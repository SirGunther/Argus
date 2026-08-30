import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { resolveSessionRoot } from '../../runtime/session-storage.mjs';

const SERVICE = 'whisper-cpp-stt';
const MAX_WINDOW_CHUNKS = 120;
const stateBySession = new Map();

runLineService({ service: SERVICE, operations: {
  'audio.chunk': { name: 'buffer-whisper-audio', async handle(message) {
    const chunk = message.payload;
    validateChunk(chunk);
    const state = stateFor(chunk.session_id);
    if (state.chunkIds.has(chunk.chunk_id)) return [];
    if (state.chunks.length >= MAX_WINDOW_CHUNKS) throw boundedAudioWindow();
    state.chunkIds.add(chunk.chunk_id);
    state.chunks.push({ ...chunk, bytes: Buffer.from(chunk.audio_base64, 'base64') });
    return [];
  } },
  'audio.flush': { name: 'finalize-whisper-window', async handle(message) {
    const sessionId = message.payload?.session_id;
    if (!sessionId) throw invalid('audio.flush requires session_id');
    const state = stateBySession.get(sessionId);
    if (!state?.chunks.length) return [];
    const result = await transcribe(state);
    const outputs = result.text ? finalOutputs(state, result, message.payload?.reason || 'flush') : [];
    state.chunks = [];
    state.chunkIds.clear();
    return outputs;
  } }
}, async onReady() {
  if (process.env.ARGUS_SESSION_ROOT) await cleanupAbandonedArtifacts();
}, onDrain() {
  return [];
} });

function stateFor(sessionId) {
  const state = stateBySession.get(sessionId) || { chunks: [], chunkIds: new Set(), nextWordSequence: 0, nextUtteranceSequence: 0 };
  stateBySession.set(sessionId, state);
  return state;
}

async function transcribe(state) {
  const binary = String(process.env.ARGUS_WHISPER_BINARY || '').trim();
  const model = String(process.env.ARGUS_WHISPER_MODEL || '').trim();
  if (!binary || !model) throw unavailable('ARGUS_WHISPER_BINARY and ARGUS_WHISPER_MODEL are required; run npm run setup:real');
  await assertAssetReadable('runtime', binary);
  await assertAssetReadable('model', model);

  const root = resolveSessionRoot();
  const tempRoot = path.join(root, '.argus-stt');
  await mkdir(tempRoot, { recursive: true });
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const wav = path.join(tempRoot, `${id}.wav`);
  const outputBase = path.join(tempRoot, `${id}`);
  const outputJson = `${outputBase}.json`;
  const ownerFile = `${outputBase}.owner.json`;
  try {
    await writeFile(ownerFile, JSON.stringify({ pid: process.pid, output_base: outputBase }), { flag: 'wx' });
    const bytes = Buffer.concat(state.chunks.map((chunk) => chunk.bytes));
    await writeFile(wav, createWav(bytes, 16000, 1, 16));
    const stderr = await runWhisper(binary, model, wav, outputBase);
    let raw;
    try { raw = JSON.parse(await readFile(outputJson, 'utf8')); }
    catch (error) { throw malformed(`Whisper returned malformed JSON: ${error.message}`, stderr); }
    const segments = parseTranscription(raw);
    if (segments.some((segment) => segment.tokens.some((token) => !Number.isFinite(token.probability)))) {
      throw malformed('Whisper JSON did not provide token probabilities; refusing to invent confidence values. Use a compatible whisper.cpp build.', stderr);
    }
    return { text: segments.map((segment) => segment.text).join(' ').replace(/\s+/g, ' ').trim(), segments };
  } finally {
    await Promise.allSettled([rm(wav, { force: true }), rm(outputJson, { force: true }), rm(ownerFile, { force: true })]);
  }
}

