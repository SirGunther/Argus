// SCRIBE-07C — governed context/output limits and priority regression.
//
// Real-work baseline (docs/plans/SCRIBE-STATELESS-REQUEST-HARDENING-TODO.md, "Real-work evidence
// baseline"): LM Studio received stateless Scribe batch requests measuring `prompt_tokens: 9334`
// and `prompt_tokens: 9288` against a model running with a 32,000-token context window, while the
// configured production budget (`wiring/production-electron.json`, the coordinator's
// `DEFAULT_POLICY`, and `SCRIBE_POLICY_DEFAULT_TOTAL_CONTEXT_TOKENS`) was only ~8,000 tokens. The
// accepted correction is a single formalized 16,384-token budget and governed output limits
// (`max_items: 8`, `max_item_chars: 512`, `max_output_chars: 4096`, `max_output_tokens: 2048`),
// applied through the existing `buildScribeBatchRequest` assembly and mandatory-floor/rollover
// logic in `services/log-extractor-local-http/scribe-batch-boundary.mjs` — no second budget or
// retention mechanism is introduced here.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { EXTRACTION_BATCH_OUTPUT_LIMITS } from '../contracts/model-protocol.mjs';
import {
  SCRIBE_POLICY_DEFAULT_TOTAL_CONTEXT_TOKENS,
  buildScribeBatchRequest
} from '../services/log-extractor-local-http/scribe-batch-boundary.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const session = 'scribe-context-budget-session';

test('the accepted SCRIBE-07C defaults are formalized in the extraction boundary export, production wiring, the policy schema, and the governed output limits', async () => {
  // Extraction boundary's own governed default (services/log-extractor-local-http/scribe-batch-boundary.mjs).
  assert.equal(SCRIBE_POLICY_DEFAULT_TOTAL_CONTEXT_TOKENS, 16384);

  // Production electron graph configuration (wiring/production-electron.json) — the same file
  // tests/scribe-production-integration.test.mjs reads to assert the real production graph.
  const productionGraph = JSON.parse(await readFile(path.join(root, 'wiring', 'production-electron.json'), 'utf8'));
  assert.equal(productionGraph.run.configuration.scribe_policy.context.max_total_context_tokens, 16384);

  // Governed policy schema's declared default (contracts/scribe-batch-policy.schema.json).
  const policySchema = JSON.parse(await readFile(path.join(root, 'contracts', 'scribe-batch-policy.schema.json'), 'utf8'));
  assert.equal(policySchema.properties.context.properties.max_total_context_tokens.default, 16384);

  // Governed batch output limits (contracts/model-protocol.mjs).
  assert.deepEqual(EXTRACTION_BATCH_OUTPUT_LIMITS, {
    max_items: 8,
    max_item_chars: 512,
    max_output_chars: 4096,
    max_output_tokens: 2048
  });
});

test('the coordinator\'s bounded worst-case background (48 transcript segments, 64 prior Logged Items) exceeded the prior 8,000-token default but fits the formalized 16,384-token default without rolling off any background', () => {
  // 48 and 64 are the coordinator's own bounded retention ceilings
  // (services/scribe-coordinator/coordinator.mjs MAX_BACKGROUND_TRANSCRIPT_SEGMENTS /
  // MAX_BACKGROUND_LOGGED_ITEMS), so this is the real worst-case shape one stateless dispatch can
  // ever carry — not an arbitrarily inflated fixture.
  const input = dispatchInput({
    background: {
      transcript_segments: heavyTranscript(48),
      prior_logged_items: heavyLoggedItems(64)
    }
  });

  const atPriorDefault = buildScribeBatchRequest({ ...input, policy: scribePolicy(8000) });
  assert.ok(
    atPriorDefault.budget.removed_background_transcript_segment_ids.length > 0,
    'the prior ~8,000-token default must be too small to hold the bounded worst-case background for this regression to be meaningful'
  );
  // New evidence is never touched by rollover, and Logged Items outrank transcript: the prior
  // default rolls transcript off before it ever removes a Logged Item.
  assert.deepEqual(atPriorDefault.request.new_evidence_segments, newEvidence());
  assert.equal(atPriorDefault.budget.removed_prior_logged_items, 0);
  assert.equal(atPriorDefault.request.background_context.prior_logged_items.length, 64);
  // Oldest-first: the removed ids are exactly the lowest-sequence prefix, and survivors keep
  // ascending chronological order.
  const removedCount = atPriorDefault.budget.removed_background_transcript_segment_ids.length;
  assert.deepEqual(
    atPriorDefault.budget.removed_background_transcript_segment_ids,
    Array.from({ length: removedCount }, (_unused, index) => `background-segment-${index}`)
  );
  const survivingSequences = atPriorDefault.request.background_context.transcript_segments.map((segment) => segment.sequence);
  assert.deepEqual(survivingSequences, [...survivingSequences].sort((left, right) => left - right));
  assert.equal(survivingSequences[0], removedCount);

  const atFormalizedDefault = buildScribeBatchRequest({ ...input, policy: scribePolicy(SCRIBE_POLICY_DEFAULT_TOTAL_CONTEXT_TOKENS) });
  assert.equal(atFormalizedDefault.budget.total_context_tokens, 16384);
  assert.ok(atFormalizedDefault.budget.total_tokens <= 16384);
  assert.equal(atFormalizedDefault.budget.removed_background_transcript_segment_ids.length, 0);
  assert.equal(atFormalizedDefault.budget.removed_prior_logged_items, 0);
  assert.equal(atFormalizedDefault.request.background_context.transcript_segments.length, 48);
  assert.equal(atFormalizedDefault.request.background_context.prior_logged_items.length, 64);
  assert.deepEqual(
    atFormalizedDefault.request.background_context.transcript_segments.map((segment) => segment.sequence),
    Array.from({ length: 48 }, (_unused, index) => index)
  );
  assert.deepEqual(atFormalizedDefault.request.new_evidence_segments, newEvidence());
});

