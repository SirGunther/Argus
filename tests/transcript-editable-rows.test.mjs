import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DesktopApplication } from '../runtime/desktop-application.mjs';
import { createUiContractBoundary } from '../ui/bridge-contracts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('an acknowledged finalized segment projects once with its real editable identity', () => {
  const sessionId = 'editable-segment-session';
  const application = createApplication(sessionId);
  const emitted = [];
  application.onProjection((message) => emitted.push(message));
  const segment = segmentOf(sessionId, 'segment-7', 7, 'Finalized segment text.', '00:00:10.000', '00:00:20.000');

  application.handleGraphMessage({ message_id: 'segment-before-history', message_type: 'transcript.segment', payload: segment });
  assert.equal(emitted.length, 0, 'unacknowledged final text must not reach the UI');
  application.handleGraphMessage({ message_id: 'history-ack', message_type: 'transcript.history-appended', payload: acknowledgement(segment) });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.segment_id, segment.segment_id);
  assert.equal(emitted[0].payload.revision, segment.revision);
  assert.equal(emitted[0].payload.sequence, segment.sequence);
  assert.equal(emitted[0].payload.start_time, segment.start_time);
  assert.equal(emitted[0].payload.end_time, segment.end_time);
  assert.equal(emitted[0].payload.read_only, false);
  assert.equal(Object.hasOwn(emitted[0].payload, 'row_id'), false);
  assert.deepEqual(application.transcript.map((row) => row.segment_id), [segment.segment_id]);

  application.handleGraphMessage({ message_id: 'segment-stored-duplicate', message_type: 'transcript.segment-stored', payload: segment });
  application.handleGraphMessage({ message_id: 'segment-duplicate', message_type: 'transcript.segment', payload: segment });
  assert.equal(emitted.length, 1, 'segment and segment-stored for one acknowledged revision must not append a second visible row');
});

