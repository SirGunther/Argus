import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
function scribeBatchIdentity(sessionId, requestId, { segments, admissionReason = 'batch-complete' } = {}) {
  const segs = segments || [{ segment_id: `${sessionId}-segment-0`, revision: 0, sequence: 0 }];
  return {
    request_id: requestId,
    session_id: sessionId,
    segments: segs,
    first_sequence: segs[0].sequence,
    last_sequence: segs.at(-1).sequence,
    admission_reason: admissionReason,
    policy_id: 'default-scribe-policy',
    policy_version: '1.0.0',
    instruction_version: '1.0.0'
  };
}
function scribeBatchEvaluated(sessionId, requestId, { attempt = 1, outcome = 'items-recorded', items, loggedItemIds, accepted = true, evaluatedAt = '2026-08-19T00:10:00.000Z', ackId, error, segments } = {}) {
  const resolvedItems = items !== undefined ? items : (outcome === 'items-recorded' ? [{ text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: [`${sessionId}-segment-0`] }] : []);
  const resolvedIds = loggedItemIds !== undefined ? loggedItemIds : (outcome === 'items-recorded' && accepted ? resolvedItems.map((_, index) => `${sessionId}-logged-item-${requestId}-${index}`) : []);
  return {
    batch_identity: scribeBatchIdentity(sessionId, requestId, { segments }),
    evaluated_at: evaluatedAt,
    attempt,
    outcome,
    items: resolvedItems,
    ...(outcome === 'failed' ? { error: error || { code: 'MODEL_ENDPOINT_TIMEOUT', category: 'timeout', message: 'The local model endpoint did not respond in time.', retryable: true } } : {}),
    acknowledgement: {
      ack_id: ackId || `ack-${requestId}-${attempt}`,
      accepted,
      acknowledged_at: accepted ? evaluatedAt : null,
      logged_item_ids: resolvedIds
    }
  };
}
function scribeCheckpoint(sessionId, overrides = {}) {
  return {
    schema_version: '1.0.0',
    session_id: sessionId,
    saved_at: '2026-08-19T00:00:00.000Z',
    admitted_through: { last_segment_id: null, last_sequence: -1, last_revision: 0 },
    pending_partial: { segments: [], accumulated_since: null },
    background_context: { prior_logged_items: [] },
    policy_id: 'default-scribe-policy',
    policy_version: '1.0.0',
    ...overrides
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
    const first = legacyRepeatedSegment(sessionId, 0);
    const second = legacyRepeatedSegment(sessionId, 1);
    const legacy = legacyRepeatedSegment(sessionId, 2);
    await sourceStorage.writeActiveSnapshot(sessionId, 'transcript', { schema_version: '1.0.0', session_id: sessionId, saved_at: legacy.stored_at, segments: [first, second, legacy] });
    for (const item of [first, second]) await sourceStorage.appendHistory(sessionId, 'transcript', { historyEntryId: `${item.segment_id}-r${item.revision}`, revision: item.revision, record: item, appendedAt: item.stored_at });
    await assert.rejects(() => sourceLifecycle.close(command('close-incident', sessionId)), (error) => error.code === 'LEGACY_RECOVERY_APPLY_REQUIRED');
    const sourceBefore = await readFile(sourceStorage.paths(sessionId).transcriptActive, 'utf8');
    const historyBefore = await sourceStorage.readHistory(sessionId, 'transcript');
    await cp(path.join(sourceRoot, sessionId), path.join(copiedRoot, sessionId), { recursive: true });

    const copiedStorage = new SessionStorage({ root: copiedRoot });
    const copiedLifecycle = new SessionLifecycle({ storage: copiedStorage });
    const dryRun = await copiedLifecycle.recoverSession(sessionId, { dryRun: true });
    assert.deepEqual(dryRun.active_revisions_missing_history, [`${sessionId}-segment-2-r0`]);
    assert.deepEqual(dryRun.recovered, [`${sessionId}-segment-2-r0`]);
    assert.deepEqual(dryRun.already_present, [`${sessionId}-segment-0-r0`, `${sessionId}-segment-1-r0`]);
    assert.deepEqual(dryRun.rejected, []);
    assert.equal(dryRun.finalization.eligible, true);
    assert.equal(dryRun.state_after, 'closing');
    assert.equal(await readFile(copiedStorage.paths(sessionId).transcriptActive, 'utf8'), sourceBefore);

    const applied = await copiedLifecycle.recoverSession(sessionId, { apply: true });
    assert.equal(applied.state_after, 'closed');
    assert.equal(applied.finalization.completed, true);
    assert.deepEqual(applied.recovered, [`${sessionId}-segment-2-r0`]);
    assert.ok(applied.backup_path);
    const historyAfter = await copiedStorage.readHistory(sessionId, 'transcript');
    const activeAfter = (await copiedStorage.readActiveSnapshot(sessionId, 'transcript')).segments;
    assert.equal(historyAfter.length, 3);
    assert.deepEqual(historyAfter.slice(0, 2), historyBefore);
    assert.equal(activeAfter.length, 3);
    assert.deepEqual(activeAfter.slice(0, 2), [first, second]);
    assert.equal(activeAfter[0].audio_windows, undefined);
    assert.equal(activeAfter[1].audio_windows, undefined);
    assert.equal(activeAfter[2].word_provenance.length, 30);
    assert.equal(activeAfter[2].audio_windows.length, 1);
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

test('recovery rejects a genuine active and permanent-history fingerprint mismatch', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'recovery-history-conflict';
    const storage = new SessionStorage({ root: directory });
    const lifecycle = new SessionLifecycle({ storage });
    await lifecycle.record(command('record-1', sessionId));
    const active = storedSegment(sessionId, 0, 0, 'Active evidence.');
    const authoritative = { ...active, text: 'Different authoritative evidence.' };
    await storage.writeActiveSnapshot(sessionId, 'transcript', { schema_version: '1.0.0', session_id: sessionId, saved_at: active.stored_at, segments: [active] });
    await storage.appendHistory(sessionId, 'transcript', { historyEntryId: active.revision_id, revision: active.revision, record: authoritative, appendedAt: authoritative.stored_at });

    const dryRun = await lifecycle.recoverSession(sessionId, { dryRun: true });
    assert.deepEqual(dryRun.recovered, []);
    assert.deepEqual(dryRun.already_present, []);
    assert.deepEqual(dryRun.rejected, [active.revision_id]);
    assert.equal(dryRun.rejection_details[active.revision_id].code, 'AUTHORITATIVE_HISTORY_CONFLICT');
    assert.equal(dryRun.finalization.eligible, false);
  });
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

test('Scribe checkpoint and batch journal start absent for a newly recorded session', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-initial-state';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));
    assert.equal(await lifecycle.getScribeCheckpoint(sessionId), undefined);
    assert.deepEqual(await lifecycle.getScribeBatchJournal(sessionId), []);
  });
});

