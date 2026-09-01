import { fingerprintValue, FINALIZATION_PHASES, SessionStorage, SessionStorageError, STORAGE_SCHEMA_VERSION, validateSessionId } from './session-storage.mjs';

export const SESSION_METADATA_VERSION = '1.0.0';
const ACTIVE_CACHE_LIMIT = 32;
const TRANSCRIPT_HISTORY_PAYLOAD_LIMIT_BYTES = 65536;

export function calculateRecordingDurationMs(metadata, nowMs = Date.now()) {
  let total = 0;
  let activeStartMs = Date.parse(metadata?.started_at || metadata?.created_at);
  const operations = Object.values(metadata?.operations || {}).sort((a, b) => Date.parse(a.outcome?.completed_at) - Date.parse(b.outcome?.completed_at));
  for (const operation of operations) {
    const completedMs = Date.parse(operation.outcome?.completed_at);
    if (!Number.isFinite(completedMs)) continue;
    if (operation.operation === 'session.stop' || operation.operation === 'session.close') {
      if (Number.isFinite(activeStartMs)) total += Math.max(0, completedMs - activeStartMs);
      activeStartMs = undefined;
    } else if (operation.operation === 'session.resume') {
      activeStartMs = completedMs;
    }
  }
  if (metadata?.state === 'recording' && Number.isFinite(activeStartMs)) total += Math.max(0, nowMs - activeStartMs);
  return total;
}

export class SessionLifecycleError extends Error {
  constructor(code, message, { retryable = false, rejected = false, details } = {}) {
    super(message);
    this.name = 'SessionLifecycleError';
    this.code = code;
    this.retryable = retryable;
    this.rejected = rejected;
    this.details = details;
  }
}

export class SessionLifecycle {
  constructor({ storage = new SessionStorage(), clock = () => new Date().toISOString(), activeCacheLimit = ACTIVE_CACHE_LIMIT } = {}) {
    this.storage = storage;
    this.clock = clock;
    this.activeCacheLimit = activeCacheLimit;
    this.transcriptCache = new Map();
    this.loggedItemCache = new Map();
  }

  async record(command) {
    validateCommand(command, 'record');
    const fingerprint = fingerprintValue(command);
    const existing = await this.storage.readMetadata(command.session_id);
    if (existing) {
      const replay = replayOperation(existing, command, fingerprint, 'session.record');
      if (replay) return replay;
      throw conflict('SESSION_ID_CONFLICT', `Session ${command.session_id} already exists and cannot be recorded with a new identity`);
    }
    await this.storage.ensureSession(command.session_id);
    const paths = this.storage.paths(command.session_id);
    const hasResidue = await Promise.all(['transcriptActive', 'loggedItemActive', 'transcriptOutbox', 'finalization', 'closeEvidence'].map((name) => this.storage.hasFile(command.session_id, name)));
    if (hasResidue.some(Boolean)) throw integrity('SESSION_RESIDUE', `Session ${command.session_id} has files but no governed metadata`);
    const now = this.clock();
    const metadata = createMetadata(command.session_id, now);
    const outcome = {
      operation_id: command.operation_id,
      session_id: command.session_id,
      state: 'recording',
      session_revision: metadata.revision + 1,
      completed_at: now,
      active_relative_path: `${command.session_id}/active`,
      permanent_relative_path: `${command.session_id}/permanent`
    };
    metadata.revision += 1;
    metadata.updated_at = now;
    metadata.operations[command.operation_id] = operationRecord(command, fingerprint, 'session.record', outcome);
    await this.storage.writeActiveSnapshot(command.session_id, 'transcript', createTranscriptSnapshot(command.session_id, now, []));
    await this.storage.writeActiveSnapshot(command.session_id, 'logged-item', createLoggedItemSnapshot(command.session_id, now, []));
    await this.storage.writeTranscriptOutbox(command.session_id, createTranscriptOutbox(command.session_id, now, []));
    await this.storage.writeFinalization(command.session_id, createFinalization(command.session_id, now));
    await this.storage.writeMetadata(command.session_id, metadata);
    return outcome;
  }

  async stop(command) {
    validateCommand(command, 'stop');
    const { metadata, fingerprint } = await this.#loadCommand(command, 'session.stop');
    const replay = replayOperation(metadata, command, fingerprint, 'session.stop');
    if (replay) return replay;
    if (metadata.state === 'closed' || metadata.state === 'closing') throw conflict('SESSION_CLOSED', `Session ${command.session_id} no longer accepts Stop`);
    if (metadata.state !== 'recording') throw conflict('SESSION_NOT_RECORDING', `Session ${command.session_id} is not recording`);
    const now = this.clock();
    metadata.state = 'stopped';
    metadata.stopped_at = now;
    metadata.updated_at = now;
    metadata.revision += 1;
    const outcome = basicOutcome(command, 'stopped', metadata.revision, now);
    metadata.operations[command.operation_id] = operationRecord(command, fingerprint, 'session.stop', outcome);
    await this.storage.writeMetadata(command.session_id, metadata);
    return outcome;
  }

  async resume(command) {
    validateCommand(command, 'resume');
    const { metadata, fingerprint } = await this.#loadCommand(command, 'session.resume');
    const replay = replayOperation(metadata, command, fingerprint, 'session.resume');
    if (replay) return replay;
    if (metadata.state === 'closed' || metadata.state === 'closing') throw conflict('SESSION_CLOSED', `Session ${command.session_id} cannot resume after close finalization began`);
    if (metadata.state !== 'stopped') throw conflict('SESSION_NOT_STOPPED', `Session ${command.session_id} must be stopped before Resume`);
    const now = this.clock();
    metadata.state = 'recording';
    metadata.stopped_at = null;
    metadata.updated_at = now;
    metadata.revision += 1;
    const outcome = basicOutcome(command, 'recording', metadata.revision, now);
    metadata.operations[command.operation_id] = operationRecord(command, fingerprint, 'session.resume', outcome);
    await this.storage.writeMetadata(command.session_id, metadata);
    return outcome;
  }

  async close(command, { failBeforePhase, failAfterPhase } = {}) {
    validateCommand(command, 'close');
    const { metadata, fingerprint } = await this.#loadCommand(command, 'session.close');
    const known = metadata.operations?.[command.operation_id];
    if (known) {
      if (known.command_fingerprint !== fingerprint) throw conflict('OPERATION_ID_CONFLICT', `Operation ${command.operation_id} was reused with different close content`);
      return structuredClone(known.outcome);
    }
    if (metadata.state === 'closed') {
      const evidence = await this.storage.readCloseEvidence(command.session_id);
      if (evidence?.operation_id === command.operation_id) return this.#persistRecoveredClose(metadata, command, fingerprint, evidence.outcome);
      throw conflict('SESSION_CLOSED', `Session ${command.session_id} is already closed`);
    }
    if (metadata.state === 'closing' && metadata.finalization.operation_id !== command.operation_id) {
      throw conflict('CLOSE_OPERATION_CONFLICT', `Session ${command.session_id} is finalizing under another close operation`);
    }
    if (!['recording', 'stopped', 'closing'].includes(metadata.state)) throw conflict('SESSION_NOT_CLOSABLE', `Session ${command.session_id} is not closable from ${metadata.state}`);
    const closeCommand = metadata.state === 'closing' ? metadata.finalization.command : structuredClone(command);
    const result = await this.#finalize(metadata, closeCommand, { failBeforePhase, failAfterPhase });
    const latest = await this.storage.readMetadata(command.session_id);
    if (!latest.operations?.[command.operation_id]) {
      latest.operations[command.operation_id] = operationRecord(command, fingerprint, 'session.close', result);
      await this.storage.writeMetadata(command.session_id, latest);
    }
    this.#releaseCaches(command.session_id);
    return result;
  }

