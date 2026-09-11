# scribe.batch-policy history

## 1.1.0

- Added the optional `generation.additional_guidance` field (SCRIBE-05B): bounded user text, at most 2,000 characters, stating which information this installation's user considers worth retaining. Backward-compatible minor - the field is optional, so every 1.0.0 policy remains valid and replays unchanged. Guidance refines retention judgement only: it travels as an explicitly labelled request field ranked below the protected instruction's role, response schema, evidence separation, provenance, and ownership rules, and instruction version `1.1.0` is the first whose governed wording states that precedence. Because guidance lives inside the policy, it is covered by the existing `policy_id`/`policy_version` identity already carried through `scribe_batch_identity`, the model request fingerprint, the durable checkpoint, and the batch journal - so a session's guidance is pinned across retries and restart recovery with no separate identity to keep in sync.

## 1.0.0

- Introduced the governed Scribe batch-admission policy: rows-per-batch, idle-timeout, and total context-token budget, defaulting to three rows, 15,000 ms, and approximately 8,000 tokens (ADR-021). Architectural invariants such as AI-lane concurrency-one scheduling and fail-explicit provider behavior are not exposed here and remain outside user-adjustable configuration.
