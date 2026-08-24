import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createEnvelope, prepareGraph, loadGraphDefinition } from '../runtime/orchestrator.mjs';
import { runService } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const session = 'phase5a-session';
const manifest = (name) => path.join(root, 'services', name, 'service.json');

const draft = (text = 'User authoritative text.', idempotencyKey = 'draft:one') => createEnvelope({
  plane: 'domain', messageType: 'logged-item.draft', producer: 'test', correlationId: session, idempotencyKey,
  payload: {
    item_id: 'item-1', session_id: session, created_at: '2026-08-18T00:00:00.000Z', text, revision: 0, revision_id: 'item-1:r0',
    source: { first_segment_id: 'segment-1', last_segment_id: 'segment-2', start_time: '00:00:00.000', end_time: '00:00:02.000' },
    generator: { implementation: 'log-extractor-concise', input_window_id: 'window-1' }
  }
});

test('active owner preserves exact provenance, replays once, rejects identity conflict, and advances revisions once', async () => {
  const user = createEnvelope({ plane: 'domain', messageType: 'logged-item.update', producer: 'test', correlationId: session, idempotencyKey: 'update:one', payload: {
    item_id: 'item-1', session_id: session, expected_revision: 0, text: 'User edited text.', updated_at: '2026-08-18T00:01:00.000Z', editor: 'user'
  }});
  const stale = createEnvelope({ plane: 'domain', messageType: 'logged-item.update', producer: 'test', correlationId: session, idempotencyKey: 'update:stale', payload: {
    ...user.payload, expected_revision: 0, updated_at: '2026-08-18T00:02:00.000Z'
  }});
  const result = await runService(manifest('active-logged-item-owner'), [draft(), structuredClone(draft()), user, structuredClone(user), stale], 13);
  const stored = result.outputs.filter((message) => message.message_type === 'logged-item.stored');
  assert.deepEqual(stored.map((message) => message.payload.revision), [0, 0, 1, 1]);
  assert.equal(stored[0].payload.generator.input_window_id, 'window-1');
  assert.deepEqual(stored[0].payload.source, { first_segment_id: 'segment-1', last_segment_id: 'segment-2', start_time: '00:00:00.000', end_time: '00:00:02.000' });
  assert.equal(result.outputs.find((message) => message.message_type === 'operation.rejected').payload.reason.code, 'STALE_REVISION');

  const conflict = await runService(manifest('active-logged-item-owner'), [draft(), draft('Changed extractor content.', 'draft:changed')], 4);
  assert.equal(conflict.outputs.find((message) => message.message_type === 'service.failure').payload.error.code, 'ITEM_ID_CONFLICT');
});

test('deterministic extractors derive stable item identity from the context window and reject false provenance', async () => {
  const context = createEnvelope({ plane: 'domain', messageType: 'transcript.context-window', producer: 'test', correlationId: session, idempotencyKey: 'window:one', payload: {
    window_id: 'window-1', session_id: session, reason: 'pause',
    segments: [{ segment_id: 'segment-1', sequence: 0, start_time: '00:00:00.000', end_time: '00:00:02.000', text: 'Use the governed source.' }],
    source: { first_segment_id: 'segment-1', last_segment_id: 'segment-1', start_time: '00:00:00.000', end_time: '00:00:02.000' }
  }});
  const replay = await runService(manifest('log-extractor-concise'), [context, structuredClone(context)], 4);
  const drafts = replay.outputs.filter((message) => message.message_type === 'logged-item.draft');
  assert.equal(drafts[0].payload.item_id, drafts[1].payload.item_id);
  assert.equal(drafts[0].payload.revision_id, `${drafts[0].payload.item_id}:r0`);
  assert.deepEqual(drafts[0].payload.source, context.payload.source);
  assert.equal(drafts[0].payload.generator.input_window_id, 'window-1');

  const invalid = structuredClone(context);
  invalid.payload.source.end_time = '00:00:03.000';
  invalid.idempotency_key = 'window:invalid';
  invalid.content_fingerprint = (await import('../runtime/message-identity.mjs')).fingerprintMessage(invalid);
  const failure = await runService(manifest('log-extractor-passthrough'), [invalid], 1);
  assert.equal(failure.outputs[0].message_type, 'service.failure');
  assert.equal(failure.outputs[0].payload.error.code, 'INVALID_INPUT');
});

test('proposals never overwrite user text until an explicit user acceptance, and history appends each accepted revision idempotently', async () => {
  const proposed = createEnvelope({ plane: 'domain', messageType: 'logged-item.update-proposed', producer: 'test', correlationId: session, idempotencyKey: 'proposal:one', payload: {
    proposal_id: 'proposal-1', item_id: 'item-1', session_id: session, base_revision: 0, proposed_text: 'Model proposal.', proposed_at: '2026-08-18T00:01:00.000Z', generator: { implementation: 'deterministic-test' }
  }});
  const accept = createEnvelope({ plane: 'domain', messageType: 'logged-item.proposal-resolve', producer: 'test', correlationId: session, idempotencyKey: 'resolve:one', payload: {
    proposal_id: 'proposal-1', item_id: 'item-1', session_id: session, expected_revision: 0, decision: 'accepted', resolved_at: '2026-08-18T00:02:00.000Z', resolver: 'user'
  }});
  const active = await runService(manifest('active-logged-item-owner'), [draft(), proposed, accept], 8);
  const stored = active.outputs.filter((message) => message.message_type === 'logged-item.stored');
  assert.deepEqual(stored.map((message) => message.payload.text), ['User authoritative text.', 'Model proposal.']);
  assert.equal(active.outputs.find((message) => message.message_type === 'logged-item.proposal-resolved').payload.decision, 'accepted');

  const appends = active.outputs.filter((message) => message.message_type === 'logged-item.history-append');
  const history = await runService(manifest('permanent-logged-item-history'), [...appends, structuredClone(appends[0]), structuredClone(appends[1])], 8);
  assert.deepEqual(history.outputs.filter((message) => message.message_type === 'logged-item.history-appended').map((message) => message.payload.revision), [0, 1, 0, 1]);
});

test('Phase 5A graph admits only finalized context windows into extraction, keeps owners distinct, and wires evidence observation', async () => {
  const { definition, graphFile } = await loadGraphDefinition(path.join(root, 'wiring/demo.logged-item-pipeline.json'));
  const prepared = await prepareGraph(definition, graphFile);
  assert.equal(prepared.services.size, 6);
  assert.ok(definition.domain_wires.some((wire) => wire.from === 'active-owner' && wire.to === 'evidence-observer' && wire.contract === 'logged-item.stored'));
  assert.ok(definition.domain_wires.some((wire) => wire.from === 'active-owner' && wire.to === 'history-owner' && wire.contract === 'logged-item.history-append'));
  assert.ok(definition.domain_wires.some((wire) => wire.from === 'history-owner' && wire.to === 'evidence-observer' && wire.contract === 'logged-item.history-appended'));
  assert.equal(definition.domain_wires.some((wire) => wire.contract === 'transcript.partial'), false);
  const activeManifest = prepared.services.get('active-owner').manifest;
  const historyManifest = prepared.services.get('history-owner').manifest;
  assert.ok(activeManifest.ports.domain.accepts.includes('logged-item.update'));
  assert.equal(historyManifest.ports.domain.accepts.includes('logged-item.update'), false);
  for (const service of ['active-owner', 'history-owner', 'evidence-observer']) {
    const control = prepared.services.get(service).manifest.ports.control;
    assert.ok(control.accepts.includes('lifecycle.health-check'));
    assert.ok(control.accepts.includes('lifecycle.drain'));
  }
});
