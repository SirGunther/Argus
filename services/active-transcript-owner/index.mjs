import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { fingerprintValue } from '../../runtime/message-identity.mjs';
import { OrderedStreamError, OrderedStreamGuard } from '../../runtime/ordered-stream.mjs';
import { SessionStorage, SessionStorageError } from '../../runtime/session-storage.mjs';
import { createDiagnosticLogger } from '../../runtime/diagnostics.mjs';

const SERVICE = 'active-transcript-owner';
const MAX_PENDING_REVISIONS = 16;
const PAYLOAD_LIMITS = Object.freeze({ 'transcript.segment': 32768, 'transcript.segment-stored': 65536, 'transcript.history-append': 65536 });
const partialByUtterance = new Map();
const wordsByUtterance = new Map();
const boundaryByUtterance = new Map();
const requestById = new Map();
const segmentById = new Map();
const segmentSequenceBySession = new Map();
const wordOrdering = new OrderedStreamGuard();
const committedWords = new Map();
const finalizedUtterances = new Set();
const pendingByRevision = new Map();
const storage = process.env.ARGUS_SESSION_ROOT ? new SessionStorage() : null;
const loadedSessions = new Set();
const diagnostics = createDiagnosticLogger({ enabled: process.env.ARGUS_DIAGNOSTICS === '1', source: SERVICE });
const wordReceiptCountBySession = new Map();

