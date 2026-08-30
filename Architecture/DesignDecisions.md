# Argus Design Decisions

This file records product and system decisions discovered while evaluating the Active Assistant POC. It is intentionally separate from the base architecture rules: those files describe how the system is built; this file records why a particular product behavior exists.

System-runtime decisions, including the explicit domain/control plane boundary, are recorded in `RuntimeKernelAndPlanes.md`.

## Decision status

- **Accepted** — use this direction until a later decision explicitly replaces it.
- **Proposed** — worth prototyping, but important behavior remains open.
- **Open** — a question that needs evidence or user testing.

---

## ADR-001 — The primary output is a neutral logged item

**Status:** Accepted  
**Date:** 2026-08-11

### Problem

The first POC labeled every derived entry as a task, note, observation, or idea while it was being extracted. That made an uncertain model judgment look authoritative and added vertical weight to the list. It also coupled two different responsibilities: finding a useful statement and interpreting its semantic type.

### Decision

The live extraction pass creates a **LoggedItem**, not a classified task, note, observation, or idea.

The primary UI presents only the concise logged text, its creation time, and its transcript provenance. Classification is not required to create or save the item. The logged text remains editable, and user edits are authoritative.

### Consequences

- Live extraction has a smaller and more deterministic output contract.
- A useful log can exist even when classification is uncertain or unavailable.
- The primary list stays visually compact.
- Any later classification must be clearly represented as a suggestion, not as the identity of the log.

---

## ADR-002 — Every logged item carries an explicit transcript source range

**Status:** Accepted  
**Date:** 2026-08-11

### Problem

A concise log is difficult to trust or reinterpret if the system cannot show which speech produced it. Using only the last sentence or the last few transcript rows also loses the context that may change the meaning of the item.

### Decision

Every LoggedItem records the exact transcript span considered during extraction. Timestamps are displayed to the user, but stable transcript segment IDs are the persistent anchors.

Minimum contract:

```json
{
  "item_id": "log-1842",
  "session_id": "session-42",
  "created_at": "2026-08-11T16:23:46Z",
  "text": "Investigate whether the owner value resets before the API call.",
  "revision": 3,
  "source": {
    "first_segment_id": "segment-109",
    "last_segment_id": "segment-113",
    "start_time": "16:23:22",
    "end_time": "16:23:41"
  }
}
```

The UI exposes the range compactly. Selecting it should reveal or retrieve the associated transcript rows. Editing the logged text does not erase its original provenance.

### Consequences

- Every logged item can explain where it came from.
- Reprocessing and audit behavior can use stable segment IDs rather than guessing from text.
- Archived transcript segments must remain addressable after they leave the active UI window.
- If a user changes the source association in the future, that change should be versioned rather than silently replacing the original range.

---

## ADR-003 — Extraction is chunk-driven and stays off the word-by-word path

**Status:** Accepted in principle; trigger thresholds remain open  
**Date:** 2026-08-11

### Problem

Sending every word or transcript mutation for analysis is expensive, noisy, and likely to produce unstable logs. Waiting too long, however, makes the live assistant feel unresponsive.

### Decision

Transcript segments accumulate into a candidate window. Extraction is scheduled when the window is likely coherent, using signals such as:

- a meaningful speech pause;
- a topic or intent boundary;
- a minimum accumulated text/token threshold;
- a maximum latency threshold so a long monologue still produces output;
- available processing capacity outside the latency-sensitive transcription work.

The transcript writer remains independent from extraction. The extractor receives an immutable ContextWindow message and emits a LoggedItemDraft. It never reads transcript storage directly.

### Open measurements

- Pause length that best indicates a usable boundary
- Minimum and maximum chunk size
- Maximum acceptable delay before a log appears
- Whether forward context should be allowed to revise a recently emitted log
- How often overlapping windows create duplicates

---

## ADR-004 — Classification is optional lowest-priority enrichment