test('owner acknowledgement projects an accepted revision into the existing visible row', async () => {
  const sessionId = 'editable-owner-session';
  const application = createApplication(sessionId);
  const segment = segmentOf(sessionId, 'segment-owner-3', 3, 'Owner text.', '00:00:03.000', '00:00:04.000');
  const emitted = [];
  application.onProjection((message) => emitted.push(message));
  application.handleGraphMessage({ message_id: 'initial-history-ack', message_type: 'transcript.history-appended', payload: acknowledgement(segment) });
  application.handleGraphMessage({ message_id: 'initial-segment', message_type: 'transcript.segment', payload: segment });
  const initialRow = application.transcript[0];
  const revision = { ...segment, revision: 1, revision_id: `${segment.segment_id}-r1`, text: 'Edited owner text.', stored_at: '2026-09-01T00:00:01.000Z' };
  const calls = [];
  application.graph = {
    dispatchFrom(...args) {
      calls.push(args);
      application.handleGraphMessage({ message_id: 'revision-history-ack', message_type: 'transcript.history-appended', payload: acknowledgement(revision) });
      application.handleGraphMessage({ message_id: 'revision-segment-stored', message_type: 'transcript.segment-stored', payload: revision });
      return Promise.resolve();
    }
  };

  const result = await application.executeCommand({
    command_id: 'edit-real-segment',
    session_id: sessionId,
    command: 'transcript.edit',
    segment_id: segment.segment_id,
    expected_revision: segment.revision,
    text: 'Edited owner text.'
  });

  assert.equal(result.status, 'accepted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], 'transcript.segment-update');
  assert.equal(calls[0][3], sessionId);
  assert.equal(calls[0][4].segment_id, segment.segment_id);
  assert.equal(calls[0][4].expected_revision, segment.revision);
  assert.equal(calls[0][4].text, 'Edited owner text.');
  assert.equal(application.transcript.length, 1);
  assert.equal(application.transcript[0].segment_id, segment.segment_id);
  assert.equal(application.transcript[0].revision, 1);
  assert.equal(application.transcript[0].text, revision.text);
  assert.equal(initialRow.segment_id, application.transcript[0].segment_id, 'the authoritative revision keeps the existing row identity');

  application.handleGraphMessage({ message_id: 'revision-segment-stored-duplicate', message_type: 'transcript.segment-stored', payload: revision });
  application.handleGraphMessage({ message_id: 'late-old-segment', message_type: 'transcript.segment', payload: segment });
  assert.equal(application.transcript.length, 1);
  assert.equal(application.transcript[0].revision, 1, 'a late older revision cannot downgrade the visible row');
  assert.equal(application.transcript[0].text, revision.text);
  assert.equal(emitted.filter((message) => !message.payload.provisional).length, 2, 'initial and accepted revisions each project once');
});

test('synthetic row IDs cannot enter transcript.edit and closed rows are read-only', async () => {
  const sessionId = 'identity-guard-session';
  const application = createApplication(sessionId);
  const segment = segmentOf(sessionId, 'segment-real-4', 4, 'Editable while recording.', '00:00:04.000', '00:00:05.000');
  application.transcript = [application.transcriptRow(segment, undefined, 'recording')];
  let dispatchCount = 0;
  application.graph = { dispatchFrom() { dispatchCount += 1; return Promise.resolve(); } };

  await assert.rejects(
    () => application.executeCommand({ command_id: 'edit-synthetic-row', session_id: sessionId, command: 'transcript.edit', segment_id: `${sessionId}-transcript-row-0`, expected_revision: 0, text: 'Must be rejected.' }),
    (error) => error.code === 'TRANSCRIPT_SEGMENT_NOT_FOUND'
  );
  assert.equal(dispatchCount, 0, 'a synthetic presentation identity must never reach the owner');

  application.metadata = { session_id: sessionId, state: 'closed' };
  application.transcript = [application.transcriptRow(segment, undefined, 'closed')];
  assert.equal(application.transcript[0].read_only, true);
  await assert.rejects(
    () => application.executeCommand({ command_id: 'edit-closed-row', session_id: sessionId, command: 'transcript.edit', segment_id: segment.segment_id, expected_revision: 0, text: 'Must be rejected.' }),
    (error) => error.code === 'SESSION_CLOSED'
  );
  assert.equal(dispatchCount, 0);
});

test('the UI contract remains at the existing transcript-row version for real segment rows', async () => {
  const boundary = await createUiContractBoundary(root);
  const segment = segmentOf('contract-segment-session', 'segment-contract-0', 0, 'Contract-valid segment.', '00:00:00.000', '00:00:01.000');
  const message = boundary.projection('ui.transcript-row', {
    session_id: segment.session_id,
    segment_id: segment.segment_id,
    revision: segment.revision,
    sequence: segment.sequence,
    start_time: segment.start_time,
    end_time: segment.end_time,
    text: segment.text,
    provisional: false,
    read_only: false,
    review_flags: []
  }, segment.session_id);
  assert.equal(message.schema_version, '1.1.0');
  assert.deepEqual(boundary.registry.validateEnvelope(message), []);
});

function createApplication(sessionId) {
  const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot: path.join(process.env.TEMP || 'C:\\Temp', `argus-editable-rows-${sessionId}`) });
  application.sessionId = sessionId;
  application.metadata = { session_id: sessionId, state: 'recording' };
  application.boundary = { projection: (messageType, payload) => ({ message_type: messageType, payload }) };
  return application;
}

function segmentOf(sessionId, segmentId, sequence, text, start_time, end_time) {
  return { session_id: sessionId, segment_id: segmentId, revision: 0, revision_id: `${segmentId}-r0`, sequence, start_time, end_time, text, provisional: false, review_flags: [] };
}

function acknowledgement(segment) {
  return { history_entry_id: segment.revision_id, session_id: segment.session_id, segment_id: segment.segment_id, segment_revision: segment.revision, revision_id: segment.revision_id };
}