runLineService({ service: SERVICE, operations: {
  'transcript.partial': { name: 'project-partial', handle: async (message) => {
    await loadSession(message.payload.session_id);
    const partial = message.payload;
    if (finalizedUtterances.has(partial.utterance_id)) throw rejected('LATE_PROJECTION', `Utterance ${partial.utterance_id} is already finalized`);
    const current = partialByUtterance.get(partial.utterance_id);
    if (current && partial.revision <= current.revision) throw rejected('STALE_PROJECTION', `Partial revision ${partial.revision} is not newer than ${current.revision}`);
    if (partial.revision > 0 && partial.replaces_revision !== partial.revision - 1) throw invalid('partial replaces_revision must name the previous revision');
    partialByUtterance.set(partial.utterance_id, { ...partial, read_only: true });
    return [];
  } },
  'transcript.word-committed': { name: 'assemble-committed-word', handle: async (message) => {
    await loadSession(message.payload.session_id);
    const word = message.payload;
    if (finalizedUtterances.has(word.utterance_id)) throw rejected('LATE_WORD', `Utterance ${word.utterance_id} is already finalized`);
    const known = committedWords.get(word.word_id);
    if (known) {
      if (known.fingerprint !== fingerprintValue(word)) throw new ServiceOperationError(`Word id ${word.word_id} was reused with different evidence`, { code: 'WORD_ID_CONFLICT', category: 'conflict' });
      return maybeRequestCorrection(word.utterance_id);
    }
    try { wordOrdering.accept(word.session_id, word.sequence); }
    catch (error) {
      if (error instanceof OrderedStreamError) {
        throw new ServiceOperationError(error.message, {
          code: error.code,
          category: 'conflict',
          retryable: error.retryable,
          rejected: error.code === 'LATE_MESSAGE',
          details: { expected: error.expected, received: error.received, stream_id: error.streamId }
        });
      }
      throw error;
    }
    const words = wordsByUtterance.get(word.utterance_id) || [];
    words.push(word); wordsByUtterance.set(word.utterance_id, words);
    committedWords.set(word.word_id, { fingerprint: fingerprintValue(word) });
    const receiptCount = (wordReceiptCountBySession.get(word.session_id) || 0) + 1;
    wordReceiptCountBySession.set(word.session_id, receiptCount);
    diagnostics.log('transcript.word-committed.received', { session_id: word.session_id, utterance_id: word.utterance_id, word_id: word.word_id, sequence: word.sequence, receipt_count: receiptCount });
    return maybeRequestCorrection(word.utterance_id);
  } },
  'transcript.utterance-boundary': { name: 'prepare-finalization', handle: async (message) => {
    await loadSession(message.payload.session_id);
    if (finalizedUtterances.has(message.payload.utterance_id)) throw rejected('LATE_BOUNDARY', `Utterance ${message.payload.utterance_id} is already finalized`);
    boundaryByUtterance.set(message.payload.utterance_id, message.payload);
    diagnostics.log('transcript.boundary-received', { session_id: message.payload.session_id, utterance_id: message.payload.utterance_id, boundary_id: message.payload.boundary_id, first_word_sequence: message.payload.first_word_sequence, last_word_sequence: message.payload.last_word_sequence, reason: message.payload.reason, input_message_id: message.message_id });
    diagnostics.log('transcript.boundary-emitted', { session_id: message.payload.session_id, utterance_id: message.payload.utterance_id, boundary_id: message.payload.boundary_id, first_word_sequence: message.payload.first_word_sequence, last_word_sequence: message.payload.last_word_sequence, reason: message.payload.reason });
    return maybeRequestCorrection(message.payload.utterance_id);
  } },
  'transcript.correction-resolved': { name: 'finalize-transcript-segment', handle: async (message) => {
    const resolution = message.payload;
    diagnostics.log('transcript.correction-resolving', { session_id: resolution.session_id, utterance_id: resolution.utterance_id, boundary_id: resolution.boundary_id, request_id: resolution.request_id, resolution_message_id: message.message_id, proposal_count: resolution.proposals?.length || 0 });
    await loadSession(resolution.session_id);
    const request = requestById.get(resolution.request_id);
    if (!request || request.boundary_id !== resolution.boundary_id) throw rejected('STALE_CORRECTION', 'Correction request is missing or no longer current');
    const words = wordsByUtterance.get(resolution.utterance_id) || [];
    const threshold = request.policy.automatic_acceptance_threshold;
    const accepted = new Map();
    for (const proposal of resolution.proposals) {
      const target = words.find((word) => word.word_id === proposal.target_word_id && word.sequence === proposal.target_word_sequence);
      if (target && target.text === proposal.expected_text && proposal.confidence >= threshold) accepted.set(target.word_id, proposal);
    }
    const boundary = boundaryByUtterance.get(resolution.utterance_id);
    if (!boundary) throw rejected('BOUNDARY_NOT_FOUND', `Boundary ${resolution.boundary_id} is no longer available`);
    const provenance = words.map((word) => {
      const proposal = accepted.get(word.word_id);
      return {
        word_id: word.word_id,
        source_text: word.text,
        rendered_text: proposal?.proposed_text || word.text,
        source_sequence: word.sequence,
        ...(word.evidence.audio_window_id ? { source_audio_window_id: word.evidence.audio_window_id } : {}),
        source_chunk_ids: word.evidence.chunk_ids,
        ...(proposal ? { correction_proposal_id: proposal.proposal_id } : {})
      };
    });
    const audioWindows = audioWindowsForBoundary(boundary);
    const proposedWordIds = new Set(resolution.proposals.map((proposal) => proposal.target_word_id));
    const punctuation = new Map((resolution.punctuation_after || [])
      .filter((item) => !proposedWordIds.has(item.word_id) || accepted.has(item.word_id))
      .map((item) => [item.word_id, item.mark]));
    let text = provenance.map((word) => `${word.rendered_text}${punctuation.get(word.word_id) || ''}`).join(' ');
    if (resolution.formatting.capitalize_first_word) text = text.charAt(0).toUpperCase() + text.slice(1);
    text = `${text.replace(/[.?!]$/, '')}${resolution.formatting.terminal_mark}`;
    const sequence = segmentSequenceBySession.get(resolution.session_id) || 0;
    const segmentId = `${resolution.session_id}-segment-${sequence}`;
    const stored = {
      segment_id: segmentId, revision_id: `${segmentId}-r0`, session_id: resolution.session_id, sequence, revision: 0, start_time: boundary.start_time, end_time: boundary.end_time,
      text, original_stt_text: words.map((word) => word.text).join(' '), boundary: boundary.reason, word_provenance: provenance,
      ...(audioWindows.length ? { audio_windows: audioWindows } : {}),
      formatting: { source: 'contextual-language', provisional_until_finalized: true },
      review_flags: words.flatMap((word) => {
        const proposal = resolution.proposals.find((item) => item.target_word_id === word.word_id);
        if (!proposal && word.confidence < 0.75 && word.evidence.alternatives.length) return [{ word_id: word.word_id, reason: 'unresolved-ambiguity', candidates: [word.text, ...word.evidence.alternatives.map((item) => item.text)] }];
        if (proposal && proposal.confidence < threshold) return [{ word_id: word.word_id, reason: 'correction-review', candidates: [word.text, proposal.proposed_text] }];
        return [];
      }),
      stored_at: new Date().toISOString()
    };
    const outputs = await stageRevision(resolution.session_id, stored, {
      utteranceId: resolution.utterance_id,
      requestId: resolution.request_id,
      emitSegment: true,
      causationId: message.message_id
    });
    segmentSequenceBySession.set(resolution.session_id, sequence + 1);
    diagnostics.log('transcript.correction-resolved', { session_id: resolution.session_id, utterance_id: resolution.utterance_id, boundary_id: resolution.boundary_id, request_id: resolution.request_id, resolution_message_id: message.message_id, accepted_proposal_count: accepted.size, word_count: words.length });
    return outputs;
  } },
  'transcript.segment-update': { name: 'revise-transcript-segment', handle: async (message) => {
    const update = message.payload;
    await loadSession(update.session_id);
    const current = segmentById.get(update.segment_id);
    if (!current) throw rejected('SEGMENT_NOT_FOUND', `Unknown segment ${update.segment_id}`);
    if (current.session_id !== update.session_id) throw rejected('SEGMENT_SESSION_CONFLICT', 'session_id does not match');
    if (current.revision !== update.expected_revision) throw rejected('STALE_REVISION', `Expected revision ${update.expected_revision}; current is ${current.revision}`);
    const stored = { ...current, revision: current.revision + 1, revision_id: `${current.segment_id}-r${current.revision + 1}`, text: update.text, stored_at: update.updated_at };
    return stageRevision(update.session_id, stored, { emitSegment: false, causationId: message.message_id });
  } },
  'transcript.history-appended': { name: 'commit-authoritative-transcript-revision', handle: async (message) => {
    const acknowledgement = message.payload;
    await loadSession(acknowledgement.session_id);
    const revisionId = acknowledgement.revision_id || `${acknowledgement.segment_id}-r${acknowledgement.segment_revision}`;
    if (acknowledgement.history_entry_id !== revisionId) throw rejected('HISTORY_REVISION_MISMATCH', `Permanent history acknowledged ${acknowledgement.history_entry_id}, expected ${revisionId}`);
    const key = pendingKey(acknowledgement.session_id, revisionId);
    const pending = pendingByRevision.get(key);
    if (!pending) {
      const current = segmentById.get(acknowledgement.segment_id);
      if (current?.revision_id === revisionId) return [];
      throw rejected('PENDING_REVISION_NOT_FOUND', `No pending active transcript revision exists for ${revisionId}`);
    }
    if (pending.segment.segment_id !== acknowledgement.segment_id || pending.segment.revision !== acknowledgement.segment_revision || pending.segment.revision_id !== revisionId) {
      throw rejected('HISTORY_REVISION_MISMATCH', `Permanent history acknowledgement does not match pending revision ${pending.segment.revision_id}`);
    }
    const current = segmentById.get(pending.segment.segment_id);
    if (current && current.revision > pending.segment.revision) throw rejected('STALE_REVISION', `Pending transcript revision ${pending.segment.revision_id} is older than active state`);
    if (current && current.revision === pending.segment.revision && fingerprintValue(current) !== fingerprintValue(pending.segment)) {
      throw new ServiceOperationError(`Active transcript revision ${revisionId} conflicts with its pending commit`, { code: 'AUTHORITATIVE_ACTIVE_CONFLICT', category: 'conflict' });
    }
    segmentById.set(pending.segment.segment_id, structuredClone(pending.segment));
    await persistSession(acknowledgement.session_id);
    pendingByRevision.delete(key);
    await persistPendingOutbox(acknowledgement.session_id);
    if (pending.utterance_id) {
      finalizedUtterances.add(pending.utterance_id);
      partialByUtterance.delete(pending.utterance_id);
      wordsByUtterance.delete(pending.utterance_id);
      boundaryByUtterance.delete(pending.utterance_id);
      if (pending.request_id) requestById.delete(pending.request_id);
      for (const word of pending.words || []) committedWords.delete(word.word_id);
    }
    diagnostics.log('transcript.authoritative-commit-completed', { session_id: acknowledgement.session_id, segment_id: pending.segment.segment_id, revision: pending.segment.revision, revision_id: revisionId, history_entry_id: acknowledgement.history_entry_id, word_count: pending.segment.word_provenance.length });
    diagnostics.log('transcript.segment-emitting', { session_id: pending.segment.session_id, segment_id: pending.segment.segment_id, sequence: pending.segment.sequence, revision: pending.segment.revision, revision_id: revisionId, word_count: pending.segment.word_provenance.length, transcript_preview: pending.segment.text });
    return segmentOutputs(pending.segment, message.message_id, pending.emitSegment)
      .filter((output) => output.messageType !== 'transcript.history-append');
  } }
} });

