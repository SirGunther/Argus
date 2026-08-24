import { runLineService } from '../../runtime/service-protocol.mjs';
import { SerialAiScheduler } from '../../runtime/serial-ai-scheduler.mjs';

const SERVICE = 'serial-transcription-gate';
const journal = {
  async load() { return []; },
  async append(event) {
    if (JSON.stringify(event).includes('"audio_base64"')) throw new Error('Raw audio cannot enter the transcription scheduler journal');
  }
};
const scheduler = await SerialAiScheduler.create({ journal, capacity: 32, executor: async (work) => ({ chunk_id: work.input.chunk_id }) });

runLineService({ service: SERVICE, operations: {
  'audio.chunk': { name: 'schedule-transcription', retainOutputs: false, onDuplicate: 'handle', async handle(message) {
    const chunk = message.payload;
    const result = await scheduler.enqueue({
      work_id: `transcription:${chunk.session_id}:${chunk.sequence}`, workload: 'transcription', session_id: chunk.session_id,
      sequence: chunk.sequence, queued_at: message.timestamp, input: { chunk_id: chunk.chunk_id }, recovery: { max_attempts: 1 }
    });
    if (result.chunk_id !== chunk.chunk_id) throw new Error('Scheduled transcription result did not match its ephemeral chunk reference');
    return [{ messageType: 'audio.chunk', identityKey: `scheduled-audio.chunk:${chunk.session_id}:${chunk.sequence}`, payload: chunk }];
  }, traceDetail: (message) => ({ workload: 'transcription', sequence: message.payload.sequence, scheduler_concurrency: 1, scheduler_work_input: 'chunk_id-only' }) }
} });
