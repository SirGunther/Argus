import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DesktopApplication } from '../runtime/desktop-application.mjs';
import { InteractiveGraph } from '../runtime/interactive-graph.mjs';
import { MessageIntegrityLedger } from '../runtime/message-identity.mjs';
import { createEnvelope } from '../runtime/orchestrator.mjs';
import { SessionLifecycle } from '../runtime/session-lifecycle.mjs';
import { SessionStorage } from '../runtime/session-storage.mjs';
import { createSessionTimer } from '../ui/session-timer.mjs';
import { runService, runServiceBatches } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const whisperManifest = path.join(root, 'services', 'whisper-cpp-stt', 'service.json');

test('session timer ticks only while recording and resumes from authoritative accumulated time', () => {
  let now = 0;
  const timer = createSessionTimer({ clock: () => now });
  timer.applyProjection({ session_id: 'timer-session', state: 'recording', elapsed_seconds: 0 });
  assert.equal(timer.current(), 0);
  now = 2100;
  assert.equal(timer.current(), 2);
  timer.applyProjection({ session_id: 'timer-session', state: 'stopped', elapsed_seconds: 2 });
  now += 10000;
  assert.equal(timer.current(), 2, 'stopped time must not accumulate');
  timer.applyProjection({ session_id: 'timer-session', state: 'recording', elapsed_seconds: 2 });
  now += 1100;
  assert.equal(timer.current(), 3, 'resume must continue from the stopped accumulation');
  timer.pause();
  now += 10000;
  assert.equal(timer.current(), 3, 'Stop/Close pause the visible timer');
});

test('New Session emits an authoritative recording projection for its new identity', async () => {
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-new-session-${Date.now()}`) });
  application.metadata = { session_id: 'closed-session', state: 'closed' };
  application.sessionId = 'closed-session';
  application.boundary = { projection: (messageType, payload) => ({ message_type: messageType, payload }) };
  let recovery;
  application.graph = {
    dispatchFrom: async () => {},
    recoverDeliveryForNewSession: async (boundary) => { recovery = boundary; return 1; },
    closed: false
  };
  const createdAt = new Date().toISOString();
  application.loadLatestSession = async (sessionId) => {
    application.sessionId = sessionId;
    application.metadata = {
      session_id: sessionId, state: 'recording', revision: 1, created_at: createdAt, started_at: createdAt,
      operations: { record: { operation: 'session.record', outcome: { completed_at: createdAt } } }
    };
    application.transcript = [];
    application.loggedItems = [];
  };
  const projections = [];
  application.onProjection((message) => projections.push(message));
  const result = await application.newSessionCommand({ command: 'session.new', command_id: 'new-session-command', session_id: 'closed-session' });
  assert.equal(result.command, 'session.new');
  assert.equal(result.status, 'accepted');
  assert.equal(result.session_id, application.sessionId);
  assert.deepEqual(recovery, { currentSessionId: 'closed-session', nextSessionId: application.sessionId });
  assert.deepEqual(projections.at(-1), { message_type: 'ui.session-status', payload: { session_id: application.sessionId, state: 'recording', elapsed_seconds: 0, created_at: createdAt, duration_seconds: 0, transcript_count: 0, logged_item_count: 0, audio_processing: { state: 'listening', queue_depth: 0, capture_state: 'idle', transcription_state: 'idle' } } });
});

test('sequence 67 to 128 gap remains guarded and becomes a visible finalization failure', async () => {
  const sessionId = 'finalization-sequence-gap-session';
  const word = (sequence) => createEnvelope({
    plane: 'domain', messageType: 'transcript.word-committed', producer: 'gap-repro', correlationId: sessionId,
    idempotencyKey: `${sessionId}:word:${sequence}`,
    payload: {
      word_id: `${sessionId}-word-${sequence}`, session_id: sessionId, utterance_id: `${sessionId}-utterance-0`, sequence,
      start_time: '00:00:00.000', end_time: '00:00:00.100', text: `word-${sequence}`, confidence: 0.99,
      evidence: { provider: 'gap-repro', chunk_ids: [`${sessionId}-chunk-0`], alternatives: [] }
    }
  });
  const result = await runService(path.join(root, 'services', 'active-transcript-owner', 'service.json'), [
    ...Array.from({ length: 67 }, (_, sequence) => word(sequence)), word(128)
  ], 68, 10000, { env: { ARGUS_SESSION_ROOT: '' } });
  const failure = result.outputs.find((message) => message.message_type === 'service.failure');
  assert.equal(failure.payload.error.code, 'SEQUENCE_GAP');
  assert.equal(failure.payload.error.details.expected, 67);
  assert.equal(failure.payload.error.details.received, 128);
  assert.equal(result.outputs.filter((message) => message.message_type === 'transcript.segment').length, 0);

  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-gap-ui-${Date.now()}`) });
  application.sessionId = sessionId;
  application.metadata = { session_id: sessionId, state: 'recording', created_at: '2026-09-01T00:00:00.000Z' };
  application.boundary = { projection: (messageType, payload) => ({ message_type: messageType, payload }) };
  application.started = true;
  application.handleGraphMessage(failure);
  assert.equal(application.sessionProjection().audio_processing.state, 'error');
  assert.match(application.sessionProjection().audio_processing.detail, /Stop recording and start a new session/);
  assert.equal(application.capabilitySnapshot().find((item) => item.capability === 'transcript').status, 'unavailable');
});

