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

  // Recovery-only: seed the guard with the correct next-expected sequence for a stream whose
  // prior history was persisted elsewhere (e.g. a durable checkpoint), without replaying every
  // historical `accept()` call. Additive and backward compatible: no existing caller uses it, and
  // `accept()`/`expected()` behavior for a stream that was never seeded is unchanged. Monotonic
  // only: it can advance a stream's expectation (typically from its unseeded default of 0) but
  // can never rewind one that already advanced further, which would let an already-consumed
  // sequence be accepted again as if it were new.
  seed(streamId, nextSequence) {
    if (typeof streamId !== 'string' || !streamId) throw new Error('streamId is required');
    if (!Number.isInteger(nextSequence) || nextSequence < 0) throw new Error('nextSequence must be a non-negative integer');
    const current = this.#nextByStream.get(streamId) || 0;
    if (nextSequence < current) {
      throw new Error(`Stream ${streamId} cannot be seeded backward from ${current} to ${nextSequence}`);
    }
    this.#nextByStream.set(streamId, nextSequence);
  }
}
