import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractsDirectory = path.join(root, 'contracts');
const catalog = await readJson(path.join(contractsDirectory, 'catalog.json'));
const outputPath = path.join(contractsDirectory, 'generated', 'contract-reference.md');
const output = await renderReference(catalog);

if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8').catch(() => '');
  if (current !== output) {
    process.stderr.write('Generated contract reference is stale. Run npm run contracts:docs.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('Generated contract reference is current.\n');
  }
} else {
  await writeFile(outputPath, output, 'utf8');
  process.stdout.write(`Generated ${path.relative(root, outputPath)}.\n`);
}

async function renderReference(sourceCatalog) {
  const lines = [
    '# Generated Contract Reference',
    '',
    '> Generated from `contracts/catalog.json` and payload schemas. Do not edit by hand.',
    '',
    '## Governance',
    '',
    `- Catalog version: \`${sourceCatalog.schema_version}\``,
    `- Compatibility: \`${sourceCatalog.governance.compatibility_policy}\``,
    `- Plane changes: \`${sourceCatalog.governance.plane_change}\``,
    `- Validator: \`${sourceCatalog.governance.validation}\``,
    `- Default payload limit: ${formatBytes(sourceCatalog.governance.default_max_payload_bytes)}`,
    '',
    '## Inventory',
    '',
    '| Message | Plane | Version | Owner | Max payload |',
    '| --- | --- | --- | --- | ---: |'
  ];

  for (const [messageType, definition] of Object.entries(sourceCatalog.messages)) {
    lines.push(`| \`${messageType}\` | ${definition.plane} | \`${definition.version}\` | \`${definition.owner}\` | ${formatBytes(definition.max_payload_bytes)} |`);
  }

  for (const [messageType, definition] of Object.entries(sourceCatalog.messages)) {
    const schema = await readJson(path.join(contractsDirectory, definition.schema));
    lines.push('', `## \`${messageType}\``, '');
    lines.push(`- Plane: \`${definition.plane}\``);
    lines.push(`- Version: \`${definition.version}\``);
    lines.push(`- Owner: \`${definition.owner}\``);
    lines.push(`- Schema: [\`${definition.schema}\`](../${definition.schema})`);
    lines.push(`- History: [\`${definition.changelog}\`](../${definition.changelog})`);
    lines.push(`- Maximum payload: ${formatBytes(definition.max_payload_bytes)} (${definition.max_payload_bytes} bytes)`);
    lines.push('', '| Field | Required | Type | Constraint |', '| --- | --- | --- | --- |');
    const required = new Set(schema.required || []);
    for (const [property, propertySchema] of Object.entries(schema.properties || {})) {
      lines.push(`| \`${property}\` | ${required.has(property) ? 'yes' : 'no'} | ${describeType(propertySchema)} | ${describeConstraint(propertySchema)} |`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function describeType(schema) {
  if (schema.type === 'array') return `array<${schema.items?.type || 'value'}>`;
  return schema.type || 'any';
}

function describeConstraint(schema) {
  const constraints = [];
  if (schema.enum) constraints.push(schema.enum.map((value) => `\`${value}\``).join(', '));
  if (schema.minLength !== undefined) constraints.push(`min length ${schema.minLength}`);
  if (schema.minimum !== undefined) constraints.push(`minimum ${schema.minimum}`);
  if (schema.minItems !== undefined) constraints.push(`min items ${schema.minItems}`);
  if (schema.type === 'object' && schema.required?.length) constraints.push(`requires ${schema.required.map((name) => `\`${name}\``).join(', ')}`);
  return constraints.join('; ') || '—';
}

function formatBytes(bytes) {
  return bytes >= 1024 ? `${bytes / 1024} KiB` : `${bytes} B`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}
