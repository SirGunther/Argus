import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createEnvelope } from '../runtime/orchestrator.mjs';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { OrderedStreamGuard } from '../runtime/ordered-stream.mjs';
import { createScribeCoordinator, ScribeBatchStalledError } from '../services/scribe-coordinator/coordinator.mjs';
import { runService, runServiceBatches } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(root, 'services/scribe-coordinator/service.json');
const registry = await loadContractRegistry(path.join(root, 'contracts/catalog.json'));

function createFakeClock(startMs = 1_700_000_000_000) {
  let currentMs = startMs;
  let nextId = 1;
  const timers = new Map();
  return {
    clock: {
      now: () => currentMs,
      setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fireAt: currentMs + Math.max(0, ms), fn }); return id; },
      clearTimeout: (id) => timers.delete(id)
    },
    advance(ms) {
      currentMs += ms;
      for (;;) {
        const due = [...timers].find(([, timer]) => timer.fireAt <= currentMs);
        if (!due) break;
        timers.delete(due[0]);
        due[1].fn();
      }
    },
    pendingTimerCount: () => timers.size
  };
}

function segment(sessionId, sequence, overrides = {}) {
  return {
    segment_id: `seg-${sequence}`,
    revision: 0,
    session_id: sessionId,
    sequence,
    start_time: `00:00:${String(sequence).padStart(2, '0')}.000`,
    end_time: `00:00:${String(sequence + 1).padStart(2, '0')}.000`,
    text: `Finalized row ${sequence}`,
    boundary: 'continuation',
    ...overrides
  };
}

function policy(sessionId) {
  return {
    policy_id: 'test-policy', policy_version: '1.0.0', session_id: sessionId,
    admission: { rows_per_batch: 3, idle_timeout_ms: 15000 },
    context: { max_total_context_tokens: 8000 },
    generation: { policy_profile: 'test-profile', instruction_version: '1.0.0' }
  };
}

function admit(coordinator, sessionId, count = 3, startSequence = 0) {
  const outputs = [];
  for (let index = 0; index < count; index += 1) outputs.push(...coordinator.acceptFinalizedSegment(segment(sessionId, startSequence + index)));
  return outputs.find((output) => output.type === 'batch-admitted');
}

function evaluated(dispatch, { items = [], loggedItemIds, outcome, accepted = true, error } = {}) {
  const actualOutcome = outcome || (items.length ? 'items-recorded' : 'empty-evaluated');
  const ids = loggedItemIds ?? items.map((_item, index) => `logged-item-${index}`);
  return {
    batch_attempt: dispatch.batchAttempt,
    batch: {
      batch_identity: structuredClone(dispatch.batchIdentity),
      evaluated_at: '2026-09-08T12:00:00.000Z',
      attempt: dispatch.batchAttempt,
      outcome: actualOutcome,
      items: structuredClone(items),
      ...(actualOutcome === 'failed' ? { error: error || { code: 'MODEL_FAILED', category: 'dependency', message: 'failed', retryable: false } } : {}),
      acknowledgement: {
        ack_id: `${dispatch.batchIdentity.request_id}:a${dispatch.batchAttempt}`,
        accepted: actualOutcome === 'failed' ? false : accepted,
        acknowledged_at: actualOutcome === 'failed' || !accepted ? null : '2026-09-08T12:00:01.000Z',
        logged_item_ids: actualOutcome === 'failed' || !accepted ? [] : ids
      }
    }
  };
}

test('zero, partial-idle, and exactly-three admission are deterministic', () => {
  const time = createFakeClock();
  const spontaneous = [];
  const coordinator = createScribeCoordinator({ clock: time.clock, onSpontaneousDispatch: (_session, outputs) => spontaneous.push(...outputs) });
  assert.deepEqual(coordinator.status('s0'), { busy: false, pendingCount: 0, cursor: { last_segment_id: null, last_sequence: -1, last_revision: 0 }, idleTimerActive: false, closing: false, stalled: false, retainedSegmentFingerprints: 0, backgroundTranscriptCount: 0, backgroundItemCount: 0, pendingComplete: true, inFlight: undefined });
  coordinator.configurePolicy(policy('s1'));
  assert.deepEqual(coordinator.acceptFinalizedSegment(segment('s1', 0)), []);
  time.advance(14999);
  assert.equal(spontaneous.length, 0);
  time.advance(1);
  assert.equal(spontaneous[0].batchIdentity.admission_reason, 'idle-timeout');
  assert.equal(spontaneous[0].newEvidenceSegments[0].revision, 0);

  const full = createScribeCoordinator({ clock: createFakeClock().clock });
  const dispatch = admit(full, 's2');
  assert.equal(dispatch.batchIdentity.admission_reason, 'batch-complete');
  assert.equal(dispatch.batchAttempt, 1);
  assert.equal(Object.hasOwn(dispatch, 'model'), false);
  assert.equal(Object.hasOwn(dispatch, 'workId'), false);
});

