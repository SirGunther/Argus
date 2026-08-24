import { createHash } from 'node:crypto';
import { EXTRACTION_OUTPUT_LIMITS, fingerprintModelRequest, validateModelRequest } from '../../contracts/model-protocol.mjs';

export { EXTRACTION_OUTPUT_LIMITS };

export function readModelName(env = process.env) {
  const modelName = String(env.ARGUS_MODEL_NAME || '').trim();
  if (!modelName) throw new Error('ARGUS_MODEL_NAME is required', { cause: { code: 'INVALID_MODEL_CONFIGURATION' } });
  return modelName;
}

export function buildExtractionRequest(window, { workId, modelName }) {
  validateContextWindow(window);
  const directive = window.generation_directive;
  const contextSegments = structuredClone(window.context_segments || []);
  const maxContextChars = directive.context_scope.max_context_chars;
  const request = {
    protocol_version: '1.0.0',
    purpose: 'logged-item-extraction',
    model: modelName,
    authoritative_source_segments: structuredClone(window.segments),
    bounded_context_segments: contextSegments,
    policy_profile: directive.policy_profile,
    instruction_version: directive.instruction_version,
    limits: { max_context_chars: maxContextChars, max_context_tokens: Math.max(1, Math.ceil(maxContextChars / 4)), ...EXTRACTION_OUTPUT_LIMITS },
    identity: { work_id: workId, session_id: window.session_id, context_window_id: window.window_id }
  };
  validateModelRequest(request, 'logged-item-extraction');
  return request;
}

export function fingerprintRequest(request) {
  return fingerprintModelRequest(request);
}

export function stableItemId(window) {
  return `logged-item-${createHash('sha256').update(JSON.stringify({ session_id: window.session_id, window_id: window.window_id })).digest('hex').slice(0, 24)}`;
}

function validateContextWindow(window) {
  if (!window?.window_id || !window.session_id || !Array.isArray(window.segments) || !window.segments.length) throw invalidModelInput('a finalized context window is required');
  const source = window.segments;
  const first = source[0], last = source.at(-1);
  const expectedSource = { first_segment_id: first.segment_id, last_segment_id: last.segment_id, start_time: first.start_time, end_time: last.end_time };
  if (JSON.stringify(window.source) !== JSON.stringify(expectedSource)) throw invalidModelInput('authoritative source provenance does not match the first and last finalized segments');
  const directive = window.generation_directive;
  if (!directive || directive.purpose !== 'logged-item-extraction' || !directive.policy_profile || !directive.instruction_version || !directive.context_scope) throw invalidModelInput('generation policy and instruction version are required');
  const scope = directive.context_scope;
  const contextSegments = window.context_segments || [];
  const sourceIds = new Set(source.map((item) => item.segment_id));
  const seen = new Set(sourceIds);
  let lookback = 0, forward = 0;
  for (const item of contextSegments) {
    if (!item?.segment_id || seen.has(item.segment_id)) throw invalidModelInput('context segments must not duplicate authoritative source segments or each other');
    seen.add(item.segment_id);
    if (item.relation === 'lookback') lookback += 1;
    else if (item.relation === 'forward') forward += 1;
    else throw invalidModelInput('context segment relation must be lookback or forward');
  }
  if (lookback > scope.lookback_segment_count || forward > scope.forward_segment_count) throw invalidModelInput('context exceeds the permitted lookback or forward bound');
  if (!Number.isInteger(scope.max_context_chars) || scope.max_context_chars < 1) throw invalidModelInput('declared context character limit is required');
}

function invalidModelInput(message) { return new Error(message, { cause: { code: 'INVALID_MODEL_INPUT' } }); }
