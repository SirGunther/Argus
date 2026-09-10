// SCRIBE-01 — focused contract tests for the governed Scribe policy, batch identity,
// batch-shaped model request/response, and durable checkpoint/journal artifact shapes.
// This suite proves the *shapes* defined in contracts/ are well-formed and reject the
// documented invalid cases. It does not exercise any coordinator, timer, or durable
// file I/O — those belong to SCRIBE-02/SCRIBE-03 and are explicitly out of scope here.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import {
  SCRIBE_BATCH_PROTOCOL_VERSION,
  EXTRACTION_BATCH_OUTPUT_LIMITS,
  validateScribeBatchModelRequest,
  validateScribeBatchModelResponse
} from '../contracts/model-protocol.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = await loadContractRegistry(path.join(root, 'contracts', 'catalog.json'));

const messageFixtureRoot = path.join(root, 'tests', 'fixtures', 'contracts');
const artifactFixtureRoot = path.join(root, 'tests', 'fixtures', 'scribe-artifacts');

async function loadMessageFixture(messageType, version, name) {
  return JSON.parse(await readFile(path.join(messageFixtureRoot, messageType, version, name), 'utf8'));
}

async function loadArtifactFixture(kind, name) {
  return JSON.parse(await readFile(path.join(artifactFixtureRoot, kind, name), 'utf8'));
}

test('catalog registers the governed Scribe policy message and the batch-shaped 1.5.0 protocol bump', () => {
  const catalog = registry.catalog;
  assert.equal(catalog.messages['scribe.batch-policy'].plane, 'control');
  assert.equal(catalog.messages['scribe.batch-policy'].version, '1.0.0');
  assert.ok(catalog.messages['scribe.batch-policy'].owner);
  assert.equal(catalog.messages['ai.work-request'].version, '1.5.0');
  assert.equal(catalog.messages['ai.work-completed'].version, '1.5.0');
  for (const artifactType of ['scribe_batch_identity', 'scribe_batch_evaluated', 'scribe_checkpoint', 'scribe_batch_journal_entry']) {
    assert.ok(catalog.artifacts[artifactType], `${artifactType} must be registered`);
  }
});

test('scribe.batch-policy default fixture (three rows, 15000ms idle, ~8000 token budget) is contract-valid', async () => {
  const fixture = await loadMessageFixture('scribe.batch-policy', '1.0.0', 'valid.json');
  assert.deepEqual(registry.validateEnvelope(fixture), []);
  assert.equal(fixture.payload.admission.rows_per_batch, 3);
  assert.equal(fixture.payload.admission.idle_timeout_ms, 15000);
  assert.equal(fixture.payload.context.max_total_context_tokens, 8000);
});

test('scribe.batch-policy rejects an architectural-invariant field smuggled into the policy', async () => {
  const fixture = await loadMessageFixture('scribe.batch-policy', '1.0.0', 'valid.json');
  const tampered = { ...fixture, payload: { ...fixture.payload, admission: { ...fixture.payload.admission, concurrency: 1 } } };
  assert.match(registry.validateEnvelope(tampered).join('\n'), /not allowed/);
});

test('ai.work-request 1.5.0 accepts a full three-row batch-complete request and a two-row idle-timeout partial request', async () => {
  const fullBatch = await loadMessageFixture('ai.work-request', '1.5.0', 'valid.json');
  assert.deepEqual(registry.validateEnvelope(fullBatch), []);
  assert.equal(fullBatch.payload.input.model_request.batch_identity.segments.length, 3);
  assert.equal(fullBatch.payload.input.model_request.batch_identity.admission_reason, 'batch-complete');

  const partialBatch = await loadMessageFixture('ai.work-request', '1.5.0', 'valid-partial-idle-batch.json');
  assert.deepEqual(registry.validateEnvelope(partialBatch), []);
  assert.equal(partialBatch.payload.input.model_request.batch_identity.segments.length, 2);
  assert.equal(partialBatch.payload.input.model_request.batch_identity.admission_reason, 'idle-timeout');
});