test('two rows idle together and a third row cancels the single idle timer', () => {
  const time = createFakeClock();
  const spontaneous = [];
  const coordinator = createScribeCoordinator({ clock: time.clock, onSpontaneousDispatch: (_session, outputs) => spontaneous.push(...outputs) });
  coordinator.acceptFinalizedSegment(segment('s1', 0));
  coordinator.acceptFinalizedSegment(segment('s1', 1));
  assert.equal(time.pendingTimerCount(), 1);
  const outputs = coordinator.acceptFinalizedSegment(segment('s1', 2));
  assert.equal(outputs[0].type, 'batch-admitted');
  assert.equal(time.pendingTimerCount(), 0);
  time.advance(15000);
  assert.equal(spontaneous.length, 0);
});

test('busy accumulation admits the next batch immediately, including already-idle remainder', () => {
  const time = createFakeClock();
  const coordinator = createScribeCoordinator({ clock: time.clock });
  const first = admit(coordinator, 's1');
  coordinator.acceptFinalizedSegment(segment('s1', 3));
  coordinator.acceptFinalizedSegment(segment('s1', 4));
  coordinator.acceptFinalizedSegment(segment('s1', 5));
  const outputs = coordinator.acceptBatchEvaluated(evaluated(first));
  const second = outputs.find((output) => output.type === 'batch-admitted');
  assert.equal(second.batchIdentity.first_sequence, 3);
  coordinator.acceptFinalizedSegment(segment('s1', 6));
  time.advance(15000);
  const next = coordinator.acceptBatchEvaluated(evaluated(second)).find((output) => output.type === 'batch-admitted');
  assert.equal(next.batchIdentity.first_sequence, 6);
  assert.equal(next.batchIdentity.admission_reason, 'idle-timeout');
});

test('only a final accepted evaluated batch advances the cursor and item IDs stay ordered', () => {
  const coordinator = createScribeCoordinator({ clock: createFakeClock().clock });
  const dispatch = admit(coordinator, 's1');
  const items = [
    { text: 'First.', source_segment_ids: ['seg-0'] },
    { text: 'Second.', source_segment_ids: ['seg-1'] }
  ];
  assert.throws(() => coordinator.acceptBatchEvaluated(evaluated(dispatch, { items, accepted: false })), /must acknowledge every item exactly once/);
  assert.equal(coordinator.status('s1').cursor.last_sequence, -1);
  coordinator.acceptBatchEvaluated(evaluated(dispatch, { items, loggedItemIds: ['item-first', 'item-second'] }));
  assert.equal(coordinator.status('s1').cursor.last_sequence, 2);
  assert.equal(coordinator.status('s1').backgroundItemCount, 2);
});

test('mismatched identity or coordinator batch_attempt is non-destructive', () => {
  const coordinator = createScribeCoordinator({ clock: createFakeClock().clock });
  const dispatch = admit(coordinator, 's1');
  const wrongIdentity = evaluated(dispatch);
  wrongIdentity.batch.batch_identity.request_id = 'forged';
  assert.throws(() => coordinator.acceptBatchEvaluated(wrongIdentity), /does not match the exact in-flight batch/);
  const wrongAttempt = evaluated(dispatch);
  wrongAttempt.batch_attempt = 2;
  wrongAttempt.batch.attempt = 2;
  assert.throws(() => coordinator.acceptBatchEvaluated(wrongAttempt), /does not match in-flight batch attempt/);
  assert.equal(coordinator.status('s1').inFlight.requestId, dispatch.batchIdentity.request_id);
  coordinator.acceptBatchEvaluated(evaluated(dispatch));
  assert.equal(coordinator.status('s1').cursor.last_sequence, 2);
});

