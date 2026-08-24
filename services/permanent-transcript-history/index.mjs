import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { fingerprintValue } from '../../runtime/message-identity.mjs';
import { SessionStorage, SessionStorageError } from '../../runtime/session-storage.mjs';

const SERVICE = 'permanent-transcript-history';
const entries = new Map();
runLineService({ service: SERVICE, operations: {
  'transcript.history-append': { name: 'append-transcript-revision', onDuplicate: 'handle', async handle(message) {
    const append = message.payload;
    if (!append?.history_entry_id || !append.segment?.segment_id) throw invalid('history_entry_id and segment are required');
    if (append.session_id !== append.segment.session_id) throw invalid('history session_id must match the segment');
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
        return [{ messageType: 'transcript.history-appended', identityKey: `transcript.history-appended:${append.history_entry_id}`, payload: {
          history_entry_id: append.history_entry_id, session_id: append.session_id, segment_id: append.segment.segment_id,
          segment_revision: append.segment.revision, appended_at: entry.appended_at
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
    return [{ messageType: 'transcript.history-appended', identityKey: `transcript.history-appended:${append.history_entry_id}`, payload: {
      history_entry_id: append.history_entry_id, session_id: append.session_id, segment_id: append.segment.segment_id,
      segment_revision: append.segment.revision, appended_at: appendedAt
    } }];
  } }
} });

function invalid(message) { return new ServiceOperationError(message, { code: 'INVALID_INPUT', category: 'validation' }); }
