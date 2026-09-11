import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DesktopApplication } from '../runtime/desktop-application.mjs';
import { InteractiveGraph } from '../runtime/interactive-graph.mjs';
import { SessionStorage } from '../runtime/session-storage.mjs';
import { startScribeBatchModelEndpoint } from './helpers/scribe-batch-model-endpoint.mjs';

// SCRIBE-05 integration coverage.
//
// These tests run the real production graph with exactly one substitution: Whisper is replaced by
// an injected evidence source that emits the same `transcript.word-committed` and
// `transcript.utterance-boundary` traffic speech-to-text would emit. Everything downstream is the
// real thing in its own process - the transcript owner and its durable active snapshot, the
// permanent history, the Scribe policy source, the Scribe coordinator, the session-lifecycle
// checkpoint/journal owner, the extraction boundary, the serial model lane, the Logged Item owner
// and its append-only history. No persistence or ownership seam is stubbed, so a durable
// checkpoint asserted here is the same file the desktop host recovers from.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productionGraphFile = path.join(root, 'wiring', 'production-electron.json');
const MODEL_NAME = 'scribe-integration-model';

test('production graph configures the governed Scribe defaults without coupling policy to a provider', async () => {
  const definition = JSON.parse(await readFile(productionGraphFile, 'utf8'));
  const policy = definition.run.configuration.scribe_policy;
  assert.deepEqual(policy.admission, { rows_per_batch: 3, idle_timeout_ms: 15000 });
  assert.deepEqual(policy.context, { max_total_context_tokens: 8000 });
  assert.equal(policy.generation.instruction_version, '1.0.0');
  // ADR-021's operational defaults are configuration; nothing about the model provider may leak
  // into the governed policy the coordinator and extraction boundary agree on.
  const serialized = JSON.stringify(policy);
  for (const forbidden of ['model', 'endpoint', 'provider', 'lm-studio', 'ollama', 'api_key']) {
    assert.equal(serialized.includes(forbidden), false, `scribe_policy must not carry ${forbidden}`);
  }

  // The obsolete production-only selection path is gone, but its services stay on disk for the
  // Phase 4 replacement proofs and the unrelated demos that still exercise them.
  const serviceIds = definition.services.map((service) => service.id);
  assert.equal(serviceIds.includes('window-selector'), false);
  assert.equal(serviceIds.includes('context-policy'), false);
  assert.ok(serviceIds.includes('scribe-coordinator'));
  assert.ok(serviceIds.includes('scribe-policy'));
  const wires = [...definition.domain_wires, ...definition.control_wires];
  assert.equal(wires.some((wire) => wire.contract === 'transcript.context-window'), false);
  assert.equal(wires.some((wire) => wire.contract === 'transcript.context-policy'), false);
  await assert.doesNotReject(() => readFile(path.join(root, 'services', 'transcript-window-selector', 'service.json'), 'utf8'));
  await assert.doesNotReject(() => readFile(path.join(root, 'services', 'context-policy-source', 'service.json'), 'utf8'));
  const demo = JSON.parse(await readFile(path.join(root, 'wiring', 'demo.transcript-context.json'), 'utf8'));
  assert.ok(demo.services.some((service) => service.manifest.includes('transcript-window-selector')));
});

test('finalized rows accumulate 3 + 3 + 1 across a busy model lane, and only the remainder waits for idle', async () => {
  const harness = await startHarness({
    idleTimeoutMs: 1000,
    reply: (request) => ({ items: itemsFor(request) }),
    modelDelayMs: 250
  });
  try {
    await harness.record();
    // Seven finalized rows arrive back to back while the model lane is busy with the first batch.
    for (let sequence = 0; sequence < 7; sequence += 1) await harness.finalizeRow(sequence);
    await harness.waitFor(() => harness.admitted.length >= 2, 'two full batches admitted');
    await harness.waitFor(() => harness.evaluated.length >= 2, 'two full batches evaluated');

    const [first, second] = harness.admitted;
    assert.deepEqual(sequencesOf(first), [0, 1, 2]);
    assert.deepEqual(sequencesOf(second), [3, 4, 5]);
    assert.equal(first.payload.batch_identity.admission_reason, 'batch-complete');
    assert.equal(second.payload.batch_identity.admission_reason, 'batch-complete');
    // The second three-row group accumulated while the lane was busy and ran on acknowledgement
    // of the first, not on the partial-batch idle threshold.
    assert.ok(
      Date.parse(second.timestamp) - Date.parse(harness.evaluated[0].timestamp) < 1000,
      'the accumulated three-row group must run immediately after the previous acknowledgement'
    );
    assert.equal(harness.admitted.length, 2, 'the one-row remainder must not be admitted yet');

    await harness.waitFor(() => harness.admitted.length >= 3, 'idle admission of the remainder');
    const third = harness.admitted[2];
    assert.deepEqual(sequencesOf(third), [6]);
    assert.equal(third.payload.batch_identity.admission_reason, 'idle-timeout');
    await harness.waitFor(() => harness.evaluated.length >= 3, 'remainder evaluated');

    // One durable cursor and one active batch describe Scribe progress for the session.
    await harness.waitForCursor(6, 'the durable cursor reaches the last finalized row');
    const checkpoint = await harness.checkpoint();
    assert.equal(checkpoint.admitted_through.last_sequence, 6);
    assert.equal(checkpoint.in_flight_batch, undefined);
    assert.deepEqual(checkpoint.pending_partial.segments, []);
    const journal = await harness.journal();
    assert.deepEqual(journal.map((entry) => entry.batch.batch_identity.last_sequence), [2, 5, 6]);
    for (const entry of journal) assert.equal(entry.batch.attempt, 1, 'coordinator attempt stays independent of provider retries');

    // Every model call is stateless and carries only its own new evidence as triggering material.
    for (const call of harness.endpoint.calls) {
      assert.equal(call.modelRequest.protocol_version, '2.0.0');
      const evidenceIds = call.modelRequest.new_evidence_segments.map((segment) => segment.segment_id);
      const backgroundIds = call.modelRequest.background_context.transcript_segments.map((segment) => segment.segment_id);
      assert.equal(evidenceIds.some((id) => backgroundIds.includes(id)), false, 'new evidence may never be background');
    }
    assert.ok(harness.endpoint.calls.at(-1).modelRequest.background_context.transcript_segments.length > 0, 'later batches carry prior rows as background');
  } finally {
    await harness.stop();
  }
});

