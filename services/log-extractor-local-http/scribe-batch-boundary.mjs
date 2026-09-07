import { createHash } from 'node:crypto';
import { canonicalJson } from '../../runtime/message-identity.mjs';
import {
  EXTRACTION_BATCH_OUTPUT_LIMITS,
  SCRIBE_BATCH_PROTOCOL_VERSION,
  estimateModelTokens,
  fingerprintModelRequest,
  protocolError,
  validateScribeBatchModelRequest,
  validateScribeBatchModelResponse
} from '../../contracts/model-protocol.mjs';
import { scribeBatchInstruction } from '../../contracts/scribe-instruction.mjs';

const IMPLEMENTATION = 'log-extractor-local-http';

export { EXTRACTION_BATCH_OUTPUT_LIMITS, SCRIBE_BATCH_PROTOCOL_VERSION };

/**
 * Governed total context budget from `scribe.batch-policy` (`context.max_total_context_tokens`).
 * Exported for callers that need the policy default; a dispatch still has to supply the policy,
 * because reading a budget from a constant instead of the accepted policy would let the
 * extraction path drift from the coordinator's governed configuration.
 */
export const SCRIBE_POLICY_DEFAULT_TOTAL_CONTEXT_TOKENS = 8000;

/**
 * Build one stateless Scribe batch model request inside the governed total token budget.
 *
 * Every call carries the whole prompt: the versioned instruction, the new authoritative
 * evidence, and the bounded prior Scribe context. Nothing is assumed to survive on the provider
 * side between requests, so LM Studio (or any OpenAI-compatible endpoint) retaining or
 * discarding earlier requests cannot change the result.
 *
 * Budget accounting reserves all five components named by the policy: instruction, response
 * schema (carried inside the instruction text), new evidence, background context, and the
 * bounded output. New evidence is mandatory and is never truncated; only background rolls.
 */
