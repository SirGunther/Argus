import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createEnvelope, loadGraphDefinition, prepareGraph, runPreparedGraph } from '../runtime/orchestrator.mjs';
import { SessionLifecycle } from '../runtime/session-lifecycle.mjs';
import { SessionStorage } from '../runtime/session-storage.mjs';
import { runService, runServiceBatches } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contextGraphFile = path.join(root, 'wiring/demo.transcript-context.json');

test('long monologue closes at configured size or latency with bounded active state, queues/context, durable history, and reloadable revisions', async () => {
  for (const [reason, triggers] of [
    ['size', { pause_enabled: false, max_source_segments: 99, max_source_chars: 40, topic_boundary_after_sequences: [], max_latency_ms: 99999 }],
    ['latency', { pause_enabled: false, max_source_segments: 99, max_source_chars: 4000, topic_boundary_after_sequences: [], max_latency_ms: 5000 }]
  ]) {
    const { definition, graphFile } = await loadGraphDefinition(contextGraphFile);
    definition.name = `phase4e-long-monologue-${reason}`;
    definition.run.session_id = `phase4e-long-${reason}`;
    definition.run.timeout_ms = 10000;
    definition.run.configuration.fixture = 'long-monologue';
    definition.run.configuration.context_policy = {
      policy_id: `phase4e-long-${reason}`,
      policy_version: '1.0.0',
      triggers,
      context: { lookback_segment_count: 2, forward_segment_count: 0, max_context_chars: 120 },
      generation: { policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0' }
    };
    const result = await runPreparedGraph(await prepareGraph(definition, graphFile), { trace: false });
    const window = result.completions[0];
    assert.equal(window.message_type, 'transcript.context-window');
    assert.deepEqual(window.payload.triggered_reasons, [reason]);
    assert.deepEqual(window.payload.segments.map((segment) => segment.sequence), [0]);
    assert.equal(window.payload.source.first_segment_id, `phase4e-long-${reason}-segment-0`);
    assert.equal(window.payload.source.last_segment_id, `phase4e-long-${reason}-segment-0`);
    assert.ok(result.metrics.max_queue_depth > 0);
    assert.ok(result.metrics.max_queue_depth <= definition.supervision.queue.capacity);
  }

  const sessionId = 'phase4e-long-ranges';
  const policy = contextPolicy(sessionId, {
    pause_enabled: false,
    max_source_segments: 3,
    max_source_chars: 4000,
    topic_boundary_after_sequences: [],
    max_latency_ms: 99999
  }, { lookback_segment_count: 1, forward_segment_count: 1, max_context_chars: 64 });
  const inputs = [policy, ...Array.from({ length: 12 }, (_, sequence) => segment(sessionId, sequence)), drain(sessionId)];
  const selection = await runService(manifest('transcript-window-selector'), inputs, 19, 5000);
  const windows = selection.outputs.filter((message) => message.message_type === 'transcript.context-window');
  assert.deepEqual(windows.map((window) => window.payload.segments.map((item) => item.sequence)), [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11]
  ]);
  let nextSequence = 0;
  for (const window of windows) {
    const sequences = window.payload.segments.map((item) => item.sequence);
    assert.equal(sequences[0], nextSequence);
    assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, index) => nextSequence + index));
    nextSequence = sequences.at(-1) + 1;
    assert.ok(window.payload.context_segments.filter((item) => item.relation === 'lookback').length <= 1);
    assert.ok(window.payload.context_segments.filter((item) => item.relation === 'forward').length <= 1);
    assert.ok(contextChars(window.payload.context_segments) <= 64);
  }
  assert.equal(nextSequence, 12);

  const durableRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-phase4e-storage-'));
  try {
    const durableSession = 'phase4e-durable-long-monologue';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: durableRoot }), activeCacheLimit: 4 });
    await lifecycle.record({ operation_id: 'record-1', session_id: durableSession, requested_at: '2026-08-19T00:00:00.000Z' });
    const sourceSegments = windows.flatMap((window) => window.payload.segments);
    for (const source of sourceSegments) await lifecycle.acceptTranscriptRevision(durableSession, { ...source, revision: 0, original_stt_text: source.text, word_provenance: [], formatting: { source: 'phase4e-test', provisional_until_finalized: true }, stored_at: '2026-08-19T00:00:00.000Z' });
    assert.ok(lifecycle.memoryStats().transcript_cache_entries <= 4);
    const oldRevision = await lifecycle.resolveTranscriptRevision(durableSession, sourceSegments[0].segment_id, 0);
    assert.equal(oldRevision.sequence, 0);
    const edited = { ...oldRevision, revision: 1, text: 'Reloaded and edited durable segment.', stored_at: '2026-08-19T00:01:00.000Z' };
    await lifecycle.acceptTranscriptRevision(durableSession, edited);
    assert.equal((await lifecycle.resolveTranscriptRevision(durableSession, sourceSegments[0].segment_id, 1)).text, edited.text);
    assert.equal((await lifecycle.storage.readHistory(durableSession, 'transcript')).length, 13);
    const closed = await lifecycle.close({ operation_id: 'close-1', session_id: durableSession, requested_at: '2026-08-19T00:02:00.000Z' });
    assert.equal(closed.transcript_history_count, 13);
    assert.equal(lifecycle.memoryStats().transcript_cache_entries, 0);
  } finally {
    await rm(durableRoot, { recursive: true, force: true });
  }
});

