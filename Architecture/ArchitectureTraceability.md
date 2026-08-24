## Traceability and Failure Locality

Every service must identify itself whenever it performs work.

Logs are not generic application logs.

Every emitted log entry must answer:

* which service produced it
* which operation was running
* which message or request triggered it
* when it happened
* whether it succeeded or failed

A service may emit logs only under its own identity.

There should be no ambiguity about origin.

If a log says:

```text
service = speech-to-text
```

then that event came from the `speech-to-text` service and nowhere else.

The architecture should make it impossible for unrelated code to impersonate that service.

---

### Location Is Part of Identity

A service's implementation belongs to one explicit location.

For example:

```text
/services/speech-to-text
```

All behavior attributed to `speech-to-text` must originate from that service boundary.

Business logic for that service should not be buried in:

```text
/shared
/utils
/helpers
/orchestrator
/common
```

and then merely called on its behalf.

The rule is:

> If behavior belongs to a service, its implementation lives with that service.

This creates a direct mapping:

```text
runtime event
    ↓
service identity
    ↓
service location
    ↓
implementation
```

When something fails, the system should immediately tell the developer where to look.

---

### One Path to an Operation

Where practical, every capability should have one canonical execution path.

If transcription happens, it happens through:

```text
speech-to-text
```

There should not also be:

```text
some-helper-that-can-transcribe
legacy-transcription-function
orchestrator-transcription-code
ui-direct-transcription-call
```

A capability has one owner.

A request for that capability goes to that owner.

This reduces ambiguity during debugging.

Instead of asking:

> Which of the five transcription implementations ran?

the answer is structurally predetermined:

> Transcription belongs to `speech-to-text`.

---

### Structured Logging

Every operation should emit structured events.

Example:

```json
{
  "service": "speech-to-text",
  "operation": "transcribe",
  "message_id": "msg-1842",
  "correlation_id": "session-71",
  "status": "started",
  "timestamp": "..."
}
```

Then:

```json
{
  "service": "speech-to-text",
  "operation": "transcribe",
  "message_id": "msg-1842",
  "correlation_id": "session-71",
  "status": "completed",
  "duration_ms": 84,
  "timestamp": "..."
}
```

Or:

```json
{
  "service": "speech-to-text",
  "operation": "transcribe",
  "message_id": "msg-1842",
  "correlation_id": "session-71",
  "status": "failed",
  "error_type": "ModelUnavailable",
  "timestamp": "..."
}
```

The origin of the failure is therefore explicit.

---

### Correlation Across Services

When one message causes work across several services, its correlation identity should travel with it.

For example:

```text
audio-capture
    correlation_id = 71
        ↓
speech-to-text
    correlation_id = 71
        ↓
transcript-writer
    correlation_id = 71
```

This makes the entire execution path reconstructable without combining service internals.

A trace might read:

```text
17:02:01 audio-capture      emitted AudioChunk
17:02:01 speech-to-text     received AudioChunk
17:02:02 speech-to-text     emitted TranscriptSegment
17:02:02 transcript-writer  received TranscriptSegment
17:02:02 transcript-writer  write failed
```

The failure is immediately localized.

---

### Services Return Outcomes, Not Hidden Exceptions

A service boundary should convert internal failures into explicit outcomes.

Instead of forcing callers to understand the internal exception structure of another service:

```text
try
    call service
catch internal implementation detail
```

prefer a stable external result:

```text
request
    ↓
service
    ↓
Success | Failure
```

For example:

```json
{
  "status": "failure",
  "service": "transcript-writer",
  "operation": "write",
  "error": {
    "type": "StorageUnavailable",
    "retryable": true
  }
}
```

The service remains responsible for understanding its own implementation failures.

The caller only needs to understand the contract.

---

### The Orchestrator Handles Coordination Failure

Services should not accumulate large amounts of cross-service defensive logic.

The orchestration layer may own concerns such as:

```text
retry
timeout
restart
fallback
routing
health checking
circuit breaking
dead-letter handling
```

A service should primarily answer:

```text
Can I perform my responsibility?

Yes → return/emit success.

No → return/emit a defined failure.
```

This keeps individual services small.

---

### Thin Service Principle

A service should contain only what is required to fulfill its contract.

Its code should not need to understand the entire execution chain.

Conceptually:

```text
receive input
validate contract
perform responsibility
emit result
emit trace
```

rather than:

```text
receive input
understand five neighboring systems
handle their internal exceptions
manage global state
perform unrelated fallback behavior
call utility layers
guess what should happen next
```

Complexity moves away from hidden control flow and toward explicit system wiring.

That trade is intentional.

---

### Failure Locality

When a failure occurs, the system should be able to produce:

```text
FAILED SERVICE
    transcript-writer

FAILED OPERATION
    write

INPUT
    TranscriptSegment

CORRELATION
    session-71

ERROR
    StorageUnavailable

SOURCE LOCATION
    /services/transcript-writer
```

The debugging question should therefore rarely be:

> Where could this failure possibly have come from?

It should instead be:

> Why did this specific service fail to honor its contract?

That is a much smaller search space.

---

### Observability Rule

Every boundary crossing should be observable.

At minimum:

```text
message sent
message received
operation started
operation completed
operation failed
```

This produces a traceable graph of actual runtime behavior.

The architecture graph describes what **may** happen.

The event log describes what **did** happen.

Together they should provide a nearly complete explanation of system behavior.

---

### Architectural Principle

> No invisible execution.

If meaningful work happens, its owning service identifies itself.

If a boundary is crossed, the crossing is observable.

If a failure occurs, the failing boundary is named.

If behavior exists, it has one explicit owner and one obvious place to inspect.

The system should always be able to answer:

> What happened?

> Who did it?

> What caused it?

> Where does that behavior live?

> What happened immediately before and after it?

Traceability is therefore not tooling layered on top of the architecture.

**Traceability is one of the architectural guarantees.**
