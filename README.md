# Argus standalone desktop application

Argus is a standalone Electron application. The packaged desktop path uses the governed contracts and service graph, captures microphone audio through Electron's permission boundary and an AudioWorklet, sends it to the real whisper.cpp adapter, and routes logged-item extraction through the provider-neutral local model boundary. The browser/Node bridge remains available as a deterministic POC and is not imported by the packaged desktop host.

## Run

Install dependencies and start the standalone desktop host:

```powershell
npm.cmd install
npm.cmd start
```

### Select a Windows microphone

From PowerShell, launch the source application from the repository:

```powershell
cd C:\Argus
npm.cmd start
```

In the running Electron window, use the **Audio input** selector in the bottom status bar. The first scan requests microphone permission so Windows/Electron can reveal physical microphone labels; the permission probe stops its tracks immediately. Choose **System Default** or a listed physical microphone, then use **Rescan** after connecting, disconnecting, or enabling a microphone in Windows. An explicitly chosen microphone is remembered for the next launch. If that device disappears, Argus marks it **Unavailable** and will not silently use System Default; select another input before pressing Record.

The desktop host uses a per-user session root under Electron's `userData` directory unless `ARGUS_SESSION_ROOT` is set. It does not silently fall back to fake audio, fake STT, or a fake model: unavailable real dependencies are shown as degraded capabilities.

Provision the real local dependencies before expecting transcription or logged-item extraction:

```powershell
npm.cmd run setup:real
npm.cmd start
```

The provisioning script builds whisper.cpp `v1.9.1`, downloads `ggml-base.en.bin`, records its SHA-256, and prepares Ollama `llama3.2:3b` at `http://127.0.0.1:11434/api/generate`. It writes a ready manifest to `runtime-output/real-dependencies.json` only after both real runtimes pass. Git, CMake, a C++ build toolchain, network access for the model download, and Ollama are external prerequisites; any missing dependency fails setup with the exact prerequisite named.

For a Windows distributable:

```powershell
npm.cmd run package:win
```

The installer, zip, and unpacked executable are written under `out/`.

The **Stop** button flushes the real audio pipeline and preserves the session for Resume. **Close** flushes, finalizes, and releases the session through the lifecycle owner.

## Real Electron operational status

`npm.cmd run setup:real` is now idempotent and fail-closed: it succeeds only after the pinned Whisper runtime/model and the selected Ollama model pass real probes. It records the exact paths, versions, model identity, and SHA-256 values in `runtime-output/real-dependencies.json`. A missing prerequisite or unavailable endpoint produces a visible error and does not write a false-ready manifest.

The packaged path bundles `runtime-output/real-runtime/whisper-cli.exe`, its four required Whisper DLLs, and `ggml-base.en.bin`; the source/build cache is excluded. Ollama remains a separately installed local runtime at `http://127.0.0.1:11434`.

After Close, the primary control becomes **New Session**. The trusted Electron/Node boundary creates a new session identity and routes creation through the real lifecycle owner; the closed session remains persisted and read-only for review. Real audio energy, not a timer, gates the 1,200 ms bounded pause flush. Capture continues after a pause flush while recording.

The source Electron/runtime path and real dependency provisioning are operational, but final packaged launch is currently blocked on this Windows machine by the packaged Chromium GPU helper: it exits with `0xC0000135`, followed by Electron `0x80000003`. Do not treat this as a corrupt installer or attempt physical-input acceptance until that host packaging blocker is resolved. Optional classification remains deferred and is not available in the packaged path.

Provisioned versions and evidence are recorded in [`Architecture/RealElectronOperationalEvidence.md`](Architecture/RealElectronOperationalEvidence.md).

Run the deterministic startup smoke check with:

```powershell
npm.cmd run demo:ui:smoke
```

## Current validation status

The focused Phase 7 corrections are agent-verified and user-revalidated: D1 through D4 passed in [`docs/review/v0.1.0-phase-7-corrective-revalidation-validation-review.md`](docs/review/v0.1.0-phase-7-corrective-revalidation-validation-review.md). The newly observed editor-position movement during live arrival is a deferred Phase 7A bug and is unchanged.

