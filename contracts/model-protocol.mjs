import { createHash } from 'node:crypto';

export const MODEL_PROTOCOL_VERSION = '1.0.0';
export const EXTRACTION_OUTPUT_LIMITS = Object.freeze({ max_output_chars: 512, max_output_tokens: 128 });
export const CLASSIFICATION_OUTPUT_LIMITS = Object.freeze({ max_output_chars: 128, max_output_tokens: 32 });
export const MODEL_PURPOSE_BY_WORKLOAD = Object.freeze({
  'logged-item-extraction': 'logged-item-extraction',
  'classification-enrichment': 'classification-enrichment'
});
const CLASSIFICATIONS = new Set(['task', 'note', 'observation', 'idea']);

// Scribe batch protocol (ADR-021/ADR-022, SCRIBE-01). This is a distinct, explicitly
// versioned protocol for the zero-to-many batch-shaped `logged-item-extraction` request
// and response, additive to the 1.0.0 single-window/single-text protocol above. Nothing
// in the current production path (services/log-extractor-local-http,
// services/serial-ai-model-lane) calls these; they exist so SCRIBE-02/03 can wire the
// batch coordinator against a governed, already-proven shape.
export const SCRIBE_BATCH_PROTOCOL_VERSION = '2.0.0';
export const SCRIBE_ITEM_KINDS = Object.freeze(['action', 'decision', 'open-question', 'reminder', 'other']);
// max_items/max_item_chars mirror EXTRACTION_OUTPUT_LIMITS.max_output_chars per item (the
// existing single-item ceiling); max_output_chars/tokens bound the whole batch response so
// a multi-item reply cannot grow unbounded merely because each item alone is in-limit.
export const EXTRACTION_BATCH_OUTPUT_LIMITS = Object.freeze({
  max_items: 8,
  max_item_chars: 512,
  max_output_chars: 2048,
  max_output_tokens: 512
});
// Optional user Scribe guidance (SCRIBE-05B). 2000 chars is ~500 governed tokens, so even a
// maximum-length guidance leaves the instruction, the whole new evidence, and the output reserve
// inside the ~8000-token policy budget. Guidance is never truncated to fit: an over-budget request
// fails visibly at the extraction boundary instead of silently prompting under shortened wording.
export const SCRIBE_GUIDANCE_LIMITS = Object.freeze({ max_chars: 2000 });

/** Stable governed identity for the normalized text of one Scribe guidance setting. */
export function fingerprintScribeGuidance(guidance) {
  const value = typeof guidance === 'string' ? guidance.trim() : '';
  return `sha256:${createHash('sha256').update(`v1:${value}`).digest('hex')}`;
}

export function fingerprintModelRequest(request) {
  return `sha256:${createHash('sha256').update(JSON.stringify(request)).digest('hex')}`;
}

export function assertPurposeMatchesWorkload(purpose, workload) {
  if (MODEL_PURPOSE_BY_WORKLOAD[workload] !== purpose) {
    throw protocolError('MODEL_PURPOSE_WORKLOAD_CONFLICT', `model purpose ${purpose} does not match workload ${workload}`);
  }
}

