# `service.failure` changelog

Owner: `runtime/supervision`  
Plane: `control`

## 1.2.0 — 2026-08-12

- Added governed UUID-v4 message IDs, stable idempotency keys, and semantic content fingerprints to newly emitted envelopes.

## 1.1.0 — 2026-08-12

- Adopted governed semantic versioning and the optional namespaced envelope extension point.
- Payload shape remains backward-compatible with the governed 1.0.0 fixture.

## 1.0.0 — 2026-08-12

- Established the canonical failure outcome using `outcome`, stable `code`, bounded `category`, safe `message`, explicit `retryable`, and optional details.
- Replaced the pre-governance POC's experimental `error.type` shape before compatibility fixtures were established.
