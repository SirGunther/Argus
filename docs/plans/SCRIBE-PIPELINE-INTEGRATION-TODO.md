# Argus Scribe Pipeline Integration Work Breakdown

Status: planning and agent-dispatch artifact. This document does not itself authorize production changes or merging into `main`.

This plan divides the current Scribe work into isolated tickets with explicit dependencies and file ownership. Each `SCRIBE-*` section can be appended to [`ARGUS-ISOLATED-TICKET-HANDOFF.md`](ARGUS-ISOLATED-TICKET-HANDOFF.md) and assigned to one agent. The coordinating Codex agent reviews and merges completed branches between delivery waves.

## Integration outcome

Argus will run one session-level **Scribe** pipeline that evaluates new finalized transcript rows and creates zero, one, or multiple evidence-linked Logged Items through the existing provider-neutral model lane.

Transcript history is the durable backlog. A durable Scribe cursor records the last acknowledged finalized row. The coordinator admits three new rows immediately, admits a one- or two-row remainder after 15 seconds without a new finalized row, and admits any remainder when the session closes. Stop does not force submission because the session may resume.

Only one Scribe batch may be active. While the model lane is busy, new transcript rows remain in authoritative history. After a valid zero-item outcome or durable acknowledgement of every emitted Logged Item, the cursor advances and the coordinator immediately evaluates the next rows. A failure retains the identical batch and leaves the cursor unchanged.

Every LM Studio request is stateless. Argus reconstructs a bounded request containing the protected versioned Scribe instruction, optional bounded user guidance, bounded prior Scribe context for interpretation and duplicate suppression, and one-to-three new finalized rows. Only the new rows may trigger new Logged Items; older context is background evidence.

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

## Current behavior and exact remaining gaps

- SCRIBE-05 is merged. The production graph now has durable Scribe checkpoints/journals, one-at-a-time batch admission, stateless bounded requests, zero-to-many results, exact owner acknowledgement, restart recovery, and the Close flush handshake.
- A real LM Studio run exposed a transport defect that fast automated endpoints did not: `ai.work-request` holds its service receipt until model inference completes while the graph's default operation deadline is 15,000 ms.
- In session `session-4c87d452-f960-41b8-8b00-5818f8e9e435`, LM Studio received the first batch at 09:28:24 and completed it in 14,665.58 ms. Argus overhead crossed the 15-second wire deadline, leaving later work unable to use that wire.
- The first batch correctly produced `items: []`. Argus durably admitted the next one-row idle batch at 09:28:50, but LM Studio recorded no second POST; the checkpoint remained in flight at segment 3 while authoritative transcript history continued through segment 9 and the Logged Item snapshot stayed empty.
- This is not prompt judgment, an idle-policy outcome, or a Logged Items rendering problem. Queue admission and long-running inference completion are incorrectly represented by one synchronous receipt.
- The existing Scribe instruction is protected and versioned, but users have no bounded place to state what Scribe should prioritize or a clear surface explaining that zero, one, or multiple evidence-linked items may be returned.
- The AI Provider interface already separates local and external connectivity. Scribe guidance must remain separate from provider credentials and endpoint configuration while reusing that existing settings area.

## Non-negotiable integration rules

Every ticket inherits these rules:

- Scribe is the only operational role in scope. Do not implement Assistant evaluation, recommendation, delegation, or Actor side effects.
- Do not change microphone capture, audio transport, Whisper inference, transcript partials, transcript finalization, or transcript correction behavior.
- Use only authoritative finalized transcript rows as new Scribe evidence.
- Transcript history is the backlog. Do not copy the full transcript into a second queue or repeatedly poll/rescan every row.
- Use one event-driven pump. Finalized rows, one idle timer, completion/failure, startup recovery, and Close may wake the same eligibility function.
- Admit exactly three new rows when available. Admit one or two after a 15,000 ms idle threshold. Close forces a remainder; Stop does not.
- Preserve one Scribe batch in flight. Busy is a visible waiting state, not an error and not permission to start concurrent model work.
- Treat `ai.work-request` delivery as bounded queue admission, not as the duration of model inference. A service receipt must complete promptly after accepted admission; the terminal `ai.work-completed` message remains the separate result boundary.
- Advance the Scribe cursor only after a valid zero-item result or durable acknowledgement of every resulting Logged Item.
- Preserve an identical batch ID, exact segment IDs/revisions, prompt/policy version, work ID, and request fingerprint across provider retries within one coordinator `batch_attempt`. Never fabricate, skip, or silently drop work.
- Model calls are stateless. Argus owns and bounds the reconstructed rolling context to an approximately 8,000-token total model budget.
- User Scribe guidance is optional, bounded, included in the approximately 8,000-token accounting, immutable for the session that snapshots it, and carried in retry/recovery identity. It may refine retention priorities but may not replace the protected instruction, response schema, provenance rules, role boundary, or ownership authority.
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
SCRIBE-01 ──┬──> SCRIBE-02 ─┐
            ├──> SCRIBE-03 ─┼──> SCRIBE-04B ──> SCRIBE-05 ──> SCRIBE-05A ──> SCRIBE-05B ──> SCRIBE-06
            ├──> SCRIBE-04 ─┤
            └──> SCRIBE-04A ┘
