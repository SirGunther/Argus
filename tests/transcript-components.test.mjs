import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createEnvelope, prepareGraph, loadGraphDefinition, runGraph, validateGraphFile } from '../runtime/orchestrator.mjs';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { runService } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const graphFile = path.join(root, 'wiring/demo.transcript-pipeline.json');
const registry = await loadContractRegistry(path.join(root, 'contracts/catalog.json'));
const sessionId = 'phase4c-component-session';

test('fake audio emits valid bounded PCM16 chunks and explicitly fails an unknown fixture', async () => {
  const start = lifecycleStart('correction-question');
  const result = await runService(manifest('fake-audio-source'), [start], 4);
  const chunks = result.outputs.filter((message) => message.message_type === 'audio.chunk');
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((message) => message.payload.sequence), [0, 1, 2]);
  for (const chunk of chunks) {
    assert.deepEqual(registry.validateEnvelope(chunk), []);
    assert.equal(chunk.payload.byte_length, 16000);
    assert.equal(chunk.payload.sample_count, 8000);
  }
  const long = await runService(manifest('fake-audio-source'), [lifecycleStart('long-monologue')], 13);
  assert.equal(long.outputs.filter((message) => message.message_type === 'audio.chunk').length, 12);

  const invalid = await runService(manifest('fake-audio-source'), [lifecycleStart('missing-fixture')], 1);
  assert.equal(invalid.outputs[0].message_type, 'service.failure');
  assert.equal(invalid.outputs[0].payload.error.retryable, false);
});

test('fake STT streams changing partials and immutable words, replays duplicates, and rejects gaps and late chunks', async () => {
  const chunks = await correctionChunks();
  const normal = await runService(manifest('fake-stt'), chunks, 10);
  const partials = normal.outputs.filter((message) => message.message_type === 'transcript.partial');
  const words = normal.outputs.filter((message) => message.message_type === 'transcript.word-committed');
  assert.deepEqual(partials.map((message) => message.payload.text), ['are', 'are you ready', 'Argus, are you ready?']);
  assert.deepEqual(words.map((message) => message.payload.text), ['are', 'you', 'ready']);
  assert.deepEqual(normal.outputs.filter((message) => message.plane === 'domain').map((message) => message.message_type), [
    'transcript.partial', 'transcript.word-committed',
    'transcript.partial', 'transcript.word-committed', 'transcript.word-committed',
    'transcript.partial', 'transcript.utterance-boundary'
  ]);
  assert.equal(words[0].payload.evidence.alternatives[0].text, 'Argus');
  assert.equal(normal.outputs.filter((message) => message.message_type === 'transcript.utterance-boundary').length, 1);
  normal.outputs.forEach((message) => assert.deepEqual(registry.validateEnvelope(message), []));
  assert.equal(JSON.stringify(normal.outputs).includes('audio_base64'), false);

  const duplicate = await runService(manifest('fake-stt'), [chunks[0], structuredClone(chunks[0])], 6);
  assert.equal(duplicate.outputs.filter((message) => message.message_type === 'transcript.word-committed').length, 2);
  assert.equal(duplicate.outputs.filter((message) => message.message_type === 'operation.completed').at(-1).payload.duplicate, true);

  const conflictingChunk = createEnvelope({ plane: 'domain', messageType: 'audio.chunk', producer: 'test', correlationId: sessionId, idempotencyKey: 'conflicting-chunk-id', payload: {
    ...chunks[0].payload, audio_base64: chunks[1].payload.audio_base64, checksum: chunks[1].payload.checksum
  } });
  const conflict = await runService(manifest('fake-stt'), [chunks[0], conflictingChunk], 4);
  assert.equal(conflict.outputs.at(-1).message_type, 'service.failure');
  assert.equal(conflict.outputs.at(-1).payload.error.code, 'CHUNK_ID_CONFLICT');

  const gapChunk = createEnvelope({ plane: 'domain', messageType: 'audio.chunk', producer: 'test', correlationId: sessionId, idempotencyKey: 'gap-chunk', payload: { ...chunks[0].payload, chunk_id: `${sessionId}-gap`, sequence: 1 } });
  const gap = await runService(manifest('fake-stt'), [gapChunk], 1);
  assert.equal(gap.outputs[0].payload.error.code, 'SEQUENCE_GAP');
  assert.equal(gap.outputs[0].payload.error.retryable, true);

  const lateChunk = createEnvelope({ plane: 'domain', messageType: 'audio.chunk', producer: 'test', correlationId: sessionId, idempotencyKey: 'late-chunk', payload: { ...chunks[0].payload, chunk_id: `${sessionId}-late` } });
  const late = await runService(manifest('fake-stt'), [chunks[0], lateChunk], 4);
  assert.equal(late.outputs.at(-1).message_type, 'operation.rejected');
  assert.equal(late.outputs.at(-1).payload.reason.code, 'LATE_MESSAGE');

  const corruptPayload = { ...chunks[0].payload, chunk_id: `${sessionId}-corrupt`, checksum: `sha256:${'0'.repeat(64)}` };
  const corrupt = createEnvelope({ plane: 'domain', messageType: 'audio.chunk', producer: 'test', correlationId: sessionId, idempotencyKey: 'corrupt-chunk', payload: corruptPayload });
  const corruptResult = await runService(manifest('fake-stt'), [corrupt], 1);
  assert.equal(corruptResult.outputs[0].payload.error.code, 'INVALID_AUDIO_CHUNK');
  assert.equal(corruptResult.outputs[0].payload.error.retryable, false);
});

