# SCRIBE-01 contract handoff

Governed shapes Wave 2 (SCRIBE-02 through SCRIBE-05) must consume. No runtime, service,
graph, UI, or storage implementation was changed by this ticket; everything below is
schema, catalog, changelog, fixture, and doc governance only.

## Exact versions to consume

| Contract | Kind | Version | Schema |
| --- | --- | --- | --- |
| `scribe.batch-policy` | catalog message (control plane) | `1.0.0` | `contracts/scribe-batch-policy.schema.json` |
| `ai.work-request` | catalog message (control plane) | `1.5.0` (new `protocol_version: "2.0.0"` `modelRequest` variant; existing `1.0.0` variants unchanged) | `contracts/ai-work-request.schema.json` |
| `ai.work-completed` | catalog message (control plane) | `1.5.0` (new `protocol_version: "2.0.0"` `modelResponse` variant; existing `1.0.0` variants unchanged) | `contracts/ai-work-completed.schema.json` |
| `scribe_batch_identity` | catalog artifact | schema `1.0.0` (no `schema_version` field; shape is the version) | `contracts/scribe-batch-identity.schema.json` |
| `scribe_batch_evaluated` | catalog artifact | schema `1.0.0` | `contracts/scribe-batch-evaluated.schema.json` |
| `scribe_checkpoint` | catalog artifact | `schema_version: "1.0.0"` | `contracts/scribe-checkpoint.schema.json` |
| `scribe_batch_journal_entry` | catalog artifact | schema `1.0.0` | `contracts/scribe-batch-journal-entry.schema.json` |

Catalog `schema_version` is `1.13.0`. Pure-function validators for the batch protocol
live in `contracts/model-protocol.mjs`: `SCRIBE_BATCH_PROTOCOL_VERSION` (`"2.0.0"`),
`EXTRACTION_BATCH_OUTPUT_LIMITS`, `validateScribeBatchModelRequest`,
`validateScribeBatchModelResponse`. These are additive exports; the existing 1.0.0-only
`validateModelRequest`/`validateModelResponse` used by
`services/log-extractor-local-http` and `services/serial-ai-model-lane` are untouched.

## What Wave 2 still owns

- **Wiring**: no producer/consumer graph wires exist yet for `scribe.batch-policy`,
  the `2.0.0` model-request/response variants, or the checkpoint/journal artifacts.
  SCRIBE-02/03 must add them.
- **Cross-message correlation**: `validateScribeBatchModelRequest` rejects a request
  whose `identity.session_id`/`identity.batch_request_id`/`instruction_version`
  conflicts with its own `batch_identity`, and requires `new_evidence_segments` to
  match `batch_identity.segments` exactly — same segment IDs, same order, same
  `sequence` per position, not merely the same set. `validateScribeBatchModelResponse`
  rejects any item whose `source_segment_ids` cite a segment outside the response's own
  `batch_identity.segments` (fabricated provenance is now structurally impossible, not
  just well-formed). What remains runtime work: recognizing when a *response*'s
  `batch_identity.request_id` does not match the batch SCRIBE-02 currently has
  outstanding (a stale or superseded attempt) — that requires the in-memory pending-work
  state the contract validators don't have when validating one message in isolation.
  `scribe_checkpoint.in_flight_batch.attempt` (see below) exists so SCRIBE-02 has
  something durable to compare an incoming result's `attempt` against.
- **Idle timer and 8,000-token accounting**: `scribe.batch-policy` carries the
  governed defaults (`rows_per_batch: 3`, `idle_timeout_ms: 15000`,
  `max_total_context_tokens: 8000`) but does not implement a timer, a tokenizer, or
  restart reconstruction. That remains `MOD-002`/`MOD-003` in
  `PENDING-DECISIONS.md`, unresolved by this ticket.
