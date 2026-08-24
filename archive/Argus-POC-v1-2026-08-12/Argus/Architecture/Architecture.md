# Atomic Architecture Experiment

## Intent

Build an application as a collection of fully isolated, single-purpose services.

The experiment deliberately prioritizes:

* isolation
* explicit contracts
* deterministic behavior
* independent testing
* replaceability
* observability
* resistance to architectural drift

This is not an attempt to minimize process boundaries, deployment complexity, or boilerplate.

The purpose is to see what happens when **extreme modularity is treated as a hard architectural constraint rather than a preference**.

---

## Core Principle

Every meaningful capability is its own isolated unit.

Each unit should be understandable as:

**Input → Transformation / Action → Output**

A unit should know nothing about the larger application beyond the contract it implements.

It should not know:

* who called it
* why it was called
* what happens before it
* what happens after it
* which other services exist
* how its output will eventually be used

Its responsibility is only:

> Here is what I accept.
> Here is what I do.
> Here is what I return or emit.

---

## Isolation Rule

Every service should be independently runnable, independently testable, and independently replaceable.

Where practical, services should be physically isolated as well as logically isolated.

For example:

```text
/services
    /audio-capture
    /speech-to-text
    /transcript-writer
    /clipboard-writer
    /transcript-reader
    /notification-emitter
    /...
    
/orchestration
    /runtime
```

A service should not import implementation code from another service.

Shared implementation libraries should be avoided where possible.

Duplication is preferable to hidden coupling during this experiment.

The primary shared artifacts should be **contracts**, not implementation.

---

## Service Contract

Every service exposes an explicit contract describing:

```text
SERVICE
    name

ACCEPTS
    message/schema/input

RETURNS OR EMITS
    message/schema/output

ERRORS
    defined error conditions

SIDE EFFECTS
    explicitly declared external effects
```

Example:

```text
SERVICE
    speech-to-text

ACCEPTS
    AudioChunk

RETURNS
    TranscriptSegment

SIDE EFFECTS
    none

STATE
    optional local transcription session state
```

Another:

```text
SERVICE
    transcript-writer

ACCEPTS
    TranscriptSegment

RETURNS
    WriteResult

SIDE EFFECTS
    writes transcript data to configured storage

STATE
    owns only its persistence state
```

---

## Message-First Communication

Services communicate through messages or clearly defined request/response boundaries.

No service reaches directly into another service.

No shared mutable state.

No direct database access across service boundaries.

No service reads another service's files unless that file itself is explicitly defined as part of a public contract.

Preferred model:

```text
Service A
    ↓
Message
    ↓
Service B
    ↓
Message
    ↓
Service C
```

Or:

```text
                    ┌→ Service B
Service A → Event ──┼→ Service C
                    └→ Service D
```

The sender should not need to know which consumers exist.

---

## Orchestration

A separate orchestration layer is allowed.

Its job is coordination, not business logic.

The orchestrator may:

* start services
* stop services
* restart failed services
* connect outputs to inputs
* route messages
* provide configuration
* monitor health
* record service lifecycle events

The orchestrator should avoid transforming domain data itself.

Ideally:

```text
orchestrator = graph manager
```

rather than:

```text
orchestrator = giant application containing all real behavior
```

---

## State Ownership

State is allowed.

Hidden shared state is not.

Every piece of state must have exactly one explicit owner.

Example:

```text
audio-capture
owns:
    microphone connection

speech-to-text
owns:
    transcription session context

transcript-store
owns:
    transcript history

clipboard-service
owns:
    interaction with the operating-system clipboard
```

Other services interact with that state only through the owner's contract.

---

## Example System

A minimal voice transcription application could be represented as:

```text
┌──────────────────┐
│  audio-capture   │
└────────┬─────────┘
         │
         │ AudioChunk
         ▼
┌──────────────────┐
│  speech-to-text  │
└────────┬─────────┘
         │
         │ TranscriptSegment
         ▼
┌──────────────────┐
│    message bus   │
└─────┬─────┬──────┘
      │     │
      │     │
      ▼     ▼
┌─────────┐ ┌────────────────┐
│ writer  │ │ clipboard-view │
└─────────┘ └────────────────┘
```

