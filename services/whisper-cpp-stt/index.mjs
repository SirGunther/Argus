import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { resolveSessionRoot } from '../../runtime/session-storage.mjs';
import { createDiagnosticLogger } from '../../runtime/diagnostics.mjs';

const SERVICE = 'whisper-cpp-stt';
const MAX_WINDOW_CHUNKS = 120;
const stateBySession = new Map();
const diagnostics = createDiagnosticLogger({ enabled: process.env.ARGUS_DIAGNOSTICS === '1', source: SERVICE });

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
    try {
      const result = await transcribe(state);
      return finalOutputs(state, result, message.payload?.reason || 'flush');
    } finally {
      // A failed or empty window must not poison the next queued utterance.
      state.chunks = [];
      state.chunkIds.clear();
    }
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

function audioWindowDetails(state) {
  const first = state.chunks[0];
  const last = state.chunks.at(-1);
  return {
    session_id: first.session_id,
    audio_window_id: `${first.session_id}-audio-window-${first.sequence}`,
    first_sequence: first.sequence,
    last_sequence: last.sequence,
    chunk_count: state.chunks.length,
    duration_ms: Math.max(0, parseClock(last.end_time) - parseClock(first.start_time))
  };
}

function audioWindowId(state) {
  return audioWindowDetails(state).audio_window_id;
}

async function transcribe(state) {
  const window = audioWindowDetails(state);
  const binary = String(process.env.ARGUS_WHISPER_BINARY || '').trim();
  const model = String(process.env.ARGUS_WHISPER_MODEL || '').trim();
  if (!binary || !model) {
    const error = unavailable('ARGUS_WHISPER_BINARY and ARGUS_WHISPER_MODEL are required; run npm run setup:real');
    diagnostics.log('whisper.failed', { ...window, error_code: error.code, error: error.message });
    throw error;
  }
  try {
    await assertAssetReadable('runtime', binary);
    await assertAssetReadable('model', model);
  } catch (error) {
    diagnostics.log('whisper.failed', { ...window, error_code: error.code, error: error.message });
    throw error;
  }

  const root = resolveSessionRoot();
  const tempRoot = path.join(root, '.argus-stt');
  await mkdir(tempRoot, { recursive: true });
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const wav = path.join(tempRoot, `${id}.wav`);
  const outputBase = path.join(tempRoot, `${id}`);
  const outputJson = `${outputBase}.json`;
  const ownerFile = `${outputBase}.owner.json`;
  let processResult;
  try {
    await writeFile(ownerFile, JSON.stringify({ pid: process.pid, output_base: outputBase }), { flag: 'wx' });
    const bytes = Buffer.concat(state.chunks.map((chunk) => chunk.bytes));
    await writeFile(wav, createWav(bytes, 16000, 1, 16));
    processResult = await runWhisper(binary, model, wav, outputBase, { ...window, byte_count: bytes.byteLength });
    let raw;
    try { raw = JSON.parse(await readFile(outputJson, 'utf8')); }
    catch (error) { throw malformed(`Whisper returned malformed JSON: ${error.message}`, processResult.stderr); }
    const segments = parseTranscription(raw);
    if (segments.some((segment) => segment.tokens.some((token) => !Number.isFinite(token.probability)))) {
      throw malformed('Whisper JSON did not provide token probabilities; refusing to invent confidence values. Use a compatible whisper.cpp build.', processResult.stderr);
    }
    const text = reconstructTranscriptText(segments);
    const wordCount = countWords(segments);
    diagnostics.log('whisper.completed', { session_id: window.session_id, audio_window_id: window.audio_window_id, duration_ms: window.duration_ms, byte_count: window.byte_count, process_pid: processResult.pid, elapsed_ms: processResult.elapsed_ms, segment_count: segments.length, committed_word_count: wordCount, transcript_preview: text });
    if (!segments.length || !wordCount || !text) {
      diagnostics.log('whisper.empty', { session_id: window.session_id, audio_window_id: window.audio_window_id, duration_ms: window.duration_ms, byte_count: window.byte_count, process_pid: processResult.pid, elapsed_ms: processResult.elapsed_ms, segment_count: segments.length, committed_word_count: wordCount, reason: 'no-speech' });
    }
    return { text, segments, process: processResult };
  } catch (error) {
    diagnostics.log('whisper.failed', { session_id: window.session_id, audio_window_id: window.audio_window_id, duration_ms: window.duration_ms, byte_count: window.byte_count, process_pid: processResult?.pid, elapsed_ms: processResult?.elapsed_ms, error_code: error.code, error: error.message });
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([rm(wav, { force: true }), rm(outputJson, { force: true }), rm(ownerFile, { force: true })]);
    const failures = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason?.message || String(result.reason));
    if (failures.length) diagnostics.log('whisper.cleanup-failed', { session_id: window.session_id, audio_window_id: window.audio_window_id, error_count: failures.length, error: failures.join('; ') });
  }
}

