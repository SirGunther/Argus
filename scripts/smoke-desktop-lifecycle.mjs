import os from 'node:os';
import path from 'node:path';
import { DesktopApplication } from '../runtime/desktop-application.mjs';

const root = path.resolve(import.meta.dirname, '..');
const sessionRoot = process.env.ARGUS_SESSION_ROOT || path.join(os.tmpdir(), 'argus-desktop-lifecycle-smoke');
const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot });
const results = [];
try {
  await application.start();
  for (const [index, command] of ['session.record', 'session.stop', 'session.close'].entries()) {
    const message = await Promise.race([
      application.handleCommand({ command_id: `desktop-smoke-${index}`, session_id: application.sessionId, command }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${command} timed out`)), 5000))
    ]);
    results.push({ command, status: message.payload.status, code: message.payload.code, state: message.payload.message });
  }
  console.log(JSON.stringify({ session_id: application.sessionId, results }));
} finally {
  await application.shutdown();
}
