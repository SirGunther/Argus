## Boundary Invariant

No service may affect, inspect, invoke, read from, write to, or depend on another service unless that relationship has been explicitly declared.

There are no ambient relationships.

There is no implicit sharing.

There is no accidental reachability.

A service begins isolated.

Connectivity must be added intentionally.

The system therefore follows this rule:

> Nothing crosses a boundary unless a wire exists.

A wire is an explicit declaration that identifies:

* the producer
* the consumer
* the contract being exchanged
* the direction of communication
* the permitted data
* the failure behavior
* any required permissions

If no wire exists, communication is impossible by design.

---

### Default-Deny Architecture

Every boundary is closed by default.

Services should not automatically gain access to:

* shared filesystems
* shared databases
* environment variables belonging to other services
* internal APIs
* process memory
* operating-system resources
* network endpoints
* message streams
* credentials
* configuration owned by another component

Access must be granted explicitly.

The desired model is:

```text
Service A        Service B

   X  no connection  X
```

until the architecture declares:

```text
Service A
    │
    │ Contract: TranscriptSegment
    │
    ▼
Service B
```

The existence of both services is not sufficient to create a relationship between them.

---

### Wiring Is Architecture

The wiring graph is a first-class artifact.

It should be possible to inspect the system and answer:

```text
What can talk to this service?

What can this service talk to?

What data can cross each boundary?

Who owns each connection?

Why does this connection exist?
```

Ideally, the complete application topology can be represented separately from the services themselves:

```text
audio-capture
    -> speech-to-text : AudioChunk

speech-to-text
    -> transcript-bus : TranscriptSegment

transcript-bus
    -> transcript-writer : TranscriptSegment

transcript-bus
    -> clipboard-service : TranscriptSegment
```

The services define behavior.

The wiring defines the application.

---

### No Transitive Authority

If Service A can communicate with Service B, and Service B can communicate with Service C, that does not imply that Service A has any access to Service C.

```text
A -> B -> C
```

does not mean:

```text
A --------> C
```

Every edge must exist independently.

Authority does not leak through the graph.

---

### No Boundary Bypasses

The following should be considered architectural violations:

```text
Service A directly reads Service B's database.

Service A imports Service B's implementation.

Service A writes into Service B's directory.

Service A relies on an undocumented environment variable from Service B.

Service A discovers Service B dynamically and starts calling it without declared wiring.

Two services communicate through a shared global object.

A "temporary" shortcut bypasses the defined message contract.
```

Even if such a shortcut is convenient, it breaks the experiment.

---

### Explicit Wiring Principle

A useful test for every interaction is:

> If I deleted the orchestration configuration, would these two components still know how to find or influence one another?

Ideally, the answer is **no**.

The component knows its ports.

The orchestration layer knows the connections.

Neither responsibility leaks into the other.

---

### Architectural Goal

The system should behave less like a collection of objects sharing a runtime and more like an electrical circuit.

A component exposes terminals.

A terminal has a defined type.

Nothing happens simply because two components happen to exist nearby.

Someone must deliberately connect them.

```text
[ Component ]
     ○
     │
     │ explicit wire
     │
     ○
[ Component ]
```

**Proximity does not imply permission.**

**Visibility does not imply access.**

**Existence does not imply connectivity.**

Only wiring creates relationships.

### Session storage authority

Phase 6 applies the same default-deny rule to the filesystem. `ARGUS_SESSION_ROOT` is not ambient application authority: the trusted launcher passes it only to manifests that declare session-storage or folder-locator side effects. Those owners use the governed storage boundary and validate the session identity and resolved path before access.

Other components do not construct session paths, read active snapshots, or append permanent history directly. They exchange transcript, logged-item, lifecycle, and locator messages over declared graph wires. The filesystem implementation is replaceable behind that boundary; the POC's JSON snapshots and NDJSON histories are not a new cross-service shared database.
