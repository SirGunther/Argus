import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { DesktopApplication } from '../runtime/desktop-application.mjs';
import { startRealScribeHarness } from './helpers/real-scribe-harness.mjs';
import { startRecordingModelProxy } from './helpers/recording-model-proxy.mjs';

/**
 * SCRIBE-06 acceptance coverage against a REAL model provider.
 *
 * Every other Scribe suite proves a governed behavior against a deterministic endpoint whose reply
 * and latency the test chooses. That is the right shape for a gate, but it cannot answer the
 * question this ticket exists to answer: does the shipped path survive a real provider whose
 * inference takes as long as it takes. The defect SCRIBE-05A fixed was invisible to every fast
 * deterministic endpoint in the suite and only appeared against LM Studio.
 *
 * So these tests keep the production admission deadline (`ai.work-request`, 5,000 ms in
 * `wiring/production-electron.json`) and let a real model take real time against it. Nothing about
 * the model, the queue, the durable storage, or the Logged Item path is simulated. The only
 * substitution is Whisper, which is the physical microphone boundary and is recorded as such.
 *
 * The provider-backed tests skip unless a real provider answers, so they never turn the default
 * suite red on a machine without LM Studio - and, equally, never report a pass they did not earn.
 * The host session-start regression below needs no provider and always runs.
 */
const UPSTREAM = process.env.ARGUS_ACCEPTANCE_ENDPOINT || 'http://127.0.0.1:1234/v1/chat/completions';
const MODELS_URL = new URL('../models', UPSTREAM).href;
const PREFERRED_MODEL = process.env.ARGUS_ACCEPTANCE_MODEL;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_FILE = process.env.ARGUS_ACCEPTANCE_EVIDENCE || path.join(root, 'runtime-output', 'scribe-acceptance-evidence.json');

const provider = await probeProvider();
const skip = provider.available ? false : `no real model provider answered at ${UPSTREAM}: ${provider.reason}`;
const MODEL = provider.model;
const evidence = {
  provider: { endpoint: UPSTREAM, model: MODEL, available: provider.available, reason: provider.reason },
  recorded_at: new Date().toISOString(),
  scenarios: {}
};

after(async () => {
  await mkdir(path.dirname(EVIDENCE_FILE), { recursive: true });
  await writeFile(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
});

// ---------------------------------------------------------------------------------------------
// The defect SCRIBE-06 acceptance found. Marked `todo` because it fails on `origin/main` at
// 5dbeae3 and SCRIBE-06 owns no production file that could fix it - not because the expectation is
// uncertain. `node --test` reports a todo separately from a failure, so the assertion below stays
// in the suite as the executable statement of correct behavior without falsifying the gate result.
//
// What it asserts: `DesktopApplication` publishes a session's Scribe policy twice at session start
// - once from `configureScribeGuidance` (desktop-application.mjs:600, unconditional, before the
// command is dispatched) and once from the `session.recorded` lifecycle outcome. The coordinator
// emits `scribe.recovery-request` for each, and its identity key (scribe-coordinator/index.mjs:101)
// covers only boot id, session, policy id and policy version - so both carry one key. The semantic
// fingerprint (message-identity.mjs:53) includes `causation_id`, which differs. The result is
// IDEMPOTENCY_KEY_CONFLICT, the coordinator's output is rejected, its recovery handshake never
// completes, and it then refuses every finalized transcript row for the life of the session.
//
// Bisected: 9973a47 (pre-SCRIBE-05B) emits one recovery-request and no failure; eebc74f introduces
// the second publication. Nothing self-heals it - not further rows, not Stop, not Resume.
test('the host publishes one session-start recovery request, not two under one key', {
  todo: 'fails on origin/main 5dbeae3; SCRIBE-05B regression, production fix is outside SCRIBE-06 ownership',
  timeout: 120000
}, async () => {
  const sessionRoot = path.join(os.tmpdir(), `argus-host-acceptance-${Math.random().toString(36).slice(2, 8)}`);
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot });
  const recoveryRequests = [];
  const failures = [];
  await application.start();
  const graph = application.graph;
  const priorOnMessage = graph.onMessage?.bind(graph);
  graph.onMessage = (message) => {
    if (message.message_type === 'scribe.recovery-request') recoveryRequests.push(message);
    if (message.message_type === 'service.failure') failures.push(message.payload?.error?.message || 'failure');
    return priorOnMessage?.(message);
  };
  const priorOnStatus = graph.onStatus?.bind(graph);
  graph.onStatus = (status) => {
    if (status.type === 'service-failure' || status.type === 'graph-failure') failures.push(status.payload?.error?.message || status.message);
    return priorOnStatus?.(status);
  };
  try {
    await application.bootstrap();
    await application.handleCommand({ command_id: `acceptance-${Math.random().toString(36).slice(2, 8)}`, session_id: application.sessionId, command: 'session.record' });
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const keys = new Set(recoveryRequests.map((message) => message.idempotency_key));
    const causations = new Set(recoveryRequests.map((message) => message.causation_id));
    evidence.scenarios.host_session_start = {
      recovery_request_count: recoveryRequests.length,
      distinct_idempotency_keys: keys.size,
      distinct_causation_ids: causations.size,
      failures: [...new Set(failures)]
    };
    assert.deepEqual([...new Set(failures)], [], 'starting a session must raise no service failure');
    assert.equal(recoveryRequests.length, 1, 'one session start is one recovery request');
    assert.equal(keys.size, recoveryRequests.length, 'no two recovery requests may share an identity key');
  } finally {
    await application.shutdown().catch(() => {});
  }
});

