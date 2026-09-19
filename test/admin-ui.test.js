'use strict';
/* Console admin — contratto statico della v2 (catalogo globale, strutture a
 * blocchi, template equivalenze, coda richieste):
 *  - menu: Clienti, Strutture dieta, Template equivalenze, Ricette (visibili),
 *    Catalogo e Richieste catalogo riservate al creatore;
 *  - nessuna vista legacy (Dosi clienti, Mapping, Utenti, editor regole);
 *  - callable v2 usate, callable rimosse assenti;
 *  - dialog assegnazione senza campi v1; editor strutture dieta e dialog
 *    template/richieste col contratto attuale.
 * I percorsi DOM interattivi sono coperti da test/smoke-admin.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/admin.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'js/admin.js'), 'utf8');

test('menu console: viste operative visibili, Catalogo e Richieste riservate', () => {
  for (const view of ['clients', 'structures', 'templates', 'recipes']) {
    assert.match(html, new RegExp(`data-view="${view}"`), `voce ${view} presente`);
    assert.doesNotMatch(html, new RegExp(`data-view="${view}"[^>]*class="nav-link hidden"`), `voce ${view} visibile`);
  }
  // Catalogo e Richieste catalogo: nascosti di default, visibili solo al creatore.
  assert.match(html, /id="nav-catalog" class="nav-link hidden" data-view="catalog"/);
  assert.match(html, /id="nav-requests" class="nav-link hidden" data-view="requests"/);
  // Badge della coda: conteggio in sospeso, leggibile anche senza colore.
  assert.match(html, /id="nav-open-count" class="badge-zero" aria-label="Richieste catalogo in sospeso"/);
  assert.match(css, /\.nav-link b\.badge-zero/);
  assert.match(css, /\.nav-link b\.badge-count/);
});

test('console admin: nessuna vista legacy', () => {
  // Le viste rimosse non devono lasciare tracce né nel menu né nel JS.
  for (const legacy of ['data-view="doses"', 'data-view="mapping"', 'data-view="users"', 'id="view-doses"', 'id="view-mapping"', 'id="view-users"', '>Utenti<']) {
    assert.doesNotMatch(html, new RegExp(legacy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${legacy} non deve esistere`);
  }
  for (const legacyId of ['reports-list', 'mapping-form', 'structure-form', 'structure-rules', 'structure-groups', 'structure-add-group', 'catalog-picker']) {
    assert.doesNotMatch(html, new RegExp(`id="${legacyId}"`), `l'id legacy ${legacyId} non deve esistere`);
    assert.doesNotMatch(js, new RegExp(`getElementById\\("${legacyId}"\\)`), `il JS non deve usare ${legacyId}`);
  }
});

test('callable v2 usate, callable legacy assenti', () => {
  for (const callable of [
    'listAuthorizedClients', 'listDietStructures', 'getDietStructureRevision', 'createDietStructure',
    'updateDietStructureRevision', 'archiveDietStructure', 'assignClientStructure', 'compareDietStructures',
    'listEquivalenceTemplates', 'getEquivalenceTemplateRevision', 'saveEquivalenceTemplate', 'archiveEquivalenceTemplate',
    'listCatalogRequests', 'resolveCatalogRequest', 'importGlobalIngredientCatalog'
  ]) {
    assert.match(js, new RegExp(`['"]${callable}['"]`), `callable ${callable} usata`);
  }
  for (const legacy of ['listRuleSets', 'assignClientRuleSet', 'previewClientRuleSet', 'proposeMapping', 'publishMapping', 'listMappingReports', 'saveGrammatureTables', 'listClientDoseOverrides']) {
    assert.doesNotMatch(js, new RegExp(`['"]${legacy}['"]`), `callable legacy ${legacy} assente`);
  }
});

test('modale assegnazione: solo Cliente, Struttura, Decorrenza, Scadenza, Note', () => {
  for (const id of ['assignment-structure', 'assignment-effective', 'assignment-expires', 'assignment-no-expiry', 'assignment-notes']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // Campi v1 eliminati: niente Ambito/Versione/Strategia/checksum/anteprima.
  for (const legacy of ['assignment-scope', 'assignment-version', 'assignment-strategy', 'assignment-checksum', 'assignment-preview', 'assignment-reason']) {
    assert.doesNotMatch(html, new RegExp(`id="${legacy}"`), `il campo v1 ${legacy} non deve più esistere`);
  }
  assert.doesNotMatch(html, /Checksum SHA-256/i);
  // Il selettore usa le strutture dieta (nome + ultima modifica).
  assert.match(html, /id="assignment-structure-list"/);
  // La landing resta la vista Clienti.
  assert.match(html, /nav-link active" data-view="clients"/);
  assert.match(js, /showView\('clients'\)/);
});

test('editor strutture dieta: giornate, pasti a opzioni, catalogo e anteprima', () => {
  assert.ok(html.indexOf('data-view="clients"') < html.indexOf('data-view="structures"'), 'Strutture dieta segue Clienti nel menu');
  assert.match(html, /id="view-structures"/);
  assert.match(html, /id="new-diet-plan"/);
  assert.match(html, /id="refresh-structures"/);
  assert.match(html, /id="structures-list"/);
  // Dialog editor a revisioni: restore, changelog, dettagli tecnici, anteprima.
  for (const id of ['diet-plan-dialog', 'diet-plan-name', 'diet-plan-days', 'diet-plan-add-day', 'diet-plan-general-notes', 'diet-plan-changelog', 'diet-plan-restore-field', 'diet-plan-load-revision', 'diet-plan-preview', 'diet-plan-preview-toggle', 'diet-plan-error', 'diet-plan-submit']) {
    assert.match(html, new RegExp(`id="${id}"`), `editor: ${id}`);
  }
  assert.match(html, /<details id="diet-plan-tech-details"/);
  assert.match(html, /<summary>Dettagli tecnici<\/summary>/);
  // Autocomplete dal catalogo globale (datalist condivisa).
  assert.match(html, /id="diet-catalog-options"/);
  assert.match(js, /loadCatalogIndex/);
  assert.match(js, /collectDietPlanFromEditor/);
  assert.match(js, /renderDietPlanEditor/);
  // Confronto strutture in sola lettura.
  assert.match(html, /id="compare-structures"/);
  assert.match(html, /id="compare-dialog"/);
  assert.match(html, /id="compare-matrix"/);
  assert.match(js, /compareDietStructures/);
  assert.match(js, /Sola lettura/);
  assert.match(css, /\.compare-table|\.compare-matrix/);
});

test('template equivalenze: famiglia di riferimento, importo ed equivalenti', () => {
  assert.match(html, /data-view="templates"/);
  assert.match(html, /id="view-templates"/);
  for (const id of ['template-dialog', 'template-form', 'template-name', 'template-family', 'template-ingredient', 'template-ref-value', 'template-ref-unit', 'template-equivalents', 'template-add-equivalent', 'template-error']) {
    assert.match(html, new RegExp(`id="${id}"`), `template: ${id}`);
  }
  // L'ingrediente di riferimento è un input con datalist (non un campo libero).
  assert.match(html, /id="template-ingredient"[^>]*list="diet-catalog-options"/);
  assert.match(js, /referenceFamilyId/);
  assert.match(js, /referenceAmount/);
  assert.match(js, /equivalents/);
});

test('coda richieste catalogo: dialog di valutazione con identità e solo identità', () => {
  for (const id of ['request-dialog', 'request-form', 'request-display-name', 'request-ingredient-id', 'request-category', 'request-family', 'request-vegetarian', 'request-vegan', 'request-aliases', 'request-reason', 'request-error', 'request-reject', 'request-accept']) {
    assert.match(html, new RegExp(`id="${id}"`), `richieste: ${id}`);
  }
  // Il form raccoglie solo identità: niente dosi, porzioni o frequenze.
  for (const legacy of ['request-quantity', 'request-grams', 'request-portions', 'request-frequency']) {
    assert.doesNotMatch(html, new RegExp(`id="${legacy}"`), `nessun campo dose ${legacy}`);
  }
  assert.match(js, /resolveCatalogRequest/);
  assert.match(js, /submitCatalogRequest|listMyCatalogRequests|listCatalogRequests/);
});

test('catalogo globale: import versionato riservato al platform admin', () => {
  assert.match(html, /id="view-catalog"/);
  assert.match(html, /id="nav-catalog"/);
  assert.match(js, /importGlobalIngredientCatalog/);
  assert.match(js, /dry-run/);
  // Nessuna grammatura nel catalogo: solo identità.
  assert.doesNotMatch(js, /grammature/i);
});

test('console admin è responsive, accessibile e non indicizzabile', () => {
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /lang="it"/);
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(html, /aria-label="Chiudi editor"/);
});

test('copy premium: valore e sicurezza senza promesse cliniche', () => {
  assert.doesNotMatch(html, /guarantee|garantito|100%|cur[aà]/i);
  assert.match(html, /sicur/i);
});
