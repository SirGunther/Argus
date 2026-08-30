const path = require('node:path');
const { app, BrowserWindow, ipcMain, session } = require('electron');

const ROOT = path.resolve(__dirname, '..');
let mainWindow;
let application;
let quitting = false;
let shutdownPromise;
let rendererShutdownTimer;

// Keep the standalone host usable on Windows images where Chromium's GPU helper
// cannot load its optional graphics dependency. Audio capture and all Argus
// processing remain native/real; only UI compositing is software-rendered.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function configurePermissions() {
  const mediaPermissions = new Set(['media', 'microphone']);
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(mediaPermissions.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => mediaPermissions.has(permission));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: '#0c1117',
    webPreferences: {
      preload: path.join(ROOT, 'ui', 'desktop-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      sandbox: false
    }
  });
  mainWindow.removeMenu();
  await mainWindow.loadFile(path.join(ROOT, 'index.html'));
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    requestRendererShutdown();
  });
  mainWindow.on('closed', () => { mainWindow = undefined; });
}

async function start() {
  const { DesktopApplication } = await import('../runtime/desktop-application.mjs');
  configurePermissions();
  const sessionRoot = process.env.ARGUS_SESSION_ROOT || path.join(app.getPath('userData'), 'sessions');
  process.env.ARGUS_SESSION_ROOT = sessionRoot;
  const diagnosticsEnabled = shouldEnableDiagnostics();
  process.env.ARGUS_DIAGNOSTICS = diagnosticsEnabled ? '1' : '0';
  application = new DesktopApplication({
    root: ROOT,
    graphFile: path.join(ROOT, 'wiring', 'production-electron.json'),
    sessionRoot,
    environment: process.env,
    diagnosticsEnabled
  });
  application.diagnostics.log('electron.starting', { packaged: app.isPackaged, session_root_configured: Boolean(sessionRoot) });
  application.onProjection((message) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('argus.projection', message);
  });
  await application.start();

  ipcMain.handle('argus.bootstrap', () => application.bootstrap());
  ipcMain.handle('argus.command', (_event, payload) => application.handleCommand(payload));
  ipcMain.handle('argus.audio-chunk', (_event, payload) => application.acceptAudioChunk(payload));
  ipcMain.handle('argus.audio-flush', (_event, payload) => application.acceptAudioFlush(payload));
  ipcMain.handle('argus.capture-diagnostic', (_event, payload) => application.reportCaptureDiagnostic(payload));
  ipcMain.handle('argus.capture-failure', (_event, message) => application.reportCaptureFailure(message));
  ipcMain.handle('argus.shutdown-ready', () => completeShutdown('renderer-ready'));
  ipcMain.handle('argus.capabilities', () => application.capabilitySnapshot());

  await createWindow();
}

async function shutdown() {
  return completeShutdown('before-quit');
}

function requestRendererShutdown() {
  if (shutdownPromise) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    void completeShutdown('renderer-unavailable');
    return;
  }
  mainWindow.webContents.send('argus.shutdown-request');
  rendererShutdownTimer = setTimeout(() => void completeShutdown('renderer-timeout'), 15000);
}

function completeShutdown(reason) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    clearTimeout(rendererShutdownTimer);
    try { await application?.shutdown(); }
    catch (error) { console.error(`Argus shutdown failed (${reason}): ${error.stack || error.message}`); }
    finally {
      quitting = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      if (app.isReady()) app.quit();
    }
  })();
  return shutdownPromise;
}

app.whenReady().then(start).catch((error) => {
  console.error(`Argus startup failed: ${error.stack || error.message}`);
  app.exit(1);
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  requestRendererShutdown();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });

function shouldEnableDiagnostics() {
  const explicit = String(process.env.ARGUS_DIAGNOSTICS || '').trim().toLowerCase();
  return explicit === '1';
}
