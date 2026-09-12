'use strict';
/* Passo 4 (client) — dosi e frequenze personalizzate:
 *  - allineamento chiavi frequenza client/server;
 *  - merge override sopra le dosi studio (v1 e v2);
 *  - override solo in ambito personale, mai negli household;
 *  - snapshot: cambio override richiede nuova conferma;
 *  - loadContext online usa il motore convertito. */
const test = require('node:test');
const assert = require('node:assert/strict');
const saas = require('../js/saas.js');
const Domain = require('../js/domain.js');
const serverDomain = require('../functions/src/domain.js');

global.PianoDomain = Domain;
global.PIANO_SAAS_CONFIG = { enabled: true };
const store = {};
global.localStorage = {
  getItem: key => (key in store ? store[key] : null),
  setItem: (key, value) => { store[key] = String(value); },
  removeItem: key => { delete store[key]; }
};

const V1_RULES = [
  { family: 'pasta', group: 'carb', label: 'Pasta', aliases: ['pasta'], slots: { lunch: { training: 90, rest: 70 }, dinner: { training: 40, rest: 40 } } }
];
const v1Profile = (overrides = null) => ({
  schemaVersion: 1, clientProfileId: 'c1', assignmentId: 'a1',
  ruleSetId: 'r1', ruleSetVersion: '3', ruleSetChecksum: 'x', mappingCatalogChecksum: null,
  rules: JSON.parse(JSON.stringify(V1_RULES)), freeAliases: [],
  ...(overrides ? { clientOverrides: overrides } : {})
});
const V2_REVISION = {
  revisionId: 'r1',
  rules: [{ mellerFamilyId: 'pasta', ingredientIds: ['pasta-semola'], quantityGrams: { lunch: { training: 90, rest: 70 }, dinner: { training: 40, rest: 40 } }, enabled: true }],
  alternativeGroups: []
};
const V2_CATALOG = {
  catalogVersion: 7,
  ingredients: [{ ingredientId: 'pasta-semola', displayName: 'Pasta di semola', categoryId: 'cat1', aliases: ['pasta'], searchTokens: ['pasta'], mappingKind: 'guided', status: 'active' }],
  categories: [{ categoryId: 'cat1', displayName: 'Primi' }]
};
const v2Profile = (overrides = null) => ({
  schemaVersion: 2, clientProfileId: 'c1', assignmentId: 'a1',
  structureId: 's1', structureRevisionId: 'r1', structureChecksum: 'y', ingredientCatalogVersion: 7,
  structureRevision: JSON.parse(JSON.stringify(V2_REVISION)),
  catalog: JSON.parse(JSON.stringify(V2_CATALOG)),
  ...(overrides ? { clientOverrides: overrides } : {})
});
const OVERRIDES = { revision: 2, doses: { pasta: { lunch: { training: 120 } } }, frequencies: { legumes: { min: 2 } } };

// ---- Allineamento client/server ----

test('frequenze: chiavi, etichette e default allineati tra client e server', () => {
  const client = Domain.MELLER_PROTEIN_FREQUENCIES;
  assert.deepEqual([...serverDomain.CLIENT_FREQUENCY_KEYS].sort(), client.map(item => item.key).sort());
  client.forEach(item => {
    assert.equal(serverDomain.CLIENT_FREQUENCY_LABELS[item.key].split(' (')[0], item.label.split(' (')[0], `etichetta ${item.key}`);
    assert.deepEqual(serverDomain.CLIENT_FREQUENCY_DEFAULTS[item.key], { min: item.min, max: item.max }, `default ${item.key}`);
  });
});

test('frequencyConstraintsFor: override sparsi sopra i default', () => {
  assert.equal(Domain.frequencyConstraintsFor(null).legumesMin, 3);
  const merged = Domain.frequencyConstraintsFor({ legumes: { min: 2 }, eggs: { max: 3 } });
  assert.equal(merged.legumesMin, 2);
  assert.equal(merged.legumesMax, 14, 'default preservato');
  assert.equal(merged.eggsMax, 3);
  assert.equal(merged.poultryMin, 1, 'famiglie non toccate invariate');
  assert.equal(Domain.DEFAULT_CONSTRAINTS.legumesMin, 3, 'default globali non mutati');
});

// ---- Merge dosi ----

