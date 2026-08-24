# Runtime Kernel and Explicit Planes

## Status

Accepted and implemented in the executable architecture proof on 2026-08-12.

## Decision

Argus uses two explicit message planes governed by the same default-deny rule:

- The **domain plane** carries application information.
- The **control plane** carries operational coordination.

Every meaningful interaction on either plane requires a visible, typed wire. The runtime participates in the graph through declared pseudo-components; it does not receive hidden message authority merely because it hosts the graph.

```text
@session-controller
    -- control:lifecycle.start --> transcript-source

transcript-source
    -- domain:transcript.segment --> window-selector
    -- control:service.failure --> @supervisor

logged-item-store
    -- domain:logged-item.stored --> @result-collector

@result-collector
    -- control:workflow.completed --> @run-controller
```

## Domain plane

Domain contracts currently include:

- `transcript.segment`
- `transcript.context-window`
- `logged-item.draft`
- `logged-item.stored`

The runtime may validate, copy, and route a domain envelope. It may not interpret or transform the domain payload.

## Control plane

Control contracts currently include:

- `lifecycle.start`
- `service.failure`
- `workflow.completed`

Control messages are not universally available. A service must declare the contract on its control port, and the graph must contain a compatible control wire.

## Runtime pseudo-components

Runtime pseudo-components occupy the reserved `@` namespace and declare the same domain/control ports as executable services.

### `@session-controller`

Emits lifecycle commands into explicitly wired services.

### `@supervisor`

Accepts explicitly routed service failures. Retry and restart policy will belong here when those contracts are introduced.

### `@result-collector`

Accepts terminal domain results through a domain wire and emits `workflow.completed`. This prevents the orchestrator from silently treating an arbitrary domain message as its return value.

### `@run-controller`

Accepts explicit workflow completion signals and decides when a finite graph run has completed.

## Intrinsic runtime kernel authority

The following mechanics exist below the message planes because they are necessary to host isolated executables:

- start an executable declared by a validated manifest;
- connect standard input, standard output, and standard error;
- detect process start failure and process exit;
- close standard input during shutdown;
- terminate a child that does not exit within the drain deadline;
- enforce graph, manifest, envelope, payload, port, and wire validation.

This list is exhaustive for the POC.

The kernel does **not** have intrinsic authority to:

- read or mutate service-owned domain state;
- inspect or transform domain payload meaning;
- invent a domain message;
- deliver any message without a compatible declared wire;
- handle a service failure as a domain event;
- infer workflow completion from an arbitrary domain contract;
- grant a service filesystem, network, microphone, clipboard, or credential access.

Raw process exit is an operating-system event and therefore reaches the kernel without a wire. It is not treated as a `service.failure` message. Future process-exit policy must remain explicit and may cause the kernel to ask a wired supervisor for a decision.

## Enforced invariants

The proof rejects a graph before starting processes when:

- a contract is placed on the wrong plane;
- a producer or consumer does not declare the contract on the matching port;
- a lifecycle start path has no control wire;
- a failure-emitting service has no control wire to a supervisor;
- the run controller has no workflow completion wire;
- a runtime pseudo-component is unknown or uses the service namespace;
- a service attempts to use the reserved runtime namespace.

Runtime envelopes include their plane, and contract validation rejects a plane that disagrees with the catalog.

## Proof tests

The executable proof demonstrates:

- removal of `lifecycle.start` makes startup invalid;
- removal of any service’s `service.failure` wire makes its failure path invalid;
- removal of `workflow.completed` makes completion invalid;
- domain contracts cannot travel on control wires;
- control contracts cannot travel on domain wires;
- an actual service failure reaches `@supervisor` through its declared control wire;
- the terminal domain result reaches `@result-collector` before completion reaches `@run-controller`.

## Consequence for contract governance

Contract governance must govern the plane as part of a contract’s identity and compatibility. Changing a contract from domain to control, or control to domain, is a breaking architectural change even if its payload schema is unchanged.

