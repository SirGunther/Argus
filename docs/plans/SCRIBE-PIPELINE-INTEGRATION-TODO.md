# Argus Scribe Pipeline Integration Work Breakdown

Status: planning and agent-dispatch artifact. This document does not itself authorize production changes or merging into `main`.

This plan divides the current Scribe work into isolated tickets with explicit dependencies and file ownership. Each `SCRIBE-*` section can be appended to [`ARGUS-ISOLATED-TICKET-HANDOFF.md`](ARGUS-ISOLATED-TICKET-HANDOFF.md) and assigned to one agent. The coordinating Codex agent reviews and merges completed branches between delivery waves.

## Integration outcome

Argus will run one session-level **Scribe** pipeline that evaluates new finalized transcript rows and creates zero, one, or multiple evidence-linked Logged Items through the existing provider-neutral model lane.

Transcript history is the durable backlog. A durable Scribe cursor records the last acknowledged finalized row. The coordinator admits three new rows immediately, admits a one- or two-row remainder after 15 seconds without a new finalized row, and admits any remainder when the session closes. Stop does not force submission because the session may resume.

Only one Scribe batch may be active. While the model lane is busy, new transcript rows remain in authoritative history. After a valid zero-item outcome or durable acknowledgement of every emitted Logged Item, the cursor advances and the coordinator immediately evaluates the next rows. A failure retains the identical batch and leaves the cursor unchanged.

Every LM Studio request is stateless. Argus reconstructs a bounded request containing the versioned Scribe instruction, bounded prior Scribe context for interpretation and duplicate suppression, and one-to-three new finalized rows. Only the new rows may trigger new Logged Items; older context is background evidence.

This work does not modify Whisper, introduce Assistant reasoning, grant Actor authority, add a message broker, or require Ollama.

## Source of truth

- Repository: `C:\Argus`
- Dispatch baseline: current `origin/main` at the start of each delivery wave
- Reusable agent framework: `docs/plans/ARGUS-ISOLATED-TICKET-HANDOFF.md`
- Operational roles: `Architecture/OperationalAgentRoles.md`
- Accepted batching/context decision: `Architecture/DesignDecisions.md` ADR-021
- Accepted role boundary: `Architecture/DesignDecisions.md` ADR-022
- Current implementation checklist: `TODO.md`, section 5C
- Open detailed decisions: `PENDING-DECISIONS.md`, `MOD-003` and `MOD-004`
- Current window selection: `services/transcript-window-selector/`
- Current model-backed extractor: `services/log-extractor-local-http/`
- Existing serial model lane: `services/serial-ai-model-lane/`
- Existing authoritative owners: `services/active-logged-item-owner/` and `services/permanent-logged-item-history/`
- Existing durable session boundary: `runtime/session-storage.mjs` and `runtime/session-lifecycle.mjs`
- Production composition: `wiring/production-electron.json`
- Relevant focused suites: `tests/phase5b-model-adapter.test.mjs`, `tests/phase6-session-storage.test.mjs`, `tests/contract-governance.test.mjs`, and the production graph/Electron integration suites

## Current behavior and exact gap

- `transcript-window-selector` is already an isolated service, but its pending windows and context history are in memory. It releases on pause, size, latency, topic, or drain rather than the accepted Scribe cursor/idle policy.
- The production policy already selects at most three source segments, but there is no durable Scribe acknowledgement cursor or batch journal.
- `log-extractor-local-http` retains at most 32 pending model requests in memory and emits exactly one `logged-item.draft` for each successful model response.
- `serial-ai-model-lane` already enforces bounded concurrency-one execution and supports LM Studio through the OpenAI-compatible provider setting. Its production service journal is currently in memory.
- The current extraction response contains one `text` field; it cannot represent a valid zero-item result or multiple Logged Items.
- Session storage already owns durable transcript and Logged Item state, but it does not yet own a Scribe checkpoint or append-only Scribe batch journal.
- The existing AI Provider interface already separates local and external providers. No new provider settings UI is required.

## Non-negotiable integration rules

Every ticket inherits these rules:

