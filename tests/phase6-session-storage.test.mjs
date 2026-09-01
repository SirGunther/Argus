import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createEnvelope } from '../runtime/orchestrator.mjs';
import { SessionLifecycle, SessionLifecycleError } from '../runtime/session-lifecycle.mjs';
import { FINALIZATION_PHASES, SessionStorage } from '../runtime/session-storage.mjs';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { runService } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = (name) => path.join(root, 'services', name, 'service.json');

async function withRoot(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'argus-phase6-'));
  try { return await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function command(operationId, sessionId, requestedAt = '2026-08-19T00:00:00.000Z') { return { operation_id: operationId, session_id: sessionId, requested_at: requestedAt }; }
function segment(sessionId, revision, text = `Transcript revision ${revision}.`) { return { segment_id: `${sessionId}-segment-0`, session_id: sessionId, sequence: 0, revision, start_time: '0', end_time: '1', text, original_stt_text: 'Transcript', boundary: 'pause', word_provenance: [], formatting: { source: 'test', provisional_until_finalized: true }, stored_at: `2026-08-19T00:00:${String(revision).padStart(2, '0')}.000Z` }; }
function item(sessionId, revision) { return { item_id: `${sessionId}-item-0`, session_id: sessionId, revision, revision_id: `${sessionId}-item-0:r${revision}`, text: `Logged item ${revision}.`, source: { first_segment_id: `${sessionId}-segment-0`, last_segment_id: `${sessionId}-segment-0`, start_time: '0', end_time: '1' }, generator: { implementation: 'phase6-test', input_window_id: 'window-0' }, stored_at: `2026-08-19T00:00:${String(revision).padStart(2, '0')}.000Z` }; }
function legacyRepeatedSegment(sessionId) {
  const chunkIds = Array.from({ length: 103 }, (_, index) => `${sessionId}-chunk-${index + 45}`);
  return {
    segment_id: `${sessionId}-segment-0`, session_id: sessionId, sequence: 0, revision: 0,
    start_time: '00:00:11.520', end_time: '00:00:37.888', text: 'Recovered legacy transcript.', original_stt_text: 'Recovered legacy transcript.', boundary: 'pause',
    word_provenance: Array.from({ length: 30 }, (_, index) => ({ word_id: `${sessionId}-word-${index}`, source_text: `word-${index}`, rendered_text: `word-${index}`, source_sequence: index, source_audio_window_id: `${sessionId}-audio-window-45`, source_chunk_ids: chunkIds })),
    formatting: { source: 'contextual-language', provisional_until_finalized: true }, review_flags: [], stored_at: '2026-08-19T00:00:38.000Z'
  };
}

test('Phase 6 contract catalog and storage owners are governed', async () => {
  const registry = await loadContractRegistry(path.join(root, 'contracts', 'catalog.json'));
  for (const messageType of ['session.record', 'session.recorded', 'session.stop', 'session.stopped', 'session.resume', 'session.resumed', 'session.close', 'session.closed', 'session.folder-locate', 'session.folder-located']) {
    assert.equal(registry.planeFor(messageType), 'control');
  }
  assert.deepEqual(registry.validateArtifact('session_metadata', {
    schema_version: '1.0.0', session_id: 'governed-session', state: 'recording', revision: 0,
    created_at: '2026-08-19T00:00:00.000Z', updated_at: '2026-08-19T00:00:00.000Z', started_at: '2026-08-19T00:00:00.000Z',
    finalization: { schema_version: '1.0.0', session_id: 'governed-session', phase: 'none', operation_id: null, command: null, command_fingerprint: null, phase_history: [], updated_at: '2026-08-19T00:00:00.000Z' }, operations: {}
  }), []);
  assert.throws(() => new SessionStorage({ root: os.tmpdir() }).paths('../escape'), (error) => error.code === 'INVALID_SESSION_ID');
  assert.throws(() => new SessionStorage({ root: os.tmpdir() }).paths('C:\\outside'), (error) => error.code === 'INVALID_SESSION_ID');
});

test('Record, Stop, Resume preserve identity and active state, while contradictory identity reuse fails', async () => {
  await withRoot(async (directory) => {
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    const sessionId = 'lifecycle-session';
    const record = command('record-1', sessionId);
    assert.equal((await lifecycle.record(record)).state, 'recording');
    assert.deepEqual(await lifecycle.record(record), await lifecycle.record(record));
    await lifecycle.acceptTranscriptRevision(sessionId, segment(sessionId, 0));
    await lifecycle.acceptLoggedItemRevision(sessionId, item(sessionId, 0));
    const beforeStop = await lifecycle.getActiveProjections(sessionId);
    const stopped = await lifecycle.stop(command('stop-1', sessionId, '2026-08-19T00:01:00.000Z'));
    assert.equal(stopped.state, 'stopped');
    assert.deepEqual(await lifecycle.getActiveProjections(sessionId), beforeStop);
    await assert.rejects(() => lifecycle.acceptTranscriptRevision(sessionId, segment(sessionId, 1)), (error) => error.code === 'SESSION_NOT_RECORDING');
    const resumed = await lifecycle.resume(command('resume-1', sessionId, '2026-08-19T00:02:00.000Z'));
    assert.equal(resumed.session_id, sessionId);
    await lifecycle.acceptTranscriptRevision(sessionId, segment(sessionId, 1));
    await assert.rejects(() => lifecycle.record({ ...record, requested_at: '2026-08-19T01:00:00.000Z' }), (error) => error.code === 'OPERATION_ID_CONFLICT');
    await assert.rejects(() => lifecycle.record(command('record-2', sessionId)), (error) => error.code === 'SESSION_ID_CONFLICT');
  });
});

test('Close is recoverable and idempotent without duplicating permanent transcript or logged-item history', async () => {
  await withRoot(async (directory) => {
    const storage = new SessionStorage({ root: directory });
    const lifecycle = new SessionLifecycle({ storage });
    const sessionId = 'close-session';
    await lifecycle.record(command('record-1', sessionId));
    await lifecycle.acceptTranscriptRevision(sessionId, segment(sessionId, 0));
    await lifecycle.acceptLoggedItemRevision(sessionId, item(sessionId, 0));
    const close = command('close-1', sessionId, '2026-08-19T00:03:00.000Z');
    const first = await lifecycle.close(close);
    const replay = await lifecycle.close(close);
    assert.deepEqual(replay, first);
    assert.equal((await storage.readHistory(sessionId, 'transcript')).length, 1);
    assert.equal((await storage.readHistory(sessionId, 'logged-item')).length, 1);
    await assert.rejects(() => lifecycle.close(command('close-2', sessionId)), (error) => error.code === 'SESSION_CLOSED');
    await assert.rejects(() => lifecycle.acceptLoggedItemRevision(sessionId, item(sessionId, 1)), (error) => error.code === 'SESSION_CLOSED');
    const metadata = await storage.readMetadata(sessionId);
    assert.equal(metadata.state, 'closed');
    assert.equal(metadata.finalization.phase, 'released');
    assert.equal((await storage.readCloseEvidence(sessionId)).integrity, 'verified');
  });
});

test('durable transcript outbox reconciles an acknowledged revision before close seals the session', async () => {
  await withRoot(async (directory) => {
    const storage = new SessionStorage({ root: directory });
    const sessionId = 'transcript-outbox-recovery';
    const lifecycle = new SessionLifecycle({ storage });
    await lifecycle.record(command('record-1', sessionId));
    const pending = { ...segment(sessionId, 0, 'Recovered transcript.'), revision_id: `${sessionId}-segment-0-r0` };
    await storage.appendHistory(sessionId, 'transcript', { historyEntryId: pending.revision_id, revision: pending.revision, record: pending, appendedAt: pending.stored_at });
    await storage.writeTranscriptOutbox(sessionId, { schema_version: '1.0.0', session_id: sessionId, saved_at: pending.stored_at, pending: [{ revision_id: pending.revision_id, segment: pending, emit_segment: true }] });
    assert.deepEqual((await storage.readActiveSnapshot(sessionId, 'transcript')).segments, []);
    assert.deepEqual((await storage.readTranscriptOutbox(sessionId)).pending.map((entry) => entry.revision_id), [pending.revision_id]);

    const recovered = await new SessionLifecycle({ storage: new SessionStorage({ root: directory }) }).close(command('close-1', sessionId));
    const active = await storage.readActiveSnapshot(sessionId, 'transcript');
    const outbox = await storage.readTranscriptOutbox(sessionId);
    assert.deepEqual(active.segments, [pending]);
    assert.deepEqual(outbox.pending, []);
    assert.equal(recovered.transcript_history_count, 1);
    assert.equal((await storage.readHistory(sessionId, 'transcript'))[0].history_entry_id, pending.revision_id);
  });
});

test('close compacts a legacy repeated-provenance segment before durable history append', async () => {
  await withRoot(async (directory) => {
    const storage = new SessionStorage({ root: directory });
    const sessionId = 'legacy-provenance-recovery';
    const lifecycle = new SessionLifecycle({ storage });
    await lifecycle.record(command('record-1', sessionId));
    const legacy = legacyRepeatedSegment(sessionId);
    await storage.writeActiveSnapshot(sessionId, 'transcript', { schema_version: '1.0.0', session_id: sessionId, saved_at: legacy.stored_at, segments: [legacy] });

    const closed = await lifecycle.close(command('close-1', sessionId));
    assert.equal(closed.state, 'closed');
    const active = (await storage.readActiveSnapshot(sessionId, 'transcript')).segments[0];
    const history = (await storage.readHistory(sessionId, 'transcript'))[0];
    assert.equal(active.revision_id, undefined);
    assert.deepEqual(active.audio_windows, [{
      audio_window_id: `${sessionId}-audio-window-45`, first_chunk_id: `${sessionId}-chunk-45`, last_chunk_id: `${sessionId}-chunk-147`,
      first_sequence: 45, last_sequence: 147, chunk_count: 103, start_time: legacy.start_time, end_time: legacy.end_time
    }]);
    assert.equal(active.word_provenance.every((word) => !('source_chunk_ids' in word)), true);
    assert.equal(history.history_entry_id, `${sessionId}-segment-0-r0`);
    assert.deepEqual(history.record, active);
    assert.ok(Buffer.byteLength(JSON.stringify(history.record), 'utf8') < 32768);
  });
});

test('every close-finalization phase survives interruption before and after the phase', async () => {
  for (const phase of FINALIZATION_PHASES.slice(1)) {
    for (const edge of ['before', 'after']) {
      await withRoot(async (directory) => {
        const sessionId = `recovery-${phase}-${edge}`;
        const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
        await lifecycle.record(command('record-1', sessionId));
        await lifecycle.acceptTranscriptRevision(sessionId, segment(sessionId, 0));
        const close = command('close-1', sessionId);
        await assert.rejects(() => lifecycle.close(close, edge === 'before' ? { failBeforePhase: phase } : { failAfterPhase: phase }), (error) => error instanceof SessionLifecycleError && error.code === 'FINALIZATION_INTERRUPTED');
        const restarted = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
        const recovered = await restarted.recover(sessionId);
        assert.equal(recovered.state, 'closed', `${phase}/${edge}`);
        assert.equal(recovered.finalization_phase, 'released', `${phase}/${edge}`);
        assert.equal((await restarted.storage.readHistory(sessionId, 'transcript')).length, 1, `${phase}/${edge}`);
        assert.deepEqual(await restarted.close(close), recovered, `${phase}/${edge}`);
      });
    }
  }
});

test('durable transcript history remains addressable after active-memory eviction', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'eviction-session';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }), activeCacheLimit: 8 });
    await lifecycle.record(command('record-1', sessionId));
    for (let revision = 0; revision < 40; revision += 1) await lifecycle.acceptTranscriptRevision(sessionId, segment(sessionId, revision));
    const stats = lifecycle.memoryStats();
    assert.ok(stats.transcript_cache_entries <= 8);
    assert.equal((await lifecycle.resolveTranscriptRevision(sessionId, `${sessionId}-segment-0`, 0)).text, 'Transcript revision 0.');
    assert.equal((await new SessionStorage({ root: directory }).readHistory(sessionId, 'transcript')).length, 40);
    const close = await lifecycle.close(command('close-1', sessionId));
    assert.equal(close.transcript_history_count, 40);
    assert.equal(lifecycle.memoryStats().transcript_cache_entries, 0);
  });
});