test('at-least-once replay re-emits ephemeral PCM and creates no duplicate words or history revisions', async () => {
  const sessionId = 'phase4e-replay';
  const source = await runService(manifest('fake-audio-source'), [start(sessionId, 'correction-question')], 4);
  const chunks = source.outputs.filter((message) => message.message_type === 'audio.chunk');
  const redelivered = chunks.flatMap((chunk) => [chunk, structuredClone(chunk)]);

  const gate = await runService(manifest('serial-transcription-gate'), redelivered, 12, 5000);
  const scheduled = gate.outputs.filter((message) => message.message_type === 'audio.chunk');
  assert.equal(scheduled.length, 6);
  assert.deepEqual(scheduled.map((message) => message.payload), redelivered.map((message) => message.payload));
  assert.deepEqual(gate.outputs.filter((message) => message.message_type === 'operation.completed').map((message) => message.payload.duplicate), [false, true, false, true, false, true]);
  const completedTraces = gate.diagnostics.filter((line) => line.includes('"status":"completed"'));
  assert.equal(completedTraces.length, 6);
  assert.ok(completedTraces.every((line) => line.includes('"retained_output_count":0') && line.includes('"scheduler_work_input":"chunk_id-only"')));

  const stt = await runService(manifest('fake-stt'), scheduled, 20, 5000);
  const sttDomain = stt.outputs.filter((message) => message.plane === 'domain');
  const replayedWords = sttDomain.filter((message) => message.message_type === 'transcript.word-committed');
  assert.equal(replayedWords.length, 6);
  assert.equal(new Set(replayedWords.map((message) => message.payload.word_id)).size, 3);

  const resolution = correctionResolution(sessionId);
  const active = await runServiceBatches(manifest('active-transcript-owner'), [
    { inputs: sttDomain, expectedOutputCount: 16 },
    { inputs: [resolution, structuredClone(resolution)], expectedOutputCount: 8 }
  ], 5000);
  const finalized = active.outputs.filter((message) => message.message_type === 'transcript.segment');
  assert.equal(finalized.length, 2);
  assert.deepEqual(finalized[0].payload, finalized[1].payload);
  assert.equal(new Set(finalized[0].payload.word_provenance.map((word) => word.word_id)).size, 3);
  assert.deepEqual(new Set(active.outputs.filter((message) => message.message_type === 'transcript.segment-stored').map((message) => message.payload.revision)), new Set([0]));

  const appends = active.outputs.filter((message) => message.message_type === 'transcript.history-append');
  const conflict = createEnvelope({
    plane: 'domain', messageType: 'transcript.history-append', producer: 'phase4e-test', correlationId: sessionId,
    schemaVersion: '1.3.0', idempotencyKey: 'phase4e-replay-conflict',
    payload: { ...appends[0].payload, segment: { ...appends[0].payload.segment, text: 'Conflicting replay.' } }
  });
  const history = await runService(manifest('permanent-transcript-history'), [...appends, conflict], 5);
  const receipts = history.outputs.filter((message) => message.message_type === 'transcript.history-appended');
  assert.equal(receipts.length, 2);
  assert.equal(new Set(receipts.map((message) => message.payload.history_entry_id)).size, 1);
  assert.equal(new Set(receipts.map((message) => message.payload.segment_revision)).size, 1);
  assert.equal(new Set(receipts.map((message) => message.payload.appended_at)).size, 1);
  assert.deepEqual(history.outputs.filter((message) => message.message_type === 'operation.completed').map((message) => message.payload.duplicate), [false, true]);
  assert.equal(history.outputs.at(-1).message_type, 'service.failure');
  assert.equal(history.outputs.at(-1).payload.error.code, 'IDEMPOTENT_INPUT_CONFLICT');
});