test('ai.work-request 1.5.0 separates new authoritative evidence from bounded background context', async () => {
  const fixture = await loadMessageFixture('ai.work-request', '1.5.0', 'valid.json');
  const request = fixture.payload.input.model_request;
  const evidenceIds = new Set(request.new_evidence_segments.map((segment) => segment.segment_id));
  const backgroundIds = new Set(request.background_context.transcript_segments.map((segment) => segment.segment_id));
  assert.equal([...evidenceIds].some((id) => backgroundIds.has(id)), false);
  assert.ok(request.background_context.prior_logged_items.length >= 1, 'background carries prior non-authoritative logged items for duplicate suppression');
});

test('the retained 1.0.0/1.2.0/1.4.0 ai.work-request and ai.work-completed fixtures still replay under the 1.5.0 catalog bump', async () => {
  const oldRequest = await loadMessageFixture('ai.work-request', '1.4.0', 'valid.json');
  const oldCompletion = await loadMessageFixture('ai.work-completed', '1.4.0', 'valid.json');
  assert.deepEqual(registry.validateEnvelope(oldRequest), []);
  assert.deepEqual(registry.validateEnvelope(oldCompletion), []);
});

test('ai.work-completed 1.5.0 represents zero, one, and multiple proposed items', async () => {
  const zero = await loadMessageFixture('ai.work-completed', '1.5.0', 'valid-zero-items.json');
  const one = await loadMessageFixture('ai.work-completed', '1.5.0', 'valid-one-item.json');
  const many = await loadMessageFixture('ai.work-completed', '1.5.0', 'valid.json');
  assert.deepEqual(registry.validateEnvelope(zero), []);
  assert.deepEqual(registry.validateEnvelope(one), []);
  assert.deepEqual(registry.validateEnvelope(many), []);
  assert.equal(zero.payload.result.response.items.length, 0);
  assert.equal(one.payload.result.response.items.length, 1);
  assert.equal(many.payload.result.response.items.length, 2);
});

test('ai.work-completed 1.5.0 rejects a provider-forged item_id and an oversized item batch', async () => {
  const forged = await loadMessageFixture('ai.work-completed', '1.5.0', 'invalid-forged-item-id.json');
  assert.match(registry.validateEnvelope(forged).join('\n'), /additional property|oneOf/);

  const oversized = await loadMessageFixture('ai.work-completed', '1.5.0', 'invalid-oversized-items.json');
  assert.match(registry.validateEnvelope(oversized).join('\n'), /maxItems|oneOf/);
});

test('the batch identity invariant rejects duplicate segment ids and gapped/reordered evidence', async () => {
  const duplicate = await loadMessageFixture('ai.work-request', '1.5.0', 'invalid-duplicate-segment-ids.json');
  assert.throws(() => validateScribeBatchModelRequest(duplicate.payload.input.model_request), /must not repeat a segment_id/);

  const gapped = await loadMessageFixture('ai.work-request', '1.5.0', 'invalid-gapped-evidence.json');
  assert.throws(() => validateScribeBatchModelRequest(gapped.payload.input.model_request), /contiguous, gap-free/);
});

test('new_evidence_segments carrying the correct segment id set out of order is rejected, not silently accepted', async () => {
  const reordered = await loadMessageFixture('ai.work-request', '1.5.0', 'invalid-reordered-evidence.json');
  assert.throws(() => validateScribeBatchModelRequest(reordered.payload.input.model_request), /order, revision, and sequence/);
});

test('a request whose identity.session_id, batch_request_id, or instruction_version conflicts with batch_identity fails closed', async () => {
  const base = (await loadMessageFixture('ai.work-request', '1.5.0', 'valid.json')).payload.input.model_request;

  const wrongSession = structuredClone(base);
  wrongSession.identity.session_id = 'a-different-session';
  assert.throws(() => validateScribeBatchModelRequest(wrongSession), /identity session_id must match/);

  const wrongBatchRequestId = structuredClone(base);
  wrongBatchRequestId.identity.batch_request_id = 'a-different-batch';
  assert.throws(() => validateScribeBatchModelRequest(wrongBatchRequestId), /batch_request_id must match/);

  const wrongInstructionVersion = structuredClone(base);
  wrongInstructionVersion.instruction_version = '9.9.9';
  assert.throws(() => validateScribeBatchModelRequest(wrongInstructionVersion), /instruction_version must match/);
});

