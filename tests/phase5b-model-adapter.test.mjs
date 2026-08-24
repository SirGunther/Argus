import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildExtractionRequest, fingerprintRequest } from '../services/log-extractor-local-http/model-boundary.mjs';
import { buildClassificationRequest } from '../services/logged-item-classification-suggester/model-boundary.mjs';
import { readModelConfig } from '../services/serial-ai-model-lane/model-config.mjs';
import { buildNodeEnvironment } from '../runtime/providers/node-process-provider.mjs';
import { createEnvelope, loadGraphDefinition, prepareGraph, runGraph } from '../runtime/orchestrator.mjs';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { runService } from './helpers/process-harness.mjs';
import { startDeterministicLocalModelEndpoint } from './helpers/deterministic-local-model-endpoint.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const session = 'phase5b-test-session';
const manifest = (name) => path.join(root, 'services', name, 'service.json');

test('model request receives exact authoritative/context segments, policy, instruction, and budgets', () => {
  const window = contextWindow();
  const request = buildExtractionRequest(window, { workId: 'logged-item-extraction:test:window-1', modelName: 'test-model' });
  assert.deepEqual(request.authoritative_source_segments, window.segments);
  assert.deepEqual(request.bounded_context_segments, window.context_segments);
  assert.equal(request.policy_profile, 'neutral-contextual-log');
  assert.equal(request.instruction_version, '1.0.0');
  assert.deepEqual(request.limits, { max_context_chars: 100, max_context_tokens: 25, max_output_chars: 512, max_output_tokens: 128 });
  assert.equal(Object.hasOwn(request, 'transcript_history'), false);
  assert.deepEqual(request.identity, { work_id: 'logged-item-extraction:test:window-1', session_id: session, context_window_id: 'window-1' });
});

test('Phase 5B graph uses one scheduler lane and the required workload boundaries', async () => {
  const { definition, graphFile } = await loadGraphDefinition(path.join(root, 'wiring/demo.logged-item-model.json'));
  const prepared = await prepareGraph(definition, graphFile);
  assert.equal(prepared.services.size, 8);
  assert.ok(definition.control_wires.some((wire) => wire.from === 'log-extractor' && wire.to === 'model-lane' && wire.contract === 'ai.work-request'));
  assert.ok(definition.control_wires.some((wire) => wire.from === 'classification' && wire.to === 'model-lane' && wire.contract === 'ai.work-request'));
  assert.ok(definition.domain_wires.some((wire) => wire.from === 'active-owner' && wire.to === 'classification' && wire.contract === 'logged-item.stored'));
  assert.ok(definition.domain_wires.some((wire) => wire.from === 'window-selector' && wire.to === 'classification' && wire.contract === 'transcript.context-window'));
  assert.equal(definition.domain_wires.some((wire) => wire.contract === 'transcript.partial'), false);
  assert.ok(prepared.services.get('model-lane').manifest.state.includes('one in-memory SerialAiScheduler'));
});

test('model lane and classifier use shared contract infrastructure, not sibling service implementation imports', async () => {
  const lane = await readFile(path.join(root, 'services/serial-ai-model-lane/index.mjs'), 'utf8');
  const classifier = await readFile(path.join(root, 'services/logged-item-classification-suggester/index.mjs'), 'utf8');
  assert.doesNotMatch(lane, /log-extractor-local-http/);
  assert.doesNotMatch(classifier, /log-extractor-local-http/);
  assert.match(lane, /contracts\/model-protocol\.mjs/);
  assert.match(classifier, /contracts\/model-protocol\.mjs/);
});

test('successful HTTP extraction creates one replay-safe draft with Argus-owned identity and provenance', async () => {
  await withEndpoint({}, async (endpoint) => {
    const window = contextWindow({ contextSegments: [] });
    const workId = 'logged-item-extraction:phase5b-test-session:window-1';
    const request = buildExtractionRequest(window, { workId, modelName: 'test-model' });
    const completion = modelCompletion({ workId, workload: 'logged-item-extraction', request, response: extractionResponse('Neutral model text.') });
    const result = await runService(manifest('log-extractor-local-http'), [contextEnvelope(window), completion], 4);
    const draft = result.outputs.find((message) => message.message_type === 'logged-item.draft');
    assert.ok(draft);
    assert.equal(draft.payload.text, 'Neutral model text.');
    assert.equal(draft.payload.generator.implementation, 'log-extractor-local-http');
    assert.deepEqual(draft.payload.source, window.source);
    assert.equal(draft.payload.item_id.includes('forged'), false);
    assert.equal(result.outputs.some((message) => message.message_type === 'service.failure'), false);
    assert.equal(endpoint.requests.length, 0);
  });
});