test('paused intake preserves active ownership and resumed input continues the same session without Phase 6 lifecycle contracts', async () => {
  const sessionId = 'phase4e-stop-resume';
  const source = await runService(manifest('fake-audio-source'), [start(sessionId, 'correction-question')], 4);
  const chunks = source.outputs.filter((message) => message.message_type === 'audio.chunk');
  const stt = await runService(manifest('fake-stt'), chunks, 10);
  const domain = stt.outputs.filter((message) => message.plane === 'domain');
  const update = segmentUpdate(sessionId, 'resume-edit', 'Argus, are you ready?');
  const latePartial = createEnvelope({
    plane: 'domain', messageType: 'transcript.partial', producer: 'phase4e-test', correlationId: sessionId, idempotencyKey: 'late-partial-after-resume',
    payload: { ...domain.findLast((message) => message.message_type === 'transcript.partial').payload, revision: 3, replaces_revision: 2, text: 'Late provisional text.' }
  });
  const staleUpdate = segmentUpdate(sessionId, 'stale-resume-edit', 'Stale resumed edit.');

  const active = await runServiceBatches(manifest('active-transcript-owner'), [
    { inputs: domain.slice(0, 5), expectedOutputCount: 5, pauseAfterMs: 30 },
    { inputs: domain.slice(5), expectedOutputCount: 3 },
    { inputs: [correctionResolution(sessionId)], expectedOutputCount: 4 },
    { inputs: [update], expectedOutputCount: 3 },
    { inputs: [latePartial, staleUpdate], expectedOutputCount: 2 }
  ], 5000);

  assert.ok(active.pid > 0);
  const request = active.batchOutputs[1].find((message) => message.message_type === 'transcript.correction-request');
  assert.equal(request.payload.session_id, sessionId);
  assert.deepEqual(request.payload.words.map((word) => word.sequence), [0, 1, 2]);
  const revision0 = active.batchOutputs[2].find((message) => message.message_type === 'transcript.segment-stored');
  const revision1 = active.batchOutputs[3].find((message) => message.message_type === 'transcript.segment-stored');
  assert.equal(revision0.payload.sequence, 0);
  assert.equal(revision0.payload.session_id, sessionId);
  assert.deepEqual([revision0.payload.revision, revision1.payload.revision], [0, 1]);
  assert.equal(revision1.payload.original_stt_text, revision0.payload.original_stt_text);
  assert.deepEqual(revision1.payload.word_provenance, revision0.payload.word_provenance);
  assert.deepEqual(active.batchOutputs[4].map((message) => message.payload.reason.code), ['LATE_PROJECTION', 'STALE_REVISION']);
});

function contextPolicy(sessionId, triggers, context) {
  return createEnvelope({ plane: 'control', messageType: 'transcript.context-policy', producer: 'phase4e-test', correlationId: sessionId, idempotencyKey: `policy:${sessionId}`, payload: {
    policy_id: `policy-${sessionId}`, policy_version: '1.0.0', session_id: sessionId, triggers, context,
    generation: { policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0' }
  } });
}

function segment(sessionId, sequence) {
  return createEnvelope({ plane: 'domain', messageType: 'transcript.segment', producer: 'phase4e-test', correlationId: sessionId, idempotencyKey: `segment:${sessionId}:${sequence}`, payload: {
    segment_id: `${sessionId}-segment-${sequence}`, session_id: sessionId, sequence,
    start_time: clock(sequence * 1000), end_time: clock((sequence + 1) * 1000), text: `Synthetic segment ${sequence}.`, boundary: 'continuation'
  } });
}

function start(sessionId, fixture) {
  return createEnvelope({ plane: 'control', messageType: 'lifecycle.start', producer: 'phase4e-test', correlationId: sessionId, idempotencyKey: `start:${sessionId}:${fixture}`, payload: {
    session_id: sessionId, configuration: { fixture }
  } });
}

function drain(sessionId) {
  return createEnvelope({ plane: 'control', messageType: 'lifecycle.drain', producer: 'phase4e-test', correlationId: sessionId, idempotencyKey: `drain:${sessionId}`, payload: {
    reason: 'phase4e-test', deadline_ms: 1000
  } });
}

function correctionResolution(sessionId) {
  const firstWordId = `${sessionId}-word-0`;
  return createEnvelope({ plane: 'domain', messageType: 'transcript.correction-resolved', producer: 'phase4e-test', correlationId: sessionId, idempotencyKey: `resolution:${sessionId}`, payload: {
    request_id: `${sessionId}-utterance-0-boundary-correction`, session_id: sessionId, utterance_id: `${sessionId}-utterance-0`, boundary_id: `${sessionId}-utterance-0-boundary`,
    proposals: [{ proposal_id: `${sessionId}-proposal-0`, target_word_id: firstWordId, target_word_sequence: 0, expected_text: 'are', proposed_text: 'Argus', confidence: 0.96, basis: 'acoustic-and-contextual', context: { first_word_id: firstWordId, last_word_id: `${sessionId}-word-2` } }],
    formatting: { terminal_mark: '?', capitalize_first_word: true, confidence: 0.97 }, punctuation_after: [{ word_id: firstWordId, mark: ',' }],
    generator: { implementation: 'phase4e-test-corrector', policy_profile: 'working-document-default', instruction_version: '1.0.0' }
  } });
}

function segmentUpdate(sessionId, key, text) {
  return createEnvelope({ plane: 'domain', messageType: 'transcript.segment-update', producer: 'phase4e-test', correlationId: sessionId, idempotencyKey: key, payload: {
    segment_id: `${sessionId}-segment-0`, session_id: sessionId, expected_revision: 0, text, updated_at: '2026-08-18T12:00:00.000Z', editor: 'user'
  } });
}

function contextChars(segments) {
  return segments.reduce((sum, item, index) => sum + item.text.length + (index ? 1 : 0), 0);
}

function clock(ms) {
  return `00:00:${Math.floor(ms / 1000).toString().padStart(2, '0')}.${(ms % 1000).toString().padStart(3, '0')}`;
}

function manifest(service) {
  return path.join(root, 'services', service, 'service.json');
}