test('the batch request invariant rejects background context representing a new-evidence segment as background', async () => {
  const overlap = await loadMessageFixture('ai.work-request', '1.5.0', 'invalid-background-as-source.json');
  assert.throws(() => validateScribeBatchModelRequest(overlap.payload.input.model_request), /cannot represent a new-evidence segment as background/);
});

test('validateScribeBatchModelRequest and validateScribeBatchModelResponse accept the governed valid fixtures end to end', async () => {
  const requestFixture = await loadMessageFixture('ai.work-request', '1.5.0', 'valid.json');
  const request = validateScribeBatchModelRequest(requestFixture.payload.input.model_request);
  assert.equal(request.protocol_version, SCRIBE_BATCH_PROTOCOL_VERSION);

  const responseFixture = await loadMessageFixture('ai.work-completed', '1.5.0', 'valid.json');
  const response = validateScribeBatchModelResponse(responseFixture.payload.result.response, responseFixture.payload.result.response.limits || { max_output_tokens: EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens });
  assert.equal(response.items.length, 2);
});

test('validateScribeBatchModelResponse rejects a provider-forged item identity even when called directly', () => {
  assert.throws(
    () => validateScribeBatchModelResponse({
      protocol_version: SCRIBE_BATCH_PROTOCOL_VERSION,
      purpose: 'logged-item-extraction',
      batch_identity: {
        request_id: 'batch-1', session_id: 's', segments: [{ segment_id: 'a', revision: 0, sequence: 0 }],
        first_sequence: 0, last_sequence: 0, admission_reason: 'batch-complete', policy_id: 'p', policy_version: '1.0.0', instruction_version: '1.0.0'
      },
      items: [{ text: 'x', source_segment_ids: ['a'], item_id: 'forged' }]
    }, { max_output_tokens: 512 }),
    /provider-forged/
  );
});

test('validateScribeBatchModelResponse rejects an item citing a source segment outside the evaluated batch', () => {
  assert.throws(
    () => validateScribeBatchModelResponse({
      protocol_version: SCRIBE_BATCH_PROTOCOL_VERSION,
      purpose: 'logged-item-extraction',
      batch_identity: {
        request_id: 'batch-1', session_id: 's', segments: [{ segment_id: 'segment-10', revision: 0, sequence: 10 }],
        first_sequence: 10, last_sequence: 10, admission_reason: 'batch-complete', policy_id: 'p', policy_version: '1.0.0', instruction_version: '1.0.0'
      },
      items: [{ text: 'Fabricated provenance.', source_segment_ids: ['segment-999-never-in-batch'] }]
    }, { max_output_tokens: 512 }),
    /within the evaluated batch/
  );
});

test('scribe_batch_identity artifact fixture is contract-valid', async () => {
  const fixture = await loadArtifactFixture('batch-identity', 'valid.json');
  assert.deepEqual(registry.validateArtifact('scribe_batch_identity', fixture), []);
});

test('scribe_batch_evaluated artifact represents zero items, a full item set, and a failed/retry outcome with acknowledgement', async () => {
  const empty = await loadArtifactFixture('batch-evaluated', 'valid-empty.json');
  const items = await loadArtifactFixture('batch-evaluated', 'valid-items.json');
  const failed = await loadArtifactFixture('batch-evaluated', 'valid-failed.json');
  assert.deepEqual(registry.validateArtifact('scribe_batch_evaluated', empty), []);
  assert.deepEqual(registry.validateArtifact('scribe_batch_evaluated', items), []);
  assert.deepEqual(registry.validateArtifact('scribe_batch_evaluated', failed), []);
  assert.equal(failed.error.retryable, true);
  assert.equal(failed.acknowledgement.accepted, false);
});

test('scribe_batch_evaluated artifact rejects a malformed acknowledgement and an outcome/items mismatch', async () => {
  const malformedAck = await loadArtifactFixture('batch-evaluated', 'invalid-malformed-acknowledgement.json');
  assert.notDeepEqual(registry.validateArtifact('scribe_batch_evaluated', malformedAck), []);

  const mismatch = await loadArtifactFixture('batch-evaluated', 'invalid-outcome-items-mismatch.json');
  assert.notDeepEqual(registry.validateArtifact('scribe_batch_evaluated', mismatch), []);
});