test('interactive graph defers final-word delivery until each active-owner receipt without dropping a burst', async () => {
  const delivered = [];
  const statuses = [];
  const prepared = {
    definition: { domain_wires: [{ from: 'speech-to-text', contract: 'transcript.word-committed', to: 'active-transcript' }], control_wires: [], supervision: { queue: { capacity: 32 } } },
    endpoints: new Map([
      ['active-transcript', { endpointType: 'service', serviceName: 'active-transcript' }],
      ['@supervisor', { endpointType: 'runtime', kind: 'supervisor' }]
    ]),
    providers: new Map(),
    services: new Map()
  };
  let graph;
  graph = new InteractiveGraph(prepared, { onStatus: (status) => statuses.push(status) });
  graph.running.set('active-transcript', {
    exited: false,
    handle: {
      write: async (message) => {
        delivered.push(message.payload.sequence);
        graph.receiveRuntime(prepared.endpoints.get('@supervisor'), { message_type: 'operation.completed', payload: { input_message_id: message.message_id } }, 'active-transcript');
      }
    }
  });
  for (let sequence = 0; sequence < 128; sequence += 1) {
    graph.route('speech-to-text', createEnvelope({
      plane: 'domain', messageType: 'transcript.word-committed', producer: 'speech-to-text', correlationId: 'burst-session',
      idempotencyKey: `burst-session:word:${sequence}`,
      payload: {
        word_id: `burst-session-word-${sequence}`, session_id: 'burst-session', utterance_id: 'burst-session-utterance-0', sequence,
        start_time: '00:00:00.000', end_time: '00:00:00.100', text: `word-${sequence}`, confidence: 0.99,
        evidence: { provider: 'speech-to-text', chunk_ids: ['burst-session-chunk-0'], alternatives: [] }
      }
    }));
  }
  await graph.waitForIdle();
  assert.deepEqual(delivered, Array.from({ length: 128 }, (_, sequence) => sequence));
  assert.equal(statuses.some((status) => status.type === 'service-failure'), false);
});

test('service.failure settles receipts by sending graph instance, not manifest service name', async () => {
  const statuses = [];
  const graph = new InteractiveGraph(graphPrepared({ timeout: 100 }), { onStatus: (status) => statuses.push(status) });
  const receipt = graph.waitForReceipt('active-transcript', 'gap-word-67');
  graph.receiveRuntime({ kind: 'supervisor' }, {
    message_type: 'service.failure', correlation_id: 'gap-session',
    payload: {
      service: 'active-transcript-owner', operation: 'assemble-committed-word', input_message_id: 'gap-word-67',
      error: { code: 'SEQUENCE_GAP', category: 'conflict', message: 'expected 67, received 128', retryable: true }
    }
  }, 'active-transcript');
  await assert.rejects(receipt, (error) => error.code === 'SEQUENCE_GAP');
  assert.equal(statuses.at(-1).service, 'active-transcript-owner');
  assert.equal(statuses.at(-1).sender, 'active-transcript');
});

test('failed service operation settles queue drain and graph idle without hanging', async () => {
  const statuses = [];
  const prepared = graphPrepared({ timeout: 100 });
  const graph = new InteractiveGraph(prepared, { onStatus: (status) => statuses.push(status) });
  graph.running.set('active-transcript', {
    exited: false,
    handle: {
      write: async (message) => graph.receiveRuntime(prepared.endpoints.get('@supervisor'), {
        message_type: 'operation.rejected', correlation_id: message.correlation_id,
        payload: { service: 'active-transcript-owner', operation: 'assemble-committed-word', input_message_id: message.message_id, reason: { code: 'WORD_ID_CONFLICT', message: 'conflicting word evidence', retryable: false } }
      }, 'active-transcript')
    }
  });
  graph.route('speech-to-text', graphWord('operation-failure-session', 0));
  await graph.waitForIdle();
  const wire = prepared.definition.domain_wires[0];
  const state = graph.deferredDeliveries.get(graph.wireKey(wire));
  assert.equal(state.failed, true);
  assert.equal(graph.queues.get(graph.wireKey(wire)).failed, true);
  assert.equal(statuses.some((status) => status.type === 'operation-rejected' && status.code === 'WORD_ID_CONFLICT'), true);
});

test('missing receipt fails at the wire operation timeout and reports delivery failure', async () => {
  const statuses = [];
  const prepared = graphPrepared({ timeout: 25 });
  const graph = new InteractiveGraph(prepared, { onStatus: (status) => statuses.push(status) });
  graph.running.set('active-transcript', { exited: false, handle: { write: async () => {} } });
  const started = Date.now();
  graph.route('speech-to-text', graphWord('timeout-session', 0));
  await graph.waitForIdle();
  assert.ok(Date.now() - started >= 20);
  assert.ok(Date.now() - started < 500);
  assert.equal(statuses.some((status) => status.type === 'service-failure' && status.code === 'OPERATION_TIMEOUT'), true);
  assert.equal(graph.deferredDeliveries.get(graph.wireKey(prepared.definition.domain_wires[0])).failure.code, 'OPERATION_TIMEOUT');
});

test('terminal wire failure rejects every pending waiter and rejects later deliveries immediately', async () => {
  const statuses = [];
  const prepared = graphPrepared({ capacity: 1, timeout: 25 });
  const graph = new InteractiveGraph(prepared, { onStatus: (status) => statuses.push(status) });
  graph.running.set('active-transcript', { exited: false, handle: { write: async () => {} } });
  const wire = prepared.definition.domain_wires[0];
  const first = graphWord('pending-session', 0);
  const second = graphWord('pending-session', 1);
  const firstReceipt = graph.waitForReceipt('active-transcript', first.message_id, { wire, message: first });
  const secondReceipt = graph.waitForReceipt('active-transcript', second.message_id, { wire, message: second });
  graph.route('speech-to-text', first);
  graph.route('speech-to-text', second);
  const results = await Promise.allSettled([firstReceipt, secondReceipt]);
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
  await graph.waitForIdle();
  const later = graphWord('pending-session', 2);
  const laterReceipt = graph.waitForReceipt('active-transcript', later.message_id, { wire, message: later });
  const started = Date.now();
  graph.route('speech-to-text', later);
  await assert.rejects(laterReceipt, (error) => error.code === 'WIRE_FAILED');
  assert.ok(Date.now() - started < 100);
  assert.equal(statuses.some((status) => status.code === 'WIRE_FAILED'), true);
});

