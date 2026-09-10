import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createEnvelope } from '../runtime/orchestrator.mjs';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { SessionLifecycle } from '../runtime/session-lifecycle.mjs';
import { SessionStorage } from '../runtime/session-storage.mjs';
import { startScribeBatchModelEndpoint } from './helpers/scribe-batch-model-endpoint.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = (service) => path.join(root, 'services', service, 'service.json');
const registry = await loadContractRegistry(path.join(root, 'contracts/catalog.json'));
const modelName = 'scribe-wave2-reconciliation-model';

test('Close drains an active batch across coordinator, extractor, serial lane, and Logged Item owner only after terminal evaluation', async () => {
  const sessionId = 'scribe-wave2-active-drain';
  const endpoint = await startScribeBatchModelEndpoint({ reply: () => ({ items: [
    { text: 'Retain the active batch through Close.', kind: 'decision', source_segment_ids: [`${sessionId}-segment-0`] }
  ] }) });
  const services = await Promise.all([
    startService(manifest('scribe-coordinator')),
    startService(manifest('log-extractor-local-http'), { env: { ARGUS_MODEL_NAME: modelName } }),
    startService(manifest('serial-ai-model-lane')),
    startService(manifest('active-logged-item-owner'))
  ]);
  const [coordinator, extractor, lane, owner] = services;
  try {
    const policyMessage = policyEnvelope(sessionId);
    await configureCoordinator(coordinator, sessionId, policyMessage);
    await sendAndWait(extractor, policyMessage, (message) => completionOf(message, 'retain-scribe-batch-policy'));
    await sendAndWait(lane, providerConfiguration(sessionId, endpoint.url), (message) => completionOf(message, 'configure-model-provider'));

    const rowMark = coordinator.outputs.length;
    coordinator.send(...[0, 1, 2].map((sequence) => segmentEnvelope(sessionId, sequence)));
    const admissionPersistence = await coordinator.waitFor(
      (message) => message.message_type === 'scribe.checkpoint-persist' && message.payload.transition === 'batch-admitted',
      { after: rowMark, label: 'coordinator admission persistence request' }
    );
    const admitted = await sendAndWait(coordinator, persistenceAckEnvelope(admissionPersistence), (message) => message.message_type === 'scribe.batch-admitted');
    const dispatched = await sendAndWait(extractor, admitted, (message) => message.message_type === 'ai.work-request');

    const coordinatorDrain = drainEnvelope(sessionId, 'coordinator-active-drain');
    const extractorDrain = drainEnvelope(sessionId, 'extractor-active-drain');
    const coordinatorDrainMark = coordinator.outputs.length;
    const extractorDrainMark = extractor.outputs.length;
    coordinator.send(coordinatorDrain);
    extractor.send(extractorDrain);
    await delay(75);
    assert.equal(coordinator.outputs.slice(coordinatorDrainMark).some((message) => message.message_type === 'service.drained'), false);
    assert.equal(extractor.outputs.slice(extractorDrainMark).some((message) => message.message_type === 'service.drained'), false);

    const laneMark = lane.outputs.length;
    lane.send(dispatched, drainEnvelope(sessionId, 'lane-active-drain'));
    const completion = await lane.waitFor((message) => message.message_type === 'ai.work-completed', { after: laneMark, label: 'serial lane completion' });
    await lane.waitFor((message) => message.message_type === 'service.drained', { after: laneMark, label: 'serial lane drain' });
    const draft = await sendAndWait(extractor, completion, (message) => message.message_type === 'logged-item.draft');

    const ownerMark = owner.outputs.length;
    owner.send(draft, drainEnvelope(sessionId, 'owner-active-drain'));
    const stored = await owner.waitFor((message) => message.message_type === 'logged-item.stored', { after: ownerMark, label: 'Logged Item storage' });
    await owner.waitFor((message) => message.message_type === 'service.drained', { after: ownerMark, label: 'Logged Item owner drain' });

    const extractorSettlementMark = extractor.outputs.length;
    extractor.send(stored);
    const evaluated = await extractor.waitFor((message) => message.message_type === 'scribe.batch-evaluated', { after: extractorSettlementMark, label: 'terminal Scribe evaluation' });
    const extractorDrained = await extractor.waitFor((message) => message.message_type === 'service.drained', { after: extractorSettlementMark, label: 'extractor drain completion' });
    assert.equal(extractor.outputs.indexOf(evaluated) < extractor.outputs.indexOf(extractorDrained), true, 'terminal evaluation must be visible before drain completes');

    const evaluationPersistence = await sendAndWait(
      coordinator,
      evaluated,
      (message) => message.message_type === 'scribe.checkpoint-persist' && message.payload.transition === 'batch-evaluated'
    );
    const finalMark = coordinator.outputs.length;
    coordinator.send(persistenceAckEnvelope(evaluationPersistence));
    const coordinatorDrained = await coordinator.waitFor((message) => message.message_type === 'service.drained', { after: finalMark, label: 'coordinator drain completion' });
    assert.equal(coordinator.outputs.indexOf(evaluationPersistence) < coordinator.outputs.indexOf(coordinatorDrained), true);
    for (const message of [admissionPersistence, admitted, dispatched, completion, draft, stored, evaluated, evaluationPersistence, extractorDrained, coordinatorDrained]) {
      assert.deepEqual(registry.validateEnvelope(message), [], message.message_type);
    }
  } finally {
    await Promise.all(services.map((service) => service.stop({ force: true })));
    await endpoint.close();
  }
});