- Scribe is the only operational role in scope. Do not implement Assistant evaluation, recommendation, delegation, or Actor side effects.
- Do not change microphone capture, audio transport, Whisper inference, transcript partials, transcript finalization, or transcript correction behavior.
- Use only authoritative finalized transcript rows as new Scribe evidence.
- Transcript history is the backlog. Do not copy the full transcript into a second queue or repeatedly poll/rescan every row.
- Use one event-driven pump. Finalized rows, one idle timer, completion/failure, startup recovery, and Close may wake the same eligibility function.
- Admit exactly three new rows when available. Admit one or two after a 15,000 ms idle threshold. Close forces a remainder; Stop does not.
- Preserve one Scribe batch in flight. Busy is a visible waiting state, not an error and not permission to start concurrent model work.
- Advance the Scribe cursor only after a valid zero-item result or durable acknowledgement of every resulting Logged Item.
- Preserve an identical batch ID, exact segment IDs/revisions, prompt/policy version, and request fingerprint across retry. Never fabricate, skip, or silently drop work.
- Model calls are stateless. Argus owns and bounds the reconstructed rolling context to an approximately 8,000-token total model budget.
- Separate background context from new evidence. Background may disambiguate and prevent duplicates, but only new evidence may cause an item.
- Every item retains exact new-evidence source provenance. Any background context used must be separately identifiable and cannot be represented as the triggering source.
- A valid Scribe result may contain zero, one, or multiple items. Scribe does not generate a routine summary for every batch.
- Suggested item kinds remain non-authoritative. The active Logged Item owner remains the sole mutation authority.
- Reuse the existing serial AI scheduler, provider settings, LM Studio/OpenAI-compatible adapter, session storage boundary, and Logged Item owners.
- Add no broker, database, provider SDK, Ollama dependency, automatic model launcher, or second provider settings surface.
- Operational defaults may be configuration values. Architectural invariants—finalized evidence, concurrency one, acknowledgement ordering, provenance, boundedness, and lack of external authority—are not user-adjustable.
- Do not rebuild installers in these tickets.

## Recommended delivery order

```text
SCRIBE-01 ──┬──> SCRIBE-02 ┐
            ├──> SCRIBE-03 ├──> SCRIBE-05 ──> SCRIBE-06
            └──> SCRIBE-04 ┘
```

| Wave | Tickets | Parallel? | Purpose |
| --- | --- | --- | --- |
| 1 | SCRIBE-01 | No | Establish the shared governed contracts and compatibility boundary once. |
| 2 | SCRIBE-02, SCRIBE-03, SCRIBE-04 | Yes | Build coordinator, persistence, and model-output foundations in disjoint files. |
| 3 | SCRIBE-05 | No | Join all foundations in the production graph and desktop lifecycle. |
| 4 | SCRIBE-06 | No | Perform final regression, real-runtime acceptance, and canonical documentation closure. |

This is **six tickets across four delivery waves**. The maximum safe dispatch is **three agents simultaneously in Wave 2**. The coordinating agent must merge and push SCRIBE-01 before dispatching Wave 2. It must merge all three Wave 2 branches before dispatching SCRIBE-05.

## Agent dispatch and merge rules

For every ticket:

1. Copy the complete contents of `docs/plans/ARGUS-ISOLATED-TICKET-HANDOFF.md` into the agent prompt.
2. Append exactly one complete `SCRIBE-*` ticket below its final divider.
3. The agent starts a fresh worktree and branch from the then-current `origin/main`.
4. Do not run two tickets concurrently if their exclusive production ownership overlaps.
5. The implementation agent commits and pushes its branch but never merges `main`.
6. The coordinating agent reviews the exact commit, validates its ticket exit gate, merges it to `main`, pushes, and confirms the next wave's prerequisites.
7. Every later wave starts from the updated `origin/main`; agents do not stack unmerged branches themselves.
8. Every implementation agent must run `C:\dustin-thomason\scripts\notify-agent-complete.ps1` after pushing and before reporting completion, using a 5–9 word message containing `Codex`. If blocked and user input is required, the agent must send the notification before asking the question.
9. SCRIBE-02 through SCRIBE-05 must read `contracts/scribe-contract-handoff.md` from their starting `origin/main` and implement its runtime invariants without weakening or privately reinterpreting the governed shapes.

