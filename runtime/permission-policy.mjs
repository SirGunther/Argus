import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/** Repository root that hosts the shared component libraries every Node component imports. */
export const REPOSITORY_ROOT = path.resolve(moduleDirectory, '..');

/**
 * Intrinsic read authority of the Node runtime provider. A component cannot be launched at all
 * without reading its own directory and the shared `runtime/` and `contracts/` libraries, so this
 * is process-hosting mechanics rather than declared domain authority. It is deliberately finite:
 * everything outside these roots is denied unless a manifest declares it.
 */
export const SHARED_COMPONENT_LIBRARY_ROOTS = Object.freeze([
  path.join(REPOSITORY_ROOT, 'runtime'),
  path.join(REPOSITORY_ROOT, 'contracts')
]);

export const PERMISSION_CLASSES = Object.freeze([
  'filesystem',
  'microphone',
  'clipboard',
  'network',
  'model_credentials',
  'process',
  'worker',
  'addons',
  'wasi'
]);

/** Only host-neutral named scopes are declarable; raw host paths are never accepted from a manifest. */
export const FILESYSTEM_SCOPES = Object.freeze(['session-root', 'stt-runtime']);
export const FILESYSTEM_WRITE_SCOPES = Object.freeze(['session-root']);
export const NETWORK_OUTBOUND_SCOPES = Object.freeze(['loopback-http']);

/**
 * Every environment key a Node component may request, and what that key implies.
 * A `credential` key additionally requires an explicit `model_credentials` grant.
 */
export const SUPPORTED_ENVIRONMENT_KEYS = Object.freeze(new Map([
  ['ARGUS_MODEL_ENDPOINT', Object.freeze({ requiresNetworkScope: 'loopback-http' })],
  ['ARGUS_MODEL_NAME', Object.freeze({})],
  ['ARGUS_MODEL_TIMEOUT_MS', Object.freeze({})],
  ['ARGUS_MODEL_PROTOCOL', Object.freeze({})],
  ['ARGUS_SESSION_ROOT', Object.freeze({})],
  ['ARGUS_WHISPER_BINARY', Object.freeze({})],
  ['ARGUS_WHISPER_MODEL', Object.freeze({})],
  ['ARGUS_MODEL_API_KEY', Object.freeze({ credential: true })]
]));

/** Keys the provider injects after filtering; a manifest may never request them. */
export const PROVIDER_INJECTED_ENVIRONMENT_KEYS = Object.freeze(['ARGUS_SERVICE_INSTANCE_ID', 'ARGUS_RESTART_COUNT']);

/** Shape of an inherited variable treated as a credential regardless of which process set it. */
export const CREDENTIAL_KEY_PATTERN = /(^|_)(KEY|KEYS|TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS)$/;

export const DENIED_PERMISSIONS = Object.freeze({
  filesystem: Object.freeze({ read: Object.freeze([]), write: Object.freeze([]) }),
  microphone: Object.freeze({ granted: false }),
  clipboard: Object.freeze({ granted: false }),
  network: Object.freeze({ outbound: Object.freeze([]), listen: false }),
  model_credentials: Object.freeze({ granted: false }),
  process: Object.freeze({ granted: false }),
  worker: Object.freeze({ granted: false }),
  addons: Object.freeze({ granted: false }),
  wasi: Object.freeze({ granted: false })
});

export class PermissionDeclarationError extends Error {
  constructor(message, { code = 'PERMISSION_DECLARATION_INVALID', violations = [], manifestPath } = {}) {
    super(message);
    this.name = 'PermissionDeclarationError';
    this.code = code;
    this.violations = violations;
    this.manifestPath = manifestPath;
  }
}

/**
 * Canonicalize a declared permission block. Anything a manifest does not state is denied, so an
 * omitted class, an omitted scope list, and an explicit `false` all mean the same authority: none.
 */
export function normalizePermissions(declared) {
  const source = declared && typeof declared === 'object' ? declared : {};
  return Object.freeze({
    filesystem: Object.freeze({
      read: normalizeScopes(source.filesystem?.read),
      write: normalizeScopes(source.filesystem?.write)
    }),
    microphone: normalizeGrant(source.microphone),
    clipboard: normalizeGrant(source.clipboard),
    network: Object.freeze({
      outbound: normalizeScopes(source.network?.outbound),
      listen: source.network?.listen === true
    }),
    model_credentials: normalizeGrant(source.model_credentials),
    process: normalizeGrant(source.process),
    worker: normalizeGrant(source.worker),
    addons: normalizeGrant(source.addons),
    wasi: normalizeGrant(source.wasi)
  });
}

