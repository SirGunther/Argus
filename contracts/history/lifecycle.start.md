# `lifecycle.start` changelog

Owner: `runtime/session-lifecycle`  
Plane: `control`

## 1.2.0 — 2026-08-12

- Added governed UUID-v4 message IDs, stable idempotency keys, and semantic content fingerprints to newly emitted envelopes.

## 1.1.0 — 2026-08-12

- Adopted governed semantic versioning and the optional namespaced envelope extension point.
- Payload shape remains backward-compatible with 1.0.0.

## 1.0.0 — 2026-08-12

- Initial session-start command with required session identity and optional configuration.
