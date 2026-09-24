import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createSafeStorageCredentialStore,
  modelProviderCredentialScope,
  normalizeModelProviderSettings
} from '../runtime/model-provider-settings.mjs';
import { SCRIBE_BATCH_PROTOCOL_VERSION } from '../contracts/model-protocol.mjs';
import { createEnvelope } from '../runtime/orchestrator.mjs';
import { providerRequestExtensions } from '../services/serial-ai-model-lane/model-config.mjs';
import { buildExtractionRequest } from '../services/log-extractor-local-http/model-boundary.mjs';
import { buildClassificationRequest } from '../services/logged-item-classification-suggester/model-boundary.mjs';
import { buildScribeBatchRequest } from '../services/log-extractor-local-http/scribe-batch-boundary.mjs';
import { runService } from './helpers/process-harness.mjs';
import { startScribeBatchModelEndpoint } from './helpers/scribe-batch-model-endpoint.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const laneManifest = path.join(root, 'services', 'serial-ai-model-lane', 'service.json');
const session = 'remote-lm-studio-session';
const MODEL = 'remote-lm-studio-model';
const REMOTE_ORIGIN = 'https://lm-studio.example.ts.net';
const REMOTE_ENDPOINT = `${REMOTE_ORIGIN}/v1/chat/completions`;
const CREDENTIAL = 'fixture-lm-studio-token';

const externalLmStudio = Object.freeze({ mode: 'external', provider: 'lm-studio', endpoint: REMOTE_ENDPOINT, model: MODEL, protocol: 'openai-compatible', timeout_ms: 2000 });

test('external LM Studio normalizes to one exact HTTPS chat completions configuration', () => {
  const expected = { version: 1, mode: 'external', provider: 'lm-studio', endpoint: REMOTE_ENDPOINT, model: MODEL, protocol: 'openai-compatible', timeout_ms: 2000 };
  assert.deepEqual(normalizeModelProviderSettings(externalLmStudio), expected);
  // Protocol defaults to OpenAI-compatible for a non-Ollama provider, exactly as local LM Studio does.
  const { protocol: _omitted, ...withoutProtocol } = externalLmStudio;
  assert.deepEqual(normalizeModelProviderSettings(withoutProtocol), expected);
  // A reverse proxy may mount LM Studio under a sub-path; only the chat completions suffix is fixed.
  assert.equal(normalizeModelProviderSettings({ ...externalLmStudio, endpoint: `${REMOTE_ORIGIN}/lm/v1/chat/completions` }).endpoint, `${REMOTE_ORIGIN}/lm/v1/chat/completions`);
});

test('external LM Studio rejects plain HTTP, non-chat-completions paths, non-OpenAI protocols, and URL credentials', () => {
  const invalid = (overrides, pattern) => assert.throws(
    () => normalizeModelProviderSettings({ ...externalLmStudio, ...overrides }),
    (error) => error.code === 'INVALID_MODEL_PROVIDER_CONFIGURATION' && pattern.test(error.message)
  );
  invalid({ endpoint: 'http://lm-studio.example.ts.net/v1/chat/completions' }, /^External model endpoints must use HTTPS$/);
  const expectedForm = /full chat completions URL, for example https:\/\/<host>\/v1\/chat\/completions/;
  invalid({ endpoint: `${REMOTE_ORIGIN}/v1` }, expectedForm);
  invalid({ endpoint: `${REMOTE_ORIGIN}/v1/` }, expectedForm);
  invalid({ endpoint: `${REMOTE_ORIGIN}/v1/models` }, expectedForm);
  invalid({ endpoint: `${REMOTE_ORIGIN}/v1/chat/completions/` }, expectedForm);
  invalid({ endpoint: REMOTE_ORIGIN }, expectedForm);
  invalid({ protocol: 'provider-neutral-json' }, /^External LM Studio must use the OpenAI-compatible protocol$/);
  invalid({ protocol: 'ollama' }, /^External LM Studio must use the OpenAI-compatible protocol$/);
  invalid({ endpoint: 'https://user:secret@lm-studio.example.ts.net/v1/chat/completions' }, /^AI provider endpoint must not contain credentials$/);
  invalid({ provider: 'ollama' }, /^External provider must be OpenAI-compatible or LM Studio$/);
});

