import { SerialAiScheduler } from '../../runtime/serial-ai-scheduler.mjs';
import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { assertPurposeMatchesWorkload, fingerprintModelRequest, validateModelRequest, validateModelResponse } from '../../contracts/model-protocol.mjs';
import { normalizeModelProviderSettings, readRuntimeModelConfig } from './model-config.mjs';

const SERVICE = 'serial-ai-model-lane';
const journal = {
  events: [],
  async load() { return []; },
  async append(event) {
    this.events.push(event);
    process.stderr.write(`${JSON.stringify({ service: SERVICE, operation: 'serial-ai-scheduler', event: event.event, work_id: event.work?.work_id || event.work_id, workload: event.work?.workload, request_fingerprint: event.work?.input?.model_request ? fingerprintModelRequest(event.work.input.model_request) : undefined })}\n`);
  }
};

// The host sends the active configuration over the governed control wire after startup. The
// legacy environment remains a compatibility default for existing Ollama graphs and tests.
let activeRuntimeConfig;
try { activeRuntimeConfig = readRuntimeModelConfig(); } catch { activeRuntimeConfig = undefined; }

const scheduler = await SerialAiScheduler.create({
  journal,
  capacity: 32,
  executor: async (work, { attempt }) => {
    const request = work.input?.model_request;
    if (!request || request.identity?.work_id !== work.work_id) throw modelFailure('INVALID_MODEL_REQUEST', 'scheduler work must contain a matching provider-neutral model request', 'validation', false);
    try {
      const runtime = activeRuntimeConfig;
      if (!runtime) throw modelFailure('MODEL_PROVIDER_UNAVAILABLE', 'no governed AI provider configuration is active', 'unavailable', false);
      if (request.model !== runtime.configuration.model) throw modelFailure('MODEL_CONFIGURATION_CONFLICT', 'model request does not match the configured model name', 'validation', false);
      const response = await requestConfiguredModel(runtime, request);
      return { status: 'succeeded', attempt, response: validateModelResponse(response, request.purpose, request.limits) };
    } catch (error) {
      throw error instanceof ModelRequestError ? error : modelFailure(error.cause?.code || 'MODEL_REQUEST_FAILED', error.message, 'dependency', true);
    }
  }
});

runLineService({ service: SERVICE, operations: {
  'ai.provider-configure': { name: 'configure-model-provider', async handle(message) {
    const payload = message.payload;
    try {
      const configuration = normalizeModelProviderSettings(payload?.configuration);
      const credential = payload?.credential?.provided === true ? payload.credential.value : undefined;
      if (payload?.credential?.provided === true && (typeof credential !== 'string' || !credential.trim())) {
        throw modelFailure('MODEL_CREDENTIAL_MISSING', 'the configured external provider credential is empty', 'unavailable', false);
      }
      if (configuration.mode === 'local' && credential) throw modelFailure('INVALID_MODEL_PROVIDER_CONFIGURATION', 'local providers may not receive a credential', 'validation', false);
      activeRuntimeConfig = { configuration, ...(credential ? { credential: credential.trim() } : {}), credential_configured: Boolean(credential) };
      return [];
    } catch (error) {
      if (error instanceof ModelRequestError) throw new ServiceOperationError(error.message, { code: error.code, category: error.category, retryable: error.retryable });
      throw new ServiceOperationError(error.message, { code: error.cause?.code || error.code || 'INVALID_MODEL_PROVIDER_CONFIGURATION', category: error.cause?.category || 'validation' });
    }
  }, traceDetail: () => ({ configuration: 'redacted' }) },
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

async function requestConfiguredModel(runtime, request) {
  const config = runtime.configuration;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout_ms);
  try {
    let response;
    const requestBody = config.protocol === 'ollama' ? {
      model: config.model,
      stream: false,
      format: 'json',
      prompt: ollamaPrompt(request)
    } : config.protocol === 'openai-compatible' ? {
      model: config.model,
      stream: false,
      temperature: 0,
      messages: [{ role: 'system', content: modelInstruction(request) }, { role: 'user', content: JSON.stringify(request) }]
    } : request;
    const headers = { 'content-type': 'application/json' };
    if (runtime.credential) headers.authorization = `Bearer ${runtime.credential}`;
    if (config.mode === 'external' && !runtime.credential) throw modelFailure('MODEL_CREDENTIAL_MISSING', 'the selected external provider has no saved API key', 'unavailable', false);
    try {
      response = await fetch(config.endpoint, { method: 'POST', headers, body: JSON.stringify(requestBody), signal: controller.signal });
    } catch (error) {
      if (error.name === 'AbortError') throw modelFailure('MODEL_ENDPOINT_TIMEOUT', `model endpoint did not respond within ${config.timeout_ms} ms`, 'timeout', true);
      throw modelFailure('MODEL_ENDPOINT_UNAVAILABLE', `model endpoint is unavailable: ${error.message}`, 'unavailable', true);
    }
    if (!response.ok) throw modelFailure('MODEL_ENDPOINT_UNAVAILABLE', `model endpoint returned HTTP ${response.status}`, 'unavailable', true);
    const body = await response.text();
    try {
      const parsed = JSON.parse(body);
      if (config.protocol === 'ollama') return JSON.parse(String(parsed.response || ''));
      if (config.protocol === 'openai-compatible') {
        const content = parsed.choices?.[0]?.message?.content;
        if (typeof content === 'object' && content) return content;
        return JSON.parse(String(content || ''));
      }
      return parsed;
    }
    catch { throw modelFailure('MODEL_INVALID_JSON', 'model endpoint returned malformed JSON', 'validation', true); }
  } finally {
    clearTimeout(timeout);
  }
}

function modelInstruction(request) {
  const shape = request.purpose === 'classification-enrichment'
    ? '{"protocol_version":"1.0.0","purpose":"classification-enrichment","suggested_classification":"task|note|observation|idea","confidence":0.0}'
    : '{"protocol_version":"1.0.0","purpose":"logged-item-extraction","text":"..."}';
  return `Return only one JSON object with exactly ${shape}. Do not add markdown or commentary. Use only the governed Argus request supplied by the user.`;
}

function ollamaPrompt(request) {
  return `${modelInstruction(request)}\nThe following is the governed Argus request; preserve no fields outside the requested response shape:\n${JSON.stringify(request)}`;
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
