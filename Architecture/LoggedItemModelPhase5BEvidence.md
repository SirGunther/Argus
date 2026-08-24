# Phase 5B Local Model Adapter and Classification Evidence

Status: Phase 5B.1 boundary hardening implemented for review on 2026-08-19. This document records the provider-neutral evidence; the standalone Electron path later selects Ollama `llama3.2:3b` without changing this boundary.

## Boundary and graph

ADR-014 remains the governing boundary. `ai.work-request` and `ai.work-completed` are now version 1.4.0 with a strict nested model protocol version 1.0.0. Valid and invalid model-protocol fixtures are retained. The existing `classification.suggestion` contract remains the optional enrichment result; no new catalog message was added. The catalog remains 1.7.0 with 37 governed messages.

The model graph is:

```text
finalized transcript.context-window
  -> log-extractor-local-http
  -> ai.work-request [logged-item-extraction]
  -> serial-ai-model-lane [one SerialAiScheduler, in-memory graph journal]
  -> ai.work-completed
  -> log-extractor-local-http
  -> logged-item.draft
  -> active-logged-item-owner
  -> logged-item.stored -> logged-item-classification-suggester
finalized transcript.context-window
  -> logged-item-classification-suggester [explicit context wire]
classification request
  -> ai.work-request [classification-enrichment]
  -> serial-ai-model-lane
  -> ai.work-completed
  -> classification.suggestion -> @result-collector (optional result)
```

Primary storage and history remain the Phase 5A owners. Classification has no mutation wire to either owner and the browser UI is unchanged. The optional classifier is marked non-required, so its failure degrades only that service; the primary item/history result remains complete. Successful suggestions are observed as optional result-collector output while the collector remains live during drain.

The Phase 5B graph uses one scheduler process for extraction and classification. `SerialAiScheduler` retains concurrency one and the established priority order: transcription, transcript correction/formatting, logged-item extraction, classification enrichment. Purpose is checked against workload at model-lane admission, so classification cannot claim extraction priority. The older standalone deterministic transcription gate remains the Phase 4 offline adapter in its own graph. This evidence makes no claim that separately launched graph processes share one global scheduler, and it does not claim a durable global AI journal.

## Governed model protocol

The message contracts govern the process-boundary shapes:

- `ai.work-request@1.4.0` accepts either retained legacy scheduler input or a strict `model_request` with protocol version, purpose, model, exact source/context fields, policy/instruction identity, budgets, and work identity.
- `ai.work-completed@1.4.0` accepts either retained legacy result input or a strict model success/failure result with protocol-identified extraction/classification response, request fingerprint, and explicit error shape.
- Shared validation lives in `contracts/model-protocol.mjs`; no model lane or classifier imports another service's implementation.
- The endpoint response is exactly the governed protocol response. Extraction text and classification suggestions are bounded before any domain message is constructed. Endpoint output cannot supply Argus item identity, revision, provenance, or evidence identifiers.

## Provider-neutral HTTP and configuration

The extractor and classifier receive only `ARGUS_MODEL_NAME`. The serial model lane alone receives `ARGUS_MODEL_ENDPOINT`, `ARGUS_MODEL_NAME`, and `ARGUS_MODEL_TIMEOUT_MS` through the Node provider's manifest-declared allowlist. Unrelated services receive none of the model configuration variables.

The model lane uses built-in `fetch` only. Its endpoint must be HTTP on exactly `localhost`, `127.0.0.1`, or `::1`; HTTPS, non-loopback hosts, credentials in the URL, and invalid timeout/model configuration fail closed. The standalone path supplies Ollama's loopback `/api/generate` protocol through `ARGUS_MODEL_PROTOCOL=ollama`; no provider SDK or authentication is added.

Extraction sends the exact authoritative source segments, bounded related context, policy profile, instruction version, explicit character/token limits, and stable work/session/window identity. Classification receives an explicit finalized `transcript.context-window` message and combines it with the stored item's authoritative ID/revision/text/source range. Its request contains the exact source transcript, bounded lookback context, optional bounded forward context, and all considered evidence segment IDs. It never queries transcript ownership directly.

## Failure, capacity, and cleanup evidence

The shared lane retries transient endpoint failures twice using the same `work_id`, request fingerprint, and exact request. Endpoint unavailability, timeout, malformed JSON, and invalid structured output produce explicit retryable failure evidence and no draft. No empty, guessed, fallback, or partial item is emitted.

Extraction retains at most 32 admitted request contexts. Classification retains at most 32 explicit context windows and 32 admitted request contexts. Rejected admission never inserts state; successful completion, terminal model failure, invalid terminal output, conflict, and drain remove retained state. Terminal failure details retain the work/request fingerprint and exact-context assertion without retaining an orphaned map entry.

The durable, globally shared AI journal is explicitly deferred. The current graph still proves concurrency-one, priority, bounded admission, stable identity, and retry behavior with an in-memory journal. A durable global journal is a prerequisite for integrated application/storage work and must be coordinated with Phase 6 rather than silently inferred from this graph.

## Replacement and lifecycle evidence

The concise and passthrough deterministic extractors remain available in their original Phase 5A graph and occupy the same logical `transcript.context-window` to `logged-item.draft` position as the HTTP extractor. The focused suite proves unchanged-neighbor preparation and fake/HTTP replacement.

The eight-service model graph proves readiness, explicit health paths, completion, optional degradation, and drain behavior. Extraction remains after finalized context selection; classification remains after `logged-item.stored` and receives the same selected context through an explicit wire.

## Executable evidence

Focused proof:

```text
node --test tests/phase5b-model-adapter.test.mjs
```

The focused suite proves 14 tests: strict context/budget and protocol fixtures; shared lane/workload wires; sibling-service isolation; successful replay-safe extraction; deterministic replacement; stable retry; unavailable, timeout, malformed JSON, and invalid output with no item; forged model identity rejection; explicit classification transcript context; optional revision-bound classification; workload-purpose mismatch rejection; model configuration allowlisting and loopback-only forms; and bounded classification context admission.

Final gate results: `npm.cmd test` passed 101/101; `npm.cmd run contracts:check` passed for 37 governed messages; and `npm.cmd run contracts:docs:check` reported the generated reference current. Existing demos and measurement matrices were not rerun in this corrective batch. No provider runtime, model installation, credential handling, durable product storage, durable global AI journal, Phase 6 lifecycle, browser UI integration, microphone, or real STT work was started.