test('governed new-session recovery rebuilds failed delivery and accepts sequence zero', async () => {
  const prepared = graphPrepared({ timeout: 100 });
  const graph = new InteractiveGraph(prepared);
  let fail = true;
  const delivered = [];
  graph.running.set('active-transcript', {
    exited: false,
    handle: {
      write: async (message) => {
        delivered.push([message.correlation_id, message.payload.sequence]);
        if (fail) graph.receiveRuntime(prepared.endpoints.get('@supervisor'), {
          message_type: 'operation.rejected', correlation_id: message.correlation_id,
          payload: { service: 'active-transcript-owner', operation: 'assemble-committed-word', input_message_id: message.message_id, reason: { code: 'WORD_ID_CONFLICT', message: 'terminal current-session failure', retryable: false } }
        }, 'active-transcript');
        else graph.receiveRuntime(prepared.endpoints.get('@supervisor'), { message_type: 'operation.completed', payload: { input_message_id: message.message_id } }, 'active-transcript');
      }
    }
  });
  const old = graphWord('old-session', 0);
  graph.route('speech-to-text', old);
  await graph.waitForIdle();
  const wire = prepared.definition.domain_wires[0];
  const blocked = graphWord('old-session', 1);
  const blockedReceipt = graph.waitForReceipt('active-transcript', blocked.message_id, { wire, message: blocked });
  graph.route('speech-to-text', blocked);
  await assert.rejects(blockedReceipt, (error) => error.code === 'WIRE_FAILED');
  assert.equal(await graph.recoverDeliveryForNewSession({ currentSessionId: 'old-session', nextSessionId: 'new-session' }), 1);
  fail = false;
  const next = graphWord('new-session', 0);
  const nextReceipt = graph.waitForReceipt('active-transcript', next.message_id, { wire, message: next });
  graph.route('speech-to-text', next);
  await nextReceipt;
  await graph.waitForIdle();
  assert.deepEqual(delivered, [['old-session', 0], ['new-session', 0]]);
  assert.equal(graph.deferredDeliveries.get(graph.wireKey(wire)).failed, false);

  const boundary = createEnvelope({
    plane: 'domain', messageType: 'transcript.utterance-boundary', producer: 'speech-to-text', correlationId: 'new-session',
    idempotencyKey: 'new-session:boundary:0',
    payload: {
      boundary_id: 'new-session-boundary-0', session_id: 'new-session', utterance_id: 'new-session-utterance-0', reason: 'flush',
      first_word_sequence: 0, last_word_sequence: 0, start_time: '00:00:00.000', end_time: '00:00:00.100', punctuation_hint: '.', source_chunk_ids: ['new-session-chunk-0']
    }
  });
  const resolution = createEnvelope({
    plane: 'domain', messageType: 'transcript.correction-resolved', producer: 'sequence-window-test', correlationId: 'new-session',
    idempotencyKey: 'new-session:boundary:0:resolution',
    payload: {
      request_id: 'new-session-boundary-0-correction', session_id: 'new-session', utterance_id: 'new-session-utterance-0', boundary_id: 'new-session-boundary-0', proposals: [],
      formatting: { terminal_mark: '.', capitalize_first_word: false, confidence: 0.99 }, generator: { implementation: 'sequence-window-test', policy_profile: 'test', instruction_version: '1.0.0' }
    }
  });
  const owner = await runService(path.join(root, 'services', 'active-transcript-owner', 'service.json'), [next, boundary, resolution, transcriptHistoryAck('new-session', 0)], 8, 10000, { env: { ARGUS_SESSION_ROOT: '' } });
  assert.deepEqual(owner.outputs.filter((message) => message.message_type === 'transcript.segment').map((message) => message.payload.sequence), [0]);
});

test('Stop and Close complete after a finalization failure', async () => {
  for (const command of ['session.stop', 'session.close']) {
    const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-finalization-${command}-${Date.now()}`) });
    application.sessionId = 'failed-finalization-session';
    application.metadata = { session_id: application.sessionId, state: 'recording', revision: 1, created_at: '2026-08-30T00:00:00.000Z' };
    application.audioProcessingError = Object.assign(new Error('expected 67, received 128'), { code: 'FINALIZATION_SEQUENCE_GAP', retryable: false });
    application.boundary = { projection: (messageType, payload) => ({ message_type: messageType, payload }) };
    const calls = [];
    application.graph = {
      closed: false,
      async dispatchFrom(_from, plane, type) { calls.push(`${plane}:${type}`); },
      async waitForIdle() { calls.push('waitForIdle'); }
    };
    application.loadLatestSession = async () => {};
    const result = await Promise.race([
      application.sessionCommand({ command, command_id: `${command}-command`, session_id: application.sessionId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${command} hung`)), 500))
    ]);
    assert.equal(result.status, 'accepted');
    assert.ok(calls.includes(`control:${command}`));
  }
});