// Scenario 1 + 3 + 14. The single most important provider-backed claim in this ticket: a real
// inference that vastly outlasts the wire's admission deadline must not fail the wire, must not
// strand the next batch, and must not slow transcript finalization. The original defect was exactly
// this, and the automated reproduction of it scales the deadline down to 400 ms against a 900 ms
// reply - a ratio, not the real quantity. Here the deadline is the shipped 5,000 ms and the
// inference is however long the real model takes.
//
// This session start deliberately omits `scribe.guidance-configure`, because including it is what
// the todo test above proves is broken. That omission is the one way this scenario differs from the
// shipped host, and it is recorded in the evidence file rather than papered over: it isolates the
// admission behavior under test from the unrelated session-start defect blocking it.
test('consecutive real batches survive an inference far longer than the admission deadline', { skip, timeout: 900000 }, async () => {
  const proxy = await startRecordingModelProxy({ upstream: UPSTREAM });
  const harness = await startRealScribeHarness({ endpointUrl: proxy.url, modelName: MODEL });
  const transcriptLatencies = [];
  try {
    const admissionDeadlineMs = admissionDeadlineOf(harness.graphDefinition);
    assert.equal(admissionDeadlineMs, 5000, 'this scenario is only meaningful at the production admission deadline');

    await harness.record();
    for (const [index, text] of FIRST_BATCH.entries()) transcriptLatencies.push(await timedRow(harness, index, text));
    await harness.waitFor(() => harness.admitted.length >= 1, 'first batch admitted', 30000);
    assert.deepEqual(sequencesOf(harness.admitted[0]), [0, 1, 2], 'exactly the three new rows are admitted immediately');

    // Rows that arrive while the model is still working stay in authoritative transcript history.
    // If transcript finalization were coupled to Scribe, these would block behind the inference.
    for (const [offset, text] of SECOND_BATCH.entries()) {
      transcriptLatencies.push(await timedRow(harness, FIRST_BATCH.length + offset, text));
    }

    await harness.waitFor(() => harness.evaluated.length >= 2, 'both real batches settle', 900000);
    await harness.waitForCursor(5, 'the durable cursor reaches the last finalized row');

    const slowest = Math.max(...proxy.calls.map((call) => call.upstream_duration_ms));
    assert.equal(proxy.calls.length, 2, 'each batch reaches the provider exactly once');
    assert.deepEqual(harness.admitted.map(sequencesOf), [[0, 1, 2], [3, 4, 5]], 'no row is skipped or re-sent');
    assert.deepEqual(harness.failures.map(describeFailure), [], 'a slow but healthy inference fails no wire');
    assert.ok(slowest > admissionDeadlineMs, `this scenario only proves anything if a real inference outlasted the ${admissionDeadlineMs} ms admission deadline; slowest was ${slowest} ms`);

    const checkpoint = await harness.checkpoint();
    assert.equal(checkpoint.admitted_through.last_sequence, 5);
    assert.equal(checkpoint.in_flight_batch, undefined, 'no batch is left silently in flight');

    // Scenario 14: transcript finalization latency is unrelated to inference latency.
    const worstTranscript = Math.max(...transcriptLatencies);
    assert.ok(worstTranscript < 5000, `transcript finalization must not wait on Scribe; worst row took ${worstTranscript} ms`);

    evidence.scenarios.slow_model_catch_up = {
      session_start_omits_guidance_configure: true,
      admission_deadline_ms: admissionDeadlineMs,
      inference_durations_ms: proxy.calls.map((call) => call.upstream_duration_ms),
      slowest_inference_ms: slowest,
      ratio_to_admission_deadline: Number((slowest / admissionDeadlineMs).toFixed(1)),
      batches_admitted: harness.admitted.map(sequencesOf),
      outcomes: harness.evaluated.map((message) => message.payload.batch.outcome),
      logged_items_stored: harness.stored.length,
      wire_failures: harness.failures.length,
      durable_cursor: checkpoint.admitted_through.last_sequence,
      transcript_finalization_ms: transcriptLatencies,
      worst_transcript_finalization_ms: worstTranscript,
      request_bytes: proxy.calls.map((call) => call.request_bytes)
    };
  } finally {
    await harness.shutdown();
    await proxy.close();
  }
});

