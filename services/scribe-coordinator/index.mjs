import { createMessageIdentity, fingerprintMessage } from '../../runtime/message-identity.mjs';
import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';
import { EXTRACTION_BATCH_OUTPUT_LIMITS, SCRIBE_BATCH_PROTOCOL_VERSION, fingerprintModelRequest, validateScribeBatchModelRequest } from '../../contracts/model-protocol.mjs';
import { createScribeCoordinator } from './coordinator.mjs';

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
    // Close releases one final one-or-two-row remainder if any is pending. The coordinator's
    // own `settled` promise (returned from close()) is for direct callers who can await a
    // future stdin line; `lifecycle.drain` cannot do that here because runLineService
    // processes stdin lines strictly serially (the ai.work-completed/logged-item.stored line
    // that would resolve it is queued behind this very drain line), so blocking here would
    // deadlock. The forced remainder is still dispatched immediately below, and this process
    // keeps running afterward and will correctly settle it via the normal operation handlers
    // above once that later line arrives.
    const outputs = [];
    for (const sessionId of activeSessionIds()) {
      const { outputs: sessionOutputs } = coordinator.close(sessionId);
      outputs.push(...toWireOutputs(sessionOutputs));
    }
    return outputs;
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
  const request = buildModelRequest(dispatch);
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

function buildModelRequest(dispatch) {
  const modelName = readModelName();
  const policy = dispatch.policy;
  const maxContextTokens = policy.context.max_total_context_tokens;
  const request = {
    protocol_version: SCRIBE_BATCH_PROTOCOL_VERSION,
    purpose: 'logged-item-extraction',
    model: modelName,
    batch_identity: dispatch.batchIdentity,
    new_evidence_segments: dispatch.newEvidenceSegments,
    // Bounded prior Scribe context (transcript lookback + non-authoritative prior items) is
    // durable, cross-session state this standalone coordinator does not own or persist
    // (out of scope: filesystem persistence, Logged Item mutation). SCRIBE-05 wires the real
    // bounded background context once storage/model-extraction integration lands; an empty
    // background is structurally valid here (contracts/ai-work-request.schema.json places no
    // minItems on either background array).
    background_context: { transcript_segments: [], prior_logged_items: [] },
    policy_profile: policy.generation.policy_profile,
    instruction_version: policy.generation.instruction_version,
    limits: {
      max_context_chars: maxContextTokens * 4,
      max_context_tokens: maxContextTokens,
      max_output_chars: EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_chars,
      max_output_tokens: EXTRACTION_BATCH_OUTPUT_LIMITS.max_output_tokens
    },
    identity: { work_id: dispatch.workId, session_id: dispatch.sessionId, batch_request_id: dispatch.batchIdentity.request_id }
  };
  try {
    validateScribeBatchModelRequest(request);
  } catch (error) {
    throw new ServiceOperationError(error.message, { code: error.cause?.code || 'INVALID_MODEL_REQUEST', category: 'validation' });
  }
  return request;
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

function readModelName(env = process.env) {
  const modelName = String(env.ARGUS_MODEL_NAME || '').trim();
  if (!modelName) throw new ServiceOperationError('ARGUS_MODEL_NAME is required', { code: 'INVALID_MODEL_CONFIGURATION', category: 'validation' });
  return modelName;
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
