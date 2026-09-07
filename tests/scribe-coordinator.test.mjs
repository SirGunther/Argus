import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createEnvelope } from '../runtime/orchestrator.mjs';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { createScribeCoordinator } from '../services/scribe-coordinator/coordinator.mjs';
import { runService, runServiceBatches } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(root, 'services/scribe-coordinator/service.json');
const registry = await loadContractRegistry(path.join(root, 'contracts/catalog.json'));

// A fake, fully-controllable clock so idle-timer scenarios (up to 15,000 ms) run instantly.
// This is the only place a fake clock is used; index.mjs always uses real setTimeout/clearTimeout.
function createFakeClock(startMs = 1_700_000_000_000) {
  let currentMs = startMs;
  let nextId = 1;
  const timers = new Map();
  return {
    clock: {
      now: () => currentMs,
      setTimeout: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { fireAt: currentMs + Math.max(0, ms), fn });
        return id;
      },
      clearTimeout: (id) => { timers.delete(id); }
    },
    advance(ms) {
      currentMs += ms;
      for (;;) {
        let dueId;
        for (const [id, timer] of timers) {
          if (timer.fireAt <= currentMs) { dueId = id; break; }
        }
        if (dueId === undefined) break;
        const timer = timers.get(dueId);
        timers.delete(dueId);
        timer.fn();
      }
    },
    pendingTimerCount() { return timers.size; }
  };
}

function segment(sessionId, sequence, overrides = {}) {
  return {
    segment_id: `seg-${sequence}`,
    session_id: sessionId,
    sequence,
    start_time: `00:00:${String(sequence).padStart(2, '0')}.000`,
    end_time: `00:00:${String(sequence + 1).padStart(2, '0')}.000`,
    text: `Finalized row ${sequence}`,
    boundary: 'continuation',
    ...overrides
  };
}

function policy(sessionId, overrides = {}) {
  return {
    policy_id: 'test-policy',
    policy_version: '1.0.0',
    session_id: sessionId,
    admission: { rows_per_batch: 3, idle_timeout_ms: 15000, ...(overrides.admission || {}) },
    context: { max_total_context_tokens: 8000, ...(overrides.context || {}) },
    generation: { policy_profile: 'test-profile', instruction_version: '1.0.0', ...(overrides.generation || {}) }
  };
}

function admitThreeRows(coordinator, sessionId, startSequence = 0) {
  const outputs = [];
  for (let i = 0; i < 3; i += 1) outputs.push(...coordinator.acceptFinalizedSegment(segment(sessionId, startSequence + i)));
  const dispatch = outputs.find((output) => output.type === 'dispatch');
  assert.ok(dispatch, 'three rows must dispatch immediately');
  return dispatch;
}

function succeeded({ workId, sessionId, batchIdentity, attempt, items = [] }) {
  return {
    work_id: workId,
    workload: 'logged-item-extraction',
    session_id: sessionId,
    sequence: batchIdentity.last_sequence,
    attempt,
    completed_at: new Date().toISOString(),
    result: {
      status: 'succeeded',
      work_id: workId,
      request_fingerprint: `sha256:${'a'.repeat(64)}`,
      response: { protocol_version: '2.0.0', purpose: 'logged-item-extraction', batch_identity: batchIdentity, items }
    }
  };
}

function failed({ workId, sessionId, batchIdentity, attempt, error }) {
  return {
    work_id: workId,
    workload: 'logged-item-extraction',
    session_id: sessionId,
    sequence: batchIdentity.last_sequence,
    attempt,
    completed_at: new Date().toISOString(),
    result: { status: 'failed', work_id: workId, request_fingerprint: `sha256:${'a'.repeat(64)}`, error }
  };
}

function storedItem(sessionId, itemId, batchRequestId) {
  return {
    item_id: itemId,
    session_id: sessionId,
    stored_at: new Date().toISOString(),
    text: 'Stored item text.',
    revision: 0,
    source: { first_segment_id: 'seg-0', last_segment_id: 'seg-0', start_time: '00:00:00.000', end_time: '00:00:01.000' },
    generator: { implementation: 'log-extractor-local-http', input_window_id: batchRequestId }
  };
}

