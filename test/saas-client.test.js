'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

global.PIANO_SAAS_CONFIG = { enabled: true, shoppingRewardedAds: { enabled: false, unlockHours: 24 } };
const Saas = require('../js/saas.js');

function plan() {
  return { days: {}, alignedDosesEnabled: true };
}
const profile = {
  schemaVersion: 3, clientProfileId: 'client-a', assignmentId: 'asg-1',
  structureId: 'struttura-1', structureRevisionId: '3', structureChecksum: 'a'.repeat(64),
  structureName: 'Base', ingredientCatalogVersion: 4
};

test('SaaS senza assegnazione forza original-only senza mutare il piano sorgente', () => {
  const source = plan();
  const result = Saas.applyPolicy(source, { state: 'unassigned' });
  assert.equal(result.mode, 'original-only');
  assert.equal(result.plan, source, 'piano non toccato senza assegnazione');
  assert.equal(source.alignedDosesEnabled, true);
});

test('assegnazione nuova richiede conferma e non ricalcola silenziosamente', () => {
  const result = Saas.applyPolicy(plan(), { state: 'assigned', profile });
  assert.equal(result.mode, 'pending-confirmation');
  assert.equal(result.migrationRequired, true);
  assert.equal(result.plan.alignedDosesEnabled, false, 'interruttore spento finché non conferma');
});

test('snapshot esatto conserva la modalità del piano', () => {
  const source = plan();
  source.nutritionSnapshot = Saas.snapshotFor(profile, new Date('2026-09-09T12:00:00Z'));
  assert.equal(Saas.snapshotMatches(source, profile), true);
  const result = Saas.applyPolicy(source, { state: 'assigned', profile });
  assert.equal(result.mode, 'assigned');
  assert.equal(result.plan.alignedDosesEnabled, true, 'confermato: dosi allineate attive');
});

test('nuovo catalogo ingredienti richiede conferma e non altera lo snapshot', () => {
  const withCatalog = { ...profile, ingredientCatalogVersion: 4 };
  const source = plan();
  source.nutritionSnapshot = Saas.snapshotFor(withCatalog);
  assert.equal(Saas.snapshotMatches(source, { ...withCatalog, ingredientCatalogVersion: 5 }), false);
});

test('revisione successiva non modifica retroattivamente lo snapshot', () => {
  const source = plan();
  source.nutritionSnapshot = Saas.snapshotFor(profile);
  const v4 = { ...profile, structureRevisionId: '4', structureChecksum: 'b'.repeat(64) };
  assert.equal(Saas.snapshotMatches(source, v4), false);
  const result = Saas.applyPolicy(source, { state: 'assigned', profile: v4 });
  assert.equal(result.migrationRequired, true);
  assert.equal(source.nutritionSnapshot.structureRevisionId, '3', 'snapshot originale intatto');
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
    // Non associato e provider ads NON configurato (fase iniziale pre-ads):
    // la spesa resta aperta a tutti, nessun gate "in arrivo".
    const guest = Saas.shoppingAccess(Date.now(), { state: 'unassigned' });
    assert.equal(guest.allowed, true);
    assert.equal(guest.reason, 'ads-not-configured');
    // Contesto omesso: stesso comportamento dei guest.
    assert.equal(Saas.shoppingAccess(Date.now()).allowed, true);
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

test('spesa: con provider ads configurato il guest passa dal gate 24h', () => {
  const previousConfig = globalThis.PIANO_SAAS_CONFIG;
  const previousStorage = globalThis.localStorage;
  const storage = { getItem: () => null, setItem: () => {} };
  globalThis.localStorage = storage;
  globalThis.PIANO_SAAS_CONFIG = { enabled: true, shoppingRewardedAds: { enabled: true, provider: 'example', unlockHours: 24 } };
  try {
    // Nessun reward in corso: gate attivo, sblocco disponibile.
    const gated = Saas.shoppingAccess(Date.now(), { state: 'unassigned' });
    assert.equal(gated.allowed, false);
    assert.equal(gated.reason, 'reward-available');
    // Reward in corso: accesso libero per 24h.
    storage.getItem = key => (key === 'pn_shopping_reward_until' ? String(Date.now() + 60000) : null);
    const rewarded = Saas.shoppingAccess(Date.now(), { state: 'unassigned' });
    assert.equal(rewarded.allowed, true);
    assert.equal(rewarded.reason, 'reward');
    // Con assegnazione attiva il gate non si applica mai.
    const assigned = Saas.shoppingAccess(Date.now(), { state: 'assigned' });
    assert.equal(assigned.allowed, true);
    assert.equal(assigned.reason, 'assignment');
  } finally {
    globalThis.PIANO_SAAS_CONFIG = previousConfig;
    globalThis.localStorage = previousStorage;
  }
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
  assert.match(dataSrc, /const CATALOG_SCHEMA_VERSION = 7;/);
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
    ingredients: [{ name: 'Pasta', portions: { single: '90g' } }],
    steps: ['Porta a bollore, cuoci e scola.']
  });
  const days = {};
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach(day => {
    days[day] = { type: day === 'sunday' ? 'rest' : 'training', breakfast: 'r-1', snack1: 'r-1', lunch: 'r-2', snack2: 'r-1', dinner: 'r-2' };
  });
  const payload = {
    format: 'piano-nutrizionale-recipes', schemaVersion: 7,
    exportedAt: new Date().toISOString(), exportedBy: 'gabriele',
    recipes: [recipe(1), recipe(2)],
    plan: { schemaVersion: 7, days }
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
