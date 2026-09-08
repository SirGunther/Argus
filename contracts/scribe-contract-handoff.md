# SCRIBE-01 contract handoff

Governed shapes Wave 2 (SCRIBE-02 through SCRIBE-05) must consume. No runtime, service,
graph, UI, or storage implementation was changed by this ticket; everything below is
schema, catalog, changelog, fixture, and doc governance only.

> **SCRIBE-04A addendum below.** Two additive transport messages now carry the
> coordinator <-> extraction-boundary Scribe batch channel. Everything in the original
> SCRIBE-01 body remains true and byte-identical; jump to
> [SCRIBE-04A addendum](#scribe-04a-addendum--provider-neutral-batch-transport) for the
> new message types SCRIBE-04, SCRIBE-02, and SCRIBE-05 must consume.

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
  `item_id`/`revision` (rejected by `additionalProperties: false`). The model never
  assigns identity. The Argus extraction path derives deterministic revision-zero draft
  IDs from the validated batch and item position/content, matching the existing
  single-item boundary; `logged-items/active-owner` then accepts or rejects each draft
  and its `logged-item.stored` result confirms authority (ADR-001, ADR-002). Only those
  owner-confirmed IDs may enter `scribe_batch_evaluated.acknowledgement.logged_item_ids`.
  SCRIBE-02 must require their unique order and count to correspond one-for-one with
  `items[]` before advancing its cursor, and SCRIBE-03 must persist that exact mapping
  without reconstructing or implicitly repairing it.

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

---

# SCRIBE-04A addendum — provider-neutral batch transport

Addressed to whoever finishes **SCRIBE-04** (`agent/scribe-model-extraction`, currently on
hold) and to **SCRIBE-02** and **SCRIBE-05**. Contracts only: SCRIBE-04A changed no runtime,
service, wiring, UI, or storage file, and no byte of any shape SCRIBE-01 shipped.

## Why these exist

SCRIBE-04 reused `ai.work-request` as the coordinator's inbound batch-proposal channel and
`ai.work-completed`'s failed path (via `service.failure`) as the only reachable outbound
outcome. That had two concrete structural defects:

1. `ai-work-request.schema.json`'s `protocol_version: "2.0.0"` `modelRequest` variant
   **requires** a non-empty `model`. A coordinator that per
   `Architecture/OperationalAgentRoles.md` holds no provider or model knowledge would have to
   fabricate a `model` string on every batch proposal purely to satisfy the schema — which the
   extraction boundary then discards and replaces with `readModelName()`.
2. A **settled non-failed** batch outcome (`empty-evaluated` or `items-recorded`) had **no
   message carrier back to the coordinator at all**, so SCRIBE-02 had no governed way to
   advance its durable cursor on the normal path.

Reusing one message type for two semantically different transports also forced the extraction
boundary to guard against its own emitted `ai.work-request` messages looping back.

`ai.work-request` / `ai.work-completed` **stay exactly as they are** and remain the
**control-plane** channel between the extraction boundary and the serial AI model lane. The two
messages below are the **domain-plane** Scribe batch channel.

## Exact versions to consume

| Contract | Kind | Version | Plane | Owner | Schema |
| --- | --- | --- | --- | --- | --- |
| `scribe.batch-admitted` | catalog message | `1.0.0` | `domain` | `logged-items/scribe-coordinator` | `contracts/scribe-batch-admitted.schema.json` (`$id: argus.scribe-batch-admitted.v1`) |
| `scribe.batch-evaluated` | catalog message | `1.0.0` | `domain` | `logged-items/extraction` | `contracts/scribe-batch-evaluated-message.schema.json` (`$id: argus.scribe-batch-evaluated-message.v1`) |

Catalog `schema_version` moved `1.13.0` -> **`1.14.0`** (additive minor). Both messages sit on
the `domain` plane, following the existing `transcript.context-window` extraction-trigger
precedent: an admitted or evaluated batch is a session evidence fact, not AI-lane scheduling.
Note the **schema filename** for the evaluated message carries a `-message` suffix because
`contracts/scribe-batch-evaluated.schema.json` is already the SCRIBE-01 **artifact**; the
message type itself is plain `scribe.batch-evaluated`.

## `scribe.batch-admitted` — coordinator -> extraction boundary

Emitted by the Scribe coordinator when its governed admission policy closes a batch. Payload,
all five fields required, `additionalProperties: false`:

| Field | Meaning |
| --- | --- |
| `batch_identity` | `$ref argus.scribe-batch-identity.v1` — the immutable SCRIBE-01 identity, unchanged. Carries `request_id`, `session_id`, the ordered contiguous `segments`, `first_sequence`/`last_sequence`, `admission_reason`, `policy_id`/`policy_version`/`instruction_version`. |
| `new_evidence_segments` | The batch's new authoritative finalized rows (`segment_id`/`sequence`/`start_time`/`end_time`/`text`), same shape as `ai-work-request`'s `segment`. `minItems: 1`, `maxItems: 16`. Must match `batch_identity.segments` exactly — same ids, same order, same `sequence` per position. Only these rows may trigger new Logged Items. |
| `background_context` | `{ transcript_segments, prior_logged_items }`, same shape as `ai-work-request`'s `scribeBackgroundContext`. Bounded lookback/forward context plus previously emitted **non-authoritative** Logged Items for duplicate suppression (ADR-021). Both arrays may be empty. A `prior_logged_items` entry may **not** carry `item_id`/`revision`. |
| `policy_profile` | The generation profile the batch was admitted under (mirrors `scribe.batch-policy.generation.policy_profile`). |
| `instruction_version` | The Scribe instruction version the batch was admitted under (mirrors `batch_identity.instruction_version`). |

**There is deliberately no `model`, provider, endpoint, or `limits` field**, and
`additionalProperties: false` makes adding one a contract violation rather than a convention.
A focused test asserts the whole schema contains no provider vocabulary at all.

What the **extraction boundary** supplies for itself when composing the `2.0.0` model request:

- **`model`** — from its own local configuration (`readModelName()`), never from the message.
- **`limits`** — from its own budget math against the retained `scribe.batch-policy`
  (`context.max_total_context_tokens`) plus the governed `EXTRACTION_BATCH_OUTPUT_LIMITS`
  ceilings in `contracts/model-protocol.mjs`.
- **`identity`** (`work_id`/`session_id`/`batch_request_id`) — AI-lane scheduler identity it
  owns, derivable from `batch_identity.session_id` + `batch_identity.request_id`. The
  coordinator no longer mints a scheduler `work_id`.
- **`recovery.max_attempts`** — its own governed retry budget; the admitted message carries no
  attempt count. The **attempt number** still arrives on `ai.work-completed.attempt`, exactly
  as SCRIBE-04 already reads it, and is what fills `scribe_batch_evaluated.attempt`.

`policy_profile` and `instruction_version` are governance fields the coordinator legitimately
stamps, **not** authority: the extraction boundary must keep cross-checking them against the
retained `scribe.batch-policy` for the session (SCRIBE-04's `assertPolicyAgreement`) and fail
visibly on disagreement rather than prompting under a version the batch was not admitted under.

`tests/fixtures/contracts/scribe.batch-admitted/1.0.0/` retains `valid.json` (three-row
`batch-complete`), `valid-partial-idle-batch.json` (two-row `idle-timeout`, empty background),
`invalid-model-field.json`, `invalid-missing-background-context.json`,
`invalid-empty-new-evidence.json`, `invalid-forged-prior-item-id.json`.

## `scribe.batch-evaluated` — extraction boundary -> coordinator

Payload is a single required field, `additionalProperties: false`:

| Field | Meaning |
| --- | --- |
| `batch` | `$ref argus.scribe-batch-evaluated.v1` — the SCRIBE-01 `scribe_batch_evaluated` artifact, embedded verbatim and **not redefined**. |

So all three settled outcomes now have a real carrier: **`empty-evaluated`** (zero items),
**`items-recorded`** (the complete item set plus the owner-confirmed
`acknowledgement.logged_item_ids`), and **`failed`** (with
`error.code`/`category`/`message`/`retryable`). Everything the SCRIBE-01 body says about that
artifact still governs it unchanged — the `if`/`then` outcome/items rules, the
`accepted: true` requires a real `acknowledged_at` rule, the `logged_item_ids` placement rules,
and the runtime-only one-for-one `logged_item_ids` <-> `items` correspondence.

The payload deliberately **does not repeat `session_id`** or anything else the artifact already
holds: `batch.batch_identity` is the authoritative identity and the envelope's
`correlation_id` carries the session. A duplicated routing key would be a forgeable divergence
the payload schema cannot detect (this repository's Ajv configuration has no `$data` support).
Provenance of the evaluation is the envelope's `producer`.

`tests/fixtures/contracts/scribe.batch-evaluated/1.0.0/` retains `valid.json` (two items),
`valid-one-item.json`, `valid-empty-evaluated.json`, `valid-failed.json` (timeout, retryable,
unaccepted), `invalid-missing-batch.json`, `invalid-forged-item-id.json`,
`invalid-empty-evaluated-with-item.json`, `invalid-forged-session-id.json`.

## What SCRIBE-04A did **not** do — still owned downstream

- **No wiring.** No producer/consumer ports or graph wires exist for either message. The
  Scribe coordinator must declare `scribe.batch-admitted` under its `domain.emits` and
  `scribe.batch-evaluated` under its `domain.accepts`; `log-extractor-local-http` must declare
  the mirror image. SCRIBE-05 adds the graph wires.
- **No runtime change to SCRIBE-04.** Its `'ai.work-request'` handler (`dispatch-scribe-batch`)
  must be re-pointed at `scribe.batch-admitted`, dropping the `proposal.identity.work_id` check
  and the `protocol_version === "2.0.0"` self-emission guard, which the plane and message-type
  split make unnecessary. Its settled-outcome path must emit `scribe.batch-evaluated` for
  **every** outcome, not just route failures through `service.failure`.
- **No cursor or acknowledgement behavior.** SCRIBE-02 still owns comparing an incoming
  `batch.batch_identity.request_id`/`attempt` against the batch it currently has outstanding
  (a stale or superseded attempt), and advancing the cursor only on a settled accepted outcome.
- **No existing shape changed.** `ai.work-request` and `ai.work-completed` stay at `1.5.0` with
  the `2.0.0` `modelRequest`/`modelResponse` variants exactly as SCRIBE-01 shipped them,
  `model` still required there because the model lane genuinely needs it.