// --- Zero rows -------------------------------------------------------------

test('zero rows: an empty backlog admits nothing and starts no timer', () => {
  const { clock } = createFakeClock();
  const coordinator = createScribeCoordinator({ clock });
  const status = coordinator.status('s-empty');
  assert.equal(status.busy, false);
  assert.equal(status.pendingCount, 0);
  assert.equal(status.idleTimerActive, false);
});

// --- One/two rows before and after idle ------------------------------------

test('one pending row does not dispatch before the 15s idle threshold elapses', () => {
  const { clock, advance } = createFakeClock();
  const coordinator = createScribeCoordinator({ clock });
  coordinator.configurePolicy(policy('s1'));
  const outputs = coordinator.acceptFinalizedSegment(segment('s1', 0));
  assert.deepEqual(outputs, []);
  assert.equal(coordinator.status('s1').idleTimerActive, true);
  advance(14999);
  assert.equal(coordinator.status('s1').busy, false);
  assert.equal(coordinator.status('s1').pendingCount, 1);
});

test('a one-row remainder dispatches once the 15s idle threshold elapses', () => {
  const { clock, advance } = createFakeClock();
  const dispatched = [];
  const coordinator = createScribeCoordinator({ clock, onSpontaneousDispatch: (sessionId, outputs) => dispatched.push(...outputs) });
  coordinator.configurePolicy(policy('s1'));
  coordinator.acceptFinalizedSegment(segment('s1', 0));
  advance(15000);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'dispatch');
  assert.equal(dispatched[0].newEvidenceSegments.length, 1);
  assert.equal(dispatched[0].batchIdentity.admission_reason, 'idle-timeout');
  assert.equal(coordinator.status('s1').busy, true);
});

test('a two-row remainder dispatches once the 15s idle threshold elapses', () => {
  const { clock, advance } = createFakeClock();
  const dispatched = [];
  const coordinator = createScribeCoordinator({ clock, onSpontaneousDispatch: (sessionId, outputs) => dispatched.push(...outputs) });
  coordinator.configurePolicy(policy('s1'));
  coordinator.acceptFinalizedSegment(segment('s1', 0));
  coordinator.acceptFinalizedSegment(segment('s1', 1));
  advance(15000);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].newEvidenceSegments.length, 2);
  assert.equal(dispatched[0].batchIdentity.admission_reason, 'idle-timeout');
});

// --- Exactly three rows -----------------------------------------------------

test('exactly three rows are admitted immediately without waiting for the idle timer', () => {
  const { clock } = createFakeClock();
  const coordinator = createScribeCoordinator({ clock });
  coordinator.configurePolicy(policy('s1'));
  const dispatch = admitThreeRows(coordinator, 's1');
  assert.equal(dispatch.batchIdentity.admission_reason, 'batch-complete');
  assert.equal(dispatch.newEvidenceSegments.length, 3);
  assert.equal(coordinator.status('s1').busy, true);
  assert.equal(coordinator.status('s1').pendingCount, 0);
});

// --- Six-plus accumulating while busy + timer reset -------------------------

test('rows keep accumulating while busy and the next three admit immediately once free', () => {
  const { clock } = createFakeClock();
  const coordinator = createScribeCoordinator({ clock });
  coordinator.configurePolicy(policy('s1'));
  const firstDispatch = admitThreeRows(coordinator, 's1');
  for (let i = 3; i < 9; i += 1) {
    const outputs = coordinator.acceptFinalizedSegment(segment('s1', i));
    assert.deepEqual(outputs, [], 'no second batch may dispatch while one is in flight');
  }
  assert.equal(coordinator.status('s1').pendingCount, 6);
  const ackOutputs = coordinator.acceptWorkCompleted(succeeded({ workId: firstDispatch.workId, sessionId: 's1', batchIdentity: firstDispatch.batchIdentity, attempt: firstDispatch.attempt, items: [] }));
  const nextDispatch = ackOutputs.find((output) => output.type === 'dispatch');
  assert.ok(nextDispatch, 'an already-accumulated three-row group dispatches immediately after acknowledgement');
  assert.equal(nextDispatch.newEvidenceSegments.length, 3);
  assert.equal(coordinator.status('s1').pendingCount, 3);
});