export function buildScribeBatchRequest({ batch, policy, workId, modelName }) {
  const batchIdentity = requireObject(batch?.batch_identity, 'scribe batch identity is required');
  const newEvidenceSegments = requireArray(batch?.new_evidence_segments, 'scribe batch new evidence segments are required');
  const background = requireObject(batch?.background_context, 'scribe batch background context is required');
  const backgroundTranscript = requireArray(background.transcript_segments, 'scribe background transcript segments are required');
  const priorLoggedItems = requireArray(background.prior_logged_items, 'scribe background prior logged items are required');
  if (!workId || typeof workId !== 'string') throw inputError('scribe batch work identity is required');
  if (!modelName || typeof modelName !== 'string') throw inputError('scribe batch model name is required');

  const generation = requireObject(policy?.generation, 'scribe batch policy generation settings are required');
  const totalContextTokens = policy?.context?.max_total_context_tokens;
  if (!Number.isInteger(totalContextTokens) || totalContextTokens < 1) {
    throw inputError('scribe batch policy context.max_total_context_tokens must be a positive integer');
  }
  // The policy is the authoritative source of the profile, instruction version, and policy
  // identity; the batch identity carries the copy the coordinator stamped on the batch. A
  // disagreement means one of the two was reinterpreted, so the dispatch fails rather than
  // silently prompting under a version the batch was not admitted under.
  assertPolicyAgreement(batchIdentity, policy, generation);

  const instruction = scribeBatchInstruction(batchIdentity.instruction_version);
  const outputReserveTokens = EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens;
  const contextAllowanceTokens = totalContextTokens - instruction.tokens - outputReserveTokens;
  if (contextAllowanceTokens < 1) {
    throw budgetError(`scribe batch budget of ${totalContextTokens} tokens cannot hold the ${instruction.tokens}-token instruction and schema plus the ${outputReserveTokens}-token output reserve`);
  }

  const newEvidenceTokens = estimateModelTokens(newEvidenceSegments);
  if (newEvidenceTokens > contextAllowanceTokens) {
    // New evidence is the authoritative reason the batch exists. Dropping or clipping part of
    // it would silently evaluate a different batch than the one whose identity is recorded, so
    // an over-budget mandatory input fails visibly instead.
    throw budgetError(`scribe batch new evidence needs ${newEvidenceTokens} tokens but only ${contextAllowanceTokens} remain after the instruction and output reserve; new evidence is never truncated`);
  }

  const transcriptSegments = [...backgroundTranscript];
  const loggedItems = [...priorLoggedItems];
  const removedTranscriptSegmentIds = [];
  let removedPriorLoggedItems = 0;
  // Background rolls oldest complete unit first, and a unit always leaves whole: a clipped turn
  // or a shortened prior item would misrepresent recorded history rather than merely shrink it.
  // Background transcript turns go before prior Logged Items because the prior items are what
  // makes duplicate suppression possible (ADR-021) - losing them re-admits information already
  // recorded, while losing distant transcript turns only costs interpretive context.
  while (estimateModelTokens([...newEvidenceSegments, ...transcriptSegments, ...loggedItems]) > contextAllowanceTokens) {
    if (transcriptSegments.length) {
      const oldest = oldestSegmentIndex(transcriptSegments);
      removedTranscriptSegmentIds.push(transcriptSegments[oldest].segment_id);
      transcriptSegments.splice(oldest, 1);
      continue;
    }
    if (loggedItems.length) {
      loggedItems.shift();
      removedPriorLoggedItems += 1;
      continue;
    }
    throw budgetError(`scribe batch cannot fit its mandatory instruction, schema, new evidence, and output reserve within ${totalContextTokens} tokens`);
  }

  const request = {
    protocol_version: SCRIBE_BATCH_PROTOCOL_VERSION,
    purpose: 'logged-item-extraction',
    model: modelName,
    batch_identity: structuredClone(batchIdentity),
    new_evidence_segments: structuredClone(newEvidenceSegments),
    background_context: { transcript_segments: structuredClone(transcriptSegments), prior_logged_items: structuredClone(loggedItems) },
    policy_profile: generation.policy_profile,
    instruction_version: instruction.version,
    limits: {
      // Char and token ceilings are held at the same tightness (the governed estimator is
      // ceil(chars / 4)) so the protocol validator enforces exactly the allowance computed here.
      max_context_chars: contextAllowanceTokens * 4,
      max_context_tokens: contextAllowanceTokens,
      max_output_chars: EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_chars,
      max_output_tokens: EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens
    },
    identity: { work_id: workId, session_id: batchIdentity.session_id, batch_request_id: batchIdentity.request_id }
  };
  validateScribeBatchModelRequest(request);

  return {
    request,
    budget: Object.freeze({
      total_context_tokens: totalContextTokens,
      instruction_tokens: instruction.tokens,
      output_reserve_tokens: outputReserveTokens,
      context_allowance_tokens: contextAllowanceTokens,
      new_evidence_tokens: newEvidenceTokens,
      background_tokens: estimateModelTokens([...transcriptSegments, ...loggedItems]),
      removed_background_transcript_segment_ids: Object.freeze([...removedTranscriptSegmentIds]),
      removed_prior_logged_items: removedPriorLoggedItems
    })
  };
}

export function fingerprintScribeBatchRequest(request) {
  return fingerprintModelRequest(request);
}

/** The batch model_request variant exists only from `ai.work-request` 1.5.0 onward. */
export const SCRIBE_BATCH_WORK_REQUEST_SCHEMA_VERSION = '1.5.0';
export const LOGGED_ITEM_DRAFT_SCHEMA_VERSION = '1.3.0';

/** The governed `ai.work-request` message for one bounded Scribe batch. */
export function scribeBatchWorkRequest({ request, queuedAt, maxAttempts = 2, instance = IMPLEMENTATION }) {
  return {
    plane: 'control',
    messageType: 'ai.work-request',
    schemaVersion: SCRIBE_BATCH_WORK_REQUEST_SCHEMA_VERSION,
    identityKey: `${instance}:ai.work-request:${request.identity.work_id}`,
    payload: {
      work_id: request.identity.work_id,
      workload: 'logged-item-extraction',
      session_id: request.identity.session_id,
      sequence: request.batch_identity.last_sequence,
      queued_at: queuedAt,
      input: { model_request: structuredClone(request) },
      recovery: { max_attempts: maxAttempts }
    }
  };
}