function finalOutputs(state, result, reason = 'flush') {
  const first = state.chunks[0];
  const last = state.chunks.at(-1);
  const utteranceId = `${first.session_id}-utterance-${state.nextUtteranceSequence++}`;
  const words = [];
  for (const segment of result.segments) {
    for (const token of segment.tokens) {
      const text = sanitizeWhisperText(token.text);
      if (!text || isControlToken(text)) continue;
      const sequence = state.nextWordSequence++;
      words.push({ messageType: 'transcript.word-committed', identityKey: `${SERVICE}:word:${first.session_id}:${sequence}`, payload: {
        word_id: `${first.session_id}-word-${sequence}`, session_id: first.session_id, utterance_id: utteranceId, sequence,
        start_time: offsetTime(first.start_time, token.fromMs ?? segment.fromMs), end_time: offsetTime(first.start_time, token.toMs ?? segment.toMs), text,
        confidence: token.probability, evidence: { provider: SERVICE, chunk_ids: state.chunks.map((chunk) => chunk.chunk_id), alternatives: [] }
      } });
    }
  }
  if (!words.length) return [];
  return [
    ...words,
    { messageType: 'transcript.utterance-boundary', identityKey: `${SERVICE}:boundary:${utteranceId}:${state.nextWordSequence}`, payload: {
      boundary_id: `${utteranceId}-boundary-${state.nextWordSequence}`, session_id: first.session_id, utterance_id: utteranceId, reason,
      first_word_sequence: words[0].payload.sequence, last_word_sequence: words.at(-1).payload.sequence,
      start_time: first.start_time, end_time: last.end_time, punctuation_hint: punctuationHint(result.text), source_chunk_ids: state.chunks.map((chunk) => chunk.chunk_id)
    } }
  ];
}

function parseTranscription(raw) {
  const source = Array.isArray(raw?.transcription) ? raw.transcription : Array.isArray(raw?.segments) ? raw.segments : [];
  if (!source.length) return [];
  return source.map((segment) => {
    const text = sanitizeWhisperText(segment.text);
    const tokens = (Array.isArray(segment.tokens) ? segment.tokens : []).map((token) => ({
      text: String(token.text || ''), probability: Number(token.p ?? token.probability),
      fromMs: readTimestamp(token.offsets?.from ?? token.timestamps?.from),
      toMs: readTimestamp(token.offsets?.to ?? token.timestamps?.to)
    }));
    const fromMs = readTimestamp(segment.offsets?.from ?? segment.timestamps?.from ?? segment.t0);
    const toMs = readTimestamp(segment.offsets?.to ?? segment.timestamps?.to ?? segment.t1);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw malformed('Whisper JSON did not provide usable segment timestamps. Use --output-json-full from the pinned whisper.cpp build.');
    return { text, tokens, fromMs, toMs };
  }).filter((segment) => segment.text);
}

function readTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  const match = /^(\d+):(\d{2}):(\d{2})[,\.](\d{3})$/.exec(value.trim());
  if (!match) return undefined;
  return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4]);
}

function runWhisper(binary, model, wav, outputBase) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--model', model, '--file', wav, '--output-json-full', '--output-file', outputBase, '--no-prints', '--no-gpu', '--language', 'en'], { windowsHide: true, shell: /\.(?:cmd|bat)$/i.test(binary), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => reject(unavailable(`Unable to start whisper.cpp: ${error.message}`)));
    child.once('exit', (code) => code === 0 ? resolve(stderr) : reject(unavailable(`whisper.cpp exited with code ${code}: ${stderr.trim() || 'no diagnostic'}`)));
  });
}

function createWav(pcm, sampleRate, channels, bits) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * bits / 8, 28); header.writeUInt16LE(channels * bits / 8, 32); header.writeUInt16LE(bits, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function validateChunk(chunk) {
  if (!chunk?.session_id || !Number.isInteger(chunk.sequence) || chunk.sequence < 0) throw invalid('audio.chunk identity is invalid');
  if (chunk.format?.sample_rate_hz !== 16000 || chunk.format?.channels !== 1 || chunk.format?.bits_per_sample !== 16 || chunk.format?.byte_order !== 'little-endian') throw invalid('PCM16/16kHz/mono/little-endian is required');
  const bytes = Buffer.from(chunk.audio_base64 || '', 'base64');
  if (bytes.toString('base64') !== chunk.audio_base64 || bytes.byteLength !== chunk.byte_length || bytes.byteLength !== chunk.sample_count * 2) throw invalid('audio bytes and metadata do not match');
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== chunk.checksum) throw invalid('audio checksum does not match bytes');
}

