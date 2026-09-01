# `transcript.segment` changelog

Owner: `transcript/active-state`  
Plane: `domain`

## 1.4.0 — 2026-08-12

- Added optional review flags for unresolved ambiguity or meaningful correction review; ordinary low-confidence words remain visually quiet.
- Finalized word provenance may retain each source sequence, immutable audio-window identity, and source chunk identities.

## 1.3.0 — 2026-08-12

- Added optional active-state revision, original STT text, per-word provenance, accepted correction linkage, and formatting provenance.
- Added explicit `size`, `latency`, and `flush` finalization boundaries while retaining the 1.0 payload shape.
- The active transcript owner, rather than STT, now owns construction of finalized segments.

## 1.2.0 — 2026-08-12

- Added governed envelope identity and adopted contiguous per-session sequence enforcement.

## 1.1.0 — 2026-08-12

- Adopted governed semantic versioning and the optional namespaced envelope extension point.
- Payload shape remains backward-compatible with 1.0.0.

## 1.0.0 — 2026-08-12

- Initial ordered transcript segment with session identity, time range, text, and boundary.