test('the single idle timer is cancelled when a third row arrives before it elapses', () => {
  const { clock, advance, pendingTimerCount } = createFakeClock();
  const dispatched = [];
  const coordinator = createScribeCoordinator({ clock, onSpontaneousDispatch: (sessionId, outputs) => dispatched.push(...outputs) });
  coordinator.configurePolicy(policy('s1'));
  coordinator.acceptFinalizedSegment(segment('s1', 0));
  coordinator.acceptFinalizedSegment(segment('s1', 1));
  assert.equal(pendingTimerCount(), 1);
  const outputs = coordinator.acceptFinalizedSegment(segment('s1', 2));
  assert.equal(outputs.length, 1);
  assert.equal(pendingTimerCount(), 0, 'the third row must cancel the pending idle timer, not leave a second one running');
  advance(20000);
  assert.equal(dispatched.length, 0, 'a cancelled timer must never fire a stale spontaneous dispatch');
});

// --- Busy completion (zero-item outcome is its own acknowledgement) ---------

test('a zero-item outcome is its own acknowledgement and advances the cursor without waiting', () => {
  const { clock } = createFakeClock();
  const coordinator = createScribeCoordinator({ clock });
  coordinator.configurePolicy(policy('s1'));
  const dispatch = admitThreeRows(coordinator, 's1');
  const outputs = coordinator.acceptWorkCompleted(succeeded({ workId: dispatch.workId, sessionId: 's1', batchIdentity: dispatch.batchIdentity, attempt: dispatch.attempt, items: [] }));
  const evaluated = outputs.find((output) => output.type === 'evaluated');
  assert.equal(evaluated.acknowledgement.accepted, true);
  assert.deepEqual(evaluated.acknowledgement.logged_item_ids, []);
  assert.equal(coordinator.status('s1').cursor.last_sequence, 2);
  assert.equal(coordinator.status('s1').busy, false);
});

// --- Zero/multiple acknowledgement -------------------------------------------

test('the cursor stays unchanged until every evaluated item is acknowledged, then advances with ordered logged_item_ids', () => {
  const { clock } = createFakeClock();
  const coordinator = createScribeCoordinator({ clock });
  coordinator.configurePolicy(policy('s1'));
  const dispatch = admitThreeRows(coordinator, 's1');
  const completedOutputs = coordinator.acceptWorkCompleted(succeeded({
    workId: dispatch.workId, sessionId: 's1', batchIdentity: dispatch.batchIdentity, attempt: dispatch.attempt,
    items: [{ text: 'First item.', source_segment_ids: ['seg-0'] }, { text: 'Second item.', source_segment_ids: ['seg-1'] }]
  }));
  assert.deepEqual(completedOutputs, [], 'nothing advances until the item acknowledgements arrive');
  assert.equal(coordinator.status('s1').cursor.last_sequence, -1);
  const afterFirst = coordinator.acceptStoredItem(storedItem('s1', 'item-1', dispatch.batchIdentity.request_id));
  assert.deepEqual(afterFirst, []);
  assert.equal(coordinator.status('s1').cursor.last_sequence, -1, 'a partial acknowledgement must not advance the cursor');
  const afterSecond = coordinator.acceptStoredItem(storedItem('s1', 'item-2', dispatch.batchIdentity.request_id));
  const evaluated = afterSecond.find((output) => output.type === 'evaluated');
  assert.deepEqual(evaluated.acknowledgement.logged_item_ids, ['item-1', 'item-2']);
  assert.equal(coordinator.status('s1').cursor.last_sequence, 2);
});