If a ticket discovers that another ticket must own a file, it must stop and report the collision. It must not broaden its scope or edit the shared file preemptively.

---

## SCRIBE-01 — Governed contract and policy foundation

**Depends on:** Nothing
**May run in parallel with:** Nothing
**Suggested branch slug:** `scribe-contract-foundation`
**Exclusive production ownership:** Scribe-related files under `contracts/`, their history, fixtures, generated reference, and focused contract tests
**Must not change:** Runtime, services, production wiring, Electron/UI, session files, or installer artifacts
**Checklist in chat:** Mandatory. Display a ticket-derived checklist in the agent chat before implementation, update it as work progresses, and leave no required item unchecked before notification or completion reporting.

### Goal

Establish the versioned public boundary that SCRIBE-02 through SCRIBE-05 will implement. Define the accepted policy, stateless request, zero-to-many result, acknowledgement, and durable state shapes without implementing production behavior.

### Build checklist

- [ ] Define one governed Scribe policy shape with defaults of three rows, 15,000 ms idle, and an approximately 8,000-token total context budget, while keeping architectural invariants outside user-adjustable configuration.
- [ ] Represent a stable Scribe batch identity with session ID, ordered finalized segment IDs/revisions, first/last sequence, admission reason, policy/instruction version, and immutable request identity.
- [ ] Separate new authoritative evidence from bounded background Scribe context in the model-request contract.
- [ ] Define a logged-item extraction response containing an `items` array that validly represents zero, one, or multiple bounded items.
- [ ] Give each proposed item bounded text, optional non-authoritative kind metadata, and exact new-evidence source identifiers; reject provider-forged authoritative item IDs or revisions.
- [ ] Define one explicit evaluated-batch outcome capable of representing zero items, the complete expected item set, failure/retry metadata, and final acknowledgement.
- [ ] Define the versioned Scribe checkpoint and append-only batch-journal artifact shapes required by SCRIBE-03.
- [ ] Preserve compatibility where semantics remain compatible; perform explicit version changes where the old single-text response cannot safely represent the new shape.
- [ ] Update contract catalog versions, payload ceilings, changelogs, fixtures, invariant validation, and generated documentation.
- [ ] Record prompt/instruction profile identity without embedding provider-specific LM Studio behavior in a domain contract.

### Exit gate

- [ ] Valid fixtures cover three-row and partial batches, zero/one/multiple items, background-versus-source separation, checkpoint state, and evaluated outcomes.
- [ ] Invalid fixtures cover oversized/unbounded output, duplicate segment IDs, reordered/gapped evidence, forged item authority, background represented as source, and malformed acknowledgement sets.
- [ ] Compatibility replay, contract governance, generated documentation, syntax, and diff checks pass.
- [ ] A concise contract handoff lists the exact message/artifact versions Wave 2 must consume.
- [ ] No runtime, service, graph, UI, or storage implementation changed.

### Out of scope

Coordinator behavior, timers, durable file I/O, model prompting, LM Studio calls, graph wiring, UI status, and session acceptance.

---

## SCRIBE-02 — Standalone Scribe coordinator and eligibility policy

**Depends on:** SCRIBE-01 merged into `origin/main`
**May run in parallel with:** SCRIBE-03 and SCRIBE-04
**Suggested branch slug:** `scribe-coordinator`
**Exclusive production ownership:** New `services/scribe-coordinator/` files and new focused coordinator tests
**Must not change:** Existing contract definitions, runtime/session storage, model/extractor services, production wiring, Electron/UI, or installer artifacts
**Checklist in chat:** Mandatory. Display a ticket-derived checklist in the agent chat before implementation, update it as work progresses, and leave no required item unchecked before notification or completion reporting.

### Goal

Create the independently runnable Scribe coordinator that owns the cursor-driven admission state machine and one pure eligibility policy. It must not perform storage or model HTTP calls directly.

### Build checklist