test('Scribe checkpoint accepts atomically and advances the acknowledged cursor, rejecting regression', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-checkpoint-advance';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));

    const first = scribeCheckpoint(sessionId, { admitted_through: { last_segment_id: `${sessionId}-segment-0`, last_sequence: 0, last_revision: 0 } });
    await lifecycle.acceptScribeCheckpoint(sessionId, first, { savedAt: '2026-08-19T00:01:00.000Z' });
    assert.deepEqual(await lifecycle.getScribeCheckpoint(sessionId), { ...first, saved_at: '2026-08-19T00:01:00.000Z' });

    const second = scribeCheckpoint(sessionId, { admitted_through: { last_segment_id: `${sessionId}-segment-2`, last_sequence: 2, last_revision: 0 } });
    await lifecycle.acceptScribeCheckpoint(sessionId, second, { savedAt: '2026-08-19T00:02:00.000Z' });
    assert.deepEqual(await lifecycle.getScribeCheckpoint(sessionId), { ...second, saved_at: '2026-08-19T00:02:00.000Z' });

    const regressed = scribeCheckpoint(sessionId, { admitted_through: { last_segment_id: `${sessionId}-segment-1`, last_sequence: 1, last_revision: 0 } });
    await assert.rejects(() => lifecycle.acceptScribeCheckpoint(sessionId, regressed), (error) => error.code === 'SCRIBE_CURSOR_REGRESSION');
    assert.deepEqual((await lifecycle.getScribeCheckpoint(sessionId)).admitted_through, second.admitted_through);
  });
});