function maybeRequestCorrection(utteranceId) {
  const boundary = boundaryByUtterance.get(utteranceId);
  const words = wordsByUtterance.get(utteranceId) || [];
  if (!boundary || words.length !== boundary.last_word_sequence - boundary.first_word_sequence + 1) return [];
  assertWindowProvenance(boundary, words);
  const requestId = `${boundary.boundary_id}-correction`;
  if (requestById.has(requestId)) return [];
  const request = {
    request_id: requestId, session_id: boundary.session_id, utterance_id: utteranceId, boundary_id: boundary.boundary_id,
    words: words.map((word) => ({ word_id: word.word_id, sequence: word.sequence, text: word.text, confidence: word.confidence, alternatives: word.evidence.alternatives })),
    formatting_hint: boundary.punctuation_hint,
    policy: { profile: 'working-document-default', instruction_version: '1.0.0', automatic_acceptance_threshold: 0.9, max_context_words: 64 }
  };
  requestById.set(requestId, request);
  diagnostics.log('transcript.correction-requested', { session_id: request.session_id, utterance_id: request.utterance_id, boundary_id: request.boundary_id, request_id: request.request_id, word_count: request.words.length, formatting_hint: request.formatting_hint });
  return [{ messageType: 'transcript.correction-request', identityKey: `transcript.correction-request:${requestId}`, payload: request }];
}

