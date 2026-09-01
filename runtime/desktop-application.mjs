import { createHash, randomUUID } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createUiContractBoundary } from '../ui/bridge-contracts.mjs';
import { createPlatformCapabilities } from '../ui/platform-capabilities.mjs';
import { InteractiveGraph } from './interactive-graph.mjs';
import { SessionStorage } from './session-storage.mjs';
import { calculateRecordingDurationMs } from './session-lifecycle.mjs';
import { createDiagnosticLogger } from './diagnostics.mjs';
import { createAudioPreviewScheduler } from './audio-preview-scheduler.mjs';
import { canonicalJson } from './message-identity.mjs';

const ALLOWED_ENVIRONMENT = ['ARGUS_SESSION_ROOT', 'ARGUS_MODEL_ENDPOINT', 'ARGUS_MODEL_NAME', 'ARGUS_MODEL_TIMEOUT_MS', 'ARGUS_MODEL_PROTOCOL', 'ARGUS_WHISPER_BINARY', 'ARGUS_WHISPER_MODEL', 'ARGUS_WHISPER_TIMEOUT_MS', 'ARGUS_WHISPER_DELAYED_MS', 'ARGUS_WHISPER_PREVIEW_CADENCE_MS', 'ARGUS_DIAGNOSTICS'];
const CAPABILITIES = ['microphone', 'stt', 'model', 'orchestration', 'transcript', 'logged-item-pipeline', 'storage-session', 'clipboard', 'folder-opening'];
const MAX_AUDIO_QUEUE_ITEMS = 256;
const MAX_AUDIO_UTTERANCES = 16;
const DELAYED_AUDIO_UTTERANCES = 4;
const MAX_UTTERANCE_CHUNKS = 120;
const PIPELINE_STALL_THRESHOLD_MS = 30000;

