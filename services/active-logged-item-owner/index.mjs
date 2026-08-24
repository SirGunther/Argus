import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { fingerprintValue } from '../../runtime/message-identity.mjs';
import { SessionStorage, SessionStorageError } from '../../runtime/session-storage.mjs';

const SERVICE = 'active-logged-item-owner';
const INSTANCE = process.env.ARGUS_SERVICE_INSTANCE_ID || SERVICE;
const items = new Map();
const drafts = new Map();
const proposals = new Map();
const resolutions = new Map();
const storage = process.env.ARGUS_SESSION_ROOT ? new SessionStorage() : null;
const loadedSessions = new Set();

runLineService({ service: SERVICE, operations: {
  'logged-item.draft': { name: 'accept-extracted-draft', handle: async (message) => {
    const draft = message.payload;
    await loadSession(draft.session_id);
    ensureDraft(draft);
    const fingerprint = fingerprintValue(draft);
    const current = items.get(draft.item_id);
    if (current) {
      const knownFingerprint = drafts.get(draft.item_id) || fingerprintValue({ ...current, created_at: current.stored_at, ...removeStoredAt(current) });
      if (knownFingerprint !== fingerprint) throw conflict('ITEM_ID_CONFLICT', `Item id ${draft.item_id} was reused with different content`);
      return outputs(current);
    }
    const { created_at: _createdAt, ...storedDraft } = draft;
    const stored = { ...storedDraft, stored_at: draft.created_at };
    items.set(stored.item_id, stored);
    drafts.set(stored.item_id, fingerprint);
    await persistSession(draft.session_id);
    return outputs(stored);
  } },
  'logged-item.update': { name: 'apply-user-update', handle: async (message) => {
    const update = message.payload;
    await loadSession(update.session_id);
    if (update.editor !== 'user') throw invalid('only user-authored updates are accepted');
    const current = currentItem(update);
    checkRevision(current, update.expected_revision);
    const stored = replaceValue(current, update.text, update.updated_at);
    await persistSession(update.session_id);
    return outputs(stored);
  } },
  'logged-item.update-proposed': { name: 'record-update-proposal', handle: async (message) => {
    const proposal = message.payload;
    await loadSession(proposal.session_id);
    const fingerprint = fingerprintValue(proposal);
    const known = proposals.get(proposal.proposal_id);
    if (known) {
      if (known.fingerprint !== fingerprint) throw conflict('PROPOSAL_ID_CONFLICT', `Proposal ${proposal.proposal_id} was reused with different content`);
      return [];
    }
    const current = currentItem(proposal);
    checkRevision(current, proposal.base_revision);
    proposals.set(proposal.proposal_id, { fingerprint, proposal: structuredClone(proposal) });
    return [];
  } },
  'logged-item.proposal-resolve': { name: 'resolve-user-proposal', handle: async (message) => {
    const resolution = message.payload;
    await loadSession(resolution.session_id);
    if (resolution.resolver !== 'user') throw invalid('only a user may resolve a proposal');
    const resolutionFingerprint = fingerprintValue(resolution);
    const previous = resolutions.get(resolution.proposal_id);
    if (previous) {
      if (previous.fingerprint !== resolutionFingerprint) throw conflict('PROPOSAL_RESOLUTION_CONFLICT', `Proposal ${resolution.proposal_id} was resolved differently`);
      return previous.outputs;
    }
    const known = proposals.get(resolution.proposal_id);
    if (!known) throw rejected('PROPOSAL_NOT_FOUND', `Unknown proposal ${resolution.proposal_id}`);
    const proposal = known.proposal;
    const current = currentItem(resolution);
    checkRevision(current, resolution.expected_revision);
    if (proposal.item_id !== resolution.item_id || proposal.session_id !== resolution.session_id) throw conflict('PROPOSAL_ITEM_CONFLICT', 'proposal item identity does not match resolution');
    const result = [{ messageType: 'logged-item.proposal-resolved', schemaVersion: '1.0.0', identityKey: `logged-item.proposal-resolved:${resolution.proposal_id}`, payload: {
      proposal_id: resolution.proposal_id, item_id: current.item_id, session_id: current.session_id, decision: resolution.decision,
      resolved_at: resolution.resolved_at, result_revision: resolution.decision === 'accepted' ? current.revision + 1 : current.revision
    } }];
    if (resolution.decision === 'accepted') {
      const stored = replaceValue(current, proposal.proposed_text, resolution.resolved_at);
      await persistSession(resolution.session_id);
      result.push(...outputs(stored));
    }
    resolutions.set(resolution.proposal_id, { fingerprint: resolutionFingerprint, outputs: result });
    return result;
  } }
} });

