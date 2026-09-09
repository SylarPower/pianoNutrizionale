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
  for (const callable of ['listMappingReports','proposeMapping','publishMapping','listAuthorizedClients','previewClientRuleSet','assignClientRuleSet']) {
    assert.match(js, new RegExp(`['"]${callable}['"]`));
  }
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

test('copy premium comunica valore e sicurezza senza promessa clinica assoluta', () => {
  assert.match(html, /Decisioni più sicure/);
  assert.match(html, /Ogni azione è tracciata/);
  assert.doesNotMatch(html, /garantisce|cura|risultato garantito/i);
});