test('the external LM Studio rules leave local providers and external OpenAI-compatible exactly as before', () => {
  // Local LM Studio still accepts provider-neutral JSON on any loopback path and never needs HTTPS.
  assert.deepEqual(normalizeModelProviderSettings({ mode: 'local', provider: 'lm-studio', endpoint: 'http://127.0.0.1:1234/v1/generate', model: 'local-model', protocol: 'provider-neutral-json', timeout_ms: 1000 }), {
    version: 1, mode: 'local', provider: 'lm-studio', endpoint: 'http://127.0.0.1:1234/v1/generate', model: 'local-model', protocol: 'provider-neutral-json', timeout_ms: 1000
  });
  assert.throws(() => normalizeModelProviderSettings({ mode: 'local', provider: 'lm-studio', endpoint: 'https://lm-studio.example.ts.net/v1/chat/completions', model: 'x', timeout_ms: 1000 }), /Local model endpoints must use loopback HTTP/);
  assert.throws(() => normalizeModelProviderSettings({ mode: 'local', provider: 'openai-compatible', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'x', timeout_ms: 1000 }), /Local provider must be Ollama or LM Studio/);
  // External OpenAI-compatible keeps accepting a non-chat-completions path and provider-neutral JSON.
  assert.deepEqual(normalizeModelProviderSettings({ mode: 'external', provider: 'openai-compatible', endpoint: 'https://provider.example/v1', model: 'remote-model', protocol: 'provider-neutral-json', timeout_ms: 1000 }), {
    version: 1, mode: 'external', provider: 'openai-compatible', endpoint: 'https://provider.example/v1', model: 'remote-model', protocol: 'provider-neutral-json', timeout_ms: 1000
  });
  assert.throws(() => normalizeModelProviderSettings({ mode: 'external', provider: 'openai-compatible', endpoint: 'https://provider.example/v1/chat/completions', model: 'x', protocol: 'ollama', timeout_ms: 1000 }), /LM Studio and external providers must use an approved JSON protocol/);
});