/**
 * The governed outbound result of one settled Scribe batch: one `logged-item.draft` per validated
 * item - none at all for a valid empty evaluation, several for a multi-item batch - paired with
 * the complete evaluated-batch outcome the active owner and coordinator need in order to
 * acknowledge a zero-, one-, or many-item batch rather than infer it from message count.
 */
export function scribeBatchCompletionOutputs({ request, response, attempt, evaluatedAt, instance = IMPLEMENTATION }) {
  const { items, drafts, evaluated } = evaluateScribeBatchResponse({ request, response, attempt, evaluatedAt });
  return {
    items,
    evaluated,
    outputs: drafts.map((payload) => ({
      messageType: 'logged-item.draft',
      schemaVersion: LOGGED_ITEM_DRAFT_SCHEMA_VERSION,
      identityKey: `${instance}:logged-item.draft:${payload.item_id}:r0`,
      payload
    }))
  };
}

/**
 * Argus-owned, deterministic revision-zero draft identity.
 *
 * Derived from the validated batch identity plus the item's position and content, so the same
 * validated batch produces the same identity on replay and on a retried attempt, and two
 * distinct items in one batch can never collide. The model supplies no authority field; the
 * active Logged Item owner still decides whether each draft is accepted or rejected.
 */
export function stableScribeDraftItemId(batchIdentity, index, item) {
  const digest = createHash('sha256').update(canonicalJson({
    session_id: batchIdentity.session_id,
    batch_request_id: batchIdentity.request_id,
    item_index: index,
    text: item.text,
    kind: item.kind ?? null,
    source_segment_ids: item.source_segment_ids
  })).digest('hex').slice(0, 24);
  return `logged-item-${digest}`;
}

/**
 * Validate one Scribe batch model response and turn it into zero-to-many governed drafts plus
 * the complete evaluated-batch outcome.
 *
 * The response's whole batch identity must equal the dispatched request's before any draft
 * exists, so a stale, superseded, or provider-altered identity cannot attach a draft to a batch
 * that was never evaluated.
 */
export function evaluateScribeBatchResponse({ request, response, attempt, evaluatedAt }) {
  const validated = validateScribeBatchModelResponse(response, request.limits);
  if (canonicalJson(validated.batch_identity) !== canonicalJson(request.batch_identity)) {
    throw protocolError('SCRIBE_BATCH_IDENTITY_CONFLICT', 'scribe batch response identity does not match the dispatched batch identity');
  }
  const items = validated.items.map((item) => normalizeItem(item));
  const drafts = items.map((item, index) => draftPayload({ request, item, index }));
  return { items, drafts, evaluated: scribeBatchEvaluated({ batchIdentity: request.batch_identity, attempt, evaluatedAt, items }) };
}

/**
 * The evaluated-batch outcome for a settled batch, before acknowledgement.
 *
 * `acknowledgement` is deliberately unaccepted here: the terminal acknowledgement may only
 * carry Logged Item IDs the active owner actually confirmed, and the extraction path has no
 * authority to assert acceptance on the owner's behalf.
 */
export function scribeBatchEvaluated({ batchIdentity, attempt, evaluatedAt, items }) {
  return {
    batch_identity: structuredClone(batchIdentity),
    evaluated_at: evaluatedAt,
    attempt,
    outcome: items.length ? 'items-recorded' : 'empty-evaluated',
    items: structuredClone(items),
    acknowledgement: pendingAcknowledgement(batchIdentity, attempt)
  };
}

/** The evaluated-batch outcome for a batch that failed, including a model-endpoint timeout. */
export function failedScribeBatchEvaluation({ batchIdentity, attempt, evaluatedAt, error }) {
  return {
    batch_identity: structuredClone(batchIdentity),
    evaluated_at: evaluatedAt,
    attempt,
    outcome: 'failed',
    items: [],
    error: {
      code: error?.code || 'MODEL_REQUEST_FAILED',
      category: error?.category || 'dependency',
      message: error?.message || 'model request failed',
      retryable: error?.retryable !== false
    },
    acknowledgement: pendingAcknowledgement(batchIdentity, attempt)
  };
}

/**
 * Bounded in-memory retention for dispatched Scribe batches.
 *
 * The exact request and its fingerprint are held for the life of the work so a retried attempt
 * is correlated against byte-identical content, and so a completion can be matched to the batch
 * that was actually dispatched rather than to a reconstruction of it.
 */
