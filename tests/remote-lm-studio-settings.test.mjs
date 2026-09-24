import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createMemoryCredentialStore,
  createModelProviderSettingsStore,
  modelProviderCredentialScope,
  normalizeModelProviderSettings
} from '../runtime/model-provider-settings.mjs';
import { DesktopApplication } from '../runtime/desktop-application.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REMOTE_ORIGIN = 'https://lm-studio.example.ts.net';
const REMOTE_ENDPOINT = `${REMOTE_ORIGIN}/v1/chat/completions`;
const REMOTE_MODELS_URL = `${REMOTE_ORIGIN}/v1/models`;
const MODEL = 'remote-lm-studio-model';
const SAVED_KEY = 'fixture-saved-lm-studio-token';
const REPLACEMENT_KEY = 'fixture-replacement-lm-studio-token';
const LOCAL_AUTH_MESSAGE = 'Local providers never send one; connect through External Service with an API key.';

const externalLmStudio = Object.freeze({ mode: 'external', provider: 'lm-studio', endpoint: REMOTE_ENDPOINT, model: MODEL, protocol: 'openai-compatible', timeout_ms: 2000 });
const externalOpenAi = Object.freeze({ mode: 'external', provider: 'openai-compatible', endpoint: 'https://provider.example/v1/chat/completions', model: 'remote-model', protocol: 'openai-compatible', timeout_ms: 2000 });
const localLmStudio = Object.freeze({ mode: 'local', provider: 'lm-studio', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local-model', protocol: 'openai-compatible', timeout_ms: 2000 });

test('saving external LM Studio with an API key returns and persists only redacted, non-secret settings', async () => {
  await withApplication(async ({ application, settingsFile, credentialStore }) => {
    const saved = await application.saveAiProviderSettings({ ...externalLmStudio, api_key: SAVED_KEY });
    assert.equal(saved.mode, 'external');
    assert.equal(saved.provider, 'lm-studio');
    assert.equal(saved.endpoint, REMOTE_ENDPOINT);
    assert.equal(saved.credential_configured, true);
    assert.equal(Object.hasOwn(saved, 'api_key'), false);
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(SAVED_KEY));

    const onDisk = await readFile(settingsFile, 'utf8');
    assert.doesNotMatch(onDisk, new RegExp(SAVED_KEY));
    assert.doesNotMatch(onDisk, /api[_-]?key|credential|token/i);
    assert.deepEqual(JSON.parse(onDisk), normalizeModelProviderSettings(externalLmStudio));

    const scope = modelProviderCredentialScope(externalLmStudio);
    assert.equal(scope, `v1:lm-studio:${REMOTE_ENDPOINT}`);
    assert.equal(await application.readCredential(externalLmStudio), SAVED_KEY);
    assert.equal(await credentialStore.get(scope), SAVED_KEY);
    // The same URL under the OpenAI-compatible provider is a different credential scope.
    assert.equal(await application.readCredential({ ...externalLmStudio, provider: 'openai-compatible' }), undefined);
  });
});

test('saving an external LM Studio base URL is rejected and leaves the saved settings unchanged', async () => {
  await withApplication(async ({ application, settingsStore }) => {
    await application.saveAiProviderSettings({ ...externalLmStudio, api_key: SAVED_KEY });
    const before = await settingsStore.load();

    await assert.rejects(
      application.saveAiProviderSettings({ ...externalLmStudio, endpoint: `${REMOTE_ORIGIN}/v1`, api_key: REPLACEMENT_KEY }),
      /External LM Studio endpoint must be the full chat completions URL/
    );
    assert.deepEqual(await settingsStore.load(), before);
    assert.deepEqual(application.providerConfiguration, before);
    assert.equal((await application.aiProviderSettings()).endpoint, REMOTE_ENDPOINT);
    assert.equal(await application.readCredential(externalLmStudio), SAVED_KEY);
  });
});

test('the external LM Studio connection test sends one authorized model listing request', async () => {
  await withApplication(async ({ application }) => {
    await application.saveAiProviderSettings({ ...externalLmStudio, api_key: SAVED_KEY });
    await withStubbedFetch(() => jsonResponse({ data: [{ id: 'other-model' }, { id: MODEL }] }), async (calls) => {
      const result = await application.testAiProviderSettings(externalLmStudio);
      assert.deepEqual(result, { status: 'available', message: `LM Studio connection is available for model ${MODEL}.` });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, REMOTE_MODELS_URL);
      assert.equal(calls[0].method, 'GET');
      assert.equal(calls[0].headers.authorization, `Bearer ${SAVED_KEY}`);
    });
  });
});

