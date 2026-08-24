import { runLineService } from '../../../runtime/service-protocol.mjs';

runLineService({ service: 'undeclared-output-source', operations: {
  'lifecycle.start': { name: 'emit-fixture', handle(message) {
    return [{ messageType: 'logged-item.draft', payload: {
      item_id: 'undeclared', session_id: message.payload.session_id, created_at: new Date().toISOString(), text: 'Undeclared.', revision: 0,
      source: { first_segment_id: 'x', last_segment_id: 'x', start_time: '0', end_time: '1' },
      generator: { implementation: 'undeclared-output-source', input_window_id: 'x' }
    } }];
  } }
} });
