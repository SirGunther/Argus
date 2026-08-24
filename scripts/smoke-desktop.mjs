import os from 'node:os';
import path from 'node:path';
import { DesktopApplication } from '../runtime/desktop-application.mjs';

const root = path.resolve(import.meta.dirname, '..');
const sessionRoot = process.env.ARGUS_SESSION_ROOT || path.join(os.tmpdir(), 'argus-desktop-smoke-sessions');
const application = new DesktopApplication({ root, graphFile: path.join(root, 'wiring', 'production-electron.json'), sessionRoot });
await application.start();
const bootstrap = await application.bootstrap();
console.log(JSON.stringify({ projection_count: bootstrap.projections.length, new_session: bootstrap.new_session, session_id: application.sessionId }));
await application.shutdown();
