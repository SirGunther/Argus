import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';
import { loadContractRegistry } from './contract-registry.mjs';

const RUNTIME_KINDS = new Set(['session-controller', 'supervisor', 'run-controller', 'result-collector']);

export async function loadGraphDefinition(graphFile) {
  const absoluteGraphFile = path.resolve(graphFile);
  return {
    graphFile: absoluteGraphFile,
    definition: JSON.parse(await readFile(absoluteGraphFile, 'utf8'))
  };
}

export async function validateGraphFile(graphFile) {
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  return prepareGraph(definition, absoluteGraphFile);
}

export async function prepareGraph(definition, graphFile) {
  const graphDirectory = path.dirname(path.resolve(graphFile));
  assertGraphShape(definition);
  const registry = await loadContractRegistry(path.resolve(graphDirectory, definition.contracts));
  registry.assertArtifact('wiring_graph', definition);
  const services = new Map();
  const endpoints = new Map();

  for (const component of definition.runtime_components) {
    if (!component.id.startsWith('@')) throw new Error(`Runtime component id must begin with @: ${component.id}`);
    if (!RUNTIME_KINDS.has(component.kind)) throw new Error(`Unknown runtime component kind: ${component.kind}`);
    if (endpoints.has(component.id)) throw new Error(`Duplicate endpoint id: ${component.id}`);
    const endpoint = { ...component, endpointType: 'runtime', serviceName: component.id };
    assertPortContracts(endpoint, registry);
    endpoints.set(component.id, endpoint);
  }

  for (const service of definition.services) {
    if (endpoints.has(service.id)) throw new Error(`Duplicate endpoint id: ${service.id}`);
    if (service.id.startsWith('@')) throw new Error(`Service instance id may not use the runtime @ namespace: ${service.id}`);
    const manifestPath = path.resolve(graphDirectory, service.manifest);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    registry.assertArtifact('service_manifest', manifest);
    assertManifestShape(manifest, manifestPath);
    const instance = {
      id: service.id,
      endpointType: 'service',
      serviceName: manifest.service_name,
      ports: manifest.ports,
      manifest,
      manifestPath,
      directory: path.dirname(manifestPath),
      entrypoint: path.resolve(path.dirname(manifestPath), manifest.runtime.entrypoint)
    };
    assertPortContracts(instance, registry);
    services.set(service.id, instance);
    endpoints.set(service.id, instance);
  }

  validateWires('domain', definition.domain_wires, endpoints, registry);
  validateWires('control', definition.control_wires, endpoints, registry);
  validateRuntimeTopology(definition, services, endpoints);

  return { definition, graphFile: path.resolve(graphFile), graphDirectory, registry, services, endpoints };
}

export async function runGraph(graphFile, options = {}) {
  return runPreparedGraph(await validateGraphFile(graphFile), options);
}