export function validateModelRequest(request, expectedPurpose) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw protocolError('INVALID_MODEL_REQUEST', 'model request must be an object');
  if (request.protocol_version !== MODEL_PROTOCOL_VERSION) throw protocolError('INVALID_MODEL_REQUEST', `model protocol version must be ${MODEL_PROTOCOL_VERSION}`);
  if (expectedPurpose && request.purpose !== expectedPurpose) throw protocolError('MODEL_PURPOSE_WORKLOAD_CONFLICT', `model purpose must be ${expectedPurpose}`);
  if (!request.model || typeof request.model !== 'string') throw protocolError('INVALID_MODEL_REQUEST', 'model name is required');
  validateLimits(request.limits);
  if (!request.policy_profile || !request.instruction_version) throw protocolError('INVALID_MODEL_REQUEST', 'policy profile and instruction version are required');

  if (request.purpose === 'logged-item-extraction') {
    requireExactKeys(request, ['protocol_version', 'purpose', 'model', 'authoritative_source_segments', 'bounded_context_segments', 'policy_profile', 'instruction_version', 'limits', 'identity']);
    validateIdentity(request.identity, ['work_id', 'session_id', 'context_window_id']);
    validateSegments(request.authoritative_source_segments, false);
    validateSegments(request.bounded_context_segments, true);
    validateContextBudget([...request.authoritative_source_segments, ...request.bounded_context_segments], request.limits);
    return request;
  }

  if (request.purpose === 'classification-enrichment') {
    requireExactKeys(request, ['protocol_version', 'purpose', 'model', 'authoritative_logged_item', 'source_range', 'source_transcript', 'lookback_context', 'forward_context', 'evidence_segment_ids', 'policy_profile', 'instruction_version', 'limits', 'identity']);
    validateIdentity(request.identity, ['work_id', 'session_id', 'item_id', 'item_revision']);
    requireExactKeys(request.authoritative_logged_item, ['item_id', 'revision', 'text', 'source']);
    if (request.authoritative_logged_item.item_id !== request.identity.item_id || request.authoritative_logged_item.revision !== request.identity.item_revision) throw protocolError('INVALID_MODEL_REQUEST', 'classification item identity must match the work identity');
    if (typeof request.authoritative_logged_item.text !== 'string' || !request.authoritative_logged_item.text.trim()) throw protocolError('INVALID_MODEL_REQUEST', 'classification item text is required');
    validateSourceRange(request.authoritative_logged_item.source);
    validateSourceRange(request.source_range);
    if (JSON.stringify(request.authoritative_logged_item.source) !== JSON.stringify(request.source_range)) throw protocolError('INVALID_MODEL_REQUEST', 'classification source range must match the authoritative item');
    validateSegments(request.source_transcript, false);
    validateSegments(request.lookback_context, true, 'lookback');
    validateSegments(request.forward_context, true, 'forward');
    if (!Array.isArray(request.evidence_segment_ids) || !request.evidence_segment_ids.length || request.evidence_segment_ids.some((id) => typeof id !== 'string' || !id)) throw protocolError('INVALID_MODEL_REQUEST', 'classification evidence segment identifiers are required');
    validateContextBudget([...request.source_transcript, ...request.lookback_context, ...request.forward_context, { text: request.authoritative_logged_item.text }], request.limits);
    return request;
  }

  throw protocolError('INVALID_MODEL_REQUEST', `unsupported model purpose: ${request.purpose}`);
}

export function validateModelResponse(response, expectedPurpose, limits) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw protocolError('INVALID_MODEL_OUTPUT', 'model response must be a JSON object');
  if (response.protocol_version !== MODEL_PROTOCOL_VERSION || response.purpose !== expectedPurpose) throw protocolError('INVALID_MODEL_OUTPUT', 'model response protocol identity does not match the request');
  if (expectedPurpose === 'logged-item-extraction') {
    requireExactKeys(response, ['protocol_version', 'purpose', 'text'], 'INVALID_MODEL_OUTPUT');
    if (typeof response.text !== 'string' || !response.text.trim()) throw protocolError('INVALID_MODEL_OUTPUT', 'extraction response text must be non-empty');
    enforceOutputLimits(response.text, limits);
    return { protocol_version: MODEL_PROTOCOL_VERSION, purpose: expectedPurpose, text: response.text.trim() };
  }
  if (expectedPurpose === 'classification-enrichment') {
    requireExactKeys(response, ['protocol_version', 'purpose', 'suggested_classification', 'confidence'], 'INVALID_MODEL_OUTPUT');
    if (!CLASSIFICATIONS.has(response.suggested_classification)) throw protocolError('INVALID_MODEL_OUTPUT', 'classification is outside the governed enum');
    if (typeof response.confidence !== 'number' || response.confidence < 0 || response.confidence > 1) throw protocolError('INVALID_MODEL_OUTPUT', 'classification confidence must be between 0 and 1');
    enforceOutputLimits(JSON.stringify(response), limits);
    return { protocol_version: MODEL_PROTOCOL_VERSION, purpose: expectedPurpose, suggested_classification: response.suggested_classification, confidence: response.confidence };
  }
  throw protocolError('INVALID_MODEL_OUTPUT', `unsupported model purpose: ${expectedPurpose}`);
}

export function estimateModelTokens(value) {
  const text = Array.isArray(value) ? value.map((item) => item.text).join(' ') : String(value);
  return Math.max(1, Math.ceil(text.length / 4));
}

export function protocolError(code, message) {
  return new Error(message, { cause: { code, category: 'validation' } });
}

