import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createEnvelope } from '../runtime/orchestrator.mjs';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { createScribeCoordinator } from '../services/scribe-coordinator/coordinator.mjs';
import {
  createScribeBatchRetention,
  draftOutput,
  evaluateScribeBatchResponse
} from '../services/log-extractor-local-http/scribe-batch-boundary.mjs';
import { runService } from './helpers/process-harness.mjs';
import { startScribeBatchModelEndpoint } from './helpers/scribe-batch-model-endpoint.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const laneManifest = path.join(root, 'services/serial-ai-model-lane/service.json');
const ownerManifest = path.join(root, 'services/active-logged-item-owner/service.json');
const registry = await loadContractRegistry(path.join(root, 'contracts/catalog.json'));
const sessionId = 'scribe-wave2-component-flow';
const modelName = 'scribe-wave2-test-model';

test('finalized rows cross admission, real serial lane, active owner, and final coordinator evaluation', async () => {
  const policy = {
    policy_id: 'wave2-policy', policy_version: '1.0.0', session_id: sessionId,
    admission: { rows_per_batch: 3, idle_timeout_ms: 15000 },
    context: { max_total_context_tokens: 8000 },
    generation: { policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0' }
  };
  const coordinator = createScribeCoordinator();
  coordinator.configurePolicy(policy);
  const admissions = [];
  for (let sequence = 0; sequence < 3; sequence += 1) admissions.push(...coordinator.acceptFinalizedSegment(segment(sequence)));
  const admitted = admissions.find((output) => output.type === 'batch-admitted');
  assert.ok(admitted);
  assert.equal(coordinator.status(sessionId).cursor.last_sequence, -1);

  const admission = {
    batch_identity: admitted.batchIdentity,
    batch_attempt: admitted.batchAttempt,
    new_evidence_segments: admitted.newEvidenceSegments,
    background_context: admitted.backgroundContext,
    policy_profile: admitted.policyProfile,
    instruction_version: admitted.instructionVersion
  };
  const retention = createScribeBatchRetention({ capacity: 4 });
  const dispatched = retention.dispatch({ batch: admission, policy, modelName, queuedAt: '2026-09-08T12:00:00.000Z', maxAttempts: 2 });
  assert.equal(dispatched.workRequest.payload.recovery.max_attempts, 2);

  const endpoint = await startScribeBatchModelEndpoint({ reply: (_request, call) => call === 1
    ? { status: 503, raw: 'retry me' }
    : { items: [
      { text: 'Ship the reconciliation.', kind: 'decision', source_segment_ids: ['seg-0'] },
      { text: 'Confirm the final test run.', kind: 'action', source_segment_ids: ['seg-1', 'seg-2'] }
    ] } });
  try {
    const laneResult = await runService(laneManifest, [
      providerConfiguration(endpoint.url),
      workRequestEnvelope(dispatched.workRequest)
    ], 3, 8000);
    const completion = laneResult.outputs.find((message) => message.message_type === 'ai.work-completed');
    assert.equal(completion.payload.attempt, 2);
    assert.equal(completion.payload.work_id, dispatched.request.identity.work_id);
    assert.equal(completion.payload.result.work_id, dispatched.request.identity.work_id);
    assert.equal(completion.payload.result.request_fingerprint, dispatched.requestFingerprint);
    assert.deepEqual(endpoint.calls[0].modelRequest, endpoint.calls[1].modelRequest);
    assert.equal(endpoint.calls[0].envelope.max_tokens, dispatched.request.limits.max_output_tokens);

    const evaluated = evaluateScribeBatchResponse({
      request: dispatched.request,
      response: completion.payload.result.response,
      batchAttempt: admitted.batchAttempt,
      evaluatedAt: completion.payload.completed_at
    });
    const drafts = evaluated.drafts.map((payload) => draftOutput(payload));
    retention.beginOwnerAcknowledgement(dispatched.request.identity.work_id, { drafts, evaluated: evaluated.evaluated });
    assert.equal(coordinator.status(sessionId).cursor.last_sequence, -1);

    const ownerInputs = [...drafts].reverse().map((draft) => createEnvelope({
      plane: 'domain', messageType: 'logged-item.draft', producer: 'log-extractor-local-http', correlationId: sessionId,
      schemaVersion: draft.schemaVersion, messageId: draft.messageId, payload: draft.payload
    }));
    const ownerResult = await runService(ownerManifest, ownerInputs, drafts.length * 3, 8000);
    const stored = ownerResult.outputs.filter((message) => message.message_type === 'logged-item.stored');
    assert.deepEqual(stored.map((message) => message.payload.item_id), [...drafts].reverse().map((draft) => draft.payload.item_id));
    for (const message of stored) assert.deepEqual(registry.validateEnvelope(message), []);

    let terminal;
    for (const message of stored) terminal = retention.confirmStoredItem(message.payload, { acknowledgedAt: message.timestamp });
    assert.equal(terminal.settled, true);
    assert.deepEqual(terminal.evaluated.acknowledgement.logged_item_ids, drafts.map((draft) => draft.payload.item_id));
    assert.equal(terminal.evaluated.attempt, 1, 'coordinator batch attempt is independent of provider completion attempt 2');

    coordinator.acceptBatchEvaluated({ batch_attempt: admitted.batchAttempt, batch: terminal.evaluated });
    assert.equal(coordinator.status(sessionId).cursor.last_sequence, 2);
    assert.equal(coordinator.status(sessionId).busy, false);
    assert.equal(retention.stats().pending, 0);
    assert.equal(retention.stats().settled, 1);
  } finally {
    await endpoint.close();
  }
});

function segment(sequence) {
  return {
    segment_id: `seg-${sequence}`, revision: 0, session_id: sessionId, sequence,
    start_time: `00:00:0${sequence}.000`, end_time: `00:00:0${sequence + 1}.000`,
    text: `Finalized evidence ${sequence}.`, boundary: 'continuation'
  };
}

function providerConfiguration(endpoint) {
  return createEnvelope({
    plane: 'control', messageType: 'ai.provider-configure', producer: 'wave2-test', correlationId: sessionId,
    schemaVersion: '1.0.0', payload: {
      configuration: { version: 1, mode: 'local', provider: 'lm-studio', endpoint, model: modelName, protocol: 'openai-compatible', timeout_ms: 2000 },
      credential: { provided: false }
    }
  });
}

function workRequestEnvelope(output) {
  return createEnvelope({
    plane: 'control', messageType: output.messageType, producer: 'log-extractor-local-http', correlationId: sessionId,
    schemaVersion: output.schemaVersion, idempotencyKey: output.identityKey, payload: output.payload
  });
}
