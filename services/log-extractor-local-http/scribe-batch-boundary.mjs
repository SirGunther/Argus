import { createHash } from 'node:crypto';
import { canonicalJson, deterministicMessageId, fingerprintValue } from '../../runtime/message-identity.mjs';
import {
  EXTRACTION_BATCH_OUTPUT_LIMITS,
  SCRIBE_BATCH_PROTOCOL_VERSION,
  SCRIBE_GUIDANCE_LIMITS,
  estimateModelTokens,
  fingerprintModelRequest,
  protocolError,
  validateScribeBatchModelRequest,
  validateScribeBatchModelResponse
} from '../../contracts/model-protocol.mjs';
import { SCRIBE_GUIDANCE_INSTRUCTION_VERSION, scribeBatchInstruction } from '../../contracts/scribe-instruction.mjs';

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
 *
 * The evidence and background components are counted as the **complete serialized request** that
 * is actually transmitted, not as concatenated segment text. Counting text alone under-reports a
 * real transmission by everything JSON carries around it - `batch_identity` segment ids,
 * revisions and sequences, per-segment ids/times/relations, prior-item kinds and
 * `source_segment_ids`, plus `limits`, `identity`, `policy_profile` and `instruction_version` -
 * which let an over-budget request validate as under budget.
 */
