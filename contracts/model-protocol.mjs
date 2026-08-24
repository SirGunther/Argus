import { createHash } from 'node:crypto';

export const MODEL_PROTOCOL_VERSION = '1.0.0';
export const EXTRACTION_OUTPUT_LIMITS = Object.freeze({ max_output_chars: 512, max_output_tokens: 128 });
export const CLASSIFICATION_OUTPUT_LIMITS = Object.freeze({ max_output_chars: 128, max_output_tokens: 32 });
export const MODEL_PURPOSE_BY_WORKLOAD = Object.freeze({
  'logged-item-extraction': 'logged-item-extraction',
  'classification-enrichment': 'classification-enrichment'
});
const CLASSIFICATIONS = new Set(['task', 'note', 'observation', 'idea']);

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

function validateSegments(segments, related, requiredRelation) {
  if (!Array.isArray(segments)) throw protocolError('INVALID_MODEL_REQUEST', 'model transcript context must be an array');
  for (const segment of segments) {
    const keys = related ? ['segment_id', 'sequence', 'start_time', 'end_time', 'text', 'relation'] : ['segment_id', 'sequence', 'start_time', 'end_time', 'text'];
    requireExactKeys(segment, keys);
    if (typeof segment.segment_id !== 'string' || !segment.segment_id || !Number.isInteger(segment.sequence) || segment.sequence < 0 || typeof segment.start_time !== 'string' || typeof segment.end_time !== 'string' || typeof segment.text !== 'string' || !segment.text) throw protocolError('INVALID_MODEL_REQUEST', 'model transcript segment is invalid');
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
