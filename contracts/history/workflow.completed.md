# `workflow.completed` changelog

Owner: `runtime/run-control`  
Plane: `control`

## 1.2.0 — 2026-08-12

- Added governed UUID-v4 message IDs, stable idempotency keys, and semantic content fingerprints to newly emitted envelopes.

## 1.1.0 — 2026-08-12

- Adopted governed semantic versioning and the optional namespaced envelope extension point.
- Payload shape remains backward-compatible with 1.0.0.

## 1.0.0 — 2026-08-12

- Initial explicit completion signal linking a workflow to its terminal result message.
