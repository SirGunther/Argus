import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { runServiceBatches } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = path.join(root, 'services', 'whisper-cpp-stt', 'service.json');
const fixtureRoot = path.join(root, 'tests', 'fixtures', 'whisper-token-reconstruction');
const probe = path.join(fixtureRoot, 'whisper-probe.cmd');
const registry = await loadContractRegistry(path.join(root, 'contracts', 'catalog.json'));

for (const fixture of [
  { name: 'transcribing', texts: ['transcribing'], flushOutputs: 3, confidences: [0.88], start: '00:00:10.100', end: '00:00:10.900' },
  { name: 'im', texts: ["I'm", 'and', "it's"], flushOutputs: 5, confidences: [0.87, 0.95, 0.79] },
  { name: 'punctuation', texts: ['hello,', 'world!'], flushOutputs: 4, confidences: [0.91, 0.83] },
  { name: 'blank-audio', texts: [], flushOutputs: 2, empty: true }
]) {
  test(`Whisper fixture reconstructs ${fixture.name} without language-model spacing`, async () => {
    const sessionRoot = await mkdtemp(path.join(os.tmpdir(), `argus-whisper-${fixture.name}-`));
    const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-whisper-fixture-probe-'));
    const model = path.join(probeRoot, 'model.bin');
    await writeFile(model, 'model');
    const sessionId = `whisper-${fixture.name}-session`;
    try {
      const result = await runServiceBatches(manifest, [
        { inputs: [whisperChunk(sessionId)], expectedOutputCount: 1 },
        { inputs: [flush(sessionId)], expectedOutputCount: fixture.flushOutputs }
      ], 10000, { env: {
        ARGUS_SESSION_ROOT: sessionRoot,
        ARGUS_WHISPER_BINARY: probe,
        ARGUS_WHISPER_MODEL: model,
        ARGUS_WHISPER_FIXTURE: fixture.name,
        ARGUS_WHISPER_FIXTURE_ROOT: fixtureRoot,
        ARGUS_DIAGNOSTICS: '0'
      } });
      assert.equal(result.diagnostics.filter((line) => line.trimStart().startsWith('{')).length, 0, 'normal service operation must not write JSON diagnostics');
      const domain = result.outputs.filter((message) => message.plane === 'domain');
      domain.forEach((message) => assert.deepEqual(registry.validateEnvelope(message), [], message.message_type));
      const words = domain.filter((message) => message.message_type === 'transcript.word-committed');
      assert.deepEqual(words.map((message) => message.payload.text), fixture.texts);
      if (fixture.empty) {
        const empty = domain.find((message) => message.message_type === 'transcript.empty');
        assert.deepEqual(empty.payload, {
          audio_window_id: `${sessionId}-audio-window-0`, session_id: sessionId,
          utterance_id: `${sessionId}-utterance-0`, reason: 'pause', segment_count: 1, word_count: 0
        });
        assert.equal(JSON.stringify(result.outputs).includes('[BLANK_AUDIO]'), false);
      } else {
        assert.deepEqual(words.map((message) => message.payload.confidence), fixture.confidences);
        assert.equal(words[0].payload.evidence.provider, 'whisper-cpp-stt');
        assert.deepEqual(words[0].payload.evidence.chunk_ids, [`${sessionId}-chunk-0`]);
        if (fixture.start) {
          assert.equal(words[0].payload.start_time, fixture.start);
          assert.equal(words[0].payload.end_time, fixture.end);
        }
      }
    } finally {
      await rm(sessionRoot, { recursive: true, force: true });
      await rm(probeRoot, { recursive: true, force: true });
    }
  });
}