function validateIdentity(identity, keys) {
  requireExactKeys(identity, keys);
  for (const key of keys) if (typeof identity[key] !== 'string' && !(key === 'item_revision' && Number.isInteger(identity[key]))) throw protocolError('INVALID_MODEL_REQUEST', `model identity ${key} is required`);
  if (Number.isInteger(identity.item_revision) && identity.item_revision < 0) throw protocolError('INVALID_MODEL_REQUEST', 'item revision must be non-negative');
}

function validateLimits(limits) {
  requireExactKeys(limits, ['max_context_chars', 'max_context_tokens', 'max_output_chars', 'max_output_tokens']);
  for (const key of Object.keys(limits)) if (!Number.isInteger(limits[key]) || limits[key] < 1) throw protocolError('INVALID_MODEL_REQUEST', `model limit ${key} must be a positive integer`);
}

function validateSourceRange(source) {
  requireExactKeys(source, ['first_segment_id', 'last_segment_id', 'start_time', 'end_time']);
  for (const key of Object.keys(source)) if (typeof source[key] !== 'string' || !source[key]) throw protocolError('INVALID_MODEL_REQUEST', `source range ${key} is required`);
}

function validateSegments(segments, related, requiredRelation, includeRevision = false) {
  if (!Array.isArray(segments)) throw protocolError('INVALID_MODEL_REQUEST', 'model transcript context must be an array');
  for (const segment of segments) {
    const keys = related ? ['segment_id', 'sequence', 'start_time', 'end_time', 'text', 'relation'] : ['segment_id', ...(includeRevision ? ['revision'] : []), 'sequence', 'start_time', 'end_time', 'text'];
    requireExactKeys(segment, keys);
    if (typeof segment.segment_id !== 'string' || !segment.segment_id || !Number.isInteger(segment.sequence) || segment.sequence < 0 || typeof segment.start_time !== 'string' || typeof segment.end_time !== 'string' || typeof segment.text !== 'string' || !segment.text) throw protocolError('INVALID_MODEL_REQUEST', 'model transcript segment is invalid');
    if (includeRevision && (!Number.isInteger(segment.revision) || segment.revision < 0)) throw protocolError('INVALID_MODEL_REQUEST', 'scribe new evidence segment revision must be a non-negative integer');
    if (requiredRelation && segment.relation !== requiredRelation) throw protocolError('INVALID_MODEL_REQUEST', `model context segment must be ${requiredRelation}`);
    if (related && !['lookback', 'forward'].includes(segment.relation)) throw protocolError('INVALID_MODEL_REQUEST', 'model context relation is invalid');
  }
}

function validateContextBudget(segments, limits) {
  const chars = segments.reduce((sum, item, index) => sum + item.text.length + (index ? 1 : 0), 0);
  if (chars > limits.max_context_chars || estimateModelTokens(segments) > limits.max_context_tokens) throw protocolError('INVALID_MODEL_REQUEST', 'model context exceeds the declared limits');
}

function enforceOutputLimits(text, limits) {
  if (text.length > limits.max_output_chars || estimateModelTokens(text) > limits.max_output_tokens) throw protocolError('INVALID_MODEL_OUTPUT', 'model output exceeds the declared limits');
}

function requireExactKeys(value, keys, code = 'INVALID_MODEL_REQUEST') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError(code, 'model protocol object is required');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw protocolError(code, 'model protocol object contains an unexpected field');
}

