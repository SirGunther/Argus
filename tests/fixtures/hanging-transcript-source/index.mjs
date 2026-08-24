import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const SERVICE = 'hanging-transcript-source';
const PRODUCER = process.env.ARGUS_SERVICE_INSTANCE_ID || SERVICE;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.message_type === 'lifecycle.start') return;
  const type = message.message_type === 'lifecycle.health-check' ? 'service.health' : 'service.drained';
  const payload = type === 'service.health'
    ? { service: SERVICE, probe_id: message.payload.probe_id, status: 'ready', runtime_kind: 'node', rss_bytes: process.memoryUsage().rss }
    : { service: SERVICE, pending_operations: 0 };
  process.stdout.write(`${JSON.stringify({ message_id: randomUUID(), plane: 'control', message_type: type, timestamp: new Date().toISOString(), producer: PRODUCER, correlation_id: message.correlation_id, causation_id: message.message_id, schema_version: '1.1.0', payload })}\n`);
});