// Scenario 10 + 16. What the model actually received, and what came back. The exit gate asks for
// the bounded Scribe request shape and the protected instruction, neither of which can be read from
// the provider's own UI.
//
// Only the DEFAULT (no guidance) request can be obtained on this baseline. The guided request needs
// `scribe.guidance-configure`, which is the message the session-start defect makes fatal, so
// scenario 11 is recorded as blocked rather than claimed.
test('the real default request carries the protected instruction and bounded, stateless context', { skip, timeout: 900000 }, async () => {
  const proxy = await startRecordingModelProxy({ upstream: UPSTREAM });
  const harness = await startRealScribeHarness({ endpointUrl: proxy.url, modelName: MODEL });
  try {
    await harness.record();
    for (const [index, text] of FIRST_BATCH.entries()) await harness.finalizeRow(index, text);
    await harness.waitFor(() => proxy.calls.length >= 1, 'the request reaches the real provider', 60000);
    await harness.waitFor(() => harness.evaluated.length >= 1, 'the real batch settles', 900000);
    const call = proxy.calls[0];

    assert.match(call.systemPrompt, /Argus Scribe/, 'the protected instruction reaches the model');
    assert.match(call.systemPrompt, /zero/i, 'the instruction states that zero items is a valid answer');
    assert.equal(call.authorization_present, false, 'a local provider receives no credential');
    assert.ok(call.modelRequest, 'the governed request is the user message, parseable as JSON');
    assert.equal(call.modelRequest.purpose, 'logged-item-extraction');
    assert.equal(call.modelRequest.model, MODEL, 'the request names the configured model');
    assert.ok(Array.isArray(call.modelRequest.new_evidence_segments) && call.modelRequest.new_evidence_segments.length >= 1);
    assert.ok('background_context' in call.modelRequest, 'background context is a separate field from new evidence');
    // Statelessness: no provider-side conversation handle, no replayed prior turn.
    assert.equal(call.envelope.messages.length, 2, 'each call is a fresh two-message request');
    for (const forbidden of ['conversation_id', 'thread_id', 'previous_response_id']) {
      assert.equal(Object.hasOwn(call.envelope, forbidden), false, `request must not carry ${forbidden}`);
    }

    // Scenario 16, as far as an automated check can carry it. `logged-item.stored` records
    // provenance as a first/last segment range, so the check is that the range endpoints are
    // segments this batch admitted as NEW evidence - not background context, and not a segment from
    // some other batch. Provenance that pointed at background would be the specific failure the
    // background/new-evidence split exists to prevent.
    const admittedSegmentIds = new Set(harness.admitted[0].payload.new_evidence_segments.map((segment) => segment.segment_id));
    const provenance = harness.stored.map((message) => ({
      item_id: message.payload.item_id,
      first_segment_id: message.payload.source?.first_segment_id,
      last_segment_id: message.payload.source?.last_segment_id
    }));
    for (const entry of provenance) {
      assert.ok(entry.first_segment_id && entry.last_segment_id, `item ${entry.item_id} carries a source segment range`);
      assert.ok(admittedSegmentIds.has(entry.first_segment_id), `item ${entry.item_id} cites new evidence, not background, as its first source segment`);
      assert.ok(admittedSegmentIds.has(entry.last_segment_id), `item ${entry.item_id} cites new evidence, not background, as its last source segment`);
    }

    evidence.scenarios.request_shape = {
      request_bytes: call.request_bytes,
      governed_limits: call.modelRequest.limits,
      instruction_version: call.modelRequest.instruction_version,
      policy_profile: call.modelRequest.policy_profile,
      new_evidence_segment_count: call.modelRequest.new_evidence_segments.length,
      background_context_present: 'background_context' in call.modelRequest,
      messages_per_call: call.envelope.messages.length,
      authorization_header_sent: call.authorization_present,
      admitted_segment_ids: [...admittedSegmentIds],
      stored_item_provenance: provenance,
      outcome: harness.evaluated[0].payload.batch.outcome
    };
  } finally {
    await harness.shutdown();
    await proxy.close();
  }
});

