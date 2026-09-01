import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDiagnosticFileOutput, createDiagnosticLogger } from '../runtime/diagnostics.mjs';
import { DesktopApplication } from '../runtime/desktop-application.mjs';
import { runServiceBatches } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const whisperManifest = path.join(root, 'services', 'whisper-cpp-stt', 'service.json');

test('diagnostic logger removes raw audio fields and caps transcript previews', () => {
  const lines = [];
  const logger = createDiagnosticLogger({ enabled: true, output: { write: (line) => lines.push(line) }, clock: () => '2026-08-30T00:00:00.000Z' });
  logger.log('sanitizer.check', {
    session_id: 'diagnostic-session',
    audio_base64: 'AAABAA==',
    pcm_base64: 'AAABAA==',
    apiKey: 'must-not-appear',
    environment: { ARGUS_SECRET: 'must-not-appear' },
    samples: [0.1, 0.2],
    payload: { audio_base64: 'AAABAA==' },
    transcript_preview: 'x'.repeat(400)
  });
  const line = lines.join('');
  assert.equal(line.includes('audio_base64'), false);
  assert.equal(line.includes('pcm_base64'), false);
  assert.equal(line.includes('must-not-appear'), false);
  assert.equal(line.includes('AAABAA=='), false);
  assert.equal(JSON.parse(line).transcript_preview.length, 160);
});

