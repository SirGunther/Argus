# ai.work-completed history

## 1.5.0

- Added the zero-to-many Scribe extraction response variant (protocol version 2.0.0): a `batch_identity` echo plus an `items` array (0-8) of proposed Logged Items, each with bounded text, optional non-authoritative `kind`, and exact new-evidence source segment identifiers. Proposed items cannot carry `item_id` or `revision`; only the governed logged-item owner assigns authoritative identity and revision. The existing single-`text` 1.0.0 response shape is retained unchanged for compatibility.

## 1.4.0

- Governed model response protocol identity, strict extraction/classification result shapes, request fingerprints, and explicit terminal failure details.

## 1.3.0

- Added completion evidence for the `transcript-correction-formatting` workload.

## 1.2.0

- Introduced terminal success for serial AI-lane work.
