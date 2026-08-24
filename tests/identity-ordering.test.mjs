import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { MessageIntegrityLedger } from '../runtime/message-identity.mjs';
import { createEnvelope } from '../runtime/orchestrator.mjs';
import { OrderedStreamGuard } from '../runtime/ordered-stream.mjs';
import { JsonLinesAiWorkJournal, SerialAiScheduler } from '../runtime/serial-ai-scheduler.mjs';
import { runService } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = await loadContractRegistry(path.join(root, 'contracts/catalog.json'));
const sessionId = 'phase3-session';

test('current envelope identity is UUID-v4, idempotent, fingerprinted, and contract-valid', () => {
  const message = createEnvelope({ plane: 'domain', messageType: 'transcript.segment', producer: 'identity-test', correlationId: sessionId, idempotencyKey: 'transcript:phase3-session:0', payload: segment(0) });
  assert.match(message.message_id, /^[0-9a-f-]{36}$/i);
  assert.equal(message.idempotency_key, 'transcript:phase3-session:0');
  assert.match(message.content_fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(registry.validateEnvelope(message), []);
});

test('exact at-least-once replay is accepted while message-id and idempotency-key conflicts are fatal', () => {
  const ledger = new MessageIntegrityLedger();
  const message = createEnvelope({ plane: 'domain', messageType: 'transcript.segment', producer: 'identity-test', correlationId: sessionId, idempotencyKey: 'transcript:phase3-session:0', payload: segment(0) });
  assert.equal(ledger.observe(message).duplicate, false);
  assert.equal(ledger.observe(structuredClone(message)).duplicate, true);

  const sameIdDifferentPayload = structuredClone(message);
  sameIdDifferentPayload.payload.text = 'Conflicting content.';
  assert.throws(() => ledger.observe(sameIdDifferentPayload), /Message id .* reused with different content/);

  const sameKeyDifferentMessage = createEnvelope({ plane: 'domain', messageType: 'transcript.segment', producer: 'identity-test', correlationId: sessionId, idempotencyKey: message.idempotency_key, payload: { ...segment(0), text: 'Different operation content.' } });
  assert.throws(() => ledger.observe(sameKeyDifferentMessage), /Idempotency key .* reused with different content/);
});

test('tampering with governed content after fingerprinting is rejected', () => {
  const message = createEnvelope({ plane: 'domain', messageType: 'transcript.segment', producer: 'identity-test', correlationId: sessionId, payload: segment(0) });
  message.payload.text = 'Tampered.';
  assert.match(registry.validateEnvelope(message).join('\n'), /CONTENT_FINGERPRINT_MISMATCH/);
});

test('ordered streams are independent per session and expose gaps and late arrivals', () => {
  const guard = new OrderedStreamGuard();
  assert.equal(guard.accept('session-a', 0).next, 1);
  assert.equal(guard.accept('session-b', 0).next, 1);
  assert.throws(() => guard.accept('session-a', 2), (error) => error.code === 'SEQUENCE_GAP' && error.retryable === true);
  assert.equal(guard.accept('session-a', 1).next, 2);
  assert.throws(() => guard.accept('session-a', 0), (error) => error.code === 'LATE_MESSAGE' && error.retryable === false);
});

test('window selector accepts an exact duplicate once and emits explicit gap and late outcomes', async () => {
  const first = createEnvelope({ plane: 'domain', messageType: 'transcript.segment', producer: 'identity-test', correlationId: sessionId, idempotencyKey: 'segment:0', payload: segment(0) });
  const gap = createEnvelope({ plane: 'domain', messageType: 'transcript.segment', producer: 'identity-test', correlationId: sessionId, idempotencyKey: 'segment:2', payload: segment(2) });
  const late = createEnvelope({ plane: 'domain', messageType: 'transcript.segment', producer: 'identity-test', correlationId: sessionId, idempotencyKey: 'segment:late', payload: { ...segment(0), segment_id: 'late-segment' } });
  const result = await runService(path.join(root, 'services/transcript-window-selector/service.json'), [first, structuredClone(first), gap, late], 4);
  const completions = result.outputs.filter((message) => message.message_type === 'operation.completed');
  assert.equal(completions.length, 2);
  assert.equal(completions[1].payload.duplicate, true);
  const gapFailure = result.outputs.find((message) => message.message_type === 'service.failure');
  assert.equal(gapFailure.payload.error.code, 'SEQUENCE_GAP');
  assert.equal(gapFailure.payload.error.retryable, true);
  const lateRejection = result.outputs.find((message) => message.message_type === 'operation.rejected');
  assert.equal(lateRejection.payload.reason.code, 'LATE_MESSAGE');
});

test('logged-item owner is idempotent, increments optimistic revision once, and rejects stale commands/results', async () => {
  const draft = createEnvelope({ plane: 'domain', messageType: 'logged-item.draft', producer: 'identity-test', correlationId: sessionId, idempotencyKey: 'draft:item-1:r0', payload: draftPayload() });
  const update = createEnvelope({ plane: 'domain', messageType: 'logged-item.update', producer: 'identity-test', correlationId: sessionId, idempotencyKey: 'update:item-1:from-r0', payload: { item_id: 'item-1', session_id: sessionId, expected_revision: 0, text: 'User-edited text.', updated_at: '2026-08-12T21:00:00.000Z' } });
  const staleSuggestion = createEnvelope({ plane: 'domain', messageType: 'classification.suggestion', producer: 'identity-test', correlationId: sessionId, idempotencyKey: 'classify:item-1:r0', payload: { item_id: 'item-1', session_id: sessionId, item_revision: 0, suggested_classification: 'task', confidence: 0.8, evidence_segment_ids: ['segment-1'] } });
  const result = await runService(path.join(root, 'services/logged-item-memory-store/service.json'), [draft, structuredClone(draft), update, structuredClone(update), staleSuggestion], 8);
  const stored = result.outputs.filter((message) => message.message_type === 'logged-item.stored');
  assert.deepEqual(stored.map((message) => message.payload.revision), [0, 0, 1]);
  assert.equal(result.outputs.filter((message) => message.message_type === 'operation.completed').length, 3);
  const rejections = result.outputs.filter((message) => message.message_type === 'operation.rejected');
  assert.deepEqual(rejections.map((message) => message.payload.reason.code), ['STALE_REVISION', 'STALE_RESULT']);
  assert.equal(result.outputs.some((message) => message.message_type === 'classification.suggestion-accepted'), false);
});

test('serial AI scheduler is non-preemptive, concurrency-one, priority FIFO, durable, and bounded without drops', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'argus-ai-scheduler-'));
  const journalPath = path.join(directory, 'ai-work.jsonl');
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const started = [];
  let active = 0;
  let maxActive = 0;
  const scheduler = await SerialAiScheduler.create({
    journal: new JsonLinesAiWorkJournal(journalPath),
    capacity: 5,
    executor: async (work) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(work.work_id);
      if (work.work_id === 'active-extraction') await firstGate;
      active -= 1;
      return { work_id: work.work_id };
    }
  });

  const activePromise = scheduler.enqueue(work('active-extraction', 'logged-item-extraction', 0));
  await until(() => scheduler.status.active_work_id === 'active-extraction');
  const classificationOne = scheduler.enqueue(work('classification-1', 'classification-enrichment', 0));
  const extractionOne = scheduler.enqueue(work('extraction-1', 'logged-item-extraction', 1));
  const transcriptionOne = scheduler.enqueue(work('transcription-1', 'transcription', 0));
  const classificationTwo = scheduler.enqueue(work('classification-2', 'classification-enrichment', 1));
  await assert.rejects(() => scheduler.enqueue(work('overflow', 'transcription', 2)), /AI backlog reached its declared capacity/);
  releaseFirst();
  await Promise.all([activePromise, classificationOne, extractionOne, transcriptionOne, classificationTwo]);
  assert.equal(maxActive, 1);
  assert.deepEqual(started, ['active-extraction', 'transcription-1', 'extraction-1', 'classification-1', 'classification-2']);
  assert.equal(scheduler.status.depth, 0);
  const events = (await readFile(journalPath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(events.filter((event) => event.event === 'queued').length, 5);
  assert.equal(events.filter((event) => event.event === 'completed').length, 5);
});

