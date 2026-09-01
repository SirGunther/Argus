import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

const MAX_STRING_LENGTH = 240;
const MAX_TRANSCRIPT_PREVIEW_LENGTH = 160;
const MAX_ARRAY_ITEMS = 16;
const MAX_OBJECT_KEYS = 32;
const MAX_DEPTH = 4;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILE_ROTATIONS = 2;

const SENSITIVE_KEY = /^(?:audio(?:base64|data|bytes|buffer)?|pcm(?:base64|data|bytes|buffer)?|raw(?:audio|samples?)(?:base64|data|bytes|buffer)?|samples?|bytes?|buffer|payload|waveform|apikey|secret|password|authorization|accesstoken|refreshtoken|credential|cookie|headers?|environment|env)$/i;
const SENSITIVE_KEY_PART = /(?:apikey|secret|password|authorization|accesstoken|refreshtoken|credential|cookie|headers?|environment|^env|env$)/i;
const AUDIO_BASE64_TEXT = /(?:["']?(?:audio|pcm)[_-]?base64["']?\s*[:=]\s*["']?)[A-Za-z0-9+/=]+/gi;

/**
 * Synchronously tees sanitized JSONL to the launching terminal and a bounded,
 * rotating file. Synchronous writes keep a diagnostic record correlated with
 * the transition that produced it; all file errors are intentionally ignored
 * so diagnostics can never stop the application pipeline.
 */
export function createDiagnosticFileOutput({ filePath, terminal = process.stderr, maxBytes = DEFAULT_MAX_FILE_BYTES, maxRotations = DEFAULT_MAX_FILE_ROTATIONS } = {}) {
  if (!filePath) throw new TypeError('filePath is required');
  const absolutePath = path.resolve(filePath);
  const boundedBytes = Number(maxBytes) > 0 ? Number(maxBytes) : DEFAULT_MAX_FILE_BYTES;
  const rotations = maxRotations === undefined ? DEFAULT_MAX_FILE_ROTATIONS : Math.max(0, Math.floor(Number(maxRotations) || 0));
  let descriptor;
  let currentBytes = 0;
  let closed = false;

  function open() {
    try {
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      if (existsSync(absolutePath) && statSync(absolutePath).size >= boundedBytes) rotate();
      descriptor = openSync(absolutePath, 'a');
      currentBytes = statSync(absolutePath).size;
    } catch {
      descriptor = undefined;
      currentBytes = 0;
    }
  }

  function rotate() {
    try { if (descriptor !== undefined) closeSync(descriptor); } catch { /* best effort */ }
    descriptor = undefined;
    if (!rotations) {
      try { if (existsSync(absolutePath)) unlinkSync(absolutePath); } catch { /* best effort */ }
      currentBytes = 0;
      return;
    }
    for (let index = rotations; index >= 2; index -= 1) {
      const source = `${absolutePath}.${index - 1}`;
      const target = `${absolutePath}.${index}`;
      try { if (existsSync(target)) unlinkSync(target); } catch { /* absent */ }
      try { if (existsSync(source)) renameSync(source, target); } catch { /* best effort */ }
    }
    try { if (existsSync(`${absolutePath}.1`)) unlinkSync(`${absolutePath}.1`); } catch { /* absent */ }
    try { if (existsSync(absolutePath)) renameSync(absolutePath, `${absolutePath}.1`); } catch { /* best effort */ }
    currentBytes = 0;
  }

  function write(line) {
    if (closed) return;
    try { terminal?.write?.(line); } catch { /* terminal diagnostics are best effort */ }
    try {
      const bytes = Buffer.byteLength(String(line));
      if (bytes > boundedBytes) return;
      if (descriptor === undefined) open();
      if (descriptor === undefined) return;
      if (currentBytes + bytes > boundedBytes) {
        rotate();
        open();
      }
      if (descriptor !== undefined && currentBytes + bytes <= boundedBytes) {
        writeSync(descriptor, String(line));
        currentBytes += bytes;
      }
    } catch { /* file diagnostics must never affect application behavior */ }
  }

  function close() {
    if (closed) return;
    closed = true;
    try { if (descriptor !== undefined) closeSync(descriptor); } catch { /* best effort */ }
    descriptor = undefined;
  }

  open();
  return Object.freeze({ write, close, filePath: absolutePath, maxBytes: boundedBytes, maxRotations: rotations });
}

