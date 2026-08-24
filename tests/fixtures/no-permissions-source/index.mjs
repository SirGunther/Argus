import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';

const SERVICE = 'fake-transcript-source';
const fixture = [
  { start_time: '16:23:22.000', end_time: '16:23:27.000', text: 'We need to inspect the owner mapping.', boundary: 'continuation' },
  { start_time: '16:23:27.000', end_time: '16:23:33.000', text: 'The fallback points to the legacy team identifier.', boundary: 'continuation' },
  { start_time: '16:23:33.000', end_time: '16:23:41.000', text: 'We should replace the fallback and test the empty owner case.', boundary: 'pause' }
];

runLineService({ service: SERVICE, operations: {
  'lifecycle.start': {
    name: 'emit-fixture',
    handle(message) {
      if (typeof message.payload?.session_id !== 'string' || !message.payload.session_id) {
        throw new ServiceOperationError('session_id is required', { code: 'INVALID_INPUT', category: 'validation' });
      }
      return fixture.map((segment, sequence) => ({
        messageType: 'transcript.segment',
        payload: { segment_id: `segment-${sequence + 1}`, session_id: message.payload.session_id, sequence, ...segment }
      }));
    },
    traceDetail: (_message, outputs) => ({ emitted_count: outputs.length })
  }
} });
