# Argus Polyglot Runtime Strategy

## Status

**Accepted architectural direction; provider boundary implemented with Node services hosted by the Electron standalone product.**

Argus is intended to be a polyglot, container-capable component system. Node.js remains the baseline orchestration host and first service runtime, but it is not the required language for every component and must not become an accidental system-wide dependency.

This document is a required reference for changes to service manifests, process launching, transport, supervision, permissions, packaging, and component acceptance tests.

## Current truth

The architecture is already language-neutral at its message boundary:

- components are separate processes;
- components do not import one another's implementation code;
- interaction uses versioned JSON envelopes and declared contracts;
- domain and control connections are explicit and default-deny;
- state, side effects, and authority belong to declared component boundaries;
- replacements are judged through contracts and shared tests.

The executable launcher is runtime-neutral in shape but not yet polyglot in component-provider capability:

- `service-manifest.schema.json` discriminates `node`, `native`, and `container` declarations without accepting arbitrary commands, and requires an explicit default-deny `permissions` block on every manifest;
- the orchestrator resolves launch mechanics through a trusted provider registry;
- only the Node provider is installed and operational;
- the Node provider translates declared authority into real `node --permission` flags and rebuilds the child environment from the declared allowlist;
- every current implementation is JavaScript;
- native executables and OCI containers have no launcher providers, and such manifests fail graph preparation with `RUNTIME_PROVIDER_UNAVAILABLE` before any process launches;
- cross-runtime conformance has not been proven.

Therefore, **polyglot is an accepted invariant and roadmap requirement, not a capability claim for native or OCI execution**. Unsupported provider kinds fail closed during graph preparation. Electron is the desktop host, not an additional domain component runtime: it hosts the same governed Node provider boundary and does not weaken the runtime-neutral contracts.

## Architectural objective

Any component may use the runtime best suited to its capability—Node.js, C, Rust, Go, Python, or a containerized tool—when it honors the same governed boundary.

```text
service manifest
      |
      v
runtime-provider boundary
      |
      +-- Node process
      +-- native executable
      +-- OCI container
      |
      v
same contracts + ports + wires + supervision + conformance tests
```

The graph should know what a component accepts, emits, owns, and is authorized to do. It should not need to know which language implements the capability.

## Non-negotiable invariants

A runtime or deployment change may not weaken these rules:

1. **Contracts, not language APIs, are the integration surface.** No component imports another component's business implementation.
2. **Wiring remains explicit and default-deny.** Installing or launching a component grants no connectivity by itself.
3. **Domain and control planes remain distinct.** A runtime provider cannot create hidden lifecycle, failure, health, completion, or domain routes.
4. **The runtime kernel does not acquire domain authority.** Launchers host and supervise; they do not interpret or transform domain payload meaning.
5. **Contract governance applies equally to every language.** Versions, plane, ownership, schema, history, and payload limits remain authoritative.
6. **State and side effects remain declared.** A container boundary or separate executable does not make undeclared state or effects acceptable.
7. **Permissions are explicit capabilities.** Filesystem, microphone, clipboard, network, devices, volumes, credentials, and model access are denied unless granted. A capability the installed host cannot enforce is refused at declaration time rather than accepted and simulated, and every enforcement claim states whether it is Node-runtime-enforced, adapter-enforced, or deferred.
8. **Diagnostics never share the domain output channel.** Protocol messages and operational traces remain separable on every transport.
9. **Replacement is proven, not asserted.** A new runtime passes the same fixtures, contract checks, failure tests, graph position, and downstream assertions.
10. **No unrestricted shell manifests.** Manifests select a trusted launcher kind and validated fields; they do not supply arbitrary command strings.

## Runtime-provider boundary

The orchestrator should depend on a narrow runtime-provider interface rather than directly calling Node:

```text
prepare(manifest, componentDirectory) -> launch specification
start(launch specification, stdio/transport endpoints) -> running component
observe(running component) -> start/exit/resource events
drain(running component, deadline) -> graceful outcome
terminate(running component) -> forced outcome
```

Providers own runtime mechanics only. Contract validation, endpoint identity, declared wires, routing, and architectural policy remain above them.

Initial trusted provider kinds should be:

- **`node`** — a JavaScript module launched by the configured Node host;
- **`native`** — a repository/package-relative executable with validated arguments;
- **`container`** — an immutable OCI image reference with explicit resources and capabilities.

Additional providers require an architectural decision, manifest-schema change, negative tests, and a security review.

## Directional manifest shapes

These examples communicate the governed declaration shapes. Node is executable; native and container declarations validate structurally but cannot launch until their trusted providers are installed.

Every shape below also carries a required top-level `permissions` block. Anything it does not state is denied.

### Node

```json
{
  "runtime": {
    "kind": "node",
    "entrypoint": "index.mjs",
    "includes": ["model-boundary.mjs"],
    "environment": { "allow": ["ARGUS_SESSION_ROOT"] }
  },
  "permissions": {
    "filesystem": { "read": ["session-root"], "write": ["session-root"] }
  }
}
```

`includes` declares every additional file the component ships; packaging refuses a component directory that contains a file no declaration accounts for. Filesystem authority is a host-neutral named scope, never a host path, so the same declaration can later be mapped onto a container mount without a manifest change.

### Native executable

```json
{
  "runtime": {
    "kind": "native",
    "executable": "bin/window-selector.exe",
    "arguments": []
  }
}
```

### OCI container

