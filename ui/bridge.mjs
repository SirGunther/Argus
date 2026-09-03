import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCommandRouter } from './command-router.mjs';
import { createDemoAuthority } from './demo-state.mjs';
import { createUiContractBoundary } from './bridge-contracts.mjs';
import { createPlatformCapabilities, PlatformCapabilityError } from './platform-capabilities.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/ui/ui-state.mjs', ['ui/ui-state.mjs', 'text/javascript; charset=utf-8']],
  ['/ui/live-transcript.mjs', ['ui/live-transcript.mjs', 'text/javascript; charset=utf-8']],
  ['/ui/audio-capture.mjs', ['ui/audio-capture.mjs', 'text/javascript; charset=utf-8']],
  ['/ui/audio-worklet.mjs', ['ui/audio-worklet.mjs', 'text/javascript; charset=utf-8']],
  ['/ui/session-timer.mjs', ['ui/session-timer.mjs', 'text/javascript; charset=utf-8']]
]);

export async function createUiBridge({ root = ROOT, host = '127.0.0.1', port = 4173, authority, capabilities, startTimers = true } = {}) {
  if (!LOOPBACK.has(host)) throw new Error('The UI bridge must bind to a loopback address.');
  const boundary = await createUiContractBoundary(root);
  const demoAuthority = authority || createDemoAuthority();
  const platform = capabilities || createPlatformCapabilities();
  const clients = new Set();
  const router = createCommandRouter({ boundary, authority: demoAuthority, capabilities: platform, emit });
  const timers = [];

  function emit(messageType, payload) {
    const correlationId = payload.session_id || demoAuthority.sessionId;
    const message = boundary.projection(messageType, payload, correlationId);
    const data = `event: ${messageType}\ndata: ${JSON.stringify(message)}\n\n`;
    for (const response of clients) response.write(data);
    return message;
  }

  function serviceStatusProjections() {
    const now = new Date().toISOString();
    const base = demoAuthority.serviceStatuses();
    base.push({ capability: 'clipboard', status: platform.clipboard.available ? 'available' : 'unavailable', message: platform.clipboard.available ? 'Clipboard capability is connected through the bridge.' : 'Clipboard capability is unavailable in this browser host.', retryable: true });
    base.push({ capability: 'folder-opening', status: platform.folder.available ? 'available' : 'unavailable', message: platform.folder.available ? 'Folder opening is authorized by session identity.' : 'Operating-system folder opening is unavailable without an authorized desktop/session root.', retryable: true });
    return base.map((item) => ({ ...item, updated_at: now }));
  }

  function bootstrap() {
    return [
      emitWithoutBroadcast('ui.session-status', demoAuthority.sessionProjection()),
      ...demoAuthority.transcriptRows().map((row) => emitWithoutBroadcast('ui.transcript-row', row)),
      ...demoAuthority.loggedItemRows().map((row) => emitWithoutBroadcast('ui.logged-item-row', row)),
      ...serviceStatusProjections().map((status) => emitWithoutBroadcast('ui.service-status', status))
    ];
  }

  function emitWithoutBroadcast(messageType, payload) {
    const correlationId = payload.session_id || demoAuthority.sessionId;
    return boundary.projection(messageType, payload, correlationId);
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${host}`);
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') return sendJson(response, 200, { projections: bootstrap() });
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        response.write(': Argus UI bridge connected\n\n');
        clients.add(response);
        request.on('close', () => clients.delete(response));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/commands') {
        const body = await readRequestBody(request);
        let raw;
        try { raw = JSON.parse(body); } catch { return sendJson(response, 400, { error: 'Request body must be JSON.' }); }
        const result = await router.handle(raw);
        return sendJson(response, result.payload.status === 'accepted' ? 200 : 409, result);
      }
      if (request.method === 'GET' && STATIC_FILES.has(url.pathname)) {
        const [relative, contentType] = STATIC_FILES.get(url.pathname);
        const content = await readFile(path.join(root, relative));
        response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
        response.end(content);
        return;
      }
      sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      sendJson(response, error instanceof PlatformCapabilityError ? 503 : 500, { error: error.message });
    }
  });

  async function start() {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    if (startTimers) {
      timers.push(setInterval(() => {
        demoAuthority.tick();
        if (demoAuthority.sessionProjection().state === 'recording') emit('ui.session-status', demoAuthority.sessionProjection());
      }, 1000));
      timers.push(setInterval(() => {
        if (demoAuthority.sessionProjection().state !== 'recording') return;
        const sample = demoAuthority.nextLiveSample();
        emit('ui.transcript-row', sample.provisional);
        setTimeout(() => {
          if (demoAuthority.sessionProjection().state === 'closed') return;
          const finalized = sample.finalize();
          emit('ui.transcript-row', finalized.transcript);
          emit('ui.logged-item-row', finalized.loggedItem);
          emit('ui.session-status', demoAuthority.sessionProjection());
        }, 850);
      }, 4300));
    }
    const address = server.address();
    process.stdout.write(`Argus UI bridge listening on http://${host}:${address.port}\n`);
    return { host, port: address.port };
  }

  async function close() {
    for (const timer of timers) clearInterval(timer);
    for (const client of clients) client.end();
    await new Promise((resolve) => server.close(resolve));
  }

  return Object.freeze({ server, start, close, boundary, authority: demoAuthority, capabilities: platform, bootstrap });
}

async function readRequestBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bridge = await createUiBridge({ port: Number(process.env.ARGUS_UI_PORT || 4173) });
  await bridge.start();
  process.on('SIGINT', () => bridge.close().finally(() => process.exit(0)));
  process.on('SIGTERM', () => bridge.close().finally(() => process.exit(0)));
}