function outputs(item) {
  return [
    { messageType: 'logged-item.stored', identityKey: `${INSTANCE}:logged-item.stored:${item.revision_id}`, payload: item },
    { messageType: 'logged-item.history-append', schemaVersion: '1.0.0', identityKey: `${INSTANCE}:logged-item.history-append:${item.revision_id}`, payload: { history_entry_id: item.revision_id, session_id: item.session_id, item, requested_at: item.stored_at } }
  ];
}

function replaceValue(current, text, at) {
  const stored = { ...current, text, revision: current.revision + 1, revision_id: `${current.item_id}:r${current.revision + 1}`, stored_at: at };
  items.set(stored.item_id, stored);
  return stored;
}

function ensureDraft(draft) {
  if (!draft?.item_id || !draft.session_id || !draft.created_at || !draft.text?.trim() || draft.revision !== 0 || draft.revision_id !== `${draft.item_id}:r0` || !draft.source?.first_segment_id || !draft.source?.last_segment_id || !draft.source?.start_time || !draft.source?.end_time || !draft.generator?.implementation || !draft.generator?.input_window_id) throw invalid('draft must contain revision-0 identity and exact governed provenance');
}

function currentItem(command) {
  const current = items.get(command.item_id);
  if (!current) throw rejected('ITEM_NOT_FOUND', `Unknown item ${command.item_id}`);
  if (current.session_id !== command.session_id) throw conflict('ITEM_SESSION_CONFLICT', 'session_id does not match active item');
  return current;
}

function checkRevision(current, expected) { if (current.revision !== expected) throw rejected('STALE_REVISION', `Expected revision ${expected}; current revision is ${current.revision}`); }
function removeStoredAt(value) { const clone = { ...value }; delete clone.stored_at; return clone; }
function invalid(message) { return new ServiceOperationError(message, { code: 'INVALID_INPUT', category: 'validation' }); }
function conflict(code, message) { return new ServiceOperationError(message, { code, category: 'conflict' }); }
function rejected(code, message) { return new ServiceOperationError(message, { code, category: 'conflict', rejected: true }); }

async function loadSession(sessionId) {
  if (!storage || loadedSessions.has(sessionId)) return;
  try {
    if (!await storage.readMetadata(sessionId)) throw new SessionStorageError('SESSION_NOT_FOUND', `Unknown session ${sessionId}`);
    const snapshot = await storage.readActiveSnapshot(sessionId, 'logged-item');
    if (!snapshot) throw new SessionStorageError('ACTIVE_SNAPSHOT_MISSING', `Active logged-item snapshot is missing for ${sessionId}`);
    for (const item of snapshot.items) items.set(item.item_id, item);
    loadedSessions.add(sessionId);
  } catch (error) {
    if (error instanceof SessionStorageError) throw new ServiceOperationError(error.message, { code: error.code, category: 'conflict', details: error.details });
    throw error;
  }
}

async function persistSession(sessionId) {
  if (!storage) return;
  try {
    await storage.writeActiveSnapshot(sessionId, 'logged-item', { schema_version: '1.0.0', session_id: sessionId, saved_at: new Date().toISOString(), items: [...items.values()].filter((item) => item.session_id === sessionId) });
  } catch (error) {
    if (error instanceof SessionStorageError) throw new ServiceOperationError(error.message, { code: error.code, category: 'conflict', details: error.details });
    throw error;
  }
}