function finalOutputs(state, result, reason = 'flush') {
  const first = state.chunks[0];
  const last = state.chunks.at(-1);
  const utteranceId = `${first.session_id}-utterance-${state.nextUtteranceSequence++}`;
  const words = [];
  for (const word of lexicalWordsForSegments(result.segments)) {
    const firstToken = word.tokens[0];
    const lastToken = word.tokens.at(-1);
    const sequence = state.nextWordSequence++;
    words.push({ messageType: 'transcript.word-committed', identityKey: `${SERVICE}:word:${first.session_id}:${sequence}`, payload: {
      word_id: `${first.session_id}-word-${sequence}`, session_id: first.session_id, utterance_id: utteranceId, sequence,
      start_time: offsetTime(first.start_time, firstToken.fromMs ?? word.segment.fromMs),
      end_time: offsetTime(first.start_time, lastToken.toMs ?? word.segment.toMs),
      text: word.text, confidence: word.confidence,
      evidence: { provider: SERVICE, chunk_ids: state.chunks.map((chunk) => chunk.chunk_id), alternatives: [] }
    } });
  }
  if (!words.length) {
    return [{ messageType: 'transcript.empty', schemaVersion: '1.0.0', identityKey: `transcript.empty:${utteranceId}`, payload: {
      audio_window_id: audioWindowId(state), session_id: first.session_id, utterance_id: utteranceId, reason: reason === 'pause' ? 'pause' : 'flush', segment_count: result.segments.length, word_count: 0
    } }];
  }
  diagnostics.log('transcript.boundary-emitted', { session_id: first.session_id, audio_window_id: audioWindowId(state), utterance_id: utteranceId, first_word_sequence: words[0].payload.sequence, last_word_sequence: words.at(-1).payload.sequence, reason });
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
    const rawText = String(segment?.text ?? '');
    const sanitizedText = sanitizeWhisperText(rawText);
    const nonSpeech = isNonSpeechMarker(sanitizedText);
    const tokens = (Array.isArray(segment?.tokens) ? segment.tokens : []).map((token, index) => ({
      index, rawText: String(token?.text ?? ''), text: sanitizeWhisperText(token?.text), probability: Number(token?.p ?? token?.probability),
      fromMs: readTimestamp(token?.offsets?.from ?? token?.timestamps?.from),
      toMs: readTimestamp(token?.offsets?.to ?? token?.timestamps?.to)
    }));
    const fromMs = readTimestamp(segment?.offsets?.from ?? segment?.timestamps?.from ?? segment?.t0);
    const toMs = readTimestamp(segment?.offsets?.to ?? segment?.timestamps?.to ?? segment?.t1);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw malformed('Whisper JSON did not provide usable segment timestamps. Use --output-json-full from the pinned whisper.cpp build.');
    return { rawText, text: nonSpeech ? '' : sanitizedText, nonSpeech, tokens, fromMs, toMs };
  }).filter((segment) => segment.text || segment.nonSpeech || segment.tokens.length);
}

function readTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  const match = /^(\d+):(\d{2}):(\d{2})[,\.](\d{3})$/.exec(value.trim());
  if (!match) return undefined;
  return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4]);
}

