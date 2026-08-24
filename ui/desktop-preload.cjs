const { contextBridge, ipcRenderer } = require('electron');

const projectionListeners = new Set();

ipcRenderer.on('argus.projection', (_event, message) => {
  for (const listener of projectionListeners) listener(message);
});

contextBridge.exposeInMainWorld('argus', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('argus.bootstrap'),
  command: (payload) => ipcRenderer.invoke('argus.command', payload),
  sendAudioChunk: (payload) => ipcRenderer.invoke('argus.audio-chunk', payload),
  sendAudioFlush: (payload) => ipcRenderer.invoke('argus.audio-flush', payload),
  reportCaptureFailure: (message) => ipcRenderer.invoke('argus.capture-failure', String(message || 'Physical microphone capture failed.')),
  capabilities: () => ipcRenderer.invoke('argus.capabilities'),
  onProjection(listener) {
    if (typeof listener !== 'function') throw new TypeError('projection listener must be a function');
    projectionListeners.add(listener);
    return () => projectionListeners.delete(listener);
  }
}));
