# Phase 8 Permissions and Packaging Evidence

## Status

Implemented as one cohesive batch on 2026-08-22 and extended on 2026-09-01 by ADR-020. The browser UI and loopback Node bridge remain the POC host under ADR-017. Every component now declares default-deny authority, the installed Node host enforces the restrictions it can actually enforce, the Electron host owns encrypted model credentials, unavailable runtime providers fail closed before launch, and each graph produces a deterministic inspectable package with integrity hashes.

This phase does **not** claim native execution, OCI execution, or completed polyglot support. No compiler and no container engine are installed, so `NAT-001` and `CNT-001` proof rows remain unchecked and evidence-triggered.

## Problem, requirement, solution

**Problem.** A manifest declared a runtime kind but no authority. A launched component inherited whatever the orchestrator process held — the whole filesystem, child processes, workers, native add-ons — and nothing in the graph recorded, bounded, or proved that authority. There was also no way to inspect what a graph actually consists of, or to detect that a component file changed after it was reviewed.

**Requirement.** Authority must be declared per component, denied unless declared, enforced by the host wherever the host can enforce it, and honestly labeled where it cannot. Selecting or installing a runtime must grant nothing on its own. A graph must be reducible to a deterministic artifact that names every manifest, contract, component file, version, and hash, and that refuses traversal, undeclared files, secrets, and integrity drift.

**Solution.** A new `permissions` block on the service-manifest contract, a `runtime/permission-policy.mjs` boundary that normalizes and validates it, a Node provider that translates it into real `--permission` flags, a fail-closed provider registry, and a `runtime/package-inventory.mjs` + `scripts/package-graph.mjs` packaging path.

## Declared authority

`contracts/service-manifest.schema.json` now requires a `permissions` block on every manifest and accepts an optional `resources` block. Nine authority classes are declarable:

| Class | Declarable shape | Default |
| --- | --- | --- |
| `filesystem` | `{ read: ["session-root", "stt-runtime"], write: ["session-root"] }` | no scopes |
| `microphone` | `{ granted: boolean }` | denied |
| `clipboard` | `{ granted: boolean }` | denied |
| `network` | `{ outbound: ["loopback-http", "external-https"], listen: boolean }` | no scopes, no listener |
| `model_credentials` | `{ granted: boolean }` | denied except for the authorized serial model adapter |
| `process` | `{ granted: boolean }` | denied |
| `worker` | `{ granted: boolean }` | denied |
| `addons` | `{ granted: boolean }` | denied |
| `wasi` | `{ granted: boolean }` | denied |

An omitted class, an omitted scope list, and an explicit `false` are the same authority: none. `normalizePermissions` collapses all three to the canonical denied policy, so no code path can read a missing declaration as permission.

Filesystem authority is declared as a **named scope**, never as a host path. A manifest therefore cannot express a traversal, an absolute path, or a drive letter, and a future container or native host can map the same scope name onto its own mount without the manifest changing. `session-root` additionally requires `ARGUS_SESSION_ROOT` in the runtime environment allowlist, because a component that cannot learn which root it holds cannot meaningfully hold it. The read-only `stt-runtime` scope additionally requires both `ARGUS_WHISPER_BINARY` and `ARGUS_WHISPER_MODEL`; the Node provider canonicalizes those two supplied files and grants no surrounding directory.

### Declared grants across the shipped graph

| Component | Granted authority |
| --- | --- |
| `active-transcript-owner`, `active-logged-item-owner`, `permanent-transcript-history`, `permanent-logged-item-history`, `session-lifecycle-controller` | `filesystem` read + write on `session-root` |
| `session-folder-locator` | `filesystem` read on `session-root` |
| `whisper-cpp-stt` | `filesystem` read on `session-root` and the exact two-file `stt-runtime` scope; write on `session-root`; child process launch for whisper.cpp |
| `serial-ai-model-lane` | `network.outbound: loopback-http + external-https`; `model_credentials` |
| Every other component (16 of 24) | none |

`tests/phase8-permissions-packaging.test.mjs` pins this inventory. Adding a grant to any manifest fails that test until the grant is a deliberate, reviewed decision.

## Enforcement matrix

The installed host is Node 24.11.1. Its permission model exposes `--permission`, `--allow-fs-read`, `--allow-fs-write`, `--allow-child-process`, `--allow-worker`, `--allow-addons`, and `--allow-wasi`. It exposes **no** network permission flag; this was verified directly, not assumed — under `--permission`, an outbound `fetch`, a raw `net.connect`, and an inbound `server.listen` all succeeded.

