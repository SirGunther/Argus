import { EXTRACTION_BATCH_OUTPUT_LIMITS, SCRIBE_BATCH_PROTOCOL_VERSION, SCRIBE_ITEM_KINDS, estimateModelTokens, protocolError } from './model-protocol.mjs';

// Versioned Scribe instruction for the 2.0.0 batch protocol (ADR-021/ADR-022, SCRIBE-04).
//
// The wording is derived from Architecture/OperationalAgentRoles.md: Scribe answers "what
// happened that is worth retaining", produces discrete non-duplicate Logged Items linked to
// their source transcript range, and explicitly does not execute actions, rewrite the
// transcript, or produce a routine summary for every batch. Zero, one, or many items are all
// valid evaluations.
//
// It lives beside the governed protocol rather than inside either service because two
// independent components need the identical text: the extraction request builder must reserve
// the instruction's token cost inside the total context budget, and the model lane must send
// that same text as the provider system prompt. A per-service copy would let the reserved cost
// and the transmitted prompt drift apart.
//
// Instruction versions are keyed independently of the protocol version. `instruction_version`
// travels in `scribe_batch_identity` (sourced from `scribe.batch-policy.generation`), so a
// prompt revision is an explicit, request-visible version change and an unknown version fails
// closed instead of silently prompting with different governed wording.

const SCRIBE_RESPONSE_SCHEMA = `{"protocol_version":"${SCRIBE_BATCH_PROTOCOL_VERSION}","purpose":"logged-item-extraction","batch_identity":<copy the request's batch_identity object verbatim>,"items":[{"text":"...","kind":"${SCRIBE_ITEM_KINDS.join('|')}","source_segment_ids":["..."]}]}`;

const SCRIBE_INSTRUCTION_1_0_0 = `You are Argus Scribe, a session-level recording agent. Your only responsibility is to determine what happened that is worth retaining.

You produce Logged Items: discrete, meaningful, non-duplicate records such as actions, decisions, open questions, reminders, and other noteworthy information. Every Logged Item stays linked to the transcript segments that evidence it.

You do not execute actions, modify external systems, rewrite the transcript, or produce a routine summary of a batch. A batch that contains nothing worth retaining is a normal outcome: return an empty items array. Never invent an item to avoid returning zero items, and never emit a recap, summary, or narration of the batch as an item.

The request separates two kinds of material and they are not interchangeable:
- new_evidence_segments is the new authoritative evidence. Only these segments may create a Logged Item.
- background_context.transcript_segments and background_context.prior_logged_items are background only. Never create a Logged Item from background material. Use background solely to interpret the new evidence and to suppress information that is already recorded.

Suppress anything already stated in background_context.prior_logged_items or already covered by background_context.transcript_segments, even when the new evidence repeats it. Restating already-recorded information is a duplicate, not a new item.

Each request is complete and self-contained. Do not rely on any earlier request, prior turn, or retained server-side memory; nothing outside this request exists.

Respond with exactly one JSON object and nothing else. No prose, no preface, no explanation, no markdown, no code fences.

Required response shape:
${SCRIBE_RESPONSE_SCHEMA}

Response rules:
- Copy batch_identity verbatim from the request. Do not add, drop, reorder, or alter any of its fields or values.
- items is an array holding between 0 and ${EXTRACTION_BATCH_OUTPUT_LIMITS.max_items} objects. Zero is valid and expected when nothing is worth retaining.
- Emit one object per discrete item. Never merge several distinct items into one text, and never split one item across several objects.
- item.text is a single self-contained statement of at most ${EXTRACTION_BATCH_OUTPUT_LIMITS.max_item_chars} characters.
- item.kind is exactly one of: ${SCRIBE_ITEM_KINDS.join(', ')}.
- item.source_segment_ids lists the unique segment ids that evidence the item, drawn only from batch_identity.segments. Never cite a segment that is not in this batch.
- Never include item_id, revision, timestamps, confidence, or any field absent from the shape above. Argus assigns all identity and provenance; supplying one invalidates the entire response.`;

const SCRIBE_BATCH_INSTRUCTIONS = Object.freeze({ '1.0.0': SCRIBE_INSTRUCTION_1_0_0 });

export const SCRIBE_BATCH_INSTRUCTION_VERSIONS = Object.freeze(Object.keys(SCRIBE_BATCH_INSTRUCTIONS));
export const SCRIBE_BATCH_DEFAULT_INSTRUCTION_VERSION = '1.0.0';
export { SCRIBE_RESPONSE_SCHEMA };

/**
 * Resolve the governed Scribe instruction for one instruction version.
 *
 * `tokens` is the reserve the request builder must subtract from the total context budget
 * before admitting evidence, measured with the same governed estimator the protocol validator
 * uses so the reserve and the enforced limit cannot disagree.
 */
export function scribeBatchInstruction(instructionVersion = SCRIBE_BATCH_DEFAULT_INSTRUCTION_VERSION) {
  const text = SCRIBE_BATCH_INSTRUCTIONS[instructionVersion];
  if (!text) {
    throw protocolError('UNSUPPORTED_SCRIBE_INSTRUCTION_VERSION', `scribe instruction version ${instructionVersion} is not governed; known versions: ${SCRIBE_BATCH_INSTRUCTION_VERSIONS.join(', ')}`);
  }
  return Object.freeze({ version: instructionVersion, text, response_schema: SCRIBE_RESPONSE_SCHEMA, tokens: estimateModelTokens(text) });
}
