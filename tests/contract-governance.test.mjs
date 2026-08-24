import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertGovernedEvolution, compareContractVersions } from '../runtime/contract-governance.mjs';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { createEnvelope } from '../runtime/orchestrator.mjs';
import { runService } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(root, 'contracts', 'catalog.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const registry = await loadContractRegistry(catalogPath);

test('catalog gives every message an owner, semantic version, payload limit, and changelog', async () => {
  assert.equal(catalog.governance.compatibility_policy, 'backward-compatible-minor');
  assert.equal(catalog.governance.plane_change, 'breaking');
  assert.equal(catalog.governance.validation, 'ajv-draft-07-runtime-boundary');
  for (const [messageType, definition] of Object.entries(catalog.messages)) {
    assert.match(definition.version, /^\d+\.\d+\.\d+$/, `${messageType} version`);
    assert.ok(definition.owner, `${messageType} owner`);
    assert.ok(Number.isInteger(definition.max_payload_bytes), `${messageType} max payload`);
    await assert.doesNotReject(() => readFile(path.join(root, 'contracts', definition.changelog), 'utf8'));
  }
});

test('version policy accepts older/equal minors and rejects newer or different majors', () => {
  assert.equal(compareContractVersions('1.0.9', '1.1.0').compatible, true);
  assert.equal(compareContractVersions('1.1.7', '1.1.0').compatible, true);
  assert.match(compareContractVersions('1.2.0', '1.1.0').reason, /newer/);
  assert.match(compareContractVersions('2.0.0', '1.1.0').reason, /incompatible/);
});

test('contract plane changes require a major version increase', () => {
  const previous = { schema_version: '1.0.0', messages: { 'example.event': { plane: 'domain', version: '1.0.0' } } };
  const invalid = { schema_version: '1.1.0', messages: { 'example.event': { plane: 'control', version: '1.1.0' } } };
  assert.throws(() => assertGovernedEvolution(previous, invalid), /plane changed.*major version/);

  const valid = { schema_version: '2.0.0', messages: { 'example.event': { plane: 'control', version: '2.0.0' } } };
  assert.doesNotThrow(() => assertGovernedEvolution(previous, valid));
});

test('every governed contract owns a retained valid fixture and all fixtures replay', async () => {
  const fixtureRoot = path.join(root, 'tests', 'fixtures', 'contracts');
  const messageTypes = await readdir(fixtureRoot);
  assert.deepEqual(messageTypes.sort(), Object.keys(catalog.messages).sort());
  for (const messageType of messageTypes) {
    const versions = await readdir(path.join(fixtureRoot, messageType));
    assert.ok(versions.length, `${messageType} retained versions`);
    for (const version of versions) {
      const fixture = JSON.parse(await readFile(path.join(fixtureRoot, messageType, version, 'valid.json'), 'utf8'));
      assert.deepEqual(registry.validateEnvelope(fixture), [], `${messageType}@${version}`);
    }
  }
});

test('retained 1.0.0 inputs execute through current isolated service consumers', async () => {
  const fixtureRoot = path.join(root, 'tests', 'fixtures', 'contracts');
  const loadFixture = async (messageType) => JSON.parse(await readFile(path.join(fixtureRoot, messageType, '1.0.0', 'valid.json'), 'utf8'));

  const startResult = await runService(path.join(root, 'services/fake-transcript-source/service.json'), [await loadFixture('lifecycle.start')], 4);
  assert.equal(startResult.outputs.filter((message) => message.message_type === 'transcript.segment').length, 3);

  const segmentResult = await runService(path.join(root, 'services/transcript-window-selector/service.json'), [await loadFixture('transcript.segment')], 2);
  assert.ok(segmentResult.outputs.some((message) => message.message_type === 'transcript.context-window'));

  for (const extractor of ['log-extractor-concise', 'log-extractor-passthrough']) {
    const result = await runService(path.join(root, `services/${extractor}/service.json`), [await loadFixture('transcript.context-window')], 2);
    assert.ok(result.outputs.some((message) => message.message_type === 'logged-item.draft'));
  }

  const storeResult = await runService(path.join(root, 'services/logged-item-memory-store/service.json'), [await loadFixture('logged-item.draft')], 2);
  assert.ok(storeResult.outputs.some((message) => message.message_type === 'logged-item.stored'));
});

test('current minor messages accept namespaced extensions without weakening the payload schema', () => {
  const message = createEnvelope({
    plane: 'domain',
    messageType: 'transcript.segment',
    producer: 'governance-test',
    correlationId: 'governance-session',
    extensions: { 'argus.trace.sampled': true },
    payload: {
      segment_id: 'segment-1', session_id: 'governance-session', sequence: 0,
      start_time: '00:00:00.000', end_time: '00:00:01.000', text: 'Valid text.', boundary: 'pause'
    }
  });
  assert.deepEqual(registry.validateEnvelope(message), []);
  message.extensions = { invalid: true };
  assert.match(registry.validateEnvelope(message).join('\n'), /must match pattern/);
});

test('registry rejects unknown schema versions and oversized UTF-8 payloads before routing', () => {
  const base = {
    plane: 'domain', messageType: 'transcript.segment', producer: 'governance-test', correlationId: 'governance-session',
    payload: { segment_id: 'segment-1', session_id: 'governance-session', sequence: 0, start_time: '0', end_time: '1', text: 'Valid text.', boundary: 'pause' }
  };
  const future = createEnvelope({ ...base, schemaVersion: '1.5.0' });
  assert.match(registry.validateEnvelope(future).join('\n'), /newer than registered minor/);
  const nextMajor = createEnvelope({ ...base, schemaVersion: '2.0.0' });
  assert.match(registry.validateEnvelope(nextMajor).join('\n'), /incompatible/);
  const oversized = createEnvelope({ ...base, payload: { ...base.payload, text: 'é'.repeat(17000) } });
  assert.match(registry.validateEnvelope(oversized).join('\n'), /maximum for transcript\.segment is 32768 bytes/);
});

test('Ajv enforces schema keywords the previous subset validator did not support', () => {
  const message = createEnvelope({
    plane: 'domain', messageType: 'transcript.segment', producer: 'governance-test', correlationId: 'governance-session',
    extensions: { invalid: true },
    payload: { segment_id: 'segment-1', session_id: 'governance-session', sequence: 0, start_time: '0', end_time: '1', text: 'Valid text.', boundary: 'pause' }
  });
  assert.match(registry.validateEnvelope(message).join('\n'), /property name must be valid/);
});

test('canonical service failure is contract-valid and safely categorized', async () => {
  const invalid = createEnvelope({
    plane: 'domain', messageType: 'transcript.segment', producer: 'governance-test', correlationId: 'governance-session',
    payload: { segment_id: 'segment-1', session_id: 'governance-session', sequence: 0, start_time: '0', end_time: '1', text: '', boundary: 'pause' }
  });
  const result = await runService(path.join(root, 'services/transcript-window-selector/service.json'), [invalid], 1);
  const failure = result.outputs[0];
  assert.deepEqual(registry.validateEnvelope(failure), []);
  assert.equal(failure.payload.outcome, 'failure');
  assert.equal(failure.payload.error.code, 'INVALID_INPUT');
  assert.equal(failure.payload.error.category, 'validation');
  assert.equal(failure.payload.error.retryable, false);
  assert.equal(Object.hasOwn(failure.payload.error, 'stack'), false);
});
