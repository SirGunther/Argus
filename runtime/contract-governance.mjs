const SEMVER_PATTERN = /^(?<major>[1-9]\d*)\.(?<minor>\d+)\.(?<patch>\d+)$/;

export function parseContractVersion(version, label = 'contract version') {
  if (typeof version !== 'string') throw new Error(`${label} must be a semantic version string`);
  const match = SEMVER_PATTERN.exec(version);
  if (!match) throw new Error(`${label} must match MAJOR.MINOR.PATCH`);
  return Object.fromEntries(Object.entries(match.groups).map(([key, value]) => [key, Number(value)]));
}

export function compareContractVersions(producedVersion, currentVersion) {
  const produced = parseContractVersion(producedVersion, 'produced contract version');
  const current = parseContractVersion(currentVersion, 'catalog contract version');
  if (produced.major !== current.major) {
    return { compatible: false, reason: `major version ${produced.major} is incompatible with registered major ${current.major}` };
  }
  if (produced.minor > current.minor) {
    return { compatible: false, reason: `minor version ${produced.minor} is newer than registered minor ${current.minor}` };
  }
  return { compatible: true };
}

export function assertCatalogGovernance(catalog) {
  parseContractVersion(catalog.schema_version, 'catalog schema_version');
  const governance = catalog.governance;
  if (!governance || governance.compatibility_policy !== 'backward-compatible-minor') {
    throw new Error('Catalog governance.compatibility_policy must be backward-compatible-minor');
  }
  if (governance.plane_change !== 'breaking') throw new Error('Catalog governance.plane_change must be breaking');
  if (governance.validation !== 'ajv-draft-07-runtime-boundary') throw new Error('Catalog governance.validation must be ajv-draft-07-runtime-boundary');
  if (!Number.isInteger(governance.default_max_payload_bytes) || governance.default_max_payload_bytes < 1) {
    throw new Error('Catalog governance.default_max_payload_bytes must be a positive integer');
  }
}

export function assertMessageGovernance(messageType, definition, governance) {
  if (!['domain', 'control'].includes(definition.plane)) throw new Error(`${messageType} must declare a domain or control plane`);
  parseContractVersion(definition.version, `${messageType} version`);
  for (const field of ['owner', 'schema', 'changelog']) {
    if (typeof definition[field] !== 'string' || !definition[field]) throw new Error(`${messageType} must declare ${field}`);
  }
  const limit = definition.max_payload_bytes ?? governance.default_max_payload_bytes;
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`${messageType} max_payload_bytes must be a positive integer`);
  definition.max_payload_bytes = limit;
}

export function assertGovernedEvolution(previousCatalog, currentCatalog) {
  const previousCatalogVersion = parseContractVersion(previousCatalog.schema_version, 'previous catalog schema_version');
  const currentCatalogVersion = parseContractVersion(currentCatalog.schema_version, 'current catalog schema_version');

  for (const [messageType, previous] of Object.entries(previousCatalog.messages || {})) {
    const current = currentCatalog.messages?.[messageType];
    if (!current) {
      if (currentCatalogVersion.major <= previousCatalogVersion.major) {
        throw new Error(`Removing ${messageType} requires a catalog major-version increase`);
      }
      continue;
    }

    const previousVersion = parseContractVersion(previous.version, `previous ${messageType} version`);
    const currentVersion = parseContractVersion(current.version, `current ${messageType} version`);
    if (currentVersion.major < previousVersion.major || (currentVersion.major === previousVersion.major && currentVersion.minor < previousVersion.minor)) {
      throw new Error(`${messageType} version may not move backward`);
    }
    if (current.plane !== previous.plane && currentVersion.major <= previousVersion.major) {
      throw new Error(`${messageType} plane changed from ${previous.plane} to ${current.plane}; a new contract major version is required`);
    }
  }
}