**Status:** Accepted  
**Date:** 2026-08-12

### Problem

A task/note/observation/idea suggestion may be useful, but making that decision during extraction competes with live processing and presents an uncertain label too early. Classification often requires more context than the exact sentence that produced the log.

### Decision

Classification is a separate deferred capability. It runs after a LoggedItem exists and occupies the lowest-priority workload in the one global, sequential AI execution lane. It may suggest a category but may not mutate the LoggedItem.

Suggested service boundary:

```text
transcript-window-selector
    ContextWindowRequest -> ContextWindow

log-extractor
    ContextWindow -> LoggedItemDraft

classification-suggester
    ClassificationRequest -> ClassificationSuggestion

logged-item-store
    owns LoggedItem state and revisions
```

The suggestion should be reviewable and editable if classification is added to the UI. Until that review interaction is designed, no classification badge appears in the primary logged-item list.

### Required classification payload

```json
{
  "session_id": "session-42",
  "item_id": "log-1842",
  "item_revision": 3,
  "current_log_text": "Investigate whether the owner value resets before the API call.",
  "source_range": {
    "first_segment_id": "segment-109",
    "last_segment_id": "segment-113"
  },
  "source_transcript": [
    { "segment_id": "segment-109", "timestamp": "16:23:22", "text": "..." },
    { "segment_id": "segment-113", "timestamp": "16:23:41", "text": "..." }
  ],
  "lookback_context": [
    { "segment_id": "segment-104", "timestamp": "16:22:58", "text": "..." }
  ],
  "taxonomy_version": 1
}
```

Context priority is:

1. The exact source range is mandatory.
2. A bounded lookback window supplies the preceding topic and references.
3. Optional forward context may be used only when re-evaluating a stabilized item.
4. Context is limited by an explicit token/time budget, not by an arbitrary row count.
5. The response echoes `item_id`, `item_revision`, and source IDs so stale results can be rejected.

A possible result contract:

```json
{
  "item_id": "log-1842",
  "item_revision": 3,
  "suggested_classification": "task",
  "confidence": 0.78,
  "evidence_segment_ids": ["segment-109", "segment-113"],
  "model": "configured-model-id",
  "taxonomy_version": 1
}
```

### Consequences

- Classification cannot delay or prevent transcript capture and log extraction.
- A stale suggestion is discarded when its `item_revision` no longer matches the authoritative LoggedItem.
- The system can change or replace the classifier without changing the extractor.
- Model cost and latency for enrichment can be scheduled and measured separately.
- The product still needs a decision about where suggestions are reviewed and whether accepted categories affect export, filtering, or downstream automation.

---

## ADR-005 — Notifications occupy top-center negative space

**Status:** Accepted for the POC  
**Date:** 2026-08-11

Toast notifications are anchored in the unused top-center portion of the primary window. They must not obscure the newest transcript or logged items at the bottom of either live pane. On narrow layouts, the notification region may move below the header when the header no longer has sufficient negative space.

---

## ADR-006 — AI work uses one durable, non-preemptive execution lane

**Status:** Accepted  
**Date:** 2026-08-12

### Problem

The local AI agent cannot process several requests concurrently. Uncoordinated calls would create hidden competition, unpredictable completion order, and trace-management complexity without increasing actual model throughput.

### Decision

All local AI work enters one bounded, durably journaled lane with concurrency exactly one. A running task is never preempted; it reaches success or the terminal outcome allowed by its explicit recovery policy before another task starts.

Pending work is selected by fixed workload priority and FIFO within each workload:

1. `transcription`
2. `logged-item-extraction`
3. `classification-enrichment`

Admission is atomic with respect to scheduling: the executor cannot select work while earlier admissions are waiting for their durable queue record. When capacity is exhausted, enqueue fails explicitly with `AI_BACKLOG_FULL`; accepted work is never silently dropped. Unfinished journal entries are recovered after restart and re-enter the same priority/FIFO policy.

