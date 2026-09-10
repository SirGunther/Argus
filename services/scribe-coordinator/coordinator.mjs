import { fingerprintValue } from '../../runtime/message-identity.mjs';
import { OrderedStreamError, OrderedStreamGuard } from '../../runtime/ordered-stream.mjs';
import { ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { buildBatchIdentity } from './batch-identity.mjs';
import { decideAdmission } from './eligibility-policy.mjs';

const DEFAULT_POLICY = Object.freeze({
  policy_id: 'scribe-default-policy',
  policy_version: '1.0.0',
  admission: Object.freeze({ rows_per_batch: 3, idle_timeout_ms: 15000 }),
  context: Object.freeze({ max_total_context_tokens: 8000 }),
  generation: Object.freeze({ policy_profile: 'scribe-default', instruction_version: '1.0.0' })
});
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_MAX_PENDING_SEGMENTS = 128;
const MAX_BACKGROUND_TRANSCRIPT_SEGMENTS = 48;
const MAX_BACKGROUND_LOGGED_ITEMS = 64;
const MAX_SETTLE_WAITERS = 16;

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

/** Provider-neutral finalized-row admission and final-evaluation settlement. */
export function createScribeCoordinator({
  clock = {},
  onSpontaneousDispatch,
  maxSessions = DEFAULT_MAX_SESSIONS,
  maxPendingSegments = DEFAULT_MAX_PENDING_SEGMENTS,
  requireRecovery = false,
  requirePersistence = false
} = {}) {
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new TypeError('maxSessions must be a positive integer');
  if (!Number.isInteger(maxPendingSegments) || maxPendingSegments < 3) throw new TypeError('maxPendingSegments must be at least three');

  const now = typeof clock.now === 'function' ? clock.now : () => Date.now();
  const scheduleTimer = typeof clock.setTimeout === 'function' ? clock.setTimeout : setTimeout;
  const cancelTimer = typeof clock.clearTimeout === 'function' ? clock.clearTimeout : clearTimeout;
  const sessions = new Map();
  const ordering = new OrderedStreamGuard();
  const maxRememberedSegments = maxPendingSegments + 64;

  function stateFor(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      if (sessions.size >= maxSessions) {
        throw new ServiceOperationError(`Scribe coordinator session capacity reached: ${maxSessions}`, {
          code: 'SCRIBE_SESSION_CAPACITY_FULL', category: 'unavailable', retryable: true, details: { capacity: maxSessions }
        });
      }
      state = {
        policy: undefined,
        pendingSegments: [],
        acceptedFingerprints: new Map(),
        accumulatedSinceMs: null,
        idleTimer: undefined,
        cursor: { last_segment_id: null, last_sequence: -1, last_revision: 0 },
        backgroundContext: { transcript_segments: [], prior_logged_items: [] },
        inFlight: undefined,
        closing: false,
        stalledRequestId: undefined,
        lastSettled: undefined,
        lastEvaluatedBatch: undefined,
        pendingEvaluation: undefined,
        pendingPersistence: undefined,
        lastPersistence: undefined,
        recovered: !requireRecovery,
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
    if (fingerprintValue(current) === fingerprintValue(payload)) {
      state.policy ||= structuredClone(payload);
      return recoveryRequest(state, payload.session_id);
    }
    if (state.policy && state.policy.policy_id === payload.policy_id) {
      throw new ServiceOperationError(`Scribe batch policy id ${payload.policy_id} was reused with different content`, { code: 'SCRIBE_POLICY_ID_CONFLICT', category: 'conflict' });
    }
    if (state.pendingSegments.length || state.inFlight) {
      throw rejected('SCRIBE_POLICY_CHANGE_DURING_ACTIVE_BATCH', 'Scribe batch policy cannot change while rows are pending or a batch is active');
    }
    state.policy = structuredClone(payload);
    return recoveryRequest(state, payload.session_id);
  }

  function recoveryRequest(state, sessionId) {
    if (!requireRecovery || state.recovered) return [];
    const policy = policyFor(state, sessionId);
    return [{ type: 'recovery-request', sessionId, policyId: policy.policy_id, policyVersion: policy.policy_version }];
  }

  function acceptFinalizedSegment(segment) {
    validateSegment(segment);
    const state = stateFor(segment.session_id);
    if (!state.recovered) throw rejected('SCRIBE_RECOVERY_REQUIRED', `Scribe recovery must complete for session ${segment.session_id} before finalized evidence is admitted`);
    const fingerprint = fingerprintValue(segment);
    const known = state.acceptedFingerprints.get(segment.segment_id);
    if (known) {
      if (known !== fingerprint) throw new ServiceOperationError(`Segment id ${segment.segment_id} was reused with different content`, { code: 'SEGMENT_ID_CONFLICT', category: 'conflict' });
      return [];
    }
    const retainedCount = state.pendingSegments.length + (state.inFlight?.admittedSegments.length || 0);
    if (retainedCount >= maxPendingSegments) {
      throw new ServiceOperationError(`Scribe pending segment capacity reached: ${maxPendingSegments}`, {
        code: 'SCRIBE_PENDING_CAPACITY_FULL', category: 'unavailable', retryable: true, details: { capacity: maxPendingSegments }
      });
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
    trimRememberedSegments(state);
    state.pendingSegments.push(structuredClone(segment));
    state.accumulatedSinceMs = now();
    const outputs = pump(segment.session_id);
    scheduleIdleTimer(segment.session_id);
    return outputs;
  }

  function acceptBatchEvaluated(payload) {
    validateEvaluatedPayload(payload);
    const batch = payload.batch;
    const sessionId = batch.batch_identity.session_id;
    const state = stateFor(sessionId);
    const evaluationFingerprint = fingerprintValue(payload);
    const evaluationKey = `${batch.batch_identity.request_id}:${payload.batch_attempt}`;

    if (!state.inFlight) {
      if (state.lastSettled?.key === evaluationKey) {
        if (state.lastSettled.fingerprint !== evaluationFingerprint) throw conflict('SCRIBE_EVALUATION_REPLAY_CONFLICT', 'Settled Scribe evaluation was replayed with different content');
        return [];
      }
      throw conflict('SCRIBE_BATCH_IDENTITY_CONFLICT', `No matching in-flight Scribe batch for ${batch.batch_identity.request_id}`);
    }

    const inFlight = state.inFlight;
    if (fingerprintValue(batch.batch_identity) !== fingerprintValue(inFlight.batchIdentity)) {
      throw conflict('SCRIBE_BATCH_IDENTITY_CONFLICT', 'Scribe evaluation batch identity does not match the exact in-flight batch');
    }
    if (payload.batch_attempt !== inFlight.batchAttempt || batch.attempt !== inFlight.batchAttempt) {
      throw conflict('SCRIBE_BATCH_ATTEMPT_CONFLICT', `Scribe evaluation batch_attempt does not match in-flight batch attempt ${inFlight.batchAttempt}`);
    }

    if (batch.outcome === 'failed') {
      if (inFlight.failureFingerprint) {
        if (inFlight.failureFingerprint !== evaluationFingerprint) throw conflict('SCRIBE_EVALUATION_REPLAY_CONFLICT', 'Failed Scribe evaluation was replayed with different content');
        return [];
      }
      inFlight.failureFingerprint = evaluationFingerprint;
      inFlight.terminalFailure = structuredClone(batch.error);
      state.stalledRequestId = inFlight.batchIdentity.request_id;
      const stall = new ScribeBatchStalledError(sessionId, inFlight.batchIdentity, batch.error);
      rejectSettleWaiters(state, stall);
      return [{ type: 'failure', sessionId, batchIdentity: inFlight.batchIdentity, batchAttempt: inFlight.batchAttempt, error: batch.error }];
    }

    if (batch.acknowledgement.accepted !== true) {
      throw conflict('SCRIBE_ACKNOWLEDGEMENT_REJECTED', 'A successful Scribe evaluation must carry the extraction boundary final acknowledgement');
    }
    if (!requirePersistence) return completeBatch(sessionId, state, payload, evaluationKey, evaluationFingerprint);
    if (state.pendingEvaluation) {
      if (state.pendingEvaluation.fingerprint !== evaluationFingerprint) throw conflict('SCRIBE_EVALUATION_REPLAY_CONFLICT', 'Pending Scribe evaluation was replayed with different content');
      return [structuredClone(state.pendingPersistence.output)];
    }
    const checkpoint = checkpointAfterEvaluation(sessionId, state, batch);
    state.pendingEvaluation = { payload: structuredClone(payload), key: evaluationKey, fingerprint: evaluationFingerprint };
    return [beginPersistence(state, sessionId, 'batch-evaluated', checkpoint, batch)];
  }

  function acceptRecoveryRestored(payload) {
    if (!payload || typeof payload !== 'object' || !payload.session_id) throw invalid('scribe.recovery-restored must carry a session_id');
    const state = stateFor(payload.session_id);
    if (state.recovered) throw rejected('SCRIBE_RECOVERY_CONFLICT', `Scribe recovery already completed for session ${payload.session_id}`);
    const policy = policyFor(state, payload.session_id);
    if (!state.policy || payload.policy_id !== policy.policy_id || payload.policy_version !== policy.policy_version) {
      throw conflict('SCRIBE_RECOVERY_POLICY_CONFLICT', 'Recovered Scribe policy identity does not match the configured policy');
    }
    const checkpoint = payload.checkpoint;
    if (checkpoint === null) {
      if ((payload.pending_segments?.length || 0) || (payload.in_flight_segments?.length || 0) || (payload.background_transcript_segments?.length || 0)) {
        throw conflict('SCRIBE_RECOVERY_STATE_CONFLICT', 'Absent Scribe checkpoint cannot carry hydrated recovery state');
      }
      return restoreState(payload.session_id, emptyRecoverySnapshot());
    }
    if (!checkpoint || checkpoint.session_id !== payload.session_id) throw conflict('SCRIBE_RECOVERY_STATE_CONFLICT', 'Recovered Scribe checkpoint targets a different session');
    if (checkpoint.policy_id !== policy.policy_id || checkpoint.policy_version !== policy.policy_version) throw conflict('SCRIBE_RECOVERY_POLICY_CONFLICT', 'Recovered Scribe checkpoint policy identity does not match the configured policy');
    const pendingSegments = requireRecoverySegments(payload.pending_segments, 'pending');
    const inFlightSegments = requireRecoverySegments(payload.in_flight_segments, 'in-flight');
    assertReferenceMatch(checkpoint.pending_partial?.segments || [], pendingSegments, 'pending');
    assertReferenceMatch(checkpoint.in_flight_batch?.batch_identity?.segments || [], inFlightSegments, 'in-flight');
    const accumulated = checkpoint.pending_partial?.accumulated_since;
    const accumulatedSinceMs = accumulated === null ? null : Date.parse(accumulated);
    if (accumulated !== null && !Number.isFinite(accumulatedSinceMs)) throw invalid('recovered pending accumulated_since must be a timestamp');
    return restoreState(payload.session_id, {
      cursor: structuredClone(checkpoint.admitted_through),
      pendingSegments,
      accumulatedSinceMs,
      backgroundContext: {
        transcript_segments: structuredClone(payload.background_transcript_segments || []),
        prior_logged_items: structuredClone(checkpoint.background_context?.prior_logged_items || [])
      },
      ...(checkpoint.in_flight_batch ? { inFlightBatch: {
        batchIdentity: structuredClone(checkpoint.in_flight_batch.batch_identity),
        admittedSegments: inFlightSegments,
        attempt: checkpoint.in_flight_batch.attempt,
        dispatchedAtIso: checkpoint.in_flight_batch.dispatched_at
      } } : {}),
      lastEvaluatedBatch: checkpoint.last_evaluated_batch
    });
  }

  function acceptCheckpointPersisted(payload) {
    if (!payload || typeof payload !== 'object' || !payload.session_id || !payload.transition || !payload.checkpoint) throw invalid('scribe.checkpoint-persisted must carry session_id, transition, and checkpoint');
    const state = stateFor(payload.session_id);
    const fingerprint = fingerprintValue(payload);
    if (!state.pendingPersistence) {
      if (state.lastPersistence?.fingerprint === fingerprint) return [];
      throw conflict('SCRIBE_PERSISTENCE_ACK_CONFLICT', 'No matching Scribe checkpoint persistence request is pending');
    }
    if (state.pendingPersistence.fingerprint !== fingerprint) throw conflict('SCRIBE_PERSISTENCE_ACK_CONFLICT', 'Persisted Scribe checkpoint does not exactly match the pending transition');
    const transition = state.pendingPersistence.transition;
    state.pendingPersistence = undefined;
    state.lastPersistence = { fingerprint };
    if (transition === 'batch-admitted') {
      state.inFlight.admissionPersisted = true;
      return [dispatchDescriptor(payload.session_id, state, state.inFlight)];
    }
    const pending = state.pendingEvaluation;
    if (!pending) throw conflict('SCRIBE_PERSISTENCE_ACK_CONFLICT', 'Persisted evaluation has no matching pending coordinator evaluation');
    state.pendingEvaluation = undefined;
    return completeBatch(payload.session_id, state, pending.payload, pending.key, pending.fingerprint);
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
      retainedSegmentFingerprints: state.acceptedFingerprints.size,
      backgroundTranscriptCount: state.backgroundContext.transcript_segments.length,
      backgroundItemCount: state.backgroundContext.prior_logged_items.length,
      inFlight: state.inFlight ? { batchAttempt: state.inFlight.batchAttempt, requestId: state.inFlight.batchIdentity.request_id } : undefined
    };
  }

  function restoreState(sessionId, snapshot) {
    const state = stateFor(sessionId);
    if (state.inFlight || state.pendingSegments.length || state.cursor.last_sequence >= 0) {
      throw rejected('SCRIBE_RECOVERY_CONFLICT', 'Scribe recovery state was supplied for a session that already has coordinator state');
    }
    validateRecoverySnapshot(snapshot);
    if (snapshot.policy) {
      validatePolicy(snapshot.policy);
      if (snapshot.policy.session_id !== sessionId) throw invalid('recovery policy targets a different session');
      state.policy = structuredClone(snapshot.policy);
    }
    state.cursor = { ...snapshot.cursor };
    state.recovered = true;
    state.backgroundContext = normalizeBackgroundContext(snapshot.backgroundContext);
    for (const segment of snapshot.pendingSegments) rememberRecoveredSegment(state, segment);
    state.accumulatedSinceMs = state.pendingSegments.length ? (snapshot.accumulatedSinceMs ?? now()) : null;
    const knownSequences = [snapshot.cursor.last_sequence, ...snapshot.pendingSegments.map((segment) => segment.sequence), ...(snapshot.inFlightBatch?.admittedSegments || []).map((segment) => segment.sequence)];
    ordering.seed(sessionId, Math.max(-1, ...knownSequences) + 1);
    if (snapshot.inFlightBatch) {
      const { batchIdentity, admittedSegments, attempt } = snapshot.inFlightBatch;
      for (const segment of admittedSegments) state.acceptedFingerprints.set(segment.segment_id, fingerprintValue(segment));
      state.inFlight = {
        batchIdentity: structuredClone(batchIdentity),
        admittedSegments: admittedSegments.map((segment) => structuredClone(segment)),
        batchAttempt: attempt,
        admittedAtIso: snapshot.inFlightBatch.dispatchedAtIso || new Date(now()).toISOString(),
        backgroundContext: structuredClone(state.backgroundContext),
        failureFingerprint: undefined,
        terminalFailure: undefined
      };
      state.inFlight.admissionPersisted = true;
      assertInFlightEvidence(state.inFlight);
      trimRememberedSegments(state);
      return [dispatchDescriptor(sessionId, state, state.inFlight)];
    }
    if (snapshot.lastEvaluatedBatch) {
      const batch = snapshot.lastEvaluatedBatch;
      state.lastEvaluatedBatch = structuredClone(batch);
      state.lastSettled = { key: `${batch.batch_identity.request_id}:${batch.attempt}`, fingerprint: fingerprintValue({ batch_attempt: batch.attempt, batch }) };
    }
    return pump(sessionId);
  }

  function rememberRecoveredSegment(state, segment) {
    validateSegment(segment);
    if (state.pendingSegments.length >= maxPendingSegments) throw invalid('recovery pending segments exceed coordinator capacity');
    state.acceptedFingerprints.set(segment.segment_id, fingerprintValue(segment));
    state.pendingSegments.push(structuredClone(segment));
    trimRememberedSegments(state);
  }

  function pump(sessionId) {
    const state = stateFor(sessionId);
    const policy = policyFor(state, sessionId);
    const idleElapsedMs = state.pendingSegments.length && state.accumulatedSinceMs != null ? now() - state.accumulatedSinceMs : 0;
    const decision = state.stalledRequestId ? null : decideAdmission({
      pendingCount: state.pendingSegments.length,
      batchActive: Boolean(state.inFlight),
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
    state.inFlight = {
      batchIdentity,
      admittedSegments: admitted,
      batchAttempt: 1,
      admittedAtIso: new Date(now()).toISOString(),
      backgroundContext: structuredClone(state.backgroundContext),
      failureFingerprint: undefined,
      terminalFailure: undefined
    };
    cancelIdleTimer(state);
    if (!requirePersistence) return [dispatchDescriptor(sessionId, state, state.inFlight)];
    return [beginPersistence(state, sessionId, 'batch-admitted', checkpointForState(sessionId, state, { savedAtMs: now() }))];
  }

  function beginPersistence(state, sessionId, transition, checkpoint, batch) {
    if (state.pendingPersistence) throw conflict('SCRIBE_PERSISTENCE_IN_FLIGHT', 'A Scribe checkpoint transition is already awaiting durable acknowledgement');
    const payload = {
      session_id: sessionId,
      transition,
      checkpoint: structuredClone(checkpoint),
      ...(batch ? { batch: structuredClone(batch) } : {})
    };
    const output = { type: 'checkpoint-persist', ...structuredClone(payload) };
    state.pendingPersistence = { transition, fingerprint: fingerprintValue(payload), output };
    return output;
  }

  function dispatchDescriptor(sessionId, state, inFlight) {
    const policy = policyFor(state, sessionId);
    return {
      type: 'batch-admitted',
      sessionId,
      batchAttempt: inFlight.batchAttempt,
      batchIdentity: structuredClone(inFlight.batchIdentity),
      newEvidenceSegments: inFlight.admittedSegments.map(projectSegmentContent),
      backgroundContext: structuredClone(inFlight.backgroundContext),
      policyProfile: policy.generation.policy_profile,
      instructionVersion: policy.generation.instruction_version
    };
  }

  function completeBatch(sessionId, state, payload, evaluationKey, evaluationFingerprint) {
    const inFlight = state.inFlight;
    const batch = payload.batch;
    const lastSegment = inFlight.admittedSegments.at(-1);
    state.cursor = { last_segment_id: lastSegment.segment_id, last_sequence: lastSegment.sequence, last_revision: lastSegment.revision };
    updateBackgroundContext(state, inFlight.admittedSegments, batch.items);
    state.inFlight = undefined;
    state.stalledRequestId = undefined;
    state.lastSettled = { key: evaluationKey, fingerprint: evaluationFingerprint };
    state.lastEvaluatedBatch = structuredClone(batch);
    if (!state.pendingSegments.length) state.accumulatedSinceMs = null;
    trimRememberedSegments(state);
    const settledOutput = { type: 'settled', sessionId, batch: structuredClone(batch), batchAttempt: payload.batch_attempt };
    const dispatchOutputs = pump(sessionId);
    if (!state.inFlight) resolveSettleWaiters(state);
    scheduleIdleTimer(sessionId);
    return [settledOutput, ...dispatchOutputs];
  }

  function updateBackgroundContext(state, admittedSegments, items) {
    const admittedIds = new Set(admittedSegments.map((segment) => segment.segment_id));
    const previousSegments = state.backgroundContext.transcript_segments.filter((segment) => !admittedIds.has(segment.segment_id));
    const appendedSegments = admittedSegments.map(({ segment_id, sequence, start_time, end_time, text }) => ({ segment_id, sequence, start_time, end_time, text, relation: 'lookback' }));
    state.backgroundContext.transcript_segments = [...previousSegments, ...appendedSegments].slice(-MAX_BACKGROUND_TRANSCRIPT_SEGMENTS);
    state.backgroundContext.prior_logged_items = [...state.backgroundContext.prior_logged_items, ...items.map((item) => structuredClone(item))].slice(-MAX_BACKGROUND_LOGGED_ITEMS);
  }

  function trimRememberedSegments(state) {
    if (state.acceptedFingerprints.size <= maxRememberedSegments) return;
    const protectedIds = new Set([...state.pendingSegments.map((segment) => segment.segment_id), ...(state.inFlight?.admittedSegments || []).map((segment) => segment.segment_id)]);
    for (const segmentId of state.acceptedFingerprints.keys()) {
      if (state.acceptedFingerprints.size <= maxRememberedSegments) break;
      if (!protectedIds.has(segmentId)) state.acceptedFingerprints.delete(segmentId);
    }
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
    if (state.stalledRequestId && state.inFlight) return Promise.reject(new ScribeBatchStalledError(sessionId, state.inFlight.batchIdentity, state.inFlight.terminalFailure));
    if (!state.inFlight) return Promise.resolve();
    if ((state.settleWaiters?.length || 0) >= MAX_SETTLE_WAITERS) return Promise.reject(new ServiceOperationError(`Scribe Close waiter capacity reached: ${MAX_SETTLE_WAITERS}`, { code: 'SCRIBE_CLOSE_WAITER_CAPACITY_FULL', category: 'unavailable', retryable: true }));
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

  return Object.freeze({ configurePolicy, acceptFinalizedSegment, acceptBatchEvaluated, acceptRecoveryRestored, acceptCheckpointPersisted, close, stop, status, restoreState });
}

function checkpointForState(sessionId, state, overrides = {}) {
  const policy = state.policy || { ...DEFAULT_POLICY, session_id: sessionId };
  const pending = state.pendingSegments.length <= 2 ? state.pendingSegments : [];
  const checkpoint = {
    schema_version: '1.0.0',
    session_id: sessionId,
    saved_at: new Date(overrides.savedAtMs ?? Date.now()).toISOString(),
    admitted_through: structuredClone(overrides.cursor || state.cursor),
    pending_partial: {
      segments: pending.map(({ segment_id, revision, sequence }) => ({ segment_id, revision, sequence })),
      accumulated_since: pending.length && state.accumulatedSinceMs != null ? new Date(state.accumulatedSinceMs).toISOString() : null
    },
    background_context: { prior_logged_items: structuredClone(overrides.priorLoggedItems || state.backgroundContext.prior_logged_items) },
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    ...(state.inFlight && !overrides.clearInFlight ? { in_flight_batch: {
      batch_identity: structuredClone(state.inFlight.batchIdentity),
      attempt: state.inFlight.batchAttempt,
      dispatched_at: state.inFlight.admittedAtIso
    } } : {}),
    ...(overrides.lastEvaluatedBatch || state.lastEvaluatedBatch ? { last_evaluated_batch: structuredClone(overrides.lastEvaluatedBatch || state.lastEvaluatedBatch) } : {})
  };
  return checkpoint;
}

function checkpointAfterEvaluation(sessionId, state, batch) {
  const last = state.inFlight.admittedSegments.at(-1);
  const priorLoggedItems = [...state.backgroundContext.prior_logged_items, ...batch.items.map((item) => structuredClone(item))].slice(-MAX_BACKGROUND_LOGGED_ITEMS);
  return checkpointForState(sessionId, state, {
    savedAtMs: Date.parse(batch.acknowledgement.acknowledged_at || batch.evaluated_at),
    cursor: { last_segment_id: last.segment_id, last_sequence: last.sequence, last_revision: last.revision },
    priorLoggedItems,
    clearInFlight: true,
    lastEvaluatedBatch: batch
  });
}

function emptyRecoverySnapshot() {
  return {
    cursor: { last_segment_id: null, last_sequence: -1, last_revision: 0 },
    pendingSegments: [],
    accumulatedSinceMs: null,
    backgroundContext: { transcript_segments: [], prior_logged_items: [] }
  };
}

function requireRecoverySegments(value, label) {
  if (!Array.isArray(value)) throw invalid(`recovered ${label} segments must be an array`);
  for (const segment of value) validateSegment(segment);
  return value.map((segment) => structuredClone(segment));
}

function assertReferenceMatch(references, segments, label) {
  if (references.length !== segments.length) throw conflict('SCRIBE_RECOVERY_STATE_CONFLICT', `Recovered ${label} evidence count does not match its checkpoint references`);
  references.forEach((reference, index) => {
    const segment = segments[index];
    if (reference.segment_id !== segment.segment_id || reference.revision !== segment.revision || reference.sequence !== segment.sequence) {
      throw conflict('SCRIBE_RECOVERY_STATE_CONFLICT', `Recovered ${label} evidence does not exactly match its checkpoint references`);
    }
  });
}

function projectSegmentContent({ segment_id, revision, sequence, start_time, end_time, text }) {
  return { segment_id, revision, sequence, start_time, end_time, text };
}

function normalizeBackgroundContext(context = { transcript_segments: [], prior_logged_items: [] }) {
  if (!context || !Array.isArray(context.transcript_segments) || !Array.isArray(context.prior_logged_items)) throw invalid('recovery backgroundContext must carry transcript_segments and prior_logged_items arrays');
  if (context.transcript_segments.length > MAX_BACKGROUND_TRANSCRIPT_SEGMENTS || context.prior_logged_items.length > MAX_BACKGROUND_LOGGED_ITEMS) throw invalid('recovery backgroundContext exceeds the bounded coordinator limits');
  return structuredClone(context);
}

function validateEvaluatedPayload(payload) {
  if (!payload || typeof payload !== 'object' || !Number.isInteger(payload.batch_attempt) || payload.batch_attempt < 1 || !payload.batch || typeof payload.batch !== 'object') throw invalid('scribe.batch-evaluated must carry a positive batch_attempt and batch');
  const batch = payload.batch;
  if (!batch.batch_identity?.request_id || !batch.batch_identity?.session_id || !Number.isInteger(batch.attempt) || batch.attempt < 1) throw invalid('evaluated batch identity and coordinator attempt are required');
  if (!['items-recorded', 'empty-evaluated', 'failed'].includes(batch.outcome) || !Array.isArray(batch.items)) throw invalid('evaluated batch outcome and items are invalid');
  const ack = batch.acknowledgement;
  if (!ack || typeof ack.accepted !== 'boolean' || !Array.isArray(ack.logged_item_ids) || new Set(ack.logged_item_ids).size !== ack.logged_item_ids.length) throw invalid('evaluated batch acknowledgement is invalid');
  if (batch.outcome === 'empty-evaluated' && (batch.items.length || ack.logged_item_ids.length || ack.accepted !== true)) throw invalid('empty evaluation must carry an accepted zero-item acknowledgement');
  if (batch.outcome === 'items-recorded' && (!batch.items.length || ack.accepted !== true || ack.logged_item_ids.length !== batch.items.length)) throw invalid('recorded-item evaluation must acknowledge every item exactly once in item order');
  if (batch.outcome === 'failed' && (ack.accepted !== false || ack.logged_item_ids.length || !batch.error)) throw invalid('failed evaluation must remain unacknowledged and carry an error');
  if (ack.accepted && (typeof ack.acknowledged_at !== 'string' || !ack.acknowledged_at)) throw invalid('accepted evaluation must carry acknowledged_at');
}

function assertInFlightEvidence(inFlight) {
  const identity = inFlight.batchIdentity;
  if (identity.segments.length !== inFlight.admittedSegments.length) throw invalid('recovered in-flight evidence does not match its batch identity');
  inFlight.admittedSegments.forEach((segment, index) => {
    const expected = identity.segments[index];
    if (segment.segment_id !== expected.segment_id || segment.revision !== expected.revision || segment.sequence !== expected.sequence) throw invalid('recovered in-flight evidence order/revision does not match its batch identity');
  });
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
  if (!segment?.segment_id || !segment.session_id || !Number.isInteger(segment.revision) || segment.revision < 0 || !Number.isInteger(segment.sequence) || segment.sequence < 0 || typeof segment.text !== 'string' || !segment.text.trim()) throw invalid('a valid finalized segment identity, revision, session, sequence, and text are required');
  if (!['continuation', 'pause', 'size', 'latency', 'flush'].includes(segment.boundary)) throw invalid('unsupported finalized segment boundary');
  if (typeof segment.start_time !== 'string' || !segment.start_time || typeof segment.end_time !== 'string' || !segment.end_time) throw invalid('segment time range is required');
}

function validateRecoverySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw invalid('a Scribe recovery snapshot is required');
  if (!snapshot.cursor || !Number.isInteger(snapshot.cursor.last_sequence)) throw invalid('recovery cursor with a last_sequence is required');
  if (!Array.isArray(snapshot.pendingSegments)) throw invalid('recovery pendingSegments must be an array');
  if (snapshot.pendingSegments.length > 2) throw invalid('recovery pendingSegments cannot exceed the two-row bounded partial remainder');
  if (snapshot.inFlightBatch) {
    const { batchIdentity, admittedSegments, attempt } = snapshot.inFlightBatch;
    if (!batchIdentity?.request_id || !Array.isArray(admittedSegments) || !admittedSegments.length || !Number.isInteger(attempt) || attempt < 1) throw invalid('recovery inFlightBatch must carry a complete batch identity, admitted segments, and a positive coordinator attempt');
  }
}

function invalid(message) { return new ServiceOperationError(message, { code: 'INVALID_INPUT', category: 'validation' }); }
function conflict(code, message) { return new ServiceOperationError(message, { code, category: 'conflict' }); }
function rejected(code, message) { return new ServiceOperationError(message, { code, category: 'conflict', rejected: true }); }
