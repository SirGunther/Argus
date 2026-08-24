# Phase 3 Identity, Ordering, and AI Lane

## Accepted guarantees

Argus uses at-least-once delivery. A retry or restart may replay an input, so every current envelope and every state mutation has governed identity. Ordered inputs are scoped by `session_id`; the architecture does not claim total ordering across sessions or unrelated contracts.

## Message identity

Schema 1.2+ messages require:

- `message_id`: a UUID v4 identifying a concrete emitted message;
- `idempotency_key`: the stable logical operation identity chosen by the producer;
- `content_fingerprint`: SHA-256 of canonical semantic envelope content.

The semantic fingerprint includes plane, message type, producer, correlation, idempotency key, causation, schema version, and payload. It excludes message ID and timestamp so a producer may recreate the same logical operation after a crash without manufacturing a conflict.

An exact message replay and a new message carrying the same idempotency key and semantic content are duplicates. Reusing either identity with different semantic content is a fatal integrity violation. The runtime kernel maintains a graph-wide ledger; each independently runnable service also maintains its own input ledger.

Inside a graph, `producer` is the graph service-instance ID, not merely the reusable implementation name. The trusted runtime provider injects that identity; the kernel rejects an output whose producer does not match its endpoint. This prevents two instances of the same implementation from colliding in the global idempotency namespace.

## Idempotent consumers

The line-service protocol serializes input handling. This is required because a newline reader may deliver another line while an asynchronous handler is still running.

For stateless operations, a duplicate re-emits the first operation's cached outputs and returns a duplicate completion receipt. For state-owning operations, the handler may re-evaluate a duplicate against current authoritative state. It must either reproduce the same output or return an explicit governed rejection; producing different output for the same completed logical operation is `IDEMPOTENT_OUTPUT_CONFLICT`.

The Phase 3 state-owner proof uses the logged-item store. A draft replay does not create a second record, and an update replay does not increment revision twice. Durable logged-item storage remains Phase 6 work; these semantics are the required boundary it must preserve.

## Ordering

`transcript.segment` is ordered independently within each `session_id` by a non-negative contiguous sequence beginning at zero.

- The expected sequence is accepted and advances the stream.
- A larger sequence is `SEQUENCE_GAP`, retryable, and does not advance the stream.
- A smaller sequence is `LATE_MESSAGE`, non-retryable, and becomes `operation.rejected`.
- An exact duplicate is idempotent and does not advance twice.

The graph must explicitly wire `operation.rejected` from every service that can produce it to the supervisor. A rejection terminates that input without failing the required component. It remains observable in run results and metrics.

## Optimistic revisions and stale AI work

`logged-item.update` carries `expected_revision`. Only the owning store may increment revision, and only when the expectation equals the authoritative revision. Mismatch produces `STALE_REVISION` without mutation.

`classification.suggestion` carries the item revision it analyzed. If a user edit has advanced the item, the suggestion produces `STALE_RESULT` and cannot overwrite, label, or otherwise mutate the logged item. Classification remains optional suggestion data.

## Global AI execution lane

`SerialAiScheduler` implements ADR-006 with a JSON-lines durable journal, bounded admission, concurrency one, non-preemptive completion, recovery attempts, fixed priority, and FIFO by invocation order within a workload. Restart recovery rehydrates both unfinished work and terminal results, so replaying a completed `work_id` returns its recorded result rather than executing the model again.

The fixed workload priority is transcription, transcript correction/formatting, logged-item extraction, then classification enrichment. The work contracts are `ai.work-request` and `ai.work-completed`. The scheduler is a runtime capability with an injected executor and journal; model adapters remain replaceable components. The deterministic Phase 4C corrector does not call a model; a future model-backed corrector must enter its governed second-priority workload. Phase 5 will wire real adapters to this proven boundary.

## Executable evidence

`tests/identity-ordering.test.mjs` proves:

- current identity creation and validation;
- exact replay and fatal message/idempotency conflicts;
- post-fingerprint tamper rejection;
- independent per-session ordering, gaps, and late arrivals;
- duplicate-safe window selection;
- idempotent logged-item drafts and revisions;
- stale edit and stale classification rejection;
- scheduler concurrency one, non-preemption, priority/FIFO, capacity failure, durable events, unfinished-work recovery, terminal-result idempotency across restart, and concurrent-admission ordering.

`tests/wiring.test.mjs` proves that removing an `operation.rejected` wire makes the graph invalid.