function runWhisper(binary, model, wav, outputBase, window) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const delayedMs = positiveEnvironmentNumber('ARGUS_WHISPER_DELAYED_MS', 10000);
    const timeoutMs = positiveEnvironmentNumber('ARGUS_WHISPER_TIMEOUT_MS', 120000);
    const child = spawn(binary, ['--model', model, '--file', wav, '--output-json-full', '--output-file', outputBase, '--no-prints', '--no-gpu', '--language', 'en'], { windowsHide: true, shell: /\.(?:cmd|bat)$/i.test(binary), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    let exited = false;
    let timedOut = false;
    let delayedTimer;
    let timeoutTimer;
    let killTimer;
    const timeoutError = () => unavailable(`whisper.cpp exceeded its ${timeoutMs} ms hard timeout`, { code: 'STT_TIMEOUT', category: 'timeout', retryable: true });
    const clearTimers = () => { clearTimeout(delayedTimer); clearTimeout(timeoutTimer); clearTimeout(killTimer); };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (error) reject(error);
      else resolve(result);
    };
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString().slice(0, 4096 - stderr.length);
    });
    if (child.pid) diagnostics.log('whisper.started', { ...window, byte_count: window.byte_count, process_pid: child.pid });
    child.once('error', (error) => finish(unavailable(`Unable to start whisper.cpp: ${error.message}`)));
    child.once('exit', (code, signal) => {
      exited = true;
      if (timedOut) return finish(timeoutError());
      if (code === 0) return finish(undefined, { stderr, pid: child.pid, elapsed_ms: Math.round(performance.now() - startedAt) });
      finish(unavailable(`whisper.cpp exited with code ${code ?? 'none'}${signal ? ` (${signal})` : ''}: ${stderr.trim() || 'no diagnostic'}`, { code: 'STT_PROCESS_EXIT', category: 'dependency', retryable: true }));
    });
    delayedTimer = setTimeout(() => {
      if (!settled && !exited) diagnostics.log('whisper.delayed', { ...window, byte_count: window.byte_count, process_pid: child.pid, elapsed_ms: Math.round(performance.now() - startedAt), threshold_ms: delayedMs });
    }, delayedMs);
    timeoutTimer = setTimeout(() => {
      if (settled || exited) return;
      timedOut = true;
      diagnostics.log('whisper.timeout', { ...window, byte_count: window.byte_count, process_pid: child.pid, elapsed_ms: Math.round(performance.now() - startedAt), timeout_ms: timeoutMs });
      terminateProcessTree(child);
      killTimer = setTimeout(() => { if (!exited) terminateProcessTree(child); finish(timeoutError()); }, 1000);
    }, timeoutMs);
  });
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  try { child.kill(process.platform === 'win32' ? undefined : 'SIGTERM'); } catch { /* the exit handler still reports the bounded timeout */ }
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
function unavailable(message, options = {}) { return new ServiceOperationError(message, { code: 'STT_UNAVAILABLE', category: 'dependency', retryable: true, ...options }); }
function malformed(message, stderr) { return new ServiceOperationError(`${message}${stderr ? ` Diagnostic: ${stderr.trim()}` : ''}`, { code: 'STT_MALFORMED_OUTPUT', category: 'validation', retryable: true }); }
function boundedAudioWindow() { return new ServiceOperationError(`Whisper audio buffer reached its governed ${MAX_WINDOW_CHUNKS}-chunk limit; stop or pause recording to finalize it before continuing.`, { code: 'AUDIO_WINDOW_LIMIT', category: 'resource' }); }

function countWords(segments) { return lexicalWordsForSegments(segments).length; }

function reconstructTranscriptText(segments) {
  return lexicalWordsForSegments(segments).map((word) => word.text).join(' ');
}

/**
 * Whisper's BPE token text uses leading whitespace to mark a new lexical word.
 * A token without that whitespace is a continuation, while contractions and
 * trailing punctuation attach explicitly even when the provider includes a
 * leading space. No language model or heuristic spacing guess is involved.
 */
function lexicalWordsForSegments(segments) {
  return segments.flatMap((segment) => mergeWhisperTokens(segment));
}

function mergeWhisperTokens(segment) {
  // Whisper may expose a known non-speech marker as several BPE tokens. The
  // segment-level text is authoritative for filtering the complete marker.
  if (segment.nonSpeech) return [];
  const words = [];
  let current;
  for (const token of segment.tokens) {
    const text = token.text;
    if (!text || isControlToken(text) || isNonSpeechMarker(text)) continue;

    const startsWithWhitespace = /^\s/u.test(token.rawText);
    const attachesToPrevious = current && (
      !startsWithWhitespace || isContractionToken(text) || isTrailingPunctuation(text)
    );
    if (!attachesToPrevious) {
      current = {
        segment,
        tokens: [token],
        text,
        confidence: token.probability
      };
      words.push(current);
      continue;
    }

    current.tokens.push(token);
    current.text += text;
    current.confidence = conservativeTokenConfidence(current.tokens);
  }
  return words;
}

/** The weakest token bounds a merged word; this prevents confidence inflation. */
function conservativeTokenConfidence(tokens) {
  return Math.min(...tokens.map((token) => token.probability));
}

function positiveEnvironmentNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const CONTROL_TOKEN_PATTERN = /<\|[^|]*\|>|\[\*[^\]]+\*\]|\[_[^\]]+\]/g;
const CONTROL_TOKEN_EXACT = /^(?:<\|[^|]*\|>|\[\*[^\]]+\*\]|\[_[^\]]+\])$/;
const NON_SPEECH_MARKERS = new Set(['[BLANK_AUDIO]', '[MUSIC]', '[NOISE]', '[SILENCE]']);
const CONTRACTION_TOKEN_PATTERN = /^(?:['’](?:d|ll|m|re|s|t|ve)|n['’]t)$/iu;
const TRAILING_PUNCTUATION_PATTERN = /^[,.;:!?%…]+[\)\]\}»”"']*$/u;
function sanitizeWhisperText(text) { return String(text ?? '').replace(CONTROL_TOKEN_PATTERN, '').replace(/\s+/g, ' ').trim(); }
function isControlToken(text) { return CONTROL_TOKEN_EXACT.test(String(text || '').trim()); }
function isNonSpeechMarker(text) { return NON_SPEECH_MARKERS.has(String(text || '').trim().toUpperCase()); }
function isContractionToken(text) { return CONTRACTION_TOKEN_PATTERN.test(String(text || '').trim()); }
function isTrailingPunctuation(text) { return TRAILING_PUNCTUATION_PATTERN.test(String(text || '').trim()); }

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