test('deterministic extractors and HTTP adapter share the existing logical graph position', async () => {
  const { definition, graphFile } = await loadGraphDefinition(path.join(root, 'wiring/demo.logged-item-pipeline.json'));
  const model = structuredClone(definition);
  model.services.find((service) => service.id === 'log-extractor').manifest = '../services/log-extractor-local-http/service.json';
  await assert.doesNotReject(() => prepareGraph(model, graphFile));
  const modelDomain = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(manifest('log-extractor-local-http'), 'utf8')));
  for (const fake of ['log-extractor-concise', 'log-extractor-passthrough']) {
    const fakeManifest = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(manifest(fake), 'utf8')));
    assert.deepEqual(fakeManifest.ports.domain, modelDomain.ports.domain);
    const replacement = structuredClone(definition);
    replacement.services.find((service) => service.id === 'log-extractor').manifest = `../services/${fake}/service.json`;
    await assert.doesNotReject(() => prepareGraph(replacement, graphFile));
  }
});

test('shared lane retries with stable work and exact request identity', async () => {
  await withEndpoint({ scenario: 'failure-once-then-valid' }, async (endpoint) => {
    const workId = 'logged-item-extraction:retry-session:window-1';
    const request = buildExtractionRequest(contextWindow({ sessionId: 'retry-session', contextSegments: [] }), { workId, modelName: 'test-model' });
    const result = await runService(manifest('serial-ai-model-lane'), [createEnvelope({ plane: 'control', messageType: 'ai.work-request', producer: 'test', correlationId: 'retry-session', idempotencyKey: 'retry-work', schemaVersion: '1.4.0', payload: {
      work_id: workId, workload: 'logged-item-extraction', session_id: 'retry-session', sequence: 1, queued_at: '2026-08-19T00:00:00.000Z', input: { model_request: request }, recovery: { max_attempts: 2 }
    } })], 2);
    assert.equal(result.outputs[0].message_type, 'ai.work-completed');
    assert.equal(result.outputs[0].payload.attempt, 2);
    assert.equal(endpoint.requests.length, 2);
    assert.deepEqual(endpoint.requests[0].body, endpoint.requests[1].body);
    assert.equal(endpoint.requests[0].body.identity.work_id, workId);
  });
});

test('endpoint unavailable, timeout, malformed JSON, and invalid structured output create no item', async () => {
  for (const [scenario, code, options] of [
    ['unavailable', 'MODEL_ENDPOINT_UNAVAILABLE', {}],
    ['timeout', 'MODEL_ENDPOINT_TIMEOUT', { delayMs: 60, timeoutMs: '10' }],
    ['malformed-json', 'MODEL_INVALID_JSON', {}],
    ['invalid-output', 'INVALID_MODEL_OUTPUT', {}]
  ]) {
    const endpoint = await startDeterministicLocalModelEndpoint(options.scenario ? options : { scenario });
    const endpointUrl = endpoint.endpoint;
    if (scenario === 'unavailable') await endpoint.close();
    const previous = setModelEnv(endpointUrl, options.timeoutMs || '50');
    try {
      await assert.rejects(() => runGraph(path.join(root, 'wiring/demo.logged-item-model.json')), new RegExp(code));
    } finally {
      restoreModelEnv(previous);
      if (scenario !== 'unavailable') await endpoint.close();
    }
  }
});

test('invalid model identity/output cannot become a draft and exact context remains retained in failure evidence', async () => {
  await withEndpoint({}, async () => {
    const window = contextWindow({ contextSegments: [] });
    const workId = 'logged-item-extraction:phase5b-test-session:window-1';
    const request = buildExtractionRequest(window, { workId, modelName: 'test-model' });
    const completion = modelCompletion({ workId, workload: 'logged-item-extraction', request, response: { ...extractionResponse('Neutral'), item_id: 'forged', source: { first_segment_id: 'forged' } } });
    const result = await runService(manifest('log-extractor-local-http'), [contextEnvelope(window), completion], 3);
    assert.equal(result.outputs.some((message) => message.message_type === 'logged-item.draft'), false);
    const failure = result.outputs.find((message) => message.message_type === 'service.failure');
    assert.equal(failure.payload.error.code, 'INVALID_MODEL_OUTPUT');
    assert.equal(failure.payload.error.retryable, true);
    assert.equal(failure.payload.error.details.retained_exact_context, true);
  });
});

