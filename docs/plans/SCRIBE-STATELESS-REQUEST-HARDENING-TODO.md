# Argus Scribe Stateless Request Hardening Work Breakdown

**Status:** SCRIBE-06B reviewed and merged (`89a9f66`). SCRIBE-07A, SCRIBE-07B, and SCRIBE-07C are
implemented, independently reviewed, and each recommended MERGE (see each ticket's Review record
below). They are chained sequentially as branches (`agent/scribe-structured-response` →
`agent/scribe-json-fence-compatibility` → `agent/scribe-context-budget`) rather than merged into
`origin/main` yet — the coordinator has not pushed the final merge-to-`main` decision for 07A/07B/07C
during this session. Remaining: merge decision for the chain, then the Final real LM Studio
acceptance below (not started; requires a live LM Studio session).

**Execution model:** One low-reasoning agent, one small branch at a time

**Merge authority:** The coordinating agent reviews and merges; implementation agents never merge `main`

**Evidence authority:** This artifact, not the agent chat, is the durable implementation and review record

**Created from:** `origin/main` at `ba6585c` on 2026-09-15

## Why this work exists

Real LM Studio evidence showed two concrete problems in otherwise successful Scribe processing:

1. Argus asks for JSON in prose but does not request provider-enforced structured output. Gemma
   sometimes wraps an otherwise valid response in a Markdown `json` fence, so strict `JSON.parse`
   rejects it. The existing retry then sends the same deterministic request again and can receive
   the same rejected wrapper.
2. Stateless Scribe calls legitimately resend context, but the accepted context and output limits
   need one explicit, governed configuration. Current requests correctly distinguish new evidence
   from background, yet the configured approximately 8,000-token total is smaller than the newly
   accepted operating target for a model running with a 32,000-token context window.

This is request hardening, not a new Scribe architecture. Argus remains stateless and reconstructs
each request. LM Studio remains a shared provider: structured output is requested only by Argus on
the individual Scribe call and must not alter LM Studio globally or affect LMLink, MCP, other Argus
workloads, or any other client.

## Real-work evidence baseline

The tickets below originate from a real Argus session using LM Studio, not from a hypothetical test:

- At `2026-09-15 17:19:40`, LM Studio received a stateless two-message Scribe request for three new
  finalized rows. It reported `prompt_tokens: 9334`, returned unfenced JSON, and Argus accepted it.
- At `2026-09-15 17:20:17`, LM Studio received the next three-row Scribe batch. It reported
  `prompt_tokens: 9288` and returned a complete valid JSON object wrapped in a Markdown `json` fence.
  The response stopped normally and was not token-truncated, but Argus classified it as malformed
  because the production OpenAI-compatible parser passed the entire fenced string to `JSON.parse`.
- At `2026-09-15 17:20:56`, Argus sent the same retained batch again. LM Studio's prompt cache
  recognized the identical request, but the model still regenerated the same deterministic fenced
  result and occupied the serial lane again. This is the observed repeated-work failure.
- Production inspection tied the failure to `requestConfiguredModel` in
  `services/serial-ai-model-lane/index.mjs`: the OpenAI-compatible request body did not include
  `response_format`, and its response path performed strict `JSON.parse` without narrowly handling
  a complete Markdown JSON wrapper.
- Production inspection also confirmed that context is intentionally reconstructed by
  `buildScribeBatchRequest` in
  `services/log-extractor-local-http/scribe-batch-boundary.mjs`. The coordinator retains bounded
  background transcript and prior Logged Items; this is why each distinct stateless request carries
  prior context and why the accepted budget must remain explicit and bounded.

This baseline is the real failure that the implementation tests must represent. A new fixture or a
green test is supporting evidence only; it cannot replace this production-path explanation.

## Decisions already made

- Every Scribe request remains stateless and self-contained.
- `new_evidence_segments` is the only material from which Scribe may create new Logged Items.
- `background_context.prior_logged_items` is semantic memory used for interpretation and duplicate
  suppression.
- `background_context.transcript_segments` is secondary raw context.
- New evidence is never truncated or displaced by background.
- When background must roll off, remove the oldest transcript segments first, then the oldest prior
  Logged Items. Keep retained arrays in chronological order.
- Background remains bounded. Do not replace the existing bounded retention with an entire
  unbounded meeting transcript or an unbounded Logged Item list.
- The accepted production Scribe total-context setting is **16,384 tokens** for a model configured
  with a 32,000-token window. This is a ceiling, not a target to fill.
- The accepted batch output limits are: `max_items: 8`, `max_item_chars: 512`,
  `max_output_chars: 4096`, and `max_output_tokens: 2048`.
- Structured output is a per-request provider transport option. Existing Argus schema, identity,
  provenance, and authority validation remains mandatory after parsing.
- Compatibility normalization may unwrap one complete Markdown JSON fence. It must not search prose
  for a JSON-looking substring or otherwise turn an invalid response into an accepted one.
- No provider-side conversation memory, prompt-repair protocol, new queue, new service, global LM
  Studio setting, contract redesign, or model-assigned identity is authorized by this work.

## Important local-worktree note

At the time this artifact was created, `C:\Argus` contained user-owned uncommitted edits setting
`max_output_chars: 4096`, `max_output_tokens: 2048`, and
`max_total_context_tokens: 8192`. Do not build from that dirty checkout, discard those edits, or
include them accidentally in another commit. Each ticket starts from clean `origin/main`; SCRIBE-07C
formalizes the final accepted values above on its own branch. The coordinating agent will resolve
the user's local checkout after reviewed branches are ready to merge.

## Delivery order

1. Review and merge SCRIBE-06B independently.
2. Dispatch SCRIBE-07A from the then-current `origin/main`.
3. Review SCRIBE-07A for correctness and scope; merge it only if its exit gate passes.
4. Dispatch SCRIBE-07B from the updated `origin/main` containing SCRIBE-07A.
5. Review SCRIBE-07B for correctness and scope; merge it only if its exit gate passes.
6. Dispatch SCRIBE-07C from the updated `origin/main` containing SCRIBE-07B.
7. Review SCRIBE-07C for correctness and scope; merge it only if its exit gate passes.
8. Perform the short real LM Studio acceptance at the end of this document.

Do not run SCRIBE-07A, SCRIBE-07B, and SCRIBE-07C in parallel. Each branch starts from the reviewed
merge immediately before it, giving the low-reasoning agent one isolated behavior at a time.

## Rules for every implementation ticket

These rules are deliberately procedural so a low-reasoning agent can execute them without making
architectural judgments.

- [ ] Fetch `origin`, create an isolated worktree from the current `origin/main`, and create exactly
  the branch named by the ticket. Never work in `C:\Argus` directly.
- [ ] Confirm the worktree is clean and record the starting `origin/main` SHA before editing.
- [ ] Read this complete artifact, `contracts/scribe-contract-handoff.md`, and only the production
  files and focused tests named by the ticket or directly imported by them.
- [ ] Display the complete ticket checklist in the agent chat before editing and update only its
  status as work proceeds, per `C:\dustin-thomason\agents\skills\checklist-in-chat\SKILL.md`.
- [ ] Treat chat as a transient control surface, not the evidence record. Chat may contain checklist
  state, a blocking question, and the final branch/SHA/artifact pointer. Do not paste the ticket's
  WHY/HOW/WHAT analysis, changed-file evidence, test evidence, review findings, or delivery narrative
  into chat.
- [ ] Update this artifact's ticket checklist and evidence ledger on the implementation branch as
  work proceeds. A chat checkbox is never sufficient evidence that an item was completed.
- [ ] Use the existing service, request, validation, queue, and error mechanisms. Do not introduce
  a second mechanism for an existing responsibility.
- [ ] If a necessary production change falls outside the ticket's ownership, stop, record the exact
  file and reason in the ticket evidence ledger, send the notification, and ask only the concise
  blocking question plus artifact pointer in chat. Do not silently expand scope.
- [ ] Preserve unrelated behavior and retain existing contract fixtures and compatibility.
- [ ] Add focused regression evidence for the exact failure before claiming it is fixed.
- [ ] Review the diff for debug output, stale comments, magic state strings, dense mixed-concern
  handlers, removed safety guards without explanation, and ad hoc cross-cutting mechanisms. Apply
  only the portions of `C:\dustin-thomason\docs\reviewers\pr-review-patterns.md` that are relevant
  to this JavaScript repository and this ticket.
- [ ] Run the ticket's focused checks and the complete repository suite. Do not tune production
  behavior merely to satisfy a fixture.
- [ ] Commit and push only the ticket branch. Never merge `main` and never rebuild the installer.
- [ ] Verify the branch is clean and remote-aligned after pushing.
- [ ] Invoke
  `C:\dustin-thomason\scripts\notify-agent-complete.ps1 -Status "Completed" -Message "<5-9 word summary containing the agent name>"`
  after substantive completion or when blocked waiting for user direction.
- [ ] Stop after updating the artifact and posting the short chat pointer. The coordinating agent
  decides whether the branch is mergeable.

### Required artifact evidence record

