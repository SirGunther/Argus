import { randomUUID } from 'node:crypto';
import { createMessageIdentity, fingerprintMessage } from '../../runtime/message-identity.mjs';
import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { createScribeCoordinator } from './coordinator.mjs';

const SERVICE = 'scribe-coordinator';
const INSTANCE = process.env.ARGUS_SERVICE_INSTANCE_ID || SERVICE;
const BOOT_ID = randomUUID();
const FLUSH_ERROR_CATEGORIES = new Set(['validation', 'conflict', 'dependency', 'timeout', 'unavailable', 'internal', 'capacity']);
const knownSessionIds = new Set();
// Sessions that already own an outstanding Close acknowledgement. Bounded by the same session
// set the coordinator already tracks; a repeated request never starts a second flush.
const closingSessions = new Set();

const coordinator = createScribeCoordinator({
  requireRecovery: true,
  requirePersistence: true,
  onSpontaneousDispatch(_sessionId, pumpResults) {
    for (const output of toWireOutputs(pumpResults)) emitEnvelope(output);
  }
});

runLineService({
  service: SERVICE,
  operations: {
    'scribe.batch-policy': { name: 'configure-scribe-policy', handle(message) {
      const outputs = coordinator.configurePolicy(message.payload);
      knownSessionIds.add(message.payload.session_id);
      return toWireOutputs(outputs);
    } },
    'transcript.segment': { name: 'admit-finalized-segment', handle(message) {
      const outputs = coordinator.acceptFinalizedSegment(message.payload);
      knownSessionIds.add(message.payload.session_id);
      return toWireOutputs(outputs);
    } },
    'scribe.batch-evaluated': { name: 'settle-scribe-batch', handle(message) {
      const outputs = coordinator.acceptBatchEvaluated(message.payload);
      knownSessionIds.add(message.payload.batch.batch_identity.session_id);
      return toWireOutputs(outputs);
    } },
    'scribe.recovery-restored': { name: 'restore-scribe-state', handle(message) {
      const outputs = coordinator.acceptRecoveryRestored(message.payload);
      knownSessionIds.add(message.payload.session_id);
      return toWireOutputs(outputs);
    } },
    'scribe.checkpoint-persisted': { name: 'accept-scribe-checkpoint-persistence', handle(message) {
      const outputs = coordinator.acceptCheckpointPersisted(message.payload);
      knownSessionIds.add(message.payload.session_id);
      return toWireOutputs(outputs);
    } },
    // Governed session Close. `lifecycle.drain` is application shutdown and ends the service, so it
    // cannot answer a single session closing while the app keeps running. This releases the
    // remainder immediately - independently of the admission policy's idle timer - and answers with
    // one terminal `scribe.session-flushed` once the batch is acknowledged, journaled, and
    // checkpointed, or with the exact failure that must leave the session unsealed.
    'scribe.session-closing': { name: 'flush-scribe-session', handle(message) {
      const sessionId = message.payload?.session_id;
      if (!sessionId) throw new ServiceOperationError('scribe.session-closing must carry a session_id', { code: 'INVALID_INPUT', category: 'validation' });
      knownSessionIds.add(sessionId);
      if (closingSessions.has(sessionId)) return [];
      closingSessions.add(sessionId);
      const { outputs, settled } = coordinator.close(sessionId, { waitForRecovery: true });
      settled.then(
        () => emitEnvelope(sessionFlushedOutput(sessionId)),
        (error) => emitEnvelope(sessionFlushedOutput(sessionId, error))
      );
      return toWireOutputs(outputs);
    }, traceDetail: (message) => ({ session_id: message.payload?.session_id }) }
  },
  onDrain() {
    const outputs = [];
    const settleds = [];
    for (const sessionId of knownSessionIds) {
      const { outputs: sessionOutputs, settled } = coordinator.close(sessionId);
      outputs.push(...toWireOutputs(sessionOutputs));
      settleds.push(settled);
    }
    return { outputs, whenDrained: Promise.all(settleds) };
  }
});

function toWireOutputs(pumpResults) {
  const outputs = [];
  for (const result of pumpResults) {
    if (result.type === 'batch-admitted') outputs.push(admittedOutput(result));
    else if (result.type === 'recovery-request') outputs.push(recoveryRequestOutput(result));
    else if (result.type === 'checkpoint-persist') outputs.push(checkpointPersistOutput(result));
    else if (result.type === 'failure') outputs.push(failureOutput(result));
  }
  return outputs;
}

