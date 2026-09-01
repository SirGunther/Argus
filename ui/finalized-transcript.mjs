const TERMINAL_MARK = /[.?!]/;

export const DEFAULT_FINALIZED_ROW_LIMITS = Object.freeze({
  eligibleCharacters: 240,
  eligibleDurationMs: 15_000,
  hardCharacters: 400,
  hardDurationMs: 25_000
});

export function createFinalizedTranscriptState({ limits = DEFAULT_FINALIZED_ROW_LIMITS, sessionId } = {}) {
  return {
    limits: normalizeLimits(limits),
    sessionId,
    pending: null,
    rows: [],
    consumedRevisionIds: new Set(),
    consumedSegmentIds: new Set(),
    nextRowSequence: 0
  };
}

export function resetFinalizedTranscriptState(state, sessionId) {
  state.sessionId = sessionId;
  state.pending = null;
  state.rows = [];
  state.consumedRevisionIds.clear();
  state.consumedSegmentIds.clear();
  state.nextRowSequence = 0;
  return state;
}

export function consumeAcknowledgedTranscriptRevision(state, segment, acknowledgement) {
  const validation = validateAcknowledgedRevision(state, segment, acknowledgement);
  if (validation) return { accepted: false, appended: [], reason: validation };

  const revisionId = transcriptRevisionId(segment);
  if (state.consumedRevisionIds.has(revisionId) || state.consumedSegmentIds.has(segment.segment_id)) {
    return { accepted: false, appended: [], reason: 'duplicate' };
  }
  state.consumedRevisionIds.add(revisionId);
  state.consumedSegmentIds.add(segment.segment_id);
  if (!state.sessionId) state.sessionId = segment.session_id;

  const appended = [];
  const units = splitTerminalUnits(segment.text.trim());
  for (const unit of units) appendUnit(state, segment, unit, appended);
  return { accepted: true, appended, reason: appended.length ? 'row-closed' : 'pending' };
}

export function flushFinalizedTranscript(state, reason = 'flush') {
  if (!state.pending) return [];
  const row = closePending(state, reason);
  return row ? [row] : [];
}

export function hasConsumedTranscriptRevision(state, revisionId) {
  return state.consumedRevisionIds.has(revisionId);
}

export function finalizedTranscriptRows(state) {
  return state.rows.map((row) => structuredClone(row));
}

function appendUnit(state, segment, unit, appended) {
  let remaining = unit;
  while (remaining) {
    const pending = state.pending || startPending(state, segment);
    const capacity = state.limits.hardCharacters - characterLength(pending.text);
    if (capacity <= 0) {
      appended.push(closePending(state, 'character-cap'));
      continue;
    }

    const prefix = takeCharacters(remaining, capacity);
    const textBefore = pending.text;
    const text = joinTranscriptText(textBefore, prefix);
    const becameEligibleByCharacters = !pending.eligible && characterLength(text) >= state.limits.eligibleCharacters;
    const durationMs = representedDurationMs(pending.start_time, segment.end_time);
    const becameEligibleByDuration = !pending.eligible && durationMs >= state.limits.eligibleDurationMs;
    const eligible = pending.eligible || becameEligibleByCharacters || becameEligibleByDuration;
    const terminalOffset = eligible ? terminalOffsetAfterEligibility(text, textBefore, becameEligibleByCharacters, state.limits.eligibleCharacters) : -1;

    if (terminalOffset >= 0) {
      const textCharacters = Array.from(text);
      const closedText = textCharacters.slice(0, terminalOffset + 1).join('').trim();
      pending.text = closedText;
      pending.end_time = segment.end_time;
      addContribution(pending, segment);
      appended.push(closePending(state, 'sentence'));
      remaining = textCharacters.slice(terminalOffset + 1).join('').trimStart();
      continue;
    }

    pending.text = text;
    pending.end_time = segment.end_time;
    pending.eligible = eligible;
    addContribution(pending, segment);
    remaining = Array.from(remaining).slice(Array.from(prefix).length).join('').trimStart();

    if (characterLength(pending.text) >= state.limits.hardCharacters || durationMs >= state.limits.hardDurationMs) {
      appended.push(closePending(state, durationMs >= state.limits.hardDurationMs ? 'duration-cap' : 'character-cap'));
    } else if (remaining && !prefix.length) {
      appended.push(closePending(state, 'character-cap'));
    }
  }
}

function startPending(state, segment) {
  const pending = {
    session_id: segment.session_id,
    text: '',
    start_time: segment.start_time,
    end_time: segment.end_time,
    eligible: false,
    contributions: []
  };
  state.pending = pending;
  return pending;
}

