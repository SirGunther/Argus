import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { BoundedWireQueue } from '../runtime/bounded-wire-queue.mjs';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { createEnvelope } from '../runtime/orchestrator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = await loadContractRegistry(path.join(root, 'contracts', 'catalog.json'));
const cases = [
  { duration_ms: 100, raw_pcm_bytes: 3200, messages_per_second: 10 },
  { duration_ms: 250, raw_pcm_bytes: 8000, messages_per_second: 4 },
  { duration_ms: 500, raw_pcm_bytes: 16000, messages_per_second: 2 }
];
const run_seconds = 5;
const results = [];
for (const scenario of cases) results.push(await benchmark(scenario));
const oversized = oversizedCase();

process.stdout.write(`${JSON.stringify({
  measured_at: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, architecture: process.arch },
  policy: 'POC evidence only; measurements are not production performance thresholds.',
  run_seconds,
  cases: results,
  oversized
}, null, 2)}\n`);

async function benchmark(scenario) {
  const count = scenario.messages_per_second * run_seconds;
  const bytes = deterministicPcm(scenario.raw_pcm_bytes, scenario.duration_ms);
  const payload = audioPayload(bytes, scenario, 0);
  const representative = createAudioEnvelope(payload, scenario, 0);
  registry.assertEnvelope(representative);
  const base64_bytes = Buffer.byteLength(payload.audio_base64, 'utf8');
  const envelope_bytes = Buffer.byteLength(JSON.stringify(representative), 'utf8');
  let maxQueueDepth = 0;
  let routedTranscriptEvents = 0;
  const stt = createFakeStt();
  const queue = new BoundedWireQueue({
    wireKey: `benchmark:${scenario.duration_ms}ms`, capacity: 32,
    observe(depth) { maxQueueDepth = Math.max(maxQueueDepth, depth); },
    async consume(message) {
      registry.assertEnvelope(message);
      routedTranscriptEvents += await stt.send(message);
    }
  });
  const latencies = [];
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    const dueAt = started + (index * 1000 / scenario.messages_per_second);
    const delay = dueAt - performance.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const message = createAudioEnvelope(audioPayload(bytes, scenario, index), scenario, index);
    const operationStarted = performance.now();
    queue.enqueue(message);
    await queue.drain();
    latencies.push(performance.now() - operationStarted);
  }
  await stt.close();
  const elapsed_ms = performance.now() - started;
  return {
    ...scenario, chunk_count: count, raw_pcm_bytes: bytes.byteLength, base64_bytes, envelope_bytes,
    base64_expansion_ratio: ratio(base64_bytes, bytes.byteLength), envelope_expansion_ratio: ratio(envelope_bytes, bytes.byteLength),
    elapsed_ms: round(elapsed_ms), messages_per_second_observed: round(count / (elapsed_ms / 1000)),
    operation_latency_ms: summary(latencies), max_queue_depth: maxQueueDepth,
    observed_rss_bytes: process.memoryUsage().rss, routed_transcript_event_count: routedTranscriptEvents,
    behavior: 'success'
  };
}

function oversizedCase() {
  const bytes = deterministicPcm(18434, 576);
  const scenario = { duration_ms: 576, raw_pcm_bytes: bytes.byteLength, messages_per_second: 0 };
  const message = createAudioEnvelope(audioPayload(bytes, scenario, 0), scenario, 0);
  const errors = registry.validateEnvelope(message);
  return { raw_pcm_bytes: bytes.byteLength, behavior: errors.length ? 'rejection' : 'failure', errors };
}

function createAudioEnvelope(payload, scenario, index) {
  return createEnvelope({ plane: 'domain', messageType: 'audio.chunk', producer: 'phase4f-transport-benchmark', correlationId: `phase4f-${scenario.duration_ms}ms`, idempotencyKey: `phase4f:${scenario.duration_ms}:${index}`, payload });
}
function audioPayload(bytes, scenario, index) {
  return { chunk_id: `phase4f-${scenario.duration_ms}ms-${index}`, session_id: `phase4f-${scenario.duration_ms}ms`, sequence: index,
    start_time: clock(index * scenario.duration_ms), end_time: clock((index + 1) * scenario.duration_ms),
    format: { encoding: 'pcm-signed-integer', sample_rate_hz: 16000, channels: 1, bits_per_sample: 16, byte_order: 'little-endian' },
    sample_count: bytes.byteLength / 2, byte_length: bytes.byteLength, audio_base64: bytes.toString('base64'),
    checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
}
function deterministicPcm(length, seed) { const bytes = Buffer.alloc(length); for (let index = 0; index < length; index += 2) bytes.writeInt16LE(((seed + index) % 32767) - 16383, index); return bytes; }
function clock(milliseconds) { return `00:00:${Math.floor(milliseconds / 1000).toString().padStart(2, '0')}.${(milliseconds % 1000).toString().padStart(3, '0')}`; }
function ratio(value, base) { return round(value / base); }
function round(value) { return Number(value.toFixed(3)); }
function summary(values) { return { count: values.length, min: round(Math.min(...values)), max: round(Math.max(...values)), average: round(values.reduce((sum, value) => sum + value, 0) / values.length) }; }

function createFakeStt() {
  const child = spawn(process.execPath, [path.join(root, 'services', 'fake-stt', 'index.mjs')], { cwd: path.join(root, 'services', 'fake-stt'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  const counts = new Map();
  let failure;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    const inputId = message.causation_id || message.payload?.input_message_id;
    if (message.message_type.startsWith('transcript.')) counts.set(inputId, (counts.get(inputId) || 0) + 1);
    if (message.message_type === 'operation.completed') pending.get(message.payload.input_message_id)?.resolve(counts.get(message.payload.input_message_id) || 0);
    if (message.message_type === 'service.failure') pending.get(message.payload.input_message_id)?.reject(new Error(message.payload.error.code));
  });
  child.stderr.on('data', () => {});
  child.on('error', (error) => { failure = error; for (const waiter of pending.values()) waiter.reject(error); });
  return {
    send(message) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => { pending.set(message.message_id, { resolve, reject }); child.stdin.write(`${JSON.stringify(message)}\n`); });
    },
    close() { return new Promise((resolve, reject) => { child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`fake-stt exited ${code}`))); child.stdin.end(); }); }
  };
}
