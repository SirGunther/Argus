# Transcript Provenance Payload And History Divergence

**Status:** Confirmed; implementation pending  
**Observed:** 2026-09-01  
**Affected session:** `session-922dc897-804b-4c0b-be5a-6357ff4496c6`  
**Primary boundaries:** audio capture -> Whisper; Whisper -> active transcript; active transcript -> permanent history; permanent history -> UI projection  
**Related incident:** [`2026-09-01-finalization-sequence-gap.md`](./2026-09-01-finalization-sequence-gap.md)

## User-visible failure

Capture and live provisional text continued, but finalized transcript rows stopped advancing. Closing the session then failed because active transcript state contained a finalized segment that permanent transcript history did not contain.

The preceding sequence-gap incident corrected a real transport/backpressure defect. This is a separate downstream defect exposed after delivery began working: transcript provenance expands beyond governed contract payload limits before permanent history is durably updated.

## Confirmed evidence

The affected source run produced three active transcript segments. The third segment contained 30 words sourced from audio chunks `45-147` (103 chunks, approximately 26.4 seconds).

- Active snapshot: `C:\Users\dktho\AppData\Roaming\argus-standalone\sessions\session-922dc897-804b-4c0b-be5a-6357ff4496c6\active\transcript.json`
- Permanent history: `C:\Users\dktho\AppData\Roaming\argus-standalone\sessions\session-922dc897-804b-4c0b-be5a-6357ff4496c6\permanent\transcript.history.ndjson`
- Session state: `C:\Users\dktho\AppData\Roaming\argus-standalone\sessions\session-922dc897-804b-4c0b-be5a-6357ff4496c6\active\session.json`
- Finalization state: `C:\Users\dktho\AppData\Roaming\argus-standalone\sessions\session-922dc897-804b-4c0b-be5a-6357ff4496c6\active\finalization.json`

The active snapshot contains all three segments and is approximately 234,660 bytes. Permanent history contains only the first two segments. Close failed with `MISSING_AUTHORITATIVE_HISTORY` for the third segment and left the session in `closing`.

Current governed payload limits include:

- `transcript.segment`: 32,768 bytes
- `transcript.segment-stored`: 65,536 bytes
- `transcript.history-append`: 65,536 bytes
- `transcript.word-committed`: 32,768 bytes

The third segment alone serializes to approximately 182,517 bytes, so it cannot cross the existing governed segment/history boundaries.

## Confirmed root cause

`whisper-cpp-stt` attaches the complete audio-window `chunk_ids` array to every committed word. `active-transcript-owner` then copies that complete array into every word's `word_provenance.source_chunk_ids`.

For a window with `W` words and `C` chunks, provenance therefore grows as `O(W * C)`. In the affected segment, the same 103 chunk identifiers were repeated for each of 30 words.

Active transcript state is persisted before all outbound segment/history messages have crossed contract validation and permanent-history acknowledgement. An oversized outbound message can therefore be rejected after active state advances, producing active/history divergence.

## Architectural decisions

### 1. Capture, inference, storage, and presentation are separate boundaries

- Microphone capture remains continuous and must not wait for Whisper.
- Whisper processes immutable, bounded audio windows through the existing single FIFO inference lane.
- Authoritative transcript storage records finalized words/segments exactly once.
- Visible transcript rows are a presentation projection. A row does not need to equal one audio window or one stored segment.
- Later AI correction, classification, and synthesis may use adjacent finalized segments as context. They do not require an indefinitely growing Whisper window.

### 2. Audio-window policy

- A natural pause is the preferred soft boundary.
- A window is forcibly closed after 10 seconds of captured speech when no earlier pause closes it.
- Closing a window immediately opens the next immutable capture window; transcription of the prior window cannot block capture.
- Boundary continuity must preserve audio without drops or mixing. If a small overlap is required for Whisper accuracy, it must be explicitly bounded and deterministically de-duplicated through word timestamps.
- Window duration is governed configuration, not an unbounded heuristic.

Character count cannot determine the live audio cut because characters do not exist until inference returns. It can govern finalized presentation rows after Whisper supplies text and timestamps.

### 3. Presentation-row policy

- Build visible rows only from authoritative finalized text; provisional text remains in the dedicated live display.
- A row becomes eligible to close after either 240 characters or 15 seconds of represented speech.
- Once eligible, close it at the next terminal sentence mark (`.`, `?`, or `!`).
- Force closure at 400 characters or 25 seconds even if Whisper supplies no terminal punctuation.
- These values are initial governed defaults and may be tuned from real microphone use without changing capture or storage contracts.
- Finalized rows are appended once. They do not rewrite themselves while the user is speaking.