The original browser/Node POC gates remain available, while the standalone Electron integration adds a supervised production graph, real audio/STT/model adapters, and Windows packaging. Native and OCI execution remain unproven and evidence-triggered; physical-device/model acceptance and credential choices remain evidence-driven.

## Standalone integration status

The production Electron graph validates with 12 supervised components and 19 explicit wires. Contract governance, generated contract documentation, graph packaging, supervised lifecycle smoke, real dependency provisioning, and the governed New Session lifecycle pass. The remaining acceptance run is external only after packaged startup is repaired: use a physical microphone and Ollama session to measure transcription accuracy, latency, and resource cost.

## Included interactions

- Record, stop/resume, and explicit close/finalization states
- Deterministic transcript and neutral logged-item projection events while recording
- Finalized transcript and logged-item edits routed through their owning boundaries with optimistic revision checks
- UI-owned row selection, select-all, individual copy, and ordered batch copy
- Configurable timestamp inclusion for copied text
- Independent auto-scroll behavior and jump-to-live controls for both panes
- Transcript source ranges on every logged item; selecting a range reveals the contributing transcript rows
- Top-center notifications that stay clear of incoming live content
- Session details drawer, identity-only storage capability preview, and finalization confirmation
- Visible per-capability status for transcript, logged-item pipeline, storage/session, clipboard, folder opening, and optional classification
- Responsive stacked-pane fallback for narrower windows

The architecture decision record in `Architecture/DesignDecisions.md` explains why extraction and optional classification are separate operations, how idle-time enrichment should work, and which transcript context belongs in each payload.

Copy and open-folder controls are host commands. Copy uses a replaceable operating-system adapter when available; folder opening accepts only a session identity and is visibly unavailable when no authorized desktop/session-root capability is configured. The preload exposes only bootstrap, governed command, audio-chunk, capture-failure, capability, and projection channels; it does not expose Node, filesystem, or process access to the renderer.

## Executable architecture experiment

The repository also contains a Node proof of the atomic architecture described in `Architecture/`.

It demonstrates:

- one isolated process per service;
- explicit service manifests and default-deny domain/control wires;
- visible runtime pseudo-components for lifecycle, supervision, results, and completion;
- versioned message payload contracts;
- contract validation at the orchestration boundary;
- structured traces on standard error;
- a transcript-to-logged-item vertical slice;
- two interchangeable log-extractor implementations;
- tests for service contracts, invalid wiring, integration, and replaceability.
- a trusted runtime-provider boundary with Node as the sole active provider;
- explicit readiness, operation completion, drain, provider exit, and dead-letter control paths;
- bounded per-wire queues, operation timeouts, opt-in retries, and bounded restart policies;
- POC startup, memory, throughput, and routing-latency evidence at 4, 8, and 12 service processes;
- at-least-once message identity with UUID-v4 IDs, stable idempotency keys, and semantic fingerprints;
- per-session transcript ordering with explicit gap, late, stale-revision, and stale-result outcomes;
- a durable, bounded, concurrency-one AI lane with transcription/correction/extraction/enrichment priority and FIFO within each workload;
- a policy-gated Phase 4D graph whose context selector sees finalized segments only, with four configurable triggers and bounded non-authoritative surrounding context;
- independent alternate STT and context-selector implementations proven in unchanged graph positions.
- Phase 4E replay-safe transcription/history and same-process Stop/Resume-compatible ownership evidence, with the unproven active-history bound stated explicitly;
- Phase 4F deterministic inline-base64 transport measurements, bounded-queue evidence, and explicit oversized-contract rejection without production thresholds.
- Phase 5A deterministic logged-item ownership with stable context identity, exact source provenance, separate active/history owners, user-authoritative proposals, and an explicit evidence observer.
- Phase 5B/5B.1 provider-neutral loopback-only HTTP extraction through a graph-local concurrency-one model lane, governed model request/result protocol, exact context/budget enforcement, explicit retryable failure, bounded pending state, scoped model configuration, and optional revision-bound classification.
- Phase 7 browser-facing projection contracts for session status, transcript rows, logged-item rows/provenance, command results, and per-capability status;
- a loopback-only deterministic HTTP/SSE UI bridge with allowlisted static files, inbound command validation, projection validation, owner-routed revision checks, capability adapters, and no arbitrary file route.
- Phase 8 default-deny component permissions covering filesystem, microphone, clipboard, network, model credentials, child processes, worker threads, native add-ons, and WASI, where an unstated authority is a denied authority;
- Node-enforced filesystem, child-process, worker, add-on, WASI, and heap restrictions generated from those declarations, with adapter-enforced environment/credential containment and an honest record of what the host cannot enforce;
- fail-closed refusal of unavailable `native` and `container` providers and of any capability no installed provider can honor, before a process launches;
- deterministic inspectable graph packages recording manifests, contracts, component files, versions, and integrity hashes, with path-escape, undeclared-file, secret, and integrity-drift refusals.

