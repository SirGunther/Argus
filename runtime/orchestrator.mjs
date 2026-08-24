import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BoundedWireQueue } from './bounded-wire-queue.mjs';
import { loadContractRegistry } from './contract-registry.mjs';
import { createMessageIdentity, fingerprintMessage, MessageIntegrityLedger } from './message-identity.mjs';
import { assertPermissionPolicy } from './permission-policy.mjs';
import { createRuntimeProviderRegistry } from './runtime-providers.mjs';

const RUNTIME_KINDS = new Set(['input-source', 'session-controller', 'supervisor', 'run-controller', 'result-collector', 'runtime-provider', 'dead-letter-collector']);
const NO_RECEIPT_CONTRACTS = new Set(['lifecycle.health-check', 'lifecycle.drain']);

export class SupervisionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SupervisionError';
    Object.assign(this, details);
  }
}

export async function loadGraphDefinition(graphFile) {
  const absoluteGraphFile = path.resolve(graphFile);
  return { graphFile: absoluteGraphFile, definition: JSON.parse(await readFile(absoluteGraphFile, 'utf8')) };
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
  const providers = createRuntimeProviderRegistry();
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
    const declaredAuthority = assertPermissionPolicy({ manifest, manifestPath });
    providers.get(manifest.runtime.kind);
    const instance = {
      ...service,
      endpointType: 'service',
      serviceName: service.id,
      implementationName: manifest.service_name,
      ports: manifest.ports,
      manifest,
      manifestPath,
      permissions: declaredAuthority.permissions,
      resources: declaredAuthority.resources,
      directory: path.dirname(manifestPath),
      entrypoint: manifest.runtime.entrypoint ? path.resolve(path.dirname(manifestPath), manifest.runtime.entrypoint) : undefined
    };
    assertRecoveryPolicy(instance, endpoints);
    assertPortContracts(instance, registry);
    services.set(service.id, instance);
    endpoints.set(service.id, instance);
  }

  validateWires('domain', definition.domain_wires, endpoints, registry);
  validateWires('control', definition.control_wires, endpoints, registry);
  validateDeliveryPolicies(definition, endpoints);
  validateRuntimeTopology(definition, services, endpoints);
  return { definition, graphFile: path.resolve(graphFile), graphDirectory, registry, providers, services, endpoints };
}

export async function runGraph(graphFile, options = {}) {
  return runPreparedGraph(await validateGraphFile(graphFile), options);
}