  async recover(sessionId, options = {}) {
    validateSessionId(sessionId);
    const metadata = await this.storage.readMetadata(sessionId);
    if (!metadata) throw conflict('SESSION_NOT_FOUND', `Unknown session ${sessionId}`);
    if (Object.hasOwn(options, 'dryRun') || Object.hasOwn(options, 'apply')) return this.recoverSession(sessionId, options);
    if (metadata.state === 'closed') {
      const evidence = await this.storage.readCloseEvidence(sessionId);
      if (!evidence?.outcome) throw integrity('CLOSED_SESSION_EVIDENCE_MISSING', `Closed session ${sessionId} has no final close evidence`);
      return structuredClone(evidence.outcome);
    }
    if (metadata.state !== 'closing') return this.recoverSession(sessionId, { dryRun: true });
    if (!metadata.finalization.command || !metadata.finalization.operation_id) throw integrity('FINALIZATION_COMMAND_MISSING', `Session ${sessionId} has incomplete close progress`);
    const result = await this.#finalize(metadata, metadata.finalization.command, options);
    const latest = await this.storage.readMetadata(sessionId);
    const fingerprint = metadata.finalization.command_fingerprint;
    if (!latest.operations?.[metadata.finalization.operation_id]) {
      latest.operations[metadata.finalization.operation_id] = operationRecord(metadata.finalization.command, fingerprint, 'session.close', result);
      await this.storage.writeMetadata(sessionId, latest);
    }
    this.#releaseCaches(sessionId);
    return result;
  }

  async recoverSession(sessionId, options = {}) {
    validateSessionId(sessionId);
    const apply = options.apply === true;
    const dryRun = Object.hasOwn(options, 'dryRun') ? options.dryRun === true : !apply;
    if (dryRun && apply) throw invalid('Recovery cannot be both dry-run and apply');
    if (!dryRun && !apply) throw invalid('Recovery mutation requires explicit apply: true');

    const plan = await this.#buildRecoveryPlan(sessionId);
    const report = {
      session_id: sessionId,
      mode: apply ? 'apply' : 'dry-run',
      applied: false,
      backup_path: null,
      state_before: plan.metadata.state,
      state_after: plan.metadata.state,
      active_revisions_missing_history: plan.activeRevisionsMissingHistory,
      pending_acknowledged: plan.pendingAcknowledged,
      pending_unacknowledged: plan.pendingUnacknowledged,
      recovered: plan.recovered,
      already_present: plan.alreadyPresent,
      rejected: plan.rejected,
      rejection_details: plan.rejectionDetails,
      finalization: {
        eligible: plan.metadata.state === 'closing' && plan.rejected.length === 0,
        attempted: false,
        completed: false,
        phase_before: plan.metadata.finalization?.phase || 'none',
        phase_after: plan.metadata.finalization?.phase || 'none'
      }
    };
    if (!apply) return report;

    if (plan.willMutate) {
      const backup = await this.storage.backupSessionFiles(sessionId, { backupId: plan.backupId });
      report.backup_path = backup.directory;
      await this.#applyRecoveryPlan(plan);
      report.applied = true;
    }

    if (plan.metadata.state === 'closing' && plan.rejected.length === 0) {
      report.finalization.attempted = true;
      const latest = await this.#loadMetadata(sessionId);
      if (!latest.finalization.command || !latest.finalization.operation_id) throw integrity('FINALIZATION_COMMAND_MISSING', `Session ${sessionId} has incomplete close progress`);
      const outcome = await this.#finalize(latest, latest.finalization.command);
      report.finalization.completed = true;
      report.finalization.phase_after = 'released';
      report.state_after = outcome.state;
      report.outcome = outcome;
      this.#releaseCaches(sessionId);
    } else {
      const latest = await this.storage.readMetadata(sessionId);
      report.state_after = latest?.state || plan.metadata.state;
      report.finalization.phase_after = latest?.finalization?.phase || report.finalization.phase_after;
    }
    return report;
  }

  async inspectRecovery(sessionId) {
    return this.recoverSession(sessionId, { dryRun: true });
  }

  async acceptTranscriptRevision(sessionId, segment, { appendedAt = this.clock() } = {}) {
    return this.#acceptRevision(sessionId, 'transcript', segment, segment.revision_id || `${segment.segment_id}-r${segment.revision}`, appendedAt);
  }

  async acceptLoggedItemRevision(sessionId, item, { appendedAt = this.clock() } = {}) {
    return this.#acceptRevision(sessionId, 'logged-item', item, item.revision_id || `${item.item_id}:r${item.revision}`, appendedAt);
  }

  async persistActiveProjections(sessionId, { transcriptSegments, loggedItems, savedAt = this.clock() } = {}) {
    const metadata = await this.#loadMetadata(sessionId);
    if (metadata.state === 'closed') throw conflict('SESSION_CLOSED', `Session ${sessionId} is sealed`);
    if (!Array.isArray(transcriptSegments) || !Array.isArray(loggedItems)) throw invalid('active projections must be arrays');
    await this.storage.writeActiveSnapshot(sessionId, 'transcript', createTranscriptSnapshot(sessionId, savedAt, transcriptSegments));
    await this.storage.writeActiveSnapshot(sessionId, 'logged-item', createLoggedItemSnapshot(sessionId, savedAt, loggedItems));
    return { session_id: sessionId, saved_at: savedAt, transcript_count: transcriptSegments.length, logged_item_count: loggedItems.length };
  }

  async getActiveProjections(sessionId) {
    const [transcript, loggedItems] = await Promise.all([
      this.storage.readActiveSnapshot(sessionId, 'transcript'),
      this.storage.readActiveSnapshot(sessionId, 'logged-item')
    ]);
    if (!transcript || !loggedItems) throw integrity('ACTIVE_SNAPSHOT_MISSING', `Session ${sessionId} does not have complete active projections`);
    return { transcriptSegments: structuredClone(transcript.segments), loggedItems: structuredClone(loggedItems.items) };
  }

  async resolveTranscriptRevision(sessionId, segmentId, revision) {
    return this.#resolveRevision(sessionId, 'transcript', `${segmentId}-r${revision}`);
  }

  async resolveLoggedItemRevision(sessionId, revisionId) {
    return this.#resolveRevision(sessionId, 'logged-item', revisionId);
  }

