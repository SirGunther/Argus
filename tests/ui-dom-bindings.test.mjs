import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);

test('every required els binding is declared and its id selector exists in the HTML', async () => {
  const [source, html] = await Promise.all([
    readFile(new URL('app.js', root), 'utf8'),
    readFile(new URL('index.html', root), 'utf8')
  ]);

  const declarations = new Map(
    [...source.matchAll(/\b([A-Za-z][A-Za-z0-9]*):\s*document\.querySelector\('([^']+)'\)/g)]
      .map((match) => [match[1], match[2]])
  );
  const usages = new Set([...source.matchAll(/\bels\.([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]));
  const undeclared = [...usages].filter((name) => !declarations.has(name));

  assert.deepEqual(undeclared, [], `els bindings used but not declared: ${undeclared.join(', ')}`);
  assert.match(source, /assertRequiredBindings\(els\)/, 'browser startup must guard required bindings');

  const missingSelectors = [];
  for (const [name, selector] of declarations) {
    assert.match(selector, /^#[A-Za-z][A-Za-z0-9_-]*$/, `required binding ${name} must use an id selector`);
    const id = selector.slice(1);
    if (!new RegExp(`\\bid=["']${escapeRegExp(id)}["']`).test(html)) missingSelectors.push(`${name} (${selector})`);
  }
  assert.deepEqual(missingSelectors, [], `required selectors missing from index.html: ${missingSelectors.join(', ')}`);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
