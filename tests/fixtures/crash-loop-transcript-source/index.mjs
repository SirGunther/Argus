import { runLineService } from '../../../runtime/service-protocol.mjs';

runLineService({ service: 'crash-loop-transcript-source', operations: {
  'lifecycle.start': { name: 'emit-fixture', handle() {
    setImmediate(() => process.exit(18));
    return new Promise(() => {});
  } }
} });