test('multiple items reach the owner and append-only history exactly once with source navigation intact', async () => {
  const harness = await startHarness({ idleTimeoutMs: 1000, reply: (request) => ({ items: itemsFor(request, 2) }) });
  try {
    await harness.record();
    for (let sequence = 0; sequence < 3; sequence += 1) await harness.finalizeRow(sequence);
    await harness.waitFor(() => harness.evaluated.length >= 1, 'batch evaluated');

    const evaluated = harness.evaluated[0].payload.batch;
    assert.equal(evaluated.outcome, 'items-recorded');
    assert.equal(evaluated.items.length, 2);
    // The acknowledgement is assembled only from real owner confirmations, in evaluated item order.
    const storedIds = harness.stored.map((message) => message.payload.item_id);
    assert.deepEqual(evaluated.acknowledgement.logged_item_ids.length, evaluated.items.length);
    assert.deepEqual([...evaluated.acknowledgement.logged_item_ids].sort(), [...storedIds].sort());
    assert.equal(new Set(storedIds).size, storedIds.length, 'each item is stored exactly once');
    for (const message of harness.stored) {
      assert.equal(message.payload.session_id, harness.sessionId);
      assert.ok(message.payload.source.first_segment_id, 'a stored item keeps its triggering source range');
      assert.ok(message.payload.source.last_segment_id);
    }
    await harness.waitFor(() => harness.historyAppended.length >= 2, 'append-only history acknowledged both items');
    const historyIds = harness.historyAppended.map((message) => message.payload.item_id ?? message.payload.history_entry_id);
    assert.equal(new Set(historyIds).size, historyIds.length, 'history appends each item once');

    await harness.waitForCursor(2, 'the durable cursor advances past the acknowledged batch');
    const checkpoint = await harness.checkpoint();
    assert.deepEqual(
      checkpoint.last_evaluated_batch.acknowledgement.logged_item_ids,
      evaluated.acknowledgement.logged_item_ids,
      'the durable checkpoint preserves the exact one-to-one item mapping'
    );
  } finally {
    await harness.stop();
  }
});

test('a valid zero-item batch records no Logged Item and still advances the durable cursor', async () => {
  const harness = await startHarness({ idleTimeoutMs: 1000, reply: () => ({ items: [] }) });
  try {
    await harness.record();
    for (let sequence = 0; sequence < 3; sequence += 1) await harness.finalizeRow(sequence);
    await harness.waitFor(() => harness.evaluated.length >= 1, 'zero-item batch evaluated');

    const evaluated = harness.evaluated[0].payload.batch;
    assert.equal(evaluated.outcome, 'empty-evaluated');
    assert.deepEqual(evaluated.items, []);
    assert.equal(evaluated.acknowledgement.accepted, true);
    assert.deepEqual(evaluated.acknowledgement.logged_item_ids, []);
    assert.deepEqual(harness.stored, [], 'a zero-item batch must not create a blank Logged Item');

    await harness.waitForCursor(2, 'a valid zero-item outcome still advances the durable cursor');
    const checkpoint = await harness.checkpoint();
    assert.equal(checkpoint.in_flight_batch, undefined);
    const items = await harness.storage.readActiveSnapshot(harness.sessionId, 'logged-item');
    assert.deepEqual(items.items, []);
  } finally {
    await harness.stop();
  }
});

test('transcript finalization stays independent of a stalled Scribe backlog and model latency', async () => {
  const harness = await startHarness({ idleTimeoutMs: 1000, reply: () => ({ status: 503, raw: 'model unavailable' }) });
  try {
    await harness.record();
    for (let sequence = 0; sequence < 3; sequence += 1) await harness.finalizeRow(sequence);
    await harness.waitFor(() => harness.evaluated.length >= 1, 'terminal failed evaluation');
    const failed = harness.evaluated[0].payload.batch;
    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.acknowledgement.accepted, false);

    // The cursor never advances past unacknowledged evidence and the batch is retained, stalled.
    const checkpoint = await harness.checkpoint();
    assert.equal(checkpoint.admitted_through.last_sequence, -1);
    assert.ok(checkpoint.in_flight_batch, 'the exact failed batch stays retained for visible recovery');

    // Whisper's successors keep finalizing rows while Scribe is stalled.
    const before = harness.segments.length;
    for (let sequence = 3; sequence < 6; sequence += 1) await harness.finalizeRow(sequence);
    await harness.waitFor(() => harness.segments.length >= before + 3, 'transcript finalization continues');
    const stored = await harness.storage.readActiveSnapshot(harness.sessionId, 'transcript');
    assert.equal(stored.segments.length, 6, 'every finalized row stays authoritative in transcript storage');
    assert.equal(harness.evaluated.filter((message) => message.payload.batch.outcome !== 'failed').length, 0);
    assert.equal(harness.admitted.length, 1, 'a stalled batch starts no automatic outer retry');
  } finally {
    await harness.stop();
  }
});

