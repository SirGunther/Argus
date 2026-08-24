import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

export async function runService(manifestPath, inputs, expectedOutputCount, timeoutMs = 2000, { env = {} } = {}) {
  const absoluteManifestPath = path.resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absoluteManifestPath, 'utf8'));
  const serviceDirectory = path.dirname(absoluteManifestPath);
  const child = spawn(process.execPath, [path.resolve(serviceDirectory, manifest.runtime.entrypoint)], {
    cwd: serviceDirectory,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...env }
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

export async function runServiceBatches(manifestPath, batches, timeoutMs = 2000, { env = {} } = {}) {
  const absoluteManifestPath = path.resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absoluteManifestPath, 'utf8'));
  const serviceDirectory = path.dirname(absoluteManifestPath);
  const child = spawn(process.execPath, [path.resolve(serviceDirectory, manifest.runtime.entrypoint)], {
    cwd: serviceDirectory,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...env }
  });
  const outputs = [];
  const diagnostics = [];
  const batchOutputs = [];
  const waiters = new Set();
  const stdout = readline.createInterface({ input: child.stdout });
  const stderr = readline.createInterface({ input: child.stderr });
  let fatalError;
  let exited;

  const notifyWaiters = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const exitPromise = new Promise((resolve, reject) => {
    child.on('error', (error) => {
      fatalError = error;
      notifyWaiters();
      reject(error);
    });
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      notifyWaiters();
      resolve(exited);
    });
  });

  stdout.on('line', (line) => {
    try {
      outputs.push(JSON.parse(line));
    } catch (error) {
      fatalError = new Error(`${manifest.service_name} emitted invalid JSON: ${error.message}`);
      child.kill();
    }
    notifyWaiters();
  });
  stderr.on('line', (line) => diagnostics.push(line));

  const waitForOutputCount = (count, batchIndex) => {
    if (outputs.length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`${manifest.service_name} did not emit ${count} cumulative message(s) after batch ${batchIndex + 1} within ${timeoutMs} ms. Diagnostics: ${diagnostics.join(' | ')}`));
      }, timeoutMs);
      const check = () => {
        if (!fatalError && !exited && outputs.length < count) return;
        clearTimeout(timer);
        waiters.delete(check);
        if (fatalError) reject(fatalError);
        else if (outputs.length < count) reject(new Error(`${manifest.service_name} exited early (code=${exited?.code}, signal=${exited?.signal}) after ${outputs.length} output(s). Diagnostics: ${diagnostics.join(' | ')}`));
        else resolve();
      };
      waiters.add(check);
      check();
    });
  };

  let cumulativeExpected = 0;
  try {
    for (const [batchIndex, batch] of batches.entries()) {
      const startIndex = outputs.length;
      for (const input of batch.inputs) child.stdin.write(`${JSON.stringify(input)}\n`);
      cumulativeExpected += batch.expectedOutputCount;
      await waitForOutputCount(cumulativeExpected, batchIndex);
      batchOutputs.push(outputs.slice(startIndex, cumulativeExpected));
      if (batch.pauseAfterMs) await new Promise((resolve) => setTimeout(resolve, batch.pauseAfterMs));
    }
    child.stdin.end();
    const { code, signal } = await exitPromise;
    stdout.close();
    stderr.close();
    if (outputs.length !== cumulativeExpected) {
      throw new Error(`${manifest.service_name} emitted ${outputs.length} message(s); expected exactly ${cumulativeExpected}`);
    }
    return { manifest, outputs, batchOutputs, diagnostics, code, signal, pid: child.pid };
  } catch (error) {
    if (!exited) child.kill();
    await exitPromise.catch(() => {});
    stdout.close();
    stderr.close();
    throw error;
  }
}