test('successful and failed duplicate evaluations are idempotent but conflicting replays fail', () => {
  const coordinator = createScribeCoordinator({ clock: createFakeClock().clock });
  const dispatch = admit(coordinator, 's1');
  const success = evaluated(dispatch);
  coordinator.acceptBatchEvaluated(success);
  assert.deepEqual(coordinator.acceptBatchEvaluated(success), []);
  const conflict = structuredClone(success);
  conflict.batch.evaluated_at = '2026-09-08T13:00:00.000Z';
  assert.throws(() => coordinator.acceptBatchEvaluated(conflict), /different content/);

  const stalledCoordinator = createScribeCoordinator({ clock: createFakeClock().clock });
  const stalled = admit(stalledCoordinator, 's2');
  const failure = evaluated(stalled, { outcome: 'failed' });
  assert.equal(stalledCoordinator.acceptBatchEvaluated(failure)[0].type, 'failure');
  assert.deepEqual(stalledCoordinator.acceptBatchEvaluated(failure), []);
});

test('terminal evaluated failure stalls the exact batch with no outer retry or cursor advance', async () => {
  const coordinator = createScribeCoordinator({ clock: createFakeClock().clock });
  const dispatch = admit(coordinator, 's1');
  const close = coordinator.close('s1');
  const outputs = coordinator.acceptBatchEvaluated(evaluated(dispatch, { outcome: 'failed' }));
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].type, 'failure');
  assert.equal(outputs.some((output) => output.type === 'batch-admitted'), false);
  assert.equal(coordinator.status('s1').cursor.last_sequence, -1);
  assert.equal(coordinator.status('s1').stalled, true);
  assert.equal(coordinator.status('s1').inFlight.requestId, dispatch.batchIdentity.request_id);
  await assert.rejects(close.settled, ScribeBatchStalledError);
  await assert.rejects(coordinator.close('s1').settled, /stalled with rows still pending/);
});

test('Stop preserves state while Close forces a remainder and waits for settlement', async () => {
  const coordinator = createScribeCoordinator({ clock: createFakeClock().clock });
  coordinator.acceptFinalizedSegment(segment('s1', 0));
  const before = coordinator.status('s1');
  assert.deepEqual(coordinator.stop('s1'), []);
  assert.deepEqual(coordinator.status('s1'), before);
  const closing = coordinator.close('s1');
  assert.equal(closing.outputs[0].type, 'batch-admitted');
  assert.equal(closing.outputs[0].batchIdentity.admission_reason, 'idle-timeout');
  let settled = false;
  closing.settled.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  coordinator.acceptBatchEvaluated(evaluated(closing.outputs[0]));
  await closing.settled;
  assert.equal(coordinator.status('s1').cursor.last_sequence, 0);

  const empty = coordinator.close('empty');
  assert.deepEqual(empty.outputs, []);
  await empty.settled;
});

test('recovery seeds ordering and redispatches the exact immutable in-flight batch attempt', () => {
  const original = createScribeCoordinator({ clock: createFakeClock().clock });
  const dispatch = admit(original, 's1');
  const snapshot = {
    cursor: { last_segment_id: null, last_sequence: -1, last_revision: 0 },
    pendingSegments: [],
    accumulatedSinceMs: null,
    backgroundContext: { transcript_segments: [], prior_logged_items: [] },
    inFlightBatch: {
      batchIdentity: dispatch.batchIdentity,
      admittedSegments: [segment('s1', 0), segment('s1', 1), segment('s1', 2)],
      attempt: dispatch.batchAttempt,
      dispatchedAtIso: '2026-09-08T12:00:00.000Z'
    }
  };
  const recovered = createScribeCoordinator({ clock: createFakeClock().clock });
  const replay = recovered.restoreState('s1', snapshot)[0];
  assert.deepEqual(replay.batchIdentity, dispatch.batchIdentity);
  assert.equal(replay.batchAttempt, dispatch.batchAttempt);
  assert.deepEqual(recovered.acceptFinalizedSegment(segment('s1', 2)), []);
  recovered.acceptFinalizedSegment(segment('s1', 3));
  recovered.acceptBatchEvaluated(evaluated(replay));
  assert.equal(recovered.status('s1').cursor.last_sequence, 2);
});

