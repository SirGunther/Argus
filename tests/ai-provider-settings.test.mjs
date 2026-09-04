import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  DEFAULT_MODEL_PROVIDER_SETTINGS,
  createMemoryCredentialStore,
  createModelProviderSettingsStore,
  createSafeStorageCredentialStore,
  modelProviderCredentialScope,
  normalizeModelProviderSettings
} from '../runtime/model-provider-settings.mjs';
import { DesktopApplication } from '../runtime/desktop-application.mjs';
import { InteractiveGraph } from '../runtime/interactive-graph.mjs';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { createEnvelope } from '../runtime/orchestrator.mjs';
import { buildExtractionRequest } from '../services/log-extractor-local-http/model-boundary.mjs';
import { runService } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const laneManifest = path.join(root, 'services', 'serial-ai-model-lane', 'service.json');

test('provider settings validate local loopback and external HTTPS boundaries', () => {
  assert.deepEqual(normalizeModelProviderSettings(DEFAULT_MODEL_PROVIDER_SETTINGS), DEFAULT_MODEL_PROVIDER_SETTINGS);
  assert.deepEqual(normalizeModelProviderSettings({ mode: 'local', provider: 'lm-studio', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local-model', timeout_ms: 1000 }), {
    version: 1, mode: 'local', provider: 'lm-studio', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local-model', protocol: 'openai-compatible', timeout_ms: 1000
  });
  assert.deepEqual(normalizeModelProviderSettings({ mode: 'external', provider: 'openai-compatible', endpoint: 'https://provider.example/v1/chat/completions', model: 'remote-model', timeout_ms: 1000 }), {
    version: 1, mode: 'external', provider: 'openai-compatible', endpoint: 'https://provider.example/v1/chat/completions', model: 'remote-model', protocol: 'openai-compatible', timeout_ms: 1000
  });
  assert.throws(() => normalizeModelProviderSettings({ mode: 'local', provider: 'ollama', endpoint: 'https://127.0.0.1/api/generate', model: 'x', timeout_ms: 1000 }), /loopback HTTP/);
  assert.throws(() => normalizeModelProviderSettings({ mode: 'external', provider: 'openai-compatible', endpoint: 'http://provider.example/v1/chat/completions', model: 'x', timeout_ms: 1000 }), /HTTPS/);
});

test('interactive host dispatch uses the registered provider contract version', async () => {
  const registry = await loadContractRegistry(path.join(root, 'contracts', 'catalog.json'));
  const source = {
    id: '@desktop-controller',
    endpointType: 'runtime',
    serviceName: '@desktop-controller',
    ports: { control: { accepts: [], emits: ['ai.provider-configure'] } }
  };
  const sink = { id: '@provider-sink', endpointType: 'runtime', serviceName: '@provider-sink', ports: { control: { accepts: ['ai.provider-configure'], emits: [] } } };
  const graph = new InteractiveGraph({ registry, endpoints: new Map([[source.id, source], [sink.id, sink]]) });
  graph.wiresFor = () => [{ from: source.id, contract: 'ai.provider-configure', to: sink.id }];
  let routed;
  graph.route = (_from, message) => { routed = message; };

  const message = await graph.dispatchFrom(source.id, 'control', 'ai.provider-configure', 'provider-session', {
    configuration: {
      version: 1,
      mode: 'local',
      provider: 'lm-studio',
      endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
      model: 'google/gemma-4-12b-qat',
      protocol: 'openai-compatible',
      timeout_ms: 30000
    },
    credential: { provided: false }
  }, 'provider-version-regression');

  assert.equal(message.schema_version, '1.0.0');
  assert.equal(routed, message);
});

test('non-secret settings and encrypted host credentials stay out of renderer-shaped state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'argus-provider-settings-'));
  const settingsFile = path.join(directory, 'provider.json');
  const credentialFile = path.join(directory, 'credential.bin');
  const credential = 'fixture-provider-value';
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8').toString('base64'),
    decryptString: (value) => Buffer.from(value.toString('utf8'), 'base64').toString('utf8')
  };
  try {
    const settingsStore = createModelProviderSettingsStore({ filePath: settingsFile });
    const credentialStore = createSafeStorageCredentialStore({ safeStorage, filePath: credentialFile });
    const external = normalizeModelProviderSettings({ mode: 'external', provider: 'openai-compatible', endpoint: 'https://provider.example/v1/chat/completions', model: 'remote-model', timeout_ms: 1000 });
    const scope = modelProviderCredentialScope(external);
    const otherScope = modelProviderCredentialScope({ ...external, endpoint: 'https://other.example/v1/chat/completions' });
    await settingsStore.save(external);
    await credentialStore.set(scope, credential);
    assert.doesNotMatch(await readFile(settingsFile, 'utf8'), /api[_-]?key|fixture-provider-value/i);
    assert.doesNotMatch((await readFile(credentialFile)).toString('utf8'), new RegExp(credential));
    assert.equal(await credentialStore.get(scope), credential);
    assert.equal(await credentialStore.get(otherScope), undefined, 'a credential cannot cross provider endpoint scope');
    assert.equal(await credentialStore.has(otherScope), false);
    assert.deepEqual({ ...external, credential_configured: true }, { ...external, credential_configured: true });
    await credentialStore.remove();
    assert.equal(await credentialStore.has(), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the serial model lane accepts runtime configuration and preserves provider-neutral workload contracts', async () => {
  const endpoint = await startOpenAiCompatibleEndpoint();
  try {
    const request = buildExtractionRequest({
      window_id: 'provider-window', session_id: 'provider-session', reason: 'pause',
      segments: [{ segment_id: 'segment-1', sequence: 0, start_time: '00:00:00.000', end_time: '00:00:01.000', text: 'Use the configured model.' }],
      source: { first_segment_id: 'segment-1', last_segment_id: 'segment-1', start_time: '00:00:00.000', end_time: '00:00:01.000' },
      context_segments: [], generation_directive: { purpose: 'logged-item-extraction', policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0', context_scope: { source_range_only: true, lookback_segment_count: 0, forward_segment_count: 0, max_context_chars: 100 }
      }
    }, { workId: 'logged-item-extraction:provider-session:provider-window', modelName: 'remote-model' });
    const configuration = createEnvelope({ plane: 'control', messageType: 'ai.provider-configure', producer: 'fixture-host', correlationId: 'provider-session', schemaVersion: '1.0.0', idempotencyKey: 'provider-configure', payload: {
      configuration: { version: 1, mode: 'local', provider: 'lm-studio', endpoint: endpoint.url, model: 'remote-model', protocol: 'openai-compatible', timeout_ms: 2000 },
      credential: { provided: false }
    } });
    const work = createEnvelope({ plane: 'control', messageType: 'ai.work-request', producer: 'fixture-host', correlationId: 'provider-session', schemaVersion: '1.4.0', idempotencyKey: 'provider-work', payload: {
      work_id: request.identity.work_id, workload: 'logged-item-extraction', session_id: 'provider-session', sequence: 0, queued_at: '2026-09-01T00:00:00.000Z', input: { model_request: request }, recovery: { max_attempts: 1 }
    } });
    const result = await runService(laneManifest, [configuration, work], 3, 5000);
    assert.ok(result.outputs.some((message) => message.message_type === 'operation.completed' && message.payload.operation === 'configure-model-provider'));
    const completion = result.outputs.find((message) => message.message_type === 'ai.work-completed');
    assert.equal(completion.payload.result.status, 'succeeded');
    assert.equal(endpoint.authorization, undefined);
    assert.doesNotMatch(JSON.stringify(completion), /api[_-]?key|credential/i);
  } finally {
    await endpoint.close();
  }
});

test('desktop provider settings persist precedence and expose only redacted credential state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'argus-desktop-provider-'));
  try {
    const settingsStore = createModelProviderSettingsStore({ filePath: path.join(directory, 'provider.json') });
    const credentialStore = createMemoryCredentialStore();
    const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(directory, 'sessions'), providerSettingsStore: settingsStore, credentialStore, environment: {} });
    await application.loadProviderConfiguration();
    assert.equal((await application.aiProviderSettings()).configured, false);
    const saved = await application.saveAiProviderSettings({ mode: 'external', provider: 'openai-compatible', endpoint: 'https://provider.example/v1/chat/completions', model: 'remote-model', timeout_ms: 1000, api_key: 'fixture-provider-value' });
    assert.equal(saved.credential_configured, true);
    assert.doesNotMatch(JSON.stringify(saved), /fixture-provider-value/);
    const reloaded = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(directory, 'sessions-2'), providerSettingsStore: settingsStore, credentialStore, environment: { ARGUS_MODEL_ENDPOINT: 'http://127.0.0.1:11434/api/generate', ARGUS_MODEL_NAME: 'legacy-model', ARGUS_MODEL_PROTOCOL: 'ollama', ARGUS_MODEL_TIMEOUT_MS: '1000' } });
    await reloaded.loadProviderConfiguration();
    assert.equal(reloaded.providerConfiguration.provider, 'openai-compatible');
    assert.equal((await reloaded.aiProviderSettings()).credential_configured, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('switching external endpoints never reuses the prior endpoint credential', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'argus-provider-scope-'));
  try {
    const settingsStore = createModelProviderSettingsStore({ filePath: path.join(directory, 'provider.json') });
    const credentialStore = createMemoryCredentialStore();
    const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(directory, 'sessions'), providerSettingsStore: settingsStore, credentialStore, environment: {} });
    await application.loadProviderConfiguration();
    const first = { mode: 'external', provider: 'openai-compatible', endpoint: 'https://first.example/v1/chat/completions', model: 'first-model', timeout_ms: 1000 };
    const second = { ...first, endpoint: 'https://second.example/v1/chat/completions', model: 'second-model' };
    await application.saveAiProviderSettings({ ...first, api_key: 'first-endpoint-key' });
    assert.equal(await application.readCredential(first), 'first-endpoint-key');

    const switched = await application.saveAiProviderSettings(second);
    assert.equal(switched.credential_configured, false);
    assert.equal(await application.readCredential(second), undefined);
    assert.equal(await application.readCredential(first), 'first-endpoint-key');

    await application.saveAiProviderSettings({ ...second, api_key: 'second-endpoint-key' });
    assert.equal(await application.readCredential(second), 'second-endpoint-key');
    assert.equal(await application.readCredential(first), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('credential persistence failure restores the prior non-secret provider settings', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'argus-provider-rollback-'));
  try {
    const settingsStore = createModelProviderSettingsStore({ filePath: path.join(directory, 'provider.json') });
    const credentialStore = createMemoryCredentialStore();
    const first = normalizeModelProviderSettings({ mode: 'external', provider: 'openai-compatible', endpoint: 'https://first.example/v1/chat/completions', model: 'first-model', timeout_ms: 1000 });
    const second = { ...first, endpoint: 'https://second.example/v1/chat/completions', model: 'second-model' };
    const firstScope = modelProviderCredentialScope(first);
    await settingsStore.save(first);
    await credentialStore.set(firstScope, 'first-endpoint-key');
    const failingCredentialStore = {
      has: (...args) => credentialStore.has(...args),
      get: (...args) => credentialStore.get(...args),
      remove: (...args) => credentialStore.remove(...args),
      async set() { throw new Error('credential persistence failed'); }
    };
    const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(directory, 'sessions'), providerSettingsStore: settingsStore, credentialStore: failingCredentialStore, environment: {} });
    await application.loadProviderConfiguration();

    await assert.rejects(application.saveAiProviderSettings({ ...second, api_key: 'second-endpoint-key' }), /credential persistence failed/);
    assert.deepEqual(await settingsStore.load(), first);
    assert.equal(await credentialStore.get(firstScope), 'first-endpoint-key');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function startOpenAiCompatibleEndpoint() {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'remote-model' }] }));
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      server.authorization = request.headers.authorization;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ protocol_version: '1.0.0', purpose: 'logged-item-extraction', text: 'Configured provider response.' }) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}/v1/chat/completions`, get authorization() { return server.authorization; }, close: () => new Promise((resolve) => server.close(resolve)) };
}
