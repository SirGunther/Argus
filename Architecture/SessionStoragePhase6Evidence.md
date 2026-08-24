# Phase 6 Session and Storage Evidence

## Status

Implemented for the deterministic POC on 2026-08-19. Phase 6 is one complete batch covering governed session lifecycle, root-scoped filesystem storage, durable transcript/logged-item state, close recovery, folder location, and the deferred Phase 4E active-history bound.

## Governed lifecycle

The contract catalog is version `1.8.0` with `47` governed messages. The ten Phase 6 control messages are:

```text
session.record -> session.recorded
session.stop -> session.stopped
session.resume -> session.resumed
session.close -> session.closed
session.folder-locate -> session.folder-located
```

Session metadata is a versioned `session_metadata` artifact. Record creates one identity and enters `recording`; Stop enters `stopped` without moving or sealing active/permanent state; Resume returns to `recording` with the same identity; Close enters an irreversible finalization boundary. Exact operation replay returns the stored outcome. Reusing an operation identity with changed content and reusing a session identity for another Record both fail explicitly.

Closed sessions reject Resume, new transcript/logged-item revisions, and conflicting Close commands.

## Storage boundary

`ARGUS_SESSION_ROOT` is passed only to the declared lifecycle, active-owner, permanent-history, and folder-locator owners. The storage module validates a single safe session path segment, resolves every path beneath the configured root, rejects symlinked session directories, and exposes no arbitrary caller path operation.

```text
<root>/<session_id>/active/
  session.json                 versioned session metadata
  transcript.json              current transcript projection
  logged-items.json            current logged-item projection
  finalization.json            persisted close progress
<root>/<session_id>/permanent/
  transcript.history.ndjson    append-only transcript revisions
  logged-item.history.ndjson  append-only logged-item revisions
  close.evidence.json          final closed marker and outcome
```

Mutable JSON uses temporary-file-and-rename replacement. NDJSON append records carry a storage schema version, stable history identity, revision, semantic fingerprint, and the authoritative value. Exact append replay returns the original entry; different content under the same identity is an integrity conflict. Malformed or cross-session history is an explicit integrity failure.

## Close recovery

Close persists these phases in order:

```text
writes-blocked -> drained -> active-persisted -> history-reconciled -> sealed -> released
```

The close operation and phase are persisted before the next phase. Recovery resumes from the recorded phase, verifies current projections against permanent history, writes one final close evidence marker, and releases the evictable in-memory cache. A sealed session is never reopened. The test suite interrupts both before and after every phase and verifies the same successful outcome and exactly one copy of every history revision after restart.

## Bounded active history

`SessionLifecycle` keeps only a bounded revision cache in memory. Older finalized transcript revisions remain in permanent NDJSON and are resolved through the storage boundary before a later revision is accepted. The completed Phase 4E long-monologue proof combines:

- size and 5,000 ms maximum-latency closure;
- bounded graph queues and bounded lookback/forward context;
- durable history for the complete long input;
- eviction of older active revisions from the bounded cache;
- reload of an evicted revision and a valid subsequent revision;
- close sealing with no duplicate history entries.

## Executable verification

```text
node --test tests/phase6-session-storage.test.mjs        # 6 passing
node --test tests/phase4e-behavior-recovery.test.mjs     # 3 passing
npm.cmd test                                             # 107 passing
npm.cmd run contracts:check                              # 47 messages
npm.cmd run contracts:docs:check                         # generated reference current after regeneration
```

The focused tests use isolated operating-system temporary directories and remove them in `finally` blocks. No repository or immutable POC test data is used.

## Deliberate limitations

This is a replaceable local POC implementation, not production-grade storage or a claim of global durability. It does not add a database, storage SDK, backup, synchronization, encryption, cloud storage, migration system, real microphone/STT, UI integration, broad permissions, or observability. The globally shared durable AI journal remains explicitly deferred and is not part of Phase 6.
