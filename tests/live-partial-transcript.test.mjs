import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAudioPreviewScheduler } from '../runtime/audio-preview-scheduler.mjs';
import { DesktopApplication } from '../runtime/desktop-application.mjs';
import { createSerialWhisperLane } from '../services/whisper-cpp-stt/preview-scheduler.mjs';
import { runServiceBatches } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const whisperManifest = path.join(root, 'services', 'whisper-cpp-stt', 'service.json');

test('preview scheduler keeps cadence bounded and replaces its single pending snapshot', async () => {
  const timers = [];
  const dispatched = [];
  const snapshots = [];
  let releaseFirst;
  const scheduler = createAudioPreviewScheduler({
    cadenceMs: 1,
    snapshot: ({ utterance_id, revision }) => {
      const value = Object.freeze({ utterance_id, revision, covered_chunk_ids: [`chunk-${revision}`] });
      snapshots.push(value);
      return value;
    },
    dispatch: (request) => {
      dispatched.push(request);
      if (dispatched.length === 1) return new Promise((resolve) => { releaseFirst = resolve; });
      return Promise.resolve();
    },
    scheduleTimer: (callback) => { timers.push(callback); return callback; },
    cancelTimer: (callback) => { const index = timers.indexOf(callback); if (index >= 0) timers.splice(index, 1); }
  });

  scheduler.observe('utterance-1');
  assert.equal(scheduler.cadenceMs, 1500, 'production cadence is clamped to the governed lower bound');
  timers.shift()();
  await Promise.resolve();
  scheduler.observe('utterance-1');
  timers.shift()();
  scheduler.observe('utterance-1');
  timers.shift()();
  assert.equal(scheduler.pending, true);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.revision), [1, 2, 3]);
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(dispatched.map((request) => request.revision), [1, 3], 'the newest snapshot replaces an older pending preview');
  scheduler.finalize('utterance-1');
  assert.equal(scheduler.pending, false);
  assert.equal(timers.length, 0);
  scheduler.stop();
});

test('final Whisper work cancels active preview work and prevents late provisional output', async () => {
  const events = [];
  const lane = createSerialWhisperLane({ diagnostic: (event) => events.push(event) });
  lane.submitPreview({ utterance_id: 'utterance-1', revision: 1, run: (signal) => new Promise((_resolve, reject) => {
    events.push('preview-started');
    signal.addEventListener('abort', () => reject(Object.assign(new Error('superseded'), { code: 'STT_PREVIEW_SUPERSEDED' })), { once: true });
  }) });
  await Promise.resolve();
  const final = await lane.runFinal({ utterance_id: 'utterance-1', run: async () => { events.push('final-started'); return 'final'; } });
  assert.equal(final, 'final');
  assert.equal(lane.isFinalized('utterance-1'), true);
  assert.equal(lane.pending, false);
  assert.ok(events.includes('preview-started'));
  assert.ok(events.includes('final-started'));
});

