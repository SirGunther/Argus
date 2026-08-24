import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const SERVICE = 'logged-item-memory-store';
const items = new Map();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
    assertDraft(message);
    trace('store-item', 'started', message);
    const draft = message.payload;
    if (items.has(draft.item_id)) throw new Error(`Duplicate item_id: ${draft.item_id}`);
    const stored = {
      item_id: draft.item_id,
      session_id: draft.session_id,
      stored_at: new Date().toISOString(),
      text: draft.text,
      revision: draft.revision,
      source: draft.source
    };
    items.set(stored.item_id, stored);
    emit('logged-item.stored', message.correlation_id, stored, message.message_id);
    trace('store-item', 'completed', message, { item_id: stored.item_id });
  } catch (error) {
    emitFailure('store-item', error, message);
  }
});

function assertDraft(message) {
  if (!message || message.plane !== 'domain' || message.message_type !== 'logged-item.draft') throw new Error('Expected domain logged-item.draft');
  const draft = message.payload;
  if (!draft || typeof draft.item_id !== 'string' || !draft.item_id) throw new Error('item_id is required');
  if (typeof draft.session_id !== 'string' || !draft.session_id) throw new Error('session_id is required');
  if (typeof draft.text !== 'string' || !draft.text.trim()) throw new Error('text is required');
  if (!Number.isInteger(draft.revision) || draft.revision < 0) throw new Error('revision must be a non-negative integer');
  if (!draft.source?.first_segment_id || !draft.source?.last_segment_id) throw new Error('source segment range is required');
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
    error: { type: error.message.startsWith('Duplicate') ? 'DuplicateItem' : 'InvalidInput', message: error.message, retryable: false }
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