test('classification is optional, revision-bound, lowest priority, and cannot mutate the primary item', async () => {
  await withEndpoint({ scenario: 'classification-failure' }, async (endpoint) => {
    const graph = await runGraph(path.join(root, 'wiring/demo.logged-item-model.json'));
    assert.ok(graph.completions.some((message) => message.message_type === 'logged-item.history-appended'));
    assert.equal(graph.completions.some((message) => message.message_type === 'classification.suggestion'), false);
    assert.deepEqual(endpoint.requests.map(({ body }) => body.purpose), ['logged-item-extraction', 'classification-enrichment']);
    const item = { item_id: 'item-classify', session_id: session, stored_at: '2026-08-19T00:00:01.000Z', text: 'Schedule the review.', revision: 0, revision_id: 'item-classify:r0', source: { first_segment_id: 'segment-1', last_segment_id: 'segment-2', start_time: '00:00:01.000', end_time: '00:00:03.000' }, generator: { implementation: 'test', input_window_id: 'window-1' } };
    const workId = `classification-enrichment:${session}:${item.item_id}:r0`;
    const window = contextWindow({ contextSegments: [{ segment_id: 'lookback-0', sequence: 0, start_time: '00:00:00.000', end_time: '00:00:01.000', text: 'Earlier context.', relation: 'lookback' }] });
    const request = buildClassificationRequest(item, window, { workId, modelName: 'test-model' });
    const result = await runService(manifest('logged-item-classification-suggester'), [
      contextEnvelope(window),
      createEnvelope({ plane: 'domain', messageType: 'logged-item.stored', producer: 'test', correlationId: session, idempotencyKey: 'stored:classify', payload: item }),
      modelCompletion({ workId, workload: 'classification-enrichment', request, response: classificationResponse('task', 0.9) })
    ], 5);
    const suggestion = result.outputs.find((message) => message.message_type === 'classification.suggestion');
    assert.deepEqual(suggestion.payload, { item_id: item.item_id, session_id: session, item_revision: 0, suggested_classification: 'task', confidence: 0.9, evidence_segment_ids: ['segment-1', 'segment-2', 'lookback-0'] });
    assert.equal(suggestion.payload.text, undefined);
    assert.equal(item.text, 'Schedule the review.');
    assert.deepEqual(request.source_transcript, window.segments);
    assert.deepEqual(request.lookback_context, window.context_segments);
    assert.deepEqual(request.forward_context, []);
    const classificationRequest = endpoint.requests[1].body;
    assert.equal(classificationRequest.source_transcript.length, 3);
    assert.ok(Array.isArray(classificationRequest.lookback_context));
    assert.ok(Array.isArray(classificationRequest.forward_context));
    assert.deepEqual(classificationRequest.evidence_segment_ids, [...classificationRequest.source_transcript, ...classificationRequest.lookback_context, ...classificationRequest.forward_context].map((segment) => segment.segment_id));
  });
});

test('governed model fixtures accept the valid protocol and reject malformed model shapes', async () => {
  const registry = await loadContractRegistry(path.join(root, 'contracts/catalog.json'));
  const validRequest = JSON.parse(await readFile(path.join(root, 'tests/fixtures/contracts/ai.work-request/1.4.0/valid.json'), 'utf8'));
  const invalidRequest = JSON.parse(await readFile(path.join(root, 'tests/fixtures/contracts/ai.work-request/1.4.0/invalid-missing-model-context.json'), 'utf8'));
  const validCompletion = JSON.parse(await readFile(path.join(root, 'tests/fixtures/contracts/ai.work-completed/1.4.0/valid.json'), 'utf8'));
  const invalidCompletion = JSON.parse(await readFile(path.join(root, 'tests/fixtures/contracts/ai.work-completed/1.4.0/invalid-extra-model-field.json'), 'utf8'));
  assert.deepEqual(registry.validateEnvelope(validRequest), []);
  assert.deepEqual(registry.validateEnvelope(validCompletion), []);
  assert.match(registry.validateEnvelope(invalidRequest).join('\n'), /model_request|oneOf/);
  assert.match(registry.validateEnvelope(invalidCompletion).join('\n'), /additional property|oneOf/);
});

