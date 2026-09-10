# `ui.session-status` 1.0.0

Initial read-only session status projection. Storage metadata and lifecycle journals remain outside the browser boundary.

## 1.3.0 — 2026-09-10

Added the optional `scribe_processing` object so the desktop projection can report the bounded session-level Scribe states — caught up, pending rows, queued, processing, delayed, unavailable, and terminal failure — alongside the acknowledged cursor sequence and pending-row count. The host derives these from the governed `scribe.batch-admitted`, `scribe.batch-evaluated`, and finalized `transcript.segment` traffic it already observes; the coordinator's internal state is never read directly. Every existing field, including `audio_processing`, is unchanged.

## 1.2.0 — 2026-08-30

Added optional `capture_state` and `transcription_state` fields inside `audio_processing` so the renderer can show active microphone capture independently from queued or in-flight Whisper work. The legacy `state` and `queue_depth` fields remain unchanged for backward compatibility.

## 1.1.0 — 2026-08-30

Added optional `audio_processing` state and queue-depth fields so the desktop projection can distinguish listening, queued, transcribing, delayed, and error states while preserving the existing session fields.
