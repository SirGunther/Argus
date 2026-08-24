import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { prepareGraph, loadGraphDefinition } from './orchestrator.mjs';
import {
  REPOSITORY_ROOT,
  SHARED_COMPONENT_LIBRARY_ROOTS,
  declaredComponentFiles,
  normalizePermissions,
  normalizeResources
} from './permission-policy.mjs';

export const PACKAGE_FORMAT = 'argus.package.v1';
export const PACKAGE_HASH_ALGORITHM = 'sha256';

/**
 * Patterns that must never appear in a packaged artifact. They are deliberately shaped rather than
 * generic so a real credential is caught while ordinary source text is not.
 */
export const SECRET_PATTERNS = Object.freeze([
  Object.freeze({ name: 'pem-private-key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ }),
  Object.freeze({ name: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/ }),
  Object.freeze({ name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ }),
  Object.freeze({ name: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ }),
  Object.freeze({ name: 'assigned-secret-literal', pattern: /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|passwd)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i })
]);

export class PackageIntegrityError extends Error {
  constructor(message, { code = 'PACKAGE_INTEGRITY_VIOLATION', findings = [] } = {}) {
    super(message);
    this.name = 'PackageIntegrityError';
    this.code = code;
    this.findings = findings;
  }
}

/** Deterministic JSON: recursively key-sorted, two-space indented, newline-terminated. */
export function stableStringify(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function relativePackagePath(root, absolutePath) {
  const relative = path.relative(path.resolve(root), path.resolve(absolutePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PackageIntegrityError(
      `Package path escapes the package root: ${absolutePath} is not contained by ${root}`,
      { code: 'PACKAGE_PATH_ESCAPE', findings: [{ path: absolutePath, root: path.resolve(root) }] }
    );
  }
  return relative.replaceAll('\\', '/');
}

/**
 * Build the inspectable, deterministic inventory for one graph: the graph itself, the governed
 * contract catalog and every schema/changelog it names, each component manifest with its declared
 * authority and declared files, and the shared component libraries those components import. The
 * same tree always produces the same bytes, because nothing timestamped, absolute, or random enters
 * the artifact.
 */
export async function buildGraphPackage({ graphFile, root = REPOSITORY_ROOT }) {
  const packageRoot = path.resolve(root);
  const { definition, graphFile: absoluteGraphFile } = await loadGraphDefinition(graphFile);
  const prepared = await prepareGraph(definition, absoluteGraphFile);
  const inventory = new Map();

  const record = async (absolutePath, role) => {
    const relative = relativePackagePath(packageRoot, absolutePath);
    const bytes = await readFile(absolutePath);
    assertNoSecrets(relative, bytes);
    const existing = inventory.get(relative);
    const digest = createHash(PACKAGE_HASH_ALGORITHM).update(bytes).digest('hex');
    if (existing && existing.sha256 !== digest) {
      throw new PackageIntegrityError(`Package inventory produced two different hashes for ${relative}`, { findings: [{ path: relative }] });
    }
    inventory.set(relative, { path: relative, sha256: digest, bytes: bytes.length });
    return { path: relative, sha256: digest, bytes: bytes.length, role };
  };

  const graphEntry = await record(absoluteGraphFile, 'graph');

  const catalogPath = path.resolve(prepared.graphDirectory, definition.contracts);
  const catalogDirectory = path.dirname(catalogPath);
  const catalog = prepared.registry.catalog;
  const contractFiles = [await record(catalogPath, 'contract-catalog')];
  contractFiles.push(await record(path.resolve(catalogDirectory, catalog.envelope), 'contract-envelope'));
  for (const [artifactType, relativeSchema] of Object.entries(catalog.artifacts || {}).sort(byKey)) {
    contractFiles.push(await record(path.resolve(catalogDirectory, relativeSchema), `artifact-schema:${artifactType}`));
  }
  const messages = [];
  for (const [messageType, message] of Object.entries(catalog.messages).sort(byKey)) {
    contractFiles.push(await record(path.resolve(catalogDirectory, message.schema), `message-schema:${messageType}`));
    contractFiles.push(await record(path.resolve(catalogDirectory, message.changelog), `message-changelog:${messageType}`));
    messages.push({
      message_type: messageType,
      version: message.version,
      plane: message.plane,
      owner: message.owner,
      max_payload_bytes: message.max_payload_bytes,
      schema: relativePackagePath(packageRoot, path.resolve(catalogDirectory, message.schema)),
      changelog: relativePackagePath(packageRoot, path.resolve(catalogDirectory, message.changelog))
    });
  }

  const components = [];
  for (const instance of prepared.services.values()) {
    const manifest = instance.manifest;
    const manifestEntry = await record(instance.manifestPath, 'service-manifest');
    const declared = declaredComponentFiles(manifest);
    const files = [];
    for (const relative of declared) {
      files.push(await record(path.resolve(instance.directory, relative), 'component-file'));
    }
    const declaredAbsolute = new Set([
      path.resolve(instance.manifestPath),
      ...declared.map((relative) => path.resolve(instance.directory, relative))
    ]);
    const undeclared = (await listFilesRecursively(instance.directory)).filter((candidate) => !declaredAbsolute.has(candidate));
    if (undeclared.length) {
      throw new PackageIntegrityError(
        `Component ${instance.id} contains files the manifest does not declare: ${undeclared.map((candidate) => relativePackagePath(packageRoot, candidate)).join(', ')}`,
        { code: 'UNDECLARED_PACKAGE_FILE', findings: undeclared.map((candidate) => ({ path: relativePackagePath(packageRoot, candidate), component: instance.id })) }
      );
    }
    components.push({
      service_instance: instance.id,
      service_name: manifest.service_name,
      version: manifest.version,
      runtime_kind: manifest.runtime.kind,
      required: instance.required === true,
      manifest: { path: manifestEntry.path, sha256: manifestEntry.sha256, bytes: manifestEntry.bytes },
      files: files.map(({ path: filePath, sha256, bytes }) => ({ path: filePath, sha256, bytes })),
      environment_allow: [...(manifest.runtime.environment?.allow || [])].sort(),
      permissions: normalizePermissions(manifest.permissions),
      resources: normalizeResources(manifest.resources),
      state: manifest.state,
      side_effects: [...manifest.side_effects]
    });
  }
  components.sort((left, right) => left.service_instance.localeCompare(right.service_instance));

  const sharedLibraries = [];
  for (const libraryRoot of SHARED_COMPONENT_LIBRARY_ROOTS) {
    for (const absolutePath of await listFilesRecursively(libraryRoot)) {
      if (path.extname(absolutePath) !== '.mjs') continue;
      const entry = await record(absolutePath, 'shared-library');
      sharedLibraries.push({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes });
    }
  }
  sharedLibraries.sort((left, right) => left.path.localeCompare(right.path));

  const files = [...inventory.values()].sort((left, right) => left.path.localeCompare(right.path));
  const body = {
    package_format: PACKAGE_FORMAT,
    graph: {
      name: definition.name,
      schema_version: definition.schema_version,
      path: graphEntry.path,
      sha256: graphEntry.sha256,
      service_instances: [...prepared.services.keys()].sort(),
      runtime_components: definition.runtime_components.map((component) => component.id).sort(),
      domain_wire_count: definition.domain_wires.length,
      control_wire_count: definition.control_wires.length
    },
    contracts: {
      catalog_schema_version: catalog.schema_version,
      catalog: { path: contractFiles[0].path, sha256: contractFiles[0].sha256 },
      messages
    },
    components,
    shared_libraries: sharedLibraries,
    integrity: {
      algorithm: PACKAGE_HASH_ALGORITHM,
      file_count: files.length,
      total_bytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
      files
    }
  };
  body.integrity.package_digest = digestInventory(body);
  return body;
}

/**
 * Recompute the package from the working tree and compare it with a recorded artifact. Any changed,
 * missing, or added file, and any changed digest, is reported explicitly rather than tolerated.
 */
export async function verifyGraphPackage({ graphFile, root = REPOSITORY_ROOT, recorded }) {
  const rebuilt = await buildGraphPackage({ graphFile, root });
  const findings = [];
  if (recorded?.package_format !== rebuilt.package_format) {
    findings.push({ kind: 'format', expected: rebuilt.package_format, actual: recorded?.package_format ?? null });
  }
  const recordedFiles = new Map((recorded?.integrity?.files || []).map((entry) => [entry.path, entry]));
  for (const entry of rebuilt.integrity.files) {
    const previous = recordedFiles.get(entry.path);
    if (!previous) findings.push({ kind: 'missing-from-package', path: entry.path, actual: entry.sha256 });
    else if (previous.sha256 !== entry.sha256) findings.push({ kind: 'hash-mismatch', path: entry.path, expected: previous.sha256, actual: entry.sha256 });
    recordedFiles.delete(entry.path);
  }
  for (const entry of recordedFiles.values()) {
    findings.push({ kind: 'no-longer-present', path: entry.path, expected: entry.sha256 });
  }
  if (recorded?.integrity?.package_digest !== rebuilt.integrity.package_digest) {
    findings.push({ kind: 'package-digest', expected: recorded?.integrity?.package_digest ?? null, actual: rebuilt.integrity.package_digest });
  }
  return { verified: findings.length === 0, findings, rebuilt };
}

export function assertVerifiedGraphPackage(result, label) {
  if (result.verified) return result;
  throw new PackageIntegrityError(
    `Package integrity check failed for ${label}: ${result.findings.map(describeFinding).join('; ')}`,
    { findings: result.findings }
  );
}

export function digestInventory(body) {
  const canonical = stableStringify({
    package_format: body.package_format,
    graph: body.graph.name,
    algorithm: body.integrity.algorithm,
    files: body.integrity.files.map((entry) => [entry.path, entry.sha256])
  });
  return createHash(PACKAGE_HASH_ALGORITHM).update(canonical, 'utf8').digest('hex');
}

export function assertNoSecrets(relativePath, bytes) {
  // A NUL byte marks a binary artifact; the text patterns below would be meaningless against it.
  if (bytes.includes(0)) return;
  const text = bytes.toString('utf8');
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new PackageIntegrityError(
        `Refusing to package ${relativePath}: it matches the ${name} secret pattern`,
        { code: 'PACKAGED_SECRET_DETECTED', findings: [{ path: relativePath, pattern: name }] }
      );
    }
  }
}

async function listFilesRecursively(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursively(absolutePath));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

function describeFinding(finding) {
  if (finding.kind === 'hash-mismatch') return `${finding.path} changed from ${finding.expected} to ${finding.actual}`;
  if (finding.kind === 'missing-from-package') return `${finding.path} is not recorded in the package`;
  if (finding.kind === 'no-longer-present') return `${finding.path} is recorded but no longer produced`;
  if (finding.kind === 'package-digest') return `package digest changed from ${finding.expected} to ${finding.actual}`;
  return `${finding.kind} mismatch`;
}

function byKey(left, right) {
  return left[0].localeCompare(right[0]);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}
