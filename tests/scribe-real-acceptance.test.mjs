import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { DesktopApplication } from '../runtime/desktop-application.mjs';
import { startRealScribeHarness } from './helpers/real-scribe-harness.mjs';
import { startRecordingModelProxy } from './helpers/recording-model-proxy.mjs';
import { startScribeBatchModelEndpoint } from './helpers/scribe-batch-model-endpoint.mjs';

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
 * Scope limit, stated up front: these scenarios drive the production graph directly. They do NOT
 * drive the shipped desktop startup sequence, because they dispatch `session.record` without the
 * `scribe.guidance-configure` that `DesktopApplication` always sends first. What they validate is
 * the admission, batching, request-shape and failure behavior of the graph under a real provider -
 * not that a user pressing Record gets that behavior. The host session-start regression below is
 * the only test here that exercises `DesktopApplication` itself.
 *
 * The whole file is opt-in and skips without the provider, so it never turns the default suite red
 * and never reports a pass it did not earn.
 */
const UPSTREAM = process.env.ARGUS_ACCEPTANCE_ENDPOINT || 'http://127.0.0.1:1234/v1/chat/completions';
const MODELS_URL = new URL('../models', UPSTREAM).href;
const PREFERRED_MODEL = process.env.ARGUS_ACCEPTANCE_MODEL;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_FILE = process.env.ARGUS_ACCEPTANCE_EVIDENCE || path.join(root, 'runtime-output', 'scribe-acceptance-evidence.json');

// Real-provider acceptance is an explicit command, never part of the default deterministic suite.
// Without the opt-in this file probes nothing, runs nothing, and writes nothing - `npm test` must
// stay fast, offline, and free of side effects.
const OPTED_IN = process.env.ARGUS_SCRIBE_ACCEPTANCE === '1';
const OPT_IN_NOTE = 'real-provider acceptance is opt-in: set ARGUS_SCRIBE_ACCEPTANCE=1';
const provider = OPTED_IN ? await probeProvider() : { available: false, reason: OPT_IN_NOTE };
const skip = OPTED_IN
  ? (provider.available ? false : `no real model provider answered at ${UPSTREAM}: ${provider.reason}`)
  : OPT_IN_NOTE;
const MODEL = provider.model;
const evidence = {
  provider: { endpoint: UPSTREAM, model: MODEL, available: provider.available, reason: provider.reason },
  recorded_at: new Date().toISOString(),
  scenarios: {}
};

