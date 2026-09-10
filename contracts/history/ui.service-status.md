# `ui.service-status` 1.0.0

Initial per-capability availability projection. An optional classification failure is independent from transcript and logged-item editing.

## 1.1.0 — 2026-09-10

Added the `scribe` capability so session-level Scribe availability projects independently from `model` and `logged-item-pipeline`. A stalled Scribe batch leaves the model provider and Logged Item editing untouched, so collapsing it into either capability would misreport both. The enum addition is additive; every existing capability value and the `status` enum are unchanged.