test('Close forces a two-row remainder and reports a terminal model failure instead of claiming the coordinator drained', async () => {
  const sessionId = 'scribe-wave2-forced-failure';
  const endpoint = await startScribeBatchModelEndpoint({ reply: () => ({ status: 503, raw: 'terminal test failure' }) });
  const services = await Promise.all([
    startService(manifest('scribe-coordinator')),
    startService(manifest('log-extractor-local-http'), { env: { ARGUS_MODEL_NAME: modelName } }),
    startService(manifest('serial-ai-model-lane'))
  ]);
  const [coordinator, extractor, lane] = services;
  try {
    const policyMessage = policyEnvelope(sessionId);
    await configureCoordinator(coordinator, sessionId, policyMessage);
    await sendAndWait(extractor, policyMessage, (message) => completionOf(message, 'retain-scribe-batch-policy'));
    await sendAndWait(lane, providerConfiguration(sessionId, endpoint.url), (message) => completionOf(message, 'configure-model-provider'));

    const rows = [segmentEnvelope(sessionId, 0), segmentEnvelope(sessionId, 1)];
    const rowMark = coordinator.outputs.length;
    coordinator.send(...rows);
    await coordinator.waitFor(
      (message) => completionOf(message, 'admit-finalized-segment') && message.causation_id === rows[1].message_id,
      { after: rowMark, label: 'second pending finalized row' }
    );
    assert.equal(coordinator.outputs.slice(rowMark).some((message) => message.message_type === 'scribe.checkpoint-persist'), false);

    const coordinatorDrain = drainEnvelope(sessionId, 'coordinator-forced-failure-drain');
    const drainMark = coordinator.outputs.length;
    coordinator.send(coordinatorDrain);
    const admissionPersistence = await coordinator.waitFor(
      (message) => message.message_type === 'scribe.checkpoint-persist' && message.payload.transition === 'batch-admitted',
      { after: drainMark, label: 'forced remainder persistence request' }
    );
    assert.equal(admissionPersistence.payload.checkpoint.in_flight_batch.batch_identity.segments.length, 2);
    assert.equal(admissionPersistence.payload.checkpoint.in_flight_batch.batch_identity.admission_reason, 'idle-timeout');
    const admitted = await sendAndWait(coordinator, persistenceAckEnvelope(admissionPersistence), (message) => message.message_type === 'scribe.batch-admitted');
    const dispatched = await sendAndWait(extractor, admitted, (message) => message.message_type === 'ai.work-request');

    const extractorDrainMark = extractor.outputs.length;
    extractor.send(drainEnvelope(sessionId, 'extractor-forced-failure-drain'));
    await delay(75);
    assert.equal(extractor.outputs.slice(extractorDrainMark).some((message) => message.message_type === 'service.drained'), false);

    const laneMark = lane.outputs.length;
    lane.send(dispatched, drainEnvelope(sessionId, 'lane-forced-failure-drain'));
    const completion = await lane.waitFor((message) => message.message_type === 'ai.work-completed', { after: laneMark, label: 'terminal failed model completion' });
    assert.equal(completion.payload.result.status, 'failed');
    assert.equal(endpoint.calls.length, 2, 'the serial lane exhausts its governed two attempts before terminal settlement');
    await lane.waitFor((message) => message.message_type === 'service.drained', { after: laneMark, label: 'failed serial lane drain' });

    const extractorTerminalMark = extractor.outputs.length;
    extractor.send(completion);
    const evaluated = await extractor.waitFor((message) => message.message_type === 'scribe.batch-evaluated', { after: extractorTerminalMark, label: 'failed Scribe evaluation' });
    assert.equal(evaluated.payload.batch.outcome, 'failed');
    const extractorDrained = await extractor.waitFor((message) => message.message_type === 'service.drained', { after: extractorTerminalMark, label: 'extractor terminal drain' });
    assert.equal(extractor.outputs.indexOf(evaluated) < extractor.outputs.indexOf(extractorDrained), true);

    const failureMark = coordinator.outputs.length;
    coordinator.send(evaluated);
    const batchFailure = await coordinator.waitFor(
      (message) => message.message_type === 'service.failure' && message.payload.operation === 'settle-scribe-batch',
      { after: failureMark, label: 'visible terminal batch failure' }
    );
    const drainFailure = await coordinator.waitFor(
      (message) => message.message_type === 'service.failure' && message.payload.operation === 'lifecycle.drain',
      { after: failureMark, label: 'visible incomplete drain failure' }
    );
    assert.equal(coordinator.outputs.slice(failureMark).some((message) => message.message_type === 'service.drained'), false);
    assert.equal(batchFailure.payload.error.retryable, false);
    assert.equal(drainFailure.payload.error.code, 'SCRIBE_BATCH_STALLED');
    for (const message of [admissionPersistence, admitted, dispatched, completion, evaluated, extractorDrained, batchFailure, drainFailure]) {
      assert.deepEqual(registry.validateEnvelope(message), [], message.message_type);
    }
  } finally {
    await Promise.all(services.map((service) => service.stop({ force: true })));
    await endpoint.close();
  }
});

