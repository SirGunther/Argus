import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { fingerprintValue } from '../../runtime/message-identity.mjs';

const SERVICE = 'logged-item-memory-store';
const INSTANCE = process.env.ARGUS_SERVICE_INSTANCE_ID || SERVICE;
const items = new Map();
const draftFingerprints = new Map();
runLineService({ service: SERVICE, operations: {
  'logged-item.draft': { name: 'store-item', onDuplicate: 'handle', handle(message) {
    const draft = message.payload;
    if (!draft?.item_id) throw invalid('item_id is required');
    if (!draft.session_id) throw invalid('session_id is required');
    if (typeof draft.text !== 'string' || !draft.text.trim()) throw invalid('text is required');
    if (!Number.isInteger(draft.revision) || draft.revision < 0) throw invalid('revision must be a non-negative integer');
    if (!draft.source?.first_segment_id || !draft.source?.last_segment_id) throw invalid('source segment range is required');
    const draftFingerprint = fingerprintValue(draft);
    if (items.has(draft.item_id)) {
      const current = items.get(draft.item_id);
      if (draft.revision !== current.revision) throw new ServiceOperationError(`Draft revision ${draft.revision} is stale; current revision is ${current.revision}`, { code: 'STALE_RESULT', category: 'conflict', rejected: true, details: { result_revision: draft.revision, current_revision: current.revision } });
      if (draftFingerprints.get(draft.item_id) !== draftFingerprint) throw new ServiceOperationError(`Item id ${draft.item_id} was reused with different content`, { code: 'ITEM_ID_CONFLICT', category: 'conflict' });
      return [{ messageType: 'logged-item.stored', identityKey: `${INSTANCE}:logged-item.stored:${draft.item_id}:revision:${draft.revision}`, payload: current }];
    }
    const stored = { item_id: draft.item_id, session_id: draft.session_id, stored_at: new Date().toISOString(), text: draft.text, revision: draft.revision, source: draft.source };
    items.set(stored.item_id, stored);
    draftFingerprints.set(stored.item_id, draftFingerprint);
    return [{ messageType: 'logged-item.stored', identityKey: `${INSTANCE}:logged-item.stored:${stored.item_id}:revision:${stored.revision}`, payload: stored }];
  } },
  'logged-item.update': { name: 'update-item', onDuplicate: 'handle', handle(message) {
    const update = message.payload;
    const current = items.get(update.item_id);
    if (!current) throw new ServiceOperationError(`Unknown item_id: ${update.item_id}`, { code: 'ITEM_NOT_FOUND', category: 'conflict' });
    if (current.session_id !== update.session_id) throw new ServiceOperationError('session_id does not match the stored item', { code: 'ITEM_SESSION_CONFLICT', category: 'conflict' });
    if (current.revision !== update.expected_revision) throw new ServiceOperationError(`Expected revision ${update.expected_revision}; current revision is ${current.revision}`, { code: 'STALE_REVISION', category: 'conflict', rejected: true, details: { expected_revision: update.expected_revision, current_revision: current.revision } });
    const stored = { ...current, text: update.text, revision: current.revision + 1, stored_at: update.updated_at };
    items.set(stored.item_id, stored);
    draftFingerprints.delete(stored.item_id);
    return [{ messageType: 'logged-item.stored', identityKey: `${INSTANCE}:logged-item.stored:${stored.item_id}:revision:${stored.revision}`, payload: stored }];
  } },
  'classification.suggestion': { name: 'accept-classification-suggestion', onDuplicate: 'handle', handle(message) {
    const suggestion = message.payload;
    const current = items.get(suggestion.item_id);
    if (!current) throw new ServiceOperationError(`Unknown item_id: ${suggestion.item_id}`, { code: 'ITEM_NOT_FOUND', category: 'conflict' });
    if (current.revision !== suggestion.item_revision) throw new ServiceOperationError(`Suggestion revision ${suggestion.item_revision} is stale; current revision is ${current.revision}`, { code: 'STALE_RESULT', category: 'conflict', rejected: true, details: { result_revision: suggestion.item_revision, current_revision: current.revision } });
    return [{ messageType: 'classification.suggestion-accepted', identityKey: `classification.suggestion-accepted:${suggestion.item_id}:revision:${suggestion.item_revision}:${suggestion.suggested_classification}`, payload: {
      item_id: suggestion.item_id,
      session_id: suggestion.session_id,
      item_revision: suggestion.item_revision,
      suggested_classification: suggestion.suggested_classification,
      accepted_at: current.stored_at
    } }];
  } }
} });

function invalid(message) { return new ServiceOperationError(message, { code: 'INVALID_INPUT', category: 'validation' }); }
