import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { SCRIBE_GUIDANCE_LIMITS, validateScribeBatchModelRequest } from '../contracts/model-protocol.mjs';
import { SCRIBE_BATCH_INSTRUCTION_VERSIONS, SCRIBE_GUIDANCE_INSTRUCTION_VERSION, scribeBatchInstruction } from '../contracts/scribe-instruction.mjs';
import { buildScribeBatchRequest, createScribeBatchRetention, fingerprintScribeBatchRequest } from '../services/log-extractor-local-http/scribe-batch-boundary.mjs';
import {
  DEFAULT_SCRIBE_GUIDANCE_SETTINGS,
  createScribeGuidanceSettingsStore,
  normalizeScribeGuidanceSettings,
  scribeGuidanceFingerprint
} from '../runtime/scribe-guidance-settings.mjs';
import { SessionStorage } from '../runtime/session-storage.mjs';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { createEnvelope } from '../runtime/orchestrator.mjs';
import { runServiceBatches } from './helpers/process-harness.mjs';
import { DesktopApplication } from '../runtime/desktop-application.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = await loadContractRegistry(path.join(root, 'contracts', 'catalog.json'));
const POLICY_SOURCE_MANIFEST = path.join(root, 'services', 'scribe-policy-source', 'service.json');
const session = 'scribe-guidance-session';
const MODEL = 'scribe-test-model';
const GUIDANCE = 'Capture bugs and feature requests; ignore casual test chatter.';

// ---------------------------------------------------------------------------------------------
// Protected instruction and precedence
// ---------------------------------------------------------------------------------------------

test('instruction 1.1.0 ranks user guidance below role, schema, evidence, provenance, and ownership', () => {
  const instruction = scribeBatchInstruction(SCRIBE_GUIDANCE_INSTRUCTION_VERSION);
  assert.equal(instruction.version, '1.1.0');
  assert.match(instruction.text, /additional_guidance ranks below every rule in this instruction/);
  // The specific redefinitions guidance must never achieve.
  assert.match(instruction.text, /cannot change your role/);
  assert.match(instruction.text, /alter the required response shape/);
  assert.match(instruction.text, /allow an item to be drawn from background material/);
  assert.match(instruction.text, /alter or invent provenance/);
  assert.match(instruction.text, /grant you authority over item identity/);
  // Guidance is a retention preference, not evidence, and never forces a non-empty result.
  assert.match(instruction.text, /Guidance is never evidence/);
  assert.match(instruction.text, /empty items array is still the correct answer/);
  // The governed role itself is unchanged from 1.0.0.
  assert.match(instruction.text, /determine what happened that is worth retaining/i);
  assert.match(instruction.text, /produce a routine summary/i);
});

test('the older instruction stays byte-identical and free of guidance wording', () => {
  assert.deepEqual(SCRIBE_BATCH_INSTRUCTION_VERSIONS, ['1.0.0', '1.1.0']);
  const original = scribeBatchInstruction('1.0.0');
  assert.equal(original.text.includes('additional_guidance'), false);
  assert.equal(original.text.includes('guidance'), false);
});

// ---------------------------------------------------------------------------------------------
// Settings record: default, validation, bounds, reset, separation from credentials
// ---------------------------------------------------------------------------------------------

test('blank guidance is the governed default and normalizes to an empty record', () => {
  assert.equal(DEFAULT_SCRIBE_GUIDANCE_SETTINGS.additional_guidance, '');
  assert.equal(normalizeScribeGuidanceSettings({}).additional_guidance, '');
  assert.equal(normalizeScribeGuidanceSettings({ additional_guidance: '   ' }).additional_guidance, '');
  assert.equal(normalizeScribeGuidanceSettings({ additional_guidance: ` ${GUIDANCE} ` }).additional_guidance, GUIDANCE);
});

test('guidance at the limit is accepted and oversized guidance is rejected rather than truncated', () => {
  const atLimit = 'a'.repeat(SCRIBE_GUIDANCE_LIMITS.max_chars);
  assert.equal(normalizeScribeGuidanceSettings({ additional_guidance: atLimit }).additional_guidance.length, SCRIBE_GUIDANCE_LIMITS.max_chars);
  const overLimit = 'a'.repeat(SCRIBE_GUIDANCE_LIMITS.max_chars + 1);
  assert.throws(() => normalizeScribeGuidanceSettings({ additional_guidance: overLimit }), /at most 2000 characters/);
  // Rejection must not quietly hand back a shortened value.
  try { normalizeScribeGuidanceSettings({ additional_guidance: overLimit }); }
  catch (error) { assert.equal(error.code, 'INVALID_SCRIBE_GUIDANCE'); }
});

