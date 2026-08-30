import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import {
  PackageIntegrityError,
  assertNoSecrets,
  assertVerifiedGraphPackage,
  buildGraphPackage,
  stableStringify,
  verifyGraphPackage
} from '../runtime/package-inventory.mjs';
import {
  DENIED_PERMISSIONS,
  ENFORCEMENT_MATRIX,
  PERMISSION_CLASSES,
  PermissionDeclarationError,
  assertPermissionPolicy,
  normalizePermissions,
  resolveNodePermissionPlan
} from '../runtime/permission-policy.mjs';
import { loadGraphDefinition, prepareGraph } from '../runtime/orchestrator.mjs';
import { RuntimeProviderUnavailableError, createRuntimeProviderRegistry } from '../runtime/runtime-providers.mjs';
import { buildNodeEnvironment, createNodeProcessProvider } from '../runtime/providers/node-process-provider.mjs';
import { runService } from './helpers/process-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const graphFile = path.join(root, 'wiring/demo.concise.json');
const temporaryGraphDirectory = path.join(root, 'runtime-output', 'test-packages');

/**
 * Authority the shipped graph components are actually allowed to hold. Anything not listed here is
 * denied, so adding a grant to a manifest fails this test until the grant is a deliberate decision.
 */
const EXPECTED_SHIPPED_GRANTS = {
  'active-logged-item-owner': { filesystem: { read: ['session-root'], write: ['session-root'] } },
  'active-transcript-owner': { filesystem: { read: ['session-root'], write: ['session-root'] } },
  'permanent-logged-item-history': { filesystem: { read: ['session-root'], write: ['session-root'] } },
  'permanent-transcript-history': { filesystem: { read: ['session-root'], write: ['session-root'] } },
  'session-lifecycle-controller': { filesystem: { read: ['session-root'], write: ['session-root'] } },
  'session-folder-locator': { filesystem: { read: ['session-root'], write: [] } },
  'whisper-cpp-stt': { filesystem: { read: ['session-root', 'stt-runtime'], write: ['session-root'] }, process: { granted: true } },
  'serial-ai-model-lane': { network: { outbound: ['loopback-http'], listen: false } }
};

test('an unstated permission is a denied permission', () => {
  assert.deepEqual(normalizePermissions(undefined), DENIED_PERMISSIONS);
  assert.deepEqual(normalizePermissions({}), DENIED_PERMISSIONS);
  assert.deepEqual(normalizePermissions({ microphone: {} }), DENIED_PERMISSIONS);
  assert.deepEqual(normalizePermissions({ filesystem: { read: ['session-root'] } }).filesystem, { read: ['session-root'], write: [] });
  const partial = normalizePermissions({ filesystem: { read: ['session-root'] } });
  for (const capability of PERMISSION_CLASSES.filter((entry) => entry !== 'filesystem')) {
    assert.deepEqual(partial[capability], DENIED_PERMISSIONS[capability], `${capability} must stay denied when only filesystem is declared`);
  }
});

test('a manifest without an explicit permission block cannot enter a graph', async () => {
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const prepared = await prepareGraph(definition, absoluteGraphFile);
  const manifest = structuredClone([...prepared.services.values()][0].manifest);
  delete manifest.permissions;
  assert.throws(
    () => assertPermissionPolicy({ manifest, manifestPath: 'no-permissions/service.json' }),
    (error) => {
      assert.ok(error instanceof PermissionDeclarationError);
      assert.equal(error.code, 'PERMISSION_DECLARATION_INVALID');
      assert.match(error.message, /permissions must be declared explicitly/);
      return true;
    }
  );
  const withoutPermissions = await graphWithSource('no-permissions-source');
  await assert.rejects(
    () => prepareGraph(withoutPermissions, absoluteGraphFile),
    /\$\.permissions is required/,
    'the manifest artifact schema must refuse a manifest with no permission block'
  );
});