test('recovered pending remainder resumes idle eligibility and live-state recovery conflicts', () => {
  const time = createFakeClock();
  const spontaneous = [];
  const coordinator = createScribeCoordinator({ clock: time.clock, onSpontaneousDispatch: (_session, outputs) => spontaneous.push(...outputs) });
  coordinator.restoreState('s1', {
    cursor: { last_segment_id: 'seg-1', last_sequence: 1, last_revision: 0 },
    pendingSegments: [segment('s1', 2)],
    accumulatedSinceMs: time.clock.now(),
    backgroundContext: { transcript_segments: [], prior_logged_items: [] }
  });
  coordinator.acceptFinalizedSegment(segment('s1', 3));
  time.advance(15000);
  assert.equal(spontaneous[0].batchIdentity.first_sequence, 2);
  assert.throws(() => coordinator.restoreState('s1', { cursor: { last_sequence: -1 }, pendingSegments: [] }), /already has coordinator state/);
});

test('explicit recovery and durable checkpoint acknowledgements gate admission and cursor advancement', () => {
  const coordinator = createScribeCoordinator({ clock: createFakeClock().clock, requireRecovery: true, requirePersistence: true });
  const configured = coordinator.configurePolicy(policy('s1'));
  assert.deepEqual(configured.map((output) => output.type), ['recovery-request']);
  assert.throws(() => coordinator.acceptFinalizedSegment(segment('s1', 0)), (error) => error.code === 'SCRIBE_RECOVERY_REQUIRED');

  assert.deepEqual(coordinator.acceptRecoveryRestored({
    session_id: 's1', policy_id: 'test-policy', policy_version: '1.0.0', recovered_at: '2026-09-08T11:59:00.000Z',
    checkpoint: null, pending_segments: [], in_flight_segments: [], background_transcript_segments: []
  }), []);
  let persistence;
  for (let sequence = 0; sequence < 3; sequence += 1) {
    const outputs = coordinator.acceptFinalizedSegment(segment('s1', sequence));
    persistence ||= outputs.find((output) => output.type === 'checkpoint-persist');
  }
  assert.ok(persistence);
  assert.equal(persistence.transition, 'batch-admitted');
  assert.equal(coordinator.status('s1').cursor.last_sequence, -1);
  assert.equal(coordinator.status('s1').busy, true);

  const { type: _admissionType, ...admissionAck } = persistence;
  const admitted = coordinator.acceptCheckpointPersisted(admissionAck)[0];
  assert.equal(admitted.type, 'batch-admitted');
  const evaluationPersistence = coordinator.acceptBatchEvaluated(evaluated(admitted))[0];
  assert.equal(evaluationPersistence.type, 'checkpoint-persist');
  assert.equal(evaluationPersistence.transition, 'batch-evaluated');
  assert.equal(coordinator.status('s1').cursor.last_sequence, -1, 'evaluation is not final before journal/checkpoint acknowledgement');

  const conflictingAck = structuredClone(evaluationPersistence);
  conflictingAck.checkpoint.saved_at = '2026-09-08T12:00:02.000Z';
  delete conflictingAck.type;
  assert.throws(() => coordinator.acceptCheckpointPersisted(conflictingAck), (error) => error.code === 'SCRIBE_PERSISTENCE_ACK_CONFLICT');
  assert.equal(coordinator.status('s1').cursor.last_sequence, -1);

  const { type: _evaluationType, ...evaluationAck } = evaluationPersistence;
  const settled = coordinator.acceptCheckpointPersisted(evaluationAck);
  assert.equal(settled[0].type, 'settled');
  assert.equal(coordinator.status('s1').cursor.last_sequence, 2);
  assert.equal(coordinator.status('s1').busy, false);
  assert.deepEqual(coordinator.acceptCheckpointPersisted(evaluationAck), []);
});

test('session, pending-row, remembered identity, context, and close-waiter state are bounded', () => {
  const sessions = createScribeCoordinator({ maxSessions: 1, clock: createFakeClock().clock });
  sessions.status('s1');
  assert.throws(() => sessions.status('s2'), /session capacity reached/);

  const pending = createScribeCoordinator({ maxPendingSegments: 3, clock: createFakeClock().clock });
  const dispatch = admit(pending, 's1');
  assert.throws(() => pending.acceptFinalizedSegment(segment('s1', 3)), /pending segment capacity reached/);
  assert.ok(pending.status('s1').retainedSegmentFingerprints <= 67);
  assert.equal(dispatch.newEvidenceSegments.length, 3);
});

test('OrderedStreamGuard.seed cannot rewind a stream', () => {
  const guard = new OrderedStreamGuard();
  guard.seed('s1', 3);
  assert.throws(() => guard.seed('s1', 2), /cannot be seeded backward/);
  guard.accept('s1', 3);
});