test('Scribe checkpoint rejects an invalid in-flight replacement and a batch dropped without recording its outcome', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-invalid-advancement';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));

    const firstInFlight = { batch_identity: scribeBatchIdentity(sessionId, 'batch-a'), attempt: 1, dispatched_at: '2026-08-19T00:07:00.000Z' };
    await lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId, { in_flight_batch: firstInFlight }));

    const conflictingInFlight = { batch_identity: scribeBatchIdentity(sessionId, 'batch-b'), attempt: 1, dispatched_at: '2026-08-19T00:07:30.000Z' };
    await assert.rejects(() => lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId, { in_flight_batch: conflictingInFlight })), (error) => error.code === 'SCRIBE_IN_FLIGHT_BATCH_CONFLICT');

    await assert.rejects(() => lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId)), (error) => error.code === 'SCRIBE_UNACKNOWLEDGED_BATCH_DROPPED');

    const retried = { batch_identity: scribeBatchIdentity(sessionId, 'batch-a'), attempt: 2, dispatched_at: '2026-08-19T00:08:00.000Z' };
    await lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId, { in_flight_batch: retried }));
    assert.deepEqual((await lifecycle.getScribeCheckpoint(sessionId)).in_flight_batch, retried);
  });
});

test('Scribe checkpoint rejects a same-request_id retry whose batch_identity content was mutated', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-retry-identity-mutation';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));

    const original = { batch_identity: scribeBatchIdentity(sessionId, 'batch-retry'), attempt: 1, dispatched_at: '2026-08-19T00:09:00.000Z' };
    await lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId, { in_flight_batch: original }));

    const differentSegments = {
      batch_identity: scribeBatchIdentity(sessionId, 'batch-retry', { segments: [{ segment_id: `${sessionId}-segment-9`, revision: 0, sequence: 9 }] }),
      attempt: 2,
      dispatched_at: '2026-08-19T00:09:30.000Z'
    };
    await assert.rejects(() => lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId, { in_flight_batch: differentSegments })), (error) => error.code === 'SCRIBE_IN_FLIGHT_BATCH_IDENTITY_CONFLICT');

    const differentPolicyVersion = {
      batch_identity: { ...scribeBatchIdentity(sessionId, 'batch-retry'), policy_version: '2.0.0' },
      attempt: 2,
      dispatched_at: '2026-08-19T00:09:30.000Z'
    };
    await assert.rejects(() => lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId, { in_flight_batch: differentPolicyVersion })), (error) => error.code === 'SCRIBE_IN_FLIGHT_BATCH_IDENTITY_CONFLICT');

    assert.deepEqual((await lifecycle.getScribeCheckpoint(sessionId)).in_flight_batch, original);

    const identicalRetry = { batch_identity: scribeBatchIdentity(sessionId, 'batch-retry'), attempt: 2, dispatched_at: '2026-08-19T00:09:45.000Z' };
    await lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId, { in_flight_batch: identicalRetry }));
    assert.deepEqual((await lifecycle.getScribeCheckpoint(sessionId)).in_flight_batch, identicalRetry);
  });
});

