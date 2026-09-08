import { fingerprintValue } from '../../runtime/message-identity.mjs';
import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { buildExtractionRequest, EXTRACTION_OUTPUT_LIMITS, fingerprintRequest, readModelName, stableItemId } from './model-boundary.mjs';
import { SCRIBE_BATCH_PROTOCOL_VERSION, validateModelResponse } from '../../contracts/model-protocol.mjs';
import {
  createScribeBatchRetention,
  draftOutput,
  evaluateScribeBatchResponse,
  failedScribeBatchEvaluation
} from './scribe-batch-boundary.mjs';

const SERVICE = 'log-extractor-local-http';
const instance = process.env.ARGUS_SERVICE_INSTANCE_ID || SERVICE;
const MAX_PENDING_REQUESTS = 32;
const MAX_RETAINED_POLICIES = 8;
const MODEL_MAX_ATTEMPTS = 2;
const FAILURE_CATEGORIES = new Set(['validation', 'conflict', 'dependency', 'timeout', 'unavailable', 'internal']);
const pending = new Map();
const scribeBatches = createScribeBatchRetention({ capacity: MAX_PENDING_REQUESTS, instance });
const scribePolicies = new Map();

runLineService({ service: SERVICE, operations: {
  'transcript.context-window': { name: 'schedule-local-http-extraction', handle(message) {
    try {
      const window = structuredClone(message.payload);
      const modelName = readModelName();
      const workId = `logged-item-extraction:${window.session_id}:${window.window_id}`;
      if (!pending.has(workId) && pending.size >= MAX_PENDING_REQUESTS) throw new ServiceOperationError(`pending extraction capacity reached: ${MAX_PENDING_REQUESTS}`, { code: 'MODEL_PENDING_FULL', category: 'capacity', retryable: true, details: { capacity: MAX_PENDING_REQUESTS } });
      const request = buildExtractionRequest(window, { workId, modelName });
      pending.set(workId, { window, requestFingerprint: fingerprintRequest(request) });
      return [{ plane: 'control', messageType: 'ai.work-request', schemaVersion: '1.4.0', identityKey: `${instance}:ai.work-request:${workId}`, payload: {
        work_id: workId, workload: 'logged-item-extraction', session_id: window.session_id,
        sequence: window.segments.at(-1).sequence, queued_at: message.timestamp, input: { model_request: request }, recovery: { max_attempts: 2 }
      } }];
    } catch (error) { throw boundaryError(error); }
  } },
  'scribe.batch-policy': { name: 'retain-scribe-batch-policy', handle(message) {
    const policy = structuredClone(message.payload);
    if (!policy?.session_id || !policy.context || !policy.generation) throw new ServiceOperationError('scribe.batch-policy must carry a session, a context budget, and generation settings', { code: 'INVALID_SCRIBE_BATCH_POLICY', category: 'validation' });
    const retained = scribePolicies.get(policy.session_id);
    if (retained) {
      if (fingerprintValue(retained) === fingerprintValue(policy)) return [];
      throw new ServiceOperationError(`conflicting Scribe policy is already retained for session ${policy.session_id}`, { code: 'SCRIBE_BATCH_POLICY_CONFLICT', category: 'conflict', details: { session_id: policy.session_id, policy_id: retained.policy_id } });
    }
    if (scribePolicies.size >= MAX_RETAINED_POLICIES) throw new ServiceOperationError(`retained scribe policy capacity reached: ${MAX_RETAINED_POLICIES}`, { code: 'SCRIBE_POLICY_CAPACITY_FULL', category: 'unavailable', retryable: true, details: { capacity: MAX_RETAINED_POLICIES } });
    scribePolicies.set(policy.session_id, policy);
    return [];
  }, traceDetail: (message) => ({ policy_id: message.payload?.policy_id, policy_version: message.payload?.policy_version }) },
  'scribe.batch-admitted': { name: 'dispatch-scribe-batch', handle(message) {
    const admission = structuredClone(message.payload);
    const sessionId = admission?.batch_identity?.session_id;
    const policy = scribePolicies.get(sessionId);
    if (!policy) throw new ServiceOperationError(`no governed scribe batch policy is active for session ${sessionId}`, { code: 'SCRIBE_BATCH_POLICY_MISSING', category: 'unavailable', retryable: true, details: { session_id: sessionId } });
    try {
      const dispatched = scribeBatches.dispatch({
        batch: admission,
        policy,
        modelName: readModelName(),
        queuedAt: message.timestamp,
        maxAttempts: MODEL_MAX_ATTEMPTS
      });
      return dispatched.terminalEvaluation ? [scribeEvaluatedOutput(dispatched.terminalEvaluation)] : [dispatched.workRequest];
    } catch (error) {
      throw boundaryError(error, { batch_request_id: admission?.batch_identity?.request_id, batch_attempt: admission?.batch_attempt });
    }
  }, traceDetail: (message) => ({ batch_request_id: message.payload?.batch_identity?.request_id, batch_attempt: message.payload?.batch_attempt }) },
  'ai.work-completed': { name: 'accept-local-http-extraction', handle(message) {
    const completion = message.payload;
    if (completion.workload !== 'logged-item-extraction') return [];
    const activeScribeBatch = scribeBatches.get(completion.work_id);
    const settledScribeBatch = scribeBatches.getSettled(completion.work_id);
    if (activeScribeBatch || settledScribeBatch) {
      assertScribeCompletionCorrelation(completion, activeScribeBatch || settledScribeBatch);
      return settledScribeBatch
        ? [scribeEvaluatedOutput(settledScribeBatch.terminalEvaluation)]
        : acceptScribeBatchCompletion(completion);
    }
    const state = pending.get(completion.work_id);
    if (!state) {
      if (completion.work_id?.includes(':batch-attempt-') || completion.result?.response?.protocol_version === SCRIBE_BATCH_PROTOCOL_VERSION) {
        throw new ServiceOperationError(`No retained scribe batch context for work ${completion.work_id}`, { code: 'SCRIBE_BATCH_NOT_RETAINED', category: 'conflict', details: { work_id: completion.work_id, batch_request_id: completion.result?.response?.batch_identity?.request_id } });
      }
      throw new Error(`No retained extraction context for work ${completion.work_id}`);
    }
    if (completion.result?.work_id !== completion.work_id) throw new Error(`Conflicting nested model result work_id for work ${completion.work_id}`);
    if (completion.result?.request_fingerprint !== state.requestFingerprint) throw new Error(`Conflicting model result for work ${completion.work_id}`);
    try {
      if (completion.result.status === 'failed') {
        pending.delete(completion.work_id);
        return [failureOutput(completion, state, completion.result.error)];
      }
      const response = validateModelResponse(completion.result.response, 'logged-item-extraction', EXTRACTION_OUTPUT_LIMITS);
      const source = exactSource(state.window);
      const itemId = stableItemId(state.window);
      const output = { messageType: 'logged-item.draft', schemaVersion: '1.3.0', identityKey: `${instance}:logged-item.draft:${itemId}:r0`, payload: {
        item_id: itemId, session_id: state.window.session_id, created_at: source.end_time, text: response.text,
        revision: 0, revision_id: `${itemId}:r0`, source, generator: { implementation: SERVICE, input_window_id: state.window.window_id }
      } };
      pending.delete(completion.work_id);
      return [output];
    } catch (error) {
      pending.delete(completion.work_id);
      throw boundaryError(error, { work_id: completion.work_id, context_window_id: state.window.window_id, request_fingerprint: state.requestFingerprint, retained_exact_context: true });
    }
  } },
  'logged-item.stored': { name: 'confirm-scribe-draft-storage', handle(message) {
    try {
      const result = scribeBatches.confirmStoredItem(message.payload, { acknowledgedAt: message.timestamp });
      if (!result.matched || !result.settled) return [];
      return [scribeEvaluatedOutput(result.evaluated)];
    } catch (error) { throw boundaryError(error, { item_id: message.payload?.item_id, batch_request_id: message.payload?.generator?.input_window_id }); }
  } },
  'operation.rejected': { name: 'reject-scribe-draft-storage', handle(message) {
    if (message.payload?.operation !== 'accept-extracted-draft') return [];
    const reason = message.payload.reason || {};
    const result = scribeBatches.failOwnerMessage(message.payload.input_message_id, {
      code: reason.code || 'LOGGED_ITEM_OWNER_REJECTED', category: 'conflict', message: reason.message || 'Logged Item owner rejected the Scribe draft', retryable: false
    }, { evaluatedAt: message.timestamp });
    if (!result.matched) throw new ServiceOperationError('Logged Item owner rejection did not match a retained Scribe draft', { code: 'SCRIBE_OWNER_CONFIRMATION_UNKNOWN', category: 'conflict', details: { input_message_id: message.payload.input_message_id } });
    return [scribeEvaluatedOutput(result.evaluated)];
  } },
  'service.failure': { name: 'fail-scribe-draft-storage', handle(message) {
    if (message.payload?.operation !== 'accept-extracted-draft') return [];
    const error = message.payload.error || {};
    const result = scribeBatches.failOwnerMessage(message.payload.input_message_id, {
      code: error.code || 'LOGGED_ITEM_STORAGE_FAILED', category: FAILURE_CATEGORIES.has(error.category) ? error.category : 'dependency', message: error.message || 'Logged Item storage failed', retryable: Boolean(error.retryable)
    }, { evaluatedAt: message.timestamp });
    if (!result.matched) throw new ServiceOperationError('Logged Item storage failure did not match a retained Scribe draft', { code: 'SCRIBE_OWNER_CONFIRMATION_UNKNOWN', category: 'conflict', details: { input_message_id: message.payload.input_message_id } });
    return [scribeEvaluatedOutput(result.evaluated)];
  } }
}, onDrain() { pending.clear(); scribeBatches.clear(); scribePolicies.clear(); return []; } });

