import { runLineService } from '../../../runtime/service-protocol.mjs';

runLineService({ service: 'restartable-transcript-source', operations: {
  'lifecycle.start': { name: 'emit-fixture', handle(message) {
    if (process.env.ARGUS_RESTART_COUNT === '0') {
      setImmediate(() => process.exit(17));
      return new Promise(() => {});
    }
    return [{ messageType: 'transcript.segment', payload: {
      segment_id: 'restart-segment', session_id: message.payload.session_id, sequence: 0,
      start_time: '00:00:00.000', end_time: '00:00:01.000', text: 'We should verify the restart path.', boundary: 'pause'
    } }];
  } }
} });