test('Scribe batch identity rejects duplicate segment_ids, reordered/gapped sequences, and mismatched first/last_sequence bounds', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-identity-ordering';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));

    const duplicateSegmentId = scribeBatchEvaluated(sessionId, 'batch-duplicate', {
      segments: [{ segment_id: `${sessionId}-segment-0`, revision: 0, sequence: 0 }, { segment_id: `${sessionId}-segment-0`, revision: 0, sequence: 1 }],
      items: [{ text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: [`${sessionId}-segment-0`] }],
      loggedItemIds: [`${sessionId}-logged-item-0`]
    });
    await assert.rejects(() => lifecycle.recordScribeBatchOutcome(sessionId, duplicateSegmentId), (error) => error.code === 'SCRIBE_BATCH_IDENTITY_INVALID');

    const reordered = scribeBatchEvaluated(sessionId, 'batch-reordered', {
      segments: [{ segment_id: `${sessionId}-segment-1`, revision: 0, sequence: 1 }, { segment_id: `${sessionId}-segment-0`, revision: 0, sequence: 0 }],
      items: [{ text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: [`${sessionId}-segment-0`] }],
      loggedItemIds: [`${sessionId}-logged-item-0`]
    });
    await assert.rejects(() => lifecycle.recordScribeBatchOutcome(sessionId, reordered), (error) => error.code === 'SCRIBE_BATCH_IDENTITY_INVALID');

    const gapped = scribeBatchEvaluated(sessionId, 'batch-gapped', {
      segments: [{ segment_id: `${sessionId}-segment-0`, revision: 0, sequence: 0 }, { segment_id: `${sessionId}-segment-2`, revision: 0, sequence: 2 }],
      items: [{ text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: [`${sessionId}-segment-0`] }],
      loggedItemIds: [`${sessionId}-logged-item-0`]
    });
    await assert.rejects(() => lifecycle.recordScribeBatchOutcome(sessionId, gapped), (error) => error.code === 'SCRIBE_BATCH_IDENTITY_INVALID');

    const validSegments = [{ segment_id: `${sessionId}-segment-0`, revision: 0, sequence: 0 }, { segment_id: `${sessionId}-segment-1`, revision: 0, sequence: 1 }];
    const badBounds = scribeBatchEvaluated(sessionId, 'batch-bad-bounds', {
      segments: validSegments,
      items: [{ text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: [`${sessionId}-segment-0`] }],
      loggedItemIds: [`${sessionId}-logged-item-0`]
    });
    badBounds.batch_identity.last_sequence = 5;
    await assert.rejects(() => lifecycle.recordScribeBatchOutcome(sessionId, badBounds), (error) => error.code === 'SCRIBE_BATCH_IDENTITY_INVALID');

    assert.deepEqual(await lifecycle.getScribeBatchJournal(sessionId), []);
  });
});

test('Scribe checkpoint rejects a structurally malformed shape', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-malformed';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));
    const malformed = scribeCheckpoint(sessionId);
    delete malformed.admitted_through;
    await assert.rejects(() => lifecycle.acceptScribeCheckpoint(sessionId, malformed), (error) => error.code === 'SCRIBE_CHECKPOINT_INVALID');
  });
});

test('Scribe checkpoint pending_partial rejects a sequence behind the cursor and an ungoverned segments/accumulated_since correlation', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-pending-cross-checks';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));

    const behindCursor = scribeCheckpoint(sessionId, {
      admitted_through: { last_segment_id: `${sessionId}-segment-2`, last_sequence: 2, last_revision: 0 },
      pending_partial: { segments: [{ segment_id: `${sessionId}-segment-1`, revision: 0, sequence: 1 }], accumulated_since: '2026-08-19T00:01:00.000Z' }
    });
    await assert.rejects(() => lifecycle.acceptScribeCheckpoint(sessionId, behindCursor), (error) => error.code === 'SCRIBE_CHECKPOINT_INVALID');

    const missingAccumulatedSince = scribeCheckpoint(sessionId, {
      pending_partial: { segments: [{ segment_id: `${sessionId}-segment-0`, revision: 0, sequence: 0 }], accumulated_since: null }
    });
    await assert.rejects(() => lifecycle.acceptScribeCheckpoint(sessionId, missingAccumulatedSince), (error) => error.code === 'SCRIBE_CHECKPOINT_INVALID');

    const strandedAccumulatedSince = scribeCheckpoint(sessionId, {
      pending_partial: { segments: [], accumulated_since: '2026-08-19T00:01:00.000Z' }
    });
    await assert.rejects(() => lifecycle.acceptScribeCheckpoint(sessionId, strandedAccumulatedSince), (error) => error.code === 'SCRIBE_CHECKPOINT_INVALID');

    const governed = scribeCheckpoint(sessionId, {
      pending_partial: { segments: [{ segment_id: `${sessionId}-segment-0`, revision: 0, sequence: 0 }], accumulated_since: '2026-08-19T00:01:00.000Z' }
    });
    await lifecycle.acceptScribeCheckpoint(sessionId, governed);
    assert.deepEqual((await lifecycle.getScribeCheckpoint(sessionId)).pending_partial, governed.pending_partial);
  });
});

