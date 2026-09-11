import { createHash } from 'node:crypto';
import { access, appendFile, copyFile, mkdir, readFile, rename, writeFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fingerprintScribeGuidance } from '../contracts/model-protocol.mjs';

export const STORAGE_SCHEMA_VERSION = '1.0.0';
export const SCRIBE_CHECKPOINT_SCHEMA_VERSION = '1.0.0';
export const FINALIZATION_PHASES = Object.freeze([
  'none',
  'writes-blocked',
  'drained',
  'active-persisted',
  'history-reconciled',
  'sealed',
  'released'
]);

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HISTORY_FILE_BY_KIND = Object.freeze({
  transcript: 'transcript.history.ndjson',
  'logged-item': 'logged-item.history.ndjson'
});
const RECOVERY_BACKUP_FILE_NAMES = Object.freeze([
  'metadata',
  'transcriptActive',
  'loggedItemActive',
  'transcriptOutbox',
  'finalization',
  'transcriptHistory',
  'loggedItemHistory',
  'closeEvidence',
  'scribeCheckpoint',
  'scribeGuidance',
  'scribeBatchJournal'
]);
export const SCRIBE_GUIDANCE_SNAPSHOT_SCHEMA_VERSION = '1.1.0';
const SCRIBE_GUIDANCE_SNAPSHOT_SCHEMA_VERSIONS = new Set(['1.0.0', SCRIBE_GUIDANCE_SNAPSHOT_SCHEMA_VERSION]);
const SCRIBE_GUIDANCE_SNAPSHOT_MAX_CHARS = 2000;
const SCRIBE_ITEM_KIND_VALUES = new Set(['action', 'decision', 'open-question', 'reminder', 'other']);
const SCRIBE_ADMISSION_REASON_VALUES = new Set(['batch-complete', 'idle-timeout']);
const SCRIBE_OUTCOME_VALUES = new Set(['items-recorded', 'empty-evaluated', 'failed']);
const SCRIBE_BATCH_EVALUATED_MAX_ITEMS = 8;
const SCRIBE_CHECKPOINT_PENDING_MAX_SEGMENTS = 2;
const SCRIBE_BATCH_IDENTITY_MAX_SEGMENTS = 16;
const SCRIBE_ITEM_TEXT_MAX_LENGTH = 512;
// 64 = ceiling on prior_logged_items even if the entire ~8000-token scribe.batch-policy context budget were
// spent on them alone: at ~4 chars/token, a max-length (512-char, SCRIBE_ITEM_TEXT_MAX_LENGTH) item is ~128
// tokens, so 8000/128 ~= 62 is the realistic max a policy-governed caller could ever produce; 64 rounds up.
const SCRIBE_CHECKPOINT_BACKGROUND_ITEMS_MAX = 64;

export class SessionStorageError extends Error {
  constructor(code, message, { retryable = false, details } = {}) {
    super(message);
    this.name = 'SessionStorageError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new SessionStorageError('INVALID_SESSION_ID', 'session_id must be a safe single path segment', { details: { session_id: sessionId } });
  }
  return sessionId;
}

export function resolveSessionRoot(environment = process.env) {
  const configured = environment.ARGUS_SESSION_ROOT;
  if (typeof configured !== 'string' || !configured.trim()) {
    throw new SessionStorageError('SESSION_ROOT_NOT_CONFIGURED', 'ARGUS_SESSION_ROOT must be configured for durable session storage');
  }
  return path.resolve(configured);
}

export class SessionStorage {
  #root;
  // Serialization is intentionally same-instance: one SessionStorage owner coordinates writes
  // for its process. Durable journal validation still rejects cross-process conflicting content.
  // Each session entry is removed when the newest queued append settles, so completed sessions
  // cannot accumulate permanently in memory.
  #scribeJournalChains = new Map();

  constructor({ root = resolveSessionRoot(), environment, faultInjector } = {}) {
    this.#root = path.resolve(root || resolveSessionRoot(environment));
    this.faultInjector = faultInjector;
  }