- [ ] Add a service manifest with only the accepted/emitted domain and control contracts from SCRIBE-01, lifecycle ports, explicit state, no undeclared permissions, and no provider knowledge.
- [ ] Put the pure eligibility decision in its own module inside the service boundary rather than in the desktop host or graph runtime.
- [ ] Implement one event-driven pump woken by finalized evidence, the single idle deadline, work outcome/acknowledgement, recovery state, and Close.
- [ ] Make the eligibility rule return no work while a batch is active; select three rows immediately; select one or two only after 15,000 ms idle or Close.
- [ ] Cancel/reset the one idle timer when a third row arrives and avoid polling loops, repeated scans, or multiple concurrent timers.
- [ ] Preserve ordered, duplicate-safe finalized segment admission and stable batch identity.
- [ ] Correlate every result against the exact in-flight `work_id`, request fingerprint, attempt, and complete batch identity; reject stale, superseded, reordered, or conflicting results without mutating the cursor.
- [ ] Keep the cursor unchanged until the complete governed acknowledgement arrives, including a valid zero-item acknowledgement.
- [ ] Accept an `items-recorded` acknowledgement only when its unique, ordered `logged_item_ids` correspond one-for-one with the complete evaluated `items[]`; require an empty ID list for zero-item, failed, or rejected outcomes.
- [ ] Retain identical pending/retry state after failure and reject conflicting recovery or acknowledgement content.
- [ ] Immediately pump again after acknowledgement so accumulated three-row groups do not wait for the partial-batch threshold.
- [ ] Drain deterministically: Stop preserves pending state; Close releases one final remainder and waits for its governed terminal outcome.

### Exit gate

- [ ] Focused tests cover zero rows, one/two rows before and after idle, exactly three, six-plus accumulating while busy, timer reset, busy completion, zero/multiple acknowledgement, failure/retry, duplicate delivery, restart state, Stop, Close, and drain.
- [ ] Tests use an injected/fake clock only inside the test boundary; production behavior remains real and event driven.
- [ ] Service contract, health, operation completion/rejection, syntax, and diff checks pass.
- [ ] No existing production service or graph has been modified.

### Out of scope

Filesystem persistence, contract redesign, model prompts, provider calls, Logged Item mutation, production wiring, and UI changes.

---

## SCRIBE-03 — Durable Scribe checkpoint and batch journal

**Depends on:** SCRIBE-01 merged into `origin/main`
**May run in parallel with:** SCRIBE-02 and SCRIBE-04
**Suggested branch slug:** `scribe-session-persistence`
**Exclusive production ownership:** `runtime/session-storage.mjs`, directly required session-lifecycle/recovery helpers, and focused Phase 6 storage/recovery tests
**Must not change:** Contracts established by SCRIBE-01, Scribe coordinator files, model/extractor services, production graph, Electron/UI, or installer artifacts
**Checklist in chat:** Mandatory. Display a ticket-derived checklist in the agent chat before implementation, update it as work progresses, and leave no required item unchecked before notification or completion reporting.

### Goal

Extend the existing session-storage authority with a compact active Scribe checkpoint and append-only batch journal. Do not create a database or a second copy of transcript history.

### Build checklist

- [ ] Add root-contained session paths for an atomic active Scribe checkpoint and append-only permanent Scribe batch journal.
- [ ] Persist only governed Scribe state: acknowledged cursor, exact pending/in-flight batch references, idle/retry metadata, policy/instruction identity, outcome, and resulting Logged Item IDs.
- [ ] Preserve the evaluated-item-to-`logged_item_ids` positional mapping exactly and reject count, order, identity, fingerprint, or replay conflicts rather than repairing them implicitly.
- [ ] Keep transcript text in authoritative transcript storage; do not duplicate an unbounded transcript or model conversation in the journal.
- [ ] Make checkpoint writes atomic and journal appends idempotent by stable batch/outcome identity.
- [ ] Detect conflicting fingerprints, malformed state, another session's data, path escape, symlink substitution, partial writes, and invalid acknowledgement/cursor advancement.
- [ ] Include Scribe state in session creation, recovery backups, close integrity checks, and deterministic startup recovery.
- [ ] Preserve a valid pending batch across crash/restart and make completed batches replay-safe without duplicating Logged Item history.
- [ ] Keep Stop resumable and make Close refuse to seal an unacknowledged Scribe gap rather than silently skipping it.
- [ ] Bound active state and journal records; do not persist credentials, audio, unrestricted transcript text, or provider diagnostics.

