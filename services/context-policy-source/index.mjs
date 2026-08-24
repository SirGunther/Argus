import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';

const SERVICE = 'context-policy-source';
runLineService({ service: SERVICE, operations: {
  'lifecycle.start': { name: 'publish-context-policy', handle(message) {
    const sessionId = message.payload?.session_id;
    const configured = message.payload?.configuration?.context_policy;
    if (!sessionId || !configured) throw new ServiceOperationError('session_id and configuration.context_policy are required', { code: 'INVALID_INPUT', category: 'validation' });
    const payload = { ...configured, session_id: sessionId };
    return [{ plane: 'control', messageType: 'transcript.context-policy', identityKey: `transcript.context-policy:${sessionId}:${payload.policy_id}:${payload.policy_version}`, payload }];
  } }
} });