```

| Wave | Tickets | Parallel? | Purpose |
| --- | --- | --- | --- |
| 1 | SCRIBE-01 | No | Establish the shared governed contracts and compatibility boundary once. |
| 2A | SCRIBE-02, SCRIBE-03, SCRIBE-04, SCRIBE-04A | Previously parallel | Preserve the completed branch implementations as reconciliation inputs; do not merge them independently. |
| 2B | SCRIBE-04B | No | Reconcile the four Wave 2 candidates into one internally consistent contract and implementation baseline. |
| 3 | SCRIBE-05 | No | Join the reconciled foundation in the production graph and desktop lifecycle. |
| 4A | SCRIBE-05A | No | Decouple model queue admission from long-running inference and expose truthful Scribe progress. |
| 4B | SCRIBE-05B | No | Add bounded, session-stable Scribe guidance and explain expected output. |
| 5 | SCRIBE-06 | No | Perform final regression, real-runtime acceptance, and canonical documentation closure. |

This is now **ten ticket identifiers across five delivery waves**, including the corrective SCRIBE-04A contract seam, SCRIBE-04B reconciliation, SCRIBE-05A runtime correction, and SCRIBE-05B guidance surface. SCRIBE-05A and SCRIBE-05B are sequential because both touch the model-request boundary. Merge and review each before starting the next ticket.

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
9. SCRIBE-02 through SCRIBE-05B must read `contracts/scribe-contract-handoff.md` from their starting `origin/main` and implement its runtime invariants without weakening or privately reinterpreting the governed shapes.

If a ticket discovers that another ticket must own a file, it must stop and report the collision. It must not broaden its scope or edit the shared file preemptively.

## Model-tiered ticket orchestration rule

When writing or executing a ticket, partition the workflow by reasoning requirement rather than assigning one model tier to the entire ticket.

Use lower-cost models for bounded, procedural, and validation-oriented work. Use stronger models for complex implementation, ambiguity, architectural judgment, difficult debugging, and other reasoning-intensive work.

At each model boundary:

1. Send the configured push notification.
2. Pause.
3. Resume from this ticket when the user continues the session after changing models.

This ticket is the source of truth. No separate handoff artifact or agent-to-agent communication is required.

**Pattern:** lower-tier work -> pause -> high-reasoning work -> pause -> lower-tier work.

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

- [x] Define one governed Scribe policy shape with defaults of three rows, 15,000 ms idle, and an approximately 8,000-token total context budget, while keeping architectural invariants outside user-adjustable configuration.
- [x] Represent a stable Scribe batch identity with session ID, ordered finalized segment IDs/revisions, first/last sequence, admission reason, policy/instruction version, and immutable request identity.
- [x] Separate new authoritative evidence from bounded background Scribe context in the model-request contract.
- [x] Define a logged-item extraction response containing an `items` array that validly represents zero, one, or multiple bounded items.
- [x] Give each proposed item bounded text, optional non-authoritative kind metadata, and exact new-evidence source identifiers; reject provider-forged authoritative item IDs or revisions.
- [x] Define one explicit evaluated-batch outcome capable of representing zero items, the complete expected item set, failure/retry metadata, and final acknowledgement.
- [x] Define the versioned Scribe checkpoint and append-only batch-journal artifact shapes required by SCRIBE-03.
- [x] Preserve compatibility where semantics remain compatible; perform explicit version changes where the old single-text response cannot safely represent the new shape.
- [x] Update contract catalog versions, payload ceilings, changelogs, fixtures, invariant validation, and generated documentation.
- [x] Record prompt/instruction profile identity without embedding provider-specific LM Studio behavior in a domain contract.

### Exit gate

- [x] Valid fixtures cover three-row and partial batches, zero/one/multiple items, background-versus-source separation, checkpoint state, and evaluated outcomes.
- [x] Invalid fixtures cover oversized/unbounded output, duplicate segment IDs, reordered/gapped evidence, forged item authority, background represented as source, and malformed acknowledgement sets.
- [x] Compatibility replay, contract governance, generated documentation, syntax, and diff checks pass.
- [x] A concise contract handoff lists the exact message/artifact versions Wave 2 must consume.
- [x] No runtime, service, graph, UI, or storage implementation changed.

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

- [x] Add a service manifest with only the accepted/emitted domain and control contracts from SCRIBE-01, lifecycle ports, explicit state, no undeclared permissions, and no provider knowledge.
- [x] Put the pure eligibility decision in its own module inside the service boundary rather than in the desktop host or graph runtime.
- [x] Implement one event-driven pump woken by finalized evidence, the single idle deadline, final `scribe.batch-evaluated`, recovery state, and Close.
- [x] Make the eligibility rule return no work while a batch is active; select three rows immediately; select one or two only after 15,000 ms idle or Close.
- [x] Cancel/reset the one idle timer when a third row arrives and avoid polling loops, repeated scans, or multiple concurrent timers.
- [x] Preserve ordered, duplicate-safe finalized segment admission and stable batch identity.
- [x] Correlate every final evaluation against the exact in-flight complete batch identity and coordinator `batch_attempt`; the coordinator owns no model work ID or request fingerprint.
- [x] Keep the cursor unchanged until the complete governed acknowledgement arrives, including a valid zero-item acknowledgement.
- [x] Accept an `items-recorded` acknowledgement only when its unique, ordered `logged_item_ids` correspond one-for-one with the complete evaluated `items[]`; require an empty ID list for zero-item, failed, or rejected outcomes.
- [x] Retain the exact active batch in a visible stalled state after terminal failure, with no automatic outer retry, and reject conflicting recovery or acknowledgement content.
- [x] Immediately pump again after acknowledgement so accumulated three-row groups do not wait for the partial-batch threshold.
- [x] Drain deterministically: Stop preserves pending state; Close releases one final remainder and waits for its governed terminal outcome.

### Exit gate

- [x] Focused tests cover zero rows, one/two rows before and after idle, exactly three, six-plus accumulating while busy, timer reset, busy completion, zero/multiple acknowledgement, terminal failure/stall without outer retry, duplicate delivery, restart state, Stop, Close, and drain.
- [x] Tests use an injected/fake clock only inside the test boundary; production behavior remains real and event driven.
- [x] Service contract, health, operation completion/rejection, syntax, and diff checks pass.
- [x] No existing production service or graph has been modified.

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

- [x] Add root-contained session paths for an atomic active Scribe checkpoint and append-only permanent Scribe batch journal.
- [x] Persist only governed Scribe state: acknowledged cursor, exact pending/in-flight batch references, idle/retry metadata, policy/instruction identity, outcome, and resulting Logged Item IDs.
- [x] Preserve the evaluated-item-to-`logged_item_ids` positional mapping exactly and reject count, order, identity, fingerprint, or replay conflicts rather than repairing them implicitly.
- [x] Keep transcript text in authoritative transcript storage; do not duplicate an unbounded transcript or model conversation in the journal.
- [x] Make checkpoint writes atomic and journal appends idempotent by stable batch/outcome identity.
- [x] Detect conflicting fingerprints, malformed state, another session's data, path escape, symlink substitution, partial writes, and invalid acknowledgement/cursor advancement.
- [x] Include Scribe state in session creation, recovery backups, close integrity checks, and deterministic startup recovery.
- [x] Preserve a valid pending batch across crash/restart and make completed batches replay-safe without duplicating Logged Item history.
- [x] Keep Stop resumable and make Close refuse to seal an unacknowledged Scribe gap rather than silently skipping it.
- [x] Bound active state and journal records; do not persist credentials, audio, unrestricted transcript text, or provider diagnostics.

### Exit gate

- [x] Focused tests cover initial state, atomic replacement, append/idempotent replay, conflict, corrupt files, path containment, pending recovery, zero-item outcome, multiple-item acknowledgement, Stop/Resume, Close gap refusal, backup, and repeated recovery.
- [x] Existing transcript and Logged Item storage/recovery tests remain green.
- [x] Syntax, storage schema validation, diff, and directly relevant contract checks pass.
- [x] No coordinator, model, graph, or UI file has changed.

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

- [x] Replace the generic single-text extraction instruction with a versioned Scribe instruction derived from `Architecture/OperationalAgentRoles.md`.
- [x] Construct every call statelessly from new evidence plus bounded prior Scribe context; do not assume LM Studio retains earlier requests.
- [x] Mark background and new evidence distinctly and explicitly instruct the model that only new evidence may create Logged Items.
- [x] Instruct the model to suppress already-recorded information, allow a valid empty array, allow multiple discrete items, and avoid routine per-batch summaries.
- [x] Enforce the approximately 8,000-token total budget by counting/reserving instruction, schema, new evidence, background context, and bounded output; never truncate new evidence silently.
- [x] Remove oldest complete background turns/items first when bounded context must roll; fail explicitly if required instruction, schema, new evidence, and output reserve cannot fit.
- [x] Validate strict JSON-only zero-to-many output and reject commentary, malformed JSON, excessive items/text, forged identity/provenance, and unsupported kind metadata.
- [x] Require the response's complete batch identity to match the exact request before producing any draft; reject stale or provider-altered batch identity and provenance.
- [x] Derive stable Argus-owned draft item IDs deterministically from the validated batch and item position/content; the model never supplies authority fields, and the active owner remains responsible for accepting or rejecting each draft.
- [x] Emit one governed draft per validated item, wait for exact authoritative stored confirmations, then emit one final evaluated-batch outcome; emit a valid zero-item outcome immediately.
- [x] Retain exact request fingerprints and context across retry and preserve the existing provider configuration, credential redaction, timeout, and explicit failure behavior.
- [x] Keep model work FIFO/concurrency-one through the existing scheduler and make no Ollama installation or launch a prerequisite.

### Exit gate

- [x] Focused tests cover LM Studio/OpenAI-compatible zero, one, and multiple outputs; duplicate suppression context; background/new-evidence separation; token rollover; oversized mandatory input; malformed output; timeout; retry fingerprint; stable IDs; and no routine summary.
- [x] Existing provider save/test behavior, external credential redaction, classification isolation, and scheduler ordering remain green.
- [x] Syntax, focused contracts, and diff checks pass.
- [x] No coordinator, storage, wiring, provider UI, or Whisper file has changed.

### Out of scope

Eligibility/timing, persistence, graph integration, provider-settings redesign, Assistant/Actor behavior, model management, and installer work.

---

## SCRIBE-04B — Wave 2 contract and implementation reconciliation

**Depends on:** SCRIBE-01 merged into `origin/main` and the four branch candidates listed below available on `origin`
**May run in parallel with:** Nothing
**Suggested branch slug:** `scribe-wave2-reconciliation`
**Authorized production ownership:** Scribe contracts and handoff documentation; `services/scribe-coordinator/`; Scribe persistence changes in `runtime/session-storage.mjs` and `runtime/session-lifecycle.mjs`; `services/log-extractor-local-http/`; the Scribe extraction path in `services/serial-ai-model-lane/`; directly required shared runtime helpers; and focused Scribe tests
**Must not change:** Production/demo wiring, `runtime/desktop-application.mjs`, Electron/UI, provider settings UI, audio/Whisper/transcript behavior, unrelated services, or installer artifacts
**Checklist in chat:** Mandatory. Display the complete ticket-derived checklist before implementation, update it as work progresses, and leave no required item unchecked before notification or completion reporting.

### Goal

Reconcile the completed Wave 2 candidates into one coherent implementation. Preserve their working coordinator, persistence, prompting, budget, validation, and contract behavior; correct the disputed transport, retry, acknowledgement, and bounded-state seams once. This is a repair and integration ticket, not authorization to redesign Scribe or begin SCRIBE-05 production wiring.

### Required starting branches and commits

Create a fresh worktree and `agent/scribe-wave2-reconciliation` branch from the current `origin/main`. This ticket explicitly authorizes importing the following commits in the listed branch-local order. Do not merge or modify `main`, and do not assume a branch head alone contains its earlier commits.

| Candidate | Branch | Commits from the SCRIBE-01 baseline, oldest first |
| --- | --- | --- |
| SCRIBE-02 coordinator | `origin/agent/scribe-coordinator` | `2902e24369b2ed1ca9f051a1f9c66492fde1f08a`, `fbc70626bfdf0f99eb8cfe51d8958d3f4855e1b8`, `ee7025bf6dacc93fafc4880ff6c3978a93e06dcd` |
| SCRIBE-03 persistence | `origin/agent/scribe-session-persistence` | `06b048de7378e3be5eed19fbefc29748a7c32caf`, `1c1ae812c2aacf96ffd27297b4793b51803a23c9`, `d0499342bbd37e73d9f953a930807d1a9140a856` |
| SCRIBE-04 extraction | `origin/agent/scribe-model-extraction` | `622b7a6def0db8fa22a4a632d0fe4004e67bda1a`, `5a29244098042556b783f4b1b8fa0569af5de2f6` |
| SCRIBE-04A transport contracts | `origin/agent/scribe-batch-transport-contracts` | `6f3d0bafbeda535ca271746599da7964a443da0f` |

Fetch and verify every full commit before importing it. Record the actual starting `origin/main` SHA. Cherry-pick the candidate histories into the reconciliation branch, resolving conflicts deliberately and retaining the behavior described below. If a listed commit is unavailable or no longer descends from the documented SCRIBE-01 baseline `30298b254d78498a8e355433709e8952aa706910`, stop and report the exact discrepancy rather than substituting another revision.

### Authoritative reconciled exchange

The following division of responsibility resolves the conflicting interpretations in the candidate branches:

1. The coordinator owns finalized-row eligibility, the durable Scribe cursor, one active batch, immutable `batch_identity`, and a positive coordinator-level `batch_attempt`.
2. The coordinator emits provider-neutral `scribe.batch-admitted`; it never constructs `ai.work-request`, selects a model, or knows a provider endpoint.
3. The extraction boundary accepts `scribe.batch-admitted`, supplies model/provider configuration locally, constructs one stateless bounded `ai.work-request`, and retains its exact request and fingerprint until terminal settlement.
4. The existing serial AI lane owns bounded automatic provider retries. Within one `batch_attempt`, its `work_id`, complete model request, and request fingerprint remain identical across provider retries.
5. `batch_attempt` and provider-attempt count are different concepts. `scribe.batch-admitted` carries `batch_attempt`; `scribe.batch-evaluated` echoes it. `ai.work-completed.attempt` remains provider-lane evidence and must not silently redefine the coordinator's batch attempt.
6. A terminal evaluated failure leaves the coordinator cursor unchanged and the exact batch retained in a visible stalled state. It does not start a second automatic outer retry loop. A future explicit governed recovery may increment `batch_attempt`; ordinary duplicate delivery or restart replay of an unsettled attempt must remain idempotent.
7. For a successful non-empty model result, the extractor derives deterministic Argus-owned draft IDs in model item order, emits one `logged-item.draft` per item, and waits for the authoritative owner's matching `logged-item.stored` confirmations. Match confirmations by the exact expected deterministic item ID, not by count, source range, text, or arrival order.
8. The extractor emits the final accepted `scribe.batch-evaluated` only after all expected items are stored, placing `logged_item_ids` in evaluated-item order. A valid zero-item evaluation may be emitted immediately as accepted. A model, validation, owner-rejection, timeout, or terminal storage failure emits a governed failed evaluation and never advances the cursor.
9. The coordinator accepts only a `scribe.batch-evaluated` whose complete batch identity and `batch_attempt` match its exact in-flight state. The final message—not individual `logged-item.stored` traffic—is its acknowledgement boundary.
10. `scribe.recovery-request`/`scribe.recovery-restored` provide the explicit recovery handshake. New evidence is
    rejected until authoritative checkpoint references are hydrated; a recovered in-flight batch is replayed with the
    exact identity and coordinator attempt.
11. `scribe.checkpoint-persist`/`scribe.checkpoint-persisted` provide the explicit durability handshake. Admission is
    not published until its checkpoint is acknowledged; an evaluated batch is journaled before checkpoint replacement,
    and the coordinator cursor advances only after the exact persisted acknowledgement. SCRIBE-05 will wire these
    ports into the production graph without adding production graph or desktop-host callbacks here.

### Build and correction checklist

- [x] Import all four candidate histories into the fresh reconciliation branch and record any resolved conflicts without silently dropping tests or behavior.
- [x] Update `scribe.batch-admitted` and `scribe.batch-evaluated` contracts, fixtures, catalog history, generated reference, and `contracts/scribe-contract-handoff.md` so `batch_attempt` has the single meaning defined above and no provider/model field crosses the coordinator boundary.
- [x] Update this work breakdown where older SCRIBE-02 retry/fingerprint wording conflicts with the reconciled exchange; do not leave two authoritative interpretations in canonical documentation.
- [x] Make the coordinator emit/accept only the provider-neutral Scribe messages, remove coordinator-side model-request construction and individual stored-item guesswork, and correlate final evaluations by complete batch identity plus `batch_attempt`.
- [x] Preserve the coordinator's verified three-row admission, 15-second one/two-row idle admission, single timer, busy accumulation, immediate post-settlement pump, ordered recovery, Stop behavior, and deterministic Close behavior.
- [x] Remove the coordinator's second automatic outer retry loop. A terminal evaluated failure must retain the cursor/batch and reject Close settlement visibly rather than report a successful drain.
- [x] Retain the additive monotonic `OrderedStreamGuard.seed()` and asynchronous drain-settlement behavior only if still required; explicitly document these shared-runtime changes as authorized SCRIBE-04B exceptions and keep focused regression coverage.
- [x] Preserve every verified SCRIBE-03 fail-closed invariant: ordered/contiguous batch identity, cursor-relative pending evidence, bounded background state, journal-before-checkpoint settlement, idempotent append, conflicting replay rejection, and Stop/Close recovery behavior.
- [x] Reconcile an exact journaled terminal outcome with a stale in-flight checkpoint after an interrupted journal-before-checkpoint write; rebuild the cursor idempotently without model replay and fail closed on conflicting identities.
- [x] Clean `SessionStorage.#scribeJournalChains` after the latest per-session append settles so the serialization map cannot grow permanently with completed sessions. Preserve same-instance per-session serialization and document the single storage-owner assumption.
- [x] Make the extractor accept `scribe.batch-admitted`, construct the local provider request itself, and emit `scribe.batch-evaluated` for accepted zero-item, accepted one/multiple-item, and failed outcomes.
- [x] Fix the known SCRIBE-04 defects: stable `queued_at` and work identity for idempotent redispatch; nested completion `work_id` validation; non-destructive retention on forged/mismatched completions; conflicting retained-policy rejection; explicit provider `max_tokens`; and no self-routing reuse of `ai.work-request` as an inbound Scribe batch carrier.
- [x] Preserve stateless prompting, actual serialized-request token accounting, oldest-background-first rollover, mandatory-evidence refusal, strict zero-to-many JSON validation, provenance checks, deterministic draft identity, credential redaction, timeout behavior, and serial concurrency one.
- [x] Aggregate owner confirmations by exact deterministic draft ID, tolerate confirmations arriving out of order, reject unknown/duplicate/conflicting confirmations, and emit final ordered `logged_item_ids` exactly once.
- [x] Remove obsolete tests that assert attempt-specific request fingerprints or best-effort source/text acknowledgement matching. Replace them with tests of the authoritative exchange above.
- [x] Keep every modified queue, map, retained request, policy collection, and per-session synchronization structure explicitly bounded or released after settlement.
- [x] Review the combined diff for unrelated changes and confirm no production wiring, desktop host, UI, audio/Whisper, provider settings, or installer file changed.