function assertWindowProvenance(boundary, words) {
  const sourceChunks = new Set(boundary.source_chunk_ids);
  const windowSpan = boundary.audio_window_span;
  if (windowSpan) {
    if (boundary.audio_window_id && boundary.audio_window_id !== windowSpan.audio_window_id) throw rejected('WORD_WINDOW_MISMATCH', `Boundary ${boundary.boundary_id} has conflicting audio-window identities`);
    if (windowSpan.first_chunk_id !== boundary.source_chunk_ids[0] || windowSpan.last_chunk_id !== boundary.source_chunk_ids.at(-1) || windowSpan.chunk_count !== boundary.source_chunk_ids.length) {
      throw rejected('WORD_PROVENANCE_MISMATCH', `Boundary ${boundary.boundary_id} has an incomplete audio-window span`);
    }
    if (windowSpan.first_sequence > windowSpan.last_sequence) throw rejected('WORD_PROVENANCE_MISMATCH', `Boundary ${boundary.boundary_id} has a reversed audio-window sequence`);
  }
  for (const word of words) {
    if (boundary.audio_window_id && word.evidence.audio_window_id && boundary.audio_window_id !== word.evidence.audio_window_id) {
      throw rejected('WORD_WINDOW_MISMATCH', `Word ${word.word_id} belongs to ${word.evidence.audio_window_id}, boundary belongs to ${boundary.audio_window_id}`);
    }
    if (word.evidence.chunk_ids.some((chunkId) => !sourceChunks.has(chunkId))) {
      throw rejected('WORD_PROVENANCE_MISMATCH', `Word ${word.word_id} is sourced from audio outside boundary ${boundary.boundary_id}`);
    }
    const indexes = word.evidence.chunk_ids.map((chunkId) => boundary.source_chunk_ids.indexOf(chunkId));
    if (indexes.some((index) => index < 0) || indexes.some((index, position) => position > 0 && index !== indexes[position - 1] + 1)) {
      throw rejected('WORD_PROVENANCE_MISMATCH', `Word ${word.word_id} does not retain a contiguous minimal audio-chunk span`);
    }
  }
}

