import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertVerifiedGraphPackage, buildGraphPackage, stableStringify, verifyGraphPackage } from '../runtime/package-inventory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const verifyOnly = argv.includes('--verify');
const outIndex = argv.indexOf('--out-dir');
const outDirectory = path.resolve(root, outIndex === -1 ? 'runtime-output/package' : argv[outIndex + 1]);
const graphArguments = argv.filter((value, index) => !value.startsWith('--') && index !== outIndex + 1);
const graphFiles = graphArguments.length
  ? graphArguments.map((value) => path.resolve(process.cwd(), value))
  : (await readdir(path.join(root, 'wiring')))
      .filter((entry) => entry.endsWith('.json'))
      .sort()
      .map((entry) => path.join(root, 'wiring', entry));

try {
  if (!verifyOnly) await mkdir(outDirectory, { recursive: true });
  const summaries = [];
  for (const graphFile of graphFiles) {
    const built = await buildGraphPackage({ graphFile, root });
    const artifactPath = path.join(outDirectory, `${built.graph.name}.package.json`);
    const serialized = stableStringify(built);

    if (verifyOnly) {
      const recorded = JSON.parse(await readFile(artifactPath, 'utf8'));
      assertVerifiedGraphPackage(await verifyGraphPackage({ graphFile, root, recorded }), built.graph.name);
    } else {
      await writeFile(artifactPath, serialized, 'utf8');
      // Determinism is a property of the artifact, not an aspiration: rebuild and require identical bytes.
      const rebuilt = stableStringify(await buildGraphPackage({ graphFile, root }));
      if (rebuilt !== serialized) throw new Error(`Package build for ${built.graph.name} is not deterministic`);
    }
    summaries.push(`${built.graph.name}: ${built.integrity.file_count} files, ${built.components.length} components, digest ${built.integrity.package_digest.slice(0, 16)}`);
  }
  process.stdout.write(`${verifyOnly ? 'Verified' : 'Packaged'} ${graphFiles.length} graph(s) into ${path.relative(root, outDirectory).replaceAll('\\', '/')}\n${summaries.map((line) => `  ${line}\n`).join('')}`);
} catch (error) {
  process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
  process.exitCode = 1;
}