test('external LM Studio credentials are scoped apart from OpenAI-compatible on the same endpoint', async () => {
  const lmStudio = normalizeModelProviderSettings(externalLmStudio);
  const openAiCompatible = normalizeModelProviderSettings({ ...externalLmStudio, provider: 'openai-compatible' });
  const lmStudioScope = modelProviderCredentialScope(lmStudio);
  const openAiScope = modelProviderCredentialScope(openAiCompatible);
  assert.equal(lmStudioScope, `v1:lm-studio:${REMOTE_ENDPOINT}`);
  assert.equal(openAiScope, `v1:openai-compatible:${REMOTE_ENDPOINT}`);
  assert.notEqual(lmStudioScope, openAiScope);
  assert.equal(modelProviderCredentialScope({ mode: 'local', provider: 'lm-studio', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local-model', timeout_ms: 1000 }), undefined);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'argus-remote-lm-studio-scope-'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8').toString('base64'),
    decryptString: (value) => Buffer.from(value.toString('utf8'), 'base64').toString('utf8')
  };
  try {
    const store = createSafeStorageCredentialStore({ safeStorage, filePath: path.join(directory, 'credential.bin') });
    await store.set(lmStudioScope, CREDENTIAL);
    assert.equal(await store.get(lmStudioScope), CREDENTIAL);
    assert.equal(await store.get(openAiScope), undefined, 'an LM Studio credential cannot be read as the OpenAI-compatible credential');
    assert.equal(await store.has(openAiScope), false);

    await store.set(openAiScope, 'fixture-openai-compatible-value');
    assert.equal(await store.get(openAiScope), 'fixture-openai-compatible-value');
    assert.equal(await store.get(lmStudioScope), undefined, 'an OpenAI-compatible credential cannot be read as the LM Studio credential');
    assert.equal(await store.has(lmStudioScope), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('only external LM Studio over OpenAI-compatible adds reasoning_effort none to the request body', () => {
  const lmStudio = normalizeModelProviderSettings(externalLmStudio);
  assert.deepEqual(providerRequestExtensions(lmStudio), { reasoning_effort: 'none' });
  assert.ok(Object.isFrozen(providerRequestExtensions(lmStudio)));

  const unchanged = [
    normalizeModelProviderSettings({ mode: 'local', provider: 'lm-studio', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local-model', timeout_ms: 1000 }),
    normalizeModelProviderSettings({ mode: 'local', provider: 'ollama', endpoint: 'http://127.0.0.1:11434/api/generate', model: 'llama3.2:3b', protocol: 'ollama', timeout_ms: 1000 }),
    normalizeModelProviderSettings({ mode: 'external', provider: 'openai-compatible', endpoint: REMOTE_ENDPOINT, model: MODEL, timeout_ms: 1000 }),
    // A raw, un-normalized object with a non-OpenAI protocol is not the LM Studio request shape.
    { ...lmStudio, protocol: 'provider-neutral-json' },
    undefined
  ];
  for (const configuration of unchanged) {
    const extensions = providerRequestExtensions(configuration);
    assert.deepEqual(extensions, {}, `${configuration?.mode}/${configuration?.provider}/${configuration?.protocol} must add nothing`);
    assert.ok(Object.isFrozen(extensions));
  }
});

test('the serial lane sends reasoning_effort none and the bearer credential on every external LM Studio workload body', async () => {
  const endpoint = await startScribeBatchModelEndpoint({
    reply: (modelRequest) => modelRequest?.protocol_version === SCRIBE_BATCH_PROTOCOL_VERSION
      ? { items: [{ text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: ['segment-10'] }] }
      : { response: modelRequest?.purpose === 'classification-enrichment'
        ? { protocol_version: '1.0.0', purpose: 'classification-enrichment', suggested_classification: 'task', confidence: 0.8 }
        : { protocol_version: '1.0.0', purpose: 'logged-item-extraction', text: 'Neutral extracted text.' } }
  });
  try {
    const { request: scribeRequest } = buildScribeBatchRequest(scribeDispatchInput());
    const window = contextWindow();
    const extractionRequest = buildExtractionRequest(window, { workId: `logged-item-extraction:${session}:window-1`, modelName: MODEL });
    const item = { item_id: 'item-1', session_id: session, revision: 0, text: 'Schedule the review.', source: window.source, generator: { input_window_id: window.window_id } };
    const classificationRequest = buildClassificationRequest(item, window, { workId: `classification-enrichment:${session}:item-1:r0`, modelName: MODEL });

    const result = await runService(laneManifest, [
      providerConfiguration(externalLmStudio, { provided: true, value: CREDENTIAL }),
      scribeWorkRequest(scribeRequest),
      legacyWorkRequest(extractionRequest, 'logged-item-extraction'),
      legacyWorkRequest(classificationRequest, 'classification-enrichment')
    ], 7, 8000, { env: redirectRemoteFetchTo(endpoint.url) });

    assert.ok(result.outputs.some((message) => message.message_type === 'operation.completed' && message.payload.operation === 'configure-model-provider'));
    const completions = result.outputs.filter((message) => message.message_type === 'ai.work-completed');
    assert.equal(completions.length, 3);
    assert.ok(completions.every((message) => message.payload.result.status === 'succeeded'), JSON.stringify(completions.map((message) => message.payload.result.error)));

    assert.equal(endpoint.calls.length, 3);
    for (const call of endpoint.calls) {
      assert.equal(call.authorization, `Bearer ${CREDENTIAL}`);
      assert.equal(call.envelope.reasoning_effort, 'none');
    }
    const [scribeCall, ...legacyCalls] = endpoint.calls;
    assert.deepEqual(Object.keys(scribeCall.envelope).sort(), ['max_tokens', 'messages', 'model', 'reasoning_effort', 'response_format', 'stream', 'temperature']);
    for (const call of legacyCalls) {
      assert.deepEqual(Object.keys(call.envelope).sort(), ['max_tokens', 'messages', 'model', 'reasoning_effort', 'stream', 'temperature']);
    }
    assert.doesNotMatch(JSON.stringify(result.outputs), new RegExp(CREDENTIAL));
    assert.doesNotMatch(result.diagnostics.join('\n'), new RegExp(CREDENTIAL));
  } finally {
    await endpoint.close();
  }
});

test('external LM Studio without a credential fails work with MODEL_CREDENTIAL_MISSING before any request is sent', async () => {
  const endpoint = await startScribeBatchModelEndpoint({});
  try {
    const request = buildExtractionRequest(contextWindow(), { workId: `logged-item-extraction:${session}:no-credential`, modelName: MODEL });
    const result = await runService(laneManifest, [
      providerConfiguration(externalLmStudio, { provided: false }),
      legacyWorkRequest(request, 'logged-item-extraction')
    ], 3, 5000, { env: redirectRemoteFetchTo(endpoint.url) });

    assert.ok(result.outputs.some((message) => message.message_type === 'operation.completed' && message.payload.operation === 'configure-model-provider'));
    const completion = result.outputs.find((message) => message.message_type === 'ai.work-completed');
    assert.equal(completion.payload.result.status, 'failed');
    assert.equal(completion.payload.result.error.code, 'MODEL_CREDENTIAL_MISSING');
    assert.equal(completion.payload.result.error.retryable, false);
    assert.equal(endpoint.calls.length, 0, 'no model request may leave the lane without the credential');
  } finally {
    await endpoint.close();
  }
});

test('the serial lane still refuses a credential for local LM Studio and an external LM Studio base URL', async () => {
  const result = await runService(laneManifest, [
    providerConfiguration({ mode: 'local', provider: 'lm-studio', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: MODEL, protocol: 'openai-compatible', timeout_ms: 2000 }, { provided: true, value: CREDENTIAL }, 'local-with-credential'),
    providerConfiguration({ ...externalLmStudio, endpoint: `${REMOTE_ORIGIN}/v1` }, { provided: true, value: CREDENTIAL }, 'external-base-url')
  ], 2, 5000);
  const failures = result.outputs.filter((message) => message.message_type === 'service.failure');
  assert.equal(failures.length, 2);
  assert.ok(failures.every((message) => message.payload.operation === 'configure-model-provider'));
  assert.ok(failures.every((message) => message.payload.error.code === 'INVALID_MODEL_PROVIDER_CONFIGURATION'));
  assert.match(failures[0].payload.error.message, /local providers may not receive a credential/);
  assert.match(failures[1].payload.error.message, /https:\/\/<host>\/v1\/chat\/completions/);
  assert.doesNotMatch(JSON.stringify(result.outputs), new RegExp(CREDENTIAL));
});

/**
 * External mode requires HTTPS, so the lane child gets a preloaded `fetch` wrapper that sends
 * requests for the placeholder remote origin to the loopback test endpoint instead. Method,
 * headers, and body pass through unchanged, so the endpoint observes exactly what the lane sent.
 */
function redirectRemoteFetchTo(localUrl) {
  const source = `const target=${JSON.stringify(localUrl)};const prefix=${JSON.stringify(`${REMOTE_ORIGIN}/`)};const original=globalThis.fetch;globalThis.fetch=(input,init)=>original(String(input).startsWith(prefix)?target:input,init);`;
  return { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=data:text/javascript,${encodeURIComponent(source)}`.trim() };
}

function providerConfiguration(configuration, credential, key = 'remote-lm-studio') {
  return createEnvelope({
    plane: 'control', messageType: 'ai.provider-configure', producer: 'test', correlationId: session,
    schemaVersion: '1.0.0', idempotencyKey: `provider-configure:${key}`, payload: { configuration: { version: 1, ...configuration }, credential }
  });
}

function contextWindow() {
  const segments = [{ segment_id: 'segment-1', sequence: 1, start_time: '00:00:01.000', end_time: '00:00:02.000', text: 'Authoritative first.' }];
  return {
    window_id: 'window-1', session_id: session, reason: 'pause', segments,
    source: { first_segment_id: 'segment-1', last_segment_id: 'segment-1', start_time: '00:00:01.000', end_time: '00:00:02.000' },
    context_segments: [],
    generation_directive: { purpose: 'logged-item-extraction', policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0', context_scope: { source_range_only: true, lookback_segment_count: 1, forward_segment_count: 0, max_context_chars: 100 } }
  };
}

function scribeDispatchInput(requestId = 'batch-1') {
  const evidence = [{ segment_id: 'segment-10', revision: 0, sequence: 10, start_time: '00:00:10.000', end_time: '00:00:11.000', text: 'We agreed to ship the draft Friday.' }];
  return {
    batch: {
      batch_identity: {
        request_id: requestId, session_id: session,
        segments: evidence.map((segment) => ({ segment_id: segment.segment_id, revision: 0, sequence: segment.sequence })),
        first_sequence: 10, last_sequence: 10, admission_reason: 'batch-complete',
        policy_id: 'scribe-default', policy_version: '1.0.0', instruction_version: '1.0.0'
      },
      batch_attempt: 1, new_evidence_segments: evidence,
      background_context: { transcript_segments: [], prior_logged_items: [] },
      policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0'
    },
    policy: {
      policy_id: 'scribe-default', policy_version: '1.0.0', session_id: session,
      admission: { rows_per_batch: 3, idle_timeout_ms: 15000 }, context: { max_total_context_tokens: 8000 },
      generation: { policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0' }
    },
    workId: `logged-item-extraction:${session}:${requestId}:batch-attempt-1`,
    modelName: MODEL
  };
}

function scribeWorkRequest(request) {
  return createEnvelope({
    plane: 'control', messageType: 'ai.work-request', producer: 'test', correlationId: session,
    schemaVersion: '1.5.0', idempotencyKey: `scribe-work:${request.batch_identity.request_id}`, payload: {
      work_id: request.identity.work_id, workload: 'logged-item-extraction', session_id: session,
      sequence: request.batch_identity.last_sequence, queued_at: '2026-09-23T00:00:00.000Z',
      input: { model_request: request }, recovery: { max_attempts: 1 }
    }
  });
}

function legacyWorkRequest(request, workload) {
  return createEnvelope({
    plane: 'control', messageType: 'ai.work-request', producer: 'test', correlationId: session,
    schemaVersion: '1.4.0', idempotencyKey: `legacy-work:${request.identity.work_id}`, payload: {
      work_id: request.identity.work_id, workload, session_id: session, sequence: 1,
      queued_at: '2026-09-23T00:00:00.000Z', input: { model_request: request }, recovery: { max_attempts: 1 }
    }
  });
}
