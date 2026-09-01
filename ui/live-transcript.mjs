// Renderer-only state for the replaceable live transcript projection.
// Finalized transcript authority remains in app.js state.transcript.
export function createLiveTranscriptState() {
  return {
    current: null,
    records: new Map(),
    displayedOrder: 0,
    nextOrder: 0
  };
}

export function acceptLiveTranscript(state, item) {
  if (!item?.provisional) return result(false, false, 'invalid');
  const identity = primaryIdentity(item);
  const revision = Number(item.revision);
  if (!identity || !Number.isInteger(revision) || revision < 0) return result(false, false, 'invalid');

  if (item.dismissed) return dismissLiveTranscript(state, identity, revision);
  if (typeof item.text !== 'string' || !item.text.trim()) return result(false, false, 'invalid');

  let record = state.records.get(identity);
  if (!record) {
    record = { identity, order: ++state.nextOrder, revision: -1, item: null, finalized: false };
    state.records.set(identity, record);
  }
  if (record.finalized) return result(false, false, 'finalized');
  if (revision <= record.revision) return result(false, false, 'stale');

  record.revision = revision;
  record.item = { ...item };
  const isCurrent = state.current?.identity === identity;
  if (!isCurrent && record.order <= state.displayedOrder) return result(true, false, 'older-utterance');

  state.current = record;
  state.displayedOrder = record.order;
  return { accepted: true, changed: true, newUtterance: !isCurrent, reason: 'displayed', item: record.item };
}

function dismissLiveTranscript(state, identity, revision) {
  let record = state.records.get(identity);
  if (!record) {
    record = { identity, order: ++state.nextOrder, revision, item: null, finalized: true };
    state.records.set(identity, record);
    return result(true, false, 'finalized');
  }
  record.revision = Math.max(record.revision, revision);
  record.finalized = true;
  const cleared = state.current?.identity === identity;
  if (cleared) state.current = null;
  return { accepted: true, changed: cleared, cleared, newUtterance: false, reason: 'finalized', item: record.item };
}

export function finalizeLiveTranscript(state, item) {
  if (!item || item.provisional) return result(false, false, 'invalid');
  const record = [...state.records.values()].find((candidate) => matches(candidate, item));
  if (!record) return result(false, false, 'unmatched');

  record.finalized = true;
  const cleared = state.current?.identity === record.identity;
  if (cleared) state.current = null;
  return { accepted: true, changed: cleared, cleared, reason: 'finalized', item: record.item };
}

export function resetLiveTranscriptState(state) {
  state.current = null;
  state.records.clear();
  state.displayedOrder = 0;
  state.nextOrder = 0;
  return state;
}

function matches(record, item) {
  const recordIdentities = new Set([
    record.identity,
    ...identities(record.item)
  ]);
  return identities(item).some((identity) => recordIdentities.has(identity));
}

function primaryIdentity(item) {
  return identities(item)[0];
}

function identities(item) {
  return [
    item?.utterance_id ? `utterance:${item.utterance_id}` : null,
    item?.segment_id ? `segment:${item.segment_id}` : null
  ].filter(Boolean);
}

function result(accepted, changed, reason) {
  return { accepted, changed, newUtterance: false, reason };
}
