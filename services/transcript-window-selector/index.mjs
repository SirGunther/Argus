import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { fingerprintValue } from '../../runtime/message-identity.mjs';
import { OrderedStreamError, OrderedStreamGuard } from '../../runtime/ordered-stream.mjs';

const SERVICE = 'transcript-window-selector';
const INSTANCE = process.env.ARGUS_SERVICE_INSTANCE_ID || SERVICE;
const DEFAULT_POLICY = Object.freeze({
  policy_id: 'legacy-window-default', policy_version: '1.0.0',
  triggers: { pause_enabled: true, max_source_segments: 3, max_source_chars: 262144, topic_boundary_after_sequences: [], max_latency_ms: 3600000 },
  context: { lookback_segment_count: 0, forward_segment_count: 0, max_context_chars: 262144 },
  generation: { policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0' }
});

const sessionState = new Map();
const ordering = new OrderedStreamGuard();
const acceptedSegments = new Map();

runLineService({ service: SERVICE, operations: {
  'transcript.context-policy': { name: 'configure-context-selection', handle(message) {
    const policy = message.payload;
    validatePolicy(policy);
    const state = stateFor(policy.session_id);
    if (state.policy && state.policy.policy_id === policy.policy_id && fingerprintValue(state.policy) !== fingerprintValue(policy)) {
      throw new ServiceOperationError(`Context policy id ${policy.policy_id} was reused with different content`, { code: 'CONTEXT_POLICY_CONFLICT', category: 'conflict' });
    }
    if (state.pending.length || state.deferredWindows.length) throw rejected('POLICY_CHANGE_DURING_ACTIVE_WINDOW', 'Context policy cannot change while a source window is active');
    state.policy = structuredClone(policy);
    return [{ plane: 'control', messageType: 'transcript.context-policy', identityKey: `transcript.context-policy:${policy.session_id}:${policy.policy_id}:${policy.policy_version}:accepted`, payload: policy }];
  } },
  'transcript.segment': { name: 'select-window', handle(message) {
    const segment = message.payload;
    validateSegment(segment);
    const segmentFingerprint = fingerprintValue(segment);
    const knownSegment = acceptedSegments.get(segment.segment_id);
    if (knownSegment) {
      if (knownSegment !== segmentFingerprint) throw new ServiceOperationError(`Segment id ${segment.segment_id} was reused with different content`, { code: 'SEGMENT_ID_CONFLICT', category: 'conflict' });
      return [];
    }
    try { ordering.accept(segment.session_id, segment.sequence); }
    catch (error) {
      if (error instanceof OrderedStreamError) throw new ServiceOperationError(error.message, { code: error.code, category: 'conflict', retryable: error.retryable, rejected: error.code === 'LATE_MESSAGE', details: { expected: error.expected, received: error.received, stream_id: error.streamId } });
      throw error;
    }
    acceptedSegments.set(segment.segment_id, segmentFingerprint);
    const state = stateFor(segment.session_id);
    const policy = state.policy || { ...DEFAULT_POLICY, session_id: segment.session_id };
    state.pending.push(segment);

    const outputs = releaseDeferredWindows(state, policy, segment);
    const reasons = satisfiedReasons(state.pending, segment, policy);
    if (reasons.length) {
      const source = state.pending.splice(0);
      const candidate = { source, reasons, policy, lookback: state.history.slice(-policy.context.lookback_segment_count), triggerSequence: segment.sequence, elapsedMs: durationMs(source[0].start_time, segment.end_time) };
      if (policy.context.forward_segment_count > 0) state.deferredWindows.push(candidate);
      else outputs.push(windowOutput(candidate, state.history, []));
      state.history.push(...source);
      trimHistory(state, policy.context.lookback_segment_count);
    }
    return outputs;
  } }
}, onDrain() {
  const outputs = [];
  for (const state of sessionState.values()) {
    while (state.deferredWindows.length) outputs.push(windowOutput(state.deferredWindows.shift(), state.history, []));
    if (state.pending.length) {
      const source = state.pending.splice(0);
      const policy = state.policy || { ...DEFAULT_POLICY, session_id: source[0].session_id };
      outputs.push(windowOutput({ source, reasons: ['flush'], policy, lookback: state.history.slice(-policy.context.lookback_segment_count), triggerSequence: source.at(-1).sequence, elapsedMs: durationMs(source[0].start_time, source.at(-1).end_time) }, state.history, []));
      state.history.push(...source);
      trimHistory(state, policy.context.lookback_segment_count);
    }
  }
  return outputs;
}});

function stateFor(sessionId) {
  const state = sessionState.get(sessionId) || { policy: undefined, pending: [], history: [], deferredWindows: [] };
  sessionState.set(sessionId, state);
  return state;
}

function satisfiedReasons(pending, segment, policy) {
  const reasons = [];
  const sourceChars = charCount(pending);
  if (policy.triggers.pause_enabled && segment.boundary === 'pause') reasons.push('pause');
  if (pending.length >= policy.triggers.max_source_segments || sourceChars >= policy.triggers.max_source_chars) reasons.push('size');
  if (policy.triggers.topic_boundary_after_sequences.includes(segment.sequence)) reasons.push('topic');
  if (durationMs(pending[0].start_time, segment.end_time) >= policy.triggers.max_latency_ms) reasons.push('latency');
  return reasons;
}

function releaseDeferredWindows(state, policy, current) {
  const outputs = [];
  const retained = [];
  for (const candidate of state.deferredWindows) {
    const forward = [current];
    candidate.forward = [...(candidate.forward || []), ...forward];
    if (candidate.forward.length >= policy.context.forward_segment_count) outputs.push(windowOutput(candidate, state.history, candidate.forward.slice(0, policy.context.forward_segment_count)));
    else retained.push(candidate);
  }
  state.deferredWindows = retained;
  return outputs;
}

function windowOutput(candidate, history, forward) {
  const { source, reasons, policy } = candidate;
  const first = source[0];
  const last = source.at(-1);
  const lookback = (candidate.lookback || history).filter((item) => item.sequence < first.sequence).slice(-policy.context.lookback_segment_count);
  const contextSegments = boundContext([
    ...lookback.map((item) => ({ ...project(item), relation: 'lookback' })),
    ...forward.filter((item) => item.sequence > last.sequence).map((item) => ({ ...project(item), relation: 'forward' }))
  ], policy.context.max_context_chars);
  const primaryReason = ['pause', 'size', 'topic', 'latency', 'flush'].find((reason) => reasons.includes(reason));
  const identity = `${first.session_id}:${first.sequence}-${last.sequence}:${policy.policy_id}:${policy.policy_version}`;
  return { messageType: 'transcript.context-window', schemaVersion: '1.4.0', identityKey: `transcript.context-window:${INSTANCE}:${identity}`, payload: {
    window_id: `${first.session_id}-window-${first.sequence}-${last.sequence}`, session_id: first.session_id, reason: primaryReason,
    triggered_reasons: reasons, segments: source.map(project),
    source: { first_segment_id: first.segment_id, last_segment_id: last.segment_id, start_time: first.start_time, end_time: last.end_time },
    context_segments: contextSegments,
    selection: { policy_id: policy.policy_id, policy_version: policy.policy_version, trigger_observed_at_sequence: candidate.triggerSequence, source_segment_count: source.length, source_char_count: charCount(source), elapsed_ms: candidate.elapsedMs },
    generation_directive: { purpose: 'logged-item-extraction', policy_profile: policy.generation.policy_profile, instruction_version: policy.generation.instruction_version,
      context_scope: { source_range_only: contextSegments.length === 0, lookback_segment_count: contextSegments.filter((item) => item.relation === 'lookback').length, forward_segment_count: contextSegments.filter((item) => item.relation === 'forward').length, max_context_chars: policy.context.max_context_chars } }
  } };
}

function project({ segment_id, sequence, start_time, end_time, text }) { return { segment_id, sequence, start_time, end_time, text }; }
function charCount(segments) { return segments.reduce((sum, item, index) => sum + item.text.length + (index ? 1 : 0), 0); }
function boundContext(segments, maxChars) { const result = []; let used = 0; for (const item of segments) { const added = item.text.length + (result.length ? 1 : 0); if (used + added > maxChars) break; result.push(item); used += added; } return result; }
function trimHistory(state, count) { if (state.history.length > count) state.history.splice(0, state.history.length - count); }
function durationMs(start, end) { const duration = clockMs(end) - clockMs(start); return Number.isFinite(duration) ? Math.max(0, duration) : 0; }
function clockMs(value) { const match = /^(\d+):(\d+):(\d+)\.(\d{3})$/.exec(value); if (!match) return Number.NaN; return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4]); }