Later:

```text
TranscriptSegment
      │
      ├── transcript-writer
      ├── clipboard-service
      ├── live-caption-service
      ├── search-indexer
      ├── summarizer
      ├── sync-service
      └── analytics-service
```

None of those additions require modification of the transcription service.

---

## Testing Rule

Every service must be testable without starting the rest of the application.

A test should be expressible approximately as:

```text
given:
    valid input X

when:
    service receives X

expect:
    output Y
```

For side-effecting services:

```text
given:
    message X
    isolated test environment

when:
    service receives X

expect:
    declared side effect Y
    response Z
```

Examples:

```text
known audio
    → speech-to-text
    → expected transcript
```

```text
known TranscriptSegment
    → transcript-writer
    → expected persisted record
```

```text
known text
    → clipboard-service
    → expected clipboard contents
```

No unrelated services should be required for these tests.

---

## Replaceability Test

Every service should be replaceable by another implementation that honors the same contract.

Example:

```text
speech-to-text-v1
speech-to-text-whisper
speech-to-text-cloud
speech-to-text-mock
```

All may satisfy:

```text
AudioChunk → TranscriptSegment
```

The surrounding system should not care which implementation is active.

---

## Fakeability Rule

Every boundary should permit a fake producer or consumer.

For example:

```text
fake-audio
    → speech-to-text
```

```text
fake-transcript-events
    → transcript-writer
```

```text
speech-to-text
    → debug-console
```

This allows every section of the graph to be operated independently.

---

## Observability

Because the architecture is highly distributed, messages should be observable.

Each message should ideally carry metadata such as:

```text
message_id
message_type
timestamp
producer
correlation_id
schema_version
payload
```

Example:

```json
{
  "message_id": "abc123",
  "message_type": "transcript.segment",
  "timestamp": "2026-08-11T17:00:00Z",
  "producer": "speech-to-text",
  "correlation_id": "session-42",
  "schema_version": 1,
  "payload": {
    "text": "This is what I just said."
  }
}
```

This should make the entire application reconstructable as a sequence of observable events.

---

## Failure Philosophy

A failing service should fail locally.

Its failure should not corrupt unrelated services.

The orchestrator may restart it.

Messages may be retried where appropriate.

Consumers should assume that:

* producers can disappear
* consumers can disappear
* messages may arrive late
* duplicate messages may occur
* versions may differ
* individual services may fail independently

The architecture should make these conditions visible rather than hiding them.

---

## Drift Prevention

Architectural isolation is a rule, not a suggestion.

Before adding a dependency from Service A to Service B, ask:

> Can this interaction instead be represented as a contract and a message?

Before adding shared code, ask:

> Does sharing this implementation create knowledge between services that should remain independent?

Before expanding a service, ask:

> Is this still exactly one responsibility?

When uncertain, prefer creating another isolated capability during the experiment.

Optimization can come later.

The experiment is specifically designed to discover the consequences of **too much separation rather than too little**.

---

## Deliberate Non-Goals

This experiment does not initially optimize for:

* minimum process count
* minimum latency
* minimum memory usage
* minimum deployment complexity
* minimum boilerplate
* conventional repository structure
* developer familiarity

Those are measurements to observe, not constraints to obey.

---

## Success Criteria

The experiment succeeds if the resulting system demonstrates that:

1. Any service can be understood independently.
2. Any service can be run independently.
3. Any service can be tested independently.
4. Any service can be replaced without rewriting its neighbors.
5. Failures remain localized.
6. New consumers can be added without changing producers.
7. State ownership is always obvious.
8. Communication occurs only through explicit contracts.
9. The complete application can be understood as a graph of capabilities.
10. Architectural boundaries remain difficult to violate accidentally.

---

## Guiding Mental Model

Do not think:

> I am building one application containing many modules.

Think:

> I am building a society of tiny programs that happen to cooperate.

Each one has a small vocabulary.

Each one owns its own behavior.

Each one can survive being examined alone.

The application exists primarily in the **relationships between those programs**.

---

## Ultimate Constraint

A component should be able to say:

> I do not know the application.

> I know only the messages I accept, the behavior I perform, and the messages I emit.

That is the experiment.
