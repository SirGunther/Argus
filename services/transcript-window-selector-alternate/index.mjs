import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';

const SERVICE = 'transcript-window-selector-alternate';
const INSTANCE = process.env.ARGUS_SERVICE_INSTANCE_ID || SERVICE;
const policies = new Map();
const pending = new Map();

runLineService({ service: SERVICE, operations: {
  'transcript.context-policy': { name: 'configure-alternate-context-selection', handle(message) {
    const policy = message.payload;
    if (!policy?.session_id || !policy.policy_id) throw new ServiceOperationError('valid context policy is required', { code: 'INVALID_INPUT', category: 'validation' });
    policies.set(policy.session_id, policy);
    return [{ plane: 'control', messageType: 'transcript.context-policy', identityKey: `alternate-context-policy:${policy.session_id}:${policy.policy_id}:${policy.policy_version}`, payload: policy }];
  } },
  'transcript.segment': { name: 'select-alternate-window', handle(message) {
    const segment = message.payload;
    const policy = policies.get(segment.session_id);
    if (!policy) throw new ServiceOperationError('context policy must be configured first', { code: 'CONTEXT_POLICY_MISSING', category: 'conflict' });
    const source = pending.get(segment.session_id) || [];
    source.push(segment); pending.set(segment.session_id, source);
    const chars = source.reduce((sum, item, index) => sum + item.text.length + (index ? 1 : 0), 0);
    const elapsed = Math.max(0, clockMs(segment.end_time) - clockMs(source[0].start_time));
    const reasons = [];
    if (policy.triggers.pause_enabled && segment.boundary === 'pause') reasons.push('pause');
    if (source.length >= policy.triggers.max_source_segments || chars >= policy.triggers.max_source_chars) reasons.push('size');
    if (policy.triggers.topic_boundary_after_sequences.includes(segment.sequence)) reasons.push('topic');
    if (elapsed >= policy.triggers.max_latency_ms) reasons.push('latency');
    if (!reasons.length) return [];
    pending.delete(segment.session_id);
    const first = source[0]; const last = source.at(-1); const reason = ['pause', 'size', 'topic', 'latency'].find((item) => reasons.includes(item));
    return [{ messageType: 'transcript.context-window', schemaVersion: '1.4.0', identityKey: `alternate-context-window:${INSTANCE}:${segment.session_id}:${first.sequence}-${last.sequence}`, payload: {
      window_id: `${segment.session_id}-alternate-window-${first.sequence}-${last.sequence}`, session_id: segment.session_id, reason, triggered_reasons: reasons,
      segments: source.map(project), source: { first_segment_id: first.segment_id, last_segment_id: last.segment_id, start_time: first.start_time, end_time: last.end_time }, context_segments: [],
      selection: { policy_id: policy.policy_id, policy_version: policy.policy_version, trigger_observed_at_sequence: segment.sequence, source_segment_count: source.length, source_char_count: chars, elapsed_ms: elapsed },
      generation_directive: { purpose: 'logged-item-extraction', policy_profile: policy.generation.policy_profile, instruction_version: policy.generation.instruction_version,
        context_scope: { source_range_only: true, lookback_segment_count: 0, forward_segment_count: 0, max_context_chars: policy.context.max_context_chars } }
    } }];
  } }
} });

function project({ segment_id, sequence, start_time, end_time, text }) { return { segment_id, sequence, start_time, end_time, text }; }
function clockMs(value) { const match = /^(\d+):(\d+):(\d+)\.(\d{3})$/.exec(value); return match ? (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4]) : 0; }