test('silence creates no partial, committed word, or phantom segment evidence', async () => {
  const source = await runService(manifest('fake-audio-source'), [lifecycleStart('silence')], 2);
  const chunk = source.outputs.find((message) => message.message_type === 'audio.chunk');
  const stt = await runService(manifest('fake-stt'), [chunk], 1);
  assert.deepEqual(stt.outputs.map((message) => message.message_type), ['operation.completed']);
});

test('contextual corrector is independent, deterministic, versioned, and does not own transcript state', async () => {
  const request = correctionRequest();
  const result = await runService(manifest('contextual-transcript-corrector'), [request], 2);
  const resolution = result.outputs.find((message) => message.message_type === 'transcript.correction-resolved');
  assert.deepEqual(registry.validateEnvelope(resolution), []);
  assert.equal(resolution.payload.proposals[0].proposed_text, 'Argus');
  assert.equal(resolution.payload.punctuation_after[0].mark, ',');
  assert.equal(resolution.payload.formatting.terminal_mark, '?');
  assert.equal(Object.hasOwn(resolution.payload, 'segment_id'), false);
  const invalid = createEnvelope({ plane: 'domain', messageType: 'transcript.correction-request', producer: 'test', correlationId: sessionId, idempotencyKey: 'invalid-correction', payload: { ...request.payload, words: [] } });
  const invalidResult = await runService(manifest('contextual-transcript-corrector'), [invalid], 1);
  assert.equal(invalidResult.outputs[0].message_type, 'service.failure');
});

test('meaningful unresolved correction becomes a focused review flag instead of rewriting text', async () => {
  const resolution = correctionResolution(0.85);
  const result = await runService(manifest('active-transcript-owner'), [...await sttDomainOutputs(), resolution, historyAcknowledgement(sessionId, 0)], 13);
  const finalized = result.outputs.find((message) => message.message_type === 'transcript.segment');
  assert.equal(finalized.payload.text, 'Are you ready?');
  assert.deepEqual(finalized.payload.review_flags, [{
    word_id: `${sessionId}-word-0`, reason: 'correction-review', candidates: ['are', 'Argus']
  }]);
  assert.equal(finalized.payload.word_provenance[0].correction_proposal_id, undefined);
});

test('active owner rejects an oversized finalized payload before staging active or history state', async () => {
  const oversized = correctionResolution(0.96, 'é'.repeat(20000));
  const result = await runService(manifest('active-transcript-owner'), [...await sttDomainOutputs(), oversized], 9);
  assert.equal(result.outputs.some((message) => ['transcript.segment', 'transcript.segment-stored', 'transcript.history-append'].includes(message.message_type)), false);
  assert.equal(result.outputs.at(-1).message_type, 'service.failure');
  assert.equal(result.outputs.at(-1).payload.error.code, 'PAYLOAD_LIMIT_EXCEEDED');
});

