import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { EXTRACTION_BATCH_OUTPUT_LIMITS, estimateModelTokens } from '../contracts/model-protocol.mjs';
import { SCRIBE_BATCH_INSTRUCTION_VERSIONS, scribeBatchInstruction } from '../contracts/scribe-instruction.mjs';
import {
  buildScribeBatchRequest,
  createScribeBatchRetention,
  draftOutput,
  evaluateScribeBatchResponse,
  failedScribeBatchEvaluation,
  fingerprintScribeBatchRequest,
  scribeBatchCompletionOutputs,
  serializedRequestTokens,
  stableScribeDraftItemId
} from '../services/log-extractor-local-http/scribe-batch-boundary.mjs';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { createEnvelope } from '../runtime/orchestrator.mjs';
import { deterministicMessageId } from '../runtime/message-identity.mjs';
import { runService, runServiceBatches } from './helpers/process-harness.mjs';
import { startScribeBatchModelEndpoint } from './helpers/scribe-batch-model-endpoint.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const laneManifest = path.join(root, 'services', 'serial-ai-model-lane', 'service.json');
const extractorManifest = path.join(root, 'services', 'log-extractor-local-http', 'service.json');
const registry = await loadContractRegistry(path.join(root, 'contracts', 'catalog.json'));
const session = 'scribe-extraction-session';
const MODEL = 'scribe-test-model';

test('the versioned Scribe instruction carries the accepted role, forbids routine summaries, and separates background from new evidence', () => {
  const instruction = scribeBatchInstruction('1.0.0');
  assert.equal(instruction.version, '1.0.0');
  // 1.1.0 (SCRIBE-05B) adds the user-guidance precedence wording. 1.0.0 stays byte-identical and
  // free of any guidance wording, so a batch admitted under it still prompts with the exact text
  // it was evaluated against.
  assert.deepEqual(SCRIBE_BATCH_INSTRUCTION_VERSIONS, ['1.0.0', '1.1.0']);
  assert.equal(instruction.text.includes('additional_guidance'), false);

  // Role and responsibility, verbatim from Architecture/OperationalAgentRoles.md.
  assert.match(instruction.text, /determine what happened that is worth retaining/i);
  assert.match(instruction.text, /discrete, meaningful, non-duplicate/i);
  // No routine per-batch summary, and an empty evaluation is a normal outcome.
  assert.match(instruction.text, /do not execute actions, modify external systems, rewrite the transcript, or produce a routine summary/i);
  assert.match(instruction.text, /return an empty items array/i);
  assert.match(instruction.text, /never emit a recap, summary, or narration of the batch as an item/i);
  // New evidence versus background, marked distinctly.
  assert.match(instruction.text, /new_evidence_segments is the new authoritative evidence\. Only these segments may create a Logged Item/i);
  assert.match(instruction.text, /background only\. Never create a Logged Item from background material/i);
  assert.match(instruction.text, /suppress information that is already recorded/i);
  // Stateless construction.
  assert.match(instruction.text, /Do not rely on any earlier request, prior turn, or retained server-side memory/i);
  // Strict JSON only, zero-to-many, governed kinds, no model-assigned identity.
  assert.match(instruction.text, /exactly one JSON object and nothing else/i);
  assert.match(instruction.text, /No prose, no preface, no explanation, no markdown, no code fences/i);
  assert.match(instruction.text, new RegExp(`between 0 and ${EXTRACTION_BATCH_OUTPUT_LIMITS.max_items} objects`, 'i'));
  assert.match(instruction.text, /action, decision, open-question, reminder, other/);
  assert.match(instruction.text, /Never include item_id, revision, timestamps/i);
  assert.match(instruction.text, /Argus assigns all identity and provenance/i);
  assert.equal(instruction.tokens, estimateModelTokens(instruction.text));

  assert.throws(() => scribeBatchInstruction('9.9.9'), /scribe instruction version 9\.9\.9 is not governed/);
});

test('a bounded Scribe batch request reserves instruction, schema, evidence, background, and output inside the governed 8,000-token budget', () => {
  const { request, budget } = buildScribeBatchRequest(dispatchInput());
  const instruction = scribeBatchInstruction('1.0.0');

  assert.equal(budget.total_context_tokens, 8000);
  assert.equal(budget.instruction_tokens, instruction.tokens);
  assert.equal(budget.output_reserve_tokens, EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens);
  assert.equal(budget.request_allowance_tokens, 8000 - instruction.tokens - EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens);
  assert.equal(budget.new_evidence_text_tokens, estimateModelTokens(newEvidence()));
  assert.deepEqual(budget.removed_background_transcript_segment_ids, []);
  assert.equal(budget.removed_prior_logged_items, 0);

  // The governed total is measured against the complete serialized transmission, not text alone.
  assert.equal(budget.serialized_request_tokens, serializedRequestTokens(request));
  assert.equal(budget.total_tokens, instruction.tokens + budget.serialized_request_tokens + budget.output_reserve_tokens);
  assert.ok(budget.total_tokens <= budget.total_context_tokens);
  assert.ok(
    budget.serialized_request_tokens > budget.new_evidence_text_tokens + budget.background_text_tokens,
    'serialized accounting must exceed text-only accounting'
  );

  assert.equal(request.protocol_version, '2.0.0');
  assert.equal(request.instruction_version, '1.0.0');
  assert.equal(request.limits.max_context_tokens, budget.request_allowance_tokens);
  assert.equal(request.limits.max_context_chars, budget.request_allowance_tokens * 4);
  assert.equal(request.limits.max_output_tokens, EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens);
  // New evidence and background stay in separate, non-overlapping fields.
  assert.deepEqual(request.new_evidence_segments, newEvidence());
  assert.deepEqual(request.background_context.transcript_segments.map((segment) => segment.segment_id), ['segment-7', 'segment-8', 'segment-9']);
  assert.deepEqual(request.background_context.prior_logged_items.map((item) => item.text), ['Draft is due for review.', 'Reviewer list was circulated.']);
  const evidenceIds = new Set(request.new_evidence_segments.map((segment) => segment.segment_id));
  assert.equal(request.background_context.transcript_segments.some((segment) => evidenceIds.has(segment.segment_id)), false);
  assert.equal(request.identity.batch_request_id, request.batch_identity.request_id);
});

test('background rolls oldest complete units first and prior Logged Items outlive distant transcript turns', () => {
  // The budget that compels exactly one removal is searched for, not hard-coded - see
  // budgetForcingRemovals for why a constant threshold cannot be correct here.
  const oneRemoval = budgetForcingRemovals(dispatchInput(), 1);
  const partial = buildScribeBatchRequest(dispatchInput({ totalContextTokens: oneRemoval }));
  assert.equal(removalCount(partial.budget), 1);
  assert.deepEqual(partial.budget.removed_background_transcript_segment_ids, ['segment-7']);
  assert.equal(partial.budget.removed_prior_logged_items, 0);
  // Surviving background keeps the order it was supplied in; only whole turns leave.
  assert.deepEqual(partial.request.background_context.transcript_segments.map((segment) => segment.segment_id), ['segment-8', 'segment-9']);
  assert.deepEqual(partial.request.new_evidence_segments, newEvidence());
  assert.ok(partial.budget.total_tokens <= oneRemoval);

  // Squeeze past the transcript pool; prior Logged Items are the last background to go because
  // they are what makes duplicate suppression possible.
  const fourRemovals = budgetForcingRemovals(dispatchInput(), 4);
  const squeezed = buildScribeBatchRequest(dispatchInput({ totalContextTokens: fourRemovals }));
  assert.deepEqual(squeezed.request.background_context.transcript_segments, []);
  assert.deepEqual(squeezed.budget.removed_background_transcript_segment_ids, ['segment-7', 'segment-8', 'segment-9']);
  assert.equal(squeezed.budget.removed_prior_logged_items, 1);
  assert.deepEqual(squeezed.request.background_context.prior_logged_items.map((item) => item.text), ['Reviewer list was circulated.']);
  assert.deepEqual(squeezed.request.new_evidence_segments, newEvidence());
  assert.ok(squeezed.budget.total_tokens <= fourRemovals);
});