export async function runPreparedGraph(prepared, { trace = false } = {}) {
  const { definition, registry, providers, services, endpoints } = prepared;
  const running = new Map();
  const results = [];
  const completionSignals = [];
  const deadLetters = [];
  const rejections = [];
  const pendingOperations = new Map();
  const ready = new Set();
  const drained = new Set();
  const serviceRss = new Map();
  const operationLatencies = [];
  const wireQueues = new Map();
  const integrity = new MessageIntegrityLedger();
  const startedAt = performance.now();
  const metrics = { process_count: services.size, messages_routed: 0, operations_completed: 0, operations_rejected: 0, max_queue_depth: 0 };
  let readinessAt;
  let finishRequested = false;
  let finishError;
  let finalized = false;
  let readinessTimer;
  let runTimer;
  let drainTimer;
  let forceTimer;

  const emitTrace = (event) => {
    if (trace) process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), service: 'runtime-kernel', ...event })}\n`);
  };

  return new Promise((resolve, reject) => {
    const finishFinal = () => {
      if (finalized) return;
      finalized = true;
      clearTimeout(readinessTimer);
      clearTimeout(runTimer);
      clearTimeout(drainTimer);
      clearTimeout(forceTimer);
      for (const pending of pendingOperations.values()) clearTimeout(pending.timer);
      const durationMs = Math.max(1, performance.now() - startedAt);
      const result = {
        graph: definition.name,
        completions: results,
        control_completions: completionSignals,
        dead_letters: deadLetters,
        rejections,
        metrics: {
          ...metrics,
          startup_ms: readinessAt ? readinessAt - startedAt : null,
          duration_ms: durationMs,
          idle_rss_bytes_total: [...serviceRss.values()].reduce((sum, value) => sum + value, 0),
          throughput_messages_per_second: Number((metrics.messages_routed / (durationMs / 1000)).toFixed(2)),
          operation_latency_ms: summarize(operationLatencies)
        }
      };
      if (finishError) {
        finishError.deadLetters = deadLetters;
        finishError.metrics = result.metrics;
        reject(finishError);
      } else resolve(result);
    };

    const allExited = () => [...running.values()].every((record) => record.exited);

    const stopProcesses = () => {
      clearTimeout(drainTimer);
      for (const record of running.values()) {
        record.expectedExit = true;
        record.handle.closeInput();
      }
      forceTimer = setTimeout(() => {
        for (const record of running.values()) if (!record.exited) record.handle.terminate();
      }, 250);
      if (allExited()) finishFinal();
    };

    const requestFinish = (error) => {
      if (finishRequested) return;
      finishRequested = true;
      finishError = error;
      clearTimeout(readinessTimer);
      clearTimeout(runTimer);
      for (const pending of pendingOperations.values()) clearTimeout(pending.timer);
      if (error) pendingOperations.clear();
      emitTrace({ operation: 'drain', status: 'started', reason: error ? 'failed' : 'completed', deadline_ms: definition.supervision.drain_timeout_ms });
      try {
        const supervisor = runtimeByKind(endpoints, 'supervisor');
        emitFromRuntime(supervisor.id, 'control', 'lifecycle.drain', definition.run.session_id, {
          reason: error ? 'failed' : 'completed',
          deadline_ms: definition.supervision.drain_timeout_ms
        });
        drainTimer = setTimeout(() => {
          emitTrace({ operation: 'drain', status: 'deadline-exhausted', missing: [...services.keys()].filter((id) => !drained.has(id)) });
          stopProcesses();
        }, definition.supervision.drain_timeout_ms);
      } catch (drainError) {
        emitTrace({ operation: 'drain', status: 'failed', error: drainError.message });
        stopProcesses();
      }
    };

    const fail = (error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      emitTrace({ operation: 'run-graph', status: 'failed', error: normalized.message });
      requestFinish(normalized);
    };

    const emitFromRuntime = (endpointId, plane, messageType, correlationId, payload, causationId) => {
      const endpoint = endpoints.get(endpointId);
      const message = createEnvelope({ plane, messageType, producer: endpointId, correlationId, payload, causationId });
      assertEndpointEmission(endpoint, message, registry);
      routeMessage(endpointId, message);
      return message;
    };

    const clearOperation = (serviceId, inputMessageId) => {
      const key = `${serviceId}:${inputMessageId}`;
      const pending = pendingOperations.get(key);
      if (!pending) return undefined;
      clearTimeout(pending.timer);
      pendingOperations.delete(key);
      operationLatencies.push(performance.now() - pending.sentAt);
      return pending;
    };

    const enqueueExactWire = (wire, message, attempt = 1) => {
      const target = endpoints.get(wire.to);
      if (target.endpointType === 'runtime') {
        receiveRuntimeMessage(target, message, wire.from);
        return;
      }
      const serviceRecord = running.get(wire.to);
      if (serviceRecord?.degraded) {
        emitTrace({ operation: 'route', status: 'skipped-degraded', plane: message.plane, from: wire.from, to: wire.to, message_id: message.message_id, message_type: message.message_type });
        return;
      }
      const key = wireKey(wire);
      let queue = wireQueues.get(key);
      if (!queue) {
        const capacity = wire.delivery?.queue_capacity || definition.supervision.queue.capacity;
        queue = new BoundedWireQueue({
          wireKey: key,
          capacity,
          onError(error) { fail(error); },
          observe(depth) {
            metrics.max_queue_depth = Math.max(metrics.max_queue_depth, depth);
            emitTrace({ operation: 'queue-depth', status: 'observed', wire: key, depth, capacity });
          },
          async consume(item) {
            const record = running.get(wire.to);
            if (!record || record.exited || !record.handle) throw new Error(`Target service is unavailable: ${wire.to}`);
            await record.handle.write(item.message);
            if (!NO_RECEIPT_CONTRACTS.has(item.message.message_type)) {
              const operationKey = `${wire.to}:${item.message.message_id}`;
              const timeoutMs = wire.delivery?.operation_timeout_ms || definition.supervision.operation_timeout_ms;
              const timer = setTimeout(() => {
                pendingOperations.delete(operationKey);
                try {
                  const providerEndpoint = runtimeByKind(endpoints, 'runtime-provider');
                  emitFromRuntime(providerEndpoint.id, 'control', 'service.failure', item.message.correlation_id, {
                    service: wire.to,
                    operation: `consume:${item.message.message_type}`,
                    input_message_id: item.message.message_id,
                    outcome: 'failure',
                    error: { code: 'OPERATION_TIMEOUT', category: 'timeout', message: `${wire.to} did not complete ${item.message.message_type} within ${timeoutMs} ms`, retryable: true }
                  }, item.message.message_id);
                } catch (error) { fail(error); }
              }, timeoutMs);
              pendingOperations.set(operationKey, { wire, message: item.message, attempt: item.attempt, timer, sentAt: performance.now() });
            }
          }
        });
        wireQueues.set(key, queue);
      }
      queue.enqueue({ message, attempt });
    };

    const routeMessage = (fromId, message) => {
      integrity.observe(message);
      const wires = message.plane === 'domain' ? definition.domain_wires : definition.control_wires;
      const matchingWires = wires.filter((wire) => wire.from === fromId && wire.contract === message.message_type);
      if (!matchingWires.length) throw new Error(`No declared ${message.plane} wire accepts ${message.message_type} from ${fromId}`);
      for (const wire of matchingWires) {
        metrics.messages_routed += 1;
        emitTrace({ operation: 'route', status: 'completed', plane: message.plane, from: wire.from, to: wire.to, message_id: message.message_id, message_type: message.message_type, correlation_id: message.correlation_id });
        enqueueExactWire(wire, message);
      }
    };

    const maybeStartRun = () => {
      if (finishRequested || readinessAt || ready.size !== services.size) return;
      readinessAt = performance.now();
      clearTimeout(readinessTimer);
      emitTrace({ operation: 'readiness', status: 'completed', service_count: services.size, duration_ms: readinessAt - startedAt });
      const sessionController = runtimeByKind(endpoints, 'session-controller');
      emitFromRuntime(sessionController.id, 'control', 'lifecycle.start', definition.run.session_id, {
        session_id: definition.run.session_id,
        ...(definition.run.configuration ? { configuration: definition.run.configuration } : {})
      });
      runTimer = setTimeout(() => fail(new SupervisionError(`Graph did not deliver ${definition.run.completion_count} workflow.completed message(s) to ${definition.run.run_controller} within ${definition.run.timeout_ms} ms`)), definition.run.timeout_ms);
    };

    const handleFailure = (message, fromId) => {
      const serviceId = services.has(fromId) ? fromId : message.payload.service;
      const pending = message.payload.input_message_id ? clearOperation(serviceId, message.payload.input_message_id) : undefined;
      if (message.payload.error.retryable && pending?.wire.delivery?.retry) {
        const retry = pending.wire.delivery.retry;
        if (pending.attempt < retry.max_attempts) {
          emitTrace({ operation: 'retry', status: 'scheduled', wire: wireKey(pending.wire), attempt: pending.attempt + 1, max_attempts: retry.max_attempts });
          setTimeout(() => {
            try { enqueueExactWire(pending.wire, pending.message, pending.attempt + 1); }
            catch (error) { fail(error); }
          }, retry.delay_ms);
          return;
        }
        const supervisor = runtimeByKind(endpoints, 'supervisor');
        emitFromRuntime(supervisor.id, 'control', 'dead-letter.message', message.correlation_id, {
          source_wire: wireKey(pending.wire),
          target_service: serviceId,
          attempts: pending.attempt,
          original_message: pending.message,
          failure: message.payload
        }, message.message_id);
      }
      const instance = services.get(serviceId);
      if (instance && !instance.required) {
        const record = running.get(serviceId);
        if (record) {
          record.degraded = true;
          record.expectedExit = true;
          record.handle.terminate();
        }
        drained.add(serviceId);
        ready.add(serviceId);
        emitTrace({ operation: 'degraded', status: 'entered', service_instance: serviceId, reason: `service-failure:${message.payload.error.code}` });
        maybeStartRun();
        return;
      }
      fail(new SupervisionError(`${message.payload.service} reported ${message.payload.error.code}: ${message.payload.error.message}`));
    };

    const handleExit = (message) => {
      const serviceId = message.payload.service_instance;
      const instance = services.get(serviceId);
      if (!instance || message.payload.expected || finishRequested) return;
      const record = running.get(serviceId);
      const used = record?.restartCount || 0;
      if (instance.recovery.restart === 'on-failure' && used < instance.recovery.max_restarts) {
        ready.delete(serviceId);
        const replayPending = [];
        for (const [key, pending] of pendingOperations) {
          if (key.startsWith(`${serviceId}:`)) {
            clearTimeout(pending.timer);
            pendingOperations.delete(key);
            replayPending.push(pending);
          }
        }
        emitTrace({ operation: 'restart', status: 'started', service_instance: serviceId, attempt: used + 1 });
        const restarted = startService(instance, used + 1);
        restarted.replayPending = replayPending;
        sendHealthProbe(serviceId);
        return;
      }
      if (!instance.required) {
        emitTrace({ operation: 'degraded', status: 'entered', service_instance: serviceId });
        return;
      }
      fail(new SupervisionError(`${serviceId} exited and exhausted its recovery policy`));
    };

    const receiveRuntimeMessage = (endpoint, message, fromId) => {
      emitTrace({ operation: 'runtime-component-receive', status: 'completed', to: endpoint.id, from: fromId, message_id: message.message_id, message_type: message.message_type, plane: message.plane, correlation_id: message.correlation_id });
      if (endpoint.kind === 'supervisor') {
        if (message.message_type === 'service.health') {
          if (message.payload.status === 'ready') {
            ready.add(fromId);
            serviceRss.set(fromId, message.payload.rss_bytes);
            const record = running.get(fromId);
            if (record?.replayPending?.length) {
              for (const pending of record.replayPending.splice(0)) enqueueExactWire(pending.wire, pending.message, pending.attempt);
            }
            maybeStartRun();
          }
          return;
        }
        if (message.message_type === 'operation.completed') {
          clearOperation(fromId, message.payload.input_message_id);
          metrics.operations_completed += 1;
          return;
        }
        if (message.message_type === 'operation.rejected') {
          clearOperation(fromId, message.payload.input_message_id);
          metrics.operations_rejected += 1;
          rejections.push(message);
          return;
        }
        if (message.message_type === 'service.drained') {
          drained.add(fromId);
          if (finishRequested && [...running.values()].filter((record) => !record.exited).every((record) => drained.has(record.instance.id))) {
            emitTrace({ operation: 'drain', status: 'completed', service_count: drained.size });
            stopProcesses();
          }
          return;
        }
        if (message.message_type === 'service.failure') { handleFailure(message, fromId); return; }
        if (message.message_type === 'service.exited') { handleExit(message); return; }
        fail(new Error(`${endpoint.id} cannot handle ${message.message_type}`));
        return;
      }
      if (endpoint.kind === 'dead-letter-collector') { deadLetters.push(message); return; }
      if (endpoint.kind === 'result-collector') {
        results.push(message);
        emitFromRuntime(endpoint.id, 'control', 'workflow.completed', message.correlation_id, { workflow_id: definition.name, status: 'completed', result_message_id: message.message_id }, message.message_id);
        return;
      }
      if (endpoint.kind === 'run-controller') {
        completionSignals.push(message);
        if (completionSignals.length >= definition.run.completion_count) requestFinish();
        return;
      }
      fail(new Error(`${endpoint.id} does not accept runtime messages`));
    };

    const handleServiceMessage = (instance, line) => {
      if (!line.trim() || finalized) return;
      try {
        const message = JSON.parse(line);
        assertEndpointEmission(instance, message, registry);
        emitTrace({ operation: 'receive', status: 'completed', plane: message.plane, from: instance.id, message_id: message.message_id, message_type: message.message_type, correlation_id: message.correlation_id });
        routeMessage(instance.id, message);
      } catch (error) {
        fail(new Error(`Invalid output from ${instance.id}: ${error.message}`));
      }
    };

    const startService = (instance, restartCount = 0) => {
      const provider = providers.get(instance.manifest.runtime.kind);
      const record = { instance, restartCount, provider, handle: undefined, expectedExit: false, exited: false };
      running.set(instance.id, record);
      record.handle = provider.start({ ...instance, restartCount }, {
        onMessage: (line) => handleServiceMessage(instance, line),
        onDiagnostic: (line) => { if (trace) process.stderr.write(`${line}\n`); },
        onError: (error) => { if (!finishRequested) fail(new Error(`Failed to start ${instance.id}: ${error.message}`)); },
        onExit: ({ code, signal }) => {
          record.exited = true;
          record.handle?.dispose();
          try {
            const providerEndpoint = runtimeByKind(endpoints, 'runtime-provider');
            emitFromRuntime(providerEndpoint.id, 'control', 'service.exited', definition.run.session_id, {
              service_instance: instance.id,
              runtime_kind: provider.kind,
              expected: record.expectedExit,
              exit_code: code,
              signal
            });
          } catch (error) { if (!finishRequested) fail(error); }
          if (finishRequested && allExited()) finishFinal();
        }
      });
      emitTrace({ operation: restartCount ? 'restart' : 'start-process', status: 'completed', service_instance: instance.id, runtime_kind: provider.kind, pid: record.handle.pid, restart_count: restartCount });
      return record;
    };

    const sendHealthProbe = (serviceId) => {
      const supervisor = runtimeByKind(endpoints, 'supervisor');
      const probe = createEnvelope({ plane: 'control', messageType: 'lifecycle.health-check', producer: supervisor.id, correlationId: definition.run.session_id, payload: { probe_id: randomUUID() } });
      assertEndpointEmission(supervisor, probe, registry);
      const wire = definition.control_wires.find((candidate) => candidate.from === supervisor.id && candidate.contract === 'lifecycle.health-check' && candidate.to === serviceId);
      if (!wire) throw new Error(`${serviceId} requires an explicit lifecycle.health-check wire from ${supervisor.id}`);
      enqueueExactWire(wire, probe);
    };

    try {
      for (const instance of services.values()) startService(instance);
      const supervisor = runtimeByKind(endpoints, 'supervisor');
      emitFromRuntime(supervisor.id, 'control', 'lifecycle.health-check', definition.run.session_id, { probe_id: randomUUID() });
      readinessTimer = setTimeout(() => {
        const missing = [...services.values()].filter((instance) => !ready.has(instance.id));
        const requiredMissing = missing.filter((instance) => instance.required);
        if (requiredMissing.length) {
          fail(new SupervisionError(`Required services did not become ready within ${definition.supervision.readiness_timeout_ms} ms: ${requiredMissing.map((item) => item.id).join(', ')}`));
          return;
        }
        for (const instance of missing) {
          const record = running.get(instance.id);
          if (record) {
            record.expectedExit = true;
            record.handle.terminate();
          }
          ready.add(instance.id);
          emitTrace({ operation: 'degraded', status: 'entered', service_instance: instance.id, reason: 'readiness-timeout' });
        }
        maybeStartRun();
      }, definition.supervision.readiness_timeout_ms);
    } catch (error) { fail(error); }
  });
}

export function createEnvelope({ plane, messageType, producer, correlationId, payload, causationId, schemaVersion = '1.2.0', extensions, messageId, idempotencyKey }) {
  const identity = createMessageIdentity({ producer, messageType, logicalKey: idempotencyKey, messageId });
  const envelope = {
    ...identity, plane, message_type: messageType, timestamp: new Date().toISOString(), producer, correlation_id: correlationId,
    schema_version: schemaVersion, payload,
    ...(causationId ? { causation_id: causationId } : {}),
    ...(extensions ? { extensions } : {})
  };
  envelope.content_fingerprint = fingerprintMessage(envelope);
  return envelope;
}

function assertEndpointEmission(endpoint, message, registry) {
  registry.assertEnvelope(message);
  if (message.producer !== endpoint.serviceName) throw new Error(`${endpoint.id} emitted producer identity ${message.producer}; expected ${endpoint.serviceName}`);
  if (!(endpoint.ports[message.plane]?.emits || []).includes(message.message_type)) throw new Error(`${endpoint.id} emitted undeclared ${message.plane} contract ${message.message_type}`);
}

function validateWires(plane, wires, endpoints, registry) {
  for (const wire of wires) {
    const producer = endpoints.get(wire.from);
    const consumer = endpoints.get(wire.to);
    if (!producer) throw new Error(`${plane} wire references unknown producer: ${wire.from}`);
    if (!consumer) throw new Error(`${plane} wire references unknown consumer: ${wire.to}`);
    if (!registry.hasMessageType(wire.contract)) throw new Error(`${plane} wire uses an unregistered contract: ${wire.contract}`);
    if (registry.planeFor(wire.contract) !== plane) throw new Error(`${wire.contract} is a ${registry.planeFor(wire.contract)} contract and cannot use a ${plane} wire`);
    if (!producer.ports[plane].emits.includes(wire.contract)) throw new Error(`${wire.from} does not declare emitted ${plane} contract ${wire.contract}`);
    if (!consumer.ports[plane].accepts.includes(wire.contract)) throw new Error(`${wire.to} does not declare accepted ${plane} contract ${wire.contract}`);
  }
}

function validateDeliveryPolicies(definition, endpoints) {
  for (const wire of [...definition.domain_wires, ...definition.control_wires]) {
    if (wire.delivery?.retry && !wire.delivery.dead_letter_to) throw new Error(`${wireKey(wire)} enables retry without a dead_letter_to destination`);
    if (wire.delivery?.dead_letter_to) {
      const target = endpoints.get(wire.delivery.dead_letter_to);
      if (target?.kind !== 'dead-letter-collector') throw new Error(`${wireKey(wire)} dead_letter_to must reference a dead-letter-collector`);
      const declared = definition.control_wires.some((candidate) => candidate.from === runtimeByKind(endpoints, 'supervisor').id && candidate.contract === 'dead-letter.message' && candidate.to === target.id);
      if (!declared) throw new Error(`${wireKey(wire)} requires an explicit dead-letter.message control wire to ${target.id}`);
    }
  }
}

function validateRuntimeTopology(definition, services, endpoints) {
  const sessionController = endpoints.get(definition.run.session_controller);
  const runController = endpoints.get(definition.run.run_controller);
  const supervisor = runtimeByKind(endpoints, 'supervisor');
  const provider = runtimeByKind(endpoints, 'runtime-provider');
  if (sessionController?.kind !== 'session-controller') throw new Error('Run session_controller must reference a session-controller runtime component');
  if (runController?.kind !== 'run-controller') throw new Error('Run run_controller must reference a run-controller runtime component');
  requireWire(definition.control_wires, sessionController.id, 'lifecycle.start', undefined, `${sessionController.id} requires an explicit lifecycle.start control wire`);
  if (!definition.domain_wires.some((wire) => endpoints.get(wire.to)?.kind === 'result-collector')) throw new Error('A finite run requires an explicit domain wire to a result-collector');
  requireWire(definition.control_wires, undefined, 'workflow.completed', runController.id, `${runController.id} requires an explicit workflow.completed control wire`);
  requireWire(definition.control_wires, provider.id, 'service.exited', supervisor.id, `${provider.id} requires an explicit service.exited control wire to ${supervisor.id}`);
  requireWire(definition.control_wires, provider.id, 'service.failure', supervisor.id, `${provider.id} requires an explicit service.failure control wire to ${supervisor.id}`);
  for (const service of services.values()) {
    for (const [from, contract, to] of [
      [supervisor.id, 'lifecycle.health-check', service.id], [service.id, 'service.health', supervisor.id],
      [supervisor.id, 'lifecycle.drain', service.id], [service.id, 'service.drained', supervisor.id],
      [service.id, 'operation.completed', supervisor.id], [service.id, 'service.failure', supervisor.id]
    ]) requireWire(definition.control_wires, from, contract, to, `${service.id} requires an explicit ${contract} control wire`);
    if (service.ports.control.emits.includes('operation.rejected')) {
      requireWire(definition.control_wires, service.id, 'operation.rejected', supervisor.id, `${service.id} requires an explicit operation.rejected control wire`);
    }
  }
}

function requireWire(wires, from, contract, to, message) {
  if (!wires.some((wire) => (!from || wire.from === from) && wire.contract === contract && (!to || wire.to === to))) throw new Error(message);
}

function assertPortContracts(endpoint, registry) {
  for (const plane of ['domain', 'control']) {
    const ports = endpoint.ports?.[plane];
    if (!ports || !Array.isArray(ports.accepts) || !Array.isArray(ports.emits)) throw new Error(`${endpoint.id} must declare ${plane} accepts and emits ports`);
    for (const direction of ['accepts', 'emits']) for (const contract of ports[direction]) {
      if (!registry.hasMessageType(contract)) throw new Error(`${endpoint.id} declares unknown contract ${contract}`);
      if (registry.planeFor(contract) !== plane) throw new Error(`${endpoint.id} declares ${contract} on ${plane} ports, but it belongs to ${registry.planeFor(contract)}`);
    }
  }
}

function assertGraphShape(definition) {
  if (!definition || typeof definition !== 'object') throw new Error('Graph definition must be an object');
  if (!definition.name) throw new Error('Graph name is required');
  if (!definition.contracts) throw new Error('Graph contract catalog path is required');
  if (!Array.isArray(definition.runtime_components) || !definition.runtime_components.length) throw new Error('Graph requires visible runtime components');
  if (!Array.isArray(definition.services) || !definition.services.length) throw new Error('Graph requires at least one service');
  if (!definition.supervision) throw new Error('Graph supervision policy is required');
  if (!definition.run) throw new Error('Graph run configuration is required');
}

function assertManifestShape(manifest, manifestPath) {
  const prefix = `Invalid service manifest ${manifestPath}`;
  if (!manifest?.service_name || !manifest.version) throw new Error(`${prefix}: identity and version are required`);
  if (!['node', 'native', 'container'].includes(manifest.runtime?.kind)) throw new Error(`${prefix}: a discriminated runtime kind is required`);
  if (!manifest.ports?.domain || !manifest.ports?.control) throw new Error(`${prefix}: domain and control ports are required`);
  if (!Array.isArray(manifest.side_effects)) throw new Error(`${prefix}: side_effects must be explicit`);
  if (typeof manifest.state !== 'string') throw new Error(`${prefix}: state ownership must be declared`);
}

function assertRecoveryPolicy(instance, endpoints) {
  const policy = instance.recovery;
  if (policy.restart === 'never' && policy.max_restarts !== 0) throw new Error(`${instance.id} restart never requires max_restarts 0`);
  if (policy.restart === 'on-failure' && policy.max_restarts < 1) throw new Error(`${instance.id} on-failure restart requires max_restarts greater than zero`);
  if (instance.manifest.state !== 'none' && policy.restart === 'on-failure') {
    if (!policy.recovery_owner) throw new Error(`${instance.id} owns state and cannot restart until recovery_owner is declared`);
    if (!endpoints.has(policy.recovery_owner)) throw new Error(`${instance.id} recovery_owner references an unknown endpoint: ${policy.recovery_owner}`);
  }
}

function runtimeByKind(endpoints, kind) {
  const matches = [...endpoints.values()].filter((endpoint) => endpoint.kind === kind);
  if (matches.length !== 1) throw new Error(`Graph requires exactly one ${kind} runtime component; found ${matches.length}`);
  return matches[0];
}

function wireKey(wire) { return `${wire.from}:${wire.contract}:${wire.to}`; }

function summarize(values) {
  if (!values.length) return { count: 0, min: null, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p) => Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(3));
  return { count: sorted.length, min: pick(0), p50: pick(0.5), p95: pick(0.95), max: pick(1) };
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
