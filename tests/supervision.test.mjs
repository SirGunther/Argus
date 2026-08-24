import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BoundedWireQueue, QueueOverflowError } from '../runtime/bounded-wire-queue.mjs';
import { loadGraphDefinition, prepareGraph, runPreparedGraph } from '../runtime/orchestrator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const graphFile = path.join(root, 'wiring/demo.concise.json');

test('bounded wire queue rejects overflow and reports depth', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const depths = [];
  const queue = new BoundedWireQueue({ wireKey: 'source:event:target', capacity: 2, consume: async () => blocked, observe: (depth) => depths.push(depth) });
  queue.enqueue('one');
  queue.enqueue('two');
  assert.throws(() => queue.enqueue('three'), QueueOverflowError);
  assert.equal(queue.depth, 2);
  release();
  await queue.drain();
  assert.ok(depths.includes(2));
  assert.equal(queue.depth, 0);
});

test('runtime-neutral manifests fail closed when their trusted provider is not installed', async () => {
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const invalid = structuredClone(definition);
  invalid.services[0].manifest = '../tests/fixtures/native-transcript-source/service.json';
  await assert.rejects(() => prepareGraph(invalid, absoluteGraphFile), /No trusted runtime provider is installed for kind: native/);
});

test('required component fails readiness after the explicit five-second default is overridden for the test', async () => {
  const prepared = await graphWithSource('unready-transcript-source');
  prepared.definition.supervision.readiness_timeout_ms = 75;
  await assert.rejects(() => runPreparedGraph(prepared), /Required services did not become ready within 75 ms: transcript-source/);
});

test('per-operation timeout becomes a retryable supervisor failure, but retries remain disabled without a wire policy', async () => {
  const prepared = await graphWithSource('hanging-transcript-source');
  prepared.definition.supervision.operation_timeout_ms = 75;
  await assert.rejects(() => runPreparedGraph(prepared), /OPERATION_TIMEOUT.*did not complete lifecycle.start within 75 ms/);
});

test('a retryable failure is retried only when the exact input wire permits it', async () => {
  const prepared = await graphWithSource('retrying-transcript-source');
  const startWire = prepared.definition.control_wires.find((wire) => wire.contract === 'lifecycle.start');
  startWire.delivery = { retry: { max_attempts: 2, delay_ms: 0 }, dead_letter_to: '@dead-letter-collector' };
  const result = await runPreparedGraph(await reprepare(prepared));
  assert.equal(result.completions.length, 1);
  assert.equal(result.dead_letters.length, 0);
});

test('retry exhaustion emits an explicit dead letter before required-component fail-fast', async () => {
  const prepared = await graphWithSource('always-failing-transcript-source');
  const startWire = prepared.definition.control_wires.find((wire) => wire.contract === 'lifecycle.start');
  startWire.delivery = { retry: { max_attempts: 2, delay_ms: 0 }, dead_letter_to: '@dead-letter-collector' };
  const governed = await reprepare(prepared);
  await assert.rejects(
    () => runPreparedGraph(governed),
    (error) => {
      assert.match(error.message, /PERSISTENT_SOURCE/);
      assert.equal(error.deadLetters.length, 1);
      assert.equal(error.deadLetters[0].payload.attempts, 2);
      return true;
    }
  );
});

test('stateless service restarts within its declared bound and replays unfinished input', async () => {
  const prepared = await graphWithSource('restartable-transcript-source');
  prepared.definition.services[0].recovery = { restart: 'on-failure', max_restarts: 1 };
  const result = await runPreparedGraph(await reprepare(prepared));
  assert.equal(result.completions.length, 1);
});

test('required component fails fast after its bounded restart policy is exhausted', async () => {
  const prepared = await graphWithSource('crash-loop-transcript-source');
  prepared.definition.services[0].recovery = { restart: 'on-failure', max_restarts: 1 };
  const governed = await reprepare(prepared);
  await assert.rejects(() => runPreparedGraph(governed), /transcript-source exited and exhausted its recovery policy/);
});

test('an explicitly optional component can fail and enter degraded mode without ending required work', async () => {
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const changed = structuredClone(definition);
  changed.services.push({
    id: 'optional-sidecar',
    manifest: '../tests/fixtures/optional-sidecar/service.json',
    required: false,
    recovery: { restart: 'never', max_restarts: 0 }
  });
  changed.control_wires.push(
    { from: '@session-controller', contract: 'lifecycle.start', to: 'optional-sidecar' },
    { from: '@supervisor', contract: 'lifecycle.health-check', to: 'optional-sidecar' },
    { from: 'optional-sidecar', contract: 'service.health', to: '@supervisor' },
    { from: '@supervisor', contract: 'lifecycle.drain', to: 'optional-sidecar' },
    { from: 'optional-sidecar', contract: 'service.drained', to: '@supervisor' },
    { from: 'optional-sidecar', contract: 'operation.completed', to: '@supervisor' },
    { from: 'optional-sidecar', contract: 'service.failure', to: '@supervisor' }
  );
  const result = await runPreparedGraph(await prepareGraph(changed, absoluteGraphFile));
  assert.equal(result.completions.length, 1);
  assert.equal(result.metrics.process_count, 5);
});

test('stateful restart is rejected until a recovery owner is declared', async () => {
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const invalid = structuredClone(definition);
  invalid.services.find((service) => service.id === 'window-selector').recovery = { restart: 'on-failure', max_restarts: 1 };
  await assert.rejects(() => prepareGraph(invalid, absoluteGraphFile), /owns state and cannot restart until recovery_owner is declared/);
});

test('undeclared output fails the contract boundary immediately', async () => {
  const prepared = await graphWithSource('undeclared-output-source');
  await assert.rejects(() => runPreparedGraph(prepared), /emitted undeclared domain contract logged-item.draft/);
});

test('an uncooperative component is force-stopped only after the declared drain deadline', async () => {
  const prepared = await graphWithSource('undrained-transcript-source');
  prepared.definition.supervision.drain_timeout_ms = 75;
  const started = performance.now();
  const result = await runPreparedGraph(prepared);
  assert.equal(result.completions.length, 1);
  assert.ok(performance.now() - started >= 75);
});

test('successful run reports POC resource and routing evidence without enforcing production thresholds', async () => {
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const result = await runPreparedGraph(await prepareGraph(definition, absoluteGraphFile));
  assert.equal(result.metrics.process_count, 4);
  assert.ok(result.metrics.startup_ms > 0);
  assert.ok(result.metrics.idle_rss_bytes_total > 0);
  assert.ok(result.metrics.throughput_messages_per_second > 0);
  assert.ok(result.metrics.operation_latency_ms.count >= 1);
});

async function graphWithSource(fixtureName) {
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const changed = structuredClone(definition);
  changed.services.find((service) => service.id === 'transcript-source').manifest = `../tests/fixtures/${fixtureName}/service.json`;
  return prepareGraph(changed, absoluteGraphFile);
}

async function reprepare(prepared) {
  return prepareGraph(prepared.definition, prepared.graphFile);
}