test('unfinished journal work is recovered in priority FIFO order after restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'argus-ai-recovery-'));
  const journal = new JsonLinesAiWorkJournal(path.join(directory, 'ai-work.jsonl'));
  await journal.append({ event: 'queued', at: '2026-08-12T00:00:00Z', ordinal: 1, work: work('classification-recovered', 'classification-enrichment', 0), fingerprint: 'sha256:one' });
  await journal.append({ event: 'queued', at: '2026-08-12T00:00:01Z', ordinal: 2, work: work('transcription-recovered', 'transcription', 0), fingerprint: 'sha256:two' });
  await journal.append({ event: 'started', at: '2026-08-12T00:00:02Z', work_id: 'classification-recovered', attempt: 1 });
  const started = [];
  const scheduler = await SerialAiScheduler.create({ journal, executor: async (item) => { started.push(item.work_id); return {}; } });
  await scheduler.whenIdle();
  assert.deepEqual(started, ['transcription-recovered', 'classification-recovered']);
});

test('concurrent scheduler admissions preserve invocation FIFO despite slow durable append', async () => {
  let releaseFirstAppend;
  const firstAppend = new Promise((resolve) => { releaseFirstAppend = resolve; });
  const journal = {
    events: [],
    async load() { return []; },
    async append(event) {
      if (event.event === 'queued' && event.work.work_id === 'first') await firstAppend;
      this.events.push(event);
    }
  };
  const started = [];
  const scheduler = await SerialAiScheduler.create({ journal, executor: async (item) => { started.push(item.work_id); return {}; } });
  const first = scheduler.enqueue(work('first', 'transcription', 0));
  const second = scheduler.enqueue(work('second', 'transcription', 1));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(started, []);
  releaseFirstAppend();
  await Promise.all([first, second]);
  assert.deepEqual(started, ['first', 'second']);
});

