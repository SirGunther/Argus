import readline from 'node:readline';
import { createMessageIdentity, fingerprintMessage, fingerprintValue, MessageIntegrityLedger } from './message-identity.mjs';

export class ServiceOperationError extends Error {
  constructor(message, { code = 'INTERNAL_ERROR', category = 'internal', retryable = false, rejected = false, details } = {}) {
    super(message);
    this.code = code;
    this.category = category;
    this.retryable = retryable;
    this.rejected = rejected;
    this.details = details;
  }
}

export function runLineService({ service, operations, onDrain, onReady }) {
  const producer = process.env.ARGUS_SERVICE_INSTANCE_ID || service;
  const integrity = new MessageIntegrityLedger();
  const completed = new Map();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let processing = Promise.resolve();
  const ready = Promise.resolve().then(() => onReady?.());
  input.on('line', (line) => {
    processing = processing.then(() => ready).then(() => processLine(line));
  });

  async function processLine(line) {
    let message;
    try {
      message = JSON.parse(line);
      const identity = integrity.observe(message);
      if (message.plane === 'control' && message.message_type === 'lifecycle.health-check') {
        emit(producer, 'control', 'service.health', message.correlation_id, {
          service,
          probe_id: message.payload.probe_id,
          status: 'ready',
          runtime_kind: 'node',
          rss_bytes: process.memoryUsage().rss
        }, message.message_id);
        return;
      }
      if (message.plane === 'control' && message.message_type === 'lifecycle.drain') {
        const outputs = (await onDrain?.(message) || []).map((output, index) => ({
          ...output,
          identityKey: output.identityKey || `${producer}:${output.messageType}:drain:${message.idempotency_key || message.message_id}:${index}`
        }));
        for (const output of outputs) emit(producer, output.plane || 'domain', output.messageType, message.correlation_id, output.payload, message.message_id, output.identityKey, output.schemaVersion);
        emit(producer, 'control', 'service.drained', message.correlation_id, {
          service,
          pending_operations: 0
        }, message.message_id);
        return;
      }

      const operation = operations[message.message_type];
      if (!operation) throw new ServiceOperationError(`Unsupported input contract: ${message.message_type}`, { code: 'INVALID_INPUT', category: 'validation' });
      const inputKey = message.idempotency_key || message.message_id;
      const known = completed.get(inputKey);
      if (identity.duplicate && known && operation.onDuplicate !== 'handle') {
        for (const output of known.outputs) emit(producer, output.plane || 'domain', output.messageType, message.correlation_id, output.payload, known.inputMessageId, output.identityKey, output.schemaVersion);
        emitCompletion(producer, operation.name, message, true);
        trace(service, operation.name, 'duplicate-replayed', message, { output_count: known.outputs.length });
        return;
      }
      trace(service, operation.name, 'started', message);
      const outputs = (await operation.handle(message) || []).map((output, index) => ({
        ...output,
        identityKey: output.identityKey || `${producer}:${output.messageType}:${message.idempotency_key || message.message_id}:${index}`
      }));
      const outputFingerprint = fingerprintValue(outputs);
      if (known && known.outputFingerprint !== outputFingerprint) {
        throw new ServiceOperationError(`Idempotent operation ${inputKey} produced a different result`, { code: 'IDEMPOTENT_OUTPUT_CONFLICT', category: 'conflict' });
      }
      const outputCausationId = known?.inputMessageId || message.message_id;
      for (const output of outputs) {
        emit(producer, output.plane || 'domain', output.messageType, message.correlation_id, output.payload, outputCausationId, output.identityKey, output.schemaVersion);
      }
      if (!known) completed.set(inputKey, {
        outputs: operation.retainOutputs === false ? [] : outputs,
        outputFingerprint,
        inputMessageId: message.message_id
      });
      emitCompletion(producer, operation.name, message, Boolean(known));
      trace(service, operation.name, 'completed', message, {
        ...(operation.traceDetail?.(message, outputs) || {}),
        retained_output_count: operation.retainOutputs === false ? 0 : outputs.length
      });
    } catch (error) {
      const normalized = error instanceof ServiceOperationError
        ? error
        : new ServiceOperationError(error.message, { code: error.code || 'INVALID_INPUT', category: error.name === 'MessageIntegrityError' ? 'conflict' : 'validation', details: error.details });
      const outcomeType = normalized.rejected ? 'operation.rejected' : 'service.failure';
      const payload = normalized.rejected ? {
        service: producer,
        operation: operations[message?.message_type]?.name || 'receive-message',
        input_message_id: message?.message_id,
        outcome: 'rejected',
        reason: { code: normalized.code, message: normalized.message, ...(normalized.details ? { details: normalized.details } : {}) }
      } : {
        service: producer,
        operation: operations[message?.message_type]?.name || 'receive-message',
        ...(message?.message_id ? { input_message_id: message.message_id } : {}),
        outcome: 'failure',
        error: {
          code: normalized.code,
          category: normalized.category,
          message: normalized.message,
          retryable: normalized.retryable,
          ...(normalized.details ? { details: normalized.details } : {})
        }
      };
      const outcomeIdentity = normalized.rejected && message
        ? `${producer}:${outcomeType}:${message.message_id}:${normalized.code}`
        : undefined;
      emit(producer, 'control', outcomeType, message?.correlation_id || 'unattributed', payload, message?.message_id, outcomeIdentity);
      trace(service, operations[message?.message_type]?.name || 'receive-message', normalized.rejected ? 'rejected' : 'failed', message, { error_type: normalized.code, error: normalized.message });
    }
  }
}

function emit(service, plane, messageType, correlationId, payload, causationId, identityKey, schemaVersion = '1.2.0') {
  const identity = createMessageIdentity({ producer: service, messageType, logicalKey: identityKey });
  const envelope = {
    ...identity,
    plane,
    message_type: messageType,
    timestamp: new Date().toISOString(),
    producer: service,
    correlation_id: correlationId,
    schema_version: schemaVersion,
    payload,
    ...(causationId ? { causation_id: causationId } : {})
  };
  envelope.content_fingerprint = fingerprintMessage(envelope);
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function emitCompletion(service, operation, message, duplicate) {
  emit(service, 'control', 'operation.completed', message.correlation_id, {
    service,
    operation,
    input_message_id: message.message_id,
    outcome: 'success',
    duplicate
  }, message.message_id, `${service}:operation.completed:${message.message_id}:${duplicate ? 'duplicate' : 'initial'}`);
}

function trace(service, operation, status, inputMessage, detail = {}) {
  process.stderr.write(`${JSON.stringify({
    service,
    operation,
    status,
    message_id: inputMessage?.message_id,
    correlation_id: inputMessage?.correlation_id,
    timestamp: new Date().toISOString(),
    ...detail
  })}\n`);
}