test('the external LM Studio connection test reports a model the server does not list', async () => {
  await withApplication(async ({ application }) => {
    await application.saveAiProviderSettings({ ...externalLmStudio, api_key: SAVED_KEY });
    await withStubbedFetch(() => jsonResponse({ data: [{ id: 'other-model' }] }), async (calls) => {
      const result = await application.testAiProviderSettings(externalLmStudio);
      assert.deepEqual(result, { status: 'unavailable', message: `LM Studio is reachable but selected model ${MODEL} is not available.` });
      assert.equal(calls.length, 1);
    });
  });
});

test('an external server that rejects the sent key reports a rejected API key for 401 and 403', async () => {
  await withApplication(async ({ application }) => {
    await application.saveAiProviderSettings({ ...externalLmStudio, api_key: SAVED_KEY });
    for (const status of [401, 403]) {
      await withStubbedFetch(() => jsonResponse({ error: 'unauthorized' }, status), async (calls) => {
        const result = await application.testAiProviderSettings(externalLmStudio);
        assert.deepEqual(result, { status: 'unavailable', message: `LM Studio rejected the API key (HTTP ${status}).` });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].headers.authorization, `Bearer ${SAVED_KEY}`);
      });
    }
    // The label follows the provider, so an OpenAI-compatible rejection names that service instead.
    await withStubbedFetch(() => jsonResponse({ error: 'unauthorized' }, 401), async () => {
      const result = await application.testAiProviderSettings({ ...externalOpenAi, api_key: REPLACEMENT_KEY });
      assert.deepEqual(result, { status: 'unavailable', message: 'External service rejected the API key (HTTP 401).' });
    });
  });
});

test('a key supplied with the connection test overrides the saved external LM Studio key', async () => {
  await withApplication(async ({ application }) => {
    await application.saveAiProviderSettings({ ...externalLmStudio, api_key: SAVED_KEY });
    await withStubbedFetch(() => jsonResponse({ data: [{ id: MODEL }] }), async (calls) => {
      const result = await application.testAiProviderSettings({ ...externalLmStudio, api_key: REPLACEMENT_KEY });
      assert.equal(result.status, 'available');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].headers.authorization, `Bearer ${REPLACEMENT_KEY}`);
    });
    // Testing never persists the supplied key.
    assert.equal(await application.readCredential(externalLmStudio), SAVED_KEY);
  });
});

test('external LM Studio without a saved or supplied key never reaches the network', async () => {
  await withApplication(async ({ application }) => {
    await withStubbedFetch(() => { throw new Error('fetch must not be called'); }, async (calls) => {
      for (const payload of [externalLmStudio, { ...externalLmStudio, api_key: '' }, { ...externalLmStudio, api_key: '   ' }]) {
        const result = await application.testAiProviderSettings(payload);
        assert.deepEqual(result, { status: 'unavailable', message: 'External provider API key is not configured.' });
      }
      assert.equal(calls.length, 0);
    });
  });
});

