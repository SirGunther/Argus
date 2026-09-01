import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DesktopApplication } from '../runtime/desktop-application.mjs';
import { createUiContractBoundary } from '../ui/bridge-contracts.mjs';
import {
  consumeAcknowledgedTranscriptRevision,
  createFinalizedTranscriptState,
  flushFinalizedTranscript
} from '../ui/finalized-transcript.mjs';
import { resolveSourceRangeIds } from '../ui/ui-state.mjs';
import { acceptLiveTranscript, createLiveTranscriptState, finalizeLiveTranscript } from '../ui/live-transcript.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('finalized presentation consumes only exact acknowledged revisions and ignores duplicates', () => {
  const state = createFinalizedTranscriptState({ sessionId: 'rows-session' });
  const segment = segmentOf('rows-session', 'segment-0', 0, 'A finalized sentence.', '00:00:00.000', '00:00:01.000');

  assert.equal(consumeAcknowledgedTranscriptRevision(state, segment, acknowledgement(segment, 'wrong-revision')).reason, 'unacknowledged');
  assert.equal(state.pending, null);
  assert.equal(consumeAcknowledgedTranscriptRevision(state, segment, acknowledgement(segment)).accepted, true);
  assert.equal(consumeAcknowledgedTranscriptRevision(state, segment, acknowledgement(segment)).reason, 'duplicate');
  flushFinalizedTranscript(state);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].source_segment_ids[0], segment.segment_id);
});

test('text accumulates across stored segments and closes after the character threshold at the next terminal mark', () => {
  const state = createFinalizedTranscriptState({ sessionId: 'rows-session' });
  const firstText = 'x'.repeat(238);
  const first = segmentOf('rows-session', 'window-segment-0', 0, firstText, '00:00:00.000', '00:00:04.000');
  const second = segmentOf('rows-session', 'window-segment-1', 1, 'xx then the sentence ends.', '00:00:04.000', '00:00:08.000');

  assert.deepEqual(consumeAcknowledgedTranscriptRevision(state, first, acknowledgement(first)).appended, []);
  const result = consumeAcknowledgedTranscriptRevision(state, second, acknowledgement(second));
  assert.equal(result.appended.length, 1);
  assert.match(result.appended[0].text, /sentence ends\.$/);
  assert.deepEqual(result.appended[0].source_segment_ids, [first.segment_id, second.segment_id]);
  assert.deepEqual(result.appended[0].source_segments.map((item) => item.segment_id), [first.segment_id, second.segment_id]);
  assert.equal(result.appended[0].source_segments[1].end_time, second.end_time);
  assert.equal(result.appended[0].start_time, first.start_time);
  assert.equal(result.appended[0].end_time, second.end_time);
  const closedRow = structuredClone(result.appended[0]);
  const third = segmentOf('rows-session', 'window-segment-2', 2, 'The next row continues.', '00:00:08.000', '00:00:12.000');
  consumeAcknowledgedTranscriptRevision(state, third, acknowledgement(third));
  assert.deepEqual(state.rows[0], closedRow, 'a visible row is never rewritten by later speech');
});

test('a row becomes eligible at fifteen seconds but waits for punctuation', () => {
  const state = createFinalizedTranscriptState({ sessionId: 'rows-session' });
  const first = segmentOf('rows-session', 'time-segment-0', 0, 'Speech reaches the time threshold', '00:00:00.000', '00:00:15.000');
  const second = segmentOf('rows-session', 'time-segment-1', 1, ' and closes here?', '00:00:15.000', '00:00:16.000');

  assert.deepEqual(consumeAcknowledgedTranscriptRevision(state, first, acknowledgement(first)).appended, []);
  const result = consumeAcknowledgedTranscriptRevision(state, second, acknowledgement(second));
  assert.equal(result.appended.length, 1);
  assert.match(result.appended[0].text, /here\?$/);
});

test('punctuation at the exact character threshold closes the eligible row', () => {
  const state = createFinalizedTranscriptState({ sessionId: 'rows-session' });
  const segment = segmentOf('rows-session', 'exact-threshold', 0, `${'x'.repeat(239)}.`, '00:00:00.000', '00:00:01.000');
  const result = consumeAcknowledgedTranscriptRevision(state, segment, acknowledgement(segment));
  assert.equal(result.appended.length, 1);
  assert.equal(result.appended[0].text.length, 240);
  assert.equal(result.appended[0].text.at(-1), '.');
});

test('all terminal sentence marks close an eligible row', () => {
  for (const mark of ['.', '?', '!']) {
    const state = createFinalizedTranscriptState({ sessionId: 'rows-session', limits: { eligibleCharacters: 1, eligibleDurationMs: 60_000, hardCharacters: 400, hardDurationMs: 60_000 } });
    const segment = segmentOf('rows-session', `punctuation-${mark}`, 0, `Eligible text${mark}`, '00:00:00.000', '00:00:01.000');
    const result = consumeAcknowledgedTranscriptRevision(state, segment, acknowledgement(segment));
    assert.equal(result.appended.length, 1);
    assert.equal(result.appended[0].text, `Eligible text${mark}`);
  }
});

