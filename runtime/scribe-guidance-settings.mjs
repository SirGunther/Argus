import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SCRIBE_GUIDANCE_LIMITS, fingerprintScribeGuidance } from '../contracts/model-protocol.mjs';

export const SCRIBE_GUIDANCE_SETTINGS_VERSION = 1;
export const SCRIBE_GUIDANCE_MAX_CHARS = SCRIBE_GUIDANCE_LIMITS.max_chars;

/** Blank guidance is the governed default: Scribe runs on its protected instruction alone. */
export const DEFAULT_SCRIBE_GUIDANCE_SETTINGS = Object.freeze({
  version: SCRIBE_GUIDANCE_SETTINGS_VERSION,
  additional_guidance: ''
});

export class ScribeGuidanceConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScribeGuidanceConfigurationError';
    this.code = 'INVALID_SCRIBE_GUIDANCE';
    this.category = 'validation';
    this.retryable = false;
  }
}

export function scribeGuidanceError(message) { return new ScribeGuidanceConfigurationError(message); }

/**
 * Validate and normalize the one non-secret Scribe guidance record.
 *
 * Guidance is ordinary user preference text, never a credential, so this object is safe to persist
 * as plain JSON and to return to the renderer. Over-limit guidance is rejected rather than
 * shortened: silently trimming it would prompt the model under wording the user never approved.
 */
export function normalizeScribeGuidanceSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw scribeGuidanceError('Scribe guidance settings must be an object');
  const keys = Object.keys(input);
  if (keys.some((key) => /key|secret|token|password|credential/i.test(key))) {
    throw scribeGuidanceError('Scribe guidance settings must not contain credential fields');
  }
  const allowed = new Set(['version', 'additional_guidance', 'additionalGuidance']);
  if (keys.some((key) => !allowed.has(key))) throw scribeGuidanceError('Scribe guidance settings contain an undeclared field');
  if (input.version !== undefined && input.version !== SCRIBE_GUIDANCE_SETTINGS_VERSION) {
    throw scribeGuidanceError(`Scribe guidance settings version must be ${SCRIBE_GUIDANCE_SETTINGS_VERSION}`);
  }
  const raw = input.additional_guidance ?? input.additionalGuidance ?? '';
  if (typeof raw !== 'string') throw scribeGuidanceError('Scribe guidance must be text');
  const guidance = raw.trim();
  if (guidance.length > SCRIBE_GUIDANCE_MAX_CHARS) {
    throw scribeGuidanceError(`Scribe guidance must be at most ${SCRIBE_GUIDANCE_MAX_CHARS} characters; it is ${guidance.length}`);
  }
  // A control character would travel verbatim into the prompt and can forge the visual structure
  // the instruction relies on; ordinary whitespace (newlines, tabs) stays allowed.
  for (const character of guidance) {
    const code = character.codePointAt(0);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) throw scribeGuidanceError('Scribe guidance must not contain control characters');
  }
  return Object.freeze({ version: SCRIBE_GUIDANCE_SETTINGS_VERSION, additional_guidance: guidance });
}

/**
 * Stable identity for one guidance value. A session pins this fingerprint, so a later edit to the
 * global setting is visible as a different identity rather than an unnoticed substitution.
 */
export function scribeGuidanceFingerprint(guidance) {
  return fingerprintScribeGuidance(guidance);
}

/** Ordinary JSON store for the non-secret Scribe guidance record. It refuses credential-shaped fields. */
export function createScribeGuidanceSettingsStore({ filePath } = {}) {
  if (!filePath) throw new TypeError('scribe guidance settings filePath is required');
  const target = path.resolve(filePath);
  return Object.freeze({
    async load() {
      try {
        const parsed = JSON.parse(await readFile(target, 'utf8'));
        if (Object.keys(parsed).some((key) => /key|secret|token|password|credential/i.test(key))) throw scribeGuidanceError('Stored Scribe guidance contains a forbidden credential field');
        return normalizeScribeGuidanceSettings(parsed);
      } catch (error) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async save(settings) {
      const normalized = normalizeScribeGuidanceSettings(settings);
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
      return normalized;
    },
    async remove() {
      try { await unlink(target); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  });
}
