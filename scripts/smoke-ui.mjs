import { createUiBridge } from '../ui/bridge.mjs';
import { createFakeCapabilities } from '../ui/platform-capabilities.mjs';

const copied = [];
const bridge = await createUiBridge({
  port: 0,
  startTimers: false,
  capabilities: createFakeCapabilities({ clipboard: async (text) => copied.push(text) })
});
const address = await bridge.start();
const base = `http://${address.host}:${address.port}`;
try {
  const response = await fetch(`${base}/api/bootstrap`);
  if (!response.ok) throw new Error(`bootstrap returned HTTP ${response.status}`);
  const body = await response.json();
  const types = new Set(body.projections.map((message) => message.message_type));
  for (const required of ['ui.session-status', 'ui.transcript-row', 'ui.logged-item-row', 'ui.service-status']) {
    if (!types.has(required)) throw new Error(`missing ${required} projection`);
  }
  const session = body.projections.find((message) => message.message_type === 'ui.session-status').payload;
  const transcript = body.projections.find((message) => message.message_type === 'ui.transcript-row').payload;
  const loggedItem = body.projections.find((message) => message.message_type === 'ui.logged-item-row').payload;
  if (!loggedItem.source?.first_segment_id || !loggedItem.source?.last_segment_id) throw new Error('logged-item projection is missing exact provenance');

  await accepted({ command_id: 'smoke-record', session_id: session.session_id, command: 'session.record' });
  if (bridge.authority.sessionProjection().state !== 'recording') throw new Error('Record did not transition to recording');
  await accepted({ command_id: 'smoke-stop', session_id: session.session_id, command: 'session.stop' });
  if (bridge.authority.sessionProjection().state !== 'stopped') throw new Error('Stop did not preserve a stopped session');
  await accepted({ command_id: 'smoke-resume', session_id: session.session_id, command: 'session.record' });
  if (bridge.authority.sessionProjection().state !== 'recording') throw new Error('Resume did not transition to recording');
  await accepted({ command_id: 'smoke-transcript-edit', session_id: session.session_id, command: 'transcript.edit', segment_id: transcript.segment_id, expected_revision: transcript.revision, text: 'Smoke accepted transcript edit.' });
  await accepted({ command_id: 'smoke-logged-edit', session_id: session.session_id, command: 'logged-item.edit', item_id: loggedItem.item_id, expected_revision: loggedItem.revision, text: 'Smoke accepted logged-item edit.' });
  await accepted({ command_id: 'smoke-copy', session_id: session.session_id, command: 'copy', kind: 'logged-item', item_ids: [loggedItem.item_id], include_timestamps: true });
  if (copied.length !== 1 || !copied[0].includes('Smoke accepted logged-item edit.')) throw new Error('Copy did not preserve the accepted logged-item revision');
  await accepted({ command_id: 'smoke-close', session_id: session.session_id, command: 'session.close' });
  if (bridge.authority.sessionProjection().state !== 'closed') throw new Error('Close did not seal the session');

  process.stdout.write(`UI bridge smoke passed at ${base} with ${body.projections.length} validated projections and Record/Stop/Resume/edit/copy/Close command flow.\n`);
} finally {
  await bridge.close();
}

async function accepted(command) {
  const response = await fetch(`${base}/api/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
  const message = await response.json();
  if (!response.ok || message.payload?.status !== 'accepted') throw new Error(`${command.command} failed: ${message.payload?.message || message.error || `HTTP ${response.status}`}`);
  return message;
}
