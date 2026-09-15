import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { EXTRACTION_BATCH_OUTPUT_LIMITS, SCRIBE_BATCH_PROTOCOL_VERSION, SCRIBE_BATCH_RESPONSE_JSON_SCHEMA, SCRIBE_ITEM_KINDS } from '../contracts/model-protocol.mjs';
import { buildExtractionRequest } from '../services/log-extractor-local-http/model-boundary.mjs';
import { buildClassificationRequest } from '../services/logged-item-classification-suggester/model-boundary.mjs';
import { buildScribeBatchRequest } from '../services/log-extractor-local-http/scribe-batch-boundary.mjs';
import { createEnvelope } from '../runtime/orchestrator.mjs';
import { runService } from './helpers/process-harness.mjs';
import { startScribeBatchModelEndpoint } from './helpers/scribe-batch-model-endpoint.mjs';
import { startDeterministicLocalModelEndpoint } from './helpers/deterministic-local-model-endpoint.mjs';
import http from 'node:http';

/**
 * SCRIBE-07A: only the OpenAI-compatible Scribe batch request should ask the provider to enforce
 * its existing governed JSON shape via `response_format`. This is the focused regression for that
 * one change to `requestConfiguredModel` (services/serial-ai-model-lane/index.mjs).
 *
 * Real-work baseline this corrects (docs/plans/SCRIBE-STATELESS-REQUEST-HARDENING-TODO.md, "Real-
 * work evidence baseline"): at 2026-09-15 17:20:17 LM Studio returned a complete, valid governed
 * Scribe JSON object wrapped in a Markdown ```json fence for a 9,288-prompt_tokens batch request.
 * Argus rejected it as malformed and, at 17:20:56, resent the identical batch, which the model
 * regenerated as the same fenced result - repeated serial-lane work for no new outcome. Requesting
 * provider-enforced structured output for exactly the Scribe batch request is the first half of
 * closing that gap (SCRIBE-07B separately makes the parser tolerant of the one fence already seen).
 *
 * Before this change, `requestConfiguredModel`'s `openai-compatible` branch built its body from
 * exactly `{ model, stream, temperature, max_tokens, messages }` with no `response_format` key for
 * every request, Scribe batch or not - confirmed by reading the pre-change body construction and by
 * running this file's first test against that code, where it failed on the `response_format`
 * assertion (recorded in the SCRIBE-07A evidence ledger, not reproduced again here).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const laneManifest = path.join(root, 'services', 'serial-ai-model-lane', 'service.json');
const session = 'scribe-structured-response-session';
const MODEL = 'structured-response-test-model';

test('an OpenAI-compatible Scribe batch request carries a strict json_schema response_format derived from the governed response shape, and a normal valid response still passes the existing validator', async () => {
  const { request } = buildScribeBatchRequest(dispatchInput());
  const endpoint = await startScribeBatchModelEndpoint({
    reply: () => ({ items: [{ text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: ['segment-10'] }] })
  });
  try {
    const result = await runService(laneManifest, [providerConfiguration(endpoint.url), workRequestEnvelope(request)], 3, 8000);
    const completion = result.outputs.find((message) => message.message_type === 'ai.work-completed');
    assert.equal(completion.payload.result.status, 'succeeded');
    // Existing post-parse authority is unchanged: the batch identity in the accepted response is
    // still exactly the request's, and the one item still carries only the governed fields.
    assert.deepEqual(completion.payload.result.response.batch_identity, request.batch_identity);
    assert.deepEqual(completion.payload.result.response.items, [{ text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: ['segment-10'] }]);

    assert.equal(endpoint.calls.length, 1);
    const sentBody = endpoint.calls[0].envelope;
    assert.deepEqual(sentBody.response_format, {
      type: 'json_schema',
      json_schema: { name: 'scribe_batch_response', strict: true, schema: SCRIBE_BATCH_RESPONSE_JSON_SCHEMA }
    });
    // The schema is the shared, already-governed shape - not a second contract invented for the
    // provider - and it reflects the exact governed constants the runtime validator also uses.
    assert.equal(sentBody.response_format.json_schema.schema.properties.protocol_version.const, SCRIBE_BATCH_PROTOCOL_VERSION);
    assert.deepEqual(sentBody.response_format.json_schema.schema.properties.items.items.properties.kind.enum, SCRIBE_ITEM_KINDS);
    assert.equal(sentBody.response_format.json_schema.schema.properties.items.maxItems, EXTRACTION_BATCH_OUTPUT_LIMITS.max_items);
    // The rest of the OpenAI-compatible body is exactly what a Scribe batch request already sent.
    assert.equal(sentBody.model, MODEL);
    assert.equal(sentBody.stream, false);
    assert.equal(sentBody.temperature, 0);
    assert.equal(sentBody.max_tokens, request.limits.max_output_tokens);
    assert.equal(sentBody.messages.length, 2);
  } finally {
    await endpoint.close();
  }
});

test('legacy extraction and classification OpenAI-compatible requests keep their existing body with no response_format', async () => {
  const window = contextWindow();
  const extractionWorkId = 'logged-item-extraction:structured-response-session:window-1';
  const extractionRequest = buildExtractionRequest(window, { workId: extractionWorkId, modelName: MODEL });

  const item = { item_id: 'item-1', session_id: session, revision: 0, text: 'Schedule the review.', source: window.source, generator: { input_window_id: window.window_id } };
  const classificationWorkId = 'classification-enrichment:structured-response-session:item-1:r0';
  const classificationRequest = buildClassificationRequest(item, window, { workId: classificationWorkId, modelName: MODEL });

  const endpoint = await startScribeBatchModelEndpoint({
    reply: (modelRequest) => ({
      response: modelRequest.purpose === 'classification-enrichment'
        ? { protocol_version: '1.0.0', purpose: 'classification-enrichment', suggested_classification: 'task', confidence: 0.8 }
        : { protocol_version: '1.0.0', purpose: 'logged-item-extraction', text: 'Neutral extracted text.' }
    })
  });
  try {
    const result = await runService(laneManifest, [
      providerConfiguration(endpoint.url),
      legacyWorkRequestEnvelope(extractionRequest, 'logged-item-extraction'),
      legacyWorkRequestEnvelope(classificationRequest, 'classification-enrichment')
    ], 4, 8000);
    const completions = result.outputs.filter((message) => message.message_type === 'ai.work-completed');
    assert.equal(completions.length, 2);
    assert.ok(completions.every((message) => message.payload.result.status === 'succeeded'));

    assert.equal(endpoint.calls.length, 2);
    for (const call of endpoint.calls) {
      assert.equal(Object.hasOwn(call.envelope, 'response_format'), false);
      assert.deepEqual(Object.keys(call.envelope).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
    }
  } finally {
    await endpoint.close();
  }
});

test('a provider-neutral-json OpenAI-incompatible request is unaffected: its body never carries response_format', async () => {
  const endpoint = await startDeterministicLocalModelEndpoint({});
  await withLegacyEnv(endpoint.endpoint, 'provider-neutral-json', async () => {
    const window = contextWindow();
    const workId = 'logged-item-extraction:structured-response-session:provider-neutral-json';
    const request = buildExtractionRequest(window, { workId, modelName: MODEL });
    const result = await runService(laneManifest, [legacyWorkRequestEnvelope(request, 'logged-item-extraction')], 2, 3000);
    const completion = result.outputs.find((message) => message.message_type === 'ai.work-completed');
    assert.equal(completion.payload.result.status, 'succeeded');
    assert.equal(endpoint.requests.length, 1);
    assert.equal(Object.hasOwn(endpoint.requests[0].body, 'response_format'), false);
  });
  await endpoint.close();
});

test('an Ollama request is unaffected: its body has no messages/response_format shape at all', async () => {
  const endpoint = await startOllamaShapedEndpoint();
  await withLegacyEnv(endpoint.endpoint, 'ollama', async () => {
    const window = contextWindow();
    const workId = 'logged-item-extraction:structured-response-session:ollama';
    const request = buildExtractionRequest(window, { workId, modelName: MODEL });
    const result = await runService(laneManifest, [legacyWorkRequestEnvelope(request, 'logged-item-extraction')], 2, 3000);
    const completion = result.outputs.find((message) => message.message_type === 'ai.work-completed');
    assert.equal(completion.payload.result.status, 'succeeded');
    assert.equal(endpoint.requests.length, 1);
    assert.deepEqual(Object.keys(endpoint.requests[0].body).sort(), ['format', 'model', 'prompt', 'stream']);
    assert.equal(Object.hasOwn(endpoint.requests[0].body, 'response_format'), false);
  });
  await endpoint.close();
});

async function withLegacyEnv(endpointUrl, protocol, run) {
  const previousEndpoint = process.env.ARGUS_MODEL_ENDPOINT;
  const previousModel = process.env.ARGUS_MODEL_NAME;
  const previousProtocol = process.env.ARGUS_MODEL_PROTOCOL;
  const previousTimeout = process.env.ARGUS_MODEL_TIMEOUT_MS;
  process.env.ARGUS_MODEL_ENDPOINT = endpointUrl;
  process.env.ARGUS_MODEL_NAME = MODEL;
  process.env.ARGUS_MODEL_PROTOCOL = protocol;
  process.env.ARGUS_MODEL_TIMEOUT_MS = '500';
  try { await run(); }
  finally {
    if (previousEndpoint === undefined) delete process.env.ARGUS_MODEL_ENDPOINT; else process.env.ARGUS_MODEL_ENDPOINT = previousEndpoint;
    if (previousModel === undefined) delete process.env.ARGUS_MODEL_NAME; else process.env.ARGUS_MODEL_NAME = previousModel;
    if (previousProtocol === undefined) delete process.env.ARGUS_MODEL_PROTOCOL; else process.env.ARGUS_MODEL_PROTOCOL = previousProtocol;
    if (previousTimeout === undefined) delete process.env.ARGUS_MODEL_TIMEOUT_MS; else process.env.ARGUS_MODEL_TIMEOUT_MS = previousTimeout;
  }
}

/** A minimal real-shaped Ollama `/api/generate` endpoint: `{ response: "<json-string>" }`. */
async function startOllamaShapedEndpoint() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ response: JSON.stringify({ protocol_version: '1.0.0', purpose: 'logged-item-extraction', text: 'Neutral extracted text.' }) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { endpoint: `http://127.0.0.1:${port}/api/generate`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
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

function newEvidence() {
  return [
    { segment_id: 'segment-10', revision: 0, sequence: 10, start_time: '00:00:10.000', end_time: '00:00:11.000', text: 'We agreed to ship the draft Friday.' }
  ];
}

function batchIdentity(requestId) {
  return {
    request_id: requestId, session_id: session,
    segments: newEvidence().map((segment) => ({ segment_id: segment.segment_id, revision: 0, sequence: segment.sequence })),
    first_sequence: 10, last_sequence: 10, admission_reason: 'batch-complete',
    policy_id: 'scribe-default', policy_version: '1.0.0', instruction_version: '1.0.0'
  };
}

function dispatchInput({ requestId = 'batch-1' } = {}) {
  return {
    batch: {
      batch_identity: batchIdentity(requestId), batch_attempt: 1, new_evidence_segments: newEvidence(),
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

function providerConfiguration(endpointUrl) {
  return createEnvelope({
    plane: 'control', messageType: 'ai.provider-configure', producer: 'test', correlationId: session,
    schemaVersion: '1.0.0', idempotencyKey: `provider-configure:${endpointUrl}`, payload: {
      configuration: { version: 1, mode: 'local', provider: 'lm-studio', endpoint: endpointUrl, model: MODEL, protocol: 'openai-compatible', timeout_ms: 2000 },
      credential: { provided: false }
    }
  });
}

function workRequestEnvelope(request) {
  return createEnvelope({
    plane: 'control', messageType: 'ai.work-request', producer: 'test', correlationId: session,
    schemaVersion: '1.5.0', idempotencyKey: `scribe-work:${request.batch_identity.request_id}`, payload: {
      work_id: request.identity.work_id, workload: 'logged-item-extraction', session_id: session,
      sequence: request.batch_identity.last_sequence, queued_at: '2026-09-15T17:19:40.000Z',
      input: { model_request: request }, recovery: { max_attempts: 1 }
    }
  });
}

function legacyWorkRequestEnvelope(request, workload) {
  return createEnvelope({
    plane: 'control', messageType: 'ai.work-request', producer: 'test', correlationId: session,
    schemaVersion: '1.4.0', idempotencyKey: `legacy-work:${request.identity.work_id}`, payload: {
      work_id: request.identity.work_id, workload, session_id: session, sequence: 1,
      queued_at: '2026-09-15T17:19:40.000Z', input: { model_request: request }, recovery: { max_attempts: 1 }
    }
  });
}
