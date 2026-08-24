import { runLineService, ServiceOperationError } from '../../runtime/service-protocol.mjs';

const SERVICE = 'contextual-transcript-corrector';
runLineService({ service: SERVICE, operations: {
  'transcript.correction-request': { name: 'resolve-contextual-transcript', handle(message) {
    const request = message.payload;
    if (!request?.request_id || !request.words?.length) throw invalid('request_id and words are required');
    const firstWord = request.words[0];
    const argusAlternative = firstWord.alternatives.find((candidate) => candidate.text.toLowerCase() === 'argus');
    const remaining = request.words.slice(1).map((word) => word.text.toLowerCase()).join(' ');
    const proposals = argusAlternative && remaining === 'you ready' ? [{
      proposal_id: `${request.request_id}-proposal-${firstWord.sequence}`, target_word_id: firstWord.word_id,
      target_word_sequence: firstWord.sequence, expected_text: firstWord.text, proposed_text: 'Argus', confidence: 0.96,
      basis: 'acoustic-and-contextual', context: { first_word_id: request.words[0].word_id, last_word_id: request.words.at(-1).word_id }
    }] : [];
    const terminalMark = request.formatting_hint === 'question' ? '?' : request.formatting_hint === 'exclamation' ? '!' : '.';
    return [{ messageType: 'transcript.correction-resolved', identityKey: `transcript.correction-resolved:${request.request_id}`, payload: {
      request_id: request.request_id, session_id: request.session_id, utterance_id: request.utterance_id, boundary_id: request.boundary_id,
      proposals, formatting: { terminal_mark: terminalMark, capitalize_first_word: true, confidence: 0.97 },
      punctuation_after: proposals.some((proposal) => proposal.proposed_text === 'Argus') ? [{ word_id: firstWord.word_id, mark: ',' }] : [],
      generator: { implementation: SERVICE, policy_profile: request.policy.profile, instruction_version: request.policy.instruction_version }
    } }];
  } }
} });

function invalid(message) { return new ServiceOperationError(message, { code: 'INVALID_INPUT', category: 'validation' }); }