  memoryStats() {
    return {
      transcript_cache_entries: this.transcriptCache.size,
      logged_item_cache_entries: this.loggedItemCache.size,
      max_cache_entries: this.activeCacheLimit
    };
  }

  #releaseCaches(sessionId) {
    for (const cache of [this.transcriptCache, this.loggedItemCache]) {
      for (const key of [...cache.keys()]) if (key.startsWith(`${sessionId}:`)) cache.delete(key);
    }
  }

  async #acceptRevision(sessionId, kind, value, historyEntryId, appendedAt) {
    const metadata = await this.#loadMetadata(sessionId);
    if (metadata.state !== 'recording') throw conflict(metadata.state === 'closed' ? 'SESSION_CLOSED' : 'SESSION_NOT_RECORDING', `Session ${sessionId} does not accept new ${kind} revisions while ${metadata.state}`);
    if (!value || typeof value !== 'object') throw invalid(`${kind} revision must be an object`);
    const revision = Number.isInteger(value.revision) ? value.revision : undefined;
    if (revision === undefined || revision < 0) throw invalid(`${kind} revision must be a non-negative integer`);
    const history = await this.storage.appendHistory(sessionId, kind, { historyEntryId, revision, record: value, appendedAt });
    const snapshot = await this.storage.readActiveSnapshot(sessionId, kind);
    if (!snapshot) throw integrity('ACTIVE_SNAPSHOT_MISSING', `Active ${kind} snapshot is missing for ${sessionId}`);
    const collection = kind === 'transcript' ? snapshot.segments : snapshot.items;
    const identity = kind === 'transcript' ? value.segment_id : value.item_id;
    const index = collection.findIndex((item) => (kind === 'transcript' ? item.segment_id : item.item_id) === identity);
    const current = index >= 0 ? collection[index] : undefined;
    if (current && revision < current.revision) throw conflict('STALE_REVISION', `${kind} revision ${revision} is older than active revision ${current.revision}`);
    if (current && revision === current.revision && fingerprintValue(current) !== fingerprintValue(value)) throw conflict('REVISION_ID_CONFLICT', `${kind} revision ${identity}:r${revision} was reused with different content`);
    if (!current || revision > current.revision) {
      if (index >= 0) collection[index] = structuredClone(value); else collection.push(structuredClone(value));
      snapshot.saved_at = appendedAt;
      await this.storage.writeActiveSnapshot(sessionId, kind, snapshot);
      metadata.updated_at = appendedAt;
      metadata.revision += 1;
      await this.storage.writeMetadata(sessionId, metadata);
    }
    this.#remember(kind, sessionId, identity, value);
    return { session_id: sessionId, history_entry_id: historyEntryId, revision, duplicate: history.duplicate };
  }

  async #resolveRevision(sessionId, kind, historyEntryId) {
    const cache = kind === 'transcript' ? this.transcriptCache : this.loggedItemCache;
    const cached = cache.get(`${sessionId}:${historyEntryId}`);
    if (cached) return structuredClone(cached);
    const value = await this.storage.resolveHistory(sessionId, kind, historyEntryId);
    const identity = kind === 'transcript' ? value.segment_id : value.item_id;
    this.#remember(kind, sessionId, identity, value);
    return value;
  }

  #remember(kind, sessionId, identity, value) {
    const cache = kind === 'transcript' ? this.transcriptCache : this.loggedItemCache;
    const historyEntryId = kind === 'transcript' ? `${identity}-r${value.revision}` : (value.revision_id || `${identity}:r${value.revision}`);
    const key = `${sessionId}:${historyEntryId}`;
    cache.delete(key);
    cache.set(key, structuredClone(value));
    while (cache.size > this.activeCacheLimit) cache.delete(cache.keys().next().value);
  }

  async #loadCommand(command, operation) {
    const metadata = await this.#loadMetadata(command.session_id);
    return { metadata, fingerprint: fingerprintValue(command), operation };
  }

  async #loadMetadata(sessionId) {
    validateSessionId(sessionId);
    const metadata = await this.storage.readMetadata(sessionId);
    if (!metadata) throw conflict('SESSION_NOT_FOUND', `Unknown session ${sessionId}`);
    if (metadata.schema_version !== SESSION_METADATA_VERSION || metadata.session_id !== sessionId || !metadata.finalization) throw integrity('SESSION_METADATA_INVALID', `Session ${sessionId} metadata is not governed`);
    return metadata;
  }

  async #finalize(metadata, command, { failBeforePhase, failAfterPhase } = {}) {
    const sessionId = metadata.session_id;
    if (metadata.state !== 'closing') {
      metadata.state = 'closing';
      metadata.updated_at = this.clock();
      metadata.revision += 1;
      metadata.finalization = {
        ...createFinalization(sessionId, metadata.updated_at),
        operation_id: command.operation_id,
        command: structuredClone(command),
        command_fingerprint: fingerprintValue(command)
      };
      await this.storage.writeMetadata(sessionId, metadata);
      await this.storage.writeFinalization(sessionId, metadata.finalization);
    }
    let phase = metadata.finalization.phase;
    if (phaseIndex(phase) < phaseIndex('writes-blocked')) {
      maybeInterrupt(failBeforePhase, 'writes-blocked', 'before');
      await this.#setPhase(metadata, 'writes-blocked');
      phase = 'writes-blocked';
      maybeInterrupt(failAfterPhase, phase, 'after');
    }
    if (phaseIndex(phase) < phaseIndex('drained')) {
      maybeInterrupt(failBeforePhase, 'drained', 'before');
      await this.#setPhase(metadata, 'drained');
      phase = 'drained';
      maybeInterrupt(failAfterPhase, phase, 'after');
    }
    if (phaseIndex(phase) < phaseIndex('active-persisted')) {
      maybeInterrupt(failBeforePhase, 'active-persisted', 'before');
      const projections = await this.getActiveProjections(sessionId);
      await this.persistActiveProjections(sessionId, projections);
      await this.#setPhase(metadata, 'active-persisted');
      phase = 'active-persisted';
      maybeInterrupt(failAfterPhase, phase, 'after');
    }
    let counts;
    if (phaseIndex(phase) < phaseIndex('history-reconciled')) {
      maybeInterrupt(failBeforePhase, 'history-reconciled', 'before');
      counts = await this.#reconcileHistory(sessionId);
      await this.#setPhase(metadata, 'history-reconciled');
      phase = 'history-reconciled';
      maybeInterrupt(failAfterPhase, phase, 'after');
    } else {
      counts = await this.#historyCounts(sessionId);
    }
    if (phaseIndex(phase) < phaseIndex('sealed')) {
      maybeInterrupt(failBeforePhase, 'sealed', 'before');
      const closedAt = metadata.closed_at || this.clock();
      const outcome = {
        operation_id: command.operation_id,
        session_id: sessionId,
        state: 'closed',
        session_revision: metadata.revision + 1,
        completed_at: closedAt,
        finalization_phase: 'released',
        transcript_history_count: counts.transcript,
        logged_item_history_count: counts['logged-item'],
        close_evidence_id: `${sessionId}:close:${command.operation_id}`
      };
      const evidence = {
        schema_version: STORAGE_SCHEMA_VERSION,
        evidence_id: outcome.close_evidence_id,
        session_id: sessionId,
        operation_id: command.operation_id,
        state: 'closed',
        closed_at: closedAt,
        finalization_phase: 'released',
        transcript_history_count: counts.transcript,
        logged_item_history_count: counts['logged-item'],
        outcome,
        integrity: 'verified'
      };
      const prior = await this.storage.readCloseEvidence(sessionId);
      if (prior && prior.evidence_id !== evidence.evidence_id) throw integrity('CLOSE_EVIDENCE_CONFLICT', `Session ${sessionId} has conflicting close evidence`);
      if (!prior) await this.storage.writeCloseEvidence(sessionId, evidence);
      metadata.closed_at = closedAt;
      metadata.state = 'closed';
      metadata.updated_at = closedAt;
      metadata.revision += 1;
      await this.#setPhase(metadata, 'sealed');
      phase = 'sealed';
      maybeInterrupt(failAfterPhase, phase, 'after');
    }
    if (phaseIndex(phase) < phaseIndex('released')) {
      maybeInterrupt(failBeforePhase, 'released', 'before');
      await this.#setPhase(metadata, 'released');
      phase = 'released';
      maybeInterrupt(failAfterPhase, phase, 'after');
    }
    const evidence = await this.storage.readCloseEvidence(sessionId);
    if (!evidence?.outcome) throw integrity('CLOSE_EVIDENCE_MISSING', `Session ${sessionId} sealed without close outcome`);
    return structuredClone(evidence.outcome);
  }

  async #setPhase(metadata, phase) {
    if (!FINALIZATION_PHASES.includes(phase)) throw integrity('UNKNOWN_FINALIZATION_PHASE', `Unknown finalization phase ${phase}`);
    const now = this.clock();
    const history = Array.isArray(metadata.finalization.phase_history) ? metadata.finalization.phase_history : [];
    if (history.at(-1)?.phase !== phase) history.push({ phase, completed_at: now });
    metadata.finalization.phase = phase;
    metadata.finalization.phase_history = history;
    metadata.updated_at = now;
    metadata.revision += 1;
    await this.storage.writeMetadata(metadata.session_id, metadata);
    await this.storage.writeFinalization(metadata.session_id, metadata.finalization);
  }

  async #reconcileHistory(sessionId) {
    const projections = await this.#reconcilePendingTranscriptOutbox(sessionId, await this.getActiveProjections(sessionId));
    const [transcript, loggedItems] = await Promise.all([
      this.storage.readHistory(sessionId, 'transcript'),
      this.storage.readHistory(sessionId, 'logged-item')
    ]);
    let transcriptChanged = false;
    const reconciledSegments = [];
    for (const segment of projections.transcriptSegments) {
      const revisionId = segment.revision_id || `${segment.segment_id}-r${segment.revision}`;
      const reconciled = await reconcileTranscriptHistoryEntry(this.storage, sessionId, transcript, revisionId, segment);
      reconciledSegments.push(reconciled);
      transcriptChanged ||= fingerprintValue(reconciled) !== fingerprintValue(segment);
    }
    if (transcriptChanged) await this.persistActiveProjections(sessionId, { transcriptSegments: reconciledSegments, loggedItems: projections.loggedItems });
    for (const item of projections.loggedItems) ensureLatestHistory(loggedItems, item.revision_id || `${item.item_id}:r${item.revision}`, item);
    return { transcript: transcript.length, 'logged-item': loggedItems.length };
  }

  async #reconcilePendingTranscriptOutbox(sessionId, projections) {
    const outbox = await this.storage.readTranscriptOutbox(sessionId);
    const pending = Array.isArray(outbox?.pending) ? [...outbox.pending] : [];
    if (!pending.length) return projections;
    const history = await this.storage.readHistory(sessionId, 'transcript');
    const segments = [...projections.transcriptSegments];
    pending.sort((a, b) => (a.segment?.sequence ?? 0) - (b.segment?.sequence ?? 0) || (a.segment?.revision ?? 0) - (b.segment?.revision ?? 0));
    for (const entry of pending) {
      const segment = entry?.segment;
      const revisionId = entry?.revision_id || `${segment?.segment_id}-r${segment?.revision}`;
      if (!entry || typeof entry !== 'object' || typeof entry.revision_id !== 'string' || !entry.revision_id || !segment?.segment_id || segment.session_id !== sessionId || revisionId !== `${segment.segment_id}-r${segment.revision}` || typeof entry.emit_segment !== 'boolean') {
        throw integrity('PENDING_TRANSCRIPT_COMMIT_INVALID', `Pending transcript outbox contains an invalid revision for ${sessionId}`);
      }
      const reconciled = await reconcilePendingTranscriptHistoryEntry(this.storage, sessionId, history, revisionId, segment);
      const index = segments.findIndex((candidate) => candidate.segment_id === segment.segment_id);
      if (index < 0) segments.push(structuredClone(reconciled));
      else if (segments[index].revision < reconciled.revision) segments[index] = structuredClone(reconciled);
      else if (segments[index].revision === reconciled.revision && fingerprintValue(segments[index]) !== fingerprintValue(reconciled)) {
        throw integrity('AUTHORITATIVE_ACTIVE_CONFLICT', `Pending transcript revision ${revisionId} differs from active state`);
      }
    }
    await this.persistActiveProjections(sessionId, { transcriptSegments: segments, loggedItems: projections.loggedItems });
    await this.storage.writeTranscriptOutbox(sessionId, createTranscriptOutbox(sessionId, this.clock(), []));
    return { ...projections, transcriptSegments: segments };
  }

  async #buildRecoveryPlan(sessionId) {
    const metadata = await this.#loadMetadata(sessionId);
    const [transcriptSnapshot, loggedItemSnapshot, outbox, transcriptHistory, loggedItemHistory] = await Promise.all([
      this.storage.readActiveSnapshot(sessionId, 'transcript'),
      this.storage.readActiveSnapshot(sessionId, 'logged-item'),
      this.storage.readTranscriptOutbox(sessionId),
      this.storage.readHistory(sessionId, 'transcript'),
      this.storage.readHistory(sessionId, 'logged-item')
    ]);
    if (!transcriptSnapshot || transcriptSnapshot.session_id !== sessionId || !Array.isArray(transcriptSnapshot.segments)) throw integrity('ACTIVE_SNAPSHOT_INVALID', `Active transcript snapshot is not governed for ${sessionId}`);
    if (!loggedItemSnapshot || loggedItemSnapshot.session_id !== sessionId || !Array.isArray(loggedItemSnapshot.items)) throw integrity('ACTIVE_SNAPSHOT_INVALID', `Active logged-item snapshot is not governed for ${sessionId}`);
    if (outbox && (outbox.session_id !== sessionId || outbox.schema_version !== STORAGE_SCHEMA_VERSION || !Array.isArray(outbox.pending))) throw integrity('TRANSCRIPT_OUTBOX_INVALID', `Transcript pending outbox is not governed for ${sessionId}`);

    const historyById = new Map();
    const historyConflicts = new Map();
    for (const entry of transcriptHistory) {
      const known = historyById.get(entry.history_entry_id);
      if (known && known.fingerprint !== entry.fingerprint) historyConflicts.set(entry.history_entry_id, 'Permanent history contains conflicting copies of this revision');
      else if (!known) historyById.set(entry.history_entry_id, entry);
    }

    const candidates = new Map();
    const rejectionDetails = new Map();
    const activeRevisionsMissingHistory = [];
    const pendingEntries = (outbox?.pending || []).map((entry, index) => ({ entry, index, revisionId: recoveryRevisionId(entry?.segment, entry?.revision_id) || reportRevisionId(entry?.segment, `pending-${index}`) }));
    const reject = (revisionId, error) => {
      const id = revisionId || 'unknown-revision';
      if (!rejectionDetails.has(id)) rejectionDetails.set(id, { code: error.code || 'RECOVERY_REJECTED', message: error.message });
    };
    const addCandidate = (segment, source, sourceIndex, revisionId) => {
      const id = revisionId || recoveryRevisionId(segment) || reportRevisionId(segment, `${source}-${sourceIndex}`);
      const derivedId = segment?.segment_id && Number.isInteger(segment?.revision) && segment.revision >= 0 ? `${segment.segment_id}-r${segment.revision}` : undefined;
      if (!derivedId || (segment.revision_id !== undefined && segment.revision_id !== derivedId) || derivedId !== id) {
        reject(id, integrity('TRANSCRIPT_REVISION_ID_INVALID', `Transcript revision ${id} has no governed segment/revision identity`));
        return;
      }
      const fingerprint = fingerprintValue(segment);
      const known = candidates.get(id);
      if (known && known.fingerprint !== fingerprint) {
        reject(id, integrity('RECOVERY_REVISION_CONFLICT', `Active and pending transcript revision ${id} contain different evidence`));
        known.conflicted = true;
        return;
      }
      const candidate = known || { revisionId: id, fingerprint, segment: structuredClone(segment), activeIndexes: [], pendingIndexes: [], conflicted: false };
      if (source === 'active') candidate.activeIndexes.push(sourceIndex);
      else candidate.pendingIndexes.push(sourceIndex);
      candidates.set(id, candidate);
    };

    for (const [index, segment] of transcriptSnapshot.segments.entries()) {
      const revisionId = recoveryRevisionId(segment);
      const reportId = revisionId || reportRevisionId(segment, `active-${index}`);
      if (revisionId && !historyById.has(revisionId)) activeRevisionsMissingHistory.push(revisionId);
      addCandidate(segment, 'active', index, revisionId);
      if (!revisionId) reject(reportId, integrity('TRANSCRIPT_REVISION_ID_INVALID', `Active transcript entry ${reportId} has no governed revision identity`));
    }
    for (const pending of pendingEntries) {
      const entry = pending.entry;
      if (!entry || typeof entry !== 'object' || typeof entry.revision_id !== 'string' || !entry.revision_id || !entry.segment || typeof entry.segment !== 'object' || typeof entry.emit_segment !== 'boolean' || (entry.utterance_id !== undefined && (typeof entry.utterance_id !== 'string' || !entry.utterance_id)) || (entry.request_id !== undefined && (typeof entry.request_id !== 'string' || !entry.request_id))) {
        reject(pending.revisionId, integrity('PENDING_TRANSCRIPT_COMMIT_INVALID', `Pending transcript outbox entry ${pending.revisionId} is not governed`));
        continue;
      }
      addCandidate(entry.segment, 'pending', pending.index, pending.revisionId);
      if (!recoveryRevisionId(pending.entry?.segment) || pending.revisionId !== recoveryRevisionId(pending.entry?.segment)) {
        reject(pending.revisionId, integrity('PENDING_TRANSCRIPT_COMMIT_INVALID', `Pending transcript outbox entry ${pending.revisionId} is not a governed revision`));
      }
    }

    const pendingAcknowledged = pendingEntries.filter((pending) => pending.revisionId && historyById.has(pending.revisionId)).map((pending) => pending.revisionId);
    const pendingUnacknowledged = pendingEntries.filter((pending) => pending.revisionId && !historyById.has(pending.revisionId)).map((pending) => pending.revisionId);
    const activeByRevision = new Map(transcriptSnapshot.segments.map((segment, index) => [recoveryRevisionId(segment), { segment, index }]));
    const activeReplacements = new Map();
    const activeAdditions = [];
    const append = [];
    const completedPending = new Set();
    const recovered = [];
    const alreadyPresent = [];

    for (const candidate of [...candidates.values()].sort(compareRecoveryCandidates)) {
      if (candidate.conflicted) continue;
      const id = candidate.revisionId;
      const existing = historyById.get(id);
      const active = activeByRevision.get(id);
      if (historyConflicts.has(id)) {
        reject(id, integrity('AUTHORITATIVE_HISTORY_CONFLICT', `Permanent history entry ${id} has conflicting copies`));
        continue;
      }
      const candidateFingerprint = fingerprintValue(candidate.segment);
      if (existing && active && existing.fingerprint === candidateFingerprint && fingerprintValue(active.segment) === candidateFingerprint) {
        for (const pendingIndex of candidate.pendingIndexes) completedPending.add(pendingIndex);
        alreadyPresent.push(id);
        continue;
      }
      let normalized;
      try {
        normalized = compactLegacyTranscriptSegment(candidate.segment);
      } catch (error) {
        reject(id, error);
        continue;
      }
      const normalizedFingerprint = fingerprintValue(normalized);
      try { validateRecoveredTranscriptAppend(sessionId, id, normalized); }
      catch (error) {
        reject(id, error);
        continue;
      }
      if (existing && existing.fingerprint !== normalizedFingerprint) {
        reject(id, integrity('AUTHORITATIVE_HISTORY_CONFLICT', `Authoritative history entry ${id} differs from active state`));
        continue;
      }
      const activeMatches = Boolean(active && fingerprintValue(active.segment) === normalizedFingerprint);
      if (!existing) append.push({ id, segment: normalized });
      if (active && !activeMatches) activeReplacements.set(active.index, normalized);
      if (!active && candidate.pendingIndexes.length) {
        const currentIndex = transcriptSnapshot.segments.findIndex((segment) => segment.segment_id === normalized.segment_id);
        const current = currentIndex >= 0 ? transcriptSnapshot.segments[currentIndex] : undefined;
        if (!current || (Number.isInteger(current.revision) && current.revision < normalized.revision)) activeAdditions.push(normalized);
      }
      for (const pendingIndex of candidate.pendingIndexes) completedPending.add(pendingIndex);
      if (existing && activeMatches) alreadyPresent.push(id);
      else recovered.push(id);
    }

    for (const item of loggedItemSnapshot.items) {
      const id = item?.revision_id || (item?.item_id && Number.isInteger(item?.revision) ? `${item.item_id}:r${item.revision}` : undefined);
      const historyEntry = id ? loggedItemHistory.find((entry) => entry.history_entry_id === id) : undefined;
      if (!id) reject('unknown-logged-item-revision', integrity('LOGGED_ITEM_REVISION_ID_INVALID', `Active logged item has no governed revision identity`));
      else if (!historyEntry) reject(id, integrity('MISSING_AUTHORITATIVE_HISTORY', `Missing authoritative history entry ${id}`));
      else if (historyEntry.fingerprint !== fingerprintValue(item)) reject(id, integrity('AUTHORITATIVE_HISTORY_CONFLICT', `Authoritative history entry ${id} differs from active state`));
    }
    for (const id of historyConflicts.keys()) if (!rejectionDetails.has(id)) reject(id, integrity('AUTHORITATIVE_HISTORY_CONFLICT', `Permanent history entry ${id} has conflicting copies`));

    const nextSegments = transcriptSnapshot.segments.map((segment, index) => activeReplacements.get(index) || structuredClone(segment));
    for (const addition of activeAdditions) {
      const sameSegmentIndex = nextSegments.findIndex((segment) => segment.segment_id === addition.segment_id);
      if (sameSegmentIndex < 0) nextSegments.push(structuredClone(addition));
      else if ((nextSegments[sameSegmentIndex].revision ?? -1) < addition.revision) nextSegments[sameSegmentIndex] = structuredClone(addition);
    }
    const nextPending = pendingEntries.filter((pending) => !completedPending.has(pending.index)).map((pending) => structuredClone(pending.entry));
    const appendIds = append.map((item) => item.id);
    const activeChanged = fingerprintValue(nextSegments) !== fingerprintValue(transcriptSnapshot.segments);
    const outboxChanged = nextPending.length !== pendingEntries.length;
    const rejectionIds = [...rejectionDetails.keys()].sort();
    const preimage = { metadata, transcriptSnapshot, loggedItemSnapshot, outbox: outbox || createTranscriptOutbox(sessionId, transcriptSnapshot.saved_at, []), transcriptHistory, loggedItemHistory };
    const backupId = `recovery-${fingerprintValue(preimage).slice(7, 31)}`;
    return {
      sessionId,
      metadata,
      transcriptSnapshot,
      outbox: outbox || createTranscriptOutbox(sessionId, transcriptSnapshot.saved_at, []),
      nextSegments,
      nextPending,
      append,
      appendIds,
      activeChanged,
      outboxChanged,
      recovered: [...new Set(recovered)].sort(),
      alreadyPresent: [...new Set(alreadyPresent)].sort(),
      rejected: rejectionIds,
      rejectionDetails: Object.fromEntries(rejectionIds.map((id) => [id, rejectionDetails.get(id)])),
      activeRevisionsMissingHistory: [...new Set(activeRevisionsMissingHistory)].sort(),
      pendingAcknowledged: [...new Set(pendingAcknowledged)].sort(),
      pendingUnacknowledged: [...new Set(pendingUnacknowledged)].sort(),
      backupId,
      willMutate: activeChanged || outboxChanged || appendIds.length > 0 || (metadata.state === 'closing' && rejectionIds.length === 0)
    };
  }

  async #applyRecoveryPlan(plan) {
    const initialMetadata = await this.#loadMetadata(plan.sessionId);
    if (initialMetadata.revision !== plan.metadata.revision || initialMetadata.state !== plan.metadata.state) throw integrity('RECOVERY_STATE_CHANGED', `Session ${plan.sessionId} changed before recovery could be applied`);
    for (const item of plan.append) {
      await this.storage.appendHistory(plan.sessionId, 'transcript', {
        historyEntryId: item.id,
        revision: item.segment.revision,
        record: item.segment,
        appendedAt: item.segment.stored_at
      });
    }
    if (plan.activeChanged) await this.storage.writeActiveSnapshot(plan.sessionId, 'transcript', createTranscriptSnapshot(plan.sessionId, this.clock(), plan.nextSegments));
    if (plan.outboxChanged) await this.storage.writeTranscriptOutbox(plan.sessionId, createTranscriptOutbox(plan.sessionId, this.clock(), plan.nextPending));
    if (plan.activeChanged || plan.outboxChanged || plan.append.length) {
      const metadata = await this.#loadMetadata(plan.sessionId);
      if (metadata.revision !== plan.metadata.revision || metadata.state !== plan.metadata.state) throw integrity('RECOVERY_STATE_CHANGED', `Session ${plan.sessionId} changed while recovery was being applied`);
      metadata.updated_at = this.clock();
      metadata.revision += 1;
      await this.storage.writeMetadata(plan.sessionId, metadata);
    }
  }

  async #historyCounts(sessionId) {
    const [transcript, loggedItems] = await Promise.all([this.storage.readHistory(sessionId, 'transcript'), this.storage.readHistory(sessionId, 'logged-item')]);
    return { transcript: transcript.length, 'logged-item': loggedItems.length };
  }

  async #persistRecoveredClose(metadata, command, fingerprint, outcome) {
    metadata.operations[command.operation_id] = operationRecord(command, fingerprint, 'session.close', outcome);
    await this.storage.writeMetadata(metadata.session_id, metadata);
    return structuredClone(outcome);
  }
}

