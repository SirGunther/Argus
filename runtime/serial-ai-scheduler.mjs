import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fingerprintValue } from './message-identity.mjs';

export const AI_WORKLOADS = Object.freeze(['transcription', 'transcript-correction-formatting', 'logged-item-extraction', 'classification-enrichment']);
const PRIORITY = new Map(AI_WORKLOADS.map((name, index) => [name, index]));

export class AiBacklogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AiBacklogError';
    this.code = code;
  }
}

export class JsonLinesAiWorkJournal {
  constructor(filePath) { this.filePath = path.resolve(filePath); }

  async load() {
    const content = await readFile(this.filePath, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
    return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }

  async append(event) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}

export class SerialAiScheduler {
  #queues = new Map(AI_WORKLOADS.map((name) => [name, []]));
  #known = new Map();
  #waiters = [];
  #active;
  #draining = false;
  #ordinal = 0;
  #reserved = 0;
  #reservedByWorkload = new Map(AI_WORKLOADS.map((name) => [name, 0]));
  #admission = Promise.resolve();

  static async create({ executor, journal, capacity = 256, now = () => new Date().toISOString() }) {
    const scheduler = new SerialAiScheduler({ executor, journal, capacity, now });
    await scheduler.#restore();
    scheduler.#kick();
    return scheduler;
  }

  constructor({ executor, journal, capacity, now }) {
    if (typeof executor !== 'function') throw new Error('AI scheduler executor is required');
    this.executor = executor;
    this.journal = journal;
    this.capacity = capacity;
    this.now = now;
  }

