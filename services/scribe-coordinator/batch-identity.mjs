import { createHash } from 'node:crypto';

// Stable scribe_batch_identity (contracts/scribe-batch-identity.schema.json, ADR-021). The
// request_id is derived only from the exact ordered segment set plus the governed
// policy/instruction identity, so retrying the identical batch (coordinator.mjs) reuses the
// identical request_id and never fabricates a new logical batch for the same evidence.
export function buildBatchIdentity({ sessionId, segments, admissionReason, policy }) {
  if (!sessionId || typeof sessionId !== 'string') throw new TypeError('sessionId is required');
  if (!Array.isArray(segments) || !segments.length) throw new TypeError('at least one segment is required to build a batch identity');
  const projected = segments.map(({ segment_id, revision, sequence }) => ({ segment_id, revision: Number.isInteger(revision) ? revision : 0, sequence }));
  const first = projected[0];
  const last = projected.at(-1);
  return Object.freeze({
    request_id: stableBatchRequestId({ sessionId, segments: projected, policy }),
    session_id: sessionId,
    segments: projected,
    first_sequence: first.sequence,
    last_sequence: last.sequence,
    admission_reason: admissionReason,
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    instruction_version: policy.generation.instruction_version
  });
}

export function stableBatchRequestId({ sessionId, segments, policy }) {
  const material = JSON.stringify({
    session_id: sessionId,
    segments: segments.map((segment) => ({ segment_id: segment.segment_id, revision: segment.revision, sequence: segment.sequence })),
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    instruction_version: policy.generation.instruction_version
  });
  return `scribe-batch-${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}
