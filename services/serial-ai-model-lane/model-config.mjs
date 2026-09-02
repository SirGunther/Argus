import { normalizeModelProviderSettings, settingsFromLegacyEnvironment, settingsForRuntime } from '../../runtime/model-provider-settings.mjs';

export function readModelConfig(env = process.env) {
  const endpoint = String(env.ARGUS_MODEL_ENDPOINT || '').trim();
  const modelName = String(env.ARGUS_MODEL_NAME || '').trim();
  const timeoutText = String(env.ARGUS_MODEL_TIMEOUT_MS || '').trim();
  const protocol = String(env.ARGUS_MODEL_PROTOCOL || 'provider-neutral-json').trim();
  if (!endpoint) throw configurationError('ARGUS_MODEL_ENDPOINT is required');
  let url;
  try { url = new URL(endpoint); }
  catch { throw configurationError('ARGUS_MODEL_ENDPOINT must be a valid URL'); }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(hostname)) throw configurationError('ARGUS_MODEL_ENDPOINT must use loopback-only http');
  if (url.username || url.password) throw configurationError('ARGUS_MODEL_ENDPOINT must not contain credentials');
  if (!modelName) throw configurationError('ARGUS_MODEL_NAME is required');
  if (!/^\d+$/.test(timeoutText) || Number(timeoutText) < 1) throw configurationError('ARGUS_MODEL_TIMEOUT_MS must be a positive integer');
  if (!['provider-neutral-json', 'ollama'].includes(protocol)) throw configurationError('ARGUS_MODEL_PROTOCOL must be provider-neutral-json or ollama');
  return Object.freeze({ endpoint: url.href, modelName, timeoutMs: Number(timeoutText), protocol });
}

/** Legacy environment compatibility for deterministic graphs and existing Ollama installs. */
export function readRuntimeModelConfig(env = process.env) {
  const settings = settingsFromLegacyEnvironment(env);
  if (!settings) return undefined;
  return settingsForRuntime(settings, env.ARGUS_MODEL_API_KEY);
}

export { normalizeModelProviderSettings };

function configurationError(message) { return new Error(message, { cause: { code: 'INVALID_MODEL_CONFIGURATION', category: 'validation' } }); }
