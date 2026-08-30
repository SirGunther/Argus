# `ui.session-status` 1.0.0

Initial read-only session status projection. Storage metadata and lifecycle journals remain outside the browser boundary.

## 1.1.0 — 2026-08-30

Added optional `audio_processing` state and queue-depth fields so the desktop projection can distinguish listening, queued, transcribing, delayed, and error states while preserving the existing session fields.
