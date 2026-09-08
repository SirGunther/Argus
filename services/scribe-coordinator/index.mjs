import { createMessageIdentity, fingerprintMessage } from '../../runtime/message-identity.mjs';
import { runLineService } from '../../runtime/service-protocol.mjs';
import { fingerprintModelRequest } from '../../contracts/model-protocol.mjs';
import { createScribeCoordinator } from './coordinator.mjs';
import { buildModelRequestEnvelope, readModelName } from './model-request-envelope.mjs';

const SERVICE = 'scribe-coordinator';
const INSTANCE = process.env.ARGUS_SERVICE_INSTANCE_ID || SERVICE;
const knownSessionIds = new Set();

const coordinator = createScribeCoordinator({
  // The idle timer fires independently of any inbound stdin line, so its resulting dispatch
  // (if any) is emitted directly here rather than through an operation's return value.
  onSpontaneousDispatch(sessionId, pumpResults) {
    for (const output of toWireOutputs(pumpResults)) emitEnvelope(output);
  }
});

runLineService({
  service: SERVICE,
  operations: {
    'scribe.batch-policy': { name: 'configure-scribe-policy', handle(message) {
      knownSessionIds.add(message.payload?.session_id);
      const outputs = coordinator.configurePolicy(message.payload);
      return toWireOutputs(outputs);
    } },
    'transcript.segment': { name: 'admit-finalized-segment', handle(message) {
      knownSessionIds.add(message.payload?.session_id);
      const outputs = coordinator.acceptFinalizedSegment(message.payload);
      return toWireOutputs(outputs);
    } },
    'ai.work-completed': { name: 'evaluate-scribe-batch-result', handle(message) {
      knownSessionIds.add(message.payload?.session_id);
      const outputs = coordinator.acceptWorkCompleted(message.payload);
      return toWireOutputs(outputs);
    } },
    'logged-item.stored': { name: 'accept-scribe-item-acknowledgement', handle(message) {
      knownSessionIds.add(message.payload?.session_id);
      const outputs = coordinator.acceptStoredItem(message.payload);
      return toWireOutputs(outputs);
    } }
  },
  onDrain() {
    // Close releases one final one-or-two-row remainder if any is pending. `runLineService`
    // processes stdin lines strictly serially, and the ai.work-completed/logged-item.stored
    // line(s) that settle that remainder are queued behind this very drain line, so `onDrain`
    // itself must never block waiting for them (that would deadlock the process against its own
    // input). It returns `{outputs, whenDrained}` instead of a plain array: the forced remainder's
    // own outputs are emitted immediately below (same as before), and `service.drained` is emitted
    // only once `whenDrained` resolves, via the same background-emission path `lifecycle.drain`
    // already supports for a spontaneous idle-timer dispatch. Every subsequent stdin line keeps
    // processing normally in the meantime.
    const outputs = [];
    const settleds = [];
    for (const sessionId of activeSessionIds()) {
      const { outputs: sessionOutputs, settled } = coordinator.close(sessionId);
      outputs.push(...toWireOutputs(sessionOutputs));
      settleds.push(settled);
    }
    return { outputs, whenDrained: Promise.all(settleds) };
  }
});

function activeSessionIds() {
  return [...knownSessionIds];
}

function toWireOutputs(pumpResults) {
  const outputs = [];
  for (const result of pumpResults) {
    knownSessionIds.add(result.sessionId);
    if (result.type === 'dispatch') outputs.push(dispatchToOutput(result));
    else if (result.type === 'failure') outputs.push(failureOutput(result));
    // 'evaluated' descriptors are internal cursor/acknowledgement bookkeeping only; nothing is
    // wired to consume a distinct wire message for them in this isolated ticket (SCRIBE-03/05
    // own durable journaling of the evaluated batch).
  }
  return outputs;
}

function dispatchToOutput(dispatch) {
  const request = buildModelRequestEnvelope(dispatch, { modelName: readModelName() });
  // Fingerprint the request exactly as transmitted (work_id included). services/serial-ai-model-
  // lane/index.mjs independently computes `result.request_fingerprint` the same way, over the
  // raw `model_request` it actually received — any coordinator-side normalization here would
  // permanently disagree with that real echoed value and fail every completion. `batch_identity`
  // (deterministic from segment content + policy/instruction identity, unconditionally identical
  // across retries) is what already satisfies ADR-021's cross-retry stability; the raw request
  // fingerprint is attempt-specific by necessity, since `identity.work_id` must differ per retry.
  const fingerprint = fingerprintModelRequest(request);
  coordinator.recordDispatchFingerprint(dispatch.sessionId, dispatch.workId, fingerprint);
  return {
    plane: 'control',
    messageType: 'ai.work-request',
    schemaVersion: '1.5.0',
    identityKey: `${INSTANCE}:ai.work-request:${dispatch.workId}`,
    payload: {
      work_id: dispatch.workId,
      workload: 'logged-item-extraction',
      session_id: dispatch.sessionId,
      sequence: dispatch.batchIdentity.last_sequence,
      queued_at: new Date().toISOString(),
      input: { model_request: request },
      // The coordinator itself governs batch-level retry (re-dispatch with an incremented
      // attempt, see coordinator.mjs DEFAULT_MAX_DISPATCH_ATTEMPTS); the scheduler is asked
      // for exactly one internal attempt per dispatch so the two retry layers do not compound.
      recovery: { max_attempts: 1 }
    }
  };
}

function failureOutput(result) {
  return {
    plane: 'control',
    messageType: 'service.failure',
    schemaVersion: '1.2.0',
    identityKey: `${INSTANCE}:service.failure:${result.workId}`,
    payload: {
      service: INSTANCE,
      operation: 'evaluate-scribe-batch-result',
      outcome: 'failure',
      error: {
        code: result.error.code,
        category: result.error.category,
        message: result.error.message,
        retryable: Boolean(result.error.retryable),
        details: { work_id: result.workId, batch_request_id: result.batchIdentity.request_id, attempt: result.attempt }
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
    correlation_id: 'unattributed',
    schema_version: output.schemaVersion || '1.2.0',
    payload: output.payload
  };
  envelope.content_fingerprint = fingerprintMessage(envelope);
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
