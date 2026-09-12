'use strict';
/* Regressione — ordine di parsing di admin.html.
 *
 * `js/admin.js` esegue `bindAdmin()` mentre il documento è ancora in fase di
 * parsing: ogni elemento letto con `$('id')` deve quindi essere già stato
 * incontrato dal parser, cioè dichiarato PRIMA del tag
 * `<script src="js/admin.js">`. Se un dialog finisce dopo gli script,
 * `document.getElementById()` restituisce null e la prima
 * `addEventListener` lancia "Cannot read properties of null": da lì in poi
 * nessun altro listener della console viene agganciato (bug verificato in
 * produzione su `#group-target`).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'js', 'admin.js'), 'utf8');

const scriptTag = '<script src="js/admin.js"></script>';
const scriptIndex = html.indexOf(scriptTag);
const beforeScripts = scriptIndex === -1 ? '' : html.slice(0, scriptIndex);
const afterScripts = scriptIndex === -1 ? '' : html.slice(scriptIndex + scriptTag.length);

function idsIn(source) {
  return new Set([...source.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
}

test('ogni elemento letto da admin.js è dichiarato prima dello script della console', () => {
  assert.notEqual(scriptIndex, -1, 'admin.html deve caricare js/admin.js');
  const referenced = new Set([
    ...[...js.matchAll(/\$\(\s*'([^']+)'\s*\)/g)].map(match => match[1]),
    ...[...js.matchAll(/\$\(\s*"([^"]+)"\s*\)/g)].map(match => match[1]),
    ...[...js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map(match => match[1])
  ]);
  const declaredBefore = idsIn(beforeScripts);
  const declaredAfter = idsIn(afterScripts);
  const late = [...referenced].filter(id => declaredAfter.has(id) && !declaredBefore.has(id));
  assert.deepEqual(late, [], `elementi della console dichiarati dopo js/admin.js: ${late.join(', ')}`);
});

test('nessun dialog della console resta fuori dalla sezione markup', () => {
  // I dialog vivono tutti prima degli script: nessuno deve essere aggiunto in coda.
  assert.doesNotMatch(afterScripts, /<div[^>]+class="dialog/, 'nessun dialog dopo gli script');
  assert.match(beforeScripts, /id="group-dialog"/, 'il dialog di raggruppamento resta nel markup utile');
});

test('markup della console senza refusi evidenti nei contenitori principali', () => {
  // Un ">" di troppo dopo l\'attributo class produceva un carattere visibile
  // all\'inizio della vista Clienti.
  assert.doesNotMatch(html, /class="console-view hidden">>/, 'nessun ">" duplicato nelle viste');
  assert.doesNotMatch(html, /<main[^>]*>\s*>\s*</, 'nessun testo ">" orfano dentro le viste');
  assert.deepEqual(html.match(/[<>]{3,}/g) || [], [], 'nessuna sequenza sospetta di parentesi angolari');
});