### 4. Compact, exact provenance

- Do not raise payload limits to accommodate repeated identifiers.
- Record an audio window's chunk span once using its immutable window identifier, first/last chunk identity or sequence, chunk count, and start/end timestamps.
- Each word retains its word identity, global committed-word sequence, timestamps, confidence, provider, and source audio-window identifier.
- If exact per-word chunks are required, derive and store only the minimal contributing chunk span from word timestamps. Never attach the complete window chunk list to every word.
- Preserve enough information to deterministically trace a word back to immutable source audio without quadratic duplication.
- Contract/schema changes must be additive or correctly versioned and must update fixtures, changelogs, generated references, service manifests, and production wiring together.

### 5. Persistence consistency

- Build and validate every governed outbound message, including byte limits, before advancing visible active state.
- A transcript revision is not authoritative to the UI or session finalizer until permanent history acknowledges the exact revision.
- Use a bounded pending/outbox or equivalent acknowledged-commit state so a crash or service failure can be resumed deterministically.
- Close must drain acknowledged work, report an explicit recoverable/terminal condition when it cannot, and must not strand a session indefinitely in `closing`.
- Do not weaken contract validation, sequence guards, identity rules, or provenance requirements.

## Required implementation sequence

### Wave 1: Core pipeline correction

One agent owns the cross-boundary correction so the audio-window, provenance, contract, active-state, and history rules cannot diverge across competing implementations.

- Implement bounded pause/10-second window rollover without interrupting capture.
- Normalize provenance and govern the corresponding contract evolution.
- Preflight outbound payloads before active persistence.
- Introduce acknowledged active/history commit behavior and bounded failure recovery.
- Preserve the single Whisper worker, FIFO ordering, idempotency, timestamps, and exact-once finalized output.

### Wave 2A: Transcript presentation

After Wave 1 is merged, a UI-focused agent implements the sentence-aware row projection using the governed 240/400-character and 15/25-second thresholds. This agent must not alter capture, Whisper ownership, or authoritative history semantics.

### Wave 2B: Session recovery and acceptance

After Wave 1 is merged, a recovery-focused agent implements and exercises non-destructive recovery for incomplete active/history commits, including the affected session shape. It must preserve existing evidence and must not silently delete or fabricate transcript data.

## Core regression evidence required

- Continuous capture for at least two minutes produces multiple immutable Whisper windows while inference is deliberately slower than capture.
- Natural-pause and forced 10-second boundaries both continue through the same FIFO lane without drops, duplicates, mixed audio, or committed-word sequence gaps.
- No governed message exceeds its catalog payload limit.
- Provenance size grows linearly with windows and words; a word never repeats a complete multi-chunk window list.
- Active transcript and permanent history contain identical acknowledged revision identities after normal operation.
- An injected payload-validation or history failure cannot expose a finalized UI row or leave an unacknowledged segment presented as authoritative.
- Stop and Close drain successfully after multiple windows; a bounded failure remains visible and recoverable.
- New Session accepts committed-word sequence `0` only across the governed old/new session boundary.
- Normal startup remains quiet. Diagnostics remain opt-in, transition-oriented, bounded, and sanitized.

Automated tests support the correction but do not replace physical-microphone acceptance in the real Electron source application.

## Recovery requirements

- Treat the affected session files as evidence and never delete or overwrite them without a recoverable backup.
- Detect active revisions missing from permanent history.
- Validate and compact legacy repeated provenance before any attempted history append.
- Make repair idempotent and report exactly which revision identities were recovered, already present, or rejected.
- Restore a coherent terminal session state only after active/history identities reconcile.

## Explicit non-solutions

- Increasing contract payload limits.
- Disabling payload, sequence, or idempotency validation.
- Treating provisional preview text as permanent transcript history.
- Pausing microphone capture while Whisper runs.
- Starting concurrent Whisper workers against the single local model.
- Allowing a sentence, audio window, stored segment, or visible row to grow indefinitely.
- Claiming completion from synthetic tests without leaving physical-microphone acceptance clearly pending.

## Completion criteria

This incident is resolved only when the core correction is merged and a real Electron session demonstrates uninterrupted capture, repeated bounded finalization, durable active/history agreement, successful Stop/Close, and no loss of finalized rows. UI row composition and legacy-session recovery may land immediately afterward, but neither may redefine or bypass the corrected core boundary.