All implementation and review evidence must be written into this artifact under the applicable
ticket's evidence-ledger section. Do not use the agent chat as the durable report.

Each ticket record must answer these three questions with code evidence:

- **WHY:** What measured failure from this artifact did the branch correct?
- **HOW:** What existing execution path was changed, and why is that the narrowest correct seam?
- **WHAT:** What behavior is now different and what behavior was explicitly preserved?

Then provide one row per changed file in the artifact:

| Changed file | Evidence that this file owned the failure | Exact reason it changed | Resulting behavior |
| --- | --- | --- | --- |

Assertions without a file, relevant symbol or line, and a concrete before/after behavior are not
review evidence. Also record the starting SHA, branch, full commit SHA, focused/full checks, push
confirmation, worktree status, and any remaining real-user acceptance in the artifact.

The final chat response must be short: checklist status, branch, full SHA, the heading or line where
the artifact evidence begins, and whether review is requested. It must not duplicate the evidence.

### Correctness evidence standard

**Every implementation must provide evidence that it is correct against the real work failure, not
merely evidence that a newly written test passes. A test proves only that its own scenario passes
until the artifact demonstrates that the scenario represents the actual production failure point.**

For every ticket, the artifact must therefore contain all of the following:

- [ ] The real-work observation that motivated the change: timestamped log evidence, captured
  provider request/response, persisted state, user-visible failure, or another concrete production
  artifact.
- [ ] The production execution path from that observation to the owning function, branch, state,
  or boundary. Name the files and symbols; do not infer ownership solely from a test filename.
- [ ] An explanation of why the regression enters that same production path and recreates the same
  failure mechanism. A copied helper, reimplemented algorithm, test-only shortcut, or assertion
  against a fabricated side path is not valid evidence.
- [ ] Evidence that the correction changes that production path while preserving the surrounding
  contracts and boundaries. State what would still fail if the fix were removed.
- [ ] A focused regression that fails for the production reason before the correction and passes
  after it. The failure message or assertion must distinguish the real defect from unrelated setup.
- [ ] Post-correction real-runtime evidence when the dependency is available. If physical hardware
  or the real provider is unavailable, record that acceptance as pending rather than replacing it
  with a mock and claiming completion.

A ticket can be reviewable with a real pre-fix trace, a verified production code path, and a valid
production-path regression. It cannot be declared fully accepted until any explicitly required
real-runtime check is recorded in this artifact.

## Review gate for every branch

The coordinating review determines whether the implementation is accurate against this artifact,
the actual codebase, and the Scribe architecture. It is not a second implementation pass.

- [ ] State in the artifact the ticket's WHY, the implementation's HOW, and whether the resulting
  WHAT is sufficient.
- [ ] Inspect every changed production file and its focused regression. Do not accept the agent's
  summary as evidence.
- [ ] Reject a test-only proof. Confirm the recorded real-work failure, production path, regression
  entry point, and corrected path describe the same mechanism.
- [ ] Write every finding into the applicable artifact review ledger as a checklist item with a file
  and line/symbol showing the evidence. In chat, report only the number of findings and point to the
  artifact section.
- [ ] Verify every changed file is necessary for the ticket. Treat unrelated cleanup,
  documentation churn, contract changes, and architectural improvements as scope violations.
- [ ] Verify the branch did not weaken identity, provenance, statelessness, failure visibility,
  provider neutrality, or the distinction between new evidence and background context.
- [ ] Compare applicable changes with
  `C:\dustin-thomason\docs\reviewers\pr-review-patterns.md`. `C:\Argus\.cursor\rules` did not
  exist when this artifact was written; if it exists at review time, read and apply its relevant
  rules rather than assuming them.
- [ ] Ignore product preference debates and do not demand unrelated live-data or smoke-test changes
  during the code review. Determine only whether the ticket was implemented correctly and within
  scope.
- [ ] Update the artifact with the merge verdict and reviewed commit SHA. Merge only when there is
  artifact evidence for each exit-gate item and no unresolved in-scope finding.

---

## SCRIBE-07A — Scribe-only structured output request

**Depends on:** SCRIBE-06B reviewed and merged

**Suggested branch:** `agent/scribe-structured-response`

**Exclusive production ownership:** `services/serial-ai-model-lane/` and the smallest shared Scribe
response-schema helper required by that service

**Focused test ownership:** existing serial-model-lane/model-adapter tests and narrowly added Scribe
provider-response tests

**Must not change:** Scribe context selection or limits, coordinator, persistence, Logged Item owner,
Whisper/audio, UI, provider settings, contracts/catalogs, global LM Studio configuration, other
workload request shapes, or installer artifacts

### Goal

Make each OpenAI-compatible Scribe batch request ask LM Studio for its existing governed JSON shape
while retaining Argus's existing parsing and post-parse validation. This ticket changes only the
outbound provider request; SCRIBE-07B owns response-content compatibility.

### Implementation checklist

- [ ] Capture the current OpenAI-compatible Scribe HTTP body in a focused endpoint test and prove it
  lacks `response_format` before the correction.
- [ ] In the SCRIBE-07A evidence ledger, connect that captured body to the real LM Studio requests
  recorded in the real-work baseline and to `requestConfiguredModel`; do not cite the test alone.
- [ ] Add `response_format.type: "json_schema"` with `strict: true` to the OpenAI-compatible HTTP
  body only when `isScribeBatchRequest(request)` is true.
- [ ] Describe the existing Scribe response shape in that provider request: fixed protocol and
  purpose, one batch identity object, zero-to-eight item objects, allowed item kinds, item text, and
  source segment IDs. Do not create a competing Argus response contract.
- [ ] Keep `validateScribeBatchModelResponse` as the authority after JSON parsing. Provider
  structured output supplements validation; it does not replace identity, provenance, limits, or
  exact batch comparison.
- [ ] Do not alter response-content parsing, Markdown handling, provider retry behavior, or error
  categories in this ticket.
- [ ] Prove with focused tests that the Scribe request carries `response_format` and a normal valid
  structured response still passes the existing Argus validator.
- [ ] Prove legacy extraction, classification enrichment, Ollama, and non-Scribe
  OpenAI-compatible requests retain their existing bodies and behavior.
- [ ] Run focused model-lane/Scribe tests, the complete repository suite, syntax checks, and
  `git diff --check`.
- [ ] Complete the SCRIBE-07A artifact evidence ledger, commit, push, notify, and stop for review.

### Exit gate

- [ ] Structured output is request-scoped to Scribe and cannot alter other LM Studio clients or
  Argus workloads.
- [ ] Existing parsing and all Argus response validation remain active and unchanged.
- [ ] No contract version, prompt instruction version, queue, provider setting, or global server
  setting changed.

---

## SCRIBE-07B — Exact fenced-JSON compatibility

**Depends on:** SCRIBE-07A reviewed and merged

**Suggested branch:** `agent/scribe-json-fence-compatibility`

**Exclusive production ownership:** OpenAI-compatible response-content parsing inside
`services/serial-ai-model-lane/`

**Focused test ownership:** existing serial-model-lane/model-adapter tests and one narrow fenced-
response regression

**Must not change:** the structured-output request from SCRIBE-07A, retry counts or prompt content,
Scribe contracts, context limits, coordinator, persistence, UI, provider settings, other workload
response shapes, or installer artifacts

### Goal

Accept the exact complete Markdown JSON wrapper seen in the real LM Studio response without weakening
strict JSON parsing or causing the same valid payload to be sent to the provider again.

### Implementation checklist

- [ ] Reproduce the measured failure: a valid governed Scribe JSON object wrapped by exactly one
  complete `json` Markdown fence currently becomes `MODEL_INVALID_JSON`.
- [ ] In the SCRIBE-07B evidence ledger, trace the real fenced response through
  `requestConfiguredModel` to the repeated provider call and explain why the regression enters that
  same parser and retry path.
- [ ] Add one small response-content normalizer that trims outer whitespace and unwraps exactly one
  complete Markdown fence whose optional language is `json`.
- [ ] Apply the normalizer only to the assistant message content before `JSON.parse`; do not alter
  the HTTP response envelope or the parsed Scribe object.
- [ ] Continue rejecting commentary plus JSON, partial fences, multiple fenced blocks, empty
  content, malformed JSON, schema-invalid JSON, altered batch identity, and fabricated provenance.
- [ ] Preserve `validateScribeBatchModelResponse` as the final authority after parsing.
- [ ] Prove the exact fenced valid response succeeds on the first provider call and therefore does
  not trigger the existing retry.
- [ ] Prove all rejected wrapper/prose cases remain rejected and ordinary unfenced JSON is unchanged.
- [ ] Run focused model-lane/Scribe tests, the complete repository suite, syntax checks, and
  `git diff --check`.
- [ ] Complete the SCRIBE-07B artifact evidence ledger, commit, push, notify, and stop for review.

### Exit gate

- [ ] The observed complete `json` fence is accepted without a repeated provider request.
- [ ] The parser does not extract JSON from prose or accept partial/multiple fenced content.
- [ ] Existing schema, identity, provenance, and limit validation remains unchanged.
- [ ] No retry policy, prompt, contract, queue, provider setting, or unrelated workload changed.

