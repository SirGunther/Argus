# `transcript.segment-stored` changelog

Owner: `transcript/active-state`  
Plane: `domain`

## 1.4.0 — 2026-09-01

- Added immutable `revision_id` and compact `audio_windows` span records; active storage is committed only after the matching permanent-history acknowledgement.

## 1.3.0 — 2026-08-12

- Added optional review flags so active projections can highlight only unresolved ambiguity or a meaningful correction.

## 1.2.0 — 2026-08-12

- Initial authoritative active-segment state with revision, immutable original STT text, per-word provenance, accepted correction links, and provisional-formatting provenance.
