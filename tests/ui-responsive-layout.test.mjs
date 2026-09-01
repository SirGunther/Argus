import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);

test('compact Electron viewport contract keeps primary controls visible and secondary details collapsed', async () => {
  const [html, css, electron] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('styles.css', root), 'utf8'),
    readFile(new URL('electron/main.cjs', root), 'utf8')
  ]);
  const footer = html.match(/<footer class="statusbar">([\s\S]*?)<\/footer>/)?.[1] || '';
  const systemStart = footer.indexOf('<details class="system-status"');
  const systemEnd = footer.lastIndexOf('</details>');
  const systemStatus = systemStart >= 0 && systemEnd >= systemStart ? footer.slice(systemStart, systemEnd + '</details>'.length) : '';

  assert.match(electron, /width:\s*1180,\s*height:\s*800,\s*minWidth:\s*760,\s*minHeight:\s*600/);
  assert.match(css, /body\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow-x:\s*hidden;/);
  assert.match(css, /\.app-shell\s*\{[\s\S]*?grid-template-rows:\s*64px minmax\(0, 1fr\) auto 42px;[\s\S]*?min-height:\s*0;/);
  assert.match(css, /#transcriptList \.data-row:not\(\.live-preview\) > \.row-main \{\s*margin-left:\s*4px;\s*\}/, 'finalized transcript rows must keep a 4px timestamp/text inset');
  assert.doesNotMatch(css, /min-width:\s*760px|min-height:\s*850px|select\s*\{\s*width:\s*190px/);
  assert.doesNotMatch(css, /\.product-label, \.elapsed-block\s*\{\s*display:\s*none/);
  assert.match(html, /id="elapsedTime"/);
  assert.match(css, /@media \(max-width:\s*840px\)[\s\S]*?grid-template-columns:\s*1fr;[\s\S]*?grid-template-rows:\s*minmax\(190px, 1\.15fr\) minmax\(170px, \.85fr\)/);
  assert.match(css, /\.live-transcript-row\s*\{[\s\S]*?max-height:\s*78px;[\s\S]*?border-top:\s*1px solid var\(--line\);[\s\S]*?overflow-x:\s*hidden;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /@media \(max-width:\s*840px\)[\s\S]*?\.live-transcript-row\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
  assert.match(html, /<main class="workspace">[\s\S]*<\/main>\s*<section class="live-transcript-row" id="liveTranscript"[\s\S]*<footer class="statusbar">/);

  assert.match(footer, /class="capture-status"[\s\S]*?class="transcription-status/);
  assert.match(systemStatus, /id="serviceStatusList"/);
  assert.match(systemStatus, /id="audioInputDetails"/);
  assert.match(systemStatus, /id="saveStatus"/);
  assert.doesNotMatch(systemStatus, /<details class="system-status"[^>]*open/);
  assert.ok(footer.indexOf('class="capture-status"') < footer.indexOf('<details class="system-status"'), 'primary statuses must remain outside the collapsed system section');
});