test('scribe_batch_evaluated artifact rejects an accepted acknowledgement with no durable timestamp', async () => {
  const fixture = await loadArtifactFixture('batch-evaluated', 'invalid-accepted-without-timestamp.json');
  assert.notDeepEqual(registry.validateArtifact('scribe_batch_evaluated', fixture), []);
});

test('scribe_batch_evaluated artifact carries the resulting authoritative Logged Item IDs and rejects them being missing or misplaced', async () => {
  const items = await loadArtifactFixture('batch-evaluated', 'valid-items.json');
  assert.deepEqual(registry.validateArtifact('scribe_batch_evaluated', items), []);
  assert.deepEqual(items.acknowledgement.logged_item_ids, ['logged-item-batch-1-0', 'logged-item-batch-1-1']);

  const missing = await loadArtifactFixture('batch-evaluated', 'invalid-items-recorded-without-logged-item-ids.json');
  assert.notDeepEqual(registry.validateArtifact('scribe_batch_evaluated', missing), []);

  const misplaced = await loadArtifactFixture('batch-evaluated', 'invalid-logged-item-ids-without-recorded-items.json');
  assert.notDeepEqual(registry.validateArtifact('scribe_batch_evaluated', misplaced), []);
});

test('scribe_checkpoint artifact carries admitted-through position, a bounded pending partial, and rolling background context', async () => {
  const fixture = await loadArtifactFixture('checkpoint', 'valid.json');
  assert.deepEqual(registry.validateArtifact('scribe_checkpoint', fixture), []);
  assert.ok(fixture.background_context.prior_logged_items.length >= 1);
});

test('scribe_checkpoint artifact rejects a pending partial batch beyond the two-row architectural bound', async () => {
  const fixture = await loadArtifactFixture('checkpoint', 'invalid-pending-partial-overflow.json');
  assert.notDeepEqual(registry.validateArtifact('scribe_checkpoint', fixture), []);
});

test('scribe_checkpoint artifact preserves the identical in-flight batch identity and attempt across a crash/restart', async () => {
  const fixture = await loadArtifactFixture('checkpoint', 'valid-in-flight.json');
  assert.deepEqual(registry.validateArtifact('scribe_checkpoint', fixture), []);
  assert.equal(fixture.in_flight_batch.batch_identity.request_id, 'batch-3-single');
  assert.equal(fixture.in_flight_batch.attempt, 2);
});

test('scribe_checkpoint artifact rejects an in-flight batch missing its dispatched_at settlement clock', async () => {
  const fixture = await loadArtifactFixture('checkpoint', 'invalid-in-flight-missing-dispatched-at.json');
  assert.notDeepEqual(registry.validateArtifact('scribe_checkpoint', fixture), []);
});

test('scribe_batch_journal_entry artifact wraps one evaluated batch outcome for append-only durable replay', async () => {
  const fixture = await loadArtifactFixture('journal-entry', 'valid.json');
  assert.deepEqual(registry.validateArtifact('scribe_batch_journal_entry', fixture), []);
  assert.equal(fixture.batch.outcome, 'items-recorded');
});

// SCRIBE-04A — the provider-neutral coordinator <-> extraction-boundary batch transport.
// `ai.work-request`/`ai.work-completed` remain the control-plane channel to the serial AI model
// lane; these two domain-plane messages are the Scribe batch channel, so no message type has to
// serve two different transports and no consumer has to guard against its own emissions looping
// back. Still contracts only: no coordinator, wiring, or extraction behavior is exercised here.

const SCRIBE_TRANSPORT_MESSAGE_TYPES = ['scribe.batch-admitted', 'scribe.batch-evaluated'];