test('session controller and locator persist across process restart with isolated temporary storage', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'process-session';
    const record = createEnvelope({ plane: 'control', messageType: 'session.record', producer: 'phase6-test', correlationId: sessionId, idempotencyKey: 'record-1', schemaVersion: '1.2.0', payload: command('record-1', sessionId) });
    const recorded = await runService(manifest('session-lifecycle-controller'), [record], 2, 5000, { env: { ARGUS_SESSION_ROOT: directory } });
    assert.ok(recorded.outputs.some((message) => message.message_type === 'session.recorded'));
    const locate = createEnvelope({ plane: 'control', messageType: 'session.folder-locate', producer: 'phase6-test', correlationId: sessionId, idempotencyKey: 'locate-1', schemaVersion: '1.2.0', payload: command('locate-1', sessionId) });
    const located = await runService(manifest('session-folder-locator'), [locate], 2, 5000, { env: { ARGUS_SESSION_ROOT: directory } });
    const folders = located.outputs.find((message) => message.message_type === 'session.folder-located').payload;
    assert.ok(folders.active_path.startsWith(directory));
    const close = createEnvelope({ plane: 'control', messageType: 'session.close', producer: 'phase6-test', correlationId: sessionId, idempotencyKey: 'close-1', schemaVersion: '1.2.0', payload: command('close-1', sessionId) });
    const closed = await runService(manifest('session-lifecycle-controller'), [close], 2, 5000, { env: { ARGUS_SESSION_ROOT: directory } });
    const outcome = closed.outputs.find((message) => message.message_type === 'session.closed').payload;
    assert.equal(outcome.state, 'closed');
    const evidence = JSON.parse(await readFile(path.join(directory, sessionId, 'permanent', 'close.evidence.json'), 'utf8'));
    assert.equal(evidence.integrity, 'verified');
  });
});