test('a composed row matches provisional identity without clearing a newer live utterance', () => {
  const live = createLiveTranscriptState();
  const provisional = (utterance_id) => ({ session_id: 'rows-session', utterance_id, segment_id: 'live', revision: 1, sequence: 0, start_time: '00:00:00.000', end_time: '00:00:01.000', text: utterance_id, provisional: true, read_only: true, review_flags: [] });
  acceptLiveTranscript(live, provisional('utterance-1'));
  acceptLiveTranscript(live, provisional('utterance-2'));
  acceptLiveTranscript(live, provisional('utterance-3'));
  const finalized = { session_id: 'rows-session', row_id: 'row-0', segment_id: 'row-0', revision: 0, sequence: 0, start_time: '00:00:00.000', end_time: '00:00:08.000', text: 'Final text.', provisional: false, read_only: true, utterance_ids: ['utterance-1', 'utterance-2'], review_flags: [] };
  const result = finalizeLiveTranscript(live, finalized);
  assert.equal(result.accepted, true);
  assert.equal(result.cleared, false);
  assert.equal(live.current.identity, 'utterance:utterance-3');
});

test('hard character and duration caps force rows without punctuation and retain remainder', () => {
  const characterState = createFinalizedTranscriptState({ sessionId: 'rows-session' });
  const long = segmentOf('rows-session', 'hard-segment-0', 0, 'a'.repeat(401), '00:00:00.000', '00:00:01.000');
  const characterResult = consumeAcknowledgedTranscriptRevision(characterState, long, acknowledgement(long));
  assert.equal(characterResult.appended.length, 1);
  assert.equal(characterResult.appended[0].text.length, 400);
  assert.equal(characterState.pending.text, 'a');
  assert.equal(flushFinalizedTranscript(characterState, 'stop').length, 1);

  const durationState = createFinalizedTranscriptState({ sessionId: 'rows-session' });
  const duration = segmentOf('rows-session', 'duration-segment-0', 0, 'No terminal punctuation yet', '00:00:00.000', '00:00:25.000');
  const durationResult = consumeAcknowledgedTranscriptRevision(durationState, duration, acknowledgement(duration));
  assert.equal(durationResult.appended.length, 1);
  assert.equal(durationResult.appended[0].text, duration.text);
});

test('Stop and Close flush a pending finalized row after the authoritative graph drain', async () => {
  for (const command of ['session.stop', 'session.close']) {
    const sessionId = `flush-${command}`;
    const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(os.tmpdir(), `argus-row-flush-${Date.now()}-${command}`) });
    application.sessionId = sessionId;
    application.metadata = { session_id: sessionId, state: 'recording', created_at: '2026-09-01T00:00:00.000Z' };
    application.boundary = { projection: (messageType, payload) => ({ message_type: messageType, payload }) };
    application.transcriptProjectionLoaded = true;
    application.transcriptProjection.sessionId = sessionId;
    const segment = segmentOf(sessionId, `${sessionId}-segment-0`, 0, 'Pending until the session ends', '00:00:00.000', '00:00:02.000');
    application.projectFinalTranscriptSegment(segment, acknowledgement(segment));
    const emitted = [];
    application.onProjection((message) => emitted.push(message));
    application.graph = { closed: false, async dispatchFrom() {}, async waitForIdle() {} };
    application.loadLatestSession = async () => {};

    await application.sessionCommand({ command, command_id: `${command}-command`, session_id: sessionId });
    const rows = emitted.filter((message) => message.message_type === 'ui.transcript-row');
    assert.equal(rows.length, 1, `${command} flushes the pending row once`);
    assert.equal(rows[0].payload.text, segment.text);
  }
});

test('composed row metadata resolves source navigation to the visible row', () => {
  const rows = [{
    row_id: 'row-0', segment_id: 'row-0', sequence: 0,
    source_segment_ids: ['segment-0', 'segment-1'],
    source: { first_segment_id: 'segment-0', last_segment_id: 'segment-1', start_time: '00:00:00.000', end_time: '00:00:08.000' }
  }, {
    row_id: 'row-1', segment_id: 'row-1', sequence: 1,
    source_segment_ids: ['segment-2'],
    source: { first_segment_id: 'segment-2', last_segment_id: 'segment-2', start_time: '00:00:08.000', end_time: '00:00:12.000' }
  }];
  assert.deepEqual(resolveSourceRangeIds(rows, { first_segment_id: 'segment-0', last_segment_id: 'segment-2' }), ['row-0', 'row-1']);
});

test('composed finalized rows remain valid against the UI projection contract', async () => {
  const boundary = await createUiContractBoundary(root);
  const state = createFinalizedTranscriptState({ sessionId: 'contract-row-session' });
  const segment = segmentOf('contract-row-session', 'contract-segment-0', 0, 'Contract row.', '00:00:00.000', '00:00:01.000');
  consumeAcknowledgedTranscriptRevision(state, segment, acknowledgement(segment));
  const message = boundary.projection('ui.transcript-row', flushFinalizedTranscript(state)[0], 'contract-row-session');
  assert.equal(message.schema_version, '1.2.0');
  assert.deepEqual(boundary.registry.validateEnvelope(message), []);
});

function segmentOf(sessionId, segmentId, sequence, text, start_time, end_time) {
  return { session_id: sessionId, segment_id: segmentId, revision: 0, revision_id: `${segmentId}-r0`, sequence, start_time, end_time, text, provisional: false, review_flags: [] };
}

function acknowledgement(segment, revisionId = segment.revision_id) {
  return { history_entry_id: revisionId, revision_id: revisionId, session_id: segment.session_id, segment_id: segment.segment_id, segment_revision: segment.revision };
}