### Consequences

- Model utilization is predictable and easy to reason about.
- Classification can wait indefinitely behind live-critical work by design.
- Priority does not interrupt an active request; it only selects the next request.
- Queue depth, capacity, workload depths, active work, and oldest queued time are observable.
- If future hardware supports safe concurrency, changing the value requires a replacement decision and new ordering/recovery proofs.

---

## ADR-007 — Audio is ephemeral after transcription

**Status:** Accepted  
**Date:** 2026-08-12

### Problem

Retaining raw speech by default increases privacy, storage, permission, encryption, deletion, and recovery obligations. The product needs the transcript, not a recording or playback archive. At the same time, a future real STT provider might require the original bytes for a bounded retry.

### Decision

Audio is an ephemeral input. The capture service emits bounded audio chunks; STT processes a chunk and releases its bytes after the operation reaches a terminal outcome. Successful transcription never creates a raw-audio archive. The Phase 4 fake uses PCM signed 16-bit little-endian samples at 16 kHz, mono.

Any future retry buffer is a distinct capability with an explicit owner, limit, retention deadline, encryption/deletion rules, permission declaration, and wire policy. It cannot be inferred from ordinary transcript persistence.

### Consequences

- Argus does not provide playback or recording history by accident.
- Transcript evidence retains chunk identities, time ranges, and fingerprints rather than audio bytes.
- A retry that requires discarded bytes must fail explicitly until a governed retry buffer exists.
- Real microphone and STT SDK choices remain deferred in `PENDING-DECISIONS.md`.

---

## ADR-008 — Confidence commits words; finalized segments own editable state

**Status:** Accepted  
**Date:** 2026-08-12

### Problem

Streaming STT repeatedly revises its best current hypothesis. Treating every hypothesis as authoritative would create unstable edits, duplicate extraction, and ambiguous history. Waiting for an entire long utterance would make the live transcript feel slow.

### Decision

STT may emit a replaceable `transcript.partial` projection while words remain uncertain. Partial text is visible and read-only; it does not enter context selection, extraction, or permanent history.

As confidence is reached, STT emits ordered committed-word evidence incrementally. Once committed, STT does not overwrite that word. The active transcript owner assembles committed words into a finalized `transcript.segment` at an explicit boundary. Finalized segments receive stable identity and sequence, may feed downstream extraction, and become user-editable through optimistic revisions. User edits preserve the original STT text and word provenance.

Permanent transcript history accepts only finalized committed segment revisions through its own explicit contract. Session-close orchestration remains Phase 6 work.

### Consequences

- The user sees responsive word-by-word progress without exposing unstable text as durable truth.
- Provider corrections may replace provisional text but cannot silently rewrite committed evidence.
- Only one state owner can turn committed evidence into editable transcript state.
- Thresholds and real-provider confidence behavior require evidence and remain tracked in `PENDING-DECISIONS.md`.

---

## ADR-009 — Contextual correction proposes; the active transcript owner decides

**Status:** Accepted  
**Date:** 2026-08-12

### Problem

Voice recognition inevitably confuses acoustically similar words, and surrounding meaning often reveals the better interpretation only after more speech arrives. Some STT providers perform this revision and punctuation internally; others expose only partials, confidence, or alternatives. Allowing either a provider or a language model to rewrite committed text would erase evidence and couple Argus to one service's behavior.

### Decision

Argus separates immutable acoustic evidence from the best current rendered transcript. STT emits committed words and any available similar-sounding alternatives. A replaceable contextual-correction capability may use an exact bounded word range and a versioned instruction/policy profile to emit `transcript.word-correction-proposed`.

The proposal names the target word, expected source text, replacement, alternatives, confidence, basis, context range, implementation, policy profile, and instruction version. Only the active transcript owner may accept it. Acceptance changes the rendered projection before finalization while preserving source text and the proposal ID in word provenance. It never overwrites `transcript.word-committed`.

