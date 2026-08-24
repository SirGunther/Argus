import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraphDefinition, prepareGraph, runPreparedGraph } from '../runtime/orchestrator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const graphFile = path.join(root, 'wiring', 'demo.concise.json');
const { definition: base, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
const pipelineCounts = process.argv.slice(2).map(Number).filter((value) => Number.isInteger(value) && value > 0);
const counts = pipelineCounts.length ? pipelineCounts : [1, 2, 3];
const samples = [];

for (const pipelineCount of counts) {
  const definition = scaleGraph(base, pipelineCount);
  const result = await runPreparedGraph(await prepareGraph(definition, absoluteGraphFile));
  samples.push({ pipelines: pipelineCount, ...result.metrics });
}

process.stdout.write(`${JSON.stringify({
  measured_at: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, architecture: process.arch },
  policy: 'POC evidence only; these values are not production acceptance thresholds.',
  samples
}, null, 2)}\n`);

function scaleGraph(source, count) {
  if (count === 1) return structuredClone(source);
  const graph = structuredClone(source);
  graph.name = `${source.name}-${count}-pipelines`;
  graph.services = [];
  graph.domain_wires = [];
  graph.control_wires = source.control_wires.filter((wire) => wire.from.startsWith('@') && wire.to.startsWith('@'));
  graph.run.completion_count = count;

  for (let index = 1; index <= count; index += 1) {
    const suffix = `-${index}`;
    const ids = new Map(source.services.map((service) => [service.id, `${service.id}${suffix}`]));
    for (const service of source.services) graph.services.push({ ...structuredClone(service), id: ids.get(service.id) });
    for (const wire of source.domain_wires) {
      graph.domain_wires.push({ ...structuredClone(wire), from: ids.get(wire.from) || wire.from, to: ids.get(wire.to) || wire.to });
    }
    for (const wire of source.control_wires) {
      if (wire.from.startsWith('@') && wire.to.startsWith('@')) continue;
      graph.control_wires.push({ ...structuredClone(wire), from: ids.get(wire.from) || wire.from, to: ids.get(wire.to) || wire.to });
    }
  }
  return graph;
}