test('Scribe checkpoint background_context.prior_logged_items is bounded', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-background-items-bound';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));

    const priorLoggedItem = (index) => ({ text: `Duplicate-suppression item ${index}.`, kind: 'other', source_segment_ids: [`${sessionId}-segment-${index}`] });
    const atMax = scribeCheckpoint(sessionId, { background_context: { prior_logged_items: Array.from({ length: 64 }, (_, index) => priorLoggedItem(index)) } });
    await lifecycle.acceptScribeCheckpoint(sessionId, atMax);
    assert.equal((await lifecycle.getScribeCheckpoint(sessionId)).background_context.prior_logged_items.length, 64);

    const overMax = scribeCheckpoint(sessionId, { background_context: { prior_logged_items: Array.from({ length: 65 }, (_, index) => priorLoggedItem(index)) } });
    await assert.rejects(() => lifecycle.acceptScribeCheckpoint(sessionId, overMax), (error) => error.code === 'SCRIBE_CHECKPOINT_INVALID');
  });
});

test('Scribe checkpoint and batch outcome reject another session\'s data', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-session-a';
    const otherSessionId = 'scribe-session-b';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));

    await assert.rejects(() => lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(otherSessionId)), (error) => error.code === 'SCRIBE_CHECKPOINT_SESSION_CONFLICT');
    await assert.rejects(() => lifecycle.recordScribeBatchOutcome(sessionId, scribeBatchEvaluated(otherSessionId, 'batch-x')), (error) => error.code === 'SCRIBE_BATCH_SESSION_CONFLICT');
  });
});

test('Scribe batch journal appends are idempotent by stable batch/attempt identity and replay-safe', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-journal-idempotent';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));

    const batch = scribeBatchEvaluated(sessionId, 'batch-1');
    const first = await lifecycle.recordScribeBatchOutcome(sessionId, batch);
    assert.equal(first.duplicate, false);
    assert.equal(first.entry.journal_sequence, 0);

    const replay = await lifecycle.recordScribeBatchOutcome(sessionId, batch);
    assert.equal(replay.duplicate, true);
    assert.deepEqual(replay.entry, first.entry);
    assert.equal((await lifecycle.getScribeBatchJournal(sessionId)).length, 1);
  });
});

test('Scribe batch journal appends serialize per session, so concurrent identical-content calls settle to exactly one entry', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-journal-concurrent-identical';
    const storage = new SessionStorage({ root: directory });
    const lifecycle = new SessionLifecycle({ storage });
    await lifecycle.record(command('record-1', sessionId));

    const batch = scribeBatchEvaluated(sessionId, 'batch-concurrent');
    const results = await Promise.all(Array.from({ length: 8 }, () => lifecycle.recordScribeBatchOutcome(sessionId, batch)));

    assert.equal(results.filter((result) => result.duplicate === false).length, 1);
    assert.equal(results.filter((result) => result.duplicate === true).length, 7);
    for (const result of results) assert.equal(result.entry.journal_sequence, 0);

    const journal = await storage.readScribeBatchJournal(sessionId);
    assert.equal(journal.length, 1);
    assert.deepEqual(journal.map((entry) => entry.journal_sequence), [0]);
  });
});

test('Scribe batch journal appends serialize per session, so concurrent distinct-content calls all land with contiguous sequences', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-journal-concurrent-distinct';
    const storage = new SessionStorage({ root: directory });
    const lifecycle = new SessionLifecycle({ storage });
    await lifecycle.record(command('record-1', sessionId));

    const batches = Array.from({ length: 8 }, (_, index) => scribeBatchEvaluated(sessionId, `batch-concurrent-${index}`, {
      segments: [{ segment_id: `${sessionId}-segment-${index}`, revision: 0, sequence: index }],
      items: [{ text: `Item ${index}.`, kind: 'decision', source_segment_ids: [`${sessionId}-segment-${index}`] }],
      loggedItemIds: [`${sessionId}-logged-item-${index}`]
    }));
    const results = await Promise.all(batches.map((batch) => lifecycle.recordScribeBatchOutcome(sessionId, batch)));

    assert.equal(results.every((result) => result.duplicate === false), true);
    assert.deepEqual(results.map((result) => result.entry.journal_sequence).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);

    const journal = await storage.readScribeBatchJournal(sessionId);
    assert.equal(journal.length, 8);
    assert.deepEqual(journal.map((entry) => entry.journal_sequence), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(new Set(journal.map((entry) => entry.batch.batch_identity.request_id)).size, 8);
  });
});