After finalization, all corrections—including user edits—use an optimistic segment revision. A stale target, correction, or edit is explicitly rejected.

### Consequences

- Provider-native correction can be used without being required.
- A local AI grammar/context component can be added or replaced without changing STT or transcript storage.
- Similar-sounding candidates can be highlighted from governed alternatives/proposals, with confidence presented as assistance rather than truth.
- Correction and logged-item generation are reproducible because their contracts name exact context plus versioned instruction/policy profiles; context windows also bound lookback, forward context, and character budget.
- Correction consumes the serial AI lane only if its implementation actually uses the local model; it cannot bypass transcription priority.

---

## ADR-010 — Punctuation is provisional until segment finalization

**Status:** Accepted  
**Date:** 2026-08-12

### Problem

Question marks, exclamation points, capitalization, and sentence boundaries frequently become clear later than individual words. Provider capabilities vary, and reacting to punctuation revisions would destabilize extraction.

### Decision

Partial punctuation and capitalization remain part of the replaceable read-only projection. At a pause, size, latency, or flush boundary, the active transcript owner finalizes the best accepted wording and structure. It records whether formatting came from the STT provider, the active owner, or a contextual-language proposal. Downstream extraction and history receive finalized segments only.

### Consequences

- The UI can behave like established live dictation tools: one provisional line settles into a punctuated editable segment.
- Lexical STT evidence stays auditable independently of presentation formatting.
- Argus can use provider punctuation when available and add an adjacent formatter when needed.
- Production endpointing, punctuation quality, and correction thresholds remain evidence-driven choices.

---

## ADR-011 — The live transcript behaves as a working document

**Status:** Accepted and implemented for the deterministic Phase 4C proof  
**Date:** 2026-08-12

### Decision

Argus immediately displays one read-only provisional row per active utterance. Partial revisions replace that row in place as wording, capitalization, grammar, and punctuation improve. Finalization replaces it with an editable authoritative segment rather than creating a competing duplicate row.

Argus synthesizes stable word IDs from its own session-scoped sequence when a provider does not supply usable identifiers. Correction proposals and UI review affordances therefore do not depend on a provider-specific identity feature.

Eligible corrections are accepted automatically before finalization only when the target ID and expected source text still match and proposal confidence reaches the explicit policy threshold. The deterministic proof uses 0.90; this is a test value, not a production claim.

The UI should highlight only `unresolved-ambiguity` or `correction-review` flags. Ordinary low-confidence tokens and automatically accepted corrections remain visually quiet. A future affordance may show candidates and provenance on interaction.

### Consequences

- The user always sees feedback and does not wait for perfect text before knowing the system works.
- Live changes resemble established dictation behavior without granting the provider authority over durable history.
- Provider-native word IDs, alternatives, punctuation, and correction can be used when available but are not mandatory.
- Production thresholds and the exact visual treatment require later evidence/UI work.

---

## ADR-012 — Every authoritative finalized transcript revision is appended

**Status:** Accepted and implemented in memory for Phase 4C  
**Date:** 2026-08-12

### Decision

Finalized revision 0 is appended to permanent transcript history immediately. Each accepted optimistic segment edit creates and appends revision 1, 2, and so on. Permanent history never replaces an earlier entry. Exact at-least-once replay is idempotent; identity reuse with different content is a terminal integrity conflict.

### Consequences

- The current active projection can show only the latest revision while audit/history explains how it evolved.
- Original STT and accepted correction provenance survive subsequent user edits.
- Phase 6 durable storage and session sealing must preserve this append-only contract.

---

## ADR-013 — Context selection is policy-driven and preserves singular source ownership

**Status:** Accepted and implemented for the deterministic Phase 4D proof  
**Date:** 2026-08-13

### Decision

The first satisfied pause, size, deterministic topic, or maximum-latency trigger closes the current authoritative source window. Maximum latency is a mandatory safety ceiling. When signals coincide, the window records every satisfied reason while using the stable precedence `pause`, `size`, `topic`, `latency`, `flush` for its primary reason.