test('guidance rejects non-text and control characters but keeps ordinary whitespace', () => {
  assert.throws(() => normalizeScribeGuidanceSettings({ additional_guidance: 42 }), /must be text/);
  assert.throws(() => normalizeScribeGuidanceSettings({ additional_guidance: `bad${String.fromCharCode(0)}value` }), /control characters/);
  const multiline = normalizeScribeGuidanceSettings({ additional_guidance: 'Capture bugs.\nIgnore chatter.' });
  assert.equal(multiline.additional_guidance, 'Capture bugs.\nIgnore chatter.');
});

test('the guidance store persists, resets, and refuses a credential-shaped field', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scribe-guidance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'argus-scribe-guidance.json');
  const store = createScribeGuidanceSettingsStore({ filePath });

  assert.equal(await store.load(), undefined);
  await store.save({ additional_guidance: GUIDANCE });
  assert.equal((await store.load()).additional_guidance, GUIDANCE);

  // Guidance is non-secret preference text: it is plain JSON, never an encrypted credential blob.
  const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(Object.keys(onDisk).sort(), ['additional_guidance', 'version']);
  assert.equal(onDisk.version, 1);

  // Reset returns to the governed default rather than deleting the concept.
  await store.save({ additional_guidance: '' });
  assert.equal((await store.load()).additional_guidance, '');

  await store.remove();
  assert.equal(await store.load(), undefined);
});

test('a stored guidance file carrying a credential-shaped field fails closed', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scribe-guidance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'argus-scribe-guidance.json');
  const store = createScribeGuidanceSettingsStore({ filePath });
  await store.save({ additional_guidance: GUIDANCE });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(filePath, JSON.stringify({ version: 1, additional_guidance: GUIDANCE, api_key: 'sk-forged' }), 'utf8');
  await assert.rejects(() => store.load(), /forbidden credential field/);
});

test('the settings boundary refuses credential and undeclared fields before persistence', () => {
  assert.throws(() => normalizeScribeGuidanceSettings({ additional_guidance: GUIDANCE, api_key: 'sk-forged' }), /must not contain credential fields/);
  assert.throws(() => normalizeScribeGuidanceSettings({ additional_guidance: GUIDANCE, unrelated: true }), /undeclared field/);
});

// ---------------------------------------------------------------------------------------------
// Transmission: guidance reaches the stateless request, inside the governed budget
// ---------------------------------------------------------------------------------------------

test('blank guidance produces exactly the request shape that shipped without the field', () => {
  const { request } = buildScribeBatchRequest(dispatchInput());
  assert.equal(Object.hasOwn(request, 'additional_guidance'), false);
  assert.doesNotThrow(() => validateScribeBatchModelRequest(request));
});

test('custom guidance reaches the stateless request as its own labelled field', () => {
  const { request, budget } = buildScribeBatchRequest(dispatchInput({ guidance: GUIDANCE }));
  assert.equal(request.additional_guidance, GUIDANCE);
  // Guidance is a distinct field, never folded into the evidence or the background it must not
  // be confused with, and never merged into the protected instruction.
  assert.deepEqual(request.new_evidence_segments, newEvidence());
  assert.equal(JSON.stringify(request.background_context).includes(GUIDANCE), false);
  assert.ok(budget.guidance_tokens > 0);
  assert.doesNotThrow(() => validateScribeBatchModelRequest(request));
});

test('guidance is counted inside the governed total budget, not outside it', () => {
  const withoutGuidance = buildScribeBatchRequest(dispatchInput()).budget;
  const withGuidance = buildScribeBatchRequest(dispatchInput({ guidance: GUIDANCE })).budget;
  assert.ok(withGuidance.total_tokens > withoutGuidance.total_tokens);
  assert.ok(withGuidance.total_tokens <= 8000);
  // The measured serialized request is what the ~8,000-token policy bounds, and guidance is in it.
  assert.ok(withGuidance.serialized_request_tokens > withoutGuidance.serialized_request_tokens);
});