test('delayed transcription accepts later chunks and completes FIFO without mixing utterances', async () => {
  const sessionId = 'delayed-transcription-session';
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-delayed-${Date.now()}`) });
  application.sessionId = sessionId;
  application.metadata = { session_id: sessionId, state: 'recording', revision: 1, created_at: '2026-08-30T00:00:00.000Z', started_at: '2026-08-30T00:00:00.000Z', operations: { record: { operation: 'session.record', outcome: { completed_at: '2026-08-30T00:00:00.000Z' } } } };
  application.boundary = { projection: (messageType, payload) => ({ message_type: messageType, payload }) };
  application.started = true;
  const projections = [];
  application.onProjection((message) => projections.push(message));
  const serviceChunks = [];
  const completedUtterances = [];
  let activeTranscriptions = 0;
  let maxConcurrentTranscriptions = 0;
  let releaseFirstFlush;
  const firstFlushStarted = new Promise((resolve) => {
    application.graph = {
      closed: false,
      async dispatchFrom(_from, _plane, type, _correlationId, payload) {
        if (type === 'audio.chunk') {
          serviceChunks.push(payload.sequence);
          return;
        }
        if (type !== 'audio.flush') return;
        // The held flush models deliberately slow Whisper inference; this test does not claim physical-microphone acceptance.
        const utterance = serviceChunks.splice(0);
        activeTranscriptions += 1;
        maxConcurrentTranscriptions = Math.max(maxConcurrentTranscriptions, activeTranscriptions);
        try {
          if (!releaseFirstFlush) {
            resolve();
            await new Promise((release) => { releaseFirstFlush = release; });
          }
          completedUtterances.push(utterance);
        } finally {
          activeTranscriptions -= 1;
        }
      }
    };
  });

  const chunk = (sequence) => ({
    chunk_id: `${sessionId}-chunk-${sequence}`, session_id: sessionId, sequence,
    start_time: `00:00:0${sequence}.000`, end_time: `00:00:0${sequence}.256`,
    format: { encoding: 'pcm-signed-integer', sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, byte_order: 'little-endian' },
    sample_count: 2, byte_length: 4, audio_base64: 'AAABAA==', checksum: 'sha256:6b1e73a0094b7b812d3b9e22cffb4f8239319847522c4fa103753b6950020f93'
  });

  await application.acceptAudioChunk(chunk(0));
  await application.acceptAudioChunk(chunk(1));
  assert.equal((await application.acceptAudioFlush({ session_id: sessionId, reason: 'pause' })).queued, true);
  await firstFlushStarted;
  assert.equal(Object.isFrozen(application.audioActiveFlush.utterance), true);
  assert.equal(Object.isFrozen(application.audioActiveFlush.utterance.chunks), true);

  const laterChunks = await Promise.all([application.acceptAudioChunk(chunk(2)), application.acceptAudioChunk(chunk(3))]);
  assert.deepEqual(laterChunks.map((result) => result.accepted), [true, true]);
  assert.equal((await application.acceptAudioFlush({ session_id: sessionId, reason: 'pause' })).queued, true);
  assert.ok(projections.some((message) => message.payload.audio_processing?.state === 'transcribing'));

  releaseFirstFlush();
  await application.waitForAudioIdle();
  assert.deepEqual(completedUtterances, [[0, 1], [2, 3]]);
  assert.equal(maxConcurrentTranscriptions, 1);
  assert.ok(projections.some((message) => message.payload.audio_processing?.state === 'queued' || message.payload.audio_processing?.queue_depth > 0));
});

test('same-session audio identities survive pause/flush reuse and exact chunk replay', async () => {
  const sessionId = 'audio-identity-lifecycle-session';
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-audio-identity-${Date.now()}`) });
  application.sessionId = sessionId;
  application.metadata = { session_id: sessionId, state: 'recording', revision: 1, created_at: '2026-08-30T00:00:00.000Z', started_at: '2026-08-30T00:00:00.000Z' };
  const ledger = new MessageIntegrityLedger();
  const chunks = [];
  const flushes = [];
  const finalized = [];
  let currentWindow = [];
  application.graph = {
    closed: false,
    async dispatchFrom(_from, plane, type, correlationId, payload, idempotencyKey) {
      const message = createEnvelope({ plane, messageType: type, producer: '@desktop-controller', correlationId, payload, idempotencyKey });
      ledger.observe(message);
      if (type === 'audio.chunk') {
        chunks.push(payload);
        currentWindow.push(payload.sequence);
      }
      if (type === 'audio.flush') {
        flushes.push(payload);
        finalized.push(currentWindow);
        currentWindow = [];
      }
    }
  };

  const first = lifecycleChunk(sessionId, 0, 'AAABAA==', 'sha256:6b1e73a0094b7b812d3b9e22cffb4f8239319847522c4fa103753b6950020f93', '00:00:00.000', '00:00:00.256');
  await application.acceptAudioChunk(first);
  const duplicate = await application.acceptAudioChunk(structuredClone(first));
  assert.deepEqual(duplicate, { accepted: true, duplicate: true, sequence: 0 });
  assert.deepEqual([...application.audioChunkIdentities.values()], [{ chunk_id: `${sessionId}-chunk-0`, sequence: 0 }], 'replay metadata must not retain raw PCM or base64 audio');
  assert.deepEqual(application.audioPreviewSnapshot(application.audioCurrentUtteranceId, 1).covered_chunk_ids, [`${sessionId}-chunk-0`]);
  assert.equal((await application.acceptAudioFlush({ session_id: sessionId, reason: 'pause' })).queued, true);
  await application.waitForAudioIdle();

  const later = lifecycleChunk(sessionId, 0, 'AAACAA==', 'sha256:313588ae36b23498c072b8718f9a3614d9e52b444cdcea74ecd49c93044741b3', '00:00:00.256', '00:00:00.512');
  await application.acceptAudioChunk(later);
  assert.equal(application.audioPreviewSnapshot(application.audioCurrentUtteranceId, 1).covered_chunk_ids[0], `${sessionId}-chunk-1`);
  assert.equal((await application.acceptAudioFlush({ session_id: sessionId, reason: 'pause' })).queued, true);
  await application.waitForAudioIdle();

  assert.deepEqual(chunks.map((chunk) => [chunk.chunk_id, chunk.sequence, chunk.start_time, chunk.end_time, chunk.checksum]), [
    [`${sessionId}-chunk-0`, 0, '00:00:00.000', '00:00:00.256', first.checksum],
    [`${sessionId}-chunk-1`, 1, '00:00:00.256', '00:00:00.512', later.checksum]
  ]);
  assert.equal(flushes.length, 2);
  assert.notEqual(flushes[0].utterance_id, flushes[1].utterance_id);
  assert.deepEqual(finalized, [[0], [1]]);
  assert.equal(application.audioProcessingError, undefined);
});

