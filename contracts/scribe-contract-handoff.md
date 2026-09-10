# Scribe contract and implementation handoff

This document began as the SCRIBE-01 contract handoff. SCRIBE-04A added the provider-neutral
transport and SCRIBE-04B reconciled the Wave 2 implementations against that transport. The
original design record remains below, but the SCRIBE-04B section is authoritative where it
explicitly supersedes an earlier implementation note. Production graph wiring remains SCRIBE-05.

> **SCRIBE-04A addendum below.** Two additive transport messages now carry the
> coordinator <-> extraction-boundary Scribe batch channel. Everything in the original
> SCRIBE-01 body remains true and byte-identical; jump to
> [SCRIBE-04A addendum](#scribe-04a-addendum--provider-neutral-batch-transport) for the
> new message types SCRIBE-04, SCRIBE-02, and SCRIBE-05 must consume.

> **SCRIBE-04B reconciliation complete.** The coordinator and extraction implementations now
> consume these messages. Provider completion attempts are model-lane telemetry only; they are
> never a coordinator retry counter. See the SCRIBE-04B runtime section below.

## Exact versions to consume

| Contract | Kind | Version | Schema |
| --- | --- | --- | --- |
| `scribe.batch-policy` | catalog message (control plane) | `1.0.0` | `contracts/scribe-batch-policy.schema.json` |
| `ai.work-request` | catalog message (control plane) | `1.5.0` (new `protocol_version: "2.0.0"` `modelRequest` variant; existing `1.0.0` variants unchanged) | `contracts/ai-work-request.schema.json` |
| `ai.work-completed` | catalog message (control plane) | `1.5.0` (new `protocol_version: "2.0.0"` `modelResponse` variant; existing `1.0.0` variants unchanged) | `contracts/ai-work-completed.schema.json` |
| `scribe.batch-admitted` | catalog message (domain plane) | `1.0.0` | `contracts/scribe-batch-admitted.schema.json` |
| `scribe.batch-evaluated` | catalog message (domain plane) | `1.0.0` | `contracts/scribe-batch-evaluated-message.schema.json` |
| `scribe.recovery-request` | catalog message (control plane) | `1.0.0` | `contracts/scribe-recovery-request.schema.json` |
| `scribe.recovery-restored` | catalog message (control plane) | `1.0.0` | `contracts/scribe-recovery-restored.schema.json` |
| `scribe.checkpoint-persist` | catalog message (control plane) | `1.0.0` | `contracts/scribe-checkpoint-persist.schema.json` |
| `scribe.checkpoint-persisted` | catalog message (control plane) | `1.0.0` | `contracts/scribe-checkpoint-persisted.schema.json` |
| `scribe_batch_identity` | catalog artifact | schema `1.0.0` (no `schema_version` field; shape is the version) | `contracts/scribe-batch-identity.schema.json` |
| `scribe_batch_evaluated` | catalog artifact | schema `1.0.0` | `contracts/scribe-batch-evaluated.schema.json` |
| `scribe_checkpoint` | catalog artifact | `schema_version: "1.0.0"` | `contracts/scribe-checkpoint.schema.json` |
| `scribe_batch_journal_entry` | catalog artifact | schema `1.0.0` | `contracts/scribe-batch-journal-entry.schema.json` |

Catalog `schema_version` is `1.15.0`. Pure-function validators for the batch protocol
live in `contracts/model-protocol.mjs`: `SCRIBE_BATCH_PROTOCOL_VERSION` (`"2.0.0"`),
`EXTRACTION_BATCH_OUTPUT_LIMITS`, `validateScribeBatchModelRequest`,
`validateScribeBatchModelResponse`. These are additive exports; the existing 1.0.0-only
`validateModelRequest`/`validateModelResponse` used by
`services/log-extractor-local-http` and `services/serial-ai-model-lane` are untouched.

## Current ownership after SCRIBE-04B

- **Wiring**: no production graph wires exist yet for the Scribe coordinator channel. The
  coordinator and lifecycle owner now expose explicit recovery and checkpoint-persistence ports,
  but SCRIBE-05 still owns the graph wires and lifecycle orchestration that connect them.
- **Cross-message correlation**: `validateScribeBatchModelRequest` rejects a request
  whose `identity.session_id`/`identity.batch_request_id`/`instruction_version`
  conflicts with its own `batch_identity`, and requires `new_evidence_segments` to
  match `batch_identity.segments` exactly — same segment IDs, same order, same
  `revision` and `sequence` per position, not merely the same set. `validateScribeBatchModelResponse`
  rejects any item whose `source_segment_ids` cite a segment outside the response's own
  `batch_identity.segments` (fabricated provenance is now structurally impossible, not
  just well-formed). SCRIBE-04B implements the runtime comparison against the exact retained
  request fingerprint, nested result work ID, full response identity, and coordinator
  `batch_attempt`. A mismatch does not delete or replace retained work.
- **Idle timer and 8,000-token accounting**: `scribe.batch-policy` carries the
  governed defaults (`rows_per_batch: 3`, `idle_timeout_ms: 15000`,
  `max_total_context_tokens: 8000`). The coordinator implements the single idle timer and
  ordered recovery; extraction implements serialized request accounting and bounded rollover.
- **Durable file I/O**: `scribe_checkpoint` (versioned snapshot, atomic
  replace-by-rename per ADR-015's existing pattern) and `scribe_batch_journal_entry`
  (one NDJSON line per evaluated batch, append-only) are implemented by SCRIBE-03. The
  checkpoint shape carries `in_flight_batch` (`batch_identity`, `attempt`,
  `dispatched_at`) precisely so a crash between dispatch and evaluation has a governed
  place to recover the identical batch identity and coordinator attempt. Artifact `attempt`
  has the same coordinator meaning as transport `batch_attempt`, never provider attempt.
- **Assigning authoritative item identity**: proposed items in
  `ai.work-completed`'s `items[]` and in `scribe_batch_evaluated.items[]` cannot carry
  `item_id`/`revision` (rejected by `additionalProperties: false`). The model never
  assigns identity. The Argus extraction path derives deterministic revision-zero draft
  IDs from the validated batch and item position/content, matching the existing
  single-item boundary; `logged-items/active-owner` then accepts or rejects each draft
  and its `logged-item.stored` result confirms authority (ADR-001, ADR-002). Only those
  owner-confirmed IDs may enter `scribe_batch_evaluated.acknowledgement.logged_item_ids`.
  Extraction now assembles those IDs by exact deterministic draft identity and evaluated-item
  order. The coordinator requires the complete final acknowledgement before advancing, while
  persistence preserves that mapping without reconstructing or implicitly repairing it.

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
all six fields required, `additionalProperties: false`:

| Field | Meaning |
| --- | --- |
| `batch_attempt` | Positive coordinator batch attempt. It is immutable for an admitted batch and independent of provider retries. |
| `batch_identity` | `$ref argus.scribe-batch-identity.v1` — the immutable SCRIBE-01 identity, unchanged. Carries `request_id`, `session_id`, the ordered contiguous `segments`, `first_sequence`/`last_sequence`, `admission_reason`, `policy_id`/`policy_version`/`instruction_version`. |
| `new_evidence_segments` | The batch's new authoritative finalized rows (`segment_id`/`revision`/`sequence`/`start_time`/`end_time`/`text`). `minItems: 1`, `maxItems: 16`. Must match `batch_identity.segments` exactly: same ids, order, revisions, and sequences. Only these rows may trigger new Logged Items. |
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
  owns, derived from session + request + coordinator `batch_attempt`. The
  coordinator no longer mints a scheduler `work_id`.
- **`recovery.max_attempts`** — the model lane's governed provider retry budget. Every provider
  retry keeps the exact same `work_id`, model request, and request fingerprint.

`ai.work-completed.attempt` is provider-attempt telemetry only. It never fills the durable
artifact attempt. `scribe_batch_evaluated.attempt` and message `batch_attempt` both carry the
coordinator attempt from `scribe.batch-admitted`.

`policy_profile` and `instruction_version` are governance fields the coordinator legitimately
stamps, **not** authority: the extraction boundary must keep cross-checking them against the
retained `scribe.batch-policy` for the session (SCRIBE-04's `assertPolicyAgreement`) and fail
visibly on disagreement rather than prompting under a version the batch was not admitted under.

`tests/fixtures/contracts/scribe.batch-admitted/1.0.0/` retains `valid.json` (three-row
`batch-complete`), `valid-partial-idle-batch.json` (two-row `idle-timeout`, empty background),
`invalid-model-field.json`, `invalid-missing-background-context.json`,
`invalid-empty-new-evidence.json`, `invalid-forged-prior-item-id.json`, and
`invalid-evidence-revision.json`.

## `scribe.batch-evaluated` — extraction boundary -> coordinator

Payload has two required fields, `additionalProperties: false`:

| Field | Meaning |
| --- | --- |
| `batch_attempt` | Positive coordinator batch attempt copied from the admission. It must equal `batch.attempt`. |
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
`invalid-empty-evaluated-with-item.json`, `invalid-forged-session-id.json`, and
`invalid-batch-attempt-mismatch.json`.

## What remains downstream after SCRIBE-04B

- **Production graph wiring only.** The coordinator and extractor manifests now declare the
  mirror ports, but SCRIBE-05 still owns graph wires, policy injection, and checkpoint/journal
  orchestration.
- **No provider-specific domain transport.** `ai.work-request` and `ai.work-completed` remain
  solely between extraction and the serial model lane.
- **No automatic outer retry.** A terminal failed evaluated message stalls the exact coordinator
  batch with its cursor unchanged. A later recovery action may deliberately create a new
  coordinator `batch_attempt`; ordinary provider retry never does.
- **No existing shape changed.** `ai.work-request` and `ai.work-completed` stay at `1.5.0` with
  the `2.0.0` `modelRequest`/`modelResponse` variants exactly as SCRIBE-01 shipped them,
  `model` still required there because the model lane genuinely needs it.

---

# SCRIBE-04B reconciled runtime boundary

SCRIBE-04B imported the coordinator, persistence, extraction, and transport candidates onto one
fresh `origin/main` worktree, then reconciled their seams without adding production graph wires.
The following rules are the current implementation authority:

1. The coordinator owns eligibility, its acknowledged cursor, one immutable active batch, and
   the coordinator `batch_attempt`. Its output is provider-neutral `scribe.batch-admitted`.
2. Extraction consumes that admission plus its immutable per-session policy and local model
   configuration. It constructs one bounded stateless `ai.work-request` and retains the exact
   request, fingerprint, stable `queued_at`, and deterministic `work_id`.
3. The serial model lane owns provider retries. Within one coordinator attempt, every provider
   try uses the same work ID, request, prompt, and fingerprint. `ai.work-completed.attempt` is
   observability only. OpenAI-compatible calls carry `max_tokens` from the governed request
   `limits.max_output_tokens`.
4. Extraction rejects a forged nested completion work ID, fingerprint, response identity, policy,
   evidence revision, or sequence without deleting the retained batch. Invalid model output after
   valid correlation becomes one terminal failed evaluation.
5. Draft IDs and output message IDs are Argus-owned and deterministic. Extraction waits for the
   active Logged Item owner's exact `logged-item.stored` confirmation for every expected draft.
   Confirmations may arrive out of order, but final `logged_item_ids` remain in item order.
6. Zero-item evaluation is acknowledged immediately. Any owner rejection/storage failure becomes
   one failed evaluation. Extraction emits exactly one final `scribe.batch-evaluated` only after
   the batch is terminal.
7. The coordinator accepts only that final boundary with the exact identity and `batch_attempt`.
   Failure retains and stalls the exact batch with no automatic outer retry.
8. A configured coordinator service first emits `scribe.recovery-request` and rejects new evidence
   until `scribe.recovery-restored` supplies the authoritative checkpoint plus hydrated pending and
   in-flight transcript rows. A recovered in-flight batch is replayed with its exact identity and
   coordinator attempt; recovery requests are replay-stable within a process boot and fresh across
   coordinator restarts.
9. New admission is not published until `scribe.checkpoint-persisted` exactly acknowledges the
   `batch-admitted` checkpoint transition. A successful evaluation similarly emits
   `scribe.checkpoint-persist`; the lifecycle owner appends the evaluated-batch journal entry first,
   atomically replaces the checkpoint second, and only its exact acknowledgement lets the
   coordinator advance its cursor and publish settlement. Recovery reconciles an exact terminal
   journal entry against a stale in-flight checkpoint after an interrupted replacement, rebuilds
   the cursor/checkpoint idempotently, and fails closed on identity conflicts; it never re-invokes
   the model for an outcome already in the journal.
10. Close preserves active and forced one/two-row remainder work. The extractor retains policy,
    request, and owner-acknowledgement state through drain, emits terminal evaluation before
    `service.drained`, and reports a deadline failure instead of clearing unfinished work. A failed
    terminal evaluation visibly stalls coordinator Close and never produces `service.drained`.

Bounded state is explicit: coordinator sessions, pending evidence, remembered fingerprints,
background transcript/items, Close waiters, and single pending persistence transition all have ceilings; extraction has bounded pending
and settled replay retention plus bounded immutable policies. Session-storage journal append chains
are serialized inside one `SessionStorage` owner instance and are removed when the last queued
append settles, including failure.

Three directly required shared-runtime exceptions support these guarantees:

- `OrderedStreamGuard.seed` restores the next accepted transcript sequence after recovery.
- asynchronous drain settlement lets `service.drained` wait for a forced batch's final outcome.
- deterministic optional output message IDs let extraction correlate an owner rejection or storage
  failure to the exact draft without weakening the common service protocol.

SCRIBE-04B changes no production wiring, desktop host, provider-settings UI, Whisper/audio path,
or installer artifact. SCRIBE-05 remains the sole owner of production graph integration.
