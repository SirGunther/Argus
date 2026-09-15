# Argus Scribe Stateless Request Hardening Work Breakdown

**Status:** Ready for sequential dispatch after SCRIBE-06B is reviewed and merged

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

- **Review status:** Pending
- **Reviewed full SHA:** Pending
- **Scope verdict:** Pending
- **Correctness verdict:** Pending
- **Real-work failure coverage verdict:** Pending

| Finding | File and line/symbol evidence | Required disposition | Resolution |
| --- | --- | --- | --- |
| Pending | Pending | Pending | Pending |

- **Merge verdict:** Pending
- **Merged SHA:** Pending

### SCRIBE-07B evidence

#### Implementation record

- **Status:** Not started
- **Starting `origin/main` SHA:** Pending
- **Branch:** `agent/scribe-json-fence-compatibility`
- **Full implementation SHA:** Pending
- **WHY:** Pending
- **HOW:** Pending
- **WHAT:** Pending
- **Real-work failure evidence:** Pending
- **Production path trace:** Pending
- **Why the regression represents that production failure:** Pending
- **Post-correction real-runtime evidence:** Pending

| Changed file | Evidence that this file owned the failure | Exact reason it changed | Resulting behavior |
| --- | --- | --- | --- |
| Pending | Pending | Pending | Pending |

| Verification | Command or evidence source | Result |
| --- | --- | --- |
| Focused regression | Pending | Pending |
| Complete suite | Pending | Pending |
| Syntax/diff | Pending | Pending |
| Push/worktree | Pending | Pending |

- **Remaining acceptance or limitation:** Pending

#### Review record

- **Review status:** Pending
- **Reviewed full SHA:** Pending
- **Scope verdict:** Pending
- **Correctness verdict:** Pending
- **Real-work failure coverage verdict:** Pending

| Finding | File and line/symbol evidence | Required disposition | Resolution |
| --- | --- | --- | --- |
| Pending | Pending | Pending | Pending |

- **Merge verdict:** Pending
- **Merged SHA:** Pending

### SCRIBE-07C evidence

#### Implementation record

- **Status:** Not started
- **Starting `origin/main` SHA:** Pending
- **Branch:** `agent/scribe-context-budget`
- **Full implementation SHA:** Pending
- **WHY:** Pending
- **HOW:** Pending
- **WHAT:** Pending
- **Real-work failure evidence:** Pending
- **Production path trace:** Pending
- **Why the regression represents that production failure:** Pending
- **Post-correction real-runtime evidence:** Pending

| Changed file | Evidence that this file owned the failure | Exact reason it changed | Resulting behavior |
| --- | --- | --- | --- |
| Pending | Pending | Pending | Pending |

| Verification | Command or evidence source | Result |
| --- | --- | --- |
| Focused regression | Pending | Pending |
| Complete suite | Pending | Pending |
| Syntax/diff | Pending | Pending |
| Push/worktree | Pending | Pending |

- **Remaining acceptance or limitation:** Pending

#### Review record

- **Review status:** Pending
- **Reviewed full SHA:** Pending
- **Scope verdict:** Pending
- **Correctness verdict:** Pending
- **Real-work failure coverage verdict:** Pending

| Finding | File and line/symbol evidence | Required disposition | Resolution |
| --- | --- | --- | --- |
| Pending | Pending | Pending | Pending |

- **Merge verdict:** Pending
- **Merged SHA:** Pending

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
