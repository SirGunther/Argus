import { fingerprintValue } from '../../runtime/message-identity.mjs';
import { OrderedStreamError, OrderedStreamGuard } from '../../runtime/ordered-stream.mjs';
import { ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { EXTRACTION_BATCH_OUTPUT_LIMITS, validateScribeBatchModelResponse } from '../../contracts/model-protocol.mjs';
import { buildBatchIdentity } from './batch-identity.mjs';
import { decideAdmission } from './eligibility-policy.mjs';

// Scribe batch-admission defaults (ADR-021, MOD-002, contracts/scribe-batch-policy.schema.json).
// Used only until a real `scribe.batch-policy` control message configures the session.
const DEFAULT_POLICY = Object.freeze({
  policy_id: 'scribe-default-policy',
  policy_version: '1.0.0',
  admission: Object.freeze({ rows_per_batch: 3, idle_timeout_ms: 15000 }),
  context: Object.freeze({ max_total_context_tokens: 8000 }),
  generation: Object.freeze({ policy_profile: 'scribe-default', instruction_version: '1.0.0' })
});

// Bounded ceiling on how many times the coordinator will re-dispatch the identical batch after
// a terminal `ai.work-completed` failure before it stops auto-retrying and surfaces a stalled,
// still-pending batch (governed recovery, not an infinite tight loop against a broken endpoint).
const DEFAULT_MAX_DISPATCH_ATTEMPTS = 3;

// Surfaced when a batch stalls (either the dispatch-attempt ceiling was reached, or the failure
// was marked non-retryable) while a caller is waiting on Close's `settled` promise: rows remain
// pending and no further automatic progress will happen, so Close must never report success.
export class ScribeBatchStalledError extends Error {
  constructor(sessionId, batchIdentity, cause) {
    super(`Scribe batch ${batchIdentity.request_id} for session ${sessionId} is stalled with rows still pending`);
    this.name = 'ScribeBatchStalledError';
    this.code = 'SCRIBE_BATCH_STALLED';
    this.category = 'conflict';
    this.retryable = false;
    this.sessionId = sessionId;
    this.batchIdentity = batchIdentity;
    this.cause = cause;
  }
}

/**
 * The standalone Scribe coordinator: a cursor-driven admission state machine, independent of
 * storage and model HTTP calls (SCRIBE-02). One event-driven pump is woken by finalized
 * evidence, the single idle deadline, a work outcome/acknowledgement, recovery state, and
 * Close; every wake path funnels through `pump()`, which defers the actual admit/no-admit
 * decision to the pure `eligibility-policy.mjs` module.
 *
 * All mutating methods return an array of plain dispatch/evaluated descriptors (never wire
 * envelopes) so this module stays independently unit-testable with an injected clock and has
 * no knowledge of the model provider, transport envelope, or persistence.
 */
export function createScribeCoordinator({ clock = {}, onSpontaneousDispatch } = {}) {
  const now = typeof clock.now === 'function' ? clock.now : () => Date.now();
  const scheduleTimer = typeof clock.setTimeout === 'function' ? clock.setTimeout : setTimeout;
  const cancelTimer = typeof clock.clearTimeout === 'function' ? clock.clearTimeout : clearTimeout;

  const sessions = new Map();
  const ordering = new OrderedStreamGuard();

  function stateFor(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        policy: undefined,
        pendingSegments: [],
        acceptedFingerprints: new Map(),
        accumulatedSinceMs: null,
        idleTimer: undefined,
        cursor: { last_segment_id: null, last_sequence: -1, last_revision: 0 },
        inFlight: undefined,
        attemptsByRequestId: new Map(),
        closing: false,
        stalledRequestId: undefined,
        settleWaiters: undefined
      };
      sessions.set(sessionId, state);
    }
    return state;
  }

  function policyFor(state, sessionId) {
    return state.policy || { ...DEFAULT_POLICY, session_id: sessionId };
  }

  function configurePolicy(payload) {
    validatePolicy(payload);
    const state = stateFor(payload.session_id);
    const current = policyFor(state, payload.session_id);
    if (fingerprintValue(current) === fingerprintValue(payload)) return [];
    if (state.policy && state.policy.policy_id === payload.policy_id) {
      throw new ServiceOperationError(`Scribe batch policy id ${payload.policy_id} was reused with different content`, { code: 'SCRIBE_POLICY_ID_CONFLICT', category: 'conflict' });
    }
    if (state.pendingSegments.length || state.inFlight) {
      throw rejected('SCRIBE_POLICY_CHANGE_DURING_ACTIVE_BATCH', 'Scribe batch policy cannot change while rows are pending or a batch is active');
    }
    state.policy = structuredClone(payload);
    return [];
  }

  function acceptFinalizedSegment(segment) {
    validateSegment(segment);
    const state = stateFor(segment.session_id);
    const fingerprint = fingerprintValue(segment);
    const known = state.acceptedFingerprints.get(segment.segment_id);
    if (known) {
      if (known !== fingerprint) throw new ServiceOperationError(`Segment id ${segment.segment_id} was reused with different content`, { code: 'SEGMENT_ID_CONFLICT', category: 'conflict' });
      return [];
    }
    try {
      ordering.accept(segment.session_id, segment.sequence);
    } catch (error) {
      if (error instanceof OrderedStreamError) {
        throw new ServiceOperationError(error.message, { code: error.code, category: 'conflict', retryable: error.retryable, rejected: error.code === 'LATE_MESSAGE', details: { expected: error.expected, received: error.received, stream_id: error.streamId } });
      }
      throw error;
    }
    state.acceptedFingerprints.set(segment.segment_id, fingerprint);
    state.pendingSegments.push(structuredClone(segment));
    state.accumulatedSinceMs = now();
    const outputs = pump(segment.session_id);
    scheduleIdleTimer(segment.session_id);
    return outputs;
  }

  function recordDispatchFingerprint(sessionId, workId, requestFingerprint) {
    const state = stateFor(sessionId);
    if (!state.inFlight || state.inFlight.workId !== workId) return;
    state.inFlight.requestFingerprint = requestFingerprint;
  }

  function acceptWorkCompleted(completion) {
    if (completion.workload !== 'logged-item-extraction') return [];
    const sessionId = completion.session_id;
    const state = stateFor(sessionId);
    const inFlight = state.inFlight;
    if (!inFlight || completion.work_id !== inFlight.workId) {
      throw new ServiceOperationError(`No matching in-flight Scribe batch for work ${completion.work_id}`, { code: 'SCRIBE_WORK_ID_CONFLICT', category: 'conflict' });
    }
    if (completion.attempt !== inFlight.attempt) {
      throw new ServiceOperationError(`Scribe batch result attempt ${completion.attempt} does not match in-flight attempt ${inFlight.attempt}`, { code: 'SCRIBE_ATTEMPT_CONFLICT', category: 'conflict' });
    }
    const result = completion.result || {};
    if (result.work_id !== completion.work_id) {
      throw new ServiceOperationError(`Scribe batch result work_id ${result.work_id} does not match completion work_id ${completion.work_id}`, { code: 'SCRIBE_WORK_ID_CONFLICT', category: 'conflict' });
    }
    if (result.status === 'failed') return handleBatchFailure(sessionId, state, inFlight, result.error || { code: 'MODEL_REQUEST_FAILED', category: 'dependency', message: 'model request failed', retryable: true });
    if (result.status !== 'succeeded') {
      throw new ServiceOperationError(`Unsupported Scribe batch result status: ${result.status}`, { code: 'SCRIBE_RESULT_STATUS_INVALID', category: 'validation' });
    }
    if (inFlight.requestFingerprint && result.request_fingerprint !== inFlight.requestFingerprint) {
      throw new ServiceOperationError(`Scribe batch result fingerprint does not match the in-flight request for work ${completion.work_id}`, { code: 'SCRIBE_FINGERPRINT_CONFLICT', category: 'conflict' });
    }
    let response;
    try {
      response = validateScribeBatchModelResponse(result.response, { max_output_tokens: EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens });
    } catch (error) {
      return handleBatchFailure(sessionId, state, inFlight, { code: error.cause?.code || 'INVALID_MODEL_OUTPUT', category: 'validation', message: error.message, retryable: false });
    }
    if (fingerprintValue(response.batch_identity) !== fingerprintValue(inFlight.batchIdentity)) {
      throw new ServiceOperationError(`Scribe batch result batch identity does not match the in-flight batch for work ${completion.work_id}`, { code: 'SCRIBE_BATCH_IDENTITY_CONFLICT', category: 'conflict' });
    }
    if (!response.items.length) {
      return completeBatch(sessionId, state, {
        ack_id: `ack-${inFlight.batchIdentity.request_id}`,
        accepted: true,
        acknowledged_at: new Date(now()).toISOString(),
        logged_item_ids: []
      });
    }
    // One expected slot per validated response item, in item order, each carrying the exact
    // source-segment boundary independently derived from that item's own `source_segment_ids`
    // (already proven by `validateScribeBatchModelResponse` to cite only this batch's own
    // segments) plus the item's own proposed text. `acceptStoredItem` below fills a slot only
    // when a stored item's real `source` boundary AND `text` match that slot, so a count-only,
    // arbitrary, or reordered item_id can never fill an unrelated slot.
    //
    // This is a best-effort correlation, not a true identity match: neither the model-response
    // schema nor `logged-item.stored` carries a shared deterministic item identifier (the model
    // is never allowed to assign authoritative identity, and this standalone coordinator has no
    // access to whatever identity the active Logged Item owner assigns), so two *distinct*
    // response items that legitimately share both the same source range and the same text
    // remain indistinguishable and are filled in encounter order. Eliminating that residual
    // ambiguity requires a deterministic evaluated-batch/item-identity carrier that does not yet
    // exist in the governed contracts (SCRIBE-04/SCRIBE-01 territory) — this coordinator cannot
    // invent one unilaterally without risking divergence from whatever the extractor implements.
    inFlight.awaitingAck = {
      expectedItems: response.items.map((item) => ({ ...sourceBoundaryForItem(item, inFlight.batchIdentity.segments), text: item.text })),
      assigned: new Array(response.items.length).fill(null)
    };
    return [];
  }

  function acceptStoredItem(storedItem) {
    const sessionId = storedItem?.session_id;
    const state = stateFor(sessionId);
    const inFlight = state.inFlight;
    const awaitingAck = inFlight?.awaitingAck;
    const expectedRequestId = inFlight?.batchIdentity?.request_id;
    // The item-position mapping between `items[]` and `logged_item_ids` is a runtime
    // invariant the schema cannot enforce (contracts/scribe-contract-handoff.md); the
    // coordinator correlates the batch by reusing `generator.input_window_id` (contracts/
    // logged-item-stored.schema.json) as the batch request_id, matching the existing single-item
    // boundary the handoff doc says the draft-id derivation must match. Each individual item is
    // then correlated to its exact `items[]` position by matching the stored item's own
    // `source.first_segment_id`/`last_segment_id` boundary and `text` against the slot derived
    // for it in `acceptWorkCompleted` above — a count-only check would let an arbitrary,
    // out-of-order, or unrelated item_id silently fill any open slot.
    const storedRequestId = storedItem?.generator?.input_window_id;
    if (!inFlight || !awaitingAck || storedRequestId !== expectedRequestId) {
      throw new ServiceOperationError(`No Scribe batch is awaiting an item acknowledgement matching ${storedItem?.item_id}`, { code: 'SCRIBE_ACKNOWLEDGEMENT_CONFLICT', category: 'conflict' });
    }
    if (awaitingAck.assigned.includes(storedItem.item_id)) return [];
    const slot = awaitingAck.expectedItems.findIndex((expected, index) => awaitingAck.assigned[index] === null
      && expected.first_segment_id === storedItem.source?.first_segment_id
      && expected.last_segment_id === storedItem.source?.last_segment_id
      && expected.text === storedItem.text);
    if (slot === -1) {
      throw new ServiceOperationError(`Stored item ${storedItem.item_id} does not match any pending Scribe extraction item for batch ${expectedRequestId}`, { code: 'SCRIBE_ACKNOWLEDGEMENT_CONFLICT', category: 'conflict' });
    }
    awaitingAck.assigned[slot] = storedItem.item_id;
    if (awaitingAck.assigned.includes(null)) return [];
    return completeBatch(sessionId, state, {
      ack_id: `ack-${expectedRequestId}`,
      accepted: true,
      acknowledged_at: new Date(now()).toISOString(),
      logged_item_ids: [...awaitingAck.assigned]
    });
  }

  function close(sessionId) {
    const state = stateFor(sessionId);
    state.closing = true;
    cancelIdleTimer(state);
    const outputs = pump(sessionId);
    return { outputs, settled: whenSettled(sessionId) };
  }

  function stop(sessionId) {
    stateFor(sessionId);
    return [];
  }

  function status(sessionId) {
    const state = stateFor(sessionId);
    return {
      busy: Boolean(state.inFlight),
      pendingCount: state.pendingSegments.length,
      cursor: { ...state.cursor },
      idleTimerActive: Boolean(state.idleTimer),
      closing: state.closing,
      stalled: Boolean(state.stalledRequestId),
      inFlight: state.inFlight ? {
        workId: state.inFlight.workId,
        attempt: state.inFlight.attempt,
        requestId: state.inFlight.batchIdentity.request_id,
        awaitingAck: state.inFlight.awaitingAck ? { expectedCount: state.inFlight.awaitingAck.expectedItems.length, storedItemIds: state.inFlight.awaitingAck.assigned.filter((id) => id !== null) } : undefined
      } : undefined
    };
  }

  function restoreState(sessionId, snapshot) {
    const state = stateFor(sessionId);
    if (state.inFlight || state.pendingSegments.length || state.cursor.last_sequence >= 0) {
      throw rejected('SCRIBE_RECOVERY_CONFLICT', 'Scribe recovery state was supplied for a session that already has coordinator state');
    }
    validateRecoverySnapshot(snapshot);
    state.cursor = { ...snapshot.cursor };
    for (const segment of snapshot.pendingSegments) {
      state.acceptedFingerprints.set(segment.segment_id, fingerprintValue(segment));
      state.pendingSegments.push(structuredClone(segment));
    }
    state.accumulatedSinceMs = state.pendingSegments.length ? (snapshot.accumulatedSinceMs ?? now()) : null;
    // Seed the shared ordering guard with the correct next-expected sequence so a legitimately
    // continuing stream is not mistaken for one starting fresh at 0 (runtime/ordered-stream.mjs's
    // guard has no memory of a restarted process). Derived from the highest sequence already
    // accounted for across the recovered cursor, pending remainder, and any in-flight batch's
    // admitted segments.
    const knownSequences = [
      snapshot.cursor.last_sequence,
      ...snapshot.pendingSegments.map((segment) => segment.sequence),
      ...(snapshot.inFlightBatch?.admittedSegments || []).map((segment) => segment.sequence)
    ];
    ordering.seed(sessionId, Math.max(-1, ...knownSequences) + 1);
    if (snapshot.inFlightBatch) {
      const { batchIdentity, admittedSegments, attempt } = snapshot.inFlightBatch;
      state.inFlight = {
        batchIdentity,
        admittedSegments: admittedSegments.map((segment) => structuredClone(segment)),
        attempt,
        workId: workIdFor(sessionId, batchIdentity, attempt),
        dispatchedAtIso: new Date(now()).toISOString(),
        awaitingAck: undefined,
        requestFingerprint: undefined
      };
      state.attemptsByRequestId.set(batchIdentity.request_id, attempt);
      return [];
    }
    return pump(sessionId);
  }

  function pump(sessionId) {
    const state = stateFor(sessionId);
    const policy = policyFor(state, sessionId);
    const batchActive = Boolean(state.inFlight);
    const idleElapsedMs = state.pendingSegments.length && state.accumulatedSinceMs != null ? now() - state.accumulatedSinceMs : 0;
    const decision = state.stalledRequestId ? null : decideAdmission({
      pendingCount: state.pendingSegments.length,
      batchActive,
      idleElapsedMs,
      idleTimeoutMs: policy.admission.idle_timeout_ms,
      rowsPerBatch: policy.admission.rows_per_batch,
      closing: state.closing
    });
    if (!decision) {
      scheduleIdleTimer(sessionId);
      return [];
    }
    const admitted = state.pendingSegments.splice(0, decision.size);
    const batchIdentity = buildBatchIdentity({ sessionId, segments: admitted, admissionReason: decision.admissionReason, policy });
    const attempt = (state.attemptsByRequestId.get(batchIdentity.request_id) || 0) + 1;
    state.attemptsByRequestId.set(batchIdentity.request_id, attempt);
    state.inFlight = {
      batchIdentity,
      admittedSegments: admitted,
      attempt,
      workId: workIdFor(sessionId, batchIdentity, attempt),
      dispatchedAtIso: new Date(now()).toISOString(),
      awaitingAck: undefined,
      requestFingerprint: undefined
    };
    cancelIdleTimer(state);
    return [{
      type: 'dispatch',
      sessionId,
      workId: state.inFlight.workId,
      attempt,
      batchIdentity,
      newEvidenceSegments: admitted.map(projectSegmentContent),
      policy
    }];
  }

  function handleBatchFailure(sessionId, state, inFlight, error) {
    const failureOutput = { type: 'failure', sessionId, workId: inFlight.workId, batchIdentity: inFlight.batchIdentity, attempt: inFlight.attempt, error };
    state.inFlight = undefined;
    // Retain identical pending/retry state: the exact same segments return to the front of the
    // backlog so the next pump rebuilds the identical batch identity (deterministic from
    // segment content + policy/instruction identity in batch-identity.mjs).
    state.pendingSegments = [...inFlight.admittedSegments, ...state.pendingSegments];
    // A non-retryable error (e.g. permanently malformed model output) must never be
    // auto-retried, not even once — retrying it would just reproduce the identical failure.
    // Only a retryable error gets up to DEFAULT_MAX_DISPATCH_ATTEMPTS dispatch attempts before
    // the coordinator gives up and stalls.
    if (error.retryable === false || inFlight.attempt >= DEFAULT_MAX_DISPATCH_ATTEMPTS) {
      state.stalledRequestId = inFlight.batchIdentity.request_id;
      // A stall means rows remain pending with no further automatic progress: Close's `settled`
      // must reject, not resolve, or a caller (and the wire-level drain confirmation) would
      // wrongly conclude the session fully drained while a batch sits stalled and unacknowledged.
      rejectSettleWaiters(state, new ScribeBatchStalledError(sessionId, inFlight.batchIdentity, error));
      return [failureOutput];
    }
    return [failureOutput, ...pump(sessionId)];
  }

  function completeBatch(sessionId, state, acknowledgement) {
    const inFlight = state.inFlight;
    const lastSegment = inFlight.admittedSegments.at(-1);
    state.cursor = { last_segment_id: lastSegment.segment_id, last_sequence: lastSegment.sequence, last_revision: Number.isInteger(lastSegment.revision) ? lastSegment.revision : 0 };
    state.attemptsByRequestId.delete(inFlight.batchIdentity.request_id);
    state.inFlight = undefined;
    state.stalledRequestId = undefined;
    // Do not reset the debounce clock here: each still-pending segment's own arrival time (set in
    // acceptFinalizedSegment, including arrivals that happened while this batch was busy) already
    // reflects the correct idle-elapsed baseline. Overwriting it to "now" would erase idle time
    // already accrued during the busy window and force a spurious extra 15s wait on a remainder
    // that may already be past the idle threshold.
    if (!state.pendingSegments.length) state.accumulatedSinceMs = null;
    const evaluatedOutput = { type: 'evaluated', sessionId, batchIdentity: inFlight.batchIdentity, attempt: inFlight.attempt, acknowledgement };
    // Immediately pump again so an already-accumulated three-row group does not wait for the
    // partial-batch idle threshold. Only resolve Close's settled waiters once this re-pump
    // confirms nothing further was dispatched: a Close-forced remainder can itself trigger another
    // forced or accumulated batch, and resolving `settled` before that subsequent batch's own
    // terminal outcome would break Close's "waits for its governed terminal outcome" guarantee.
    const dispatchOutputs = pump(sessionId);
    if (!state.inFlight) resolveSettleWaiters(state);
    scheduleIdleTimer(sessionId);
    return [evaluatedOutput, ...dispatchOutputs];
  }

  function cancelIdleTimer(state) {
    if (state.idleTimer) {
      cancelTimer(state.idleTimer);
      state.idleTimer = undefined;
    }
  }

  function scheduleIdleTimer(sessionId) {
    const state = stateFor(sessionId);
    cancelIdleTimer(state);
    if (state.inFlight || state.closing || state.stalledRequestId || !state.pendingSegments.length) return;
    const policy = policyFor(state, sessionId);
    if (state.pendingSegments.length >= policy.admission.rows_per_batch) return;
    const elapsed = state.accumulatedSinceMs != null ? now() - state.accumulatedSinceMs : 0;
    const remaining = Math.max(0, policy.admission.idle_timeout_ms - elapsed);
    state.idleTimer = scheduleTimer(() => {
      state.idleTimer = undefined;
      const outputs = pump(sessionId);
      if (outputs.length) onSpontaneousDispatch?.(sessionId, outputs);
    }, remaining);
  }

  function whenSettled(sessionId) {
    const state = stateFor(sessionId);
    if (!state.inFlight) return Promise.resolve();
    return new Promise((resolve, reject) => {
      state.settleWaiters ||= [];
      state.settleWaiters.push({ resolve, reject });
    });
  }

  function resolveSettleWaiters(state) {
    const waiters = state.settleWaiters;
    state.settleWaiters = undefined;
    if (waiters) for (const waiter of waiters) waiter.resolve();
  }

  function rejectSettleWaiters(state, error) {
    const waiters = state.settleWaiters;
    state.settleWaiters = undefined;
    if (waiters) for (const waiter of waiters) waiter.reject(error);
  }

  function workIdFor(sessionId, batchIdentity, attempt) {
    return `logged-item-extraction:${sessionId}:${batchIdentity.request_id}:attempt-${attempt}`;
  }

  return Object.freeze({
    configurePolicy,
    acceptFinalizedSegment,
    recordDispatchFingerprint,
    acceptWorkCompleted,
    acceptStoredItem,
    close,
    stop,
    status,
    restoreState
  });
}