test('service-boundary restart restores pending and in-flight evidence before new input and persists evaluation before cursor recovery', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'argus-scribe-wave2-restart-'));
  const sessionId = 'scribe-wave2-durable-restart';
  let lifecycleService;
  let coordinator;
  let restartedCoordinator;
  try {
    const storage = new SessionStorage({ root: directory });
    const fixtureLifecycle = new SessionLifecycle({ storage });
    await fixtureLifecycle.record({ operation_id: 'record-restart-fixture', session_id: sessionId, requested_at: new Date().toISOString() });
    const segments = Array.from({ length: 4 }, (_, sequence) => durableSegment(sessionId, sequence));
    await fixtureLifecycle.persistActiveProjections(sessionId, { transcriptSegments: segments, loggedItems: [], savedAt: new Date().toISOString() });
    const references = segments.map(({ segment_id, revision, sequence }) => ({ segment_id, revision, sequence }));
    const batchIdentity = {
      request_id: `${sessionId}-request-0-2`, session_id: sessionId, segments: references.slice(0, 3),
      first_sequence: 0, last_sequence: 2, admission_reason: 'batch-complete',
      policy_id: 'wave2-reconciliation-policy', policy_version: '1.0.0', instruction_version: '1.0.0'
    };
    const accumulatedSince = new Date().toISOString();
    const checkpoint = {
      schema_version: '1.0.0', session_id: sessionId, saved_at: accumulatedSince,
      admitted_through: { last_segment_id: null, last_sequence: -1, last_revision: 0 },
      pending_partial: { segments: [references[3]], accumulated_since: accumulatedSince },
      background_context: { prior_logged_items: [] },
      policy_id: 'wave2-reconciliation-policy', policy_version: '1.0.0',
      in_flight_batch: { batch_identity: batchIdentity, attempt: 1, dispatched_at: accumulatedSince }
    };
    await fixtureLifecycle.persistScribeCheckpointTransition(sessionId, {
      session_id: sessionId, transition: 'batch-admitted', checkpoint
    });

    [lifecycleService, coordinator] = await Promise.all([
      startService(manifest('session-lifecycle-controller'), { env: { ARGUS_SESSION_ROOT: directory } }),
      startService(manifest('scribe-coordinator'))
    ]);
    const policyMessage = policyEnvelope(sessionId);
    const recoveryRequest = await sendAndWait(coordinator, policyMessage, (message) => message.message_type === 'scribe.recovery-request');
    const premature = segmentEnvelope(sessionId, 4);
    const rejected = await sendAndWait(
      coordinator,
      premature,
      (message) => message.message_type === 'operation.rejected' && message.payload.reason.code === 'SCRIBE_RECOVERY_REQUIRED'
    );
    assert.equal(rejected.payload.input_message_id, premature.message_id);

    const restored = await sendAndWait(lifecycleService, recoveryRequest, (message) => message.message_type === 'scribe.recovery-restored');
    assert.deepEqual(restored.payload.in_flight_segments.map((segment) => segment.segment_id), references.slice(0, 3).map((segment) => segment.segment_id));
    assert.deepEqual(restored.payload.pending_segments.map((segment) => segment.segment_id), [references[3].segment_id]);
    const restoreMark = coordinator.outputs.length;
    coordinator.send(restored);
    const replayedAdmission = await coordinator.waitFor((message) => message.message_type === 'scribe.batch-admitted', { after: restoreMark, label: 'recovered in-flight admission' });
    assert.equal(coordinator.outputs.slice(restoreMark).some((message) => message.message_type === 'scribe.checkpoint-persist'), false, 'the recovered in-flight admission was already durably checkpointed');

    const evaluated = emptyEvaluationEnvelope(replayedAdmission);
    const evaluationPersistence = await sendAndWait(
      coordinator,
      evaluated,
      (message) => message.message_type === 'scribe.checkpoint-persist' && message.payload.transition === 'batch-evaluated'
    );
    const persisted = await sendAndWait(lifecycleService, evaluationPersistence, (message) => message.message_type === 'scribe.checkpoint-persisted');
    const durable = new SessionLifecycle({ storage: new SessionStorage({ root: directory }) });
    const [durableCheckpoint, durableJournal] = await Promise.all([
      durable.getScribeCheckpoint(sessionId),
      durable.getScribeBatchJournal(sessionId)
    ]);
    assert.equal(durableJournal.length, 1);
    assert.deepEqual(durableJournal[0].batch, evaluated.payload.batch);
    assert.equal(durableCheckpoint.admitted_through.last_sequence, 2);
    assert.equal(durableCheckpoint.in_flight_batch, undefined);
    assert.deepEqual(durableCheckpoint.pending_partial.segments, [references[3]]);

    await sendAndWait(coordinator, persisted, (message) => completionOf(message, 'accept-scribe-checkpoint-persistence'));
    await coordinator.stop({ force: true });
    coordinator = undefined;

    restartedCoordinator = await startService(manifest('scribe-coordinator'));
    const secondRecoveryRequest = await sendAndWait(restartedCoordinator, policyMessage, (message) => message.message_type === 'scribe.recovery-request');
    const secondRestored = await sendAndWait(lifecycleService, secondRecoveryRequest, (message) => message.message_type === 'scribe.recovery-restored');
    assert.equal(secondRestored.payload.checkpoint.admitted_through.last_sequence, 2);
    assert.equal(secondRestored.payload.checkpoint.in_flight_batch, undefined);
    assert.deepEqual(secondRestored.payload.pending_segments.map((segment) => segment.segment_id), [references[3].segment_id]);
    await sendAndWait(restartedCoordinator, secondRestored, (message) => completionOf(message, 'restore-scribe-state'));

    const newEvidence = segmentEnvelope(sessionId, 4);
    const accepted = await sendAndWait(restartedCoordinator, newEvidence, (message) => completionOf(message, 'admit-finalized-segment'));
    assert.equal(accepted.causation_id, newEvidence.message_id);
    const forced = await sendAndWait(
      restartedCoordinator,
      drainEnvelope(sessionId, 'restart-pending-drain'),
      (message) => message.message_type === 'scribe.checkpoint-persist' && message.payload.transition === 'batch-admitted'
    );
    assert.deepEqual(forced.payload.checkpoint.in_flight_batch.batch_identity.segments, [
      references[3],
      { segment_id: `${sessionId}-segment-4`, revision: 0, sequence: 4 }
    ]);
    for (const message of [recoveryRequest, rejected, restored, replayedAdmission, evaluationPersistence, persisted, secondRestored, forced]) {
      assert.deepEqual(registry.validateEnvelope(message), [], message.message_type);
    }
  } finally {
    await Promise.all([lifecycleService, coordinator, restartedCoordinator].filter(Boolean).map((service) => service.stop({ force: true })));
    await rm(directory, { recursive: true, force: true });
  }
});

