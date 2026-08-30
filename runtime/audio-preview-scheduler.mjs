const MIN_CADENCE_MS = 1500;
const MAX_CADENCE_MS = 3000;
const DEFAULT_CADENCE_MS = 2000;

/**
 * Coalesces immutable active-utterance snapshots without becoming part of the
 * capture critical path. `dispatch` must only enqueue the snapshot; the
 * scheduler never waits for Whisper inference from the capture caller.
 */
export function createAudioPreviewScheduler({ cadenceMs = DEFAULT_CADENCE_MS, snapshot, dispatch, diagnostic = () => {}, scheduleTimer = setTimeout, cancelTimer = clearTimeout } = {}) {
  if (typeof snapshot !== 'function') throw new TypeError('snapshot must be a function');
  if (typeof dispatch !== 'function') throw new TypeError('dispatch must be a function');
  const cadence = Math.max(MIN_CADENCE_MS, Math.min(MAX_CADENCE_MS, Number(cadenceMs) || DEFAULT_CADENCE_MS));
  let active;
  let timer;
  let inFlight;
  let pending;
  let stopped = false;
  let revision = 0;
  const idleWaiters = new Set();

  function observe(utteranceId) {
    if (stopped || !utteranceId) return;
    if (active?.utteranceId !== utteranceId) {
      clearScheduled();
      pending = undefined;
      revision = 0;
      active = { utteranceId, generation: (active?.generation || 0) + 1, changed: true };
      diagnostic('preview.utterance-started', { utterance_id: utteranceId });
    } else {
      active.changed = true;
    }
    schedule();
  }

  function finalize(utteranceId) {
    if (!active || (utteranceId && active.utteranceId !== utteranceId)) return;
    active.finalized = true;
    clearScheduled();
    pending = undefined;
    diagnostic('preview.finalization-priority', { utterance_id: active.utteranceId, in_flight: Boolean(inFlight) });
    active = undefined;
    resolveIdleIfReady();
  }

  function schedule() {
    if (stopped || timer || !active || active.finalized) return;
    timer = scheduleTimer(() => {
      timer = undefined;
      requestLatest();
    }, cadence);
  }

  function requestLatest() {
    if (stopped || !active || active.finalized || !active.changed) {
      resolveIdleIfReady();
      return;
    }
    active.changed = false;
    const request = snapshot({ utterance_id: active.utteranceId, revision: ++revision, generation: active.generation });
    if (!request) {
      schedule();
      return;
    }
    if (inFlight) {
      pending = request;
      diagnostic('preview.snapshot-coalesced', { utterance_id: request.utterance_id, revision: request.revision, replaced_pending: true });
    } else {
      start(request);
    }
    schedule();
  }

  function start(request) {
    const operation = { request };
    inFlight = operation;
    diagnostic('preview.dispatch-started', { utterance_id: request.utterance_id, revision: request.revision, covered_chunk_count: request.covered_chunk_ids?.length });
    Promise.resolve().then(() => dispatch(request)).catch((error) => {
      diagnostic('preview.dispatch-failed', { utterance_id: request.utterance_id, revision: request.revision, error: error?.message || String(error) });
    }).finally(() => {
      if (inFlight !== operation) return;
      inFlight = undefined;
      if (!stopped && pending) {
        const next = pending;
        pending = undefined;
        if (!active || active.finalized || active.utteranceId !== next.utterance_id) {
          diagnostic('preview.snapshot-discarded', { utterance_id: next.utterance_id, revision: next.revision, reason: 'utterance-finalized-or-replaced' });
        } else {
          start(next);
        }
      }
      resolveIdleIfReady();
    });
  }

  function clearScheduled() {
    if (timer) cancelTimer(timer);
    timer = undefined;
  }

  function isIdle() { return !timer && !inFlight && !pending; }

  function waitForIdle() {
    if (isIdle()) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.add(resolve));
  }

  function resolveIdleIfReady() {
    if (!isIdle()) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function reset() {
    clearScheduled();
    active = undefined;
    pending = undefined;
    revision = 0;
  }

  function stop() {
    stopped = true;
    reset();
    resolveIdleIfReady();
  }

  return Object.freeze({
    observe,
    finalize,
    reset,
    stop,
    waitForIdle,
    get active() { return Boolean(active && !active.finalized); },
    get pending() { return Boolean(pending); },
    get inFlight() { return Boolean(inFlight); },
    get cadenceMs() { return cadence; }
  });
}