export function installProcessDiagnosticHandlers(logger) {
  if (!logger?.enabled) return () => {};
  const onUnhandledRejection = (reason) => {
    logger.log('process.unhandled-rejection', diagnosticErrorDetails(reason));
    // Preserve Node's normal fail-fast behavior after recording the condition.
    throw reason instanceof Error ? reason : new Error(String(reason));
  };
  const onUncaughtException = (error) => logger.log('process.uncaught-exception', diagnosticErrorDetails(error));
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtExceptionMonitor', onUncaughtException);
  return () => {
    process.off('unhandledRejection', onUnhandledRejection);
    process.off('uncaughtExceptionMonitor', onUncaughtException);
  };
}

export function diagnosticErrorDetails(error) {
  return {
    error_code: error?.code,
    error_name: error?.name,
    error: String(error?.message || error || 'Unknown error').slice(0, MAX_STRING_LENGTH)
  };
}

export function createDiagnosticLogger({ enabled = false, output = process.stderr, clock = () => new Date().toISOString(), source = 'argus' } = {}) {
  function log(event, details = {}) {
    if (!enabled) return;
    const record = {
      timestamp: clock(),
      event: String(event || 'diagnostic'),
      source,
      ...sanitizeDiagnosticDetails(details)
    };
    try { output.write(`${JSON.stringify(record)}\n`); } catch { /* diagnostics must never stop the pipeline */ }
  }

  function ingest(line, fallbackEvent = 'service.stderr') {
    if (!enabled || !String(line || '').trim()) return;
    try {
      const parsed = JSON.parse(String(line));
      if (parsed && typeof parsed === 'object' && !parsed.event && parsed.service && parsed.operation && ['started', 'completed', 'duplicate-replayed'].includes(parsed.status)) return;
      const { event, timestamp: _timestamp, source: childSource, ...details } = parsed && typeof parsed === 'object' ? parsed : {};
      log(event || fallbackEvent, { ...details, ...(childSource ? { child_source: childSource } : {}) });
    } catch {
      log(fallbackEvent, { message: String(line) });
    }
  }

  return Object.freeze({ enabled, log, ingest });
}

export function sanitizeDiagnosticDetails(value, key = '', depth = 0) {
  const normalizedKey = String(key || '').replace(/[_-]/g, '').toLowerCase();
  if (SENSITIVE_KEY.test(normalizedKey) || SENSITIVE_KEY_PART.test(normalizedKey) || normalizedKey.includes('base64')) return undefined;
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const limit = /(?:preview|text)$/i.test(key) ? MAX_TRANSCRIPT_PREVIEW_LENGTH : MAX_STRING_LENGTH;
    return value.replace(AUDIO_BASE64_TEXT, '[redacted-audio]').slice(0, limit);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeDiagnosticDetails(item, key, depth + 1));
  if (typeof value === 'object') {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      const sanitized = sanitizeDiagnosticDetails(childValue, childKey, depth + 1);
      if (sanitized !== undefined) result[childKey] = sanitized;
    }
    return result;
  }
  return String(value).slice(0, MAX_STRING_LENGTH);
}

export const DIAGNOSTIC_LIMITS = Object.freeze({ MAX_STRING_LENGTH, MAX_TRANSCRIPT_PREVIEW_LENGTH, MAX_FILE_BYTES: DEFAULT_MAX_FILE_BYTES, MAX_FILE_ROTATIONS: DEFAULT_MAX_FILE_ROTATIONS });
