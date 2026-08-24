import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGraph } from '../runtime/orchestrator.mjs';
import { startDeterministicLocalModelEndpoint } from '../tests/helpers/deterministic-local-model-endpoint.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const endpoint = await startDeterministicLocalModelEndpoint();
const previous = { endpoint: process.env.ARGUS_MODEL_ENDPOINT, model: process.env.ARGUS_MODEL_NAME, timeout: process.env.ARGUS_MODEL_TIMEOUT_MS };
process.env.ARGUS_MODEL_ENDPOINT = endpoint.endpoint;
process.env.ARGUS_MODEL_NAME = 'deterministic-test-model';
process.env.ARGUS_MODEL_TIMEOUT_MS = '500';
try {
  const result = await runGraph(path.join(root, 'wiring/demo.logged-item-model.json'), { trace: true });
  process.stdout.write(`${JSON.stringify({ graph: result.graph, primary_completion: result.completions[0], model_requests: endpoint.requests.map(({ body }) => ({ purpose: body.purpose, model: body.model, work_id: body.identity?.work_id })), metrics: result.metrics }, null, 2)}\n`);
} finally {
  if (previous.endpoint === undefined) delete process.env.ARGUS_MODEL_ENDPOINT; else process.env.ARGUS_MODEL_ENDPOINT = previous.endpoint;
  if (previous.model === undefined) delete process.env.ARGUS_MODEL_NAME; else process.env.ARGUS_MODEL_NAME = previous.model;
  if (previous.timeout === undefined) delete process.env.ARGUS_MODEL_TIMEOUT_MS; else process.env.ARGUS_MODEL_TIMEOUT_MS = previous.timeout;
  await endpoint.close();
}
