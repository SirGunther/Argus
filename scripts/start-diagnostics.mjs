import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const diagnosticFile = path.resolve(
  process.env.ARGUS_DIAGNOSTIC_FILE || path.join(root, 'runtime-output', 'diagnostics', `argus-${timestamp}-${process.pid}.jsonl`)
);
const electronCommand = process.platform === 'win32' ? 'electron.cmd' : 'electron';
const launchEnvironment = { ...process.env, ARGUS_DIAGNOSTICS: '1', ARGUS_DIAGNOSTIC_FILE: diagnosticFile };
// This marker is injected when Electron launches a governed Node service; it
// must not make the real source application run as plain Node.
delete launchEnvironment.ELECTRON_RUN_AS_NODE;
const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : electronCommand;
const args = process.platform === 'win32' ? ['/d', '/s', '/c', `${electronCommand} .`] : ['.'];
const child = spawn(command, args, {
  cwd: root,
  env: launchEnvironment,
  stdio: 'inherit',
  windowsHide: false
});

child.once('error', (error) => {
  process.stderr.write(`Argus diagnostics launcher failed: ${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