function acceptScribeBatchCompletion(completion) {
  const state = scribeBatches.get(completion.work_id);
  const evaluatedAt = completion.completed_at;
  const details = {
    work_id: completion.work_id,
    batch_request_id: state.request.batch_identity.request_id,
    batch_attempt: state.batchAttempt,
    request_fingerprint: state.requestFingerprint,
    retained_exact_context: true
  };
  assertScribeCompletionCorrelation(completion, state);
  const completionFingerprint = fingerprintValue(completion.result);
  if (state.phase === 'owner-acknowledgement') {
    if (state.completionFingerprint !== completionFingerprint) {
      throw new ServiceOperationError(`Conflicting repeated model result for scribe batch ${completion.work_id}`, { code: 'SCRIBE_BATCH_RESULT_CONFLICT', category: 'conflict', details });
    }
    return state.drafts.map((draft) => structuredClone(draft));
  }
  try {
    if (completion.result.status === 'failed') {
      const evaluated = failedScribeBatchEvaluation({
        batchIdentity: state.request.batch_identity,
        batchAttempt: state.batchAttempt,
        evaluatedAt,
        error: { ...completion.result.error, retryable: false }
      });
      scribeBatches.settleEvaluation(completion.work_id, evaluated);
      return [scribeEvaluatedOutput(evaluated)];
    }
    let result;
    try {
      result = evaluateScribeBatchResponse({ request: state.request, response: completion.result.response, batchAttempt: state.batchAttempt, evaluatedAt });
    } catch (error) {
      if (error.cause?.code === 'SCRIBE_BATCH_IDENTITY_CONFLICT') throw error;
      const evaluated = failedScribeBatchEvaluation({
        batchIdentity: state.request.batch_identity,
        batchAttempt: state.batchAttempt,
        evaluatedAt,
        error: { code: error.cause?.code || 'INVALID_MODEL_OUTPUT', category: FAILURE_CATEGORIES.has(error.cause?.category) ? error.cause.category : 'validation', message: error.message, retryable: false }
      });
      scribeBatches.settleEvaluation(completion.work_id, evaluated);
      return [scribeEvaluatedOutput(evaluated)];
    }
    if (result.drafts.length === 0) {
      result.evaluated.acknowledgement = {
        ...result.evaluated.acknowledgement,
        accepted: true,
        acknowledged_at: evaluatedAt,
        logged_item_ids: []
      };
      scribeBatches.settleEvaluation(completion.work_id, result.evaluated);
      return [scribeEvaluatedOutput(result.evaluated)];
    }
    state.completionFingerprint = completionFingerprint;
    return scribeBatches.beginOwnerAcknowledgement(completion.work_id, {
      drafts: result.drafts.map((payload) => draftOutput(payload, instance)),
      evaluated: result.evaluated
    });
  } catch (error) {
    throw boundaryError(error, details);
  }
}

