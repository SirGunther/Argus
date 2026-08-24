import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const SERVICE = 'transcript-window-selector';
const pendingBySession = new Map();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
    assertSegment(message);
    trace('select-window', 'started', message);
    const segment = message.payload;
    const pending = pendingBySession.get(segment.session_id) || [];
    pending.push(segment);
    pendingBySession.set(segment.session_id, pending);

    if (segment.boundary === 'pause' || pending.length >= 3) {
      const first = pending[0];
      const last = pending[pending.length - 1];
      emit('transcript.context-window', message.correlation_id, {
        window_id: randomUUID(),
        session_id: segment.session_id,
        reason: segment.boundary === 'pause' ? 'pause' : 'size',
        segments: pending.map(({ segment_id, sequence, start_time, end_time, text }) => ({
          segment_id,
          sequence,
          start_time,
          end_time,
          text
        })),
        source: {
          first_segment_id: first.segment_id,
          last_segment_id: last.segment_id,
          start_time: first.start_time,
          end_time: last.end_time
        }
      }, message.message_id);
      pendingBySession.delete(segment.session_id);
      trace('select-window', 'completed', message, { segment_count: pending.length });
    } else {
      trace('select-window', 'completed', message, { buffered_count: pending.length });
    }
  } catch (error) {
    emitFailure('select-window', error, message);
  }
});

function assertSegment(message) {
  if (!message || message.plane !== 'domain' || message.message_type !== 'transcript.segment') throw new Error('Expected domain transcript.segment');
  const segment = message.payload;
  if (!segment || typeof segment.segment_id !== 'string' || !segment.segment_id) throw new Error('segment_id is required');
  if (typeof segment.session_id !== 'string' || !segment.session_id) throw new Error('session_id is required');
  if (!Number.isInteger(segment.sequence) || segment.sequence < 0) throw new Error('sequence must be a non-negative integer');
  if (typeof segment.text !== 'string' || !segment.text.trim()) throw new Error('text is required');
  if (!['continuation', 'pause'].includes(segment.boundary)) throw new Error('boundary must be continuation or pause');
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
