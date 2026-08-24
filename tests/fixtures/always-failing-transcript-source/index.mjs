import { runLineService, ServiceOperationError } from '../../../runtime/service-protocol.mjs';

runLineService({ service: 'always-failing-transcript-source', operations: {
  'lifecycle.start': { name: 'emit-fixture', handle() {
    throw new ServiceOperationError('Persistent retryable source failure', { code: 'PERSISTENT_SOURCE', category: 'unavailable', retryable: true });
  } }
} });
