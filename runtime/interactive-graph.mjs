import { randomUUID } from 'node:crypto';
import { BoundedWireQueue } from './bounded-wire-queue.mjs';
import { createEnvelope, prepareGraph } from './orchestrator.mjs';
import { MessageIntegrityLedger } from './message-identity.mjs';

const NO_RECEIPT = new Set(['lifecycle.health-check', 'lifecycle.drain']);

export class InteractiveGraph {
  constructor(prepared, { trace = false, onMessage = () => {}, onStatus = () => {}, diagnostics } = {}) {
    this.prepared = prepared;
    this.trace = trace;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.diagnostics = diagnostics;
    this.running = new Map();
    this.queues = new Map();
    this.waiters = new Map();
    this.ready = new Set();
    this.drained = new Set();
    this.integrity = new MessageIntegrityLedger();
    this.started = false;
    this.starting = false;
    this.draining = false;
    this.closed = false;
    this.startPromise = undefined;
    this.drainPromise = undefined;
  }

  static async create(graphFile, options) { return new InteractiveGraph(await prepareGraph(await loadJson(graphFile), graphFile), options); }

  start() {
    if (this.startPromise) return this.startPromise;
    this.starting = true;
    this.startPromise = new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      try {
        for (const instance of this.prepared.services.values()) this.startService(instance);
        this.dispatchFrom('@supervisor', 'control', 'lifecycle.health-check', this.sessionId(), { probe_id: randomUUID() }).catch(reject);
        this.readinessTimer = setTimeout(() => {
          const missing = [...this.prepared.services.values()].filter((service) => !this.ready.has(service.id) && service.required);
          if (missing.length) this.fail(new Error(`Required services did not become ready: ${missing.map((service) => service.id).join(', ')}`));
        }, this.prepared.definition.supervision.readiness_timeout_ms);
      } catch (error) { this.fail(error); }
    });
    return this.startPromise;
  }

  sessionId() { return this.prepared.definition.run.session_id; }

  async dispatchFrom(from, plane, messageType, correlationId, payload, idempotencyKey) {
    if (this.closed) throw new Error('Interactive Argus graph is closed');
    const endpoint = this.prepared.endpoints.get(from);
    const message = createEnvelope({ plane, messageType, producer: from, correlationId, payload, idempotencyKey });
    this.assertEmission(endpoint, message);
    const wires = this.wiresFor(from, plane, messageType);
    if (!wires.length) throw new Error(`No declared ${plane} wire accepts ${messageType} from ${from}`);
    const receipts = wires.filter((wire) => this.prepared.endpoints.get(wire.to)?.endpointType === 'service' && !NO_RECEIPT.has(messageType))
      .map((wire) => this.waitForReceipt(wire.to, message.message_id));
    this.route(from, message);
    await Promise.all(receipts);
    return message;
  }

  async drain(reason = 'shutdown') {
    if (this.drainPromise) return this.drainPromise;
    if (!this.started) return;
    this.draining = true;
    this.diagnostics?.log('shutdown.graph-drain-beginning', { session_id: this.sessionId(), reason });
    this.drainPromise = new Promise((resolve) => {
      this.drainResolve = resolve;
      try {
        this.dispatchFrom('@supervisor', 'control', 'lifecycle.drain', this.sessionId(), { reason, deadline_ms: this.prepared.definition.supervision.drain_timeout_ms }).catch(() => this.stopProcesses());
        this.drainTimer = setTimeout(() => this.stopProcesses(), this.prepared.definition.supervision.drain_timeout_ms);
      } catch { this.stopProcesses(); }
    });
    return this.drainPromise;
  }

  async close() { await this.drain('application-shutdown'); }

  async waitForIdle() { await Promise.all([...this.queues.values()].map((queue) => queue.drain())); }

  startService(instance) {
    const provider = this.prepared.providers.get(instance.manifest.runtime.kind);
    const record = { instance, provider, exited: false, expected: false };
    this.running.set(instance.id, record);
    record.handle = provider.start(instance, {
      onMessage: (line) => this.receiveServiceLine(instance, line),
      onDiagnostic: (line) => this.diagnostics?.ingest(line) || (this.trace && process.stderr.write(`${line}\n`)),
      onError: (error) => this.fail(new Error(`${instance.id} failed to start: ${error.message}`)),
      onExit: ({ code, signal }) => {
        record.exited = true;
        record.handle.dispose();
        this.diagnostics?.log('graph.service-exited', { session_id: this.sessionId(), correlation_id: this.sessionId(), service: instance.id, pid: record.handle.pid, code, signal, expected: record.expected });
        this.onStatus({ type: 'service-exit', service: instance.id, code, signal, expected: record.expected });
        if (!record.expected && !this.draining) this.fail(new Error(`${instance.id} exited unexpectedly with code ${code ?? 'none'}`));
        if (this.draining && [...this.running.values()].every((item) => item.exited)) this.finishDrain();
      }
    });
    this.onStatus({ type: 'service-started', service: instance.id, pid: record.handle.pid });
  }

  receiveServiceLine(instance, line) {
    if (!line.trim() || this.closed) return;
    try {
      const message = JSON.parse(line);
      this.assertEmission(instance, message);
      this.onMessage(message);
      this.route(instance.id, message);
    } catch (error) { this.fail(new Error(`Invalid output from ${instance.id}: ${error.message}`)); }
  }

  route(from, message) {
    this.integrity.observe(message);
    for (const wire of this.wiresFor(from, message.plane, message.message_type)) {
      const target = this.prepared.endpoints.get(wire.to);
      if (target.endpointType === 'runtime') {
        this.receiveRuntime(target, message, from);
        continue;
      }
      const record = this.running.get(wire.to);
      if (!record || record.exited) continue;
      let queue = this.queues.get(this.wireKey(wire));
      if (!queue) {
        queue = new BoundedWireQueue({
          wireKey: this.wireKey(wire),
          capacity: wire.delivery?.queue_capacity || this.prepared.definition.supervision.queue.capacity,
          onError: (error, item) => this.rejectReceipt(wire.to, item.message.message_id, error),
          observe: (depth) => {
            this.onStatus({ type: 'queue', wire: this.wireKey(wire), depth });
            if (depth >= Math.max(1, Math.floor((wire.delivery?.queue_capacity || this.prepared.definition.supervision.queue.capacity) * 0.75))) {
              this.diagnostics?.log('graph.queue-pressure', { session_id: message.correlation_id, correlation_id: message.correlation_id, wire: this.wireKey(wire), depth });
            }
          }
        });
        queue.consume = async (item) => {
          const current = this.running.get(wire.to);
          if (!current || current.exited) throw new Error(`Target service is unavailable: ${wire.to}`);
          await current.handle.write(item.message);
        };
        this.queues.set(this.wireKey(wire), queue);
      }
      try { queue.enqueue({ message, attempt: 1 }); }
      catch (error) {
        this.rejectReceipt(wire.to, message.message_id, error);
        this.diagnostics?.log('graph.queue-rejected', { session_id: message.correlation_id, correlation_id: message.correlation_id, service: wire.to, input_message_id: message.message_id, message_type: message.message_type, code: error.code || 'QUEUE_OVERFLOW', error: error.message });
        this.onStatus({ type: 'service-failure', service: wire.to, code: error.code || 'QUEUE_OVERFLOW', message: error.message, retryable: true, correlation_id: message.correlation_id, input_message_id: message.message_id, operation: message.message_type });
      }
    }
  }

  receiveRuntime(endpoint, message, from) {
    if (endpoint.kind === 'supervisor') {
      if (message.message_type === 'service.health' && message.payload.status === 'ready') {
        this.ready.add(from);
        this.onStatus({ type: 'service-ready', service: from, rss_bytes: message.payload.rss_bytes });
        if (!this.started && this.ready.size === this.prepared.services.size) this.finishStart();
        return;
      }
      if (message.message_type === 'operation.completed') { this.resolveReceipt(from, message.payload.input_message_id); return; }
      if (message.message_type === 'operation.rejected') {
        this.rejectReceipt(from, message.payload.input_message_id, new Error(message.payload.reason?.message || 'Operation rejected'));
        this.onStatus({ type: 'operation-rejected', service: message.payload.service || from, operation: message.payload.operation, code: message.payload.reason?.code, message: message.payload.reason?.message, correlation_id: message.correlation_id, input_message_id: message.payload.input_message_id });
        return;
      }
      if (message.message_type === 'service.failure') {
        this.rejectReceipt(message.payload.service, message.payload.input_message_id, new Error(message.payload.error?.message || 'Service failure'));
        this.onStatus({ type: 'service-failure', service: message.payload.service, operation: message.payload.operation, code: message.payload.error?.code, message: message.payload.error?.message, retryable: message.payload.error?.retryable, correlation_id: message.correlation_id, input_message_id: message.payload.input_message_id });
        return;
      }
      if (message.message_type === 'service.drained') { this.drained.add(from); if (this.draining && this.drained.size === this.prepared.services.size) this.stopProcesses(); return; }
      return;
    }
    if (endpoint.kind === 'result-collector') { this.onMessage(message); return; }
  }

  finishStart() {
    if (this.started) return;
    this.started = true;
    this.starting = false;
    clearTimeout(this.readinessTimer);
    const run = this.prepared.definition.run;
    this.dispatchFrom('@session-controller', 'control', 'lifecycle.start', run.session_id, { session_id: run.session_id, ...(run.configuration ? { configuration: run.configuration } : {}) }).catch((error) => this.fail(error));
    this.onStatus({ type: 'graph-ready', services: [...this.ready] });
    this.startResolve?.(this);
  }

  fail(error) {
    if (this.starting && !this.started) { clearTimeout(this.readinessTimer); this.startReject?.(error); }
    this.onStatus({ type: 'graph-failure', message: error.message });
  }

  stopProcesses() {
    clearTimeout(this.drainTimer);
    for (const record of this.running.values()) {
      record.expected = true;
      record.handle.closeInput();
    }
    setTimeout(() => { for (const record of this.running.values()) if (!record.exited) record.handle.terminate(); }, 500);
    if ([...this.running.values()].every((record) => record.exited)) this.finishDrain();
  }

  finishDrain() {
    if (this.closed) return;
    this.closed = true;
    this.diagnostics?.log('shutdown.graph-drain-completed', { session_id: this.sessionId() });
    this.drainResolve?.();
    for (const waiter of this.waiters.values()) waiter.reject(new Error('Argus graph drained'));
    this.waiters.clear();
  }

  waitForReceipt(service, messageId) {
    const key = `${service}:${messageId}`;
    return new Promise((resolve, reject) => this.waiters.set(key, { resolve, reject }));
  }

  resolveReceipt(service, messageId) { const waiter = this.waiters.get(`${service}:${messageId}`); if (waiter) { this.waiters.delete(`${service}:${messageId}`); waiter.resolve(); } }
  rejectReceipt(service, messageId, error) { const waiter = this.waiters.get(`${service}:${messageId}`); if (waiter) { this.waiters.delete(`${service}:${messageId}`); waiter.reject(error); } }
  wiresFor(from, plane, type) { return (plane === 'domain' ? this.prepared.definition.domain_wires : this.prepared.definition.control_wires).filter((wire) => wire.from === from && wire.contract === type); }
  wireKey(wire) { return `${wire.from}:${wire.contract}:${wire.to}`; }
  sessionController() { return this.prepared.endpoints.get(this.prepared.definition.run.session_controller); }
  assertEmission(endpoint, message) {
    this.prepared.registry.assertEnvelope(message);
    if (message.producer !== endpoint.serviceName) throw new Error(`${endpoint.id} emitted producer identity ${message.producer}; expected ${endpoint.serviceName}`);
    if (!endpoint.ports[message.plane]?.emits.includes(message.message_type)) throw new Error(`${endpoint.id} emitted undeclared ${message.plane} contract ${message.message_type}`);
  }
}

async function loadJson(file) { const { loadGraphDefinition } = await import('./orchestrator.mjs'); return (await loadGraphDefinition(file)).definition; }
