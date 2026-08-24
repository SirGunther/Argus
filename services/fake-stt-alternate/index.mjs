import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';

const SERVICE = 'fake-stt-alternate';
const states = new Map();
runLineService({ service: SERVICE, operations: {
  'audio.chunk': { name: 'transcribe-provider-b', handle(message) {
    const chunk = message.payload;
    if (!chunk?.session_id || !Number.isInteger(chunk.sequence)) throw new ServiceOperationError('valid audio chunk is required', { code: 'INVALID_AUDIO_CHUNK', category: 'validation' });
    const marker = Buffer.from(chunk.audio_base64, 'base64').readInt16LE(0);
    const steps = [
      { partial: 'are', words: [['are', 0.62, [{ text: 'Argus', confidence: 0.91 }]]] },
      { partial: 'are you ready', words: [['you', 0.98, []], ['ready', 0.97, []]] },
      { partial: 'Argus, are you ready?', words: [], final: true }
    ];
    const step = steps[marker - 1];
    if (!step) throw new ServiceOperationError(`Provider-B fixture does not support marker ${marker}`, { code: 'UNSUPPORTED_FAKE_AUDIO', category: 'validation' });
    const state = states.get(chunk.session_id) || { nextWord: 0 };
    const utteranceId = `${chunk.session_id}-utterance-0`;
    const outputs = [{ messageType: 'transcript.partial', identityKey: `transcript.partial:${utteranceId}:r${chunk.sequence}`, payload: {
      projection_id: `${utteranceId}-partial`, session_id: chunk.session_id, utterance_id: utteranceId, revision: chunk.sequence,
      ...(chunk.sequence ? { replaces_revision: chunk.sequence - 1 } : {}), start_time: '00:00:00.000', end_time: chunk.end_time,
      text: step.partial, stability: step.final ? 1 : 0.65, covered_chunk_ids: Array.from({ length: chunk.sequence + 1 }, (_, index) => `${chunk.session_id}-chunk-${index}`)
    } }];
    for (const [text, confidence, alternatives] of step.words) {
      const sequence = state.nextWord++;
      outputs.push({ messageType: 'transcript.word-committed', identityKey: `transcript.word-committed:${chunk.session_id}:${sequence}`, payload: {
        word_id: `${chunk.session_id}-word-${sequence}`, session_id: chunk.session_id, utterance_id: utteranceId, sequence,
        start_time: chunk.start_time, end_time: chunk.end_time, text, confidence, evidence: { provider: SERVICE, chunk_ids: [chunk.chunk_id], alternatives }
      } });
    }
    if (step.final) outputs.push({ messageType: 'transcript.utterance-boundary', identityKey: `transcript.utterance-boundary:${utteranceId}`, payload: {
      boundary_id: `${utteranceId}-boundary`, session_id: chunk.session_id, utterance_id: utteranceId, reason: 'pause', first_word_sequence: 0,
      last_word_sequence: state.nextWord - 1, start_time: '00:00:00.000', end_time: chunk.end_time, punctuation_hint: 'question',
      source_chunk_ids: Array.from({ length: chunk.sequence + 1 }, (_, index) => `${chunk.session_id}-chunk-${index}`)
    } });
    states.set(chunk.session_id, state);
    return outputs;
  } }
} });