test('catalog registers the Scribe batch transport messages additively without disturbing the SCRIBE-01 entries', () => {
  const catalog = registry.catalog;
  assert.equal(catalog.schema_version, '1.15.0');
  for (const messageType of SCRIBE_TRANSPORT_MESSAGE_TYPES) {
    const definition = catalog.messages[messageType];
    assert.ok(definition, `${messageType} must be registered`);
    assert.equal(definition.version, '1.0.0');
    // The admitted batch is the Scribe extraction trigger, so it takes the plane the existing
    // `transcript.context-window` trigger already carries rather than inventing a convention.
    assert.equal(definition.plane, 'domain', `${messageType} must follow the transcript.context-window trigger plane`);
    assert.equal(definition.plane, catalog.messages['transcript.context-window'].plane);
    assert.ok(definition.owner);
  }
  // Every shape SCRIBE-01 shipped keeps the exact version and plane current code emits/consumes.
  assert.equal(catalog.messages['ai.work-request'].version, '1.5.0');
  assert.equal(catalog.messages['ai.work-completed'].version, '1.5.0');
  assert.equal(catalog.messages['scribe.batch-policy'].version, '1.0.0');
  assert.equal(catalog.messages['scribe.batch-policy'].plane, 'control');
});

test('catalog registers provider-neutral Scribe recovery and checkpoint persistence ports on the control plane', async () => {
  const messageTypes = [
    'scribe.recovery-request', 'scribe.recovery-restored',
    'scribe.checkpoint-persist', 'scribe.checkpoint-persisted'
  ];
  for (const messageType of messageTypes) {
    const definition = registry.catalog.messages[messageType];
    assert.ok(definition, `${messageType} must be registered`);
    assert.equal(definition.version, '1.0.0');
    assert.equal(definition.plane, 'control');
    assert.ok(definition.owner);
    const fixture = await loadMessageFixture(messageType, '1.0.0', 'valid.json');
    assert.deepEqual(registry.validateEnvelope(fixture), [], messageType);
    assert.equal(/model|provider|endpoint/.test(JSON.stringify(fixture.payload)), false);
  }
});

test('checkpoint persistence contracts distinguish in-flight admission from evaluated journal-plus-checkpoint settlement', async () => {
  const admittedRequest = await loadMessageFixture('scribe.checkpoint-persist', '1.0.0', 'valid.json');
  const evaluatedMessage = await loadMessageFixture('scribe.batch-evaluated', '1.0.0', 'valid-empty-evaluated.json');
  const evaluatedBatch = evaluatedMessage.payload.batch;
  const evaluatedCheckpoint = structuredClone(admittedRequest.payload.checkpoint);
  delete evaluatedCheckpoint.in_flight_batch;
  evaluatedCheckpoint.saved_at = evaluatedBatch.acknowledgement.acknowledged_at;
  evaluatedCheckpoint.admitted_through = { last_segment_id: 'fixture-segment-2', last_sequence: 2, last_revision: 0 };
  evaluatedCheckpoint.last_evaluated_batch = structuredClone(evaluatedBatch);

  for (const messageType of ['scribe.checkpoint-persist', 'scribe.checkpoint-persisted']) {
    const fixture = await loadMessageFixture(messageType, '1.0.0', 'valid.json');
    const evaluated = {
      ...fixture,
      message_type: messageType,
      payload: {
        session_id: evaluatedBatch.batch_identity.session_id,
        transition: 'batch-evaluated',
        checkpoint: evaluatedCheckpoint,
        batch: evaluatedBatch
      }
    };
    assert.deepEqual(registry.validateEnvelope(evaluated), [], `${messageType} evaluated transition`);
    const missingBatch = structuredClone(evaluated);
    delete missingBatch.payload.batch;
    assert.match(registry.validateEnvelope(missingBatch).join('\n'), /batch is required/);
    const admissionWithBatch = structuredClone(fixture);
    admissionWithBatch.payload.batch = evaluatedBatch;
    assert.match(registry.validateEnvelope(admissionWithBatch).join('\n'), /batch is not allowed/);
  }
});

test('scribe.batch-admitted declares no model, provider, or endpoint field at all', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'contracts', 'scribe-batch-admitted.schema.json'), 'utf8'));
  assert.equal(Object.hasOwn(schema.properties, 'model'), false);
  assert.equal(schema.additionalProperties, false, 'a provider field must be a contract violation, not a convention');
  // The coordinator holds no provider knowledge, so no provider vocabulary may exist anywhere in
  // this schema - including inside a $defs shape a later minor could reference.
  const serialized = JSON.stringify(schema);
  for (const forbidden of ['model', 'provider', 'endpoint', 'api_key', 'base_url']) {
    assert.equal(serialized.includes(forbidden), false, `scribe.batch-admitted must not mention ${forbidden}`);
  }
});

