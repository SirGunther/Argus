import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
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
function storedSegment(sessionId, sequence, revision, text) { return { segment_id: `${sessionId}-segment-${sequence}`, session_id: sessionId, sequence, revision, revision_id: `${sessionId}-segment-${sequence}-r${revision}`, start_time: `00:00:${String(sequence).padStart(2, '0')}.000`, end_time: `00:00:${String(sequence + 1).padStart(2, '0')}.000`, text, original_stt_text: text.replace(/[.?!]$/, ''), boundary: 'pause', word_provenance: [{ word_id: `${sessionId}-stored-word-${sequence}`, source_text: 'Stored', rendered_text: 'Stored', source_sequence: sequence, source_audio_window_id: `${sessionId}-window-${sequence}`, source_chunk_ids: [`${sessionId}-chunk-${sequence}`] }], audio_windows: [{ audio_window_id: `${sessionId}-window-${sequence}`, first_chunk_id: `${sessionId}-chunk-${sequence}`, last_chunk_id: `${sessionId}-chunk-${sequence}`, first_sequence: sequence, last_sequence: sequence, chunk_count: 1, start_time: `00:00:${String(sequence).padStart(2, '0')}.000`, end_time: `00:00:${String(sequence + 1).padStart(2, '0')}.000` }], formatting: { source: 'contextual-language', provisional_until_finalized: true }, review_flags: [], stored_at: `2026-08-19T00:00:${String(sequence).padStart(2, '0')}.000Z` }; }
function item(sessionId, revision) { return { item_id: `${sessionId}-item-0`, session_id: sessionId, revision, revision_id: `${sessionId}-item-0:r${revision}`, text: `Logged item ${revision}.`, source: { first_segment_id: `${sessionId}-segment-0`, last_segment_id: `${sessionId}-segment-0`, start_time: '0', end_time: '1' }, generator: { implementation: 'phase6-test', input_window_id: 'window-0' }, stored_at: `2026-08-19T00:00:${String(revision).padStart(2, '0')}.000Z` }; }
function legacyRepeatedSegment(sessionId, sequence = 0) {
  const chunkIds = Array.from({ length: 103 }, (_, index) => `${sessionId}-chunk-${index + 45}`);
  return {
    segment_id: `${sessionId}-segment-${sequence}`, session_id: sessionId, sequence, revision: 0,
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

test('close automatically resumes a valid unacknowledged corrected outbox revision', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'corrected-outbox-close';
    const storage = new SessionStorage({ root: directory });
    const lifecycle = new SessionLifecycle({ storage });
    await lifecycle.record(command('record-1', sessionId));
    const pending = storedSegment(sessionId, 0, 0, 'Safe pending transcript.');
    await storage.writeTranscriptOutbox(sessionId, { schema_version: '1.0.0', session_id: sessionId, saved_at: pending.stored_at, pending: [{ revision_id: pending.revision_id, segment: pending, emit_segment: true }] });

    const closed = await lifecycle.close(command('close-1', sessionId));
    assert.equal(closed.state, 'closed');
    assert.deepEqual((await storage.readActiveSnapshot(sessionId, 'transcript')).segments, [pending]);
    assert.deepEqual((await storage.readTranscriptOutbox(sessionId)).pending, []);
    assert.deepEqual((await storage.readHistory(sessionId, 'transcript')).map((entry) => entry.history_entry_id), [pending.revision_id]);
  });
});

test('close does not implicitly append an active-only missing revision', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'active-only-gap';
    const storage = new SessionStorage({ root: directory });
    const lifecycle = new SessionLifecycle({ storage });
    await lifecycle.record(command('record-1', sessionId));
    const active = storedSegment(sessionId, 0, 0, 'Active-only transcript.');
    await storage.writeActiveSnapshot(sessionId, 'transcript', { schema_version: '1.0.0', session_id: sessionId, saved_at: active.stored_at, segments: [active] });
    await assert.rejects(() => lifecycle.close(command('close-1', sessionId)), (error) => error.code === 'RECOVERY_APPLY_REQUIRED');
    assert.equal((await storage.readHistory(sessionId, 'transcript')).length, 0);
    const recovered = await lifecycle.recoverSession(sessionId, { apply: true });
    assert.equal(recovered.state_after, 'closed');
    assert.deepEqual((await storage.readHistory(sessionId, 'transcript')).map((entry) => entry.history_entry_id), [active.revision_id]);
  });
});