test('the real coordinator process recovers and durably gates a provider-neutral admitted batch', async () => {
  const sessionId = 'contract-session';
  const result = await runServiceBatches(MANIFEST, [
    { inputs: [policyEnvelope(sessionId)], expectedOutputCount: 2 },
    { inputs: [emptyRecoveryEnvelope(sessionId)], expectedOutputCount: 1 },
    {
      inputs: [0, 1, 2].map((sequence) => createEnvelope({ plane: 'domain', messageType: 'transcript.segment', producer: 'contract-test', correlationId: sessionId, payload: segment(sessionId, sequence) })),
      expectedOutputCount: 4
    },
    {
      inputs: (outputs) => [persistenceAckEnvelope(outputs.find((message) => message.message_type === 'scribe.checkpoint-persist'))],
      expectedOutputCount: 2
    }
  ]);
  const persisted = result.outputs.find((message) => message.message_type === 'scribe.checkpoint-persist');
  const admitted = result.outputs.find((message) => message.message_type === 'scribe.batch-admitted');
  assert.ok(persisted, 'admission checkpoint must be requested before publication');
  assert.equal(result.outputs.indexOf(persisted) < result.outputs.indexOf(admitted), true);
  assert.ok(admitted);
  assert.deepEqual(registry.validateEnvelope(admitted), []);
  assert.equal(admitted.payload.batch_attempt, 1);
  assert.equal(admitted.payload.new_evidence_segments.length, 3);
  assert.equal(/model|provider|endpoint/.test(JSON.stringify(admitted.payload)), false);
  assert.equal(result.outputs.filter((message) => message.message_type === 'operation.completed').length, 6);
});

test('the real coordinator answers health and converts malformed rows to contract-valid failure', async () => {
  const health = createEnvelope({ plane: 'control', messageType: 'lifecycle.health-check', producer: 'contract-test', correlationId: 'c1', payload: { probe_id: 'p1' } });
  const healthResult = await runService(MANIFEST, [health], 1);
  assert.equal(healthResult.outputs[0].message_type, 'service.health');
  assert.deepEqual(registry.validateEnvelope(healthResult.outputs[0]), []);

  const invalid = createEnvelope({ plane: 'domain', messageType: 'transcript.segment', producer: 'contract-test', correlationId: 'c1', payload: { ...segment('c1', 0), text: '' } });
  const invalidResult = await runService(MANIFEST, [invalid], 1);
  assert.equal(invalidResult.outputs[0].message_type, 'service.failure');
  assert.deepEqual(registry.validateEnvelope(invalidResult.outputs[0]), []);
});

test('wire Close emits a forced admission and drains only after final evaluation', async () => {
  const sessionId = 'drain-session';
  const row = createEnvelope({ plane: 'domain', messageType: 'transcript.segment', producer: 'contract-test', correlationId: sessionId, payload: segment(sessionId, 0) });
  const drain = createEnvelope({ plane: 'control', messageType: 'lifecycle.drain', producer: 'contract-test', correlationId: sessionId, payload: {} });
  const result = await runServiceBatches(MANIFEST, [
    { inputs: [policyEnvelope(sessionId)], expectedOutputCount: 2 },
    { inputs: [emptyRecoveryEnvelope(sessionId)], expectedOutputCount: 1 },
    { inputs: [row], expectedOutputCount: 1 },
    { inputs: [drain], expectedOutputCount: 1 },
    {
      inputs: (outputs) => [persistenceAckEnvelope(outputs.find((message) => message.message_type === 'scribe.checkpoint-persist' && message.payload.transition === 'batch-admitted'))],
      expectedOutputCount: 2
    },
    {
      inputs: (outputs) => {
        const admitted = outputs.find((message) => message.message_type === 'scribe.batch-admitted');
        const descriptor = { batchIdentity: admitted.payload.batch_identity, batchAttempt: admitted.payload.batch_attempt };
        return [createEnvelope({
          plane: 'domain', messageType: 'scribe.batch-evaluated', producer: 'contract-test', correlationId: sessionId,
          schemaVersion: '1.0.0', payload: evaluated(descriptor)
        })];
      },
      expectedOutputCount: 2
    },
    {
      inputs: (outputs) => [persistenceAckEnvelope(outputs.find((message) => message.message_type === 'scribe.checkpoint-persist' && message.payload.transition === 'batch-evaluated'))],
      expectedOutputCount: 2
    }
  ]);
  const admitted = result.outputs.find((message) => message.message_type === 'scribe.batch-admitted');
  assert.equal(admitted.payload.batch_identity.admission_reason, 'idle-timeout');
  assert.ok(result.outputs.find((message) => message.message_type === 'service.drained'));
  for (const output of result.outputs) assert.deepEqual(registry.validateEnvelope(output), [], output.message_type);
});

