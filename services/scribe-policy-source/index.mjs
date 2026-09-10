import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';

// The governed Scribe policy is published per real recording session, not per graph run.
// `lifecycle.start` carries the run configuration but its session is the graph bootstrap
// identity, which owns no durable session directory; requesting Scribe recovery for it would
// fail against session storage. Session lifecycle outcomes carry the authoritative session id,
// so the template is retained at start and projected when a session actually begins recording
// or resumes.
const SERVICE = 'scribe-policy-source';
let template;

runLineService({ service: SERVICE, operations: {
  'lifecycle.start': { name: 'retain-scribe-batch-policy', handle(message) {
    const configured = message.payload?.configuration?.scribe_policy;
    if (!configured) throw invalid('configuration.scribe_policy is required to govern Scribe admission');
    template = validateTemplate(configured);
    return [];
  } },
  'session.recorded': { name: 'publish-scribe-batch-policy', handle: publish },
  'session.resumed': { name: 'publish-scribe-batch-policy', handle: publish }
} });

function publish(message) {
  const sessionId = message.payload?.session_id;
  if (!sessionId) throw invalid('a session_id is required to publish a Scribe batch policy');
  if (!template) {
    throw new ServiceOperationError('No governed Scribe batch policy is configured for this graph', {
      code: 'SCRIBE_POLICY_NOT_CONFIGURED', category: 'validation', details: { session_id: sessionId }
    });
  }
  const payload = { ...structuredClone(template), session_id: sessionId };
  return [{
    plane: 'control',
    messageType: 'scribe.batch-policy',
    schemaVersion: '1.0.0',
    identityKey: `scribe.batch-policy:${sessionId}:${payload.policy_id}:${payload.policy_version}`,
    payload
  }];
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
