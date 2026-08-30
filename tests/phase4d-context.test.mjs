import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createEnvelope, loadGraphDefinition, prepareGraph, runGraph, validateGraphFile } from '../runtime/orchestrator.mjs';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { runService } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const graphFile = path.join(root, 'wiring/demo.transcript-context.json');
const registry = await loadContractRegistry(path.join(root, 'contracts/catalog.json'));

test('Phase 4D graph wires policy-gated highest-priority transcription to finalized-only context selection', async () => {
  const prepared = await validateGraphFile(graphFile);
  assert.equal(prepared.services.size, 9);
  const wires = prepared.definition.domain_wires;
  assert.ok(wires.some((wire) => wire.from === 'audio-source' && wire.to === 'transcription-lane' && wire.contract === 'audio.chunk'));
  assert.ok(wires.some((wire) => wire.from === 'transcription-lane' && wire.to === 'speech-to-text' && wire.contract === 'audio.chunk'));
  assert.ok(wires.some((wire) => wire.from === 'active-transcript' && wire.to === 'context-selector' && wire.contract === 'transcript.segment'));
  assert.equal(wires.some((wire) => wire.contract === 'transcript.partial' && wire.to === 'context-selector'), false);
  const result = await runGraph(graphFile, { trace: false });
  assert.equal(result.completions.length, 1);
  const window = result.completions[0];
  assert.equal(window.message_type, 'transcript.context-window');
  assert.equal(window.payload.segments[0].text, 'Argus, you ready?');
  assert.equal(window.payload.selection.policy_id, 'phase4d-default');
  assert.deepEqual(window.payload.triggered_reasons, ['pause']);
  assert.deepEqual(result.dead_letters, []);
});

test('pause, size, topic, and latency triggers are independent and simultaneous reasons remain visible', async () => {
  for (const [name, overrides, expected] of [
    ['pause', { pause_enabled: true }, ['pause']],
    ['size', { max_source_segments: 2 }, ['size']],
    ['topic', { topic_boundary_after_sequences: [1] }, ['topic']],
    ['latency', { max_latency_ms: 2000 }, ['latency']],
    ['all', { pause_enabled: true, max_source_segments: 2, max_source_chars: 15, topic_boundary_after_sequences: [1], max_latency_ms: 2000 }, ['pause', 'size', 'topic', 'latency']]
  ]) {
    const policy = contextPolicy(name, { pause_enabled: false, max_source_segments: 99, max_source_chars: 9999, topic_boundary_after_sequences: [], max_latency_ms: 99999, ...overrides });
    const sessionId = `phase4d-${name}`;
    const result = await runService(manifest('transcript-window-selector'), [policy, segment(0, 'continuation', sessionId), segment(1, name === 'pause' || name === 'all' ? 'pause' : 'continuation', sessionId)], 4);
    const window = result.outputs.find((message) => message.message_type === 'transcript.context-window');
    assert.deepEqual(window.payload.triggered_reasons, expected, name);
    assert.equal(window.payload.reason, expected[0]);
  }
});

test('authoritative windows never overlap while bounded lookback and forward context remain explicitly non-authoritative', async () => {
  const policy = contextPolicy('context', { pause_enabled: false, max_source_segments: 1, max_source_chars: 9999, topic_boundary_after_sequences: [], max_latency_ms: 99999 }, { lookback_segment_count: 1, forward_segment_count: 1, max_context_chars: 25 });
  const result = await runService(manifest('transcript-window-selector'), [policy, segment(0, 'continuation', 'phase4d-context'), segment(1, 'continuation', 'phase4d-context'), segment(2, 'continuation', 'phase4d-context')], 7);
  const windows = result.outputs.filter((message) => message.message_type === 'transcript.context-window');
  assert.equal(windows.length, 2);
  assert.deepEqual(windows.map((window) => window.payload.segments.map((item) => item.sequence)), [[0], [1]]);
  assert.deepEqual(windows[0].payload.context_segments.map((item) => [item.sequence, item.relation]), [[1, 'forward']]);
  assert.deepEqual(windows[1].payload.context_segments.map((item) => [item.sequence, item.relation]), [[0, 'lookback'], [2, 'forward']]);
  assert.deepEqual(registry.validateEnvelope(windows[0]), []);
  const invalid = structuredClone(windows[0]);
  invalid.payload.context_segments[0] = { ...invalid.payload.segments[0], relation: 'forward' };
  invalid.content_fingerprint = (await import('../runtime/message-identity.mjs')).fingerprintMessage(invalid);
  assert.match(registry.validateEnvelope(invalid).join('\n'), /cannot duplicate authoritative source ownership/);
});

