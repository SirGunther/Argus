import { fingerprintValue } from '../runtime/message-identity.mjs';

export function createCommandRouter({ boundary, authority, capabilities, emit }) {
  const completed = new Map();

  return Object.freeze({
    async handle(rawPayload) {
      let command;
      try { command = boundary.assertCommand(rawPayload); }
      catch (error) { return emitResult(rawPayload, rejectedPayload(rawPayload, 'INVALID_COMMAND', error.message, 'ui/bridge')); }
      const payload = command.payload;
      const fingerprint = fingerprintValue(payload);
      const known = completed.get(payload.command_id);
      if (known) {
        if (known.fingerprint !== fingerprint) return emitResult(payload, rejectedPayload(payload, 'OPERATION_ID_CONFLICT', 'command_id was reused with different content.', 'ui/bridge'));
        return known.result;
      }

      try {
        let result;
        switch (payload.command) {
          case 'transcript.edit': {
            const row = authority.editTranscript(payload);
            emit('ui.transcript-row', row);
            result = acceptedPayload(payload, 'transcript/active-state', row.segment_id, row.revision, 'Transcript revision accepted.');
            break;
          }
          case 'logged-item.edit': {
            const row = authority.editLoggedItem(payload);
            emit('ui.logged-item-row', row);
            result = acceptedPayload(payload, 'logged-items/active-owner', row.item_id, row.revision, 'Logged-item revision accepted.');
            break;
          }
          case 'session.record':
          case 'session.stop':
          case 'session.close':
            authority.applySessionCommand(payload.command);
            emit('ui.session-status', authority.sessionProjection());
            result = acceptedPayload(payload, 'runtime/session-lifecycle', payload.session_id, undefined, `${payload.command} accepted.`);
            break;
          case 'copy': {
            const text = authority.formatCopy(payload.kind, payload.item_ids, payload.include_timestamps);
            const receipt = await capabilities.clipboard.write(text);
            result = acceptedPayload(payload, 'platform/clipboard', undefined, undefined, receipt.message);
            break;
          }
          case 'copy-session-path': {
            const folder = await capabilities.folder.resolve(payload.session_id);
            const receipt = await capabilities.clipboard.write(folder);
            result = acceptedPayload(payload, 'platform/clipboard', undefined, undefined, receipt.message);
            break;
          }
          case 'open-folder': {
            const receipt = await capabilities.folder.open(payload.session_id);
            result = acceptedPayload(payload, 'platform/folder', undefined, undefined, receipt.message);
            break;
          }
          default: throw rejectedPayload(payload, 'UNSUPPORTED_COMMAND', `Unsupported UI command ${payload.command}.`, 'ui/bridge');
        }
        const resultMessage = emitResult(payload, result);
        completed.set(payload.command_id, { fingerprint, result: resultMessage });
        return resultMessage;
      } catch (error) {
        const result = rejectedPayload(payload, error.code || 'COMMAND_FAILED', error.message, ownerFor(payload.command), error.retryable);
        const resultMessage = emitResult(payload, result);
        completed.set(payload.command_id, { fingerprint, result: resultMessage });
        return resultMessage;
      }
    }
  });

  function emitResult(payload, result) {
    return emit('ui.command-result', result);
  }
}

function acceptedPayload(payload, owner, resourceId, revision, message) {
  return { command_id: payload.command_id, session_id: payload.session_id, command: payload.command, status: 'accepted', owner, ...(resourceId ? { resource_id: resourceId } : {}), ...(revision === undefined ? {} : { revision }), message };
}

function rejectedPayload(payload = {}, code, message, owner, retryable = false) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const resourceId = safePayload.segment_id || safePayload.item_id;
  return { command_id: safePayload.command_id || 'invalid-command', session_id: safePayload.session_id || 'unknown-session', command: safePayload.command || 'unknown', status: 'rejected', owner, ...(resourceId ? { resource_id: resourceId } : {}), code, message, ...(retryable ? { pending: true } : {}) };
}

function ownerFor(command) {
  if (command === 'transcript.edit') return 'transcript/active-state';
  if (command === 'logged-item.edit') return 'logged-items/active-owner';
  if (command === 'open-folder') return 'platform/folder';
  if (command === 'copy' || command === 'copy-session-path') return 'platform/clipboard';
  if (command?.startsWith('session.')) return 'runtime/session-lifecycle';
  return 'ui/bridge';
}
