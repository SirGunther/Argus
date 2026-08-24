import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.message_type !== 'lifecycle.drain') return;
  process.stdout.write(`${JSON.stringify({
    message_id: randomUUID(), plane: 'control', message_type: 'service.drained', timestamp: new Date().toISOString(),
    producer: 'unready-transcript-source', correlation_id: message.correlation_id, causation_id: message.message_id,
    schema_version: '1.1.0', payload: { service: 'unready-transcript-source', pending_operations: 0 }
  })}\n`);
});
