import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DesktopApplication } from '../runtime/desktop-application.mjs';
import { SessionLifecycle } from '../runtime/session-lifecycle.mjs';
import { SessionStorage } from '../runtime/session-storage.mjs';
import { createSessionTimer } from '../ui/session-timer.mjs';
import { runServiceBatches } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const whisperManifest = path.join(root, 'services', 'whisper-cpp-stt', 'service.json');

test('session timer ticks only while recording and resumes from authoritative accumulated time', () => {
  let now = 0;
  const timer = createSessionTimer({ clock: () => now });
  timer.applyProjection({ session_id: 'timer-session', state: 'recording', elapsed_seconds: 0 });
  assert.equal(timer.current(), 0);
  now = 2100;
  assert.equal(timer.current(), 2);
  timer.applyProjection({ session_id: 'timer-session', state: 'stopped', elapsed_seconds: 2 });
  now += 10000;
  assert.equal(timer.current(), 2, 'stopped time must not accumulate');
  timer.applyProjection({ session_id: 'timer-session', state: 'recording', elapsed_seconds: 2 });
  now += 1100;
  assert.equal(timer.current(), 3, 'resume must continue from the stopped accumulation');
  timer.pause();
  now += 10000;
  assert.equal(timer.current(), 3, 'Stop/Close pause the visible timer');
});

test('New Session emits an authoritative recording projection for its new identity', async () => {
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-new-session-${Date.now()}`) });
  application.metadata = { session_id: 'closed-session', state: 'closed' };
  application.sessionId = 'closed-session';
  application.boundary = { projection: (messageType, payload) => ({ message_type: messageType, payload }) };
  application.graph = { dispatchFrom: async () => {}, closed: false };
  const createdAt = new Date().toISOString();
  application.loadLatestSession = async (sessionId) => {
    application.sessionId = sessionId;
    application.metadata = {
      session_id: sessionId, state: 'recording', revision: 1, created_at: createdAt, started_at: createdAt,
      operations: { record: { operation: 'session.record', outcome: { completed_at: createdAt } } }
    };
    application.transcript = [];
    application.loggedItems = [];
  };
  const projections = [];
  application.onProjection((message) => projections.push(message));
  const result = await application.newSessionCommand({ command: 'session.new', command_id: 'new-session-command', session_id: 'closed-session' });
  assert.equal(result.command, 'session.new');
  assert.equal(result.status, 'accepted');
  assert.equal(result.session_id, application.sessionId);
  assert.deepEqual(projections.at(-1), { message_type: 'ui.session-status', payload: { session_id: application.sessionId, state: 'recording', elapsed_seconds: 0, created_at: createdAt, duration_seconds: 0, transcript_count: 0, logged_item_count: 0, audio_processing: { state: 'listening', queue_depth: 0, capture_state: 'idle', transcription_state: 'idle' } } });
});

test('delayed transcription accepts later chunks and completes FIFO without mixing utterances', async () => {
  const sessionId = 'delayed-transcription-session';
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-delayed-${Date.now()}`) });
  application.sessionId = sessionId;
  application.metadata = { session_id: sessionId, state: 'recording', revision: 1, created_at: '2026-08-30T00:00:00.000Z', started_at: '2026-08-30T00:00:00.000Z', operations: { record: { operation: 'session.record', outcome: { completed_at: '2026-08-30T00:00:00.000Z' } } } };
  application.boundary = { projection: (messageType, payload) => ({ message_type: messageType, payload }) };
  application.started = true;
  const projections = [];
  application.onProjection((message) => projections.push(message));
  const serviceChunks = [];
  const completedUtterances = [];
  let activeTranscriptions = 0;
  let maxConcurrentTranscriptions = 0;
  let releaseFirstFlush;
  const firstFlushStarted = new Promise((resolve) => {
    application.graph = {
      closed: false,
      async dispatchFrom(_from, _plane, type, _correlationId, payload) {
        if (type === 'audio.chunk') {
          serviceChunks.push(payload.sequence);
          return;
        }
        if (type !== 'audio.flush') return;
        // The held flush models deliberately slow Whisper inference; this test does not claim physical-microphone acceptance.
        const utterance = serviceChunks.splice(0);
        activeTranscriptions += 1;
        maxConcurrentTranscriptions = Math.max(maxConcurrentTranscriptions, activeTranscriptions);
        try {
          if (!releaseFirstFlush) {
            resolve();
            await new Promise((release) => { releaseFirstFlush = release; });
          }
          completedUtterances.push(utterance);
        } finally {
          activeTranscriptions -= 1;
        }
      }
    };
  });

  const chunk = (sequence) => ({
    chunk_id: `${sessionId}-chunk-${sequence}`, session_id: sessionId, sequence,
    start_time: `00:00:0${sequence}.000`, end_time: `00:00:0${sequence}.256`,
    format: { encoding: 'pcm-signed-integer', sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, byte_order: 'little-endian' },
    sample_count: 2, byte_length: 4, audio_base64: 'AAABAA==', checksum: 'sha256:6b1e73a0094b7b812d3b9e22cffb4f8239319847522c4fa103753b6950020f93'
  });

  await application.acceptAudioChunk(chunk(0));
  await application.acceptAudioChunk(chunk(1));
  assert.equal((await application.acceptAudioFlush({ session_id: sessionId, reason: 'pause' })).queued, true);
  await firstFlushStarted;
  assert.equal(Object.isFrozen(application.audioActiveFlush.utterance), true);
  assert.equal(Object.isFrozen(application.audioActiveFlush.utterance.chunks), true);

  const laterChunks = await Promise.all([application.acceptAudioChunk(chunk(2)), application.acceptAudioChunk(chunk(3))]);
  assert.deepEqual(laterChunks.map((result) => result.accepted), [true, true]);
  assert.equal((await application.acceptAudioFlush({ session_id: sessionId, reason: 'pause' })).queued, true);
  assert.ok(projections.some((message) => message.payload.audio_processing?.state === 'transcribing'));

  releaseFirstFlush();
  await application.waitForAudioIdle();
  assert.deepEqual(completedUtterances, [[0, 1], [2, 3]]);
  assert.equal(maxConcurrentTranscriptions, 1);
  assert.ok(projections.some((message) => message.payload.audio_processing?.state === 'queued' || message.payload.audio_processing?.queue_depth > 0));
});

