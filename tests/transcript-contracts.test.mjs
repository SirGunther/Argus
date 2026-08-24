import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { createEnvelope } from '../runtime/orchestrator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = await loadContractRegistry(path.join(root, 'contracts/catalog.json'));
const fixture = async (type) => JSON.parse(await readFile(path.join(root, 'tests', 'fixtures', 'contracts', type, '1.2.0', 'valid.json'), 'utf8'));

test('Phase 4B fixtures are valid governed contracts', async () => {
  for (const type of [
    'audio.chunk', 'transcript.partial', 'transcript.word-committed', 'transcript.word-correction-proposed',
    'transcript.segment-update', 'transcript.segment-stored', 'transcript.history-append', 'transcript.history-appended'
  ]) assert.deepEqual(registry.validateEnvelope(await fixture(type)), [], type);
});

test('audio chunk invariants reject corrupt bytes, length, sample count, checksum, and fake payload overflow', async () => {
  const valid = await fixture('audio.chunk');
  for (const [mutate, expected] of [
    [(message) => { message.payload.format.sample_rate_hz = 8000; }, /must be equal to constant/],
    [(message) => { message.payload.byte_length = 6; }, /decoded audio contains 4 bytes/],
    [(message) => { message.payload.sample_count = 3; }, /sample_count must equal/],
    [(message) => { message.payload.checksum = `sha256:${'0'.repeat(64)}`; }, /checksum does not match/],
    [(message) => { message.payload.audio_base64 = 'AAABAA'; }, /canonical padded base64/],
    [(message) => { message.payload.byte_length = 18434; }, /must be <= 18432/]
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    invalid.content_fingerprint = valid.content_fingerprint;
    assert.match(registry.validateEnvelope(invalid).join('\n'), expected);
  }
});

test('partial projection is revisioned but contains no durable or editable-state authority', async () => {
  const partial = await fixture('transcript.partial');
  assert.equal(partial.payload.revision, 1);
  assert.equal(partial.payload.replaces_revision, 0);
  for (const forbidden of ['segment_id', 'expected_revision', 'word_provenance', 'history_entry_id']) {
    const invalid = structuredClone(partial);
    invalid.payload[forbidden] = 'forbidden';
    assert.match(registry.validateEnvelope(invalid).join('\n'), /is not allowed/);
  }
});

test('committed words preserve acoustic alternatives and contextual correction preserves exact prompt provenance', async () => {
  const word = await fixture('transcript.word-committed');
  assert.deepEqual(word.payload.evidence.alternatives, [{ text: 'Are guess', confidence: 0.16 }]);

  const proposal = await fixture('transcript.word-correction-proposed');
  assert.equal(proposal.payload.context.first_word_id, 'word-0');
  assert.equal(proposal.payload.generator.policy_profile, 'transcript-correction-default');
  assert.equal(proposal.payload.generator.instruction_version, '1.0.0');
  const missingPolicy = structuredClone(proposal);
  delete missingPolicy.payload.generator.policy_profile;
  assert.match(registry.validateEnvelope(missingPolicy).join('\n'), /policy_profile is required/);
});

test('active segment and history contracts retain original STT, word provenance, revisions, and formatting source', async () => {
  const stored = await fixture('transcript.segment-stored');
  assert.equal(stored.payload.original_stt_text, 'Argus');
  assert.equal(stored.payload.revision, 0);
  assert.equal(stored.payload.word_provenance[0].source_text, 'Argus');
  assert.equal(stored.payload.formatting.provisional_until_finalized, true);

  const append = await fixture('transcript.history-append');
  assert.deepEqual(append.payload.segment, stored.payload);
  const invalid = structuredClone(append);
  delete invalid.payload.segment.original_stt_text;
  assert.match(registry.validateEnvelope(invalid).join('\n'), /original_stt_text is required/);
});

test('existing transcript segment remains backward compatible while accepting finalized provenance', async () => {
  const retained = JSON.parse(await readFile(path.join(root, 'tests', 'fixtures', 'contracts', 'transcript.segment', '1.0.0', 'valid.json'), 'utf8'));
  assert.deepEqual(registry.validateEnvelope(retained), []);

  const stored = await fixture('transcript.segment-stored');
  const current = createEnvelope({
    plane: 'domain', messageType: 'transcript.segment', producer: 'phase4b-test', correlationId: 'phase4b-session',
    schemaVersion: '1.3.0', payload: Object.fromEntries(Object.entries(stored.payload).filter(([key]) => key !== 'stored_at'))
  });
  assert.deepEqual(registry.validateEnvelope(current), []);
});

test('logged-item context makes the generation policy and context budget explicit', async () => {
  const retained = JSON.parse(await readFile(path.join(root, 'tests', 'fixtures', 'contracts', 'transcript.context-window', '1.0.0', 'valid.json'), 'utf8'));
  assert.deepEqual(registry.validateEnvelope(retained), []);
  const current = createEnvelope({
    plane: 'domain', messageType: 'transcript.context-window', producer: 'phase4b-test', correlationId: 'phase4b-session', schemaVersion: '1.3.0',
    payload: {
      ...retained.payload,
      generation_directive: {
        purpose: 'logged-item-extraction', policy_profile: 'neutral-contextual-log', instruction_version: '1.0.0',
        context_scope: { source_range_only: false, lookback_segment_count: 2, forward_segment_count: 0, max_context_chars: 12000 }
      }
    }
  });
  assert.deepEqual(registry.validateEnvelope(current), []);
  const unbounded = structuredClone(current);
  delete unbounded.payload.generation_directive.context_scope.max_context_chars;
  assert.match(registry.validateEnvelope(unbounded).join('\n'), /max_context_chars is required/);
});
