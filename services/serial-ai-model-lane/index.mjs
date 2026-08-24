import { SerialAiScheduler } from '../../runtime/serial-ai-scheduler.mjs';
import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { assertPurposeMatchesWorkload, fingerprintModelRequest, validateModelRequest, validateModelResponse } from '../../contracts/model-protocol.mjs';
import { readModelConfig } from './model-config.mjs';

const SERVICE = 'serial-ai-model-lane';
const journal = {
  events: [],
  async load() { return []; },
  async append(event) {
    this.events.push(event);
    process.stderr.write(`${JSON.stringify({ service: SERVICE, operation: 'serial-ai-scheduler', event: event.event, work_id: event.work?.work_id || event.work_id, workload: event.work?.workload, request_fingerprint: event.work?.input?.model_request ? fingerprintModelRequest(event.work.input.model_request) : undefined })}\n`);
  }
};

const scheduler = await SerialAiScheduler.create({
  journal,
  capacity: 32,
  executor: async (work, { attempt }) => {
    const request = work.input?.model_request;
    if (!request || request.identity?.work_id !== work.work_id) throw modelFailure('INVALID_MODEL_REQUEST', 'scheduler work must contain a matching provider-neutral model request', 'validation', false);
    try {
      const config = readModelConfig();
      if (request.model !== config.modelName) throw modelFailure('MODEL_CONFIGURATION_CONFLICT', 'model request does not match the configured model name', 'validation', false);
      const response = await requestLocalModel(config, request);
      return { status: 'succeeded', attempt, response: validateModelResponse(response, request.purpose, request.limits) };
    } catch (error) {
      throw error instanceof ModelRequestError ? error : modelFailure(error.cause?.code || 'MODEL_REQUEST_FAILED', error.message, 'dependency', true);
    }
  }
});

runLineService({ service: SERVICE, operations: {
  'ai.work-request': { name: 'schedule-model-work', async handle(message) {
    const work = normalizeWork(message.payload);
    try {
      const result = await scheduler.enqueue(work);
      return [{ plane: 'control', messageType: 'ai.work-completed', schemaVersion: '1.4.0', identityKey: `${SERVICE}:ai.work-completed:${work.work_id}`, payload: {
        work_id: work.work_id, workload: work.workload, session_id: work.session_id, sequence: work.sequence,
        attempt: result.attempt, completed_at: new Date().toISOString(), result: {
          status: result.status, work_id: work.work_id, request_fingerprint: fingerprintModelRequest(work.input.model_request), response: result.response
        }
      } }];
    } catch (error) {
      const normalized = error instanceof ModelRequestError ? error : modelFailure(error.cause?.code || error.code || 'MODEL_REQUEST_FAILED', error.message, error.cause?.category || 'dependency', true);
      return [{ plane: 'control', messageType: 'ai.work-completed', schemaVersion: '1.4.0', identityKey: `${SERVICE}:ai.work-completed:${work.work_id}`, payload: {
        work_id: work.work_id, workload: work.workload, session_id: work.session_id, sequence: work.sequence,
        attempt: work.recovery.max_attempts, completed_at: new Date().toISOString(), result: {
          status: 'failed', work_id: work.work_id, request_fingerprint: fingerprintModelRequest(work.input.model_request),
          error: { code: normalized.code, category: normalized.category, message: normalized.message, retryable: normalized.retryable }
        }
      } }];
    }
  }, traceDetail: (message) => ({ workload: message.payload.workload, scheduler_concurrency: 1, scheduler_work_id: message.payload.work_id }) }
} });

async function requestLocalModel(config, request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    let response;
    const requestBody = config.protocol === 'ollama' ? {
      model: config.modelName,
      stream: false,
      format: 'json',
      prompt: `Return only a JSON object with exactly {"protocol_version":"1.0.0","purpose":"${request.purpose}","text":"..."}. Do not add markdown or commentary. The following is the governed Argus request; use its authoritative source segments and preserve no fields outside the requested response shape:\n${JSON.stringify(request)}`
    } : request;
    try {
      response = await fetch(config.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody), signal: controller.signal });
    } catch (error) {
      if (error.name === 'AbortError') throw modelFailure('MODEL_ENDPOINT_TIMEOUT', `model endpoint did not respond within ${config.timeoutMs} ms`, 'timeout', true);
      throw modelFailure('MODEL_ENDPOINT_UNAVAILABLE', `model endpoint is unavailable: ${error.message}`, 'unavailable', true);
    }
    if (!response.ok) throw modelFailure('MODEL_ENDPOINT_UNAVAILABLE', `model endpoint returned HTTP ${response.status}`, 'unavailable', true);
    const body = await response.text();
    try {
      const parsed = JSON.parse(body);
      if (config.protocol === 'ollama') return JSON.parse(String(parsed.response || ''));
      return parsed;
    }
    catch { throw modelFailure('MODEL_INVALID_JSON', 'model endpoint returned malformed JSON', 'validation', true); }
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeWork(work) {
  if (!work || typeof work !== 'object' || !work.work_id || !work.session_id || !work.input?.model_request) throw new ServiceOperationError('ai.work-request must contain a provider-neutral model request', { code: 'INVALID_MODEL_REQUEST', category: 'validation' });
  try { validateModelRequest(work.input.model_request); }
  catch (error) { throw new ServiceOperationError(error.message, { code: error.cause?.code || 'INVALID_MODEL_REQUEST', category: 'validation' }); }
  try { assertPurposeMatchesWorkload(work.input.model_request.purpose, work.workload); }
  catch (error) { throw new ServiceOperationError(error.message, { code: error.cause?.code || 'MODEL_PURPOSE_WORKLOAD_CONFLICT', category: 'conflict' }); }
  if (work.input.model_request.identity?.work_id !== work.work_id) throw new ServiceOperationError('model request identity does not match scheduler work identity', { code: 'MODEL_WORK_ID_CONFLICT', category: 'conflict' });
  if (!Number.isInteger(work.sequence) || work.sequence < 0 || !Number.isInteger(work.recovery?.max_attempts) || work.recovery.max_attempts < 1) throw new ServiceOperationError('ai.work-request sequence and recovery policy are invalid', { code: 'INVALID_MODEL_REQUEST', category: 'validation' });
  return structuredClone(work);
}

class ModelRequestError extends Error {
  constructor(code, message, category, retryable) { super(message); this.name = 'ModelRequestError'; this.code = code; this.category = category; this.retryable = retryable; }
}
function modelFailure(code, message, category, retryable) { return new ModelRequestError(code, message, category, retryable); }