export function normalizeResources(declared) {
  const source = declared && typeof declared === 'object' ? declared : {};
  return Object.freeze({
    max_heap_mb: Number.isInteger(source.max_heap_mb) ? source.max_heap_mb : null,
    memory_mb: Number.isInteger(source.memory_mb) ? source.memory_mb : null,
    cpu_limit: typeof source.cpu_limit === 'number' ? source.cpu_limit : null
  });
}

/** Declared, deduplicated, POSIX-relative component files, excluding the manifest itself. */
export function declaredComponentFiles(manifest) {
  const runtime = manifest?.runtime || {};
  const declared = [];
  if (runtime.kind === 'node' && runtime.entrypoint) declared.push(runtime.entrypoint);
  if (runtime.kind === 'native' && runtime.executable) declared.push(runtime.executable);
  for (const include of runtime.includes || []) declared.push(include);
  return Object.freeze([...new Set(declared.map((entry) => String(entry).replaceAll('\\', '/')))].sort());
}

/**
 * Reject a manifest whose declaration cannot be honored by an installed provider or host adapter.
 * A capability the POC host cannot enforce is refused outright rather than silently accepted, so a
 * declaration never reads as a guarantee the runtime does not actually deliver.
 */
export function assertPermissionPolicy({ manifest, manifestPath = '<manifest>' }) {
  if (!manifest?.permissions || typeof manifest.permissions !== 'object' || Array.isArray(manifest.permissions)) {
    const violations = ['permissions must be declared explicitly; a component without a permission block has no authority to infer'];
    throw new PermissionDeclarationError(`Invalid permission declaration in ${manifestPath}: ${violations.join('; ')}`, { violations, manifestPath });
  }

  const violations = [];
  const permissions = normalizePermissions(manifest.permissions);
  const resources = normalizeResources(manifest.resources);
  const kind = manifest.runtime?.kind;
  const declaredEnvironment = manifest.runtime?.environment?.allow;
  const allowedEnvironment = Array.isArray(declaredEnvironment) ? declaredEnvironment : [];
  if (declaredEnvironment !== undefined && !Array.isArray(declaredEnvironment)) {
    violations.push('runtime.environment.allow must be an array of environment variable names');
  }

  for (const direction of ['read', 'write']) {
    for (const scope of permissions.filesystem[direction]) {
      const supportedScopes = direction === 'read' ? FILESYSTEM_SCOPES : FILESYSTEM_WRITE_SCOPES;
      if (!supportedScopes.includes(scope)) {
        violations.push(`filesystem.${direction} scope ${scope} is not a declarable authority; supported scopes are ${supportedScopes.join(', ')}`);
      }
    }
  }
  const sessionScoped = permissions.filesystem.read.includes('session-root') || permissions.filesystem.write.includes('session-root');
  if (sessionScoped && !allowedEnvironment.includes('ARGUS_SESSION_ROOT')) {
    violations.push('filesystem session-root authority requires ARGUS_SESSION_ROOT in runtime.environment.allow; without it the component cannot learn which root it was granted');
  }
  if (permissions.filesystem.read.includes('stt-runtime')) {
    for (const key of ['ARGUS_WHISPER_BINARY', 'ARGUS_WHISPER_MODEL']) {
      if (!allowedEnvironment.includes(key)) {
        violations.push(`filesystem stt-runtime authority requires ${key} in runtime.environment.allow; without it the provider cannot map the named scope to its exact asset`);
      }
    }
  }

  if (permissions.microphone.granted) {
    violations.push('microphone capture cannot be granted: no installed runtime provider or host adapter implements device capture (AUD-002 remains deferred)');
  }
  if (permissions.clipboard.granted) {
    violations.push('clipboard access cannot be granted to a component process: the clipboard stays behind the host capability adapter reached through governed UI commands (ADR-017)');
  }
  if (permissions.model_credentials.granted) {
    violations.push('model credentials cannot be granted: no secret store or credential provider is selected (SEC-001 remains deferred)');
  }

  for (const scope of permissions.network.outbound) {
    if (!NETWORK_OUTBOUND_SCOPES.includes(scope)) {
      violations.push(`network.outbound scope ${scope} is not declarable; supported scopes are ${NETWORK_OUTBOUND_SCOPES.join(', ')}`);
    }
  }
  if (permissions.network.listen) {
    violations.push('network.listen cannot be granted: no component may bind a listener in this host, and the loopback UI bridge is not a graph component');
  }

  for (const key of allowedEnvironment) {
    const supported = SUPPORTED_ENVIRONMENT_KEYS.get(key);
    if (!supported) {
      violations.push(`runtime.environment.allow requests unsupported configuration key ${key}`);
      continue;
    }
    if (supported.credential && !permissions.model_credentials.granted) {
      violations.push(`runtime.environment.allow requests credential-bearing key ${key} without a model_credentials grant`);
    }
    if (supported.requiresNetworkScope && !permissions.network.outbound.includes(supported.requiresNetworkScope)) {
      violations.push(`runtime.environment.allow requests ${key} without network.outbound ${supported.requiresNetworkScope}; a component may not be configured to reach an endpoint it is not permitted to reach`);
    }
  }

  if (kind !== 'container') {
    if (resources.memory_mb !== null) violations.push('resources.memory_mb is enforceable only by a container provider; no OCI engine is installed (CNT-001 remains deferred)');
    if (resources.cpu_limit !== null) violations.push('resources.cpu_limit is enforceable only by a container provider; no OCI engine is installed (CNT-001 remains deferred)');
  }
  if (kind !== 'node' && resources.max_heap_mb !== null) {
    violations.push('resources.max_heap_mb is enforced through the Node heap ceiling and is declarable only on a node runtime');
  }

  for (const relative of declaredComponentFiles(manifest)) {
    if (!isContainedRelativePath(relative)) {
      violations.push(`runtime file ${relative} must be a component-relative path without traversal, absolute roots, or drive letters`);
    }
  }

  if (violations.length) {
    const unsupported = violations.some((violation) => violation.includes('cannot be granted') || violation.includes('enforceable only'));
    throw new PermissionDeclarationError(
      `Invalid permission declaration in ${manifestPath}: ${violations.join('; ')}`,
      { code: unsupported ? 'CAPABILITY_UNSUPPORTED' : 'PERMISSION_DECLARATION_INVALID', violations, manifestPath }
    );
  }

  return { permissions, resources };
}

