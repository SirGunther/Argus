# Phase 4D Transcript Context Wiring

## Status

Completed for the deterministic POC on 2026-08-13. Phase 4D connects finalized transcript segments to policy-driven context selection while keeping partial hypotheses structurally excluded.

## Accepted defaults

- The first satisfied trigger closes the authoritative range.
- Maximum latency is a mandatory safety ceiling.
- Every simultaneously satisfied reason is retained; primary precedence is pause, size, topic, latency, flush.
- Source segments remain contiguous, singular, and non-overlapping.
- Lookback and forward context are bounded and labeled; they never become source ownership.
- Topic evidence is deterministic injected policy data, not AI classification.
- Fake transcription enters the governed highest-priority, concurrency-one scheduler workload.
- Partial hypotheses cannot reach context selection, extraction, or permanent history.

## Executable graph

`wiring/demo.transcript-context.json` runs nine isolated processes:

```text
context policy ──control──> context selector ──accepted policy──> audio source
audio source ──PCM──> transcription lane ──PCM──> STT
STT ──partial/words/boundary──> active owner <──> contextual correction
active owner ──finalized segment──> context selector ──context window──> result collector
active owner ──append──> permanent history
```

The policy acknowledgement gates audio production, preventing a race between session configuration and the first finalized segment. The graph produces `Argus, you ready?` as one pause-triggered source segment with the exact Phase 4D policy and source range.

## Trigger and context rules

`transcript.context-policy` configures pause enablement, maximum source segments, maximum source characters, deterministic topic sequences, maximum latency, lookback, forward context, and a context-character budget. `transcript.context-window` 1.4 records the policy, observed sequence, counts, elapsed time, primary reason, every satisfied reason, authoritative source, and labeled context.

Cross-field registry invariants reject non-contiguous source segments, mismatched source IDs/timestamps, duplicated source/context ownership, incorrectly related lookback/forward sequences, incorrect counts, and context beyond the declared character budget.

## Scheduler and audio boundary

`serial-transcription-gate` uses the proven `SerialAiScheduler` with workload `transcription`, concurrency one, and FIFO sequence. Its journal input contains only the chunk identity; ephemeral PCM passes through the service operation and is not persisted as scheduler work or retained for replay. Durable AI scheduler recovery semantics remain proved independently in Phase 3.

## Replacement proof

`fake-stt-alternate` implements the same STT ports with an independent provider-B implementation. `transcript-window-selector-alternate` independently implements the same policy/segment/context ports. Each is substituted into the Phase 4D graph without modifying its neighbors or wires, and each produces the same finalized context result.

## Verification

`tests/phase4d-context.test.mjs` proves:

- successful nine-process end-to-end wiring;
- explicit policy gating and transcription-lane placement;
- independent pause, size, topic, and latency triggers plus simultaneous-reason evidence;
- non-overlapping source ownership with bounded lookback and forward context;
- PCM preservation and scheduler workload/concurrency evidence;
- STT and selector substitution without neighbor changes;
- default-deny rejection of partial routes to context selection or history.

Phase 4E is next for broader behavioral and recovery cases, including long-monologue bounds and Stop/Resume-compatible active ownership.
