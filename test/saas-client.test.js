'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

global.PIANO_SAAS_CONFIG = { enabled: true, shoppingRewardedAds: { enabled: false, unlockHours: 24 } };
const Saas = require('../js/saas.js');

function plan() {
  return { mellerModes: { monday: { lunch: 'meller', dinner: 'meller' } }, days: {} };
}
const profile = { clientProfileId: 'client-a', assignmentId: 'asg-1', ruleSetId: 'base', ruleSetVersion: '3', ruleSetChecksum: 'a'.repeat(64) };

test('SaaS senza assegnazione forza original-only senza mutare il piano sorgente', () => {
  const source = plan();
  const result = Saas.applyPolicy(source, { state: 'unassigned' });
  assert.equal(result.mode, 'original-only');
  assert.equal(result.plan.mellerModes.monday.lunch, 'original');
  assert.equal(source.mellerModes.monday.lunch, 'meller');
});

test('assegnazione nuova richiede conferma e non ricalcola silenziosamente', () => {
  const result = Saas.applyPolicy(plan(), { state: 'assigned', profile });
  assert.equal(result.migrationRequired, true);
  assert.equal(result.plan.mellerModes.monday.dinner, 'original');
});

test('snapshot esatto conserva la modalità del piano', () => {
  const source = plan();
  source.nutritionSnapshot = Saas.snapshotFor(profile, new Date('2026-09-09T12:00:00Z'));
  assert.equal(Saas.snapshotMatches(source, profile), true);
  const result = Saas.applyPolicy(source, { state: 'assigned', profile });
  assert.equal(result.mode, 'assigned');
  assert.equal(result.plan.mellerModes.monday.lunch, 'meller');
});

test('nuovo catalogo mapping richiede conferma e non altera lo snapshot', () => {
  const withCatalog = { ...profile, mappingCatalogChecksum: 'c'.repeat(64) };
  const source = plan();
  source.nutritionSnapshot = Saas.snapshotFor(withCatalog);
  assert.equal(Saas.snapshotMatches(source, { ...withCatalog, mappingCatalogChecksum: 'd'.repeat(64) }), false);
});

test('versione 4 non modifica retroattivamente snapshot versione 3', () => {
  const source = plan();
  source.nutritionSnapshot = Saas.snapshotFor(profile);
  const v4 = { ...profile, assignmentId: 'asg-2', ruleSetVersion: '4', ruleSetChecksum: 'b'.repeat(64) };
  assert.equal(Saas.snapshotMatches(source, v4), false);
  const result = Saas.applyPolicy(source, { state: 'assigned', profile: v4 });
  assert.equal(result.migrationRequired, true);
  assert.equal(source.nutritionSnapshot.ruleSetVersion, '3');
});

test('spesa: cliente con assegnazione attiva accede sempre, senza pubblicità', () => {
  const previousConfig = globalThis.PIANO_SAAS_CONFIG;
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.PIANO_SAAS_CONFIG = { enabled: true, shoppingRewardedAds: { enabled: false, provider: null } };
  try {
    const assigned = Saas.shoppingAccess(Date.now(), { state: 'assigned' });
    assert.equal(assigned.allowed, true);
    assert.equal(assigned.reason, 'assignment');
    // Non associato: il gate rewarded resta dietro flag provider disattivato.
    const guest = Saas.shoppingAccess(Date.now(), { state: 'unassigned' });
    assert.equal(guest.allowed, false);
    assert.equal(guest.reason, 'provider-unavailable');
    // Contesto omesso: comportamento invariato (fallback legacy dei guest).
    assert.equal(Saas.shoppingAccess(Date.now()).allowed, false);
    // Con la feature SaaS disattivata l'accesso resta libero (legacy).
    globalThis.PIANO_SAAS_CONFIG = { enabled: false };
    const legacy = Saas.shoppingAccess(Date.now(), { state: 'unassigned' });
    assert.equal(legacy.allowed, true);
    assert.equal(legacy.reason, 'feature-disabled');
  } finally {
    globalThis.PIANO_SAAS_CONFIG = previousConfig;
    globalThis.localStorage = previousStorage;
  }
});

