# Scribe Session-Start Recovery Conflict

**Status:** Open. Confirmed on `origin/main` at `5dbeae3`. No fix in this branch — `SCRIBE-06` owns no production file, and the repair needs a coordinator ownership revision.
**Observed:** 2026-09-12, during `SCRIBE-06` Stage 2 real-runtime acceptance
**Introduced by:** `eebc74f` — *SCRIBE-05B: Add governed user Scribe guidance*
**Primary boundary:** `runtime/desktop-application.mjs` → `services/scribe-policy-source` → `services/scribe-coordinator`
**Severity:** Product-breaking. Every session on this baseline produces zero Logged Items.

## User-visible failure

The user presses Record. Recording is accepted, the session runs, and transcript rows finalize
normally. The Logged Items pane stays empty for the entire session, no matter how long the user
speaks. Stop and Resume do not clear it. The transcript is unaffected, so the application looks
healthy apart from the one pane Scribe exists to fill.

## Confirmed mechanism

1. `DesktopApplication.handleCommand` calls `configureScribeGuidance(session_id)` **unconditionally**
   before dispatching `session.record` or `session.resume`
   (`runtime/desktop-application.mjs:600`). `newSessionCommand` does the same (`:717`). This is
   deliberate — its own comment explains that the guidance snapshot has to be in place before the
   command is dispatched — and it runs whether or not the user has ever set guidance.
2. That dispatch reaches `scribe-policy-source`, whose `scribe.guidance-configure` handler ends in
   `publishSession(...)` (`services/scribe-policy-source/index.mjs:58`). **Policy publication one.**
3. The lifecycle outcome `session.recorded` then reaches the same service, whose `session.recorded`
   handler is also `publish` (`services/scribe-policy-source/index.mjs:62`). **Policy publication two.**
4. The coordinator emits a `scribe.recovery-request` for each publication. Its identity key
   (`services/scribe-coordinator/index.mjs:101`) is:

   ```
   ${INSTANCE}:scribe.recovery-request:${BOOT_ID}:${sessionId}:${policyId}:${policyVersion}
   ```

   Boot id, session, policy id and policy version are all identical across the two publications, so
   **both messages carry one idempotency key.**
5. `fingerprintMessage` (`runtime/message-identity.mjs:53-65`) folds `causation_id` into the semantic
   fingerprint. The two recovery requests were caused by different messages, so their fingerprints
   differ under one key → `IDEMPOTENCY_KEY_CONFLICT`.
6. The coordinator's output is rejected as invalid. Its recovery handshake never completes, and it
   then refuses every finalized transcript row for the life of the session:
   *"Scribe recovery must complete for session … before finalized evidence is admitted."*

## Decisive evidence

Reproduced through `DesktopApplication` itself — no acceptance harness, default configuration, no
guidance ever set by anyone, one plain `session.record`:

```json
{
  "record_status": "accepted",
  "recovery_request_count": 2,
  "distinct_idempotency_keys": 1,
  "distinct_causation_ids": 2,
  "failures": [
    "Invalid output from scribe-coordinator: Idempotency key scribe-coordinator:scribe.recovery-request:527cc2de-c371-4ba4-8253-a7da5469e45e:session-20260912181108:electron-scribe-default:1.0.0 was reused with different content"
  ]
}
```

`record_status: "accepted"` is the reason this is silent: the lifecycle command succeeds and the UI
reports a healthy recording session while Scribe is already unable to accept evidence.

The two messages differ in exactly two fields, `message_id` and `causation_id`:

```
idempotency_key  scribe-coordinator:scribe.recovery-request:72c748c0-…:session-…:electron-scribe-default:1.0.0   (identical)
causation_id     63178ef9-7ce7-49c0-a592-23a5da4b2ca0   vs   e13af72e-2cc3-4457-baa6-411b5b6a31bb
```

## Regression window

The same host reproduction, run at the commit immediately before SCRIBE-05B:

| Commit | recovery requests | distinct keys | failures |
| --- | --- | --- | --- |
| `9973a47` — *Scope Scribe drain state to recording session* (pre-SCRIBE-05B) | 1 | 1 | none |
| `5dbeae3` — current `origin/main` | **2** | **1** | `IDEMPOTENCY_KEY_CONFLICT` |

SCRIBE-05B added the second policy-publication path. Before it, `session.recorded` was the only
publisher and the single recovery request was uncontested.

## It does not self-heal

Production graph, the host's exact session-start order, deterministic endpoint so that model latency
plays no part:

| Elapsed | transcript rows finalized | batches admitted | batches evaluated | provider calls |
| --- | --- | --- | --- | --- |
| +30 s | 6 | 0 | 0 | 0 |
| +50 s, after 6 more rows | 12 | 0 | 0 | 0 |
| after Stop → Resume | 12 | 0 | 0 | 0 |

The durable Scribe checkpoint is never created (`admitted_through` remains absent). Resume publishes
the policy again under the same key, so it reproduces the conflict rather than clearing it.

That all 12 rows finalized normally is itself a confirmation of a separate invariant: Scribe cannot
block or mutate transcript behavior. Here that property is what makes the failure quiet.

## Why every existing gate missed it

`tests/scribe-user-guidance.test.mjs` carries 38 tests and all of them pass. Every one exercises the
guidance surface **in isolation** — the policy source alone, the extraction boundary alone, the
guidance store alone, the instruction text alone. Two of them (`a configured session publishes its
guidance…`, `re-sending the identical snapshot is idempotent…`) come close, but they assert on the
policy source's own output rather than running the production graph through the host's real
session-start order and asserting that a batch is subsequently admitted.

No suite in the repository composes `scribe.guidance-configure` + `session.record` against the
production graph. The composition is where the defect lives, so a green suite and a broken product
were consistent with each other.

## Reproduction

```
node --test --test-name-pattern="one session-start recovery request" tests/scribe-real-acceptance.test.mjs
```

The assertion is carried in `tests/scribe-real-acceptance.test.mjs` as a `todo`, not a failure: the
expectation is certain, but the fix is outside this ticket's ownership and a red gate would
misreport the rest of the baseline. It needs no model provider.

## Required ownership revision

The repair belongs to whichever of these the coordinator chooses; SCRIBE-06 may not make the call.

1. **`services/scribe-coordinator/index.mjs`** — make the recovery request idempotent across
   causations. Two publications of the same policy for the same session and boot are the same logical
   recovery; either the coordinator should emit only the first, or its identity key should be built
   so a replay is genuinely identical. Note that widening the key (e.g. adding the causation) would
   make the two requests *distinct* rather than *idempotent*, which trades a fatal conflict for a
   duplicate handshake — the weaker repair of the two.
2. **`services/scribe-policy-source/index.mjs`** — publish a session's policy once. The service
   already retains per-session guidance and could suppress a republication whose policy identity is
   unchanged, which is exactly the idempotent-replay case it already recognises elsewhere.
3. **`runtime/desktop-application.mjs`** — stop publishing twice at session start. Least invasive in
   appearance, but the ordering comment at `:598` records why the guidance dispatch has to precede
   the command, so this option needs care not to reintroduce the problem it was written to prevent.

Whichever is chosen, the missing gate is the same: a test that runs the production graph through the
host's real session-start sequence and asserts that a batch is admitted. That test now exists.
