export class QueueOverflowError extends Error {
  constructor(wireKey, capacity) {
    super(`Bounded wire queue overflow on ${wireKey} at capacity ${capacity}`);
    this.name = 'QueueOverflowError';
    this.wireKey = wireKey;
    this.capacity = capacity;
  }
}

export class BoundedWireQueue {
  #active = false;
  #items = [];
  #waiters = [];

  constructor({ wireKey, capacity, consume, observe = () => {}, onError = () => {} }) {
    this.wireKey = wireKey;
    this.capacity = capacity;
    this.consume = consume;
    this.observe = observe;
    this.onError = onError;
  }

  get depth() {
    return this.#items.length + (this.#active ? 1 : 0);
  }

  enqueue(item) {
    if (this.depth >= this.capacity) throw new QueueOverflowError(this.wireKey, this.capacity);
    this.#items.push(item);
    this.observe(this.depth);
    void this.#pump();
  }

  async drain() {
    if (this.depth === 0) return;
    await new Promise((resolve) => this.#waiters.push(resolve));
  }

  async #pump() {
    if (this.#active) return;
    const item = this.#items.shift();
    if (!item) {
      for (const resolve of this.#waiters.splice(0)) resolve();
      return;
    }
    this.#active = true;
    try {
      await this.consume(item);
    } catch (error) {
      this.onError(error, item);
    } finally {
      this.#active = false;
      this.observe(this.depth);
      void this.#pump();
    }
  }
}