test('snapshot v2: struttura + revisione + versione catalogo', () => {
  const Domain = require('../js/domain.js');
  const extract = require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', 'catalogo-ingredienti-meller.json'), 'utf8');
  const seed = Domain.splitMellerSeed(JSON.parse(extract));
  const profile = {
    schemaVersion: 2, clientProfileId: 'client-a', assignmentId: 'asg-9',
    structureId: 'struttura-1', structureRevisionId: '3', structureChecksum: 'e'.repeat(64),
    structureName: 'Base', ingredientCatalogVersion: 4,
    structureRevision: { revisionId: '3', rules: seed.structureSeed.rules, alternativeGroups: seed.structureSeed.alternativeGroups },
    catalog: { catalogVersion: 4, ingredients: seed.ingredients, categories: seed.categories }
  };
  const source = plan();
  source.nutritionSnapshot = Saas.snapshotFor(profile, new Date('2026-09-10T12:00:00Z'));
  assert.equal(source.nutritionSnapshot.structureRevisionId, '3');
  assert.equal(source.nutritionSnapshot.ingredientCatalogVersion, 4);
  assert.equal(Saas.snapshotMatches(source, profile), true);
  assert.equal(Saas.applyPolicy(source, { state: 'assigned', profile }).mode, 'assigned');
  // Nuova revisione → conferma richiesta, snapshot intatto (non-retroattività).
  const v4 = { ...profile, structureRevisionId: '4', structureChecksum: 'f'.repeat(64) };
  assert.equal(Saas.snapshotMatches(source, v4), false);
  assert.equal(Saas.applyPolicy(source, { state: 'assigned', profile: v4 }).migrationRequired, true);
  assert.equal(source.nutritionSnapshot.structureRevisionId, '3');
  // Solo il catalogo cambia → nudge (conferma) senza toccare lo snapshot.
  const catalogBump = { ...profile, ingredientCatalogVersion: 5 };
  assert.equal(Saas.snapshotMatches(source, catalogBump), false);
  assert.equal(Saas.applyPolicy(source, { state: 'assigned', profile: catalogBump }).migrationRequired, true);
  assert.equal(source.nutritionSnapshot.ingredientCatalogVersion, 4);
  // Profili v1 e v2 non coincidono mai (contratti diversi).
  assert.equal(Saas.snapshotMatches(source, { clientProfileId: 'client-a', assignmentId: 'asg-9', ruleSetId: 'base', ruleSetVersion: '3', ruleSetChecksum: 'a'.repeat(64) }), false);
});

test('engineRulesFor: v2 converte revisione+catalogo, v1 passa le regole motore', () => {
  const Domain = require('../js/domain.js');
  globalThis.PianoDomain = Domain;
  const extract = require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', 'catalogo-ingredienti-meller.json'), 'utf8');
  const seed = Domain.splitMellerSeed(JSON.parse(extract));
  const v2 = {
    schemaVersion: 2,
    structureRevision: { revisionId: '1', rules: seed.structureSeed.rules },
    catalog: { ingredients: seed.ingredients, categories: seed.categories }
  };
  const converted = Saas.engineRulesFor(v2);
  assert.ok(converted.rules.length > 0);
  assert.equal(converted.rules.find(rule => rule.family === 'pane').slots.lunch.training, 120);
  assert.ok(converted.freeAliases.length > 0);
  // Revisione senza regole valide → null (mai attivare un profilo vuoto).
  assert.equal(Saas.engineRulesFor({ schemaVersion: 2, structureRevision: { rules: [] }, catalog: v2.catalog }), null);
  // V1 legacy: passthrough delle regole motore.
  const legacy = [{ family: 'pasta', slots: {} }];
  assert.deepEqual(Saas.engineRulesFor({ schemaVersion: 1, rules: legacy, freeAliases: ['x'] }), { rules: legacy, freeAliases: ['x'] });
  assert.equal(Saas.engineRulesFor({ schemaVersion: 1, rules: [] }), null);
  assert.equal(Saas.engineRulesFor(null), null);
});