  get status() {
    const queued = [...this.#queues.values()].flat();
    return {
      active_work_id: this.#active?.work.work_id || null,
      concurrency: this.#active ? 1 : 0,
      depth: queued.length,
      reserved: this.#reserved,
      capacity: this.capacity,
      by_workload: Object.fromEntries(AI_WORKLOADS.map((name) => [name, this.#queues.get(name).length])),
      oldest_queued_at: queued.sort((a, b) => a.ordinal - b.ordinal)[0]?.work.queued_at || null
    };
  }

  async enqueue(work) {
    validateWork(work);
    const fingerprint = fingerprintValue(work);
    const known = this.#known.get(work.work_id);
    if (known) {
      if (known.fingerprint !== fingerprint) throw new AiBacklogError('AI_WORK_ID_CONFLICT', `AI work id ${work.work_id} was reused with different content`);
      return known.promise;
    }
    if (this.status.depth + (this.#active ? 1 : 0) + this.#reserved >= this.capacity) {
      throw new AiBacklogError('AI_BACKLOG_FULL', `AI backlog reached its declared capacity of ${this.capacity}; work was not dropped`);
    }
    const entry = this.#makeEntry({ ...work, queued_at: work.queued_at || this.now() }, fingerprint, 0, ++this.#ordinal);
    this.#reserved += 1;
    this.#reservedByWorkload.set(work.workload, this.#reservedByWorkload.get(work.workload) + 1);
    this.#known.set(work.work_id, entry);
    const priorAdmission = this.#admission;
    let releaseAdmission;
    this.#admission = new Promise((resolve) => { releaseAdmission = resolve; });
    await priorAdmission;
    try {
      await this.journal.append({ event: 'queued', at: this.now(), ordinal: entry.ordinal, work: entry.work, fingerprint });
      const queue = this.#queues.get(work.workload);
      queue.push(entry);
      queue.sort((left, right) => left.ordinal - right.ordinal);
      this.#kick();
      return entry.promise;
    } catch (error) {
      this.#known.delete(work.work_id);
      entry.reject(error);
      throw error;
    } finally {
      releaseAdmission();
      this.#reserved -= 1;
      this.#reservedByWorkload.set(work.workload, this.#reservedByWorkload.get(work.workload) - 1);
      this.#settleIdleWaiters();
      if (this.status.depth) this.#kick();
    }
  }

  async whenIdle() {
    if (!this.#active && this.status.depth === 0 && this.#reserved === 0) return;
    await new Promise((resolve) => this.#waiters.push(resolve));
  }

  async #restore() {
    const events = await this.journal.load();
    const recovered = new Map();
    for (const event of events) {
      if (event.event === 'queued') recovered.set(event.work.work_id, { ...event, terminal: false, attempts: 0 });
      if (event.event === 'started') {
        const state = recovered.get(event.work_id);
        if (state) state.attempts = event.attempt;
      }
      if (event.event === 'completed' || event.event === 'failed') {
        const state = recovered.get(event.work_id);
        if (state) {
          state.terminal = true;
          state.terminalEvent = event;
        }
      }
      this.#ordinal = Math.max(this.#ordinal, event.ordinal || 0);
    }
    for (const state of [...recovered.values()].sort((a, b) => a.ordinal - b.ordinal)) {
      const entry = this.#makeEntry(state.work, state.fingerprint, state.attempts, state.ordinal);
      this.#known.set(entry.work.work_id, entry);
      if (!state.terminal) {
        this.#queues.get(entry.work.workload).push(entry);
      } else if (state.terminalEvent.event === 'completed') {
        entry.resolve(state.terminalEvent.result);
      } else {
        entry.reject(new AiBacklogError('AI_WORK_TERMINAL_FAILURE', state.terminalEvent.error || `AI work ${entry.work.work_id} failed`));
      }
    }
  }

  #makeEntry(work, fingerprint, attempts, ordinal) {
    let resolve;
    let reject;
    const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    promise.catch(() => {});
    return { work, fingerprint, attempts, ordinal, promise, resolve, reject };
  }

  #kick() {
    if (this.#draining) return;
    this.#draining = true;
    queueMicrotask(() => void this.#drain());
  }

  async #drain() {
    try {
      while (!this.#active) {
        const entry = this.#takeNext();
        if (!entry) break;
        this.#active = entry;
        entry.attempts += 1;
        await this.journal.append({ event: 'started', at: this.now(), work_id: entry.work.work_id, attempt: entry.attempts });
        try {
          const result = await this.executor(entry.work, { attempt: entry.attempts });
          await this.journal.append({ event: 'completed', at: this.now(), work_id: entry.work.work_id, attempt: entry.attempts, result });
          entry.resolve(result);
        } catch (error) {
          const maxAttempts = entry.work.recovery?.max_attempts || 1;
          if (entry.attempts < maxAttempts) {
            await this.journal.append({ event: 'retrying', at: this.now(), work_id: entry.work.work_id, attempt: entry.attempts, error: error.message });
            this.#queues.get(entry.work.workload).unshift(entry);
          } else {
            await this.journal.append({ event: 'failed', at: this.now(), work_id: entry.work.work_id, attempt: entry.attempts, error: error.message });
            entry.reject(error);
          }
        } finally {
          this.#active = undefined;
        }
      }
    } finally {
      this.#draining = false;
      if (this.status.depth && this.#canTakeNext()) this.#kick();
      else this.#settleIdleWaiters();
    }
  }

  #settleIdleWaiters() {
    if (!this.#active && this.status.depth === 0 && this.#reserved === 0) {
      for (const resolve of this.#waiters.splice(0)) resolve();
    }
  }

  #takeNext() {
    for (const workload of AI_WORKLOADS) {
      const entry = this.#queues.get(workload).shift();
      if (entry) return entry;
      if (this.#reservedByWorkload.get(workload) > 0) return undefined;
    }
    return undefined;
  }

  #canTakeNext() {
    for (const workload of AI_WORKLOADS) {
      if (this.#queues.get(workload).length) return true;
      if (this.#reservedByWorkload.get(workload) > 0) return false;
    }
    return false;
  }
}

function validateWork(work) {
  if (!work || typeof work !== 'object') throw new Error('AI work must be an object');
  if (typeof work.work_id !== 'string' || !work.work_id) throw new Error('AI work_id is required');
  if (!PRIORITY.has(work.workload)) throw new Error(`Unknown AI workload: ${work.workload}`);
  if (typeof work.session_id !== 'string' || !work.session_id) throw new Error('AI session_id is required');
  if (!Number.isInteger(work.sequence) || work.sequence < 0) throw new Error('AI sequence must be a non-negative integer');
  if (!work.input || typeof work.input !== 'object') throw new Error('AI input is required');
  if (work.recovery && (!Number.isInteger(work.recovery.max_attempts) || work.recovery.max_attempts < 1)) throw new Error('AI recovery.max_attempts must be a positive integer');
}
