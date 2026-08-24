import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { SessionStorage, SessionStorageError, validateSessionId } from '../../runtime/session-storage.mjs';

const SERVICE = 'session-folder-locator';
const storage = new SessionStorage();

runLineService({ service: SERVICE, operations: {
  'session.folder-locate': {
    name: 'locate-session-folders',
    onDuplicate: 'handle',
    async handle(message) {
      try {
        const { session_id: sessionId, operation_id: operationId } = message.payload;
        validateSessionId(sessionId);
        if (!await storage.readMetadata(sessionId)) throw new SessionStorageError('SESSION_NOT_FOUND', `Unknown session ${sessionId}`);
        const paths = storage.paths(sessionId);
        return [{ messageType: 'session.folder-located', schemaVersion: '1.2.0', identityKey: `${SERVICE}:session.folder-located:${operationId}`, payload: {
          operation_id: operationId,
          session_id: sessionId,
          active_path: paths.active,
          permanent_path: paths.permanent,
          active_relative_path: `${sessionId}/active`,
          permanent_relative_path: `${sessionId}/permanent`
        } }];
      } catch (error) {
        if (error instanceof SessionStorageError) throw new ServiceOperationError(error.message, { code: error.code, category: error.code === 'SESSION_NOT_FOUND' ? 'conflict' : 'validation', rejected: error.code === 'SESSION_NOT_FOUND', details: error.details });
        throw error;
      }
    }
  }
} });