### Exit gate

- [ ] Focused tests cover initial state, atomic replacement, append/idempotent replay, conflict, corrupt files, path containment, pending recovery, zero-item outcome, multiple-item acknowledgement, Stop/Resume, Close gap refusal, backup, and repeated recovery.
- [ ] Existing transcript and Logged Item storage/recovery tests remain green.
- [ ] Syntax, storage schema validation, diff, and directly relevant contract checks pass.
- [ ] No coordinator, model, graph, or UI file has changed.

### Out of scope

Eligibility logic, model context construction, LM Studio communication, graph wiring, visual status, database adoption, and installer work.

---

## SCRIBE-04 — Stateless Scribe prompt, bounded context, and zero-to-many extraction

**Depends on:** SCRIBE-01 merged into `origin/main`
**May run in parallel with:** SCRIBE-02 and SCRIBE-03
**Suggested branch slug:** `scribe-model-extraction`
**Exclusive production ownership:** `services/log-extractor-local-http/`, Scribe-related prompt/instruction files, the extraction path in `services/serial-ai-model-lane/`, and focused model-adapter/provider tests
**Must not change:** Contracts established by SCRIBE-01, coordinator, runtime/session storage, production wiring, provider settings UI, Whisper, or installer artifacts
**Checklist in chat:** Mandatory. Display a ticket-derived checklist in the agent chat before implementation, update it as work progresses, and leave no required item unchecked before notification or completion reporting.

### Goal

Implement the provider-neutral Scribe request and response behavior against LM Studio/OpenAI-compatible calls while preserving the existing serial model boundary and optional Ollama compatibility.

### Build checklist

- [ ] Replace the generic single-text extraction instruction with a versioned Scribe instruction derived from `Architecture/OperationalAgentRoles.md`.
- [ ] Construct every call statelessly from new evidence plus bounded prior Scribe context; do not assume LM Studio retains earlier requests.
- [ ] Mark background and new evidence distinctly and explicitly instruct the model that only new evidence may create Logged Items.
- [ ] Instruct the model to suppress already-recorded information, allow a valid empty array, allow multiple discrete items, and avoid routine per-batch summaries.
- [ ] Enforce the approximately 8,000-token total budget by counting/reserving instruction, schema, new evidence, background context, and bounded output; never truncate new evidence silently.
- [ ] Remove oldest complete background turns/items first when bounded context must roll; fail explicitly if required instruction, schema, new evidence, and output reserve cannot fit.
- [ ] Validate strict JSON-only zero-to-many output and reject commentary, malformed JSON, excessive items/text, forged identity/provenance, and unsupported kind metadata.
- [ ] Require the response's complete batch identity to match the exact request before producing any draft; reject stale or provider-altered batch identity and provenance.
- [ ] Derive stable Argus-owned draft item IDs deterministically from the validated batch and item position/content; the model never supplies authority fields, and the active owner remains responsible for accepting or rejecting each draft.
- [ ] Emit one governed draft per validated item plus the complete evaluated-batch outcome required for zero/multiple acknowledgement.
- [ ] Retain exact request fingerprints and context across retry and preserve the existing provider configuration, credential redaction, timeout, and explicit failure behavior.
- [ ] Keep model work FIFO/concurrency-one through the existing scheduler and make no Ollama installation or launch a prerequisite.

### Exit gate

- [ ] Focused tests cover LM Studio/OpenAI-compatible zero, one, and multiple outputs; duplicate suppression context; background/new-evidence separation; token rollover; oversized mandatory input; malformed output; timeout; retry fingerprint; stable IDs; and no routine summary.
- [ ] Existing provider save/test behavior, external credential redaction, classification isolation, and scheduler ordering remain green.
- [ ] Syntax, focused contracts, and diff checks pass.
- [ ] No coordinator, storage, wiring, provider UI, or Whisper file has changed.

### Out of scope

Eligibility/timing, persistence, graph integration, provider-settings redesign, Assistant/Actor behavior, model management, and installer work.

---

## SCRIBE-05 — Production wiring, lifecycle, and visible status integration

