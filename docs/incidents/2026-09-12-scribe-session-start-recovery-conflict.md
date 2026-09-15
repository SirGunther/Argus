# Scribe Session-Start Recovery Conflict

**Status:** Resolved by `SCRIBE-06B` on branch `agent/scribe-session-start-recovery`, dispatched directly to `main` at `ba6585c`. The mechanism, evidence, and regression window below are unchanged from the original report; the *Resolution* section at the end records the fix.
**Observed:** 2026-09-12, during `SCRIBE-06` Stage 2 real-runtime acceptance
**Introduced by:** `eebc74f` — *SCRIBE-05B: Add governed user Scribe guidance*
**Primary boundary:** `runtime/desktop-application.mjs` → `services/scribe-policy-source` → `services/scribe-coordinator`
**Severity:** Not established prior to the fix. See *Impact* below — an earlier revision of this document
asserted a product-breaking severity that was withdrawn under review.

## What is confirmed

Session start emits **two** `scribe.recovery-request` messages that share one idempotency key and
differ in `causation_id`, producing `IDEMPOTENCY_KEY_CONFLICT` and the rejection of the coordinator's
second output.

1. `DesktopApplication.handleCommand` calls `configureScribeGuidance(session_id)` **unconditionally**
   before dispatching `session.record` or `session.resume`
   (`runtime/desktop-application.mjs:600`). `newSessionCommand` does the same (`:717`). It runs
   whether or not the user has ever set guidance.
2. That dispatch reaches `scribe-policy-source`, whose `scribe.guidance-configure` handler ends in
   `publishSession(...)` (`services/scribe-policy-source/index.mjs:58`). **Policy publication one.**
3. The `session.recorded` lifecycle outcome reaches the same service, whose handler is also `publish`
   (`services/scribe-policy-source/index.mjs:62`). **Policy publication two.**
4. The coordinator emits a `scribe.recovery-request` per publication. Its identity key
   (`services/scribe-coordinator/index.mjs:101`) is:

   ```
   ${INSTANCE}:scribe.recovery-request:${BOOT_ID}:${sessionId}:${policyId}:${policyVersion}
   ```

   Boot id, session, policy id and policy version are identical across both publications, so **both
   messages carry one key.**
5. `fingerprintMessage` (`runtime/message-identity.mjs:53-65`) folds `causation_id` into the semantic
   fingerprint. The two were caused by different messages, so their fingerprints differ under one key
   → `IDEMPOTENCY_KEY_CONFLICT`, and the coordinator's second output is rejected.

### Decisive evidence

Reproduced through `DesktopApplication` itself — default configuration, no guidance ever set, one
plain `session.record`:

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

The two messages differ in exactly two fields, `message_id` and `causation_id`:

```
idempotency_key  scribe-coordinator:scribe.recovery-request:72c748c0-...:session-...:electron-scribe-default:1.0.0   (identical)
causation_id     63178ef9-7ce7-49c0-a592-23a5da4b2ca0   vs   e13af72e-2cc3-4457-baa6-411b5b6a31bb
```

### Regression window

The same host reproduction, run at the commit immediately before SCRIBE-05B:

| Commit | recovery requests | distinct keys | failures |
| --- | --- | --- | --- |
| `9973a47` — *Scope Scribe drain state to recording session* (pre-SCRIBE-05B) | 1 | 1 | none |
| `5dbeae3` — current `origin/main` | **2** | **1** | `IDEMPOTENCY_KEY_CONFLICT` |

SCRIBE-05B added the second policy-publication path. Before it, `session.recorded` was the only
publisher and the single recovery request was uncontested.

## Impact — not established

An earlier revision of this document claimed that every session on this baseline produces zero
Logged Items. **That claim is withdrawn.** It was an inference from acceptance-harness runs, not an
observation of the shipped application, and it is contradicted by a real desktop session that
produced Logged Items normally.

Two things are now clear:

- **The graph does not terminate processing on this failure.** `failTargetService`
  (`runtime/interactive-graph.mjs:306-313`) fails only the wires with deliveries currently deferred
  to that service and rejects that service's outstanding receipts. It does not mark the service dead
  and does not block later deliveries to it. A recorded `service.failure` status is therefore not by
  itself an end to Scribe processing.
- **The harness observation was real but did not generalize.** Runs driving the production graph
  through the host's session-start order recorded 0 batches admitted across 70 s, 12 finalized rows,
  and a Stop/Resume cycle, with the coordinator reporting *"Scribe recovery must complete … before
  finalized evidence is admitted"*. The same sequence in the real application did not reproduce that
  outcome.

**What the difference is, is unknown, and this document does not speculate.** Establishing whether
the conflict is inert, intermittent, or conditionally harmful is work for the ticket that owns the
repair, not for this record.

## Why the existing gates did not cover the duplicate emission

`tests/scribe-user-guidance.test.mjs` carries 38 passing tests, each exercising the guidance surface
**in isolation** — the policy source alone, the extraction boundary alone, the guidance store alone,
the instruction text alone. No suite composes `scribe.guidance-configure` + `session.record` against
the production graph and asserts that session start raises no identity failure.

## Reproduction (pre-fix)

```
ARGUS_SCRIBE_ACCEPTANCE=1 node --test --test-name-pattern="one session-start recovery request" tests/scribe-real-acceptance.test.mjs
```

Before the fix, the assertion was carried as a `todo`: the duplicate emission was certain, the fix
was outside `SCRIBE-06`'s ownership, and a red gate would have misreported the rest of the baseline.

## Ownership revision considered

Three files could plausibly carry a repair: `services/scribe-coordinator/index.mjs` (recovery-request
identity), `services/scribe-policy-source/index.mjs` (republication of an unchanged policy identity),
and `runtime/desktop-application.mjs` (publishing twice at session start). Widening the coordinator's
identity key to include `causation_id` was considered and rejected: that would make the two requests
*distinct* rather than idempotent, trading a fatal conflict for a duplicate handshake attempt - the
weaker of the two available repairs.

## Resolution (SCRIBE-06B, 2026-09-13)

Fixed in `services/scribe-coordinator/coordinator.mjs`. `configurePolicy` legitimately runs more than
once before recovery completes - the host republishes a session's policy both from its guidance
snapshot and from the `session.recorded`/`resumed` lifecycle outcome, and both replays reach
`configurePolicy` with byte-identical policy content. `recoveryRequest` previously re-emitted a
recovery request on every call while unrecovered; it now tracks a per-session `recoveryRequested` flag
and emits at most one outstanding request per session while unrecovered, so a byte-identical replay is
silently absorbed instead of manufacturing a second logical request under a different causation. The
flag is meaningless once `state.recovered` becomes true (recovery is permanent for the life of a
coordinator process), so a genuine subsequent recovery - a fresh process restart, a fresh coordinator
instance and state map - is unaffected.

Proven at two levels:

- **Coordinator unit test** (`tests/scribe-coordinator.test.mjs`, *"replaying an identical policy
  before recovery completes asks for recovery only once"*): confirmed to fail against the pre-fix code
  (asserted `[]`, observed a real `recovery-request`) before being confirmed to pass against the fix;
  also proves a third replay stays silent and a genuinely different session is unaffected.
- **Real host regression** (`tests/scribe-real-acceptance.test.mjs`, the `todo` above converted to a
  passing test, name changed to *"the host publishes one session-start recovery request, recovers, and
  admits evidence"*): reproduces the exact host session-start sequence through `DesktopApplication`
  itself (only Whisper substituted, via the same graph-rewrite technique already used elsewhere in this
  file), and confirms one recovery request under one causation, recovery completing, three finalized
  rows admitting as one batch, that batch settling, and a Logged Item actually being stored - not just
  that the duplicate message disappeared.

Both are narrowly scoped to the coordinator's recovery-request emission; no Whisper, audio, prompting,
batching, UI, or unrelated architecture was changed.