async function configureCoordinator(coordinator, sessionId, policyMessage = policyEnvelope(sessionId)) {
  const request = await sendAndWait(coordinator, policyMessage, (message) => message.message_type === 'scribe.recovery-request');
  assert.deepEqual(registry.validateEnvelope(request), []);
  await sendAndWait(coordinator, emptyRecoveryEnvelope(sessionId), (message) => completionOf(message, 'restore-scribe-state'));
  return request;
}

function policyEnvelope(sessionId) {
  return createEnvelope({
    plane: 'control', messageType: 'scribe.batch-policy', producer: 'scribe-wave2-test', correlationId: sessionId,
    schemaVersion: '1.0.0', payload: policy(sessionId)
  });
}

function policy(sessionId) {
  return {
    policy_id: 'wave2-reconciliation-policy', policy_version: '1.0.0', session_id: sessionId,
    admission: { rows_per_batch: 3, idle_timeout_ms: 15000 },
    context: { max_total_context_tokens: 8000 },
    generation: { policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0' }
  };
}

function emptyRecoveryEnvelope(sessionId) {
  return createEnvelope({
    plane: 'control', messageType: 'scribe.recovery-restored', producer: 'session-lifecycle-controller', correlationId: sessionId,
    schemaVersion: '1.0.0', payload: {
      session_id: sessionId, policy_id: 'wave2-reconciliation-policy', policy_version: '1.0.0', recovered_at: new Date().toISOString(),
      checkpoint: null, pending_segments: [], in_flight_segments: [], background_transcript_segments: []
    }
  });
}

function segmentEnvelope(sessionId, sequence) {
  return createEnvelope({
    plane: 'domain', messageType: 'transcript.segment', producer: 'active-transcript-owner', correlationId: sessionId,
    schemaVersion: '1.5.0', payload: {
      segment_id: `${sessionId}-segment-${sequence}`, revision: 0, session_id: sessionId, sequence,
      start_time: `00:00:${String(sequence).padStart(2, '0')}.000`, end_time: `00:00:${String(sequence + 1).padStart(2, '0')}.000`,
      text: `Finalized evidence ${sequence}.`, boundary: 'continuation'
    }
  });
}

function persistenceAckEnvelope(request) {
  return createEnvelope({
    plane: 'control', messageType: 'scribe.checkpoint-persisted', producer: 'session-lifecycle-controller', correlationId: request.payload.session_id,
    schemaVersion: '1.0.0', payload: structuredClone(request.payload)
  });
}

function providerConfiguration(sessionId, endpoint) {
  return createEnvelope({
    plane: 'control', messageType: 'ai.provider-configure', producer: 'scribe-wave2-test', correlationId: sessionId,
    schemaVersion: '1.0.0', payload: {
      configuration: { version: 1, mode: 'local', provider: 'lm-studio', endpoint, model: modelName, protocol: 'openai-compatible', timeout_ms: 2000 },
      credential: { provided: false }
    }
  });
}

function drainEnvelope(sessionId, key) {
  return createEnvelope({
    plane: 'control', messageType: 'lifecycle.drain', producer: 'scribe-wave2-test', correlationId: sessionId,
    schemaVersion: '1.0.0', idempotencyKey: key, payload: { reason: 'completed', deadline_ms: 5000 }
  });
}

function emptyEvaluationEnvelope(admitted) {
  const batchIdentity = admitted.payload.batch_identity;
  const batchAttempt = admitted.payload.batch_attempt;
  const evaluatedAt = new Date().toISOString();
  return createEnvelope({
    plane: 'domain', messageType: 'scribe.batch-evaluated', producer: 'log-extractor-local-http', correlationId: batchIdentity.session_id,
    schemaVersion: '1.0.0', payload: {
      batch_attempt: batchAttempt,
      batch: {
        batch_identity: structuredClone(batchIdentity), evaluated_at: evaluatedAt, attempt: batchAttempt,
        outcome: 'empty-evaluated', items: [],
        acknowledgement: {
          ack_id: `${batchIdentity.request_id}:a${batchAttempt}:accepted`, accepted: true,
          acknowledged_at: evaluatedAt, logged_item_ids: []
        }
      }
    }
  });
}

function durableSegment(sessionId, sequence) {
  const segmentId = `${sessionId}-segment-${sequence}`;
  return {
    segment_id: segmentId, revision_id: `${segmentId}-r0`, session_id: sessionId, sequence, revision: 0,
    start_time: `00:00:${String(sequence).padStart(2, '0')}.000`, end_time: `00:00:${String(sequence + 1).padStart(2, '0')}.000`,
    text: `Durable finalized evidence ${sequence}.`, original_stt_text: `Durable finalized evidence ${sequence}`, boundary: 'continuation',
    word_provenance: [{
      word_id: `${segmentId}-word-0`, source_text: 'Durable', rendered_text: 'Durable', source_sequence: sequence,
      source_audio_window_id: `${segmentId}-window`, source_chunk_ids: [`${segmentId}-chunk-0`]
    }],
    audio_windows: [{
      audio_window_id: `${segmentId}-window`, first_chunk_id: `${segmentId}-chunk-0`, last_chunk_id: `${segmentId}-chunk-0`,
      first_sequence: sequence, last_sequence: sequence, chunk_count: 1,
      start_time: `00:00:${String(sequence).padStart(2, '0')}.000`, end_time: `00:00:${String(sequence + 1).padStart(2, '0')}.000`
    }],
    formatting: { source: 'contextual-language', provisional_until_finalized: true }, review_flags: [], stored_at: new Date().toISOString()
  };
}

function completionOf(message, operation) {
  return message.message_type === 'operation.completed' && message.payload.operation === operation;
}

async function sendAndWait(service, input, predicate, label = input.message_type) {
  const after = service.outputs.length;
  service.send(input);
  return service.waitFor(predicate, { after, label });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function startService(manifestPath, { env = {} } = {}) {
  const definition = JSON.parse(await readFile(manifestPath, 'utf8'));
  const directory = path.dirname(manifestPath);
  const child = spawn(process.execPath, [path.resolve(directory, definition.runtime.entrypoint)], {
    cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env }
  });
  const outputs = [];
  const diagnostics = [];
  const waiters = new Set();
  let fatalError;
  let exited;
  const notify = () => { for (const waiter of [...waiters]) waiter(); };
  const stdout = readline.createInterface({ input: child.stdout });
  const stderr = readline.createInterface({ input: child.stderr });
  stdout.on('line', (line) => {
    try { outputs.push(JSON.parse(line)); }
    catch (error) { fatalError = new Error(`${definition.service_name} emitted invalid JSON: ${error.message}`); child.kill(); }
    notify();
  });
  stderr.on('line', (line) => diagnostics.push(line));
  child.on('error', (error) => { fatalError = error; notify(); });
  const exitPromise = new Promise((resolve) => child.on('exit', (code, signal) => {
    exited = { code, signal };
    notify();
    resolve(exited);
  }));

  function send(...messages) {
    if (exited || fatalError) throw fatalError || new Error(`${definition.service_name} already exited`);
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function waitFor(predicate, { after = 0, label = 'matching output', timeoutMs = 8000 } = {}) {
    const existing = outputs.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        const observed = outputs.slice(after).map((message) => `${message.message_type}:${message.payload?.error?.code || message.payload?.reason?.code || message.payload?.operation || ''}`);
        reject(new Error(`${definition.service_name} did not emit ${label} within ${timeoutMs} ms. Observed: ${observed.join(', ')}. Diagnostics: ${diagnostics.join(' | ')}`));
      }, timeoutMs);
      const check = () => {
        const matching = outputs.slice(after).find(predicate);
        if (!matching && !fatalError && !exited) return;
        clearTimeout(timer);
        waiters.delete(check);
        if (matching) resolve(matching);
        else reject(fatalError || new Error(`${definition.service_name} exited before emitting ${label}. Diagnostics: ${diagnostics.join(' | ')}`));
      };
      waiters.add(check);
      check();
    });
  }

  async function stop({ force = false } = {}) {
    if (!exited) {
      if (force) child.kill();
      else child.stdin.end();
    }
    await exitPromise;
    stdout.close();
    stderr.close();
  }

  return { definition, outputs, diagnostics, send, waitFor, stop };
}