test('Scribe batch journal rejects a conflicting replay and a reused acknowledgement identity', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-journal-conflict';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));

    const batch = scribeBatchEvaluated(sessionId, 'batch-1');
    await lifecycle.recordScribeBatchOutcome(sessionId, batch);

    const conflicting = scribeBatchEvaluated(sessionId, 'batch-1', { items: [{ text: 'Different item.', source_segment_ids: [`${sessionId}-segment-0`] }], loggedItemIds: [`${sessionId}-logged-item-batch-1-different`] });
    await assert.rejects(() => lifecycle.recordScribeBatchOutcome(sessionId, conflicting), (error) => error.code === 'SCRIBE_JOURNAL_REPLAY_CONFLICT');

    const reusedAck = scribeBatchEvaluated(sessionId, 'batch-2', { ackId: batch.acknowledgement.ack_id });
    await assert.rejects(() => lifecycle.recordScribeBatchOutcome(sessionId, reusedAck), (error) => error.code === 'SCRIBE_JOURNAL_ACK_ID_CONFLICT');

    assert.equal((await lifecycle.getScribeBatchJournal(sessionId)).length, 1);
  });
});

test('Scribe batch journal accepts a governed zero-item outcome', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-zero-item-outcome';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));
    const batch = scribeBatchEvaluated(sessionId, 'batch-empty', { outcome: 'empty-evaluated', items: [], loggedItemIds: [] });
    const result = await lifecycle.recordScribeBatchOutcome(sessionId, batch);
    assert.equal(result.duplicate, false);
    assert.deepEqual(result.entry.batch.items, []);
    assert.deepEqual(result.entry.batch.acknowledgement.logged_item_ids, []);
  });
});

test('Scribe batch outcome rejects an item citing a source_segment_id outside the batch\'s own evidence', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-out-of-batch-provenance';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));

    const fabricated = scribeBatchEvaluated(sessionId, 'batch-fabricated-provenance', {
      items: [{ text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: [`${sessionId}-segment-99`] }],
      loggedItemIds: [`${sessionId}-logged-item-0`]
    });
    await assert.rejects(() => lifecycle.recordScribeBatchOutcome(sessionId, fabricated), (error) => error.code === 'SCRIBE_ITEM_SOURCE_OUT_OF_BATCH');
    assert.deepEqual(await lifecycle.getScribeBatchJournal(sessionId), []);
  });
});

test('Scribe acknowledgement must correspond one-for-one with the recorded items', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-multi-item-ack';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));

    const segments = [{ segment_id: `${sessionId}-segment-0`, revision: 0, sequence: 0 }, { segment_id: `${sessionId}-segment-1`, revision: 0, sequence: 1 }];
    const items = [
      { text: 'Ship the draft Friday.', kind: 'decision', source_segment_ids: [`${sessionId}-segment-0`] },
      { text: 'Confirm the reviewer.', kind: 'open-question', source_segment_ids: [`${sessionId}-segment-1`] }
    ];
    const good = scribeBatchEvaluated(sessionId, 'batch-multi', { items, segments, loggedItemIds: [`${sessionId}-logged-item-0`, `${sessionId}-logged-item-1`] });
    const result = await lifecycle.recordScribeBatchOutcome(sessionId, good);
    assert.deepEqual(result.entry.batch.acknowledgement.logged_item_ids, [`${sessionId}-logged-item-0`, `${sessionId}-logged-item-1`]);

    const mismatched = scribeBatchEvaluated(sessionId, 'batch-mismatch', { items, segments, loggedItemIds: [`${sessionId}-logged-item-only-one`] });
    await assert.rejects(() => lifecycle.recordScribeBatchOutcome(sessionId, mismatched), (error) => error.code === 'SCRIBE_ACKNOWLEDGEMENT_MAPPING_INVALID');
  });
});

