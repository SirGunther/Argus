# Argus Architecture Build To-Dos

This list is ordered to prove the riskiest architectural claims first. Completed items are part of the initial executable scaffold.

## 0. Executable architecture proof

- [x] Define the common observable message envelope.
- [x] Define versioned payload contracts for the first transcript-to-log path.
- [x] Define a service manifest format with explicit plane-specific `accepts` and `emits` ports.
- [x] Separate domain and control ports in every service manifest.
- [x] Implement a graph definition containing only explicit domain and control wires.
- [x] Represent session control, supervision, results, and completion as visible runtime pseudo-components.
- [x] Document the exhaustive intrinsic authority of the runtime kernel.
- [x] Prove that removing a lifecycle, failure, or completion wire removes the corresponding capability.
- [x] Reject a wire when the producer does not emit or the consumer does not accept its message type.
- [x] Spawn every service as an isolated Node process.
- [x] Route newline-delimited JSON messages without importing service implementation code.
- [x] Emit structured service traces on standard error and domain messages on standard output.
- [x] Build a finite fake transcript -> context window -> log extraction -> memory store vertical slice.
- [x] Build two log-extractor implementations with the same contract.
- [x] Test that both implementations can occupy the same graph position.

## 1. Contract governance

- [x] Choose the compatibility policy for major/minor schema versions.
- [x] Treat a contract plane change as a breaking change.
- [x] Add contract ownership metadata and a changelog for every message type.
- [x] Add compatibility tests that replay older fixtures against newer consumers.
- [x] Decide whether full JSON Schema validation uses a maintained validator package or a dedicated validation service.
- [x] Add generated human-readable contract documentation.
- [x] Add maximum payload sizes and reject oversized messages.
- [x] Define canonical error and failure outcome contracts.

## 2. Runtime supervision

- [x] Define a trusted runtime-provider interface for Node, native executables, and OCI containers without arbitrary shell commands.
- [x] Keep the current Node launcher behind that provider boundary with no graph behavior change.
- [x] Add health and readiness messages.
- [x] Add graceful shutdown with an explicit drain deadline.
- [x] Add bounded per-wire queues and observable backpressure.
- [x] Add per-operation timeouts.
- [x] Add retry policies only on wires that explicitly permit retry.
- [x] Add a dead-letter destination for messages that exhaust retry.
- [x] Add restart policies for stateless and stateful services.
- [x] Prevent a service from writing domain messages to undeclared outputs.
- [x] Measure idle memory, startup time, throughput, and routing latency as process count grows.

## 3. Identity, duplication, and ordering

- [x] Adopt at-least-once delivery explicitly.
- [x] Define UUID-v4 message-id, stable idempotency-key, and semantic fingerprint rules.
- [x] Reject same message ID or idempotency key with different semantic content as a fatal integrity violation.
- [x] Serialize service input handling and make state-owning consumers idempotent.
- [x] Define contiguous ordering independently per `session_id`.
- [x] Add duplicate, late, and out-of-order delivery tests.
- [x] Add optimistic revision checks for the first user-editable state owner.
- [x] Reject stale extraction or classification responses after a user edit.
- [x] Add an explicitly wired, nonfatal `operation.rejected` outcome.
- [x] Define one global, non-preemptive, concurrency-one AI execution lane.
- [x] Prioritize transcription, then transcript correction/formatting, then logged-item extraction, then classification enrichment.
- [x] Preserve FIFO invocation order within each AI workload.
- [x] Journal accepted AI work durably and recover unfinished work after restart.
- [x] Bound the AI backlog, expose queue status, and fail admission without silent drops.

## 4. Transcript pipeline

### 4A. Accepted boundaries

- [x] Treat raw audio as ephemeral and do not retain it after successful transcription.
- [x] Require any future retry-audio buffer to be a separate, explicit, bounded capability.
- [x] Use deterministic PCM16, 16 kHz, mono audio for the fake pipeline.
- [x] Show partial transcript hypotheses as provisional and read-only.
- [x] Emit committed words as confidence is reached; committed words are immutable STT evidence.
- [x] Permit extraction and permanent history to consume finalized committed segments only.
- [x] Track deferred provider, package, SDK, threshold, storage, and transport choices in `PENDING-DECISIONS.md`.

### 4B. Contracts and ownership