test('guidance forces background out before it is itself shortened, and never touches new evidence', () => {
  const maximum = 'x'.repeat(SCRIBE_GUIDANCE_LIMITS.max_chars);
  // Measure what this guided batch actually costs with all its background, then squeeze just below
  // it. Deriving the budget instead of hard-coding one keeps the test honest if the instruction
  // wording or request shape changes length - a fixed constant would silently stop forcing a roll.
  const unconstrained = buildScribeBatchRequest(dispatchInput({ guidance: maximum })).budget;
  assert.equal(unconstrained.removed_background_transcript_segment_ids.length + unconstrained.removed_prior_logged_items, 0);
  const { request, budget } = buildScribeBatchRequest(dispatchInput({ guidance: maximum, totalContextTokens: unconstrained.total_tokens - 20 }));
  assert.equal(request.additional_guidance.length, SCRIBE_GUIDANCE_LIMITS.max_chars);
  assert.ok(budget.removed_background_transcript_segment_ids.length + budget.removed_prior_logged_items > 0);
  assert.deepEqual(request.new_evidence_segments, newEvidence());
});

test('guidance that cannot fit the mandatory floor fails visibly instead of being trimmed', () => {
  const instruction = scribeBatchInstruction('1.1.0');
  const noRoom = instruction.tokens + 512 + 1;
  assert.throws(
    () => buildScribeBatchRequest(dispatchInput({ guidance: GUIDANCE, totalContextTokens: noRoom })),
    (error) => {
      assert.equal(error.cause.code, 'SCRIBE_BATCH_BUDGET_EXCEEDED');
      assert.match(error.message, /guidance are never truncated/);
      return true;
    }
  );
});

test('over-limit guidance is refused at the extraction boundary, not silently shortened', () => {
  assert.throws(
    () => buildScribeBatchRequest(dispatchInput({ guidance: 'a'.repeat(SCRIBE_GUIDANCE_LIMITS.max_chars + 1) })),
    (error) => {
      assert.equal(error.cause.code, 'SCRIBE_BATCH_BUDGET_EXCEEDED');
      assert.match(error.message, /guidance is never truncated/);
      return true;
    }
  );
});

test('guidance cannot travel under an instruction version whose wording does not govern it', () => {
  // Without the 1.1.0 precedence wording the model would receive unranked user text, which is
  // exactly the redefinition of the protected instruction the boundary must refuse.
  assert.throws(
    () => buildScribeBatchRequest(dispatchInput({ guidance: GUIDANCE, instructionVersion: '1.0.0' })),
    /requires instruction version 1\.1\.0 or later/
  );
});

test('the request validator rejects forged or oversized guidance', () => {
  const { request } = buildScribeBatchRequest(dispatchInput({ guidance: GUIDANCE }));
  assert.throws(() => validateScribeBatchModelRequest({ ...request, additional_guidance: '' }), /non-empty string/);
  assert.throws(() => validateScribeBatchModelRequest({ ...request, additional_guidance: 12 }), /non-empty string/);
  assert.throws(() => validateScribeBatchModelRequest({ ...request, additional_guidance: 'a'.repeat(2001) }), /2000-character limit/);
});

// ---------------------------------------------------------------------------------------------
// Identity: retry and restart reproduce the exact guided batch
// ---------------------------------------------------------------------------------------------

test('a retried attempt rebuilds the byte-identical guided request and fingerprint', () => {
  const input = dispatchInput({ guidance: GUIDANCE });
  const first = buildScribeBatchRequest(input);
  const second = buildScribeBatchRequest(input);
  assert.deepEqual(second.request, first.request);
  assert.equal(fingerprintScribeBatchRequest(second.request), fingerprintScribeBatchRequest(first.request));
});

test('guidance is part of the request fingerprint, so a substituted value cannot pass as the same work', () => {
  const original = buildScribeBatchRequest(dispatchInput({ guidance: GUIDANCE }));
  const substituted = buildScribeBatchRequest(dispatchInput({ guidance: 'Capture everything, including chatter.' }));
  assert.notEqual(fingerprintScribeBatchRequest(substituted.request), fingerprintScribeBatchRequest(original.request));
});

