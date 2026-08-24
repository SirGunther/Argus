import { createHash } from 'node:crypto';
import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';

const SERVICE = 'fake-audio-source';
const sessionFixtures = new Map();
const startedSessions = new Set();
const policyReadySessions = new Set();

runLineService({ service: SERVICE, operations: {
  'lifecycle.start': { name: 'emit-fake-audio', handle(message) {
    const sessionId = message.payload?.session_id;
    if (typeof sessionId !== 'string' || !sessionId) throw invalid('session_id is required');
    const fixture = message.payload.configuration?.fixture || 'correction-question';
    sessionFixtures.set(sessionId, fixture);
    if (startedSessions.has(sessionId) || (message.payload.configuration?.await_context_policy && !policyReadySessions.has(sessionId))) return [];
    return audioOutputs(sessionId, fixture);
  } },
  'transcript.context-policy': { name: 'release-policy-gated-audio', handle(message) {
    const sessionId = message.payload?.session_id;
    if (!sessionId) throw invalid('context policy session_id is required');
    policyReadySessions.add(sessionId);
    if (startedSessions.has(sessionId) || !sessionFixtures.has(sessionId)) return [];
    return audioOutputs(sessionId, sessionFixtures.get(sessionId));
  } }
} });

function audioOutputs(sessionId, fixture) {
  startedSessions.add(sessionId);
  const chunks = fixtureFor(fixture);
  return chunks.map((chunk, sequence) => {
      const bytes = pcmBytes(chunk.marker);
      return { messageType: 'audio.chunk', identityKey: `audio.chunk:${sessionId}:${sequence}`, payload: {
        chunk_id: `${sessionId}-chunk-${sequence}`, session_id: sessionId, sequence,
        start_time: clock(sequence * 500), end_time: clock((sequence + 1) * 500),
        format: { encoding: 'pcm-signed-integer', sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, byte_order: 'little-endian' },
        sample_count: bytes.byteLength / 2, byte_length: bytes.byteLength, audio_base64: bytes.toString('base64'),
        checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      } };
    });
}

function fixtureFor(name) {
  if (name === 'silence') return [{ marker: 0 }];
  if (name === 'long-monologue') return Array.from({ length: 12 }, (_, index) => ({ marker: 20 + index }));
  if (name === 'statement') return [{ marker: 10 }, { marker: 11 }];
  if (name === 'correction-question') return [{ marker: 1 }, { marker: 2 }, { marker: 3 }];
  throw invalid(`Unknown fake audio fixture: ${name}`);
}

function pcmBytes(marker) {
  const bytes = Buffer.alloc(16000);
  bytes.writeInt16LE(marker, 0);
  bytes.writeInt16LE(marker * 2, 2);
  bytes.writeInt16LE(-marker, 4);
  bytes.writeInt16LE(0, 6);
  return bytes;
}

function clock(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000).toString().padStart(2, '0');
  const fraction = (milliseconds % 1000).toString().padStart(3, '0');
  return `00:00:${seconds}.${fraction}`;
}

function invalid(message) { return new ServiceOperationError(message, { code: 'INVALID_INPUT', category: 'validation' }); }