test('sustained capture rolls over after 120 chunks without dropping or mixing audio', async () => {
  const sessionId = 'size-rollover-session';
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-rollover-${Date.now()}`) });
  application.sessionId = sessionId;
  application.metadata = { session_id: sessionId, state: 'recording', revision: 1, created_at: '2026-08-30T00:00:00.000Z', started_at: '2026-08-30T00:00:00.000Z' };
  const serviceChunks = [];
  const completedUtterances = [];
  let activeTranscriptions = 0;
  let maxConcurrentTranscriptions = 0;
  let releaseFirstFlush;
  let firstFlushStarted;
  const firstFlush = new Promise((resolve) => { firstFlushStarted = resolve; });
  application.graph = {
    closed: false,
    async dispatchFrom(_from, _plane, type, _correlationId, payload) {
      if (type === 'audio.chunk') {
        serviceChunks.push(payload.sequence);
        return;
      }
      if (type !== 'audio.flush') return;
      const utterance = serviceChunks.splice(0);
      activeTranscriptions += 1;
      maxConcurrentTranscriptions = Math.max(maxConcurrentTranscriptions, activeTranscriptions);
      try {
        if (!releaseFirstFlush) {
          firstFlushStarted();
          await new Promise((resolve) => { releaseFirstFlush = resolve; });
        }
        completedUtterances.push(utterance);
      } finally {
        activeTranscriptions -= 1;
      }
    }
  };

  const chunk = (sequence) => ({
    chunk_id: `${sessionId}-chunk-${sequence}`, session_id: sessionId, sequence,
    start_time: '00:00:00.000', end_time: '00:00:00.256',
    format: { encoding: 'pcm-signed-integer', sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, byte_order: 'little-endian' },
    sample_count: 2, byte_length: 4, audio_base64: 'AAABAA==', checksum: 'sha256:6b1e73a0094b7b812d3b9e22cffb4f8239319847522c4fa103753b6950020f93'
  });

  // Deterministic delayed-Whisper coverage only; no physical microphone is simulated.
  for (let sequence = 0; sequence <= 120; sequence += 1) await application.acceptAudioChunk(chunk(sequence));
  await firstFlush;
  assert.equal(application.audioCurrentUtterance.length, 1);
  assert.equal((await application.acceptAudioFlush({ session_id: sessionId, reason: 'pause' })).queued, true);
  releaseFirstFlush();
  await application.waitForAudioIdle();

  assert.deepEqual(completedUtterances, [Array.from({ length: 120 }, (_, sequence) => sequence), [120]]);
  assert.equal(maxConcurrentTranscriptions, 1);
  assert.equal(application.audioProcessingError, undefined);
});

test('continuous two-minute capture survives pause and forced windows across the worker completion gap', async () => {
  const sessionId = 'continuous-finalization-session';
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-continuous-finalization-${Date.now()}`) });
  application.sessionId = sessionId;
  application.metadata = { session_id: sessionId, state: 'recording', revision: 1, created_at: '2026-08-30T00:00:00.000Z', started_at: '2026-08-30T00:00:00.000Z' };
  application.boundary = { projection: (messageType, payload) => ({ message_type: messageType, payload }) };
  application.started = true;
  const projections = [];
  const deliveredChunks = [];
  const finalizedWindows = [];
  const flushes = [];
  let currentWindow = [];
  let releaseFirstFlush;
  let firstFlushStarted;
  const firstFlushGate = new Promise((resolve) => { releaseFirstFlush = resolve; });
  const firstFlush = new Promise((resolve) => { firstFlushStarted = resolve; });

  const emitFinalRow = (window, flush) => {
    const rowSequence = finalizedWindows.length;
    const utteranceId = flush.utterance_id;
    const startTime = window[0].start_time;
    const endTime = window.at(-1).end_time;
    finalizedWindows.push({ utterance_id: utteranceId, sequences: window.map((chunk) => chunk.sequence), reason: flush.reason || 'rollover' });
    application.handleGraphMessage({ message_id: `boundary-${rowSequence}`, message_type: 'transcript.utterance-boundary', payload: {
      boundary_id: `${utteranceId}-boundary`, session_id: sessionId, utterance_id: utteranceId, reason: 'flush', first_word_sequence: rowSequence,
      last_word_sequence: rowSequence, start_time: startTime, end_time: endTime, punctuation_hint: 'statement', source_chunk_ids: window.map((chunk) => chunk.chunk_id)
    } });
    const revisionId = `${sessionId}-segment-${rowSequence}-r0`;
    application.handleGraphMessage({ message_id: `history-${rowSequence}`, message_type: 'transcript.history-appended', payload: {
      history_entry_id: revisionId, session_id: sessionId, segment_id: `${sessionId}-segment-${rowSequence}`, segment_revision: 0, revision_id: revisionId, appended_at: '2026-09-01T00:00:00.000Z'
    } });
    application.handleGraphMessage({ message_id: `segment-${rowSequence}`, message_type: 'transcript.segment', payload: {
      segment_id: `${sessionId}-segment-${rowSequence}`, revision_id: revisionId, session_id: sessionId, sequence: rowSequence, revision: 0,
      start_time: startTime, end_time: endTime, text: `Final window ${rowSequence}.`, boundary: 'flush'
    } });
  };

  application.graph = {
    closed: false,
    dispatchFrom(_from, _plane, type, _correlationId, payload) {
      if (type === 'audio.chunk') {
        deliveredChunks.push(payload);
        currentWindow.push(payload);
        return Promise.resolve();
      }
      if (type !== 'audio.flush') return Promise.resolve();
      const window = currentWindow.splice(0);
      const flushIndex = flushes.push({ ...payload, sequences: window.map((chunk) => chunk.sequence) }) - 1;
      if (flushIndex === 0) {
        firstFlushStarted();
        firstFlushGate.then(() => emitFinalRow(window, payload));
        return firstFlushGate;
      }
      emitFinalRow(window, payload);
      return Promise.resolve();
    }
  };
  application.onProjection((message) => projections.push(message));

  const chunk = (sequence) => ({
    chunk_id: `${sessionId}-source-${sequence}`, session_id: sessionId, sequence,
    start_time: clock(sequence * 256), end_time: clock((sequence + 1) * 256),
    format: { encoding: 'pcm-signed-integer', sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, byte_order: 'little-endian' },
    sample_count: 2, byte_length: 4, audio_base64: 'AAABAA==', checksum: 'sha256:6b1e73a0094b7b812d3b9e22cffb4f8239319847522c4fa103753b6950020f93'
  });

  for (let sequence = 0; sequence < 120; sequence += 1) await application.acceptAudioChunk(chunk(sequence));
  await firstFlush;
  assert.deepEqual(application.audioCurrentUtterance.map((item) => item.sequence), Array.from({ length: 40 }, (_, sequence) => sequence + 80));
  assert.equal((await application.acceptAudioFlush({ session_id: sessionId, reason: 'pause' })).queued, true);

  // Release the first final, then admit the next rollover in the precise
  // completion microtask gap where the old worker has already observed an
  // empty queue but its cleanup callback has not run yet.
  releaseFirstFlush();
  await Promise.resolve().then(() => application.acceptAudioChunk(chunk(120)));
  for (let sequence = 121; sequence < 480; sequence += 1) await application.acceptAudioChunk(chunk(sequence));
  assert.equal((await application.acceptAudioFlush({ session_id: sessionId, reason: 'pause' })).queued, true);
  await application.waitForAudioIdle();

  const rows = projections.filter((message) => message.message_type === 'ui.transcript-row' && !message.payload.provisional);
  assert.deepEqual(finalizedWindows.map((window) => window.sequences), [
    Array.from({ length: 40 }, (_, sequence) => sequence),
    Array.from({ length: 40 }, (_, sequence) => sequence + 40),
    Array.from({ length: 40 }, (_, sequence) => sequence + 80),
    ...Array.from({ length: 8 }, (_, window) => Array.from({ length: 40 }, (_, sequence) => sequence + 120 + (window * 40))),
    Array.from({ length: 40 }, (_, sequence) => sequence + 440)
  ]);
  assert.equal(rows.length, 12, 'each bounded utterance must produce a finalized transcript row');
  assert.deepEqual(rows.map((row) => row.payload.sequence), Array.from({ length: 12 }, (_, sequence) => sequence));
  assert.equal(flushes.length, 12);
  assert.equal(flushes.at(-1).reason, 'pause');
  assert.equal(flushes.filter((flush) => flush.reason === 'pause').length, 2);
  assert.equal(flushes.filter((flush) => flush.reason === 'size').length, 10);
  assert.deepEqual(deliveredChunks.map((item) => item.sequence), Array.from({ length: 480 }, (_, sequence) => sequence));
  assert.deepEqual([...application.audioChunkIdentities.values()].map((item) => item.sequence), Array.from({ length: 480 }, (_, sequence) => sequence));
  assert.equal(application.audioProcessingError, undefined);
  assert.deepEqual(application.audioQueueDiagnostics(), {
    capturing_chunk_count: 0, queued_window_count: 0, queued_chunk_count: 0, active_window_id: undefined, active_chunk_count: 0, audio_in_flight: 0
  });
});

