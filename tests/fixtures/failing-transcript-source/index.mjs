import { runLineService, ServiceOperationError } from '../../../runtime/service-protocol.mjs';

runLineService({ service: 'failing-transcript-source', operations: {
  'lifecycle.start': {
    name: 'emit-fixture',
    handle() {
      throw new ServiceOperationError('Failure fixture reached the explicit supervisor path', {
        code: 'DELIBERATE_TEST_FAILURE', category: 'internal', retryable: false
      });
    }
  }
} });