- [x] Add a governed `audio.chunk` contract with session/chunk sequence, time range, PCM format, sample count, inline fake payload, and checksum.
- [x] Set a strict fake-audio payload limit and reject invalid PCM metadata and corrupt data at the registry boundary; define duplicate, gap, and late outcomes for the Phase 4C owner.
- [x] Add a governed replaceable `transcript.partial` projection contract that never enters extraction or permanent history.
- [x] Add a governed `transcript.word-committed` contract with stable word identity, session order, time range, text, confidence evidence, and optional acoustic alternatives.
- [x] Add a governed contextual word-correction proposal with exact bounded context and versioned prompt/policy provenance; only the active transcript owner can accept it.
- [x] Add an optional governed logged-item generation directive to exact context windows with a versioned policy/instruction profile and explicit context bounds.
- [x] Keep `transcript.segment` as the finalized committed downstream unit and document its construction from committed words.
- [x] Add optimistic-revision contracts for user edits to finalized active transcript segments while preserving original STT evidence.
- [x] Add explicit contracts for active-segment storage and append-only permanent-history acceptance.
- [x] Define retryability and terminal outcomes for audio decode, STT, active-state, and history operations.

### 4C. Independently runnable components

- [x] Implement a deterministic fake-audio producer with silence, correction, pause/statement, and long-monologue fixtures.
- [x] Implement an independently runnable fake STT service: `audio.chunk` -> provisional hypotheses, committed words, and an explicit utterance boundary.
- [x] Ensure fake STT releases each audio payload after terminal processing, emits no audio bytes, and keeps no replayable raw-audio archive.
- [x] Implement an independent deterministic contextual correction/formatting component with versioned policy evidence and no state authority.
- [x] Implement one active-transcript owner for the read-only provisional projection, stable word identity validation/assembly, automatic correction acceptance, finalized segments, review flags, and optimistic user revisions.
- [x] Implement one append-only permanent-transcript-history owner that cannot be mutated by STT or UI consumers.
- [x] Prove every new component independently against valid, invalid, corrupt, duplicate, late, gap, silence, revision, lifecycle, recovery-policy, and drain cases.

### 4D. Wiring and context selection

- [x] Create an explicit fake-audio -> serial transcription gate -> fake-STT -> active-transcript -> context-selector graph.
- [x] Prove that no wire permits partial hypotheses to reach extraction or permanent history.
- [x] Route transcription through the existing highest-priority global AI workload without concurrent model execution.
- [x] Add independently configurable pause, size, deterministic topic-boundary, and maximum-latency triggers to the context-window selector.
- [x] Preserve stable first/last segment IDs and exact time ranges in every emitted context window.
- [x] Prove an STT or context-selector replacement can occupy the same graph position without neighbor changes.

### 4E. Behavioral and recovery proofs

- [x] Test word-by-word commitment while partial hypotheses change between chunks.
- [x] Test silence without empty transcript output or phantom committed words.
- [x] Test that provider corrections replace only provisional text and never rewrite committed STT evidence.
- [x] Test user edits as new revisions while retaining original text and source-word provenance.
- [x] Test pause, size, topic, and maximum-latency boundaries independently and in conflict.
- [x] Test long monologues against bounded active state, bounded queues, and the maximum-latency trigger.
  - The long-monologue proof now exercises durable transcript history, bounded active revision cache, reload after eviction, revision-after-reload, bounded related context, bounded graph queues, and the maximum-latency ceiling. See `Architecture/TranscriptBehaviorPhase4EEvidence.md`.
- [x] Test at-least-once replay across fake STT, active state, and permanent history without duplicate words or revisions.
- [x] Test Stop/Resume-compatible active ownership without implementing the Phase 6 session lifecycle prematurely.

### 4F. Transport evidence and exit gate

- [x] Benchmark inline base64 PCM16 over bounded NDJSON at representative chunk sizes and transcript frequencies.
- [x] Record throughput, payload expansion, queue depth, latency, memory, and failure behavior; do not set production thresholds from one machine.
- [x] Resolve or explicitly defer the `PENDING-DECISIONS.md` entries whose decision trigger is reached by the benchmark.
- [x] Run contract governance, generated-doc drift, full regression, both existing graphs, the new transcript graph, scaling evidence, and dependency audit.
- [x] Update the canonical changelog, capability catalog, decision register, and Phase 4 evidence artifact.

## 5. Logged-item pipeline

Phase 5 is intentionally split into two reviewable batches. Phase 5A proves logged-item ownership with deterministic components. Phase 5B connects a configurable local model only after 5A passes review. Phase 5 state is logical/in-memory state; durable files or databases remain Phase 6.

### 5A. Governed logged-item state and ownership

- [x] Require stable first/last transcript segment IDs and exact timestamps for every logged item.
- [x] Wire finalized `transcript.context-window` input to the deterministic extractor and logged-item owners without changing neighboring contracts.
- [x] Implement one in-memory logged-item temporary-state owner with optimistic revisions and sole mutation authority.
- [x] Implement a separate in-memory append-only logged-item history owner with idempotent revision identity.
- [x] Add item update/merge proposals without silently replacing user-authored text.
- [x] Prove replay, identity conflict, stale revision, source provenance, and owner isolation behavior.
- [x] Preserve the existing deterministic extractor as the Phase 5A test/offline implementation.

