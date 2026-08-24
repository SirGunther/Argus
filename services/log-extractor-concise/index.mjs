import { createHash } from 'node:crypto';
import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';

const SERVICE = 'log-extractor-concise';
runLineService({ service: SERVICE, operations: {
  'transcript.context-window': { name: 'extract-log', handle: (message) => extract(message, true) }
} });

function extract(message, concise) {
  const window = message.payload;
  if (!window?.window_id) throw invalid('window_id is required');
  if (!window.session_id) throw invalid('session_id is required');
  if (!Array.isArray(window.segments) || !window.segments.length) throw invalid('at least one transcript segment is required');
  const source = exactSource(window);
  let text = concise ? window.segments.at(-1).text.trim().replace(/^(we|i) should\s+/i, '').replace(/empty owner/gi, 'empty-owner') : window.segments.map((item) => item.text).join(' ');
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (!/[.!?]$/.test(text)) text += '.';
  return [{ messageType: 'logged-item.draft', payload: {
    item_id: stableItemId(window), session_id: window.session_id, created_at: stableCreatedAt(source), text, revision: 0, revision_id: `${stableItemId(window)}:r0`,
    source, generator: { implementation: SERVICE, input_window_id: window.window_id }
  } }];
}

function exactSource(window) {
  const first = window.segments[0];
  const last = window.segments.at(-1);
  const source = { first_segment_id: first.segment_id, last_segment_id: last.segment_id, start_time: first.start_time, end_time: last.end_time };
  if (!['first_segment_id', 'last_segment_id', 'start_time', 'end_time'].every((field) => window.source?.[field] === source[field])) throw invalid('source provenance must match the first and last finalized segments exactly');
  return source;
}

function stableItemId(window) { return `logged-item-${createHash('sha256').update(JSON.stringify({ session_id: window.session_id, window_id: window.window_id })).digest('hex').slice(0, 24)}`; }
function stableCreatedAt(source) { return source.end_time; }

function invalid(message) { return new ServiceOperationError(message, { code: 'INVALID_INPUT', category: 'validation' }); }