### Required validation

- [x] Focused contract tests prove provider-neutral admission, `batch_attempt` semantics, exact evidence order/revision correlation, zero/one/multiple/failed evaluated messages, and invalid forged/mismatched identities.
- [x] Focused coordinator tests prove three-row and idle admission, concurrency one, duplicate/restart replay, no automatic outer retry, terminal stall, zero/multiple acknowledgement, post-ack pump, Stop, Close, and failed drain visibility.
- [x] Focused extraction tests prove one exact model request across provider retries, stable raw request fingerprint, local provider configuration, bounded serialized payload, `max_tokens`, strict response validation, deterministic draft IDs, owner-confirmation aggregation, and zero/failure completion.
- [x] Focused persistence tests prove the corrected identity/checkpoint/journal invariants, genuine concurrent same-instance appends, journal-chain cleanup, crash/restart, Stop, Close refusal, and bounded state.
- [x] Focused persistence regression interrupts evaluation persistence between journal append and checkpoint replacement, proves one recovery settlement without model replay, and rejects conflicting journal/checkpoint identities.
- [x] One component-level integration test exercises: finalized rows -> admitted batch -> extractor -> serial model completion -> zero or deterministic drafts -> authoritative stored confirmations -> final evaluated message -> coordinator settlement, without production graph wiring or simulation in production code.
- [x] Run the complete repository test suite, contract governance, generated contract documentation check, package graph generation/verification, syntax checks for every changed JavaScript module, and `git diff --check`.
- [x] All checks pass from the combined reconciliation branch. A test must not redefine an architectural requirement merely to match implementation behavior.