function audioWindowsForBoundary(boundary) {
  if (boundary.audio_window_span) return [structuredClone(boundary.audio_window_span)];
  const chunkIds = boundary.source_chunk_ids || [];
  if (!boundary.audio_window_id || !chunkIds.length) return [];
  const firstSequence = sequenceFromChunkId(chunkIds[0]);
  const lastSequence = sequenceFromChunkId(chunkIds.at(-1));
  if (!Number.isInteger(firstSequence) || !Number.isInteger(lastSequence)) return [];
  return [{
    audio_window_id: boundary.audio_window_id,
    first_chunk_id: chunkIds[0],
    last_chunk_id: chunkIds.at(-1),
    first_sequence: firstSequence,
    last_sequence: lastSequence,
    chunk_count: chunkIds.length,
    start_time: boundary.start_time,
    end_time: boundary.end_time
  }];
}

function sequenceFromChunkId(chunkId) {
  const match = /(?:^|-)chunk-(\d+)$/.exec(String(chunkId || ''));
  return match ? Number(match[1]) : undefined;
}

async function stageRevision(sessionId, stored, { utteranceId, requestId, emitSegment, causationId } = {}) {
  const revisionId = stored.revision_id || `${stored.segment_id}-r${stored.revision}`;
  const key = pendingKey(sessionId, revisionId);
  const known = pendingByRevision.get(key);
  if (known) {
    if (fingerprintValue(known.segment) !== fingerprintValue(stored)) throw new ServiceOperationError(`Pending transcript revision ${revisionId} was reused with different content`, { code: 'IDEMPOTENT_INPUT_CONFLICT', category: 'conflict' });
    return [historyAppendOutput(known.segment)];
  }
  if (pendingForSession(sessionId).length >= MAX_PENDING_REVISIONS) throw new ServiceOperationError(`Pending transcript revision outbox reached its governed ${MAX_PENDING_REVISIONS}-revision limit`, { code: 'TRANSCRIPT_OUTBOX_FULL', category: 'resource', retryable: true });
  const outputs = segmentOutputs(stored, causationId, emitSegment);
  await preflightRevisionOutputs(sessionId, outputs);
  pendingByRevision.set(key, { segment: structuredClone(stored), utterance_id: utteranceId, request_id: requestId, emitSegment: Boolean(emitSegment), words: utteranceId ? structuredClone(wordsByUtterance.get(utteranceId) || []) : [] });
  await persistPendingOutbox(sessionId);
  diagnostics.log('transcript.revision-staged', { session_id: sessionId, segment_id: stored.segment_id, revision: stored.revision, revision_id: revisionId, emit_segment: Boolean(emitSegment), pending_revision_count: pendingForSession(sessionId).length });
  return [historyAppendOutput(stored)];
}

