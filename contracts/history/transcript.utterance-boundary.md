# `transcript.utterance-boundary` changelog

Owner: `transcript/stt`  
Plane: `domain`

Boundaries may carry the immutable source `audio_window_id` alongside source chunk ids.

## 1.3.0 — 2026-09-01

- Added the bounded immutable `audio_window_span` record so a window’s identity, complete first/last span, sequence range, count, and timestamps are recorded once at the boundary.

## 1.2.0 — 2026-08-12

- Initial explicit utterance-finalization evidence with word range, time range, punctuation hint, reason, and source audio-chunk identities.