### Commit, push, and report

Keep the imported commits intact where practical and add one clearly named reconciliation commit for the corrections. Push `agent/scribe-wave2-reconciliation`; never merge `main`. Report the starting `origin/main`, imported commit list, reconciliation commit, final branch HEAD, exact files changed by reconciliation, conflict resolutions, full checklist, test results, and any genuinely unresolved blocker. Main must remain untouched and the installer must not be rebuilt.

After pushing and before reporting completion, run the required notification command with a 5–9 word message containing `Codex`, as required by `C:\dustin-thomason\agents\rules\agent-completion-notification.md`.

### Exit gate

- [x] The four candidate histories are preserved on one clean branch and all disputed seams have one documented meaning.
- [x] No coordinator provider knowledge, duplicate retry owner, ambiguous acknowledgement matching, unbounded completed-session synchronization state, or self-routing message type remains.
- [x] Complete tests and governance gates pass without weakening the accepted Scribe behavior.
- [x] The final worktree is clean, the branch is pushed, main is untouched, and the completion notification was sent.
- [x] SCRIBE-05 can consume the reconciled contracts and component ports without redesigning SCRIBE-02, SCRIBE-03, or SCRIBE-04.

### Out of scope

Production graph/DesktopApplication wiring, UI status, real microphone or LM Studio acceptance, prompt-quality tuning, provider-settings redesign, Whisper/audio changes, Assistant/Actor behavior, installer rebuild, and unrelated refactoring.

---

## SCRIBE-05 — Production wiring, lifecycle, and visible status integration

**Depends on:** SCRIBE-04B merged into `origin/main`
**May run in parallel with:** Nothing
**Suggested branch slug:** `scribe-production-integration`
**Exclusive production ownership:** `wiring/production-electron.json`, directly affected production/demo graph files, `runtime/desktop-application.mjs`, the production Scribe policy source/configuration, and focused cross-component integration tests
**Must not change:** Contract semantics from SCRIBE-01, core coordinator/model/storage implementations except for a reported prerequisite defect, provider settings UI, Whisper/audio, unrelated UI layout, or installer artifacts
**Checklist in chat:** Mandatory. Display a ticket-derived checklist in the agent chat before implementation, update it as work progresses, and leave no required item unchecked before notification or completion reporting.

### Goal

Replace the production window-selector-only extraction path with the complete Scribe coordinator flow and connect its durable state, existing scheduler, model adapter, owners, lifecycle, and truthful status.

### Model-tiered execution checklist

The three stages below are sequential and constitute the ticket's single authoritative checklist. At the end of Stages 1 and 2, send the required notification and pause. Do not continue until the user resumes the ticket after changing the model configuration.

#### Stage 1 — Lower-cost model, low reasoning/effort: bounded preparation

- [x] Confirm the isolated worktree starts cleanly from the current `origin/main` and contains the reviewed SCRIBE-04B merge.
- [x] Read `contracts/scribe-contract-handoff.md`, this ticket, and only the directly affected production graph, manifests, desktop lifecycle/status path, and focused tests.
- [x] Map the exact existing production path and every required Scribe input/output wire before editing; identify any prerequisite defect in a core SCRIBE-04B component instead of silently broadening ownership.
- [x] Run the focused baseline graph, lifecycle, contract, and Scribe integration checks needed to distinguish a new regression from an inherited failure.
- [x] Display this complete ticket-derived checklist in chat with Stage 1 progress recorded.
- [x] Send a 5–9 word notification containing `Codex`, stating that SCRIBE-05 preparation is complete, then pause for the high-reasoning stage.

