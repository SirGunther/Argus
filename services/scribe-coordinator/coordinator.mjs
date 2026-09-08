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
  maxPendingSegments = DEFAULT_MAX_PENDING_SEGMENTS
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
    return completeBatch(sessionId, state, payload, evaluationKey, evaluationFingerprint);
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
      assertInFlightEvidence(state.inFlight);
      trimRememberedSegments(state);
      return [dispatchDescriptor(sessionId, state, state.inFlight)];
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
    return [dispatchDescriptor(sessionId, state, state.inFlight)];
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

  return Object.freeze({ configurePolicy, acceptFinalizedSegment, acceptBatchEvaluated, close, stop, status, restoreState });
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
