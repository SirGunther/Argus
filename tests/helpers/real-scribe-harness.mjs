import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintScribeGuidance } from '../../contracts/model-protocol.mjs';
import { InteractiveGraph } from '../../runtime/interactive-graph.mjs';
import { SessionStorage } from '../../runtime/session-storage.mjs';

/**
 * Acceptance harness for the real Scribe path against a real model provider.
 *
 * It runs `wiring/production-electron.json` with exactly one substitution - Whisper is replaced by
 * an injected evidence source emitting the same `transcript.word-committed` and
 * `transcript.utterance-boundary` traffic speech-to-text emits. That substitution is the physical
 * microphone boundary and nothing else: the transcript owner, permanent history, Scribe policy
 * source, coordinator, durable checkpoint/journal, extraction boundary, serial model lane, Logged
 * Item owner, and append-only Logged Item history are all the real production services in their
 * own processes, reading and writing the same durable files the desktop host recovers from.
 *
 * Unlike the SCRIBE-05 integration harness, this one does NOT scale the admission deadline down.
 * The `ai.work-request` operation deadline stays at the production value so a real inference that
 * outlasts it is the actual failure condition SCRIBE-05A fixed, not a proxy for it.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const productionGraphFile = path.join(root, 'wiring', 'production-electron.json');

export const PRODUCTION_IDLE_TIMEOUT_MS = 15000;

export async function startRealScribeHarness({
  endpointUrl,
  modelName,
  idleTimeoutMs = PRODUCTION_IDLE_TIMEOUT_MS,
  providerTimeoutMs = 120000,
  guidance,
  directory,
  sessionId
} = {}) {
  if (!endpointUrl) throw new TypeError('a real model endpoint URL is required');
  if (!modelName) throw new TypeError('a real model name is required');
  const base = directory || await mkdtemp(path.join(os.tmpdir(), 'scribe-acceptance-'));
  const sessionRoot = path.join(base, 'sessions');
  const graphFile = path.join(base, `graph-${Math.random().toString(36).slice(2)}.json`);
  const definition = await writeGraph(graphFile, { idleTimeoutMs });

  process.env.ARGUS_SESSION_ROOT = sessionRoot;
  // What `DesktopApplication.setModelEnvironment` does for the real host. The extraction boundary
  // reads the model name from its own process environment while the model lane reads it from the
  // live `ai.provider-configure` message, and the lane refuses a batch whose request model does not
  // match its configured model. Setting only one of the two here would test a misconfiguration
  // rather than the shipped path.
  process.env.ARGUS_MODEL_NAME = modelName;
  process.env.ARGUS_MODEL_ENDPOINT = endpointUrl;
  process.env.ARGUS_MODEL_PROTOCOL = 'openai-compatible';
  process.env.ARGUS_MODEL_TIMEOUT_MS = String(providerTimeoutMs);
  const storage = new SessionStorage({ root: sessionRoot });
  await storage.ensureRoot();

  const harness = {
    admitted: [], evaluated: [], stored: [], flushed: [], segments: [],
    historyAppended: [], drained: [], failures: [], allMessages: [],
    storage, sessionRoot, graphDefinition: definition, baseDirectory: base,
    sessionId: sessionId || `session-acceptance-${Math.random().toString(36).slice(2, 10)}`,
    ownedDirectory: directory ? undefined : base
  };

  const seen = new Set();
  harness.graph = await InteractiveGraph.create(graphFile, {
    onMessage: (message) => {
      if (seen.has(message.message_id)) return;
      seen.add(message.message_id);
      harness.allMessages.push({ type: message.message_type, at: Date.now() });
      if (message.message_type === 'scribe.batch-admitted') harness.admitted.push(message);
      if (message.message_type === 'scribe.batch-evaluated') harness.evaluated.push(message);
      if (message.message_type === 'logged-item.stored') harness.stored.push(message);
      if (message.message_type === 'scribe.session-flushed') harness.flushed.push(message);
      if (message.message_type === 'transcript.segment') harness.segments.push(message);
      if (message.message_type === 'logged-item.history-appended') harness.historyAppended.push(message);
      if (message.message_type === 'service.drained') harness.drained.push(message);
      if (message.message_type === 'service.failure') harness.failures.push(message);
      harness.observe?.(message);
    },
    onStatus: (status) => { if (status.type === 'service-failure' || status.type === 'graph-failure') harness.failures.push(status); }
  });
  await harness.graph.start();
  await harness.graph.dispatchFrom('@desktop-controller', 'control', 'ai.provider-configure', harness.sessionId, {
    configuration: { version: 1, mode: 'local', provider: 'lm-studio', endpoint: endpointUrl, model: modelName, protocol: 'openai-compatible', timeout_ms: providerTimeoutMs },
    credential: { provided: false }
  }, `provider:${harness.sessionId}`);

  // The host's guidance snapshot, sent exactly the way `DesktopApplication` sends it before a
  // session records. Omitted entirely when no guidance is configured, which is the default path.
  harness.configureGuidance = async (text) => {
    await harness.graph.dispatchFrom('@desktop-controller', 'control', 'scribe.guidance-configure', harness.sessionId, {
      session_id: harness.sessionId,
      additional_guidance: text,
      guidance_fingerprint: fingerprintScribeGuidance(text),
      instruction_version: definition.run.configuration.scribe_policy.generation.instruction_version
      // Byte-for-byte the host's key (`DesktopApplication.configureScribeGuidance`). A different
      // key here would make a replay look like new work and would be testing the harness.
    }, `scribe-guidance-configure:${harness.sessionId}:${fingerprintScribeGuidance(text).slice(7, 19)}`);
    await harness.graph.waitForIdle();
  };
  if (guidance !== undefined) await harness.configureGuidance(guidance);

  harness.record = async () => {
    await harness.graph.dispatchFrom('@desktop-controller', 'control', 'session.record', harness.sessionId, {
      operation_id: `record-${harness.sessionId}`, session_id: harness.sessionId, requested_at: new Date().toISOString()
    }, `record:${harness.sessionId}`);
    await harness.graph.waitForIdle();
  };

  harness.stopRecording = async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    await harness.graph.dispatchFrom('@desktop-controller', 'control', 'session.stop', harness.sessionId, {
      operation_id: `stop-${harness.sessionId}-${suffix}`, session_id: harness.sessionId, requested_at: new Date().toISOString()
    }, `stop:${harness.sessionId}:${suffix}`);
    await harness.graph.waitForIdle();
  };

  harness.resume = async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const metadata = await storage.readMetadata(harness.sessionId);
    if (metadata?.state === 'recording') {
      await harness.graph.dispatchFrom('@desktop-controller', 'control', 'session.stop', harness.sessionId, {
        operation_id: `startup-recovery-${harness.sessionId}-${suffix}`, session_id: harness.sessionId, requested_at: new Date().toISOString()
      }, `startup-recovery:${harness.sessionId}:${suffix}`);
      await harness.graph.waitForIdle();
    }
    await harness.graph.dispatchFrom('@desktop-controller', 'control', 'session.resume', harness.sessionId, {
      operation_id: `resume-${harness.sessionId}-${suffix}`, session_id: harness.sessionId, requested_at: new Date().toISOString()
    }, `resume:${harness.sessionId}:${suffix}`);
    await harness.graph.waitForIdle();
  };

  /**
   * One finalized transcript row of real sentence text. Whisper emits one committed word per word
   * and then an utterance boundary; this reproduces that exact traffic so the transcript owner
   * finalizes the row itself rather than being handed a finished segment.
   *
   * Word sequences are a single contiguous per-session stream. The transcript owner rejects a gap
   * (`SEQUENCE_GAP`), so a per-row numbering scheme is not merely untidy - it is refused, exactly
   * as a dropped Whisper word would be.
   */
  let nextWordSequence = 0;
  harness.finalizeRow = async (sequence, text) => {
    const utteranceId = `${harness.sessionId}-utterance-${sequence}`;
    const words = String(text).trim().split(/\s+/);
    const clock = (seconds) => {
      const whole = Math.floor(seconds);
      return `00:${String(Math.floor(whole / 60) % 60).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}.000`;
    };
    const first = nextWordSequence;
    for (const word of words) {
      const wordSequence = nextWordSequence;
      nextWordSequence += 1;
      await harness.graph.dispatchFrom('@desktop-controller', 'domain', 'transcript.word-committed', harness.sessionId, {
        word_id: `${harness.sessionId}-word-${wordSequence}`, session_id: harness.sessionId, utterance_id: utteranceId,
        sequence: wordSequence, start_time: clock(wordSequence), end_time: clock(wordSequence + 1), text: word, confidence: 0.97,
        evidence: { provider: 'scribe-acceptance-injected-speech', chunk_ids: [`${harness.sessionId}-chunk-${wordSequence}`], alternatives: [] }
      }, `word:${harness.sessionId}:${wordSequence}`);
    }
    const last = nextWordSequence - 1;
    await harness.graph.dispatchFrom('@desktop-controller', 'domain', 'transcript.utterance-boundary', harness.sessionId, {
      boundary_id: `${utteranceId}-boundary`, session_id: harness.sessionId, utterance_id: utteranceId, reason: 'pause',
      first_word_sequence: first, last_word_sequence: last, start_time: clock(first), end_time: clock(last + 1),
      punctuation_hint: 'statement', source_chunk_ids: words.map((_, index) => `${harness.sessionId}-chunk-${first + index}`)
    }, `boundary:${harness.sessionId}:${sequence}`);
  };

  harness.closeSession = async () => {
    const requestId = `close-${Math.random().toString(36).slice(2, 10)}`;
    await harness.graph.dispatchFrom('@desktop-controller', 'control', 'scribe.session-closing', harness.sessionId, {
      session_id: harness.sessionId, request_id: requestId, requested_at: new Date().toISOString()
    }, `scribe-session-closing:${harness.sessionId}:${requestId}`);
    await harness.waitFor(() => harness.flushed.some((message) => message.payload.request_id === requestId), 'Scribe acknowledged the Close flush', 300000);
    const acknowledgement = harness.flushed.find((message) => message.payload.request_id === requestId).payload;
    if (!acknowledgement.accepted) return { sealed: false, acknowledgement };
    await harness.graph.dispatchFrom('@desktop-controller', 'control', 'session.close', harness.sessionId, {
      operation_id: `close-${harness.sessionId}`, session_id: harness.sessionId, requested_at: new Date().toISOString()
    }, `close:${harness.sessionId}`);
    await harness.graph.waitForIdle();
    return { sealed: true, acknowledgement };
  };

  harness.metadata = () => storage.readMetadata(harness.sessionId);
  harness.checkpoint = () => storage.readScribeCheckpoint(harness.sessionId);
  harness.journal = () => storage.readScribeBatchJournal(harness.sessionId);

  harness.waitFor = async (condition, label, timeoutMs = 300000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failures = harness.failures.map((item) => item.payload?.error?.message || item.message).join(' | ');
    throw new Error(`Timed out waiting for ${label}; admitted=${harness.admitted.length} evaluated=${harness.evaluated.length} stored=${harness.stored.length} segments=${harness.segments.length}${failures ? `; failures: ${failures}` : ''}`);
  };
  harness.waitForCursor = (sequence, label = `durable cursor ${sequence}`) =>
    harness.waitFor(async () => (await harness.checkpoint())?.admitted_through.last_sequence === sequence, label);

  /** Abrupt termination, not a drain: a drain would let the coordinator settle, which a crash must not. */
  harness.crash = async () => {
    harness.graph.draining = true;
    harness.graph.stopProcesses();
    await new Promise((resolve) => setTimeout(resolve, 750));
  };

  /**
   * `close()` performs the governed drain. It is bounded by the graph's own drain timeout, but the
   * model lane deliberately refuses to report drained while admitted inference is still open, and a
   * real inference can run for the better part of a minute. `stopProcesses()` afterwards is the
   * unconditional backstop: without it a leaked service process keeps the test runner's stdio open
   * and the run never terminates.
   */
  harness.shutdown = async ({ keepDirectory = false } = {}) => {
    try { await harness.graph.close(); } catch { /* drain already failed or timed out */ }
    try { harness.graph.stopProcesses(); } catch { /* already stopped */ }
    if (harness.ownedDirectory && !keepDirectory) await rm(harness.ownedDirectory, { recursive: true, force: true }).catch(() => {});
  };

  return harness;
}

async function writeGraph(graphFile, { idleTimeoutMs }) {
  const definition = JSON.parse(await readFile(productionGraphFile, 'utf8'));
  definition.name = 'argus-scribe-acceptance';
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
  // The one policy value an acceptance scenario may vary, because waiting the real 15 s for every
  // idle scenario is wall-clock only. The admission deadline on `ai.work-request` is deliberately
  // left at its production value.
  definition.run.configuration.scribe_policy.admission.idle_timeout_ms = idleTimeoutMs;
  await writeFile(graphFile, JSON.stringify(definition, null, 2), 'utf8');
  return definition;
}