Authoritative source ranges are contiguous and non-overlapping. Bounded lookback or forward segments may accompany the range as `context_segments`, but they are explicitly related context and never duplicate source ownership. Exact source segment IDs and timestamps remain mandatory.

The topic signal is an injected sequence list in the session policy, not an AI classification. Production thresholds and topic detection remain evidence-driven. Partial hypotheses have no accepted port into context selection, extraction, or permanent history.

Deterministic transcription enters the governed `transcription` scheduler workload through an explicit gate. The POC executor is a pass-through reference because the fake STT does not require a model, but it proves concurrency-one admission and the same highest-priority boundary a real adapter must use.

### Consequences

- Selection behavior is reproducible from a versioned session policy.
- Overlapping context can improve interpretation without creating competing provenance.
- The architecture proves priority and replacement wiring without prematurely selecting an STT, model, or topic-classification package.
- An alternate STT and alternate context selector can occupy the same graph positions without changing neighbors or wires.

---

## ADR-014 — Phase 5 separates model transport, logged-item ownership, and durability

**Status:** Accepted for Phase 5 implementation  
**Date:** 2026-08-18

### Decision

Phase 5 is delivered in two bounded batches. Phase 5A proves logged-item active ownership, append-only history ownership, revision behavior, and exact transcript provenance with deterministic components. Both owners are in memory for this phase; durable files, databases, retention, and eviction remain Phase 6 concerns.

Phase 5B may connect a local model through a provider-neutral HTTP adapter. Endpoint URL, model name, and timeout are injected through environment variables. No provider-specific SDK is selected, and the deterministic implementation remains available for tests and offline operation.

If a model endpoint is unavailable, times out, or returns invalid structured output, the operation fails explicitly and retains its exact context window for retry. It creates no empty, guessed, or partially validated logged item. Classification remains a separate optional lowest-priority suggestion and cannot block or mutate the primary logged item.

### Consequences

- Model transport can change without changing neighboring logged-item contracts or ownership.
- Logical active/history behavior can be proven before choosing a durable storage format.
- Tests and offline operation do not require a running model server.
- A specific local runtime/model remains an evidence-driven Phase 5B decision under `MOD-001`.
- Phase 5A cannot silently expand into local-model integration, disk persistence, or Phase 6 lifecycle work.

---

## ADR-015 — Phase 6 uses a replaceable filesystem session-storage boundary

**Status:** Accepted and implemented for the deterministic POC  
**Date:** 2026-08-19

### Problem

Phase 4 and Phase 5 proved transcript and logged-item ownership in memory, but a long session could not bound finalized active history, survive process restart, or seal a session without guessing what had already been accepted. The POC also needed a narrowly scoped way to locate a session folder without granting arbitrary filesystem authority to other components.

### Decision

The POC uses a replaceable filesystem-backed storage boundary configured only for declared storage and locator owners through `ARGUS_SESSION_ROOT`. Each session has the deterministic layout:

```text
<root>/<session_id>/active/
  session.json
  transcript.json
  logged-items.json
  finalization.json
<root>/<session_id>/permanent/
  transcript.history.ndjson
  logged-item.history.ndjson
  close.evidence.json
```

Session metadata and current active projections are versioned JSON snapshots replaced through a temporary file and rename. Permanent transcript and logged-item revisions are append-only NDJSON records. History entries are keyed by stable revision identity and compare semantic fingerprints on replay; changed content under an existing identity is an explicit integrity conflict.

Record creates a recording session. Stop changes only lifecycle metadata and preserves active projections. Resume reuses the same session identity. Close blocks new writes, records progress through `writes-blocked`, `drained`, `active-persisted`, `history-reconciled`, `sealed`, and `released`, verifies authoritative history, writes close evidence, and releases evictable in-memory revision cache. A restart resumes from the persisted phase or reports an integrity failure; it never reopens a sealed session or guesses missing data. Exact command replay returns the original outcome, while contradictory operation/session identity reuse fails.