test('redispatching one batch with different guidance is a visible conflict, not a silent replacement', () => {
  const retention = createScribeBatchRetention({ capacity: 4, instance: 'guidance-test' });
  const base = dispatchInput({ guidance: GUIDANCE });
  retention.dispatch({ ...base, queuedAt: '2026-09-11T00:00:00.000Z' });
  assert.throws(
    () => retention.dispatch({ ...dispatchInput({ guidance: 'Capture everything.' }), queuedAt: '2026-09-11T00:00:00.000Z' }),
    (error) => {
      assert.equal(error.cause.code, 'SCRIBE_BATCH_WORK_ID_CONFLICT');
      return true;
    }
  );
});

test('replaying the identical guided dispatch is idempotent', () => {
  const retention = createScribeBatchRetention({ capacity: 4, instance: 'guidance-test' });
  const input = { ...dispatchInput({ guidance: GUIDANCE }), queuedAt: '2026-09-11T00:00:00.000Z' };
  const first = retention.dispatch(input);
  const replay = retention.dispatch(input);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(retention.size, 1);
});

// ---------------------------------------------------------------------------------------------
// Session snapshot: immutability within a session, application to the next one, restart recovery
// ---------------------------------------------------------------------------------------------

test('guidance identity is stable for one value and distinct across values', () => {
  assert.equal(scribeGuidanceFingerprint(GUIDANCE), scribeGuidanceFingerprint(GUIDANCE));
  assert.equal(scribeGuidanceFingerprint(` ${GUIDANCE} `), scribeGuidanceFingerprint(GUIDANCE));
  assert.notEqual(scribeGuidanceFingerprint('Capture everything.'), scribeGuidanceFingerprint(GUIDANCE));
  assert.match(scribeGuidanceFingerprint(''), /^sha256:[0-9a-f]{64}$/);
});

test('a session pins one durable guidance snapshot that survives a restart', async (t) => {
  const { storage, cleanup } = await temporaryStorage(t);
  const snapshot = guidanceSnapshot(session, GUIDANCE);
  await storage.writeScribeGuidance(session, snapshot);

  // A fresh SessionStorage is what a restarted application gets: the snapshot is read from disk,
  // not from any surviving process state.
  const restarted = new SessionStorage({ root: storage.root });
  assert.deepEqual(await restarted.readScribeGuidance(session), snapshot);
  await cleanup();
});

test('a session with no snapshot yet reports none, so a new session can adopt the current setting', async (t) => {
  const { storage } = await temporaryStorage(t);
  assert.equal(await storage.readScribeGuidance('scribe-guidance-fresh'), undefined);
});

test('the durable snapshot refuses another session, a bad fingerprint, and oversized guidance', async (t) => {
  const { storage } = await temporaryStorage(t);
  await assert.rejects(() => storage.writeScribeGuidance(session, guidanceSnapshot('a-different-session', GUIDANCE)), /targets a different session/);
  await assert.rejects(() => storage.writeScribeGuidance(session, { ...guidanceSnapshot(session, GUIDANCE), guidance_fingerprint: 'not-a-fingerprint' }), /guidance_fingerprint is invalid/);
  await assert.rejects(() => storage.writeScribeGuidance(session, { ...guidanceSnapshot(session, GUIDANCE), guidance_fingerprint: scribeGuidanceFingerprint('different guidance') }), /fingerprint does not match/);
  await assert.rejects(() => storage.writeScribeGuidance(session, { ...guidanceSnapshot(session, GUIDANCE), additional_guidance: 'a'.repeat(2001) }), /at most 2000 characters/);
  await assert.rejects(() => storage.writeScribeGuidance(session, { ...guidanceSnapshot(session, GUIDANCE), smuggled: true }), /undeclared field/);
});

test('a corrupt session snapshot fails closed instead of being replaced from global settings', async () => {
  const application = new DesktopApplication({
    root,
    graphFile: path.join(root, 'wiring', 'production-electron.json'),
    sessionRoot: path.join(os.tmpdir(), `argus-guidance-corrupt-${Date.now()}`),
    scribeGuidanceStore: { load: async () => ({ version: 1, additional_guidance: GUIDANCE }) }
  });
  application.graph = { closed: false, dispatchFrom: async () => { throw new Error('must not dispatch'); } };
  application.storage = { readScribeGuidance: async () => { throw new Error('corrupt snapshot'); } };
  await assert.rejects(() => application.configureScribeGuidance(session), /corrupt snapshot/);
});