function assertScribeCompletionCorrelation(completion, state) {
  const details = { work_id: completion.work_id, batch_request_id: state.request.batch_identity.request_id, request_fingerprint: state.requestFingerprint, retained_exact_context: true };
  if (completion.session_id !== state.request.identity.session_id || completion.sequence !== state.request.batch_identity.last_sequence) {
    throw new ServiceOperationError(`Model completion routing does not match scribe batch ${completion.work_id}`, { code: 'SCRIBE_BATCH_RESULT_ROUTING_CONFLICT', category: 'conflict', details });
  }
  if (completion.result?.work_id !== completion.work_id) {
    throw new ServiceOperationError(`Nested model result work_id does not match scribe batch ${completion.work_id}`, { code: 'SCRIBE_BATCH_RESULT_WORK_ID_CONFLICT', category: 'conflict', details });
  }
  if (completion.result?.request_fingerprint !== state.requestFingerprint) {
    throw new ServiceOperationError(`Conflicting model result for scribe batch ${completion.work_id}`, { code: 'SCRIBE_BATCH_RESULT_CONFLICT', category: 'conflict', details });
  }
}

function scribeEvaluatedOutput(evaluated) {
  return {
    plane: 'domain',
    messageType: 'scribe.batch-evaluated',
    schemaVersion: '1.0.0',
    identityKey: `${instance}:scribe.batch-evaluated:${evaluated.batch_identity.request_id}:a${evaluated.attempt}`,
    payload: { batch_attempt: evaluated.attempt, batch: structuredClone(evaluated) }
  };
}