function recoveryRequestOutput(result) {
  return {
    plane: 'control', messageType: 'scribe.recovery-request', schemaVersion: '1.0.0',
    identityKey: `${INSTANCE}:scribe.recovery-request:${BOOT_ID}:${result.sessionId}:${result.policyId}:${result.policyVersion}`,
    payload: { session_id: result.sessionId, policy_id: result.policyId, policy_version: result.policyVersion }
  };
}

function checkpointPersistOutput(result) {
  const requestId = result.checkpoint.in_flight_batch?.batch_identity.request_id || result.batch?.batch_identity.request_id;
  const attempt = result.checkpoint.in_flight_batch?.attempt || result.batch?.attempt;
  return {
    plane: 'control', messageType: 'scribe.checkpoint-persist', schemaVersion: '1.0.0',
    identityKey: `${INSTANCE}:scribe.checkpoint-persist:${result.transition}:${requestId}:a${attempt}`,
    payload: {
      session_id: result.session_id,
      transition: result.transition,
      checkpoint: result.checkpoint,
      ...(result.batch ? { batch: result.batch } : {})
    }
  };
}

function sessionFlushedOutput(sessionId, error) {
  const status = coordinator.status(sessionId);
  // Rows still pending after a settled flush would mean unacknowledged evidence, so the
  // acknowledgement fails closed rather than reporting a Close the session cannot honour.
  const strandedRows = !error && status.pendingCount > 0;
  const accepted = !error && !strandedRows;
  const failure = error || (strandedRows
    ? { code: 'SCRIBE_SESSION_FLUSH_INCOMPLETE', category: 'conflict', message: `Scribe still holds ${status.pendingCount} unacknowledged finalized row(s) for session ${sessionId}`, retryable: true }
    : undefined);
  return {
    plane: 'control', messageType: 'scribe.session-flushed', schemaVersion: '1.0.0',
    identityKey: `${INSTANCE}:scribe.session-flushed:${sessionId}:${accepted ? 'accepted' : 'failed'}`,
    payload: {
      session_id: sessionId,
      flushed_at: new Date().toISOString(),
      accepted,
      admitted_through: { ...status.cursor },
      pending_rows: accepted ? 0 : status.pendingCount,
      ...(accepted ? {} : { error: {
        code: failure.code || 'SCRIBE_SESSION_FLUSH_FAILED',
        category: FLUSH_ERROR_CATEGORIES.has(failure.category) ? failure.category : 'conflict',
        message: failure.message || 'Scribe could not flush the session',
        retryable: Boolean(failure.retryable)
      } })
    }
  };
}

function admittedOutput(dispatch) {
  return {
    plane: 'domain', messageType: 'scribe.batch-admitted', schemaVersion: '1.0.0',
    identityKey: `${INSTANCE}:scribe.batch-admitted:${dispatch.batchIdentity.request_id}:a${dispatch.batchAttempt}`,
    payload: {
      batch_identity: dispatch.batchIdentity,
      batch_attempt: dispatch.batchAttempt,
      new_evidence_segments: dispatch.newEvidenceSegments,
      background_context: dispatch.backgroundContext,
      policy_profile: dispatch.policyProfile,
      instruction_version: dispatch.instructionVersion
    }
  };
}

function failureOutput(result) {
  return {
    plane: 'control', messageType: 'service.failure', schemaVersion: '1.2.0',
    identityKey: `${INSTANCE}:service.failure:${result.batchIdentity.request_id}:a${result.batchAttempt}`,
    payload: {
      service: INSTANCE, operation: 'settle-scribe-batch', outcome: 'failure',
      error: {
        code: result.error.code, category: result.error.category, message: result.error.message,
        retryable: Boolean(result.error.retryable),
        details: { batch_request_id: result.batchIdentity.request_id, batch_attempt: result.batchAttempt }
      }
    }
  };
}

function emitEnvelope(output) {
  const identity = createMessageIdentity({ producer: INSTANCE, messageType: output.messageType, logicalKey: output.identityKey });
  const envelope = {
    ...identity,
    plane: output.plane || 'domain',
    message_type: output.messageType,
    timestamp: new Date().toISOString(),
    producer: INSTANCE,
    correlation_id: output.payload?.batch_identity?.session_id || output.payload?.session_id || 'unattributed',
    schema_version: output.schemaVersion || '1.2.0',
    payload: output.payload
  };
  envelope.content_fingerprint = fingerprintMessage(envelope);
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
