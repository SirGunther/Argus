export function createSerialWhisperLane({ diagnostic = () => {} } = {}) {
  let active;
  let pendingPreview;
  let finalActive = false;
  const finalizedUtterances = new Set();

  function submitPreview(job) {
    if (finalizedUtterances.has(job.utterance_id)) {
      diagnostic('preview.discarded', { utterance_id: job.utterance_id, revision: job.revision, reason: 'utterance-finalized' });
      return;
    }
    if (active || finalActive) {
      pendingPreview = job;
      diagnostic('preview.coalesced', { utterance_id: job.utterance_id, revision: job.revision, replaced_pending: true, final_active: finalActive });
      return;
    }
    startPreview(job);
  }

  async function runFinal(job) {
    finalizedUtterances.add(job.utterance_id);
    finalActive = true;
    if (pendingPreview?.utterance_id === job.utterance_id) pendingPreview = undefined;
    const current = active;
    if (current) {
      if (current.job.utterance_id !== job.utterance_id) pendingPreview = current.job;
      current.controller.abort();
      diagnostic('preview.cancelled-for-final', { utterance_id: current.job.utterance_id, revision: current.job.revision, final_utterance_id: job.utterance_id });
      await current.promise.catch(() => {});
    }
    try {
      return await job.run();
    } finally {
      finalActive = false;
      drainPreview();
    }
  }

  function canEmitPreview(utteranceId, revision) {
    return !finalizedUtterances.has(utteranceId) && (!active || active.job.utterance_id !== utteranceId || active.job.revision === revision);
  }

  function startPreview(job) {
    const controller = new AbortController();
    const operation = { job, controller };
    active = operation;
    operation.promise = Promise.resolve().then(() => job.run(controller.signal)).catch((error) => {
      if (error?.code !== 'STT_PREVIEW_SUPERSEDED') diagnostic('preview.failed', { utterance_id: job.utterance_id, revision: job.revision, error: error?.message || String(error) });
    }).finally(() => {
      if (active !== operation) return;
      active = undefined;
      drainPreview();
    });
  }

  function drainPreview() {
    if (finalActive || active || !pendingPreview) return;
    const next = pendingPreview;
    pendingPreview = undefined;
    if (finalizedUtterances.has(next.utterance_id)) {
      diagnostic('preview.discarded', { utterance_id: next.utterance_id, revision: next.revision, reason: 'utterance-finalized' });
      return drainPreview();
    }
    startPreview(next);
  }

  return Object.freeze({
    submitPreview,
    runFinal,
    canEmitPreview,
    isFinalized: (utteranceId) => finalizedUtterances.has(utteranceId),
    get active() { return Boolean(active); },
    get pending() { return Boolean(pendingPreview); },
    get finalActive() { return finalActive; }
  });
}