export class DesktopApplication {
  constructor({ root, graphFile, sessionRoot, environment = process.env, diagnosticsEnabled = false, diagnosticsOutput, diagnosticClock, diagnosticStallThresholdMs = PIPELINE_STALL_THRESHOLD_MS } = {}) {
    this.root = path.resolve(root);
    this.graphFile = path.resolve(graphFile);
    this.sessionRoot = path.resolve(sessionRoot);
    this.environment = environment;
    this.diagnostics = createDiagnosticLogger({ enabled: diagnosticsEnabled, output: diagnosticsOutput, clock: diagnosticClock, source: 'electron-main' });
    for (const key of ALLOWED_ENVIRONMENT) if (environment[key] !== undefined) process.env[key] = String(environment[key]);
    process.env.ARGUS_SESSION_ROOT = this.sessionRoot;
    this.storage = new SessionStorage({ root: this.sessionRoot });
    this.capabilities = createPlatformCapabilities({ environment: process.env });
    this.boundary = undefined;
    this.graph = undefined;
    this.sessionId = process.env.ARGUS_SESSION_ID || `session-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
    this.metadata = undefined;
    this.transcript = [];
    this.loggedItems = [];
    this.transcriptPartials = new Map();
    this.transcriptBoundaries = new Map();
    this.projectionListeners = new Set();
    this.commandResults = new Map();
    this.capabilityState = new Map();
    this.seenMessages = new Set();
    this.audioInFlight = 0;
    this.audioIdleWaiters = new Set();
    this.audioUtteranceQueue = [];
    this.audioCurrentUtterance = [];
    this.audioCurrentUtteranceId = undefined;
    this.audioIdentitySessionId = undefined;
    this.audioNextChunkSequence = 0;
    this.audioChunkIdentities = new Map();
    this.audioQueuedUtterances = 0;
    this.audioQueuedChunkCount = 0;
    this.audioPreparingUtterance = undefined;
    this.audioActiveFlush = undefined;
    this.audioWorkerPromise = undefined;
    this.audioProcessingError = undefined;
    this.audioProcessingOverride = undefined;
    this.audioProcessingLast = undefined;
    this.audioProcessingNotice = undefined;
    this.audioWorkerGeneration = 0;
    this.audioWorkerInvocation = undefined;
    this.pipelinePreviewProgress = new Map();
    this.pipelineStallTimers = new Map();
    this.diagnosticStallThresholdMs = Math.max(1, Number(diagnosticStallThresholdMs) || PIPELINE_STALL_THRESHOLD_MS);
    this.captureActive = false;
    this.shuttingDown = false;
    this.shutdownPromise = undefined;
    this.provisionedManifest = undefined;
    this.started = false;
    this.startError = undefined;
    this.audioPreviewScheduler = createAudioPreviewScheduler({
      cadenceMs: environment.ARGUS_WHISPER_PREVIEW_CADENCE_MS,
      snapshot: ({ utterance_id, revision }) => this.audioPreviewSnapshot(utterance_id, revision),
      dispatch: (snapshot) => this.dispatchAudioPreview(snapshot),
      diagnostic: (event, details) => this.diagnostics.log(`audio.${event}`, { session_id: this.sessionId, ...details })
    });
  }

  onProjection(listener) { this.projectionListeners.add(listener); return () => this.projectionListeners.delete(listener); }

  async start() {
    this.diagnostics.log('host.starting', { session_id: this.sessionId, graph_file: path.basename(this.graphFile) });
    await this.loadProvisionedConfiguration();
    this.boundary = await createUiContractBoundary(this.root);
    await this.loadLatestSession();
    await this.setInitialCapabilities();
    this.graph = await InteractiveGraph.create(this.graphFile, {
      onMessage: (message) => this.handleGraphMessage(message),
      onStatus: (status) => this.handleGraphStatus(status),
      diagnostics: this.diagnostics
    });
    try {
      await this.graph.start();
      this.setCapability('orchestration', 'available', 'Production Argus graph is supervised and ready.', false);
    } catch (error) {
      this.startError = error;
      this.setCapability('orchestration', 'unavailable', `Production graph unavailable: ${error.message}`, true);
      throw error;
    }
    this.started = true;
    this.diagnostics.log('host.started', { session_id: this.sessionId });
    await this.recoverUncleanRecordings();
    await this.loadLatestSession();
    this.emit('ui.session-status', this.sessionProjection());
  }

  async loadProvisionedConfiguration() {
    try {
      const manifest = JSON.parse(await readFile(path.join(this.root, 'runtime-output', 'real-dependencies.json'), 'utf8'));
      const whisper = manifest.whisper || {};
      const model = manifest.local_model || {};
      this.provisionedManifest = manifest;
      const provisioned = {
        ARGUS_WHISPER_BINARY: resolveProvisionedPath(this.root, whisper.binary, whisper.binary_relative),
        ARGUS_WHISPER_MODEL: resolveProvisionedPath(this.root, whisper.model, whisper.model_relative),
        ARGUS_MODEL_ENDPOINT: model.endpoint,
        ARGUS_MODEL_NAME: model.model,
        ARGUS_MODEL_PROTOCOL: model.protocol,
        ARGUS_MODEL_TIMEOUT_MS: '120000',
        ARGUS_WHISPER_TIMEOUT_MS: '120000',
        ARGUS_WHISPER_DELAYED_MS: '10000'
      };
      for (const [key, value] of Object.entries(provisioned)) if (value && !process.env[key]) process.env[key] = String(value);
    } catch {
      // Missing provisioning is a visible unavailable capability, not a simulated fallback.
    }
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.diagnostics.log('shutdown.queue-drain-beginning', { session_id: this.sessionId, ...this.audioQueueDiagnostics() });
    this.shutdownPromise = (async () => {
      try {
        await this.waitForAudioIdle();
        this.diagnostics.log('shutdown.audio-drained', { session_id: this.sessionId, ...this.audioQueueDiagnostics() });
        if (this.graph && !this.graph.closed) {
          await this.graph.waitForIdle();
          await this.loadLatestSession(this.sessionId);
          if (this.metadata?.state === 'recording') {
            await this.sessionCommand({ command: 'session.stop', command_id: `shutdown-stop-${randomUUID()}`, session_id: this.sessionId }, { allowFlushFailure: true });
            await this.graph.waitForIdle();
          }
          await this.audioPreviewScheduler.waitForIdle();
          this.diagnostics.log('shutdown.graph-drained', { session_id: this.sessionId });
        }
      } finally {
        this.clearPipelineStallDetection();
        this.audioPreviewScheduler.stop();
        await this.graph?.close();
        this.diagnostics.log('shutdown.queue-drain-completed', { session_id: this.sessionId, ...this.audioQueueDiagnostics() });
      }
    })();
    return this.shutdownPromise;
  }

  async bootstrap() {
    await this.loadLatestSession();
    const projections = [this.ui('ui.session-status', this.sessionProjection()), ...this.transcript.map((row) => this.ui('ui.transcript-row', row)), ...this.loggedItems.map((row) => this.ui('ui.logged-item-row', row)), ...this.capabilityProjections()];
    return { projections, new_session: !this.metadata };
  }

  capabilitySnapshot() { return this.capabilityProjections().map((message) => message.payload); }

  reportCaptureFailure(message) {
    this.captureActive = false;
    this.diagnostics.log('capture.failure', { session_id: this.sessionId, error: String(message || 'Physical microphone capture failed.'), ...this.audioQueueDiagnostics() });
    this.updateAudioProcessing();
    this.setCapability('microphone', 'unavailable', `Physical microphone capture failed: ${message}`, true);
    return { accepted: true };
  }

  reportCaptureDiagnostic(payload = {}) {
    const event = typeof payload.event === 'string' && payload.event ? payload.event : 'capture.renderer-diagnostic';
    if (event === 'capture.active') this.captureActive = true;
    if (event === 'capture.stopped' || event === 'capture.failure' || event === 'capture.renderer-failure' || event === 'capture.start-failed' || event === 'capture.backpressure') this.captureActive = false;
    this.diagnostics.log(event, { ...payload, capture_active: this.captureActive, ...this.audioQueueDiagnostics() });
    if (event === 'capture.active' || event.startsWith('capture.')) this.updateAudioProcessing();
    return { accepted: true };
  }

  async acceptAudioChunk(chunk) {
    if (this.shuttingDown || this.graph?.closed) {
      this.diagnostics.log('capture.chunk-ignored', { session_id: chunk?.session_id, reason: 'shutdown' });
      return this.ignoredAudioResult(chunk?.session_id);
    }
    if (!this.graph || this.metadata?.state !== 'recording') {
      this.diagnostics.log('capture.chunk-rejected', { session_id: chunk?.session_id, reason: 'session-not-recording' });
      throw new Error('Audio is accepted only while the governed session is recording');
    }
    if (chunk?.session_id !== this.sessionId) {
      this.diagnostics.log('capture.chunk-rejected', { session_id: chunk?.session_id, reason: 'session-not-found' });
      throw Object.assign(new Error(`Unknown active session ${chunk?.session_id}`), { code: 'SESSION_NOT_FOUND' });
    }
    if (this.audioProcessingError) throw this.audioProcessingError;
    this.prepareAudioIdentitySession(chunk.session_id);
    const sourceIdentity = audioChunkSourceIdentity(chunk);
    const knownIdentity = this.audioChunkIdentities.get(sourceIdentity);
    if (knownIdentity) {
      this.diagnostics.log('capture.chunk-duplicate', { session_id: chunk.session_id, sequence: knownIdentity.sequence, chunk_id: knownIdentity.chunk_id });
      return { accepted: true, duplicate: true, sequence: knownIdentity.sequence };
    }
    if (this.audioQueuedChunkCount + this.audioCurrentUtterance.length >= MAX_AUDIO_QUEUE_ITEMS) {
      this.diagnostics.log('capture.chunk-rejected', { session_id: chunk.session_id, sequence: chunk.sequence, reason: 'backpressure' });
      throw this.audioBackpressure('Audio processing queue is full; capture must pause briefly.');
    }
    this.audioProcessingOverride = undefined;
    this.audioProcessingNotice = undefined;
    const snapshot = this.canonicalAudioChunk(chunk);
    if (this.audioCurrentUtterance.length >= MAX_UTTERANCE_CHUNKS) {
      this.diagnostics.log('audio.rollover-boundary-triggered', {
        session_id: chunk.session_id,
        utterance_id: this.audioCurrentUtteranceId,
        audio_window_id: `${chunk.session_id}-audio-window-${this.audioCurrentUtterance[0].sequence}`,
        first_sequence: this.audioCurrentUtterance[0].sequence,
        last_sequence: this.audioCurrentUtterance.at(-1).sequence,
        chunk_count: this.audioCurrentUtterance.length,
        trigger_sequence: chunk.sequence,
        reason: 'size',
        ...this.audioQueueDiagnostics({ extended: true })
      });
      this.enqueueCurrentUtterance(`${chunk.session_id}:audio.rollover:${this.audioCurrentUtterance[0].sequence}`, { reason: 'rollover' });
    }
    if (!this.audioCurrentUtteranceId) this.audioCurrentUtteranceId = `${chunk.session_id}-utterance-${randomUUID()}`;
    this.audioCurrentUtterance.push(snapshot);
    // Retain only replay identity metadata. PCM/base64 remains bounded to the
    // active/queued utterance and is released after transcription.
    this.audioChunkIdentities.set(sourceIdentity, Object.freeze({
      chunk_id: snapshot.chunk_id,
      sequence: snapshot.sequence
    }));
    this.audioNextChunkSequence += 1;
    this.audioPreviewScheduler.observe(this.audioCurrentUtteranceId);
    this.updateAudioProcessing();
    return { accepted: true, sequence: snapshot.sequence };
  }

  canonicalAudioChunk(chunk) {
    this.prepareAudioIdentitySession(chunk.session_id);
    return freezeAudioChunk({ ...chunk, chunk_id: `${chunk.session_id}-chunk-${this.audioNextChunkSequence}`, sequence: this.audioNextChunkSequence });
  }

  prepareAudioIdentitySession(sessionId) {
    if (this.audioIdentitySessionId === sessionId) return;
    this.audioIdentitySessionId = sessionId;
    this.audioNextChunkSequence = 0;
    this.audioChunkIdentities.clear();
  }

  async acceptAudioFlush(payload = {}) {
    if (this.shuttingDown || this.graph?.closed) {
      this.diagnostics.log('capture.flush-ignored', { session_id: payload.session_id, reason: 'shutdown' });
      return this.ignoredAudioResult(payload.session_id);
    }
    if (!this.graph || this.metadata?.state !== 'recording') {
      this.diagnostics.log('capture.flush-rejected', { session_id: payload.session_id, reason: 'session-not-recording' });
      throw new Error('Audio flush is accepted only while the governed session is recording');
    }
    this.diagnostics.log('audio.flush-requested', { session_id: payload.session_id, reason: payload.reason || 'flush', requested_at: payload.requested_at, ...this.audioQueueDiagnostics({ extended: true }) });
    const result = this.enqueueAudioFlush(payload.session_id, {
      session_id: payload.session_id,
      requested_at: payload.requested_at || new Date().toISOString(),
      ...(payload.reason === 'pause' ? { reason: 'pause' } : {})
    }, `${payload.session_id}:audio.flush:${randomUUID()}`);
    return result;
  }

  async dispatchAudioPreview(snapshot) {
    if (this.shuttingDown || this.graph?.closed || this.metadata?.state !== 'recording') return { accepted: false, discarded: true };
    const previewId = `${snapshot.session_id}:audio.preview:${snapshot.preview_id}`;
    try {
      const message = await this.graph.dispatchFrom('@desktop-controller', 'domain', 'audio.preview', snapshot.session_id, snapshot, previewId);
      this.markPreviewStage(snapshot.utterance_id, 'audio.preview.dispatch-completed');
      this.diagnostics.log('audio.preview-dispatch-completed', { session_id: snapshot.session_id, utterance_id: snapshot.utterance_id, preview_id: snapshot.preview_id, revision: snapshot.revision, input_message_id: message.message_id });
      return message;
    } catch (error) {
      this.diagnostics.log('audio.preview-dispatch-failed', { session_id: snapshot.session_id, utterance_id: snapshot.utterance_id, preview_id: snapshot.preview_id, revision: snapshot.revision, error_code: error.code, error: error.message });
      throw error;
    }
  }

  async handleCommand(rawPayload) {
    let command;
    try { command = this.boundary.assertCommand(rawPayload); }
    catch (error) { return this.emitCommandResult(rawPayload, this.rejected(rawPayload, 'INVALID_COMMAND', error.message, 'ui/command')); }
    const payload = command.payload;
    const known = this.commandResults.get(payload.command_id);
    if (known) return known;
    try {
      const result = await this.executeCommand(payload);
      return this.emitCommandResult(payload, result);
    } catch (error) {
      return this.emitCommandResult(payload, this.rejected(payload, error.code || 'COMMAND_FAILED', error.message, ownerFor(payload.command), Boolean(error.retryable)));
    }
  }

  async executeCommand(payload) {
    if (payload.session_id !== this.sessionId) throw Object.assign(new Error(`Unknown active session ${payload.session_id}`), { code: 'SESSION_NOT_FOUND' });
    switch (payload.command) {
      case 'session.new': return this.newSessionCommand(payload);
      case 'session.record':
      case 'session.stop':
      case 'session.resume':
      case 'session.close': return this.sessionCommand(payload);
      case 'transcript.edit':
        await this.graph.dispatchFrom('@desktop-controller', 'domain', 'transcript.segment-update', payload.session_id, { segment_id: payload.segment_id, session_id: payload.session_id, expected_revision: payload.expected_revision, text: payload.text, updated_at: new Date().toISOString(), editor: 'user' }, payload.command_id);
        return this.accepted(payload, 'transcript/active-state', payload.segment_id, payload.expected_revision + 1, 'Transcript revision accepted by the active owner.');
      case 'logged-item.edit':
        await this.graph.dispatchFrom('@desktop-controller', 'domain', 'logged-item.update', payload.session_id, { item_id: payload.item_id, session_id: payload.session_id, expected_revision: payload.expected_revision, text: payload.text, updated_at: new Date().toISOString(), editor: 'user' }, payload.command_id);
        return this.accepted(payload, 'logged-items/active-owner', payload.item_id, payload.expected_revision + 1, 'Logged-item revision accepted by the active owner.');
      case 'copy': return this.copyCommand(payload);
      case 'copy-session-path': return this.copySessionPath(payload);
      case 'open-folder': return this.openFolder(payload);
      default: throw Object.assign(new Error(`Unsupported UI command ${payload.command}.`), { code: 'UNSUPPORTED_COMMAND' });
    }
  }

  async sessionCommand(payload, { allowFlushFailure = false } = {}) {
    if ((payload.command === 'session.stop' || payload.command === 'session.close') && this.metadata?.state === 'recording') {
      this.diagnostics.log('shutdown.session-drain-beginning', { session_id: payload.session_id, command: payload.command, ...this.audioQueueDiagnostics() });
      const finalizationAlreadyFailed = this.audioProcessingError?.code?.startsWith('FINALIZATION_');
      try {
        this.enqueueAudioFlush(payload.session_id, { session_id: payload.session_id, requested_at: new Date().toISOString() }, `${payload.command_id}:audio-flush`, { allowShutdown: true });
        await this.waitForAudioIdle();
        await this.graph.waitForIdle();
        this.diagnostics.log('shutdown.session-drain-completed', { session_id: payload.session_id, command: payload.command, ...this.audioQueueDiagnostics() });
      } catch (error) {
        this.diagnostics.log('shutdown.session-drain-failed', { session_id: payload.session_id, command: payload.command, error: error.message, ...this.audioQueueDiagnostics() });
        if (!allowFlushFailure && !finalizationAlreadyFailed) throw error;
        this.setCapability('stt', 'unavailable', `Final audio flush failed during shutdown: ${error.message}`, false);
      }
    }
    const output = await this.graph.dispatchFrom('@desktop-controller', 'control', payload.command, payload.session_id, { operation_id: payload.command_id, session_id: payload.session_id, requested_at: new Date().toISOString() }, payload.command_id);
    await this.graph.waitForIdle();
    await this.loadLatestSession(payload.session_id);
    this.emit('ui.session-status', this.sessionProjection());
    const state = this.metadata?.state || (payload.command === 'session.record' ? 'recording' : 'stopped');
    return this.accepted(payload, 'runtime/session-lifecycle', payload.session_id, this.metadata?.revision, `${payload.command} accepted by the session lifecycle owner (${state}).`);
  }

  async newSessionCommand(payload) {
    if (this.metadata && this.metadata.state !== 'closed') throw Object.assign(new Error('New Session is available only after the current session is closed.'), { code: 'SESSION_NOT_CLOSED' });
    const sessionId = `session-${randomUUID()}`;
    await this.graph.dispatchFrom('@desktop-controller', 'control', 'session.record', sessionId, {
      operation_id: payload.command_id,
      session_id: sessionId,
      requested_at: new Date().toISOString()
    }, payload.command_id);
    const recoveredDelivery = await this.graph.recoverDeliveryForNewSession?.({ currentSessionId: payload.session_id, nextSessionId: sessionId });
    await this.loadLatestSession(sessionId);
    this.transcript = [];
    this.loggedItems = [];
    if (recoveredDelivery || this.audioProcessingError?.code?.startsWith('FINALIZATION_')) {
      this.audioProcessingError = undefined;
      this.audioProcessingOverride = undefined;
      this.audioProcessingNotice = undefined;
      this.audioIdentitySessionId = undefined;
      this.audioNextChunkSequence = 0;
      this.audioChunkIdentities.clear();
      this.setCapability('stt', 'available', 'Whisper finalization is ready for the new session.', false);
      this.setCapability('transcript', 'available', 'Finalized transcript is ready for the new session.', false);
    }
    this.transcriptPartials.clear();
    this.transcriptBoundaries.clear();
    this.clearPipelineStallDetection();
    this.emit('ui.session-status', this.sessionProjection());
    return this.accepted({ ...payload, session_id: sessionId }, 'runtime/session-lifecycle', sessionId, this.metadata?.revision, 'New Session accepted by the session lifecycle owner.');
  }

  async dispatchAudioFlush(sessionId, payload, idempotencyKey) {
    return this.enqueueAudioFlush(sessionId, payload, idempotencyKey, { allowShutdown: true });
  }

  async waitForAudioIdle() {
    if (this.audioInFlight === 0 && !this.audioWorkerPromise) return;
    await new Promise((resolve) => this.audioIdleWaiters.add(resolve));
  }

  resolveAudioIdleWaiters() {
    if (this.audioInFlight !== 0 || this.audioWorkerPromise) return;
    for (const resolve of this.audioIdleWaiters) resolve();
    this.audioIdleWaiters.clear();
  }

  enqueueAudioFlush(sessionId, payload, idempotencyKey, { allowShutdown = false } = {}) {
    if (sessionId !== this.sessionId) {
      this.diagnostics.log('capture.flush-rejected', { session_id: sessionId, reason: 'session-not-found' });
      throw Object.assign(new Error(`Unknown active session ${sessionId}`), { code: 'SESSION_NOT_FOUND' });
    }
    if (this.shuttingDown && !allowShutdown) return this.ignoredAudioResult(sessionId);
    if (this.audioProcessingError) throw this.audioProcessingError;
    if (!this.audioCurrentUtterance.length) {
      this.diagnostics.log('audio.flush-completed-empty', { session_id: sessionId, flush_id: idempotencyKey, reason: payload.reason || 'flush', ...this.audioQueueDiagnostics({ extended: true }) });
      return { accepted: true, session_id: sessionId, queued: false };
    }
    this.audioProcessingOverride = undefined;
    this.audioProcessingNotice = undefined;
    const queued = this.enqueueCurrentUtterance(idempotencyKey, payload);
    return { accepted: true, session_id: sessionId, queued, ...(queued ? { queue_depth: this.audioQueuedUtterances } : {}) };
  }

  enqueueCurrentUtterance(idempotencyKey, payload = {}) {
    if (!this.audioCurrentUtterance.length) return false;
    if (this.audioQueuedChunkCount + this.audioCurrentUtterance.length > MAX_AUDIO_QUEUE_ITEMS || this.audioQueuedUtterances >= MAX_AUDIO_UTTERANCES) throw this.audioBackpressure('Audio utterance queue is full; capture must pause briefly.');
    const firstChunk = this.audioCurrentUtterance[0];
    const lastChunk = this.audioCurrentUtterance.at(-1);
    const utteranceId = this.audioCurrentUtteranceId || `${this.sessionId}-utterance-${firstChunk.sequence}`;
    this.audioPreviewScheduler.finalize(utteranceId);
    const utterance = Object.freeze({
      session_id: this.sessionId,
      utterance_id: utteranceId,
      audio_window_id: `${this.sessionId}-audio-window-${firstChunk.sequence}`,
      chunks: Object.freeze(this.audioCurrentUtterance.slice()),
      requested_at: payload.requested_at || new Date().toISOString(),
      ...(payload.reason ? { reason: payload.reason } : {})
    });
    this.audioCurrentUtterance = [];
    this.audioCurrentUtteranceId = undefined;
    this.audioQueuedUtterances += 1;
    this.audioQueuedChunkCount += utterance.chunks.length;
    this.diagnostics.log('audio-window.queued', {
      session_id: utterance.session_id,
      audio_window_id: utterance.audio_window_id,
      first_sequence: firstChunk.sequence,
      last_sequence: lastChunk.sequence,
      chunk_count: utterance.chunks.length,
      duration_ms: audioDurationMs(utterance.chunks),
      reason: payload.reason || 'flush',
      ...this.audioQueueDiagnostics({ extended: true }),
      queued_window_count: this.audioUtteranceQueue.length + 1,
      queued_chunk_count: this.audioQueuedChunkCount,
      audio_in_flight: this.audioInFlight + 1
    });
    this.enqueueAudioWork({ utterance, idempotencyKey });
    return true;
  }

  enqueueAudioWork(work) {
    this.audioUtteranceQueue.push(work);
    this.audioInFlight += 1;
    this.diagnostics.log('audio.utterance-entered-host-fifo', {
      ...audioWorkDiagnostics(work),
      fifo_position: this.audioUtteranceQueue.length,
      ...this.audioQueueDiagnostics({ extended: true })
    });
    this.diagnostics.log('audio-queue.snapshot', { session_id: this.sessionId, ...this.audioQueueDiagnostics() });
    this.updateAudioProcessing();
    this.enqueueAudioWorkWorker();
  }

  enqueueAudioWorkWorker() {
    if (this.audioWorkerPromise || !this.audioUtteranceQueue.length || this.audioProcessingError) return;
    const worker = {
      worker_generation: ++this.audioWorkerGeneration,
      worker_invocation_id: `${this.sessionId}:audio-worker-${this.audioWorkerGeneration}`
    };
    this.audioWorkerInvocation = worker;
    this.diagnostics.log('audio.worker-started', { session_id: this.sessionId, ...worker, ...this.audioQueueDiagnostics({ extended: true }) });
    this.audioWorkerPromise = this.processAudioQueue(worker).finally(() => {
      const queued = this.audioUtteranceQueue.length;
      this.audioWorkerPromise = undefined;
      this.audioWorkerInvocation = undefined;
      this.diagnostics.log('audio.worker-finished', { session_id: this.sessionId, ...worker, ...this.audioQueueDiagnostics({ extended: true }) });
      if (queued && !this.audioProcessingError) {
        this.diagnostics.log('audio.worker-rekick', { session_id: this.sessionId, ...worker, queued_utterance_count: queued, ...this.audioQueueDiagnostics({ extended: true }) });
        this.enqueueAudioWorkWorker();
      }
      this.resolveAudioIdleWaiters();
    });
  }

  async processAudioQueue(worker) {
    while (this.audioUtteranceQueue.length) {
      const work = this.audioUtteranceQueue.shift();
      let queueAccountingCleared = false;
      let terminalOutcome = 'unknown';
      let terminalError;
      try {
        this.audioQueuedUtterances -= 1;
        this.audioPreparingUtterance = work;
        this.diagnostics.log('audio-window.transcription-started', {
          ...worker,
          ...audioWorkDiagnostics(work),
          ...this.audioQueueDiagnostics({ extended: true })
        });
        this.diagnostics.log('audio-window.dispatch-beginning', {
          ...worker,
          ...audioWorkDiagnostics(work),
          ...this.audioQueueDiagnostics({ extended: true })
        });
        this.updateAudioProcessing();
        for (const chunk of work.utterance.chunks) {
          await this.graph.dispatchFrom('@desktop-controller', 'domain', 'audio.chunk', chunk.session_id, chunk, `${chunk.session_id}:audio.chunk:${chunk.sequence}`);
        }
        this.audioPreparingUtterance = undefined;
        this.audioActiveFlush = work;
        this.updateAudioProcessing();
        this.diagnostics.log('audio.flush-dispatch-beginning', {
          ...worker,
          ...audioWorkDiagnostics(work),
          flush_id: work.idempotencyKey,
          ...this.audioQueueDiagnostics({ extended: true })
        });
        const flushMessage = await this.graph.dispatchFrom('@desktop-controller', 'domain', 'audio.flush', work.utterance.session_id, {
          session_id: work.utterance.session_id,
          requested_at: work.utterance.requested_at,
          utterance_id: work.utterance.utterance_id,
          ...(work.utterance.reason === 'pause' ? { reason: 'pause' } : work.utterance.reason === 'rollover' ? { reason: 'size' } : {})
        }, work.idempotencyKey);
        this.diagnostics.log('audio.flush-dispatch-completed', {
          ...worker,
          ...audioWorkDiagnostics(work),
          flush_id: work.idempotencyKey,
          input_message_id: flushMessage?.message_id,
          ...this.audioQueueDiagnostics({ extended: true })
        });
        this.diagnostics.log('audio-window.transcription-completed', {
          ...worker,
          ...audioWorkDiagnostics(work),
          ...this.audioQueueDiagnostics({ extended: true })
        });
        terminalOutcome = 'completed';
      } catch (error) {
        terminalOutcome = 'failed';
        terminalError = error;
        this.failAudioProcessing(error);
        this.clearAudioQueue(error);
        queueAccountingCleared = true;
      } finally {
        this.audioPreparingUtterance = undefined;
        this.audioActiveFlush = undefined;
        if (!queueAccountingCleared) this.audioQueuedChunkCount -= work.utterance.chunks.length;
        this.audioInFlight -= 1;
        this.diagnostics.log('audio.queue-state-after-terminal-outcome', {
          ...worker,
          ...audioWorkDiagnostics(work),
          outcome: terminalOutcome,
          error_code: terminalError?.code,
          retryable: terminalError?.retryable,
          ...this.audioQueueDiagnostics({ extended: true })
        });
        this.diagnostics.log('audio-queue.snapshot', { session_id: this.sessionId, ...this.audioQueueDiagnostics() });
        this.updateAudioProcessing();
      }
      if (this.audioProcessingError) break;
    }
  }

  failAudioProcessing(error, { retryable = error.retryable ?? true } = {}) {
    this.audioProcessingError = Object.assign(error, { retryable });
    this.diagnostics.log('audio.processing-failed', { session_id: this.sessionId, error: error.message, error_code: error.code, retryable, ...this.audioQueueDiagnostics() });
    this.setCapability('stt', 'unavailable', `Audio processing failed: ${error.message}`, retryable);
    this.setCapability('transcript', 'unavailable', `Finalized transcript unavailable: ${error.message}`, retryable);
    this.updateAudioProcessing();
  }

  failFinalization({ code = 'FINALIZATION_FAILED', message = 'Finalized transcript processing failed.', retryable = false, expected, received, service = 'active-transcript' } = {}) {
    if (this.audioProcessingError?.code === `FINALIZATION_${code}`) return;
    const error = Object.assign(new Error(`Finalized transcript failed in ${service}: ${message}`), {
      code: `FINALIZATION_${code}`,
      retryable,
      expected,
      received
    });
    this.diagnostics.log('transcript.finalization-failed', {
      session_id: this.sessionId,
      service,
      error_code: code,
      error: message,
      retryable,
      expected,
      received,
      ...this.audioQueueDiagnostics()
    });
    this.failAudioProcessing(error, { retryable });
    this.audioProcessingOverride = { state: 'error', detail: `${error.message} Stop recording and start a new session.` };
    this.updateAudioProcessing('error', this.audioProcessingOverride.detail);
  }

  audioBackpressure(message) {
    const error = Object.assign(new Error(message), { code: 'AUDIO_BACKPRESSURE', retryable: true });
    this.audioProcessingOverride = { state: 'delayed', detail: message };
    this.diagnostics.log('audio.backpressure', { session_id: this.sessionId, error: message, ...this.audioQueueDiagnostics() });
    this.updateAudioProcessing('delayed', message);
    return error;
  }

  clearAudioQueue(error) {
    try {
      const droppedWindowCount = this.audioUtteranceQueue.length;
      const droppedChunkCount = this.audioUtteranceQueue.reduce((sum, work) => sum + work.utterance.chunks.length, 0);
      this.audioInFlight -= droppedWindowCount;
      this.audioUtteranceQueue.length = 0;
      this.audioQueuedUtterances = 0;
      this.audioQueuedChunkCount = 0;
      this.audioCurrentUtterance = [];
      this.audioPreviewScheduler.finalize(this.audioCurrentUtteranceId);
      this.audioCurrentUtteranceId = undefined;
      this.diagnostics.log('audio.queue-cleared', { session_id: this.sessionId, dropped_window_count: droppedWindowCount, dropped_chunk_count: droppedChunkCount, error: error?.message, ...this.audioQueueDiagnostics() });
    } catch (clearError) {
      this.diagnostics.log('audio.queue-clearing-failed', { session_id: this.sessionId, error: clearError.message, original_error: error?.message, ...this.audioQueueDiagnostics() });
    }
  }

  updateAudioProcessing(forcedState, detail) {
    const next = this.audioProcessingSnapshot(forcedState, detail);
    const changed = JSON.stringify(this.audioProcessingLast) !== JSON.stringify(next);
    this.audioProcessingLast = next;
    if (changed && this.started) this.emit('ui.session-status', this.sessionProjection());
  }

  audioProcessingSnapshot(forcedState, detail) {
    const queueDepth = this.audioQueuedUtterances;
    const transcriptionState = forcedState || this.audioProcessingOverride?.state || (this.audioProcessingError ? 'error' : this.audioActiveFlush || this.audioPreparingUtterance ? 'transcribing' : queueDepth ? (queueDepth >= DELAYED_AUDIO_UTTERANCES ? 'delayed' : 'queued') : 'idle');
    const captureState = this.captureActive && this.metadata?.state === 'recording' && !this.shuttingDown ? 'listening' : 'idle';
    return {
      state: transcriptionState === 'idle' ? 'listening' : transcriptionState,
      queue_depth: queueDepth,
      capture_state: captureState,
      transcription_state: transcriptionState,
      ...(detail || this.audioProcessingOverride?.detail || this.audioProcessingError?.message || this.audioProcessingNotice ? { detail: detail || this.audioProcessingOverride?.detail || this.audioProcessingError?.message || this.audioProcessingNotice } : {})
    };
  }

  audioQueueDiagnostics({ extended = false } = {}) {
    const active = this.audioActiveFlush || this.audioPreparingUtterance;
    const base = {
      capturing_chunk_count: this.audioCurrentUtterance.length,
      queued_window_count: this.audioUtteranceQueue.length,
      queued_chunk_count: this.audioQueuedChunkCount,
      active_window_id: active?.utterance.audio_window_id,
      active_chunk_count: active?.utterance.chunks.length || 0,
      audio_in_flight: this.audioInFlight
    };
    return extended ? {
      ...base,
      queued_utterance_count: this.audioQueuedUtterances,
      active_utterance_id: active?.utterance.utterance_id,
      active_worker_state: this.audioWorkerState(),
      worker_generation: this.audioWorkerInvocation?.worker_generation,
      worker_invocation_id: this.audioWorkerInvocation?.worker_invocation_id
    } : base;
  }

  audioPreviewSnapshot(utteranceId, revision) {
    if (!utteranceId || utteranceId !== this.audioCurrentUtteranceId || !this.audioCurrentUtterance.length) return undefined;
    const chunks = Object.freeze(this.audioCurrentUtterance.slice());
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.audio_base64, 'base64')));
    this.observePreviewRevision({
      session_id: this.sessionId,
      utterance_id: utteranceId,
      revision,
      preview_id: `${utteranceId}-preview-${revision}`,
      first_sequence: chunks[0].sequence,
      last_sequence: chunks.at(-1).sequence,
      chunk_count: chunks.length
    });
    return Object.freeze({
      preview_id: `${utteranceId}-preview-${revision}`,
      session_id: this.sessionId,
      utterance_id: utteranceId,
      revision,
      requested_at: new Date().toISOString(),
      start_time: chunks[0].start_time,
      end_time: chunks.at(-1).end_time,
      sample_count: bytes.byteLength / 2,
      byte_length: bytes.byteLength,
      pcm_base64: bytes.toString('base64'),
      checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      covered_chunk_ids: chunks.map((chunk) => chunk.chunk_id)
    });
  }

  audioWorkerState() {
    if (!this.audioWorkerPromise) return this.audioWorkerInvocation ? 'starting' : 'idle';
    if (this.audioActiveFlush) return 'flushing';
    if (this.audioPreparingUtterance) return 'dispatching';
    return 'running';
  }

  observePreviewRevision(preview) {
    if (!this.diagnostics.enabled) return;
    const existing = this.pipelinePreviewProgress.get(preview.utterance_id);
    if (existing && preview.revision <= existing.latest_revision) return;
    const progress = existing || {
      session_id: preview.session_id,
      utterance_id: preview.utterance_id,
      first_revision: preview.revision,
      first_observed_at: Date.now(),
      warning_emitted: false,
      last_successfully_completed_stage: 'capture.audio-window'
    };
    progress.latest_revision = preview.revision;
    progress.latest_preview_id = preview.preview_id;
    progress.latest_observed_at = Date.now();
    progress.last_successfully_completed_stage = 'audio.preview.dispatch-beginning';
    this.pipelinePreviewProgress.set(preview.utterance_id, progress);
    this.diagnostics.log('pipeline.preview-revision-advanced', {
      session_id: preview.session_id,
      utterance_id: preview.utterance_id,
      preview_id: preview.preview_id,
      preview_revision: preview.revision,
      first_sequence: preview.first_sequence,
      last_sequence: preview.last_sequence,
      chunk_count: preview.chunk_count
    });
    if (!this.pipelineStallTimers.has(preview.utterance_id)) {
      const timer = setTimeout(() => this.emitPossiblePipelineStall(preview.utterance_id), this.diagnosticStallThresholdMs);
      timer.unref?.();
      this.pipelineStallTimers.set(preview.utterance_id, timer);
    }
  }

  markPreviewStage(utteranceId, stage) {
    const progress = this.pipelinePreviewProgress.get(utteranceId);
    if (progress) progress.last_successfully_completed_stage = stage;
  }

  emitPossiblePipelineStall(utteranceId) {
    const progress = this.pipelinePreviewProgress.get(utteranceId);
    if (!progress || progress.warning_emitted) return;
    progress.warning_emitted = true;
    this.diagnostics.log('pipeline.possible-stall', {
      session_id: progress.session_id,
      utterance_id: progress.utterance_id,
      preview_revision: progress.latest_revision,
      preview_id: progress.latest_preview_id,
      elapsed_ms: Math.max(0, Date.now() - progress.first_observed_at),
      last_successfully_completed_stage: progress.last_successfully_completed_stage,
      ...this.audioQueueDiagnostics({ extended: true })
    });
  }

  clearPipelineStall(utteranceId) {
    if (!utteranceId) return;
    const timer = this.pipelineStallTimers.get(utteranceId);
    if (timer) clearTimeout(timer);
    this.pipelineStallTimers.delete(utteranceId);
    this.pipelinePreviewProgress.delete(utteranceId);
  }

  clearPipelineStallDetection() {
    for (const timer of this.pipelineStallTimers.values()) clearTimeout(timer);
    this.pipelineStallTimers.clear();
    this.pipelinePreviewProgress.clear();
  }

  ignoredAudioResult(sessionId) { return { accepted: false, ignored: true, code: 'SHUTDOWN_IN_PROGRESS', session_id: sessionId, reason: 'Application shutdown is in progress.' }; }

  async copyCommand(payload) {
    const { transcriptSegments, loggedItems } = await this.storageProjections();
    const values = payload.kind === 'transcript' ? transcriptSegments.filter((item) => payload.item_ids.includes(item.segment_id)) : loggedItems.filter((item) => payload.item_ids.includes(item.item_id));
    const text = values.map((item) => `${payload.include_timestamps ? `[${item.start_time || item.stored_at}] ` : ''}${item.text}`).join('\n');
    const receipt = await this.capabilities.clipboard.write(text);
    return this.accepted(payload, 'platform/clipboard', undefined, undefined, receipt.message);
  }

  async copySessionPath(payload) {
    const folder = this.storage.paths(payload.session_id).session;
    const receipt = await this.capabilities.clipboard.write(folder);
    return this.accepted(payload, 'platform/clipboard', undefined, undefined, receipt.message);
  }

  async openFolder(payload) { return this.accepted(payload, 'platform/folder', undefined, undefined, (await this.capabilities.folder.open(payload.session_id)).message); }

  async storageProjections(sessionId = this.sessionId) {
    const [transcript, logged] = await Promise.all([this.storage.readActiveSnapshot(sessionId, 'transcript'), this.storage.readActiveSnapshot(sessionId, 'logged-item')]);
    return { transcriptSegments: transcript?.segments || [], loggedItems: logged?.items || [] };
  }

  async loadLatestSession(preferredSessionId) {
    const selected = preferredSessionId || process.env.ARGUS_SESSION_ID;
    const entries = await readdir(this.sessionRoot, { withFileTypes: true }).catch(() => []);
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const metadata = await this.storage.readMetadata(entry.name).catch(() => undefined);
      if (metadata) sessions.push(metadata);
    }
    const metadata = selected ? sessions.find((item) => item.session_id === selected) : sessions.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
    if (metadata) this.sessionId = metadata.session_id;
    this.metadata = metadata;
    if (metadata) {
      const active = await this.storageProjections(metadata.session_id);
      this.transcript = active.transcriptSegments.map((item) => this.transcriptRow(item));
      this.loggedItems = active.loggedItems.map((item) => this.loggedItemRow(item));
    } else { this.transcript = []; this.loggedItems = []; }
  }

  async recoverUncleanRecordings() {
    const entries = await readdir(this.sessionRoot, { withFileTypes: true }).catch(() => []);
    const recordings = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const metadata = await this.storage.readMetadata(entry.name).catch(() => undefined);
      if (metadata?.state === 'recording') recordings.push(metadata.session_id);
    }
    for (const sessionId of recordings) {
      await this.graph.dispatchFrom('@desktop-controller', 'control', 'session.stop', sessionId, {
        operation_id: `startup-recovery-${sessionId}-${randomUUID()}`,
        session_id: sessionId,
        requested_at: new Date().toISOString()
      }, `startup-recovery:${sessionId}:${randomUUID()}`);
    }
    if (recordings.length) await this.graph.waitForIdle();
  }

  sessionProjection() {
    const metadata = this.metadata;
    const state = metadata?.state || 'stopped';
    const createdAt = metadata?.created_at || new Date().toISOString();
    const elapsedMs = calculateRecordingDurationMs(metadata, Date.now());
    const duration = Math.max(0, Math.floor(elapsedMs / 1000));
    const elapsed = duration;
    return { session_id: this.sessionId, state, elapsed_seconds: elapsed, created_at: createdAt, duration_seconds: duration, transcript_count: this.transcript.length, logged_item_count: this.loggedItems.length, audio_processing: this.audioProcessingSnapshot() };
  }

  handleGraphMessage(message) {
    if (!message || this.seenMessages.has(message.message_id)) return;
    this.seenMessages.add(message.message_id);
    const payload = message.payload || {};
    if (message.message_type === 'transcript.empty') {
      const partial = this.transcriptPartials.get(payload.utterance_id);
      if (partial) {
        const projection = this.emit('ui.transcript-row', {
          session_id: partial.session_id,
          utterance_id: partial.utterance_id,
          segment_id: `${partial.session_id}-live`,
          revision: partial.revision + 1,
          sequence: 0,
          start_time: partial.start_time,
          end_time: partial.end_time,
          text: partial.text,
          provisional: true,
          read_only: true,
          dismissed: true,
          review_flags: []
        });
        this.diagnostics.log('ui.transcript-row-projected', { session_id: partial.session_id, utterance_id: partial.utterance_id, projection_id: projection.message_id, segment_id: `${partial.session_id}-live`, revision: partial.revision + 1, provisional: true, dismissed: true });
      }
      this.transcriptPartials.delete(payload.utterance_id);
      this.transcriptBoundaries.delete(payload.utterance_id);
      this.audioProcessingNotice = 'No speech recognized; still listening';
      this.clearPipelineStall(payload.utterance_id);
      this.diagnostics.log('whisper.empty-observed', { session_id: payload.session_id, utterance_id: payload.utterance_id, audio_window_id: payload.audio_window_id, reason: payload.reason, segment_count: payload.segment_count, word_count: payload.word_count, terminal_outcome: 'empty' });
      this.updateAudioProcessing();
      return;
    }
    if (message.message_type === 'transcript.partial') {
      const partial = payload;
      this.transcriptPartials.set(partial.utterance_id, partial);
      this.observePreviewRevision({ session_id: partial.session_id, utterance_id: partial.utterance_id, revision: partial.revision, preview_id: partial.projection_id });
      this.markPreviewStage(partial.utterance_id, 'whisper.preview');
      const projection = this.emit('ui.transcript-row', { session_id: partial.session_id, utterance_id: partial.utterance_id, segment_id: `${partial.session_id}-live`, revision: partial.revision, sequence: 0, start_time: partial.start_time, end_time: partial.end_time, text: partial.text, provisional: true, read_only: true, review_flags: [] });
      this.diagnostics.log('ui.transcript-row-projected', { session_id: partial.session_id, utterance_id: partial.utterance_id, projection_id: projection.message_id, segment_id: `${partial.session_id}-live`, revision: partial.revision, provisional: true });
      return;
    }
    if (message.message_type === 'transcript.utterance-boundary') {
      this.transcriptBoundaries.set(payload.utterance_id, payload);
      this.markPreviewStage(payload.utterance_id, 'transcript.utterance-boundary');
      this.diagnostics.log('transcript.utterance-boundary-received', { session_id: payload.session_id, utterance_id: payload.utterance_id, boundary_id: payload.boundary_id, first_word_sequence: payload.first_word_sequence, last_word_sequence: payload.last_word_sequence, reason: payload.reason });
      return;
    }
    if (message.message_type === 'transcript.segment') {
      const utteranceId = this.correlateTranscriptSegment(payload);
      this.clearPipelineStall(utteranceId);
      this.diagnostics.log('transcript.segment-received', { session_id: payload.session_id, utterance_id: utteranceId, segment_id: payload.segment_id, sequence: payload.sequence, boundary: payload.boundary, transcript_preview: payload.text });
      const projection = this.emit('ui.transcript-row', this.transcriptRow(payload, utteranceId));
      this.diagnostics.log('ui.transcript-row-projected', { session_id: payload.session_id, utterance_id: utteranceId, projection_id: projection.message_id, segment_id: payload.segment_id, revision: payload.revision || 0, provisional: false });
      if (utteranceId) {
        this.transcriptPartials.delete(utteranceId);
        this.transcriptBoundaries.delete(utteranceId);
      }
      return;
    }
    if (message.message_type === 'transcript.history-appended') {
      this.diagnostics.log('transcript.history-appended', { session_id: payload.session_id, history_entry_id: payload.history_entry_id, segment_id: payload.segment_id, revision: payload.segment_revision });
      return;
    }
    if (message.message_type === 'logged-item.stored') { this.emit('ui.logged-item-row', this.loggedItemRow(payload)); return; }
    if (message.message_type === 'session.recorded' || message.message_type === 'session.stopped' || message.message_type === 'session.resumed' || message.message_type === 'session.closed') {
      this.loadLatestSession(message.payload?.session_id).then(() => this.emit('ui.session-status', this.sessionProjection())).catch(() => {});
      return;
    }
    if (message.message_type === 'service.failure') {
      const service = message.payload.service || '';
      this.diagnostics.log('service.failure', { session_id: message.correlation_id, correlation_id: message.correlation_id, service, operation: message.payload.operation, input_message_id: message.payload.input_message_id, error_code: message.payload.error?.code, retryable: message.payload.error?.retryable, error: message.payload.error?.message });
      this.clearPipelineStallDetection();
      if (isFinalizationService(service) || message.payload.error?.code === 'SEQUENCE_GAP' || message.payload.error?.code === 'DELIVERY_BACKLOG_FULL') {
        this.failFinalization({
          code: message.payload.error?.code,
          message: message.payload.error?.message,
          retryable: false,
          expected: message.payload.error?.details?.expected,
          received: message.payload.error?.details?.received,
          service: service || 'active-transcript'
        });
      }
      if (service.includes('speech') || service.includes('stt')) this.setCapability('stt', 'unavailable', message.payload.error?.message || 'The real Whisper transcription dependency failed.', true);
      if (service.includes('model')) this.setCapability('model', 'unavailable', message.payload.error?.message || 'The configured local model dependency failed.', true);
    }
  }

  handleGraphStatus(status) {
    const event = status.type === 'service-failure' ? 'service.failure' : status.type === 'service-exit' ? 'graph.service-exited' : status.type === 'graph-failure' ? 'graph.failure' : status.type === 'operation-rejected' ? 'operation.rejected' : undefined;
    if (event) this.diagnostics.log(event, { session_id: status.correlation_id || this.sessionId, correlation_id: status.correlation_id || this.sessionId, service: status.service, operation: status.operation, input_message_id: status.input_message_id, code: status.code, retryable: status.retryable, error: status.message, pid: status.pid, signal: status.signal, expected: status.expected });
    if (status.type === 'graph-ready') this.setCapability('orchestration', 'available', 'Production Argus graph is supervised and ready.', false);
    if (status.type === 'graph-failure') this.setCapability('orchestration', 'unavailable', status.message, true);
    if (status.type === 'service-failure') {
      if (status.service === 'speech-to-text') this.setCapability('stt', 'unavailable', status.message, true);
      if (status.service === 'model-lane') this.setCapability('model', 'unavailable', status.message, true);
      if (isFinalizationService(status.service) || status.code === 'SEQUENCE_GAP' || status.code === 'DELIVERY_BACKLOG_FULL') {
        this.failFinalization({ code: status.code, message: status.message, retryable: false, expected: status.expected, received: status.received, service: status.service });
      }
    }
    if (status.type === 'operation-rejected' && isFinalizationService(status.service) && ['WORD_ID_CONFLICT', 'WORD_WINDOW_MISMATCH', 'WORD_PROVENANCE_MISMATCH'].includes(status.code)) {
      this.failFinalization({ code: status.code, message: status.message, retryable: false, service: status.service });
    }
  }

  async setInitialCapabilities() {
    await this.storage.ensureRoot();
    this.setCapability('storage-session', 'available', `Durable sessions are stored under ${this.sessionRoot}.`, false);
    this.setCapability('microphone', 'degraded', 'Physical microphone permission is requested by Electron when Record starts.', true);
    const whisperBinary = process.env.ARGUS_WHISPER_BINARY;
    const whisperModel = process.env.ARGUS_WHISPER_MODEL;
    let stt = 'unavailable', sttMessage = 'Whisper runtime/model paths are not configured; run npm run setup:real.';
    if (whisperBinary && whisperModel) {
      try { await access(whisperBinary); await access(whisperModel); stt = 'available'; sttMessage = 'Pinned whisper.cpp runtime and model are available.'; }
      catch (error) { sttMessage = `Whisper dependency unavailable: ${error.message}`; }
    }
    this.setCapability('stt', stt, sttMessage, true);
    const endpoint = String(process.env.ARGUS_MODEL_ENDPOINT || '').trim();
    const model = String(process.env.ARGUS_MODEL_NAME || '').trim();
    const modelAvailability = endpoint && model ? await probeLocalModel(endpoint, model, this.provisionedManifest?.local_model?.identity) : { status: 'unavailable', message: 'Local model endpoint/name are not configured; run npm run setup:real.' };
    this.setCapability('model', modelAvailability.status, modelAvailability.message, modelAvailability.status !== 'available');
    this.setCapability('transcript', stt, sttMessage, true);
    this.setCapability('logged-item-pipeline', modelAvailability.status === 'available' ? 'available' : 'unavailable', modelAvailability.status === 'available' ? 'Real local model extraction is available through the serial model lane.' : `Logged-item extraction is unavailable: ${modelAvailability.message}`, true);
    this.setCapability('clipboard', this.capabilities.clipboard.available ? 'available' : 'unavailable', this.capabilities.clipboard.available ? 'Clipboard is available through the Electron host.' : 'Clipboard host capability is unavailable.', true);
    this.setCapability('folder-opening', this.capabilities.folder.available ? 'available' : 'unavailable', this.capabilities.folder.available ? 'Session folders can be opened by identity.' : 'Folder opening is unavailable.', true);
    this.setCapability('orchestration', 'degraded', 'Starting supervised production graph.', true);
  }

  setCapability(capability, status, message, retryable) {
    if (!CAPABILITIES.includes(capability)) return;
    const value = { capability, status, message, retryable, updated_at: new Date().toISOString() };
    this.capabilityState.set(capability, value);
    if (this.started) this.emit('ui.service-status', value);
  }

  capabilityProjections() { return [...this.capabilityState.values()].map((value) => this.ui('ui.service-status', value)); }
  correlateTranscriptSegment(segment) {
    for (const [utteranceId, boundary] of this.transcriptBoundaries) {
      if (boundary.session_id === segment.session_id && boundary.start_time === segment.start_time && boundary.end_time === segment.end_time) return utteranceId;
    }
    for (const [utteranceId, partial] of this.transcriptPartials) {
      if (partial.session_id === segment.session_id && partial.start_time === segment.start_time && partial.end_time === segment.end_time) return utteranceId;
    }
    return undefined;
  }
  transcriptRow(item, utteranceId) { return { session_id: item.session_id, ...(utteranceId ? { utterance_id: utteranceId } : {}), segment_id: item.segment_id, revision: item.revision || 0, sequence: item.sequence, start_time: item.start_time, end_time: item.end_time, text: item.text, provisional: false, read_only: false, review_flags: item.review_flags || [] }; }
  loggedItemRow(item) { return { session_id: item.session_id, item_id: item.item_id, revision: item.revision, revision_id: item.revision_id, logged_at: item.stored_at || item.created_at, text: item.text, source: item.source, classification_suggestion: item.classification_suggestion || null }; }
  accepted(payload, owner, resourceId, revision, message) { return { command_id: payload.command_id, session_id: payload.session_id, command: payload.command, status: 'accepted', owner, ...(resourceId ? { resource_id: resourceId } : {}), ...(revision === undefined ? {} : { revision }), message }; }
  rejected(payload = {}, code, message, owner, pending = false) { return { command_id: payload.command_id || 'invalid-command', session_id: payload.session_id || this.sessionId, command: payload.command || 'unknown', status: 'rejected', owner, code, message, ...(pending ? { pending: true } : {}) }; }
  emitCommandResult(payload, result) { const message = this.emit('ui.command-result', result); this.commandResults.set(payload?.command_id, message); return message; }
  emit(type, payload) { const message = this.ui(type, payload); for (const listener of this.projectionListeners) listener(message); return message; }
  ui(type, payload) { return this.boundary.projection(type, payload, payload.session_id || this.sessionId); }
}

function ownerFor(command) { if (command === 'transcript.edit') return 'transcript/active-state'; if (command === 'logged-item.edit') return 'logged-items/active-owner'; if (command === 'copy' || command === 'copy-session-path') return 'platform/clipboard'; if (command === 'open-folder') return 'platform/folder'; if (command?.startsWith('session.')) return 'runtime/session-lifecycle'; return 'ui/command'; }

function isFinalizationService(service) { return service === 'active-transcript' || service === 'active-transcript-owner'; }

function freezeAudioChunk(chunk) {
  return Object.freeze({ ...chunk, format: Object.freeze({ ...(chunk.format || {}) }) });
}

function audioWorkDiagnostics(work) {
  const utterance = work?.utterance;
  const chunks = utterance?.chunks || [];
  return {
    session_id: utterance?.session_id,
    utterance_id: utterance?.utterance_id,
    audio_window_id: utterance?.audio_window_id,
    first_sequence: chunks[0]?.sequence,
    last_sequence: chunks.at(-1)?.sequence,
    chunk_count: chunks.length,
    duration_ms: audioDurationMs(chunks),
    reason: utterance?.reason || 'flush'
  };
}

function audioChunkSourceIdentity(chunk) {
  return createHash('sha256').update(canonicalJson({
    chunk_id: chunk?.chunk_id,
    session_id: chunk?.session_id,
    sequence: chunk?.sequence,
    start_time: chunk?.start_time,
    end_time: chunk?.end_time,
    format: chunk?.format,
    sample_count: chunk?.sample_count,
    byte_length: chunk?.byte_length,
    audio_base64: chunk?.audio_base64,
    checksum: chunk?.checksum
  })).digest('hex');
}

function audioDurationMs(chunks) {
  if (!chunks?.length) return 0;
  const clockMs = (value) => {
    const match = /^(\d+):(\d+):(\d+)\.(\d{3})$/.exec(String(value || ''));
    return match ? (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4]) : 0;
  };
  return Math.max(0, clockMs(chunks.at(-1).end_time) - clockMs(chunks[0].start_time));
}

function resolveProvisionedPath(root, absolutePath, relativePath) {
  if (relativePath) return path.resolve(root, relativePath);
  if (!absolutePath) return undefined;
  return path.isAbsolute(absolutePath) ? absolutePath : path.resolve(root, absolutePath);
}

async function probeLocalModel(endpoint, modelName, expectedIdentity) {
  try {
    const url = new URL(endpoint);
    const tags = await fetchJson(new URL('/api/tags', url.origin), { method: 'GET' }, 5000);
    const model = (tags.models || []).find((entry) => entry.name === modelName || entry.model === modelName);
    if (!model) return { status: 'unavailable', message: `Ollama is reachable but selected model ${modelName} is not installed.` };
    const digest = model.digest || model.details?.digest;
    if (expectedIdentity?.digest && digest && digest !== expectedIdentity.digest) return { status: 'unavailable', message: `Ollama model identity mismatch for ${modelName}; expected ${expectedIdentity.digest}, found ${digest}.` };
    return { status: 'available', message: `Ollama loopback endpoint is available with selected model ${modelName}${digest ? ` (${digest})` : ''}.` };
  } catch (error) {
    return { status: 'unavailable', message: `Ollama local model unavailable: ${error.message}` };
  }
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`request timed out after ${timeoutMs} ms`);
    throw error;
  } finally { clearTimeout(timer); }
}
