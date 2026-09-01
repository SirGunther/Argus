const TRANSCRIPT_SEED = [
  ['16:23:08', 'Let’s look at the account provisioning flow first.'],
  ['16:23:22', 'The handoff from sales is creating the customer record, but not assigning an owner.'],
  ['16:23:41', 'I need to check whether this value is being reset.'],
  ['16:23:58', 'Actually, this may be happening before the API call.'],
  ['16:24:16', 'The webhook receives the workspace ID correctly.'],
  ['16:24:33', 'There is a transform between the webhook and the create-user request.'],
  ['16:24:48', 'I should inspect that next.'],
  ['16:25:04', 'Also make a note to add the missing owner field to our integration test.'],
  ['16:25:26', 'If the transform is clean, compare the staging payload with production.'],
  ['16:25:47', 'That should tell us whether this is an environment-specific configuration issue.']
];

const LOGGED_SEED = [
  ['16:23:25', 0, 1, 'Customer records are created without an assigned owner.'],
  ['16:23:46', 1, 2, 'Investigate whether the owner value resets before the API call.'],
  ['16:24:36', 3, 5, 'A payload transform runs between the webhook and create-user request.'],
  ['16:24:51', 5, 6, 'Inspect the webhook-to-request transform.'],
  ['16:25:08', 6, 7, 'Add the owner field to the integration test.'],
  ['16:25:30', 7, 8, 'Compare staging and production payloads if the transform is clean.'],
  ['16:25:51', 8, 9, 'Possible environment-specific configuration issue.']
];

const LIVE_SAMPLES = [
  ['Let me trace where the owner ID is first introduced into the request.', 'Trace where the owner ID enters the request.'],
  ['The mapping file has a fallback, but it points to the legacy team identifier.', 'The mapping fallback uses a legacy team identifier.'],
  ['We should replace that fallback and cover the empty-owner case.', 'Replace the legacy fallback and test the empty-owner case.'],
  ['Keep the original payload in the debug log while we validate the change.', 'Retain original payloads in debug logs during validation.'],
  ['After that, run the provisioning test against both environments.', 'Run provisioning tests against staging and production.']
];

