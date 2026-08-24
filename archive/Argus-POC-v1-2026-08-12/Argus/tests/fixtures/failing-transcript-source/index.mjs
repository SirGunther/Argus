import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const message = JSON.parse(line);
  process.stdout.write(`${JSON.stringify({
    message_id: randomUUID(),
    plane: 'control',
    message_type: 'service.failure',
    timestamp: new Date().toISOString(),
    producer: 'failing-transcript-source',
    correlation_id: message.correlation_id,
    causation_id: message.message_id,
    schema_version: 1,
    payload: {
      service: 'failing-transcript-source',
      operation: 'emit-fixture',
      input_message_id: message.message_id,
      error: {
        type: 'DeliberateTestFailure',
        message: 'Failure fixture reached the explicit supervisor path',
        retryable: false
      }
    }
  })}\n`);
});