export async function runPreparedGraph(prepared, { trace = false } = {}) {
  const { definition, registry, services, endpoints } = prepared;
  const running = new Map();
  const results = [];
  const completionSignals = [];
  let settled = false;
  let shutdownStarted = false;
  let timeout;

  const emitTrace = (event) => {
    if (trace) process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), service: 'runtime-kernel', ...event })}\n`);
  };

  return new Promise((resolve, reject) => {
    const finish = async (error) => {
      if (settled) return;
      settled = true;
      shutdownStarted = true;
      clearTimeout(timeout);
      await shutdownChildren(running);
      if (error) reject(error);
      else resolve({ graph: definition.name, completions: results, control_completions: completionSignals });
    };

    const fail = (error) => {
      emitTrace({ operation: 'run-graph', status: 'failed', error: error.message });
      void finish(error);
    };

    const emitFromRuntime = (endpointId, plane, messageType, correlationId, payload, causationId) => {
      const endpoint = endpoints.get(endpointId);
      const message = createEnvelope({ plane, messageType, producer: endpointId, correlationId, payload, causationId });
      try {
        assertEndpointEmission(endpoint, message, registry);
        routeMessage(endpointId, message);
      } catch (error) {
        fail(new Error(`Invalid output from ${endpointId}: ${error.message}`));
      }
    };

    const receiveRuntimeMessage = (endpoint, message) => {
      emitTrace({
        operation: 'runtime-component-receive',
        status: 'completed',
        to: endpoint.id,
        message_id: message.message_id,
        message_type: message.message_type,
        plane: message.plane,
        correlation_id: message.correlation_id
      });

      if (endpoint.kind === 'supervisor') {
        if (message.message_type !== 'service.failure') {
          fail(new Error(`${endpoint.id} cannot handle ${message.message_type}`));
          return;
        }
        fail(new Error(`${message.payload.service} reported ${message.payload.error.type}: ${message.payload.error.message}`));
        return;
      }

      if (endpoint.kind === 'result-collector') {
        results.push(message);
        emitFromRuntime(endpoint.id, 'control', 'workflow.completed', message.correlation_id, {
          workflow_id: definition.name,
          status: 'completed',
          result_message_id: message.message_id
        }, message.message_id);
        return;
      }

      if (endpoint.kind === 'run-controller') {
        if (message.message_type !== 'workflow.completed') {
          fail(new Error(`${endpoint.id} cannot handle ${message.message_type}`));
          return;
        }
        completionSignals.push(message);
        if (completionSignals.length >= definition.run.completion_count) void finish();
        return;
      }

      fail(new Error(`${endpoint.id} does not accept runtime messages`));
    };

    const routeMessage = (fromId, message) => {
      const wires = message.plane === 'domain' ? definition.domain_wires : definition.control_wires;
      const matchingWires = wires.filter((wire) => wire.from === fromId && wire.contract === message.message_type);
      if (!matchingWires.length) throw new Error(`No declared ${message.plane} wire accepts ${message.message_type} from ${fromId}`);

      for (const wire of matchingWires) {
        const targetEndpoint = endpoints.get(wire.to);
        emitTrace({
          operation: 'route',
          status: 'completed',
          plane: message.plane,
          from: wire.from,
          to: wire.to,
          message_id: message.message_id,
          message_type: message.message_type,
          correlation_id: message.correlation_id
        });

        if (targetEndpoint.endpointType === 'runtime') {
          receiveRuntimeMessage(targetEndpoint, message);
          continue;
        }

        const target = running.get(wire.to);
        if (!target?.child.stdin.writable) throw new Error(`Target service is unavailable: ${wire.to}`);
        target.child.stdin.write(`${JSON.stringify(message)}\n`);
      }
    };

    const handleServiceMessage = (instance, line) => {
      if (settled || !line.trim()) return;
      try {
        const message = JSON.parse(line);
        assertEndpointEmission(instance, message, registry);
        emitTrace({
          operation: 'receive',
          status: 'completed',
          plane: message.plane,
          from: instance.id,
          message_id: message.message_id,
          message_type: message.message_type,
          correlation_id: message.correlation_id
        });
        routeMessage(instance.id, message);
      } catch (error) {
        fail(new Error(`Invalid output from ${instance.id}: ${error.message}`));
      }
    };

    try {
      for (const instance of services.values()) {
        const child = spawn(process.execPath, [instance.entrypoint], {
          cwd: instance.directory,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        });
        const output = readline.createInterface({ input: child.stdout });
        const diagnostics = readline.createInterface({ input: child.stderr });
        running.set(instance.id, { instance, child, output, diagnostics });
        output.on('line', (line) => handleServiceMessage(instance, line));
        diagnostics.on('line', (line) => {
          if (trace) process.stderr.write(`${line}\n`);
        });
        child.on('error', (error) => {
          if (!shutdownStarted) fail(new Error(`Failed to start ${instance.id}: ${error.message}`));
        });
        child.on('exit', (code, signal) => {
          if (!shutdownStarted && !settled) fail(new Error(`${instance.id} exited before completion (code=${code}, signal=${signal})`));
        });
      }

      const sessionController = endpoints.get(definition.run.session_controller);
      emitFromRuntime(sessionController.id, 'control', 'lifecycle.start', definition.run.session_id, {
        session_id: definition.run.session_id
      });

      timeout = setTimeout(() => {
        fail(new Error(`Graph did not deliver ${definition.run.completion_count} workflow.completed message(s) to ${definition.run.run_controller} within ${definition.run.timeout_ms} ms`));
      }, definition.run.timeout_ms);
    } catch (error) {
      fail(error);
    }
  });
}

export function createEnvelope({ plane, messageType, producer, correlationId, payload, causationId }) {
  const envelope = {
    message_id: randomUUID(),
    plane,
    message_type: messageType,
    timestamp: new Date().toISOString(),
    producer,
    correlation_id: correlationId,
    schema_version: 1,
    payload
  };
  if (causationId) envelope.causation_id = causationId;
  return envelope;
}

function assertEndpointEmission(endpoint, message, registry) {
  registry.assertEnvelope(message);
  if (message.producer !== endpoint.serviceName) {
    throw new Error(`${endpoint.id} emitted producer identity ${message.producer}; expected ${endpoint.serviceName}`);
  }
  const emitted = endpoint.ports[message.plane]?.emits || [];
  if (!emitted.includes(message.message_type)) {
    throw new Error(`${endpoint.id} emitted undeclared ${message.plane} contract ${message.message_type}`);
  }
}

function validateWires(plane, wires, endpoints, registry) {
  for (const wire of wires) {
    const producer = endpoints.get(wire.from);
    const consumer = endpoints.get(wire.to);
    if (!producer) throw new Error(`${plane} wire references unknown producer: ${wire.from}`);
    if (!consumer) throw new Error(`${plane} wire references unknown consumer: ${wire.to}`);
    if (!registry.hasMessageType(wire.contract)) throw new Error(`${plane} wire uses an unregistered contract: ${wire.contract}`);
    if (registry.planeFor(wire.contract) !== plane) {
      throw new Error(`${wire.contract} is a ${registry.planeFor(wire.contract)} contract and cannot use a ${plane} wire`);
    }
    if (!producer.ports[plane].emits.includes(wire.contract)) {
      throw new Error(`${wire.from} does not declare emitted ${plane} contract ${wire.contract}`);
    }
    if (!consumer.ports[plane].accepts.includes(wire.contract)) {
      throw new Error(`${wire.to} does not declare accepted ${plane} contract ${wire.contract}`);
    }
  }
}

function validateRuntimeTopology(definition, services, endpoints) {
  const sessionController = endpoints.get(definition.run.session_controller);
  const runController = endpoints.get(definition.run.run_controller);
  if (sessionController?.kind !== 'session-controller') throw new Error(`Run session_controller must reference a session-controller runtime component`);
  if (runController?.kind !== 'run-controller') throw new Error(`Run run_controller must reference a run-controller runtime component`);

  const startWires = definition.control_wires.filter((wire) => wire.from === sessionController.id && wire.contract === 'lifecycle.start');
  if (!startWires.length) throw new Error(`${sessionController.id} requires an explicit lifecycle.start control wire`);

  const resultCollectorIds = new Set([...endpoints.values()].filter((endpoint) => endpoint.kind === 'result-collector').map((endpoint) => endpoint.id));
  const resultWire = definition.domain_wires.some((wire) => resultCollectorIds.has(wire.to));
  if (!resultWire) throw new Error(`A finite run requires an explicit domain wire to a result-collector`);

  const supervisorIds = new Set([...endpoints.values()].filter((endpoint) => endpoint.kind === 'supervisor').map((endpoint) => endpoint.id));
  for (const service of services.values()) {
    if (!service.ports.control.emits.includes('service.failure')) continue;
    const hasFailureWire = definition.control_wires.some((wire) => wire.from === service.id && wire.contract === 'service.failure' && supervisorIds.has(wire.to));
    if (!hasFailureWire) throw new Error(`${service.id} requires an explicit service.failure control wire to a supervisor`);
  }

  const completionWire = definition.control_wires.some((wire) => wire.to === runController.id && wire.contract === 'workflow.completed');
  if (!completionWire) throw new Error(`${runController.id} requires an explicit workflow.completed control wire`);
}

function assertPortContracts(endpoint, registry) {
  for (const plane of ['domain', 'control']) {
    const ports = endpoint.ports?.[plane];
    if (!ports || !Array.isArray(ports.accepts) || !Array.isArray(ports.emits)) throw new Error(`${endpoint.id} must declare ${plane} accepts and emits ports`);
    for (const direction of ['accepts', 'emits']) {
      for (const contract of ports[direction]) {
        if (!registry.hasMessageType(contract)) throw new Error(`${endpoint.id} declares unknown contract ${contract}`);
        if (registry.planeFor(contract) !== plane) throw new Error(`${endpoint.id} declares ${contract} on ${plane} ports, but it belongs to ${registry.planeFor(contract)}`);
      }
    }
  }
}

function assertGraphShape(definition) {
  if (!definition || typeof definition !== 'object') throw new Error('Graph definition must be an object');
  if (typeof definition.name !== 'string' || !definition.name) throw new Error('Graph name is required');
  if (typeof definition.contracts !== 'string' || !definition.contracts) throw new Error('Graph contract catalog path is required');
  if (!Array.isArray(definition.runtime_components) || !definition.runtime_components.length) throw new Error('Graph requires visible runtime components');
  if (!Array.isArray(definition.services) || !definition.services.length) throw new Error('Graph requires at least one service');
  if (!Array.isArray(definition.domain_wires)) throw new Error('Graph domain_wires must be an array');
  if (!Array.isArray(definition.control_wires)) throw new Error('Graph control_wires must be an array');
  if (!definition.run || typeof definition.run !== 'object') throw new Error('Graph run configuration is required');
}

function assertManifestShape(manifest, manifestPath) {
  const prefix = `Invalid service manifest ${manifestPath}`;
  if (!manifest || typeof manifest !== 'object') throw new Error(`${prefix}: expected an object`);
  if (typeof manifest.service_name !== 'string' || !manifest.service_name) throw new Error(`${prefix}: service_name is required`);
  if (typeof manifest.version !== 'string' || !manifest.version) throw new Error(`${prefix}: version is required`);
  if (!manifest.runtime || manifest.runtime.command !== 'node' || typeof manifest.runtime.entrypoint !== 'string') {
    throw new Error(`${prefix}: a Node runtime entrypoint is required`);
  }
  if (!manifest.ports?.domain || !manifest.ports?.control) throw new Error(`${prefix}: domain and control ports are required`);
  if (!Array.isArray(manifest.side_effects)) throw new Error(`${prefix}: side_effects must be explicit`);
  if (typeof manifest.state !== 'string') throw new Error(`${prefix}: state ownership must be declared`);
}

async function shutdownChildren(running) {
  const waits = [];
  for (const { child } of running.values()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    waits.push(new Promise((resolve) => {
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }, 250);
      child.once('exit', () => {
        clearTimeout(forceTimer);
        resolve();
      });
      child.stdin.end();
    }));
  }
  await Promise.all(waits);
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  const graphFile = process.argv[2];
  if (!graphFile) {
    process.stderr.write('Usage: node runtime/orchestrator.mjs <graph.json>\n');
    process.exitCode = 1;
  } else {
    try {
      const result = await runGraph(path.resolve(process.cwd(), graphFile), { trace: true });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    }
  }
}