test('explicit recovery compacts a legacy repeated-provenance segment before durable history append', async () => {
  await withRoot(async (directory) => {
    const storage = new SessionStorage({ root: directory });
    const sessionId = 'legacy-provenance-recovery';
    const lifecycle = new SessionLifecycle({ storage });
    await lifecycle.record(command('record-1', sessionId));
    const legacy = legacyRepeatedSegment(sessionId);
    await storage.writeActiveSnapshot(sessionId, 'transcript', { schema_version: '1.0.0', session_id: sessionId, saved_at: legacy.stored_at, segments: [legacy] });

    await assert.rejects(() => lifecycle.close(command('close-1', sessionId)), (error) => error.code === 'LEGACY_RECOVERY_APPLY_REQUIRED');
    const beforeDryRun = await readFile(storage.paths(sessionId).transcriptActive, 'utf8');
    const dryRun = await lifecycle.recoverSession(sessionId, { dryRun: true });
    assert.deepEqual(dryRun.recovered, [`${sessionId}-segment-0-r0`]);
    assert.deepEqual(dryRun.already_present, []);
    assert.deepEqual(dryRun.rejected, []);
    assert.equal(dryRun.backup_path, null);
    assert.equal(await readFile(storage.paths(sessionId).transcriptActive, 'utf8'), beforeDryRun);

    const closed = await lifecycle.recoverSession(sessionId, { apply: true });
    assert.equal(closed.state_after, 'closed');
    assert.equal(closed.finalization.completed, true);
    assert.ok(closed.backup_path);
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
    assert.deepEqual(active.word_provenance.map((word) => [word.word_id, word.source_text, word.rendered_text, word.source_sequence, word.source_audio_window_id]), legacy.word_provenance.map((word) => [word.word_id, word.source_text, word.rendered_text, word.source_sequence, word.source_audio_window_id]));
    assert.equal((await storage.readHistory(sessionId, 'transcript')).length, 1);

    const replay = await lifecycle.recoverSession(sessionId, { apply: true });
    assert.deepEqual(replay.recovered, []);
    assert.deepEqual(replay.already_present, [`${sessionId}-segment-0-r0`]);
    assert.equal(replay.backup_path, null);
    assert.equal((await storage.readHistory(sessionId, 'transcript')).length, 1);
  });
});