test('every shipped component holds exactly the authority its manifest declares and nothing more', async () => {
  for (const [name, expected] of Object.entries(await shippedManifestPermissions())) {
    const granted = EXPECTED_SHIPPED_GRANTS[name] || {};
    assert.deepEqual(expected, { ...DENIED_PERMISSIONS, ...granted }, `${name} holds authority that is not in the expected grant inventory`);
  }
});

test('capabilities no installed provider can enforce are refused at declaration time', () => {
  const refusals = [
    [{ microphone: { granted: true } }, /microphone capture cannot be granted/],
    [{ clipboard: { granted: true } }, /clipboard access cannot be granted/],
    [{ model_credentials: { granted: true } }, /model credentials cannot be granted/],
    [{ network: { listen: true } }, /network\.listen cannot be granted/]
  ];
  for (const [permissions, expected] of refusals) {
    assert.throws(
      () => assertPermissionPolicy({ manifest: nodeManifest({ permissions }), manifestPath: 'refused/service.json' }),
      (error) => {
        assert.equal(error.code, 'CAPABILITY_UNSUPPORTED');
        assert.match(error.message, expected);
        return true;
      }
    );
  }
});

test('container-only resource limits are refused on the installed Node runtime', () => {
  for (const resources of [{ memory_mb: 256 }, { cpu_limit: 1 }]) {
    assert.throws(
      () => assertPermissionPolicy({ manifest: nodeManifest({ resources }), manifestPath: 'resource/service.json' }),
      (error) => {
        assert.equal(error.code, 'CAPABILITY_UNSUPPORTED');
        assert.match(error.message, /container provider/);
        return true;
      }
    );
  }
  assert.doesNotThrow(() => assertPermissionPolicy({ manifest: nodeManifest({ resources: { max_heap_mb: 64 } }), manifestPath: 'heap/service.json' }));
});

test('configuration a component is not permitted to use is refused before it is injected', () => {
  assert.throws(
    () => assertPermissionPolicy({ manifest: nodeManifest({ environment: { allow: ['ARGUS_MODEL_ENDPOINT'] } }), manifestPath: 'endpoint/service.json' }),
    (error) => {
      assert.equal(error.code, 'PERMISSION_DECLARATION_INVALID');
      assert.match(error.message, /without network\.outbound loopback-http/);
      return true;
    }
  );
  assert.throws(
    () => assertPermissionPolicy({ manifest: nodeManifest({ permissions: { filesystem: { read: ['stt-runtime'] } } }), manifestPath: 'stt-runtime-missing-environment/service.json' }),
    (error) => {
      assert.match(error.message, /filesystem stt-runtime authority requires ARGUS_WHISPER_BINARY/);
      assert.match(error.message, /filesystem stt-runtime authority requires ARGUS_WHISPER_MODEL/);
      return true;
    }
  );
  assert.throws(
    () => assertPermissionPolicy({ manifest: nodeManifest({ permissions: { filesystem: { write: ['stt-runtime'] } }, environment: { allow: ['ARGUS_WHISPER_BINARY', 'ARGUS_WHISPER_MODEL'] } }), manifestPath: 'stt-runtime-write/service.json' }),
    (error) => {
      assert.match(error.message, /filesystem\.write scope stt-runtime is not a declarable authority/);
      return true;
    }
  );
  assert.throws(
    () => assertPermissionPolicy({ manifest: nodeManifest({ permissions: { filesystem: { read: ['runtime-output'] } } }), manifestPath: 'stt-runtime-unknown-scope/service.json' }),
    (error) => {
      assert.match(error.message, /filesystem\.read scope runtime-output is not a declarable authority/);
      return true;
    }
  );
  assert.throws(
    () => assertPermissionPolicy({ manifest: nodeManifest({ environment: { allow: 'ARGUS_WHISPER_BINARY' } }), manifestPath: 'invalid-environment/service.json' }),
    (error) => {
      assert.match(error.message, /runtime\.environment\.allow must be an array/);
      return true;
    }
  );
  assert.throws(
    () => assertPermissionPolicy({ manifest: nodeManifest({ environment: { allow: ['ARGUS_MODEL_API_KEY'] } }), manifestPath: 'credential/service.json' }),
    (error) => {
      assert.equal(error.code, 'PERMISSION_DECLARATION_INVALID');
      assert.match(error.message, /credential-bearing key ARGUS_MODEL_API_KEY without a model_credentials grant/);
      return true;
    }
  );
  assert.throws(
    () => assertPermissionPolicy({ manifest: nodeManifest({ permissions: { filesystem: { write: ['session-root'] } } }), manifestPath: 'root/service.json' }),
    (error) => {
      assert.match(error.message, /requires ARGUS_SESSION_ROOT in runtime\.environment\.allow/);
      return true;
    }
  );
});

