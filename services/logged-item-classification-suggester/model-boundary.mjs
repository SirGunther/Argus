import { CLASSIFICATION_OUTPUT_LIMITS, fingerprintModelRequest, validateModelRequest } from '../../contracts/model-protocol.mjs';

export { CLASSIFICATION_OUTPUT_LIMITS, fingerprintModelRequest as fingerprintRequest };

export function readModelName(env = process.env) {
  const modelName = String(env.ARGUS_MODEL_NAME || '').trim();
  if (!modelName) throw new Error('ARGUS_MODEL_NAME is required', { cause: { code: 'INVALID_MODEL_CONFIGURATION' } });
  return modelName;
}

export function buildClassificationRequest(item, contextWindow, { workId, modelName }) {
  validateStoredItem(item);
  validateContextForItem(item, contextWindow);
  const directive = contextWindow.generation_directive;
  const lookbackContext = structuredClone((contextWindow.context_segments || []).filter((segment) => segment.relation === 'lookback'));
  const forwardContext = structuredClone((contextWindow.context_segments || []).filter((segment) => segment.relation === 'forward'));
  const sourceTranscript = structuredClone(contextWindow.segments);
  const request = {
    protocol_version: '1.0.0',
    purpose: 'classification-enrichment',
    model: modelName,
    authoritative_logged_item: { item_id: item.item_id, revision: item.revision, text: item.text, source: structuredClone(item.source) },
    source_range: structuredClone(item.source),
    source_transcript: sourceTranscript,
    lookback_context: lookbackContext,
    forward_context: forwardContext,
    evidence_segment_ids: [...sourceTranscript, ...lookbackContext, ...forwardContext].map((segment) => segment.segment_id),
    policy_profile: 'neutral-logged-item-classification',
    instruction_version: '1.0.0',
    limits: { max_context_chars: directive.context_scope.max_context_chars, max_context_tokens: Math.max(1, Math.ceil(directive.context_scope.max_context_chars / 4)), ...CLASSIFICATION_OUTPUT_LIMITS },
    identity: { work_id: workId, session_id: item.session_id, item_id: item.item_id, item_revision: item.revision }
  };
  validateModelRequest(request, 'classification-enrichment');
  return request;
}

function validateStoredItem(item) {
  if (!item?.item_id || !item.session_id || !Number.isInteger(item.revision) || item.revision < 0 || !item.text?.trim()) throw invalidModelInput('stored logged item identity, revision, and text are required');
  if (!item.source?.first_segment_id || !item.source.last_segment_id || !item.source.start_time || !item.source.end_time) throw invalidModelInput('stored logged item provenance is required');
  if (!item.generator?.input_window_id) throw invalidModelInput('stored logged item context-window identity is required');
}

function validateContextForItem(item, contextWindow) {
  if (!contextWindow?.window_id || contextWindow.window_id !== item.generator.input_window_id) throw invalidModelInput('classification must receive the exact context window that generated the item');
  if (contextWindow.session_id !== item.session_id || !Array.isArray(contextWindow.segments) || !contextWindow.segments.length) throw invalidModelInput('classification context session and source transcript are required');
  const first = contextWindow.segments[0], last = contextWindow.segments.at(-1);
  const expectedSource = { first_segment_id: first.segment_id, last_segment_id: last.segment_id, start_time: first.start_time, end_time: last.end_time };
  if (JSON.stringify(item.source) !== JSON.stringify(expectedSource)) throw invalidModelInput('classification item provenance must match the explicit context window');
  const directive = contextWindow.generation_directive;
  if (!directive?.context_scope || !Number.isInteger(directive.context_scope.max_context_chars) || directive.context_scope.max_context_chars < 1) throw invalidModelInput('classification context bounds are required');
  const contexts = contextWindow.context_segments || [];
  const lookback = contexts.filter((segment) => segment.relation === 'lookback').length;
  const forward = contexts.filter((segment) => segment.relation === 'forward').length;
  if (lookback > directive.context_scope.lookback_segment_count || forward > directive.context_scope.forward_segment_count) throw invalidModelInput('classification context exceeds the explicit lookback/forward bounds');
}

function invalidModelInput(message) { return new Error(message, { cause: { code: 'INVALID_MODEL_INPUT' } }); }
