# Runtime Kernel, Explicit Planes, and Supervision

## Status

Accepted. The domain/control-plane boundary was proven on 2026-08-12; Phase 2 runtime supervision was accepted and implemented later that day.

## Decision

Argus uses two explicit message planes governed by the same default-deny rule:

- The **domain plane** carries application information.
- The **control plane** carries operational coordination.

Every meaningful interaction on either plane requires a visible, typed wire. The runtime participates through declared pseudo-components and does not receive hidden message authority merely because it hosts the graph.

```text
@supervisor
    -- control:lifecycle.health-check --> service
    <-- control:service.health ---------
    -- control:lifecycle.drain --------> service
    <-- control:service.drained --------
    <-- control:operation.completed ----
    <-- control:service.failure --------

@runtime-provider
    -- control:service.exited ---------> @supervisor
    -- control:service.failure --------> @supervisor
```

## Domain plane

The runtime may validate, copy, queue, and route a domain envelope. It may not interpret or transform domain payload meaning. Current domain contracts are `transcript.segment`, `transcript.context-window`, `logged-item.draft`, and `logged-item.stored`.

## Control plane

Current control contracts are:

- `lifecycle.start`
- `lifecycle.health-check` and `service.health`
- `lifecycle.drain` and `service.drained`
- `operation.completed`
- `service.failure` and `service.exited`
- `dead-letter.message`
- `workflow.completed`

Control messages are not universally available. Both endpoint ports and a compatible graph wire are required.

## Runtime pseudo-components

Runtime pseudo-components occupy the reserved `@` namespace and declare the same plane-specific ports as executable services.

- `@session-controller` emits the explicitly wired session start.
- `@supervisor` owns readiness gates, operation outcomes, retry/restart recovery decisions, drain coordination, and required/optional failure policy.
- `@runtime-provider` converts process-provider observations and runtime-generated timeouts into explicit control facts sent to the supervisor.
- `@dead-letter-collector` receives messages whose declared retry policy is exhausted.
- `@result-collector` receives terminal domain results and emits `workflow.completed`.
- `@run-controller` decides when a finite run has completed.

## Accepted Phase 2 defaults

- The design is runtime-neutral; Node is the sole installed provider.
- Required components fail fast after their explicit recovery policy is exhausted.
- Optional degraded behavior exists only when the graph declares `required: false`.
- Readiness deadline: 5,000 ms.
- Graceful drain deadline: 2,000 ms.
- Operation deadline: 2,000 ms unless the exact wire overrides it.
- Retry is disabled unless the exact wire declares attempts, delay, and a dead-letter destination.
- Restart is disabled by default. A stateless component may declare bounded restart. A state-owning component cannot restart without a declared recovery owner.
- Every wire queue is bounded; the POC overflow policy is fail-fast and observable.
- Undeclared output fails contract validation immediately.
- Resource measurements are POC evidence, not production acceptance thresholds.

## Intrinsic kernel authority

The following mechanics are exhaustive for the POC:

- validate graphs, manifests, envelopes, payloads, ports, and wires;
- resolve only an installed trusted runtime provider;
- connect protocol input/output and a separate diagnostics stream;
- inject the graph service-instance identity and reject outputs that claim another producer;
- create bounded per-wire queues and observe their depth;
- start an executable declared by a validated manifest;
- translate a validated permission declaration into the restrictions the installed provider can enforce, and read the component's own directory plus the shared `runtime/` and `contracts/` component libraries so the executable can be loaded at all — that read grant is exhaustive, and everything outside it is denied unless declared;
- rebuild the child environment from the manifest's declared allowlist, dropping every undeclared `ARGUS_` variable and every credential-shaped inherited variable;
- observe provider start failure and process exit;
- close input after an explicit drain outcome or deadline;
- force-terminate a child only after the declared drain deadline;
- keep timers needed to enforce graph-declared readiness, operation, and drain policy.

The kernel does **not** have intrinsic authority to interpret domain payloads, invent domain messages, deliver without a wire, infer successful work from a stream write, retry/restart without graph permission, silently degrade a required component, or grant filesystem/network/device/credential access. Permission resolution is launch mechanics only: it never reads, transforms, or interprets a payload, and it can only narrow what a component may do.

An operating-system exit and a timer firing are raw host observations. They become governed `service.exited` or `service.failure` messages from `@runtime-provider`; the wired supervisor, not the launcher callback, applies recovery policy.

## Provider boundary

The manifest uses a discriminated `runtime.kind` for `node`, `native`, or `container`, plus a required default-deny `permissions` block. The graph cannot provide arbitrary shell commands and cannot declare a raw host path. Only the Node provider is installed. A structurally valid native or container declaration fails graph preparation with `RUNTIME_PROVIDER_UNAVAILABLE` before any process launches.

Declared authority becomes real Node-runtime `--permission` flags for filesystem read, filesystem write, child processes, worker threads, native add-ons, WASI, and the declared heap ceiling. A capability the installed host cannot enforce is refused at declaration time rather than accepted and simulated. See ADR-018 and `PermissionsPackagingPhase8Evidence.md` for the enforcement matrix, including the outbound-network gap the installed Node build cannot close.

## Enforced invariants

Graph preparation rejects:

- a contract placed on the wrong plane;
- a producer or consumer missing the matching port;
- missing start, readiness, operation, failure, drain, exit, or completion wiring;
- retry without a declared dead-letter component and control wire;
- unbounded or invalid recovery declarations;
- stateful restart without a recovery owner;
- an unknown runtime component or namespace violation;
- a runtime kind without an installed trusted provider;
- a manifest with no explicit permission declaration;
- a granted capability no installed provider or host adapter can enforce;
- a resource limit only a container provider could apply;
- configuration a component is not permitted to use, including a credential-bearing key without a credential grant and a model endpoint without the declared network scope;
- a declared component file that is absolute or contains traversal.

Runtime enforcement proves readiness gates, operation timeouts, per-wire opt-in retries, dead-letter delivery, bounded stateless restart, recovery exhaustion, undeclared-output failure, drain deadline enforcement, graph-wide message integrity, and explicitly wired nonfatal rejections.

## Measurement evidence

`npm run measure:runtime` runs 1, 2, and 3 parallel pipelines (4, 8, and 12 service processes) and reports startup time, health-reported RSS, throughput, queue depth, and routing-operation latency as JSON. The numbers characterize this machine and POC only; they do not authorize production thresholds.

## Phase 3 extension

Retry and restart intentionally replay unfinished input. Phase 3 now governs message identity, idempotency, duplicate handling, per-session ordering, optimistic state revisions, stale derived results, and the one global AI lane. See `IdentityOrderingAndAiLane.md` for the exhaustive policy and proof.

## Next architectural risk

Phase 4 must define committed versus partial transcript semantics and explicit temporary/permanent transcript ownership without weakening the identity and ordering rules.
