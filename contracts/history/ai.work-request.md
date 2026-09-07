# ai.work-request history

## 1.5.0

- Added the batch-shaped Scribe model-request variant (protocol version 2.0.0) for `logged-item-extraction`: a stable `batch_identity` (session, ordered finalized segment id/revision list, first/last sequence, admission reason, policy/instruction version, immutable request id), `new_evidence_segments` carrying only the new authoritative finalized rows, and a separate bounded `background_context` (transcript lookback plus prior non-authoritative Logged Items retained for duplicate suppression). The existing single-window 1.0.0 request shape is retained unchanged for compatibility.

## 1.4.0

- Governed provider-neutral model request protocol identity, exact extraction/classification request shapes, bounded transcript context, and purpose-bound workload admission.

## 1.3.0

- Added `transcript-correction-formatting` between transcription and logged-item extraction in the fixed serial AI priority order.

## 1.2.0

- Introduced global serial AI-lane work with explicit priority class and sequence.
