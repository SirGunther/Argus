# Argus Atomic Architecture Feasibility Review

## Verdict

The architecture is feasible, and Node.js is a good runtime for the experiment.

The strongest idea in the current architecture folder is not merely “many services.” It is that behavior, state ownership, contracts, wiring, and traceability are all explicit. That can be implemented and tested. A component can be replaced without changing its neighbors when both implementations honor the same message contracts.

The approach is most feasible when a service represents an independently valuable capability—audio capture, transcript window selection, log extraction, persistence—not every helper function. Turning every small transformation into a process would add more transport and lifecycle work than useful isolation.

## What is already strong

| Area | Assessment |
| --- | --- |
| Isolation | Clear default: implementations do not import each other. |
| Contracts | Input/output thinking is explicit and testable. |
| Wiring | Treating the graph as a first-class artifact makes composition possible. |
| State ownership | “One owner per state” prevents hidden write paths. |
| Replaceability | The architecture provides an objective compatibility test. |
| Traceability | Correlation IDs and service identity make cross-process behavior reconstructable. |
| Failure locality | A failure can be named at a specific service boundary. |

## What the documents did not yet prove

The documents describe the rules well, but several runtime questions need executable answers:

- How manifests declare accepted and emitted message types
- How invalid wires are rejected before startup
- How payloads are validated at runtime
- How a graph starts and knows when a finite run is complete
- What happens when a process exits, stalls, duplicates a message, or emits invalid data
- How backpressure, retry, timeout, and dead-letter behavior are represented
- How contract versions evolve without breaking existing implementations
- How user-edited state rejects a stale asynchronous model result
- How resource usage changes as the number of isolated processes grows
- Which permissions and filesystem locations each service receives

The initial scaffold answers the first four and establishes test seams for the rest.

## Initial technical choice

The first runtime uses one Node child process per service and newline-delimited JSON over standard input/output.

```text
service stdout -> message envelope -> orchestrator -> declared wire -> service stdin
service stderr -> structured operational trace
```

This is appropriate for the proof because it provides:

- real process and memory isolation;
- no direct implementation imports between services;
- a narrow language-neutral transport;
- deterministic local tests without network infrastructure;
- a direct path to later replace standard I/O with sockets or a broker.

It is not the final transport decision. Standard I/O has limited backpressure and restart semantics. Those limitations are useful to expose before adopting a heavier system.

## Feasibility by layer

### Contracts — high feasibility

JSON message envelopes and payload schemas are straightforward. The main challenge is governance: version compatibility, deprecation, and who owns each schema.

### Wiring runtime — high feasibility for a POC

A graph manager can load service manifests, reject undeclared connections, spawn processes, and route only matching messages. Production hardening will require health checks, bounded queues, graceful shutdown, and supervision policies.

### Extreme service isolation — feasible with a cost

The constraint can be honored. The cost is more manifests, duplicated boundary validation, more processes, and more integration testing. That cost is central to the experiment and should be measured rather than hidden.

### Live audio and transcription — feasible, latency-sensitive

Audio chunking and speech-to-text can use the same contracts, but high-frequency audio should not be copied through an unbounded JSON pipeline. Binary transport, shared immutable buffers, or a dedicated streaming boundary may be justified while preserving explicit authority.

### Model-backed log extraction — feasible and naturally replaceable

The extractor can accept a stable ContextWindow and emit a LoggedItemDraft. A deterministic fake and a real model adapter can satisfy the same contract. This is an especially good replaceability test.

### Persistence and session finalization — feasible, needs careful ownership

Temporary transcript state, temporary logged-item state, permanent history, and session metadata should each have a declared owner. Exactly-once storage is unlikely; idempotent writes keyed by message and item IDs are more realistic.

## Primary risks

1. **Service granularity drift:** boundaries become either too tiny to operate or too broad to replace.
2. **Orchestrator growth:** business logic leaks into the graph manager.
3. **Contract churn:** schema changes silently break independent services.
4. **Message amplification:** high-frequency events create avoidable process and serialization load.
5. **Distributed state ambiguity:** retries and duplicates cause multiple “current” values.
6. **Operational overhead:** process count, startup time, logs, and packaging become cumbersome.
7. **False isolation:** services remain separate processes but share unrestricted filesystem or credentials.

## Guardrails

- The orchestrator routes and supervises; it does not transform domain payloads.
- A service imports no code from another service.
- Shared artifacts are contracts and test fixtures, not business implementation.
- Each state mutation carries an idempotency identity and revision where appropriate.
- Every boundary test includes a valid message and at least one invalid message.
- Every critical contract has a fake and at least two compatible implementations over the life of the experiment.
- Resource cost is measured as services are added.
- New authority requires an explicit manifest or wiring change.

## Recommendation

Proceed with the experiment. Keep the first graph deliberately small, prove replaceability and failure rejection, then add one production-shaped capability at a time. The architecture should earn complexity through measured tests rather than adopting infrastructure in advance.

## POC resolution update — 2026-08-12

The original runtime ambiguity around startup, service failure, terminal results, and workflow completion has been resolved in the executable proof. Domain and control contracts now occupy separate manifest ports and graph wire collections. Runtime-owned behavior is exposed through `@session-controller`, `@supervisor`, `@result-collector`, and `@run-controller` pseudo-components.

The finite authority remaining below those planes is documented in `RuntimeKernelAndPlanes.md`. Negative tests prove that removing an operational wire makes the corresponding capability unavailable. This places the proof on a sound foundation for contract governance.
