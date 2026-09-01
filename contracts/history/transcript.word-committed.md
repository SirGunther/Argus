# `transcript.word-committed` changelog

Owner: `transcript/stt`  
Plane: `domain`

## 1.3.0 — 2026-09-01

- Final Whisper words retain the immutable audio-window identity and only the minimal contiguous timestamp-overlapping source chunk span; a complete window chunk list is never copied into every word.

## 1.2.0 — 2026-08-12

- Initial immutable ordered word evidence with provider confidence, audio-chunk provenance, and optional acoustically similar alternatives.

- Final committed words may identify their immutable source `audio_window_id` in addition to source chunk ids.
