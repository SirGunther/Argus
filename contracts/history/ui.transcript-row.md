# `ui.transcript-row` 1.1.0

Initial browser transcript-row projection. Provisional rows are explicitly read-only; finalized rows carry optimistic revision identity.

## 1.1.0 — 2026-08-31

- Added optional `utterance_id` correlation metadata so the renderer can match a replaceable provisional display with its authoritative finalized segment.
