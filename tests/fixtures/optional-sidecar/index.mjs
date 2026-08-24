import { runLineService, ServiceOperationError } from '../../../runtime/service-protocol.mjs';

runLineService({ service: 'optional-sidecar', operations: {
  'lifecycle.start': { name: 'optional-work', handle() {
    throw new ServiceOperationError('Optional sidecar is unavailable', { code: 'OPTIONAL_UNAVAILABLE', category: 'unavailable', retryable: false });
  } }
} });