test('a batch whose structural overhead breaks the budget rolls background instead of transmitting over the limit', () => {
  // Regression for the accepted-over-budget defect: a background pool with short text but heavy
  // JSON structure (ids, revisions, sequences, times, relations) whose text-only estimate sits far
  // under 8,000 tokens while the request actually transmitted exceeds it.
  const input = dispatchInput({ background: { transcript_segments: structuralBackground(170), prior_logged_items: backgroundContext().prior_logged_items } });
  const instruction = scribeBatchInstruction('1.0.0');

  const unrolled = buildScribeBatchRequest({ ...input, policy: scribePolicy(20000) });
  const textOnlyTotal = instruction.tokens
    + estimateModelTokens([...input.batch.new_evidence_segments, ...input.batch.background_context.transcript_segments, ...input.batch.background_context.prior_logged_items])
    + EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens;

  // The old text-only accounting would have accepted this batch outright...
  assert.ok(textOnlyTotal < 8000, `text-only accounting reported ${textOnlyTotal} tokens, which must sit under the budget for this regression to be meaningful`);
  // ...while the request it actually transmits overruns the governed budget.
  assert.ok(unrolled.budget.total_tokens > 8000, `serialized transmission measured ${unrolled.budget.total_tokens} tokens, which must exceed the budget for this regression to be meaningful`);
  assert.equal(unrolled.budget.removed_background_transcript_segment_ids.length, 0);

  // Under the governed 8,000-token policy the same batch now rolls background until the real
  // transmission fits, and never touches new evidence.
  const bounded = buildScribeBatchRequest(input);
  assert.ok(bounded.budget.total_tokens <= 8000);
  assert.equal(bounded.budget.total_tokens, instruction.tokens + serializedRequestTokens(bounded.request) + EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens);
  assert.ok(bounded.budget.removed_background_transcript_segment_ids.length > 0);
  // Oldest structural turns leave first, in ascending sequence order.
  assert.deepEqual(bounded.budget.removed_background_transcript_segment_ids, bounded.budget.removed_background_transcript_segment_ids.map((_unused, index) => `background-segment-${index}`));
  assert.deepEqual(bounded.request.new_evidence_segments, newEvidence());
  assert.deepEqual(bounded.request.background_context.prior_logged_items.map((item) => item.text), ['Draft is due for review.', 'Reviewer list was circulated.']);
});