test('Scribe checkpoint and batch journal corruption is detected, not silently accepted', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-corrupt-files';
    const storage = new SessionStorage({ root: directory });
    const lifecycle = new SessionLifecycle({ storage });
    await lifecycle.record(command('record-1', sessionId));
    const paths = storage.paths(sessionId);
    assert.ok(paths.scribeCheckpoint.startsWith(paths.active));
    assert.ok(paths.scribeBatchJournal.startsWith(paths.permanent));

    await writeFile(paths.scribeCheckpoint, 'not json', 'utf8');
    await assert.rejects(() => storage.readScribeCheckpoint(sessionId), (error) => error.code === 'SNAPSHOT_INTEGRITY_FAILURE');

    await writeFile(paths.scribeCheckpoint, `${JSON.stringify({ schema_version: '1.0.0', session_id: sessionId })}\n`, 'utf8');
    await assert.rejects(() => storage.readScribeCheckpoint(sessionId), (error) => error.code === 'SCRIBE_CHECKPOINT_INVALID');

    await writeFile(paths.scribeBatchJournal, 'not json\n', 'utf8');
    await assert.rejects(() => storage.readScribeBatchJournal(sessionId), (error) => error.code === 'SCRIBE_JOURNAL_INTEGRITY_FAILURE');
  });
});

test('Scribe checkpoint read rejects a symlinked storage file', async (t) => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-symlink-substitution';
    const storage = new SessionStorage({ root: directory });
    const lifecycle = new SessionLifecycle({ storage });
    await lifecycle.record(command('record-1', sessionId));
    const paths = storage.paths(sessionId);
    const outsideTarget = path.join(directory, 'outside-scribe-checkpoint.json');
    await writeFile(outsideTarget, '{}', 'utf8');
    try {
      await symlink(outsideTarget, paths.scribeCheckpoint, 'file');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip(`symlink privilege unavailable in this environment: ${error.code}`); return; }
      throw error;
    }
    await assert.rejects(() => storage.readScribeCheckpoint(sessionId), (error) => error.code === 'SESSION_FILE_SYMLINK');
  });
});

test('a valid pending Scribe batch survives a simulated crash/restart', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-pending-recovery';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));

    const inFlight = { batch_identity: scribeBatchIdentity(sessionId, 'batch-in-flight'), attempt: 1, dispatched_at: '2026-08-19T00:05:00.000Z' };
    await lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId, { in_flight_batch: inFlight }));

    const restarted = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    const recovered = await restarted.getScribeCheckpoint(sessionId);
    assert.deepEqual(recovered.in_flight_batch, inFlight);
  });
});

test('Scribe checkpoint survives Stop and Resume unchanged', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-stop-resume';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));
    const inFlight = { batch_identity: scribeBatchIdentity(sessionId, 'batch-stop-resume'), attempt: 1, dispatched_at: '2026-08-19T00:03:00.000Z' };
    await lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId, { in_flight_batch: inFlight }), { savedAt: '2026-08-19T00:03:30.000Z' });

    await lifecycle.stop(command('stop-1', sessionId, '2026-08-19T00:04:00.000Z'));
    assert.deepEqual((await lifecycle.getScribeCheckpoint(sessionId)).in_flight_batch, inFlight);

    await lifecycle.resume(command('resume-1', sessionId, '2026-08-19T00:05:00.000Z'));
    assert.deepEqual((await lifecycle.getScribeCheckpoint(sessionId)).in_flight_batch, inFlight);
  });
});

test('Scribe checkpoint refuses to clear an in-flight batch whose outcome was never journaled', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-outcome-not-journaled';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));

    const inFlight = { batch_identity: scribeBatchIdentity(sessionId, 'batch-not-journaled'), attempt: 1, dispatched_at: '2026-08-19T00:06:00.000Z' };
    await lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId, { in_flight_batch: inFlight }));

    const resolvedBatch = scribeBatchEvaluated(sessionId, 'batch-not-journaled', { attempt: 1 });
    await assert.rejects(
      () => lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId, { last_evaluated_batch: resolvedBatch })),
      (error) => error.code === 'SCRIBE_BATCH_OUTCOME_NOT_JOURNALED'
    );
    assert.deepEqual((await lifecycle.getScribeCheckpoint(sessionId)).in_flight_batch, inFlight);
    assert.deepEqual(await lifecycle.getScribeBatchJournal(sessionId), []);

    await lifecycle.recordScribeBatchOutcome(sessionId, resolvedBatch);
    await lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId, { last_evaluated_batch: resolvedBatch }));
    assert.equal((await lifecycle.getScribeCheckpoint(sessionId)).in_flight_batch, undefined);
  });
});