test('the Node provider maps stt-runtime to exactly the canonical Whisper asset files', async () => {
  const assetDirectory = await mkdtemp(path.join(os.tmpdir(), 'argus-stt-assets-'));
  const binary = path.join(assetDirectory, 'whisper-cli.exe');
  const model = path.join(assetDirectory, 'ggml-base.en.bin');
  await writeFile(binary, 'binary');
  await writeFile(model, 'model');
  try {
    const manifest = nodeManifest({
      permissions: { filesystem: { read: ['stt-runtime'] } },
      environment: { allow: ['ARGUS_WHISPER_BINARY', 'ARGUS_WHISPER_MODEL'] }
    });
    const provider = createNodeProcessProvider();
    const plan = provider.plan(
      { manifest, directory: path.join(root, 'services', 'whisper-cpp-stt') },
      { ARGUS_WHISPER_BINARY: binary, ARGUS_WHISPER_MODEL: model }
    );
    const canonicalBinary = realpathSync.native(binary);
    const canonicalModel = realpathSync.native(model);
    assert.deepEqual(plan.grantedReadPaths.filter((grantedPath) => grantedPath.startsWith(assetDirectory)), [canonicalBinary, canonicalModel]);
    assert.ok(plan.grantedReadPaths.includes(canonicalBinary));
    assert.ok(plan.grantedReadPaths.includes(canonicalModel));
    assert.ok(!plan.grantedReadPaths.includes(realpathSync.native(assetDirectory)));
    assert.ok(!plan.grantedReadPaths.includes(path.join(root, 'runtime-output')));
    assert.deepEqual(plan.grantedWritePaths, []);
  } finally {
    await rm(assetDirectory, { recursive: true, force: true });
  }
});