test('Whisper attaches only the minimal timestamp-overlapping chunk span to each word', async () => {
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-whisper-overlap-'));
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-whisper-overlap-probe-'));
  const binary = path.join(probeRoot, 'overlap-probe.cmd');
  const model = path.join(probeRoot, 'model.bin');
  const sessionId = 'whisper-overlap-session';
  await writeFile(model, 'model');
  await writeFile(binary, '@echo off\r\n> "%~7.json" echo {"transcription":[{"text":" First Second Third.","offsets":{"from":0,"to":700},"tokens":[{"text":" First","p":0.95,"offsets":{"from":0,"to":100}},{"text":" Second","p":0.95,"offsets":{"from":200,"to":456}},{"text":" Third","p":0.95,"offsets":{"from":512,"to":700}},{"text":".","p":0.95,"offsets":{"from":700,"to":700}}]}]}\r\n');
  const chunks = [
    timedChunk(sessionId, 0, '00:00:00.000', '00:00:00.256'),
    timedChunk(sessionId, 1, '00:00:00.256', '00:00:00.512'),
    timedChunk(sessionId, 2, '00:00:00.512', '00:00:00.768')
  ];
  try {
    const result = await runServiceBatches(manifest, [
      { inputs: chunks, expectedOutputCount: 3 },
      { inputs: [flush(sessionId)], expectedOutputCount: 5 }
    ], 10000, { env: { ARGUS_SESSION_ROOT: sessionRoot, ARGUS_WHISPER_BINARY: binary, ARGUS_WHISPER_MODEL: model } });
    const domain = result.outputs.filter((message) => message.plane === 'domain');
    domain.forEach((message) => assert.deepEqual(registry.validateEnvelope(message), [], message.message_type));
    const words = domain.filter((message) => message.message_type === 'transcript.word-committed');
    assert.deepEqual(words.map((message) => message.payload.evidence.chunk_ids), [
      [`${sessionId}-chunk-0`],
      [`${sessionId}-chunk-0`, `${sessionId}-chunk-1`],
      [`${sessionId}-chunk-2`]
    ]);
    const boundary = domain.find((message) => message.message_type === 'transcript.utterance-boundary');
    assert.deepEqual(boundary.payload.source_chunk_ids, chunks.map((chunk) => chunk.payload.chunk_id));
    assert.deepEqual(boundary.payload.audio_window_span, {
      audio_window_id: `${sessionId}-audio-window-0`, first_chunk_id: `${sessionId}-chunk-0`, last_chunk_id: `${sessionId}-chunk-2`,
      first_sequence: 0, last_sequence: 2, chunk_count: 3, start_time: '00:00:00.000', end_time: '00:00:00.768'
    });
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
    await rm(probeRoot, { recursive: true, force: true });
  }
});

function whisperChunk(sessionId) {
  return envelope('audio.chunk', `${sessionId}:chunk:0`, {
    chunk_id: `${sessionId}-chunk-0`, session_id: sessionId, sequence: 0,
    start_time: '00:00:10.000', end_time: '00:00:10.256',
    format: { encoding: 'pcm-signed-integer', sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, byte_order: 'little-endian' },
    sample_count: 2, byte_length: 4, audio_base64: 'AAABAA==', checksum: 'sha256:6b1e73a0094b7b812d3b9e22cffb4f8239319847522c4fa103753b6950020f93'
  });
}

function timedChunk(sessionId, sequence, start_time, end_time) {
  return envelope('audio.chunk', `${sessionId}:chunk:${sequence}`, {
    chunk_id: `${sessionId}-chunk-${sequence}`, session_id: sessionId, sequence, start_time, end_time,
    format: { encoding: 'pcm-signed-integer', sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, byte_order: 'little-endian' },
    sample_count: 2, byte_length: 4, audio_base64: 'AAABAA==', checksum: 'sha256:6b1e73a0094b7b812d3b9e22cffb4f8239319847522c4fa103753b6950020f93'
  });
}

function flush(sessionId) {
  return envelope('audio.flush', `${sessionId}:flush`, { session_id: sessionId, requested_at: '2026-08-30T00:00:00.000Z', reason: 'pause' });
}

function envelope(messageType, idempotencyKey, payload) {
  return {
    message_id: idempotencyKey, idempotency_key: idempotencyKey, plane: 'domain', message_type: messageType,
    timestamp: '2026-08-30T00:00:00.000Z', producer: 'token-reconstruction-test', correlation_id: payload.session_id, schema_version: '1.2.0', payload
  };
}