test('sustained capture rolls over after 120 chunks without dropping or mixing audio', async () => {
  const sessionId = 'size-rollover-session';
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-rollover-${Date.now()}`) });
  application.sessionId = sessionId;
  application.metadata = { session_id: sessionId, state: 'recording', revision: 1, created_at: '2026-08-30T00:00:00.000Z', started_at: '2026-08-30T00:00:00.000Z' };
  const serviceChunks = [];
  const completedUtterances = [];
  let activeTranscriptions = 0;
  let maxConcurrentTranscriptions = 0;
  let releaseFirstFlush;
  let firstFlushStarted;
  const firstFlush = new Promise((resolve) => { firstFlushStarted = resolve; });
  application.graph = {
    closed: false,
    async dispatchFrom(_from, _plane, type, _correlationId, payload) {
      if (type === 'audio.chunk') {
        serviceChunks.push(payload.sequence);
        return;
      }
      if (type !== 'audio.flush') return;
      const utterance = serviceChunks.splice(0);
      activeTranscriptions += 1;
      maxConcurrentTranscriptions = Math.max(maxConcurrentTranscriptions, activeTranscriptions);
      try {
        if (!releaseFirstFlush) {
          firstFlushStarted();
          await new Promise((resolve) => { releaseFirstFlush = resolve; });
        }
        completedUtterances.push(utterance);
      } finally {
        activeTranscriptions -= 1;
      }
    }
  };

  const chunk = (sequence) => ({
    chunk_id: `${sessionId}-chunk-${sequence}`, session_id: sessionId, sequence,
    start_time: '00:00:00.000', end_time: '00:00:00.256',
    format: { encoding: 'pcm-signed-integer', sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, byte_order: 'little-endian' },
    sample_count: 2, byte_length: 4, audio_base64: 'AAABAA==', checksum: 'sha256:6b1e73a0094b7b812d3b9e22cffb4f8239319847522c4fa103753b6950020f93'
  });

  // Deterministic delayed-Whisper coverage only; no physical microphone is simulated.
  for (let sequence = 0; sequence <= 120; sequence += 1) await application.acceptAudioChunk(chunk(sequence));
  await firstFlush;
  assert.equal(application.audioCurrentUtterance.length, 1);
  assert.equal((await application.acceptAudioFlush({ session_id: sessionId, reason: 'pause' })).queued, true);
  releaseFirstFlush();
  await application.waitForAudioIdle();

  assert.deepEqual(completedUtterances, [Array.from({ length: 120 }, (_, sequence) => sequence), [120]]);
  assert.equal(maxConcurrentTranscriptions, 1);
  assert.equal(application.audioProcessingError, undefined);
});

test('startup recovery routes an unclean recording through the lifecycle owner and preserves duration', async () => {
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-recovery-correction-'));
  const sessionId = 'unclean-recording-session';
  const times = ['2026-08-30T00:00:00.000Z', '2026-08-30T00:00:06.656Z'];
  const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: sessionRoot }), clock: () => times.shift() || '2026-08-30T00:00:06.656Z' });
  await lifecycle.record({ operation_id: 'record-unclean', session_id: sessionId, requested_at: '2026-08-30T00:00:00.000Z' });
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot });
  const calls = [];
  application.graph = {
    async dispatchFrom(_from, plane, type, _correlationId, payload) { calls.push(`${plane}:${type}`); if (type === 'session.stop') await lifecycle.stop(payload); },
    async waitForIdle() {}
  };
  await application.recoverUncleanRecordings();
  assert.deepEqual(calls, ['control:session.stop']);
  await application.loadLatestSession(sessionId);
  assert.equal(application.metadata.state, 'stopped');
  assert.equal(application.sessionProjection().elapsed_seconds, 6);
  await rm(sessionRoot, { recursive: true, force: true });
});

test('Whisper buffers many chunks without launching and launches exactly once on flush', async () => {
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-whisper-correction-'));
  const tempRoot = path.join(sessionRoot, '.argus-stt');
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-whisper-probe-'));
  const binary = path.join(probeRoot, 'whisper-probe.cmd');
  const model = path.join(probeRoot, 'model.bin');
  const counter = path.join(probeRoot, 'launches.txt');
  await mkdir(tempRoot, { recursive: true });
  await writeFile(path.join(tempRoot, '99999-1-dead.wav'), 'abandoned');
  await writeFile(path.join(tempRoot, '99999-1-dead.json'), '{}');
  await writeFile(model, 'model');
  await writeFile(binary, '@echo off\r\nif not "%ARGUS_PROBE_COUNTER%"=="" echo launch>>"%ARGUS_PROBE_COUNTER%"\r\n> "%~7.json" echo {"transcription":[{"text":"[*BEG*] Okay . [_TT_250].","offsets":{"from":0,"to":6656},"tokens":[{"text":"[*BEG*]","p":0.99,"offsets":{"from":0,"to":0}},{"text":"Okay","p":0.91,"offsets":{"from":0,"to":6000}},{"text":".","p":0.92,"offsets":{"from":6000,"to":6656}},{"text":"[_TT_250]","p":0.99,"offsets":{"from":6656,"to":6656}}]}]}\r\n');
  const sessionId = 'whisper-correction-session';
  const chunks = Array.from({ length: 12 }, (_, sequence) => whisperChunk(sequence, sessionId));
  const flush = envelope('audio.flush', `${sessionId}:flush`, { session_id: sessionId, requested_at: '2026-08-30T00:00:00.000Z', reason: 'flush' });
  try {
    const result = await runServiceBatches(whisperManifest, [
      { inputs: chunks, expectedOutputCount: chunks.length },
      { inputs: [flush], expectedOutputCount: 4 }
    ], 10000, { env: { ARGUS_SESSION_ROOT: sessionRoot, ARGUS_WHISPER_BINARY: binary, ARGUS_WHISPER_MODEL: model, ARGUS_PROBE_COUNTER: counter } });
    assert.equal((await readFile(counter, 'utf8')).trim().split(/\r?\n/).filter(Boolean).length, 1);
    const words = result.outputs.filter((message) => message.message_type === 'transcript.word-committed');
    assert.deepEqual(words.map((message) => message.payload.text), ['Okay', '.']);
    assert.equal(JSON.stringify(words).includes('[*BEG*]'), false);
    assert.equal(JSON.stringify(words).includes('[_TT_250]'), false);
    assert.equal(JSON.stringify(result.outputs).includes('<|'), false);
    await assert.rejects(readFile(path.join(tempRoot, '99999-1-dead.wav')), /ENOENT/);
    await assert.rejects(readFile(path.join(tempRoot, '99999-1-dead.json')), /ENOENT/);
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
    await rm(probeRoot, { recursive: true, force: true });
  }
});

test('shutdown waits for audio, routes stop before graph drain, and ignores late audio stably', async () => {
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-shutdown-${Date.now()}`) });
  application.sessionId = 'shutdown-session';
  application.metadata = { session_id: application.sessionId, state: 'recording', revision: 1, created_at: '2026-08-30T00:00:00.000Z', started_at: '2026-08-30T00:00:00.000Z', operations: { record: { operation: 'session.record', outcome: { completed_at: '2026-08-30T00:00:00.000Z' } } } };
  application.boundary = { projection: (messageType, payload) => ({ message_type: messageType, payload }) };
  const calls = [];
  application.graph = {
    closed: false,
    async dispatchFrom(_from, plane, type) { calls.push(`${plane}:${type}`); },
    async waitForIdle() { calls.push('waitForIdle'); },
    async close() { calls.push('close'); this.closed = true; }
  };
  application.loadLatestSession = async () => {};
  application.audioInFlight = 1;
  const shutdown = application.shutdown();
  assert.deepEqual(calls, []);
  assert.deepEqual(await application.acceptAudioChunk({ session_id: application.sessionId }), { accepted: false, ignored: true, code: 'SHUTDOWN_IN_PROGRESS', session_id: application.sessionId, reason: 'Application shutdown is in progress.' });
  application.audioInFlight = 0;
  application.resolveAudioIdleWaiters();
  await shutdown;
  assert.ok(calls.indexOf('domain:audio.flush') < calls.indexOf('control:session.stop'));
  assert.equal(calls.at(-1), 'close');
});

function whisperChunk(sequence, sessionId) {
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
    timestamp: '2026-08-30T00:00:00.000Z', producer: 'correction-test', correlation_id: payload.session_id, schema_version: '1.2.0', payload
  };
}