  get root() { return this.#root; }

  paths(sessionId) {
    validateSessionId(sessionId);
    const session = this.#insideRoot(path.join(this.#root, sessionId));
    const active = this.#insideRoot(path.join(session, 'active'));
    const permanent = this.#insideRoot(path.join(session, 'permanent'));
    return Object.freeze({
      root: this.#root,
      session,
      active,
      permanent,
      metadata: path.join(active, 'session.json'),
      transcriptActive: path.join(active, 'transcript.json'),
      loggedItemActive: path.join(active, 'logged-items.json'),
      transcriptOutbox: path.join(active, 'transcript.outbox.json'),
      finalization: path.join(active, 'finalization.json'),
      transcriptHistory: path.join(permanent, HISTORY_FILE_BY_KIND.transcript),
      loggedItemHistory: path.join(permanent, HISTORY_FILE_BY_KIND['logged-item']),
      closeEvidence: path.join(permanent, 'close.evidence.json'),
      scribeCheckpoint: path.join(active, 'scribe.checkpoint.json'),
      scribeGuidance: path.join(active, 'scribe.guidance.json'),
      scribeBatchJournal: path.join(permanent, 'scribe.batch-journal.ndjson'),
      recoveryBackups: this.#insideRoot(path.join(session, 'recovery-backups'))
    });
  }

  async ensureRoot() {
    await mkdir(this.#root, { recursive: true });
    const rootInfo = await lstat(this.#root);
    if (!rootInfo.isDirectory()) throw new SessionStorageError('SESSION_ROOT_NOT_DIRECTORY', 'ARGUS_SESSION_ROOT must resolve to a directory');
    this.#root = await realpath(this.#root);
    return this.#root;
  }

  async ensureSession(sessionId) {
    await this.ensureRoot();
    const paths = this.paths(sessionId);
    await mkdir(paths.session, { recursive: true });
    await this.#assertDirectory(paths.session, 'SESSION_FOLDER_SYMLINK');
    await mkdir(paths.active, { recursive: true });
    await mkdir(paths.permanent, { recursive: true });
    await this.#assertDirectory(paths.active, 'ACTIVE_FOLDER_SYMLINK');
    await this.#assertDirectory(paths.permanent, 'PERMANENT_FOLDER_SYMLINK');
    return paths;
  }

  async readMetadata(sessionId) {
    await this.ensureRoot();
    const paths = this.paths(sessionId);
    await this.#assertSafeSessionPaths(paths, ['metadata']);
    return this.#readJson(paths.metadata, { missing: undefined, label: 'session metadata' });
  }

  async writeMetadata(sessionId, metadata) {
    const paths = await this.ensureSession(sessionId);
    return this.#writeAtomic(paths.metadata, metadata);
  }

  async readActiveSnapshot(sessionId, kind) {
    await this.ensureRoot();
    const paths = this.paths(sessionId);
    const file = kind === 'transcript' ? paths.transcriptActive : kind === 'logged-item' ? paths.loggedItemActive : undefined;
    if (!file) throw new SessionStorageError('INVALID_ACTIVE_KIND', `Unsupported active snapshot kind: ${kind}`);
    await this.#assertSafeSessionPaths(paths, [kind === 'transcript' ? 'transcriptActive' : 'loggedItemActive']);
    return this.#readJson(file, { missing: undefined, label: `${kind} active snapshot` });
  }

  async writeActiveSnapshot(sessionId, kind, snapshot) {
    const paths = await this.ensureSession(sessionId);
    const file = kind === 'transcript' ? paths.transcriptActive : kind === 'logged-item' ? paths.loggedItemActive : undefined;
    if (!file) throw new SessionStorageError('INVALID_ACTIVE_KIND', `Unsupported active snapshot kind: ${kind}`);
    return this.#writeAtomic(file, snapshot);
  }

  async readFinalization(sessionId) {
    await this.ensureRoot();
    const paths = this.paths(sessionId);
    await this.#assertSafeSessionPaths(paths, ['finalization']);
    return this.#readJson(paths.finalization, { missing: undefined, label: 'finalization progress' });
  }

  async readTranscriptOutbox(sessionId) {
    await this.ensureRoot();
    const paths = this.paths(sessionId);
    await this.#assertSafeSessionPaths(paths, ['transcriptOutbox']);
    return this.#readJson(paths.transcriptOutbox, { missing: undefined, label: 'transcript pending outbox' });
  }

  async writeTranscriptOutbox(sessionId, outbox) {
    const paths = await this.ensureSession(sessionId);
    return this.#writeAtomic(paths.transcriptOutbox, outbox);
  }

  async writeFinalization(sessionId, progress) {
    const paths = await this.ensureSession(sessionId);
    return this.#writeAtomic(paths.finalization, progress);
  }

  async readCloseEvidence(sessionId) {
    await this.ensureRoot();
    const paths = this.paths(sessionId);
    await this.#assertSafeSessionPaths(paths, ['closeEvidence']);
    return this.#readJson(paths.closeEvidence, { missing: undefined, label: 'close evidence' });
  }

  async writeCloseEvidence(sessionId, evidence) {
    const paths = await this.ensureSession(sessionId);
    return this.#writeAtomic(paths.closeEvidence, evidence);
  }

  async readScribeCheckpoint(sessionId) {
    await this.ensureRoot();
    const paths = this.paths(sessionId);
    await this.#assertSafeSessionPaths(paths, ['scribeCheckpoint']);
    const checkpoint = await this.#readJson(paths.scribeCheckpoint, { missing: undefined, label: 'Scribe checkpoint' });
    if (checkpoint !== undefined) assertGovernedScribeCheckpointShape(sessionId, checkpoint);
    return checkpoint;
  }

  async writeScribeCheckpoint(sessionId, checkpoint) {
    assertGovernedScribeCheckpointShape(sessionId, checkpoint);
    const paths = await this.ensureSession(sessionId);
    return this.#writeAtomic(paths.scribeCheckpoint, checkpoint);
  }

  /**
   * The exact user Scribe guidance this session runs under.
   *
   * It lives with the session rather than beside the global setting because it must survive a
   * restart: without a durable per-session copy, resuming a session after the user edited their
   * guidance would silently prompt the model with wording that session never used.
   */
  async readScribeGuidance(sessionId) {
    await this.ensureRoot();
    const paths = this.paths(sessionId);
    await this.#assertSafeSessionPaths(paths, ['scribeGuidance']);
    const snapshot = await this.#readJson(paths.scribeGuidance, { missing: undefined, label: 'Scribe guidance snapshot' });
    if (snapshot !== undefined) assertGovernedScribeGuidanceShape(sessionId, snapshot);
    return snapshot;
  }

  async writeScribeGuidance(sessionId, snapshot) {
    assertGovernedScribeGuidanceShape(sessionId, snapshot);
    const paths = await this.ensureSession(sessionId);
    return this.#writeAtomic(paths.scribeGuidance, snapshot);
  }

  async readScribeBatchJournal(sessionId) {
    await this.ensureRoot();
    const paths = this.paths(sessionId);
    await this.#assertSafeSessionPaths(paths, ['scribeBatchJournal']);
    let content;
    try {
      content = await readFile(paths.scribeBatchJournal, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new SessionStorageError('SCRIBE_JOURNAL_READ_FAILED', `Unable to read Scribe batch journal: ${error.message}`, { retryable: true });
    }
    const entries = [];
    let expectedSequence = 0;
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch (error) {
        throw new SessionStorageError('SCRIBE_JOURNAL_INTEGRITY_FAILURE', `Scribe batch journal line ${index + 1} is not valid JSON`, { details: { cause: error.message } });
      }
      assertGovernedJournalEntryShape(sessionId, entry, index + 1);
      if (entry.journal_sequence !== expectedSequence) {
        throw new SessionStorageError('SCRIBE_JOURNAL_INTEGRITY_FAILURE', `Scribe batch journal line ${index + 1} has out-of-order journal_sequence ${entry.journal_sequence}; expected ${expectedSequence}`);
      }
      expectedSequence += 1;
      entries.push(entry);
    }
    return entries;
  }

  async appendScribeBatchJournal(sessionId, options = {}) {
    const previousChain = this.#scribeJournalChains.get(sessionId) || Promise.resolve();
    const runPromise = previousChain.catch(() => {}).then(() => this.#appendScribeBatchJournalExclusive(sessionId, options));
    this.#scribeJournalChains.set(sessionId, runPromise);
    try {
      return await runPromise;
    } finally {
      if (this.#scribeJournalChains.get(sessionId) === runPromise) this.#scribeJournalChains.delete(sessionId);
    }
  }

  memoryStats() {
    return { scribe_journal_chain_entries: this.#scribeJournalChains.size };
  }

  async #appendScribeBatchJournalExclusive(sessionId, { batch, writtenAt = new Date().toISOString() } = {}) {
    assertGovernedBatchEvaluatedShape(sessionId, batch, 'Scribe batch outcome');
    const paths = await this.ensureSession(sessionId);
    await this.#assertSafeSessionPaths(paths, ['scribeBatchJournal']);
    const existing = await this.readScribeBatchJournal(sessionId);
    const identityKey = `${batch.batch_identity.request_id}:${batch.attempt}`;
    const fingerprint = fingerprintValue(batch);
    const known = existing.find((entry) => `${entry.batch.batch_identity.request_id}:${entry.batch.attempt}` === identityKey);
    if (known) {
      if (fingerprintValue(known.batch) !== fingerprint) throw new SessionStorageError('SCRIBE_JOURNAL_REPLAY_CONFLICT', `Scribe batch ${identityKey} was already journaled with different content`);
      return { duplicate: true, entry: structuredClone(known) };
    }
    const ackConflict = existing.find((entry) => entry.batch.acknowledgement.ack_id === batch.acknowledgement.ack_id);
    if (ackConflict) throw new SessionStorageError('SCRIBE_JOURNAL_ACK_ID_CONFLICT', `Acknowledgement ${batch.acknowledgement.ack_id} was already recorded for a different Scribe batch`);
    const entry = {
      journal_sequence: existing.length,
      session_id: sessionId,
      batch: structuredClone(batch),
      written_at: writtenAt
    };
    await appendFile(paths.scribeBatchJournal, `${JSON.stringify(entry)}\n`, 'utf8');
    return { duplicate: false, entry };
  }

  async backupSessionFiles(sessionId, { backupId, fileNames = RECOVERY_BACKUP_FILE_NAMES } = {}) {
    if (typeof backupId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(backupId)) {
      throw new SessionStorageError('INVALID_RECOVERY_BACKUP_ID', 'Recovery backup id must be a safe path segment');
    }
    if (!Array.isArray(fileNames) || fileNames.some((name) => !RECOVERY_BACKUP_FILE_NAMES.includes(name))) {
      throw new SessionStorageError('INVALID_RECOVERY_BACKUP_FILE', 'Recovery backup file list is not governed');
    }
    const paths = await this.ensureSession(sessionId);
    await this.#assertSafeSessionPaths(paths, fileNames);
    await mkdir(paths.recoveryBackups, { recursive: true });
    await this.#assertDirectory(paths.recoveryBackups, 'RECOVERY_BACKUP_FOLDER_SYMLINK');
    const backupDirectory = this.#insideRoot(path.join(paths.recoveryBackups, backupId));
    await mkdir(backupDirectory, { recursive: true });
    await this.#assertDirectory(backupDirectory, 'RECOVERY_BACKUP_FOLDER_SYMLINK');

    const copied = [];
    for (const name of fileNames) {
      const source = paths[name];
      const destination = this.#insideRoot(path.join(backupDirectory, path.basename(source)));
      let sourceInfo;
      try { sourceInfo = await lstat(source); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) throw new SessionStorageError('SESSION_FILE_NOT_REGULAR', `Cannot back up non-regular session file: ${source}`);
      try {
        await access(destination);
        const [sourceContent, backupContent] = await Promise.all([readFile(source), readFile(destination)]);
        if (!sourceContent.equals(backupContent)) throw new SessionStorageError('RECOVERY_BACKUP_CONFLICT', `Recovery backup ${backupId} already contains different ${name}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await copyFile(source, destination);
      }
      copied.push({ name, file: path.basename(source) });
    }

    const manifest = {
      schema_version: STORAGE_SCHEMA_VERSION,
      backup_id: backupId,
      session_id: sessionId,
      files: copied
    };
    const manifestPath = path.join(backupDirectory, 'recovery-manifest.json');
    try {
      const existing = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (existing?.schema_version !== manifest.schema_version || existing?.backup_id !== backupId || existing?.session_id !== sessionId || JSON.stringify(existing?.files) !== JSON.stringify(copied)) {
        throw new SessionStorageError('RECOVERY_BACKUP_CONFLICT', `Recovery backup ${backupId} already contains a different manifest`);
      }
    } catch (error) {
      if (error instanceof SessionStorageError) throw error;
      if (error.code !== 'ENOENT') throw new SessionStorageError('RECOVERY_BACKUP_READ_FAILED', `Unable to read recovery backup manifest: ${error.message}`, { retryable: true });
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }
    return { backup_id: backupId, directory: backupDirectory, files: copied };
  }

  async readHistory(sessionId, kind) {
    await this.ensureRoot();
    const paths = this.paths(sessionId);
    const file = kind === 'transcript' ? paths.transcriptHistory : kind === 'logged-item' ? paths.loggedItemHistory : undefined;
    if (!file) throw new SessionStorageError('INVALID_HISTORY_KIND', `Unsupported history kind: ${kind}`);
    await this.#assertSafeSessionPaths(paths, [kind === 'transcript' ? 'transcriptHistory' : 'loggedItemHistory']);
    let content;
    try {
      content = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new SessionStorageError('HISTORY_READ_FAILED', `Unable to read ${kind} history: ${error.message}`, { retryable: true });
    }
    const records = [];
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch (error) {
        throw new SessionStorageError('HISTORY_INTEGRITY_FAILURE', `${kind} history line ${index + 1} is not valid JSON`, { details: { cause: error.message } });
      }
      if (record.storage_schema_version !== STORAGE_SCHEMA_VERSION || typeof record.history_entry_id !== 'string' || typeof record.session_id !== 'string' || !record.record || typeof record.fingerprint !== 'string') {
        throw new SessionStorageError('HISTORY_INTEGRITY_FAILURE', `${kind} history line ${index + 1} has an invalid storage record`);
      }
      if (record.session_id !== sessionId) throw new SessionStorageError('HISTORY_SESSION_CONFLICT', `${kind} history contains another session`, { details: { session_id: record.session_id } });
      if (fingerprintValue(record.record) !== record.fingerprint) throw new SessionStorageError('HISTORY_INTEGRITY_FAILURE', `${kind} history entry ${record.history_entry_id} has a bad fingerprint`);
      records.push(record);
    }
    return records;
  }

  async appendHistory(sessionId, kind, { historyEntryId, revision, record, appendedAt = new Date().toISOString() }) {
    if (typeof historyEntryId !== 'string' || !historyEntryId) throw new SessionStorageError('INVALID_HISTORY_ENTRY_ID', 'history_entry_id is required');
    if (!record || typeof record !== 'object') throw new SessionStorageError('INVALID_HISTORY_RECORD', 'history record must be an object');
    const paths = await this.ensureSession(sessionId);
    const existing = await this.readHistory(sessionId, kind);
    const fingerprint = fingerprintValue(record);
    const known = existing.find((entry) => entry.history_entry_id === historyEntryId);
    if (known) {
      if (known.fingerprint !== fingerprint) throw new SessionStorageError('IDEMPOTENT_INPUT_CONFLICT', `History entry ${historyEntryId} was reused with different content`);
      return { duplicate: true, entry: structuredClone(known) };
    }
    if (existing.some((entry) => entry.history_entry_id === historyEntryId)) throw new SessionStorageError('IDEMPOTENT_INPUT_CONFLICT', `History entry ${historyEntryId} was reused`);
    const entry = {
      storage_schema_version: STORAGE_SCHEMA_VERSION,
      history_entry_id: historyEntryId,
      session_id: sessionId,
      revision,
      appended_at: appendedAt,
      fingerprint,
      record: structuredClone(record)
    };
    const file = kind === 'transcript' ? paths.transcriptHistory : kind === 'logged-item' ? paths.loggedItemHistory : undefined;
    if (!file) throw new SessionStorageError('INVALID_HISTORY_KIND', `Unsupported history kind: ${kind}`);
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return { duplicate: false, entry };
  }

  async resolveHistory(sessionId, kind, historyEntryId) {
    const entry = (await this.readHistory(sessionId, kind)).find((item) => item.history_entry_id === historyEntryId);
    if (!entry) throw new SessionStorageError('HISTORY_ENTRY_NOT_FOUND', `Unknown ${kind} history entry ${historyEntryId}`, { details: { history_entry_id: historyEntryId } });
    return structuredClone(entry.record);
  }

  async hasFile(sessionId, name) {
    await this.ensureRoot();
    const paths = this.paths(sessionId);
    const target = paths[name];
    if (!target || !target.startsWith(`${paths.session}${path.sep}`)) throw new SessionStorageError('INVALID_STORAGE_PATH', `Unknown session storage file ${name}`);
    await this.#assertSafeSessionPaths(paths, [name]);
    try { await access(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  #insideRoot(target) {
    const resolved = path.resolve(target);
    const relative = path.relative(this.#root, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new SessionStorageError('SESSION_PATH_ESCAPE', 'Resolved session path escapes ARGUS_SESSION_ROOT', { details: { target: resolved } });
    }
    return resolved;
  }

  async #assertDirectory(target, code) {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new SessionStorageError(code, `Storage path is not a normal directory: ${target}`);
  }

  async #assertSafeSessionPaths(paths, files) {
    for (const directory of [paths.session, paths.active, paths.permanent]) {
      try {
        const info = await lstat(directory);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new SessionStorageError('SESSION_PATH_SYMLINK', `Storage directory is not a normal directory: ${directory}`);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
    }
    for (const fileName of files) {
      const file = paths[fileName];
      if (!file) continue;
      try {
        const info = await lstat(file);
        if (info.isSymbolicLink()) throw new SessionStorageError('SESSION_FILE_SYMLINK', `Storage file is a symbolic link: ${file}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  async #readJson(file, { missing, label }) {
    let content;
    try { content = await readFile(file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return missing;
      throw new SessionStorageError('SNAPSHOT_READ_FAILED', `Unable to read ${label}: ${error.message}`, { retryable: true });
    }
    try { return JSON.parse(content); }
    catch (error) { throw new SessionStorageError('SNAPSHOT_INTEGRITY_FAILURE', `${label} is not valid JSON`, { details: { cause: error.message } }); }
  }

  async #writeAtomic(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await rename(temporary, file);
    } catch (error) {
      try { await import('node:fs/promises').then(({ unlink }) => unlink(temporary)); } catch { /* best effort cleanup */ }
      throw new SessionStorageError('SNAPSHOT_WRITE_FAILED', `Unable to atomically replace ${path.basename(file)}: ${error.message}`, { retryable: true });
    }
  }
}

function isNonEmptyString(value) { return typeof value === 'string' && value.length > 0; }
function isNonNegativeInteger(value) { return Number.isInteger(value) && value >= 0; }

function assertGovernedBatchIdentityShape(sessionId, identity, label) {
  if (!identity || typeof identity !== 'object') throw new SessionStorageError('SCRIBE_BATCH_IDENTITY_INVALID', `${label} batch_identity must be an object`);
  const allowed = new Set(['request_id', 'session_id', 'segments', 'first_sequence', 'last_sequence', 'admission_reason', 'policy_id', 'policy_version', 'instruction_version']);
  if (Object.keys(identity).some((key) => !allowed.has(key))) throw new SessionStorageError('SCRIBE_BATCH_IDENTITY_INVALID', `${label} batch_identity has an undeclared field`);
  if (!isNonEmptyString(identity.request_id)) throw new SessionStorageError('SCRIBE_BATCH_IDENTITY_INVALID', `${label} batch_identity.request_id is required`);
  if (identity.session_id !== sessionId) throw new SessionStorageError('SCRIBE_BATCH_SESSION_CONFLICT', `${label} batch_identity targets a different session`, { details: { session_id: identity.session_id } });
  if (!Array.isArray(identity.segments) || identity.segments.length < 1 || identity.segments.length > SCRIBE_BATCH_IDENTITY_MAX_SEGMENTS) {
    throw new SessionStorageError('SCRIBE_BATCH_IDENTITY_INVALID', `${label} batch_identity.segments must contain 1-${SCRIBE_BATCH_IDENTITY_MAX_SEGMENTS} entries`);
  }
  for (const entry of identity.segments) {
    const keysOk = entry && typeof entry === 'object' && Object.keys(entry).every((key) => ['segment_id', 'revision', 'sequence'].includes(key));
    if (!keysOk || !isNonEmptyString(entry.segment_id) || !isNonNegativeInteger(entry.revision) || !isNonNegativeInteger(entry.sequence)) {
      throw new SessionStorageError('SCRIBE_BATCH_IDENTITY_INVALID', `${label} batch_identity.segments contains an invalid entry`);
    }
  }
  if (new Set(identity.segments.map((entry) => entry.segment_id)).size !== identity.segments.length) {
    throw new SessionStorageError('SCRIBE_BATCH_IDENTITY_INVALID', `${label} batch_identity.segments must not repeat a segment_id`);
  }
  for (let index = 1; index < identity.segments.length; index += 1) {
    if (identity.segments[index].sequence !== identity.segments[index - 1].sequence + 1) {
      throw new SessionStorageError('SCRIBE_BATCH_IDENTITY_INVALID', `${label} batch_identity.segments must be ordered and contiguous by ascending sequence`);
    }
  }
  if (!isNonNegativeInteger(identity.first_sequence) || !isNonNegativeInteger(identity.last_sequence)
    || identity.first_sequence !== identity.segments[0].sequence || identity.last_sequence !== identity.segments.at(-1).sequence) {
    throw new SessionStorageError('SCRIBE_BATCH_IDENTITY_INVALID', `${label} batch_identity.first_sequence/last_sequence must match the segment list's actual bounds`);
  }
  if (!SCRIBE_ADMISSION_REASON_VALUES.has(identity.admission_reason)) throw new SessionStorageError('SCRIBE_BATCH_IDENTITY_INVALID', `${label} batch_identity.admission_reason is invalid`);
  if (!isNonEmptyString(identity.policy_id) || !isNonEmptyString(identity.policy_version) || !isNonEmptyString(identity.instruction_version)) {
    throw new SessionStorageError('SCRIBE_BATCH_IDENTITY_INVALID', `${label} batch_identity policy/instruction identity is invalid`);
  }
}

function assertGovernedScribeItem(item, label, { requireUniqueSourceSegments = false, allowedSourceSegmentIds } = {}) {
  const allowed = new Set(['text', 'kind', 'source_segment_ids']);
  if (!item || typeof item !== 'object' || Object.keys(item).some((key) => !allowed.has(key))) throw new SessionStorageError('SCRIBE_ITEM_INVALID', `${label} item has an undeclared field`);
  if (!isNonEmptyString(item.text) || item.text.length > SCRIBE_ITEM_TEXT_MAX_LENGTH) throw new SessionStorageError('SCRIBE_ITEM_INVALID', `${label} item.text must be 1-${SCRIBE_ITEM_TEXT_MAX_LENGTH} characters`);
  if (item.kind !== undefined && !SCRIBE_ITEM_KIND_VALUES.has(item.kind)) throw new SessionStorageError('SCRIBE_ITEM_INVALID', `${label} item.kind is invalid`);
  const ids = item.source_segment_ids;
  const idsValid = Array.isArray(ids) && ids.length >= 1 && ids.every((id) => isNonEmptyString(id)) && (!requireUniqueSourceSegments || new Set(ids).size === ids.length);
  if (!idsValid) throw new SessionStorageError('SCRIBE_ITEM_INVALID', `${label} item.source_segment_ids is not governed`);
  if (allowedSourceSegmentIds && ids.some((id) => !allowedSourceSegmentIds.has(id))) {
    throw new SessionStorageError('SCRIBE_ITEM_SOURCE_OUT_OF_BATCH', `${label} item cites a source_segment_id outside the batch's evidence`);
  }
}

function assertGovernedBatchEvaluatedShape(sessionId, batch, label) {
  if (!batch || typeof batch !== 'object') throw new SessionStorageError('SCRIBE_BATCH_EVALUATED_INVALID', `${label} must be an object`);
  const allowed = new Set(['batch_identity', 'evaluated_at', 'attempt', 'outcome', 'items', 'error', 'acknowledgement']);
  if (Object.keys(batch).some((key) => !allowed.has(key))) throw new SessionStorageError('SCRIBE_BATCH_EVALUATED_INVALID', `${label} has an undeclared field`);
  assertGovernedBatchIdentityShape(sessionId, batch.batch_identity, label);
  if (!isNonEmptyString(batch.evaluated_at)) throw new SessionStorageError('SCRIBE_BATCH_EVALUATED_INVALID', `${label}.evaluated_at is required`);
  if (!Number.isInteger(batch.attempt) || batch.attempt < 1) throw new SessionStorageError('SCRIBE_BATCH_EVALUATED_INVALID', `${label}.attempt must be a positive integer`);
  if (!SCRIBE_OUTCOME_VALUES.has(batch.outcome)) throw new SessionStorageError('SCRIBE_BATCH_EVALUATED_INVALID', `${label}.outcome is invalid`);
  if (!Array.isArray(batch.items) || batch.items.length > SCRIBE_BATCH_EVALUATED_MAX_ITEMS) throw new SessionStorageError('SCRIBE_BATCH_EVALUATED_INVALID', `${label}.items must be an array of at most ${SCRIBE_BATCH_EVALUATED_MAX_ITEMS} entries`);
  const allowedSourceSegmentIds = new Set(batch.batch_identity.segments.map((segment) => segment.segment_id));
  for (const item of batch.items) assertGovernedScribeItem(item, label, { requireUniqueSourceSegments: true, allowedSourceSegmentIds });
  if (batch.outcome === 'empty-evaluated' && batch.items.length !== 0) throw new SessionStorageError('SCRIBE_BATCH_EVALUATED_INVALID', `${label} outcome empty-evaluated must carry zero items`);
  if (batch.outcome === 'items-recorded' && batch.items.length < 1) throw new SessionStorageError('SCRIBE_BATCH_EVALUATED_INVALID', `${label} outcome items-recorded must carry at least one item`);
  if (batch.outcome === 'failed' || batch.error !== undefined) {
    const error = batch.error;
    const allowedError = new Set(['code', 'category', 'message', 'retryable']);
    if (!error || typeof error !== 'object' || Object.keys(error).some((key) => !allowedError.has(key)) || !isNonEmptyString(error.code) || !isNonEmptyString(error.category) || !isNonEmptyString(error.message) || typeof error.retryable !== 'boolean') {
      throw new SessionStorageError('SCRIBE_BATCH_EVALUATED_INVALID', `${label}.error is not governed`);
    }
  }
  const ack = batch.acknowledgement;
  const allowedAck = new Set(['ack_id', 'accepted', 'acknowledged_at', 'logged_item_ids']);
  if (!ack || typeof ack !== 'object' || Object.keys(ack).some((key) => !allowedAck.has(key)) || !isNonEmptyString(ack.ack_id) || typeof ack.accepted !== 'boolean'
    || !(ack.acknowledged_at === null || typeof ack.acknowledged_at === 'string') || !Array.isArray(ack.logged_item_ids)
    || ack.logged_item_ids.some((id) => !isNonEmptyString(id)) || new Set(ack.logged_item_ids).size !== ack.logged_item_ids.length) {
    throw new SessionStorageError('SCRIBE_BATCH_EVALUATED_INVALID', `${label}.acknowledgement is not governed`);
  }
  if (ack.accepted === true && !isNonEmptyString(ack.acknowledged_at)) throw new SessionStorageError('SCRIBE_BATCH_EVALUATED_INVALID', `${label}.acknowledgement.accepted requires a durable acknowledged_at timestamp`);
  const acknowledgesItems = batch.outcome === 'items-recorded' && ack.accepted === true;
  if (!acknowledgesItems && ack.logged_item_ids.length !== 0) throw new SessionStorageError('SCRIBE_BATCH_EVALUATED_INVALID', `${label}.acknowledgement.logged_item_ids must be empty unless items were recorded and accepted`);
  if (acknowledgesItems && ack.logged_item_ids.length < 1) throw new SessionStorageError('SCRIBE_BATCH_EVALUATED_INVALID', `${label}.acknowledgement.logged_item_ids must be non-empty when items were recorded and accepted`);
  if (acknowledgesItems && ack.logged_item_ids.length !== batch.items.length) {
    throw new SessionStorageError('SCRIBE_ACKNOWLEDGEMENT_MAPPING_INVALID', `${label}.acknowledgement.logged_item_ids must correspond one-for-one with items (${batch.items.length} expected, received ${ack.logged_item_ids.length})`);
  }
}

export function assertGovernedScribeCheckpointShape(sessionId, checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') throw new SessionStorageError('SCRIBE_CHECKPOINT_INVALID', 'Scribe checkpoint must be an object');
  const allowed = new Set(['schema_version', 'session_id', 'saved_at', 'admitted_through', 'pending_partial', 'background_context', 'policy_id', 'policy_version', 'in_flight_batch', 'last_evaluated_batch']);
  if (Object.keys(checkpoint).some((key) => !allowed.has(key))) throw new SessionStorageError('SCRIBE_CHECKPOINT_INVALID', 'Scribe checkpoint has an undeclared field');
  if (checkpoint.schema_version !== SCRIBE_CHECKPOINT_SCHEMA_VERSION) throw new SessionStorageError('SCRIBE_CHECKPOINT_INVALID', `Scribe checkpoint schema_version must be ${SCRIBE_CHECKPOINT_SCHEMA_VERSION}`);
  if (checkpoint.session_id !== sessionId) throw new SessionStorageError('SCRIBE_CHECKPOINT_SESSION_CONFLICT', 'Scribe checkpoint targets a different session', { details: { session_id: checkpoint.session_id } });
  if (!isNonEmptyString(checkpoint.saved_at)) throw new SessionStorageError('SCRIBE_CHECKPOINT_INVALID', 'Scribe checkpoint.saved_at is required');

  const admitted = checkpoint.admitted_through;
  const allowedAdmitted = new Set(['last_segment_id', 'last_sequence', 'last_revision']);
  if (!admitted || typeof admitted !== 'object' || Object.keys(admitted).some((key) => !allowedAdmitted.has(key))
    || !(admitted.last_segment_id === null || typeof admitted.last_segment_id === 'string')
    || !Number.isInteger(admitted.last_sequence) || admitted.last_sequence < -1
    || !isNonNegativeInteger(admitted.last_revision)) {
    throw new SessionStorageError('SCRIBE_CHECKPOINT_INVALID', 'Scribe checkpoint.admitted_through is not governed');
  }

  const pending = checkpoint.pending_partial;
  const allowedPending = new Set(['segments', 'accumulated_since']);
  if (!pending || typeof pending !== 'object' || Object.keys(pending).some((key) => !allowedPending.has(key))
    || !Array.isArray(pending.segments) || pending.segments.length > SCRIBE_CHECKPOINT_PENDING_MAX_SEGMENTS
    || !(pending.accumulated_since === null || typeof pending.accumulated_since === 'string')) {
    throw new SessionStorageError('SCRIBE_CHECKPOINT_INVALID', 'Scribe checkpoint.pending_partial is not governed');
  }
  if (pending.segments.length > 0 && pending.accumulated_since === null) {
    throw new SessionStorageError('SCRIBE_CHECKPOINT_INVALID', 'Scribe checkpoint.pending_partial.accumulated_since is required while segments are pending');
  }
  if (pending.segments.length === 0 && pending.accumulated_since !== null) {
    throw new SessionStorageError('SCRIBE_CHECKPOINT_INVALID', 'Scribe checkpoint.pending_partial.accumulated_since must be null while no segments are pending');
  }
  for (const entry of pending.segments) {
    const keysOk = entry && typeof entry === 'object' && Object.keys(entry).every((key) => ['segment_id', 'revision', 'sequence'].includes(key));
    if (!keysOk || !isNonEmptyString(entry.segment_id) || !isNonNegativeInteger(entry.revision) || !isNonNegativeInteger(entry.sequence)) {
      throw new SessionStorageError('SCRIBE_CHECKPOINT_INVALID', 'Scribe checkpoint.pending_partial.segments contains an invalid entry');
    }
    if (entry.sequence <= admitted.last_sequence) {
      throw new SessionStorageError('SCRIBE_CHECKPOINT_INVALID', 'Scribe checkpoint.pending_partial.segments contains a sequence at or behind the acknowledged cursor');
    }
  }

  const background = checkpoint.background_context;
  if (!background || typeof background !== 'object' || Object.keys(background).some((key) => key !== 'prior_logged_items') || !Array.isArray(background.prior_logged_items)
    || background.prior_logged_items.length > SCRIBE_CHECKPOINT_BACKGROUND_ITEMS_MAX) {
    throw new SessionStorageError('SCRIBE_CHECKPOINT_INVALID', `Scribe checkpoint.background_context.prior_logged_items must not exceed ${SCRIBE_CHECKPOINT_BACKGROUND_ITEMS_MAX} entries`);
  }
  for (const item of background.prior_logged_items) assertGovernedScribeItem(item, 'Scribe checkpoint.background_context.prior_logged_items');

  if (!isNonEmptyString(checkpoint.policy_id) || !isNonEmptyString(checkpoint.policy_version)) throw new SessionStorageError('SCRIBE_CHECKPOINT_INVALID', 'Scribe checkpoint policy identity is invalid');

  if (checkpoint.in_flight_batch !== undefined) {
    const inFlight = checkpoint.in_flight_batch;
    const allowedInFlight = new Set(['batch_identity', 'attempt', 'dispatched_at']);
    if (!inFlight || typeof inFlight !== 'object' || Object.keys(inFlight).some((key) => !allowedInFlight.has(key)) || !Number.isInteger(inFlight.attempt) || inFlight.attempt < 1 || !isNonEmptyString(inFlight.dispatched_at)) {
      throw new SessionStorageError('SCRIBE_CHECKPOINT_INVALID', 'Scribe checkpoint.in_flight_batch is not governed');
    }
    assertGovernedBatchIdentityShape(sessionId, inFlight.batch_identity, 'Scribe checkpoint.in_flight_batch');
  }

  if (checkpoint.last_evaluated_batch !== undefined) {
    assertGovernedBatchEvaluatedShape(sessionId, checkpoint.last_evaluated_batch, 'Scribe checkpoint.last_evaluated_batch');
  }
}

export function assertGovernedScribeGuidanceShape(sessionId, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new SessionStorageError('SCRIBE_GUIDANCE_INVALID', 'Scribe guidance snapshot must be an object');
  const allowed = new Set(['schema_version', 'session_id', 'saved_at', 'additional_guidance', 'guidance_fingerprint', 'instruction_version']);
  if (Object.keys(snapshot).some((key) => !allowed.has(key))) throw new SessionStorageError('SCRIBE_GUIDANCE_INVALID', 'Scribe guidance snapshot has an undeclared field');
  if (!SCRIBE_GUIDANCE_SNAPSHOT_SCHEMA_VERSIONS.has(snapshot.schema_version)) throw new SessionStorageError('SCRIBE_GUIDANCE_INVALID', `Scribe guidance snapshot.schema_version must be one of: ${[...SCRIBE_GUIDANCE_SNAPSHOT_SCHEMA_VERSIONS].join(', ')}`);
  if (snapshot.session_id !== sessionId) throw new SessionStorageError('SCRIBE_GUIDANCE_SESSION_CONFLICT', 'Scribe guidance snapshot targets a different session', { details: { session_id: snapshot.session_id } });
  if (!isNonEmptyString(snapshot.saved_at)) throw new SessionStorageError('SCRIBE_GUIDANCE_INVALID', 'Scribe guidance snapshot.saved_at is required');
  if (typeof snapshot.additional_guidance !== 'string' || snapshot.additional_guidance.length > SCRIBE_GUIDANCE_SNAPSHOT_MAX_CHARS) {
    throw new SessionStorageError('SCRIBE_GUIDANCE_INVALID', `Scribe guidance snapshot.additional_guidance must be text of at most ${SCRIBE_GUIDANCE_SNAPSHOT_MAX_CHARS} characters`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(snapshot.guidance_fingerprint || '')) throw new SessionStorageError('SCRIBE_GUIDANCE_INVALID', 'Scribe guidance snapshot.guidance_fingerprint is invalid');
  if (snapshot.guidance_fingerprint !== fingerprintScribeGuidance(snapshot.additional_guidance)) {
    throw new SessionStorageError('SCRIBE_GUIDANCE_FINGERPRINT_CONFLICT', 'Scribe guidance snapshot fingerprint does not match its guidance text');
  }
  if (snapshot.schema_version === SCRIBE_GUIDANCE_SNAPSHOT_SCHEMA_VERSION && !isNonEmptyString(snapshot.instruction_version)) {
    throw new SessionStorageError('SCRIBE_GUIDANCE_INVALID', 'Scribe guidance snapshot.instruction_version is required');
  }
}

function assertGovernedJournalEntryShape(sessionId, entry, lineNumber) {
  if (!entry || typeof entry !== 'object') throw new SessionStorageError('SCRIBE_JOURNAL_INTEGRITY_FAILURE', `Scribe batch journal line ${lineNumber} is not a governed entry`);
  const allowed = new Set(['journal_sequence', 'session_id', 'batch', 'written_at']);
  if (Object.keys(entry).some((key) => !allowed.has(key))) throw new SessionStorageError('SCRIBE_JOURNAL_INTEGRITY_FAILURE', `Scribe batch journal line ${lineNumber} has an undeclared field`);
  if (!isNonNegativeInteger(entry.journal_sequence)) throw new SessionStorageError('SCRIBE_JOURNAL_INTEGRITY_FAILURE', `Scribe batch journal line ${lineNumber} has an invalid journal_sequence`);
  if (entry.session_id !== sessionId) throw new SessionStorageError('SCRIBE_JOURNAL_SESSION_CONFLICT', `Scribe batch journal line ${lineNumber} contains another session`, { details: { session_id: entry.session_id } });
  if (!isNonEmptyString(entry.written_at)) throw new SessionStorageError('SCRIBE_JOURNAL_INTEGRITY_FAILURE', `Scribe batch journal line ${lineNumber} has an invalid written_at`);
  assertGovernedBatchEvaluatedShape(sessionId, entry.batch, `Scribe batch journal line ${lineNumber}`);
}

export function fingerprintValue(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
