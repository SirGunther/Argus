import { fingerprintValue } from '../../runtime/message-identity.mjs';
import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { buildExtractionRequest, EXTRACTION_OUTPUT_LIMITS, fingerprintRequest, readModelName, stableItemId } from './model-boundary.mjs';
import { validateModelResponse } from '../../contracts/model-protocol.mjs';

const SERVICE = 'log-extractor-local-http';
const instance = process.env.ARGUS_SERVICE_INSTANCE_ID || SERVICE;
const MAX_PENDING_REQUESTS = 32;
const pending = new Map();

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
  'ai.work-completed': { name: 'accept-local-http-extraction', handle(message) {
    const completion = message.payload;
    if (completion.workload !== 'logged-item-extraction') return [];
    const state = pending.get(completion.work_id);
    if (!state) throw new Error(`No retained extraction context for work ${completion.work_id}`);
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
}, onDrain() { pending.clear(); return []; } });

function exactSource(window) {
  const first = window.segments[0], last = window.segments.at(-1);
  const source = { first_segment_id: first.segment_id, last_segment_id: last.segment_id, start_time: first.start_time, end_time: last.end_time };
  if (fingerprintValue(window.source) !== fingerprintValue(source)) throw new Error('authoritative source provenance changed while retained for model completion');
  return source;
}

function boundaryError(error, details) {
  return error instanceof ServiceOperationError ? error : new ServiceOperationError(error.message, {
    code: error.cause?.code || 'INVALID_MODEL_OUTPUT', category: 'validation', retryable: true, details
  });
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