test('active owner automatically accepts eligible correction, finalizes formatting, revises optimistically, and preserves every history revision', async () => {
  const sttInputs = await sttDomainOutputs();
  const resolution = correctionResolution();
  const update = createEnvelope({ plane: 'domain', messageType: 'transcript.segment-update', producer: 'test', correlationId: sessionId, idempotencyKey: 'edit-segment-r0', payload: {
    segment_id: `${sessionId}-segment-0`, session_id: sessionId, expected_revision: 0, text: 'Argus, are you ready?', updated_at: '2026-08-13T01:10:00.000Z', editor: 'user'
  } });
  const stale = createEnvelope({ plane: 'domain', messageType: 'transcript.segment-update', producer: 'test', correlationId: sessionId, idempotencyKey: 'stale-edit-segment-r0', payload: {
    ...update.payload, text: 'Stale text.', updated_at: '2026-08-13T01:11:00.000Z'
  } });
  const result = await runService(manifest('active-transcript-owner'), [...sttInputs, resolution, historyAcknowledgement(sessionId, 0), update, historyAcknowledgement(sessionId, 1), stale], 18);
  const request = result.outputs.find((message) => message.message_type === 'transcript.correction-request');
  assert.equal(request.payload.policy.automatic_acceptance_threshold, 0.9);
  const finalized = result.outputs.find((message) => message.message_type === 'transcript.segment');
  assert.equal(finalized.payload.text, 'Argus, you ready?');
  assert.equal(finalized.payload.original_stt_text, 'are you ready');
  assert.equal(finalized.payload.word_provenance[0].source_text, 'are');
  assert.equal(finalized.payload.word_provenance[0].rendered_text, 'Argus');
  assert.ok(finalized.payload.word_provenance[0].correction_proposal_id);
  assert.deepEqual(finalized.payload.review_flags, []);
  const stored = result.outputs.filter((message) => message.message_type === 'transcript.segment-stored');
  assert.deepEqual(stored.map((message) => message.payload.revision), [0, 1]);
  assert.equal(stored[1].payload.text, 'Argus, are you ready?');
  assert.equal(stored[1].payload.original_stt_text, 'are you ready');
  assert.deepEqual(stored[1].payload.word_provenance, stored[0].payload.word_provenance);
  const appends = result.outputs.filter((message) => message.message_type === 'transcript.history-append');
  assert.deepEqual(appends.map((message) => message.payload.segment.revision), [0, 1]);
  assert.deepEqual(appends.map((message) => message.payload.history_entry_id), appends.map((message) => message.payload.segment.revision_id));
  const rejection = result.outputs.find((message) => message.message_type === 'operation.rejected');
  assert.equal(rejection.payload.reason.code, 'STALE_REVISION');
  result.outputs.forEach((message) => assert.deepEqual(registry.validateEnvelope(message), []));
});

test('permanent history is append-only, replay-safe, revision-complete, and rejects conflicting reuse', async () => {
  const active = await finalizedActiveOutputs(true);
  const appends = active.filter((message) => message.message_type === 'transcript.history-append');
  const replay = await runService(manifest('permanent-transcript-history'), [appends[0], structuredClone(appends[0]), appends[1]], 6);
  const receipts = replay.outputs.filter((message) => message.message_type === 'transcript.history-appended');
  assert.deepEqual(receipts.map((message) => message.payload.segment_revision), [0, 0, 1]);
  assert.ok(receipts.every((message) => message.payload.history_entry_id === message.payload.revision_id));
  assert.equal(replay.outputs.filter((message) => message.message_type === 'operation.completed')[1].payload.duplicate, true);

  const conflict = createEnvelope({ plane: 'domain', messageType: 'transcript.history-append', producer: 'test', correlationId: sessionId, schemaVersion: '1.4.0', idempotencyKey: 'conflicting-history-entry', payload: {
    ...appends[0].payload, segment: { ...appends[0].payload.segment, text: 'Conflicting history.' }
  } });
  const rejected = await runService(manifest('permanent-transcript-history'), [appends[0], conflict], 3);
  assert.equal(rejected.outputs.at(-1).message_type, 'service.failure');
  assert.equal(rejected.outputs.at(-1).payload.error.code, 'IDEMPOTENT_INPUT_CONFLICT');
});