test('a service without stt-runtime cannot read the provisioned Whisper assets', async () => {
  const assetDirectory = await mkdtemp(path.join(os.tmpdir(), 'argus-stt-assets-'));
  const sessionParent = await mkdtemp(path.join(os.tmpdir(), 'argus-stt-session-parent-'));
  const sessionRoot = path.join(sessionParent, 'session');
  await mkdir(sessionRoot);
  const binary = path.join(assetDirectory, 'whisper-cli.exe');
  const model = path.join(assetDirectory, 'ggml-base.en.bin');
  await writeFile(binary, 'binary');
  await writeFile(model, 'model');
  const previous = new Map();
  for (const [key, value] of [['ARGUS_SESSION_ROOT', sessionRoot], ['ARGUS_WHISPER_BINARY', binary], ['ARGUS_WHISPER_MODEL', model]]) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  let handle;
  try {
    const manifestPath = path.join(root, 'services', 'whisper-cpp-stt', 'service.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.permissions.filesystem.read = ['session-root'];
    const provider = createNodeProcessProvider();
    const lines = [];
    const diagnostics = [];
    let failureResolve;
    let failureReject;
    const failure = new Promise((resolve, reject) => {
      failureResolve = resolve;
      failureReject = reject;
    });
    const exited = new Promise((resolve) => {
      handle = provider.start(
        { id: 'stt-probe-without-scope', manifest, directory: path.dirname(manifestPath), entrypoint: path.join(path.dirname(manifestPath), manifest.runtime.entrypoint), restartCount: 0 },
        {
          onMessage: (line) => {
            lines.push(line);
            const message = JSON.parse(line);
            if (message.message_type === 'service.failure') failureResolve(message);
          },
          onDiagnostic: (line) => diagnostics.push(line),
          onError: failureReject,
          onExit: resolve
        }
      );
    });
    for (let sequence = 0; sequence < 8; sequence += 1) await handle.write(whisperChunkInput(sequence));
    const serviceFailure = await Promise.race([
      failure,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Whisper permission probe timed out: ${diagnostics.join(' | ')}`)), 3000))
    ]);
    assert.equal(serviceFailure.payload.error.code, 'STT_UNAVAILABLE');
    assert.match(serviceFailure.payload.error.message, /Whisper runtime or model is unavailable/);
    assert.doesNotMatch(serviceFailure.payload.error.message, /Promise\.prototype\.then called on incompatible receiver/);
    handle.closeInput();
    await exited;
    handle.dispose();
  } finally {
    if (handle && !handle.isExited()) {
      handle.closeInput();
      handle.terminate();
    }
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(sessionParent, { recursive: true, force: true });
    await rm(assetDirectory, { recursive: true, force: true });
  }
});

test('missing Whisper assets remain a clear STT_UNAVAILABLE failure', async () => {
  const result = await runService(
    path.join(root, 'services', 'whisper-cpp-stt', 'service.json'),
    Array.from({ length: 8 }, (_, sequence) => whisperChunkInput(sequence)),
    8,
    3000,
    { env: { ARGUS_WHISPER_BINARY: '', ARGUS_WHISPER_MODEL: '' } }
  );
  const failure = result.outputs.find((message) => message.message_type === 'service.failure');
  assert.equal(failure?.payload?.error?.code, 'STT_UNAVAILABLE');
  assert.match(failure?.payload?.error?.message || '', /ARGUS_WHISPER_BINARY and ARGUS_WHISPER_MODEL are required/);
  assert.doesNotMatch(failure?.payload?.error?.message || '', /Promise\.prototype\.then called on incompatible receiver/);
});

test('a credential-shaped manifest is rejected before the graph reaches any process', async () => {
  const { graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const credentialGraph = await graphWithSource('credential-transcript-source');
  await assert.rejects(
    () => prepareGraph(credentialGraph, absoluteGraphFile),
    /credential-bearing key ARGUS_MODEL_API_KEY/
  );
  const microphoneGraph = await graphWithSource('microphone-transcript-source');
  await assert.rejects(
    () => prepareGraph(microphoneGraph, absoluteGraphFile),
    /microphone capture cannot be granted/
  );
});

test('a declared runtime with no installed provider fails closed before launch', async () => {
  const { graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  for (const [fixture, kind] of [['native-transcript-source', 'native'], ['container-transcript-source', 'container']]) {
    const unavailable = await graphWithSource(fixture);
    await assert.rejects(
      () => prepareGraph(unavailable, absoluteGraphFile),
      (error) => {
        assert.ok(error instanceof RuntimeProviderUnavailableError);
        assert.equal(error.code, 'RUNTIME_PROVIDER_UNAVAILABLE');
        assert.equal(error.runtimeKind, kind);
        assert.deepEqual(error.installedKinds, ['node']);
        return true;
      }
    );
  }
  const registry = createRuntimeProviderRegistry();
  assert.equal(registry.has('node'), true);
  assert.equal(registry.has('native'), false);
  assert.equal(registry.has('container'), false);
});

test('the declared policy becomes real Node permission flags', async () => {
  const denied = await manifestFor('permission-probe');
  const deniedPlan = resolveNodePermissionPlan({ manifest: denied.manifest, directory: denied.directory, environment: { ARGUS_SESSION_ROOT: path.join(root, 'runtime-output') } });
  assert.equal(deniedPlan.execArgv[0], '--permission');
  assert.deepEqual(deniedPlan.grantedWritePaths, []);
  assert.ok(!deniedPlan.execArgv.some((flag) => flag.startsWith('--allow-fs-write')));
  assert.ok(!deniedPlan.execArgv.includes('--allow-child-process'));

  const granted = await manifestFor('permission-probe-granted');
  const sessionRoot = path.join(root, 'runtime-output');
  const grantedPlan = resolveNodePermissionPlan({ manifest: granted.manifest, directory: granted.directory, environment: { ARGUS_SESSION_ROOT: sessionRoot } });
  assert.deepEqual(grantedPlan.grantedWritePaths, [sessionRoot]);
  assert.ok(grantedPlan.execArgv.includes(`--allow-fs-write=${sessionRoot}`));
  assert.ok(grantedPlan.execArgv.includes('--max-old-space-size=64'));

  const unset = resolveNodePermissionPlan({ manifest: granted.manifest, directory: granted.directory, environment: {} });
  assert.equal(unset.sessionRoot, null);
  assert.deepEqual(unset.grantedWritePaths, [], 'an unconfigured root grants no filesystem authority');
});

test('the operating system refuses what the manifest did not declare', async () => {
  const probe = await runProbe('permission-probe');
  assert.equal(probe.results['read-own-directory'], 'allowed');
  for (const denied of ['write-own-directory', 'read-outside-any-grant', 'read-session-root', 'write-session-root', 'spawn-child-process', 'start-worker-thread']) {
    assert.equal(probe.results[denied], 'ERR_ACCESS_DENIED', `${denied} must be refused by the Node permission model`);
  }
});

test('a granted scope is honored while every undeclared capability stays refused', async () => {
  const probe = await runProbe('permission-probe-granted');
  assert.equal(probe.results['read-session-root'], 'ENOENT', 'a granted read reaches the filesystem and reports a real missing file, not a denial');
  assert.equal(probe.results['write-session-root'], 'allowed');
  for (const denied of ['write-own-directory', 'read-outside-any-grant', 'spawn-child-process', 'start-worker-thread']) {
    assert.equal(probe.results[denied], 'ERR_ACCESS_DENIED', `${denied} must stay refused even for a component with a filesystem grant`);
  }
  // The fixture declares max_heap_mb 64 only to observe that the declaration reaches V8; it is not a
  // production sizing. V8 reports heap_size_limit as a combined limit that reflects but does not equal
  // the old-space ceiling (measured: 256 MB under --max-old-space-size=64 against a ~4.2 GB default),
  // so the assertion checks that a ceiling was applied rather than asserting an exact byte count.
  const uncappedDefault = getHeapStatistics().heap_size_limit;
  assert.ok(
    probe.heap_size_limit_bytes < uncappedDefault,
    `declared heap ceiling did not reach V8: ${probe.heap_size_limit_bytes} is not below the uncapped default ${uncappedDefault}`
  );
});

test('the child environment carries only declared configuration and no credential', async () => {
  const probe = await runProbe('permission-probe-granted', {
    ARGUS_MODEL_NAME: 'undeclared-model',
    ARGUS_MODEL_ENDPOINT: 'http://127.0.0.1:9/undeclared',
    DEMO_SERVICE_TOKEN: 'inherited-credential-value'
  });
  assert.deepEqual(probe.argus_environment_keys, ['ARGUS_RESTART_COUNT', 'ARGUS_SERVICE_INSTANCE_ID', 'ARGUS_SESSION_ROOT']);
  assert.deepEqual(probe.credential_shaped_keys, []);

  const base = { PATH: 'path', ARGUS_SESSION_ROOT: 'root', ARGUS_MODEL_NAME: 'fixture', ARGUS_MODEL_UNDECLARED: 'secret', SERVICE_API_TOKEN: 'inherited', DEPLOY_PASSWORD: 'inherited' };
  const filtered = buildNodeEnvironment(base, ['ARGUS_MODEL_NAME'], 'component');
  assert.equal(filtered.ARGUS_MODEL_NAME, 'fixture');
  assert.equal(filtered.PATH, 'path');
  for (const dropped of ['ARGUS_SESSION_ROOT', 'ARGUS_MODEL_UNDECLARED', 'SERVICE_API_TOKEN', 'DEPLOY_PASSWORD']) {
    assert.equal(filtered[dropped], undefined, `${dropped} must not reach a component that did not declare it`);
  }
  assert.throws(
    () => buildNodeEnvironment(base, ['ARGUS_MODEL_API_KEY'], 'component'),
    /credential configuration without a model_credentials grant/
  );
});

test('the package inventory is byte-identical across rebuilds', async () => {
  const first = await buildGraphPackage({ graphFile, root });
  const second = await buildGraphPackage({ graphFile, root });
  assert.equal(stableStringify(first), stableStringify(second));
  assert.equal(first.integrity.package_digest, second.integrity.package_digest);
  assert.equal(first.integrity.algorithm, 'sha256');
  assert.ok(first.integrity.file_count > 0);
  assert.ok(first.integrity.files.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)));
});

test('the package records the graph, contracts, manifests, component files, versions, and declared authority', async () => {
  const built = await buildGraphPackage({ graphFile, root });
  assert.equal(built.graph.path, 'wiring/demo.concise.json');
  assert.equal(built.contracts.catalog.path, 'contracts/catalog.json');
  assert.ok(built.contracts.messages.every((message) => message.version && message.plane && message.schema && message.changelog));
  const extractor = built.components.find((component) => component.service_instance === 'log-extractor');
  assert.equal(extractor.version, '1.0.0');
  assert.equal(extractor.runtime_kind, 'node');
  assert.deepEqual(extractor.files.map((file) => file.path), ['services/log-extractor-concise/index.mjs']);
  assert.deepEqual(extractor.permissions, DENIED_PERMISSIONS);
  assert.ok(built.shared_libraries.some((library) => library.path === 'runtime/orchestrator.mjs'));
  for (const entry of built.integrity.files) {
    assert.ok(!entry.path.includes('..') && !path.isAbsolute(entry.path), `${entry.path} must be a contained relative path`);
  }
});

test('packaging refuses a path outside the package root', async () => {
  await assert.rejects(
    () => buildGraphPackage({ graphFile, root: path.join(root, 'services') }),
    (error) => {
      assert.ok(error instanceof PackageIntegrityError);
      assert.equal(error.code, 'PACKAGE_PATH_ESCAPE');
      return true;
    }
  );
});

test('packaging refuses a component file the manifest does not declare', async () => {
  const temporaryGraph = await writeTemporaryGraph('undeclared-file-source', 'undeclared-file.json');
  try {
    await assert.rejects(
      () => buildGraphPackage({ graphFile: temporaryGraph, root }),
      (error) => {
        assert.equal(error.code, 'UNDECLARED_PACKAGE_FILE');
        assert.match(error.message, /undeclared-helper\.mjs/);
        return true;
      }
    );
  } finally {
    await rm(temporaryGraph, { force: true });
  }
});

test('packaging refuses a secret regardless of which file carries it', () => {
  const secrets = [
    ['pem-private-key', '-----BEGIN RSA PRIVATE KEY-----\nabc\n'],
    ['aws-access-key-id', 'const id = "AKIAIOSFODNN7EXAMPLE";'],
    ['github-token', 'token: ghp_0123456789abcdefghijklmnopqrstuvwxyz'],
    ['assigned-secret-literal', 'const config = { api_key: "sk-live-abcdefgh" };']
  ];
  for (const [name, content] of secrets) {
    assert.throws(
      () => assertNoSecrets('candidate.mjs', Buffer.from(content, 'utf8')),
      (error) => {
        assert.equal(error.code, 'PACKAGED_SECRET_DETECTED');
        assert.match(error.message, new RegExp(name));
        return true;
      },
      `${name} must be refused`
    );
  }
  assert.doesNotThrow(() => assertNoSecrets('ordinary.mjs', Buffer.from('const modelName = process.env.ARGUS_MODEL_NAME;', 'utf8')));
});

test('integrity verification reports every drift between a recorded package and the tree', async () => {
  const recorded = structuredClone(await buildGraphPackage({ graphFile, root }));
  const clean = await verifyGraphPackage({ graphFile, root, recorded });
  assert.equal(clean.verified, true);
  assert.deepEqual(clean.findings, []);

  const tampered = structuredClone(recorded);
  tampered.integrity.files[0].sha256 = '0'.repeat(64);
  tampered.integrity.files.push({ path: 'wiring/removed-graph.json', sha256: '1'.repeat(64), bytes: 1 });
  tampered.integrity.package_digest = '2'.repeat(64);
  const drifted = await verifyGraphPackage({ graphFile, root, recorded: tampered });
  assert.equal(drifted.verified, false);
  assert.ok(drifted.findings.some((finding) => finding.kind === 'hash-mismatch'));
  assert.ok(drifted.findings.some((finding) => finding.kind === 'no-longer-present'));
  assert.ok(drifted.findings.some((finding) => finding.kind === 'package-digest'));
  assert.throws(() => assertVerifiedGraphPackage(drifted, 'demo'), (error) => {
    assert.equal(error.code, 'PACKAGE_INTEGRITY_VIOLATION');
    return true;
  });
});

test('the enforcement record matches what the installed host can actually do', () => {
  const covered = new Set(ENFORCEMENT_MATRIX.map((entry) => entry.capability));
  for (const capability of ['filesystem.read', 'filesystem.write', 'microphone', 'clipboard', 'network.outbound', 'network.listen', 'model_credentials', 'process', 'worker', 'addons', 'wasi']) {
    assert.ok(covered.has(capability), `${capability} must have a recorded enforcement level`);
  }
  for (const entry of ENFORCEMENT_MATRIX) {
    assert.ok(['node', 'adapter', 'deferred'].includes(entry.enforcement), `${entry.capability} has an unknown enforcement level`);
    assert.ok(entry.mechanism.length > 0);
  }
  const network = ENFORCEMENT_MATRIX.find((entry) => entry.capability === 'network.outbound');
  assert.equal(network.enforcement, 'adapter', 'the installed Node build exposes no network permission flag, so network must not be claimed as Node-enforced');
  const claimedNode = ENFORCEMENT_MATRIX.filter((entry) => entry.enforcement === 'node').map((entry) => entry.capability);
  assert.deepEqual(claimedNode.sort(), ['addons', 'filesystem.read', 'filesystem.write', 'process', 'resources.max_heap_mb', 'wasi', 'worker']);
});

test('Phase 8 leaves the existing consumer contracts and graph wires unchanged', async () => {
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const prepared = await prepareGraph(definition, absoluteGraphFile);
  assert.equal(prepared.services.size, 4);
  assert.equal(definition.domain_wires.length, 4);
  assert.equal(definition.control_wires.length, 31);
  for (const instance of prepared.services.values()) {
    assert.deepEqual(instance.ports, instance.manifest.ports, `${instance.id} ports must come only from its manifest`);
    assert.deepEqual(instance.permissions, normalizePermissions(instance.manifest.permissions));
  }
});

async function shippedManifestPermissions() {
  const names = (await readdir(path.join(root, 'services'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const permissions = {};
  for (const name of names) {
    const manifest = JSON.parse(await readFile(path.join(root, 'services', name, 'service.json'), 'utf8'));
    permissions[manifest.service_name] = normalizePermissions(manifest.permissions);
  }
  return permissions;
}

function nodeManifest({ permissions = {}, resources, environment } = {}) {
  const manifest = {
    service_name: 'declaration-under-test',
    version: '1.0.0',
    runtime: { kind: 'node', entrypoint: 'index.mjs', ...(environment ? { environment } : {}) },
    permissions,
    ports: { domain: { accepts: [], emits: [] }, control: { accepts: [], emits: [] } },
    state: 'none',
    side_effects: []
  };
  if (resources) manifest.resources = resources;
  return manifest;
}

function whisperChunkInput(sequence) {
  return {
    message_id: `phase8-whisper-missing-${sequence}`,
    idempotency_key: `phase8-whisper-missing-${sequence}`,
    plane: 'domain',
    message_type: 'audio.chunk',
    timestamp: '2026-08-29T00:00:00.000Z',
    producer: 'phase8-permission-test',
    correlation_id: 'phase8-whisper-missing',
    schema_version: '1.2.0',
    payload: {
      chunk_id: `phase8-whisper-chunk-${sequence}`,
      session_id: 'phase8-whisper-missing',
      sequence,
      start_time: '00:00:00.000',
      end_time: '00:00:00.000',
      format: { encoding: 'pcm-signed-integer', sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, byte_order: 'little-endian' },
      sample_count: 2,
      byte_length: 4,
      audio_base64: 'AAABAA==',
      checksum: 'sha256:6b1e73a0094b7b812d3b9e22cffb4f8239319847522c4fa103753b6950020f93'
    }
  };
}

async function manifestFor(fixtureName) {
  const manifestPath = path.join(root, 'tests', 'fixtures', fixtureName, 'service.json');
  return { manifestPath, directory: path.dirname(manifestPath), manifest: JSON.parse(await readFile(manifestPath, 'utf8')) };
}

async function graphWithSource(fixtureName) {
  const { definition } = await loadGraphDefinition(graphFile);
  const changed = structuredClone(definition);
  changed.services.find((service) => service.id === 'transcript-source').manifest = `../tests/fixtures/${fixtureName}/service.json`;
  return changed;
}

/**
 * Write a graph clone two directories deep so its component and contract references stay relative
 * and contained; the extra `../` compensates for the added depth.
 */
async function writeTemporaryGraph(fixtureName, fileName) {
  const definition = await graphWithSource(fixtureName);
  definition.contracts = `../${definition.contracts}`;
  for (const service of definition.services) service.manifest = `../${service.manifest}`;
  await mkdir(temporaryGraphDirectory, { recursive: true });
  const target = path.join(temporaryGraphDirectory, fileName);
  await writeFile(target, `${JSON.stringify(definition, null, 2)}\n`, 'utf8');
  return target;
}

/** Launch a fixture through the real Node provider and read the single containment report it emits. */
async function runProbe(fixtureName, environmentOverrides = {}) {
  const { manifest, directory } = await manifestFor(fixtureName);
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), 'argus-phase8-'));
  const previous = new Map();
  const applied = { ARGUS_SESSION_ROOT: sessionRoot, ...environmentOverrides };
  for (const [key, value] of Object.entries(applied)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    const provider = createNodeProcessProvider();
    const lines = [];
    const diagnostics = [];
    let handle;
    const exited = new Promise((resolve, reject) => {
      handle = provider.start(
        { id: fixtureName, manifest, directory, entrypoint: path.join(directory, manifest.runtime.entrypoint), restartCount: 0 },
        {
          onMessage: (line) => lines.push(line),
          onDiagnostic: (line) => diagnostics.push(line),
          onError: reject,
          onExit: resolve
        }
      );
    });
    handle.closeInput();
    await exited;
    handle.dispose();
    assert.equal(lines.length, 1, `${fixtureName} must emit exactly one containment report. Diagnostics: ${diagnostics.join(' | ')}`);
    return JSON.parse(lines[0]);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(sessionRoot, { recursive: true, force: true });
  }
}