#### Stage 2 — Stronger model, high reasoning/effort: production integration

- [x] Add the Scribe coordinator manifest to the production graph and wire every input/output explicitly; do not add hidden host callbacks or sibling imports.
- [x] Route authoritative finalized transcript rows to Scribe while preserving their existing projection and permanent-history paths.
- [x] Route bounded Scribe batches to the existing model-backed extractor and route evaluated outcomes and Logged Item acknowledgements back to the coordinator.
- [x] Connect checkpoint/journal persistence and restore governed state before admitting new work after startup.
- [x] Configure defaults of three rows, 15,000 ms partial idle, and approximately 8,000 total model tokens without coupling policy to LM Studio.
- [x] Preserve the existing serial model lane and provider configuration; do not create a second scheduler or provider connection.
- [x] Keep recording, Whisper, and transcript finalization independent of Scribe backlog or model latency.
- [x] Surface bounded Scribe states through the existing status boundary: caught up, pending rows, queued/busy, processing, delayed/retrying, unavailable, and terminal failure.
- [x] Prove three-row groups accumulated during busy work run immediately after acknowledgement while a final one/two-row group waits only for idle or Close.
- [x] Make Stop leave Scribe resumable; make Close release the remainder, wait for terminal acknowledgement, and fail visibly rather than lose work.
- [x] Ensure a valid zero-item batch produces no blank Logged Item while still advancing the durable cursor.
- [x] Ensure multiple items arrive exactly once through the active owner and append-only history with source navigation intact.
- [x] Assemble the accepted batch acknowledgement only from actual `logged-item.stored` confirmations, preserving the evaluated item order and exact one-to-one `logged_item_ids` mapping before allowing cursor advancement or persistence.
- [x] Remove or bypass the obsolete production-only selection path without deleting reusable Phase 4 replacement proofs or unrelated demos.
- [x] Add focused integrated coverage for delayed 3 + 3 + 1 processing and all three required crash-recovery boundaries; tests must exercise real component contracts rather than bypassing persistence or ownership seams.
- [x] Review the implementation diff for architecture, ordering, acknowledgement, recovery, and scope correctness.
- [x] Send a 5–9 word notification containing `Codex`, stating that SCRIBE-05 implementation is ready for verification, then pause for the lower-tier verification stage.

#### Stage 3 — Lower-cost model, low reasoning/effort: verification and delivery

- [x] Run the focused integration/recovery suites and the complete repository test suite.
- [x] Run production graph validation, package generation/integrity verification, contract governance/docs, syntax checks, and `git diff --check`.
- [x] Launch the real source Electron application against the configured provider without simulating the microphone, model, queue, or Logged Item path; record any physical-device acceptance that remains with the user.
- [x] Confirm AI Provider settings still select and test LM Studio without requiring Ollama.
- [x] Confirm the final diff stays within this ticket's authorized files and does not rebuild the installer.
- [x] Update every checklist item truthfully, leaving no required item checked if its evidence is missing.
- [x] Commit and push the isolated branch, verify the worktree is clean and remote-aligned, send the required completion notification, and report the exact SHA, files, checks, and remaining user acceptance. Do not merge `main`.

### Exit gate

- [x] A focused integrated session proves 3 + 3 + 1 finalized rows, model-lane delay, 15-second partial admission, zero/multiple results, exact ordering, stable provenance, and no loss/duplication.
- [x] Recovery proves a crash before model completion, after model completion but before item acknowledgement, and after item acknowledgement but before cursor persistence.
- [x] Production graph validation, package generation/integrity, contract governance/docs, focused Electron integration, syntax, and diff checks pass.
- [x] The source Electron app launches against the configured real provider without simulation; physical microphone/content-quality acceptance may remain for SCRIBE-06/user review.
- [x] AI Provider settings still select and test LM Studio without requiring Ollama.

### Out of scope

Prompt/schema redesign, broad UI redesign, new settings tabs, Whisper changes, Assistant/Actor roles, new storage technology, and installer rebuild.

---

## SCRIBE-05A — Asynchronous model admission and truthful Scribe progress

**Depends on:** SCRIBE-05 merged into `origin/main`
**May run in parallel with:** Nothing
**Suggested branch slug:** `scribe-async-model-admission`
**Exclusive production ownership:** `services/serial-ai-model-lane/`, only the scheduler/runtime seam required for correct admission and drain behavior, `wiring/production-electron.json`, the existing Scribe status projection/rendering path, and focused model-lane/production integration tests
**Must not change:** Scribe batching thresholds, prompt semantics, model-provider settings, transcript/audio behavior, Logged Item ownership, unrelated contracts, or installer artifacts
**Checklist in chat:** Mandatory. Display a ticket-derived checklist in the agent chat before implementation, update it as work progresses, and leave no required item unchecked before notification or completion reporting.

### Goal

Repair the real failure in which a slow but healthy LM Studio inference consumes the graph's 15-second operation receipt, permanently fails the `ai.work-request` wire, and prevents every later Scribe batch from reaching the model. Queue admission must complete promptly; model completion remains asynchronous, serial, bounded, correlated, and visible.

### Reproduction evidence

- Session: `session-4c87d452-f960-41b8-8b00-5818f8e9e435`.
- LM Studio received the first request at 09:28:24 and reported 14,665.58 ms of model processing. It returned a valid zero-item response.
- The graph default `operation_timeout_ms` is 15,000 ms and the `log-extractor` -> `model-lane` `ai.work-request` wire has no distinct admission deadline.
- The next idle-triggered batch was durably admitted at 09:28:50, but LM Studio received no second POST. The checkpoint remained in flight at segment 3 while transcript history reached segment 9.
- The correction must reproduce this timing relationship and prove that two or more consecutive batches reach the provider even when each inference outlasts the graph's ordinary operation deadline.

### Model-tiered execution checklist

The three stages below are sequential and constitute the ticket's single authoritative checklist. At the end of Stages 1 and 2, send the required notification and pause. Do not continue until the user resumes the ticket after changing the model configuration.

#### Stage 1 — Lower-cost model, low reasoning/effort: bounded preparation

- [ ] Confirm the isolated worktree starts cleanly from the current `origin/main` and contains the reviewed SCRIBE-05 merge.
- [ ] Read `contracts/scribe-contract-handoff.md`, this ticket, and only the model-lane operation, scheduler admission/drain seam, production wire, existing Scribe status rendering path, and focused tests.
- [ ] Trace the exact receipt lifecycle from `scribe.batch-admitted` through `ai.work-request`, `operation.completed`, and later `ai.work-completed`; record where the 15-second deadline marks the wire failed.
- [ ] Confirm from the supplied real-run evidence that only the first POST reached LM Studio and that later authoritative rows remained durable but undispatched.
- [ ] Run the smallest focused baseline necessary to demonstrate that current fast endpoint tests do not cover inference lasting beyond the wire operation deadline.
- [ ] Display this complete ticket-derived checklist in chat with Stage 1 progress recorded.
- [ ] Send a 5–9 word notification containing `Codex`, stating that SCRIBE-05A preparation is complete, then pause for the high-reasoning stage.

