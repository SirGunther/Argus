# Phase 4E Transcript Behavior and Recovery Evidence

## Status

Complete for the deterministic architecture POC after Phase 6 storage work on 2026-08-19. The long-monologue case now proves size/latency closure, contiguous authoritative ranges, bounded related context, bounded wire queues, bounded active revision cache, durable history, reload after eviction, revision-after-reload, and close sealing.

No real microphone, STT provider, model SDK, broker, container runtime, desktop host, or production storage claim was added. The POC uses the governed replaceable filesystem boundary and catalog 1.8.0 contains 47 messages.

## Checklist evidence

| Phase 4E claim | Evidence | Result |
| --- | --- | --- |
| Word-by-word commitment while partial hypotheses change | `tests/transcript-components.test.mjs` asserts the exact interleaving of three changing partial projections with committed `are`, `you`, and `ready` word evidence. | Proven. |
| Silence without empty or phantom transcript output | `tests/transcript-components.test.mjs` sends the deterministic silence fixture through fake STT and receives only the terminal operation receipt. | Proven. |
| Provider correction changes provisional rendering only | The same fake-STT case asserts the final provisional text `Argus, are you ready?` while committed evidence remains `are`, `you`, `ready`. | Proven. |
| User edits create revisions while retaining original text and word provenance | The active-owner case asserts revisions 0 and 1, unchanged `original_stt_text`, and identical per-word provenance after the user edit. | Proven. |
| Pause, size, topic, and maximum latency independently and in conflict | `tests/phase4d-context.test.mjs` directly exercises every trigger alone and all four simultaneously, including stable primary precedence and all coincident reasons. | Proven. |
| Long monologues remain within bounded active state, queues, and maximum latency | `tests/phase4e-behavior-recovery.test.mjs` proves actual long-fixture size and latency closure, bounded graph queue depth, contiguous/non-overlapping synthetic source ranges, bounded lookback/forward context, durable NDJSON history, an active revision-cache bound, reload of an evicted revision, and a valid post-reload revision before close. | Proven. |
| At-least-once replay creates no duplicate words or revisions | The new replay case redelivers exact PCM through the transcription gate and fake STT, replays active-owner finalization, and appends permanent history twice. Logical word IDs remain unique, active revision remains 0, both history receipts identify one stored entry, and conflicting history identity reuse still fails. | Proven. |
| Stop/Resume-compatible active ownership | The new batch harness pauses input while one active-owner process remains alive, then resumes the same session/sequence, finalizes, revises, preserves provenance, and rejects late projection plus stale revision input. | Proven within the stated boundary. |

## New Phase 4E cases

`tests/phase4e-behavior-recovery.test.mjs` adds three deterministic cases:

1. The 12-chunk long-monologue fixture crosses the real audio source, transcription gate, fake STT, active owner, correction component, history owner, and selector graph. Separate policies close the one authoritative segment by configured character size and by the 5,000 ms maximum-latency ceiling. A 12-segment selector stream separately proves four contiguous, non-overlapping ranges and bounded related context.
2. Exact audio redelivery crosses the transcription gate, fake STT, active owner, and permanent history. Duplicate transport events may be visible, but logical word identity, active revision state, and append-only history identity do not multiply.
3. Intake pauses between two batches while the same active-owner process remains alive. The second batch continues the original utterance and session; a post-resume user edit retains original STT and word provenance; late and stale inputs are rejected.

The existing Phase 4C test also gained exact domain-event interleaving and post-edit provenance assertions. No schema, catalog, fixture, or generated contract documentation changed.

## Replay semantics

The transcription gate now declares operation-level `onDuplicate: 'handle'`. Its stable scheduler `work_id` remains idempotent, so redelivery reuses the completed scheduling result and re-emits the PCM payload supplied by the current transport delivery.

`retainOutputs: false` still prevents the protocol from caching the PCM-bearing output. The protocol retains only a SHA-256 semantic fingerprint for idempotent output comparison. A journal guard fails if `audio_base64` ever enters the scheduler event, and diagnostics report zero retained outputs plus the chunk-ID-only scheduler input. Fake STT may therefore replay deterministic transcript evidence without turning raw audio into history.

Downstream owners preserve at-least-once semantics:

- fake STT re-emits deterministic evidence for an exact chunk replay;
- the active owner accepts exact evidence idempotently and does not create another logical word or revision;
- permanent history returns the original receipt for an exact append replay and keeps one entry per `history_entry_id`/segment revision;
- conflicting chunk, word, work, message, idempotency, or history identity reuse remains a terminal integrity failure.

## Stop/Resume-compatible semantics

The earlier same-process proof stops input; Phase 6 adds the governed session lifecycle and durable restart boundary. While intake is paused or a session is stopped:

- Stop does not move or seal permanent state, and the same session identity remains resumable;
- provisional, committed-word, ordering, and revision state remain intact;
- Resume continues the same `session_id` and contiguous sequence;
- post-resume edits preserve original STT and per-word provenance;
- finalized-utterance late projection, stale optimistic revision input, and writes after Close are rejected by governed owners.

Close recovery is separately proven for every finalization phase in `tests/phase6-session-storage.test.mjs`.

## Explicit limitation

Transient selector state is bounded by configured pending-window triggers, bounded lookback/forward context, and bounded graph wire queues. Fake STT releases raw PCM, and the active owner clears provisional/word/boundary/correction working maps when an utterance finalizes. Durable finalized transcript revisions are append-only NDJSON records; the active lifecycle cache evicts older revisions after acceptance and resolves them through the storage boundary before applying a later revision.

The POC now has an authorized durable active snapshot, permanent histories, eviction/reload protocol, session-close boundary, and interruption recovery. It does not claim global durability, backups, synchronization, encryption, cloud storage, or a production storage engine. TRN-003 is resolved for this replaceable POC implementation; the durable globally shared AI journal remains explicitly deferred.

## Verification boundary

The full suite contains 107 passing tests before the final documentation/gate rerun. Focused Phase 6 tests cover contracts, lifecycle, storage, recovery, locator authority, and eviction; the Phase 4E long-monologue case now includes the durable bound. Required contract governance, generated-document drift, and full regression remain the release gates. No production threshold or production durability claim follows from this deterministic POC evidence.
