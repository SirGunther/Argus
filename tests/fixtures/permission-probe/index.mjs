// Deterministic containment probe. It reports what the installed Node permission model actually
// refuses, so an enforcement claim can be checked against observed runtime behavior instead of
// against the declaration that requested it.
import { readFile, writeFile } from 'node:fs/promises';
import { getHeapStatistics } from 'node:v8';

const results = {};

const attempt = async (name, action) => {
  try {
    await action();
    results[name] = 'allowed';
  } catch (error) {
    results[name] = error.code || error.name || 'FAILED';
  }
};

const sessionRoot = process.env.ARGUS_SESSION_ROOT;

await attempt('read-own-directory', () => readFile(new URL('./service.json', import.meta.url)));
await attempt('write-own-directory', () => writeFile(new URL('./probe-artifact.txt', import.meta.url), 'probe'));
await attempt('read-outside-any-grant', () => readFile(new URL('../../../package.json', import.meta.url)));
await attempt('read-session-root', () => readFile(`${sessionRoot}/probe-input.txt`, 'utf8'));
await attempt('write-session-root', () => writeFile(`${sessionRoot}/probe-output.txt`, 'probe'));
await attempt('spawn-child-process', async () => {
  const { spawnSync } = await import('node:child_process');
  const outcome = spawnSync(process.execPath, ['-e', '0']);
  if (outcome.error) throw outcome.error;
});
await attempt('start-worker-thread', async () => {
  const { Worker } = await import('node:worker_threads');
  const worker = new Worker('', { eval: true });
  await new Promise((resolve, reject) => {
    worker.on('exit', resolve);
    worker.on('error', reject);
  });
});

const report = {
  argus_environment_keys: Object.keys(process.env).filter((key) => key.startsWith('ARGUS_')).sort(),
  credential_shaped_keys: Object.keys(process.env).filter((key) => /(^|_)(KEY|TOKEN|SECRET|PASSWORD)$/.test(key.toUpperCase())).sort(),
  heap_size_limit_bytes: getHeapStatistics().heap_size_limit,
  results
};

process.stdout.write(JSON.stringify(report) + '\n');
