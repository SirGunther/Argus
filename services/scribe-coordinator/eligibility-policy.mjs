// Pure Scribe batch-admission eligibility (ADR-021, MOD-002). No I/O, no timers, no clock
// access: the caller supplies the already-computed idle duration so this stays a plain
// deterministic function of its inputs, independently testable from the stateful pump in
// coordinator.mjs.
//
// Rule: no work is offered while a batch is active. Three new rows are offered immediately.
// One or two rows are offered only once the idle threshold has elapsed, or Close is in
// progress.
export function decideAdmission({ pendingCount, batchActive, idleElapsedMs, idleTimeoutMs, rowsPerBatch, closing }) {
  if (batchActive) return null;
  if (!Number.isInteger(pendingCount) || pendingCount <= 0) return null;
  if (!Number.isInteger(rowsPerBatch) || rowsPerBatch < 1) throw new TypeError('rowsPerBatch must be a positive integer');
  if (pendingCount >= rowsPerBatch) return { size: rowsPerBatch, admissionReason: 'batch-complete' };
  // scribe_batch_identity.admission_reason (contracts/scribe-batch-identity.schema.json) only
  // defines "batch-complete" and "idle-timeout" - there is no distinct governed reason for a
  // Close-forced remainder, so Close reuses "idle-timeout" for a forced partial batch.
  if (closing) return { size: pendingCount, admissionReason: 'idle-timeout' };
  if (Number.isInteger(idleElapsedMs) && idleElapsedMs >= idleTimeoutMs) return { size: pendingCount, admissionReason: 'idle-timeout' };
  return null;
}
