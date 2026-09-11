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

test('snapshot v2: la revisione grammature richiede conferma (mai retroattiva)', () => {
  const v2 = {
    schemaVersion: 2, clientProfileId: 'client-a', assignmentId: 'asg-1',
    structureId: 'str-1', structureRevisionId: '3', structureChecksum: 'a'.repeat(64),
    ingredientCatalogVersion: 'cat-9', gramOverrides: { revision: 1, overrides: {} }
  };
  const source = plan();
  source.nutritionSnapshot = Saas.snapshotFor(v2);
  assert.equal(source.nutritionSnapshot.gramOverridesRevision, 1);
  assert.equal(Saas.snapshotMatches(source, v2), true);
  // Stessa struttura, nuove dosi personalizzate → serve conferma.
  const grams2 = { ...v2, gramOverrides: { revision: 2, overrides: {} } };
  assert.equal(Saas.snapshotMatches(source, grams2), false);
  const result = Saas.applyPolicy(source, { state: 'assigned', profile: grams2 });
  assert.equal(result.migrationRequired, true);
  assert.equal(source.nutritionSnapshot.gramOverridesRevision, 1, 'lo snapshot esistente non cambia');
});

test('snapshot v2 retro-compatibile: profili senza grammature come prima', () => {
  const v2 = {
    schemaVersion: 2, clientProfileId: 'client-a', assignmentId: 'asg-1',
    structureId: 'str-1', structureRevisionId: '3', structureChecksum: 'a'.repeat(64),
    ingredientCatalogVersion: 'cat-9'
  };
  const source = plan();
  source.nutritionSnapshot = Saas.snapshotFor(v2);
  assert.equal(source.nutritionSnapshot.gramOverridesRevision, null);
  assert.equal(Saas.snapshotMatches(source, v2), true);
  // Snapshot creati prima delle grammature (senza chiave) restano validi.
  delete source.nutritionSnapshot.gramOverridesRevision;
  assert.equal(Saas.snapshotMatches(source, v2), true);
});

test('engineRulesFor v2 applica le grammature confermate alla conversione', () => {
  const previous = globalThis.PianoDomain;
  const Domain = require('../js/domain.js');
  globalThis.PianoDomain = Domain;
  try {
    const profile = {
      schemaVersion: 2,
      structureRevision: { revisionId: '1', rules: [{ mellerFamilyId: 'riso', ingredientIds: ['riso'], categoryId: 'carb', quantityGrams: { lunch: { training: 90, rest: 70 }, dinner: { training: 40, rest: 40 } }, enabled: true }] },
      catalog: { ingredients: [{ ingredientId: 'riso', displayName: 'Riso', normalizedName: 'riso', categoryId: 'carb', aliases: ['riso'], searchTokens: ['riso'], mappingKind: 'guided', mellerFamilyId: 'riso', status: 'active' }], categories: [] },
      gramOverrides: { revision: 2, overrides: { riso: { quantityGrams: { lunch: { training: 100, rest: null }, dinner: null } } } }
    };
    const engine = Saas.engineRulesFor(profile);
    assert.ok(engine.rules.length > 0);
    assert.equal(engine.rules[0].slots.lunch.training, 100, 'override applicato');
    assert.equal(engine.rules[0].slots.lunch.rest, 70, 'null conserva la struttura');
  } finally {
    if (previous === undefined) delete globalThis.PianoDomain;
    else globalThis.PianoDomain = previous;
  }
});

test('loadContext online attiva i profili v2 convertiti (mai profile.rules grezzo)', async () => {
  const previousDomain = globalThis.PianoDomain;
  const previousStorage = globalThis.localStorage;
  const activated = {};
  globalThis.PianoDomain = {
    buildCatalogIndex: () => ({}),
    structureRevisionToMellerRules: () => ({ rules: [{ family: 'riso', slots: {} }], freeAliases: ['riso'] }),
    applyGramOverridesToRules: rules => rules,
    activateMellerRuleSet: (rules, freeAliases) => { activated.rules = rules; activated.freeAliases = freeAliases; return true; }
  };
  const store = {};
  globalThis.localStorage = { getItem: key => store[key] ?? null, setItem: (key, value) => { store[key] = String(value); } };
  try {
    const value = await Saas.loadContext('uid-1', async () => ({
      state: 'assigned',
      profile: { schemaVersion: 2, clientProfileId: 'c', assignmentId: 'a', structureId: 's', structureRevisionId: '1', structureChecksum: 'x', gramOverrides: null }
    }));
    assert.equal(value.state, 'assigned');
    assert.deepEqual(activated.rules, [{ family: 'riso', slots: {} }], 'attivate le regole convertite, non profile.rules (undefined in v2)');
    assert.deepEqual(activated.freeAliases, ['riso']);
  } finally {
    if (previousDomain === undefined) delete globalThis.PianoDomain;
    else globalThis.PianoDomain = previousDomain;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});