test('scribe.batch-admitted carries a full three-row batch-complete batch and a two-row idle-timeout remainder', async () => {
  const full = await loadMessageFixture('scribe.batch-admitted', '1.0.0', 'valid.json');
  assert.deepEqual(registry.validateEnvelope(full), []);
  assert.equal(full.payload.batch_identity.segments.length, 3);
  assert.equal(full.payload.batch_identity.admission_reason, 'batch-complete');
  assert.equal(Object.hasOwn(full.payload, 'model'), false);

  const partial = await loadMessageFixture('scribe.batch-admitted', '1.0.0', 'valid-partial-idle-batch.json');
  assert.deepEqual(registry.validateEnvelope(partial), []);
  assert.equal(partial.payload.batch_identity.segments.length, 2);
  assert.equal(partial.payload.batch_identity.admission_reason, 'idle-timeout');
  // A remainder admitted on the idle timer may legitimately have no background at all.
  assert.deepEqual(partial.payload.background_context, { transcript_segments: [], prior_logged_items: [] });
});

test('scribe.batch-admitted rejects a smuggled model name, a missing background context, empty evidence, and forged prior-item identity', async () => {
  const withModel = await loadMessageFixture('scribe.batch-admitted', '1.0.0', 'invalid-model-field.json');
  assert.match(registry.validateEnvelope(withModel).join('\n'), /model is not allowed/);

  const missingBackground = await loadMessageFixture('scribe.batch-admitted', '1.0.0', 'invalid-missing-background-context.json');
  assert.match(registry.validateEnvelope(missingBackground).join('\n'), /background_context is required/);

  const emptyEvidence = await loadMessageFixture('scribe.batch-admitted', '1.0.0', 'invalid-empty-new-evidence.json');
  assert.match(registry.validateEnvelope(emptyEvidence).join('\n'), /fewer than 1 items/);

  // Prior Scribe context is non-authoritative background; only the Logged Item owner assigns
  // identity (ADR-001/ADR-002), so a proposal may not carry item_id/revision.
  const forgedPriorItem = await loadMessageFixture('scribe.batch-admitted', '1.0.0', 'invalid-forged-prior-item-id.json');
  assert.match(registry.validateEnvelope(forgedPriorItem).join('\n'), /item_id is not allowed/);
});

test('scribe.batch-admitted rejects evidence whose revision differs from the admitted identity', async () => {
  const fixture = await loadMessageFixture('scribe.batch-admitted', '1.0.0', 'invalid-evidence-revision.json');
  assert.match(registry.validateEnvelope(fixture).join('\n'), /segment order, revision, and sequence/);
});

test('an admitted batch carries everything needed to build the governed 2.0.0 model request once the extraction boundary adds its own provider detail', async () => {
  const admitted = (await loadMessageFixture('scribe.batch-admitted', '1.0.0', 'valid.json')).payload;
  const workId = `logged-item-extraction:${admitted.batch_identity.session_id}:${admitted.batch_identity.request_id}`;
  const modelRequest = {
    protocol_version: SCRIBE_BATCH_PROTOCOL_VERSION,
    purpose: 'logged-item-extraction',
    // Supplied by the extraction boundary from its own local configuration, never by the
    // coordinator; the same is true of the request ceilings below.
    model: 'locally-configured-model',
    batch_identity: admitted.batch_identity,
    new_evidence_segments: admitted.new_evidence_segments,
    background_context: admitted.background_context,
    policy_profile: admitted.policy_profile,
    instruction_version: admitted.instruction_version,
    limits: {
      max_context_chars: 4000,
      max_context_tokens: 2000,
      max_output_chars: EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_chars,
      max_output_tokens: EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens
    },
    identity: { work_id: workId, session_id: admitted.batch_identity.session_id, batch_request_id: admitted.batch_identity.request_id }
  };

  // The SCRIBE-01 cross-message invariant accepts it: evidence matches the batch identity exactly,
  // and no background segment is presented as new evidence.
  assert.equal(validateScribeBatchModelRequest(modelRequest).protocol_version, SCRIBE_BATCH_PROTOCOL_VERSION);

  const validateWorkRequest = registry.definitionFor('ai.work-request').validate;
  assert.equal(validateWorkRequest({
    work_id: workId,
    workload: 'logged-item-extraction',
    session_id: admitted.batch_identity.session_id,
    sequence: admitted.batch_identity.last_sequence,
    queued_at: '2026-09-07T17:00:00.000Z',
    input: { model_request: modelRequest },
    recovery: { max_attempts: 2 }
  }), true);
});

