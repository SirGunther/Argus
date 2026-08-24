import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const SERVICE = 'fake-transcript-source';
const fixture = [
  { start_time: '16:23:22.000', end_time: '16:23:27.000', text: 'We need to inspect the owner mapping.', boundary: 'continuation' },
  { start_time: '16:23:27.000', end_time: '16:23:33.000', text: 'The fallback points to the legacy team identifier.', boundary: 'continuation' },
  { start_time: '16:23:33.000', end_time: '16:23:41.000', text: 'We should replace the fallback and test the empty owner case.', boundary: 'pause' }
];

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
    assertStart(message);
    trace('emit-fixture', 'started', message);
    fixture.forEach((segment, sequence) => {
      emit('transcript.segment', message.correlation_id, {
        segment_id: `segment-${sequence + 1}`,
        session_id: message.payload.session_id,
        sequence,
        ...segment
      }, message.message_id);
    });
    trace('emit-fixture', 'completed', message, { emitted_count: fixture.length });
  } catch (error) {
    emitFailure('emit-fixture', error, message);
  }
});

function assertStart(message) {
  if (!message || message.plane !== 'control' || message.message_type !== 'lifecycle.start') throw new Error('Expected control lifecycle.start');
  if (typeof message.payload?.session_id !== 'string' || !message.payload.session_id) throw new Error('session_id is required');
  if (typeof message.correlation_id !== 'string' || !message.correlation_id) throw new Error('correlation_id is required');
}

function emit(messageType, correlationId, payload, causationId) {
  const message = {
    message_id: randomUUID(),
    plane: messageType === 'service.failure' ? 'control' : 'domain',
    message_type: messageType,
    timestamp: new Date().toISOString(),
    producer: SERVICE,
    correlation_id: correlationId,
    schema_version: 1,
    payload
  };
  if (causationId) message.causation_id = causationId;
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function emitFailure(operation, error, inputMessage) {
  emit('service.failure', inputMessage?.correlation_id || 'unattributed', {
    service: SERVICE,
    operation,
    ...(inputMessage?.message_id ? { input_message_id: inputMessage.message_id } : {}),
    error: { type: 'InvalidInput', message: error.message, retryable: false }
  }, inputMessage?.message_id);
  trace(operation, 'failed', inputMessage, { error_type: 'InvalidInput', error: error.message });
}

function trace(operation, status, inputMessage, detail = {}) {
  process.stderr.write(`${JSON.stringify({
    service: SERVICE,
    operation,
    status,
    message_id: inputMessage?.message_id,
    correlation_id: inputMessage?.correlation_id,
    timestamp: new Date().toISOString(),
    ...detail
  })}\n`);
}
