import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContractRegistry } from '../runtime/contract-registry.mjs';
import { assertGovernedEvolution } from '../runtime/contract-governance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(root, 'contracts', 'catalog.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const baseline = JSON.parse(await readFile(path.join(root, 'contracts', 'baselines', 'catalog-1.0.0.json'), 'utf8'));
const registry = await loadContractRegistry(catalogPath);
assertGovernedEvolution(baseline, catalog);

for (const [messageType, definition] of Object.entries(catalog.messages)) {
  await access(path.join(root, 'contracts', definition.schema));
  await access(path.join(root, 'contracts', definition.changelog));
  if (registry.planeFor(messageType) !== definition.plane) throw new Error(`${messageType} plane mismatch`);
}

const fixtureRoot = path.join(root, 'tests', 'fixtures', 'contracts');
const fixtureTypes = await (await import('node:fs/promises')).readdir(fixtureRoot);
const catalogTypes = Object.keys(catalog.messages);
if (fixtureTypes.sort().join('\n') !== catalogTypes.sort().join('\n')) {
  throw new Error('Contract fixture inventory must exactly match catalog message inventory');
}

process.stdout.write(`Contract governance valid for ${Object.keys(catalog.messages).length} messages.\n`);