function createMetadata(sessionId, now) {
  return {
    schema_version: SESSION_METADATA_VERSION,
    session_id: sessionId,
    state: 'recording',
    revision: 0,
    created_at: now,
    updated_at: now,
    started_at: now,
    stopped_at: null,
    closed_at: null,
    finalization: createFinalization(sessionId, now),
    operations: {}
  };
}

function createFinalization(sessionId, now) {
  return { schema_version: STORAGE_SCHEMA_VERSION, session_id: sessionId, phase: 'none', operation_id: null, command: null, command_fingerprint: null, phase_history: [], updated_at: now };
}

function createTranscriptOutbox(sessionId, savedAt, pending) {
  return { schema_version: STORAGE_SCHEMA_VERSION, session_id: sessionId, saved_at: savedAt, pending: structuredClone(pending) };
}

function createTranscriptSnapshot(sessionId, savedAt, segments) { return { schema_version: STORAGE_SCHEMA_VERSION, session_id: sessionId, saved_at: savedAt, segments: structuredClone(segments) }; }
function createLoggedItemSnapshot(sessionId, savedAt, items) { return { schema_version: STORAGE_SCHEMA_VERSION, session_id: sessionId, saved_at: savedAt, items: structuredClone(items) }; }

function validateCommand(command, type) {
  if (!command || typeof command !== 'object') throw invalid(`${type} command must be an object`);
  validateSessionId(command.session_id);
  if (typeof command.operation_id !== 'string' || !command.operation_id) throw invalid(`${type} operation_id is required`);
  if (typeof command.requested_at !== 'string' || !command.requested_at) throw invalid(`${type} requested_at is required`);
}