---

## SCRIBE-07C — Governed context/output limits and priority regression

**Depends on:** SCRIBE-07B reviewed and merged

**Suggested branch:** `agent/scribe-context-budget`

**Exclusive production ownership:** existing Scribe policy defaults, production Scribe policy
configuration, Scribe batch output-limit constants, context-budget assembly, directly corresponding
Scribe documentation/comments, and focused budget tests

**Must not change:** the response shape introduced by SCRIBE-07A, batching threshold of three rows,
15-second idle admission, statelessness, coordinator cursor/recovery, queue behavior, Logged Item
ownership, Whisper/audio, general AI provider settings, UI layout, or installer artifacts

### Goal

Formalize the accepted 32K-model operating profile and prove the existing semantic-memory priority:
new evidence always survives, prior Logged Items outrank raw transcript background, and the retained
request remains bounded and self-contained.

### Implementation checklist

- [ ] Begin from clean `origin/main` containing SCRIBE-07A and SCRIBE-07B. Do not copy or commit the
  dirty main checkout noted above.
- [ ] In the SCRIBE-07C evidence ledger, connect the 9,334/9,288-token real requests to
  `buildScribeBatchRequest`, coordinator background retention, and the production policy values;
  do not treat limit assertions by themselves as real-work evidence.
- [ ] Set every production Scribe default/configuration of `max_total_context_tokens` to `16384`.
  Remove stale statements that describe 8,000 as the current production default without rewriting
  unrelated architectural history.
- [ ] Set the governed batch output limits to exactly `max_items: 8`, `max_item_chars: 512`,
  `max_output_chars: 4096`, and `max_output_tokens: 2048`.
- [ ] Preserve the current mandatory floor: protected instruction/schema, optional immutable user
  guidance, complete new evidence, required request identity, and output reserve must fit or the
  request fails visibly.
- [ ] Preserve bounded coordinator history (currently at most 48 transcript segments and 64 prior
  Logged Items). Do not make either collection unbounded merely because the configured model has a
  larger window.
- [ ] Prove background selection removes complete oldest transcript segments before removing any
  prior Logged Item; only after transcript background is empty may complete oldest Logged Items be
  removed.
- [ ] Prove retained transcript segments and Logged Items remain chronologically ordered even
  though selection prefers newer entries.
- [ ] Prove the three current evidence rows remain byte-for-byte present and separate from
  background at every rollover boundary.
- [ ] Keep the existing provider-neutral estimator unless a focused failing regression proves a
  correctness defect. Label estimated values as estimates; do not add an LM-Studio-specific
  tokenizer dependency or provider call.
- [ ] Add focused tests for the accepted exact defaults, mandatory evidence, Logged-Item-first
  priority, oldest-unit rollover, chronological output, and an over-budget mandatory floor.
- [ ] Run focused Scribe context/extraction tests, the complete repository suite, contract checks
  only if a governed artifact was actually touched, syntax checks, and `git diff --check`.
- [ ] Complete the SCRIBE-07C artifact evidence ledger, commit, push, notify, and stop for review.

### Exit gate

- [ ] The governed production Scribe budget is consistently 16,384 tokens with the exact accepted
  output limits.
- [ ] Each request remains stateless, bounded, and visibly divided into new evidence and background.
- [ ] New evidence cannot roll off; prior Logged Items survive before raw transcript history; no
  background collection becomes unbounded.
- [ ] No provider-specific tokenizer, conversation state, second context store, response-contract
  redesign, or unrelated behavior was introduced.

---

## Ticket evidence ledger

Each implementation agent updates only its ticket subsection below. Each coordinating reviewer then
updates that ticket's review record on the same branch. Replace placeholders with concise evidence;
do not delete the fields. The artifact must make the branch understandable without reading the
agent chat.

### SCRIBE-07A evidence

#### Implementation record