- **Durable file I/O**: `scribe_checkpoint` (versioned snapshot, atomic
  replace-by-rename per ADR-015's existing pattern) and `scribe_batch_journal_entry`
  (one NDJSON line per evaluated batch, append-only) are shapes only. SCRIBE-03 owns
  reading/writing them and reconstructing `background_context` on restart. The
  checkpoint shape carries `in_flight_batch` (`batch_identity`, `attempt`,
  `dispatched_at`) precisely so a crash between dispatch and evaluation has a governed
  place to recover the identical batch identity and attempt count for retry — SCRIBE-03
  still owns writing it before dispatch and clearing it once `last_evaluated_batch`
  is written, but the slot exists.
- **Assigning authoritative item identity**: proposed items in
  `ai.work-completed`'s `items[]` and in `scribe_batch_evaluated.items[]` cannot carry
  `item_id`/`revision` (rejected by `additionalProperties: false`). Only
  `logged-items/active-owner` may assign those, exactly as for the existing single-item
  path (ADR-001, ADR-002). Once assigned, `scribe_batch_evaluated.acknowledgement.
  logged_item_ids` is the governed place to record the resulting authoritative IDs —
  SCRIBE-03 still owns writing it after the owner accepts the batch.

## Key shape decisions

- **Compatibility**: both `ai.work-request` and `ai.work-completed` took a
  backward-compatible **minor** catalog bump (`1.4.0` -> `1.5.0`). The existing
  `protocol_version: "1.0.0"` single-window/single-`text` shapes are byte-for-byte
  unchanged and remain the only shapes current production services emit/consume. The
  new batch shape is reachable only through a distinct, explicit
  `protocol_version: "2.0.0"` discriminator (an internal protocol version, not the
  catalog message version) — this is the "explicit version change" for the part of the
  old shape (a single `text` field) that cannot represent zero-to-many items.
- **New evidence vs. background context**: `new_evidence_segments` carries only the
  batch's new authoritative finalized rows. `background_context` is a separate object:
  `transcript_segments` (bounded lookback/forward, same shape as the existing
  `bounded_context_segments`) plus `prior_logged_items` (previously emitted,
  non-authoritative Logged Items retained for duplicate suppression per ADR-021). A
  segment id cannot appear in both places (enforced by
  `validateScribeBatchModelRequest`).
- **Batch identity**: `scribe_batch_identity` is `session_id` + an ordered, contiguous,
  duplicate-free `segments` list (`segment_id`/`revision`/`sequence`) +
  `first_sequence`/`last_sequence` + `admission_reason`
  (`"batch-complete" | "idle-timeout"`) + `policy_id`/`policy_version`/
  `instruction_version` + the immutable `request_id`. It is reused via `$ref` from the
  new `ai.work-request`/`ai.work-completed` variants and from
  `scribe_batch_evaluated`/`scribe_checkpoint`, so the shape is defined once.
- **Evaluated-batch outcome**: `scribe_batch_evaluated` is one artifact shape covering
  all three outcomes — `empty-evaluated` (zero items), `items-recorded` (the complete
  item set), and `failed` (with `error.code/category/message/retryable`) — plus a
  terminal `acknowledgement` (`ack_id`, `accepted`, `acknowledged_at`). `if`/`then`
  rules in the schema enforce that `items` is empty for `empty-evaluated`, non-empty
  for `items-recorded`, that `error` is present for `failed`, and that an `accepted:
  true` acknowledgement always carries a real `acknowledged_at` timestamp (a null
  timestamp is only valid alongside `accepted: false`, matching the `valid-failed`
  fixture) — settlement can never be represented as "accepted" without a durable time.
  A model-endpoint timeout with no response at all is represented as `outcome: "failed"`
  with `error.category: "timeout"` and `retryable: true`, exactly like the
  `valid-failed` fixture; there is no separate "ambiguous" outcome. `acknowledgement.
  logged_item_ids` holds the resulting authoritative Logged Item IDs and is governed by
  `if`/`then` rules: non-empty only when `outcome: "items-recorded"` **and**
  `accepted: true`; empty for every other outcome/acceptance combination (`empty-
  evaluated`, `failed`, or a rejected `items-recorded` batch). The schema cannot enforce
  that its length matches `items.length` one-for-one (no `$data` support in this repo's
  AJV configuration) — that positional correspondence is a runtime invariant for
  whichever component (`logged-items/active-owner` or SCRIBE-03) writes this field.
- **Bounded queue**: `scribe_checkpoint.pending_partial.segments` is capped at
  `maxItems: 2`, matching ADR-021's "one- or two-row remainder" — a checkpoint can
  never describe a stranded partial batch larger than the policy allows.
