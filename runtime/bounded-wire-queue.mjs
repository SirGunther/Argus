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
  #capacityWaiters = [];
  #failed = false;
  #failure;

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

  get failed() { return this.#failed; }

  enqueue(item) {
    if (this.#failed) throw this.#failure;
    if (this.depth >= this.capacity) throw new QueueOverflowError(this.wireKey, this.capacity);
    this.#items.push(item);
    this.observe(this.depth);
    void this.#pump();
  }

  whenAvailable() {
    if (this.depth < this.capacity) return Promise.resolve();
    return new Promise((resolve) => this.#capacityWaiters.push(resolve));
  }

  async drain() {
    if (this.#failed || this.depth === 0) return;
    await new Promise((resolve) => this.#waiters.push(resolve));
  }

  fail(error) {
    if (this.#failed) return;
    this.#failed = true;
    this.#failure = error;
    this.#items.length = 0;
    this.observe(this.depth);
    for (const resolve of this.#capacityWaiters.splice(0)) resolve();
    for (const resolve of this.#waiters.splice(0)) resolve();
    if (!this.#active) void this.#pump();
  }

  async #pump() {
    if (this.#failed) {
      for (const resolve of this.#waiters.splice(0)) resolve();
      return;
    }
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
      if (this.depth < this.capacity) {
        for (const resolve of this.#capacityWaiters.splice(0)) resolve();
      }
      void this.#pump();
    }
  }
}
