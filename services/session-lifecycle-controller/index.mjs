import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { SessionLifecycle, SessionLifecycleError } from '../../runtime/session-lifecycle.mjs';
import { SessionStorage } from '../../runtime/session-storage.mjs';

const SERVICE = 'session-lifecycle-controller';
const lifecycle = new SessionLifecycle({ storage: new SessionStorage() });

runLineService({ service: SERVICE, operations: {
  'session.record': operation('record-session', 'session.recorded', (payload) => lifecycle.record(payload)),
  'session.stop': operation('stop-session', 'session.stopped', (payload) => lifecycle.stop(payload)),
  'session.resume': operation('resume-session', 'session.resumed', (payload) => lifecycle.resume(payload)),
  'session.close': operation('close-session', 'session.closed', (payload) => lifecycle.close(payload)),
  'scribe.recovery-request': operation(
    'restore-scribe-state',
    'scribe.recovery-restored',
    (payload) => lifecycle.getScribeRecoveryState(payload.session_id, { policyId: payload.policy_id, policyVersion: payload.policy_version }),
    (payload) => `${payload.session_id}:${payload.policy_id}:${payload.policy_version}:${payload.recovered_at}:${payload.checkpoint?.saved_at || 'none'}`,
    'replay'
  ),
  'scribe.checkpoint-persist': operation(
    'persist-scribe-checkpoint',
    'scribe.checkpoint-persisted',
    (payload) => lifecycle.persistScribeCheckpointTransition(payload.session_id, payload),
    (payload) => {
      const requestId = payload.checkpoint.in_flight_batch?.batch_identity.request_id || payload.batch?.batch_identity.request_id;
      const attempt = payload.checkpoint.in_flight_batch?.attempt || payload.batch?.attempt;
      return `${payload.transition}:${requestId}:a${attempt}`;
    }
  )
} });

function operation(name, outputType, handler, identityFor = (payload) => payload.operation_id, duplicateMode = 'handle') {
  return {
    name,
    onDuplicate: duplicateMode,
    async handle(message) {
      try {
        const payload = await handler(message.payload);
        return [{ plane: 'control', messageType: outputType, schemaVersion: outputType.startsWith('scribe.') ? '1.0.0' : '1.2.0', identityKey: `${SERVICE}:${outputType}:${identityFor(payload)}`, payload }];
      } catch (error) {
        if (error instanceof SessionLifecycleError) {
          throw new ServiceOperationError(error.message, {
            code: error.code,
            category: error.rejected ? 'conflict' : error.code?.includes('INTEGRITY') || error.code?.includes('MISSING_') ? 'conflict' : 'validation',
            retryable: error.retryable,
            rejected: error.rejected,
            details: error.details
          });
        }
        throw error;
      }
    }
  };
}