test('mandatory new evidence that alone exceeds the formalized 16,384-token default fails visibly instead of being truncated', () => {
  // Each evidence segment's text alone is far larger than the entire governed budget once the
  // instruction, schema, and output reserve are reserved, so this failure is caused by the
  // mandatory floor, not by an exhausted background pool (background is empty here).
  const input = dispatchInput({
    background: { transcript_segments: [], prior_logged_items: [] },
    oversizedEvidence: true
  });

  assert.throws(
    () => buildScribeBatchRequest({ ...input, policy: scribePolicy(SCRIBE_POLICY_DEFAULT_TOTAL_CONTEXT_TOKENS) }),
    (error) => {
      assert.equal(error.cause.code, 'SCRIBE_BATCH_BUDGET_EXCEEDED');
      assert.match(error.message, /new evidence and guidance are never truncated/);
      assert.match(error.message, /governed budget is 16384/);
      return true;
    }
  );
});

function newEvidence() {
  return [
    { segment_id: 'evidence-0', revision: 0, sequence: 100, start_time: '00:10:00.000', end_time: '00:10:01.000', text: 'We agreed to ship the draft Friday.' },
    { segment_id: 'evidence-1', revision: 0, sequence: 101, start_time: '00:10:01.000', end_time: '00:10:02.000', text: 'Someone still needs to confirm the reviewer.' },
    { segment_id: 'evidence-2', revision: 0, sequence: 102, start_time: '00:10:02.000', end_time: '00:10:03.000', text: 'Remind the team about the Friday deadline.' }
  ];
}

function oversizedNewEvidence() {
  const bigText = 'x'.repeat(20000);
  return newEvidence().map((segment) => ({ ...segment, text: bigText }));
}

/**
 * Background turns whose text is realistically long (not merely short filler): heavy enough,
 * across the coordinator's full 48-segment ceiling, that the bounded worst-case background
 * measurably exceeds the prior ~8,000-token default but still fits the formalized 16,384-token
 * default. Each carries the same structural overhead (ids, sequence, both timestamps, relation)
 * the real serialized request transmits.
 */
function heavyTranscript(count) {
  return Array.from({ length: count }, (_unused, index) => ({
    segment_id: `background-segment-${index}`,
    sequence: index,
    start_time: `00:00:${String(index % 60).padStart(2, '0')}.000`,
    end_time: `00:00:${String((index + 1) % 60).padStart(2, '0')}.000`,
    text: 'Earlier in the meeting someone made a longer remark about the project schedule, budget, staffing, and the plan for the upcoming release window and dependencies.',
    relation: 'lookback'
  }));
}

function heavyLoggedItems(count) {
  return Array.from({ length: count }, (_unused, index) => ({
    text: `Prior logged item number ${index} describing something specific the team already decided to do about the release, staffing, or schedule, recorded for later reference.`,
    kind: 'action',
    source_segment_ids: [`segment-${index}`]
  }));
}

function batchIdentity(evidence) {
  return {
    request_id: 'context-budget-batch-1',
    session_id: session,
    segments: evidence.map((segment) => ({ segment_id: segment.segment_id, revision: 0, sequence: segment.sequence })),
    first_sequence: evidence[0].sequence,
    last_sequence: evidence.at(-1).sequence,
    admission_reason: 'batch-complete',
    policy_id: 'scribe-default',
    policy_version: '1.0.0',
    instruction_version: '1.0.0'
  };
}

function scribePolicy(totalContextTokens) {
  return {
    policy_id: 'scribe-default',
    policy_version: '1.0.0',
    session_id: session,
    admission: { rows_per_batch: 3, idle_timeout_ms: 15000 },
    context: { max_total_context_tokens: totalContextTokens },
    generation: { policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0' }
  };
}

function dispatchInput({ background, oversizedEvidence = false } = {}) {
  const evidence = oversizedEvidence ? oversizedNewEvidence() : newEvidence();
  return {
    batch: {
      batch_identity: batchIdentity(evidence),
      batch_attempt: 1,
      new_evidence_segments: evidence,
      background_context: background,
      policy_profile: 'neutral-contextual-log',
      instruction_version: '1.0.0'
    },
    workId: `logged-item-extraction:${session}:context-budget-batch-1:batch-attempt-1`,
    modelName: 'scribe-context-budget-model'
  };
}