test('deterministic transcription gate preserves PCM output and proves scheduler workload without retaining audio in work input', async () => {
  const audio = await runService(manifest('fake-audio-source'), [start('statement')], 3);
  const chunk = audio.outputs.find((message) => message.message_type === 'audio.chunk');
  const gate = await runService(manifest('serial-transcription-gate'), [chunk], 2, 2000, { env: { ARGUS_DIAGNOSTICS: '1' } });
  const scheduled = gate.outputs.find((message) => message.message_type === 'audio.chunk');
  assert.deepEqual(scheduled.payload, chunk.payload);
  assert.ok(gate.diagnostics.some((line) => line.includes('"workload":"transcription"') && line.includes('"scheduler_concurrency":1')));
});

test('alternate STT and alternate selector occupy the same graph positions without neighbor changes', async () => {
  const { definition, graphFile: absolute } = await loadGraphDefinition(graphFile);
  for (const [serviceId, replacement] of [['speech-to-text', '../services/fake-stt-alternate/service.json'], ['context-selector', '../services/transcript-window-selector-alternate/service.json']]) {
    const alternate = structuredClone(definition);
    alternate.services.find((service) => service.id === serviceId).manifest = replacement;
    await assert.doesNotReject(() => prepareGraph(alternate, absolute));
    const graph = await runGraphFromPrepared(alternate, absolute);
    assert.equal(graph.completions[0].message_type, 'transcript.context-window');
    assert.equal(graph.completions[0].payload.segments[0].text, 'Argus, you ready?');
  }
});

test('default-deny graph rejects any partial route to context selection or permanent history', async () => {
  const { definition, graphFile: absolute } = await loadGraphDefinition(graphFile);
  for (const target of ['context-selector', 'transcript-history']) {
    const unsafe = structuredClone(definition);
    unsafe.domain_wires.push({ from: 'speech-to-text', contract: 'transcript.partial', to: target });
    await assert.rejects(() => prepareGraph(unsafe, absolute), new RegExp(`${target} does not declare accepted domain contract transcript\\.partial`));
  }
});

async function runGraphFromPrepared(definition, absolute) {
  const { runPreparedGraph } = await import('../runtime/orchestrator.mjs');
  return runPreparedGraph(await prepareGraph(definition, absolute), { trace: false });
}
function contextPolicy(id, triggers, context = { lookback_segment_count: 0, forward_segment_count: 0, max_context_chars: 12000 }) {
  return createEnvelope({ plane: 'control', messageType: 'transcript.context-policy', producer: 'phase4d-test', correlationId: `phase4d-${id}`, idempotencyKey: `policy:${id}`, payload: {
    policy_id: `policy-${id}`, policy_version: '1.0.0', session_id: `phase4d-${id}`, triggers, context,
    generation: { policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0' }
  } });
}
function segment(sequence, boundary = 'continuation', sessionId = 'phase4d-test') {
  return createEnvelope({ plane: 'domain', messageType: 'transcript.segment', producer: 'phase4d-test', correlationId: sessionId, idempotencyKey: `segment:${sessionId}:${sequence}`, payload: {
    segment_id: `${sessionId}-segment-${sequence}`, session_id: sessionId, sequence, start_time: clock(sequence * 1000), end_time: clock((sequence + 1) * 1000), text: `Segment ${sequence}.`, boundary
  } });
}
function start(fixture) { return createEnvelope({ plane: 'control', messageType: 'lifecycle.start', producer: 'phase4d-test', correlationId: 'phase4d-gate', idempotencyKey: `start:${fixture}`, payload: { session_id: 'phase4d-gate', configuration: { fixture } } }); }
function clock(ms) { return `00:00:${Math.floor(ms / 1000).toString().padStart(2, '0')}.${(ms % 1000).toString().padStart(3, '0')}`; }
function manifest(service) { return path.join(root, 'services', service, 'service.json'); }