test('a crash before model completion replays the exact in-flight batch after recovery', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scribe-recovery-a-'));
  try {
    const first = await startHarness({ idleTimeoutMs: 1000, directory, reply: () => ({ delayMs: 60000 }) });
    let sessionId;
    let admitted;
    try {
      await first.record();
      for (let sequence = 0; sequence < 3; sequence += 1) await first.finalizeRow(sequence);
      await first.waitFor(() => first.admitted.length >= 1, 'batch admitted');
      sessionId = first.sessionId;
      admitted = first.admitted[0].payload;
      // The admission checkpoint is durable before the model answers, which is what makes the
      // crash recoverable at all.
      const checkpoint = await first.checkpoint();
      assert.equal(checkpoint.in_flight_batch.batch_identity.request_id, admitted.batch_identity.request_id);
      assert.equal(checkpoint.in_flight_batch.attempt, admitted.batch_attempt);
      assert.equal(checkpoint.admitted_through.last_sequence, -1);
    } finally {
      await first.crash();
    }

    const second = await startHarness({ idleTimeoutMs: 1000, directory, sessionId, reply: (request) => ({ items: itemsFor(request) }) });
    try {
      await second.resume();
      await second.waitFor(() => second.admitted.length >= 1, 'recovered batch redispatched');
      const replayed = second.admitted[0].payload;
      assert.deepEqual(replayed.batch_identity, admitted.batch_identity, 'recovery replays the identical batch identity');
      assert.equal(replayed.batch_attempt, admitted.batch_attempt, 'recovery keeps the exact coordinator attempt');
      await second.waitFor(() => second.evaluated.length >= 1, 'recovered batch evaluated');
      await second.waitForCursor(2, 'the replayed batch settles its durable cursor');
      const journal = await second.journal();
      assert.equal(journal.length, 1, 'the replayed batch is journaled exactly once');
    } finally {
      await second.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a crash after model completion but before item acknowledgement re-evaluates without duplicating items', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scribe-recovery-b-'));
  try {
    const first = await startHarness({ idleTimeoutMs: 1000, directory, reply: (request) => ({ items: itemsFor(request) }) });
    let sessionId;
    let admitted;
    try {
      await first.record();
      for (let sequence = 0; sequence < 3; sequence += 1) await first.finalizeRow(sequence);
      // The model has answered and the draft is with the owner, but the batch has not been
      // acknowledged as evaluated yet.
      await first.waitFor(() => first.stored.length >= 1, 'owner stored the draft');
      await first.waitForCursor(2, 'the first run stored its item and settled');
      sessionId = first.sessionId;
      admitted = first.admitted[0].payload;
    } finally {
      await first.crash();
    }
    const storage = new SessionStorage({ root: path.join(directory, 'sessions') });
    const itemsBefore = (await storage.readActiveSnapshot(sessionId, 'logged-item')).items.length;
    assert.ok(itemsBefore >= 1, 'the real owner durably stored the Logged Item before the crash');

    // Reproduce the boundary deterministically instead of racing it. Letting the crash fall
    // wherever timing puts it made this test pass whenever settlement won the race, because
    // recovery then rebuilds from the journal and never replays the draft to the owner - so the
    // boundary the test claims to prove went unexercised. The Logged Item above was stored by the
    // real owner; rewinding the durable Scribe state to its pre-acknowledgement form recreates
    // exactly "the model answered and the item is stored, but the outcome was never acknowledged"
    // on every run, and forces the replay path through the real ownership seam.
    const settled = await storage.readScribeCheckpoint(sessionId);
    await storage.writeScribeCheckpoint(sessionId, {
      schema_version: settled.schema_version,
      session_id: sessionId,
      saved_at: settled.saved_at,
      admitted_through: { last_segment_id: null, last_sequence: -1, last_revision: 0 },
      pending_partial: { segments: [], accumulated_since: null },
      background_context: { prior_logged_items: [] },
      policy_id: settled.policy_id,
      policy_version: settled.policy_version,
      in_flight_batch: { batch_identity: admitted.batch_identity, attempt: admitted.batch_attempt, dispatched_at: settled.saved_at }
    });
    await rm(path.join(directory, 'sessions', sessionId, 'permanent', 'scribe.batch-journal.ndjson'), { force: true });
    assert.deepEqual(await storage.readScribeBatchJournal(sessionId), [], 'the rewound state must carry no journaled outcome, or recovery would settle from the journal instead of replaying');

    const second = await startHarness({ idleTimeoutMs: 1000, directory, sessionId, reply: (request) => ({ items: itemsFor(request) }) });
    try {
      await second.resume();
      await second.waitFor(() => second.admitted.length >= 1, 'the unacknowledged batch is replayed');
      assert.deepEqual(second.admitted[0].payload.batch_identity, admitted.batch_identity, 'a replay uses the identical batch identity');
      assert.equal(second.admitted[0].payload.batch_attempt, admitted.batch_attempt, 'a replay keeps the exact coordinator attempt');
      await second.waitForCursor(2, 'the replayed batch settles its durable cursor through the real owner');
      const checkpoint = await second.checkpoint();
      assert.equal(checkpoint.in_flight_batch, undefined, 'settlement clears the in-flight batch');
      const journal = await second.journal();
      assert.equal(journal.length, 1, 'the replayed outcome is journaled exactly once');
      assert.deepEqual(journal[0].batch.batch_identity, admitted.batch_identity, 'settlement keeps the exact pre-crash batch identity');
      assert.equal(journal[0].batch.attempt, admitted.batch_attempt, 'settlement keeps the exact pre-crash coordinator attempt');
      // The owner must idempotently re-confirm the already-stored draft rather than reject it as a
      // reused item id; a duplicate or a rejection here both fail the boundary.
      const items = (await second.storage.readActiveSnapshot(sessionId, 'logged-item')).items;
      assert.equal(new Set(items.map((item) => item.item_id)).size, items.length, 'deterministic draft identity prevents duplicate Logged Items');
      assert.equal(items.length, itemsBefore, 'a replayed batch stores no additional Logged Item');
      assert.deepEqual(
        checkpoint.last_evaluated_batch.acknowledgement.logged_item_ids,
        items.map((item) => item.item_id),
        'the settled acknowledgement names exactly the stored Logged Items'
      );
    } finally {
      await second.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a crash after item acknowledgement but before cursor persistence settles from the journal without re-invoking the model', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scribe-recovery-c-'));
  try {
    const first = await startHarness({ idleTimeoutMs: 1000, directory, reply: (request) => ({ items: itemsFor(request) }) });
    let sessionId;
    let evaluatedBatch;
    try {
      await first.record();
      for (let sequence = 0; sequence < 3; sequence += 1) await first.finalizeRow(sequence);
      await first.waitFor(() => first.evaluated.length >= 1, 'batch evaluated and acknowledged');
      sessionId = first.sessionId;
      evaluatedBatch = first.evaluated[0].payload.batch;
      await first.waitFor(async () => (await first.journal()).length >= 1, 'outcome journaled');
    } finally {
      await first.crash();
    }

    // Reproduce the interrupted journal-before-checkpoint write: the terminal outcome is durable
    // in the append-only journal while the checkpoint still describes the batch as in flight.
    const storage = new SessionStorage({ root: path.join(directory, 'sessions') });
    const settled = await storage.readScribeCheckpoint(sessionId);
    const journal = await storage.readScribeBatchJournal(sessionId);
    assert.equal(journal.length, 1);
    assert.equal(settled.admitted_through.last_sequence, 2);
    await storage.writeScribeCheckpoint(sessionId, {
      schema_version: settled.schema_version,
      session_id: sessionId,
      saved_at: settled.saved_at,
      admitted_through: { last_segment_id: null, last_sequence: -1, last_revision: 0 },
      pending_partial: { segments: [], accumulated_since: null },
      background_context: { prior_logged_items: [] },
      policy_id: settled.policy_id,
      policy_version: settled.policy_version,
      in_flight_batch: {
        batch_identity: journal[0].batch.batch_identity,
        attempt: journal[0].batch.attempt,
        dispatched_at: settled.saved_at
      }
    });

    const second = await startHarness({ idleTimeoutMs: 1000, directory, sessionId, reply: () => { throw new Error('the model must not be re-invoked for a journaled outcome'); } });
    try {
      await second.resume();
      await second.waitFor(async () => (await second.checkpoint()).admitted_through.last_sequence === 2, 'cursor rebuilt from the journal');
      const checkpoint = await second.checkpoint();
      assert.equal(checkpoint.in_flight_batch, undefined, 'the stale in-flight reference is reconciled away');
      assert.deepEqual(
        checkpoint.last_evaluated_batch.acknowledgement.logged_item_ids,
        evaluatedBatch.acknowledgement.logged_item_ids,
        'the rebuilt cursor keeps the journaled acknowledgement'
      );
      assert.deepEqual((await second.journal()).length, 1, 'recovery does not re-journal a settled outcome');
      assert.equal(second.endpoint.calls.length, 0, 'a journaled outcome is never re-sent to the model');
      const items = (await second.storage.readActiveSnapshot(sessionId, 'logged-item')).items;
      assert.equal(items.length, evaluatedBatch.items.length, 'recovery duplicates no Logged Item');
    } finally {
      await second.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Close releases a sub-threshold remainder immediately and seals only after acknowledgement', async () => {
  // The remainder is two rows - below the three-row batch threshold - and the idle timer is set far
  // beyond the test, so nothing but the governed Close request can release it.
  const harness = await startHarness({ idleTimeoutMs: 300000, reply: (request) => ({ items: itemsFor(request) }) });
  try {
    await harness.record();
    for (let sequence = 0; sequence < 2; sequence += 1) await harness.finalizeRow(sequence);
    await harness.waitFor(() => harness.segments.length >= 2, 'both rows finalized');
    assert.equal(harness.admitted.length, 0, 'a sub-threshold remainder must not be admitted before Close');
    assert.equal(await harness.checkpoint(), undefined, 'nothing durable records those rows yet');

    const started = Date.now();
    const { sealed, acknowledgement } = await harness.close();
    assert.equal(sealed, true);
    assert.equal(acknowledgement.accepted, true, 'Close is acknowledged only when Scribe is caught up');
    assert.equal(acknowledgement.pending_rows, 0);
    assert.equal(acknowledgement.admitted_through.last_sequence, 1);
    assert.ok(Date.now() - started < 30000, 'Close must not wait out the admission policy idle timer');

    assert.deepEqual(sequencesOf(harness.admitted[0]), [0, 1], 'Close forced the exact remainder');
    assert.equal(harness.admitted[0].payload.batch_identity.admission_reason, 'idle-timeout');
    const checkpoint = await harness.checkpoint();
    assert.equal(checkpoint.admitted_through.last_sequence, 1, 'the durable cursor covers every finalized row');
    assert.equal(checkpoint.in_flight_batch, undefined);
    assert.equal((await harness.journal()).length, 1);
    assert.equal((await harness.metadata()).state, 'closed', 'the session seals only after the acknowledgement');
    const items = (await harness.storage.readActiveSnapshot(harness.sessionId, 'logged-item')).items;
    assert.equal(items.length, 1, 'the remainder produced its Logged Item rather than being skipped');
  } finally {
    await harness.stop();
  }
});

test('Close fails visibly and leaves the session unsealed when Scribe cannot finish', async () => {
  const harness = await startHarness({ idleTimeoutMs: 300000, reply: () => ({ status: 503, raw: 'model unavailable' }) });
  try {
    await harness.record();
    for (let sequence = 0; sequence < 2; sequence += 1) await harness.finalizeRow(sequence);
    await harness.waitFor(() => harness.segments.length >= 2, 'both rows finalized');

    const { sealed, acknowledgement } = await harness.close();
    assert.equal(sealed, false, 'a session Scribe could not flush must not be sealed');
    assert.equal(acknowledgement.accepted, false);
    assert.ok(acknowledgement.error, 'the refusal names its exact cause');
    assert.equal((await harness.metadata()).state, 'recording', 'the session stays open so no finalized row is lost');

    // The durable boundary refuses the seal independently, so a caller that ignores the
    // acknowledgement still cannot seal past the unacknowledged rows.
    const refusal = await harness.sealDirectly();
    assert.equal(refusal.refused, true, 'the lifecycle owner refuses to seal an unacknowledged Scribe gap');
    assert.match(refusal.code, /SCRIBE_/);
    assert.notEqual((await harness.metadata()).state, 'closed');
    const checkpoint = await harness.checkpoint();
    assert.ok(checkpoint.in_flight_batch, 'the exact failed batch stays retained');
  } finally {
    await harness.stop();
  }
});

test('rows finalized below the batch threshold survive a crash through authoritative transcript history', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scribe-subthreshold-'));
  try {
    const first = await startHarness({ idleTimeoutMs: 300000, directory, reply: (request) => ({ items: itemsFor(request) }) });
    let sessionId;
    try {
      await first.record();
      for (let sequence = 0; sequence < 2; sequence += 1) await first.finalizeRow(sequence);
      await first.waitFor(() => first.segments.length >= 2, 'both rows finalized');
      sessionId = first.sessionId;
      // Nothing durable describes these rows as Scribe evidence: no checkpoint exists at all.
      assert.equal(await first.checkpoint(), undefined);
    } finally {
      await first.crash();
    }

    const second = await startHarness({ idleTimeoutMs: 300000, directory, sessionId, reply: (request) => ({ items: itemsFor(request) }) });
    try {
      await second.resume();
      // Recovery rebuilt them from authoritative transcript history, so Close can still flush them.
      const { sealed, acknowledgement } = await second.close();
      assert.equal(sealed, true);
      assert.equal(acknowledgement.accepted, true);
      assert.equal(acknowledgement.admitted_through.last_sequence, 1, 'both pre-crash rows were acknowledged');
      assert.deepEqual(sequencesOf(second.admitted[0]), [0, 1], 'the recovered rows are the exact pre-crash evidence');
      const checkpoint = await second.checkpoint();
      assert.equal(checkpoint.admitted_through.last_sequence, 1);
      const items = (await second.storage.readActiveSnapshot(sessionId, 'logged-item')).items;
      assert.equal(items.length, 1, 'the recovered remainder produced its Logged Item');
    } finally {
      await second.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the host Close deadline rejects visibly instead of hanging when Scribe never answers', { timeout: 15000 }, async () => {
  const application = new DesktopApplication({ root, graphFile: productionGraphFile, sessionRoot: path.join(os.tmpdir(), `argus-flush-timeout-${Date.now()}`) });
  application.sessionId = 'flush-timeout-session';
  application.boundary = { projection: (messageType, payload) => ({ message_type: messageType, payload }) };
  const dispatched = [];
  // A graph that accepts the request and never acknowledges it - the exact shape of a coordinator
  // that dies mid-flush. The deadline must reject; it must not leave Close awaiting forever.
  application.graph = { closed: false, async dispatchFrom(_from, _plane, type, _session, payload) { dispatched.push({ type, payload }); } };
  const originalTimeout = application.constructor;
  const flush = withShortFlushDeadline(application, 120, () => application.flushScribeBeforeClose(application.sessionId));
  await assert.rejects(flush, (error) => {
    assert.equal(error.code, 'SCRIBE_CLOSE_FLUSH_TIMEOUT');
    assert.match(error.message, /stays open/);
    return true;
  });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'scribe.session-closing');
  assert.ok(dispatched[0].payload.request_id, 'every attempt carries its own request id');
  assert.equal(application.scribeFlushWaiters.size, 0, 'the waiter is released so a retry is possible');
  assert.equal(originalTimeout, application.constructor);
});

// This covers the host half only: a fresh identity per attempt, correct correlation of each
// answer, and a released waiter. Whether a retry can actually succeed depends on coordinator
// state, which the real-coordinator test below establishes.
test('the host gives every Close attempt its own identity and surfaces each answer', { timeout: 15000 }, async () => {
  const application = new DesktopApplication({ root, graphFile: productionGraphFile, sessionRoot: path.join(os.tmpdir(), `argus-flush-retry-${Date.now()}`) });
  application.sessionId = 'flush-retry-session';
  application.boundary = { projection: (messageType, payload) => ({ message_type: messageType, payload }) };
  const requests = [];
  let answer = 'fail';
  application.graph = {
    closed: false,
    async dispatchFrom(_from, _plane, type, sessionId, payload) {
      if (type !== 'scribe.session-closing') return;
      requests.push(payload.request_id);
      const accepted = answer === 'accept';
      application.handleGraphMessage({
        message_id: `flushed-${payload.request_id}`, message_type: 'scribe.session-flushed', plane: 'control', correlation_id: sessionId,
        payload: {
          session_id: sessionId, request_id: payload.request_id, flushed_at: new Date().toISOString(), accepted,
          admitted_through: { last_segment_id: null, last_sequence: accepted ? 2 : -1, last_revision: 0 },
          pending_rows: accepted ? 0 : 2,
          ...(accepted ? {} : { error: { code: 'SCRIBE_BATCH_STALLED', category: 'conflict', message: 'the model was unavailable', retryable: true } })
        }
      });
    }
  };

  await assert.rejects(() => application.flushScribeBeforeClose(application.sessionId), (error) => {
    assert.equal(error.code, 'SCRIBE_BATCH_STALLED');
    return true;
  });
  answer = 'accept';
  await application.flushScribeBeforeClose(application.sessionId);

  assert.equal(requests.length, 2, 'the retry reached the coordinator as a second request');
  assert.notEqual(requests[0], requests[1], 'a retry never reuses the failed attempt identity');
  assert.equal(new Set(requests).size, 2);
  assert.equal(application.scribeFlushWaiters.size, 0);
});

test('a Close retried after a terminal Scribe failure never seals, and only a restart clears the stall', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scribe-close-retry-'));
  try {
    const failing = await startHarness({ idleTimeoutMs: 300000, directory, reply: () => ({ status: 503, raw: 'model unavailable' }) });
    let sessionId;
    try {
      await failing.record();
      for (let sequence = 0; sequence < 2; sequence += 1) await failing.finalizeRow(sequence);
      await failing.waitFor(() => failing.segments.length >= 2, 'both rows finalized');
      sessionId = failing.sessionId;

      const first = await failing.closeAttempt();
      assert.equal(first.delivered ? first.acknowledgement.accepted : false, false, 'a stalled Scribe never acknowledges a clean flush');

      // Retrying is visible either way and never seals: the coordinator answers with the exact
      // failure, or - once its inbound wires have failed with the terminal batch - the attempt is
      // refused at delivery. What it cannot do is clear the stall.
      const second = await failing.closeAttempt();
      assert.notEqual(second.requestId, first.requestId, 'each attempt is a distinct governed request');
      if (second.delivered) assert.equal(second.acknowledgement.accepted, false);
      else assert.ok(second.code, 'an undeliverable retry fails visibly rather than silently');
      assert.equal((await failing.metadata()).state, 'recording', 'a stalled session is never sealed');
    } finally {
      await failing.crash();
    }

    // Restart is the path that actually clears it: recovery replays the exact stalled batch, and
    // with the model answering the session reaches a clean Close.
    const recovered = await startHarness({ idleTimeoutMs: 300000, directory, sessionId, reply: (request) => ({ items: itemsFor(request) }) });
    try {
      await recovered.resume();
      const { sealed, acknowledgement } = await recovered.close();
      assert.equal(sealed, true, 'restart recovery clears a stall that retrying Close cannot');
      assert.equal(acknowledgement.accepted, true);
      assert.equal(acknowledgement.admitted_through.last_sequence, 1);
      assert.equal((await recovered.metadata()).state, 'closed');
    } finally {
      await recovered.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a recovered backlog larger than one page drains completely without truncating rows', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scribe-paged-backlog-'));
  const backlog = 20; // one in-flight batch plus 17 queued rows - more than the 16-row page
  try {
    // The model fails, so the first batch stalls in flight and every later row queues in
    // coordinator memory. The crash therefore leaves a durable in-flight batch and a backlog that
    // cannot fit in a single `scribe.recovery-restored` message.
    const first = await startHarness({ idleTimeoutMs: 300000, directory, reply: () => ({ status: 503, raw: 'model unavailable' }) });
    let sessionId;
    try {
      await first.record();
      for (let sequence = 0; sequence < backlog; sequence += 1) await first.finalizeRow(sequence);
      await first.waitFor(() => first.segments.length >= backlog, 'every row finalized');
      await first.waitFor(() => first.admitted.length >= 1, 'the first batch is in flight');
      sessionId = first.sessionId;
      const checkpoint = await first.checkpoint();
      assert.ok(checkpoint.in_flight_batch, 'the crash leaves a batch in flight');
      assert.equal(checkpoint.admitted_through.last_sequence, -1, 'nothing was acknowledged before the crash');
    } finally {
      await first.crash();
    }
    const storage = new SessionStorage({ root: path.join(directory, 'sessions') });
    assert.equal((await storage.readActiveSnapshot(sessionId, 'transcript')).segments.length, backlog);

    const second = await startHarness({ idleTimeoutMs: 300000, directory, sessionId, reply: (request) => ({ items: itemsFor(request) }) });
    try {
      await second.resume();
      const { sealed, acknowledgement } = await second.close();
      assert.equal(sealed, true);
      assert.equal(acknowledgement.accepted, true);
      assert.equal(acknowledgement.admitted_through.last_sequence, backlog - 1, 'every backlog row was acknowledged, not just the first page');
      const checkpoint = await second.checkpoint();
      assert.equal(checkpoint.admitted_through.last_sequence, backlog - 1);
      const admittedSequences = second.admitted.flatMap((message) => sequencesOf(message));
      assert.deepEqual(admittedSequences, Array.from({ length: backlog }, (_, index) => index), 'the paged backlog is admitted exactly once, in order, including the rows beyond the first page');
      const items = (await second.storage.readActiveSnapshot(sessionId, 'logged-item')).items;
      assert.equal(new Set(items.map((item) => item.item_id)).size, items.length, 'no row produced a duplicate Logged Item');
    } finally {
      await second.stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the desktop host projects bounded Scribe states from governed traffic alone', async () => {
  const sessionId = 'scribe-status-session';
  const application = new DesktopApplication({ root, graphFile: productionGraphFile, sessionRoot: path.join(os.tmpdir(), `argus-scribe-status-${Date.now()}`) });
  application.sessionId = sessionId;
  application.metadata = { session_id: sessionId, state: 'recording', created_at: '2026-09-10T00:00:00.000Z' };
  application.boundary = { projection: (messageType, payload) => ({ message_type: messageType, payload }) };
  application.started = true;
  // Policy lives in the graph, not the host: the pending/queued boundary is read from the same
  // run configuration the Scribe policy source projects.
  application.graph = { prepared: { definition: JSON.parse(await readFile(productionGraphFile, 'utf8')) } };
  const scribeState = () => application.sessionProjection().scribe_processing;
  const capability = () => application.capabilitySnapshot().find((item) => item.capability === 'scribe');

  assert.deepEqual(scribeState(), { state: 'caught-up', pending_rows: 0, cursor_sequence: -1 });

  application.handleGraphMessage(segmentMessage(sessionId, 0));
  assert.equal(scribeState().state, 'pending');
  assert.equal(scribeState().pending_rows, 1);
  application.handleGraphMessage(segmentMessage(sessionId, 1));
  application.handleGraphMessage(segmentMessage(sessionId, 2));
  assert.equal(scribeState().state, 'queued', 'a full batch worth of rows reads as queued, not pending');
  assert.equal(scribeState().pending_rows, 3);

  const identity = batchIdentity(sessionId, [0, 1, 2]);
  application.handleGraphMessage(admittedMessage(sessionId, identity));
  assert.equal(scribeState().state, 'processing');
  assert.equal(scribeState().pending_rows, 0);
  assert.equal(scribeState().batch_request_id, identity.request_id);
  assert.equal(capability().status, 'available');
  assert.match(capability().message, /Processing/);

  application.handleGraphMessage(evaluatedMessage(sessionId, identity, { itemIds: ['item-a'] }));
  assert.deepEqual(scribeState(), { state: 'caught-up', pending_rows: 0, cursor_sequence: 2 });

  // A terminal failure is a distinct visible state and never a transcript or audio problem.
  const nextIdentity = batchIdentity(sessionId, [3, 4, 5]);
  application.handleGraphMessage(segmentMessage(sessionId, 3));
  application.handleGraphMessage(admittedMessage(sessionId, nextIdentity));
  application.handleGraphMessage(evaluatedMessage(sessionId, nextIdentity, { failed: true }));
  assert.equal(scribeState().state, 'failed');
  assert.equal(scribeState().cursor_sequence, 2, 'a failed batch never advances the projected cursor');
  assert.equal(capability().status, 'unavailable');
  assert.equal(application.sessionProjection().audio_processing.state, 'listening', 'Scribe failure leaves the audio state untouched');
  assert.equal(application.capabilitySnapshot().some((item) => item.capability === 'transcript' && item.status === 'unavailable'), false);
});

function segmentMessage(sessionId, sequence) {
  return {
    message_id: `segment-${sequence}`, message_type: 'transcript.segment', plane: 'domain', correlation_id: sessionId,
    payload: {
      segment_id: `${sessionId}-segment-${sequence}`, session_id: sessionId, sequence, revision: 0,
      start_time: '00:00:00.000', end_time: '00:00:01.000', text: `evidence ${sequence}`, boundary: 'pause'
    }
  };
}

function batchIdentity(sessionId, sequences) {
  return {
    session_id: sessionId,
    request_id: `${sessionId}:${sequences[0]}-${sequences.at(-1)}:electron-scribe-default:1.0.0`,
    segments: sequences.map((sequence) => ({ segment_id: `${sessionId}-segment-${sequence}`, revision: 0, sequence })),
    first_sequence: sequences[0],
    last_sequence: sequences.at(-1),
    admission_reason: sequences.length >= 3 ? 'batch-complete' : 'idle-timeout',
    policy_id: 'electron-scribe-default',
    policy_version: '1.0.0',
    instruction_version: '1.0.0'
  };
}

function admittedMessage(sessionId, identity) {
  return {
    message_id: `admitted-${identity.request_id}`, message_type: 'scribe.batch-admitted', plane: 'domain', correlation_id: sessionId,
    payload: {
      batch_identity: identity, batch_attempt: 1,
      new_evidence_segments: identity.segments.map((segment) => ({ ...segment, start_time: '00:00:00.000', end_time: '00:00:01.000', text: 'evidence' })),
      background_context: { transcript_segments: [], prior_logged_items: [] },
      policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0'
    }
  };
}

function evaluatedMessage(sessionId, identity, { itemIds = [], failed = false } = {}) {
  const batch = failed
    ? { batch_identity: identity, attempt: 1, outcome: 'failed', items: [], evaluated_at: '2026-09-10T00:00:02.000Z', error: { code: 'MODEL_REQUEST_FAILED', category: 'dependency', message: 'model unavailable', retryable: true }, acknowledgement: { ack_id: `${identity.request_id}:ack`, accepted: false, acknowledged_at: null, logged_item_ids: [] } }
    : { batch_identity: identity, attempt: 1, outcome: itemIds.length ? 'items-recorded' : 'empty-evaluated', items: itemIds.map((id) => ({ text: `Recorded ${id}.`, source_segment_ids: [identity.segments[0].segment_id] })), evaluated_at: '2026-09-10T00:00:02.000Z', acknowledgement: { ack_id: `${identity.request_id}:ack`, accepted: true, acknowledged_at: '2026-09-10T00:00:02.500Z', logged_item_ids: itemIds } };
  return {
    message_id: `evaluated-${identity.request_id}-${failed ? 'failed' : 'accepted'}`, message_type: 'scribe.batch-evaluated', plane: 'domain', correlation_id: sessionId,
    payload: { batch_attempt: 1, batch }
  };
}

// Exercises the real host deadline without waiting out the production timeout.
function withShortFlushDeadline(application, deadlineMs, run) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...rest) => realSetTimeout(callback, ms > deadlineMs ? deadlineMs : ms, ...rest);
  try { return run(); } finally { globalThis.setTimeout = realSetTimeout; }
}

