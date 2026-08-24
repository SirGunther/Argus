import { runLineService } from '../../runtime/service-protocol.mjs';

runLineService({ service: 'transcript-evidence-observer', operations: {
  'transcript.segment-stored': { name: 'observe-active-segment-storage', handle() { return []; } },
  'transcript.history-appended': { name: 'observe-permanent-history-append', handle() { return []; } }
} });