async function preflightRevisionOutputs(sessionId, outputs) {
  for (const output of outputs) {
    const limit = PAYLOAD_LIMITS[output.messageType];
    const bytes = Buffer.byteLength(JSON.stringify(output.payload), 'utf8');
    if (bytes > limit) throw new ServiceOperationError(`${output.messageType} payload is ${bytes} bytes; maximum is ${limit} bytes`, { code: 'PAYLOAD_LIMIT_EXCEEDED', category: 'validation' });
    if (output.messageType === 'transcript.segment') validateSegmentPayload(output.payload, { stored: false, sessionId });
    if (output.messageType === 'transcript.segment-stored') validateSegmentPayload(output.payload, { stored: true, sessionId });
    if (output.messageType === 'transcript.history-append') validateHistoryAppendPayload(output.payload, sessionId);
  }
}

function validateSegmentPayload(segment, { stored, sessionId }) {
  const required = stored
    ? ['segment_id', 'session_id', 'sequence', 'revision', 'start_time', 'end_time', 'text', 'original_stt_text', 'boundary', 'word_provenance', 'stored_at']
    : ['segment_id', 'session_id', 'sequence', 'start_time', 'end_time', 'text', 'boundary'];
  if (!segment || typeof segment !== 'object' || required.some((key) => segment[key] === undefined)) throw invalid(`${stored ? 'transcript.segment-stored' : 'transcript.segment'} schema preflight failed: required field is missing`);
  const allowed = new Set(['segment_id', 'revision_id', 'session_id', 'sequence', 'revision', 'start_time', 'end_time', 'text', 'original_stt_text', 'boundary', 'word_provenance', 'audio_windows', 'formatting', 'review_flags', ...(stored ? ['stored_at'] : [])]);
  if (Object.keys(segment).some((key) => !allowed.has(key))) throw invalid(`${stored ? 'transcript.segment-stored' : 'transcript.segment'} schema preflight failed: additional field is not allowed`);
  if (sessionId !== undefined && segment.session_id !== sessionId) throw invalid('transcript segment session_id schema preflight failed');
  if (!Number.isInteger(segment.sequence) || segment.sequence < 0 || (stored && (!Number.isInteger(segment.revision) || segment.revision < 0))) throw invalid('transcript segment sequence/revision schema preflight failed');
  if (segment.revision_id !== undefined && segment.revision_id !== `${segment.segment_id}-r${segment.revision || 0}`) throw invalid('transcript segment revision_id schema preflight failed');
  if (![segment.segment_id, segment.session_id, segment.start_time, segment.end_time, segment.text, ...(stored ? [segment.original_stt_text, segment.stored_at] : []), ...(segment.revision_id !== undefined ? [segment.revision_id] : [])].every((value) => typeof value === 'string' && value.length > 0)) throw invalid('transcript segment string schema preflight failed');
  if (!['continuation', 'pause', 'size', 'latency', 'flush'].includes(segment.boundary)) throw invalid('transcript segment boundary schema preflight failed');
  if (!Array.isArray(segment.word_provenance) || !segment.word_provenance.length) throw invalid('transcript segment word_provenance schema preflight failed');
  for (const word of segment.word_provenance) {
    if (!word || typeof word !== 'object' || ![word.word_id, word.source_text, word.rendered_text].every((value) => typeof value === 'string' && value.length > 0)) throw invalid('transcript segment word provenance schema preflight failed');
    if (word.source_sequence !== undefined && (!Number.isInteger(word.source_sequence) || word.source_sequence < 0)) throw invalid('transcript segment source_sequence schema preflight failed');
    if (!Array.isArray(word.source_chunk_ids) || !word.source_chunk_ids.length || word.source_chunk_ids.some((chunkId) => typeof chunkId !== 'string' || !chunkId)) throw invalid('transcript segment source_chunk_ids schema preflight failed');
  }
  if (segment.audio_windows !== undefined) validateAudioWindows(segment.audio_windows);
  if (segment.formatting && (segment.formatting.provisional_until_finalized !== true || !['stt-provider', 'active-transcript-owner', 'contextual-language'].includes(segment.formatting.source))) throw invalid('transcript segment formatting schema preflight failed');
  if (segment.review_flags !== undefined && (!Array.isArray(segment.review_flags) || segment.review_flags.some((flag) => !flag || typeof flag !== 'object' || typeof flag.word_id !== 'string' || !['unresolved-ambiguity', 'correction-review'].includes(flag.reason) || !Array.isArray(flag.candidates) || flag.candidates.length < 1 || flag.candidates.some((candidate) => typeof candidate !== 'string' || !candidate)))) throw invalid('transcript segment review_flags schema preflight failed');
}

