# Phase 4C Executable Transcript Pipeline

## Status

Completed for the deterministic POC on 2026-08-12. This phase proves independently runnable component behavior and an explicit five-process transcript graph. It does not select a microphone, STT engine, model, durable storage engine, or desktop SDK.

## Components

| Component | Owns | Accepts | Emits |
| --- | --- | --- | --- |
| `fake-audio-source` | deterministic PCM fixture production only | `lifecycle.start` | bounded `audio.chunk` |
| `fake-stt` | ephemeral chunk order, current utterance progress, and adapter-synthesized word IDs | `audio.chunk` | `transcript.partial`, immutable `transcript.word-committed`, `transcript.utterance-boundary` |
| `contextual-transcript-corrector` | deterministic correction/formatting calculation only | `transcript.correction-request` | `transcript.correction-resolved` |
| `active-transcript-owner` | current read-only projection, word identity validation/assembly, correction acceptance, finalized segments, optimistic revisions | partial/word/boundary/resolution/update | correction request, finalized segment, stored projection, history append |
| `permanent-transcript-history` | append-only accepted segment revisions | `transcript.history-append` | idempotent `transcript.history-appended` receipt |

Each component is an isolated Node executable with its own manifest. None imports another service's implementation. The graph in `wiring/demo.transcript-pipeline.json` is the only place their relationships are authorized.

## Working-document proof

The correction fixture emits three 500 ms PCM16 chunks. The fake STT visibly evolves one provisional utterance:

1. `are`
2. `are you ready`
3. `Argus, are you ready?`

It commits acoustic evidence separately as `are`, `you`, and `ready`; `are` includes `Argus` as an acoustic alternative. The Argus STT adapter synthesizes stable word IDs from the session and word sequence, then the active owner validates their reuse, so provider-native identifiers are optional.

At the pause boundary the active owner emits a correction request with all three words, alternatives, a 64-word context bound, the `working-document-default` policy, instruction version `1.0.0`, and a 0.90 automatic-acceptance threshold. The contextual component proposes `are` → `Argus`, comma placement, capitalization, and a question mark at 0.96/0.97 confidence. The active owner verifies target identity and expected source text before accepting it.

The final result is:

```text
Argus, you ready?
```

It retains:

- original STT text: `are you ready`;
- each stable word ID;
- `source_text` and `rendered_text` for every word;
- the accepted correction proposal ID;
- contextual formatting provenance;
- revision 0 and its permanent-history receipt.

## Highlighting rule

The component proof does not render UI styles. It emits the minimum UI-facing evidence required for a later projection:

- no flag for an automatically accepted high-confidence correction;
- no flag merely because a word has a low confidence number;
- `unresolved-ambiguity` when alternatives exist and no meaningful resolution is available;
- `correction-review` when a meaningful proposal exists but does not reach the declared automatic threshold;
- exact candidate strings and stable word identity for a future subtle underline, highlight, or review affordance.

This keeps the live transcript readable while ensuring mission-critical ambiguity can be inspected.

## Revision and history proof

Finalized revision 0 is appended immediately. A user edit naming `expected_revision: 0` creates revision 1 and a second append. Original STT text and word provenance survive. A second revision-0 edit is rejected as `STALE_REVISION`. Exact append replay returns the original receipt; reusing a history identity with different content fails as `IDEMPOTENT_INPUT_CONFLICT`.

Permanent history therefore retains every authoritative finalized revision, not just the latest snapshot. Phase 6 will add durable storage and session sealing without changing this boundary.

## AI lane order

The global serial workload order is now:

1. `transcription`
2. `transcript-correction-formatting`
3. `logged-item-extraction`
4. `classification-enrichment`

The deterministic fake corrector does not invoke a model and therefore does not consume the AI scheduler. A future model-backed implementation must enter the second workload and cannot run concurrently with transcription. The priority/FIFO test proves next-work selection without preemption.

## Audio lifecycle

Fake chunks contain actual bounded PCM bytes, not encoded transcript text. The STT service validates PCM metadata, canonical base64, decoded byte/sample equality, and checksum, reads the marker, and retains only transcript progress/output evidence. No output contains `audio_base64`; no raw-audio archive or replay buffer exists. Silence produces one successful terminal operation with no partial, word, or segment.

## Executable evidence

`tests/transcript-components.test.mjs` proves:

- bounded valid audio, long fixture generation, and invalid-fixture failure;
- changing partials, stable words, alternatives, utterance boundary, corrupt data, exact duplicate replay, contradictory chunk-ID reuse failure, sequence gap, late rejection, and no output audio bytes;
- silence without phantom transcript evidence;
- independent deterministic correction and invalid-input failure;
- high-confidence automatic correction versus focused review flags;
- active finalization, punctuation, provenance, optimistic edits, stale rejection, and revision-complete appends;
- append-only history replay and integrity-conflict behavior;
- the complete graph and the absence of any partial-to-history/context wire;
- state-owner restart fail-closed policy plus health/drain conformance for all five components;
- the four-level serial AI priority order.

The existing supervision suite continues to prove bounded stateless restart and the requirement for explicit state recovery ownership. Phase 4C state owners declare restart `never`; durable recovery remains Phase 6.

## Remaining boundary

Phase 4D connects finalized segments to context selection, exercises configurable pause/size/topic/latency triggers, and proves replacement of STT or context selection. Real provider and production-threshold decisions remain governed by `PENDING-DECISIONS.md`.
