import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { fingerprintValue } from '../../runtime/message-identity.mjs';
import { validateModelResponse } from '../../contracts/model-protocol.mjs';
import { buildClassificationRequest, CLASSIFICATION_OUTPUT_LIMITS, fingerprintRequest, readModelName } from './model-boundary.mjs';

const SERVICE = 'logged-item-classification-suggester';
const instance = process.env.ARGUS_SERVICE_INSTANCE_ID || SERVICE;
const MAX_PENDING_REQUESTS = 32;
const MAX_PENDING_CONTEXTS = 32;
const pending = new Map();
const contexts = new Map();

runLineService({ service: SERVICE, operations: {
  'transcript.context-window': { name: 'retain-explicit-classification-context', handle(message) {
    const context = structuredClone(message.payload);
    const fingerprint = fingerprintValue(context);
    const existing = contexts.get(context.window_id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ServiceOperationError(`Conflicting classification context for window ${context.window_id}`, { code: 'CLASSIFICATION_CONTEXT_CONFLICT', category: 'conflict' });
      return [];
    }
    if (contexts.size >= MAX_PENDING_CONTEXTS) throw new ServiceOperationError(`pending classification context capacity reached: ${MAX_PENDING_CONTEXTS}`, { code: 'CLASSIFICATION_CONTEXT_FULL', category: 'capacity', retryable: true, details: { capacity: MAX_PENDING_CONTEXTS } });
    contexts.set(context.window_id, { context, fingerprint });
    return [];
  } },
  'logged-item.stored': { name: 'schedule-optional-classification', handle(message) {
    const item = structuredClone(message.payload);
    const windowId = item.generator?.input_window_id;
    const retained = windowId ? contexts.get(windowId) : undefined;
    try {
      if (!retained) throw new ServiceOperationError(`explicit classification context is unavailable for item ${item.item_id}`, { code: 'CLASSIFICATION_CONTEXT_UNAVAILABLE', category: 'dependency', retryable: true });
      const modelName = readModelName();
      const workId = `classification-enrichment:${item.session_id}:${item.item_id}:r${item.revision}`;
      if (!pending.has(workId) && pending.size >= MAX_PENDING_REQUESTS) throw new ServiceOperationError(`pending classification capacity reached: ${MAX_PENDING_REQUESTS}`, { code: 'CLASSIFICATION_PENDING_FULL', category: 'capacity', retryable: true, details: { capacity: MAX_PENDING_REQUESTS } });
      const request = buildClassificationRequest(item, retained.context, { workId, modelName });
      pending.set(workId, { item, context: retained.context, request, requestFingerprint: fingerprintRequest(request) });
      contexts.delete(windowId);
      return [{ plane: 'control', messageType: 'ai.work-request', schemaVersion: '1.4.0', identityKey: `${instance}:ai.work-request:${workId}`, payload: {
        work_id: workId, workload: 'classification-enrichment', session_id: item.session_id, sequence: item.revision,
        queued_at: message.timestamp, input: { model_request: request }, recovery: { max_attempts: 1 }
      } }];
    } catch (error) {
      if (windowId) contexts.delete(windowId);
      throw boundaryError(error);
    }
  } },
  'ai.work-completed': { name: 'accept-optional-classification', handle(message) {
    const completion = message.payload;
    if (completion.workload !== 'classification-enrichment') return [];
    const state = pending.get(completion.work_id);
    if (!state) throw new Error(`No retained classification context for work ${completion.work_id}`);
    if (completion.result?.request_fingerprint !== state.requestFingerprint) {
      pending.delete(completion.work_id);
      throw new Error(`Conflicting classification result for work ${completion.work_id}`);
    }
    try {
      if (completion.result.status === 'failed') {
        pending.delete(completion.work_id);
        return [failureOutput(completion, state, completion.result.error)];
      }
      const response = validateModelResponse(completion.result.response, 'classification-enrichment', CLASSIFICATION_OUTPUT_LIMITS);
      const output = { messageType: 'classification.suggestion', schemaVersion: '1.2.0', identityKey: `${instance}:classification.suggestion:${state.item.item_id}:r${state.item.revision}`, payload: {
        item_id: state.item.item_id, session_id: state.item.session_id, item_revision: state.item.revision,
        suggested_classification: response.suggested_classification, confidence: response.confidence, evidence_segment_ids: state.request.evidence_segment_ids
      } };
      pending.delete(completion.work_id);
      return [output];
    } catch (error) {
      pending.delete(completion.work_id);
      throw boundaryError(error, { work_id: completion.work_id, item_id: state.item.item_id, item_revision: state.item.revision, request_fingerprint: state.requestFingerprint, retained_exact_context: true });
    }
  } }
}, onDrain() { pending.clear(); contexts.clear(); return []; } });

function failureOutput(completion, state, error) {
  const safe = error || { code: 'MODEL_REQUEST_FAILED', category: 'dependency', message: 'classification request failed', retryable: true };
  return { plane: 'control', messageType: 'service.failure', schemaVersion: '1.2.0', identityKey: `${instance}:classification-failure:${completion.work_id}`, payload: {
    service: instance, operation: 'accept-optional-classification', outcome: 'failure',
    error: { code: safe.code, category: safe.category, message: safe.message, retryable: safe.retryable, details: {
      work_id: completion.work_id, item_id: state.item.item_id, item_revision: state.item.revision,
      request_fingerprint: state.requestFingerprint, optional: true
    } }
  } };
}

function boundaryError(error, details) {
  return error instanceof ServiceOperationError ? error : new ServiceOperationError(error.message, {
    code: error.cause?.code || 'INVALID_MODEL_OUTPUT', category: 'validation', retryable: true, details
  });
}
