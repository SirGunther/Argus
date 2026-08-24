# Phase 2 Runtime Supervision Evidence

## Accepted scope

Phase 2 implements runtime-neutral supervision policy while retaining Node as the sole operational provider. Required services fail fast only after their graph-declared retry/restart recovery is exhausted. Optional degraded behavior is opt-in.

## Executable proofs

The supervision suite proves:

- a runtime-neutral native declaration fails closed because no trusted native provider is installed;
- a required service that does not acknowledge readiness fails at its deadline;
- a completed stream write does not count as completed work;
- operation timeout becomes a canonical retryable failure routed through `@runtime-provider` and `@supervisor`;
- retry occurs only on the exact wire that permits it;
- exhausted retry is delivered to the declared dead-letter component before fail-fast;
- stateless restart is bounded and replays unfinished input;
- a required crash loop fails after its recovery bound;
- an explicitly optional component can fail and enter degraded mode while required work completes;
- stateful restart is invalid without a recovery owner;
- undeclared output fails immediately;
- queue overflow is bounded, observable, and fails;
- graceful drain uses an explicit acknowledgement and force-stops an uncooperative process only after the declared deadline;
- both original extractor implementations still occupy the same graph position and produce contract-valid terminal results.

Run the proof:

```powershell
npm test
npm run contracts:check
npm run contracts:docs:check
npm audit --omit=dev
```

## Measurement command

```powershell
npm run measure:runtime
```

The command runs equivalent graphs containing 4, 8, and 12 service processes. It reports:

- process count;
- message and operation counts;
- maximum observed queue depth;
- readiness/startup time;
- health-reported aggregate RSS;
- routed messages per second;
- min/p50/p95/max completed-operation latency.

The output is deliberately ephemeral JSON so each environment can be measured without committing machine-specific performance claims. It is evidence for later acceptance-threshold decisions, not a production gate.

## Known limits

- Native and container provider implementations are not installed.
- The POC transport remains NDJSON over standard streams.
- Queue overflow has one supported policy: fail.
- Optional-component degraded operation is implemented at readiness/exit policy level but the current demo graph declares every component required.
- Retry/restart replay can duplicate work; Phase 3 now makes those replays observable and idempotent. Durable domain storage is still required to preserve the same ledger/revision semantics across a process restart.
- Memory comes from service-reported Node RSS and is not a cross-runtime accounting standard.
- Permission enforcement and OCI resource limits remain in the later packaging/security phase.