**Depends on:** SCRIBE-02, SCRIBE-03, and SCRIBE-04 merged into `origin/main`
**May run in parallel with:** Nothing
**Suggested branch slug:** `scribe-production-integration`
**Exclusive production ownership:** `wiring/production-electron.json`, directly affected production/demo graph files, `runtime/desktop-application.mjs`, the production Scribe policy source/configuration, and focused cross-component integration tests
**Must not change:** Contract semantics from SCRIBE-01, core coordinator/model/storage implementations except for a reported prerequisite defect, provider settings UI, Whisper/audio, unrelated UI layout, or installer artifacts
**Checklist in chat:** Mandatory. Display a ticket-derived checklist in the agent chat before implementation, update it as work progresses, and leave no required item unchecked before notification or completion reporting.

### Goal

Replace the production window-selector-only extraction path with the complete Scribe coordinator flow and connect its durable state, existing scheduler, model adapter, owners, lifecycle, and truthful status.

### Build checklist

- [ ] Add the Scribe coordinator manifest to the production graph and wire every input/output explicitly; do not add hidden host callbacks or sibling imports.
- [ ] Route authoritative finalized transcript rows to Scribe while preserving their existing projection and permanent-history paths.
- [ ] Route bounded Scribe batches to the existing model-backed extractor and route evaluated outcomes and Logged Item acknowledgements back to the coordinator.
- [ ] Connect checkpoint/journal persistence and restore governed state before admitting new work after startup.
- [ ] Configure defaults of three rows, 15,000 ms partial idle, and approximately 8,000 total model tokens without coupling policy to LM Studio.
- [ ] Preserve the existing serial model lane and provider configuration; do not create a second scheduler or provider connection.
- [ ] Keep recording, Whisper, and transcript finalization independent of Scribe backlog or model latency.
- [ ] Surface bounded Scribe states through the existing status boundary: caught up, pending rows, queued/busy, processing, delayed/retrying, unavailable, and terminal failure.
- [ ] Prove three-row groups accumulated during busy work run immediately after acknowledgement while a final one/two-row group waits only for idle or Close.
- [ ] Make Stop leave Scribe resumable; make Close release the remainder, wait for terminal acknowledgement, and fail visibly rather than lose work.
- [ ] Ensure a valid zero-item batch produces no blank Logged Item while still advancing the durable cursor.
- [ ] Ensure multiple items arrive exactly once through the active owner and append-only history with source navigation intact.
- [ ] Assemble the accepted batch acknowledgement only from actual `logged-item.stored` confirmations, preserving the evaluated item order and exact one-to-one `logged_item_ids` mapping before allowing cursor advancement or persistence.
- [ ] Remove or bypass the obsolete production-only selection path without deleting reusable Phase 4 replacement proofs or unrelated demos.

### Exit gate

- [ ] A focused integrated session proves 3 + 3 + 1 finalized rows, model-lane delay, 15-second partial admission, zero/multiple results, exact ordering, stable provenance, and no loss/duplication.
- [ ] Recovery proves a crash before model completion, after model completion but before item acknowledgement, and after item acknowledgement but before cursor persistence.
- [ ] Production graph validation, package generation/integrity, contract governance/docs, focused Electron integration, syntax, and diff checks pass.
- [ ] The source Electron app launches against the configured real provider without simulation; physical microphone/content-quality acceptance may remain for SCRIBE-06/user review.
- [ ] AI Provider settings still select and test LM Studio without requiring Ollama.

### Out of scope

Prompt/schema redesign, broad UI redesign, new settings tabs, Whisper changes, Assistant/Actor roles, new storage technology, and installer rebuild.

---

## SCRIBE-06 — Regression, documentation, and real-runtime acceptance gate

**Depends on:** SCRIBE-05 merged into `origin/main`
**May run in parallel with:** Nothing
**Suggested branch slug:** `scribe-acceptance`
**Exclusive production ownership:** No production files unless acceptance exposes a defect and the coordinator approves an ownership revision; canonical Scribe evidence, README/TODO/pending-decision status, and new acceptance-only tests
**Must not change:** Accepted behavior merely to make a test pass, unrelated application features, Whisper/audio, Assistant/Actor scope, or installer artifacts
**Checklist in chat:** Mandatory. Display a ticket-derived checklist in the agent chat before implementation, update it as work progresses, and leave no required item unchecked before notification or completion reporting.

