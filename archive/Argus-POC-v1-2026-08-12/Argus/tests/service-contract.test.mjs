import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createEnvelope } from '../runtime/orchestrator.mjs';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { runService } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = await loadContractRegistry(path.join(root, 'contracts/catalog.json'));
const correlationId = 'contract-test-session';

const segmentPayloads = [
  { segment_id: 'segment-1', session_id: correlationId, sequence: 0, start_time: '16:23:22.000', end_time: '16:23:27.000', text: 'We need to inspect the owner mapping.', boundary: 'continuation' },
  { segment_id: 'segment-2', session_id: correlationId, sequence: 1, start_time: '16:23:27.000', end_time: '16:23:33.000', text: 'The fallback points to the legacy team identifier.', boundary: 'continuation' },
  { segment_id: 'segment-3', session_id: correlationId, sequence: 2, start_time: '16:23:33.000', end_time: '16:23:41.000', text: 'We should replace the fallback and test the empty owner case.', boundary: 'pause' }
];

const contextPayload = {
  window_id: 'window-contract-test',
  session_id: correlationId,
  reason: 'pause',
  segments: segmentPayloads.map(({ segment_id, sequence, start_time, end_time, text }) => ({ segment_id, sequence, start_time, end_time, text })),
  source: {
    first_segment_id: 'segment-1',
    last_segment_id: 'segment-3',
    start_time: '16:23:22.000',
    end_time: '16:23:41.000'
  }
};

test('contract registry accepts a valid envelope and rejects a malformed payload', () => {
  const valid = createEnvelope({ plane: 'domain', messageType: 'transcript.segment', producer: 'test', correlationId, payload: segmentPayloads[0] });
  assert.deepEqual(registry.validateEnvelope(valid), []);
  const invalid = structuredClone(valid);
  delete invalid.payload.text;
  assert.match(registry.validateEnvelope(invalid).join('\n'), /text is required/);
  const wrongPlane = structuredClone(valid);
  wrongPlane.plane = 'control';
  assert.match(registry.validateEnvelope(wrongPlane).join('\n'), /plane must be domain for transcript\.segment/);
});

test('fake transcript source independently emits valid transcript segments', async () => {
  const start = createEnvelope({
    plane: 'control',
    messageType: 'lifecycle.start',
    producer: 'contract-test',
    correlationId,
    payload: { session_id: correlationId }
  });
  const result = await runService(path.join(root, 'services/fake-transcript-source/service.json'), [start], 3);
  assert.equal(result.outputs.length, 3);
  result.outputs.forEach((message) => assert.deepEqual(registry.validateEnvelope(message), []));
  assert.deepEqual(result.outputs.map((message) => message.payload.sequence), [0, 1, 2]);
});

test('window selector independently emits a valid provenance-bearing context window', async () => {
  const inputs = segmentPayloads.map((payload) => createEnvelope({
    plane: 'domain',
    messageType: 'transcript.segment',
    producer: 'contract-test',
    correlationId,
    payload
  }));
  const result = await runService(path.join(root, 'services/transcript-window-selector/service.json'), inputs, 1);
  assert.deepEqual(registry.validateEnvelope(result.outputs[0]), []);
  assert.equal(result.outputs[0].payload.segments.length, 3);
  assert.equal(result.outputs[0].payload.source.first_segment_id, 'segment-1');
  assert.equal(result.outputs[0].payload.source.last_segment_id, 'segment-3');
});

for (const implementation of ['log-extractor-concise', 'log-extractor-passthrough']) {
  test(`${implementation} independently honors the logged-item draft contract`, async () => {
    const input = createEnvelope({
      plane: 'domain',
      messageType: 'transcript.context-window',
      producer: 'contract-test',
      correlationId,
      payload: contextPayload
    });
    const result = await runService(path.join(root, `services/${implementation}/service.json`), [input], 1);
    assert.deepEqual(registry.validateEnvelope(result.outputs[0]), []);
    assert.equal(result.outputs[0].payload.source.first_segment_id, 'segment-1');
    assert.ok(result.outputs[0].payload.text.length > 0);
  });
}

test('memory store independently emits the stored-item contract', async () => {
  const draft = createEnvelope({
    plane: 'domain',
    messageType: 'logged-item.draft',
    producer: 'contract-test',
    correlationId,
    payload: {
      item_id: 'log-contract-test',
      session_id: correlationId,
      created_at: new Date().toISOString(),
      text: 'Inspect the owner mapping.',
      revision: 0,
      source: contextPayload.source,
      generator: { implementation: 'contract-test', input_window_id: contextPayload.window_id }
    }
  });
  const result = await runService(path.join(root, 'services/logged-item-memory-store/service.json'), [draft], 1);
  assert.deepEqual(registry.validateEnvelope(result.outputs[0]), []);
  assert.equal(result.outputs[0].payload.item_id, 'log-contract-test');
});

test('a service converts invalid input into an explicit contract-valid failure', async () => {
  const invalid = createEnvelope({
    plane: 'domain',
    messageType: 'transcript.segment',
    producer: 'contract-test',
    correlationId,
    payload: { ...segmentPayloads[0], text: '' }
  });
  const result = await runService(path.join(root, 'services/transcript-window-selector/service.json'), [invalid], 1);
  assert.equal(result.outputs[0].message_type, 'service.failure');
  assert.deepEqual(registry.validateEnvelope(result.outputs[0]), []);
  assert.equal(result.outputs[0].payload.error.retryable, false);
});
