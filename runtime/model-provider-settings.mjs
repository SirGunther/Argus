import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MODEL_PROVIDER_SETTINGS_VERSION = 1;
export const LOCAL_MODEL_PROVIDERS = Object.freeze(['ollama', 'lm-studio']);
export const EXTERNAL_MODEL_PROVIDERS = Object.freeze(['openai-compatible']);
export const MODEL_PROVIDER_MODES = Object.freeze(['local', 'external']);

export const DEFAULT_MODEL_PROVIDER_SETTINGS = Object.freeze({
  version: MODEL_PROVIDER_SETTINGS_VERSION,
  mode: 'local',
  provider: 'ollama',
  endpoint: 'http://127.0.0.1:11434/api/generate',
  model: 'llama3.2:3b',
  protocol: 'ollama',
  timeout_ms: 120000
});

export const DEFAULT_LOCAL_MODEL_SETTINGS = Object.freeze({
  ollama: DEFAULT_MODEL_PROVIDER_SETTINGS,
  'lm-studio': Object.freeze({
    version: MODEL_PROVIDER_SETTINGS_VERSION,
    mode: 'local',
    provider: 'lm-studio',
    endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
    model: 'local-model',
    protocol: 'openai-compatible',
    timeout_ms: 120000
  })
});

export const DEFAULT_EXTERNAL_MODEL_SETTINGS = Object.freeze({
  version: MODEL_PROVIDER_SETTINGS_VERSION,
  mode: 'external',
  provider: 'openai-compatible',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4o-mini',
  protocol: 'openai-compatible',
  timeout_ms: 120000
});

/**
 * Validate and normalize the one active, non-secret provider configuration. No credential is
 * accepted here so this object is safe to persist as ordinary JSON or return to the renderer.
 */
export function normalizeModelProviderSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw providerConfigurationError('AI provider settings must be an object');
  const mode = String(input.mode || '').trim().toLowerCase();
  const provider = String(input.provider || '').trim().toLowerCase();
  const endpoint = String(input.endpoint || '').trim();
  const model = String(input.model || '').trim();
  const protocol = String(input.protocol || (provider === 'ollama' ? 'ollama' : 'openai-compatible')).trim().toLowerCase();
  const timeout = input.timeout_ms ?? input.timeoutMs;

  if (!MODEL_PROVIDER_MODES.includes(mode)) throw providerConfigurationError('AI provider mode must be local or external');
  if (mode === 'local' && !LOCAL_MODEL_PROVIDERS.includes(provider)) throw providerConfigurationError('Local provider must be Ollama or LM Studio');
  if (mode === 'external' && !EXTERNAL_MODEL_PROVIDERS.includes(provider)) throw providerConfigurationError('External provider must be OpenAI-compatible');
  if (!endpoint) throw providerConfigurationError('AI provider endpoint is required');
  let url;
  try { url = new URL(endpoint); }
  catch { throw providerConfigurationError('AI provider endpoint must be a valid URL'); }
  if (url.username || url.password) throw providerConfigurationError('AI provider endpoint must not contain credentials');
  if (mode === 'local') {
    if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) throw providerConfigurationError('Local model endpoints must use loopback HTTP');
  } else if (url.protocol !== 'https:') {
    throw providerConfigurationError('External model endpoints must use HTTPS');
  }
  if (!model || model.length > 256) throw providerConfigurationError('AI provider model is required and must be at most 256 characters');
  if (provider === 'ollama' && protocol !== 'ollama') throw providerConfigurationError('Ollama must use the Ollama protocol');
  if (provider !== 'ollama' && !['openai-compatible', 'provider-neutral-json'].includes(protocol)) {
    throw providerConfigurationError('LM Studio and external providers must use an approved JSON protocol');
  }
  if (!/^\d+$/.test(String(timeout)) || Number(timeout) < 1 || Number(timeout) > 120000) {
    throw providerConfigurationError('AI provider timeout must be a positive integer no greater than 120000 ms');
  }
  return Object.freeze({
    version: MODEL_PROVIDER_SETTINGS_VERSION,
    mode,
    provider,
    endpoint: url.href,
    model,
    protocol,
    timeout_ms: Number(timeout)
  });
}

