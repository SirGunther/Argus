import { runLineService } from '../../runtime/service-protocol.mjs';
runLineService({ service: 'logged-item-evidence-observer', operations: {
  'logged-item.stored': { name: 'observe-active-revision', handle() { return []; } },
  'logged-item.history-appended': { name: 'observe-history-revision', handle() { return []; } }
} });