The session-folder locator receives only a session identity and returns the validated active/permanent locations beneath the configured root. It cannot resolve arbitrary caller-supplied paths. The active transcript and logged-item owners and their permanent-history counterparts are the declared state/storage owners; unrelated services continue to communicate only through governed messages and graph wires.

### Consequences

- The Phase 4E active-history bound is executable without deleting authoritative data: finalized revisions leave the bounded active cache but remain resolvable from permanent history.
- JSON and NDJSON are a POC implementation choice behind the service boundary, not a permanent prohibition on replacing the implementation with an embedded database later.
- Close recovery is deterministic only for the persisted local files and tested interruption points; global durability, backup, synchronization, encryption, migration, and cloud storage are not claimed.
- The durable globally shared AI journal remains explicitly deferred and is not part of Phase 6.

---

## ADR-016 — Browser UI consumes projections through a loopback bridge

**Status:** Accepted for the deterministic Phase 7 POC  
**Date:** 2026-08-19

### Decision

The browser is a read-only projection consumer. A small loopback-only Node bridge validates browser commands and validates the versioned projections it sends to the HTML POC. Session status, transcript rows, logged-item rows with exact source provenance, service/capability status, and command outcomes are the only browser-facing message shapes. Browser edits are routed to the transcript or logged-item authority with optimistic expected revisions; copy and folder actions route through explicit platform capability adapters.

Selection, scrolling, timestamp preference, presentation state, and toasts remain UI-owned and never become domain records. The bridge serves an allowlisted static surface and exposes no arbitrary file access. The browser POC remains separate from desktop packaging; `APP-001` and the final ambiguity-review treatment `UI-001` remain unresolved.

### Consequences

- Direct browser access to service memory, storage files, session folders, and internal journals is structurally absent.
- Stale, validation, unavailable, and capability failures remain visible without turning every failure into total application failure.
- The bridge can be replaced by a future desktop host without changing the browser projection or command contracts.
- The deterministic POC does not claim production transport, desktop packaging, authentication, or OS capability availability on every host.

---

## ADR-017 — Browser and Node remain the replaceable POC host

**Status:** Accepted for the Phase 8 POC foundation  
**Date:** 2026-08-22

### Decision

Argus retains the browser UI, loopback-only bridge, and Node composition host for the POC. This is a host selection for the current proof, not a permanent desktop or component-runtime commitment.

Host-specific filesystem, microphone, clipboard, folder, network, credential, device, process, and packaging access must remain behind explicit capability adapters, trusted runtime providers, declared permissions, and governed wires. Domain owners and consumers cannot import browser, Node, Electron, Tauri, container-engine, native-runtime, STT-provider, or model-provider implementations directly.

Phase 8 establishes default-deny permission declarations, the restrictions the installed Node host can honestly enforce, fail-closed unavailable-provider behavior, and deterministic inspectable package artifacts. No native compiler or OCI engine is installed, so actual native and container replacement proofs remain evidence-triggered under `NAT-001` and `CNT-001`; the implementation must not claim executable polyglot or container support until their conformance proofs pass.

Real microphone/audio capture, STT, and model-provider injection remain separate decisions under `AUD-002`, `STT-001`, `MOD-001`, and their related evidence rows. Phase 8 may declare and deny those capabilities but does not integrate them.

### Consequences

- The current POC remains runnable in a browser without introducing a desktop framework.
- A later desktop host can replace the bridge by implementing the same command, projection, and capability boundaries.
- Node can remain the orchestrator while individual components later use trusted native or container providers.
- Permission claims must distinguish OS-enforced restrictions from adapter-level denial and documented future enforcement.
- Phase 8 cannot silently expand into real audio, STT, AI-provider, desktop-shell, or observability work.