test('model lane rejects a purpose-to-workload priority mismatch', async () => {
  const window = contextWindow();
  const item = { item_id: 'item-priority', session_id: session, stored_at: '2026-08-19T00:00:01.000Z', text: 'Schedule the review.', revision: 0, source: window.source, generator: { implementation: 'test', input_window_id: window.window_id } };
  const request = buildClassificationRequest(item, window, { workId: 'classification-enrichment:priority:item-priority:r0', modelName: 'test-model' });
  const result = await runService(manifest('serial-ai-model-lane'), [createEnvelope({ plane: 'control', messageType: 'ai.work-request', producer: 'test', correlationId: session, idempotencyKey: 'priority-mismatch', schemaVersion: '1.4.0', payload: {
    work_id: request.identity.work_id, workload: 'logged-item-extraction', session_id: session, sequence: 1, queued_at: '2026-08-19T00:00:00.000Z', input: { model_request: request }, recovery: { max_attempts: 1 }
  } })], 1);
  assert.equal(result.outputs[0].message_type, 'service.failure');
  assert.equal(result.outputs[0].payload.error.code, 'MODEL_PURPOSE_WORKLOAD_CONFLICT');
});

test('model configuration is filtered to the declared component allowlist', () => {
  const base = { PATH: 'path', ARGUS_MODEL_ENDPOINT: 'http://127.0.0.1:1234', ARGUS_MODEL_NAME: 'fixture', ARGUS_MODEL_TIMEOUT_MS: '50', ARGUS_MODEL_UNDECLARED: 'secret' };
  const extractor = buildNodeEnvironment(base, ['ARGUS_MODEL_NAME'], 'log-extractor');
  assert.equal(extractor.ARGUS_MODEL_NAME, 'fixture');
  assert.equal(extractor.ARGUS_MODEL_ENDPOINT, undefined);
  assert.equal(extractor.ARGUS_MODEL_TIMEOUT_MS, undefined);
  assert.equal(extractor.ARGUS_MODEL_UNDECLARED, undefined);
  const lane = buildNodeEnvironment(base, ['ARGUS_MODEL_ENDPOINT', 'ARGUS_MODEL_NAME', 'ARGUS_MODEL_TIMEOUT_MS'], 'model-lane');
  assert.equal(lane.ARGUS_MODEL_ENDPOINT, base.ARGUS_MODEL_ENDPOINT);
  assert.equal(lane.ARGUS_MODEL_TIMEOUT_MS, '50');
  assert.equal(lane.ARGUS_SERVICE_INSTANCE_ID, 'model-lane');
});

test('classifier bounds explicit context retention before admission', async () => {
  const inputs = Array.from({ length: 33 }, (_, index) => {
    const window = contextWindow();
    window.window_id = `window-capacity-${index}`;
    return contextEnvelope(window);
  });
  const result = await runService(manifest('logged-item-classification-suggester'), inputs, 33);
  const failure = result.outputs.find((message) => message.message_type === 'service.failure');
  assert.equal(failure.payload.error.code, 'CLASSIFICATION_CONTEXT_FULL');
  assert.equal(result.outputs.filter((message) => message.message_type === 'operation.completed').length, 32);
});

test('model configuration is explicit and local-only', () => {
  assert.throws(() => readModelConfig({ ARGUS_MODEL_ENDPOINT: '', ARGUS_MODEL_NAME: 'x', ARGUS_MODEL_TIMEOUT_MS: '10' }), /ARGUS_MODEL_ENDPOINT is required/);
  assert.throws(() => readModelConfig({ ARGUS_MODEL_ENDPOINT: 'https://127.0.0.1', ARGUS_MODEL_NAME: 'x', ARGUS_MODEL_TIMEOUT_MS: '10' }), /loopback-only http/);
  assert.throws(() => readModelConfig({ ARGUS_MODEL_ENDPOINT: 'http://example.com', ARGUS_MODEL_NAME: 'x', ARGUS_MODEL_TIMEOUT_MS: '10' }), /loopback-only http/);
  assert.throws(() => readModelConfig({ ARGUS_MODEL_ENDPOINT: 'http://127.0.0.2:1234/v1', ARGUS_MODEL_NAME: 'x', ARGUS_MODEL_TIMEOUT_MS: '10' }), /loopback-only http/);
  assert.deepEqual(readModelConfig({ ARGUS_MODEL_ENDPOINT: 'http://localhost:1234/v1', ARGUS_MODEL_NAME: 'x', ARGUS_MODEL_TIMEOUT_MS: '10' }), { endpoint: 'http://localhost:1234/v1', modelName: 'x', timeoutMs: 10, protocol: 'provider-neutral-json' });
  assert.deepEqual(readModelConfig({ ARGUS_MODEL_ENDPOINT: 'http://[::1]:1234/v1', ARGUS_MODEL_NAME: 'x', ARGUS_MODEL_TIMEOUT_MS: '10' }), { endpoint: 'http://[::1]:1234/v1', modelName: 'x', timeoutMs: 10, protocol: 'provider-neutral-json' });
  assert.deepEqual(readModelConfig({ ARGUS_MODEL_ENDPOINT: 'http://127.0.0.1:1234/v1', ARGUS_MODEL_NAME: 'x', ARGUS_MODEL_TIMEOUT_MS: '10' }), { endpoint: 'http://127.0.0.1:1234/v1', modelName: 'x', timeoutMs: 10, protocol: 'provider-neutral-json' });
});