/**
 * Translate a validated declaration into the flags the installed Node permission model honors.
 * Node 24.11.1 exposes --permission with --allow-fs-read, --allow-fs-write, --allow-child-process,
 * --allow-worker, --allow-addons, and --allow-wasi. It exposes no network flag, so outbound network
 * stays adapter-enforced and is reported here as unenforced rather than claimed.
 */
export function resolveNodePermissionPlan({
  manifest,
  directory,
  environment = process.env,
  sharedReadRoots = SHARED_COMPONENT_LIBRARY_ROOTS,
  sttRuntimePaths = []
}) {
  const { permissions, resources } = assertPermissionPolicy({ manifest });
  const allowedEnvironment = manifest.runtime?.environment?.allow || [];
  const reads = [path.resolve(directory), ...sharedReadRoots.map((root) => path.resolve(root))];
  const writes = [];
  const unenforced = [];

  const configuredRoot = allowedEnvironment.includes('ARGUS_SESSION_ROOT') ? environment.ARGUS_SESSION_ROOT : undefined;
  const configuredSessionRoot = typeof configuredRoot === 'string' && configuredRoot.trim() ? path.resolve(configuredRoot.trim()) : null;
  // SessionStorage canonicalizes an existing root with realpath(). Use the same canonical case
  // for Windows Node permission flags; otherwise C:\Temp and C:\temp are treated as different
  // permission resources even though they address the same directory.
  const sessionRoot = configuredSessionRoot ? canonicalExistingPath(configuredSessionRoot) : null;
  if (permissions.filesystem.read.includes('session-root') && sessionRoot) reads.push(configuredSessionRoot, sessionRoot, path.dirname(configuredSessionRoot), path.dirname(sessionRoot));
  if (permissions.filesystem.write.includes('session-root') && sessionRoot) writes.push(configuredSessionRoot, sessionRoot);
  if (permissions.filesystem.read.includes('stt-runtime')) reads.push(...sttRuntimePaths);

  const execArgv = ['--permission'];
  for (const grantedPath of unique(reads)) execArgv.push(`--allow-fs-read=${grantedPath}`);
  for (const grantedPath of unique(writes)) execArgv.push(`--allow-fs-write=${grantedPath}`);
  if (permissions.process.granted) execArgv.push('--allow-child-process');
  if (permissions.worker.granted) execArgv.push('--allow-worker');
  if (permissions.addons.granted) execArgv.push('--allow-addons');
  if (permissions.wasi.granted) execArgv.push('--allow-wasi');
  if (resources.max_heap_mb !== null) execArgv.push(`--max-old-space-size=${resources.max_heap_mb}`);

  if (permissions.network.outbound.length) {
    unenforced.push('network.outbound is adapter-enforced: the installed Node build exposes no network permission flag, so loopback-only restriction is proven at the model configuration boundary instead of by the operating system');
  }

  return Object.freeze({
    execArgv: Object.freeze(execArgv),
    permissions,
    resources,
    sessionRoot,
    grantedReadPaths: Object.freeze(unique(reads)),
    grantedWritePaths: Object.freeze(unique(writes)),
    unenforced: Object.freeze(unenforced)
  });
}