test('applyDoseOverrides: fonde le celle senza mutare lo studio', () => {
  const engine = { rules: JSON.parse(JSON.stringify(V1_RULES)), freeAliases: [] };
  const merged = saas.applyDoseOverrides(engine, OVERRIDES);
  assert.equal(merged.rules[0].slots.lunch.training, 120);
  assert.equal(merged.rules[0].slots.lunch.rest, 70, 'cella non coperta preservata');
  assert.equal(engine.rules[0].slots.lunch.training, 90, 'input non mutato');
  assert.equal(merged.freeAliases, engine.freeAliases);
});

test('engineRulesFor v1: override applicati in ambito personale', () => {
  const merged = saas.engineRulesFor(v1Profile(OVERRIDES));
  assert.equal(merged.rules[0].slots.lunch.training, 120);
  const plain = saas.engineRulesFor(v1Profile());
  assert.equal(plain.rules[0].slots.lunch.training, 90);
});

test('engineRulesFor v2: conversione + override', () => {
  const merged = saas.engineRulesFor(v2Profile(OVERRIDES));
  assert.equal(merged.rules.length, 1);
  assert.equal(merged.rules[0].family, 'pasta');
  assert.equal(merged.rules[0].slots.lunch.training, 120);
  assert.equal(merged.rules[0].slots.dinner.rest, 40);
});

test('engineRulesFor: negli household condivisi valgono le dosi studio', () => {
  global.getCurrentHousehold = () => ({ id: 'h1' });
  try {
    assert.equal(saas.saasPersonalScope(), false);
    const merged = saas.engineRulesFor(v1Profile(OVERRIDES));
    assert.equal(merged.rules[0].slots.lunch.training, 90, 'override ignorato in household');
  } finally {
    delete global.getCurrentHousehold;
  }
  assert.equal(saas.saasPersonalScope(), true);
});

// ---- Snapshot ----

test('snapshot: cambio revisione override richiede nuova conferma', () => {
  const confirmed = saas.snapshotFor(v1Profile(OVERRIDES));
  assert.equal(confirmed.overridesRevision, 2);
  const plan = { nutritionSnapshot: confirmed };
  assert.equal(saas.snapshotMatches(plan, v1Profile(OVERRIDES)), true);
  assert.equal(saas.snapshotMatches(plan, v1Profile({ ...OVERRIDES, revision: 3 })), false, 'nuova revisione → pending-confirmation');
  assert.equal(saas.snapshotMatches(plan, v1Profile()), false, 'override rimossi → pending-confirmation');
});

test('snapshot legacy senza campo resta valido senza override', () => {
  const legacy = { clientProfileId: 'c1', assignmentId: 'a1', ruleSetId: 'r1', ruleSetVersion: '3', ruleSetChecksum: 'x' };
  assert.equal(saas.snapshotMatches({ nutritionSnapshot: legacy }, v1Profile()), true, 'niente nudge spuri');
  assert.equal(saas.snapshotMatches({ nutritionSnapshot: legacy }, v1Profile(OVERRIDES)), false, 'primi override → conferma');
  const policy = saas.applyPolicy({ nutritionSnapshot: legacy }, { state: 'assigned', profile: v1Profile(OVERRIDES) });
  assert.equal(policy.mode, 'pending-confirmation');
});

// ---- loadContext ----

test('loadContext online: attiva il motore convertito con override', async () => {
  const activated = [];
  const previous = Domain.activateMellerRuleSet;
  Domain.activateMellerRuleSet = (rules, freeAliases) => { activated.push({ rules, freeAliases }); return true; };
  try {
    const context = await saas.loadContext('u1', async () => ({ state: 'assigned', profile: v2Profile(OVERRIDES) }));
    assert.equal(context.state, 'assigned');
    assert.equal(activated.length, 1);
    assert.equal(activated[0].rules[0].slots.lunch.training, 120, 'regole v2 convertite e personalizzate');
    assert.ok(store['pn_saas_profile_u1'], 'profilo in cache per l’offline');
  } finally {
    Domain.activateMellerRuleSet = previous;
  }
});

test('loadContext online v1 invariato, offline usa la cache verificata', async () => {
  const activated = [];
  const previous = Domain.activateMellerRuleSet;
  Domain.activateMellerRuleSet = (rules, freeAliases) => { activated.push(rules); return true; };
  try {
    await saas.loadContext('u2', async () => ({ state: 'assigned', profile: v1Profile() }));
    assert.equal(activated[0][0].slots.lunch.training, 90);
    // Offline: la cache verificata vale ancora.
    const offline = await saas.loadContext('u2', async () => { throw new Error('offline'); });
    assert.equal(offline.offline, true);
    assert.equal(offline.profile.rules[0].slots.lunch.training, 90);
  } finally {
    Domain.activateMellerRuleSet = previous;
  }
});