export function validateScribeBatchModelRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw protocolError('INVALID_MODEL_REQUEST', 'model request must be an object');
  if (request.protocol_version !== SCRIBE_BATCH_PROTOCOL_VERSION) throw protocolError('INVALID_MODEL_REQUEST', `scribe batch protocol version must be ${SCRIBE_BATCH_PROTOCOL_VERSION}`);
  if (request.purpose !== 'logged-item-extraction') throw protocolError('INVALID_MODEL_REQUEST', 'scribe batch request purpose must be logged-item-extraction');
  // `additional_guidance` is optional and declared only when present, so a request without user
  // guidance keeps exactly the key set SCRIBE-01 shipped and still validates unchanged.
  const guidanceKeys = request.additional_guidance !== undefined ? ['additional_guidance'] : [];
  requireExactKeys(request, ['protocol_version', 'purpose', 'model', 'batch_identity', 'new_evidence_segments', 'background_context', 'policy_profile', 'instruction_version', 'limits', 'identity', ...guidanceKeys]);
  if (request.additional_guidance !== undefined) {
    if (typeof request.additional_guidance !== 'string' || !request.additional_guidance.trim()) {
      throw protocolError('INVALID_MODEL_REQUEST', 'scribe additional_guidance must be a non-empty string when present');
    }
    if (request.additional_guidance.length > SCRIBE_GUIDANCE_LIMITS.max_chars) {
      throw protocolError('INVALID_MODEL_REQUEST', `scribe additional_guidance exceeds the governed ${SCRIBE_GUIDANCE_LIMITS.max_chars}-character limit`);
    }
  }
  if (!request.model || typeof request.model !== 'string') throw protocolError('INVALID_MODEL_REQUEST', 'model name is required');
  validateLimits(request.limits);
  if (!request.policy_profile || !request.instruction_version) throw protocolError('INVALID_MODEL_REQUEST', 'policy profile and instruction version are required');
  requireExactKeys(request.identity, ['work_id', 'session_id', 'batch_request_id']);
  for (const key of ['work_id', 'session_id', 'batch_request_id']) {
    if (typeof request.identity[key] !== 'string' || !request.identity[key]) throw protocolError('INVALID_MODEL_REQUEST', `scribe batch identity ${key} is required`);
  }

  const batchIdentity = validateScribeBatchIdentity(request.batch_identity);
  if (request.identity.session_id !== request.batch_identity.session_id) {
    throw protocolError('INVALID_MODEL_REQUEST', 'scribe request identity session_id must match the batch identity session_id');
  }
  if (request.identity.batch_request_id !== request.batch_identity.request_id) {
    throw protocolError('INVALID_MODEL_REQUEST', 'scribe request identity batch_request_id must match the batch identity request_id');
  }
  if (request.instruction_version !== request.batch_identity.instruction_version) {
    throw protocolError('INVALID_MODEL_REQUEST', 'scribe request instruction_version must match the batch identity instruction_version');
  }

  validateSegments(request.new_evidence_segments, false, undefined, true);
  if (request.new_evidence_segments.length !== batchIdentity.segments.length) {
    throw protocolError('INVALID_MODEL_REQUEST', 'scribe new evidence segments must exactly match the batch identity segment order and count');
  }
  request.new_evidence_segments.forEach((segment, index) => {
    const expected = batchIdentity.segments[index];
    if (segment.segment_id !== expected.segment_id || segment.revision !== expected.revision || segment.sequence !== expected.sequence) {
      throw protocolError('INVALID_MODEL_REQUEST', 'scribe new evidence segments must exactly match the batch identity segment order, revision, and sequence');
    }
  });
  const newEvidenceIds = batchIdentity.segmentIds;

  requireExactKeys(request.background_context, ['transcript_segments', 'prior_logged_items']);
  validateSegments(request.background_context.transcript_segments, true);
  for (const backgroundSegment of request.background_context.transcript_segments) {
    if (newEvidenceIds.has(backgroundSegment.segment_id)) {
      throw protocolError('INVALID_MODEL_REQUEST', 'scribe background context cannot represent a new-evidence segment as background');
    }
  }
  for (const priorItem of request.background_context.prior_logged_items) validateScribeProposedItem(priorItem, 'INVALID_MODEL_REQUEST');

  validateContextBudget([...request.new_evidence_segments, ...request.background_context.transcript_segments, ...request.background_context.prior_logged_items], request.limits);
  return request;
}

export function validateScribeBatchModelResponse(response, limits) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw protocolError('INVALID_MODEL_OUTPUT', 'model response must be a JSON object');
  if (response.protocol_version !== SCRIBE_BATCH_PROTOCOL_VERSION || response.purpose !== 'logged-item-extraction') {
    throw protocolError('INVALID_MODEL_OUTPUT', 'model response protocol identity does not match the request');
  }
  requireExactKeys(response, ['protocol_version', 'purpose', 'batch_identity', 'items'], 'INVALID_MODEL_OUTPUT');
  const batchIdentity = validateScribeBatchIdentity(response.batch_identity, 'INVALID_MODEL_OUTPUT');
  if (!Array.isArray(response.items)) throw protocolError('INVALID_MODEL_OUTPUT', 'scribe batch items must be an array');
  if (response.items.length > EXTRACTION_BATCH_OUTPUT_LIMITS.max_items) throw protocolError('INVALID_MODEL_OUTPUT', 'scribe batch item count exceeds the declared limit');
  for (const item of response.items) validateScribeProposedItem(item, 'INVALID_MODEL_OUTPUT', batchIdentity.segmentIds);
  const totalChars = response.items.reduce((sum, item) => sum + item.text.length, 0);
  if (totalChars > EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_chars) throw protocolError('INVALID_MODEL_OUTPUT', 'scribe batch output exceeds the declared total character limit');
  if (estimateModelTokens(response.items) > (limits?.max_output_tokens ?? EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens)) {
    throw protocolError('INVALID_MODEL_OUTPUT', 'scribe batch output exceeds the declared total token limit');
  }
  return { protocol_version: SCRIBE_BATCH_PROTOCOL_VERSION, purpose: 'logged-item-extraction', batch_identity: response.batch_identity, items: response.items };
}

