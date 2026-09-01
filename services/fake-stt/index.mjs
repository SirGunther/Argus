import { createHash } from 'node:crypto';
import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { fingerprintValue } from '../../runtime/message-identity.mjs';
import { OrderedStreamError, OrderedStreamGuard } from '../../runtime/ordered-stream.mjs';

const SERVICE = 'fake-stt';
const ordering = new OrderedStreamGuard();
const stateBySession = new Map();
const acceptedChunks = new Map();

runLineService({ service: SERVICE, operations: {
  'audio.chunk': { name: 'transcribe-fake-chunk', handle(message) {
    const chunk = message.payload;
    validateChunk(chunk);
    const known = acceptedChunks.get(chunk.chunk_id);
    const fingerprint = fingerprintValue(chunk);
    if (known) {
      if (known.fingerprint !== fingerprint) throw new ServiceOperationError(`Chunk id ${chunk.chunk_id} was reused with different audio evidence`, { code: 'CHUNK_ID_CONFLICT', category: 'conflict' });
      return known.outputs;
    }
    try { ordering.accept(chunk.session_id, chunk.sequence); }
    catch (error) {
      if (error instanceof OrderedStreamError) throw new ServiceOperationError(error.message, { code: error.code, category: 'conflict', retryable: error.retryable, rejected: error.code === 'LATE_MESSAGE', details: { expected: error.expected, received: error.received } });
      throw error;
    }
    const marker = Buffer.from(chunk.audio_base64, 'base64').readInt16LE(0);
    const state = stateBySession.get(chunk.session_id) || { partialRevision: -1, nextWordSequence: 0 };
    const outputs = fixtureOutputs(marker, chunk, state);
    stateBySession.set(chunk.session_id, state);
    acceptedChunks.set(chunk.chunk_id, { fingerprint, outputs });
    return outputs;
  } }
} });

function fixtureOutputs(marker, chunk, state) {
  if (marker === 0) return [];
  const utteranceId = `${chunk.session_id}-utterance-0`;
  const correction = [
    { partial: 'are', words: [['are', 0.62, [{ text: 'Argus', confidence: 0.91 }]]], final: false },
    { partial: 'are you ready', words: [['you', 0.98, []], ['ready', 0.97, []]], final: false },
    { partial: 'Argus, are you ready?', words: [], final: true, punctuation: 'question' }
  ];
  const statement = [
    { partial: 'we are ready', words: [['we', 0.99, []], ['are', 0.99, []]], final: false },
    { partial: 'We are ready.', words: [['ready', 0.99, []]], final: true, punctuation: 'statement' }
  ];
  const long = { partial: `long monologue token ${marker - 19}`, words: [[`token${marker - 19}`, 0.96, []]], final: marker === 31, punctuation: 'statement' };
  const step = marker >= 1 && marker <= 3 ? correction[marker - 1] : marker >= 10 && marker <= 11 ? statement[marker - 10] : long;
  const audioWindowId = `${chunk.session_id}-audio-window-0`;
  state.partialRevision += 1;
  const outputs = [{ messageType: 'transcript.partial', identityKey: `transcript.partial:${utteranceId}:r${state.partialRevision}`, payload: {
    projection_id: `${utteranceId}-partial`, session_id: chunk.session_id, utterance_id: utteranceId, revision: state.partialRevision,
    ...(state.partialRevision ? { replaces_revision: state.partialRevision - 1 } : {}), start_time: '00:00:00.000', end_time: chunk.end_time,
    text: step.partial, stability: step.final ? 1 : 0.55 + Math.min(0.35, state.partialRevision * 0.15), covered_chunk_ids: Array.from({ length: chunk.sequence + 1 }, (_, index) => `${chunk.session_id}-chunk-${index}`)
  } }];
  for (const [text, confidence, alternatives] of step.words) {
    const sequence = state.nextWordSequence++;
    outputs.push({ messageType: 'transcript.word-committed', schemaVersion: '1.3.0', identityKey: `transcript.word-committed:${chunk.session_id}:${sequence}`, payload: {
      word_id: `${chunk.session_id}-word-${sequence}`, session_id: chunk.session_id, utterance_id: utteranceId, sequence,
      start_time: chunk.start_time, end_time: chunk.end_time, text, confidence,
      evidence: { provider: SERVICE, audio_window_id: audioWindowId, chunk_ids: [chunk.chunk_id], alternatives }
    } });
  }
  if (step.final) outputs.push({ messageType: 'transcript.utterance-boundary', schemaVersion: '1.3.0', identityKey: `transcript.utterance-boundary:${utteranceId}`, payload: {
    boundary_id: `${utteranceId}-boundary`, session_id: chunk.session_id, utterance_id: utteranceId, reason: 'pause',
    first_word_sequence: 0, last_word_sequence: state.nextWordSequence - 1, start_time: '00:00:00.000', end_time: chunk.end_time,
    punctuation_hint: step.punctuation, source_chunk_ids: Array.from({ length: chunk.sequence + 1 }, (_, index) => `${chunk.session_id}-chunk-${index}`),
    audio_window_id: audioWindowId,
    audio_window_span: {
      audio_window_id: audioWindowId,
      first_chunk_id: `${chunk.session_id}-chunk-0`,
      last_chunk_id: chunk.chunk_id,
      first_sequence: 0,
      last_sequence: chunk.sequence,
      chunk_count: chunk.sequence + 1,
      start_time: '00:00:00.000',
      end_time: chunk.end_time
    }
  } });
  return outputs;
}

function validateChunk(chunk) {
  if (!chunk?.session_id || !Number.isInteger(chunk.sequence)) throw invalid('session_id and sequence are required');
  if (chunk.format?.sample_rate_hz !== 16000 || chunk.format?.channels !== 1 || chunk.format?.bits_per_sample !== 16 || chunk.format?.byte_order !== 'little-endian') throw invalid('PCM16/16kHz/mono/little-endian is required');
  const bytes = Buffer.from(chunk.audio_base64 || '', 'base64');
  if (bytes.toString('base64') !== chunk.audio_base64) throw invalid('audio_base64 must be canonical padded base64');
  if (bytes.byteLength !== chunk.byte_length || bytes.byteLength !== chunk.sample_count * 2) throw invalid('PCM16 byte and sample metadata do not match decoded audio');
  const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (checksum !== chunk.checksum) throw invalid('audio checksum does not match decoded bytes');
}
function invalid(message) { return new ServiceOperationError(message, { code: 'INVALID_AUDIO_CHUNK', category: 'validation' }); }