function contextWindow({ sessionId = session, contextSegments = [{ segment_id: 'lookback-0', sequence: 0, start_time: '00:00:00.000', end_time: '00:00:01.000', text: 'Earlier context.', relation: 'lookback' }] } = {}) {
  const segments = [
    { segment_id: 'segment-1', sequence: 1, start_time: '00:00:01.000', end_time: '00:00:02.000', text: 'Authoritative first.' },
    { segment_id: 'segment-2', sequence: 2, start_time: '00:00:02.000', end_time: '00:00:03.000', text: 'Authoritative second.' }
  ];
  return { window_id: 'window-1', session_id: sessionId, reason: 'pause', segments, source: { first_segment_id: 'segment-1', last_segment_id: 'segment-2', start_time: '00:00:01.000', end_time: '00:00:03.000' }, context_segments: contextSegments, generation_directive: { purpose: 'logged-item-extraction', policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0', context_scope: { source_range_only: contextSegments.length === 0, lookback_segment_count: 1, forward_segment_count: 0, max_context_chars: 100 } } };
}

function contextEnvelope(window) { return createEnvelope({ plane: 'domain', messageType: 'transcript.context-window', producer: 'test', correlationId: window.session_id, idempotencyKey: `window:${window.window_id}`, schemaVersion: '1.4.0', payload: window }); }
function modelCompletion({ workId, workload, request, response }) { return createEnvelope({ plane: 'control', messageType: 'ai.work-completed', producer: 'model-lane', correlationId: request.identity.session_id, idempotencyKey: `completion:${workId}`, schemaVersion: '1.4.0', payload: { work_id: workId, workload, session_id: request.identity.session_id, sequence: workload === 'classification-enrichment' ? request.identity.item_revision : 2, attempt: 1, completed_at: '2026-08-19T00:00:02.000Z', result: { status: 'succeeded', work_id: workId, request_fingerprint: fingerprintRequest(request), response } } }); }

function extractionResponse(text) { return { protocol_version: '1.0.0', purpose: 'logged-item-extraction', text }; }
function classificationResponse(suggested_classification, confidence) { return { protocol_version: '1.0.0', purpose: 'classification-enrichment', suggested_classification, confidence }; }

async function withEndpoint(options, callback) {
  const endpoint = await startDeterministicLocalModelEndpoint(options);
  const previous = setModelEnv(endpoint.endpoint, '500');
  try { return await callback(endpoint); }
  finally { restoreModelEnv(previous); await endpoint.close(); }
}
function setModelEnv(endpoint, timeoutMs) { const previous = { endpoint: process.env.ARGUS_MODEL_ENDPOINT, model: process.env.ARGUS_MODEL_NAME, timeout: process.env.ARGUS_MODEL_TIMEOUT_MS }; process.env.ARGUS_MODEL_ENDPOINT = endpoint; process.env.ARGUS_MODEL_NAME = 'test-model'; process.env.ARGUS_MODEL_TIMEOUT_MS = String(timeoutMs); return previous; }
function restoreModelEnv(previous) { if (previous.endpoint === undefined) delete process.env.ARGUS_MODEL_ENDPOINT; else process.env.ARGUS_MODEL_ENDPOINT = previous.endpoint; if (previous.model === undefined) delete process.env.ARGUS_MODEL_NAME; else process.env.ARGUS_MODEL_NAME = previous.model; if (previous.timeout === undefined) delete process.env.ARGUS_MODEL_TIMEOUT_MS; else process.env.ARGUS_MODEL_TIMEOUT_MS = previous.timeout; }