function validateScribeProposedItem(item, code = 'INVALID_MODEL_REQUEST', allowedSourceIds = null) {
  if ('item_id' in (item || {}) || 'revision' in (item || {})) {
    throw protocolError(code, 'scribe batch item cannot carry a provider-forged authoritative item_id or revision');
  }
  const allowedKeys = item && item.kind !== undefined ? ['text', 'kind', 'source_segment_ids'] : ['text', 'source_segment_ids'];
  requireExactKeys(item, allowedKeys, code);
  if (typeof item.text !== 'string' || !item.text.trim()) throw protocolError(code, 'scribe batch item text must be non-empty');
  if (item.text.length > EXTRACTION_BATCH_OUTPUT_LIMITS.max_item_chars) throw protocolError(code, 'scribe batch item text exceeds the declared limit');
  if (item.kind !== undefined && !SCRIBE_ITEM_KINDS.includes(item.kind)) throw protocolError(code, 'scribe batch item kind is outside the governed enum');
  if (!Array.isArray(item.source_segment_ids) || !item.source_segment_ids.length || item.source_segment_ids.some((id) => typeof id !== 'string' || !id)) {
    throw protocolError(code, 'scribe batch item source segment identifiers are required');
  }
  if (new Set(item.source_segment_ids).size !== item.source_segment_ids.length) throw protocolError(code, 'scribe batch item source segment identifiers must be unique');
  if (allowedSourceIds && item.source_segment_ids.some((id) => !allowedSourceIds.has(id))) {
    throw protocolError(code, 'scribe batch item source segment identifiers must be within the evaluated batch');
  }
}

function validateScribeBatchIdentity(identity, code = 'INVALID_MODEL_REQUEST') {
  requireExactKeys(identity, ['request_id', 'session_id', 'segments', 'first_sequence', 'last_sequence', 'admission_reason', 'policy_id', 'policy_version', 'instruction_version'], code);
  if (typeof identity.request_id !== 'string' || !identity.request_id) throw protocolError(code, 'scribe batch request_id is required');
  if (typeof identity.session_id !== 'string' || !identity.session_id) throw protocolError(code, 'scribe batch session_id is required');
  if (!Array.isArray(identity.segments) || !identity.segments.length) throw protocolError(code, 'scribe batch segments are required');
  const segmentIds = new Set();
  for (let index = 0; index < identity.segments.length; index += 1) {
    const segment = identity.segments[index];
    requireExactKeys(segment, ['segment_id', 'revision', 'sequence'], code);
    if (typeof segment.segment_id !== 'string' || !segment.segment_id) throw protocolError(code, 'scribe batch segment segment_id is required');
    if (!Number.isInteger(segment.revision) || segment.revision < 0) throw protocolError(code, 'scribe batch segment revision must be a non-negative integer');
    if (!Number.isInteger(segment.sequence) || segment.sequence < 0) throw protocolError(code, 'scribe batch segment sequence must be a non-negative integer');
    if (segmentIds.has(segment.segment_id)) throw protocolError(code, 'scribe batch segments must not repeat a segment_id');
    segmentIds.add(segment.segment_id);
    if (index > 0 && segment.sequence !== identity.segments[index - 1].sequence + 1) {
      throw protocolError(code, 'scribe batch segments must be an ordered, contiguous, gap-free sequence');
    }
  }
  if (identity.first_sequence !== identity.segments[0].sequence || identity.last_sequence !== identity.segments.at(-1).sequence) {
    throw protocolError(code, 'scribe batch first_sequence/last_sequence must match the segment range');
  }
  if (!['batch-complete', 'idle-timeout'].includes(identity.admission_reason)) throw protocolError(code, 'scribe batch admission_reason is invalid');
  if (!identity.policy_id || !identity.policy_version || !identity.instruction_version) throw protocolError(code, 'scribe batch policy/instruction identity is required');
  return { segmentIds, segments: identity.segments };
}
