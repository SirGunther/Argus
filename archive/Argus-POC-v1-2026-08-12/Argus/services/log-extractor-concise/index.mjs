import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const SERVICE = 'log-extractor-concise';
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
    assertContextWindow(message);
    trace('extract-log', 'started', message);
    const window = message.payload;
    const text = makeConcise(window.segments.at(-1).text);
    emit('logged-item.draft', message.correlation_id, {
      item_id: randomUUID(),
      session_id: window.session_id,
      created_at: new Date().toISOString(),
      text,
      revision: 0,
      source: window.source,
      generator: {
        implementation: SERVICE,
        input_window_id: window.window_id
      }
    }, message.message_id);
    trace('extract-log', 'completed', message, { output_length: text.length });
  } catch (error) {
    emitFailure('extract-log', error, message);
  }
});

function makeConcise(text) {
  let result = text.trim().replace(/^(we|i) should\s+/i, '');
  result = result.replace(/empty owner/gi, 'empty-owner');
  result = result.charAt(0).toUpperCase() + result.slice(1);
  return /[.!?]$/.test(result) ? result : `${result}.`;
}

function assertContextWindow(message) {
  if (!message || message.plane !== 'domain' || message.message_type !== 'transcript.context-window') throw new Error('Expected domain transcript.context-window');
  const window = message.payload;
  if (!window || typeof window.window_id !== 'string' || !window.window_id) throw new Error('window_id is required');
  if (typeof window.session_id !== 'string' || !window.session_id) throw new Error('session_id is required');
  if (!Array.isArray(window.segments) || !window.segments.length) throw new Error('at least one transcript segment is required');
  if (!window.source?.first_segment_id || !window.source?.last_segment_id) throw new Error('source segment range is required');
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
    payload,
    ...(causationId ? { causation_id: causationId } : {})
  };
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