test('completed AI work remains idempotent across scheduler restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'argus-ai-idempotent-restart-'));
  const journal = new JsonLinesAiWorkJournal(path.join(directory, 'ai-work.jsonl'));
  const original = work('completed-before-restart', 'logged-item-extraction', 0);
  const firstScheduler = await SerialAiScheduler.create({ journal, executor: async () => ({ artifact_id: 'artifact-1' }) });
  assert.deepEqual(await firstScheduler.enqueue(original), { artifact_id: 'artifact-1' });
  await firstScheduler.whenIdle();

  let executionsAfterRestart = 0;
  const restarted = await SerialAiScheduler.create({ journal, executor: async () => { executionsAfterRestart += 1; return {}; } });
  assert.deepEqual(await restarted.enqueue(structuredClone(original)), { artifact_id: 'artifact-1' });
  assert.equal(executionsAfterRestart, 0);
  await assert.rejects(() => restarted.enqueue({ ...original, input: { value: 'conflicting' } }), /reused with different content/);
});

function segment(sequence) {
  return { segment_id: `segment-${sequence}`, session_id: sessionId, sequence, start_time: `${sequence}`, end_time: `${sequence + 1}`, text: `Segment ${sequence}.`, boundary: 'continuation' };
}

function draftPayload() {
  return { item_id: 'item-1', session_id: sessionId, created_at: '2026-08-12T20:59:00.000Z', text: 'Original text.', revision: 0, source: { first_segment_id: 'segment-1', last_segment_id: 'segment-1', start_time: '0', end_time: '1' }, generator: { implementation: 'identity-test', input_window_id: 'window-1' } };
}

function work(workId, workload, sequence) {
  return { work_id: workId, workload, session_id: sessionId, sequence, queued_at: `2026-08-12T21:00:0${sequence}.000Z`, input: { value: workId }, recovery: { max_attempts: 1 } };
}

async function until(predicate, timeoutMs = 1000) {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
