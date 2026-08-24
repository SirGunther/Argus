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

- [ ] Choose the compatibility policy for major/minor schema versions.
- [ ] Treat a contract plane change as a breaking change.
- [ ] Add contract ownership metadata and a changelog for every message type.
- [ ] Add compatibility tests that replay older fixtures against newer consumers.
- [ ] Decide whether full JSON Schema validation uses a maintained validator package or a dedicated validation service.
- [ ] Add generated human-readable contract documentation.
- [ ] Add maximum payload sizes and reject oversized messages.
- [ ] Define canonical error and failure outcome contracts.

## 2. Runtime supervision

- [ ] Add health and readiness messages.
- [ ] Add graceful shutdown with an explicit drain deadline.
- [ ] Add bounded per-wire queues and observable backpressure.
- [ ] Add per-operation timeouts.
- [ ] Add retry policies only on wires that explicitly permit retry.
- [ ] Add a dead-letter destination for messages that exhaust retry.
- [ ] Add restart policies for stateless and stateful services.
- [ ] Prevent a service from writing domain messages to undeclared outputs.
- [ ] Measure idle memory, startup time, throughput, and routing latency as process count grows.

## 3. Identity, duplication, and ordering

- [ ] Define message-id and idempotency-key creation rules.
- [ ] Make persistent consumers idempotent.
- [ ] Define ordering guarantees per session/correlation ID.
- [ ] Add duplicate, late, and out-of-order delivery tests.
- [ ] Add optimistic revision checks for all user-editable state.
- [ ] Reject stale extraction or classification responses after a user edit.

## 4. Transcript pipeline

- [ ] Implement a fake audio producer and `AudioChunk` contract.
- [ ] Implement an independently runnable speech-to-text fake.
- [ ] Define partial versus committed transcript segment semantics.
- [ ] Implement transcript temporary-state ownership.
- [ ] Implement transcript permanent-history ownership.
- [ ] Add pause, size, topic-boundary, and maximum-latency triggers to the context-window selector.
- [ ] Test chunk boundaries with silence, corrections, and long monologues.
- [ ] Benchmark whether JSON transport is acceptable for audio metadata and transcript frequency.

## 5. Logged-item pipeline

- [ ] Replace the deterministic extractor with a model-adapter implementation behind the existing contract.
- [ ] Preserve a deterministic fake for tests and offline operation.
- [ ] Require stable first/last transcript segment IDs for every logged item.
- [ ] Implement logged-item temporary-state ownership.
- [ ] Implement logged-item permanent-history ownership.
- [ ] Add item merge/update proposals without silently replacing user text.
- [ ] Add an idle-work scheduler that cannot block transcription.
- [ ] Implement classification as a separate optional suggestion service.
- [ ] Test exact source context, bounded lookback, optional forward context, and token budgets.

## 6. Sessions and storage

- [ ] Define the session metadata contract and lifecycle state machine.
- [ ] Implement Record, Stop, Resume, and Close Session orchestration commands.
- [ ] Ensure Stop preserves active temporary state.
- [ ] Implement idempotent Close Session finalization.
- [ ] Define the on-disk active/permanent folder structure.
- [ ] Add crash-recovery tests during each finalization phase.
- [ ] Add a session-folder locator service with narrowly scoped filesystem authority.

## 7. UI boundary

- [ ] Define UI-facing projection contracts instead of allowing the UI to read service state directly.
- [ ] Bridge transcript and logged-item events into the existing HTML POC.
- [ ] Route user edits through the owning state service.
- [ ] Route copy and open-folder requests through platform capability services.
- [ ] Preserve pane auto-scroll and row selection as UI-owned state.
- [ ] Display source-range provenance from stable segment IDs.
- [ ] Add visible degraded states when individual services are unavailable.

## 8. Permissions and packaging

- [ ] Declare filesystem, microphone, clipboard, network, and model credential permissions per service.
- [ ] Launch services with only their declared authority.
- [ ] Decide whether the desktop shell is Electron, Tauri, or another host after measuring the Node proof.
- [ ] Package service manifests, contracts, and the graph as inspectable artifacts.
- [ ] Add signed/versioned component bundles if third-party drop-in components become a goal.

## 9. Observability and acceptance

- [ ] Persist the route-level event trace for replay.
- [ ] Add graph visualization from manifests and wires.
- [ ] Add correlation-based session trace viewing.
- [ ] Add deterministic end-to-end replay from recorded messages.
- [ ] Add fault injection for crashes, delays, invalid output, and dropped messages.
- [ ] Define measurable acceptance thresholds for latency, recovery, replacement, and resource cost.

## Next recommended implementation slice

Implement session state plus temporary transcript persistence next. It exercises state ownership, idempotency, Stop/Resume behavior, and crash recovery without requiring audio hardware or a model provider.