function replayOperation(metadata, command, fingerprint, operation) {
  const known = metadata.operations?.[command.operation_id];
  if (!known) return undefined;
  if (known.command_fingerprint !== fingerprint) throw conflict('OPERATION_ID_CONFLICT', `Operation ${command.operation_id} was reused with different content`);
  if (known.operation !== operation) throw conflict('OPERATION_ID_CONFLICT', `Operation ${command.operation_id} was reused for ${known.operation}`);
  return structuredClone(known.outcome);
}

function operationRecord(command, commandFingerprint, operation, outcome) { return { operation_id: command.operation_id, operation, command_fingerprint: commandFingerprint, command: structuredClone(command), outcome: structuredClone(outcome) }; }
function basicOutcome(command, state, revision, completedAt) { return { operation_id: command.operation_id, session_id: command.session_id, state, session_revision: revision, completed_at: completedAt }; }
function phaseIndex(phase) { const index = FINALIZATION_PHASES.indexOf(phase); if (index < 0) throw integrity('UNKNOWN_FINALIZATION_PHASE', `Unknown finalization phase ${phase}`); return index; }
function maybeInterrupt(target, phase, edge) { if (target === phase) throw new SessionLifecycleError('FINALIZATION_INTERRUPTED', `Test interruption ${edge} finalization phase ${phase}`, { retryable: true, details: { phase, edge } }); }
async function reconcileTranscriptHistoryEntry(storage, sessionId, history, revisionId, segment) {
  const existing = history.find((item) => item.history_entry_id === revisionId);
  if (existing?.fingerprint === fingerprintValue(segment)) return segment;
  let candidate = segment;
  candidate = compactLegacyTranscriptSegment(segment);
  if (fingerprintValue(candidate) !== fingerprintValue(segment)) throw integrity('LEGACY_RECOVERY_APPLY_REQUIRED', `Transcript revision ${revisionId} requires explicit recovery apply before close can mutate legacy provenance`);
  validateRecoveredTranscriptAppend(sessionId, revisionId, candidate);
  if (existing) {
    if (existing.fingerprint !== fingerprintValue(candidate)) throw integrity('AUTHORITATIVE_HISTORY_CONFLICT', `Authoritative history entry ${revisionId} differs from active state`);
    return candidate;
  }
  throw integrity('RECOVERY_APPLY_REQUIRED', `Transcript revision ${revisionId} is active without authoritative history; run explicit recovery apply before close`);
}
async function reconcilePendingTranscriptHistoryEntry(storage, sessionId, history, revisionId, segment) {
  const existing = history.find((item) => item.history_entry_id === revisionId);
  if (existing?.fingerprint === fingerprintValue(segment)) return segment;
  validateRecoveredTranscriptAppend(sessionId, revisionId, segment);
  if (existing) throw integrity('AUTHORITATIVE_HISTORY_CONFLICT', `Authoritative history entry ${revisionId} differs from pending state`);
  const appended = await storage.appendHistory(sessionId, 'transcript', {
    historyEntryId: revisionId,
    revision: segment.revision,
    record: segment,
    appendedAt: segment.stored_at
  });
  history.push(appended.entry);
  return segment;
}

