import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadGraphDefinition, prepareGraph, validateGraphFile } from '../runtime/orchestrator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const graphFile = path.join(root, 'wiring/demo.concise.json');

test('valid graph resolves four isolated services, four runtime components, and explicit two-plane wires', async () => {
  const prepared = await validateGraphFile(graphFile);
  assert.equal(prepared.services.size, 4);
  assert.equal(prepared.endpoints.size, 8);
  assert.equal(prepared.definition.domain_wires.length, 4);
  assert.equal(prepared.definition.control_wires.length, 6);
});

test('component manifests are executable contracts, not informal metadata', async () => {
  const prepared = await validateGraphFile(graphFile);
  const invalidManifest = structuredClone(prepared.services.get('log-extractor').manifest);
  delete invalidManifest.side_effects;
  assert.throws(() => prepared.registry.assertArtifact('service_manifest', invalidManifest), /side_effects is required/);
});

test('default-deny validation rejects a wire the producer did not declare', async () => {
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const invalid = structuredClone(definition);
  invalid.domain_wires[0].contract = 'logged-item.draft';
  invalid.domain_wires[0].to = 'logged-item-store';
  await assert.rejects(() => prepareGraph(invalid, absoluteGraphFile), /transcript-source does not declare emitted domain contract logged-item\.draft/);
});

test('default-deny validation rejects a wire with an unknown consumer', async () => {
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const invalid = structuredClone(definition);
  invalid.domain_wires[0].to = 'undeclared-service';
  await assert.rejects(() => prepareGraph(invalid, absoluteGraphFile), /unknown consumer/);
});

test('domain contracts cannot be placed on control wires', async () => {
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const invalid = structuredClone(definition);
  invalid.control_wires.push({ from: 'transcript-source', contract: 'transcript.segment', to: 'window-selector' });
  await assert.rejects(() => prepareGraph(invalid, absoluteGraphFile), /transcript\.segment is a domain contract and cannot use a control wire/);
});

test('control contracts cannot be placed on domain wires', async () => {
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const invalid = structuredClone(definition);
  invalid.domain_wires.push({ from: 'transcript-source', contract: 'service.failure', to: '@supervisor' });
  await assert.rejects(() => prepareGraph(invalid, absoluteGraphFile), /service\.failure is a control contract and cannot use a domain wire/);
});

test('removing lifecycle.start wire makes startup impossible before processes launch', async () => {
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const invalid = structuredClone(definition);
  invalid.control_wires = invalid.control_wires.filter((wire) => wire.contract !== 'lifecycle.start');
  await assert.rejects(() => prepareGraph(invalid, absoluteGraphFile), /requires an explicit lifecycle\.start control wire/);
});

test('removing a failure wire makes service failure handling impossible', async () => {
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const invalid = structuredClone(definition);
  invalid.control_wires = invalid.control_wires.filter((wire) => !(wire.from === 'log-extractor' && wire.contract === 'service.failure'));
  await assert.rejects(() => prepareGraph(invalid, absoluteGraphFile), /log-extractor requires an explicit service\.failure control wire/);
});

test('removing workflow completion wire makes run completion impossible', async () => {
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const invalid = structuredClone(definition);
  invalid.control_wires = invalid.control_wires.filter((wire) => wire.contract !== 'workflow.completed');
  await assert.rejects(() => prepareGraph(invalid, absoluteGraphFile), /requires an explicit workflow\.completed control wire/);
});

test('removing the result-collector domain wire makes result observation impossible', async () => {
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const invalid = structuredClone(definition);
  invalid.domain_wires = invalid.domain_wires.filter((wire) => wire.to !== '@result-collector');
  await assert.rejects(() => prepareGraph(invalid, absoluteGraphFile), /requires an explicit domain wire to a result-collector/);
});