test('a stale or unrelated stored-item acknowledgement is rejected without mutating the cursor', () => {
  const { clock } = createFakeClock();
  const coordinator = createScribeCoordinator({ clock });
  coordinator.configurePolicy(policy('s1'));
  const dispatch = admitThreeRows(coordinator, 's1');
  coordinator.acceptWorkCompleted(succeeded({ workId: dispatch.workId, sessionId: 's1', batchIdentity: dispatch.batchIdentity, attempt: dispatch.attempt, items: [{ text: 'Only item.', source_segment_ids: ['seg-0'] }] }));
  assert.throws(() => coordinator.acceptStoredItem(storedItem('s1', 'item-x', 'some-other-request-id')), /No Scribe batch is awaiting/);
  assert.equal(coordinator.status('s1').cursor.last_sequence, -1);
  assert.equal(coordinator.status('s1').busy, true, 'the real in-flight batch must remain intact after rejecting the unrelated acknowledgement');
});

// --- Duplicate delivery ------------------------------------------------------

test('a duplicate finalized segment is idempotent and does not double-admit', () => {
  const { clock } = createFakeClock();
  const coordinator = createScribeCoordinator({ clock });
  coordinator.configurePolicy(policy('s1'));
  const row = segment('s1', 0);
  coordinator.acceptFinalizedSegment(row);
  const duplicateOutputs = coordinator.acceptFinalizedSegment({ ...row });
  assert.deepEqual(duplicateOutputs, []);
  assert.equal(coordinator.status('s1').pendingCount, 1);
});

test('a duplicate stored-item acknowledgement is idempotent and does not double-count', () => {
  const { clock } = createFakeClock();
  const coordinator = createScribeCoordinator({ clock });
  coordinator.configurePolicy(policy('s1'));
  const dispatch = admitThreeRows(coordinator, 's1');
  coordinator.acceptWorkCompleted(succeeded({ workId: dispatch.workId, sessionId: 's1', batchIdentity: dispatch.batchIdentity, attempt: dispatch.attempt, items: [{ text: 'a', source_segment_ids: ['seg-0'] }, { text: 'b', source_segment_ids: ['seg-1'] }] }));
  const first = coordinator.acceptStoredItem(storedItem('s1', 'item-1', dispatch.batchIdentity.request_id));
  assert.deepEqual(first, []);
  const duplicate = coordinator.acceptStoredItem(storedItem('s1', 'item-1', dispatch.batchIdentity.request_id));
  assert.deepEqual(duplicate, [], 'a redelivered confirmation for an already-recorded item must be a no-op, not an error');
  assert.equal(coordinator.status('s1').inFlight.awaitingAck.storedItemIds.length, 1);
});

// --- Failure/retry -----------------------------------------------------------

test('a failed batch retains its exact segments and re-dispatches the identical batch identity', () => {
  const { clock } = createFakeClock();
  const coordinator = createScribeCoordinator({ clock });
  coordinator.configurePolicy(policy('s1'));
  const dispatch1 = admitThreeRows(coordinator, 's1');
  const afterFailure = coordinator.acceptWorkCompleted(failed({
    workId: dispatch1.workId, sessionId: 's1', batchIdentity: dispatch1.batchIdentity, attempt: dispatch1.attempt,
    error: { code: 'MODEL_ENDPOINT_TIMEOUT', category: 'timeout', message: 'model endpoint timed out', retryable: true }
  }));
  const failureDescriptor = afterFailure.find((output) => output.type === 'failure');
  assert.equal(failureDescriptor.error.code, 'MODEL_ENDPOINT_TIMEOUT');
  const retryDispatch = afterFailure.find((output) => output.type === 'dispatch');
  assert.ok(retryDispatch, 'a retryable failure must immediately re-dispatch the identical batch');
  assert.equal(retryDispatch.batchIdentity.request_id, dispatch1.batchIdentity.request_id);
  assert.deepEqual(retryDispatch.newEvidenceSegments.map((s) => s.segment_id), dispatch1.newEvidenceSegments.map((s) => s.segment_id));
  assert.equal(retryDispatch.attempt, 2);
  assert.notEqual(retryDispatch.workId, dispatch1.workId);
  assert.equal(coordinator.status('s1').cursor.last_sequence, -1, 'a failure must never mutate the cursor');
});

