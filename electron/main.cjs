const path = require('node:path');
const { app, BrowserWindow, ipcMain, session } = require('electron');

const ROOT = path.resolve(__dirname, '..');
let mainWindow;
let application;
let quitting = false;

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
    width: 1440,
    height: 1000,
    minWidth: 1060,
    minHeight: 720,
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
  mainWindow.on('closed', () => { mainWindow = undefined; });
}

async function start() {
  const { DesktopApplication } = await import('../runtime/desktop-application.mjs');
  configurePermissions();
  const sessionRoot = process.env.ARGUS_SESSION_ROOT || path.join(app.getPath('userData'), 'sessions');
  process.env.ARGUS_SESSION_ROOT = sessionRoot;
  application = new DesktopApplication({
    root: ROOT,
    graphFile: path.join(ROOT, 'wiring', 'production-electron.json'),
    sessionRoot,
    environment: process.env
  });
  application.onProjection((message) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('argus.projection', message);
  });
  await application.start();

  ipcMain.handle('argus.bootstrap', () => application.bootstrap());
  ipcMain.handle('argus.command', (_event, payload) => application.handleCommand(payload));
  ipcMain.handle('argus.audio-chunk', (_event, payload) => application.acceptAudioChunk(payload));
  ipcMain.handle('argus.audio-flush', (_event, payload) => application.acceptAudioFlush(payload));
  ipcMain.handle('argus.capture-failure', (_event, message) => application.reportCaptureFailure(message));
  ipcMain.handle('argus.capabilities', () => application.capabilitySnapshot());

  await createWindow();
}

async function shutdown() {
  if (quitting) return;
  quitting = true;
  try { await application?.shutdown(); }
  catch (error) { console.error(`Argus shutdown failed: ${error.stack || error.message}`); }
}

app.whenReady().then(start).catch((error) => {
  console.error(`Argus startup failed: ${error.stack || error.message}`);
  app.exit(1);
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  shutdown().finally(() => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });
