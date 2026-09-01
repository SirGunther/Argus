import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandRouter } from '../ui/command-router.mjs';
import { createDemoAuthority } from '../ui/demo-state.mjs';
import { createUiBridge } from '../ui/bridge.mjs';
import { createUiContractBoundary } from '../ui/bridge-contracts.mjs';
import { createFakeCapabilities } from '../ui/platform-capabilities.mjs';
import { createUiState, noteIncomingContent, notePaneScroll, selectionCount, selectionSummary, setAllSelected, toggleSelected } from '../ui/ui-state.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:').replaceAll('/', '\\').replace(/\\$/, '');

test('Phase 7 projection contracts accept valid messages and reject missing exact provenance', async () => {
  const boundary = await createUiContractBoundary(root);
  const valid = boundary.projection('ui.logged-item-row', {
    session_id: 'ui-test-session', item_id: 'item-1', revision: 0, revision_id: 'item-1:r0', logged_at: '16:00:00', text: 'A logged item.',
    source: { first_segment_id: 'segment-1', last_segment_id: 'segment-2', start_time: '15:59:00', end_time: '16:00:00' }, classification_suggestion: null
  }, 'ui-test-session');
  assert.deepEqual(boundary.registry.validateEnvelope(valid), []);
  const missing = structuredClone(valid);
  delete missing.payload.source.first_segment_id;
  assert.throws(() => boundary.assertProjection(missing), /Contract validation failed/);
});

test('session status keeps legacy fields and exposes independent capture/transcription state', async () => {
  const boundary = await createUiContractBoundary(root);
  const message = boundary.projection('ui.session-status', {
    session_id: 'ui-audio-session', state: 'recording', elapsed_seconds: 2, created_at: '2026-08-30T00:00:00.000Z',
    duration_seconds: 2, transcript_count: 0, logged_item_count: 0,
    audio_processing: { state: 'transcribing', queue_depth: 1, capture_state: 'listening', transcription_state: 'transcribing' }
  }, 'ui-audio-session');
  assert.equal(message.schema_version, '1.2.0');
  assert.deepEqual(boundary.registry.validateEnvelope(message), []);
  assert.equal(message.payload.audio_processing.capture_state, 'listening');
  assert.equal(message.payload.audio_processing.transcription_state, 'transcribing');
  const legacy = structuredClone(message);
  legacy.schema_version = '1.0.0';
  delete legacy.payload.audio_processing;
  assert.deepEqual(boundary.registry.validateEnvelope(legacy), []);
});

test('UI command validation is closed over supported commands and rejects arbitrary paths', async () => {
  const boundary = await createUiContractBoundary(root);
  assert.doesNotThrow(() => boundary.assertCommand({ command_id: 'cmd-1', session_id: 'ui-test-session', command: 'open-folder' }));
  assert.throws(() => boundary.assertCommand({ command_id: 'cmd-2', session_id: 'ui-test-session', command: 'open-folder', path: 'C:\\secret' }), /not allowed/);
  assert.throws(() => boundary.assertCommand({ command_id: 'cmd-3', session_id: 'ui-test-session', command: 'transcript.edit', segment_id: 'segment-1', expected_revision: 0 }), /requires text/);
});

test('transcript and logged-item edits route through owners and stale revisions reject without overwrite', async () => {
  const boundary = await createUiContractBoundary(root);
  const authority = createDemoAuthority({ sessionId: 'ui-test-session' });
  const emitted = [];
  const router = createCommandRouter({ boundary, authority, capabilities: createFakeCapabilities(), emit: (type, payload) => { const value = { type, payload }; emitted.push(value); return value; } });
  const first = await router.handle({ command_id: 'edit-1', session_id: 'ui-test-session', command: 'transcript.edit', segment_id: 'segment-0', expected_revision: 0, text: 'Owner accepted transcript.' });
  assert.equal(first.payload.status, 'accepted');
  assert.equal(first.payload.revision, 1);
  const stale = await router.handle({ command_id: 'edit-2', session_id: 'ui-test-session', command: 'transcript.edit', segment_id: 'segment-0', expected_revision: 0, text: 'Must not overwrite.' });
  assert.equal(stale.payload.status, 'rejected');
  assert.equal(stale.payload.code, 'STALE_REVISION');
  assert.equal(authority.transcriptRows().find((row) => row.segment_id === 'segment-0').text, 'Owner accepted transcript.');
  const logged = await router.handle({ command_id: 'edit-3', session_id: 'ui-test-session', command: 'logged-item.edit', item_id: 'item-0', expected_revision: 0, text: 'Owner accepted logged item.' });
  assert.equal(logged.payload.status, 'accepted');
  assert.ok(emitted.some((event) => event.type === 'ui.transcript-row'));
  assert.ok(emitted.some((event) => event.type === 'ui.logged-item-row'));
});