function validateAudioWindows(windows) {
  if (!Array.isArray(windows) || !windows.length) throw invalid('transcript segment audio_windows schema preflight failed');
  for (const window of windows) {
    if (!window || typeof window !== 'object' || ['audio_window_id', 'first_chunk_id', 'last_chunk_id', 'start_time', 'end_time'].some((key) => typeof window[key] !== 'string' || !window[key]) || !Number.isInteger(window.first_sequence) || window.first_sequence < 0 || !Number.isInteger(window.last_sequence) || window.last_sequence < 0 || window.first_sequence > window.last_sequence || !Number.isInteger(window.chunk_count) || window.chunk_count < 1 || window.chunk_count > 120) {
      throw invalid('transcript audio-window span schema preflight failed');
    }
  }
}

function validateHistoryAppendPayload(append, sessionId) {
  if (!append?.history_entry_id || !append.session_id || !append.requested_at || typeof append.history_entry_id !== 'string' || typeof append.session_id !== 'string' || typeof append.requested_at !== 'string') throw invalid('transcript history append schema preflight failed');
  if (sessionId !== undefined && append.session_id !== sessionId) throw invalid('transcript history append session_id schema preflight failed');
  const segment = append.segment;
  validateSegmentPayload(segment, { stored: true, sessionId: append.session_id });
  const revisionId = segment.revision_id || `${segment.segment_id}-r${segment.revision}`;
  if (append.history_entry_id !== revisionId || append.session_id !== segment.session_id) throw invalid('transcript history append revision identity preflight failed');
}

function historyAppendOutput(segment) {
  return {
    messageType: 'transcript.history-append',
    schemaVersion: '1.4.0',
    identityKey: `transcript.history-append:${segment.revision_id || `${segment.segment_id}-r${segment.revision}`}`,
    payload: {
      history_entry_id: segment.revision_id || `${segment.segment_id}-r${segment.revision}`,
      session_id: segment.session_id,
      segment,
      requested_at: segment.stored_at
    }
  };
}

function pendingKey(sessionId, revisionId) { return `${sessionId}:${revisionId}`; }
function pendingForSession(sessionId) { return [...pendingByRevision.entries()].filter(([key]) => key.startsWith(`${sessionId}:`)).map(([, value]) => value); }

async function persistPendingOutbox(sessionId) {
  if (!storage) return;
  await storage.writeTranscriptOutbox(sessionId, {
    schema_version: '1.0.0',
    session_id: sessionId,
    saved_at: new Date().toISOString(),
    pending: pendingForSession(sessionId).map((entry) => ({
      revision_id: entry.segment.revision_id || `${entry.segment.segment_id}-r${entry.segment.revision}`,
      segment: structuredClone(entry.segment),
      ...(entry.utterance_id ? { utterance_id: entry.utterance_id } : {}),
      ...(entry.request_id ? { request_id: entry.request_id } : {}),
      emit_segment: Boolean(entry.emitSegment)
    }))
  });
}