function compactLegacyTranscriptSegment(segment) {
  const words = Array.isArray(segment?.word_provenance) ? segment.word_provenance : [];
  if (Array.isArray(segment?.audio_windows) && segment.audio_windows.length) return structuredClone(segment);
  const groups = new Map();
  for (const word of words) {
    if (!Array.isArray(word?.source_chunk_ids) || word.source_chunk_ids.length < 2) continue;
    const windowId = word.source_audio_window_id;
    if (!windowId) throw integrity('LEGACY_PROVENANCE_UNRECOVERABLE', `Transcript segment ${segment.segment_id} has repeated chunks without an audio-window identity`);
    const group = groups.get(windowId) || { chunkIds: word.source_chunk_ids, count: 0, consistent: true };
    if (fingerprintValue(group.chunkIds) !== fingerprintValue(word.source_chunk_ids)) group.consistent = false;
    group.count += 1;
    groups.set(windowId, group);
  }
  if (!groups.size) return structuredClone(segment);
  if ([...groups.values()].some((group) => !group.consistent)) throw integrity('LEGACY_PROVENANCE_UNRECOVERABLE', `Transcript segment ${segment.segment_id} has inconsistent repeated provenance without word timestamps`);
  const repeatedGroups = [...groups.entries()].filter(([, group]) => group.count > 1);
  if (!repeatedGroups.length) return structuredClone(segment);
  const audioWindows = repeatedGroups.map(([audioWindowId, group]) => {
    const chunkIds = group.chunkIds;
    const sequences = chunkIds.map(sequenceFromChunkId);
    if (sequences.some((sequence) => !Number.isInteger(sequence)) || sequences.at(-1) - sequences[0] + 1 !== chunkIds.length || chunkIds.length > 120) {
      throw integrity('LEGACY_PROVENANCE_UNRECOVERABLE', `Transcript segment ${segment.segment_id} has a non-contiguous or oversized legacy audio span`);
    }
    return {
      audio_window_id: audioWindowId,
      first_chunk_id: chunkIds[0],
      last_chunk_id: chunkIds.at(-1),
      first_sequence: sequences[0],
      last_sequence: sequences.at(-1),
      chunk_count: chunkIds.length,
      start_time: segment.start_time,
      end_time: segment.end_time
    };
  });
  const compacted = structuredClone(segment);
  compacted.audio_windows = audioWindows;
  compacted.word_provenance = words.map((word) => {
    const next = structuredClone(word);
    const group = groups.get(next.source_audio_window_id);
    if (group?.count > 1 && group.consistent && fingerprintValue(group.chunkIds) === fingerprintValue(next.source_chunk_ids)) delete next.source_chunk_ids;
    return next;
  });
  return compacted;
}