test('copy and open-folder commands use deterministic capability fakes and preserve ordered copy', async () => {
  const boundary = await createUiContractBoundary(root);
  const authority = createDemoAuthority({ sessionId: 'ui-test-session' });
  const copied = [];
  const opened = [];
  const capabilities = createFakeCapabilities({ clipboard: async (text) => copied.push(text), openFolder: async (sessionId, resolved) => opened.push({ sessionId, resolved }) });
  const router = createCommandRouter({ boundary, authority, capabilities, emit: (type, payload) => ({ type, payload }) });
  const copy = await router.handle({ command_id: 'copy-1', session_id: 'ui-test-session', command: 'copy', kind: 'transcript', item_ids: ['segment-1', 'segment-0'], include_timestamps: false });
  assert.equal(copy.payload.status, 'accepted');
  assert.match(copied[0], /The handoff from sales[\s\S]*Let’s look at the account provisioning flow/);
  const open = await router.handle({ command_id: 'folder-1', session_id: 'ui-test-session', command: 'open-folder' });
  assert.equal(open.payload.status, 'accepted');
  assert.deepEqual(open.payload.owner, 'platform/folder');
  assert.deepEqual(opened, [{ sessionId: 'ui-test-session', resolved: '/fake/sessions/ui-test-session' }]);
});

test('selection and pane-following state remain independent UI concerns', () => {
  const ui = createUiState();
  toggleSelected(ui, 'transcript', 'segment-1', true);
  assert.equal(selectionCount(ui, 'transcript'), 1);
  assert.equal(selectionCount(ui, 'derived'), 0);
  setAllSelected(ui, 'derived', ['item-1', 'item-2'], true);
  assert.equal(selectionCount(ui, 'derived'), 2);
  notePaneScroll(ui, 'transcript', { distanceFromBottom: 100 });
  noteIncomingContent(ui, 'transcript');
  assert.equal(ui.panes.transcript.unseen, 1);
  assert.equal(ui.panes.derived.unseen, 0);
  notePaneScroll(ui, 'derived', { distanceFromBottom: 0 });
  noteIncomingContent(ui, 'derived');
  assert.equal(ui.panes.derived.unseen, 0);
});

test('selection summary drives the master control through unchecked, indeterminate, and checked states', () => {
  const ui = createUiState();
  const ids = ['item-1', 'item-2', 'item-3'];

  assert.deepEqual(selectionSummary(ui, 'derived', ids), { selectedCount: 0, totalCount: 3, state: 'none' });
  toggleSelected(ui, 'derived', 'item-1', true);
  assert.deepEqual(selectionSummary(ui, 'derived', ids), { selectedCount: 1, totalCount: 3, state: 'some' });
  setAllSelected(ui, 'derived', ids, true);
  assert.deepEqual(selectionSummary(ui, 'derived', ids), { selectedCount: 3, totalCount: 3, state: 'all' });
  setAllSelected(ui, 'derived', ids, false);
  assert.deepEqual(selectionSummary(ui, 'derived', ids), { selectedCount: 0, totalCount: 3, state: 'none' });

  toggleSelected(ui, 'derived', 'stale-item', true);
  assert.deepEqual(selectionSummary(ui, 'derived', ids), { selectedCount: 0, totalCount: 3, state: 'none' }, 'stale selections do not affect current-pane state');
});

test('loopback bridge starts deterministically, validates projections, and exposes no arbitrary file route', async () => {
  const bridge = await createUiBridge({ root, port: 0, startTimers: false });
  const address = await bridge.start();
  const base = `http://${address.host}:${address.port}`;
  try {
    const bootstrapResponse = await fetch(`${base}/api/bootstrap`);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.json();
    assert.ok(bootstrap.projections.some((message) => message.message_type === 'ui.transcript-row'));
    assert.ok(bootstrap.projections.some((message) => message.message_type === 'ui.service-status'));
    assert.equal((await fetch(`${base}/C:/Users/secret.txt`)).status, 404);
    const commandResponse = await fetch(`${base}/api/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_id: 'bridge-edit-1', session_id: 'AA-260811-042', command: 'transcript.edit', segment_id: 'segment-0', expected_revision: 0, text: 'Bridge accepted edit.' }) });
    assert.equal(commandResponse.status, 200);
    assert.equal((await commandResponse.json()).payload.status, 'accepted');
  } finally {
    await bridge.close();
  }
});