// ---- Export/import legacy (migrazione manuale JSON degli account storici) ----

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Domain = require('../js/domain.js');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const firebaseSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'firebase.js'), 'utf8');
const dataSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');

test('export legacy: formato stabile piano-nutrizionale-recipes con schema corrente', () => {
  // Contratto del file JSON consegnato per la migrazione manuale dei dati legacy:
  // export dall'app e reimport nello stesso profilo niente script server.
  assert.match(dataSrc, /const CATALOG_SCHEMA_VERSION = 5;/);
  assert.match(appSrc, /format: "piano-nutrizionale-recipes"/);
  assert.match(appSrc, /schemaVersion: CATALOG_SCHEMA_VERSION/);
  assert.match(appSrc, /exportedAt: new Date\(\)\.toISOString\(\)/);
  assert.match(appSrc, /recipes: recipes\.map\(cleanRecipeForTransfer\)/);
  assert.match(appSrc, /payload\.plan = window\.PianoDomain \? PianoDomain\.migratePlan\(clone\(appState\.plan\)\) : clone\(appState\.plan\)/);
  // Il reimport valida ricette + piano e riscrive catalogo/piano/spesa in batch.
  assert.match(firebaseSrc, /function validateImportedDataset\(dataset\)/);
  assert.match(firebaseSrc, /function importUserDataset\(dataset\)/);
  assert.match(firebaseSrc, /schemaVersion: Number\(dataset\.schemaVersion \|\| CATALOG_SCHEMA_VERSION\)/);
  assert.match(firebaseSrc, /if \(plan\) batch\.set\(weeklyPlanRef\(\), plan\)/);
  assert.match(firebaseSrc, /const shopping = getDefaultShoppingList\(\)/);
});

test('round-trip export → import: payload valido accettato, payload manomesso rifiutato', () => {
  const sandbox = { console, TextEncoder, Date, JSON, Set, Map, Array, Object, String, Number, Boolean, Promise, RegExp, Error, Math, Intl, Symbol, PianoDomain: Domain };
  vm.createContext(sandbox);
  vm.runInContext(dataSrc, sandbox, { filename: 'js/data.js' });
  vm.runInContext(firebaseSrc, sandbox, { filename: 'js/firebase.js' });
  const { validateImportedDataset } = sandbox;
  assert.equal(typeof validateImportedDataset, 'function', 'validatore caricato nel sandbox');
  const recipe = id => ({
    id: `r-${id}`, name: `Ricetta ${id}`, slot: 'lunch',
    ingredients: [{ name: 'Pasta', portions: { ipo: '80 g', man: '90 g' } }],
    steps: ['Porta a bollore, cuoci e scola.']
  });
  const days = {};
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach(day => {
    days[day] = { type: day === 'sunday' ? 'rest' : 'training', breakfast: 'r-1', snack1: 'r-1', lunch: 'r-2', snack2: 'r-1', dinner: 'r-2' };
  });
  const payload = {
    format: 'piano-nutrizionale-recipes', schemaVersion: 5,
    exportedAt: new Date().toISOString(), exportedBy: 'gabriele',
    recipes: [recipe(1), recipe(2)],
    plan: { schemaVersion: 5, days }
  };
  assert.equal(validateImportedDataset(payload), true, 'export prodotto dall’app riimportabile');
  // File manomessi: nessun dato parziale nel profilo.
  assert.throws(() => validateImportedDataset({ format: 'piano-nutrizionale-recipes', recipes: [] }), /non contiene ricette/);
  const missingRef = JSON.parse(JSON.stringify(payload));
  missingRef.plan.days.monday.lunch = 'r-404';
  assert.throws(() => validateImportedDataset(missingRef), /non trovata/);
  const badSlot = JSON.parse(JSON.stringify(payload));
  badSlot.recipes[0].slot = 'brunch';
  assert.throws(() => validateImportedDataset(badSlot), /Tipo pasto non valido/);
  const duplicated = JSON.parse(JSON.stringify(payload));
  duplicated.recipes.push(duplicated.recipes[0]);
  assert.throws(() => validateImportedDataset(duplicated), /duplicato/);
});