// Scenario 2. The real 15,000 ms idle threshold, not a scaled-down one. A one-row remainder must
// wait for the threshold and must then be admitted with the governed reason.
test('a one-row remainder waits the real idle threshold and is then admitted', { skip, timeout: 900000 }, async () => {
  const proxy = await startRecordingModelProxy({ upstream: UPSTREAM });
  const harness = await startRealScribeHarness({ endpointUrl: proxy.url, modelName: MODEL });
  try {
    await harness.record();
    const started = performance.now();
    await harness.finalizeRow(0, 'Let us table the budget question until Priya is back from leave on the fourth.');
    await new Promise((resolve) => setTimeout(resolve, 8000));
    assert.equal(harness.admitted.length, 0, 'a single row must not be admitted before the idle threshold elapses');
    await harness.waitFor(() => harness.admitted.length >= 1, 'the idle remainder is admitted', 60000);
    const waitedMs = Math.round(performance.now() - started);

    assert.deepEqual(sequencesOf(harness.admitted[0]), [0]);
    assert.equal(harness.admitted[0].payload.batch_identity.admission_reason, 'idle-timeout');
    assert.ok(waitedMs >= 15000, `the remainder must wait the full governed threshold; waited ${waitedMs} ms`);
    evidence.scenarios.idle_remainder = {
      idle_threshold_ms: harness.graphDefinition.run.configuration.scribe_policy.admission.idle_timeout_ms,
      observed_wait_ms: waitedMs,
      admitted_sequences: sequencesOf(harness.admitted[0]),
      admission_reason: harness.admitted[0].payload.batch_identity.admission_reason,
      premature_admissions: 0
    };
  } finally {
    await harness.shutdown();
    await proxy.close();
  }
});