test('scribe.batch-evaluated transmits zero-item, one-item, multi-item, and failed outcomes as real messages', async () => {
  const empty = await loadMessageFixture('scribe.batch-evaluated', '1.0.0', 'valid-empty-evaluated.json');
  const one = await loadMessageFixture('scribe.batch-evaluated', '1.0.0', 'valid-one-item.json');
  const many = await loadMessageFixture('scribe.batch-evaluated', '1.0.0', 'valid.json');
  const failed = await loadMessageFixture('scribe.batch-evaluated', '1.0.0', 'valid-failed.json');
  for (const fixture of [empty, one, many, failed]) {
    assert.deepEqual(registry.validateEnvelope(fixture), [], fixture.message_id);
    // The message wraps the SCRIBE-01 artifact verbatim, so the same payload validates as one.
    assert.deepEqual(registry.validateArtifact('scribe_batch_evaluated', fixture.payload.batch), []);
  }
  assert.equal(empty.payload.batch.outcome, 'empty-evaluated');
  assert.equal(empty.payload.batch.items.length, 0);
  assert.equal(one.payload.batch.items.length, 1);
  assert.equal(many.payload.batch.items.length, 2);
  assert.equal(failed.payload.batch.outcome, 'failed');
  assert.equal(failed.payload.batch.error.retryable, true);
  assert.equal(failed.payload.batch.acknowledgement.accepted, false);
});

test('scribe.batch-evaluated advances the cursor only on an accepted outcome whose logged item ids match its recorded items', async () => {
  const many = await loadMessageFixture('scribe.batch-evaluated', '1.0.0', 'valid.json');
  const accepted = many.payload.batch.acknowledgement;
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.logged_item_ids, ['logged-item-batch-1-0', 'logged-item-batch-1-1']);

  // A zero-item settlement is a real advance with no Logged Items, which is exactly the outcome
  // that previously had no carrier back to the coordinator at all.
  const empty = await loadMessageFixture('scribe.batch-evaluated', '1.0.0', 'valid-empty-evaluated.json');
  assert.equal(empty.payload.batch.acknowledgement.accepted, true);
  assert.deepEqual(empty.payload.batch.acknowledgement.logged_item_ids, []);
});

test('scribe.batch-evaluated rejects a missing batch, a forged item identity, an outcome/items mismatch, and a forged sibling routing key', async () => {
  const missing = await loadMessageFixture('scribe.batch-evaluated', '1.0.0', 'invalid-missing-batch.json');
  assert.match(registry.validateEnvelope(missing).join('\n'), /batch is required/);

  const forgedItemId = await loadMessageFixture('scribe.batch-evaluated', '1.0.0', 'invalid-forged-item-id.json');
  assert.match(registry.validateEnvelope(forgedItemId).join('\n'), /item_id is not allowed/);

  const mismatch = await loadMessageFixture('scribe.batch-evaluated', '1.0.0', 'invalid-empty-evaluated-with-item.json');
  assert.notDeepEqual(registry.validateEnvelope(mismatch), []);

  // The batch identity and the envelope's correlation_id are the only session keys; a duplicated
  // one would be a divergence this repository's Ajv configuration cannot detect ($data is absent).
  const forgedSession = await loadMessageFixture('scribe.batch-evaluated', '1.0.0', 'invalid-forged-session-id.json');
  assert.match(registry.validateEnvelope(forgedSession).join('\n'), /session_id is not allowed/);
});

test('scribe.batch-evaluated rejects a message batch_attempt that differs from the durable artifact attempt', async () => {
  const fixture = await loadMessageFixture('scribe.batch-evaluated', '1.0.0', 'invalid-batch-attempt-mismatch.json');
  assert.match(registry.validateEnvelope(fixture).join('\n'), /batch_attempt must equal batch\.attempt/);
});
