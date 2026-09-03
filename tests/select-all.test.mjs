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
  assert.match(app, /checkboxLabel\.addEventListener\('click', \(event\) =>/);
  assert.match(app, /checkbox\.addEventListener\('change', \(event\) =>/);
  assert.match(app, /isShiftPressed\(event\)/);
  assert.match(app, /selectRange\(ui, kind, ids, anchorIndex, clickedIndex\)/);
  assert.match(app, /window\.addEventListener\('keydown', updateShiftKeyState\)/);
  assert.match(app, /window\.addEventListener\('keyup', updateShiftKeyState\)/);
  assert.match(app, /const action = selectionState === 'none' \? 'Select' : 'Deselect'/);
  assert.match(app, /setAllSelected\(ui, kind, ids, selectedCount === 0\)/);
  const rowSelectionHandlerStart = app.indexOf("checkbox.addEventListener('change'");
  const rowSelectionHandlerEnd = app.indexOf("editable.addEventListener('focus'", rowSelectionHandlerStart);
  assert.ok(rowSelectionHandlerStart >= 0 && rowSelectionHandlerEnd > rowSelectionHandlerStart);
  assert.doesNotMatch(app.slice(rowSelectionHandlerStart, rowSelectionHandlerEnd), /preventDefault\(\)/);
  const shiftSelectionHandlerStart = app.indexOf("checkboxLabel.addEventListener('click'");
  const shiftSelectionHandlerEnd = app.indexOf("checkbox.addEventListener('change'", shiftSelectionHandlerStart);
  assert.ok(shiftSelectionHandlerStart >= 0 && shiftSelectionHandlerEnd > shiftSelectionHandlerStart);
  assert.match(app.slice(shiftSelectionHandlerStart, shiftSelectionHandlerEnd), /event\.preventDefault\(\)/);
  assert.match(app, /window\.getSelection\(\)\?\.removeAllRanges\(\)/);
  assert.match(app, /els\.transcriptList\.classList\.toggle\('range-selection-active', shiftKeyDown\)/);
  assert.match(app, /els\.transcriptList\.classList\.remove\('range-selection-active'\)/);
  assert.match(app, /transcriptList\.addEventListener\('selectstart', \(event\) =>\s*\{\s*if \(isShiftPressed\(event\)\) event\.preventDefault\(\);\s*\}\)/);
  assert.match(css, /#transcriptList\.range-selection-active \.data-row\s*\{\s*user-select:\s*none;\s*\}/);
  assert.match(css, /input\[aria-checked="mixed"\]/);
  assert.match(css, /input\[aria-checked="mixed"\][\s\S]*?background: var\(--surface-active\)/);
  assert.doesNotMatch(css, /\.select-all-button\s*\{\s*display:\s*none/);
  assert.match(css, /\.pane-actions\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-width:\s*max-content;/);
  assert.match(css, /\.select-all-control\s*\{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/);
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*?\.pane\s*\{\s*grid-template-rows:\s*auto 27px minmax\(0, 1fr\);\s*\}[\s\S]*?\.pane-header\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/);
});