after(async () => {
  if (!OPTED_IN) return;
  await mkdir(path.dirname(EVIDENCE_FILE), { recursive: true });
  await writeFile(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
});

// ---------------------------------------------------------------------------------------------
// SCRIBE-06B. Formerly a `todo` recording a confirmed defect: `DesktopApplication` published a
// session's Scribe policy twice at session start - once from `configureScribeGuidance`
// (desktop-application.mjs:600, unconditional, before the command is dispatched) and once from the
// `session.recorded` lifecycle outcome. The coordinator emitted `scribe.recovery-request` for each,
// and its identity key (scribe-coordinator/index.mjs:101) covers only boot id, session, policy id
// and policy version - so both carried one key. The semantic fingerprint (message-identity.mjs:53)
// includes `causation_id`, which differed, so the second output was rejected with
// IDEMPOTENCY_KEY_CONFLICT.
//
// Fixed in `services/scribe-coordinator/coordinator.mjs`: `recoveryRequest` now emits at most one
// outstanding request per session while unrecovered (`state.recoveryRequested`), so a second replay
// of byte-identical policy content is silently absorbed instead of manufacturing a second logical
// request under a different causation. The coordinator-level proof of that, including that a
// distinct session is unaffected, is in `tests/scribe-coordinator.test.mjs`.
//
// This test proves the same thing through the real host sequence, and further proves recovery
// actually completes and finalized evidence is admitted afterward - the two things a duplicate
// recovery-request could otherwise still silently prevent even if the request count were merely
// hidden rather than fixed. The only substitution is Whisper, replaced by the same injected
// `transcript.word-committed`/`transcript.utterance-boundary` traffic used throughout this test
// file's other scenarios; that is the physical-microphone boundary, not a change to how Whisper,
// audio, prompting, batching, or the graph's other wiring behaves.
//
// Bisected: 9973a47 (pre-SCRIBE-05B) emits one recovery request and no failure; eebc74f introduces
// the second publication.
test('the host publishes one session-start recovery request, recovers, and admits evidence', {
  skip: OPTED_IN ? false : OPT_IN_NOTE,
  timeout: 120000
}, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'argus-host-acceptance-'));
  const sessionRoot = path.join(base, 'sessions');
  const graphFile = path.join(base, 'graph.json');
  await writeWhisperSubstitutedGraph(graphFile);
  // A non-empty reply, not just `items: []`: the checklist item is "admitted after recovery and
  // CAN PRODUCE Logged Items", which an always-empty batch would not actually demonstrate.
  const endpoint = await startScribeBatchModelEndpoint({
    reply: (request) => {
      const segmentId = request?.new_evidence_segments?.[0]?.segment_id;
      return segmentId ? { items: [{ text: 'A decision was made.', kind: 'decision', source_segment_ids: [segmentId] }] } : { items: [] };
    }
  });
  process.env.ARGUS_MODEL_ENDPOINT = endpoint.url;
  process.env.ARGUS_MODEL_NAME = 'scribe-06b-regression-model';
  process.env.ARGUS_MODEL_PROTOCOL = 'openai-compatible';
  process.env.ARGUS_MODEL_TIMEOUT_MS = '30000';
  const application = new DesktopApplication({ root, graphFile, sessionRoot });
  const recoveryRequests = [];
  const failures = [];
  const admitted = [];
  const evaluated = [];
  const stored = [];
  await application.start();
  const graph = application.graph;
  const priorOnMessage = graph.onMessage?.bind(graph);
  // The interactive runner reports one line once when it is emitted and again when it reaches a
  // result-collector; the desktop host dedupes by message id, so this observer does too.
  const seen = new Set();
  graph.onMessage = (message) => {
    if (!seen.has(message.message_id)) {
      seen.add(message.message_id);
      if (message.message_type === 'scribe.recovery-request') recoveryRequests.push(message);
      if (message.message_type === 'scribe.batch-admitted') admitted.push(message);
      if (message.message_type === 'scribe.batch-evaluated') evaluated.push(message);
      if (message.message_type === 'logged-item.stored') stored.push(message);
      if (message.message_type === 'service.failure') failures.push(message.payload?.error?.message || 'failure');
    }
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
    assert.deepEqual([...new Set(failures)], [], 'starting a session must raise no service failure');
    assert.equal(recoveryRequests.length, 1, 'one session start is one recovery request');
    assert.equal(keys.size, recoveryRequests.length, 'no two recovery requests may share an identity key');
    assert.equal(causations.size, 1, 'exactly one causing message produced the one request');

    // The checklist item a bare request-count assertion cannot cover: recovery actually completed,
    // so real finalized rows are admitted and produce a settled Scribe evaluation.
    const sessionId = application.sessionId;
    // Word sequences are one contiguous per-session stream (OrderedStreamGuard); a per-row
    // numbering scheme is rejected with SEQUENCE_GAP exactly as a dropped Whisper word would be.
    let nextSequence = 0;
    for (const [index, text] of ['First finalized row.', 'Second finalized row.', 'Third finalized row.'].entries()) {
      const words = text.split(' ');
      const utteranceId = `${sessionId}-utterance-${index}`;
      const first = nextSequence;
      for (const word of words) {
        const sequence = nextSequence;
        nextSequence += 1;
        await graph.dispatchFrom('@desktop-controller', 'domain', 'transcript.word-committed', sessionId, {
          word_id: `${sessionId}-word-${sequence}`, session_id: sessionId, utterance_id: utteranceId, sequence,
          start_time: `00:00:${String(sequence).padStart(2, '0')}.000`, end_time: `00:00:${String(sequence + 1).padStart(2, '0')}.000`,
          text: word, confidence: 0.97, evidence: { provider: 'scribe-06b-injected-speech', chunk_ids: [`${sessionId}-chunk-${sequence}`], alternatives: [] }
        }, `word:${sessionId}:${sequence}`);
      }
      const last = nextSequence - 1;
      await graph.dispatchFrom('@desktop-controller', 'domain', 'transcript.utterance-boundary', sessionId, {
        boundary_id: `${utteranceId}-boundary`, session_id: sessionId, utterance_id: utteranceId, reason: 'pause',
        first_word_sequence: first, last_word_sequence: last,
        start_time: `00:00:${String(first).padStart(2, '0')}.000`, end_time: `00:00:${String(last + 1).padStart(2, '0')}.000`,
        punctuation_hint: 'statement', source_chunk_ids: words.map((_, offset) => `${sessionId}-chunk-${first + offset}`)
      }, `boundary:${sessionId}:${index}`);
    }
    const deadline = Date.now() + 30000;
    while (evaluated.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));

    evidence.scenarios.host_session_start = {
      recovery_request_count: recoveryRequests.length,
      distinct_idempotency_keys: keys.size,
      distinct_causation_ids: causations.size,
      failures: [...new Set(failures)],
      rows_admitted_after_recovery: admitted.length,
      batches_evaluated_after_recovery: evaluated.length,
      logged_items_stored_after_recovery: stored.length
    };
    assert.equal(admitted.length, 1, 'the three finalized rows are admitted as one batch once recovery has completed');
    assert.equal(evaluated.length, 1, 'the admitted batch settles - recovery did not leave Scribe stuck refusing evidence');
    assert.equal(stored.length, 1, 'the batch not only settles but produces a stored Logged Item once recovery has completed');
    assert.deepEqual([...new Set(failures)], [], 'admission and settlement must not raise a service failure either');
  } finally {
    await application.shutdown().catch(() => {});
    await endpoint.close();
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

// Scenario 1 + 3 + 14. The single most important provider-backed claim in this ticket: a real
// inference that vastly outlasts the wire's admission deadline must not fail the wire, must not
// strand the next batch, and must not slow transcript finalization. The original defect was exactly
// this, and the automated reproduction of it scales the deadline down to 400 ms against a 900 ms
// reply - a ratio, not the real quantity. Here the deadline is the shipped 5,000 ms and the
// inference is however long the real model takes.
//
// Limitation, not a justification: this session start omits `scribe.guidance-configure`, which the
// real host always sends before `session.record`. So this scenario exercises an internal graph path
// and says nothing about the shipped startup sequence. The evidence file records the omission under
// `session_start_omits_guidance_configure` so no reader can mistake one for the other.
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
// Only the DEFAULT (no guidance) request was captured in this acceptance run. The guided request
// was not exercised end to end against the real provider, so scenario 11 remains untested rather
// than being claimed as either passing or broken.
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

/**
 * The unmodified `wiring/production-electron.json` with exactly one substitution: Whisper replaced
 * by letting `@desktop-controller` emit the same `transcript.word-committed` and
 * `transcript.utterance-boundary` traffic Whisper emits. This is the same technique
 * `tests/helpers/real-scribe-harness.mjs` uses for its graph-level scenarios; here it is applied so
 * a `DesktopApplication`-driven test can prove the real host session-start sequence without a
 * physical microphone. Nothing about Whisper, audio, prompting, batching, or any other production
 * wiring is changed - the admission policy, idle threshold, and admission deadline are left exactly
 * as configured in the real file.
 */
async function writeWhisperSubstitutedGraph(graphFile) {
  const definition = JSON.parse(await readFile(path.join(root, 'wiring', 'production-electron.json'), 'utf8'));
  definition.name = 'argus-scribe-06b-host-regression';
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
  await writeFile(graphFile, JSON.stringify(definition, null, 2), 'utf8');
  return definition;
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