### 5B. Local model adapter and optional classification

- [x] Add a provider-neutral local HTTP model adapter behind the governed extractor boundary; configure endpoint, model, and timeout through environment variables without a provider SDK.
- [x] Keep the deterministic fake selectable for tests and offline operation, and prove fake/local adapter replacement without neighbor or wire changes.
- [x] Prove a priority AI scheduler in which enrichment cannot displace queued transcription.
- [x] Wire logged-item extraction through the proven scheduler workload.
- [x] Retain the exact context window for retry and emit an explicit failure when the endpoint is unavailable, times out, or returns invalid structured output; create no empty or guessed item.
- [x] Implement classification as a separate optional lowest-priority suggestion service using the governed contracts; classification failure must not block the primary logged item.
- [x] Test exact authoritative source context, bounded lookback, optional forward context, instruction/policy version, and token/character budgets.

### 5B.1 Boundary hardening

- [x] Establish the focused Phase 5B baseline before editing.
- [x] Govern versioned model request/result shapes in `ai.work-request` and `ai.work-completed`, with valid and invalid fixtures.
- [x] Remove sibling-service implementation imports from the model lane and classifier.
- [x] Restrict model endpoints to loopback-only HTTP and reject HTTPS/non-loopback forms.
- [x] Deliver classification transcript context through an explicit finalized context-window wire.
- [x] Bound extraction/classification pending state and clean successful, terminal, rejected, conflicting, and drained paths.
- [x] Enforce purpose-to-workload mapping and preserve concurrency-one priority behavior.
- [x] Allowlist model configuration per component; unrelated services receive no model variables.
- [x] Keep the durable globally shared AI journal deferred for integrated application/storage work and Phase 6 coordination.
- [x] Update evidence and deferred-work records to make only graph-local, in-memory claims.

## 6. Sessions and storage

- [x] Define the session metadata contract and lifecycle state machine.
- [x] Implement Record, Stop, Resume, and Close Session orchestration commands.
- [x] Ensure Stop preserves active temporary state.
- [x] Implement idempotent Close Session finalization.
- [x] Define the on-disk active/permanent folder structure.
- [x] Add crash-recovery tests during each finalization phase.
- [x] Add a session-folder locator service with narrowly scoped filesystem authority.

## 7. UI boundary

- [x] Define UI-facing projection contracts instead of allowing the UI to read service state directly.
- [x] Bridge transcript and logged-item events into the existing HTML POC.
- [x] Route user edits through the owning state service.
- [x] Route copy and open-folder requests through platform capability services.
- [x] Preserve pane auto-scroll and row selection as UI-owned state.
- [x] Display source-range provenance from stable segment IDs.
- [x] Add visible degraded states when individual services are unavailable.

### 7A. Deferred browser validation bug

- [ ] Pause live following independently for a pane while one of its rows is being edited so incoming projections cannot move the active editor.
- [ ] Preserve the pane's scroll position, focus, caret/selection, and in-progress text while continuing to accept and count new rows.
- [ ] Keep Jump to Live available and resume following only after editing ends or the user explicitly returns to live content.
- [ ] Add focused browser regression evidence for transcript and logged-item panes before closing the bug.

## 8. Permissions and packaging

- [x] Retain the browser UI and loopback Node bridge as the POC host while keeping host integration behind replaceable capability adapters.
- [x] Complete the existing discriminated runtime manifest (`node`, `native`, `container`) with explicit default-deny permission and resource declarations.
- [x] Declare filesystem, microphone, clipboard, network, and model credential permissions per service.
  - Nine authority classes are declarable; an omitted class, an omitted scope list, and an explicit `false` all normalize to denied. Filesystem authority uses the host-neutral `session-root` scope so a manifest cannot express a host path or a traversal.
- [x] Enforce the installed Node host's supported filesystem, child-process, worker, add-on, WASI, environment, and credential restrictions from the declared policy.
  - Node 24.11.1 `--permission` flags are generated from the declaration. Live probes observe `ERR_ACCESS_DENIED` for undeclared write, outside read, child process, and worker, and observe a granted `session-root` scope working while every other capability stays refused.
- [x] Keep microphone, clipboard, folder, network, and model access behind explicit adapters or declared wires. The deterministic fake path remains test-only; the standalone Electron path now connects real microphone capture, whisper.cpp STT, and the provider-neutral local model boundary.
- [x] Fail closed when a manifest selects an unavailable runtime provider or requests an unsupported or undeclared capability.
  - `native` and `container` manifests fail graph preparation with `RUNTIME_PROVIDER_UNAVAILABLE` before any process launches. Microphone, clipboard, model-credential, listener, and container-only resource declarations are refused at declaration time instead of being accepted and simulated.
