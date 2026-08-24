import { createHash, randomUUID } from 'node:crypto';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class MessageIntegrityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MessageIntegrityError';
    this.code = code;
    this.details = details;
  }
}

export class MessageIntegrityLedger {
  #messageIds = new Map();
  #idempotencyKeys = new Map();

  observe(message) {
    const semanticFingerprint = fingerprintMessage(message);
    const knownMessage = this.#messageIds.get(message.message_id);
    if (knownMessage && knownMessage !== semanticFingerprint) {
      throw new MessageIntegrityError('MESSAGE_ID_CONFLICT', `Message id ${message.message_id} was reused with different content`, { message_id: message.message_id });
    }
    const key = message.idempotency_key;
    const knownOperation = key ? this.#idempotencyKeys.get(key) : undefined;
    if (knownOperation && knownOperation !== semanticFingerprint) {
      throw new MessageIntegrityError('IDEMPOTENCY_KEY_CONFLICT', `Idempotency key ${key} was reused with different content`, { idempotency_key: key });
    }
    const duplicate = Boolean(knownMessage || knownOperation);
    this.#messageIds.set(message.message_id, semanticFingerprint);
    if (key) this.#idempotencyKeys.set(key, semanticFingerprint);
    return { duplicate, fingerprint: semanticFingerprint };
  }
}

export function createMessageIdentity({ producer, messageType, logicalKey, messageId = randomUUID() }) {
  if (!UUID_V4.test(messageId)) throw new MessageIntegrityError('INVALID_MESSAGE_ID', 'Current messages require a UUID v4 message_id', { message_id: messageId });
  return {
    message_id: messageId,
    idempotency_key: logicalKey || `${producer}:${messageType}:${messageId}`
  };
}

export function fingerprintMessage(message) {
  const semantic = {
    plane: message.plane,
    message_type: message.message_type,
    producer: message.producer,
    correlation_id: message.correlation_id,
    ...(message.idempotency_key ? { idempotency_key: message.idempotency_key } : {}),
    ...(message.causation_id ? { causation_id: message.causation_id } : {}),
    schema_version: message.schema_version,
    payload: message.payload
  };
  return `sha256:${createHash('sha256').update(canonicalJson(semantic)).digest('hex')}`;
}

export function assertCurrentMessageIdentity(message) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(message?.schema_version || '');
  if (!match || Number(match[1]) !== 1 || Number(match[2]) < 2) return;
  if (!UUID_V4.test(message.message_id)) throw new MessageIntegrityError('INVALID_MESSAGE_ID', 'Schema 1.2+ requires a UUID v4 message_id', { message_id: message.message_id });
  if (typeof message.idempotency_key !== 'string' || !message.idempotency_key) throw new MessageIntegrityError('MISSING_IDEMPOTENCY_KEY', 'Schema 1.2+ requires idempotency_key');
  const expected = fingerprintMessage(message);
  if (message.content_fingerprint !== expected) {
    throw new MessageIntegrityError('CONTENT_FINGERPRINT_MISMATCH', `Message ${message.message_id} content fingerprint does not match its governed content`, { expected, received: message.content_fingerprint });
  }
}

export function fingerprintValue(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
