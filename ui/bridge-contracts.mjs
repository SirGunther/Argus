import path from 'node:path';
import { createEnvelope } from '../runtime/orchestrator.mjs';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';

const UI_PROJECTION_TYPES = new Set([
  'ui.session-status', 'ui.transcript-row', 'ui.logged-item-row', 'ui.service-status', 'ui.command-result'
]);

export async function createUiContractBoundary(root) {
  const registry = await loadContractRegistry(path.join(root, 'contracts', 'catalog.json'));

  return Object.freeze({
    assertCommand(payload) {
      const message = createEnvelope({
        plane: 'control', messageType: 'ui.command', producer: 'browser', correlationId: payload.session_id,
        schemaVersion: '1.0.0', idempotencyKey: payload.command_id, payload
      });
      registry.assertEnvelope(message);
      assertCommandShape(payload);
      return message;
    },
    projection(messageType, payload, correlationId, idempotencyKey) {
      if (!UI_PROJECTION_TYPES.has(messageType)) throw new Error(`Not a browser projection: ${messageType}`);
      const plane = messageType === 'ui.service-status' || messageType === 'ui.command-result' ? 'control' : 'domain';
      const message = createEnvelope({
        plane, messageType, producer: 'ui-bridge', correlationId, schemaVersion: messageType === 'ui.session-status' ? '1.2.0' : messageType === 'ui.transcript-row' ? '1.2.0' : '1.0.0',
        idempotencyKey: idempotencyKey || `${messageType}:${correlationId}:${Date.now()}`, payload
      });
      registry.assertEnvelope(message);
      return message;
    },
    assertProjection(message) {
      if (!UI_PROJECTION_TYPES.has(message.message_type)) throw new Error(`Unexpected browser projection: ${message.message_type}`);
      registry.assertEnvelope(message);
      return message;
    },
    registry
  });
}

function assertCommandShape(payload) {
  const required = {
    'transcript.edit': ['segment_id', 'expected_revision', 'text'],
    'logged-item.edit': ['item_id', 'expected_revision', 'text'],
    copy: ['kind', 'item_ids', 'include_timestamps']
  }[payload.command] || [];
  const missing = required.filter((field) => payload[field] === undefined);
  if (missing.length) throw new Error(`${payload.command} requires ${missing.join(', ')}`);
}