test('desktop capture accepts new chunks while preview dispatch is unresolved and final flush remains independent', async () => {
  const sessionId = 'desktop-live-preview-session';
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-desktop-live-${Date.now()}`) });
  application.sessionId = sessionId;
  application.metadata = { session_id: sessionId, state: 'recording' };
  const timers = [];
  const calls = [];
  let releasePreview;
  application.graph = {
    closed: false,
    async dispatchFrom(_from, _plane, type, _correlationId, payload) {
      calls.push({ type, payload });
      if (type === 'audio.preview') return new Promise((resolve) => { releasePreview = resolve; });
    }
  };
  application.audioPreviewScheduler = createAudioPreviewScheduler({
    cadenceMs: 1,
    snapshot: ({ utterance_id, revision }) => application.audioPreviewSnapshot(utterance_id, revision),
    dispatch: (snapshot) => application.dispatchAudioPreview(snapshot),
    scheduleTimer: (callback) => { timers.push(callback); return callback; },
    cancelTimer: (callback) => { const index = timers.indexOf(callback); if (index >= 0) timers.splice(index, 1); }
  });

  await application.acceptAudioChunk(audioChunk(sessionId, 0).payload);
  timers.shift()();
  await Promise.resolve();
  const previewCall = calls.find((call) => call.type === 'audio.preview');
  assert.ok(previewCall);
  assert.deepEqual(previewCall.payload.covered_chunk_ids, [`${sessionId}-chunk-0`]);
  assert.equal(Object.isFrozen(previewCall.payload), true);
  await application.acceptAudioChunk(audioChunk(sessionId, 1).payload);
  assert.equal(application.audioCurrentUtterance.length, 2, 'capture continues while preview IPC is unresolved');
  assert.equal((await application.acceptAudioFlush({ session_id: sessionId, reason: 'pause' })).queued, true);
  await application.waitForAudioIdle();
  assert.ok(calls.some((call) => call.type === 'audio.flush'), 'final flush is not held behind preview dispatch');
  releasePreview();
  await application.audioPreviewScheduler.waitForIdle();
  application.audioPreviewScheduler.stop();
});

test('real Whisper adapter emits revisioned partials without durable or committed provisional output', async () => {
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-live-preview-session-'));
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-live-preview-probe-'));
  const binary = path.join(probeRoot, 'whisper-preview-probe.cmd');
  const model = path.join(probeRoot, 'model.bin');
  const counter = path.join(probeRoot, 'launches.txt');
  await writeFile(model, 'model');
  await writeFile(binary, '@echo off\r\nif not "%ARGUS_PROBE_COUNTER%"=="" echo launch>>"%ARGUS_PROBE_COUNTER%"\r\n> "%~7.json" echo {"transcription":[{"text":" Live preview.","offsets":{"from":0,"to":256},"tokens":[{"text":" Live","p":0.91,"offsets":{"from":0,"to":128}},{"text":" preview","p":0.92,"offsets":{"from":128,"to":224}},{"text":".","p":0.93,"offsets":{"from":224,"to":256}}]}]}\r\n');
  const sessionId = 'live-preview-service-session';
  const utteranceId = `${sessionId}-utterance-0`;
  const chunk = audioChunk(sessionId, 0);
  const preview = envelope('audio.preview', `${sessionId}:preview:1`, {
    preview_id: `${utteranceId}-preview-1`, session_id: sessionId, utterance_id: utteranceId, revision: 1,
    requested_at: '2026-08-30T00:00:00.000Z', start_time: '00:00:00.000', end_time: '00:00:00.256',
    sample_count: 2, byte_length: 4, pcm_base64: 'AAABAA==', checksum: 'sha256:6b1e73a0094b7b812d3b9e22cffb4f8239319847522c4fa103753b6950020f93', covered_chunk_ids: [chunk.payload.chunk_id]
  });
  const preview2 = structuredClone(preview);
  preview2.message_id = `${sessionId}:preview:2`;
  preview2.idempotency_key = `${sessionId}:preview:2`;
  preview2.payload.preview_id = `${utteranceId}-preview-2`;
  preview2.payload.revision = 2;
  const flush = envelope('audio.flush', `${sessionId}:flush`, { session_id: sessionId, utterance_id: utteranceId, requested_at: '2026-08-30T00:00:00.000Z', reason: 'pause' });
  try {
    const result = await runServiceBatches(whisperManifest, [
      { inputs: [chunk], expectedOutputCount: 1 },
      { inputs: [preview], expectedOutputCount: 2, pauseAfterMs: 20 },
      { inputs: [preview2], expectedOutputCount: 2, pauseAfterMs: 20 },
      { inputs: [flush], expectedOutputCount: 4 }
    ], 10000, { env: { ARGUS_SESSION_ROOT: sessionRoot, ARGUS_WHISPER_BINARY: binary, ARGUS_WHISPER_MODEL: model, ARGUS_PROBE_COUNTER: counter } });
    const partials = result.outputs.filter((message) => message.message_type === 'transcript.partial');
    assert.deepEqual(partials.map((message) => message.payload.revision), [1, 2]);
    assert.deepEqual(partials.map((message) => message.payload.replaces_revision), [0, 1]);
    assert.ok(partials.every((message) => message.payload.utterance_id === utteranceId));
    assert.equal(result.outputs.some((message) => message.message_type === 'transcript.word-committed' && message.payload.utterance_id === utteranceId && message.payload.text === 'Live'), true);
    assert.equal(result.outputs.some((message) => ['transcript.history-append', 'transcript.segment', 'transcript.segment-stored'].includes(message.message_type)), false);
    assert.equal((await readFile(counter, 'utf8')).trim().split(/\r?\n/).filter(Boolean).length, 3, 'each real preview/final request uses the same governed Whisper executable');
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
    await rm(probeRoot, { recursive: true, force: true });
  }
});

test('source wiring uses real preview projection semantics and no browser speech fallback', async () => {
  const app = await readFile(path.join(root, 'app.js'), 'utf8');
  const wiring = await readFile(path.join(root, 'wiring', 'production-electron.json'), 'utf8');
  assert.doesNotMatch(app, /SpeechRecognition/);
  assert.match(app, /item\.provisional/);
  assert.match(app, /item\.revision <= collection\[index\]\.revision/);
  assert.match(wiring, /"audio\.preview"/);
});

function audioChunk(sessionId, sequence) {
  return envelope('audio.chunk', `${sessionId}:chunk:${sequence}`, {
    chunk_id: `${sessionId}-chunk-${sequence}`, session_id: sessionId, sequence,
    start_time: '00:00:00.000', end_time: '00:00:00.256',
    format: { encoding: 'pcm-signed-integer', sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, byte_order: 'little-endian' },
    sample_count: 2, byte_length: 4, audio_base64: 'AAABAA==', checksum: 'sha256:6b1e73a0094b7b812d3b9e22cffb4f8239319847522c4fa103753b6950020f93'
  });
}

function envelope(messageType, idempotencyKey, payload) {
  return {
    message_id: idempotencyKey, idempotency_key: idempotencyKey, plane: 'domain', message_type: messageType,
    timestamp: '2026-08-30T00:00:00.000Z', producer: 'live-preview-test', correlation_id: payload.session_id, schema_version: '1.2.0', payload
  };
}
