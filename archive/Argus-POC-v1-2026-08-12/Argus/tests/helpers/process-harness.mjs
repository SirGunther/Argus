import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

export async function runService(manifestPath, inputs, expectedOutputCount, timeoutMs = 2000) {
  const absoluteManifestPath = path.resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absoluteManifestPath, 'utf8'));
  const serviceDirectory = path.dirname(absoluteManifestPath);
  const child = spawn(process.execPath, [path.resolve(serviceDirectory, manifest.runtime.entrypoint)], {
    cwd: serviceDirectory,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const outputs = [];
  const diagnostics = [];
  const stdout = readline.createInterface({ input: child.stdout });
  const stderr = readline.createInterface({ input: child.stderr });

  return new Promise((resolve, reject) => {
    let inputClosed = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${manifest.service_name} did not emit ${expectedOutputCount} message(s) within ${timeoutMs} ms. Diagnostics: ${diagnostics.join(' | ')}`));
    }, timeoutMs);

    const closeInput = () => {
      if (!inputClosed) {
        inputClosed = true;
        child.stdin.end();
      }
    };

    stdout.on('line', (line) => {
      try {
        outputs.push(JSON.parse(line));
      } catch (error) {
        clearTimeout(timer);
        child.kill();
        reject(new Error(`${manifest.service_name} emitted invalid JSON: ${error.message}`));
        return;
      }
      if (outputs.length >= expectedOutputCount) closeInput();
    });
    stderr.on('line', (line) => diagnostics.push(line));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      stdout.close();
      stderr.close();
      if (outputs.length < expectedOutputCount) {
        reject(new Error(`${manifest.service_name} exited early (code=${code}, signal=${signal}) after ${outputs.length} output(s). Diagnostics: ${diagnostics.join(' | ')}`));
      } else {
        resolve({ manifest, outputs, diagnostics, code, signal });
      }
    });

    for (const input of inputs) child.stdin.write(`${JSON.stringify(input)}\n`);
    if (expectedOutputCount === 0) closeInput();
  });
}