#### Stage 2 — Stronger model, high reasoning/effort: runtime correction

- [ ] Make `ai.work-request` acknowledge bounded scheduler admission promptly instead of holding the service receipt for the entire inference.
- [ ] Emit the existing governed `ai.work-completed` success or failure asynchronously after the serial scheduler finishes, preserving the exact work ID, request fingerprint, session, sequence, attempt, idempotency, and causation needed by the extractor.
- [ ] Preserve scheduler concurrency one, workload priority, bounded capacity, and the explicit recovery-attempt policy. Do not add a second queue, worker, provider connection, or hidden cross-service callback.
- [ ] Handle admission/capacity/configuration failures through a terminal correlated result without unhandled promise rejection, silent loss, fabricated success, or a permanently pending extractor batch.
- [ ] Make model-lane application drain stop accepting new work, wait asynchronously for admitted work to settle and emit its completion, then report `service.drained`; do not block the serial stdin loop needed to complete that drain.
- [ ] Do not use a very large graph receipt timeout as the primary fix. The provider timeout governs inference; the wire operation timeout governs admission.
- [ ] Render the existing `scribe_processing` state where a user can actually see it near the Logged Items workflow: pending, queued, processing, delayed, caught up, unavailable, or failed. Do not represent a failed/stuck batch merely as `scribe: available`.
- [ ] Add focused regressions proving an inference longer than the ordinary wire deadline does not fail the wire, the next queued batch reaches the provider, results remain ordered/exactly once, and Stop/Resume plus application drain preserve work.
- [ ] Preserve durable transcript backlog and restart recovery. No transcript row may be dropped or duplicated merely because model work is slow.
- [ ] Review the diff against the explicit service boundaries and the real failure evidence.
- [ ] Send a 5–9 word notification containing `Codex`, stating that SCRIBE-05A implementation is ready for verification, then pause for the lower-tier verification stage.

#### Stage 3 — Lower-cost model, low reasoning/effort: verification and delivery

- [ ] Run the focused model-lane, Scribe integration/recovery, and UI status suites plus the complete repository suite.
- [ ] Run contract governance/docs, production graph validation, package graph generation/verification, syntax checks, and `git diff --check`.
- [ ] Launch the real source Electron app against LM Studio without microphone or model simulation; prove at least two consecutive admitted Scribe batches reach LM Studio and settle, including a response whose total duration exceeds 15 seconds if the configured model naturally does so.
- [ ] Confirm ordinary startup remains quiet, diagnostics remain opt-in, and visible Scribe state accurately follows the real batch.
- [ ] Confirm the final diff stays within authorized ownership and does not rebuild the installer.
- [ ] Update every checklist item truthfully, leaving no required item checked if its evidence is missing.
- [ ] Commit and push the isolated branch, verify the worktree is clean and remote-aligned, send the required completion notification, and report the exact SHA, files, checks, real-run evidence, and remaining user acceptance. Do not merge `main`.

### Exit gate

- [ ] Queue admission completes within the graph operation deadline while inference may safely continue beyond it.
- [ ] Two or more consecutive Scribe batches reach the configured provider and settle in order without a failed wire, duplicate result, skipped row, or stuck checkpoint.
- [ ] Model-lane drain waits for admitted asynchronous work and emits its terminal result before reporting drained.
- [ ] The application visibly distinguishes Scribe pending, active, delayed, caught-up, and failed states.
- [ ] All focused/full automated gates and a real LM Studio source launch pass.

### Out of scope

Prompt customization, response-schema redesign, batching-policy changes, Whisper/audio work, Assistant/Actor behavior, installer rebuild, and unrelated UI redesign.

---

## SCRIBE-05B — Governed user Scribe guidance and output expectations

**Depends on:** SCRIBE-05A merged into `origin/main`
**May run in parallel with:** Nothing
**Suggested branch slug:** `scribe-user-guidance`
**Exclusive production ownership:** Scribe policy/request/checkpoint contract additions required for guidance, `contracts/scribe-instruction.mjs`, the Scribe policy/settings persistence path, existing AI settings drawer and Electron bridge, and focused guidance/recovery/UI tests
**Must not change:** Provider credential semantics, fixed Scribe role and response schema, transcript/audio behavior, batch thresholds, Logged Item authority, Assistant/Actor scope, or installer artifacts
**Checklist in chat:** Mandatory. Display a ticket-derived checklist in the agent chat before implementation, update it as work progresses, and leave no required item unchecked before notification or completion reporting.

### Goal

Give the user one clear, bounded place to tell Scribe what information to prioritize while also explaining what Scribe can return. Preserve Argus's protected operational instruction and contracts: user guidance refines retention judgment but cannot redefine the Scribe role, response structure, provenance, or authority.

### Accepted product behavior

- The existing AI settings area gains a distinct **Scribe** section or tab; do not create another top-level settings system.
- The surface explains that Scribe may create zero, one, or multiple discrete Logged Items such as actions, decisions, open questions, reminders, and noteworthy facts, each linked to new source rows. It does not promise an item for every batch or a routine summary.
- An editable **Additional Scribe guidance** field lets the user state priorities such as “Capture bugs and feature requests; ignore casual test chatter.” The protected system instruction and output contract are not directly editable.
- Guidance is optional, locally persisted, non-secret, explicitly bounded, and counted inside the existing approximately 8,000-token total budget.
- A session snapshots one exact guidance value before its first Scribe batch. Edits apply only to the next new session and never mutate a stopped/resumable or in-flight session.
- The snapshot, its identity/fingerprint, and its retry/recovery path are durable so an application restart cannot silently substitute newer global guidance for an existing session.

### Model-tiered execution checklist

The three stages below are sequential and constitute the ticket's single authoritative checklist. At the end of Stages 1 and 2, send the required notification and pause. Do not continue until the user resumes the ticket after changing the model configuration.

#### Stage 1 — Lower-cost model, low reasoning/effort: bounded preparation

- [x] Confirm the isolated worktree starts cleanly from the current `origin/main` and contains the reviewed SCRIBE-05A merge.
- [x] Read `contracts/scribe-contract-handoff.md`, this ticket, and only the protected instruction, Scribe policy/request/checkpoint path, settings persistence/bridge, existing AI settings drawer, and focused tests.
- [x] Map where guidance must be snapshotted, budgeted, fingerprinted, persisted, recovered, rendered, and transmitted without treating it as a provider credential or server-side conversation.
- [x] Identify the smallest compatible contract-minor additions needed; retain every older fixture and verify old messages still replay.
- [x] Record the exact current user-facing expectation gap and the proposed field label/help text before implementation.
- [x] Display this complete ticket-derived checklist in chat with Stage 1 progress recorded.
- [x] Send a 5–9 word notification containing `Codex`, stating that SCRIBE-05B preparation is complete, then pause for the high-reasoning stage.

#### Stage 2 — Stronger model, high reasoning/effort: governed guidance implementation

