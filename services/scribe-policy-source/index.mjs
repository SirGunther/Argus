import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { fingerprintScribeGuidance } from '../../contracts/model-protocol.mjs';
import { SCRIBE_GUIDANCE_INSTRUCTION_VERSION, scribeBatchInstruction } from '../../contracts/scribe-instruction.mjs';

// The governed Scribe policy is published per real recording session, not per graph run.
// `lifecycle.start` carries the run configuration but its session is the graph bootstrap
// identity, which owns no durable session directory; requesting Scribe recovery for it would
// fail against session storage. Session lifecycle outcomes carry the authoritative session id,
// so the template is retained at start and projected when a session actually begins recording
// or resumes.
const SERVICE = 'scribe-policy-source';
const SCRIBE_GUIDANCE_MAX_CHARS = 2000;
// One entry per live session, matching the extraction boundary's retained-policy ceiling. The
// host re-sends a session's snapshot on every resume, so evicting the oldest entry loses nothing
// durable: the durable copy lives with the session, not here.
const MAX_RETAINED_GUIDANCE = 8;
let template;
const sessionGuidance = new Map();

runLineService({ service: SERVICE, operations: {
  'lifecycle.start': { name: 'retain-scribe-batch-policy', handle(message) {
    const configured = message.payload?.configuration?.scribe_policy;
    if (!configured) throw invalid('configuration.scribe_policy is required to govern Scribe admission');
    template = validateTemplate(configured);
    return [];
  } },
  'scribe.guidance-configure': { name: 'retain-scribe-session-guidance', handle(message) {
    const { session_id: sessionId, additional_guidance: guidance, guidance_fingerprint: fingerprint, instruction_version: instructionVersion } = message.payload || {};
    if (!sessionId) throw invalid('scribe.guidance-configure requires a session_id');
    if (typeof guidance !== 'string') throw invalid('scribe.guidance-configure requires additional_guidance text');
    if (guidance.length > SCRIBE_GUIDANCE_MAX_CHARS) throw invalid(`scribe.guidance-configure additional_guidance exceeds ${SCRIBE_GUIDANCE_MAX_CHARS} characters`);
    if (typeof fingerprint !== 'string' || !fingerprint) throw invalid('scribe.guidance-configure requires a guidance_fingerprint');
    if (fingerprint !== fingerprintScribeGuidance(guidance)) {
      throw new ServiceOperationError('Scribe guidance fingerprint does not match its guidance text', {
        code: 'SCRIBE_GUIDANCE_FINGERPRINT_CONFLICT', category: 'conflict', details: { session_id: sessionId }
      });
    }
    // The 1.0 carrier predates this explicit field. Replaying one means "use the graph's
    // configured instruction", which was the behavior before the additive 1.1 field existed.
    const effectiveInstructionVersion = instructionVersion || template?.generation?.instruction_version;
    try { scribeBatchInstruction(effectiveInstructionVersion); }
    catch (error) { throw invalid(error.message); }
    if (guidance.trim() && effectiveInstructionVersion !== SCRIBE_GUIDANCE_INSTRUCTION_VERSION) {
      throw invalid(`non-empty Scribe guidance requires instruction version ${SCRIBE_GUIDANCE_INSTRUCTION_VERSION}`);
    }
    const retained = sessionGuidance.get(sessionId);
    if (retained) {
      // A session's guidance is snapshotted once. A second value for the same session is the
      // substitution this ticket exists to prevent, so it is a visible conflict, not an update.
      if (retained.fingerprint === fingerprint && retained.guidance === guidance && retained.instructionVersion === effectiveInstructionVersion) return publishSession(sessionId, message.message_id);
      throw new ServiceOperationError(`Scribe guidance for session ${sessionId} is already snapshotted and cannot be replaced`, {
        code: 'SCRIBE_GUIDANCE_CONFLICT', category: 'conflict', details: { session_id: sessionId, retained_fingerprint: retained.fingerprint, offered_fingerprint: fingerprint }
      });
    }
    if (sessionGuidance.size >= MAX_RETAINED_GUIDANCE) sessionGuidance.delete(sessionGuidance.keys().next().value);
    sessionGuidance.set(sessionId, { guidance, fingerprint, instructionVersion: effectiveInstructionVersion });
    // Publishing here prepares stopped-session recovery before Close. session.recorded/resumed
    // remains as a compatibility trigger for callers that do not configure guidance.
    return publishSession(sessionId, message.message_id);
  }, traceDetail: (message) => ({ session_id: message.payload?.session_id, guidance_fingerprint: message.payload?.guidance_fingerprint }) },
  'session.recorded': { name: 'publish-scribe-batch-policy', handle: publish },
  'session.resumed': { name: 'publish-scribe-batch-policy', handle: publish }
} });

