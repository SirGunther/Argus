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

## ADR-004 — Classification is optional idle-time enrichment

**Status:** Proposed  
**Date:** 2026-08-11

### Problem

A task/note/observation/idea suggestion may be useful, but making that decision during extraction competes with live processing and presents an uncertain label too early. Classification often requires more context than the exact sentence that produced the log.

### Decision

Classification is a separate asynchronous capability. It runs after a LoggedItem exists, preferably when live transcription and extraction are not consuming the available model budget. It may suggest a category but may not mutate the LoggedItem.

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