function projectSegmentContent({ segment_id, sequence, start_time, end_time, text }) {
  return { segment_id, sequence, start_time, end_time, text };
}

// Derives the `{first_segment_id, last_segment_id}` boundary a validated response item's own
// `source_segment_ids` implies, ordered by each segment's position within the batch (not textual
// order in `source_segment_ids`). `validateScribeBatchModelResponse` has already proven every id
// in `source_segment_ids` belongs to this batch's own `batch_identity.segments`, so `segments`
// here is authoritative. Used to correlate an incoming `logged-item.stored` acknowledgement's
// `source` boundary against the exact response-item slot it confirms, independent of item_id or
// arrival order.
function sourceBoundaryForItem(item, segments) {
  const sequenceBySegmentId = new Map(segments.map((segment) => [segment.segment_id, segment.sequence]));
  let first;
  let last;
  let firstSequence = Infinity;
  let lastSequence = -Infinity;
  for (const segmentId of item.source_segment_ids) {
    const sequence = sequenceBySegmentId.get(segmentId);
    if (sequence === undefined) continue;
    if (sequence < firstSequence) { firstSequence = sequence; first = segmentId; }
    if (sequence > lastSequence) { lastSequence = sequence; last = segmentId; }
  }
  return { first_segment_id: first, last_segment_id: last };
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw invalid('a Scribe batch policy object is required');
  if (!policy.policy_id || !policy.policy_version || !policy.session_id) throw invalid('policy_id, policy_version, and session_id are required');
  if (!policy.admission || !Number.isInteger(policy.admission.rows_per_batch) || policy.admission.rows_per_batch < 1) throw invalid('admission.rows_per_batch must be a positive integer');
  if (!Number.isInteger(policy.admission.idle_timeout_ms) || policy.admission.idle_timeout_ms < 1000) throw invalid('admission.idle_timeout_ms must be an integer of at least 1000 ms');
  if (!policy.context || !Number.isInteger(policy.context.max_total_context_tokens) || policy.context.max_total_context_tokens < 1) throw invalid('context.max_total_context_tokens must be a positive integer');
  if (!policy.generation || !policy.generation.policy_profile || !policy.generation.instruction_version) throw invalid('generation.policy_profile and generation.instruction_version are required');
}

