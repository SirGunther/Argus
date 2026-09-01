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