test('repeated terminal failures stall the batch after the retry ceiling without losing its pending rows', () => {
  const { clock } = createFakeClock();
  const coordinator = createScribeCoordinator({ clock });
  coordinator.configurePolicy(policy('s1'));
  let dispatch = admitThreeRows(coordinator, 's1');
  let lastOutputs;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    lastOutputs = coordinator.acceptWorkCompleted(failed({ workId: dispatch.workId, sessionId: 's1', batchIdentity: dispatch.batchIdentity, attempt: dispatch.attempt, error: { code: 'MODEL_ENDPOINT_UNAVAILABLE', category: 'unavailable', message: 'unavailable', retryable: true } }));
    dispatch = lastOutputs.find((output) => output.type === 'dispatch');
  }
  assert.equal(dispatch, undefined, 'the coordinator must stop auto-retrying once the dispatch ceiling is reached');
  assert.equal(coordinator.status('s1').stalled, true);
  assert.equal(coordinator.status('s1').busy, false);
  assert.equal(coordinator.status('s1').pendingCount, 3, 'the exact same three rows must remain pending, not lost');
});

// --- Restart state -----------------------------------------------------------

test('recovered cursor and pending remainder resume idle-based eligibility after a restart', () => {
  const { clock, advance } = createFakeClock();
  const dispatched = [];
  const coordinator = createScribeCoordinator({ clock, onSpontaneousDispatch: (sessionId, outputs) => dispatched.push(...outputs) });
  coordinator.configurePolicy(policy('s1'));
  const outputs = coordinator.restoreState('s1', {
    cursor: { last_segment_id: 'seg-1', last_sequence: 1, last_revision: 0 },
    pendingSegments: [segment('s1', 2)],
    accumulatedSinceMs: clock.now() - 10000
  });
  assert.deepEqual(outputs, []);
  assert.equal(coordinator.status('s1').cursor.last_sequence, 1);
  assert.equal(coordinator.status('s1').pendingCount, 1);
  advance(5000);
  assert.equal(dispatched.length, 1, 'idle elapsed relative to the recovered accumulated-since time must still trigger admission');
  assert.equal(dispatched[0].batchIdentity.admission_reason, 'idle-timeout');
});

test('recovery is rejected as conflicting once the coordinator already has live state for that session', () => {
  const { clock } = createFakeClock();
  const coordinator = createScribeCoordinator({ clock });
  coordinator.configurePolicy(policy('s1'));
  coordinator.acceptFinalizedSegment(segment('s1', 0));
  assert.throws(() => coordinator.restoreState('s1', { cursor: { last_segment_id: null, last_sequence: -1, last_revision: 0 }, pendingSegments: [] }), /already has coordinator state/);
});

// --- Stop --------------------------------------------------------------------

test('Stop leaves pending rows, cursor, and timers exactly as they were', () => {
  const { clock } = createFakeClock();
  const coordinator = createScribeCoordinator({ clock });
  coordinator.configurePolicy(policy('s1'));
  coordinator.acceptFinalizedSegment(segment('s1', 0));
  const before = coordinator.status('s1');
  const outputs = coordinator.stop('s1');
  assert.deepEqual(outputs, []);
  assert.deepEqual(coordinator.status('s1'), before);
});

// --- Close and drain -----------------------------------------------------------

