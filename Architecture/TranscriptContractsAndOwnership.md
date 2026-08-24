# Phase 4B Transcript Contracts and Ownership

## Status

Accepted and governed on 2026-08-12. Phase 4B defines executable message boundaries and ownership; Phase 4C implements the independent fake components.

## Expected live behavior

Speech recognition commonly supplies evolving partial hypotheses and may supply punctuation, word confidence, timings, and alternatives. Argus can use those capabilities when present, but does not make correctness depend on one provider. A replaceable adjacent contextual-correction component may therefore analyze immutable committed words with bounded surrounding context and emit a proposal.

Neither component edits authoritative history:

```text
audio.chunk
    ↓
STT: transcript.partial + transcript.word-committed
                              ↓
          optional contextual correction proposal
                              ↓
active transcript owner: projection + segment finalization + revisions
                              ↓
       transcript.segment / transcript.segment-stored
                    ↙                         ↘
          context selection          explicit history append
```

The UI renders one changing read-only provisional row per utterance. Provider updates replace that projection by increasing its revision. At a finalization boundary, the provisional row is replaced by the active owner's finalized, editable segment.

## Ownership matrix

| State or decision | Sole owner | May propose | Must not do |
| --- | --- | --- | --- |
| Audio bytes and chunk order | audio capture, until terminal STT outcome | — | Archive successful audio implicitly. |
| Partial live hypothesis | STT creates; active transcript owns current projection | STT provider | Feed partial text into extraction or permanent history. |
| Committed word evidence | STT | STT may include acoustic alternatives | Overwrite a committed word. |
| Contextual correction | contextual-correction component | STT provider or contextual language process | Silently mutate evidence or authoritative text. |
| Accepted rendered wording | active transcript owner | correction proposal | Lose source word, candidate, context, or generator provenance. |
| Punctuation/capitalization at boundary | active transcript owner | STT and contextual formatter | Treat pre-finalization formatting as durable evidence. |
| Finalized segment and optimistic revision | active transcript owner | UI or authorized system command | Accept a stale expected revision. |
| Permanent transcript entries | permanent-history owner | active owner through explicit append | Update or delete a prior entry in place. |
| Logged-item wording | logged-item extractor/storage owner | model adapter | Read STT internals or unfinalized projections. |

## Correction semantics

`transcript.word-committed` is immutable acoustic evidence. Its `alternatives` capture similar-sounding candidates when the provider exposes them. `transcript.word-correction-proposed` may identify a more likely word using acoustic similarity, contextual meaning, or both. It names the exact target word, expected text, bounded first/last context word IDs, alternatives, confidence, implementation, policy profile, and instruction version.

The active owner may accept a proposal only while the target evidence and expected text still match. Acceptance changes the rendered word used to assemble the not-yet-finalized segment; it does not modify the committed event. The finalized segment keeps `source_text`, `rendered_text`, and `correction_proposal_id` per word. After finalization, any change uses `transcript.segment-update` and creates another authoritative revision.

This is also explicit on the logged-item input. `transcript.context-window.generation_directive` names a versioned policy/instruction profile plus source-only behavior, lookback count, forward count, and maximum context characters. The exact source range remains mandatory. A future model adapter resolves the named profile to provider-specific instructions; the wire stays stable and an output can be reproduced without carrying an opaque raw prompt. The model is asked to produce a proposal or draft from that context, never given authority to rewrite transcript or logged-item state directly.

## Punctuation and structure

Punctuation and capitalization remain provisional until segment finalization. If the STT service supplies them, the active owner may use that proposal. If it does not, a replaceable contextual formatter can propose them through the same bounded, versioned-policy principle. Lexical committed evidence remains separately auditable. Extraction consumes only finalized segment text, so it receives the best accepted structure without reacting to every punctuation revision.

## Governed contracts

- `audio.chunk`: bounded PCM16/16 kHz/mono fake payload, checksum, exact byte/sample metadata, per-session sequence.
- `transcript.partial`: replaceable utterance projection; never a history/extraction input.
- `transcript.word-committed`: immutable ordered word evidence and acoustic alternatives.
- `transcript.word-correction-proposed`: contextual/acoustic proposal with bounded evidence and versioned instructions.
- `transcript.segment`: finalized downstream unit assembled by the active owner.
- `transcript.context-window`: exact finalized-segment range plus optional versioned logged-item generation/context directive.
- `transcript.segment-update`: optimistic edit command.
- `transcript.segment-stored`: authoritative active revision preserving original STT and word provenance.
- `transcript.history-append` / `transcript.history-appended`: explicit append-only permanent-history boundary and receipt.

Phase 4B established catalog 1.4.0 with 28 governed messages. Phase 4C extended that authority to catalog 1.5.0 and 31 messages with explicit utterance-boundary and correction request/result contracts. Phase 4D advances to catalog 1.6.0 and 32 messages with an explicit session context policy and richer context-window evidence. JSON Schema enforces shapes and payload bounds. Registry invariants additionally verify decoded PCM relationships and the exact source/context ownership rules that Draft 7 cannot express alone.

## Failure and recovery

The normative mapping is `contracts/operation-outcomes.md`. Gaps and temporary dependency/storage failures are retryable; corrupt audio, late input, stale partials/corrections/revisions, expired audio, and integrity conflicts are terminal. At-least-once append replay is idempotent. No retry implies raw-audio retention.

## Phase boundary

Phase 4B did not claim a microphone, STT engine, language model, durable storage engine, finalized threshold, or UI integration. Phase 6 now supplies a replaceable POC filesystem boundary for the active and permanent owners: finalized transcript revisions remain append-only and resolvable after active-cache eviction, while raw audio remains ephemeral. The real microphone, STT provider, production thresholds, production storage choice, and UI integration remain governed future decisions.
