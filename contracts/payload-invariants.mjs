import { createHash } from 'node:crypto';

export function validatePayloadInvariants(messageType, payload) {
  if (messageType === 'transcript.context-window') return validateContextWindow(payload);
  if (messageType === 'scribe.batch-admitted') return validateScribeBatchAdmitted(payload);
  if (messageType === 'scribe.batch-evaluated') return validateScribeBatchEvaluated(payload);
  if (messageType !== 'audio.chunk') return [];
  const errors = [];
  let bytes;
  try {
    bytes = Buffer.from(payload.audio_base64, 'base64');
  } catch {
    return ['$.payload.audio_base64 is not decodable base64'];
  }

  if (bytes.toString('base64') !== payload.audio_base64) errors.push('$.payload.audio_base64 must use canonical padded base64');
  if (bytes.byteLength !== payload.byte_length) errors.push(`$.payload.byte_length declares ${payload.byte_length}; decoded audio contains ${bytes.byteLength} bytes`);
  if (bytes.byteLength !== payload.sample_count * 2) errors.push('$.payload.sample_count must equal decoded PCM16 byte length divided by two');
  const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (checksum !== payload.checksum) errors.push('$.payload.checksum does not match decoded audio bytes');
  return errors;
}

function validateScribeBatchAdmitted(payload) {
  const errors = [];
  const identity = payload.batch_identity;
  const evidence = payload.new_evidence_segments || [];
  if (identity?.segments?.length !== evidence.length) errors.push('$.payload.new_evidence_segments must match batch_identity.segments count');
  evidence.forEach((segment, index) => {
    const expected = identity?.segments?.[index];
    if (!expected || segment.segment_id !== expected.segment_id || segment.revision !== expected.revision || segment.sequence !== expected.sequence) {
      errors.push('$.payload.new_evidence_segments must exactly match batch_identity segment order, revision, and sequence');
    }
  });
  if (payload.instruction_version !== identity?.instruction_version) errors.push('$.payload.instruction_version must match batch_identity.instruction_version');
  const evidenceIds = new Set(evidence.map((segment) => segment.segment_id));
  if ((payload.background_context?.transcript_segments || []).some((segment) => evidenceIds.has(segment.segment_id))) errors.push('$.payload.background_context cannot represent new evidence as background');
  return errors;
}

function validateScribeBatchEvaluated(payload) {
  const errors = [];
  const batch = payload.batch;
  if (payload.batch_attempt !== batch?.attempt) errors.push('$.payload.batch_attempt must equal batch.attempt');
  if (batch?.outcome === 'items-recorded' && batch.acknowledgement?.accepted === true && batch.acknowledgement.logged_item_ids.length !== batch.items.length) {
    errors.push('$.payload.batch.acknowledgement.logged_item_ids must correspond one-for-one with items');
  }
  const sourceIds = new Set((batch?.batch_identity?.segments || []).map((segment) => segment.segment_id));
  if ((batch?.items || []).some((item) => item.source_segment_ids.some((id) => !sourceIds.has(id)))) errors.push('$.payload.batch.items cannot cite evidence outside batch_identity');
  return errors;
}

function validateContextWindow(payload) {
  const errors = [];
  const source = payload.segments || [];
  if (source.length) {
    for (let index = 1; index < source.length; index += 1) {
      if (source[index].sequence !== source[index - 1].sequence + 1) errors.push('$.payload.segments must be a contiguous authoritative sequence');
    }
    const first = source[0];
    const last = source.at(-1);
    if (payload.source?.first_segment_id !== first.segment_id || payload.source?.last_segment_id !== last.segment_id || payload.source?.start_time !== first.start_time || payload.source?.end_time !== last.end_time) {
      errors.push('$.payload.source must exactly identify the authoritative segments range');
    }
    const sourceIds = new Set(source.map((segment) => segment.segment_id));
    for (const context of payload.context_segments || []) {
      if (sourceIds.has(context.segment_id)) errors.push('$.payload.context_segments cannot duplicate authoritative source ownership');
      if (context.relation === 'lookback' && context.sequence >= first.sequence) errors.push('$.payload.context_segments lookback must precede the source range');
      if (context.relation === 'forward' && context.sequence <= last.sequence) errors.push('$.payload.context_segments forward context must follow the source range');
    }
    if (payload.selection) {
      const count = source.reduce((sum, item, index) => sum + item.text.length + (index ? 1 : 0), 0);
      if (payload.selection.source_segment_count !== source.length || payload.selection.source_char_count !== count) errors.push('$.payload.selection source counts must match the authoritative range');
      if (!payload.triggered_reasons?.includes(payload.reason)) errors.push('$.payload.triggered_reasons must include the primary reason');
    }
    if (payload.generation_directive && payload.context_segments) {
      const scope = payload.generation_directive.context_scope;
      const lookback = payload.context_segments.filter((item) => item.relation === 'lookback').length;
      const forward = payload.context_segments.filter((item) => item.relation === 'forward').length;
      const chars = payload.context_segments.reduce((sum, item, index) => sum + item.text.length + (index ? 1 : 0), 0);
      if (scope.lookback_segment_count !== lookback || scope.forward_segment_count !== forward || scope.source_range_only !== (payload.context_segments.length === 0)) errors.push('$.payload.generation_directive context counts must match context_segments');
      if (chars > scope.max_context_chars) errors.push('$.payload.context_segments exceeds the declared context character bound');
    }
  }
  return errors;
}