test('diagnostic JSONL output stays valid and bounded through rotation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'argus-diagnostic-file-'));
  const filePath = path.join(directory, 'run.jsonl');
  const terminal = [];
  const output = createDiagnosticFileOutput({ filePath, terminal: { write: (line) => terminal.push(line) }, maxBytes: 1024, maxRotations: 2 });
  const logger = createDiagnosticLogger({ enabled: true, output, clock: () => '2026-08-30T00:00:00.000Z' });
  for (let index = 0; index < 80; index += 1) logger.log('bounded.event', { sequence: index, transcript_preview: 'diagnostic text' });
  output.close();
  try {
    const names = (await readdir(directory)).filter((name) => name.startsWith('run.jsonl'));
    assert.deepEqual(names.sort(), ['run.jsonl', 'run.jsonl.1', 'run.jsonl.2']);
    const contents = await Promise.all(names.map((name) => readFile(path.join(directory, name), 'utf8')));
    assert.ok(contents.every((content) => Buffer.byteLength(content) <= 1024));
    assert.ok(contents.flatMap((content) => content.trim().split('\n')).every((line) => JSON.parse(line).event === 'bounded.event'));
    assert.equal(terminal.length, 80);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('diagnostic launcher reuses one stable rotating file across runs', async () => {
  const launcher = await readFile(path.join(root, 'scripts', 'start-diagnostics.mjs'), 'utf8');
  const electron = await readFile(path.join(root, 'electron', 'main.cjs'), 'utf8');
  assert.match(launcher, /runtime-output['"],\s*['"]diagnostics['"],\s*['"]argus-finalization\.jsonl['"]/);
  assert.match(electron, /diagnostics['"],\s*['"]argus-finalization\.jsonl['"]/);
  assert.doesNotMatch(launcher, /Date\.now\(\)|timestamp.*jsonl/);
});

test('preview progress emits an observational possible-stall warning with queue state', async () => {
  const lines = [];
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-stall-${Date.now()}`), diagnosticsEnabled: true, diagnosticsOutput: { write: (line) => lines.push(line) }, diagnosticStallThresholdMs: 10 });
  application.observePreviewRevision({ session_id: 'stall-session', utterance_id: 'stall-session-utterance-0', preview_id: 'stall-preview-1', revision: 1, first_sequence: 0, last_sequence: 7, chunk_count: 8 });
  application.markPreviewStage('stall-session-utterance-0', 'whisper.preview');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const warning = lines.map((line) => JSON.parse(line)).find((record) => record.event === 'pipeline.possible-stall');
  assert.equal(warning.utterance_id, 'stall-session-utterance-0');
  assert.equal(warning.preview_revision, 1);
  assert.equal(warning.last_successfully_completed_stage, 'whisper.preview');
  assert.equal(warning.active_worker_state, 'idle');
  application.clearPipelineStallDetection();
});

test('host worker and flush diagnostics retain shared correlation identities', async () => {
  const lines = [];
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-host-diagnostics-${Date.now()}`), diagnosticsEnabled: true, diagnosticsOutput: { write: (line) => lines.push(line) } });
  application.sessionId = 'host-diagnostics-session';
  application.graph = { closed: false, dispatchFrom: async (_from, _plane, messageType, sessionId, payload, idempotencyKey) => ({ message_id: `${messageType}:${idempotencyKey}`, message_type: messageType, correlation_id: sessionId, payload }) };
  const makeWork = (sequence) => ({ idempotencyKey: `host-diagnostics-flush-${sequence}`, utterance: { session_id: application.sessionId, utterance_id: `${application.sessionId}-utterance-${sequence}`, audio_window_id: `${application.sessionId}-audio-window-${sequence}`, chunks: [{ chunk_id: `${application.sessionId}-chunk-${sequence}`, sequence, start_time: '00:00:00.000', end_time: '00:00:00.256', audio_base64: 'AAABAA==' }], requested_at: '2026-08-30T00:00:00.000Z', reason: 'pause' } });
  application.audioQueuedUtterances = 2;
  application.audioQueuedChunkCount = 2;
  application.enqueueAudioWork(makeWork(0));
  application.enqueueAudioWork(makeWork(1));
  await application.waitForAudioIdle();
  const records = lines.map((line) => JSON.parse(line));
  const worker = records.find((record) => record.event === 'audio.worker-started');
  const flushBeginning = records.find((record) => record.event === 'audio.flush-dispatch-beginning');
  const flushCompleted = records.find((record) => record.event === 'audio.flush-dispatch-completed');
  assert.ok(worker.worker_invocation_id);
  assert.equal(flushBeginning.flush_id, flushCompleted.flush_id);
  assert.equal(flushBeginning.utterance_id, flushCompleted.utterance_id);
  assert.ok(records.some((record) => record.event === 'audio.queue-state-after-terminal-outcome' && record.outcome === 'completed'));
  assert.equal(lines.join('').includes('audio_base64'), false);
});

test('empty Whisper result is observable and the next queued window still transcribes', async () => {
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-empty-diagnostics-'));
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-empty-probe-'));
  const binary = path.join(probeRoot, 'whisper-empty-then-word.cmd');
  const model = path.join(probeRoot, 'model.bin');
  const counter = path.join(probeRoot, 'counter.txt');
  await mkdir(path.join(sessionRoot, '.argus-stt'), { recursive: true });
  await writeFile(model, 'model');
  const whisperScript = [
    '@echo off',
    'setlocal EnableDelayedExpansion',
    'if not exist "%ARGUS_PROBE_COUNTER%" echo 0>"%ARGUS_PROBE_COUNTER%"',
    'set /p count=<"%ARGUS_PROBE_COUNTER%"',
    'set /a count+=1',
    'echo !count!>"%ARGUS_PROBE_COUNTER%"',
    'if "!count!"=="1" ( >"%~7.json" echo {"transcription":[]} ) else ( >"%~7.json" echo {"transcription":[{"text":"Next .","offsets":{"from":0,"to":6656},"tokens":[{"text":"Next","p":0.95,"offsets":{"from":0,"to":6000}},{"text":".","p":0.95,"offsets":{"from":6000,"to":6656}}]}]} )'
  ].join('\r\n') + '\r\n';
  await writeFile(binary, whisperScript);
  const sessionId = 'empty-then-next-session';
  const chunk = (sequence) => envelope('audio.chunk', `${sessionId}:chunk:${sequence}`, {
    chunk_id: `${sessionId}-chunk-${sequence}`, session_id: sessionId, sequence,
    start_time: `00:00:0${sequence}.000`, end_time: `00:00:0${sequence}.256`,
    format: { encoding: 'pcm-signed-integer', sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, byte_order: 'little-endian' },
    sample_count: 2, byte_length: 4, audio_base64: 'AAABAA==', checksum: 'sha256:6b1e73a0094b7b812d3b9e22cffb4f8239319847522c4fa103753b6950020f93'
  });
  const flush = (key) => envelope('audio.flush', `${sessionId}:${key}`, { session_id: sessionId, requested_at: '2026-08-30T00:00:00.000Z', reason: 'pause' });
  try {
    const result = await runServiceBatches(whisperManifest, [
      { inputs: [chunk(0), flush('empty')] , expectedOutputCount: 3 },
      { inputs: [chunk(1), flush('next')], expectedOutputCount: 4 }
    ], 10000, { env: { ARGUS_SESSION_ROOT: sessionRoot, ARGUS_WHISPER_BINARY: binary, ARGUS_WHISPER_MODEL: model, ARGUS_PROBE_COUNTER: counter, ARGUS_DIAGNOSTICS: '1' } });
    assert.equal(result.outputs.filter((message) => message.message_type === 'transcript.empty').length, 1);
    assert.deepEqual(result.outputs.filter((message) => message.message_type === 'transcript.word-committed').map((message) => message.payload.text), ['Next.']);
    assert.ok(result.diagnostics.filter((line) => line.trimStart().startsWith('{')).some((line) => JSON.parse(line).event === 'whisper.empty'));
    const diagnostics = result.diagnostics.filter((line) => line.trimStart().startsWith('{')).map((line) => JSON.parse(line));
    const flushDiagnostic = diagnostics.find((record) => record.event === 'audio.flush-received');
    const emission = diagnostics.find((record) => record.event === 'transcript.final-emission-summary');
    assert.equal(flushDiagnostic.utterance_id, emission.utterance_id);
    assert.equal(flushDiagnostic.audio_window_id, emission.audio_window_id);
    assert.equal(result.diagnostics.join('\n').includes('audio_base64'), false);
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
    await rm(probeRoot, { recursive: true, force: true });
  }
});

test('held Whisper job emits delayed and timeout diagnostics and cleans temporary artifacts', async () => {
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-timeout-diagnostics-'));
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-timeout-probe-'));
  const binary = path.join(probeRoot, 'whisper-hangs.cmd');
  const model = path.join(probeRoot, 'model.bin');
  await mkdir(path.join(sessionRoot, '.argus-stt'), { recursive: true });
  await writeFile(model, 'model');
  await writeFile(binary, '@echo off\r\n:again\r\ngoto again\r\n');
  const sessionId = 'timeout-diagnostics-session';
  try {
    const result = await runServiceBatches(whisperManifest, [
      { inputs: [whisperChunk(sessionId, 0)], expectedOutputCount: 1 },
      { inputs: [envelope('audio.flush', `${sessionId}:flush`, { session_id: sessionId, requested_at: '2026-08-30T00:00:00.000Z', reason: 'pause' })], expectedOutputCount: 1 }
    ], 5000, { env: { ARGUS_SESSION_ROOT: sessionRoot, ARGUS_WHISPER_BINARY: binary, ARGUS_WHISPER_MODEL: model, ARGUS_WHISPER_TIMEOUT_MS: '100', ARGUS_WHISPER_DELAYED_MS: '10', ARGUS_DIAGNOSTICS: '1' } });
    const failure = result.outputs.find((message) => message.message_type === 'service.failure');
    assert.equal(failure.payload.error.code, 'STT_TIMEOUT');
    const diagnosticEvents = result.diagnostics.filter((line) => line.trimStart().startsWith('{')).map((line) => JSON.parse(line).event);
    assert.ok(diagnosticEvents.includes('whisper.delayed'));
    assert.ok(diagnosticEvents.includes('whisper.timeout'));
    assert.ok(diagnosticEvents.includes('whisper.failed'));
    assert.deepEqual((await readdir(path.join(sessionRoot, '.argus-stt'))).filter((name) => /\.(?:wav|json)$/.test(name)), []);
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
    await rm(probeRoot, { recursive: true, force: true });
  }
});

test('desktop empty-result projection keeps capture active and exposes the user notice', () => {
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-empty-ui-${Date.now()}`) });
  application.sessionId = 'empty-ui-session';
  application.metadata = { session_id: application.sessionId, state: 'recording', created_at: '2026-08-30T00:00:00.000Z' };
  application.captureActive = true;
  application.boundary = { projection: (messageType, payload) => ({ message_type: messageType, payload }) };
  application.handleGraphMessage({ message_id: 'empty-message', message_type: 'transcript.empty', correlation_id: application.sessionId, payload: { audio_window_id: 'empty-ui-session-audio-window-0', session_id: application.sessionId, utterance_id: 'empty-ui-session-utterance-0', reason: 'pause', segment_count: 0, word_count: 0 } });
  assert.equal(application.sessionProjection().audio_processing.capture_state, 'listening');
  assert.equal(application.sessionProjection().audio_processing.detail, 'No speech recognized; still listening');
});

function whisperChunk(sessionId, sequence) {
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
    timestamp: '2026-08-30T00:00:00.000Z', producer: 'diagnostic-test', correlation_id: payload.session_id, schema_version: '1.2.0', payload
  };
}
