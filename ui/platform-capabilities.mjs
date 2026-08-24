import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveSessionRoot, validateSessionId } from '../runtime/session-storage.mjs';

export class PlatformCapabilityError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'PlatformCapabilityError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function createPlatformCapabilities({ environment = process.env, clipboard, folder } = {}) {
  const clipboardCapability = clipboard || createWindowsClipboardCapability();
  const folderCapability = folder || createSessionFolderCapability({ environment });
  return Object.freeze({ clipboard: clipboardCapability, folder: folderCapability });
}

export function createFakeCapabilities({ clipboard = async () => undefined, resolveFolder = async (sessionId) => `/fake/sessions/${validateSessionId(sessionId)}`, openFolder = async () => undefined } = {}) {
  return Object.freeze({
    clipboard: Object.freeze({
      name: 'fake-clipboard',
      available: true,
      async write(text) { await clipboard(text); return { message: 'Copied through deterministic capability fake.' }; }
    }),
    folder: Object.freeze({
      name: 'fake-folder',
      async resolve(sessionId) { return resolveFolder(sessionId); },
      async open(sessionId) { const resolved = await resolveFolder(sessionId); await openFolder(sessionId, resolved); return { path: resolved, message: 'Folder opened through deterministic capability fake.' }; }
    })
  });
}

function createWindowsClipboardCapability() {
  return Object.freeze({
    name: 'windows-clipboard',
    available: process.platform === 'win32',
    async write(text) {
      if (process.platform !== 'win32') throw new PlatformCapabilityError('CLIPBOARD_UNAVAILABLE', 'The loopback bridge has no clipboard adapter on this operating system.', { retryable: true });
      await runProcess('clip.exe', [], text);
      return { message: 'Copied to the operating-system clipboard.' };
    }
  });
}

function createSessionFolderCapability({ environment }) {
  return Object.freeze({
    name: 'session-folder',
    available: Boolean(environment.ARGUS_SESSION_ROOT) && process.platform === 'win32',
    async resolve(sessionId) {
      validateSessionId(sessionId);
      let root;
      try { root = resolveSessionRoot(environment); }
      catch { throw new PlatformCapabilityError('FOLDER_UNAVAILABLE', 'Session storage is not configured for the folder capability.', { retryable: true }); }
      const target = path.resolve(root, sessionId);
      if (path.relative(path.resolve(root), target).startsWith('..')) throw new PlatformCapabilityError('FOLDER_REJECTED', 'Session folder resolution escaped the configured root.');
      try {
        const info = await stat(target);
        if (!info.isDirectory()) throw new Error('not a directory');
      } catch {
        throw new PlatformCapabilityError('FOLDER_UNAVAILABLE', `The authorized session folder does not exist for ${sessionId}.`, { retryable: true });
      }
      return target;
    },
    async open(sessionId) {
      const target = await this.resolve(sessionId);
      if (process.platform !== 'win32') throw new PlatformCapabilityError('FOLDER_UNAVAILABLE', 'Opening an operating-system folder is unavailable in this browser host.', { retryable: true });
      await runProcess('explorer.exe', [target]);
      return { path: target, message: 'Session folder opened.' };
    }
  });
}

function runProcess(command, args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let errorText = '';
    child.stderr.on('data', (chunk) => { errorText += chunk.toString(); });
    child.on('error', (error) => reject(new PlatformCapabilityError('CAPABILITY_FAILED', `${command} failed: ${error.message}`, { retryable: true })));
    child.on('close', (code) => code === 0 ? resolve() : reject(new PlatformCapabilityError('CAPABILITY_FAILED', `${command} exited with ${code}: ${errorText}`)));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
