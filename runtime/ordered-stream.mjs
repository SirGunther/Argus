export class OrderedStreamError extends Error {
  constructor(code, message, { retryable, expected, received, streamId }) {
    super(message);
    this.name = 'OrderedStreamError';
    this.code = code;
    this.retryable = retryable;
    this.expected = expected;
    this.received = received;
    this.streamId = streamId;
  }
}

export class OrderedStreamGuard {
  #nextByStream = new Map();

  accept(streamId, sequence) {
    if (typeof streamId !== 'string' || !streamId) throw new Error('streamId is required');
    if (!Number.isInteger(sequence) || sequence < 0) throw new Error('sequence must be a non-negative integer');
    const expected = this.#nextByStream.get(streamId) || 0;
    if (sequence > expected) {
      throw new OrderedStreamError('SEQUENCE_GAP', `Stream ${streamId} expected sequence ${expected} but received ${sequence}`, { retryable: true, expected, received: sequence, streamId });
    }
    if (sequence < expected) {
      throw new OrderedStreamError('LATE_MESSAGE', `Stream ${streamId} already advanced to sequence ${expected}; received late sequence ${sequence}`, { retryable: false, expected, received: sequence, streamId });
    }
    this.#nextByStream.set(streamId, expected + 1);
    return { streamId, sequence, next: expected + 1 };
  }

  expected(streamId) {
    return this.#nextByStream.get(streamId) || 0;
  }
}