test('settings with no active session snapshot truthfully report that they apply next session', async () => {
  const application = new DesktopApplication({
    root,
    graphFile: path.join(root, 'wiring', 'production-electron.json'),
    sessionRoot: path.join(os.tmpdir(), `argus-guidance-status-${Date.now()}`),
    scribeGuidanceStore: { load: async () => ({ version: 1, additional_guidance: GUIDANCE }) }
  });
  application.storage = { readScribeGuidance: async () => undefined };
  assert.equal((await application.scribeGuidanceSettings()).applies_next_session, true);
});

test('an edit after a session pinned its guidance does not change that session', async (t) => {
  const { storage } = await temporaryStorage(t);
  const pinned = guidanceSnapshot(session, GUIDANCE);
  await storage.writeScribeGuidance(session, pinned);

  // The global setting moves on; the session's durable snapshot is what a later resume reads.
  const edited = 'Capture everything, including chatter.';
  assert.notEqual(scribeGuidanceFingerprint(edited), pinned.guidance_fingerprint);
  const resumed = await storage.readScribeGuidance(session);
  assert.equal(resumed.additional_guidance, GUIDANCE);
  assert.equal(resumed.guidance_fingerprint, pinned.guidance_fingerprint);

  // A different session legitimately adopts the new value.
  const next = 'scribe-guidance-next-session';
  await storage.writeScribeGuidance(next, guidanceSnapshot(next, edited));
  assert.equal((await storage.readScribeGuidance(next)).additional_guidance, edited);
  assert.equal((await storage.readScribeGuidance(session)).additional_guidance, GUIDANCE);
});

// ---------------------------------------------------------------------------------------------
// Policy source: the real per-session snapshot boundary
// ---------------------------------------------------------------------------------------------

test('a configured session publishes its guidance, and a resume republishes the same snapshot', async () => {
  const sessionId = 'guidance-publish-session';
  const result = await runServiceBatches(POLICY_SOURCE_MANIFEST, [
    { inputs: [lifecycleStart()], expectedOutputCount: 1 },
    { inputs: [guidanceConfigure(sessionId, GUIDANCE)], expectedOutputCount: 2 },
    { inputs: [sessionOutcome('session.recorded', sessionId)], expectedOutputCount: 2 },
    { inputs: [sessionOutcome('session.resumed', sessionId)], expectedOutputCount: 2 }
  ], 8000);

  const [recorded, resumed] = result.batchOutputs.slice(2).map((batch) => batch[0]);
  assert.equal(recorded.message_type, 'scribe.batch-policy');
  assert.equal(recorded.payload.generation.additional_guidance, GUIDANCE);
  assert.equal(recorded.payload.generation.instruction_version, '1.1.0');
  assert.deepEqual(registry.validateEnvelope(recorded), []);
  // Guidance is folded into the policy identity, so it travels through batch identity, checkpoint,
  // and journal on the identity those already carry.
  assert.notEqual(recorded.payload.policy_id, 'electron-scribe-default');
  assert.match(recorded.payload.policy_id, /^electron-scribe-default\+g[0-9a-f]{12}$/);
  // Stop/Resume must not re-resolve guidance: the resumed session gets the identical policy.
  assert.deepEqual(resumed.payload, recorded.payload);
});

test('a session with no configured guidance publishes the protected instruction alone', async () => {
  const sessionId = 'guidance-absent-session';
  const result = await runServiceBatches(POLICY_SOURCE_MANIFEST, [
    { inputs: [lifecycleStart()], expectedOutputCount: 1 },
    { inputs: [sessionOutcome('session.recorded', sessionId)], expectedOutputCount: 2 }
  ], 8000);
  const published = result.batchOutputs[1][0];
  assert.equal(Object.hasOwn(published.payload.generation, 'additional_guidance'), false);
  assert.equal(published.payload.policy_id, 'electron-scribe-default');
  assert.deepEqual(registry.validateEnvelope(published), []);
});