test('Phase 4C graph exposes working-document results and default-deny wiring excludes partials from history', async () => {
  const prepared = await validateGraphFile(graphFile);
  assert.equal(prepared.services.size, 5);
  assert.equal(prepared.definition.domain_wires.filter((wire) => wire.contract === 'transcript.partial').length, 1);
  assert.equal(prepared.definition.domain_wires.find((wire) => wire.contract === 'transcript.partial').to, 'active-transcript');
  assert.equal(prepared.definition.domain_wires.some((wire) => wire.contract === 'transcript.partial' && ['transcript-history', 'window-selector'].includes(wire.to)), false);
  const result = await runGraph(graphFile, { trace: false });
  assert.deepEqual(result.completions.map((message) => message.message_type), ['transcript.history-appended', 'transcript.segment', 'transcript.segment-stored']);
  assert.equal(result.completions.find((message) => message.message_type === 'transcript.segment').payload.text, 'Argus, you ready?');
  assert.deepEqual(result.dead_letters, []);
  assert.deepEqual(result.rejections, []);

  const { definition, graphFile: absolute } = await loadGraphDefinition(graphFile);
  const unsafe = structuredClone(definition);
  unsafe.domain_wires.push({ from: 'speech-to-text', contract: 'transcript.partial', to: 'transcript-history' });
  await assert.rejects(() => prepareGraph(unsafe, absolute), /transcript-history does not declare accepted domain contract transcript\.partial/);
});

test('Phase 4C state owners fail closed on undeclared restart recovery', async () => {
  const { definition, graphFile: absolute } = await loadGraphDefinition(graphFile);
  const unsafe = structuredClone(definition);
  const owner = unsafe.services.find((service) => service.id === 'active-transcript');
  owner.recovery = { restart: 'on-failure', max_restarts: 1 };
  await assert.rejects(() => prepareGraph(unsafe, absolute), /owns state and cannot restart until recovery_owner is declared/);
});

test('serial AI priority is transcription, correction/formatting, extraction, then classification', async () => {
  const { AI_WORKLOADS, SerialAiScheduler } = await import('../runtime/serial-ai-scheduler.mjs');
  assert.deepEqual(AI_WORKLOADS, ['transcription', 'transcript-correction-formatting', 'logged-item-extraction', 'classification-enrichment']);
  let releaseActive;
  const gate = new Promise((resolve) => { releaseActive = resolve; });
  const started = [];
  const journal = { async load() { return []; }, async append() {} };
  const scheduler = await SerialAiScheduler.create({ journal, capacity: 8, executor: async (item) => {
    started.push(item.work_id);
    if (item.work_id === 'active') await gate;
    return {};
  } });
  const work = (work_id, workload, sequence) => ({ work_id, workload, session_id: sessionId, sequence, queued_at: '2026-08-13T00:00:00Z', input: {} });
  const active = scheduler.enqueue(work('active', 'logged-item-extraction', 0));
  while (scheduler.status.active_work_id !== 'active') await new Promise((resolve) => setTimeout(resolve, 1));
  const classification = scheduler.enqueue(work('classification', 'classification-enrichment', 0));
  const extraction = scheduler.enqueue(work('extraction', 'logged-item-extraction', 1));
  const correction = scheduler.enqueue(work('correction', 'transcript-correction-formatting', 0));
  const transcription = scheduler.enqueue(work('transcription', 'transcription', 0));
  releaseActive();
  await Promise.all([active, classification, extraction, correction, transcription]);
  assert.deepEqual(started, ['active', 'transcription', 'correction', 'extraction', 'classification']);
});

test('every new component independently acknowledges health and drain', async () => {
  for (const service of ['fake-audio-source', 'fake-stt', 'active-transcript-owner', 'contextual-transcript-corrector', 'permanent-transcript-history']) {
    const health = createEnvelope({ plane: 'control', messageType: 'lifecycle.health-check', producer: 'test', correlationId: sessionId, idempotencyKey: `health:${service}`, payload: { probe_id: `probe-${service}` } });
    const drain = createEnvelope({ plane: 'control', messageType: 'lifecycle.drain', producer: 'test', correlationId: sessionId, idempotencyKey: `drain:${service}`, payload: { reason: 'test', deadline_ms: 1000 } });
    const result = await runService(manifest(service), [health, drain], 2);
    assert.deepEqual(result.outputs.map((message) => message.message_type), ['service.health', 'service.drained']);
    result.outputs.forEach((message) => assert.deepEqual(registry.validateEnvelope(message), []));
  }
});

