# Phase 5A Logged-Item Pipeline Evidence

Status: Phase 5A ownership evidence retained after Phase 6 storage integration on 2026-08-19. Phase 5B has a separate evidence artifact; the browser UI remains out of scope.

## Governing boundary

ADR-014 separates deterministic Phase 5A ownership from the provider-neutral local model boundary reserved for Phase 5B. The Phase 5A graph uses the existing finalized transcript context-window contract and keeps the two deterministic extractors replaceable in the same graph position.

## Ownership graph

```text
finalized transcript.segment
  -> transcript-window-selector
  -> transcript.context-window
  -> log-extractor-concise (or log-extractor-passthrough)
  -> logged-item.draft
  -> active-logged-item-owner
       -> logged-item.stored -> logged-item-evidence-observer
       -> logged-item.history-append
  -> permanent-logged-item-history
       -> logged-item.history-appended -> logged-item-evidence-observer
       -> logged-item.history-appended -> @result-collector
```

All domain and control relationships are explicit in `wiring/demo.logged-item-pipeline.json`. The graph has six isolated services. The partial transcript contract has no wire into extraction, active logged-item state, or history.

## State and identity evidence

- Extractors derive `item_id` deterministically from `session_id` and `window_id`, so exact context-window replay addresses one logical item.
- Reusing that identity with changed extraction content fails with `ITEM_ID_CONFLICT`; the extractor also rejects a context window whose declared source does not exactly match its first and last finalized segments.
- Draft and stored revisions carry `revision_id`, stable first/last segment IDs, exact source timestamps, `generator.implementation`, and `generator.input_window_id`.
- The active owner is the sole mutation authority. It accepts revision 0, applies only user-authored direct updates when `expected_revision` matches, increments once, rejects stale revisions with `STALE_REVISION`, and writes the current projection through the declared session-storage boundary when `ARGUS_SESSION_ROOT` is configured.
- Duplicate draft and update envelopes replay the cached outputs without adding a revision. The separate history owner accepts one exact append per `item_id:rN`; duplicate appends replay the acknowledgement and changed content fails with `IDEMPOTENT_INPUT_CONFLICT`. With a configured root, the owner reloads append-only NDJSON history across process restart.
- A model-like update enters `logged-item.update-proposed` and does not emit stored text. Only an explicit user `logged-item.proposal-resolve` acceptance advances active text and emits the next history append. Rejection emits a decision only.

## Executable evidence

Focused proof:

```text
node --test tests/phase5a-logged-items.test.mjs
```

This proves exact provenance, stable replay identity, changed-content conflict, optimistic revision/replay/stale behavior, proposal authority, revision-0 and accepted-revision history appends, owner isolation, finalized-context-only wiring, and health/drain declarations.

Direct graph proof:

```text
node runtime/orchestrator.mjs wiring/demo.logged-item-pipeline.json
```

The graph completes with six services, readiness and drain evidence, one revision-0 history acknowledgement, zero rejections, and zero dead letters.

The concise and passthrough extractors retain the same `transcript.context-window` input and `logged-item.draft` output contracts; no neighbor or wire changes are required to replace them.

## Deferred boundaries

This Phase 5A snapshot intentionally does not describe the later Phase 5B local HTTP model boundary or optional classification service. The Phase 6 lifecycle/storage boundary now persists current logged-item projections and append-only revisions, with session close and bounded revision-cache evidence recorded separately in `Architecture/SessionStoragePhase6Evidence.md`. Packaging, microphone, real STT, and UI integration remain unstarted.
