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

test('Scribe progress renders inside the Logged Items pane and distinguishes every governed state', async () => {
  const [source, html, css] = await Promise.all([
    readFile(new URL('app.js', root), 'utf8'),
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('styles.css', root), 'utf8')
  ]);

  // The indicator has to sit beside the Logged Items it explains, not only in the footer chips.
  const paneStart = html.indexOf('id="derivedPane"');
  const derivedPane = html.slice(paneStart, html.indexOf('</section>', paneStart));
  assert.match(derivedPane, /id="scribeStatus"/, 'Scribe progress must render inside the Logged Items pane');
  assert.match(derivedPane, /aria-live="polite"/);

  assert.match(source, /renderScribeStatus\(state\.session\.scribe_processing\)/, 'the renderer must read the governed projection');
  for (const governedState of ['caught-up', 'pending', 'queued', 'processing', 'delayed', 'unavailable', 'failed']) {
    assert.ok(new RegExp(`['"]?${escapeRegExp(governedState)}['"]?:`).test(source), `the renderer must label the ${governedState} state`);
  }
  // A failed or stalled batch must not read like a healthy one.
  assert.match(css, /\.scribe-status\.failed[^{]*\{/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
