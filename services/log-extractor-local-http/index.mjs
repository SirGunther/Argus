import { fingerprintValue } from '../../runtime/message-identity.mjs';
import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { buildExtractionRequest, EXTRACTION_OUTPUT_LIMITS, fingerprintRequest, readModelName, stableItemId } from './model-boundary.mjs';
import { SCRIBE_BATCH_PROTOCOL_VERSION, validateModelResponse } from '../../contracts/model-protocol.mjs';
import { createScribeBatchRetention, failedScribeBatchEvaluation, scribeBatchCompletionOutputs } from './scribe-batch-boundary.mjs';

const SERVICE = 'log-extractor-local-http';
const instance = process.env.ARGUS_SERVICE_INSTANCE_ID || SERVICE;
const MAX_PENDING_REQUESTS = 32;
const MAX_RETAINED_POLICIES = 8;
const FAILURE_CATEGORIES = new Set(['validation', 'conflict', 'dependency', 'timeout', 'unavailable', 'internal']);
const pending = new Map();
// Batch work is retained separately from single-window work: the two protocols correlate their
// completions against different retained shapes, so the dispatch that produced the work - not the
// shape of whatever response comes back - must decide how a completion is evaluated.
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
    // The coordinator owns the policy; this service only retains it. The total token budget and
    // the instruction version are inputs to bounded request construction and must come from the
    // governed policy rather than from a local default.
    const policy = structuredClone(message.payload);
    if (!policy?.session_id || !policy.context || !policy.generation) {
      throw new ServiceOperationError('scribe.batch-policy must carry a session, a context budget, and generation settings', { code: 'INVALID_SCRIBE_BATCH_POLICY', category: 'validation' });
    }
    if (!scribePolicies.has(policy.session_id) && scribePolicies.size >= MAX_RETAINED_POLICIES) {
      throw new ServiceOperationError(`retained scribe policy capacity reached: ${MAX_RETAINED_POLICIES}`, { code: 'SCRIBE_POLICY_CAPACITY_FULL', category: 'unavailable', retryable: true, details: { capacity: MAX_RETAINED_POLICIES } });
    }
    scribePolicies.set(policy.session_id, policy);
    return [];
  }, traceDetail: (message) => ({ policy_id: message.payload?.policy_id, policy_version: message.payload?.policy_version }) },
  'ai.work-request': { name: 'dispatch-scribe-batch', handle(message) {
    const work = message.payload;
    const proposal = work?.input?.model_request;
    // This service is the producer of 1.0.0 single-window work, not its consumer. It consumes only
    // the batch-shaped proposal the Scribe coordinator routes here for bounded construction, so
    // anything else arriving on this wire is ignored rather than reinterpreted.
    if (proposal?.protocol_version !== SCRIBE_BATCH_PROTOCOL_VERSION) return [];
    try {
      if (proposal.identity?.work_id !== work.work_id) {
        throw new ServiceOperationError('scribe batch request identity does not match the scheduler work identity', { code: 'MODEL_WORK_ID_CONFLICT', category: 'conflict', details: { work_id: work.work_id } });
      }
      const sessionId = proposal.batch_identity?.session_id;
      const policy = scribePolicies.get(sessionId);
      if (!policy) {
        throw new ServiceOperationError(`no governed scribe batch policy is active for session ${sessionId}`, { code: 'SCRIBE_BATCH_POLICY_MISSING', category: 'unavailable', retryable: true, details: { session_id: sessionId } });
      }
      // The model name comes from this service's own configuration, never from the proposal: the
      // coordinator holds no provider knowledge and must not be able to name the model.
      const dispatched = scribeBatches.dispatch({
        batch: {
          batch_identity: proposal.batch_identity,
          new_evidence_segments: proposal.new_evidence_segments,
          background_context: proposal.background_context
        },
        policy,
        workId: work.work_id,
        modelName: readModelName(),
        queuedAt: message.timestamp,
        maxAttempts: Number.isInteger(work?.recovery?.max_attempts) ? work.recovery.max_attempts : 2
      });
      return [dispatched.workRequest];
    } catch (error) { throw boundaryError(error, { work_id: work?.work_id, batch_request_id: proposal.batch_identity?.request_id }); }
  }, traceDetail: (message) => ({ batch_request_id: message.payload?.input?.model_request?.batch_identity?.request_id, scheduler_work_id: message.payload?.work_id }) },
  'ai.work-completed': { name: 'accept-local-http-extraction', handle(message) {
    const completion = message.payload;
    if (completion.workload !== 'logged-item-extraction') return [];
    if (scribeBatches.has(completion.work_id)) return acceptScribeBatchCompletion(completion);
    const state = pending.get(completion.work_id);
    if (!state) {
      // A batch result for work this service never dispatched is a correlation conflict, not a
      // malformed single-window result. Reporting it as the latter is what made an unretained
      // 2.0.0 completion look like an extraction defect instead of a routing one.
      if (completion.result?.response?.protocol_version === SCRIBE_BATCH_PROTOCOL_VERSION) {
        throw new ServiceOperationError(`No retained scribe batch context for work ${completion.work_id}`, { code: 'SCRIBE_BATCH_NOT_RETAINED', category: 'conflict', details: { work_id: completion.work_id, batch_request_id: completion.result.response.batch_identity?.request_id } });
      }
      throw new Error(`No retained extraction context for work ${completion.work_id}`);
    }
    if (completion.result?.request_fingerprint !== state.requestFingerprint) {
      pending.delete(completion.work_id);
      throw new Error(`Conflicting model result for work ${completion.work_id}`);
    }
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
  } }
}, onDrain() { pending.clear(); scribeBatches.clear(); scribePolicies.clear(); return []; } });