function publish(message) {
  const sessionId = message.payload?.session_id;
  if (!sessionId) throw invalid('a session_id is required to publish a Scribe batch policy');
  return publishSession(sessionId, message.message_id);
}

function publishSession(sessionId, triggerId) {
  if (!template) {
    throw new ServiceOperationError('No governed Scribe batch policy is configured for this graph', {
      code: 'SCRIBE_POLICY_NOT_CONFIGURED', category: 'validation', details: { session_id: sessionId }
    });
  }
  // An unconfigured session publishes without guidance rather than failing: guidance is optional,
  // and blank guidance means Scribe runs on its protected instruction alone. The host sends and
  // awaits a session's snapshot before recording or resuming it, so a real session that has
  // guidance has it here first.
  const snapshot = sessionGuidance.get(sessionId);
  const guidance = snapshot?.guidance?.trim() ? snapshot.guidance.trim() : undefined;
  const payload = {
    ...structuredClone(template),
    session_id: sessionId,
    policy_id: guidanceScopedPolicyId(template.policy_id, snapshot, guidance),
    generation: {
      ...structuredClone(template.generation),
      ...(snapshot?.instructionVersion ? { instruction_version: snapshot.instructionVersion } : {}),
      ...(guidance ? { additional_guidance: guidance } : {})
    }
  };
  return [{
    plane: 'control',
    messageType: 'scribe.batch-policy',
    schemaVersion: '1.1.0',
    // The same immutable policy may be reasserted on configure, Record, or Resume. Binding the
    // publication identity to its governed trigger keeps each assertion idempotent without
    // reusing one message identity across distinct lifecycle events.
    identityKey: `scribe.batch-policy:${sessionId}:${payload.policy_id}:${payload.policy_version}:${triggerId}`,
    payload
  }];
}

/**
 * Fold the guidance identity into `policy_id`.
 *
 * Guidance is part of what the model was prompted with, so it has to be part of the policy
 * identity that `scribe_batch_identity`, the durable checkpoint, and the batch journal already
 * carry. Deriving it here means a changed guidance value is a changed policy everywhere
 * downstream - the checkpoint's existing policy comparison detects a substituted snapshot on
 * recovery - without adding a second identity that could drift out of step with the first.
 */
function guidanceScopedPolicyId(policyId, snapshot, guidance) {
  if (!guidance || !snapshot) return policyId;
  return `${policyId}+g${snapshot.fingerprint.replace(/^sha256:/, '').slice(0, 12)}`;
}

function validateTemplate(configured) {
  const { policy_id, policy_version, admission, context, generation } = configured;
  if (!policy_id || !policy_version) throw invalid('scribe_policy requires policy_id and policy_version');
  if (!Number.isInteger(admission?.rows_per_batch) || admission.rows_per_batch < 1) throw invalid('scribe_policy admission.rows_per_batch must be a positive integer');
  if (!Number.isInteger(admission?.idle_timeout_ms) || admission.idle_timeout_ms < 1000) throw invalid('scribe_policy admission.idle_timeout_ms must be an integer of at least 1000 ms');
  if (!Number.isInteger(context?.max_total_context_tokens) || context.max_total_context_tokens < 256) throw invalid('scribe_policy context.max_total_context_tokens must be an integer of at least 256');
  if (!generation?.policy_profile || !generation?.instruction_version) throw invalid('scribe_policy generation.policy_profile and generation.instruction_version are required');
  return {
    policy_id,
    policy_version,
    admission: { rows_per_batch: admission.rows_per_batch, idle_timeout_ms: admission.idle_timeout_ms },
    context: { max_total_context_tokens: context.max_total_context_tokens },
    generation: { policy_profile: generation.policy_profile, instruction_version: generation.instruction_version }
  };
}

function invalid(message) { return new ServiceOperationError(message, { code: 'INVALID_INPUT', category: 'validation' }); }