test('Close refuses to seal an unacknowledged in-flight Scribe batch, and Stop/Resume remain unaffected by the refusal', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-close-gap';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));
    const inFlight = { batch_identity: scribeBatchIdentity(sessionId, 'batch-close-gap'), attempt: 1, dispatched_at: '2026-08-19T00:06:00.000Z' };
    await lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId, { in_flight_batch: inFlight }));

    await assert.rejects(() => lifecycle.close(command('close-1', sessionId)), (error) => error.code === 'SCRIBE_BATCH_UNACKNOWLEDGED');

    const resolvedBatch = scribeBatchEvaluated(sessionId, 'batch-close-gap', { attempt: 1 });
    await lifecycle.recordScribeBatchOutcome(sessionId, resolvedBatch);
    await lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId, { last_evaluated_batch: resolvedBatch }));

    const closed = await lifecycle.close(command('close-2', sessionId));
    assert.equal(closed.state, 'closed');
  });
});

test('Close refuses to seal unacknowledged pending Scribe evidence that was never batched, and Stop remains unaffected', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-pending-gap';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));
    const pending = {
      segments: [{ segment_id: `${sessionId}-segment-0`, revision: 0, sequence: 0 }],
      accumulated_since: '2026-08-19T00:06:00.000Z'
    };
    await lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId, { pending_partial: pending }));

    await assert.rejects(() => lifecycle.close(command('close-1', sessionId)), (error) => error.code === 'SCRIBE_PENDING_EVIDENCE_UNACKNOWLEDGED');

    await lifecycle.stop(command('stop-1', sessionId, '2026-08-19T00:06:30.000Z'));
    assert.deepEqual((await lifecycle.getScribeCheckpoint(sessionId)).pending_partial, pending);
    await assert.rejects(() => lifecycle.close(command('close-2', sessionId)), (error) => error.code === 'SCRIBE_PENDING_EVIDENCE_UNACKNOWLEDGED');

    await lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId, { admitted_through: { last_segment_id: `${sessionId}-segment-0`, last_sequence: 0, last_revision: 0 } }));
    const closed = await lifecycle.close(command('close-3', sessionId));
    assert.equal(closed.state, 'closed');
  });
});

test('recovery backups include the Scribe checkpoint and batch journal when present, and repeated recovery stays idempotent', async () => {
  await withRoot(async (directory) => {
    const sessionId = 'scribe-backup-and-repeat';
    const storage = new SessionStorage({ root: directory });
    const lifecycle = new SessionLifecycle({ storage });
    await lifecycle.record(command('record-1', sessionId));
    await lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId));
    await lifecycle.recordScribeBatchOutcome(sessionId, scribeBatchEvaluated(sessionId, 'batch-backup'));

    const active = storedSegment(sessionId, 0, 0, 'Active-only transcript.');
    await storage.writeActiveSnapshot(sessionId, 'transcript', { schema_version: '1.0.0', session_id: sessionId, saved_at: active.stored_at, segments: [active] });

    const applied = await lifecycle.recoverSession(sessionId, { apply: true });
    assert.ok(applied.backup_path);
    assert.ok(await readFile(path.join(applied.backup_path, 'scribe.checkpoint.json'), 'utf8'));
    assert.ok(await readFile(path.join(applied.backup_path, 'scribe.batch-journal.ndjson'), 'utf8'));

    const repeated = await lifecycle.recoverSession(sessionId, { apply: true });
    assert.equal(repeated.backup_path, null);
    assert.equal((await lifecycle.getScribeCheckpoint(sessionId)).session_id, sessionId);
    assert.equal((await lifecycle.getScribeBatchJournal(sessionId)).length, 1);
  });
});

test('Persisted Scribe checkpoint and journal entries validate against the governed catalog contracts', async () => {
  const registry = await loadContractRegistry(path.join(root, 'contracts', 'catalog.json'));
  await withRoot(async (directory) => {
    const sessionId = 'scribe-contract-conformance';
    const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    await lifecycle.record(command('record-1', sessionId));
    await lifecycle.acceptScribeCheckpoint(sessionId, scribeCheckpoint(sessionId));
    const { entry } = await lifecycle.recordScribeBatchOutcome(sessionId, scribeBatchEvaluated(sessionId, 'batch-contract'));

    assert.deepEqual(registry.validateArtifact('scribe_checkpoint', await lifecycle.getScribeCheckpoint(sessionId)), []);
    assert.deepEqual(registry.validateArtifact('scribe_batch_journal_entry', entry), []);
  });
});