test('mandatory instruction, schema, new evidence, and output reserve that cannot fit fail explicitly instead of truncating evidence', () => {
  const instruction = scribeBatchInstruction('1.0.0');
  // One token of room for the whole serialized request: the instruction and the output reserve fit,
  // so this exercises the mandatory-floor rejection rather than the reserve rejection.
  const noRoomForEvidence = instruction.tokens + EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens + 1;

  assert.throws(
    () => buildScribeBatchRequest(dispatchInput({ totalContextTokens: noRoomForEvidence })),
    (error) => {
      assert.equal(error.cause.code, 'SCRIBE_BATCH_BUDGET_EXCEEDED');
      assert.match(error.message, /new evidence and guidance are never truncated/);
      return true;
    }
  );
  assert.throws(
    () => buildScribeBatchRequest(dispatchInput({ totalContextTokens: 256 })),
    (error) => {
      assert.equal(error.cause.code, 'SCRIBE_BATCH_BUDGET_EXCEEDED');
      assert.match(error.message, /output reserve/);
      return true;
    }
  );
  assert.throws(() => buildScribeBatchRequest(dispatchInput({ policy: { policy_id: 'scribe-default', policy_version: '1.0.0', session_id: session, generation: { policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0' }, context: {} } })), /max_total_context_tokens must be a positive integer/);
});

test('a batch identity that disagrees with the accepted policy is refused before any provider call', () => {
  assert.throws(
    () => buildScribeBatchRequest(dispatchInput({ batchIdentityOverrides: { policy_version: '2.0.0' } })),
    /batch identity policy_version does not match the accepted policy policy_version/
  );
  assert.throws(
    () => buildScribeBatchRequest(dispatchInput({ batchIdentityOverrides: { instruction_version: '1.0.1' } })),
    /batch identity instruction_version does not match the accepted policy generation\.instruction_version/
  );
  // Agreeing on an ungoverned instruction version still fails closed rather than falling back to
  // whichever wording happens to be shipped.
  assert.throws(
    () => buildScribeBatchRequest(dispatchInput({
      batchIdentityOverrides: { instruction_version: '1.0.1' },
      policy: { ...scribePolicy(), generation: { policy_profile: 'neutral-contextual-log', instruction_version: '1.0.1' } }
    })),
    /instruction_version does not match the accepted policy and batch identity/
  );
});

test('LM Studio zero, one, and multiple item results each produce the matching drafts and evaluated-batch outcome in FIFO order', async () => {
  const zero = dispatchInput({ requestId: 'batch-zero' });
  const one = dispatchInput({ requestId: 'batch-one' });
  const many = dispatchInput({ requestId: 'batch-many' });
  const answers = {
    'batch-zero': { items: [] },
    'batch-one': { items: [{ text: 'Confirm the reviewer.', kind: 'open-question', source_segment_ids: ['segment-11'] }] },
    'batch-many': { items: [
      { text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: ['segment-10'] },
      { text: 'Confirm the reviewer.', kind: 'open-question', source_segment_ids: ['segment-11'] },
      { text: 'Remind the team about the Friday deadline.', kind: 'reminder', source_segment_ids: ['segment-11', 'segment-12'] }
    ] }
  };
  const endpoint = await startScribeBatchModelEndpoint({ reply: (request) => answers[request.batch_identity.request_id] });
  try {
    const requests = [zero, one, many].map((input) => buildScribeBatchRequest(input).request);
    const result = await runService(laneManifest, [
      providerConfiguration(endpoint.url),
      ...requests.map((request) => workRequestEnvelope(request))
    ], 7, 8000);
    const completions = result.outputs.filter((message) => message.message_type === 'ai.work-completed');
    assert.equal(completions.length, 3);
    // Serial lane keeps submitted order at concurrency one, on both the provider and the result side.
    assert.deepEqual(endpoint.calls.map((call) => call.modelRequest.batch_identity.request_id), ['batch-zero', 'batch-one', 'batch-many']);
    assert.deepEqual(completions.map((message) => message.payload.result.response.batch_identity.request_id), ['batch-zero', 'batch-one', 'batch-many']);

    for (const [index, completion] of completions.entries()) {
      assert.equal(completion.payload.result.status, 'succeeded');
      assert.equal(completion.schema_version, '1.5.0');
      assert.deepEqual(registry.validateEnvelope(completion), []);
      assert.equal(completion.payload.result.request_fingerprint, fingerprintScribeBatchRequest(requests[index]));
      // Every call is constructed statelessly: the whole governed request and the whole Scribe
      // instruction travel on each call rather than relying on provider-retained history.
      assert.equal(endpoint.calls[index].systemPrompt, scribeBatchInstruction('1.0.0').text);
      assert.deepEqual(endpoint.calls[index].modelRequest, requests[index]);
    }

    const settled = completions.map((completion, index) => scribeBatchCompletionOutputs({
      request: requests[index], response: completion.payload.result.response,
      batchAttempt: 1, evaluatedAt: completion.payload.completed_at
    }));

    // Zero: a valid empty evaluation emits no draft at all and still settles as a complete outcome.
    assert.deepEqual(settled[0].outputs, []);
    assert.equal(settled[0].evaluated.outcome, 'empty-evaluated');
    assert.deepEqual(settled[0].evaluated.items, []);
    assert.deepEqual(registry.validateArtifact('scribe_batch_evaluated', settled[0].evaluated), []);
    assert.equal(settled[0].evaluated.acknowledgement.accepted, false);
    assert.deepEqual(settled[0].evaluated.acknowledgement.logged_item_ids, []);

    // One item.
    assert.equal(settled[1].outputs.length, 1);
    assert.equal(settled[1].evaluated.outcome, 'items-recorded');
    assert.deepEqual(registry.validateArtifact('scribe_batch_evaluated', settled[1].evaluated), []);
    assert.equal(settled[1].outputs[0].message_type, undefined);
    assert.equal(settled[1].outputs[0].messageType, 'logged-item.draft');
    assert.deepEqual(settled[1].outputs[0].payload.source, { first_segment_id: 'segment-11', last_segment_id: 'segment-11', start_time: '00:00:11.000', end_time: '00:00:12.000' });

    // Multiple discrete items: one governed draft each, distinct identity, exact provenance.
    assert.equal(settled[2].outputs.length, 3);
    assert.equal(settled[2].evaluated.outcome, 'items-recorded');
    assert.deepEqual(registry.validateArtifact('scribe_batch_evaluated', settled[2].evaluated), []);
    const drafts = settled[2].outputs.map((message) => message.payload);
    assert.equal(new Set(drafts.map((draft) => draft.item_id)).size, 3);
    assert.deepEqual(drafts.map((draft) => draft.text), ['Ship the draft Friday.', 'Confirm the reviewer.', 'Remind the team about the Friday deadline.']);
    for (const draft of drafts) {
      assert.deepEqual(registry.validateEnvelope(createEnvelope({
        plane: 'domain', messageType: 'logged-item.draft', producer: 'fixture-extractor', correlationId: session,
        idempotencyKey: `draft:${draft.item_id}`, schemaVersion: '1.3.0', payload: draft
      })), []);
      assert.equal(draft.revision, 0);
      assert.equal(draft.revision_id, `${draft.item_id}:r0`);
      assert.equal(draft.session_id, session);
      assert.deepEqual(draft.generator, { implementation: 'log-extractor-local-http', input_window_id: 'batch-many' });
      // The model classifies, but the draft contract owns the item shape: no kind rides along.
      assert.equal(Object.hasOwn(draft, 'kind'), false);
    }
    // Provenance spans the cited evidence in batch order, timed from the evidence, not the model.
    assert.deepEqual(drafts[2].source, { first_segment_id: 'segment-11', last_segment_id: 'segment-12', start_time: '00:00:11.000', end_time: '00:00:13.000' });
    assert.equal(drafts[2].created_at, '00:00:13.000');
  } finally {
    await endpoint.close();
  }
});

test('duplicate-suppression context and the background/new-evidence split reach the provider verbatim', async () => {
  const endpoint = await startScribeBatchModelEndpoint({ reply: () => ({ items: [] }) });
  try {
    const { request } = buildScribeBatchRequest(dispatchInput({ requestId: 'batch-suppress' }));
    await runService(laneManifest, [providerConfiguration(endpoint.url), workRequestEnvelope(request)], 3, 8000);
    const sent = endpoint.calls[0].modelRequest;
    assert.deepEqual(sent.background_context.prior_logged_items, [
      { text: 'Draft is due for review.', kind: 'action', source_segment_ids: ['segment-3'] },
      { text: 'Reviewer list was circulated.', kind: 'other', source_segment_ids: ['segment-5'] }
    ]);
    assert.deepEqual(sent.background_context.transcript_segments.map((segment) => segment.relation), ['lookback', 'lookback', 'lookback']);
    assert.deepEqual(sent.new_evidence_segments.map((segment) => segment.segment_id), ['segment-10', 'segment-11', 'segment-12']);
    // Background transcript turns carry a relation; new evidence never does, so the two are
    // structurally distinguishable to the model rather than distinguished only by prose.
    assert.equal(sent.new_evidence_segments.some((segment) => Object.hasOwn(segment, 'relation')), false);
  } finally {
    await endpoint.close();
  }
});

test('a stale or provider-altered batch identity cannot produce a draft', () => {
  const { request } = buildScribeBatchRequest(dispatchInput());
  const items = [{ text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: ['segment-10'] }];
  const stale = { ...batchResponse(request, items), batch_identity: { ...request.batch_identity, request_id: 'batch-superseded' } };
  assert.throws(
    () => evaluateScribeBatchResponse({ request, response: stale, batchAttempt: 1, evaluatedAt: '2026-09-07T17:00:01.000Z' }),
    (error) => {
      assert.equal(error.cause.code, 'SCRIBE_BATCH_IDENTITY_CONFLICT');
      return true;
    }
  );
  const reordered = { ...batchResponse(request, items), batch_identity: { ...request.batch_identity, admission_reason: 'idle-timeout' } };
  assert.throws(() => evaluateScribeBatchResponse({ request, response: reordered, batchAttempt: 1, evaluatedAt: '2026-09-07T17:00:01.000Z' }), /does not match the dispatched batch identity/);
});

test('commentary, malformed JSON, excess items, oversized text, forged identity, unsupported kind, and forged provenance are all visible failures with no draft', async () => {
  const cases = [
    ['prose commentary', { raw: 'Here is the batch summary you asked for.' }, 'MODEL_INVALID_JSON'],
    ['malformed JSON', { raw: '{"choices":[{"message":{"content":"{\\"items\\":"' }, 'MODEL_INVALID_JSON'],
    ['markdown-fenced JSON', { content: '```json\n{"protocol_version":"2.0.0","purpose":"logged-item-extraction","items":[]}\n```' }, 'MODEL_INVALID_JSON'],
    ['JSON wrapped in commentary', { content: 'Sure - here is the batch: {"protocol_version":"2.0.0","purpose":"logged-item-extraction","items":[]}' }, 'MODEL_INVALID_JSON'],
    ['forged item identity', { items: [{ item_id: 'forged-by-model', text: 'Ship it.', source_segment_ids: ['segment-10'] }] }, 'INVALID_MODEL_OUTPUT'],
    ['unsupported kind', { items: [{ text: 'Ship it.', kind: 'summary', source_segment_ids: ['segment-10'] }] }, 'INVALID_MODEL_OUTPUT'],
    ['forged provenance', { items: [{ text: 'Ship it.', source_segment_ids: ['segment-99'] }] }, 'INVALID_MODEL_OUTPUT'],
    ['excess items', { items: Array.from({ length: EXTRACTION_BATCH_OUTPUT_LIMITS.max_items + 1 }, () => ({ text: 'Ship it.', source_segment_ids: ['segment-10'] })) }, 'INVALID_MODEL_OUTPUT'],
    ['oversized item text', { items: [{ text: 'x'.repeat(EXTRACTION_BATCH_OUTPUT_LIMITS.max_item_chars + 1), source_segment_ids: ['segment-10'] }] }, 'INVALID_MODEL_OUTPUT'],
    ['oversized batch output', { items: Array.from({ length: 5 }, (_unused, index) => ({ text: `${index}${'y'.repeat(EXTRACTION_BATCH_OUTPUT_LIMITS.max_item_chars - 1)}`, source_segment_ids: ['segment-10'] })) }, 'INVALID_MODEL_OUTPUT'],
    ['malformed batch identity', { response: { protocol_version: '2.0.0', purpose: 'logged-item-extraction', batch_identity: { ...batchIdentity('batch-1'), admission_reason: 'model-decided' }, items: [] } }, 'INVALID_MODEL_OUTPUT'],
    ['wrong protocol version', { response: { protocol_version: '1.0.0', purpose: 'logged-item-extraction', text: 'A summary of the batch.' } }, 'INVALID_MODEL_OUTPUT']
  ];

  for (const [label, answer, expectedCode] of cases) {
    const endpoint = await startScribeBatchModelEndpoint({ reply: () => answer });
    try {
      const { request } = buildScribeBatchRequest(dispatchInput({ requestId: 'batch-1' }));
      const result = await runService(laneManifest, [providerConfiguration(endpoint.url), workRequestEnvelope(request, { maxAttempts: 1 })], 3, 8000);
      const completion = result.outputs.find((message) => message.message_type === 'ai.work-completed');
      assert.equal(completion.payload.result.status, 'failed', label);
      assert.equal(completion.payload.result.error.code, expectedCode, label);
      assert.equal(Object.hasOwn(completion.payload.result, 'response'), false, label);
    } finally {
      await endpoint.close();
    }
  }
});

test('a response describing a different batch passes isolated validation but cannot become a draft', async () => {
  // The lane validates one message in isolation, so a well-formed identity for a *different*
  // batch is not something it can detect. Correlating a result against the batch that was
  // actually dispatched is the extraction path's retained-context responsibility, and it must
  // refuse the result before any draft exists.
  const supersededIdentity = { ...batchIdentity('batch-superseded'), segments: [{ segment_id: 'segment-10', revision: 0, sequence: 10 }], first_sequence: 10, last_sequence: 10 };
  const endpoint = await startScribeBatchModelEndpoint({
    reply: () => ({ response: { protocol_version: '2.0.0', purpose: 'logged-item-extraction', batch_identity: supersededIdentity, items: [{ text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: ['segment-10'] }] } })
  });
  try {
    const { request } = buildScribeBatchRequest(dispatchInput({ requestId: 'batch-outstanding' }));
    const result = await runService(laneManifest, [providerConfiguration(endpoint.url), workRequestEnvelope(request, { maxAttempts: 1 })], 3, 8000);
    const completion = result.outputs.find((message) => message.message_type === 'ai.work-completed');
    assert.equal(completion.payload.result.status, 'succeeded');
    assert.throws(
      () => evaluateScribeBatchResponse({ request, response: completion.payload.result.response, batchAttempt: 1, evaluatedAt: completion.payload.completed_at }),
      (error) => {
        assert.equal(error.cause.code, 'SCRIBE_BATCH_IDENTITY_CONFLICT');
        return true;
      }
    );
  } finally {
    await endpoint.close();
  }
});

test('a model endpoint timeout is a visible retryable failure and settles as a failed evaluated outcome', async () => {
  const endpoint = await startScribeBatchModelEndpoint({ reply: () => ({ delayMs: 400, items: [] }) });
  try {
    const { request } = buildScribeBatchRequest(dispatchInput({ requestId: 'batch-timeout' }));
    const result = await runService(laneManifest, [
      providerConfiguration(endpoint.url, { timeoutMs: 60 }),
      workRequestEnvelope(request, { maxAttempts: 1 })
    ], 3, 8000);
    const completion = result.outputs.find((message) => message.message_type === 'ai.work-completed');
    assert.equal(completion.payload.result.status, 'failed');
    assert.equal(completion.payload.result.error.code, 'MODEL_ENDPOINT_TIMEOUT');
    assert.equal(completion.payload.result.error.category, 'timeout');
    assert.equal(completion.payload.result.error.retryable, true);

    const evaluated = failedScribeBatchEvaluation({
      batchIdentity: request.batch_identity, batchAttempt: 1,
      evaluatedAt: completion.payload.completed_at, error: completion.payload.result.error
    });
    assert.equal(evaluated.outcome, 'failed');
    assert.deepEqual(evaluated.items, []);
    assert.equal(evaluated.error.category, 'timeout');
    assert.equal(evaluated.error.retryable, true);
    assert.equal(evaluated.acknowledgement.accepted, false);
    assert.equal(evaluated.acknowledgement.acknowledged_at, null);
    assert.deepEqual(registry.validateArtifact('scribe_batch_evaluated', evaluated), []);
  } finally {
    await endpoint.close();
  }
});

test('a provider retry reuses the byte-identical work ID, request, prompt, and fingerprint', async () => {
  const endpoint = await startScribeBatchModelEndpoint({
    reply: (_request, number) => number === 1 ? { status: 503, raw: 'temporary model failure' } : { items: [{ text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: ['segment-10'] }] }
  });
  try {
    const { request } = buildScribeBatchRequest(dispatchInput({ requestId: 'batch-retry' }));
    const result = await runService(laneManifest, [providerConfiguration(endpoint.url), workRequestEnvelope(request, { maxAttempts: 2 })], 3, 8000);
    const completion = result.outputs.find((message) => message.message_type === 'ai.work-completed');
    assert.equal(completion.payload.result.status, 'succeeded');
    assert.equal(completion.payload.attempt, 2);
    assert.equal(endpoint.calls.length, 2);
    assert.equal(endpoint.calls[0].modelRequest.identity.work_id, endpoint.calls[1].modelRequest.identity.work_id);
    assert.deepEqual(endpoint.calls[0].modelRequest, endpoint.calls[1].modelRequest);
    assert.equal(endpoint.calls[0].systemPrompt, endpoint.calls[1].systemPrompt);
    assert.equal(endpoint.calls[0].envelope.messages[1].content, endpoint.calls[1].envelope.messages[1].content);
    assert.equal(completion.payload.result.request_fingerprint, fingerprintScribeBatchRequest(request));
    // The retained context is the batch that was dispatched, so the retry evaluates the same batch.
    assert.deepEqual(completion.payload.result.response.batch_identity, request.batch_identity);
  } finally {
    await endpoint.close();
  }
});

test('draft identity is Argus-owned, deterministic from the validated batch and item position/content, and never model supplied', () => {
  const { request } = buildScribeBatchRequest(dispatchInput());
  const items = [
    { text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: ['segment-10'] },
    { text: 'Confirm the reviewer.', kind: 'open-question', source_segment_ids: ['segment-11'] }
  ];
  const first = evaluateScribeBatchResponse({ request, response: batchResponse(request, items), batchAttempt: 1, evaluatedAt: '2026-09-07T17:00:01.000Z' });
  const replayed = evaluateScribeBatchResponse({ request, response: batchResponse(request, items), batchAttempt: 1, evaluatedAt: '2026-09-07T17:05:00.000Z' });
  assert.deepEqual(replayed.drafts.map((draft) => draft.item_id), first.drafts.map((draft) => draft.item_id));

  // Position matters, so two identical texts in one batch stay distinct.
  const duplicated = [items[0], { ...items[0] }];
  const duplicates = evaluateScribeBatchResponse({ request, response: batchResponse(request, duplicated), batchAttempt: 1, evaluatedAt: '2026-09-07T17:00:01.000Z' });
  assert.notEqual(duplicates.drafts[0].item_id, duplicates.drafts[1].item_id);

  // Content matters, so an edited item is a different draft.
  const edited = evaluateScribeBatchResponse({ request, response: batchResponse(request, [{ ...items[0], text: 'Ship the draft Monday.' }, items[1]]), batchAttempt: 1, evaluatedAt: '2026-09-07T17:00:01.000Z' });
  assert.notEqual(edited.drafts[0].item_id, first.drafts[0].item_id);
  assert.equal(edited.drafts[1].item_id, first.drafts[1].item_id);

  // A different batch never reuses an identity, even for identical item content.
  const other = buildScribeBatchRequest(dispatchInput({ requestId: 'batch-other' })).request;
  assert.notEqual(stableScribeDraftItemId(other.batch_identity, 0, items[0]), stableScribeDraftItemId(request.batch_identity, 0, items[0]));
  for (const draft of first.drafts) assert.match(draft.item_id, /^logged-item-[0-9a-f]{24}$/);
});

test('retained Scribe batch dispatch bounds its capacity and produces the governed 1.5.0 work request', async () => {
  const retention = createScribeBatchRetention({ capacity: 2 });
  const dispatched = retention.dispatch({ ...dispatchInput({ requestId: 'batch-a' }), workId: workId('batch-a'), modelName: MODEL, queuedAt: '2026-09-07T17:00:00.000Z' });
  assert.equal(dispatched.requestFingerprint, fingerprintScribeBatchRequest(dispatched.request));
  assert.equal(dispatched.workRequest.schemaVersion, '1.5.0');
  assert.equal(dispatched.workRequest.payload.sequence, 12);
  assert.deepEqual(dispatched.workRequest.payload.recovery, { max_attempts: 2 });
  assert.deepEqual(registry.validateEnvelope(createEnvelope({
    plane: 'control', messageType: 'ai.work-request', producer: 'fixture-extractor', correlationId: session,
    idempotencyKey: dispatched.workRequest.identityKey, schemaVersion: dispatched.workRequest.schemaVersion, payload: dispatched.workRequest.payload
  })), []);

  retention.dispatch({ ...dispatchInput({ requestId: 'batch-b' }), workId: workId('batch-b'), modelName: MODEL, queuedAt: '2026-09-07T17:00:00.000Z' });
  assert.equal(retention.size, 2);
  assert.throws(
    () => retention.dispatch({ ...dispatchInput({ requestId: 'batch-c' }), workId: workId('batch-c'), modelName: MODEL, queuedAt: '2026-09-07T17:00:00.000Z' }),
    (error) => {
      assert.equal(error.cause.code, 'SCRIBE_BATCH_PENDING_FULL');
      return true;
    }
  );
  // The exact request stays retained for correlation until the work is released.
  assert.deepEqual(retention.get(workId('batch-a')).request, dispatched.request);
  retention.clear();
  assert.equal(retention.size, 0);
});

test('reusing a Scribe batch work identity for different content is a conflict, not a silent overwrite', () => {
  const retention = createScribeBatchRetention({ capacity: 4 });
  const reusedWorkId = workId('batch-reused');
  const first = retention.dispatch({ ...dispatchInput({ requestId: 'batch-reused' }), workId: reusedWorkId, modelName: MODEL, queuedAt: '2026-09-07T17:00:00.000Z' });

  // Same work identity, different batch content: the retained request an outstanding attempt is
  // still correlated against must not be replaced, or the next completion would be checked
  // against content that was never dispatched.
  const changedEvidence = newEvidence().map((segment, index) => index === 0 ? { ...segment, text: 'We agreed to ship the draft on Monday instead.' } : segment);
  assert.throws(
    () => retention.dispatch({
      batch: {
        batch_identity: batchIdentity('batch-reused'), batch_attempt: 1,
        new_evidence_segments: changedEvidence, background_context: backgroundContext(),
        policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0'
      },
      policy: scribePolicy(), workId: reusedWorkId, modelName: MODEL, queuedAt: '2026-09-07T17:10:00.000Z'
    }),
    (error) => {
      assert.equal(error.cause.code, 'SCRIBE_BATCH_WORK_ID_CONFLICT');
      assert.equal(error.cause.details.work_id, reusedWorkId);
      assert.equal(error.cause.details.retained_request_fingerprint, first.requestFingerprint);
      assert.notEqual(error.cause.details.offered_request_fingerprint, first.requestFingerprint);
      return true;
    }
  );
  // The original retained request survives the rejected re-dispatch untouched.
  assert.deepEqual(retention.get(reusedWorkId).request, first.request);
  assert.equal(retention.get(reusedWorkId).requestFingerprint, first.requestFingerprint);
  assert.equal(retention.size, 1);

  // A byte-identical re-dispatch stays idempotent rather than conflicting.
  const replayed = retention.dispatch({ ...dispatchInput({ requestId: 'batch-reused' }), workId: reusedWorkId, modelName: MODEL, queuedAt: '2026-09-07T17:20:00.000Z' });
  assert.equal(replayed.requestFingerprint, first.requestFingerprint);
  assert.deepEqual(replayed.request, first.request);
  assert.deepEqual(replayed.workRequest, first.workRequest);
  assert.equal(retention.size, 1);
});

test('owner confirmations match exact deterministic IDs, tolerate order, and reject unknown, duplicate, or conflicting content', () => {
  const retention = createScribeBatchRetention({ capacity: 4 });
  const dispatched = retention.dispatch({ ...dispatchInput({ requestId: 'batch-owner-acks' }), queuedAt: '2026-09-07T17:00:00.000Z' });
  const result = evaluateScribeBatchResponse({
    request: dispatched.request,
    response: batchResponse(dispatched.request, [
      { text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: ['segment-10'] },
      { text: 'Confirm the reviewer.', kind: 'open-question', source_segment_ids: ['segment-11'] }
    ]),
    batchAttempt: 1,
    evaluatedAt: '2026-09-07T17:00:01.000Z'
  });
  const drafts = result.drafts.map((payload) => draftOutput(payload));
  retention.beginOwnerAcknowledgement(dispatched.request.identity.work_id, { drafts, evaluated: result.evaluated });

  const firstStored = storedEnvelope({ payload: drafts[0].payload }).payload;
  const secondStored = storedEnvelope({ payload: drafts[1].payload }).payload;
  const unknown = { ...firstStored, item_id: 'unknown-deterministic-id', revision_id: 'unknown-deterministic-id:r0' };
  assert.throws(() => retention.confirmStoredItem(unknown, { acknowledgedAt: '2026-09-07T17:00:02.000Z' }), (error) => error.cause.code === 'SCRIBE_OWNER_CONFIRMATION_UNKNOWN');
  assert.throws(() => retention.confirmStoredItem({ ...firstStored, text: 'Conflicting owner content.' }, { acknowledgedAt: '2026-09-07T17:00:02.000Z' }), (error) => error.cause.code === 'SCRIBE_OWNER_CONFIRMATION_CONFLICT');

  assert.equal(retention.confirmStoredItem(secondStored, { acknowledgedAt: '2026-09-07T17:00:02.000Z' }).settled, false);
  assert.throws(() => retention.confirmStoredItem(secondStored, { acknowledgedAt: '2026-09-07T17:00:02.000Z' }), (error) => error.cause.code === 'SCRIBE_OWNER_CONFIRMATION_DUPLICATE');
  const final = retention.confirmStoredItem(firstStored, { acknowledgedAt: '2026-09-07T17:00:03.000Z' });
  assert.equal(final.settled, true);
  assert.deepEqual(final.evaluated.acknowledgement.logged_item_ids, drafts.map((draft) => draft.payload.item_id));

  const failedRetention = createScribeBatchRetention({ capacity: 4 });
  const failedDispatch = failedRetention.dispatch({ ...dispatchInput({ requestId: 'batch-owner-rejected' }), queuedAt: '2026-09-07T17:00:00.000Z' });
  const failedResult = evaluateScribeBatchResponse({
    request: failedDispatch.request,
    response: batchResponse(failedDispatch.request, [{ text: 'Owner may reject this.', source_segment_ids: ['segment-12'] }]),
    batchAttempt: 1,
    evaluatedAt: '2026-09-07T17:00:01.000Z'
  });
  const failedDrafts = failedResult.drafts.map((payload) => draftOutput(payload));
  failedRetention.beginOwnerAcknowledgement(failedDispatch.request.identity.work_id, { drafts: failedDrafts, evaluated: failedResult.evaluated });
  assert.deepEqual(failedRetention.failOwnerMessage('00000000-0000-4000-8000-000000000000', {}, { evaluatedAt: '2026-09-07T17:00:02.000Z' }), { matched: false });
  const rejected = failedRetention.failOwnerMessage(failedDrafts[0].messageId, { code: 'OWNER_REJECTED', category: 'conflict', message: 'Owner rejected draft.', retryable: false }, { evaluatedAt: '2026-09-07T17:00:02.000Z' });
  assert.equal(rejected.evaluated.outcome, 'failed');
  assert.deepEqual(rejected.evaluated.items, failedResult.items);
  assert.equal(rejected.evaluated.acknowledgement.accepted, false);
});

test('the extractor emits a final evaluated boundary only after exact owner confirmations', async () => {
  for (const [label, items, expectedDrafts] of [
    ['zero', [], 0],
    ['one', [{ text: 'Confirm the reviewer.', kind: 'open-question', source_segment_ids: ['segment-11'] }], 1],
    ['multiple', [
      { text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: ['segment-10'] },
      { text: 'Confirm the reviewer.', kind: 'open-question', source_segment_ids: ['segment-11'] },
      { text: 'Remind the team about the Friday deadline.', kind: 'reminder', source_segment_ids: ['segment-11', 'segment-12'] }
    ], 3]
  ]) {
    const input = dispatchInput({ requestId: `batch-service-${label}` });
    const batches = [
      { inputs: [policyEnvelope(), batchAdmittedEnvelope(input.batch)], expectedOutputCount: 3 },
      {
        inputs: (outputs) => {
          const request = outputs.find((message) => message.message_type === 'ai.work-request').payload.input.model_request;
          return [batchCompletionEnvelope(request, { response: batchResponse(request, items) })];
        },
        expectedOutputCount: expectedDrafts ? expectedDrafts + 1 : 2
      }
    ];
    if (expectedDrafts) {
      batches.push({
        inputs: (outputs) => outputs.filter((message) => message.message_type === 'logged-item.draft').reverse().map(storedEnvelope),
        expectedOutputCount: expectedDrafts + 1
      });
    }
    const result = await runServiceBatches(extractorManifest, batches, 8000, { env: { ARGUS_MODEL_NAME: MODEL } });

    const forwarded = result.outputs.find((message) => message.message_type === 'ai.work-request');
    assert.ok(forwarded, label);
    assert.equal(forwarded.schema_version, '1.5.0', label);
    assert.deepEqual(registry.validateEnvelope(forwarded), [], label);
    assert.equal(forwarded.payload.work_id, workId(`batch-service-${label}`));

    const drafts = result.outputs.filter((message) => message.message_type === 'logged-item.draft');
    assert.equal(drafts.length, expectedDrafts, label);
    for (const draft of drafts) {
      assert.deepEqual(registry.validateEnvelope(draft), [], label);
      assert.equal(draft.payload.generator.input_window_id, `batch-service-${label}`, label);
      assert.equal(draft.payload.revision, 0, label);
      const identityKey = `log-extractor-local-http:logged-item.draft:${draft.payload.item_id}:r0`;
      assert.equal(draft.message_id, deterministicMessageId(identityKey), label);
    }
    const evaluatedMessages = result.outputs.filter((message) => message.message_type === 'scribe.batch-evaluated');
    assert.equal(evaluatedMessages.length, 1, label);
    assert.deepEqual(registry.validateEnvelope(evaluatedMessages[0]), [], label);
    assert.equal(evaluatedMessages[0].payload.batch_attempt, 1);
    assert.equal(evaluatedMessages[0].payload.batch.acknowledgement.accepted, true);
    assert.deepEqual(evaluatedMessages[0].payload.batch.acknowledgement.logged_item_ids, drafts.map((draft) => draft.payload.item_id));
    if (expectedDrafts === 3) {
      assert.deepEqual(drafts.map((draft) => draft.payload.text), items.map((item) => item.text));
      assert.equal(new Set(drafts.map((draft) => draft.payload.item_id)).size, 3);
    }
  }
});

test('an exhausted provider completion emits one terminal failed evaluated message', async () => {
  const input = dispatchInput({ requestId: 'batch-service-failed' });
  const result = await runServiceBatches(extractorManifest, [
    { inputs: [policyEnvelope(), batchAdmittedEnvelope(input.batch)], expectedOutputCount: 3 },
    {
      inputs: (outputs) => {
        const request = outputs.find((message) => message.message_type === 'ai.work-request').payload.input.model_request;
        return [batchCompletionEnvelope(request, { status: 'failed', error: { code: 'MODEL_ENDPOINT_TIMEOUT', category: 'timeout', message: 'model endpoint did not respond within 2000 ms', retryable: true } })];
      },
      expectedOutputCount: 2
    }
  ], 8000, { env: { ARGUS_MODEL_NAME: MODEL } });

  assert.equal(result.outputs.some((message) => message.message_type === 'logged-item.draft'), false);
  const message = result.outputs.find((output) => output.message_type === 'scribe.batch-evaluated');
  const evaluated = message.payload.batch;
  assert.equal(evaluated.outcome, 'failed');
  assert.equal(evaluated.attempt, 1);
  assert.deepEqual(evaluated.items, []);
  assert.equal(evaluated.acknowledgement.accepted, false);
  assert.equal(evaluated.error.retryable, false);
  assert.deepEqual(registry.validateArtifact('scribe_batch_evaluated', evaluated), []);
  assert.deepEqual(registry.validateEnvelope(message), []);
});

test('a batch completion for work the extractor never dispatched is a named correlation conflict, not a single-window extraction error', async () => {
  const { request } = buildScribeBatchRequest(dispatchInput({ requestId: 'batch-unretained' }));
  const result = await runService(extractorManifest, [
    batchCompletionEnvelope(request, { response: batchResponse(request, []) })
  ], 1, 8000, { env: { ARGUS_MODEL_NAME: MODEL } });

  const failure = result.outputs.find((message) => message.message_type === 'service.failure');
  assert.equal(failure.payload.error.code, 'SCRIBE_BATCH_NOT_RETAINED');
  assert.equal(failure.payload.error.category, 'conflict');
  assert.equal(failure.payload.error.details.batch_request_id, 'batch-unretained');
  assert.equal(result.outputs.some((message) => message.message_type === 'logged-item.draft'), false);
  assert.deepEqual(registry.validateEnvelope(failure), []);
});

test('a Scribe batch dispatch without a governed policy fails closed and forwards nothing', async () => {
  const input = dispatchInput({ requestId: 'batch-no-policy' });
  const result = await runService(extractorManifest, [batchAdmittedEnvelope(input.batch)], 1, 8000, { env: { ARGUS_MODEL_NAME: MODEL } });
  const failure = result.outputs.find((message) => message.message_type === 'service.failure');
  assert.equal(failure.payload.error.code, 'SCRIBE_BATCH_POLICY_MISSING');
  assert.equal(failure.payload.error.category, 'unavailable');
  assert.equal(result.outputs.some((message) => message.message_type === 'ai.work-request'), false);
});

test('a forged nested work ID is rejected non-destructively and the exact completion still settles', async () => {
  const input = dispatchInput({ requestId: 'batch-forged-completion' });
  const result = await runServiceBatches(extractorManifest, [
    { inputs: [policyEnvelope(), batchAdmittedEnvelope(input.batch)], expectedOutputCount: 3 },
    {
      inputs: (outputs) => {
        const request = outputs.find((message) => message.message_type === 'ai.work-request').payload.input.model_request;
        return [batchCompletionEnvelope(request, { response: batchResponse(request, []), nestedWorkId: 'forged-nested-work', idempotencyKey: 'forged-nested-completion' })];
      },
      expectedOutputCount: 1
    },
    {
      inputs: (outputs) => {
        const request = outputs.find((message) => message.message_type === 'ai.work-request').payload.input.model_request;
        return [batchCompletionEnvelope(request, { response: batchResponse(request, []) })];
      },
      expectedOutputCount: 2
    }
  ], 8000, { env: { ARGUS_MODEL_NAME: MODEL } });
  const failure = result.outputs.find((message) => message.message_type === 'service.failure');
  assert.equal(failure.payload.error.code, 'SCRIBE_BATCH_RESULT_WORK_ID_CONFLICT');
  assert.ok(result.outputs.find((message) => message.message_type === 'scribe.batch-evaluated'));
});

test('accepted policy state is immutable for a session', async () => {
  const changed = structuredClone(scribePolicy());
  changed.generation.policy_profile = 'changed-profile';
  const result = await runService(extractorManifest, [policyEnvelope(), policyEnvelope(changed)], 2);
  assert.equal(result.outputs[0].message_type, 'operation.completed');
  assert.equal(result.outputs[1].message_type, 'service.failure');
  assert.equal(result.outputs[1].payload.error.code, 'SCRIBE_BATCH_POLICY_CONFLICT');
});

test('Scribe batch extraction needs no Ollama installation and leaves the 1.0.0 single-text protocol untouched', async () => {
  const endpoint = await startScribeBatchModelEndpoint({ reply: () => ({ items: [] }) });
  try {
    const { request } = buildScribeBatchRequest(dispatchInput({ requestId: 'batch-lmstudio' }));
    const result = await runService(laneManifest, [providerConfiguration(endpoint.url), workRequestEnvelope(request)], 3, 8000, {
      env: { ARGUS_MODEL_ENDPOINT: '', ARGUS_MODEL_NAME: '', ARGUS_MODEL_TIMEOUT_MS: '', ARGUS_MODEL_PROTOCOL: '' }
    });
    const completion = result.outputs.find((message) => message.message_type === 'ai.work-completed');
    assert.equal(completion.payload.result.status, 'succeeded');
    // An OpenAI-compatible chat body, not an Ollama generate body.
    assert.ok(Array.isArray(endpoint.calls[0].envelope.messages));
    assert.equal(Object.hasOwn(endpoint.calls[0].envelope, 'prompt'), false);
    assert.equal(endpoint.calls[0].envelope.stream, false);
    assert.equal(endpoint.calls[0].envelope.temperature, 0);
    assert.equal(endpoint.calls[0].envelope.max_tokens, request.limits.max_output_tokens);
    assert.equal(endpoint.calls[0].authorization, undefined);
    assert.doesNotMatch(JSON.stringify(result.outputs), /api[_-]?key|credential/i);
    // The Scribe instruction governs only the batch protocol; it never restates the 1.0.0
    // single-text response shape that the existing extraction and classification paths use.
    const scribeText = scribeBatchInstruction('1.0.0').text;
    assert.match(scribeText, /"protocol_version":"2\.0\.0"/);
    assert.doesNotMatch(scribeText, /"protocol_version":"1\.0\.0"/);
    assert.doesNotMatch(scribeText, /suggested_classification/);
  } finally {
    await endpoint.close();
  }
});

function newEvidence() {
  return [
    { segment_id: 'segment-10', revision: 0, sequence: 10, start_time: '00:00:10.000', end_time: '00:00:11.000', text: 'We agreed to ship the draft Friday.' },
    { segment_id: 'segment-11', revision: 0, sequence: 11, start_time: '00:00:11.000', end_time: '00:00:12.000', text: 'Someone still needs to confirm the reviewer.' },
    { segment_id: 'segment-12', revision: 0, sequence: 12, start_time: '00:00:12.000', end_time: '00:00:13.000', text: 'Remind the team about the Friday deadline.' }
  ];
}

function backgroundContext() {
  return {
    transcript_segments: [
      { segment_id: 'segment-7', sequence: 7, start_time: '00:00:07.000', end_time: '00:00:08.000', text: 'Oldest background turn.', relation: 'lookback' },
      { segment_id: 'segment-8', sequence: 8, start_time: '00:00:08.000', end_time: '00:00:09.000', text: 'Middle background turn.', relation: 'lookback' },
      { segment_id: 'segment-9', sequence: 9, start_time: '00:00:09.000', end_time: '00:00:10.000', text: 'Newest background turn.', relation: 'lookback' }
    ],
    prior_logged_items: [
      { text: 'Draft is due for review.', kind: 'action', source_segment_ids: ['segment-3'] },
      { text: 'Reviewer list was circulated.', kind: 'other', source_segment_ids: ['segment-5'] }
    ]
  };
}

function batchIdentity(requestId, overrides = {}) {
  return {
    request_id: requestId,
    session_id: session,
    segments: newEvidence().map((segment) => ({ segment_id: segment.segment_id, revision: 0, sequence: segment.sequence })),
    first_sequence: 10,
    last_sequence: 12,
    admission_reason: 'batch-complete',
    policy_id: 'scribe-default',
    policy_version: '1.0.0',
    instruction_version: '1.0.0',
    ...overrides
  };
}

function scribePolicy(totalContextTokens = 8000) {
  return {
    policy_id: 'scribe-default',
    policy_version: '1.0.0',
    session_id: session,
    admission: { rows_per_batch: 3, idle_timeout_ms: 15000 },
    context: { max_total_context_tokens: totalContextTokens },
    generation: { policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0' }
  };
}

function dispatchInput({ requestId = 'batch-1', totalContextTokens, policy, batchIdentityOverrides, background } = {}) {
  return {
    batch: {
      batch_identity: batchIdentity(requestId, batchIdentityOverrides),
      batch_attempt: 1,
      new_evidence_segments: newEvidence(),
      background_context: background ?? backgroundContext(),
      policy_profile: 'neutral-contextual-log',
      instruction_version: '1.0.0'
    },
    policy: policy ?? scribePolicy(totalContextTokens),
    workId: workId(requestId),
    modelName: MODEL
  };
}

function workId(requestId) { return `logged-item-extraction:${session}:${requestId}:batch-attempt-1`; }

/** The real serialized total one dispatch consumes at the governed default budget. */
function measuredTotalTokens(input) {
  return buildScribeBatchRequest({ ...input, policy: scribePolicy(8000) }).budget.total_tokens;
}

function removalCount(budget) {
  return budget.removed_background_transcript_segment_ids.length + budget.removed_prior_logged_items;
}

/**
 * The largest governed budget that forces at least `count` background units out.
 *
 * This searches instead of hard-coding a threshold because `limits` is itself part of the
 * serialized request, so the budget and the measured size are mutually dependent: a constant
 * derived from one budget silently stops forcing a roll at another, and would also drift the
 * moment the instruction wording or the request shape changed length. Taking the largest such
 * budget means the removal count is the minimum the budget actually compels.
 */
function budgetForcingRemovals(input, count) {
  for (let budget = measuredTotalTokens(input); budget >= 1; budget -= 1) {
    let built;
    try { built = buildScribeBatchRequest({ ...input, policy: scribePolicy(budget) }); } catch { break; }
    if (removalCount(built.budget) >= count) return budget;
  }
  throw new Error(`no governed budget forced ${count} background removal(s)`);
}

/**
 * Background turns whose text is short but whose JSON structure is heavy: long segment ids, a
 * sequence, both timestamps, and a relation. This is the shape that makes a text-only token
 * estimate diverge sharply from the request actually transmitted.
 */
function structuralBackground(count) {
  return Array.from({ length: count }, (_unused, index) => ({
    segment_id: `background-segment-${index}`,
    sequence: index,
    start_time: `00:00:${String(index % 60).padStart(2, '0')}.000`,
    end_time: `00:00:${String((index + 1) % 60).padStart(2, '0')}.000`,
    text: 'Short background turn.',
    relation: 'lookback'
  }));
}

function policyEnvelope(policy = scribePolicy()) {
  return createEnvelope({
    plane: 'control', messageType: 'scribe.batch-policy', producer: 'fixture-scribe-coordinator', correlationId: session,
    schemaVersion: '1.0.0', idempotencyKey: `scribe-policy:${policy.policy_id}:${policy.policy_version}:${policy.generation.policy_profile}`, payload: policy
  });
}

function batchAdmittedEnvelope(batch) {
  return createEnvelope({
    plane: 'domain', messageType: 'scribe.batch-admitted', producer: 'fixture-scribe-coordinator', correlationId: session,
    schemaVersion: '1.0.0', idempotencyKey: `scribe-admitted:${batch.batch_identity.request_id}:a${batch.batch_attempt}`, payload: batch
  });
}

function storedEnvelope(draft) {
  const { created_at, ...payload } = structuredClone(draft.payload);
  return createEnvelope({
    plane: 'domain', messageType: 'logged-item.stored', producer: 'fixture-active-logged-item-owner', correlationId: session,
    schemaVersion: '1.0.0', idempotencyKey: `stored:${payload.item_id}`, payload: { ...payload, stored_at: created_at }
  });
}

function batchCompletionEnvelope(request, { response, status = 'succeeded', error, nestedWorkId, idempotencyKey } = {}) {
  return createEnvelope({
    plane: 'control', messageType: 'ai.work-completed', producer: 'fixture-model-lane', correlationId: session,
    schemaVersion: '1.5.0', idempotencyKey: idempotencyKey || `scribe-completion:${request.batch_identity.request_id}`, payload: {
      work_id: request.identity.work_id, workload: 'logged-item-extraction', session_id: session,
      sequence: request.batch_identity.last_sequence, attempt: 1, completed_at: '2026-09-07T17:00:01.000Z',
      result: {
        status, work_id: nestedWorkId || request.identity.work_id, request_fingerprint: fingerprintScribeBatchRequest(request),
        ...(status === 'failed' ? { error } : { response })
      }
    }
  });
}

/** A 1.0.0 work request of the kind this service produces; it must be ignored on the accept side. */
function legacyWorkRequestEnvelope() {
  return createEnvelope({
    plane: 'control', messageType: 'ai.work-request', producer: 'fixture-extractor', correlationId: session,
    schemaVersion: '1.4.0', idempotencyKey: 'legacy-work-request', payload: {
      work_id: 'logged-item-extraction:legacy:window-1', workload: 'logged-item-extraction', session_id: session,
      sequence: 1, queued_at: '2026-09-07T17:00:00.000Z', recovery: { max_attempts: 2 },
      input: { model_request: {
        protocol_version: '1.0.0', purpose: 'logged-item-extraction', model: MODEL,
        authoritative_source_segments: [{ segment_id: 'segment-1', sequence: 1, start_time: '00:00:01.000', end_time: '00:00:02.000', text: 'Legacy window.' }],
        bounded_context_segments: [], policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0',
        limits: { max_context_chars: 100, max_context_tokens: 25, max_output_chars: 512, max_output_tokens: 128 },
        identity: { work_id: 'logged-item-extraction:legacy:window-1', session_id: session, context_window_id: 'window-1' }
      } }
    }
  });
}

function batchResponse(request, items) {
  return { protocol_version: '2.0.0', purpose: 'logged-item-extraction', batch_identity: structuredClone(request.batch_identity), items: structuredClone(items) };
}

function providerConfiguration(endpointUrl, { timeoutMs = 2000 } = {}) {
  return createEnvelope({
    plane: 'control', messageType: 'ai.provider-configure', producer: 'fixture-host', correlationId: session,
    schemaVersion: '1.0.0', idempotencyKey: `provider-configure:${endpointUrl}`, payload: {
      configuration: { version: 1, mode: 'local', provider: 'lm-studio', endpoint: endpointUrl, model: MODEL, protocol: 'openai-compatible', timeout_ms: timeoutMs },
      credential: { provided: false }
    }
  });
}

function workRequestEnvelope(request, { maxAttempts = 2 } = {}) {
  return createEnvelope({
    plane: 'control', messageType: 'ai.work-request', producer: 'fixture-extractor', correlationId: session,
    schemaVersion: '1.5.0', idempotencyKey: `scribe-work:${request.batch_identity.request_id}`, payload: {
      work_id: request.identity.work_id, workload: 'logged-item-extraction', session_id: session,
      sequence: request.batch_identity.last_sequence, queued_at: '2026-09-07T17:00:00.000Z',
      input: { model_request: request }, recovery: { max_attempts: maxAttempts }
    }
  });
}
