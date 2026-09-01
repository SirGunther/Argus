# Finalized Transcript Sequence-Gap Incident

**Status:** Resolved in `8f0b8b457f650e46539bafd60f4a2459e3987f59`; physical-microphone acceptance pending
**Observed:** 2026-09-01  
**Affected session:** `session-5877d529-bf4e-402a-a87a-7d72ed19c8d9`  
**Primary boundary:** `whisper-cpp-stt` -> `active-transcript-owner`  
**Source evidence:** `C:\Users\dktho\.codex\attachments\e1a71e19-7b0c-435c-bfc4-87cb8fb2bfd7\pasted-text.txt`

## User-visible failure

Live provisional transcription continued to update, but completed speech stopped transferring into finalized transcript rows. The interface therefore appeared partially healthy while the authoritative finalized-transcript path was rejecting output.

## Confirmed event sequence

1. At `04:33:43.703Z`, `active-transcript-owner` rejected committed word sequence `128`. Its ordering guard expected sequence `67` for the session.
2. Live preview remained operational. Revisions 1-3 were projected at `04:33:45.889Z`, `04:33:47.908Z`, and `04:33:49.889Z`.
3. At `04:33:52.992Z`, final Whisper inference completed successfully for audio window `232-268`:
   - 37 chunks
   - 9.22 seconds of audio
   - 1.425 seconds inference time
   - 3 committed words
   - transcript: `Our Army Secretary.`
4. At `04:33:52.993Z`, the audio flush completed with terminal outcome `boundary-emitted` and four outputs: three committed words plus the final boundary.
5. At `04:33:52.995Z` through `04:33:52.998Z`, `active-transcript-owner` rejected committed word sequences `129`, `130`, and `131`. It continued to expect sequence `67`.
6. No accepted committed words remained available to assemble and finalize the corresponding transcript segment. The provisional UI continued to demonstrate capture activity, but no authoritative transcript row could be produced.

## Decisive evidence

```text
SEQUENCE_GAP: expected sequence 67 but received 128

whisper.final-completed
audio_window_id: ...-audio-window-232
first_sequence: 232
last_sequence: 268
committed_word_count: 3
transcript_preview: Our Army Secretary.

audio.flush-completed
output_count: 4
terminal_outcome: boundary-emitted

SEQUENCE_GAP: expected sequence 67 but received 129
SEQUENCE_GAP: expected sequence 67 but received 130
SEQUENCE_GAP: expected sequence 67 but received 131
```

This establishes that microphone capture, buffering, final Whisper inference, and flush dispatch completed for this window. The observed loss occurred after final inference, at committed-word ordering/assembly.

## Confirmed defect

The finalized-word producer and consumer disagreed about the next valid committed-word sequence. Rejected authoritative words were neither recovered nor escalated to a clear user-visible failure. The system continued showing provisional text even though finalized output could no longer advance.

This is both:

- a sequence continuity/recovery defect; and
- a failure escalation defect.

Marking the failure `retryable: true` is insufficient unless the runtime actually retries or performs another explicit recovery action.

## Root-cause boundary

The log does **not** prove why sequences `67-127` were absent from the consumer's perspective. The implementation must be traced before choosing a correction. Relevant possibilities include producer sequence allocation before successful delivery, loss during routing, consumer recovery/state divergence, or incorrect sequence ownership across utterance/window boundaries.

Do not mask the failure by resetting the consumer's expected sequence or weakening its ordering guard. Establish the authoritative sequence owner and preserve deterministic ordering, idempotency, provenance, and single-lane final Whisper processing.

## Required behavior

- Every finalized committed word is accepted exactly once and in order, including across pause boundaries, automatic rollovers, queued windows, Stop/Resume, and delayed Whisper completion.
- A detected gap invokes a defined recovery path that either restores the missing authoritative messages or fails finalization explicitly.
- An unrecoverable finalized-transcript failure becomes visible in application state; the UI must not continue implying that finalization is healthy merely because preview remains active.
- Provisional text never enters authoritative transcript history and cannot conceal a stalled or failed finalized path.
- Recovery must not create duplicate finalized rows, mixed audio windows, fabricated words, or provenance changes.

## Regression evidence required

- Reproduce the equivalent of a consumer expecting `67` while the next received committed word is `128`.
- Demonstrate the pre-fix rejection and lack of finalized output.
- Demonstrate the corrected deterministic outcome: missing messages are recovered and finalized in order, or the session enters an explicit visible failure state.
- Exercise at least three consecutive audio windows with delayed final inference and overlapping continued capture.
- Confirm that finalized rows remain ordered, unique, and sourced from their original immutable audio windows.
- Confirm normal startup remains quiet; opt-in diagnostics should report state transitions and the first actionable failure without flooding per-chunk output.

## Separate observed defect

At `04:33:53.002Z`, session shutdown produced:

```text
Invalid output from session-lifecycle: Contract validation failed for session.stopped:
$.plane must be control for session.stopped; received domain
```

This contract-plane defect is real but is not the cause of the preceding finalized-word rejection. It is deferred from the primary sequence-gap correction unless investigation proves a direct causal relationship.

## Resolution

The production graph had allowed Whisper to emit faster than the bounded downstream wire could deliver. Overflowed finalized-word messages were rejected after Whisper had already advanced its authoritative sequence, leaving `active-transcript-owner` waiting for words that could no longer arrive.

The resolved transport now:

- applies FIFO deferred delivery with receipt-based backpressure instead of dropping accepted finalized words;
- settles receipts using graph instance identity rather than manifest service name;
- bounds receipt waits through the governed per-wire or graph operation timeout;
- rejects and drains all pending work when a wire fails terminally;
- rejects later delivery immediately while that session remains failed;
- exposes finalization failure in application state; and
- restores failed delivery only across a validated old-session/new-session boundary.

Sequence, idempotency, immutable audio-window/chunk provenance, rollover, pause, delayed Whisper, and single-worker rules remain enforced. Automated validation passed all 187 tests, contract governance for 56 messages, generated contract documentation, syntax checks, and deterministic package-graph verification. A real Electron session with the configured physical microphone and Whisper assets remains the final acceptance check.
