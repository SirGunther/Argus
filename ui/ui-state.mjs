const KINDS = Object.freeze(['transcript', 'derived']);

export function createUiState() {
  return {
    selected: { transcript: new Set(), derived: new Set() },
    sourceHighlights: new Set(),
    panes: {
      transcript: { followingLive: true, unseen: 0 },
      derived: { followingLive: true, unseen: 0 }
    },
    includeTimestamps: true
  };
}

export function reconcileKeyedRows({ list, items, itemId, createRow, updateRow, preserveRow = () => false }) {
  const existing = new Map([...list.children].map((row) => [row.dataset.id, row]));
  const desired = items.map((item) => {
    const id = itemId(item);
    const current = existing.get(id);
    if (!current) return createRow(item);
    existing.delete(id);
    updateRow(current, item, { preserveEditor: preserveRow(current) });
    return current;
  });

  for (const stale of existing.values()) stale.remove();
  desired.forEach((row, index) => {
    const current = list.children[index] || null;
    if (current !== row) list.insertBefore(row, current);
  });
  return desired;
}

export function resolveSourceRangeIds(transcriptRows, source) {
  if (!source?.first_segment_id || !source?.last_segment_id) return [];
  const first = transcriptRows.find((row) => row.segment_id === source.first_segment_id);
  const last = transcriptRows.find((row) => row.segment_id === source.last_segment_id);
  if (!first || !last) return [];
  const low = Math.min(first.sequence, last.sequence);
  const high = Math.max(first.sequence, last.sequence);
  return transcriptRows
    .filter((row) => row.sequence >= low && row.sequence <= high)
    .sort((left, right) => left.sequence - right.sequence)
    .map((row) => row.segment_id);
}

export function replaceSourceHighlights(uiState, segmentIds = []) {
  uiState.sourceHighlights = new Set(segmentIds);
  return uiState.sourceHighlights;
}

export function isSourceHighlighted(uiState, segmentId) {
  return uiState.sourceHighlights.has(segmentId);
}

// Logged Items must sort by the order they were actually logged, not by `logged_at`
// (source-content time). `logged_at` is derived from the spoken audio's session-elapsed clock,
// which restarts near zero whenever capture reinitializes without already knowing a session was
// active - e.g. relaunching the app and resuming a session recorded earlier - producing a smaller
// time string for genuinely later items. `orderMap` assigns each item a stable index the first
// time it's ever seen (live arrival or bootstrap load, both already in true creation order) and
// that index, not the unreliable time string, is what determines display order.
//
// `ensureDerivedOrder` must be called explicitly for a new item before it can ever reach
// `compareDerivedOrder` (app.js does this at push time, immediately before re-sorting). It must
// NOT be called lazily from inside the comparator: Array.prototype.sort does not guarantee which
// argument order it compares elements in, so assigning on first comparison would hand out indices
// based on the sort algorithm's internal traversal order instead of true arrival order - the same
// class of bug this function exists to fix, just moved one level down.
export function ensureDerivedOrder(orderMap, itemId) {
  if (!orderMap.has(itemId)) orderMap.set(itemId, orderMap.size);
  return orderMap.get(itemId);
}

export function compareDerivedOrder(orderMap, a, b) {
  return orderMap.get(a.item_id) - orderMap.get(b.item_id);
}

export function describeClassification(suggestion, serviceStatus) {
  const availability = serviceStatus?.status || 'degraded';
  if (suggestion) {
    return {
      state: 'suggested',
      text: `Optional suggestion · ${suggestion.label} · non-authoritative`,
      title: `Optional suggestion from ${suggestion.suggested_by}; classification is ${availability} and editing remains available.`
    };
  }
  if (availability === 'available') {
    return { state: 'available', text: 'Optional classification available · no suggestion', title: 'Classification is optional; editing remains available without a suggestion.' };
  }
  return {
    state: availability,
    text: `Optional classification ${availability} · editing unaffected`,
    title: serviceStatus?.message || 'Optional classification is not currently available; editing remains available.'
  };
}

export function toggleSelected(uiState, kind, id, selected) {
  assertKind(kind);
  if (selected) uiState.selected[kind].add(id);
  else uiState.selected[kind].delete(id);
  return uiState;
}

export function setAllSelected(uiState, kind, ids, selected) {
  assertKind(kind);
  uiState.selected[kind] = new Set(selected ? ids : []);
  return uiState;
}

export function selectRange(uiState, kind, ids, startIndex, endIndex) {
  assertKind(kind);
  if (!Array.isArray(ids) || !Number.isInteger(startIndex) || !Number.isInteger(endIndex)) return [];
  if (startIndex < 0 || endIndex < 0 || startIndex >= ids.length || endIndex >= ids.length) return [];

  const first = Math.min(startIndex, endIndex);
  const last = Math.max(startIndex, endIndex);
  const range = ids.slice(first, last + 1);
  const nextSelected = new Set(uiState.selected[kind]);
  range.forEach((id) => nextSelected.add(id));
  uiState.selected[kind] = nextSelected;
  return range;
}

export function selectionSummary(uiState, kind, ids = []) {
  assertKind(kind);
  const selected = uiState.selected[kind];
  let selectedCount = 0;
  for (const id of ids) {
    if (selected.has(id)) selectedCount += 1;
  }
  const totalCount = ids.length;
  const state = selectedCount === 0 ? 'none' : selectedCount === totalCount ? 'all' : 'some';
  return { selectedCount, totalCount, state };
}

export function isSelected(uiState, kind, id) {
  assertKind(kind);
  return uiState.selected[kind].has(id);
}

export function selectionCount(uiState, kind) {
  assertKind(kind);
  return uiState.selected[kind].size;
}

export function notePaneScroll(uiState, kind, { distanceFromBottom, threshold = 24 } = {}) {
  assertKind(kind);
  const pane = uiState.panes[kind];
  if (distanceFromBottom <= threshold) {
    pane.followingLive = true;
    pane.unseen = 0;
  } else {
    pane.followingLive = false;
  }
  return pane;
}

export function noteIncomingContent(uiState, kind) {
  assertKind(kind);
  const pane = uiState.panes[kind];
  if (!pane.followingLive) pane.unseen += 1;
  return pane;
}

export function jumpToLive(uiState, kind) {
  assertKind(kind);
  uiState.panes[kind] = { followingLive: true, unseen: 0 };
  return uiState.panes[kind];
}

function assertKind(kind) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown UI pane: ${kind}`);
}
