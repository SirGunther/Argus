import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const SERVICE = 'undrained-transcript-source';
const PRODUCER = process.env.ARGUS_SERVICE_INSTANCE_ID || SERVICE;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.message_type === 'lifecycle.drain') return;
  if (message.message_type === 'lifecycle.health-check') {
    emit('control', 'service.health', message, { service: SERVICE, probe_id: message.payload.probe_id, status: 'ready', runtime_kind: 'node', rss_bytes: process.memoryUsage().rss });
    return;
  }
  emit('domain', 'transcript.segment', message, {
    segment_id: 'undrained-segment', session_id: message.payload.session_id, sequence: 0,
    start_time: '00:00:00.000', end_time: '00:00:01.000', text: 'We should verify the drain deadline.', boundary: 'pause'
  });
  emit('control', 'operation.completed', message, { service: SERVICE, operation: 'emit-fixture', input_message_id: message.message_id, outcome: 'success' });
});

function emit(plane, messageType, inputMessage, payload) {
  process.stdout.write(`${JSON.stringify({ message_id: randomUUID(), plane, message_type: messageType, timestamp: new Date().toISOString(), producer: PRODUCER, correlation_id: inputMessage.correlation_id, causation_id: inputMessage.message_id, schema_version: '1.1.0', payload })}\n`);
}
