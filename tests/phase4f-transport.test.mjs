import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { stdout } = await promisify(execFile)(process.execPath, ['scripts/benchmark-audio-transport.mjs'], { cwd: root });
const report = JSON.parse(stdout);

test('Phase 4F transport benchmark covers representative governed PCM cases', () => {
  assert.equal(report.policy.includes('not production performance thresholds'), true);
  assert.deepEqual(report.cases.map((item) => [item.duration_ms, item.raw_pcm_bytes, item.messages_per_second]), [[100, 3200, 10], [250, 8000, 4], [500, 16000, 2]]);
  for (const item of report.cases) {
    assert.equal(item.chunk_count, item.messages_per_second * report.run_seconds);
    assert.equal(item.base64_bytes, 4 * Math.ceil(item.raw_pcm_bytes / 3));
    assert.ok(item.envelope_bytes > item.base64_bytes);
    assert.equal(item.base64_expansion_ratio, Number((item.base64_bytes / item.raw_pcm_bytes).toFixed(3)));
    assert.equal(item.behavior, 'success');
    assert.ok(item.raw_pcm_bytes <= 18432);
    assert.equal(item.routed_transcript_event_count, item.chunk_count * 2);
    assertFiniteMetrics(item);
  }
});

test('Phase 4F benchmark proves oversized PCM is rejected at the governed contract boundary', () => {
  assert.equal(report.oversized.behavior, 'rejection');
  assert.ok(report.oversized.raw_pcm_bytes > 18432);
  assert.match(report.oversized.errors.join('\n'), /must be <= 18432/);
});

function assertFiniteMetrics(item) {
  for (const value of [item.elapsed_ms, item.messages_per_second_observed, item.max_queue_depth, item.observed_rss_bytes, item.operation_latency_ms.min, item.operation_latency_ms.max, item.operation_latency_ms.average]) assert.ok(Number.isFinite(value));
  assert.ok(item.max_queue_depth > 0 && item.max_queue_depth <= 32);
  assert.equal(item.operation_latency_ms.count, item.chunk_count);
}