function sequenceFromChunkId(chunkId) {
  const match = /(?:^|-)chunk-(\d+)$/.exec(String(chunkId || ''));
  return match ? Number(match[1]) : undefined;
}

function validateRecoveredTranscriptAppend(sessionId, revisionId, segment) {
  if (!segment || typeof segment !== 'object' || segment.session_id !== sessionId || typeof segment.segment_id !== 'string' || !Number.isInteger(segment.sequence) || segment.sequence < 0 || !Number.isInteger(segment.revision) || segment.revision < 0 || revisionId !== `${segment.segment_id}-r${segment.revision}` || !Array.isArray(segment.word_provenance) || !segment.word_provenance.length) {
    throw integrity('TRANSCRIPT_HISTORY_PAYLOAD_INVALID', `Transcript revision ${revisionId} is not a governed stored segment`);
  }
  if (![segment.start_time, segment.end_time, segment.text, segment.original_stt_text, segment.stored_at].every((value) => typeof value === 'string' && value.length > 0) || !['continuation', 'pause', 'size', 'latency', 'flush'].includes(segment.boundary)) {
    throw integrity('TRANSCRIPT_HISTORY_PAYLOAD_INVALID', `Transcript revision ${revisionId} is not a governed stored segment`);
  }
  const allowedSegmentKeys = new Set(['segment_id', 'revision_id', 'session_id', 'sequence', 'revision', 'start_time', 'end_time', 'text', 'original_stt_text', 'boundary', 'word_provenance', 'audio_windows', 'formatting', 'review_flags', 'stored_at']);
  if (Object.keys(segment).some((key) => !allowedSegmentKeys.has(key))) throw integrity('TRANSCRIPT_HISTORY_PAYLOAD_INVALID', `Transcript revision ${revisionId} contains an undeclared field`);
  const wordIds = new Set();
  for (const word of segment.word_provenance) {
    if (!word || typeof word !== 'object' || typeof word.word_id !== 'string' || !word.word_id || typeof word.source_text !== 'string' || !word.source_text || typeof word.rendered_text !== 'string' || !word.rendered_text) throw integrity('TRANSCRIPT_HISTORY_PAYLOAD_INVALID', `Transcript revision ${revisionId} contains an invalid word record`);
    const allowedWordKeys = new Set(['word_id', 'source_text', 'rendered_text', 'source_sequence', 'source_audio_window_id', 'source_chunk_ids', 'correction_proposal_id']);
    if (Object.keys(word).some((key) => !allowedWordKeys.has(key))) throw integrity('TRANSCRIPT_HISTORY_PAYLOAD_INVALID', `Transcript revision ${revisionId} contains an undeclared word field`);
    if (wordIds.has(word.word_id)) throw integrity('TRANSCRIPT_HISTORY_PAYLOAD_INVALID', `Transcript revision ${revisionId} contains duplicate word evidence`);
    wordIds.add(word.word_id);
    if (word.source_sequence !== undefined && (!Number.isInteger(word.source_sequence) || word.source_sequence < 0)) throw integrity('TRANSCRIPT_HISTORY_PAYLOAD_INVALID', `Transcript revision ${revisionId} contains an invalid word sequence`);
    if (word.source_audio_window_id !== undefined && (typeof word.source_audio_window_id !== 'string' || !word.source_audio_window_id)) throw integrity('TRANSCRIPT_HISTORY_PAYLOAD_INVALID', `Transcript revision ${revisionId} contains an invalid audio-window identity`);
    if (word.source_chunk_ids !== undefined && (!Array.isArray(word.source_chunk_ids) || !word.source_chunk_ids.length || word.source_chunk_ids.some((chunkId) => typeof chunkId !== 'string' || !chunkId))) throw integrity('TRANSCRIPT_HISTORY_PAYLOAD_INVALID', `Transcript revision ${revisionId} contains invalid chunk evidence`);
  }
  if (segment.audio_windows !== undefined) validateRecoveredAudioWindows(segment.audio_windows, revisionId);
  if (segment.formatting !== undefined && (!segment.formatting || segment.formatting.provisional_until_finalized !== true || !['stt-provider', 'active-transcript-owner', 'contextual-language'].includes(segment.formatting.source))) throw integrity('TRANSCRIPT_HISTORY_PAYLOAD_INVALID', `Transcript revision ${revisionId} has invalid formatting metadata`);
  if (segment.review_flags !== undefined && (!Array.isArray(segment.review_flags) || segment.review_flags.some((flag) => !flag || typeof flag.word_id !== 'string' || !['unresolved-ambiguity', 'correction-review'].includes(flag.reason) || !Array.isArray(flag.candidates) || flag.candidates.length < 1 || flag.candidates.some((candidate) => typeof candidate !== 'string' || !candidate)))) throw integrity('TRANSCRIPT_HISTORY_PAYLOAD_INVALID', `Transcript revision ${revisionId} has invalid review flags`);
  const bytes = Buffer.byteLength(JSON.stringify({ history_entry_id: revisionId, session_id: sessionId, segment, requested_at: segment.stored_at }), 'utf8');
  if (bytes > TRANSCRIPT_HISTORY_PAYLOAD_LIMIT_BYTES) throw integrity('TRANSCRIPT_HISTORY_PAYLOAD_LIMIT', `Transcript revision ${revisionId} remains ${bytes} bytes after provenance compaction; maximum is ${TRANSCRIPT_HISTORY_PAYLOAD_LIMIT_BYTES}`);
}
function validateRecoveredAudioWindows(windows, revisionId) {
  if (!Array.isArray(windows) || !windows.length) throw integrity('TRANSCRIPT_HISTORY_PAYLOAD_INVALID', `Transcript revision ${revisionId} has invalid audio-window spans`);
  for (const window of windows) {
    const allowedWindowKeys = new Set(['audio_window_id', 'first_chunk_id', 'last_chunk_id', 'first_sequence', 'last_sequence', 'chunk_count', 'start_time', 'end_time']);
    if (!window || typeof window !== 'object' || Object.keys(window).some((key) => !allowedWindowKeys.has(key))) throw integrity('TRANSCRIPT_HISTORY_PAYLOAD_INVALID', `Transcript revision ${revisionId} has undeclared audio-window fields`);
    if (!window || typeof window !== 'object' || ['audio_window_id', 'first_chunk_id', 'last_chunk_id', 'start_time', 'end_time'].some((key) => typeof window[key] !== 'string' || !window[key]) || !Number.isInteger(window.first_sequence) || !Number.isInteger(window.last_sequence) || !Number.isInteger(window.chunk_count) || window.first_sequence < 0 || window.last_sequence < window.first_sequence || window.chunk_count < 1 || window.chunk_count > 120 || window.last_sequence - window.first_sequence + 1 !== window.chunk_count) throw integrity('TRANSCRIPT_HISTORY_PAYLOAD_INVALID', `Transcript revision ${revisionId} has invalid audio-window spans`);
  }
}
function recoveryRevisionId(segment, explicitId) {
  const derived = segment?.segment_id && Number.isInteger(segment?.revision) && segment.revision >= 0 ? `${segment.segment_id}-r${segment.revision}` : undefined;
  if (explicitId !== undefined) return typeof explicitId === 'string' && explicitId === derived ? explicitId : explicitId;
  if (segment?.revision_id !== undefined) return segment.revision_id;
  return derived;
}
function reportRevisionId(segment, fallback) { return recoveryRevisionId(segment) || (segment?.revision_id || `${fallback}`); }
function compareRecoveryCandidates(a, b) { return (a.segment?.sequence ?? Number.MAX_SAFE_INTEGER) - (b.segment?.sequence ?? Number.MAX_SAFE_INTEGER) || (a.segment?.revision ?? Number.MAX_SAFE_INTEGER) - (b.segment?.revision ?? Number.MAX_SAFE_INTEGER) || a.revisionId.localeCompare(b.revisionId); }
function ensureLatestHistory(history, id, value) { const entry = history.find((item) => item.history_entry_id === id); if (!entry) throw integrity('MISSING_AUTHORITATIVE_HISTORY', `Missing authoritative history entry ${id}`); if (entry.fingerprint !== fingerprintValue(value)) throw integrity('AUTHORITATIVE_HISTORY_CONFLICT', `Authoritative history entry ${id} differs from active state`); }
function invalid(message) { return new SessionLifecycleError('INVALID_INPUT', message); }
function conflict(code, message) { return new SessionLifecycleError(code, message, { rejected: true }); }
function integrity(code, message) { return new SessionLifecycleError(code, message); }
