# Phase 4F Transport Evidence

## Scope and environment

This is deterministic POC transport evidence, not a production load test or threshold. It validates inline base64 PCM16/16 kHz/mono through the existing `audio.chunk` contract and bounded queue boundary. Environment: Node v24.11.1, Windows x64, measured 2026-08-18.

## Five-second matrix and results

| Chunk | Count | PCM bytes | Base64 bytes | Envelope bytes | Base64 / envelope expansion | Observed msg/s | Avg operation latency | Max queue | RSS | Routed transcript events | Result |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 100 ms at 10/s | 50 | 3,200 | 4,268 | 5,043 | 1.334x / 1.576x | 10.160 | 2.561 ms | 1 | 74,936,320 | 100 | success |
| 250 ms at 4/s | 20 | 8,000 | 10,668 | 11,443 | 1.333x / 1.430x | 4.186 | 4.972 ms | 1 | 64,266,240 | 40 | success |
| 500 ms at 2/s | 10 | 16,000 | 21,336 | 22,112 | 1.333x / 1.382x | 2.214 | 7.079 ms | 1 | 65,527,808 | 20 | success |

The benchmark uses deterministic PCM bytes, verifies each envelope through the governed registry, routes it through the isolated fake-STT service via a capacity-32 bounded queue, and drains before the next cadence slot. The routed-event count is the emitted `transcript.*` output count. An 18,434-byte PCM payload was explicitly rejected by the current contract (sample count, byte length, and base64 length limits).

## Limitations and deferred decisions

These measurements do not include a microphone, browser, real STT provider, network transport, user session, storage, or production allocation threshold. Inline base64 NDJSON is acceptable only for this deterministic POC. AUD-003, TRN-001, and TRN-002 require real-device/provider/session evidence; TRN-003 remains Phase 6 storage/eviction work. The Phase 4E active-history limitation is unchanged.

## Final gate results

`npm.cmd audit --omit=dev`, `npm.cmd test`, `npm.cmd run contracts:check`, `npm.cmd run contracts:docs:check`, `npm.cmd run demo`, `npm.cmd run demo:alternate`, `npm.cmd run demo:transcript`, `npm.cmd run demo:context`, `npm.cmd run measure:runtime`, and `npm.cmd run benchmark:transport` all passed on 2026-08-18. The Phase 4F focused test adds two passing assertions; the final suite has 83 tests.