/**
 * Honest per-capability enforcement record. `node` means the Node runtime refuses or limits the
 * operation; `adapter` means an Argus boundary refuses it in process; `deferred` means no installed
 * provider can enforce it, so the capability is refused at declaration time instead of simulated.
 */
export const ENFORCEMENT_MATRIX = Object.freeze([
  Object.freeze({ capability: 'filesystem.read', enforcement: 'node', mechanism: 'Node --permission with --allow-fs-read limited to the component directory, the shared component libraries, a granted session root, and exact files in a granted stt-runtime scope' }),
  Object.freeze({ capability: 'filesystem.write', enforcement: 'node', mechanism: 'Node --permission with --allow-fs-write; a component with no write grant cannot write anywhere, including its own directory' }),
  Object.freeze({ capability: 'process', enforcement: 'node', mechanism: 'Node --permission denies child processes unless --allow-child-process is granted' }),
  Object.freeze({ capability: 'worker', enforcement: 'node', mechanism: 'Node --permission denies worker threads unless --allow-worker is granted' }),
  Object.freeze({ capability: 'addons', enforcement: 'node', mechanism: 'Node --permission denies native add-ons unless --allow-addons is granted' }),
  Object.freeze({ capability: 'wasi', enforcement: 'node', mechanism: 'Node --permission denies WASI unless --allow-wasi is granted' }),
  Object.freeze({ capability: 'resources.max_heap_mb', enforcement: 'node', mechanism: 'Node --max-old-space-size applies the declared V8 heap ceiling' }),
  Object.freeze({ capability: 'environment', enforcement: 'adapter', mechanism: 'the Node provider rebuilds the child environment from the declared allowlist and drops every other ARGUS_ variable and every credential-shaped inherited variable' }),
  Object.freeze({ capability: 'network.outbound', enforcement: 'adapter', mechanism: 'the installed Node build has no network permission flag; loopback-only http is enforced by the model configuration boundary and by refusing ARGUS_MODEL_ENDPOINT without the declared scope' }),
  Object.freeze({ capability: 'network.listen', enforcement: 'deferred', mechanism: 'refused at declaration time; a component listener would need a provider that can bind and restrict sockets' }),
  Object.freeze({ capability: 'microphone', enforcement: 'deferred', mechanism: 'refused at declaration time; device capture needs a host that owns the device boundary (AUD-002)' }),
  Object.freeze({ capability: 'clipboard', enforcement: 'deferred', mechanism: 'refused at declaration time for components; the host capability adapter behind governed UI commands remains the only clipboard path (ADR-017)' }),
  Object.freeze({ capability: 'model_credentials', enforcement: 'deferred', mechanism: 'refused at declaration time; no secret store or credential provider is selected (SEC-001)' }),
  Object.freeze({ capability: 'resources.memory_mb', enforcement: 'deferred', mechanism: 'refused outside a container runtime; no OCI engine is installed (CNT-001)' }),
  Object.freeze({ capability: 'resources.cpu_limit', enforcement: 'deferred', mechanism: 'refused outside a container runtime; no OCI engine is installed (CNT-001)' })
]);

export function isContainedRelativePath(relative) {
  if (typeof relative !== 'string' || !relative.length) return false;
  const normalized = relative.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return false;
  return !normalized.split('/').some((segment) => segment === '..' || segment === '.' || segment === '');
}

function normalizeGrant(value) {
  return Object.freeze({ granted: value?.granted === true });
}

function normalizeScopes(value) {
  return Object.freeze(Array.isArray(value) ? [...new Set(value.map(String))].sort() : []);
}

function unique(values) {
  return [...new Set(values)];
}

function canonicalExistingPath(value) {
  try { return realpathSync.native(value); } catch { return value; }
}