function policyEnvelope(sessionId) {
  return createEnvelope({
    plane: 'control', messageType: 'scribe.batch-policy', producer: 'contract-test', correlationId: sessionId,
    schemaVersion: '1.0.0', payload: policy(sessionId)
  });
}

function emptyRecoveryEnvelope(sessionId) {
  return createEnvelope({
    plane: 'control', messageType: 'scribe.recovery-restored', producer: 'session-lifecycle-controller', correlationId: sessionId,
    schemaVersion: '1.0.0', payload: {
      session_id: sessionId, policy_id: 'test-policy', policy_version: '1.0.0', recovered_at: '2026-09-08T11:59:00.000Z',
      checkpoint: null, pending_segments: [], in_flight_segments: [], background_transcript_segments: []
    }
  });
}

function persistenceAckEnvelope(request) {
  assert.ok(request, 'expected a Scribe checkpoint persistence request');
  return createEnvelope({
    plane: 'control', messageType: 'scribe.checkpoint-persisted', producer: 'session-lifecycle-controller', correlationId: request.payload.session_id,
    schemaVersion: '1.0.0', payload: structuredClone(request.payload)
  });
}

test('a recovery page with a gap or a reordering is rejected instead of advancing past skipped rows', () => {
  const sessionId = 'paged-recovery-guard';
  const policy = {
    policy_id: 'paged', policy_version: '1.0.0', session_id: sessionId,
    admission: { rows_per_batch: 3, idle_timeout_ms: 15000 },
    context: { max_total_context_tokens: 8000 },
    generation: { policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0' }
  };
  const row = (sequence) => ({
    segment_id: `${sessionId}-segment-${sequence}`, revision: 0, session_id: sessionId, sequence,
    start_time: '00:00:00.000', end_time: '00:00:01.000', text: `evidence ${sequence}`, boundary: 'pause'
  });
  const restored = (pendingSegments, pendingComplete = true) => ({
    session_id: sessionId, policy_id: 'paged', policy_version: '1.0.0', recovered_at: '2026-09-11T00:00:00.000Z',
    checkpoint: null, pending_segments: pendingSegments, pending_complete: pendingComplete,
    in_flight_segments: [], background_transcript_segments: []
  });

  // A first page that skips sequence 1 must not be accepted: the cursor would later advance past
  // a finalized row that was never evaluated.
  const gapped = createScribeCoordinator({ requireRecovery: true });
  gapped.configurePolicy(policy);
  assert.throws(() => gapped.acceptRecoveryRestored(restored([row(0), row(2)])), /contiguous/);

  const reordered = createScribeCoordinator({ requireRecovery: true });
  reordered.configurePolicy(policy);
  assert.throws(() => reordered.acceptRecoveryRestored(restored([row(1), row(0)])), /contiguous/);

  // The same guard applies to a continuation page. A continuation is only accepted once the
  // coordinator has asked for one, so Close drives it the way production does.
  const continued = createScribeCoordinator({ requireRecovery: true });
  continued.configurePolicy(policy);
  continued.acceptRecoveryRestored(restored([], false));
  assert.equal(continued.status(sessionId).pendingComplete, false);
  const asked = continued.close(sessionId).outputs;
  assert.equal(asked.filter((output) => output.type === 'recovery-request').length, 1, 'an incomplete backlog asks for its next page');
  assert.throws(() => continued.acceptRecoveryRestored(restored([row(4)], true)), /contiguous/);

  // A contiguous continuation is accepted and leaves the backlog complete.
  const accepted = createScribeCoordinator({ requireRecovery: true });
  accepted.configurePolicy(policy);
  accepted.acceptRecoveryRestored(restored([], false));
  accepted.close(sessionId);
  accepted.acceptRecoveryRestored(restored([row(0), row(1)], true));
  assert.equal(accepted.status(sessionId).pendingComplete, true);
});