async function correctionChunks() {
  const source = await runService(manifest('fake-audio-source'), [lifecycleStart('correction-question')], 4);
  return source.outputs.filter((message) => message.message_type === 'audio.chunk');
}

async function sttDomainOutputs() {
  const result = await runService(manifest('fake-stt'), await correctionChunks(), 10);
  return result.outputs.filter((message) => message.plane === 'domain');
}

async function finalizedActiveOutputs(includeUpdate = false) {
  const inputs = [...await sttDomainOutputs(), correctionResolution(), historyAcknowledgement(sessionId, 0)];
  if (includeUpdate) inputs.push(createEnvelope({ plane: 'domain', messageType: 'transcript.segment-update', producer: 'test', correlationId: sessionId, idempotencyKey: 'history-edit-r0', payload: {
    segment_id: `${sessionId}-segment-0`, session_id: sessionId, expected_revision: 0, text: 'Argus, are you ready?', updated_at: '2026-08-13T01:12:00.000Z', editor: 'user'
  } }));
  if (includeUpdate) inputs.push(historyAcknowledgement(sessionId, 1));
  const result = await runService(manifest('active-transcript-owner'), inputs, includeUpdate ? 17 : 13);
  return result.outputs;
}

function historyAcknowledgement(sessionId, revision) {
  const segmentId = `${sessionId}-segment-0`;
  const revisionId = `${segmentId}-r${revision}`;
  return createEnvelope({ plane: 'domain', messageType: 'transcript.history-appended', producer: 'permanent-transcript-history', correlationId: sessionId, schemaVersion: '1.3.0', idempotencyKey: `history-ack:${revisionId}`, payload: {
    history_entry_id: revisionId, session_id: sessionId, segment_id: segmentId, segment_revision: revision, revision_id: revisionId, appended_at: '2026-08-13T01:00:00.000Z'
  } });
}

function correctionRequest() {
  const wordIds = [0, 1, 2].map((index) => `${sessionId}-word-${index}`);
  return createEnvelope({ plane: 'domain', messageType: 'transcript.correction-request', producer: 'test', correlationId: sessionId, idempotencyKey: 'correction-request', payload: {
    request_id: `${sessionId}-utterance-0-boundary-correction`, session_id: sessionId, utterance_id: `${sessionId}-utterance-0`, boundary_id: `${sessionId}-utterance-0-boundary`,
    words: [
      { word_id: wordIds[0], sequence: 0, text: 'are', confidence: 0.62, alternatives: [{ text: 'Argus', confidence: 0.91 }] },
      { word_id: wordIds[1], sequence: 1, text: 'you', confidence: 0.98, alternatives: [] },
      { word_id: wordIds[2], sequence: 2, text: 'ready', confidence: 0.97, alternatives: [] }
    ], formatting_hint: 'question', policy: { profile: 'working-document-default', instruction_version: '1.0.0', automatic_acceptance_threshold: 0.9, max_context_words: 64 }
  } });
}

function correctionResolution(confidence = 0.96, proposedText = 'Argus') {
  const first = `${sessionId}-word-0`;
  return createEnvelope({ plane: 'domain', messageType: 'transcript.correction-resolved', producer: 'test', correlationId: sessionId, idempotencyKey: 'correction-resolution', payload: {
    request_id: `${sessionId}-utterance-0-boundary-correction`, session_id: sessionId, utterance_id: `${sessionId}-utterance-0`, boundary_id: `${sessionId}-utterance-0-boundary`,
    proposals: [{ proposal_id: `${sessionId}-proposal-0`, target_word_id: first, target_word_sequence: 0, expected_text: 'are', proposed_text: proposedText, confidence, basis: 'acoustic-and-contextual', context: { first_word_id: first, last_word_id: `${sessionId}-word-2` } }],
    formatting: { terminal_mark: '?', capitalize_first_word: true, confidence: 0.97 }, punctuation_after: [{ word_id: first, mark: ',' }],
    generator: { implementation: 'contextual-transcript-corrector', policy_profile: 'working-document-default', instruction_version: '1.0.0' }
  } });
}

function lifecycleStart(fixture) {
  return createEnvelope({ plane: 'control', messageType: 'lifecycle.start', producer: 'test', correlationId: sessionId, idempotencyKey: `start:${fixture}`, payload: { session_id: sessionId, configuration: { fixture } } });
}

function manifest(service) { return path.join(root, 'services', service, 'service.json'); }