- [x] Add a versioned, bounded Scribe settings record separate from AI provider credentials, with load, save, validation, default, and reset behavior.
- [x] Add the Scribe settings section/tab to the existing AI settings drawer with concise expected-output text and an **Additional Scribe guidance** input. Make saved/applies-next-session state truthful and accessible.
- [x] Keep the protected Scribe instruction fixed. Treat user text only as an explicitly labeled guidance field whose precedence is below role, schema, evidence, provenance, safety, and ownership rules.
- [x] Snapshot guidance once per new session before its first batch. Prevent an edit from changing an existing session's pending, in-flight, stopped/resumable, retried, or recovered work.
- [x] Carry the exact guidance snapshot and stable identity/fingerprint through the governed policy, request, checkpoint/journal, retry, and recovery seams required to reproduce a batch exactly after restart.
- [x] Include serialized guidance in the approximately 8,000-token accounting and remove old background context first under the existing policy. Reject over-limit guidance visibly; never truncate it silently or truncate new evidence.
- [x] Ensure every stateless LM Studio request contains the protected instruction, the labeled optional guidance, the complete new evidence, and bounded background context. Do not rely on LM Studio conversation memory or configure prompting inside LM Studio.
- [x] Preserve zero/one/multiple-item validation, exact batch identity, provenance, deterministic draft identity, owner acknowledgement, and serial execution.
- [x] Add focused tests for blank/default guidance, custom guidance transmission, maximum/oversized input, next-session application, mid-session edit isolation, retry identity, restart recovery, token rollover, and older contract compatibility.
- [x] Review the diff for contract truthfulness, settings separation, boundedness, identity stability, recovery, and scope.
- [x] Send a 5–9 word notification containing `Codex`, stating that SCRIBE-05B implementation is ready for verification, then pause for the lower-tier verification stage.

#### Stage 3 — Lower-cost model, low reasoning/effort: verification and delivery

- [x] Run focused Scribe guidance, settings, contract, model extraction, persistence/recovery, production integration, and UI suites plus the complete repository suite.
- [x] Run contract governance/docs, package graph generation/verification, production graph validation, syntax checks, and `git diff --check`.
- [ ] Launch the real source Electron app with LM Studio; save recognizable guidance, begin a new real session, and confirm LM Studio receives that exact bounded guidance while the prior/current-session behavior remains correctly described.
- [ ] Confirm the UI explains valid zero output and does not imply that every batch becomes a summary or Logged Item.
- [ ] Confirm secrets remain redacted, guidance is not stored as a credential, ordinary startup stays quiet, and the installer is not rebuilt.
- [x] Update every checklist item truthfully, leaving no required item checked if its evidence is missing.
- [x] Commit and push the isolated branch, verify the worktree is clean and remote-aligned, send the required completion notification, and report the exact SHA, files, contract versions, checks, real-run evidence, and remaining user judgment. Do not merge `main`.

### Exit gate

- [x] The user can see what Scribe may return and can save/reset bounded additional guidance without editing protected instructions or provider credentials.
- [x] A new session uses one immutable guidance snapshot across batches, retries, Stop/Resume, Close, and restart recovery; an existing session cannot silently change guidance.
- [ ] Guidance is present in the real stateless LM Studio request, included in the total token budget, and unable to weaken schema, provenance, or authority rules.
- [x] Default/blank and customized guidance both preserve valid zero, one, and multiple Logged Item outcomes.
- [ ] All focused/full automated gates and a real LM Studio source launch pass.

### Out of scope

Arbitrary replacement of the protected system prompt, provider-side conversation persistence, per-batch prompt editing, prompt-template marketplaces, Assistant/Actor behavior, Whisper/audio changes, installer rebuild, and unrelated settings redesign.

---

## SCRIBE-06 — Regression, documentation, and real-runtime acceptance gate

**Depends on:** SCRIBE-05B merged into `origin/main`
**May run in parallel with:** Nothing
**Suggested branch slug:** `scribe-acceptance`
**Exclusive production ownership:** No production files unless acceptance exposes a defect and the coordinator approves an ownership revision; canonical Scribe evidence, README/TODO/pending-decision status, and new acceptance-only tests
**Must not change:** Accepted behavior merely to make a test pass, unrelated application features, Whisper/audio, Assistant/Actor scope, or installer artifacts
**Checklist in chat:** Mandatory. Display a ticket-derived checklist in the agent chat before implementation, update it as work progresses, and leave no required item unchecked before notification or completion reporting.

### Goal

Verify the complete real Scribe path, close the implementation documentation, and leave a precise user-validation checklist. This is the only ticket authorized to mark the Scribe work breakdown complete.

### Model-tiered execution checklist

The three stages below are sequential and constitute the ticket's single authoritative checklist. At the end of Stages 1 and 2, send the required notification and pause. Do not continue until the user resumes the ticket after changing the model configuration.

#### Stage 1 — Lower-cost model, low reasoning/effort: evidence preparation

- [x] Confirm the isolated worktree starts cleanly from the current `origin/main` and contains the reviewed SCRIBE-05A and SCRIBE-05B merges.
- [x] Review the merged Scribe ticket history against the integration-wide definition of complete, using commit summaries and directly affected files rather than rereading unrelated project history.
- [x] Run the complete Argus suite, contract governance, generated contract documentation check, production graph validation, package graph generation/verification, syntax checks, and diff checks once from the joined baseline.
- [x] Create the focused Scribe validation artifact skeleton with an explicit user action and expected result for every acceptance scenario; do not mark evidence as passed yet.
- [x] Report any baseline failure, contract drift, production-file ownership need, or unavailable real dependency before editing.
- [x] Display this complete ticket-derived checklist in chat with Stage 1 progress recorded.
- [ ] Send a 5–9 word notification containing `Codex`, stating that SCRIBE-06 preparation is complete, then pause for the high-reasoning acceptance stage. — **not done, by user direction.** The user ran all three stages in one session on one model and instructed the agent not to pause at stage boundaries. The notification duty was discharged instead at the point the ticket cares about: when a production defect was confirmed (Stage 2), and again at completion.

#### Stage 2 — Stronger model, high reasoning/effort: real acceptance and judgment

- [x] Launch the real source Electron application with LM Studio selected; do not simulate microphone, model, queue, or Logged Item behavior. — `electron .` from source, 12 services healthy, `host.started`. The GUI could not be *operated* (no click automation available), so scenario evaluation ran through the real production graph and the real `DesktopApplication` instead; the microphone stays a user acceptance.
- [x] Evaluate three-row admission, partial idle admission, slow-model busy catch-up across multiple requests, zero output, multiple output, retry/failure visibility, Stop/Resume, Close, and restart recovery through the real production path. — three-row, idle, catch-up, zero, multiple, and failure evaluated against real LM Studio; Stop/Resume, Close, and restart recovery evaluated against the production graph with a deterministic endpoint only.
- [ ] Confirm default and customized Scribe guidance both reach LM Studio as bounded stateless input, remain immutable within a session, and produce no promise that every batch yields an item. — **default confirmed; customized blocked.** Immutability and the output-expectation surface confirmed. `scribe.guidance-configure` is the exact message that triggers the session-start defect, so no guided request can reach the provider on this baseline.
- [x] Record the exact user action, expected result, and observed evidence for every scenario; distinguish automated, agent-observed, and user/physical-device evidence.
- [x] Confirm long-running transcription remains responsive while Scribe is delayed and that Scribe cannot block or mutate Whisper/transcript behavior. — worst transcript row 79 ms while inference held 39 s.
- [ ] Confirm background context influences interpretation without independently recreating old Logged Items and that every new item navigates to its triggering source rows. — **partially confirmed.** Provenance data verified: every stored item cited new-evidence segments, never background. Whether background *influences interpretation* without recreating items needs a multi-turn real conversation and human judgement.
- [x] Confirm secrets, transcript text, model context, and audio are absent from ordinary diagnostics beyond existing governed/redacted behavior.
- [x] Determine whether any failure is a product defect, environment limitation, model-quality result, or missing user acceptance; do not redefine accepted behavior to make a test pass. — one product defect (session-start recovery conflict), two environment limitations (CRLF contract-docs gate, symlink EPERM skip), no accepted behavior altered.
- [x] If a production defect is confirmed, document the exact root cause and required ownership revision, send the required notification, and pause for coordinator approval before changing production code. — documented in `docs/incidents/2026-09-12-scribe-session-start-recovery-conflict.md`, notification sent, **no production file changed**.
- [x] Decide from evidence whether `MOD-003` and `MOD-004` are resolved or require a precise remaining trigger. — both stay **Open** with narrowed triggers recorded in `PENDING-DECISIONS.md`.
- [ ] Send a 5–9 word notification containing `Codex`, stating that SCRIBE-06 acceptance analysis is complete, then pause for the lower-tier closure stage. — **not done, by user direction** (see the Stage 1 note). A notification was sent when the defect was confirmed.

