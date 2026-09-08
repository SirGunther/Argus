import { createMessageIdentity, fingerprintMessage } from '../../runtime/message-identity.mjs';
import { runLineService } from '../../runtime/service-protocol.mjs';
import { createScribeCoordinator } from './coordinator.mjs';

const SERVICE = 'scribe-coordinator';
const INSTANCE = process.env.ARGUS_SERVICE_INSTANCE_ID || SERVICE;
const knownSessionIds = new Set();

const coordinator = createScribeCoordinator({
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
    } }
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
    else if (result.type === 'failure') outputs.push(failureOutput(result));
  }
  return outputs;
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
    correlation_id: output.payload?.batch_identity?.session_id || 'unattributed',
    schema_version: output.schemaVersion || '1.2.0',
    payload: output.payload
  };
  envelope.content_fingerprint = fingerprintMessage(envelope);
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