function validatePolicy(policy) {
  if (!policy?.policy_id || !policy?.session_id || !policy.triggers || !policy.context || !policy.generation) throw invalid('complete context policy is required');
  if (!Number.isInteger(policy.triggers.max_latency_ms) || policy.triggers.max_latency_ms < 1) throw invalid('a positive maximum-latency safety ceiling is required');
}
function validateSegment(segment) {
  if (!segment?.segment_id || !segment.session_id || !Number.isInteger(segment.sequence) || segment.sequence < 0 || typeof segment.text !== 'string' || !segment.text.trim()) throw invalid('valid segment identity, session, sequence, and text are required');
  if (!['continuation', 'pause', 'size', 'latency', 'flush'].includes(segment.boundary)) throw invalid('unsupported finalized segment boundary');
  if (typeof segment.start_time !== 'string' || !segment.start_time || typeof segment.end_time !== 'string' || !segment.end_time) throw invalid('segment time range is required');
  if (Number.isFinite(clockMs(segment.start_time)) && Number.isFinite(clockMs(segment.end_time)) && clockMs(segment.end_time) < clockMs(segment.start_time)) throw invalid('segment time range must be non-negative');
}
function invalid(message) { return new ServiceOperationError(message, { code: 'INVALID_INPUT', category: 'validation' }); }
function rejected(code, message) { return new ServiceOperationError(message, { code, category: 'conflict', rejected: true }); }
