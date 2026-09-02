const { contextBridge, ipcRenderer } = require('electron');

const projectionListeners = new Set();
const shutdownListeners = new Set();
let shutdownRequested = false;

ipcRenderer.on('argus.projection', (_event, message) => {
  for (const listener of projectionListeners) listener(message);
});
ipcRenderer.on('argus.shutdown-request', () => {
  shutdownRequested = true;
  for (const listener of shutdownListeners) listener();
});

contextBridge.exposeInMainWorld('argus', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('argus.bootstrap'),
  command: (payload) => ipcRenderer.invoke('argus.command', payload),
  sendAudioChunk: (payload) => ipcRenderer.invoke('argus.audio-chunk', payload),
  sendAudioFlush: (payload) => ipcRenderer.invoke('argus.audio-flush', payload),
  reportCaptureDiagnostic: (payload) => ipcRenderer.invoke('argus.capture-diagnostic', payload),
  reportCaptureFailure: (message) => ipcRenderer.invoke('argus.capture-failure', String(message || 'Physical microphone capture failed.')),
  shutdownReady: () => ipcRenderer.invoke('argus.shutdown-ready'),
  capabilities: () => ipcRenderer.invoke('argus.capabilities'),
  aiProviderSettings: () => ipcRenderer.invoke('argus.ai-provider-settings'),
  saveAiProviderSettings: (payload) => ipcRenderer.invoke('argus.ai-provider-save', payload),
  testAiProviderSettings: (payload) => ipcRenderer.invoke('argus.ai-provider-test', payload),
  onProjection(listener) {
    if (typeof listener !== 'function') throw new TypeError('projection listener must be a function');
    projectionListeners.add(listener);
    return () => projectionListeners.delete(listener);
  },
  onShutdown(listener) {
    if (typeof listener !== 'function') throw new TypeError('shutdown listener must be a function');
    shutdownListeners.add(listener);
    if (shutdownRequested) queueMicrotask(listener);
    return () => shutdownListeners.delete(listener);
  }
}));