Only raw process-hosting mechanics remain intrinsic to the runtime kernel. See `Architecture/RuntimeKernelAndPlanes.md` for the exhaustive authority boundary and proof invariants.

Contract governance is executable: every message declares semantic version, owner, plane, payload limit, schema, and history; older compatible fixtures are replayed against the current registry; and generated reference documentation is checked for drift. See `Architecture/ContractGovernance.md`.

Phase 3 identity, ordering, optimistic revision, stale-result, and AI-lane guarantees are documented with executable evidence in `Architecture/IdentityOrderingAndAiLane.md`.

Phase 4A's accepted semantics are recorded in `Architecture/DesignDecisions.md`; Phase 4B boundaries are in `Architecture/TranscriptContractsAndOwnership.md`; Phase 4C's executable working-document proof is in `Architecture/TranscriptPipelinePhase4CEvidence.md`; Phase 4D context selection and replacement evidence are in `Architecture/TranscriptContextPhase4DEvidence.md`; Phase 4E's seven completed claims and one precise limitation are in `Architecture/TranscriptBehaviorPhase4EEvidence.md`; Phase 4F transport evidence is in `Architecture/TranscriptTransportPhase4FEvidence.md`. All unresolved package, SDK, provider, transport, storage, threshold, and desktop-host choices are tracked centrally in `PENDING-DECISIONS.md`.

Phase 8 permission, enforcement-matrix, fail-closed provider, and packaging evidence is in `Architecture/PermissionsPackagingPhase8Evidence.md`; ADR-018 records that authority is declared, denied by default, and never simulated. Node-runtime restrictions are labeled as Node-runtime-enforced; outbound network is adapter-enforced because the installed Node build ships no network permission flag.

Phase 5A logged-item ownership evidence is in `Architecture/LoggedItemPipelinePhase5AEvidence.md`. Phase 5B/5B.1 local model and classification evidence is in `Architecture/LoggedItemModelPhase5BEvidence.md`; the standalone path selects Ollama `llama3.2:3b` while the durable globally shared AI journal remains deferred. Phase 7 UI boundary evidence is in `Architecture/UiBoundaryPhase7Evidence.md`; ADR-019 records Electron as the standalone host. `UI-001` and `UI-002` remain evidence-driven product decisions.

Polyglot execution is an accepted architectural direction. Manifests and the provider boundary are runtime-neutral, while Node remains the sole installed provider; `native` and `container` manifests fail closed before launch. Argus does not claim native, OCI, or complete polyglot execution. The root-level `POLYGLOT-RUNTIME-STRATEGY.md` records the boundary, inbound/outbound constraints, container rules, conformance proof, and roadmap before anyone broadens the launcher.

Run with Node 22 or newer:

```powershell
npm install
npm test
npm run contracts:check
npm run contracts:docs:check
npm run measure:runtime
npm run benchmark:transport
npm run package:graph
npm run package:graph:verify
node runtime/orchestrator.mjs wiring/demo.concise.json
node runtime/orchestrator.mjs wiring/demo.passthrough.json
npm run demo:transcript
npm run demo:context
npm run demo:logged-items
npm run demo:logged-item-model
npm.cmd run demo:ui
```

See `Architecture/FeasibilityReview.md` for the assessment, `TODO.md` for the prioritized build sequence, and `PENDING-DECISIONS.md` for choices that must be resolved when their evidence trigger is reached.