- [x] Package service manifests, contracts, and the graph as inspectable artifacts.
- [x] Produce a deterministic package inventory with version and integrity hashes, path-containment checks, and no undeclared files or secrets.
  - `npm run package:graph` and `npm run package:graph:verify` build and re-derive one artifact per graph. Refusals: `PACKAGE_PATH_ESCAPE`, `UNDECLARED_PACKAGE_FILE`, `PACKAGED_SECRET_DETECTED`, `PACKAGE_INTEGRITY_VIOLATION`.
- [x] Add focused permission, denial, package-integrity, and replacement-boundary tests, then run the complete gate matrix once.
- [x] Record an honest enforcement matrix distinguishing enforced Node restrictions, adapter-level denial, and permissions that require a future native/container host.
  - See `Architecture/PermissionsPackagingPhase8Evidence.md`. Outbound network is **adapter-enforced, not OS-enforced**: the installed Node build ships no network permission flag, verified directly.
- [x] Correct the Phase 8 enforcement taxonomy in runtime metadata and tests: Node `--permission` and V8 heap limits are **Node-runtime-enforced**, not OS-enforced, while the current outbound-network scope restricts approved endpoint configuration but does not contain direct sockets. The focused permission suite and complete contract/package gates were rerun.

The rows below are **evidence-triggered, not merely outstanding**. They are intentionally non-blocking for the browser/Node POC foundation. No native compiler and no OCI engine is installed; do not install one, and do not check these rows, without the named decision evidence and explicit user authorization.

- [ ] Select the first native language/toolchain only after `NAT-001` evidence identifies a suitable deterministic replacement component, then prove same-wire substitution.
- [ ] Select OCI tooling under `CNT-001`, package one conforming component immutably, and repeat replacement, supervision, permission, and resource tests.
- [ ] Add signed/versioned component bundles only if third-party distribution becomes an explicit product goal.
- [x] Select and integrate Electron under `APP-001`: context-isolated preload, media permission handling, AudioWorklet PCM transport, supervised production graph, durable sessions, and Forge Windows artifacts are implemented. Physical-device/model acceptance remains external evidence.

### 8.1 Real Electron operational completion

- [x] Determine and record Git, CMake, Visual Studio/MSVC, Ollama, whisper.cpp, Whisper model, and selected model versions.
- [x] Provision pinned whisper.cpp v1.9.1, `ggml-base.en.bin`, Ollama 0.32.15, and `llama3.2:3b`; write a ready manifest only after real probes pass.
- [x] Add physical-audio energy pause detection, bounded 1,200 ms pause finalization, serialized flushes, and continued capture.
- [x] Advance real Whisper utterance and word identities across repeated flushes while preserving provider timestamps/probabilities and temporary-file cleanup.
- [x] Add governed `session.new`, trusted new identity generation, closed-session read-only review, and accepted-session projection reset.
- [x] Bundle the final Whisper runtime/model assets, rebase packaged paths, and keep setup independent of the source tree for installed execution.
- [ ] Repair the packaged Windows Electron GPU-helper crash (`0xC0000135` followed by Electron `0x80000003`) before attempting physical input.
- [ ] Perform final spoken-input acceptance with a physical microphone; measure accuracy, pause behavior, latency, resources, and real logged-item output.
- [ ] Resolve the deferred optional classification review/UI decision; it is not available in the packaged path.

Phase 9 observability has not started.

## 9. Observability and acceptance

- [ ] Persist the route-level event trace for replay.
- [ ] Add graph visualization from manifests and wires.
- [ ] Add correlation-based session trace viewing.
- [ ] Add deterministic end-to-end replay from recorded messages.
- [ ] Add fault injection for crashes, delays, invalid output, and dropped messages.
- [ ] Define measurable acceptance thresholds for latency, recovery, replacement, and resource cost.

## Next recommended implementation slice

The permission and packaging behavior passes its complete gate matrix, and the production Electron graph now runs through the same default-deny/supervision boundary. Every component declares authority, the installed Node runtime enforces what it can, unavailable real dependencies become visible degraded capabilities, and each graph produces a deterministic inspectable package with integrity hashes.

The native and OCI proof rows stay unchecked on purpose. They are **evidence-triggered**, not merely unfinished: no compiler and no container engine are installed, and `NAT-001`/`CNT-001` must be resolved before either is attempted. Do not install a toolchain or engine to close them without explicit authorization.

The dependency and runtime completion slice is done, but packaged startup has an external Windows GPU-helper blocker (`0xC0000135` / Electron `0x80000003`). Resolve that before physical-device/model acceptance. The deferred Phase 7A editor-position bug remains open and independent. `SEC-001`, `NAT-001`, and `CNT-001` remain governed decisions; do not add credential storage, native execution, remote access, authentication, or a database without their evidence triggers.