test('override proteine e carboidrati indipendenti', () => {
  const engine = saas.applyDoseOverrides({ rules: [
    { family: 'pasta', slots: { lunch: { training: 90, rest: 70 } } },
    { family: 'pollame', slots: { lunch: { training: 150, rest: 150 } } }
  ], freeAliases: [] }, { revision: 1, doses: { pollame: { lunch: { training: 180 } } }, frequencies: {} });
  assert.equal(engine.rules[0].slots.lunch.training, 90, 'carboidrati invariati');
  assert.equal(engine.rules[1].slots.lunch.training, 180, 'proteine personalizzate');
});

// ---- Switch quantità adattate (struttura v2 assegnata) ----

test('switch ON: engineRulesFor v2 + attivazione motore adattano le porzioni del pasto', () => {
  // Motore completo: struttura v2 (90/70 pranzo) + override 120 A pranzo.
  const engine = saas.engineRulesFor(v2Profile(OVERRIDES));
  assert.equal(engine.rules[0].slots.lunch.training, 120);
  assert.equal(engine.rules[0].slots.lunch.rest, 70);
  const previousActivate = Domain.activateMellerRuleSet;
  try {
    assert.equal(Domain.activateMellerRuleSet(engine.rules, engine.freeAliases), true, 'motore installato');
    const recipe = {
      name: 'Pranzo tipo', slot: 'lunch',
      ingredients: [{ name: 'Pasta', portions: { ipo: '500 g', man: '500 g' } }]
    };
    const onTraining = Domain.resolveRecipeForPlan(recipe, 'lunch', Domain.MELLER_MODE_MELLER, 'training');
    assert.equal(onTraining.mode, 'meller');
    assert.equal(onTraining.applied, true, 'dosi personalizzate applicate');
    assert.equal(onTraining.recipe.ingredients[0].portions.ipo, '120 g', 'override allenamento');
    assert.equal(onTraining.recipe.ingredients[0].portions.man, '120 g');
    const onRest = Domain.resolveRecipeForPlan(recipe, 'lunch', Domain.MELLER_MODE_MELLER, 'rest');
    assert.equal(onRest.applied, true);
    assert.equal(onRest.recipe.ingredients[0].portions.ipo, '70 g', 'dose riposo della struttura (non coperta dall’override)');
    assert.equal(recipe.ingredients[0].portions.ipo, '500 g', 'ricetta originale mai mutata');
  } finally {
    Domain.activateMellerRuleSet = previousActivate;
  }
});

test('switch OFF: stessa struttura assegnata ma le quantità restano originali', () => {
  const engine = saas.engineRulesFor(v2Profile(OVERRIDES));
  const previousActivate = Domain.activateMellerRuleSet;
  try {
    Domain.activateMellerRuleSet(engine.rules, engine.freeAliases);
    const recipe = {
      name: 'Pranzo tipo', slot: 'lunch',
      ingredients: [{ name: 'Pasta', portions: { ipo: '500 g', man: '500 g' } }]
    };
    const off = Domain.resolveRecipeForPlan(recipe, 'lunch', Domain.MELLER_MODE_ORIGINAL, 'training');
    assert.equal(off.mode, 'original');
    assert.equal(off.applied, false, 'nessuna adattazione in modalità originale');
    assert.equal(off.recipe.ingredients[0].portions.ipo, '500 g', 'porzioni intatte');
    assert.equal(recipe.ingredients[0].portions.ipo, '500 g', 'sorgente immutata');
  } finally {
    Domain.activateMellerRuleSet = previousActivate;
  }
});

test('switch ON senza override: valgono le dosi dello studio dalla revisione v2', () => {
  const engine = saas.engineRulesFor(v2Profile());
  assert.equal(engine.rules[0].slots.lunch.training, 90, 'nessun override: dosi studio');
  const previousActivate = Domain.activateMellerRuleSet;
  try {
    Domain.activateMellerRuleSet(engine.rules, engine.freeAliases);
    const recipe = {
      name: 'Pranzo tipo', slot: 'lunch',
      ingredients: [{ name: 'Pasta', portions: { ipo: '500 g', man: '500 g' } }]
    };
    const on = Domain.resolveRecipeForPlan(recipe, 'lunch', Domain.MELLER_MODE_MELLER, 'training');
    assert.equal(on.applied, true);
    assert.equal(on.recipe.ingredients[0].portions.ipo, '90 g', 'dose studio applicata');
  } finally {
    Domain.activateMellerRuleSet = previousActivate;
  }
});