function offsetTime(base, offsetMs) { return formatClock(parseClock(base) + Math.max(0, offsetMs)); }
function parseClock(value) { const match = /^(\d+):(\d+):(\d+)\.(\d{3})$/.exec(value); return match ? (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4]) : 0; }
function formatClock(value) { const ms = Math.max(0, Math.round(value)); const hours = Math.floor(ms / 3600000); const minutes = Math.floor((ms % 3600000) / 60000); const seconds = Math.floor((ms % 60000) / 1000); return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; }
function punctuationHint(text) { return text.trim().endsWith('?') ? 'question' : text.trim().endsWith('!') ? 'exclamation' : 'statement'; }
function invalid(message) { return new ServiceOperationError(message, { code: 'INVALID_AUDIO_CHUNK', category: 'validation' }); }
function unavailable(message) { return new ServiceOperationError(message, { code: 'STT_UNAVAILABLE', category: 'dependency', retryable: true }); }
function malformed(message, stderr) { return new ServiceOperationError(`${message}${stderr ? ` Diagnostic: ${stderr.trim()}` : ''}`, { code: 'STT_MALFORMED_OUTPUT', category: 'validation', retryable: true }); }
function boundedAudioWindow() { return new ServiceOperationError(`Whisper audio buffer reached its governed ${MAX_WINDOW_CHUNKS}-chunk limit; stop or pause recording to finalize it before continuing.`, { code: 'AUDIO_WINDOW_LIMIT', category: 'resource' }); }

const CONTROL_TOKEN_PATTERN = /<\|[^|]*\|>|\[\*[^\]]+\*\]|\[_[^\]]+\]/g;
const CONTROL_TOKEN_EXACT = /^(?:<\|[^|]*\|>|\[\*[^\]]+\*\]|\[_[^\]]+\])$/;
function sanitizeWhisperText(text) { return String(text || '').replace(CONTROL_TOKEN_PATTERN, '').replace(/\s+/g, ' ').trim(); }
function isControlToken(text) { return CONTROL_TOKEN_EXACT.test(String(text || '').trim()); }

async function cleanupAbandonedArtifacts() {
  const root = resolveSessionRoot();
  const tempRoot = path.join(root, '.argus-stt');
  try {
    const info = await lstat(tempRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) return;
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const entries = await readdir(tempRoot, { withFileTypes: true });
  const owned = new Set();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.owner.json')) continue;
    const ownerPath = path.join(tempRoot, entry.name);
    let owner;
    try { owner = JSON.parse(await readFile(ownerPath, 'utf8')); } catch { owner = undefined; }
    if (owner?.pid && processAlive(owner.pid)) owned.add(String(owner.output_base || '').trim());
    else await rm(ownerPath, { force: true });
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9]+-[0-9]+-[0-9a-f]+\.(?:wav|json)$/.test(entry.name)) continue;
    const filePath = path.join(tempRoot, entry.name);
    const outputBase = filePath.replace(/\.(?:wav|json)$/, '');
    if (!owned.has(outputBase)) await rm(filePath, { force: true });
  }
}

function processAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function assertAssetReadable(label, assetPath) {
  try {
    await access(assetPath);
  } catch (error) {
    const reason = error?.code === 'ERR_ACCESS_DENIED'
      ? 'read permission was denied'
      : error?.code === 'ENOENT'
        ? 'the file was not found'
        : 'the file could not be read';
    throw unavailable(`Whisper runtime or model is unavailable: provisioned ${label} ${reason} (${assetPath}).`);
  }
}