function sequencesOf(admitted) {
  return admitted.payload.new_evidence_segments.map((segment) => segment.sequence);
}

function itemsFor(request, count = 1) {
  const segments = request.new_evidence_segments;
  return Array.from({ length: count }, (_, index) => ({
    text: `Recorded outcome ${segments[0].sequence}-${index}.`,
    kind: index % 2 === 0 ? 'decision' : 'action',
    source_segment_ids: [segments[Math.min(index, segments.length - 1)].segment_id]
  }));
}

async function startHarness({ idleTimeoutMs = 1000, reply, modelDelayMs = 0, directory, sessionId } = {}) {
  const base = directory || await mkdtemp(path.join(os.tmpdir(), 'scribe-integration-'));
  const sessionRoot = path.join(base, 'sessions');
  const graphFile = path.join(base, `graph-${Math.random().toString(36).slice(2)}.json`);
  await writeGraph(graphFile, { idleTimeoutMs });
  const endpoint = await startScribeBatchModelEndpoint({
    reply: (request, call) => {
      const answer = reply ? reply(request, call) : { items: [] };
      return modelDelayMs && !answer.delayMs ? { ...answer, delayMs: modelDelayMs } : answer;
    }
  });

  process.env.ARGUS_SESSION_ROOT = sessionRoot;
  process.env.ARGUS_MODEL_NAME = MODEL_NAME;
  const storage = new SessionStorage({ root: sessionRoot });
  await storage.ensureRoot();

  const harness = {
    admitted: [],
    evaluated: [],
    stored: [],
    flushed: [],
    segments: [],
    historyAppended: [],
    failures: [],
    endpoint,
    storage,
    sessionRoot,
    sessionId: sessionId || `session-scribe-${Math.random().toString(36).slice(2, 10)}`,
    ownedDirectory: directory ? undefined : base
  };

  const seen = new Set();
  harness.graph = await InteractiveGraph.create(graphFile, {
    onMessage: (message) => {
      // The interactive runner reports a service line once when it is emitted and again when it
      // reaches a result-collector. The desktop host dedupes by message id; so does this harness.
      if (seen.has(message.message_id)) return;
      seen.add(message.message_id);
      if (message.message_type === 'scribe.batch-admitted') harness.admitted.push(message);
      if (message.message_type === 'scribe.batch-evaluated') harness.evaluated.push(message);
      if (message.message_type === 'logged-item.stored') harness.stored.push(message);
      if (message.message_type === 'scribe.session-flushed') harness.flushed.push(message);
      if (message.message_type === 'transcript.segment') harness.segments.push(message);
      if (message.message_type === 'logged-item.history-appended') harness.historyAppended.push(message);
      if (message.message_type === 'service.failure') harness.failures.push(message);
    },
    onStatus: (status) => { if (status.type === 'service-failure' || status.type === 'graph-failure') harness.failures.push(status); }
  });
  await harness.graph.start();
  await harness.graph.dispatchFrom('@desktop-controller', 'control', 'ai.provider-configure', harness.sessionId, {
    configuration: { version: 1, mode: 'local', provider: 'lm-studio', endpoint: endpoint.url, model: MODEL_NAME, protocol: 'openai-compatible', timeout_ms: 5000 },
    credential: { provided: false }
  }, `provider:${harness.sessionId}`);

  harness.record = async () => {
    await harness.graph.dispatchFrom('@desktop-controller', 'control', 'session.record', harness.sessionId, {
      operation_id: `record-${harness.sessionId}`, session_id: harness.sessionId, requested_at: new Date().toISOString()
    }, `record:${harness.sessionId}`);
    await harness.graph.waitForIdle();
  };

  // A session interrupted mid-recording is recovered the way the desktop host recovers it at
  // startup: the lifecycle owner stops the unclean recording, then Resume republishes the Scribe
  // policy and drives the governed recovery handshake.
  harness.resume = async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const metadata = await storage.readMetadata(harness.sessionId);
    if (metadata?.state === 'recording') {
      await harness.graph.dispatchFrom('@desktop-controller', 'control', 'session.stop', harness.sessionId, {
        operation_id: `startup-recovery-${harness.sessionId}-${suffix}`, session_id: harness.sessionId, requested_at: new Date().toISOString()
      }, `startup-recovery:${harness.sessionId}:${suffix}`);
      await harness.graph.waitForIdle();
    }
    await harness.graph.dispatchFrom('@desktop-controller', 'control', 'session.resume', harness.sessionId, {
      operation_id: `resume-${harness.sessionId}-${suffix}`, session_id: harness.sessionId, requested_at: new Date().toISOString()
    }, `resume:${harness.sessionId}:${suffix}`);
    await harness.graph.waitForIdle();
  };

  harness.finalizeRow = async (sequence) => {
    const utteranceId = `${harness.sessionId}-utterance-${sequence}`;
    const clock = (seconds) => `00:00:${String(seconds).padStart(2, '0')}.000`;
    await harness.graph.dispatchFrom('@desktop-controller', 'domain', 'transcript.word-committed', harness.sessionId, {
      word_id: `${harness.sessionId}-word-${sequence}`, session_id: harness.sessionId, utterance_id: utteranceId, sequence,
      start_time: clock(sequence), end_time: clock(sequence + 1), text: `evidence${sequence}`, confidence: 0.99,
      evidence: { provider: 'scribe-integration', chunk_ids: [`${harness.sessionId}-chunk-${sequence}`], alternatives: [] }
    }, `word:${harness.sessionId}:${sequence}`);
    await harness.graph.dispatchFrom('@desktop-controller', 'domain', 'transcript.utterance-boundary', harness.sessionId, {
      boundary_id: `${utteranceId}-boundary`, session_id: harness.sessionId, utterance_id: utteranceId, reason: 'pause',
      first_word_sequence: sequence, last_word_sequence: sequence, start_time: clock(sequence), end_time: clock(sequence + 1),
      punctuation_hint: 'statement', source_chunk_ids: [`${harness.sessionId}-chunk-${sequence}`]
    }, `boundary:${harness.sessionId}:${sequence}`);
  };

  // The governed Close the desktop host performs: ask Scribe to flush, wait for its terminal
  // acknowledgement, and only then seal the session through the lifecycle owner.
  // A Close attempt that may not even reach the coordinator: once a terminal Scribe failure has
  // failed the wires into it, delivery itself is refused, which is a distinct visible outcome
  // from an acknowledgement that says the flush could not complete.
  harness.closeAttempt = async () => {
    const requestId = `close-${Math.random().toString(36).slice(2, 10)}`;
    try {
      await harness.graph.dispatchFrom('@desktop-controller', 'control', 'scribe.session-closing', harness.sessionId, {
        session_id: harness.sessionId, request_id: requestId, requested_at: new Date().toISOString()
      }, `scribe-session-closing:${harness.sessionId}:${requestId}`);
    } catch (error) {
      return { delivered: false, requestId, code: error.code, message: error.message };
    }
    await harness.waitFor(() => harness.flushed.some((message) => message.payload.request_id === requestId), 'Scribe acknowledged the Close flush');
    return { delivered: true, requestId, acknowledgement: harness.flushed.find((message) => message.payload.request_id === requestId).payload };
  };
  harness.close = async () => {
    const requestId = `close-${Math.random().toString(36).slice(2, 10)}`;
    await harness.graph.dispatchFrom('@desktop-controller', 'control', 'scribe.session-closing', harness.sessionId, {
      session_id: harness.sessionId, request_id: requestId, requested_at: new Date().toISOString()
    }, `scribe-session-closing:${harness.sessionId}:${requestId}`);
    await harness.waitFor(() => harness.flushed.some((message) => message.payload.request_id === requestId), 'Scribe acknowledged the Close flush');
    const acknowledgement = harness.flushed.find((message) => message.payload.request_id === requestId).payload;
    if (!acknowledgement.accepted) return { sealed: false, acknowledgement };
    await harness.graph.dispatchFrom('@desktop-controller', 'control', 'session.close', harness.sessionId, {
      operation_id: `close-${harness.sessionId}`, session_id: harness.sessionId, requested_at: new Date().toISOString()
    }, `close:${harness.sessionId}`);
    await harness.graph.waitForIdle();
    return { sealed: true, acknowledgement };
  };
  // Sealing without the handshake, to prove the durable boundary refuses it independently. The
  // lifecycle owner rejects the operation, so the dispatch itself rejects.
  harness.sealDirectly = async () => {
    try {
      await harness.graph.dispatchFrom('@desktop-controller', 'control', 'session.close', harness.sessionId, {
        operation_id: `direct-close-${harness.sessionId}`, session_id: harness.sessionId, requested_at: new Date().toISOString()
      }, `direct-close:${harness.sessionId}`);
      await harness.graph.waitForIdle();
      return { refused: false };
    } catch (error) {
      return { refused: true, code: error.code, message: error.message };
    }
  };
  harness.metadata = () => storage.readMetadata(harness.sessionId);
  harness.checkpoint = () => storage.readScribeCheckpoint(harness.sessionId);
  // Observing `scribe.batch-evaluated` is not durable settlement: the cursor advances only after
  // the coordinator's checkpoint-persist/checkpoint-persisted handshake completes. Every durable
  // assertion waits for the persisted cursor rather than the message that precedes it.
  harness.waitForCursor = (sequence, label = `durable cursor ${sequence}`) =>
    harness.waitFor(async () => (await harness.checkpoint())?.admitted_through.last_sequence === sequence, label);
  harness.journal = () => storage.readScribeBatchJournal(harness.sessionId);
  harness.waitFor = (condition, label, timeoutMs = 20000) => waitFor(condition, label, timeoutMs, harness);
  // A crash is an abrupt stop, not a drain: draining would let the coordinator force its
  // remainder and settle, which is exactly the behavior a crash must not have.
  harness.crash = async () => {
    harness.graph.draining = true;
    harness.graph.stopProcesses();
    await new Promise((resolve) => setTimeout(resolve, 750));
    // A crash can happen while a model request is still open, and `server.close()` waits for
    // in-flight connections - so the endpoint is released without awaiting it.
    endpoint.close().catch(() => {});
  };
  harness.stop = async () => {
    await harness.graph.close().catch(() => {});
    await endpoint.close();
    if (harness.ownedDirectory) await rm(harness.ownedDirectory, { recursive: true, force: true });
  };
  return harness;
}