| Capability | Enforcement | Mechanism |
| --- | --- | --- |
| `filesystem.read` | **Node-runtime-enforced** | `--allow-fs-read` limited to the component directory, shared component libraries, a granted session root, and exact files in a granted `stt-runtime` scope |
| `filesystem.write` | **Node-runtime-enforced** | `--allow-fs-write`; a component with no write grant cannot write anywhere, including its own directory |
| `process` | **Node-runtime-enforced** | child processes denied without `--allow-child-process` |
| `worker` | **Node-runtime-enforced** | worker threads denied without `--allow-worker` |
| `addons` | **Node-runtime-enforced** | native add-ons denied without `--allow-addons` |
| `wasi` | **Node-runtime-enforced** | WASI denied without `--allow-wasi` |
| `resources.max_heap_mb` | **Node-runtime-enforced** | `--max-old-space-size` applies the declared V8 heap ceiling |
| `environment` | **Adapter-enforced** | the Node provider rebuilds the child environment from the declared allowlist, dropping every other `ARGUS_` variable and every credential-shaped inherited variable |
| `network.outbound` | **Adapter-enforced** | no network flag exists in this Node build; local loopback HTTP and selected-provider HTTPS are enforced at the model configuration boundary and by requiring the declared scope |
| `network.listen` | **Deferred** | refused at declaration time; a component listener needs a provider that can bind and restrict sockets |
| `microphone` | **Deferred** | refused at declaration time; device capture needs a host that owns the device boundary (`AUD-002`) |
| `clipboard` | **Deferred** | refused at declaration time for components; the host capability adapter behind governed UI commands remains the only clipboard path (ADR-017) |
| `model_credentials` | **Adapter-enforced** | Electron `safeStorage` encrypts the host-owned credential at rest and binds it to the exact normalized external provider and endpoint; only `serial-ai-model-lane` receives it in the runtime configuration control message, redacted state reaches the renderer, and failed credential persistence restores the prior non-secret configuration |
| `resources.memory_mb`, `resources.cpu_limit` | **Deferred** | refused outside a container runtime; no OCI engine is installed (`CNT-001`) |

The matrix is exported as `ENFORCEMENT_MATRIX` and asserted by test, including the specific assertion that `network.outbound` is **not** claimed as Node-runtime-enforced. A capability the host cannot enforce is **refused at declaration time** rather than accepted and simulated, so a declaration never reads as a guarantee the runtime does not deliver.

### Observed runtime behavior

`tests/fixtures/permission-probe` and `tests/fixtures/permission-probe-granted` are launched through the real Node provider and report what the operating system actually refused:

| Probe attempt | No grant | `session-root` read + write granted |
| --- | --- | --- |
| read own component directory | allowed | allowed |
| write own component directory | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` |
| read outside every grant (`package.json`) | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` |
| read configured session root | `ERR_ACCESS_DENIED` | `ENOENT` (reaches the filesystem) |
| write configured session root | `ERR_ACCESS_DENIED` | allowed |
| spawn a child process | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` |
| start a worker thread | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` |

Both probes allowlist `ARGUS_SESSION_ROOT` and receive the same configured path. Only the one that declared filesystem authority can use it, which separates *knowing a location* from *holding authority over it*.

The focused STT permission probes create the executable and model outside the service directory. The granted plan contains both canonical file paths and neither their containing directory nor the repository `runtime-output` directory. A service that allowlists both variables but does not declare `stt-runtime` is denied those asset reads and reports a clear `STT_UNAVAILABLE` failure. A scope declaration missing either environment variable, a write request for the read-only scope, or an unsupported scope is refused before launch.

Two measured caveats are recorded rather than smoothed over:

- A granted path that **does not exist** is denied for everything beneath it, because Node resolves the granted path before matching. An unconfigured or absent session root therefore grants nothing, and the existing in-memory fallback still applies.
- `v8.getHeapStatistics().heap_size_limit` reports a combined limit that reflects but does not equal the declared old-space ceiling — measured 256 MB under `--max-old-space-size=64` against a ~4.2 GB default. The test asserts that a ceiling was applied, not an exact byte count.

## Environment and credential containment

The existing per-component environment allowlist is preserved and tightened. `buildNodeEnvironment` now:

- drops every `ARGUS_` variable the component did not declare (previously only `ARGUS_MODEL_*` and `ARGUS_SESSION_ROOT` were filtered);
- drops every inherited variable whose name is credential-shaped (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIAL`, and their plurals), so a credential in the orchestrator's environment cannot reach a component that never declared it;
- refuses to build an environment at all when a manifest requests a credential-bearing key without a `model_credentials` grant; that grant is reserved for the authorized serial model adapter.

A manifest that allowlists `ARGUS_MODEL_ENDPOINT` without declaring `network.outbound: loopback-http` is rejected: a component may not be configured to reach an endpoint it is not permitted to reach. The only shipped component with `external-https` is the serial model adapter, and its provider boundary rejects external HTTP and local non-loopback endpoints.

The live probe confirms containment end to end. With `ARGUS_MODEL_NAME`, `ARGUS_MODEL_ENDPOINT`, and `DEMO_SERVICE_TOKEN` present in the parent environment, the child received exactly `ARGUS_RESTART_COUNT`, `ARGUS_SERVICE_INSTANCE_ID`, and `ARGUS_SESSION_ROOT`, and no credential-shaped key at all.

## Fail-closed runtime providers

`createRuntimeProviderRegistry` installs only the `node` provider. `native` and `container` manifests validate structurally, then fail during graph preparation — before any process is launched and before any wire is considered live — with a typed `RuntimeProviderUnavailableError` carrying `code: 'RUNTIME_PROVIDER_UNAVAILABLE'`, the requested kind, and the installed kinds. The failure message names `NAT-001` and `CNT-001` as the decisions that must be resolved first.

## Deterministic inspectable packaging

`npm run package:graph` writes one artifact per wiring graph to `runtime-output/package/<graph>.package.json`; `npm run package:graph:verify` re-derives each artifact from the working tree and compares it. Each package records:

- the graph file, its hash, its service instances, its runtime components, and its domain/control wire counts;
- the contract catalog version and, for every governed message, its version, plane, owner, payload ceiling, schema path, and changelog path — each file hashed;
- every component's instance id, implementation name, version, runtime kind, manifest hash, declared files with hashes, environment allowlist, **fully expanded** normalized permissions, resources, declared state, and declared side effects;
- the shared component libraries under `runtime/` and `contracts/` that every Node component imports;
- an integrity block: algorithm, file count, total bytes, the full sorted file/hash list, and a `package_digest` over that list.

Because the permission block is written out fully expanded, a reader sees every denied class explicitly rather than inferring denial from absence.

Determinism comes from construction rather than convention: recursively key-sorted JSON, sorted arrays, POSIX-relative paths, and no timestamp, absolute path, or random value anywhere in the artifact. `package:graph` rebuilds each package immediately after writing it and fails if the bytes differ.

Packaging refuses four classes of problem:

| Refusal | Code | Trigger |
| --- | --- | --- |
| Path traversal / escape | `PACKAGE_PATH_ESCAPE` | any file resolving outside the package root |
| Undeclared file | `UNDECLARED_PACKAGE_FILE` | a file in a component directory that the manifest does not declare through `entrypoint`, `executable`, or `includes` |
| Secret | `PACKAGED_SECRET_DETECTED` | PEM private key, AWS access key id, GitHub token, Slack token, or an assigned secret literal |
| Integrity drift | `PACKAGE_INTEGRITY_VIOLATION` | any changed, missing, added, or re-hashed file, or a changed package digest |

The undeclared-file rule is what forced `log-extractor-local-http`, `logged-item-classification-suggester`, and `serial-ai-model-lane` to declare their `model-boundary.mjs` / `model-config.mjs` helpers through `runtime.includes`. A component can no longer ship code that no declaration accounts for.

Current inventory sizes are regenerated by `npm.cmd run package:graph`; the production Electron graph is included as `argus-electron-production.package.json` with its digest recorded in the generated package output.

## Preserved boundaries

- Domain and control ports, wires, projections, and consumer contracts are unchanged; a focused test asserts the concise graph still resolves 4 services, 4 domain wires, and 31 control wires, and that each instance's ports come only from its manifest.
- The runtime kernel gained no domain authority. Permission resolution is launch mechanics; it does not read, transform, or interpret payloads.
- Browser and Node APIs did not enter domain components. Clipboard and folder access remain in `ui/platform-capabilities.mjs` behind governed UI commands, and clipboard is explicitly non-grantable to a component process.
- Intrinsic provider read authority is finite and documented: a component directory plus the shared `runtime/` and `contracts/` libraries. Nothing else is readable without a declaration.
- A future host implements the same adapters and the same named scopes without changing domain consumers or wires.

## Verification

| Gate | Command | Scope | Result |
| --- | --- | --- | --- |
| focused | `node --test tests/phase8-permissions-packaging.test.mjs` | Phase 8 permissions, exact STT asset scope, and packaging | pass — 23/23 |
| smoke | `npm.cmd run demo:ui:smoke` | loopback bridge and UI command flow | pass — 24 projections |
| tests | `npm.cmd test` | complete repository suite | pass — 137/137 |
| contracts | `npm.cmd run contracts:check` | contract governance | pass — 54 governed messages |
| contract docs | `npm.cmd run contracts:docs:check` | generated reference drift | pass — current |
| audit | `npm.cmd audit --audit-level=high` | dependency vulnerabilities | pass — 0 vulnerabilities |
| packaging | `npm.cmd run package:graph` then `npm.cmd run package:graph:verify` | 7 graphs, including `argus-electron-production` | pass — deterministic, verified |

The focused suite proves default-deny normalization, schema-level refusal of a manifest with no permission block, the pinned shipped-grant inventory, declaration-time refusal of unsupported capabilities and container-only resource limits, exact canonical two-file `stt-runtime` mapping without a broad directory grant, denial without that scope, fail-closed invalid scope/environment declarations, refusal of configuration a component is not permitted to use, fail-closed native and container providers, correct flag translation, live Node-runtime denial and granted-scope behavior, environment and credential filtering, byte-identical package rebuilds, package content completeness, path-escape refusal, undeclared-file refusal, secret refusal, integrity-drift reporting, enforcement-matrix honesty, and unchanged consumer contracts and wires.

## Governance note

The `service_manifest` artifact contract gained a required `permissions` field. That is a **breaking** change for any manifest outside this repository. Artifact schemas are not independently versioned by the current governance model — only messages are — so the change is recorded through a catalog `schema_version` move from `1.8.0` to `1.9.0` and through this note. Every in-repository manifest, including all test fixtures, was migrated in the same change. Independent artifact-contract versioning is a real gap in contract governance and is named here rather than worked around.

## Phase 8A standalone Electron integration

The production host is implemented in `electron/main.cjs` and uses `ui/desktop-preload.cjs` as a narrow context-isolated bridge. The renderer has no Node integration and receives only validated bootstrap, command, audio-chunk, audio-flush, capture-failure, capability, and projection messages. Electron grants only media/microphone permission requests. `ui/audio-capture.mjs` uses `getUserMedia`, an AudioWorklet resampler, bounded PCM16 transport, SHA-256 chunk checksums, and explicit backpressure failure.

`runtime/interactive-graph.mjs` starts the declared `wiring/production-electron.json` graph through the existing supervised provider boundary. `services/whisper-cpp-stt` invokes the provisioned whisper.cpp binary with session-scoped temporary WAV/JSON files, emits actual partials and token probabilities, and deletes temporary files after each inference. `services/serial-ai-model-lane` keeps the provider-neutral workload contracts and adapts requests to Ollama, LM Studio, or the configured HTTPS OpenAI-compatible endpoint after receiving `ai.provider-configure` from the trusted host. There is no fake fallback in the desktop path.

The Windows artifacts are produced by Electron Forge: Squirrel installer, win32/x64 zip, and unpacked executable. The rebuilt unpacked executable was launched successfully with no inherited `ELECTRON_RUN_AS_NODE` override; it stayed alive with the production graph's supervised service children and was then closed as part of the smoke run. The real dependency setup is intentionally separate because physical-device accuracy, latency, resource, licensing, and Ollama availability remain acceptance evidence rather than claims inferred from a package build.

The Node permission taxonomy is explicit: `node` means enforced by Node's permission/V8 runtime flags, `adapter` means enforced by an Argus boundary, and `deferred` means no installed provider can enforce it. The operating system is not credited with Node-runtime policy enforcement.

## Deliberate limits

The Electron host is selected and implemented, including the host-encrypted credential path for authenticated external providers. Native and OCI execution remain unproven and evidence-triggered. Database-backed global AI journaling and Phase 9 observability remain out of scope.

The deferred Phase 7A editor-position bug is unchanged and remains open.

Two enforcement claims deserve explicit residual-risk statements:

1. **Network is not OS-enforced.** A component with no declared network scope is not prevented by the operating system from opening a socket. Local loopback restriction and external HTTPS/provider scoping are enforced at the model configuration boundary and by refusing endpoint configuration without the declared scope. A component that ignored the adapter and used `node:net` directly would not be stopped by this host. Closing that gap requires a provider that can restrict sockets — a container runtime under `CNT-001`, or a future Node build that ships a network permission flag.
2. **The test process harness is intentionally outside this boundary.** `tests/helpers/process-harness.mjs` spawns services directly with the full parent environment and no permission flags, because it exercises service logic rather than containment. Containment is proven separately through the real provider in the Phase 8 probes.