## ADR-018 — Component authority is declared, denied by default, and never simulated

**Status:** Accepted  
**Date:** 2026-08-22

### Decision

Every service manifest declares an explicit `permissions` block covering filesystem, microphone, clipboard, network, model credentials, child processes, worker threads, native add-ons, and WASI, plus an optional `resources` block. Anything a manifest does not state is denied: an omitted class, an omitted scope list, and an explicit `false` are the same authority — none.

Filesystem authority is declared as a **named host-neutral scope** (`session-root` or the read-only `stt-runtime`), never as a host path, so a manifest cannot express a traversal, an absolute path, or a drive letter, and a future container or native host can map the same scope onto its own mount without changing the manifest. The Node provider maps `stt-runtime` only to the canonical provisioned Whisper executable and model files.

The installed Node host enforces every restriction it can actually enforce — filesystem read, filesystem write, child processes, worker threads, add-ons, WASI, and the declared heap ceiling — by translating the declaration into real `--permission` flags. A capability the host **cannot** enforce is refused at declaration time rather than accepted and simulated, so a declaration never reads as a guarantee the runtime does not deliver. Microphone, clipboard for a component process, model credentials, component listeners, and container-only resource limits are therefore refused outright while `AUD-002`, `SEC-001`, and `CNT-001` remain unresolved.

Outbound network is **adapter-enforced, not OS-enforced**. The installed Node build ships no network permission flag; this was verified directly rather than assumed. Loopback-only restriction is enforced at the model configuration boundary and by refusing endpoint configuration unless the scope is declared, and the residual gap is recorded rather than papered over.

A manifest that selects a runtime kind with no installed trusted provider fails graph preparation before any process launches. Installing or selecting a runtime grants no connectivity and no permission by itself.

Each graph is reducible to a deterministic, inspectable package: the graph, the contract catalog and every schema and changelog it names, every component manifest with its fully expanded authority and declared files, the shared component libraries, and an integrity block of per-file hashes plus a package digest. Packaging refuses path escape, undeclared component files, secrets, and integrity drift.

### Consequences

- A reviewer can read exactly what any component may do, and the same file is what the launcher enforces.
- Adding authority to a component is a visible, reviewable manifest change that fails a pinned inventory test until it is deliberate.
- A component can no longer ship code that no declaration accounts for; helper modules must be declared through `runtime.includes`.
- Enforcement claims are separable into Node-runtime-enforced, adapter-enforced, and deferred, so the project never overstates what the host actually guarantees.
- The `service_manifest` artifact contract change is breaking for out-of-repository manifests. Artifact schemas are not independently versioned by the current governance model; that gap is recorded rather than worked around.

## ADR-019 — Electron is the standalone product host

**Status:** Accepted for the standalone application  
**Date:** 2026-08-24

### Decision

Electron owns the standalone desktop boundary. The main process owns OS permission requests, the per-user session root, host clipboard/folder capabilities, the supervised production graph, and shutdown. A context-isolated preload exposes only the validated UI command/projection boundary and the bounded audio-chunk path. The renderer has no Node integration, filesystem access, or process access.

The real desktop graph uses Electron microphone capture, whisper.cpp `v1.9.1` with `ggml-base.en.bin`, and Ollama `llama3.2:3b` through the existing provider-neutral model lane. Missing binaries, models, Ollama, or physical capture are visible degraded capabilities; no fake runtime is activated as a fallback. Browser/Node remains a deterministic POC host and replacement test surface.

### Consequences

- Packaging is a real Windows application artifact produced by Electron Forge, with an installer, zip, and unpacked executable.
- Domain contracts and service ownership remain unchanged; the desktop host replaces only the UI/host boundary and supplies a production graph.
- Physical microphone/model acceptance is still required for accuracy, latency, resource, licensing, and failure evidence.
- Credential storage remains unresolved because the selected initial local model path does not require credentials.