test('startup recovery routes an unclean recording through the lifecycle owner and preserves duration', async () => {
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-recovery-correction-'));
  const sessionId = 'unclean-recording-session';
  const times = ['2026-08-30T00:00:00.000Z', '2026-08-30T00:00:06.656Z'];
  const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: sessionRoot }), clock: () => times.shift() || '2026-08-30T00:00:06.656Z' });
  await lifecycle.record({ operation_id: 'record-unclean', session_id: sessionId, requested_at: '2026-08-30T00:00:00.000Z' });
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot });
  const calls = [];
  application.graph = {
    async dispatchFrom(_from, plane, type, _correlationId, payload) { calls.push(`${plane}:${type}`); if (type === 'session.stop') await lifecycle.stop(payload); },
    async waitForIdle() {}
  };
  await application.recoverUncleanRecordings();
  assert.deepEqual(calls, ['control:session.stop']);
  await application.loadLatestSession(sessionId);
  assert.equal(application.metadata.state, 'stopped');
  assert.equal(application.sessionProjection().elapsed_seconds, 6);
  await rm(sessionRoot, { recursive: true, force: true });
});

test('startup recovery resumes an interrupted close through the original close operation', async () => {
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-close-recovery-correction-'));
  const sessionId = 'interrupted-close-session';
  const lifecycle = new SessionLifecycle({ storage: new SessionStorage({ root: sessionRoot }) });
  await lifecycle.record({ operation_id: 'record-interrupted-close', session_id: sessionId, requested_at: '2026-08-30T00:00:00.000Z' });
  const close = { operation_id: 'close-interrupted', session_id: sessionId, requested_at: '2026-08-30T00:00:01.000Z' };
  await assert.rejects(() => lifecycle.close(close, { failAfterPhase: 'drained' }), /Test interruption after finalization phase drained/);

  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot });
  const calls = [];
  application.graph = {
    async dispatchFrom(_from, plane, type, _correlationId, payload) {
      calls.push(`${plane}:${type}`);
      if (type === 'session.close') await lifecycle.close(payload);
    },
    async waitForIdle() {}
  };
  await application.recoverUncleanRecordings();
  assert.deepEqual(calls, ['control:session.close']);
  await application.loadLatestSession(sessionId);
  assert.equal(application.metadata.state, 'closed');
  assert.equal(application.sessionProjection().state, 'closed');
  await rm(sessionRoot, { recursive: true, force: true });
});

test('Whisper buffers many chunks without launching and launches exactly once on flush', async () => {
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-whisper-correction-'));
  const tempRoot = path.join(sessionRoot, '.argus-stt');
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-whisper-probe-'));
  const binary = path.join(probeRoot, 'whisper-probe.cmd');
  const model = path.join(probeRoot, 'model.bin');
  const counter = path.join(probeRoot, 'launches.txt');
  await mkdir(tempRoot, { recursive: true });
  await writeFile(path.join(tempRoot, '99999-1-dead.wav'), 'abandoned');
  await writeFile(path.join(tempRoot, '99999-1-dead.json'), '{}');
  await writeFile(model, 'model');
  await writeFile(binary, '@echo off\r\nif not "%ARGUS_PROBE_COUNTER%"=="" echo launch>>"%ARGUS_PROBE_COUNTER%"\r\n> "%~7.json" echo {"transcription":[{"text":"[*BEG*] Okay . [_TT_250].","offsets":{"from":0,"to":6656},"tokens":[{"text":"[*BEG*]","p":0.99,"offsets":{"from":0,"to":0}},{"text":"Okay","p":0.91,"offsets":{"from":0,"to":6000}},{"text":".","p":0.92,"offsets":{"from":6000,"to":6656}},{"text":"[_TT_250]","p":0.99,"offsets":{"from":6656,"to":6656}}]}]}\r\n');
  const sessionId = 'whisper-correction-session';
  const chunks = Array.from({ length: 12 }, (_, sequence) => whisperChunk(sequence, sessionId));
  const flush = envelope('audio.flush', `${sessionId}:flush`, { session_id: sessionId, requested_at: '2026-08-30T00:00:00.000Z', reason: 'flush' });
  try {
    const result = await runServiceBatches(whisperManifest, [
      { inputs: chunks, expectedOutputCount: chunks.length },
      { inputs: [flush], expectedOutputCount: 3 }
    ], 10000, { env: { ARGUS_SESSION_ROOT: sessionRoot, ARGUS_WHISPER_BINARY: binary, ARGUS_WHISPER_MODEL: model, ARGUS_PROBE_COUNTER: counter } });
    assert.equal((await readFile(counter, 'utf8')).trim().split(/\r?\n/).filter(Boolean).length, 1);
    const words = result.outputs.filter((message) => message.message_type === 'transcript.word-committed');
    assert.deepEqual(words.map((message) => message.payload.text), ['Okay.']);
    assert.equal(JSON.stringify(words).includes('[*BEG*]'), false);
    assert.equal(JSON.stringify(words).includes('[_TT_250]'), false);
    assert.equal(JSON.stringify(result.outputs).includes('<|'), false);
    await assert.rejects(readFile(path.join(tempRoot, '99999-1-dead.wav')), /ENOENT/);
    await assert.rejects(readFile(path.join(tempRoot, '99999-1-dead.json')), /ENOENT/);
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
    await rm(probeRoot, { recursive: true, force: true });
  }
});

