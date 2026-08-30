import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { fingerprintValue } from '../../runtime/message-identity.mjs';
import { OrderedStreamError, OrderedStreamGuard } from '../../runtime/ordered-stream.mjs';
import { SessionStorage, SessionStorageError } from '../../runtime/session-storage.mjs';
import { createDiagnosticLogger } from '../../runtime/diagnostics.mjs';

const SERVICE = 'active-transcript-owner';
const partialByUtterance = new Map();
const wordsByUtterance = new Map();
const boundaryByUtterance = new Map();
const requestById = new Map();
const segmentById = new Map();
const segmentSequenceBySession = new Map();
const wordOrdering = new OrderedStreamGuard();
const committedWords = new Map();
const finalizedUtterances = new Set();
const storage = process.env.ARGUS_SESSION_ROOT ? new SessionStorage() : null;
const loadedSessions = new Set();
const diagnostics = createDiagnosticLogger({ enabled: process.env.ARGUS_DIAGNOSTICS !== '0', source: SERVICE });
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
    catch (error) { if (error instanceof OrderedStreamError) throw new ServiceOperationError(error.message, { code: error.code, category: 'conflict', retryable: error.retryable, rejected: error.code === 'LATE_MESSAGE' }); throw error; }
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
    diagnostics.log('transcript.boundary-emitted', { session_id: message.payload.session_id, utterance_id: message.payload.utterance_id, boundary_id: message.payload.boundary_id, first_word_sequence: message.payload.first_word_sequence, last_word_sequence: message.payload.last_word_sequence, reason: message.payload.reason });
    return maybeRequestCorrection(message.payload.utterance_id);
  } },
  'transcript.correction-resolved': { name: 'finalize-transcript-segment', handle: async (message) => {
    const resolution = message.payload;
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
    const provenance = words.map((word) => {
      const proposal = accepted.get(word.word_id);
      return { word_id: word.word_id, source_text: word.text, rendered_text: proposal?.proposed_text || word.text, ...(proposal ? { correction_proposal_id: proposal.proposal_id } : {}) };
    });
    const proposedWordIds = new Set(resolution.proposals.map((proposal) => proposal.target_word_id));
    const punctuation = new Map((resolution.punctuation_after || [])
      .filter((item) => !proposedWordIds.has(item.word_id) || accepted.has(item.word_id))
      .map((item) => [item.word_id, item.mark]));
    let text = provenance.map((word) => `${word.rendered_text}${punctuation.get(word.word_id) || ''}`).join(' ');
    if (resolution.formatting.capitalize_first_word) text = text.charAt(0).toUpperCase() + text.slice(1);
    text = `${text.replace(/[.?!]$/, '')}${resolution.formatting.terminal_mark}`;
    const boundary = boundaryByUtterance.get(resolution.utterance_id);
    const sequence = segmentSequenceBySession.get(resolution.session_id) || 0;
    segmentSequenceBySession.set(resolution.session_id, sequence + 1);
    const segmentId = `${resolution.session_id}-segment-${sequence}`;
    const stored = {
      segment_id: segmentId, session_id: resolution.session_id, sequence, revision: 0, start_time: boundary.start_time, end_time: boundary.end_time,
      text, original_stt_text: words.map((word) => word.text).join(' '), boundary: boundary.reason, word_provenance: provenance,
      formatting: { source: 'contextual-language', provisional_until_finalized: true },
      review_flags: words.flatMap((word) => {
        const proposal = resolution.proposals.find((item) => item.target_word_id === word.word_id);
        if (!proposal && word.confidence < 0.75 && word.evidence.alternatives.length) return [{ word_id: word.word_id, reason: 'unresolved-ambiguity', candidates: [word.text, ...word.evidence.alternatives.map((item) => item.text)] }];
        if (proposal && proposal.confidence < threshold) return [{ word_id: word.word_id, reason: 'correction-review', candidates: [word.text, proposal.proposed_text] }];
        return [];
      }),
      stored_at: new Date().toISOString()
    };
    segmentById.set(segmentId, stored);
    await persistSession(resolution.session_id);
    diagnostics.log('transcript.segment-projected', { session_id: stored.session_id, segment_id: stored.segment_id, sequence: stored.sequence, transcript_preview: stored.text });
    finalizedUtterances.add(resolution.utterance_id);
    partialByUtterance.delete(resolution.utterance_id);
    wordsByUtterance.delete(resolution.utterance_id);
    boundaryByUtterance.delete(resolution.utterance_id);
    requestById.delete(resolution.request_id);
    for (const word of words) committedWords.delete(word.word_id);
    return segmentOutputs(stored, message.message_id);
  } },
  'transcript.segment-update': { name: 'revise-transcript-segment', handle: async (message) => {
    const update = message.payload;
    await loadSession(update.session_id);
    const current = segmentById.get(update.segment_id);
    if (!current) throw rejected('SEGMENT_NOT_FOUND', `Unknown segment ${update.segment_id}`);
    if (current.session_id !== update.session_id) throw rejected('SEGMENT_SESSION_CONFLICT', 'session_id does not match');
    if (current.revision !== update.expected_revision) throw rejected('STALE_REVISION', `Expected revision ${update.expected_revision}; current is ${current.revision}`);
    const stored = { ...current, revision: current.revision + 1, text: update.text, stored_at: update.updated_at };
    segmentById.set(stored.segment_id, stored);
    await persistSession(update.session_id);
    return segmentOutputs(stored, message.message_id, false);
  } }
} });

function maybeRequestCorrection(utteranceId) {
  const boundary = boundaryByUtterance.get(utteranceId);
  const words = wordsByUtterance.get(utteranceId) || [];
  if (!boundary || words.length !== boundary.last_word_sequence - boundary.first_word_sequence + 1) return [];
  const requestId = `${boundary.boundary_id}-correction`;
  if (requestById.has(requestId)) return [];
  const request = {
    request_id: requestId, session_id: boundary.session_id, utterance_id: utteranceId, boundary_id: boundary.boundary_id,
    words: words.map((word) => ({ word_id: word.word_id, sequence: word.sequence, text: word.text, confidence: word.confidence, alternatives: word.evidence.alternatives })),
    formatting_hint: boundary.punctuation_hint,
    policy: { profile: 'working-document-default', instruction_version: '1.0.0', automatic_acceptance_threshold: 0.9, max_context_words: 64 }
  };
  requestById.set(requestId, request);
  return [{ messageType: 'transcript.correction-request', identityKey: `transcript.correction-request:${requestId}`, payload: request }];
}

function segmentOutputs(stored, causationId, emitFinalizedSegment = true) {
  const outputs = [];
  if (emitFinalizedSegment) outputs.push({ messageType: 'transcript.segment', schemaVersion: '1.4.0', identityKey: `transcript.segment:${stored.segment_id}:r${stored.revision}`, payload: Object.fromEntries(Object.entries(stored).filter(([key]) => key !== 'stored_at')) });
  outputs.push({ messageType: 'transcript.segment-stored', schemaVersion: '1.3.0', identityKey: `transcript.segment-stored:${stored.segment_id}:r${stored.revision}`, payload: stored });
  outputs.push({ messageType: 'transcript.history-append', schemaVersion: '1.3.0', identityKey: `transcript.history-append:${stored.segment_id}:r${stored.revision}`, payload: {
    history_entry_id: `${stored.segment_id}-r${stored.revision}`, session_id: stored.session_id, segment: stored, requested_at: stored.stored_at
  } });
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