export function createDemoAuthority({ sessionId = 'AA-260811-042', now = () => new Date().toISOString() } = {}) {
  const transcript = new Map();
  const loggedItems = new Map();
  const createdAt = '2026-08-11T20:23:00.000Z';
  TRANSCRIPT_SEED.forEach(([time, text], sequence) => transcript.set(`segment-${sequence}`, {
    session_id: sessionId, segment_id: `segment-${sequence}`, revision: 0, sequence,
    start_time: time, end_time: time, text, provisional: false, read_only: false, review_flags: []
  }));
  LOGGED_SEED.forEach(([time, first, last, text], index) => loggedItems.set(`item-${index}`, {
    session_id: sessionId, item_id: `item-${index}`, revision: 0, revision_id: `item-${index}:r0`, logged_at: time, text,
    source: { first_segment_id: `segment-${first}`, last_segment_id: `segment-${last}`, start_time: TRANSCRIPT_SEED[first][0], end_time: TRANSCRIPT_SEED[last][0] },
    classification_suggestion: index === 0
      ? { label: 'observation', confidence: 0.82, suggested_by: 'deterministic-demo-classifier' }
      : null
  }));

  const state = { sessionId, createdAt, status: 'stopped', elapsedSeconds: 18 * 60 + 42, liveIndex: 0 };

  return {
    sessionId,
    serviceStatuses() {
      return [
        { capability: 'transcript', status: 'available', message: 'Active transcript owner connected.', retryable: false },
        { capability: 'logged-item-pipeline', status: 'available', message: 'Logged-item owner connected; extraction is deterministic demo input.', retryable: false },
        { capability: 'storage-session', status: 'unavailable', message: 'Session storage is unavailable; this browser demo uses bounded in-memory active state.', retryable: true },
        { capability: 'classification', status: 'unavailable', message: 'Optional classification is unavailable; logged items remain editable.', retryable: true }
      ];
    },
    sessionProjection() {
      return { session_id: state.sessionId, state: state.status, elapsed_seconds: state.elapsedSeconds, created_at: createdAt, duration_seconds: state.elapsedSeconds, transcript_count: transcript.size, logged_item_count: loggedItems.size };
    },
    transcriptRows() { return [...transcript.values()].map((row) => structuredClone(row)); },
    loggedItemRows() { return [...loggedItems.values()].map((row) => structuredClone(row)); },
    formatCopy(kind, ids, includeTimestamps) {
      const map = kind === 'transcript' ? transcript : loggedItems;
      return ids.map((id) => {
        const row = map.get(id);
        if (!row) throw reject('ITEM_NOT_FOUND', `Unknown ${kind} row ${id}`);
        const time = kind === 'transcript' ? row.start_time : row.logged_at;
        return includeTimestamps ? `[${time}] ${row.text}` : row.text;
      }).join('\n');
    },
    editTranscript(payload) {
      const current = transcript.get(payload.segment_id);
      if (!current) throw reject('SEGMENT_NOT_FOUND', `Unknown transcript segment ${payload.segment_id}`);
      if (current.session_id !== payload.session_id) throw reject('SEGMENT_SESSION_CONFLICT', 'Transcript session identity does not match.');
      if (current.provisional || current.read_only) throw reject('PROVISIONAL_READ_ONLY', 'Provisional transcript rows are read-only.');
      if (current.revision !== payload.expected_revision) throw reject('STALE_REVISION', `Expected revision ${payload.expected_revision}; current revision is ${current.revision}.`);
      if (!payload.text.trim()) throw reject('INVALID_TEXT', 'Transcript text cannot be empty.');
      const next = { ...current, text: payload.text, revision: current.revision + 1 };
      transcript.set(next.segment_id, next);
      return structuredClone(next);
    },
    editLoggedItem(payload) {
      const current = loggedItems.get(payload.item_id);
      if (!current) throw reject('ITEM_NOT_FOUND', `Unknown logged item ${payload.item_id}`);
      if (current.session_id !== payload.session_id) throw reject('ITEM_SESSION_CONFLICT', 'Logged-item session identity does not match.');
      if (current.revision !== payload.expected_revision) throw reject('STALE_REVISION', `Expected revision ${payload.expected_revision}; current revision is ${current.revision}.`);
      if (!payload.text.trim()) throw reject('INVALID_TEXT', 'Logged-item text cannot be empty.');
      const next = { ...current, text: payload.text, revision: current.revision + 1, revision_id: `${current.item_id}:r${current.revision + 1}` };
      loggedItems.set(next.item_id, next);
      return structuredClone(next);
    },
    applySessionCommand(command) {
      if (command === 'session.record') {
        if (state.status === 'closed') throw reject('SESSION_CLOSED', 'Closed sessions cannot resume recording.');
        state.status = 'recording';
        return;
      }
      if (command === 'session.stop') {
        if (state.status === 'closed') throw reject('SESSION_CLOSED', 'Closed sessions cannot stop.');
        state.status = 'stopped';
        return;
      }
      if (command === 'session.close') {
        if (state.status === 'closed') throw reject('SESSION_CLOSED', 'Session is already closed.');
        state.status = 'closed';
        return;
      }
      throw reject('UNSUPPORTED_COMMAND', `Unsupported session command ${command}.`);
    },
    nextLiveSample() {
      const sequence = transcript.size;
      const [text, derivedText] = LIVE_SAMPLES[state.liveIndex++ % LIVE_SAMPLES.length];
      const time = `16:2${6 + Math.floor(sequence / 10)}:${String(sequence).padStart(2, '0')}`;
      const row = { session_id: state.sessionId, segment_id: `segment-${sequence}`, revision: 0, sequence, start_time: time, end_time: time, text, provisional: true, read_only: true, review_flags: [] };
      transcript.set(row.segment_id, row);
      const item = { session_id: state.sessionId, item_id: `item-${loggedItems.size}`, revision: 0, revision_id: `item-${loggedItems.size}:r0`, logged_at: time, text: derivedText,
        source: { first_segment_id: row.segment_id, last_segment_id: row.segment_id, start_time: row.start_time, end_time: row.end_time }, classification_suggestion: null };
      return { provisional: structuredClone(row), finalize: () => { const finalized = { ...row, provisional: false, read_only: false }; transcript.set(row.segment_id, finalized); loggedItems.set(item.item_id, item); return { transcript: structuredClone(finalized), loggedItem: structuredClone(item) }; } };
    },
    tick() { if (state.status === 'recording') state.elapsedSeconds += 1; }
  };
}

function reject(code, message) {
  const error = new Error(message);
  error.code = code;
  error.rejected = true;
  return error;
}
