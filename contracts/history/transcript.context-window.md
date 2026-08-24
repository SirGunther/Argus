# `transcript.context-window` changelog

## 1.4.0 — 2026-08-13

- Added deterministic `topic` as a selection reason and retained every simultaneously satisfied reason.
- Added the exact selection policy/version, observed sequence, source size, and elapsed-time evidence.
- Added explicitly related, bounded lookback/forward context segments outside the authoritative source range.
- The authoritative `segments` range remains contiguous and non-overlapping across emitted windows.

## 1.3.0 — 2026-08-12

- Added an optional versioned logged-item generation directive with a stable policy profile and explicit context bounds.
- The exact source range remains mandatory; the directive makes lookback, forward context, and prompt budget visible rather than provider-private.

Owner: `transcript/context-selection`  
Plane: `domain`

## 1.2.0 — 2026-08-12

- Added governed UUID-v4 message IDs, stable idempotency keys, and semantic content fingerprints to newly emitted envelopes.

## 1.1.0 — 2026-08-12

- Adopted governed semantic versioning and the optional namespaced envelope extension point.
- Payload shape remains backward-compatible with 1.0.0.

## 1.0.0 — 2026-08-12

- Initial immutable transcript window with extraction reason and stable source boundaries.
