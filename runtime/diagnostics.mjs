const MAX_STRING_LENGTH = 240;
const MAX_TRANSCRIPT_PREVIEW_LENGTH = 160;
const MAX_ARRAY_ITEMS = 16;
const MAX_OBJECT_KEYS = 32;
const MAX_DEPTH = 4;

const SENSITIVE_KEY = /^(?:audio_base64|pcm|samples?|raw_samples?|bytes?|buffer|payload|audio_data|waveform|api[_-]?key|secret|password|authorization|access[_-]?token|refresh[_-]?token|credential|cookie|headers?)$/i;
const AUDIO_BASE64_TEXT = /(?:["']?audio_base64["']?\s*[:=]\s*["']?)[A-Za-z0-9+/=]+/gi;

export function createDiagnosticLogger({ enabled = false, output = process.stderr, clock = () => new Date().toISOString(), source = 'argus' } = {}) {
  function log(event, details = {}) {
    if (!enabled) return;
    const record = {
      timestamp: clock(),
      event: String(event || 'diagnostic'),
      source,
      ...sanitizeDiagnosticDetails(details)
    };
    output.write(`${JSON.stringify(record)}\n`);
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
  if (SENSITIVE_KEY.test(key)) return undefined;
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

export const DIAGNOSTIC_LIMITS = Object.freeze({ MAX_STRING_LENGTH, MAX_TRANSCRIPT_PREVIEW_LENGTH });
