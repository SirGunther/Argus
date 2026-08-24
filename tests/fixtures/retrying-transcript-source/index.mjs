import { runLineService, ServiceOperationError } from '../../../runtime/service-protocol.mjs';

let attempts = 0;
runLineService({ service: 'retrying-transcript-source', operations: {
  'lifecycle.start': { name: 'emit-fixture', handle(message) {
    attempts += 1;
    if (attempts === 1) throw new ServiceOperationError('Transient source failure', { code: 'TRANSIENT_SOURCE', category: 'unavailable', retryable: true });
    return [{ messageType: 'transcript.segment', payload: {
      segment_id: 'retry-segment', session_id: message.payload.session_id, sequence: 0,
      start_time: '00:00:00.000', end_time: '00:00:01.000', text: 'We should verify the retry path.', boundary: 'pause'
    } }];
  } }
} });