async function waitFor(condition, label, timeoutMs, harness) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const failures = harness.failures.map((item) => item.payload?.error?.message || item.message).join(' | ');
  const observed = `admitted=${harness.admitted.length} evaluated=${harness.evaluated.length} stored=${harness.stored.length} segments=${harness.segments.length} modelCalls=${harness.endpoint.calls.length}`;
  throw new Error(`Timed out waiting for ${label}; ${observed}${failures ? `; observed failures: ${failures}` : ''}`);
}

// The graph under test is the production graph with Whisper replaced by injected evidence. Every
// other service, wire, and durable owner is exactly what production runs, so the derivation is
// asserted rather than hand-maintained.
async function writeGraph(graphFile, { idleTimeoutMs }) {
  const definition = JSON.parse(await readFile(productionGraphFile, 'utf8'));
  definition.name = 'argus-scribe-integration';
  definition.contracts = path.join(root, 'contracts', 'catalog.json');
  definition.services = definition.services
    .filter((service) => service.id !== 'speech-to-text')
    .map((service) => ({ ...service, manifest: path.resolve(root, 'wiring', service.manifest) }));

  const controller = definition.runtime_components.find((component) => component.id === '@desktop-controller');
  controller.ports.domain.emits = ['transcript.word-committed', 'transcript.utterance-boundary', 'transcript.segment-update', 'logged-item.update'];
  const removed = (wire) => wire.from === 'speech-to-text' || wire.to === 'speech-to-text';
  definition.domain_wires = definition.domain_wires.filter((wire) => !removed(wire));
  definition.control_wires = definition.control_wires.filter((wire) => !removed(wire));
  definition.domain_wires.unshift(
    { from: '@desktop-controller', contract: 'transcript.word-committed', to: 'active-transcript' },
    { from: '@desktop-controller', contract: 'transcript.utterance-boundary', to: 'active-transcript' }
  );
  definition.run.configuration.scribe_policy.admission.idle_timeout_ms = idleTimeoutMs;
  definition.run.timeout_ms = 600000;
  await writeFile(graphFile, JSON.stringify(definition, null, 2), 'utf8');
  return definition;
}