#### Stage 3 — Lower-cost model, low reasoning/effort: documentation and closure

- [x] Apply only the evidence-backed documentation decisions from Stage 2 to `Architecture/DesignDecisions.md`, `Architecture/OperationalAgentRoles.md`, `PENDING-DECISIONS.md`, `TODO.md`, `README.md`, and the focused Scribe validation artifact.
- [x] Mark `MOD-003` and `MOD-004` resolved only when Stage 2 supplied their required evidence; otherwise retain the precise unresolved trigger. — both retained as **Open** with narrowed triggers.
- [x] Rerun every automated gate affected by any approved correction or documentation update and confirm the merged production baseline remains green.
- [x] Verify the validation artifact contains actionable user actions and expected results and clearly identifies all pending physical-microphone, model-quality, or user acceptance.
- [x] Confirm the final diff contains no unrelated production changes and that the installer was not rebuilt. — zero production files changed; `argus-electron-production` package digest `a648678204a65ea4` identical to baseline; `out/` untouched.
- [x] Update every checklist item truthfully, leaving no required item checked if its evidence is missing.
- [x] Commit and push the isolated branch, verify the worktree is clean and remote-aligned, send the required completion notification, and report the exact SHA, files, checks, and remaining acceptance. Do not merge `main`.

### Exit gate

- [x] All automated gates pass from the merged production baseline. — with two recorded exceptions: the `contracts:docs:check` CRLF artifact and the symlink-privilege skip, both environment limitations, neither contract drift nor a Scribe defect.
- [x] Real LM Studio source launch succeeds and its model receives the bounded Scribe request shape. — 5,997-byte request, governed `limits` with output reserve, protected instruction present, two stateless messages per call, no credential.
- [x] Consecutive real Scribe batches continue reaching LM Studio when an inference exceeds 15 seconds; no queue-admission receipt fails the wire and no checkpoint remains silently stuck. — 38,825 ms and 38,976 ms inferences against a 5,000 ms admission deadline; zero wire failures; cursor reached the last row; no in-flight batch left behind.
- [ ] The real request contains the selected session guidance, and the settings surface accurately explains valid zero, one, and multiple-item outcomes. — **half met.** The settings surface is correct and verified. The guided request cannot reach the provider on this baseline; blocked by the session-start defect.
- [x] The user-validation artifact gives actionable action/result steps and identifies any physical-microphone or model-quality acceptance still pending.
- [x] No unresolved cursor gap, unacknowledged batch, duplicate Logged Item, silent failure, or unintended Assistant/Actor behavior remains in the accepted scenarios. — within the scenarios that could run. The session-start defect is itself a silent failure and is recorded as the blocking item, not as an accepted scenario.
- [x] Canonical documents agree on what is implemented, deferred, and still awaiting user evidence.

**Gate verdict: the Scribe work breakdown is NOT complete.** This ticket is the only one authorized to
mark it complete, and it does not. The pipeline is built and proven batch-for-batch against a real
model, but the shipped desktop host produces zero Logged Items for every session. Completion requires
the repair in `docs/incidents/2026-09-12-scribe-session-start-recovery-conflict.md`, then the two
blocked items above, then the physical-microphone and model-quality acceptance in
`docs/validation/SCRIBE-ACCEPTANCE-VALIDATION.md`.

### Out of scope

New product behavior beyond the accepted Scribe guidance surface, optimization beyond measured need, installer rebuild, packaged release, Whisper tuning, arbitrary system-prompt replacement, Assistant implementation, and Actor integrations.

---

## Integration-wide definition of complete

The Scribe integration is complete only when every applicable implementation, reconciliation, integration, and acceptance exit gate passes and all of the following remain true:

- Finalized transcript history is the only durable evidence backlog; no duplicate transcript queue exists.
- One durable cursor and one active batch describe Scribe progress for each session.
- Three new rows run immediately; one or two run after 15 seconds idle or on Close; Stop remains resumable.
- Busy model work causes bounded waiting, not concurrent requests, repeated polling, skipped rows, or transcript backpressure.
- Model queue admission is acknowledged promptly and independently from inference completion, so a healthy request lasting longer than the ordinary graph operation deadline cannot fail the wire or strand every later batch.
- Cursor advancement is acknowledgement-driven and crash-safe for zero, one, and multiple Logged Items.
- LM Studio requests are stateless, bounded to the governed approximately 8,000-token total, and reconstructed by Argus.
- Background context supports interpretation and duplicate suppression; only new evidence triggers Logged Items.
- Every item is discrete, meaningful, non-duplicate, bounded, and linked to exact source transcript rows.
- Scribe may return no item and does not generate a routine summary for every batch.
- The user can see Scribe's expected zero/one/multiple-item behavior and provide bounded additional guidance that is immutable for one session, included in the stateless request budget, and subordinate to the protected Scribe contract.
- Provider settings remain provider neutral; LM Studio works without making Ollama a prerequisite.
- Whisper, transcript ownership, Logged Item ownership/history, service isolation, explicit wires, and recovery rules remain intact.
- Assistant and Actor remain documented future roles with no current runtime, model, tool, permission, or side effect.

## Next dispatch

SCRIBE-01 through SCRIBE-06 have all run. SCRIBE-06 completed on `agent/scribe-acceptance` and
**did not** mark the integration complete: acceptance found that the shipped desktop host produces
zero Logged Items for every session.

**Next is a new ticket, SCRIBE-07 — repair the session-start policy publication conflict.** It is the
only thing standing between a built pipeline and a working one, and it is the one thing SCRIBE-06
could not do, because SCRIBE-06 owns no production file.

Dispatch it with `docs/plans/ARGUS-ISOLATED-TICKET-HANDOFF.md` plus
`docs/incidents/2026-09-12-scribe-session-start-recovery-conflict.md`, which carries the mechanism,
the bisection to `eebc74f`, and three candidate ownership revisions with their trade-offs. Start from
the then-current `origin/main` after `agent/scribe-acceptance` is reviewed and merged.

Its exit gate is already written and executable: remove the `todo` marker from *the host publishes
one session-start recovery request, not two under one key* in `tests/scribe-real-acceptance.test.mjs`
and make it pass. Then re-run `tests/scribe-real-acceptance.test.mjs` against real LM Studio to clear
the two items SCRIBE-06 left blocked — the guided request reaching the provider, and background
context influencing interpretation without recreating items — before handing the remaining
physical-microphone and model-quality acceptance to the user.
