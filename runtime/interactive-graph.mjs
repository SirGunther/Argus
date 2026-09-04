import { randomUUID } from 'node:crypto';
import { BoundedWireQueue } from './bounded-wire-queue.mjs';
import { createEnvelope, prepareGraph } from './orchestrator.mjs';
import { MessageIntegrityLedger } from './message-identity.mjs';

const NO_RECEIPT = new Set(['lifecycle.health-check', 'lifecycle.drain']);
const MAX_DEFERRED_DELIVERIES = 4096;

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
    this.deferredDeliveries = new Map();
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
    const schemaVersion = this.prepared.registry.definitionFor(messageType)?.version;
    const message = createEnvelope({ plane, messageType, producer: from, correlationId, payload, idempotencyKey, schemaVersion });
    this.assertEmission(endpoint, message);
    const wires = this.wiresFor(from, plane, messageType);
    if (!wires.length) throw new Error(`No declared ${plane} wire accepts ${messageType} from ${from}`);
    const traceDispatch = messageType !== 'audio.chunk';
    if (traceDispatch) this.diagnostics?.log('graph.dispatch-beginning', {
      session_id: correlationId,
      correlation_id: correlationId,
      input_message_id: message.message_id,
      idempotency_key: message.idempotency_key,
      message_type: messageType,
      producer: from,
      targets: wires.map((wire) => wire.to)
    });
    const receipts = wires.filter((wire) => this.prepared.endpoints.get(wire.to)?.endpointType === 'service' && !NO_RECEIPT.has(messageType))
      .map((wire) => this.waitForReceipt(wire.to, message.message_id, { wire }));
    this.route(from, message);
    try {
      await Promise.all(receipts);
      if (traceDispatch) this.diagnostics?.log('graph.dispatch-completed', {
        session_id: correlationId,
        correlation_id: correlationId,
        input_message_id: message.message_id,
        idempotency_key: message.idempotency_key,
        message_type: messageType,
        producer: from
      });
      return message;
    } catch (error) {
      if (traceDispatch) this.diagnostics?.log('graph.dispatch-failed', {
        session_id: correlationId,
        correlation_id: correlationId,
        input_message_id: message.message_id,
        idempotency_key: message.idempotency_key,
        message_type: messageType,
        producer: from,
        error_code: error.code,
        error: error.message
      });
      throw error;
    }
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

  async waitForIdle() {
    while (true) {
      await Promise.all([...this.queues.values()].map((queue) => queue.drain()));
      const pumps = [...this.deferredDeliveries.values()].map((state) => state.pumpPromise).filter(Boolean);
      if (!pumps.length) return;
      await Promise.all(pumps);
    }
  }

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
        this.diagnostics?.log('child-process.exit', { session_id: this.sessionId(), correlation_id: this.sessionId(), service: instance.id, pid: record.handle.pid, code, signal, expected: record.expected });
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
      const state = this.deliveryState(wire);
      if (state.failed) {
        this.reportDeliveryFailure(wire, message, state.failure, 'WIRE_FAILED', false, false);
        continue;
      }
      if (!record || record.exited) {
        this.reportDeliveryFailure(wire, message, new Error(`Target service is unavailable: ${wire.to}`), 'TARGET_UNAVAILABLE', false);
        continue;
      }
      let queue = this.queues.get(this.wireKey(wire));
      if (!queue) {
        queue = new BoundedWireQueue({
          wireKey: this.wireKey(wire),
          capacity: wire.delivery?.queue_capacity || this.prepared.definition.supervision.queue.capacity,
          onError: (error, item) => {
            this.failWire(wire, item.message, error, { emit: !error.code });
          },
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
          const receipt = NO_RECEIPT.has(item.message.message_type) ? undefined : this.waitForReceipt(wire.to, item.message.message_id, { wire });
          const write = current.handle.write(item.message);
          if (receipt) {
            await Promise.race([write, receipt]);
            await receipt;
          } else await write;
        };
        this.queues.set(this.wireKey(wire), queue);
      }
      if (queue.failed) {
        this.reportDeliveryFailure(wire, message, state.failure || new Error(`Wire ${this.wireKey(wire)} is failed`), 'WIRE_FAILED', false, false);
        continue;
      }
      const wireState = state;
      if (wireState.pending.length || queue.depth >= queue.capacity) {
        if (wireState.pending.length >= MAX_DEFERRED_DELIVERIES) {
          this.reportDeliveryFailure(wire, message, new Error(`Reliable delivery backlog reached its governed limit of ${MAX_DEFERRED_DELIVERIES} messages`), 'DELIVERY_BACKLOG_FULL', false);
          continue;
        }
        wireState.pending.push({ message, attempt: 1 });
        this.pumpDeferredDeliveries(wire, queue, wireState);
        continue;
      }
      try { queue.enqueue({ message, attempt: 1 }); }
      catch (error) {
        if (queue.failed) {
          this.failWire(wire, message, error, { emit: false });
          continue;
        }
        if (wireState.pending.length >= MAX_DEFERRED_DELIVERIES) {
          this.reportDeliveryFailure(wire, message, new Error(`Reliable delivery backlog reached its governed limit of ${MAX_DEFERRED_DELIVERIES} messages`), 'DELIVERY_BACKLOG_FULL', false);
          continue;
        }
        wireState.pending.push({ message, attempt: 1 });
        this.pumpDeferredDeliveries(wire, queue, wireState);
      }
    }
  }

  pumpDeferredDeliveries(wire, queue, state) {
    if (state.pumping || state.failed) return;
    state.pumping = true;
    state.pumpPromise = (async () => {
      try {
        while (state.pending.length && !state.failed && !this.closed) {
          try { await queue.whenAvailable(); }
          catch (error) {
            this.failWire(wire, state.pending[0]?.message, error, { emit: false });
            break;
          }
          if (state.failed || this.closed) break;
          const item = state.pending.shift();
          try {
            queue.enqueue(item);
          } catch (error) {
            if (queue.failed) {
              state.pending.unshift(item);
              this.failWire(wire, item.message, error, { emit: false });
              break;
            }
            state.pending.unshift(item);
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      } finally {
        state.pumping = false;
        state.pumpPromise = undefined;
        if (state.pending.length && !state.failed && !this.closed) this.pumpDeferredDeliveries(wire, queue, state);
      }
    })();
  }

  deliveryState(wire) {
    const key = this.wireKey(wire);
    const state = this.deferredDeliveries.get(key) || { wire, pending: [], pumping: false, pumpPromise: undefined, failed: false, failure: undefined, failedSessionId: undefined };
    state.wire = wire;
    this.deferredDeliveries.set(key, state);
    return state;
  }

  operationTimeout(wire) {
    return wire?.delivery?.operation_timeout_ms || this.prepared.definition.supervision.operation_timeout_ms || 15000;
  }

  failWire(wire, message, error, { emit = true } = {}) {
    const state = this.deliveryState(wire);
    const failure = Object.assign(error instanceof Error ? error : new Error(String(error)), {
      code: error?.code || 'DELIVERY_FAILED',
      retryable: error?.retryable ?? false
    });
    if (state.failed) return state.failure || failure;
    state.failed = true;
    state.failure = failure;
    state.failedSessionId = message?.correlation_id;
    const pending = state.pending.splice(0);
    this.rejectReceiptsForWire(this.wireKey(wire), failure);
    for (const item of pending) this.rejectReceipt(wire.to, item.message.message_id, failure);
    this.queues.get(this.wireKey(wire))?.fail(failure);
    this.diagnostics?.log('graph.wire-failed', {
      session_id: message?.correlation_id,
      correlation_id: message?.correlation_id,
      wire: this.wireKey(wire),
      service: wire.to,
      input_message_id: message?.message_id,
      message_type: message?.message_type,
      code: failure.code,
      retryable: failure.retryable,
      error: failure.message
    });
    if (emit && message) this.emitDeliveryFailure(wire, message, failure);
    return failure;
  }

  failTargetService(instanceId, failureMessage, error) {
    const wires = [...this.deferredDeliveries.values()]
      .filter((state) => state.wire?.to === instanceId)
      .map((state) => state.wire);
    for (const wire of wires) this.failWire(wire, failureMessage, error, { emit: false });
    this.rejectReceiptsForService(instanceId, error);
    if (failureMessage?.payload?.input_message_id) this.rejectReceipt(instanceId, failureMessage.payload.input_message_id, error);
  }

  emitDeliveryFailure(wire, message, error) {
    this.diagnostics?.log('graph.delivery-failed', {
      session_id: message?.correlation_id,
      correlation_id: message?.correlation_id,
      service: wire.to,
      wire: this.wireKey(wire),
      input_message_id: message?.message_id,
      message_type: message?.message_type,
      code: error.code,
      retryable: error.retryable,
      error: error.message
    });
    this.onStatus({ type: 'service-failure', service: wire.to, code: error.code, message: error.message, retryable: error.retryable, correlation_id: message?.correlation_id, input_message_id: message?.message_id, operation: message?.message_type });
  }

  reportDeliveryFailure(wire, message, error, code = error.code || 'DELIVERY_FAILED', retryable = Boolean(error.retryable), terminal = true) {
    const failure = Object.assign(new Error(error?.message || String(error)), { ...error, code, retryable });
    if (terminal) this.failWire(wire, message, failure, { emit: false });
    else this.rejectReceipt(wire.to, message.message_id, failure);
    this.emitDeliveryFailure(wire, message, failure);
  }

  async recoverDeliveryForNewSession({ currentSessionId, nextSessionId } = {}) {
    if (!currentSessionId || !nextSessionId || currentSessionId === nextSessionId) throw Object.assign(new Error('Delivery recovery requires distinct current and next session identities'), { code: 'WIRE_RECOVERY_REJECTED', retryable: false });
    if (this.closed || this.draining) throw Object.assign(new Error('Delivery recovery is unavailable after graph shutdown has begun'), { code: 'WIRE_RECOVERY_REJECTED', retryable: false });
    await this.waitForIdle();
    const failed = [...this.deferredDeliveries.entries()].filter(([, state]) => state.failed);
    for (const [, state] of failed) {
      if (state.failedSessionId !== currentSessionId) throw Object.assign(new Error(`Wire ${this.wireKey(state.wire)} cannot be recovered across an unknown session boundary`), { code: 'WIRE_RECOVERY_REJECTED', retryable: false });
    }
    for (const [key] of failed) {
      this.queues.delete(key);
      this.deferredDeliveries.delete(key);
      this.diagnostics?.log('graph.wire-recovered', { wire: key, previous_session_id: currentSessionId, session_id: nextSessionId });
    }
    return failed.length;
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
        const error = Object.assign(new Error(message.payload.reason?.message || 'Operation rejected'), {
          code: message.payload.reason?.code,
          retryable: message.payload.reason?.retryable
        });
        this.rejectReceipt(from, message.payload.input_message_id, error);
        this.onStatus({ type: 'operation-rejected', service: message.payload.service || from, sender: from, operation: message.payload.operation, code: message.payload.reason?.code, message: message.payload.reason?.message, correlation_id: message.correlation_id, input_message_id: message.payload.input_message_id });
        return;
      }
      if (message.message_type === 'service.failure') {
        const error = Object.assign(new Error(message.payload.error?.message || 'Service failure'), {
          code: message.payload.error?.code,
          retryable: message.payload.error?.retryable,
          details: message.payload.error?.details
        });
        this.failTargetService(from, message, error);
        this.onStatus({ type: 'service-failure', service: message.payload.service || from, sender: from, operation: message.payload.operation, code: message.payload.error?.code, message: message.payload.error?.message, retryable: message.payload.error?.retryable, expected: message.payload.error?.details?.expected, received: message.payload.error?.details?.received, correlation_id: message.correlation_id, input_message_id: message.payload.input_message_id });
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
    const error = Object.assign(new Error('Argus graph drained'), { code: 'GRAPH_DRAINED', retryable: false });
    for (const waiters of this.waiters.values()) for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  waitForReceipt(service, messageId, { wire, message, timeoutMs = this.operationTimeout(wire) } = {}) {
    const key = `${service}:${messageId}`;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, service, messageId, wireKey: wire ? this.wireKey(wire) : undefined, timer: undefined };
      waiter.timer = setTimeout(() => {
        const timeout = Object.assign(new Error(`${wire?.to || service} did not complete ${message?.message_type || 'the operation'} within ${timeoutMs} ms`), {
          code: 'OPERATION_TIMEOUT',
          retryable: false,
          timeout_ms: timeoutMs
        });
        if (wire) this.failWire(wire, message || { message_id: messageId, correlation_id: this.prepared.definition.run?.session_id || 'unknown-session', message_type: 'unknown' }, timeout);
        else {
          this.rejectReceipt(service, messageId, timeout);
          this.onStatus({ type: 'service-failure', service, code: timeout.code, message: timeout.message, retryable: timeout.retryable, input_message_id: messageId, operation: 'receipt' });
        }
      }, timeoutMs);
      const waiters = this.waiters.get(key) || new Set();
      waiters.add(waiter);
      this.waiters.set(key, waiters);
    });
  }

  rejectReceiptsForWire(wireKey, error) {
    for (const [key, waiters] of this.waiters) {
      const matching = [...waiters].filter((waiter) => waiter.wireKey === wireKey);
      if (!matching.length) continue;
      const remaining = [...waiters].filter((waiter) => waiter.wireKey !== wireKey);
      if (remaining.length) this.waiters.set(key, new Set(remaining));
      else this.waiters.delete(key);
      for (const waiter of matching) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
  }

  rejectReceiptsForService(service, error) {
    for (const [key, waiters] of this.waiters) {
      const matching = [...waiters].filter((waiter) => waiter.service === service);
      if (!matching.length) continue;
      const remaining = [...waiters].filter((waiter) => waiter.service !== service);
      if (remaining.length) this.waiters.set(key, new Set(remaining));
      else this.waiters.delete(key);
      for (const waiter of matching) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
  }

  resolveReceipt(service, messageId) {
    const key = `${service}:${messageId}`;
    const waiters = this.waiters.get(key);
    if (!waiters) return;
    this.waiters.delete(key);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }
  rejectReceipt(service, messageId, error) {
    const key = `${service}:${messageId}`;
    const waiters = this.waiters.get(key);
    if (!waiters) return;
    this.waiters.delete(key);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
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
