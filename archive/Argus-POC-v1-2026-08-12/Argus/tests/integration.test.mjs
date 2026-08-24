import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadGraphDefinition, prepareGraph, runGraph, runPreparedGraph } from '../runtime/orchestrator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('both extractor implementations complete the same graph contract', async () => {
  const concise = await runGraph(path.join(root, 'wiring/demo.concise.json'));
  const passthrough = await runGraph(path.join(root, 'wiring/demo.passthrough.json'));
  const conciseItem = concise.completions[0].payload;
  const passthroughItem = passthrough.completions[0].payload;

  assert.equal(concise.completions[0].message_type, 'logged-item.stored');
  assert.equal(passthrough.completions[0].message_type, 'logged-item.stored');
  assert.equal(concise.completions[0].plane, 'domain');
  assert.equal(concise.control_completions[0].message_type, 'workflow.completed');
  assert.equal(concise.control_completions[0].plane, 'control');
  assert.equal(conciseItem.session_id, passthroughItem.session_id);
  assert.deepEqual(conciseItem.source, passthroughItem.source);
  assert.notEqual(conciseItem.text, passthroughItem.text);
  assert.equal(conciseItem.text, 'Replace the fallback and test the empty-owner case.');
  assert.match(passthroughItem.text, /owner mapping.*legacy team identifier.*empty owner case/i);
});

test('graceful completion preserves the terminal service completed trace', async () => {
  const orchestrator = path.join(root, 'runtime/orchestrator.mjs');
  const graph = path.join(root, 'wiring/demo.concise.json');
  const { code, stderr } = await runCli(orchestrator, graph);
  assert.equal(code, 0);
  const traces = stderr.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(traces.some((entry) => entry.service === 'logged-item-memory-store' && entry.operation === 'store-item' && entry.status === 'completed'));
  assert.ok(traces.some((entry) => entry.operation === 'route' && entry.plane === 'control' && entry.from === '@session-controller' && entry.to === 'transcript-source'));
  assert.ok(traces.some((entry) => entry.operation === 'route' && entry.plane === 'domain' && entry.from === 'logged-item-store' && entry.to === '@result-collector'));
  assert.ok(traces.some((entry) => entry.operation === 'route' && entry.plane === 'control' && entry.from === '@result-collector' && entry.to === '@run-controller'));
});

test('service.failure reaches the explicit supervisor control component', async () => {
  const graphFile = path.join(root, 'wiring/demo.concise.json');
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const failing = structuredClone(definition);
  failing.services.find((service) => service.id === 'transcript-source').manifest = '../tests/fixtures/failing-transcript-source/service.json';
  const prepared = await prepareGraph(failing, absoluteGraphFile);
  await assert.rejects(
    () => runPreparedGraph(prepared),
    /failing-transcript-source reported DeliberateTestFailure: Failure fixture reached the explicit supervisor path/
  );
});

function runCli(orchestrator, graph) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [orchestrator, graph], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