export function buildScribeBatchRequest({ batch, policy, workId, modelName }) {
  const batchIdentity = requireObject(batch?.batch_identity, 'scribe batch identity is required');
  const newEvidenceSegments = requireArray(batch?.new_evidence_segments, 'scribe batch new evidence segments are required');
  const background = requireObject(batch?.background_context, 'scribe batch background context is required');
  const backgroundTranscript = requireArray(background.transcript_segments, 'scribe background transcript segments are required');
  const priorLoggedItems = requireArray(background.prior_logged_items, 'scribe background prior logged items are required');
  if (!Number.isInteger(batch?.batch_attempt) || batch.batch_attempt < 1) throw inputError('scribe batch coordinator batch_attempt must be a positive integer');
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
  assertPolicyAgreement(batch, policy, generation);

  const instruction = scribeBatchInstruction(batchIdentity.instruction_version);
  const guidance = normalizeGuidance(generation.additional_guidance, instruction.version);
  const outputReserveTokens = EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens;
  const requestAllowanceTokens = totalContextTokens - instruction.tokens - outputReserveTokens;
  if (requestAllowanceTokens < 1) {
    throw budgetError(`scribe batch budget of ${totalContextTokens} tokens cannot hold the ${instruction.tokens}-token instruction and schema plus the ${outputReserveTokens}-token output reserve`);
  }

  // `limits` are the governed protocol ceilings on context *text*, which the SCRIBE-01 request
  // validator enforces. They are fixed once, before background rolls, because they are part of
  // the serialized request: recomputing them per roll would make the budget self-referential.
  // The binding constraint below is the serialized-request measurement, which is never looser.
  const limits = {
    // Char and token ceilings are held at the same tightness (the governed estimator is
    // ceil(chars / 4)) so the text ceiling and the token ceiling cannot disagree.
    max_context_chars: requestAllowanceTokens * 4,
    max_context_tokens: requestAllowanceTokens,
    max_output_chars: EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_chars,
    max_output_tokens: EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens
  };
  const assemble = (transcriptSegments, loggedItems) => ({
    protocol_version: SCRIBE_BATCH_PROTOCOL_VERSION,
    purpose: 'logged-item-extraction',
    model: modelName,
    batch_identity: structuredClone(batchIdentity),
    new_evidence_segments: structuredClone(newEvidenceSegments),
    background_context: { transcript_segments: structuredClone(transcriptSegments), prior_logged_items: structuredClone(loggedItems) },
    ...(guidance ? { additional_guidance: guidance } : {}),
    policy_profile: generation.policy_profile,
    instruction_version: instruction.version,
    limits,
    identity: { work_id: workId, session_id: batchIdentity.session_id, batch_request_id: batchIdentity.request_id }
  });

  // The mandatory floor is the request with no background at all: instruction, schema, the whole
  // serialized new evidence and its structure, and the output reserve. New evidence is the
  // authoritative reason the batch exists, so if the floor does not fit, the dispatch fails
  // visibly rather than clipping evidence and evaluating a batch that is not the recorded one.
  // User guidance sits inside this floor with the new evidence: it is a governed session-immutable
  // input, so it is never shortened to make a batch fit either.
  const mandatoryTotalTokens = instruction.tokens + serializedRequestTokens(assemble([], [])) + outputReserveTokens;
  if (mandatoryTotalTokens > totalContextTokens) {
    throw budgetError(`scribe batch mandatory instruction, schema, serialized new evidence, user guidance, and output reserve need ${mandatoryTotalTokens} tokens but the governed budget is ${totalContextTokens}; new evidence and guidance are never truncated`);
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
  //
  // The predicate measures the complete serialized request each pass. Removing a unit strictly
  // shrinks that serialization, and the mandatory floor above is already proven to fit, so the
  // loop always terminates; the pass count is bounded by the policy-bounded background pool.
  let totalTokens = instruction.tokens + serializedRequestTokens(assemble(transcriptSegments, loggedItems)) + outputReserveTokens;
  while (totalTokens > totalContextTokens) {
    if (transcriptSegments.length) {
      const oldest = oldestSegmentIndex(transcriptSegments);
      removedTranscriptSegmentIds.push(transcriptSegments[oldest].segment_id);
      transcriptSegments.splice(oldest, 1);
    } else if (loggedItems.length) {
      loggedItems.shift();
      removedPriorLoggedItems += 1;
    } else {
      throw budgetError(`scribe batch cannot fit its mandatory instruction, schema, serialized new evidence, and output reserve within ${totalContextTokens} tokens`);
    }
    totalTokens = instruction.tokens + serializedRequestTokens(assemble(transcriptSegments, loggedItems)) + outputReserveTokens;
  }

  const request = assemble(transcriptSegments, loggedItems);
  validateScribeBatchModelRequest(request);

  return {
    request,
    budget: Object.freeze({
      total_context_tokens: totalContextTokens,
      instruction_tokens: instruction.tokens,
      guidance_tokens: guidance ? estimateModelTokens(guidance) : 0,
      output_reserve_tokens: outputReserveTokens,
      request_allowance_tokens: requestAllowanceTokens,
      // The measured size of the transmission this dispatch produces, and the whole governed
      // total it consumes. `total_tokens` is the number the ~8,000-token policy actually bounds.
      serialized_request_tokens: serializedRequestTokens(request),
      total_tokens: totalTokens,
      new_evidence_text_tokens: estimateModelTokens(newEvidenceSegments),
      background_text_tokens: estimateModelTokens([...transcriptSegments, ...loggedItems]),
      removed_background_transcript_segment_ids: Object.freeze([...removedTranscriptSegmentIds]),
      removed_prior_logged_items: removedPriorLoggedItems
    })
  };
}

/**
 * Tokens for the complete request exactly as the model lane transmits it: `JSON.stringify` of the
 * governed request, placed as the user message beside the instruction system prompt. The provider's
 * own chat envelope (`model`, `stream`, `temperature`, the `messages` wrapper) is provider framing
 * rather than governed content and is deliberately outside the content budget.
 */
export function serializedRequestTokens(request) {
  return estimateModelTokens(JSON.stringify(request));
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
export function scribeBatchCompletionOutputs({ request, response, batchAttempt, evaluatedAt, instance = IMPLEMENTATION }) {
  const { items, drafts, evaluated } = evaluateScribeBatchResponse({ request, response, batchAttempt, evaluatedAt });
  return {
    items,
    evaluated,
    outputs: drafts.map((payload) => draftOutput(payload, instance))
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

export function draftOutput(payload, instance = IMPLEMENTATION) {
  const identityKey = `${instance}:logged-item.draft:${payload.item_id}:r0`;
  return {
    messageType: 'logged-item.draft',
    schemaVersion: LOGGED_ITEM_DRAFT_SCHEMA_VERSION,
    identityKey,
    messageId: deterministicMessageId(identityKey),
    payload
  };
}

export function scribeBatchWorkId(batchIdentity, batchAttempt) {
  if (!Number.isInteger(batchAttempt) || batchAttempt < 1) throw inputError('scribe batch coordinator batch_attempt must be a positive integer');
  return `logged-item-extraction:${batchIdentity.session_id}:${batchIdentity.request_id}:batch-attempt-${batchAttempt}`;
}

/**
 * Validate one Scribe batch model response and turn it into zero-to-many governed drafts plus
 * the complete evaluated-batch outcome.
 *
 * The response's whole batch identity must equal the dispatched request's before any draft
 * exists, so a stale, superseded, or provider-altered identity cannot attach a draft to a batch
 * that was never evaluated.
 */
export function evaluateScribeBatchResponse({ request, response, batchAttempt, evaluatedAt }) {
  if (canonicalJson(response?.batch_identity) !== canonicalJson(request.batch_identity)) {
    throw protocolError('SCRIBE_BATCH_IDENTITY_CONFLICT', 'scribe batch response identity does not match the dispatched batch identity');
  }
  const validated = validateScribeBatchModelResponse(response, request.limits);
  const items = validated.items.map((item) => normalizeItem(item));
  const drafts = items.map((item, index) => draftPayload({ request, item, index }));
  return { items, drafts, evaluated: scribeBatchEvaluated({ batchIdentity: request.batch_identity, batchAttempt, evaluatedAt, items }) };
}

/**
 * The evaluated-batch outcome for a settled batch, before acknowledgement.
 *
 * `acknowledgement` is deliberately unaccepted here: the terminal acknowledgement may only
 * carry Logged Item IDs the active owner actually confirmed, and the extraction path has no
 * authority to assert acceptance on the owner's behalf.
 */
export function scribeBatchEvaluated({ batchIdentity, batchAttempt, evaluatedAt, items }) {
  return {
    batch_identity: structuredClone(batchIdentity),
    evaluated_at: evaluatedAt,
    attempt: batchAttempt,
    outcome: items.length ? 'items-recorded' : 'empty-evaluated',
    items: structuredClone(items),
    acknowledgement: pendingAcknowledgement(batchIdentity, batchAttempt)
  };
}

/** The evaluated-batch outcome for a batch that failed, including a model-endpoint timeout. */
export function failedScribeBatchEvaluation({ batchIdentity, batchAttempt, evaluatedAt, error, items = [] }) {
  return {
    batch_identity: structuredClone(batchIdentity),
    evaluated_at: evaluatedAt,
    attempt: batchAttempt,
    outcome: 'failed',
    items: structuredClone(items),
    error: {
      code: error?.code || 'MODEL_REQUEST_FAILED',
      category: error?.category || 'dependency',
      message: error?.message || 'model request failed',
      retryable: error?.retryable !== false
    },
    acknowledgement: pendingAcknowledgement(batchIdentity, batchAttempt)
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
  const settled = new Map();
  const workByRequestId = new Map();
  const workByDraftMessageId = new Map();
  const settledWorkByRequestId = new Map();
  const settledWorkByDraftMessageId = new Map();

  function settle(workId, terminalEvaluation) {
    const state = pending.get(workId);
    if (!state) throw confirmationError('SCRIBE_BATCH_NOT_RETAINED', `No pending Scribe batch for work ${workId}`);
    pending.delete(workId);
    workByRequestId.delete(state.request.batch_identity.request_id);
    for (const draft of state.drafts || []) workByDraftMessageId.delete(draft.messageId);
    state.terminalEvaluation = structuredClone(terminalEvaluation);
    settled.set(workId, state);
    settledWorkByRequestId.set(state.request.batch_identity.request_id, workId);
    for (const draft of state.drafts || []) settledWorkByDraftMessageId.set(draft.messageId, workId);
    while (settled.size > capacity) {
      const [oldestWorkId, oldest] = settled.entries().next().value;
      settled.delete(oldestWorkId);
      settledWorkByRequestId.delete(oldest.request.batch_identity.request_id);
      for (const draft of oldest.drafts || []) settledWorkByDraftMessageId.delete(draft.messageId);
    }
    return structuredClone(terminalEvaluation);
  }

  return {
    get size() { return pending.size; },
    get settledSize() { return settled.size; },
    has(workId) { return pending.has(workId); },
    get(workId) { return pending.get(workId); },
    getSettled(workId) { return settled.get(workId); },
    hasActiveSession(sessionId) { return [...pending.values()].some((state) => state.request.identity.session_id === sessionId); },
    stats() { return { pending: pending.size, settled: settled.size, request_index: workByRequestId.size, draft_message_index: workByDraftMessageId.size }; },
    clear() {
      pending.clear(); settled.clear(); workByRequestId.clear(); workByDraftMessageId.clear(); settledWorkByRequestId.clear(); settledWorkByDraftMessageId.clear();
    },
    dispatch({ batch, policy, workId, modelName, queuedAt, maxAttempts = 2 }) {
      const derivedWorkId = scribeBatchWorkId(batch?.batch_identity, batch?.batch_attempt);
      if (workId !== undefined && workId !== derivedWorkId) throw workIdConflictError('offered Scribe work_id does not match the deterministic batch identity and batch_attempt', { offered_work_id: workId, expected_work_id: derivedWorkId });
      workId = derivedWorkId;
      const retained = pending.get(workId);
      const priorTerminal = settled.get(workId);
      if (!retained && !priorTerminal && pending.size >= capacity) {
        throw capacityError(`pending scribe batch capacity reached: ${capacity}`, capacity);
      }
      const { request, budget } = buildScribeBatchRequest({ batch, policy, workId, modelName });
      const requestFingerprint = fingerprintScribeBatchRequest(request);
      const admissionFingerprint = fingerprintValue(batch);
      const policyFingerprint = fingerprintValue(policy);
      const known = retained || priorTerminal;
      if (known) {
        if (known.requestFingerprint !== requestFingerprint || known.admissionFingerprint !== admissionFingerprint || known.policyFingerprint !== policyFingerprint || known.maxAttempts !== maxAttempts) {
          throw workIdConflictError(`scribe batch work ${workId} is already retained for different immutable content`, { work_id: workId, retained_request_fingerprint: known.requestFingerprint, offered_request_fingerprint: requestFingerprint });
        }
        return priorTerminal
          ? { ...priorTerminal, terminalEvaluation: structuredClone(priorTerminal.terminalEvaluation), replayed: true }
          : { ...retained, workRequest: structuredClone(retained.workRequest), replayed: true };
      }
      const workRequest = scribeBatchWorkRequest({ request, queuedAt, maxAttempts, instance });
      const state = { request, requestFingerprint, admissionFingerprint, policyFingerprint, budget, workRequest, batchAttempt: batch.batch_attempt, maxAttempts, phase: 'model', drafts: undefined, evaluated: undefined, confirmed: undefined };
      pending.set(workId, state);
      workByRequestId.set(request.batch_identity.request_id, workId);
      return { ...state, workRequest: structuredClone(workRequest), replayed: false };
    },
    beginOwnerAcknowledgement(workId, { drafts, evaluated }) {
      const state = pending.get(workId);
      if (!state || state.phase !== 'model') throw confirmationError('SCRIBE_BATCH_STATE_CONFLICT', `Scribe batch ${workId} is not awaiting a model result`);
      state.phase = 'owner-acknowledgement';
      state.drafts = drafts.map((output) => structuredClone(output));
      state.evaluated = structuredClone(evaluated);
      state.confirmed = new Array(drafts.length).fill(null);
      for (const draft of state.drafts) workByDraftMessageId.set(draft.messageId, workId);
      return state.drafts.map((draft) => structuredClone(draft));
    },
    settleEvaluation(workId, evaluated) { return settle(workId, evaluated); },
    confirmStoredItem(storedItem, { acknowledgedAt }) {
      const requestId = storedItem?.generator?.input_window_id;
      const workId = workByRequestId.get(requestId);
      if (!workId) {
        if (settledWorkByRequestId.has(requestId)) throw confirmationError('SCRIBE_OWNER_CONFIRMATION_DUPLICATE', `Scribe batch ${requestId} is already terminal`);
        return { matched: false };
      }
      const state = pending.get(workId);
      if (state.phase !== 'owner-acknowledgement') throw confirmationError('SCRIBE_OWNER_CONFIRMATION_UNEXPECTED', `Scribe batch ${requestId} is not awaiting owner confirmations`);
      const index = state.drafts.findIndex((draft) => draft.payload.item_id === storedItem?.item_id);
      if (index < 0) throw confirmationError('SCRIBE_OWNER_CONFIRMATION_UNKNOWN', `Stored item ${storedItem?.item_id} is not an expected deterministic draft for batch ${requestId}`);
      if (state.confirmed[index] !== null) throw confirmationError('SCRIBE_OWNER_CONFIRMATION_DUPLICATE', `Stored item ${storedItem.item_id} was confirmed more than once`);
      assertStoredMatchesDraft(storedItem, state.drafts[index].payload);
      state.confirmed[index] = storedItem.item_id;
      if (state.confirmed.includes(null)) return { matched: true, settled: false };
      const evaluated = structuredClone(state.evaluated);
      evaluated.acknowledgement = {
        ...evaluated.acknowledgement,
        accepted: true,
        acknowledged_at: acknowledgedAt,
        logged_item_ids: [...state.confirmed]
      };
      return { matched: true, settled: true, evaluated: settle(workId, evaluated) };
    },
    failOwnerMessage(inputMessageId, error, { evaluatedAt }) {
      const workId = workByDraftMessageId.get(inputMessageId);
      if (!workId) {
        if (settledWorkByDraftMessageId.has(inputMessageId)) throw confirmationError('SCRIBE_OWNER_CONFIRMATION_DUPLICATE', `Owner outcome for Scribe draft ${inputMessageId} arrived after terminal settlement`);
        return { matched: false };
      }
      const state = pending.get(workId);
      const evaluated = failedScribeBatchEvaluation({ batchIdentity: state.request.batch_identity, batchAttempt: state.batchAttempt, evaluatedAt, error, items: state.evaluated?.items || [] });
      return { matched: true, evaluated: settle(workId, evaluated) };
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

/**
 * Validate the optional user guidance carried by the session's immutable policy.
 *
 * Guidance may only travel under an instruction version that actually states its precedence. An
 * older instruction has no wording subordinating guidance to the role, schema, provenance, and
 * ownership rules, so sending the field anyway would hand the model unranked user text - exactly
 * the redefinition of the protected instruction this boundary exists to prevent.
 */
function normalizeGuidance(value, instructionVersion) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw inputError('scribe policy generation.additional_guidance must be a string when present');
  const guidance = value.trim();
  if (!guidance) return undefined;
  if (guidance.length > SCRIBE_GUIDANCE_LIMITS.max_chars) {
    throw budgetError(`scribe user guidance is ${guidance.length} characters but the governed limit is ${SCRIBE_GUIDANCE_LIMITS.max_chars}; guidance is never truncated`);
  }
  if (compareInstructionVersions(instructionVersion, SCRIBE_GUIDANCE_INSTRUCTION_VERSION) < 0) {
    throw inputError(`scribe user guidance requires instruction version ${SCRIBE_GUIDANCE_INSTRUCTION_VERSION} or later, but the batch was admitted under ${instructionVersion}`);
  }
  return guidance;
}

function compareInstructionVersions(left, right) {
  const leftParts = String(left).split('.').map(Number);
  const rightParts = String(right).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function assertPolicyAgreement(batch, policy, generation) {
  const batchIdentity = batch.batch_identity;
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
  if (batch.policy_profile !== generation.policy_profile) throw inputError('scribe batch policy_profile does not match the accepted policy generation.policy_profile');
  if (batch.instruction_version !== generation.instruction_version || batch.instruction_version !== batchIdentity.instruction_version) throw inputError('scribe batch instruction_version does not match the accepted policy and batch identity');
}

function assertStoredMatchesDraft(stored, draft) {
  const matches = stored?.item_id === draft.item_id
    && stored.session_id === draft.session_id
    && stored.stored_at === draft.created_at
    && stored.text === draft.text
    && stored.revision === draft.revision
    && stored.revision_id === draft.revision_id
    && canonicalJson(stored.source) === canonicalJson(draft.source)
    && canonicalJson(stored.generator) === canonicalJson(draft.generator);
  if (!matches) throw confirmationError('SCRIBE_OWNER_CONFIRMATION_CONFLICT', `Stored item ${stored?.item_id} does not exactly confirm its deterministic Scribe draft`);
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
function capacityError(message, capacity) { return new Error(message, { cause: { code: 'SCRIBE_BATCH_PENDING_FULL', category: 'unavailable', details: { capacity } } }); }
function workIdConflictError(message, details) { return new Error(message, { cause: { code: 'SCRIBE_BATCH_WORK_ID_CONFLICT', category: 'conflict', details } }); }
function confirmationError(code, message) { return new Error(message, { cause: { code, category: 'conflict' } }); }
