# `ui.transcript-row` 1.1.0

Initial browser transcript-row projection. Provisional rows are explicitly read-only; finalized rows carry optimistic revision identity.

## 1.2.0 — 2026-09-01

- Added optional `row_id`, `utterance_ids`, `source_segment_ids`, `source_segments`, and exact `source` range metadata for sentence-aware visible rows that span one or more acknowledged stored segments.
- Finalized presentation rows are append-only and may use a presentation row identity distinct from any stored transcript segment.

## 1.1.0 — 2026-08-31

- Added optional `utterance_id` correlation metadata so the renderer can match a replaceable provisional display with its authoritative finalized segment.
- Added optional `dismissed` metadata so an authoritative empty final result can remove its provisional display without creating a finalized transcript row.