export function settingsFromLegacyEnvironment(env = process.env) {
  const endpoint = String(env.ARGUS_MODEL_ENDPOINT || '').trim();
  const model = String(env.ARGUS_MODEL_NAME || '').trim();
  if (!endpoint && !model) return undefined;
  if (!endpoint || !model) throw providerConfigurationError('Legacy model endpoint and model must be configured together');
  const protocol = String(env.ARGUS_MODEL_PROTOCOL || 'provider-neutral-json').trim().toLowerCase();
  const url = new URL(endpoint);
  const mode = url.protocol === 'https:' ? 'external' : 'local';
  const provider = protocol === 'ollama' ? 'ollama' : mode === 'local' ? 'lm-studio' : 'openai-compatible';
  return normalizeModelProviderSettings({ mode, provider, endpoint, model, protocol, timeout_ms: env.ARGUS_MODEL_TIMEOUT_MS || 120000 });
}

export function settingsFromProvisionedManifest(manifest) {
  const model = manifest?.local_model;
  if (!model?.endpoint || !model?.model) return undefined;
  return normalizeModelProviderSettings({
    mode: 'local',
    provider: model.protocol === 'ollama' ? 'ollama' : 'lm-studio',
    endpoint: model.endpoint,
    model: model.model,
    protocol: model.protocol || 'ollama',
    timeout_ms: 120000
  });
}

export function settingsForRuntime(settings, credential) {
  const normalized = normalizeModelProviderSettings(settings);
  const value = typeof credential === 'string' ? credential.trim() : '';
  if (normalized.mode === 'external' && value.length === 0) {
    return Object.freeze({ configuration: normalized, credential_configured: false });
  }
  return Object.freeze({ configuration: normalized, ...(normalized.mode === 'external' ? { credential: value, credential_configured: true } : { credential_configured: false }) });
}

export function redactRuntimeSettings(settings, credentialConfigured = false) {
  const normalized = normalizeModelProviderSettings(settings);
  return Object.freeze({ ...normalized, credential_configured: normalized.mode === 'external' && credentialConfigured === true });
}

export function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export class ModelProviderConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelProviderConfigurationError';
    this.code = 'INVALID_MODEL_PROVIDER_CONFIGURATION';
    this.category = 'validation';
    this.retryable = false;
  }
}

export function providerConfigurationError(message) { return new ModelProviderConfigurationError(message); }

/** Ordinary JSON store for non-secret provider settings. It refuses credential-shaped fields. */
export function createModelProviderSettingsStore({ filePath } = {}) {
  if (!filePath) throw new TypeError('model provider settings filePath is required');
  const target = path.resolve(filePath);
  return Object.freeze({
    async load() {
      try {
        const parsed = JSON.parse(await readFile(target, 'utf8'));
        if (Object.keys(parsed).some((key) => /key|secret|token|password|credential/i.test(key))) throw providerConfigurationError('Stored provider settings contain a forbidden credential field');
        return normalizeModelProviderSettings(parsed);
      } catch (error) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async save(settings) {
      const normalized = normalizeModelProviderSettings(settings);
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
      return normalized;
    }
  });
}

/**
 * Host-only credential store backed by Electron safeStorage. The file contains only the encrypted
 * binary blob; it is never a JSON config value and the adapter exposes no export/list operation.
 */
export function createSafeStorageCredentialStore({ safeStorage, filePath } = {}) {
  if (!safeStorage || !filePath) throw new TypeError('safeStorage and filePath are required');
  const target = path.resolve(filePath);
  function assertAvailable() {
    if (typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
      throw new Error('OS credential storage is unavailable on this host', { cause: { code: 'CREDENTIAL_STORE_UNAVAILABLE', category: 'unavailable' } });
    }
  }
  return Object.freeze({
    async has() {
      try { await readFile(target); return true; }
      catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
    },
    async get() {
      if (!await this.has()) return undefined;
      assertAvailable();
      return safeStorage.decryptString(await readFile(target));
    },
    async set(value) {
      const credential = String(value || '').trim();
      if (!credential) throw providerConfigurationError('API key must not be empty');
      assertAvailable();
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, safeStorage.encryptString(credential), { mode: 0o600 });
      await rename(temporary, target);
    },
    async remove() {
      try { await unlink(target); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  });
}

export function createMemoryCredentialStore(initialValue) {
  let value = initialValue ? String(initialValue) : undefined;
  return Object.freeze({
    async has() { return Boolean(value); },
    async get() { return value; },
    async set(next) { value = String(next || '').trim() || undefined; },
    async remove() { value = undefined; }
  });
}