// Scenario 6. A provider that is genuinely gone - not one told to return an error. The batch must
// stay identical, the cursor must not move, and the failure must be visible rather than silent.
test('an unreachable real provider leaves the identical batch retained and the cursor unmoved', { skip, timeout: 300000 }, async () => {
  // A closed loopback port is the honest shape of "LM Studio is not running": connection refused,
  // not a courteous JSON error from a server that is in fact alive.
  const deadProxy = await startRecordingModelProxy({ upstream: UPSTREAM });
  const deadUrl = deadProxy.url;
  await deadProxy.close();
  const harness = await startRealScribeHarness({ endpointUrl: deadUrl, modelName: MODEL });
  try {
    await harness.record();
    for (const [index, text] of FIRST_BATCH.entries()) await harness.finalizeRow(index, text);
    await harness.waitFor(() => harness.admitted.length >= 1, 'the batch is admitted', 30000);
    const firstBatchId = harness.admitted[0].payload.batch_identity.request_id;
    await harness.waitFor(() => harness.failures.length >= 1, 'the provider failure becomes visible', 120000);

    const checkpoint = await harness.checkpoint();
    assert.notEqual(checkpoint?.admitted_through?.last_sequence, 2, 'a failed batch must not advance the cursor');
    assert.equal(harness.stored.length, 0, 'a failed batch stores no Logged Item');
    const retriedIds = new Set(harness.admitted.map((message) => message.payload.batch_identity.request_id));
    assert.ok(retriedIds.has(firstBatchId), 'the identical batch identity is retained across the failure');
    const codes = harness.failures.map((failure) => failure.payload?.error?.code).filter(Boolean);
    assert.ok(codes.length > 0, 'the failure carries a governed code rather than disappearing');

    evidence.scenarios.provider_unreachable = {
      failure_codes: [...new Set(codes)],
      retained_batch_identities: [...retriedIds],
      cursor_after_failure: checkpoint?.admitted_through?.last_sequence ?? null,
      logged_items_stored: harness.stored.length
    };
  } finally {
    await harness.shutdown();
  }
});

// Scenario 12. Guidance is snapshotted per session. A second, different value for the same session
// is the substitution the guidance surface exists to prevent, and must be a visible conflict.
test('a running session refuses a second, different guidance value', { skip, timeout: 300000 }, async () => {
  const proxy = await startRecordingModelProxy({ upstream: UPSTREAM });
  const harness = await startRealScribeHarness({ endpointUrl: proxy.url, modelName: MODEL, guidance: 'Prefer decisions over discussion.' });
  try {
    await harness.record();
    // Re-sending the identical value is idempotent: the host replays it on resume.
    await harness.configureGuidance('Prefer decisions over discussion.');
    let conflict;
    try { await harness.configureGuidance('Prefer risks over decisions.'); }
    catch (error) { conflict = error; }
    assert.ok(conflict, 'a different guidance value for a snapshotted session must be refused');
    assert.match(String(conflict.message || conflict), /guidance/i);
    evidence.scenarios.guidance_immutability = {
      identical_replay_accepted: true,
      different_value_refused: true,
      refusal: String(conflict.code || conflict.message || conflict).slice(0, 200)
    };
  } finally {
    await harness.shutdown();
    await proxy.close();
  }
});

