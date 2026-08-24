import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { SessionLifecycle, SessionLifecycleError } from '../../runtime/session-lifecycle.mjs';
import { SessionStorage } from '../../runtime/session-storage.mjs';

const SERVICE = 'session-lifecycle-controller';
const lifecycle = new SessionLifecycle({ storage: new SessionStorage() });

runLineService({ service: SERVICE, operations: {
  'session.record': operation('record-session', 'session.recorded', (payload) => lifecycle.record(payload)),
  'session.stop': operation('stop-session', 'session.stopped', (payload) => lifecycle.stop(payload)),
  'session.resume': operation('resume-session', 'session.resumed', (payload) => lifecycle.resume(payload)),
  'session.close': operation('close-session', 'session.closed', (payload) => lifecycle.close(payload))
} });

function operation(name, outputType, handler) {
  return {
    name,
    onDuplicate: 'handle',
    async handle(message) {
      try {
        const payload = await handler(message.payload);
        return [{ messageType: outputType, schemaVersion: '1.2.0', identityKey: `${SERVICE}:${outputType}:${payload.operation_id}`, payload }];
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
