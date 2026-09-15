'use strict';
/* Tabelle grammature del nutrizionista (console professionisti):
 *  - voce di menu a sinistra e vista dedicata;
 *  - CRUD personale: crea, modifica, duplica, elimina;
 *  - l'editor della dieta guidata sceglie da quale tabella attingere;
 *  - tabella di esempio caricata sul profilo del nutrizionista via seed. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'js/admin.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/admin.css'), 'utf8');
const functionsJs = fs.readFileSync(path.join(root, 'functions/src/index.js'), 'utf8');
const domain = require(path.join(root, 'js/domain.js'));

test('console: menu a sinistra «Tabelle grammature» e vista dedicata', () => {
  assert.match(html, /data-view="tables"/);
  assert.match(html, /Tabelle grammature/);
  assert.match(html, /id="view-tables"/);
  assert.match(html, /id="new-gram-table"/);
  assert.match(html, /id="refresh-gram-tables"/);
  assert.match(html, /id="gram-tables-list"/);
  assert.match(js, /view === 'tables'/);
  assert.match(js, /function loadGrammatureTables/);
});

test('console: editor tabella con righe, gruppo e dosi A/R', () => {
  for (const id of ['gram-table-dialog', 'gram-table-form', 'gram-table-id', 'gram-table-name', 'gram-table-description', 'gram-table-rows', 'gram-table-add-row', 'gram-table-error', 'gram-table-catalog-options']) {
    assert.match(html, new RegExp(`id="${id}"`), `manca #${id}`);
  }
  for (const fn of ['openGramTableDialog', 'closeGramTableDialog', 'collectGramTable', 'submitGramTable', 'duplicateGramTable', 'deleteGramTable', 'gramTableRowHtml']) {
    assert.match(js, new RegExp(`function ${fn}\\b`), `manca ${fn}`);
  }
  // Quattro dosi per riga: pranzo A/R e cena A/R.
  assert.match(js, /data-g="row-lt"/);
  assert.match(js, /data-g="row-lr"/);
  assert.match(js, /data-g="row-dt"/);
  assert.match(js, /data-g="row-dr"/);
  assert.match(css, /\.gram-table-row\{/);
});

test('backend: callable personali per elenco, salvataggio, duplica, elimina', () => {
  for (const name of ['listMyGrammatureTables', 'saveGrammatureTable', 'duplicateGrammatureTable', 'deleteGrammatureTable']) {
    assert.match(functionsJs, new RegExp(`exports\\.${name} = callable`), `manca callable ${name}`);
  }
  // Le tabelle vivono sotto l'organizzazione e sono personali (ownerUid).
  assert.match(functionsJs, /grammatureTables/);
  assert.match(functionsJs, /ownerUid/);
  assert.match(functionsJs, /Puoi modificare soltanto le tue tabelle/);
});

test('dieta guidata: selezione della tabella grammature in compilazione', () => {
  assert.match(html, /id="diet-plan-gram-table"/);
  assert.match(js, /function renderDietPlanGramTableSelect/);
  assert.match(js, /function dietPlanPrefillAlternatives/);
  // La tabella guida integrata resta sempre disponibile come riferimento.
  assert.match(js, /Tabella guida integrata/);
});

test('dominio: alternative da una tabella con fallback tra slot', () => {
  const table = { rows: [
    { description: 'Avena', group: 'carb', foodGroup: 'cereali', doses: { lunch: { training: 70, rest: 50 }, dinner: { training: null, rest: 40 } } }
  ] };
  // Cena di allenamento senza dose A: usa il riposo della cena.
  const dinner = domain.dietPlanTableAlternatives(table, 'carb', 'dinner', 'training');
  assert.equal(dinner[0].quantity, 40);
  // Riga senza alcuna dose per il pasto richiesto ma con altre dosi: resta.
  const onlyLunch = { rows: [{ description: 'X', group: 'protein', doses: { lunch: { training: 100 } } }] };
  assert.equal(domain.dietPlanTableAlternatives(onlyLunch, 'protein', 'lunch', 'training')[0].quantity, 100);
  // Gruppo diverso: nessuna riga.
  assert.deepEqual(domain.dietPlanTableAlternatives(onlyLunch, 'carb', 'lunch', 'training'), []);
});

test('seed: tabella di esempio per il profilo nutrizionista', () => {
  const script = fs.readFileSync(path.join(root, 'functions/scripts/seed-grammature-tables.js'), 'utf8');
  assert.match(script, /2WVr880Y9DTpPQPJGPDHshMczdI2/, 'uid del nutrizionista');
  assert.match(script, /tabella-grammature-esempio\.json/);
  assert.match(script, /grammatureTables/);
  const table = JSON.parse(fs.readFileSync(path.join(root, 'docs/tabella-grammature-esempio.json'), 'utf8'));
  assert.ok(table.rows.length >= 30);
});