/**
 * Turn one settled Scribe batch into zero-to-many governed drafts, or into one visible failure.
 *
 * A valid empty evaluation legitimately emits no draft. The complete evaluated-batch outcome is
 * produced here, but only the failed outcome currently has a governed carrier (`service.failure`
 * details); the settled-outcome carrier back to the coordinator is not a contract SCRIBE-01
 * established, so SCRIBE-02 must declare it and SCRIBE-05 must wire it.
 */
function acceptScribeBatchCompletion(completion) {
  const state = scribeBatches.get(completion.work_id);
  const details = { work_id: completion.work_id, batch_request_id: state.request.batch_identity.request_id, request_fingerprint: state.requestFingerprint, retained_exact_context: true };
  if (completion.result?.request_fingerprint !== state.requestFingerprint) {
    scribeBatches.release(completion.work_id);
    throw new ServiceOperationError(`Conflicting model result for scribe batch ${completion.work_id}`, { code: 'SCRIBE_BATCH_RESULT_CONFLICT', category: 'conflict', details });
  }
  const attempt = Number.isInteger(completion.attempt) && completion.attempt >= 1 ? completion.attempt : 1;
  const evaluatedAt = completion.completed_at;
  try {
    if (completion.result.status === 'failed') {
      const evaluated = failedScribeBatchEvaluation({ batchIdentity: state.request.batch_identity, attempt, evaluatedAt, error: completion.result.error });
      scribeBatches.release(completion.work_id);
      return [scribeFailureOutput(completion, completion.result.error, { ...details, evaluated_batch: evaluated })];
    }
    const { outputs } = scribeBatchCompletionOutputs({ request: state.request, response: completion.result.response, attempt, evaluatedAt, instance });
    scribeBatches.release(completion.work_id);
    return outputs;
  } catch (error) {
    scribeBatches.release(completion.work_id);
    throw boundaryError(error, details);
  }
}

function exactSource(window) {
  const first = window.segments[0], last = window.segments.at(-1);
  const source = { first_segment_id: first.segment_id, last_segment_id: last.segment_id, start_time: first.start_time, end_time: last.end_time };
  if (fingerprintValue(window.source) !== fingerprintValue(source)) throw new Error('authoritative source provenance changed while retained for model completion');
  return source;
}

function boundaryError(error, details) {
  if (error instanceof ServiceOperationError) return error;
  // Preserve a cause category the service.failure contract actually accepts; anything else (or a
  // missing category) reports as validation rather than emitting an out-of-enum failure payload.
  const category = FAILURE_CATEGORIES.has(error.cause?.category) ? error.cause.category : 'validation';
  return new ServiceOperationError(error.message, { code: error.cause?.code || 'INVALID_MODEL_OUTPUT', category, retryable: true, details });
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

function scribeFailureOutput(completion, error, details) {
  const safe = error || { code: 'MODEL_REQUEST_FAILED', category: 'dependency', message: 'model request failed', retryable: true };
  return { plane: 'control', messageType: 'service.failure', schemaVersion: '1.2.0', identityKey: `${instance}:service.failure:${completion.work_id}`, payload: {
    service: instance, operation: 'accept-local-http-extraction', outcome: 'failure',
    error: { code: safe.code, category: safe.category, message: safe.message, retryable: safe.retryable, details }
  } };
}