```json
{
  "runtime": {
    "kind": "container",
    "image": "registry.example/argus/log-extractor@sha256:<digest>",
    "network": "none",
    "read_only_root": true,
    "memory_mb": 256,
    "cpu_limit": 1.0,
    "mounts": [],
    "devices": [],
    "secrets": []
  }
}
```

Container images must be immutable digest references in governed environments. Mutable tags alone are insufficient for replay, audit, and replacement evidence.

## Inbound and outbound boundaries

Every provider must preserve equivalent observable behavior:

- one complete governed input envelope at a time;
- one complete governed output envelope at a time;
- contract validation before routing;
- bounded inbound frame and payload sizes;
- declared producer identity and correlation/causation metadata;
- a dedicated diagnostic stream or channel;
- explicit lifecycle, health, readiness, drain, failure, and completion messages where the graph grants those capabilities;
- no undeclared network listener, filesystem path, device, volume, credential, or host integration.

NDJSON over standard input/output remains the first local proof transport. It is language-neutral and useful for deterministic tests, but it is not mandated forever. High-frequency audio may require binary streaming, shared immutable buffers, sockets, or a broker. A transport substitution must preserve the same authority, contract, routing, size, correlation, and supervision rules.

## Containerization is not the architecture

A container is one possible isolation and packaging mechanism. It does not by itself provide the Argus guarantees.

A containerized component is conforming only when:

- the graph still contains every allowed relationship;
- the image receives only declared capabilities;
- network access is deny-by-default;
- mounts, devices, credentials, and environment data are explicit;
- resource bounds and termination behavior are declared;
- image identity is versioned and reproducible;
- health and shutdown semantics use governed control paths;
- the same contract and replacement suites pass outside and inside the container.

## Runtime selection criteria

The default is the simplest runtime that meets the capability's measured needs. A different language or container is justified by evidence such as:

- latency or throughput requirements;
- memory or startup constraints;
- access to a uniquely suitable library or hardware interface;
- stronger sandboxing or deployment isolation;
- portability or packaging requirements;
- an independently maintained external tool whose boundary is more stable than a rewrite.

Runtime novelty alone is not a reason. Selection evidence and operational cost belong in the decision/changelog record.

## Cross-runtime conformance suite

Every implementation, regardless of language or packaging, must prove:

- manifest validity and declared runtime kind;
- valid-input behavior using versioned shared fixtures;
- invalid-input conversion to canonical `service.failure` where appropriate;
- valid output envelopes, versions, planes, payload sizes, and producer identity;
- no undeclared output contract or diagnostic text on the protocol channel;
- correct startup, readiness, drain, deadline, exit, and forced-termination behavior;
- compliance with declared state, side effects, and permissions;
- installation in the same graph position without consumer or wire changes;
- identical downstream assertions for behavior that the contract promises;
- observable performance/resource measurements when optimization motivates the replacement.

Semantic output may differ where the contract allows it, as the concise and passthrough extractors already demonstrate. Contractual behavior may not.

## Recommended proof sequence

1. Complete the supervision contracts needed by all runtime providers: health/readiness, graceful drain deadline, process-exit policy, timeout, and bounded transport behavior.
2. Replace the direct Node spawn with a provider registry while keeping existing Node behavior green.
3. Evolve the service manifest into a discriminated, default-deny runtime declaration. **Done** — see ADR-018 and the Phase 8 evidence artifact.
4. Add a small native implementation—C, Rust, or Go—of an existing stateless component.
5. Run the retained contract fixtures and install both implementations in the same graph position.
6. Package one implementation as an OCI container with no network and no undeclared mounts/capabilities.
7. Repeat the same replacement, failure, shutdown, and resource tests.
8. Measure startup, idle memory, throughput, routing latency, shutdown, and packaging cost before broadening adoption.

The first polyglot component should be small and deterministic. The context-window selector or a deterministic extractor is a better proof target than audio capture or a model adapter because it isolates runtime interoperability from external dependencies.

## Definition of polyglot proof complete

Argus may claim executable polyglot support only when:

- at least two implementation languages run through trusted providers;
- both implementations occupy the same graph position without wire or consumer changes;
- the shared conformance and replacement suites pass;
- health, readiness, failure, drain, timeout, and exit behavior are equivalent;
- permissions and resource limits are enforced rather than documented only;
- at least one implementation completes the same proof both locally and as an OCI container;
- measurements and remaining trade-offs are recorded.

Until then, documentation must say **runtime-neutral provider boundary, Node-only active provider**.

## Relationship to the roadmap

- **Phase 1 — Contract governance:** complete and foundational.
- **Phase 2 — Runtime supervision:** complete for the POC, including runtime-neutral lifecycle behavior before provider expansion.
- **Runtime-provider and polyglot proof:** an explicit architectural workstream spanning supervision and permissions/packaging.
- **Permissions and packaging:** the Node-host foundation is complete — default-deny declarations, Node-enforced filesystem/child-process/worker/add-on/WASI/heap restrictions, environment and credential containment, fail-closed unavailable providers, and deterministic inspectable packages with integrity hashes. See `Architecture/PermissionsPackagingPhase8Evidence.md`. Per-provider enforcement for native and container runtimes, and OS-enforced network restriction, still require those providers.
- **Observability and acceptance:** must compare runtime providers using the same correlation and resource measures.

This goal does not require replacing the Node orchestrator. Node can remain the composition host as long as its launcher boundary becomes runtime-neutral and its authority stays finite.