test('three delayed Whisper windows preserve one authoritative word sequence and immutable window provenance', async () => {
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-sequence-windows-'));
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-sequence-windows-probe-'));
  const binary = path.join(probeRoot, 'whisper-sequence-probe.cmd');
  const model = path.join(probeRoot, 'model.bin');
  const counter = path.join(probeRoot, 'launches.txt');
  const sessionId = 'three-window-sequence-session';
  await writeFile(model, 'model');
  await writeFile(binary, [
    '@echo off',
    'setlocal EnableDelayedExpansion',
    'if not exist "%ARGUS_PROBE_COUNTER%" echo 0>"%ARGUS_PROBE_COUNTER%"',
    'set /p count=<"%ARGUS_PROBE_COUNTER%"',
    'set /a count+=1',
    'echo !count!>"%ARGUS_PROBE_COUNTER%"',
    'ping 127.0.0.1 -n 2 >nul',
    'if "!count!"=="1" ( >"%~7.json" echo {"transcription":[{"text":" First.","offsets":{"from":0,"to":1000},"tokens":[{"text":" First","p":0.95,"offsets":{"from":0,"to":800}},{"text":".","p":0.95,"offsets":{"from":800,"to":1000}}]}]} )',
    'if "!count!"=="2" ( >"%~7.json" echo {"transcription":[{"text":" Second.","offsets":{"from":0,"to":1000},"tokens":[{"text":" Second","p":0.95,"offsets":{"from":0,"to":800}},{"text":".","p":0.95,"offsets":{"from":800,"to":1000}}]}]} )',
    'if "!count!"=="3" ( >"%~7.json" echo {"transcription":[{"text":" Third.","offsets":{"from":0,"to":1000},"tokens":[{"text":" Third","p":0.95,"offsets":{"from":0,"to":800}},{"text":".","p":0.95,"offsets":{"from":800,"to":1000}}]}]} )'
  ].join('\r\n') + '\r\n');
  const flush = (sequence, reason) => envelope('audio.flush', `${sessionId}:flush:${sequence}`, {
    session_id: sessionId, utterance_id: `${sessionId}-utterance-${sequence}`, requested_at: '2026-09-01T00:00:00.000Z', reason
  });
  try {
    const whisper = await runServiceBatches(path.join(root, 'services', 'whisper-cpp-stt', 'service.json'), [
      { inputs: [whisperChunk(0, sessionId), flush(0, 'pause')], expectedOutputCount: 4 },
      { inputs: [whisperChunk(1, sessionId), flush(1, 'size')], expectedOutputCount: 4 },
      { inputs: [whisperChunk(2, sessionId), flush(2, 'flush')], expectedOutputCount: 4 }
    ], 10000, { env: { ARGUS_SESSION_ROOT: sessionRoot, ARGUS_WHISPER_BINARY: binary, ARGUS_WHISPER_MODEL: model, ARGUS_PROBE_COUNTER: counter, ARGUS_WHISPER_DELAYED_MS: '10', ARGUS_DIAGNOSTICS: '1' } });
    const domain = whisper.outputs.filter((message) => message.plane === 'domain');
    const words = domain.filter((message) => message.message_type === 'transcript.word-committed');
    const boundaries = domain.filter((message) => message.message_type === 'transcript.utterance-boundary');
    assert.deepEqual(words.map((message) => message.payload.sequence), [0, 1, 2]);
    assert.equal(new Set(words.map((message) => message.payload.word_id)).size, 3);
    assert.deepEqual(words.map((message) => message.payload.evidence.audio_window_id), [
      `${sessionId}-audio-window-0`, `${sessionId}-audio-window-1`, `${sessionId}-audio-window-2`
    ]);
    assert.deepEqual(boundaries.map((message) => message.payload.reason), ['pause', 'size', 'flush']);
    assert.ok(whisper.diagnostics.filter((line) => line.trimStart().startsWith('{')).map((line) => JSON.parse(line)).filter((record) => record.event === 'whisper.delayed').length >= 3);

    const resolutions = boundaries.map((boundary) => createEnvelope({
      plane: 'domain', messageType: 'transcript.correction-resolved', producer: 'sequence-window-test', correlationId: sessionId,
      idempotencyKey: `${boundary.payload.boundary_id}:resolution`,
      payload: {
        request_id: `${boundary.payload.boundary_id}-correction`, session_id: sessionId, utterance_id: boundary.payload.utterance_id,
        boundary_id: boundary.payload.boundary_id, proposals: [],
        formatting: { terminal_mark: '.', capitalize_first_word: false, confidence: 0.99 },
        generator: { implementation: 'sequence-window-test', policy_profile: 'test', instruction_version: '1.0.0' }
      }
    }));
    const owner = await runServiceBatches(path.join(root, 'services', 'active-transcript-owner', 'service.json'), [
      { inputs: domain, expectedOutputCount: 9 },
      { inputs: resolutions.flatMap((resolution, index) => [resolution, transcriptHistoryAck(sessionId, index)]), expectedOutputCount: 15 }
    ], 10000, { env: { ARGUS_SESSION_ROOT: '' } });
    const segments = owner.outputs.filter((message) => message.message_type === 'transcript.segment');
    assert.deepEqual(segments.map((message) => message.payload.sequence), [0, 1, 2]);
    assert.deepEqual(segments.flatMap((message) => message.payload.word_provenance.map((word) => [word.source_sequence, word.source_audio_window_id, word.source_chunk_ids])), [
      [0, `${sessionId}-audio-window-0`, [`${sessionId}-chunk-0`]],
      [1, `${sessionId}-audio-window-1`, [`${sessionId}-chunk-1`]],
      [2, `${sessionId}-audio-window-2`, [`${sessionId}-chunk-2`]]
    ]);
    assert.deepEqual(boundaries.map((message) => [message.payload.audio_window_span.first_chunk_id, message.payload.audio_window_span.last_chunk_id, message.payload.audio_window_span.chunk_count]), [
      [`${sessionId}-chunk-0`, `${sessionId}-chunk-0`, 1],
      [`${sessionId}-chunk-1`, `${sessionId}-chunk-1`, 1],
      [`${sessionId}-chunk-2`, `${sessionId}-chunk-2`, 1]
    ]);
    assert.equal(owner.outputs.some((message) => message.message_type === 'service.failure'), false);
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
    await rm(probeRoot, { recursive: true, force: true });
  }
});

