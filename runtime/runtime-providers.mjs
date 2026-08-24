import { createNodeProcessProvider } from './providers/node-process-provider.mjs';

/**
 * A manifest may declare `node`, `native`, or `container`. Only `node` has an installed trusted
 * provider, so the other kinds are refused during graph preparation — before any process is
 * launched and before any wire is considered live. Selecting a runtime grants nothing by itself.
 */
export class RuntimeProviderUnavailableError extends Error {
  constructor(kind, installedKinds) {
    super(`No trusted runtime provider is installed for kind: ${kind}. Installed providers: ${installedKinds.join(', ')}. A native toolchain (NAT-001) or OCI engine (CNT-001) must be selected, installed, and proven against the conformance suite before a ${kind} component can launch.`);
    this.name = 'RuntimeProviderUnavailableError';
    this.code = 'RUNTIME_PROVIDER_UNAVAILABLE';
    this.runtimeKind = kind;
    this.installedKinds = installedKinds;
  }
}

export const DECLARABLE_RUNTIME_KINDS = Object.freeze(['node', 'native', 'container']);

export function createRuntimeProviderRegistry() {
  const providers = new Map([['node', createNodeProcessProvider()]]);
  return {
    get(kind) {
      const provider = providers.get(kind);
      if (!provider) throw new RuntimeProviderUnavailableError(kind, [...providers.keys()]);
      return provider;
    },
    has(kind) {
      return providers.has(kind);
    },
    installedKinds() {
      return [...providers.keys()];
    }
  };
}
