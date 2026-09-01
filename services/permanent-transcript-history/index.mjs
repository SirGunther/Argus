import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { fingerprintValue } from '../../runtime/message-identity.mjs';
import { SessionStorage, SessionStorageError } from '../../runtime/session-storage.mjs';
import { createDiagnosticLogger } from '../../runtime/diagnostics.mjs';

const SERVICE = 'permanent-transcript-history';
const entries = new Map();
const diagnostics = createDiagnosticLogger({ enabled: process.env.ARGUS_DIAGNOSTICS === '1', source: SERVICE });
runLineService({ service: SERVICE, operations: {
  'transcript.history-append': { name: 'append-transcript-revision', onDuplicate: 'handle', async handle(message) {
    const append = message.payload;
    if (!append?.history_entry_id || !append.segment?.segment_id || !Number.isInteger(append.segment.revision) || append.segment.revision < 0) throw invalid('history_entry_id, segment, and non-negative segment revision are required');
    if (append.session_id !== append.segment.session_id) throw invalid('history session_id must match the segment');
    const revisionId = `${append.segment.segment_id}-r${append.segment.revision}`;
    if (append.segment.revision_id && append.segment.revision_id !== revisionId) throw invalid('segment revision_id must name its exact transcript revision');
    if (append.history_entry_id !== revisionId) throw invalid('history entry must name its exact transcript revision');
    if (process.env.ARGUS_SESSION_ROOT) {
      try {
        const durable = await new SessionStorage().appendHistory(append.session_id, 'transcript', {
          historyEntryId: append.history_entry_id,
          revision: append.segment.revision,
          record: append.segment,
          appendedAt: append.requested_at
        });
        const entry = durable.entry;
        entries.set(append.history_entry_id, { fingerprint: entry.fingerprint, segment: structuredClone(entry.record), appendedAt: entry.appended_at });
        diagnostics.log('transcript.history-appended', { session_id: append.session_id, history_entry_id: append.history_entry_id, segment_id: append.segment.segment_id, revision: append.segment.revision, durable: true });
        return [{ messageType: 'transcript.history-appended', schemaVersion: '1.3.0', identityKey: `transcript.history-appended:${append.history_entry_id}`, payload: {
          history_entry_id: append.history_entry_id, session_id: append.session_id, segment_id: append.segment.segment_id,
          segment_revision: append.segment.revision, revision_id: revisionId, appended_at: entry.appended_at
        } }];
      } catch (error) {
        if (error instanceof SessionStorageError) throw new ServiceOperationError(error.message, { code: error.code, category: 'conflict', details: error.details });
        throw error;
      }
    }
    const fingerprint = fingerprintValue(append.segment);
    const known = entries.get(append.history_entry_id);
    if (known && known.fingerprint !== fingerprint) throw new ServiceOperationError(`History entry ${append.history_entry_id} was reused with different content`, { code: 'IDEMPOTENT_INPUT_CONFLICT', category: 'conflict' });
    const appendedAt = known?.appendedAt || new Date().toISOString();
    if (!known) entries.set(append.history_entry_id, { fingerprint, segment: structuredClone(append.segment), appendedAt });
    diagnostics.log('transcript.history-appended', { session_id: append.session_id, history_entry_id: append.history_entry_id, segment_id: append.segment.segment_id, revision: append.segment.revision, durable: false });
    return [{ messageType: 'transcript.history-appended', schemaVersion: '1.3.0', identityKey: `transcript.history-appended:${append.history_entry_id}`, payload: {
      history_entry_id: append.history_entry_id, session_id: append.session_id, segment_id: append.segment.segment_id,
      segment_revision: append.segment.revision, revision_id: revisionId, appended_at: appendedAt
    } }];
  } }
} });

function invalid(message) { return new ServiceOperationError(message, { code: 'INVALID_INPUT', category: 'validation' }); }
