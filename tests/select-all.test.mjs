import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);

test('each list header exposes an accessible three-state master checkbox', async () => {
  const [app, html, css] = await Promise.all([
    readFile(new URL('app.js', root), 'utf8'),
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('styles.css', root), 'utf8')
  ]);

  assert.equal((html.match(/class="select-all-checkbox"/g) || []).length, 2);
  assert.match(html, /class="select-all-checkbox" data-kind="transcript"[^>]*aria-controls="transcriptList"/);
  assert.match(html, /class="select-all-checkbox" data-kind="derived"[^>]*aria-controls="derivedList"/);
  assert.match(app, /selectionSummary\(ui, kind, ids\)/);
  assert.match(app, /selectAll\.indeterminate = selectionState === 'some'/);
  assert.match(app, /const action = selectionState === 'none' \? 'Select' : 'Deselect'/);
  assert.match(app, /setAllSelected\(ui, kind, ids, selectedCount === 0\)/);
  assert.match(css, /input\[aria-checked="mixed"\]/);
  assert.match(css, /input\[aria-checked="mixed"\][\s\S]*?background: var\(--surface-active\)/);
  assert.doesNotMatch(css, /\.select-all-button\s*\{\s*display:\s*none/);
});