### Goal

Verify the complete real Scribe path, close the implementation documentation, and leave a precise user-validation checklist. This is the only ticket authorized to mark the Scribe work breakdown complete.

### Build checklist

- [ ] Review all five merged ticket commits against this integration-wide definition of complete and report any scope or contract drift before editing.
- [ ] Run the complete Argus test suite, contract governance, generated contract documentation check, production graph validation, package graph generation/verification, syntax checks, and diff checks once from the joined baseline.
- [ ] Launch the real source Electron application with LM Studio selected; do not simulate microphone, model, queue, or Logged Item behavior.
- [ ] Record exact user actions and expected results for three-row admission, partial idle admission, busy catch-up, zero output, multiple output, retry/failure visibility, Stop/Resume, Close, and restart recovery.
- [ ] Confirm long-running transcription remains responsive while Scribe is delayed and that Scribe cannot block or mutate Whisper/transcript behavior.
- [ ] Confirm background context influences interpretation without independently recreating old Logged Items and that every new item navigates to its triggering source rows.
- [ ] Confirm secrets, transcript text, model context, and audio are absent from ordinary diagnostics beyond existing governed/redacted behavior.
- [ ] Update `Architecture/DesignDecisions.md`, `Architecture/OperationalAgentRoles.md`, `PENDING-DECISIONS.md`, `TODO.md`, `README.md`, and a focused Scribe evidence artifact with actual implemented versions and remaining evidence only.
- [ ] Mark `MOD-003` and `MOD-004` resolved only if their exact context and response behavior is implemented and evidenced; otherwise leave a precise unresolved trigger.
- [ ] Do not rebuild the installer. Record installer acceptance as separate only if explicitly requested later.

### Exit gate

- [ ] All automated gates pass from the merged production baseline.
- [ ] Real LM Studio source launch succeeds and its model receives the bounded Scribe request shape.
- [ ] The user-validation artifact gives actionable action/result steps and identifies any physical-microphone or model-quality acceptance still pending.
- [ ] No unresolved cursor gap, unacknowledged batch, duplicate Logged Item, silent failure, or unintended Assistant/Actor behavior remains in the accepted scenarios.
- [ ] Canonical documents agree on what is implemented, deferred, and still awaiting user evidence.

### Out of scope

New product behavior, optimization beyond measured need, installer rebuild, packaged release, Whisper tuning, prompt-management UI, Assistant implementation, and Actor integrations.

---

## Integration-wide definition of complete

The Scribe integration is complete only when all six ticket exit gates pass and all of the following remain true:

- Finalized transcript history is the only durable evidence backlog; no duplicate transcript queue exists.
- One durable cursor and one active batch describe Scribe progress for each session.
- Three new rows run immediately; one or two run after 15 seconds idle or on Close; Stop remains resumable.
- Busy model work causes bounded waiting, not concurrent requests, repeated polling, skipped rows, or transcript backpressure.
- Cursor advancement is acknowledgement-driven and crash-safe for zero, one, and multiple Logged Items.
- LM Studio requests are stateless, bounded to the governed approximately 8,000-token total, and reconstructed by Argus.
- Background context supports interpretation and duplicate suppression; only new evidence triggers Logged Items.
- Every item is discrete, meaningful, non-duplicate, bounded, and linked to exact source transcript rows.
- Scribe may return no item and does not generate a routine summary for every batch.
- Provider settings remain provider neutral; LM Studio works without making Ollama a prerequisite.
- Whisper, transcript ownership, Logged Item ownership/history, service isolation, explicit wires, and recovery rules remain intact.
- Assistant and Actor remain documented future roles with no current runtime, model, tool, permission, or side effect.

## Next dispatch

Assign **SCRIBE-01 only** using `docs/plans/ARGUS-ISOLATED-TICKET-HANDOFF.md`. After its branch is reviewed, merged, and pushed to `origin/main`, assign **SCRIBE-02, SCRIBE-03, and SCRIBE-04 simultaneously**. Do not dispatch SCRIBE-05 until all three Wave 2 branches are reviewed and merged.