test('a legacy stopped session can republish blank guidance under its original instruction', async () => {
  const sessionId = 'guidance-legacy-close-session';
  const legacy = guidanceConfigure(sessionId, '');
  legacy.payload.instruction_version = '1.0.0';
  const result = await runServiceBatches(POLICY_SOURCE_MANIFEST, [
    { inputs: [lifecycleStart()], expectedOutputCount: 1 },
    { inputs: [legacy], expectedOutputCount: 2 }
  ], 8000);
  const policy = result.batchOutputs[1][0];
  assert.equal(policy.message_type, 'scribe.batch-policy');
  assert.equal(policy.payload.generation.instruction_version, '1.0.0');
  assert.equal(Object.hasOwn(policy.payload.generation, 'additional_guidance'), false);
  assert.deepEqual(registry.validateEnvelope(policy), []);
});

test('the 1.0 guidance carrier remains compatible by using the governed graph instruction', async () => {
  const sessionId = 'guidance-legacy-carrier-session';
  const legacyCarrier = guidanceConfigure(sessionId, GUIDANCE);
  legacyCarrier.schema_version = '1.0.0';
  delete legacyCarrier.payload.instruction_version;
  const result = await runServiceBatches(POLICY_SOURCE_MANIFEST, [
    { inputs: [lifecycleStart()], expectedOutputCount: 1 },
    { inputs: [legacyCarrier], expectedOutputCount: 2 }
  ], 8000);
  const policy = result.batchOutputs[1][0];
  assert.equal(policy.message_type, 'scribe.batch-policy');
  assert.equal(policy.payload.generation.instruction_version, '1.1.0');
  assert.equal(policy.payload.generation.additional_guidance, GUIDANCE);
  assert.deepEqual(registry.validateEnvelope(policy), []);
});

test('re-sending the identical snapshot is idempotent but a different one is a visible conflict', async () => {
  const sessionId = 'guidance-conflict-session';
  const result = await runServiceBatches(POLICY_SOURCE_MANIFEST, [
    { inputs: [lifecycleStart()], expectedOutputCount: 1 },
    { inputs: [guidanceConfigure(sessionId, GUIDANCE)], expectedOutputCount: 2 },
    // The same value again - a restart re-asserting what the session already runs under.
    { inputs: [guidanceConfigure(sessionId, GUIDANCE)], expectedOutputCount: 2 },
    // A different value for a session already snapshotted is the substitution this forbids.
    { inputs: [guidanceConfigure(sessionId, 'Capture everything, including chatter.')], expectedOutputCount: 1 },
    { inputs: [sessionOutcome('session.recorded', sessionId)], expectedOutputCount: 2 }
  ], 8000);

  const rejection = result.batchOutputs[3][0];
  assert.equal(rejection.message_type, 'service.failure');
  assert.equal(rejection.payload.error.code, 'SCRIBE_GUIDANCE_CONFLICT');
  assert.deepEqual(registry.validateEnvelope(rejection), []);
  // The original snapshot survived the rejected replacement.
  assert.equal(result.batchOutputs[4][0].payload.generation.additional_guidance, GUIDANCE);
});

test('the policy source rejects a fingerprint that does not bind the offered guidance', async () => {
  const sessionId = 'guidance-fingerprint-conflict-session';
  const forged = guidanceConfigure(sessionId, GUIDANCE);
  forged.payload.guidance_fingerprint = scribeGuidanceFingerprint('different guidance');
  const result = await runServiceBatches(POLICY_SOURCE_MANIFEST, [
    { inputs: [lifecycleStart()], expectedOutputCount: 1 },
    { inputs: [forged], expectedOutputCount: 1 }
  ], 8000);
  assert.equal(result.batchOutputs[1][0].message_type, 'service.failure');
  assert.equal(result.batchOutputs[1][0].payload.error.code, 'SCRIBE_GUIDANCE_FINGERPRINT_CONFLICT');
});

test('two sessions in one run carry their own guidance', async () => {
  const first = 'guidance-session-one';
  const second = 'guidance-session-two';
  const next = 'Capture only decisions.';
  const result = await runServiceBatches(POLICY_SOURCE_MANIFEST, [
    { inputs: [lifecycleStart()], expectedOutputCount: 1 },
    { inputs: [guidanceConfigure(first, GUIDANCE)], expectedOutputCount: 2 },
    { inputs: [sessionOutcome('session.recorded', first)], expectedOutputCount: 2 },
    // The user edits guidance; the next new session picks it up while the first keeps its own.
    { inputs: [guidanceConfigure(second, next)], expectedOutputCount: 2 },
    { inputs: [sessionOutcome('session.recorded', second)], expectedOutputCount: 2 },
    { inputs: [sessionOutcome('session.resumed', first)], expectedOutputCount: 2 }
  ], 8000);

  assert.equal(result.batchOutputs[2][0].payload.generation.additional_guidance, GUIDANCE);
  assert.equal(result.batchOutputs[4][0].payload.generation.additional_guidance, next);
  assert.equal(result.batchOutputs[5][0].payload.generation.additional_guidance, GUIDANCE);
});

