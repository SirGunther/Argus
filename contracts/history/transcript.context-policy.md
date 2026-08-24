# `transcript.context-policy` changelog

## 1.2.0 — 2026-08-13

- Added the explicit, session-scoped context-selection policy used by the Phase 4D proof.
- Pause, source-size, deterministic topic-sequence, and maximum-latency triggers are independently configurable.
- Lookback and forward context are bounded separately from authoritative source ownership.
- The maximum-latency trigger is mandatory; topic input is deterministic policy data rather than AI classification.

Owner: `transcript/context-selection`  
Plane: `control`