function addContribution(pending, segment) {
  if (pending.contributions.some((item) => item.segment_id === segment.segment_id)) return;
  pending.contributions.push({
    segment_id: segment.segment_id,
    utterance_id: segment.utterance_id,
    sequence: segment.sequence,
    start_time: segment.start_time,
    end_time: segment.end_time,
    revision: segment.revision || 0,
    revision_id: transcriptRevisionId(segment),
    review_flags: segment.review_flags || []
  });
}

function closePending(state, reason) {
  const pending = state.pending;
  if (!pending || !pending.text.trim()) {
    state.pending = null;
    return undefined;
  }
  const sourceSegmentIds = pending.contributions.map((item) => item.segment_id);
  const first = pending.contributions[0];
  const last = pending.contributions.at(-1);
  const sequence = state.nextRowSequence++;
  const rowId = `${pending.session_id}-transcript-row-${sequence}`;
  const utteranceIds = [...new Set(pending.contributions.map((item) => item.utterance_id).filter(Boolean))];
  const row = {
    session_id: pending.session_id,
    row_id: rowId,
    segment_id: rowId,
    ...(utteranceIds.length === 1 ? { utterance_id: utteranceIds[0] } : {}),
    ...(utteranceIds.length ? { utterance_ids: utteranceIds } : {}),
    revision: 0,
    sequence,
    start_time: pending.start_time,
    end_time: pending.end_time,
    text: pending.text.trim(),
    provisional: false,
    read_only: true,
    source_segment_ids: sourceSegmentIds,
    source_segments: pending.contributions.map((item) => ({
      segment_id: item.segment_id,
      sequence: item.sequence,
      start_time: item.start_time,
      end_time: item.end_time
    })),
    source: {
      first_segment_id: first.segment_id,
      last_segment_id: last.segment_id,
      start_time: pending.start_time,
      end_time: pending.end_time
    },
    review_flags: uniqueReviewFlags(pending.contributions.flatMap((item) => item.review_flags))
  };
  state.rows.push(row);
  state.pending = null;
  return row;
}

function validateAcknowledgedRevision(state, segment, acknowledgement) {
  if (!segment || segment.provisional || typeof segment.session_id !== 'string' || !segment.session_id) return 'invalid-segment';
  if (state.sessionId && segment.session_id !== state.sessionId) return 'session-mismatch';
  if (typeof segment.segment_id !== 'string' || !segment.segment_id || !Number.isInteger(segment.sequence) || segment.sequence < 0) return 'invalid-segment';
  if (typeof segment.start_time !== 'string' || typeof segment.end_time !== 'string' || typeof segment.text !== 'string' || !segment.text.trim()) return 'invalid-segment';
  const revisionId = transcriptRevisionId(segment);
  if (!acknowledgement || acknowledgement.session_id !== segment.session_id || acknowledgement.segment_id !== segment.segment_id || acknowledgement.segment_revision !== (segment.revision || 0) || acknowledgement.history_entry_id !== revisionId || (acknowledgement.revision_id && acknowledgement.revision_id !== revisionId)) return 'unacknowledged';
  return undefined;
}

function transcriptRevisionId(segment) {
  return segment?.revision_id || `${segment?.segment_id}-r${segment?.revision || 0}`;
}

function splitTerminalUnits(text) {
  const units = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!TERMINAL_MARK.test(text[index])) continue;
    units.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) units.push(text.slice(start));
  return units.filter((unit) => unit.trim());
}

function terminalOffsetAfterEligibility(combinedText, textBefore, becameEligibleByCharacters, eligibleCharacters) {
  const searchStart = becameEligibleByCharacters ? Math.max(0, eligibleCharacters - 1) : characterLength(textBefore);
  return Array.from(combinedText).findIndex((character, index) => index >= searchStart && TERMINAL_MARK.test(character));
}

function joinTranscriptText(left, right) {
  const first = left.trimEnd();
  const second = right.trimStart();
  if (!first) return second;
  if (!second) return first;
  return `${first}${/^[.,?!:;)}\]]/.test(second) ? '' : ' '}${second}`;
}

function takeCharacters(value, count) {
  return Array.from(value).slice(0, count).join('');
}

function characterLength(value) {
  return Array.from(value || '').length;
}

function representedDurationMs(start, end) {
  const parse = (value) => {
    const match = /^(\d+):(\d+):(\d+)\.(\d{3})$/.exec(String(value || ''));
    return match ? (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4]) : 0;
  };
  return Math.max(0, parse(end) - parse(start));
}

function uniqueReviewFlags(flags) {
  const seen = new Set();
  return flags.filter((flag) => {
    const key = JSON.stringify(flag);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeLimits(limits) {
  const values = { ...DEFAULT_FINALIZED_ROW_LIMITS, ...limits };
  for (const key of Object.keys(DEFAULT_FINALIZED_ROW_LIMITS)) {
    values[key] = Math.max(1, Number(values[key]) || DEFAULT_FINALIZED_ROW_LIMITS[key]);
  }
  return Object.freeze(values);
}