- **Status:** Implemented, awaiting review
- **Starting `origin/main` SHA:** `89a9f66d02c7c36a56a04c70ee5f1bb87b3e5da3`
- **Branch:** `agent/scribe-structured-response`
- **Full implementation SHA:** `4a3d963e9cf4fc9b8799e127eaed49bf08f36230`
- **WHY:** At `2026-09-15 17:20:17` LM Studio returned a complete, valid governed Scribe batch
  JSON object wrapped in one Markdown ` ```json ` fence for a 9,288-`prompt_tokens` request.
  Argus's `requestConfiguredModel` (`services/serial-ai-model-lane/index.mjs`) passed the fenced
  string straight to `JSON.parse`, which threw, so the response was classified `MODEL_INVALID_JSON`
  even though the model's output was otherwise correct. At `17:20:56` Argus resent the identical
  retained batch and the model regenerated the same deterministic fenced result, repeating serial-
  lane work for no new outcome. Reading the pre-change `openai-compatible` request body (the
  branch inside `requestConfiguredModel`) confirmed it never asked the provider for enforced
  structured output at all — the body was exactly `{ model, stream, temperature, max_tokens,
  messages }` for every OpenAI-compatible request, Scribe batch or not. Requesting
  provider-enforced JSON output for the Scribe batch shape narrows how often the model wraps a
  valid answer in prose/fencing in the first place; SCRIBE-07B separately makes the parser
  tolerant of the one fence already observed.
- **HOW:** The narrowest correct seam is the single `openai-compatible` request-body branch inside
  `requestConfiguredModel` (`services/serial-ai-model-lane/index.mjs`), gated by the existing
  `isScribeBatchRequest(request)` predicate (already present, keyed off
  `request.protocol_version === SCRIBE_BATCH_PROTOCOL_VERSION`) — no new mechanism was invented to
  detect a Scribe batch request. When true, the body now also carries `response_format: {
  type: "json_schema", json_schema: { name: "scribe_batch_response", strict: true, schema:
  SCRIBE_BATCH_RESPONSE_JSON_SCHEMA } }`. `SCRIBE_BATCH_RESPONSE_JSON_SCHEMA` is a new export in
  `contracts/model-protocol.mjs` (the shared Scribe protocol module `requestConfiguredModel`
  already imports from), built only from the already-governed constants in that same file
  (`SCRIBE_BATCH_PROTOCOL_VERSION`, `SCRIBE_ITEM_KINDS`, `EXTRACTION_BATCH_OUTPUT_LIMITS`) and the
  required-key sets `validateScribeBatchIdentity`/`validateScribeProposedItem` already enforce. No
  second response contract was created.
- **WHAT:** Different: every OpenAI-compatible Scribe batch request now carries a
  `response_format` asking the provider to emit the governed shape directly. Preserved: every
  other OpenAI-compatible request (legacy `logged-item-extraction`, `classification-enrichment`)
  keeps its exact prior body with no `response_format` key; the `ollama` and
  `provider-neutral-json` protocol branches are untouched; `validateScribeBatchModelResponse`
  still performs full post-parse identity, provenance, limit, and exact-batch-comparison
  validation exactly as before — the new schema is intentionally looser (it cannot express
  "batch_identity must equal the request's" or the total output character/token ceilings), so it
  supplements rather than replaces the runtime validator. No Markdown-fence handling, retry
  behavior, prompt/instruction wording, contract version, or provider setting changed.
- **Real-work failure evidence:** The two real LM Studio requests recorded in this artifact's
  "Real-work evidence baseline" (`prompt_tokens: 9334` unfenced/accepted at 17:19:40;
  `prompt_tokens: 9288` fenced/rejected at 17:20:17; identical batch resent and re-regenerated at
  17:20:56), tied to `requestConfiguredModel` per that section's own production-inspection note.
- **Production path trace:** `services/serial-ai-model-lane/index.mjs` — `requestConfiguredModel`
  (body construction for `config.protocol === 'openai-compatible'`, now emitting
  `response_format` only under `isScribeBatchRequest(request)`) and the new
  `scribeBatchResponseFormat()` helper beside it. Schema source: `contracts/model-protocol.mjs` —
  new `SCRIBE_BATCH_RESPONSE_JSON_SCHEMA` export, alongside the pre-existing
  `SCRIBE_BATCH_PROTOCOL_VERSION`, `SCRIBE_ITEM_KINDS`, `EXTRACTION_BATCH_OUTPUT_LIMITS`, and
  `validateScribeBatchModelResponse` it mirrors.
- **Why the regression represents that production failure:** `tests/scribe-structured-response.test.mjs`'s
  first test dispatches a real `ai.work-request`/`ai.provider-configure` pair through the actual
  `serial-ai-model-lane` service process (`runService(laneManifest, ...)`), the same
  `requestConfiguredModel` code path a real LM Studio batch traverses, and inspects the literal
  HTTP body a mock OpenAI-compatible endpoint received — not a copied helper or a reimplemented
  request builder. Before the fix this assertion fails because `response_format` is `undefined`
  (verified directly, see below); after the fix it is the exact governed schema.
- **Post-correction real-runtime evidence:** Pending — deferred to the coordinator's final real
  LM Studio acceptance step (this artifact's "Final real LM Studio acceptance" section). No live
  LM Studio endpoint is available in this worktree; nothing here fabricates that check.

| Changed file | Evidence that this file owned the failure | Exact reason it changed | Resulting behavior |
| --- | --- | --- | --- |
| `services/serial-ai-model-lane/index.mjs` | `requestConfiguredModel`'s `openai-compatible` branch is the exact function production inspection (this artifact, "Real-work evidence baseline") named as building the body LM Studio received without `response_format`. | Add `response_format` to the OpenAI-compatible HTTP body, gated by the existing `isScribeBatchRequest(request)` predicate, plus the new `scribeBatchResponseFormat()` helper. | Only Scribe batch OpenAI-compatible requests now ask the provider for enforced `json_schema` output; every other request body (legacy extraction, classification, ollama, provider-neutral-json) is byte-identical to before. |
| `contracts/model-protocol.mjs` | This is the sole existing home of the governed Scribe batch response shape (`SCRIBE_BATCH_PROTOCOL_VERSION`, `SCRIBE_ITEM_KINDS`, `EXTRACTION_BATCH_OUTPUT_LIMITS`, `validateScribeBatchModelResponse`) that `services/serial-ai-model-lane/index.mjs` already imports from — the smallest shared helper location the ticket's ownership names. | Add `SCRIBE_BATCH_RESPONSE_JSON_SCHEMA`, a JSON Schema description derived from those same constants, for the model lane to hand to the provider. | A new, additive export; no existing export, validator, or fixture changed. |
| `tests/scribe-structured-response.test.mjs` (new) | N/A — new focused test file. | Prove the Scribe-only `response_format` addition, prove a valid structured response still passes `validateScribeBatchModelResponse`, and prove legacy extraction/classification/provider-neutral-json/ollama bodies are unaffected. | Four passing focused tests; the first was confirmed failing against the pre-change code (see Verification). |

| Verification | Command or evidence source | Result |
| --- | --- | --- |
| Pre-fix regression check | `git stash push -u` the production diff, then `node --test tests/scribe-structured-response.test.mjs` | First test failed exactly as expected: `AssertionError`, `actual: undefined` vs `expected: { type: 'json_schema', ... }` on `sentBody.response_format` — confirms the regression enters the real pre-fix defect, not a fabricated side path. Change restored via `git stash apply`/`git stash drop` afterward. |
| Focused regression | `node --test tests/scribe-structured-response.test.mjs` | 4 pass, 0 fail. |
| Focused model-lane/Scribe suites | `node --test tests/phase5b-model-adapter.test.mjs tests/scribe-model-extraction.test.mjs tests/scribe-contracts.test.mjs tests/contract-governance.test.mjs` | 87 pass, 0 fail. |
| Complete suite | `npm test` (`node --test tests/*.test.mjs`) | 389 pass, 7 skipped (pre-existing `tests/scribe-real-acceptance.test.mjs` live-LM-Studio-only tests, unrelated to this change), 0 fail. |
| Syntax | `node --check contracts/model-protocol.mjs`, `node --check services/serial-ai-model-lane/index.mjs`, `node --check tests/scribe-structured-response.test.mjs` | All pass. |
| Diff whitespace | `git diff --check` | Clean. |
| Push/worktree | `git status` clean after commit; branch `agent/scribe-structured-response` created from `origin/main` at `89a9f66`; `git push -u origin agent/scribe-structured-response` | Pushed; `HEAD` and `origin/agent/scribe-structured-response` both at `4a3d963e9cf4fc9b8799e127eaed49bf08f36230`; worktree clean |

- **Remaining acceptance or limitation:** Real LM Studio runtime acceptance (does LM Studio
  actually honor `response_format` for this model/config, and does it reduce the observed fenced-
  response rate) is pending and explicitly deferred to the coordinator's final acceptance step —
  no live provider was available in this worktree. SCRIBE-07B (response-content fenced-JSON
  compatibility) is intentionally out of scope here and remains a separate, subsequent failure
  mode: a fenced response is now less likely but not yet structurally impossible to receive from
  an OpenAI-compatible provider that only partially honors `strict` structured output.

#### Review record

- **Review status:** Reviewed
- **Reviewed full SHA:** `f815c9124a7a8c80a110725ff5c9a81a4595327f` (branch tip of `agent/scribe-structured-response`, `origin/main` under it at `89a9f66`)
- **Scope verdict:** Pass — `git diff --stat origin/main...origin/agent/scribe-structured-response` shows exactly `contracts/model-protocol.mjs`, `services/serial-ai-model-lane/index.mjs`, `tests/scribe-structured-response.test.mjs` (new), and this evidence-ledger doc. No coordinator, persistence, UI, provider-settings, contracts-version, or installer files touched.
- **Correctness verdict:** Pass — independently reverted only `services/serial-ai-model-lane/index.mjs` to pre-change state and confirmed the focused test fails for the real reason (`response_format` `actual: undefined`); restored and confirmed 4/4 pass. `response_format` gating confirmed to reuse the pre-existing `isScribeBatchRequest` predicate with no second detection mechanism; `SCRIBE_BATCH_RESPONSE_JSON_SCHEMA` confirmed built only from already-governed constants; `validateScribeBatchModelResponse` confirmed byte-unchanged.
- **Real-work failure coverage verdict:** Pass — production path (`requestConfiguredModel`'s `openai-compatible` body construction) traced directly to the 17:20:17/17:20:56 real-work baseline; regression exercises the real service process (`runService`) against a mock endpoint, not a copied helper.

| Finding | File and line/symbol evidence | Required disposition | Resolution |
| --- | --- | --- | --- |
| Full-suite result in the implementation record ("389 pass, 7 skipped, 0 fail") does not reproduce in the reviewer's environment | `tests/phase8-permissions-packaging.test.mjs:353` | Non-blocking — verify pre-existing on unmodified `origin/main` | Confirmed: the same failure reproduces identically on a clean `origin/main` worktree, unrelated to this branch's diff (a Windows filesystem-permission-scoping flake). Not a merge blocker; ledger's "0 fail" claim should read "1 pre-existing unrelated failure" for accuracy. |
| Provider-facing JSON Schema marks `kind` as `required` while the runtime validator `validateScribeProposedItem` treats `kind` as optional | `contracts/model-protocol.mjs` — new schema `required: ['text','kind','source_segment_ids']` vs `validateScribeProposedItem`'s `if (item.kind !== undefined ...)` | Non-blocking — note asymmetry | A stricter provider-facing schema than the runtime validator can only reduce malformed responses; the runtime validator remains authoritative. No action required. |

- **Merge verdict:** MERGE — approved to merge to `origin/main` once the coordinator resolves the branch chain (07A → 07B → 07C).
- **Merged SHA:** Not yet merged to `origin/main` (coordinator is chaining ticket branches; see SCRIBE-07C's evidence for the full chained state).

### SCRIBE-07B evidence

#### Implementation record

- **Status:** Implemented, awaiting review
- **Starting SHA:** `f815c9124a7a8c80a110725ff5c9a81a4595327f` — this is **SCRIBE-07A's branch tip**
  (`agent/scribe-structured-response`), not `origin/main`. Per the coordinator's chaining
  instruction, SCRIBE-07B was dispatched directly from SCRIBE-07A's reviewed-but-not-yet-merged
  branch (`origin/main` under it is `89a9f66d02c7c36a56a04c70ee5f1bb87b3e5da3`, which already
  includes merged SCRIBE-06B).
- **Branch:** `agent/scribe-json-fence-compatibility`
- **Full implementation SHA:** `8facffdd7b7eef1ceaaba7b9af6a63faaf430729`
- **WHY:** At `2026-09-15 17:20:17` LM Studio returned a complete, valid governed Scribe batch JSON
  object wrapped in exactly one Markdown ` ```json ` fence for a 9,288-`prompt_tokens` request. The
  fenced string reached `requestConfiguredModel`'s `openai-compatible` response branch
  (`services/serial-ai-model-lane/index.mjs`), where `JSON.parse(String(content || ''))` was handed
  the fence delimiters themselves and threw, so the response was classified `MODEL_INVALID_JSON`
  even though the model's answer was otherwise correct. At `17:20:56` Argus resent the identical
  retained batch and the model regenerated the same deterministic fenced result, repeating serial-
  lane work for no new outcome. SCRIBE-07A (already on this branch) narrows how often the provider
  wraps a valid Scribe answer in the first place by requesting `response_format`; it explicitly left
  response-content parsing untouched for this ticket to own.
- **HOW:** The narrowest correct seam is the one line inside `requestConfiguredModel`'s
  `openai-compatible` branch that turns the assistant message's `content` string into the parsed
  object before `JSON.parse`. A single new helper, `unwrapScribeJsonFence(content)`, is applied to
  that string — and only that string, only when `isScribeBatchRequest(request)` is true (the same
  existing predicate SCRIBE-07A gates `response_format` on, so no second detection mechanism was
  introduced) — immediately before `JSON.parse`. It trims outer whitespace, then matches the
  anchored pattern `^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```$` against the trimmed string: only a
  fence that starts at the very first character and closes at the very last character (i.e.
  "exactly one complete fence", not a partial one, not one followed or preceded by prose) unwraps to
  its inner text. If the unwrapped interior still contains a `` ``` `` delimiter, the original,
  untouched string is returned instead — this is what rejects two fenced blocks that would otherwise
  satisfy the outer anchors by having the non-greedy capture swallow everything between the first
  block's close and the second block's close. Every other input (no fence, partial fence, fence
  preceded/followed by commentary) is returned completely unchanged, so it still fails `JSON.parse`
  exactly as before. Legacy extraction, classification enrichment, ollama, and provider-neutral-json
  requests never call this helper at all, since `isScribeBatchRequest` is false for them.
- **WHAT:** Different: an OpenAI-compatible Scribe batch response whose entire trimmed content is
  one complete Markdown JSON fence (with no language tag or the `json` tag) is now parsed
  successfully instead of raising `MODEL_INVALID_JSON`, and — because it now parses to a
  schema-valid object — is accepted on the very first provider call, so the existing retry is never
  spent re-sending the identical deterministic batch. Preserved: commentary preceding or following a
  fence, a fence missing its closing delimiter, two or more fenced blocks, and empty/malformed
  content all remain rejected as `MODEL_INVALID_JSON` exactly as before; ordinary unfenced JSON is
  returned byte-for-byte unchanged (trimming a string that was already valid JSON does not change
  what `JSON.parse` produces); `validateScribeBatchModelResponse` still runs unmodified after
  parsing and is still the sole authority on identity, provenance, item limits, and exact-batch
  comparison — a fenced response missing `batch_identity` (or otherwise schema-invalid) now parses
  but is still rejected by that validator, as `INVALID_MODEL_OUTPUT` instead of `MODEL_INVALID_JSON`
  (see the updated `tests/scribe-model-extraction.test.mjs` case below). No retry count, prompt
  text, contract version, queue, provider setting, or non-Scribe workload changed.
- **Real-work failure evidence:** The `17:20:17` fenced/rejected request and the `17:20:56`
  identical-batch resend recorded in this artifact's "Real-work evidence baseline", tied to
  `requestConfiguredModel` per that section's own production-inspection note, and already cited
  verbatim in the SCRIBE-07A evidence above as the shared baseline both tickets correct.
- **Production path trace:** `services/serial-ai-model-lane/index.mjs` —
  `requestConfiguredModel`'s `config.protocol === 'openai-compatible'` response branch (the
  `const content = parsed.choices?.[0]?.message?.content; ... return JSON.parse(...)` lines), the
  new `unwrapScribeJsonFence()` helper defined immediately beside `scribeBatchResponseFormat()`, and
  the existing `isScribeBatchRequest(request)` predicate reused to gate it. Post-parse authority:
  `contracts/model-protocol.mjs` — `validateScribeBatchModelResponse` (unmodified).
- **Why the regression represents that production failure:** The new focused test in
  `tests/scribe-model-extraction.test.mjs`, `'an exact complete Markdown json-fenced valid batch
  response is accepted on the first call and never triggers a retry'`, dispatches a real
  `ai.work-request`/`ai.provider-configure` pair through the actual `serial-ai-model-lane` service
  process (`runService(laneManifest, ...)`) against a mock OpenAI-compatible endpoint
  (`startScribeBatchModelEndpoint`) that returns `{ choices: [{ message: { content: '```json\n' +
  <the exact governed batch object> + '\n```' } }] }` — the identical wire shape and the identical
  `requestConfiguredModel` code path a real LM Studio fenced batch response traverses, not a copied
  helper or a reimplemented parser. Verified directly against the pre-fix code (see Verification
  below): with the fix reverted, this test fails with `status: 'failed'` (not `'succeeded'`) because
  the lane still raises `MODEL_INVALID_JSON` on the fenced string, which is the same failure
  mechanism the real 17:20:17 request hit. The pre-existing `'markdown-fenced JSON'` case in the same
  file's `'commentary, malformed JSON, ...'` table also flips: before the fix it asserted
  `MODEL_INVALID_JSON` for a complete fence (proving the regression was already represented in the
  suite); after the fix that same fence parses, and the case was updated to assert
  `INVALID_MODEL_OUTPUT` because its payload happens to omit `batch_identity`, demonstrating parsing
  succeeded while the runtime validator remained the final authority.
- **Post-correction real-runtime evidence:** Pending — deferred to the coordinator's final real LM
  Studio acceptance step (this artifact's "Final real LM Studio acceptance" section), same as
  SCRIBE-07A. No live LM Studio endpoint is available in this worktree; nothing here fabricates that
  check.

| Changed file | Evidence that this file owned the failure | Exact reason it changed | Resulting behavior |
| --- | --- | --- | --- |
| `services/serial-ai-model-lane/index.mjs` | `requestConfiguredModel`'s `openai-compatible` response branch is the exact function/branch production inspection (this artifact, "Real-work evidence baseline") named as passing the fenced string straight to `JSON.parse`. | Added `unwrapScribeJsonFence(content)`, applied to the assistant message content only for Scribe batch requests (`isScribeBatchRequest(request)`), only before `JSON.parse`, trimming outer whitespace and unwrapping exactly one complete optional-`json` Markdown fence. | A complete, exactly-one `json`-fenced Scribe response now parses instead of raising `MODEL_INVALID_JSON`; partial fences, multiple fenced blocks, commentary-plus-fence, empty content, and every non-Scribe request body/response are byte-for-byte unaffected. |
| `tests/scribe-model-extraction.test.mjs` | Already owned the pre-existing `'markdown-fenced JSON'` case asserting `MODEL_INVALID_JSON` for a complete fence — the exact expectation this ticket's fix inverts. | Updated that case's expected code to `INVALID_MODEL_OUTPUT` (its payload lacks `batch_identity`, so parsing now succeeds but the runtime validator still rejects it) and added four new rows/tests: the real 17:20:17 exact-fence acceptance-and-no-retry case, commentary-preceding-a-complete-fence, a fence missing its closing delimiter, and two fenced blocks — all still `MODEL_INVALID_JSON`. | The suite proves the exact observed regression is fixed and that every rejected wrapper/prose shape named by the ticket remains rejected. |

| Verification | Command or evidence source | Result |
| --- | --- | --- |
| Pre-fix regression check | `git stash push -u -m scribe-07b-prefix-check-tmp -- services/serial-ai-model-lane/index.mjs`, then `node --test tests/scribe-model-extraction.test.mjs`, then `git stash apply <captured-sha>` + `git stash drop <captured-sha>` (never bare `git stash pop`, per this worktree's shared-stash rule) | Two failures, both for the expected production reason: the pre-existing `'markdown-fenced JSON'` case asserted `MODEL_INVALID_JSON` (actual) vs the fix's `INVALID_MODEL_OUTPUT` (expected); the new no-retry test asserted `status: 'failed'` (actual) vs `'succeeded'` (expected). Every other case in the file still passed unmodified (23/25). Fix restored afterward; worktree clean. |
| Focused regression | `node --test tests/scribe-model-extraction.test.mjs` | 25 pass, 0 fail (post-fix). |
| Focused model-lane/Scribe suites | `node --test tests/phase5b-model-adapter.test.mjs tests/scribe-model-extraction.test.mjs tests/scribe-structured-response.test.mjs tests/scribe-contracts.test.mjs tests/contract-governance.test.mjs` | 92 pass, 0 fail. |
| Complete suite | `npm test` (`node --test tests/*.test.mjs`) | 390 pass, 7 skipped (same pre-existing live-LM-Studio-only tests in `tests/scribe-real-acceptance.test.mjs` noted in the SCRIBE-07A ledger), 0 fail. |
| Syntax | `node --check services/serial-ai-model-lane/index.mjs`, `node --check tests/scribe-model-extraction.test.mjs` | Both pass. |
| Diff whitespace | `git diff --check` | Clean. |
| Push/worktree | `git status` clean after commit; branch `agent/scribe-json-fence-compatibility` created from `origin/agent/scribe-structured-response` at `f815c91`; `git push -u origin agent/scribe-json-fence-compatibility` | Pushed; `HEAD` and `origin/agent/scribe-json-fence-compatibility` both at `8facffdd7b7eef1ceaaba7b9af6a63faaf430729`; worktree clean. |

- **Remaining acceptance or limitation:** Real LM Studio runtime acceptance (does the exact fence
  the model actually emits match this normalizer's "exactly one complete fence" shape in practice,
  and does the observed repeated-work failure stop recurring) is pending and explicitly deferred to
  the coordinator's final acceptance step — no live provider was available in this worktree.
  SCRIBE-07C (governed context/output limits) is intentionally out of scope here and remains
  unaffected: this ticket touched no context budget, policy default, or limit constant.

#### Review record

- **Review status:** Reviewed
- **Reviewed full SHA:** `8facffdd7b7eef1ceaaba7b9af6a63faaf430729` (branch tip of `agent/scribe-json-fence-compatibility`, chained on `agent/scribe-structured-response` tip `f815c91`)
- **Scope verdict:** Pass — diff between the two branch tips touches exactly `services/serial-ai-model-lane/index.mjs`, `tests/scribe-model-extraction.test.mjs`, and this evidence-ledger doc. `contracts/model-protocol.mjs` and `validateScribeBatchModelResponse` confirmed byte-unchanged. No retry-count, prompt, contract, coordinator, persistence, UI, or provider-settings files touched.
- **Correctness verdict:** Pass — `unwrapScribeJsonFence`'s anchored regex hand-traced against all required rejection cases (commentary-preceding-fence fails the `^` anchor, missing-closing-fence fails the `$` anchor, two fenced blocks caught by the `inner.includes('```')` guard) — these are structural guarantees, not incidental to the test fixtures. Independently reverted the one production line and confirmed the focused tests fail for the real reason (`MODEL_INVALID_JSON`/`status:'failed'`); restored and confirmed 25/25 pass. The "no retry triggered" claim verified against real attempt-counted harness code (`executor: async (work, {attempt}) => {...}`), not a mock incapable of failing.
- **Real-work failure coverage verdict:** Pass — production path (`requestConfiguredModel`'s response-parsing branch) traced directly to the 17:20:17 fenced-response/17:20:56 repeated-work baseline shared with SCRIBE-07A.

| Finding | File and line/symbol evidence | Required disposition | Resolution |
| --- | --- | --- | --- |
| None | — | — | — |

- **Merge verdict:** MERGE — approved to merge to `origin/main` once the coordinator resolves the branch chain (07A → 07B → 07C).
- **Merged SHA:** Not yet merged to `origin/main` (coordinator is chaining ticket branches).

### SCRIBE-07C evidence

#### Implementation record

- **Status:** Implemented, awaiting review
- **Starting SHA:** `050887a` — this is **SCRIBE-07B's branch tip** (`agent/scribe-json-fence-compatibility`),
  not `origin/main` directly, per the coordinator's chaining instruction (`origin/main` under it is
  `89a9f66d02c7c36a56a04c70ee5f1bb87b3e5da3`, which already includes merged SCRIBE-06B; SCRIBE-07A's
  tip is `4a3d963e9cf4fc9b8799e127eaed49bf08f36230` and SCRIBE-07B's tip/full SHA is
  `8facffdd7b7eef1ceaaba7b9af6a63faaf430729`, both already in this branch's history).
- **Branch:** `agent/scribe-context-budget`
- **Full implementation SHA:** `f56028a33636600ae7e3769bac32bdee8428ba5f`
- **WHY:** The real-work baseline (this artifact, "Real-work evidence baseline") measured LM Studio
  `prompt_tokens: 9334` and `prompt_tokens: 9288` for stateless Scribe batch requests against a
  model configured with a 32,000-token context window, while the configured production budget was
  only ~8,000 tokens end to end: `wiring/production-electron.json`'s
  `run.configuration.scribe_policy.context.max_total_context_tokens` was `8000`, the coordinator's
  own fallback `DEFAULT_POLICY.context.max_total_context_tokens`
  (`services/scribe-coordinator/coordinator.mjs`) was `8000`, the extraction boundary's exported
  `SCRIBE_POLICY_DEFAULT_TOTAL_CONTEXT_TOKENS`
  (`services/log-extractor-local-http/scribe-batch-boundary.mjs`) was `8000`, and the governed
  policy schema's declared default (`contracts/scribe-batch-policy.schema.json`,
  `context.max_total_context_tokens.default`) was also `8000`. The accepted operating profile
  formalizes a single 16,384-token budget across every one of those four locations, plus the
  governed batch output ceilings (`EXTRACTION_BATCH_OUTPUT_LIMITS` in `contracts/model-protocol.mjs`)
  at exactly `max_items: 8`, `max_item_chars: 512`, `max_output_chars: 4096`, `max_output_tokens: 2048`.
- **HOW:** No new budget-assembly or retention mechanism was introduced. The narrowest correct seam
  is the existing, single set of governed constants that `buildScribeBatchRequest`
  (`services/log-extractor-local-http/scribe-batch-boundary.mjs`) and the coordinator's bounded
  background retention (`services/scribe-coordinator/coordinator.mjs`,
  `MAX_BACKGROUND_TRANSCRIPT_SEGMENTS = 48`, `MAX_BACKGROUND_LOGGED_ITEMS = 64`, both left unchanged
  and unbounded-checked) already read: `EXTRACTION_BATCH_OUTPUT_LIMITS` in
  `contracts/model-protocol.mjs`, `SCRIBE_POLICY_DEFAULT_TOTAL_CONTEXT_TOKENS` in the extraction
  boundary, the coordinator's `DEFAULT_POLICY`, the production graph's
  `wiring/production-electron.json` policy configuration, and the governed
  `contracts/scribe-batch-policy.schema.json` default. Each of the four token-budget locations and
  the batch output-limit constant were updated to the exact accepted numeric values; the mandatory
  floor, oldest-unit-first rollover (transcript before Logged Items), and chronological-order
  preservation logic already inside `buildScribeBatchRequest` were read and left completely
  unmodified, since they are budget-value-agnostic and already implement the accepted priority
  rule.
- **WHAT:** Different: every governed Scribe context/output-limit default is now `16384` /
  `{max_items: 8, max_item_chars: 512, max_output_chars: 4096, max_output_tokens: 2048}` instead of
  `8000` / `{..., max_output_chars: 2048, max_output_tokens: 512}`. Preserved: statelessness, the
  three-row batching threshold, the 15-second idle admission, the coordinator's bounded background
  retention ceilings (48/64, unchanged), the mandatory floor (protected instruction/schema +
  optional immutable guidance + complete new evidence + identity + output reserve must fit or the
  dispatch fails visibly), oldest-complete-unit-first rollover with transcript exhausted before any
  Logged Item is touched, chronological ordering of surviving background, and the provider-neutral
  `estimateModelTokens` (`ceil(text.length / 4)`) — untouched, no defect found in it, no
  LM-Studio-specific tokenizer added.
- **Real-work failure evidence:** The `2026-09-15 17:19:40` (`prompt_tokens: 9334`) and
  `2026-09-15 17:20:17` (`prompt_tokens: 9288`) real LM Studio requests recorded in this artifact's
  "Real-work evidence baseline", both measured against a model configured with a 32,000-token
  context window while every governed production budget was ~8,000 tokens.
- **Production path trace:** `wiring/production-electron.json` →
  `run.configuration.scribe_policy.context.max_total_context_tokens` (the real production graph's
  configured budget, read by `tests/scribe-production-integration.test.mjs`) →
  `services/scribe-coordinator/coordinator.mjs` (`DEFAULT_POLICY`, the coordinator's own fallback
  when no policy is yet configured for a session, and `MAX_BACKGROUND_TRANSCRIPT_SEGMENTS` /
  `MAX_BACKGROUND_LOGGED_ITEMS`, the bounded retention the extraction boundary's background pool is
  built from) → `services/log-extractor-local-http/scribe-batch-boundary.mjs`
  (`SCRIBE_POLICY_DEFAULT_TOTAL_CONTEXT_TOKENS`, `buildScribeBatchRequest`'s mandatory-floor and
  oldest-unit-first rollover loop, which is the same production function every real Scribe dispatch
  calls) → `contracts/model-protocol.mjs` (`EXTRACTION_BATCH_OUTPUT_LIMITS`, the output reserve
  `buildScribeBatchRequest` subtracts from the budget and the ceiling
  `validateScribeBatchModelResponse` enforces on every real model response) →
  `contracts/scribe-batch-policy.schema.json` (the governed contract declaring the accepted
  default for any policy source that omits an explicit value).
- **Why the regression represents that production failure:** The new focused test file
  `tests/scribe-context-budget.test.mjs` reads the actual `wiring/production-electron.json` file
  and the actual `contracts/scribe-batch-policy.schema.json` file from disk (not a copied fixture)
  and imports the real `SCRIBE_POLICY_DEFAULT_TOTAL_CONTEXT_TOKENS` and
  `EXTRACTION_BATCH_OUTPUT_LIMITS` exports directly from the production modules
  `buildScribeBatchRequest` and `validateScribeBatchModelResponse` are built from - the same symbols
  those production functions read, not a reimplementation. Its second test constructs the
  coordinator's own real bounded worst-case background shape (48 transcript segments, 64 prior
  Logged Items - `services/scribe-coordinator/coordinator.mjs`'s own
  `MAX_BACKGROUND_TRANSCRIPT_SEGMENTS`/`MAX_BACKGROUND_LOGGED_ITEMS` ceilings) and dispatches it
  through the real `buildScribeBatchRequest`, first at the prior `8000`-token default (proving that
  budget was too small to hold the bounded worst case without rolling background off - the same
  failure mechanism the real 9,334/9,288-token requests hit) and then at the formalized `16384`
  default (proving the same batch now fits with zero rollover). A third test drives an over-budget
  new-evidence batch through the real mandatory-floor check at the literal `16384` default and
  asserts the exact `SCRIBE_BATCH_BUDGET_EXCEEDED` failure message, including "governed budget is
  16384".
- **Post-correction real-runtime evidence:** Pending — deferred to the coordinator's final real LM
  Studio acceptance step (this artifact's "Final real LM Studio acceptance" section), same as
  SCRIBE-07A/07B. No live LM Studio endpoint is available in this worktree; nothing here fabricates
  that check. In particular, whether the real 32K-context model's actual `prompt_tokens` for a
  worst-case bounded batch (48/64 background) lands safely under 16,384 in practice - not merely
  under Argus's provider-neutral `ceil(chars/4)` estimate - can only be confirmed against a live
  provider.

| Changed file | Evidence that this file owned the failure | Exact reason it changed | Resulting behavior |
| --- | --- | --- | --- |
| `contracts/model-protocol.mjs` | Sole existing home of `EXTRACTION_BATCH_OUTPUT_LIMITS`, the governed batch output ceilings `buildScribeBatchRequest`'s output reserve and `validateScribeBatchModelResponse`'s response validation both read. | `max_output_chars` 2048→4096, `max_output_tokens` 512→2048 (the ticket's accepted exact values); `max_items`/`max_item_chars` were already 8/512 and are unchanged. Stale `~8000-token policy budget` comment reworded to the accepted 16,384 figure. | Every Scribe batch output-limit consumer (instruction text, structured-output JSON schema, response validator, extraction boundary's output reserve) now enforces the accepted ceilings via the one shared constant; no second limits constant was introduced. |
| `services/log-extractor-local-http/scribe-batch-boundary.mjs` | Owns `SCRIBE_POLICY_DEFAULT_TOTAL_CONTEXT_TOKENS`, the extraction boundary's own governed default, and `buildScribeBatchRequest`, the real production request-assembly function the real 9,334/9,288-token requests traversed. | Default token budget 8000→16384; stale `~8,000-token policy` comment on the `total_tokens` budget field reworded to reference the accepted 16,384 figure (SCRIBE-07C). | Any caller that does not supply an explicit policy total now gets the formalized 16,384-token default; the mandatory-floor, oldest-unit-first rollover, and serialized-request accounting logic are untouched. |
| `services/scribe-coordinator/coordinator.mjs` | Owns `DEFAULT_POLICY`, the coordinator's own fallback Scribe policy used before an explicit `scribe.batch-policy` is configured for a session. | `context.max_total_context_tokens` 8000→16384, matching every other governed default. | The coordinator's fallback policy (rarely exercised in production, since `wiring/production-electron.json` always configures an explicit policy first) is no longer a stale 8,000-token value; `MAX_BACKGROUND_TRANSCRIPT_SEGMENTS`/`MAX_BACKGROUND_LOGGED_ITEMS` (48/64) are explicitly unchanged and still bound retention. |
| `wiring/production-electron.json` | The actual production Electron graph configuration; `tests/scribe-production-integration.test.mjs` reads this exact file to assert the real production Scribe defaults. | `run.configuration.scribe_policy.context.max_total_context_tokens` 8000→16384 (the ticket's accepted production default). | The real production graph now dispatches every Scribe batch under the formalized 16,384-token budget instead of the stale ~8,000-token one. |
| `contracts/scribe-batch-policy.schema.json` | The governed contract schema declaring `context.max_total_context_tokens`'s accepted default (`minimum: 256`, `maximum: 32000`). | `default` 8000→16384, matching the other three governed default locations. | Any policy source that omits an explicit `max_total_context_tokens` (and is validated against this schema) now defaults to the accepted 16,384, not the stale 8,000; `minimum`/`maximum` bounds (unrelated to this ticket) are unchanged. |
| `contracts/scribe-contract-handoff.md` | Directly corresponding Scribe documentation describing the governed policy defaults (`rows_per_batch`, `idle_timeout_ms`, `max_total_context_tokens`) for implementers of SCRIBE-02/03/04. | Reworded the "Idle timer and 8,000-token accounting" heading/prose to the accepted "16,384-token accounting", citing SCRIBE-07C. | Documentation no longer describes 8,000 as the current governed default; the `limits` construction description elsewhere in the same file (extraction-boundary-owned, no literal number) is unchanged. |
| `tests/scribe-production-integration.test.mjs` | Asserts `policy.context` read directly from `wiring/production-electron.json`'s real production graph. | Updated expected `max_total_context_tokens` 8000→16384 to match the corrected production wiring; otherwise this test is unrelated to SCRIBE-07C and untouched. | The real production-graph integration test continues to pass against the corrected, formalized default instead of asserting the stale one. |
| `tests/scribe-model-extraction.test.mjs` | Owns the existing focused budget/rollover/mandatory-floor tests for `buildScribeBatchRequest`, all parameterized by the shared `EXTRACTION_BATCH_OUTPUT_LIMITS` constant. | (1) Reworded three comments/titles that called this test file's own arbitrary 8,000-token *test* fixture budget "the governed default", since the real governed default is now a different, formalized 16,384 (the test's own budget is intentionally left at 8,000 as a stable arbitrary fixture value, not tied to production). (2) The pre-existing "oversized batch output" failure case is no longer reachable now that `max_output_chars` (4096) exactly equals `max_items * max_item_chars` (8 * 512 = 4096) — a response respecting the per-item and item-count ceilings can never independently exceed the total-character ceiling anymore. Removed that unreachable case (with an explanatory comment) and added a new passing-side test proving the exact per-item/per-count ceiling (8 items at 512 chars each = 4096 total chars) is accepted, not rejected. (3) The pre-existing mandatory-floor guidance test in `scribe-user-guidance.test.mjs` (see below) needed the same output-reserve-constant fix; noted together here since both stem from the same `max_output_tokens` 512→2048 change. | Focused budget/rollover/mandatory-floor coverage for `buildScribeBatchRequest` continues to pass and accurately reflects the new governed constants; the now-provably-unreachable total-character-ceiling failure case was replaced with an accurate boundary-acceptance test instead of silently left to fail or silently deleted without explanation. |
| `tests/scribe-user-guidance.test.mjs` | Owns the mandatory-floor guidance test, which hard-coded the prior `max_output_tokens` value (512) inline to compute a budget that fits the instruction and output reserve but not evidence/guidance. | Replaced the hard-coded `512` with `EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens` (now 2048), and reworded one stale `~8,000-token policy` comment to clarify it is this test's own fixture budget, not the current production default. | The mandatory-floor rejection test again reaches the intended `SCRIBE_BATCH_BUDGET_EXCEEDED` / "guidance are never truncated" branch instead of failing one check earlier at the output-reserve branch, which is what the output-limit constant change had shifted it into. |
| `tests/scribe-context-budget.test.mjs` (new) | N/A — new focused test file for SCRIBE-07C. | Added to prove: (1) the four exact accepted defaults are wired into the extraction boundary export, production wiring, the policy schema, and the output limits constant; (2) the coordinator's real bounded worst-case background (48/64) exceeds the prior 8,000-token default (with transcript rolling off before any Logged Item, oldest-first, chronological order preserved, new evidence untouched) but fits the formalized 16,384-token default with zero rollover; (3) mandatory new evidence alone exceeding 16,384 tokens fails visibly with the exact expected message, never silently truncated. | Four new passing focused tests directly tying the real-work 9,334/9,288-token baseline to the corrected, formalized defaults. |

| Verification | Command | Scope | Result | Exception / risk |
| --- | --- | --- | --- | --- |
| Focused regression (new) | `node --test tests/scribe-context-budget.test.mjs` | new SCRIBE-07C context-budget tests | 4 pass, 0 fail | — |
| Focused Scribe/context/coordinator/contract suites | `node --test tests/scribe-context-budget.test.mjs tests/scribe-model-extraction.test.mjs tests/scribe-user-guidance.test.mjs tests/scribe-contracts.test.mjs tests/scribe-coordinator.test.mjs tests/scribe-production-integration.test.mjs tests/scribe-structured-response.test.mjs tests/phase5b-model-adapter.test.mjs tests/scribe-wave2-integration.test.mjs tests/scribe-wave2-reconciliation.test.mjs` | Scribe context/extraction/coordinator/contract path | 167 pass, 0 fail (2 pre-fix failures identified and fixed - see below) | — |
| Pre-fix regression check (output-limit shift) | Same focused command, run immediately after changing `EXTRACTION_BATCH_OUTPUT_LIMITS` but before updating the two affected tests | `tests/scribe-model-extraction.test.mjs`, `tests/scribe-user-guidance.test.mjs` | 2 failures for the expected reason: the "oversized batch output" case no longer exceeded the new 4096-char ceiling (`max_items * max_item_chars` now equals `max_output_chars` exactly), and the guidance mandatory-floor test's hard-coded `512` output-reserve constant under-computed the new 2048-token reserve, tripping the wrong budget branch. Both fixed as described above; re-run confirmed 0 fail. | Confirms the two test fixes were driven by the real constant change, not speculative edits. |
| Complete suite | `npm test` (`node --test tests/*.test.mjs`) | whole repository | 401 pass − 7 skipped (pre-existing live-LM-Studio-only tests in `tests/scribe-real-acceptance.test.mjs`, unrelated) = 394 pass, 0 fail | — |
| Contract docs check | `npm run contracts:docs:check` | `contracts/generated/contract-reference.md` vs `contracts/catalog.json`/schemas | Initially reported stale; regenerating (`npm run contracts:docs`) produced a byte-identical file once CRLF/LF normalization was stripped (`diff` on de-CRLF'd content showed zero lines changed) — a pre-existing Windows line-ending artifact unrelated to this ticket's schema edit, not real content drift. Reverted the regenerated file (`git checkout -- contracts/generated/contract-reference.md`) since it carried no real change. | Pre-existing environment line-ending quirk, not a SCRIBE-07C defect; documented here rather than silently worked around. |
| Contract governance check | `npm run contracts:check` | all governed contracts | "Contract governance valid for 67 messages." | — |
| Syntax | `node --check` on every changed `.mjs` production/test file (`contracts/model-protocol.mjs`, `services/log-extractor-local-http/scribe-batch-boundary.mjs`, `services/scribe-coordinator/coordinator.mjs`, `tests/scribe-context-budget.test.mjs`, `tests/scribe-model-extraction.test.mjs`, `tests/scribe-production-integration.test.mjs`, `tests/scribe-user-guidance.test.mjs`) | all changed `.mjs` files | All pass | — |
| JSON syntax | `node -e` parse of `contracts/scribe-batch-policy.schema.json` and `wiring/production-electron.json` | both changed JSON files | Valid | — |
| Diff whitespace | `git diff --check` | full worktree diff | Clean | — |
| Push/worktree | `git status` clean after commit; branch `agent/scribe-context-budget` created from `origin/agent/scribe-json-fence-compatibility` at `050887a`; `git push -u origin agent/scribe-context-budget` | this branch | Pushed; `HEAD` and `origin/agent/scribe-context-budget` both at `f56028a33636600ae7e3769bac32bdee8428ba5f`; worktree clean | — |

- **Remaining acceptance or limitation:** Real LM Studio runtime acceptance — whether the formalized
  16,384-token budget and the accepted output limits behave as expected against the real 32K-context
  model, and whether a real worst-case bounded batch's actual `prompt_tokens` lands safely under
  16,384 in practice — is pending and explicitly deferred to the coordinator's final acceptance step
  (this artifact's "Final real LM Studio acceptance" section). No live LM Studio endpoint was
  available in this worktree.

**Scope-boundary finding (not blocking, recorded per process rules):** The accepted exact values
`max_items: 8`, `max_item_chars: 512`, `max_output_chars: 4096` make the total-character-ceiling
check inside `validateScribeBatchModelResponse` (`contracts/model-protocol.mjs`) structurally
unreachable through item text alone, because the densest possible in-limit response
(`max_items * max_item_chars` = 8 * 512 = 4096) now lands exactly at, never past, `max_output_chars`
(this was not true under the prior values, where 8 * 512 = 4096 already exceeded the prior
`max_output_chars` of 2048). This is not a defect introduced by this ticket — the four numeric
values are exactly what the ticket's "Decisions already made" section mandates — but it is worth
the coordinator's awareness: the total-character check remains valid defense-in-depth (e.g. against
a future independent change to `max_items` or `max_item_chars` without a matching `max_output_chars`
update) but cannot currently be exercised as an independently-triggerable rejection path. No
production code was changed to "fix" this, per the instruction not to silently expand scope; the
affected test case was adjusted to test the now-accepted boundary instead (see the
`tests/scribe-model-extraction.test.mjs` row above).

#### Review record

- **Review status:** Reviewed
- **Reviewed full SHA:** `f56028a33636600ae7e3769bac32bdee8428ba5f` (branch tip of `agent/scribe-context-budget`, chained on `agent/scribe-json-fence-compatibility` tip `050887a`)
- **Scope verdict:** Pass — diff between the two branch tips touches exactly the 4 governed-default locations (`wiring/production-electron.json`, `services/scribe-coordinator/coordinator.mjs`, `services/log-extractor-local-http/scribe-batch-boundary.mjs`, `contracts/scribe-batch-policy.schema.json`), `contracts/model-protocol.mjs`'s output-limit constant, `contracts/scribe-contract-handoff.md`, 3 test files, and this ledger. Confirmed `MAX_BACKGROUND_TRANSCRIPT_SEGMENTS=48`/`MAX_BACKGROUND_LOGGED_ITEMS=64` unchanged; mandatory-floor and oldest-transcript-then-oldest-Logged-Item rollover logic in `buildScribeBatchRequest` read directly and confirmed untouched; provider-neutral `estimateModelTokens` confirmed untouched (zero diff hunks). Batching threshold, idle admission, coordinator cursor/recovery, queue, Logged Item ownership, Whisper/audio, UI, installer confirmed absent from the diff.
- **Correctness verdict:** Pass — independently reverted `wiring/production-electron.json`'s value to 8000 and confirmed `tests/scribe-context-budget.test.mjs` and `tests/scribe-production-integration.test.mjs` fail for the real reason (`8000 !== 16384`); restored and confirmed green. The self-reported scope-boundary finding (`max_items * max_item_chars` = 4096 = `max_output_chars`, making the total-character ceiling unreachable via item text alone) was independently verified by reading `validateScribeBatchModelResponse` directly — accurately characterized, not a hidden correctness regression, no production logic weakened to route around it.
- **Real-work failure coverage verdict:** Pass — all four token-budget locations traced directly to the 9,334/9,288-token real-work baseline and the stale ~8,000-token production configuration; regression tests read the actual production files/exports rather than reimplementing them.

| Finding | File and line/symbol evidence | Required disposition | Resolution |
| --- | --- | --- | --- |
| Stale "~8000-token" comment still live as the justification for an active constant | `runtime/session-storage.mjs` lines 46-48 — `SCRIBE_CHECKPOINT_BACKGROUND_ITEMS_MAX = 64` justified via "the entire ~8000-token scribe.batch-policy context budget" / "8000/128 ≈ 62 ... 64 rounds up" | Non-blocking — reword to the 16,384 figure in a follow-up (not a new ticket) | Not fixed in this ticket; the constant's value (64) is unaffected either way. Recorded here as the follow-up. |
| Duplicated `#### Review record` block under SCRIBE-07C evidence (doc slip from a prior edit) | This file, previously two consecutive "Pending" Review record blocks after the Implementation record | Non-blocking — collapse to one | Fixed by this same edit: the duplicate block is removed and replaced with this single, filled-in Review record. |

- **Merge verdict:** MERGE — approved to merge to `origin/main` once the coordinator resolves the branch chain (07A → 07B → 07C, each already independently reviewed and approved above).
- **Merged SHA:** Not yet merged to `origin/main`. Current state: three sequentially-chained, independently-reviewed, MERGE-approved branches — `agent/scribe-structured-response` (07A) → `agent/scribe-json-fence-compatibility` (07B) → `agent/scribe-context-budget` (07C, this branch, containing the full chain) — none yet merged into `origin/main`, per the coordinator's explicit instruction to keep each ticket on its own branch and defer the actual merge-to-`main` decision rather than pushing it during this session.

---

## Final real LM Studio acceptance

This acceptance occurs only after all three branches are reviewed and merged.

- [ ] Start the source Electron application with the intended LM Studio model loaded and a 32,000-
  token model context window.
- [ ] Begin a new real session and speak long enough to settle at least two three-row Scribe batches.
- [ ] In LM Studio logs, confirm each Scribe request is stateless, contains the current batch under
  `new_evidence_segments`, and carries prior material separately under `background_context`.
- [ ] Confirm Scribe requests use structured JSON output without changing requests made by another
  client or another Argus workload.
- [ ] Confirm a normal response produces zero, one, or multiple Logged Items as appropriate and no
  fenced valid response causes a duplicate model call.
- [ ] Record LM Studio's actual `prompt_tokens` and `completion_tokens` for both requests. Treat a
  difference from Argus's provider-neutral estimate as evidence, not automatically as a defect. If
  a request approaches the model's real 32K ceiling, stop and create a separate measured budgeting
  ticket rather than adding provider-specific logic here.
- [ ] Confirm ordinary application diagnostics remain quiet and no installer was rebuilt.

### Final acceptance evidence

- **Status:** Not started
- **Date and model:** Pending
- **Session or log reference:** Pending
- **Observed request separation:** Pending
- **Observed structured-output behavior:** Pending
- **Observed provider token counts:** Pending
- **Observed Logged Item result:** Pending
- **Remaining limitation:** Pending

## Definition of done

This work is complete only when SCRIBE-07A, SCRIBE-07B, and SCRIBE-07C are independently reviewed
and merged, the final real LM Studio acceptance is recorded, the ordinary Scribe path no longer
rejects the observed fenced valid response, and context remains stateless, bounded, prioritized,
and governed.