function segmentOutputs(stored, causationId, emitFinalizedSegment = true) {
  const outputs = [];
  if (emitFinalizedSegment) {
    diagnostics.log('transcript.segment-emitted', { session_id: stored.session_id, segment_id: stored.segment_id, sequence: stored.sequence, revision: stored.revision, boundary: stored.boundary, word_count: stored.word_provenance.length, causation_id: causationId, transcript_preview: stored.text });
    outputs.push({ messageType: 'transcript.segment', schemaVersion: '1.5.0', identityKey: `transcript.segment:${stored.revision_id || `${stored.segment_id}:r${stored.revision}`}`, payload: Object.fromEntries(Object.entries(stored).filter(([key]) => key !== 'stored_at')) });
  }
  outputs.push({ messageType: 'transcript.segment-stored', schemaVersion: '1.4.0', identityKey: `transcript.segment-stored:${stored.revision_id || `${stored.segment_id}:r${stored.revision}`}`, payload: stored });
  outputs.push(historyAppendOutput(stored));
  return outputs;
}

function invalid(message) { return new ServiceOperationError(message, { code: 'INVALID_INPUT', category: 'validation' }); }
function rejected(code, message) { return new ServiceOperationError(message, { code, category: 'conflict', rejected: true }); }

async function loadSession(sessionId) {
  if (!storage || loadedSessions.has(sessionId)) return;
  try {
    if (!await storage.readMetadata(sessionId)) throw new SessionStorageError('SESSION_NOT_FOUND', `Unknown session ${sessionId}`);
    const snapshot = await storage.readActiveSnapshot(sessionId, 'transcript');
    if (!snapshot) throw new SessionStorageError('ACTIVE_SNAPSHOT_MISSING', `Active transcript snapshot is missing for ${sessionId}`);
    let nextSequence = 0;
    for (const segment of snapshot.segments) {
      segmentById.set(segment.segment_id, segment);
      nextSequence = Math.max(nextSequence, segment.sequence + 1);
    }
    const outbox = await storage.readTranscriptOutbox(sessionId);
    if (outbox && (outbox.session_id !== sessionId || outbox.schema_version !== '1.0.0' || !Array.isArray(outbox.pending))) {
      throw new SessionStorageError('TRANSCRIPT_OUTBOX_INVALID', `Transcript pending outbox is not governed for ${sessionId}`);
    }
    for (const entry of outbox?.pending || []) {
      const segment = entry?.segment;
      const revisionId = entry?.revision_id || `${segment?.segment_id}-r${segment?.revision}`;
      if (!segment?.segment_id || segment.session_id !== sessionId || revisionId !== `${segment.segment_id}-r${segment.revision}`) {
        throw new SessionStorageError('TRANSCRIPT_OUTBOX_INVALID', `Transcript pending outbox contains an invalid revision for ${sessionId}`);
      }
      pendingByRevision.set(pendingKey(sessionId, revisionId), {
        segment: structuredClone(segment),
        ...(entry.utterance_id ? { utterance_id: entry.utterance_id } : {}),
        ...(entry.request_id ? { request_id: entry.request_id } : {}),
        emitSegment: Boolean(entry.emit_segment),
        words: []
      });
      nextSequence = Math.max(nextSequence, segment.sequence + 1);
    }
    segmentSequenceBySession.set(sessionId, nextSequence);
    loadedSessions.add(sessionId);
  } catch (error) {
    if (error instanceof SessionStorageError) throw new ServiceOperationError(error.message, { code: error.code, category: 'conflict', details: error.details });
    throw error;
  }
}

async function persistSession(sessionId) {
  if (!storage) return;
  try {
    await storage.writeActiveSnapshot(sessionId, 'transcript', { schema_version: '1.0.0', session_id: sessionId, saved_at: new Date().toISOString(), segments: [...segmentById.values()].filter((segment) => segment.session_id === sessionId) });
    diagnostics.log('transcript.active-storage-completed', { session_id: sessionId, segment_count: [...segmentById.values()].filter((segment) => segment.session_id === sessionId).length });
  } catch (error) {
    if (error instanceof SessionStorageError) throw new ServiceOperationError(error.message, { code: error.code, category: 'conflict', details: error.details });
    throw error;
  }
}