test('copied affected-session fixture reports active gaps and resumes acknowledged or unacknowledged corrected commits deterministically', async () => {
  const sessionId = 'session-922dc897-804b-4c0b-be5a-6357ff4496c6';
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'argus-copied-incident-'));
  const sourceRoot = path.join(scratch, 'source');
  const copiedRoot = path.join(scratch, 'copied');
  try {
    const sourceStorage = new SessionStorage({ root: sourceRoot });
    const sourceLifecycle = new SessionLifecycle({ storage: sourceStorage });
    await sourceLifecycle.record(command('record-1', sessionId));
    const first = storedSegment(sessionId, 0, 0, 'First authoritative segment.');
    const second = storedSegment(sessionId, 1, 0, 'Second authoritative segment.');
    const legacy = legacyRepeatedSegment(sessionId, 2);
    await sourceStorage.writeActiveSnapshot(sessionId, 'transcript', { schema_version: '1.0.0', session_id: sessionId, saved_at: legacy.stored_at, segments: [first, second, legacy] });
    for (const item of [first, second]) await sourceStorage.appendHistory(sessionId, 'transcript', { historyEntryId: `${item.segment_id}-r${item.revision}`, revision: item.revision, record: item, appendedAt: item.stored_at });
    await assert.rejects(() => sourceLifecycle.close(command('close-incident', sessionId)), (error) => error.code === 'LEGACY_RECOVERY_APPLY_REQUIRED');
    const sourceBefore = await readFile(sourceStorage.paths(sessionId).transcriptActive, 'utf8');
    await cp(path.join(sourceRoot, sessionId), path.join(copiedRoot, sessionId), { recursive: true });

    const copiedStorage = new SessionStorage({ root: copiedRoot });
    const copiedLifecycle = new SessionLifecycle({ storage: copiedStorage });
    const dryRun = await copiedLifecycle.recoverSession(sessionId, { dryRun: true });
    assert.deepEqual(dryRun.active_revisions_missing_history, [`${sessionId}-segment-2-r0`]);
    assert.deepEqual(dryRun.recovered, [`${sessionId}-segment-2-r0`]);
    assert.deepEqual(dryRun.already_present, [`${sessionId}-segment-0-r0`, `${sessionId}-segment-1-r0`]);
    assert.deepEqual(dryRun.rejected, []);
    assert.equal(dryRun.state_after, 'closing');
    assert.equal(await readFile(copiedStorage.paths(sessionId).transcriptActive, 'utf8'), sourceBefore);

    const applied = await copiedLifecycle.recoverSession(sessionId, { apply: true });
    assert.equal(applied.state_after, 'closed');
    assert.equal(applied.finalization.completed, true);
    assert.ok(applied.backup_path);
    assert.equal((await copiedStorage.readHistory(sessionId, 'transcript')).length, 3);
    assert.equal((await copiedStorage.readActiveSnapshot(sessionId, 'transcript')).segments.length, 3);
    assert.equal((await copiedStorage.readActiveSnapshot(sessionId, 'transcript')).segments[2].word_provenance.length, 30);
    assert.equal((await copiedStorage.readTranscriptOutbox(sessionId)).pending.length, 0);
    assert.ok(await readFile(path.join(applied.backup_path, 'transcript.json'), 'utf8'));
    assert.ok(await readFile(path.join(applied.backup_path, 'session.json'), 'utf8'));

    const replay = await copiedLifecycle.recoverSession(sessionId, { apply: true });
    assert.deepEqual(replay.recovered, []);
    assert.deepEqual(replay.already_present, [`${sessionId}-segment-0-r0`, `${sessionId}-segment-1-r0`, `${sessionId}-segment-2-r0`]);
    assert.equal(replay.backup_path, null);
    assert.equal((await copiedStorage.readHistory(sessionId, 'transcript')).length, 3);
    assert.equal(await readFile(sourceStorage.paths(sessionId).transcriptActive, 'utf8'), sourceBefore);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('recovery applies only governed corrected pending commits and preserves rejected evidence', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'pending-recovery-session';
    const storage = new SessionStorage({ root: directory });
    const lifecycle = new SessionLifecycle({ storage });
    await lifecycle.record(command('record-1', sessionId));
    const acknowledged = storedSegment(sessionId, 0, 0, 'Acknowledged pending segment.');
    const unacknowledged = storedSegment(sessionId, 1, 0, 'Unacknowledged pending segment.');
    const rejected = { ...storedSegment(sessionId, 2, 0, 'Rejected pending segment.'), word_provenance: Array.from({ length: 30 }, (_, index) => ({ word_id: `${sessionId}-bad-word-${index}`, source_text: 'bad', rendered_text: 'bad', source_sequence: index, source_chunk_ids: Array.from({ length: 121 }, (_, chunkIndex) => `${sessionId}-chunk-${chunkIndex}`), source_audio_window_id: `${sessionId}-window-bad` })) };
    await storage.appendHistory(sessionId, 'transcript', { historyEntryId: `${acknowledged.segment_id}-r0`, revision: 0, record: acknowledged, appendedAt: acknowledged.stored_at });
    await storage.writeTranscriptOutbox(sessionId, { schema_version: '1.0.0', session_id: sessionId, saved_at: acknowledged.stored_at, pending: [
      { revision_id: `${acknowledged.segment_id}-r0`, segment: acknowledged, emit_segment: true },
      { revision_id: `${unacknowledged.segment_id}-r0`, segment: unacknowledged, emit_segment: true },
      { revision_id: `${rejected.segment_id}-r0`, segment: rejected, emit_segment: true }
    ] });

    const dryRun = await lifecycle.recoverSession(sessionId, { dryRun: true });
    assert.deepEqual(dryRun.pending_acknowledged, [`${acknowledged.segment_id}-r0`]);
    assert.deepEqual(dryRun.pending_unacknowledged, [`${unacknowledged.segment_id}-r0`, `${rejected.segment_id}-r0`]);
    assert.deepEqual(dryRun.recovered, [`${acknowledged.segment_id}-r0`, `${unacknowledged.segment_id}-r0`]);
    assert.deepEqual(dryRun.rejected, [`${rejected.segment_id}-r0`]);
    assert.equal((await storage.readHistory(sessionId, 'transcript')).length, 1);

    const applied = await lifecycle.recoverSession(sessionId, { apply: true });
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.recovered, [`${acknowledged.segment_id}-r0`, `${unacknowledged.segment_id}-r0`]);
    assert.deepEqual(applied.rejected, [`${rejected.segment_id}-r0`]);
    assert.equal((await storage.readHistory(sessionId, 'transcript')).length, 2);
    assert.deepEqual((await storage.readTranscriptOutbox(sessionId)).pending.map((entry) => entry.revision_id), [`${rejected.segment_id}-r0`]);
    assert.deepEqual((await storage.readActiveSnapshot(sessionId, 'transcript')).segments.map((segment) => segment.segment_id), [acknowledged.segment_id, unacknowledged.segment_id]);
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
