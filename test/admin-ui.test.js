'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/admin.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'js/admin.js'), 'utf8');

test('console admin contiene una slice reale mapping e assegnazioni', () => {
  for (const id of ['reports-list','mapping-form','clients-list','assignment-form','organization-id']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const callable of ['listMappingReports','proposeMapping','publishMapping','listAuthorizedClients']) {
    assert.match(js, new RegExp(`['"]${callable}['"]`));
  }
});

test('modale assegnazione v2: solo Cliente, Struttura, Decorrenza, Scadenza/Senza scadenza, Note e Conferma', () => {
  for (const id of ['assignment-structure','assignment-effective','assignment-expires','assignment-no-expiry','assignment-notes']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // Campi v1 eliminati: niente Ambito/Versione/Strategia/checksum/anteprima.
  for (const legacy of ['assignment-scope','assignment-version','assignment-strategy','assignment-checksum','assignment-preview','assignment-reason']) {
    assert.doesNotMatch(html, new RegExp(`id="${legacy}"`), `il campo v1 ${legacy} non deve più esistere`);
  }
  // Il checksum non viene mai mostrato né richiesto nel UI della console.
  assert.doesNotMatch(html, /Checksum SHA-256/i);
  assert.doesNotMatch(js, /previewClientRuleSet/);
  assert.match(js, /assignClientStructure/);
  assert.match(js, /listRuleSets/);
  // Landing: la vista Clienti è la porta d'ingresso.
  assert.match(html, /nav-link active" data-view="clients"/);
  assert.match(js, /showView\('clients'\)/);
  // Badge coda accessibile: stato anche senza colore.
  assert.match(html, /id="nav-open-count" class="badge-zero"/);
  assert.match(js, /aria-label.*Coda ingredienti/);
  assert.match(css, /\.nav-link b\.badge-zero/);
  assert.match(css, /\.nav-link b\.badge-count/);
});

test('console admin è responsive, accessibile e non indicizzabile', () => {
  assert.match(html, /name="robots" content="noindex,nofollow"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(css, /@media\(max-width:840px\)/);
  assert.match(css, /@media\(max-width:1100px\) and \(min-width:841px\)/, 'tabella passa a due colonne sui tablet');
  assert.match(css, /\.form-grid>label,[^{]+\{min-width:0\}/, 'i campi tecnici non forzano la griglia');
  assert.match(css, /\.dialog-actions\{flex-direction:column-reverse\}/, 'azioni modale impilate sugli schermi stretti');
  assert.match(css, /prefers-reduced-motion/);
});

test('sezione Strutture dieta: voce di menu dopo Clienti, editor a revisioni nuove, callable v2', () => {
  assert.match(html, /data-view="structures"/);
  assert.ok(html.indexOf('data-view="clients"') < html.indexOf('data-view="structures"'), 'Strutture dieta segue Clienti nel menu');
  assert.match(html, /id="view-structures"/);
  assert.match(html, /id="structure-form"/);
  assert.match(html, /id="structure-rules"/);
  assert.match(html, /id="structure-restore-field"/);
  for (const callable of ['listDietStructures','getDietStructureRevision','createDietStructure','updateDietStructureRevision','archiveDietStructure']) {
    assert.match(js, new RegExp(`['"]${callable}['"]`), `callable ${callable} usata`);
  }
  // Nessun campo "Versione" né checksum nel UI; date di sola lettura.
  assert.doesNotMatch(html, /<label>Versione/i);
  assert.doesNotMatch(html, /Checksum/);
  assert.doesNotMatch(js, /<input[^>]*structure-(created|updated)/);
  assert.match(js, /1 e 2000/);
  assert.match(js, /Famiglia duplicata/);
});

test('copy premium comunica valore e sicurezza senza promessa clinica assoluta', () => {
  assert.match(html, /Decisioni più sicure/);
  assert.match(html, /Ogni azione è tracciata/);
  assert.doesNotMatch(html, /garantisce|cura|risultato garantito/i);
});