test('shutdown waits for audio, routes stop before graph drain, and ignores late audio stably', async () => {
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-shutdown-${Date.now()}`) });
  application.sessionId = 'shutdown-session';
  application.metadata = { session_id: application.sessionId, state: 'recording', revision: 1, created_at: '2026-08-30T00:00:00.000Z', started_at: '2026-08-30T00:00:00.000Z', operations: { record: { operation: 'session.record', outcome: { completed_at: '2026-08-30T00:00:00.000Z' } } } };
  application.boundary = { projection: (messageType, payload) => ({ message_type: messageType, payload }) };
  const calls = [];
  application.graph = {
    closed: false,
    async dispatchFrom(_from, plane, type) { calls.push(`${plane}:${type}`); },
    async waitForIdle() { calls.push('waitForIdle'); },
    async close() { calls.push('close'); this.closed = true; }
  };
  application.loadLatestSession = async () => {};
  application.audioInFlight = 1;
  const shutdown = application.shutdown();
  assert.deepEqual(calls, []);
  assert.deepEqual(await application.acceptAudioChunk({ session_id: application.sessionId }), { accepted: false, ignored: true, code: 'SHUTDOWN_IN_PROGRESS', session_id: application.sessionId, reason: 'Application shutdown is in progress.' });
  application.audioInFlight = 0;
  application.resolveAudioIdleWaiters();
  await shutdown;
  assert.ok(calls.indexOf('domain:audio.flush') < calls.indexOf('control:session.stop'));
  assert.equal(calls.at(-1), 'close');
});

function graphPrepared({ capacity = 1, timeout = 100 } = {}) {
  const wire = { from: 'speech-to-text', contract: 'transcript.word-committed', to: 'active-transcript', delivery: { queue_capacity: capacity, operation_timeout_ms: timeout } };
  return {
    definition: { domain_wires: [wire], control_wires: [], supervision: { operation_timeout_ms: timeout, queue: { capacity } } },
    endpoints: new Map([
      ['active-transcript', { endpointType: 'service', serviceName: 'active-transcript-owner' }],
      ['@supervisor', { endpointType: 'runtime', kind: 'supervisor' }]
    ]),
    providers: new Map(),
    services: new Map()
  };
}

function graphWord(sessionId, sequence) {
  return createEnvelope({
    plane: 'domain', messageType: 'transcript.word-committed', producer: 'speech-to-text', correlationId: sessionId,
    idempotencyKey: `${sessionId}:word:${sequence}`,
    payload: {
      word_id: `${sessionId}-word-${sequence}`, session_id: sessionId, utterance_id: `${sessionId}-utterance-0`, sequence,
      start_time: '00:00:00.000', end_time: '00:00:00.100', text: `word-${sequence}`, confidence: 0.99,
      evidence: { provider: 'speech-to-text', chunk_ids: [`${sessionId}-chunk-0`], alternatives: [] }
    }
  });
}

function transcriptHistoryAck(sessionId, sequence, revision = 0) {
  const segmentId = `${sessionId}-segment-${sequence}`;
  const revisionId = `${segmentId}-r${revision}`;
  return createEnvelope({
    plane: 'domain', messageType: 'transcript.history-appended', producer: 'permanent-transcript-history', correlationId: sessionId,
    schemaVersion: '1.3.0', idempotencyKey: `history-ack:${revisionId}`,
    payload: { history_entry_id: revisionId, session_id: sessionId, segment_id: segmentId, segment_revision: revision, revision_id: revisionId, appended_at: '2026-09-01T00:00:00.000Z' }
  });
}

function whisperChunk(sequence, sessionId) {
  return envelope('audio.chunk', `${sessionId}:chunk:${sequence}`, {
    chunk_id: `${sessionId}-chunk-${sequence}`, session_id: sessionId, sequence,
    start_time: '00:00:00.000', end_time: '00:00:00.256',
    format: { encoding: 'pcm-signed-integer', sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, byte_order: 'little-endian' },
    sample_count: 2, byte_length: 4, audio_base64: 'AAABAA==', checksum: 'sha256:6b1e73a0094b7b812d3b9e22cffb4f8239319847522c4fa103753b6950020f93'
  });
}

function lifecycleChunk(sessionId, sequence, audio_base64, checksum, start_time, end_time) {
  return {
    chunk_id: `${sessionId}-chunk-${sequence}`, session_id: sessionId, sequence,
    start_time, end_time,
    format: { encoding: 'pcm-signed-integer', sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, byte_order: 'little-endian' },
    sample_count: Buffer.from(audio_base64, 'base64').byteLength / 2,
    byte_length: Buffer.from(audio_base64, 'base64').byteLength,
    audio_base64, checksum
  };
}

function clock(milliseconds) {
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const seconds = Math.floor((milliseconds % 60000) / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

function envelope(messageType, idempotencyKey, payload) {
  return {
    message_id: idempotencyKey, idempotency_key: idempotencyKey, plane: 'domain', message_type: messageType,
    timestamp: '2026-08-30T00:00:00.000Z', producer: 'correction-test', correlation_id: payload.session_id, schema_version: '1.2.0', payload
  };
}
