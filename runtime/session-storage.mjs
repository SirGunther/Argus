import { createHash } from 'node:crypto';
import { access, appendFile, mkdir, readFile, rename, writeFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const STORAGE_SCHEMA_VERSION = '1.0.0';
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
      closeEvidence: path.join(permanent, 'close.evidence.json')
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

export function fingerprintValue(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