// A real-world failure point no scenario in the ticket names, found while tracing how the model
// name reaches the wire. The extraction boundary reads `ARGUS_MODEL_NAME` from its own process
// environment, fixed at spawn; the model lane is reconfigured by a live `ai.provider-configure`.
// Switching models in the settings drawer mid-session therefore moves one and not the other. That
// divergence must fail closed and visibly, never silently prompt a different model than the
// governed request claims - the request fingerprint would otherwise attest to work that did not
// happen.
test('switching the configured model mid-session fails closed instead of prompting a mismatched model', { skip, timeout: 300000 }, async () => {
  const proxy = await startRecordingModelProxy({ upstream: UPSTREAM });
  const harness = await startRealScribeHarness({ endpointUrl: proxy.url, modelName: MODEL });
  try {
    await harness.record();
    // Exactly what `DesktopApplication.synchronizeModelProvider` sends after the user saves new
    // provider settings. The already-spawned extractor keeps the model name it started with.
    await harness.graph.dispatchFrom('@desktop-controller', 'control', 'ai.provider-configure', harness.sessionId, {
      configuration: { version: 1, mode: 'local', provider: 'lm-studio', endpoint: proxy.url, model: `${MODEL}-switched`, protocol: 'openai-compatible', timeout_ms: 120000 },
      credential: { provided: false }
    }, `provider-switch:${harness.sessionId}`);
    await harness.graph.waitForIdle();

    for (const [index, text] of FIRST_BATCH.entries()) await harness.finalizeRow(index, text);
    await harness.waitFor(() => harness.failures.length >= 1 || harness.evaluated.length >= 1, 'the divergence resolves one way or the other', 120000);

    const codes = [...new Set(harness.failures.map((failure) => failure.payload?.error?.code).filter(Boolean))];
    assert.equal(harness.stored.length, 0, 'a divergent model name must not silently store an item');
    assert.ok(codes.includes('MODEL_CONFIGURATION_CONFLICT'), `the divergence must surface as MODEL_CONFIGURATION_CONFLICT; saw ${codes.join(', ') || 'nothing'}`);
    assert.equal(proxy.calls.length, 0, 'no request may reach the provider under a mismatched model name');
    const checkpoint = await harness.checkpoint();
    assert.notEqual(checkpoint?.admitted_through?.last_sequence, 2, 'the cursor must not advance past an unresolved batch');

    evidence.scenarios.model_switch_divergence = {
      failure_codes: codes,
      reached_provider: proxy.calls.length,
      logged_items_stored: harness.stored.length,
      cursor_after_divergence: checkpoint?.admitted_through?.last_sequence ?? null
    };
  } finally {
    await harness.shutdown();
    await proxy.close();
  }
});

const FIRST_BATCH = [
  'Kevin agreed to send the revised vendor contract to legal by Thursday afternoon.',
  'We also decided to postpone the Denver site visit until the second week of October.',
  'Nothing else came up on that topic so we moved on.'
];

const SECOND_BATCH = [
  'Dana raised a risk that the migration window overlaps with the quarterly close.',
  'She will confirm with finance and report back before the Friday standup.',
  'That was the last item on the agenda.'
];

async function timedRow(harness, index, text) {
  const started = performance.now();
  await harness.finalizeRow(index, text);
  await harness.waitFor(() => harness.segments.length >= index + 1, `transcript row ${index} finalized`, 30000);
  return Math.round(performance.now() - started);
}

function sequencesOf(message) {
  return message.payload.new_evidence_segments.map((segment) => segment.sequence);
}

function describeFailure(failure) {
  return failure.payload?.error?.code || failure.payload?.error?.message || failure.message;
}

function admissionDeadlineOf(definition) {
  const wire = definition.control_wires.find((candidate) => candidate.from === 'log-extractor' && candidate.to === 'model-lane' && candidate.contract === 'ai.work-request');
  return wire?.delivery?.operation_timeout_ms;
}

async function probeProvider() {
  try {
    const response = await fetch(MODELS_URL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { available: false, reason: `HTTP ${response.status}` };
    const body = await response.json();
    const ids = (body?.data || []).map((entry) => entry.id).filter((id) => !/embed/i.test(id));
    if (!ids.length) return { available: false, reason: 'no non-embedding model is loaded' };
    const model = PREFERRED_MODEL && ids.includes(PREFERRED_MODEL) ? PREFERRED_MODEL : ids[0];
    return { available: true, model, reason: 'ok', models: ids };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}
