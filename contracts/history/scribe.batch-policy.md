# scribe.batch-policy history

## 1.0.0

- Introduced the governed Scribe batch-admission policy: rows-per-batch, idle-timeout, and total context-token budget, defaulting to three rows, 15,000 ms, and approximately 8,000 tokens (ADR-021). Architectural invariants such as AI-lane concurrency-one scheduling and fail-explicit provider behavior are not exposed here and remain outside user-adjustable configuration.