export function createScribeBatchRetention({ capacity = 32, instance = IMPLEMENTATION } = {}) {
  const pending = new Map();
  return {
    get size() { return pending.size; },
    has(workId) { return pending.has(workId); },
    get(workId) { return pending.get(workId); },
    release(workId) { return pending.delete(workId); },
    clear() { pending.clear(); },
    dispatch({ batch, policy, workId, modelName, queuedAt, maxAttempts }) {
      if (!pending.has(workId) && pending.size >= capacity) {
        throw capacityError(`pending scribe batch capacity reached: ${capacity}`, capacity);
      }
      const { request, budget } = buildScribeBatchRequest({ batch, policy, workId, modelName });
      const requestFingerprint = fingerprintScribeBatchRequest(request);
      pending.set(workId, { request, requestFingerprint, budget });
      return { request, requestFingerprint, budget, workRequest: scribeBatchWorkRequest({ request, queuedAt, maxAttempts, instance }) };
    }
  };
}

function draftPayload({ request, item, index }) {
  const source = itemSource(request, item);
  const itemId = stableScribeDraftItemId(request.batch_identity, index, item);
  return {
    item_id: itemId,
    session_id: request.batch_identity.session_id,
    created_at: source.end_time,
    text: item.text,
    revision: 0,
    revision_id: `${itemId}:r0`,
    source,
    generator: { implementation: IMPLEMENTATION, input_window_id: request.batch_identity.request_id }
  };
}

/**
 * Exact provenance for one item, taken from the dispatched new evidence rather than from the
 * response, so a model can cite which segments evidence an item but cannot state its times.
 */
function itemSource(request, item) {
  const byId = new Map(request.new_evidence_segments.map((segment) => [segment.segment_id, segment]));
  const cited = item.source_segment_ids.map((id) => {
    const segment = byId.get(id);
    if (!segment) throw protocolError('INVALID_MODEL_OUTPUT', `scribe batch item cites segment ${id}, which is not part of the evaluated new evidence`);
    return segment;
  }).sort((left, right) => left.sequence - right.sequence);
  const first = cited[0], last = cited.at(-1);
  return { first_segment_id: first.segment_id, last_segment_id: last.segment_id, start_time: first.start_time, end_time: last.end_time };
}

function normalizeItem(item) {
  const text = item.text.trim();
  return item.kind === undefined
    ? { text, source_segment_ids: [...item.source_segment_ids] }
    : { text, kind: item.kind, source_segment_ids: [...item.source_segment_ids] };
}

function pendingAcknowledgement(batchIdentity, attempt) {
  return { ack_id: `${batchIdentity.request_id}:a${attempt}`, accepted: false, acknowledged_at: null, logged_item_ids: [] };
}

function assertPolicyAgreement(batchIdentity, policy, generation) {
  for (const [batchKey, policyValue, label] of [
    ['policy_id', policy.policy_id, 'policy_id'],
    ['policy_version', policy.policy_version, 'policy_version'],
    ['instruction_version', generation.instruction_version, 'generation.instruction_version']
  ]) {
    if (policyValue !== undefined && batchIdentity[batchKey] !== policyValue) {
      throw inputError(`scribe batch identity ${batchKey} does not match the accepted policy ${label}`);
    }
  }
  if (policy.session_id !== undefined && policy.session_id !== batchIdentity.session_id) {
    throw inputError('scribe batch identity session_id does not match the accepted policy session_id');
  }
}

function oldestSegmentIndex(segments) {
  let oldest = 0;
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].sequence < segments[oldest].sequence) oldest = index;
  }
  return oldest;
}

function requireObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw inputError(message);
  return value;
}
function requireArray(value, message) {
  if (!Array.isArray(value)) throw inputError(message);
  return value;
}
function inputError(message) { return new Error(message, { cause: { code: 'INVALID_MODEL_INPUT', category: 'validation' } }); }
function budgetError(message) { return new Error(message, { cause: { code: 'SCRIBE_BATCH_BUDGET_EXCEEDED', category: 'validation' } }); }
function capacityError(message, capacity) { return new Error(message, { cause: { code: 'SCRIBE_BATCH_PENDING_FULL', category: 'capacity', details: { capacity } } }); }