function exactSource(window) {
  const first = window.segments[0], last = window.segments.at(-1);
  const source = { first_segment_id: first.segment_id, last_segment_id: last.segment_id, start_time: first.start_time, end_time: last.end_time };
  if (fingerprintValue(window.source) !== fingerprintValue(source)) throw new Error('authoritative source provenance changed while retained for model completion');
  return source;
}

function boundaryError(error, details) {
  if (error instanceof ServiceOperationError) return error;
  const category = FAILURE_CATEGORIES.has(error.cause?.category) ? error.cause.category : 'validation';
  return new ServiceOperationError(error.message, { code: error.cause?.code || 'INVALID_MODEL_OUTPUT', category, retryable: true, details: { ...error.cause?.details, ...details } });
}

function failureOutput(completion, state, error) {
  const safe = error || { code: 'MODEL_REQUEST_FAILED', category: 'dependency', message: 'model request failed', retryable: true };
  return { plane: 'control', messageType: 'service.failure', schemaVersion: '1.2.0', identityKey: `${instance}:service.failure:${completion.work_id}`, payload: {
    service: instance, operation: 'accept-local-http-extraction', outcome: 'failure',
    error: { code: safe.code, category: safe.category, message: safe.message, retryable: safe.retryable, details: {
      work_id: completion.work_id, context_window_id: state.window.window_id, request_fingerprint: state.requestFingerprint,
      retained_exact_context: true
    } }
  } };
}