test('the policy source refuses guidance beyond the governed bound', async () => {
  const sessionId = 'guidance-oversized-session';
  const result = await runServiceBatches(POLICY_SOURCE_MANIFEST, [
    { inputs: [lifecycleStart()], expectedOutputCount: 1 },
    { inputs: [guidanceConfigure(sessionId, 'a'.repeat(SCRIBE_GUIDANCE_LIMITS.max_chars + 1))], expectedOutputCount: 1 }
  ], 8000);
  const failure = result.batchOutputs[1][0];
  assert.equal(failure.message_type, 'service.failure');
  assert.match(failure.payload.error.message, /exceeds 2000 characters/);
});

// ---------------------------------------------------------------------------------------------
// Contract compatibility
// ---------------------------------------------------------------------------------------------

test('the guidance carrier is governed, bounded, and carries no credential or provider field', async () => {
  const definition = registry.catalog.messages['scribe.guidance-configure'];
  assert.equal(definition.plane, 'control');
  assert.equal(definition.version, '1.1.0');
  const schema = JSON.parse(await readFile(path.join(root, 'contracts', 'scribe-guidance-configure.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.additional_guidance.maxLength, SCRIBE_GUIDANCE_LIMITS.max_chars);
  const serialized = JSON.stringify(schema);
  for (const forbidden of ['api_key', 'credential', 'secret', 'endpoint', 'model', 'provider']) {
    assert.equal(serialized.includes(forbidden), false, `guidance carrier must not mention ${forbidden}`);
  }
});

test('a 1.0.0 policy with no guidance still replays under the 1.1.0 schema', async () => {
  const legacy = JSON.parse(await readFile(path.join(root, 'tests', 'fixtures', 'contracts', 'scribe.batch-policy', '1.0.0', 'valid.json'), 'utf8'));
  assert.equal(Object.hasOwn(legacy.payload.generation, 'additional_guidance'), false);
  assert.deepEqual(registry.validateEnvelope(legacy), []);
});

test('a policy carrying guidance validates and an over-limit one does not', async () => {
  const guided = JSON.parse(await readFile(path.join(root, 'tests', 'fixtures', 'contracts', 'scribe.batch-policy', '1.1.0', 'valid.json'), 'utf8'));
  assert.equal(guided.payload.generation.additional_guidance, GUIDANCE);
  assert.deepEqual(registry.validateEnvelope(guided), []);

  const oversized = structuredClone(guided);
  oversized.payload.generation.additional_guidance = 'a'.repeat(SCRIBE_GUIDANCE_LIMITS.max_chars + 1);
  assert.notDeepEqual(registry.validateEnvelope(oversized), []);

  // Guidance is the only thing the minor added; an unrelated field is still refused.
  const smuggled = structuredClone(guided);
  smuggled.payload.generation.max_items = 99;
  assert.notDeepEqual(registry.validateEnvelope(smuggled), []);
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

async function temporaryStorage(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scribe-guidance-store-'));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  t.after(cleanup);
  const storage = new SessionStorage({ root: directory });
  await storage.ensureRoot();
  return { storage, directory, cleanup };
}

function lifecycleStart() {
  return createEnvelope({
    plane: 'control',
    messageType: 'lifecycle.start',
    producer: 'guidance-test',
    correlationId: 'desktop-bootstrap',
    payload: {
      session_id: 'desktop-bootstrap',
      configuration: {
        scribe_policy: {
          policy_id: 'electron-scribe-default',
          policy_version: '1.0.0',
          admission: { rows_per_batch: 3, idle_timeout_ms: 15000 },
          context: { max_total_context_tokens: 8000 },
          generation: { policy_profile: 'neutral-contextual-log', instruction_version: '1.1.0' }
        }
      }
    }
  });
}

function guidanceConfigure(sessionId, guidance) {
  return createEnvelope({
    plane: 'control',
    messageType: 'scribe.guidance-configure',
    producer: 'guidance-test',
    correlationId: sessionId,
    payload: { session_id: sessionId, additional_guidance: guidance, guidance_fingerprint: scribeGuidanceFingerprint(guidance), instruction_version: '1.1.0' }
  });
}

function sessionOutcome(messageType, sessionId) {
  return createEnvelope({
    plane: 'control',
    messageType,
    producer: 'guidance-test',
    correlationId: sessionId,
    payload: {
      operation_id: `${sessionId}:${messageType}`,
      session_id: sessionId,
      state: messageType === 'session.recorded' ? 'recording' : 'recording',
      session_revision: 1,
      completed_at: '2026-09-11T00:00:00.000Z'
    }
  });
}

function guidanceSnapshot(sessionId, guidance) {
  return {
    schema_version: '1.0.0',
    session_id: sessionId,
    saved_at: '2026-09-11T00:00:00.000Z',
    additional_guidance: guidance,
    guidance_fingerprint: scribeGuidanceFingerprint(guidance)
  };
}

function newEvidence() {
  return [
    { segment_id: 'segment-10', revision: 0, sequence: 10, start_time: '00:00:10.000', end_time: '00:00:11.000', text: 'We agreed to ship the draft Friday.' },
    { segment_id: 'segment-11', revision: 0, sequence: 11, start_time: '00:00:11.000', end_time: '00:00:12.000', text: 'Someone still needs to confirm the reviewer.' },
    { segment_id: 'segment-12', revision: 0, sequence: 12, start_time: '00:00:12.000', end_time: '00:00:13.000', text: 'Remind the team about the Friday deadline.' }
  ];
}

function backgroundContext() {
  return {
    transcript_segments: [
      { segment_id: 'segment-7', sequence: 7, start_time: '00:00:07.000', end_time: '00:00:08.000', text: 'Oldest background turn.', relation: 'lookback' },
      { segment_id: 'segment-8', sequence: 8, start_time: '00:00:08.000', end_time: '00:00:09.000', text: 'Middle background turn.', relation: 'lookback' },
      { segment_id: 'segment-9', sequence: 9, start_time: '00:00:09.000', end_time: '00:00:10.000', text: 'Newest background turn.', relation: 'lookback' }
    ],
    prior_logged_items: [
      { text: 'Draft is due for review.', kind: 'action', source_segment_ids: ['segment-3'] },
      { text: 'Reviewer list was circulated.', kind: 'other', source_segment_ids: ['segment-5'] }
    ]
  };
}

function batchIdentity(requestId, instructionVersion) {
  return {
    request_id: requestId,
    session_id: session,
    segments: newEvidence().map((segment) => ({ segment_id: segment.segment_id, revision: 0, sequence: segment.sequence })),
    first_sequence: 10,
    last_sequence: 12,
    admission_reason: 'batch-complete',
    policy_id: 'scribe-default',
    policy_version: '1.0.0',
    instruction_version: instructionVersion
  };
}

function scribePolicy(totalContextTokens = 8000, guidance, instructionVersion = '1.1.0') {
  return {
    policy_id: 'scribe-default',
    policy_version: '1.0.0',
    session_id: session,
    admission: { rows_per_batch: 3, idle_timeout_ms: 15000 },
    context: { max_total_context_tokens: totalContextTokens },
    generation: {
      policy_profile: 'neutral-contextual-log',
      instruction_version: instructionVersion,
      ...(guidance ? { additional_guidance: guidance } : {})
    }
  };
}

function dispatchInput({ requestId = 'guidance-batch-1', totalContextTokens = 8000, guidance, instructionVersion = '1.1.0' } = {}) {
  return {
    batch: {
      batch_identity: batchIdentity(requestId, instructionVersion),
      batch_attempt: 1,
      new_evidence_segments: newEvidence(),
      background_context: backgroundContext(),
      policy_profile: 'neutral-contextual-log',
      instruction_version: instructionVersion
    },
    policy: scribePolicy(totalContextTokens, guidance, instructionVersion),
    workId: `logged-item-extraction:${session}:${requestId}:batch-attempt-1`,
    modelName: MODEL
  };
}