test('local LM Studio that demands authentication points the user at External Service and sends no key', async () => {
  await withApplication(async ({ application }) => {
    // A saved external credential must not leak into a local connection test.
    await application.saveAiProviderSettings({ ...externalLmStudio, api_key: SAVED_KEY });
    for (const status of [401, 403]) {
      await withStubbedFetch(() => jsonResponse({ error: 'unauthorized' }, status), async (calls) => {
        const result = await application.testAiProviderSettings(localLmStudio);
        assert.deepEqual(result, { status: 'unavailable', message: `LM Studio requires an API key (HTTP ${status}). ${LOCAL_AUTH_MESSAGE}` });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'http://127.0.0.1:1234/v1/models');
        assert.equal(Object.hasOwn(calls[0].headers, 'authorization'), false);
      });
    }
  });
});

test('non-authentication outcomes keep their existing connection test messages', async () => {
  await withApplication(async ({ application }) => {
    await withStubbedFetch(() => jsonResponse({ data: [{ id: 'remote-model' }] }), async (calls) => {
      const result = await application.testAiProviderSettings({ ...externalOpenAi, api_key: REPLACEMENT_KEY });
      assert.deepEqual(result, { status: 'available', message: 'External service connection is available for model remote-model.' });
      assert.equal(calls[0].url, 'https://provider.example/v1/models');
    });
    await withStubbedFetch(() => { throw new TypeError('fetch failed'); }, async () => {
      assert.deepEqual(await application.testAiProviderSettings({ ...externalOpenAi, api_key: REPLACEMENT_KEY }), { status: 'unavailable', message: 'External service unavailable: fetch failed' });
      assert.deepEqual(await application.testAiProviderSettings({ ...externalLmStudio, api_key: REPLACEMENT_KEY }), { status: 'unavailable', message: 'LM Studio unavailable: fetch failed' });
    });
    await withStubbedFetch(() => jsonResponse({ error: 'server error' }, 500), async () => {
      assert.deepEqual(await application.testAiProviderSettings({ ...externalLmStudio, api_key: REPLACEMENT_KEY }), { status: 'unavailable', message: 'LM Studio unavailable: HTTP 500' });
      assert.deepEqual(await application.testAiProviderSettings(localLmStudio), { status: 'unavailable', message: 'LM Studio unavailable: HTTP 500' });
    });
    await withStubbedFetch(() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, async () => {
      assert.deepEqual(await application.testAiProviderSettings({ ...externalLmStudio, api_key: REPLACEMENT_KEY }), { status: 'unavailable', message: 'LM Studio unavailable: request timed out after 2000 ms' });
    });
  });
});

test('the settings drawer offers LM Studio as an external provider and reacts to provider changes', async () => {
  const [html, source] = await Promise.all([
    readFile(path.join(root, 'index.html'), 'utf8'),
    readFile(path.join(root, 'app.js'), 'utf8')
  ]);
  const select = html.match(/<select id="externalProviderSelect">([\s\S]*?)<\/select>/);
  assert.ok(select, 'index.html must declare #externalProviderSelect');
  assert.deepEqual([...select[1].matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]), ['openai-compatible', 'lm-studio']);
  assert.match(source, /els\.externalProviderSelect\.addEventListener\(\s*'change'/);
  assert.ok(source.includes("'https://your-device.your-tailnet.ts.net/v1/chat/completions'"), 'the LM Studio endpoint placeholder must be a placeholder host');
});

async function withApplication(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'argus-remote-lm-studio-settings-'));
  try {
    const settingsFile = path.join(directory, 'provider.json');
    const settingsStore = createModelProviderSettingsStore({ filePath: settingsFile });
    const credentialStore = createMemoryCredentialStore();
    const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(directory, 'sessions'), providerSettingsStore: settingsStore, credentialStore, environment: {} });
    await application.loadProviderConfiguration();
    await run({ application, settingsStore, settingsFile, credentialStore });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Replace the global fetch for one block, recording every request the host makes. */
async function withStubbedFetch(respond, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method, headers: { ...(options.headers || {}) } };
    calls.push(call);
    return respond(call);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