function validateSegment(segment) {
  if (!segment?.segment_id || !segment.session_id || !Number.isInteger(segment.sequence) || segment.sequence < 0 || typeof segment.text !== 'string' || !segment.text.trim()) throw invalid('a valid finalized segment identity, session, sequence, and text are required');
  if (!['continuation', 'pause', 'size', 'latency', 'flush'].includes(segment.boundary)) throw invalid('unsupported finalized segment boundary');
  if (typeof segment.start_time !== 'string' || !segment.start_time || typeof segment.end_time !== 'string' || !segment.end_time) throw invalid('segment time range is required');
}

function validateRecoverySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw invalid('a Scribe recovery snapshot is required');
  if (!snapshot.cursor || !Number.isInteger(snapshot.cursor.last_sequence)) throw invalid('recovery cursor with a last_sequence is required');
  if (!Array.isArray(snapshot.pendingSegments)) throw invalid('recovery pendingSegments must be an array');
  if (snapshot.pendingSegments.length > 2) throw invalid('recovery pendingSegments cannot exceed the two-row bounded partial remainder (scribe_checkpoint.pending_partial)');
  if (snapshot.inFlightBatch) {
    const { batchIdentity, admittedSegments, attempt } = snapshot.inFlightBatch;
    if (!batchIdentity?.request_id || !Array.isArray(admittedSegments) || !admittedSegments.length || !Number.isInteger(attempt) || attempt < 1) {
      throw invalid('recovery inFlightBatch must carry a complete batch identity, its admitted segments, and a positive attempt');
    }
  }
}

function invalid(message) {
  return new ServiceOperationError(message, { code: 'INVALID_INPUT', category: 'validation' });
}

function rejected(code, message) {
  return new ServiceOperationError(message, { code, category: 'conflict', rejected: true });
}
