import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoAuthority } from '../ui/demo-state.mjs';
import {
  createUiState,
  describeClassification,
  isSourceHighlighted,
  reconcileKeyedRows,
  replaceSourceHighlights,
  resolveSourceRangeIds
} from '../ui/ui-state.mjs';

test('incoming projections preserve the active keyed editor, typed value, and selection', () => {
  const list = new FakeList();
  const createRow = (item) => new FakeRow(item);
  const updateRow = (row, item, { preserveEditor }) => {
    row.item = item;
    if (!preserveEditor) row.editor.value = item.text;
  };

  reconcileKeyedRows({
    list,
    items: [{ id: 'segment-1', text: 'Owner text.' }],
    itemId: (item) => item.id,
    createRow,
    updateRow
  });
  const activeRow = list.children[0];
  const activeEditor = activeRow.editor;
  activeEditor.value = 'Owner text with an in-progress correction.';
  activeEditor.selectionStart = 16;
  activeEditor.selectionEnd = 30;
  activeEditor.focused = true;

  reconcileKeyedRows({
    list,
    items: [
      { id: 'segment-1', text: 'Owner text.' },
      { id: 'segment-2', text: 'New SSE projection.' }
    ],
    itemId: (item) => item.id,
    createRow,
    updateRow,
    preserveRow: (row) => row.editor === activeEditor && activeEditor.focused
  });

  assert.equal(list.children[0], activeRow, 'stable row identity must be reused');
  assert.equal(list.children[0].editor, activeEditor, 'the active editor must not be replaced');
  assert.equal(activeEditor.value, 'Owner text with an in-progress correction.');
  assert.deepEqual([activeEditor.selectionStart, activeEditor.selectionEnd], [16, 30]);
  assert.equal(activeEditor.focused, true);
  assert.deepEqual(list.children.map((row) => row.dataset.id), ['segment-1', 'segment-2']);
});

test('exact governed provenance highlights the entire range and replaces or clears the prior range', () => {
  const transcript = [
    { segment_id: 'segment-0', sequence: 0 },
    { segment_id: 'segment-1', sequence: 1 },
    { segment_id: 'segment-2', sequence: 2 },
    { segment_id: 'segment-3', sequence: 3 }
  ];
  const ui = createUiState();
  const firstRange = resolveSourceRangeIds(transcript, { first_segment_id: 'segment-1', last_segment_id: 'segment-3' });
  assert.deepEqual(firstRange, ['segment-1', 'segment-2', 'segment-3']);
  replaceSourceHighlights(ui, firstRange);
  assert.equal(isSourceHighlighted(ui, 'segment-1'), true);
  assert.equal(isSourceHighlighted(ui, 'segment-2'), true);
  assert.equal(isSourceHighlighted(ui, 'segment-3'), true);
  assert.equal(isSourceHighlighted(ui, 'segment-0'), false);

  const replacement = resolveSourceRangeIds(transcript, { first_segment_id: 'segment-0', last_segment_id: 'segment-1' });
  replaceSourceHighlights(ui, replacement);
  assert.equal(isSourceHighlighted(ui, 'segment-0'), true);
  assert.equal(isSourceHighlighted(ui, 'segment-1'), true);
  assert.equal(isSourceHighlighted(ui, 'segment-2'), false);
  assert.equal(isSourceHighlighted(ui, 'segment-3'), false);

  replaceSourceHighlights(ui);
  assert.equal(ui.sourceHighlights.size, 0);
  assert.deepEqual(resolveSourceRangeIds(transcript, { first_segment_id: 'unknown', last_segment_id: 'segment-2' }), []);
});

test('optional classification is visible, independently unavailable, and never blocks editing', () => {
  const authority = createDemoAuthority({ sessionId: 'classification-demo' });
  const classificationStatus = authority.serviceStatuses().find((status) => status.capability === 'classification');
  const [suggested, unsuggested] = authority.loggedItemRows();

  assert.equal(classificationStatus.status, 'unavailable');
  const suggestionPresentation = describeClassification(suggested.classification_suggestion, classificationStatus);
  assert.equal(suggestionPresentation.state, 'suggested');
  assert.match(suggestionPresentation.text, /^Optional suggestion · observation · non-authoritative$/);

  const unavailablePresentation = describeClassification(unsuggested.classification_suggestion, classificationStatus);
  assert.equal(unavailablePresentation.state, 'unavailable');
  assert.match(unavailablePresentation.text, /Optional classification unavailable · editing unaffected/);

  const edited = authority.editLoggedItem({
    session_id: 'classification-demo',
    item_id: unsuggested.item_id,
    expected_revision: unsuggested.revision,
    text: 'Editing remains governed and available.'
  });
  assert.equal(edited.text, 'Editing remains governed and available.');
  assert.equal(edited.revision, 1);
});

class FakeRow {
  constructor(item) {
    this.dataset = { id: item.id };
    this.item = item;
    this.editor = { value: item.text, selectionStart: 0, selectionEnd: 0, focused: false };
    this.parent = null;
  }

  remove() {
    this.parent?.remove(this);
  }
}

class FakeList {
  constructor() {
    this.nodes = [];
  }

  get children() {
    return this.nodes;
  }

  insertBefore(row, current) {
    if (row.parent) row.parent.remove(row);
    const index = current ? this.nodes.indexOf(current) : this.nodes.length;
    this.nodes.splice(index < 0 ? this.nodes.length : index, 0, row);
    row.parent = this;
  }

  remove(row) {
    const index = this.nodes.indexOf(row);
    if (index >= 0) this.nodes.splice(index, 1);
    row.parent = null;
  }
}