test('Close forces a pending remainder and settles only after its terminal acknowledgement', async () => {
  const { clock } = createFakeClock();
  const coordinator = createScribeCoordinator({ clock });
  coordinator.configurePolicy(policy('s1'));
  coordinator.acceptFinalizedSegment(segment('s1', 0));
  const { outputs, settled } = coordinator.close('s1');
  const dispatch = outputs.find((output) => output.type === 'dispatch');
  assert.ok(dispatch, 'Close must force the pending remainder even though idle has not elapsed');
  assert.equal(dispatch.batchIdentity.admission_reason, 'idle-timeout');
  let settledFlag = false;
  settled.then(() => { settledFlag = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settledFlag, false, 'settled must wait for the terminal outcome, not resolve as soon as the remainder is released');
  coordinator.acceptWorkCompleted(succeeded({ workId: dispatch.workId, sessionId: 's1', batchIdentity: dispatch.batchIdentity, attempt: dispatch.attempt, items: [] }));
  await settled;
  assert.equal(coordinator.status('s1').cursor.last_sequence, 0);
});

test('Close with an empty backlog settles immediately', async () => {
  const { clock } = createFakeClock();
  const coordinator = createScribeCoordinator({ clock });
  const { outputs, settled } = coordinator.close('s-empty');
  assert.deepEqual(outputs, []);
  await settled;
});

// --- Wire-level contract compliance (real process, real timers) --------------

test('the real coordinator process answers a health-check', async () => {
  const start = createEnvelope({ plane: 'control', messageType: 'lifecycle.health-check', producer: 'contract-test', correlationId: 'c1', payload: { probe_id: 'p1' } });
  const result = await runService(MANIFEST, [start], 1);
  assert.equal(result.outputs[0].message_type, 'service.health');
  assert.deepEqual(registry.validateEnvelope(result.outputs[0]), []);
});

test('three real finalized rows independently emit a valid, contract-compliant batch ai.work-request', async () => {
  const sessionId = 'contract-session';
  const inputs = [0, 1, 2].map((sequence) => createEnvelope({ plane: 'domain', messageType: 'transcript.segment', producer: 'contract-test', correlationId: sessionId, payload: segment(sessionId, sequence) }));
  const result = await runService(MANIFEST, inputs, 4, 2000, { env: { ARGUS_MODEL_NAME: 'test-model' } });
  const request = result.outputs.find((message) => message.message_type === 'ai.work-request');
  assert.ok(request, 'a batch-complete admission must emit ai.work-request');
  assert.deepEqual(registry.validateEnvelope(request), []);
  assert.equal(request.payload.input.model_request.protocol_version, '2.0.0');
  assert.equal(request.payload.input.model_request.batch_identity.admission_reason, 'batch-complete');
  assert.equal(request.payload.input.model_request.new_evidence_segments.length, 3);
  const completions = result.outputs.filter((message) => message.message_type === 'operation.completed');
  assert.equal(completions.length, 3, 'every accepted finalized segment must complete its own operation');
});

test('a malformed finalized segment converts into a contract-valid service.failure, not a crash', async () => {
  const invalid = createEnvelope({ plane: 'domain', messageType: 'transcript.segment', producer: 'contract-test', correlationId: 'c1', payload: { ...segment('c1', 0), text: '' } });
  const result = await runService(MANIFEST, [invalid], 1);
  assert.equal(result.outputs[0].message_type, 'service.failure');
  assert.deepEqual(registry.validateEnvelope(result.outputs[0]), []);
});

test('Close over the wire (lifecycle.drain) releases the pending remainder and drains', async () => {
  const sessionId = 'drain-session';
  const segmentInput = createEnvelope({ plane: 'domain', messageType: 'transcript.segment', producer: 'contract-test', correlationId: sessionId, payload: segment(sessionId, 0) });
  const drainInput = createEnvelope({ plane: 'control', messageType: 'lifecycle.drain', producer: 'contract-test', correlationId: sessionId, payload: {} });
  const result = await runServiceBatches(MANIFEST, [
    { inputs: [segmentInput], expectedOutputCount: 1 },
    { inputs: [drainInput], expectedOutputCount: 2 }
  ], 2000, { env: { ARGUS_MODEL_NAME: 'test-model' } });
  const request = result.outputs.find((message) => message.message_type === 'ai.work-request');
  const drained = result.outputs.find((message) => message.message_type === 'service.drained');
  assert.ok(request, 'Close must force the one-row remainder rather than discard it');
  assert.equal(request.payload.input.model_request.batch_identity.admission_reason, 'idle-timeout');
  assert.ok(drained);
  assert.deepEqual(registry.validateEnvelope(request), []);
  assert.deepEqual(registry.validateEnvelope(drained), []);
});
