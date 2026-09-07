import { EXTRACTION_BATCH_OUTPUT_LIMITS, SCRIBE_BATCH_PROTOCOL_VERSION, validateScribeBatchModelRequest } from '../../contracts/model-protocol.mjs';
import { ServiceOperationError } from '../../runtime/service-protocol.mjs';

// PROVISIONAL wire-adaptation seam, isolated from coordinator.mjs's admission/acknowledgement
// state machine on purpose: SCRIBE-02's own ticket scope excludes model prompts, provider calls,
// and durable storage, so this module has no real bounded Scribe context to offer (no access to
// SCRIBE-03's session storage) and no real prompt/instruction assembly to perform (SCRIBE-04's
// services/log-extractor-local-http/ owns that). `background_context` is emitted empty
// (structurally valid; contracts/ai-work-request.schema.json places no minItems on either array)
// purely so this standalone service can produce a contract-valid `ai.work-request` on its own.
// SCRIBE-05 is expected to supply real background context and provider/model configuration when
// it wires the coordinator to storage and the extractor; keeping that assembly in one small,
// separately named file (rather than mixed into coordinator dispatch/admission logic) narrows
// what SCRIBE-05 needs to touch to do so, without SCRIBE-02 fabricating a new domain contract to
// carry it.
export function buildModelRequestEnvelope(dispatch, { modelName }) {
  const policy = dispatch.policy;
  const maxContextTokens = policy.context.max_total_context_tokens;
  const request = {
    protocol_version: SCRIBE_BATCH_PROTOCOL_VERSION,
    purpose: 'logged-item-extraction',
    model: modelName,
    batch_identity: dispatch.batchIdentity,
    new_evidence_segments: dispatch.newEvidenceSegments,
    background_context: { transcript_segments: [], prior_logged_items: [] },
    policy_profile: policy.generation.policy_profile,
    instruction_version: policy.generation.instruction_version,
    limits: {
      max_context_chars: maxContextTokens * 4,
      max_context_tokens: maxContextTokens,
      max_output_chars: EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_chars,
      max_output_tokens: EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens
    },
    identity: { work_id: dispatch.workId, session_id: dispatch.sessionId, batch_request_id: dispatch.batchIdentity.request_id }
  };
  try {
    validateScribeBatchModelRequest(request);
  } catch (error) {
    throw new ServiceOperationError(error.message, { code: error.cause?.code || 'INVALID_MODEL_REQUEST', category: 'validation' });
  }
  return request;
}

export function readModelName(env = process.env) {
  const modelName = String(env.ARGUS_MODEL_NAME || '').trim();
  if (!modelName) throw new ServiceOperationError('ARGUS_MODEL_NAME is required', { code: 'INVALID_MODEL_CONFIGURATION', category: 'validation' });
  return modelName;
}

// ADR-021's "preserve ... exact request fingerprint across retry" invariant means the *content*
// fingerprint used for dispatch/result correlation must stay identical across attempts of the
// identical batch, even though `identity.work_id` is deliberately attempt-specific (each retry is
// tracked as its own `ai.work-request`/work_id). Fingerprinting the request as transmitted would
// make every retry's fingerprint differ purely because of that tracking id, which would falsely
// read as content drift between attempts. Fingerprint a clone with `identity.work_id` normalized
// to the attempt-invariant `batch_request_id` instead. This is a coordinator-established
// convention: SCRIBE-04's extractor must compute `result.request_fingerprint` the same way for
// `acceptWorkCompleted`'s fingerprint-correlation check in coordinator.mjs to succeed.
export function stableFingerprintInput(request) {
  return { ...request, identity: { ...request.identity, work_id: request.identity.batch_request_id } };
}
