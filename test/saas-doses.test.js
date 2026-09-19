'use strict';
/* Passo 4 (client) — dosi allineate alla struttura dieta assegnata:
 *  - snapshot della conferma cliente (revisione + checksum + catalogo);
 *  - policy: senza assegnazione o negli household si resta su dosi originali;
 *  - motore dieta dal profilo v3 (dietPlan a blocchi per pasto e tipo giornata);
 *  - equivalenti proporzionali del blocco con override espliciti;
 *  - vista allineata della ricetta: dosi cambiate, aggiunti, omessi, mai
 *    mutazioni della ricetta originale. */
const test = require('node:test');
const assert = require('node:assert/strict');
const saas = require('../js/saas.js');
const Domain = require('../js/domain.js');

global.PianoDomain = Domain;
global.PIANO_SAAS_CONFIG = { enabled: true };
const store = {};
global.localStorage = {
  getItem: key => (key in store ? store[key] : null),
  setItem: (key, value) => { store[key] = String(value); },
  removeItem: key => { delete store[key]; }
};

const CATALOG = {
  catalogVersion: 7,
  categories: [{ categoryId: 'carb', displayName: 'Carboidrati', sortOrder: 0 }],
  families: [
    { familyId: 'cereali', displayName: 'Cereali', categoryId: 'carb', sortOrder: 0 },
    { familyId: 'patate', displayName: 'Patate e tuberi', categoryId: 'carb', sortOrder: 1 }
  ],
  ingredients: [
    { ingredientId: 'pasta-semola', displayName: 'Pasta di semola', aliases: ['pasta'], categoryId: 'carb', familyId: 'cereali', dietaryFlags: { vegetarian: true, vegan: true }, status: 'active' },
    { ingredientId: 'riso', displayName: 'Riso', aliases: [], categoryId: 'carb', familyId: 'cereali', dietaryFlags: { vegetarian: true, vegan: true }, status: 'active' },
    { ingredientId: 'patate', displayName: 'Patate', aliases: ['patata'], categoryId: 'carb', familyId: 'patate', dietaryFlags: { vegetarian: true, vegan: true }, status: 'active' }
  ]
};

const TEMPLATE_SNAPSHOT = {
  revisionId: 'tpl-rev-1',
  referenceAmount: { value: 80, unit: 'g' },
  equivalents: [{ familyId: 'patate', ingredientId: 'patate', amount: { value: 250, unit: 'g' } }]
};

function dietPlan() {
  return Domain.createEmptyDietPlan({ days: [
    Domain.createDietPlanDay('training', { dayId: 'giorno-allenamento', meals: [
      Domain.createDietPlanMeal('lunch', { options: [
        Domain.createDietPlanOption({
          optionId: 'pranzo-cereali', type: 'family-block',
          blocks: [Domain.createDietPlanBlock({
            blockId: 'amidi', referenceFamilyId: 'cereali', referenceIngredientId: 'riso',
            referenceAmount: { value: 80, unit: 'g' },
            templateId: 'tpl-amidi',
            templateSnapshot: JSON.parse(JSON.stringify(TEMPLATE_SNAPSHOT)),
            overrides: [{ familyId: 'patate', ingredientId: 'patate', amount: { value: 300, unit: 'g' } }]
          })]
        }),
        Domain.createDietPlanOption({ optionId: 'pranzo-ricetta', type: 'recipe', recipeId: 'ricetta-x', recipeMultiplier: 1 })
      ] })
    ] }),
    Domain.createDietPlanDay('rest', { dayId: 'giorno-riposo', meals: [
      Domain.createDietPlanMeal('lunch', { options: [
        Domain.createDietPlanOption({
          optionId: 'pranzo-riposo', type: 'family-block',
          blocks: [Domain.createDietPlanBlock({
            blockId: 'amidi-riposo', referenceFamilyId: 'cereali', referenceIngredientId: 'riso',
            referenceAmount: { value: 60, unit: 'g' },
            templateId: 'tpl-amidi',
            templateSnapshot: JSON.parse(JSON.stringify(TEMPLATE_SNAPSHOT))
          })]
        })
      ] })
    ] })
  ] });
}

function v3Profile(extra = {}) {
  return {
    schemaVersion: 3,
    clientProfileId: 'cp1',
    assignmentId: 'a1',
    structureId: 's1',
    structureRevisionId: 'rev1',
    structureChecksum: 'chk-1',
    structureName: 'Struttura base',
    ingredientCatalogVersion: 7,
    effectiveAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    structureRevision: { revisionId: 'rev1', dietPlan: dietPlan() },
    catalog: JSON.parse(JSON.stringify(CATALOG)),
    compatibleClientSchema: 7,
    ...extra
  };
}

const personalPlan = snapshot => ({ schemaVersion: Domain.VERSION, days: {}, alignedDosesEnabled: true, ...(snapshot ? { nutritionSnapshot: snapshot } : {}) });

// ---- Snapshot della conferma ----

test('snapshot: la conferma fissa revisione, checksum e versione catalogo', () => {
  const profile = v3Profile();
  const snapshot = saas.snapshotFor(profile, new Date('2026-05-01T08:00:00.000Z'));
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.structureId, 's1');
  assert.equal(snapshot.structureRevisionId, 'rev1');
  assert.equal(snapshot.structureChecksum, 'chk-1');
  assert.equal(snapshot.ingredientCatalogVersion, 7);
  assert.equal(snapshot.resolvedAt, '2026-05-01T08:00:00.000Z');
});

test('snapshot: cambio revisione o catalogo richiede nuova conferma', () => {
  const profile = v3Profile();
  const plan = personalPlan(saas.snapshotFor(profile));
  assert.equal(saas.snapshotMatches(plan, profile), true);
  // Nuova revisione della struttura → pending-confirmation
  assert.equal(saas.snapshotMatches(plan, v3Profile({ structureRevisionId: 'rev2', structureRevision: { revisionId: 'rev2', dietPlan: dietPlan() } })), false);
  // Checksum diverso (contenuto cambiato) → pending-confirmation
  assert.equal(saas.snapshotMatches(plan, v3Profile({ structureChecksum: 'chk-2' })), false);
  // Anche solo il catalogo ingredienti è cambiato → pending-confirmation
  assert.equal(saas.snapshotMatches(plan, v3Profile({ ingredientCatalogVersion: 8 })), false);
  // Nessuno snapshot → da confermare
  assert.equal(saas.snapshotMatches(personalPlan(), profile), false);
});

// ---- Policy ----

test('applyPolicy: senza assegnazione si resta su dosi originali', () => {
  const plan = personalPlan();
  const result = saas.applyPolicy(plan, { state: 'unassigned' });
  assert.equal(result.mode, 'original-only');
  assert.equal(result.plan, plan, 'piano non toccato');
});

test('applyPolicy: assegnato e confermato attiva la vista allineata', () => {
  const profile = v3Profile();
  const result = saas.applyPolicy(personalPlan(saas.snapshotFor(profile)), { state: 'assigned', profile });
  assert.equal(result.mode, 'assigned');
  assert.equal(result.migrationRequired, false);
  assert.equal(result.plan.alignedDosesEnabled, true);
});

test('applyPolicy: profilo non confermato → originali forzate e conferma richiesta', () => {
  const profile = v3Profile();
  const result = saas.applyPolicy(personalPlan(), { state: 'assigned', profile });
  assert.equal(result.mode, 'pending-confirmation');
  assert.equal(result.migrationRequired, true);
  assert.equal(result.plan.alignedDosesEnabled, false, 'interruttore spento finché non conferma');
  // Il piano di partenza non è mutato
  const original = personalPlan();
  saas.applyPolicy(original, { state: 'assigned', profile });
  assert.equal(original.alignedDosesEnabled, true);
});

test('applyPolicy: nei piani famiglia valgono sempre le dosi originali', () => {
  global.getCurrentHousehold = () => ({ id: 'h1' });
  try {
    assert.equal(saas.saasPersonalScope(), false);
    const profile = v3Profile();
    const result = saas.applyPolicy(personalPlan(saas.snapshotFor(profile)), { state: 'assigned', profile });
    assert.equal(result.mode, 'original-only', 'la dieta personale non si applica alla famiglia');
  } finally {
    delete global.getCurrentHousehold;
  }
  assert.equal(saas.saasPersonalScope(), true);
});

test('originalOnlyPlan: clona il piano senza mutarlo', () => {
  const plan = personalPlan();
  const next = saas.originalOnlyPlan(plan);
  assert.equal(next.alignedDosesEnabled, false);
  assert.equal(plan.alignedDosesEnabled, true, 'originale intatto');
  assert.notEqual(next, plan);
});

// ---- Motore dieta ----

test('buildDietEngine: opzioni per pasto e tipo giornata, niente piano → null', () => {
  const engine = Domain.buildDietEngine(v3Profile());
  assert.ok(engine);
  assert.equal(engine.structureRevisionId, 'rev1');
  assert.equal(engine.structureName, 'Struttura base');
  assert.deepEqual(engine.mealIds, ['lunch']);
  assert.deepEqual(engine.optionsFor('lunch', 'training').map(option => option.optionId), ['pranzo-cereali', 'pranzo-ricetta']);
  // Allenamento e riposo hanno ciascuno la propria pasto
  assert.equal(engine.optionsFor('lunch', 'training')[0].blocks[0].referenceAmount.value, 80);
  assert.equal(engine.optionsFor('lunch', 'rest')[0].blocks[0].referenceAmount.value, 60);
  // Pasto non previsto dalla struttura → null (mai dosi inventate)
  assert.equal(engine.optionsFor('dinner', 'training'), null);
  // Senza piano a blocchi non esiste motore
  assert.equal(Domain.buildDietEngine({ structureRevision: { revisionId: 'r', dietPlan: null }, catalog: CATALOG }), null);
  assert.equal(Domain.buildDietEngine(null), null);
});

test('dietBlockEquivalents: proporzionali, override esplicito vince senza riscala', () => {
  const block = Domain.createDietPlanBlock({
    referenceFamilyId: 'cereali', referenceIngredientId: 'riso',
    referenceAmount: { value: 80, unit: 'g' },
    templateId: 'tpl-amidi', templateSnapshot: JSON.parse(JSON.stringify(TEMPLATE_SNAPSHOT))
  });
  assert.deepEqual(Domain.dietBlockEquivalents(block), [
    { familyId: 'patate', ingredientId: 'patate', amount: { value: 250, unit: 'g' }, overridden: false }
  ]);
  // Blocco con quantità doppia: gli equivalenti del template scalano ×2,5
  const scaled = Domain.createDietPlanBlock({
    referenceFamilyId: 'cereali', referenceIngredientId: 'riso',
    referenceAmount: { value: 200, unit: 'g' },
    templateId: 'tpl-amidi', templateSnapshot: JSON.parse(JSON.stringify(TEMPLATE_SNAPSHOT))
  });
  assert.deepEqual(Domain.dietBlockEquivalents(scaled), [
    { familyId: 'patate', ingredientId: 'patate', amount: { value: 625, unit: 'g' }, overridden: false }
  ]);
  // Override della struttura: importo fisso, niente proporzionalità
  const overriddenBlock = Domain.createDietPlanBlock({
    referenceFamilyId: 'cereali', referenceIngredientId: 'riso',
    referenceAmount: { value: 200, unit: 'g' },
    templateId: 'tpl-amidi', templateSnapshot: JSON.parse(JSON.stringify(TEMPLATE_SNAPSHOT)),
    overrides: [{ familyId: 'patate', ingredientId: 'patate', amount: { value: 300, unit: 'g' } }]
  });
  const equivalents = Domain.dietBlockEquivalents(overriddenBlock);
  assert.equal(equivalents[0].amount.value, 300);
  assert.equal(equivalents[0].overridden, true);
  // Blocco senza template → nessun equivalente
  assert.deepEqual(Domain.dietBlockEquivalents(Domain.createDietPlanBlock({ referenceFamilyId: 'cereali' })), []);
});

test('alignRecipeToDiet: dosi allineate, aggiunti e omessi senza toccare la ricetta', () => {
  const engine = Domain.buildDietEngine(v3Profile());
  const recipe = {
    id: 'r1', name: 'Pasta al pomodoro', slot: 'lunch',
    ingredients: [
      { name: 'Pasta di semola', ingredientId: 'pasta-semola', portions: { single: '200g' } },
      { name: 'Patate', ingredientId: 'patate', portions: { single: '150g' } }
    ]
  };
  const aligned = Domain.alignRecipeToDiet(recipe, engine, 'lunch', 'training');
  assert.ok(aligned);
  assert.equal(aligned.optionId, 'pranzo-cereali');
  assert.equal(aligned.changed, true);
  // La pasta (stessa famiglia del blocco cereali) è allineata a 80g
  const pasta = aligned.ingredients.find(item => item.ingredientId === 'pasta-semola');
  assert.equal(pasta.amountText, '80g');
  assert.equal(pasta.original, '200g');
  assert.equal(pasta.aligned, true);
  // Le patate non sono previste dall'opzione scelta per quel pasto: segnalate
  // come omesse, mai riscritte. I loro equivalenti si vedono nel pannello
  // alternative (dietBlockEquivalents), non qui.
  assert.deepEqual(aligned.omitted.map(item => item.ingredientId), ['patate']);
  // La ricetta originale non è mai mutata
  assert.equal(recipe.ingredients[0].portions.single, '200g');
  assert.equal(recipe.ingredients[1].portions.single, '150g');
  // Ricetta senza nulla della famiglia del blocco: la dieta aggiunge il
  // riferimento (riso 80g) e segnala l'estraneo.
  const estranea = { id: 'r2', name: 'Solo patate', slot: 'lunch', ingredients: [{ name: 'Patate', ingredientId: 'patate', portions: { single: '150g' } }] };
  const vista = Domain.alignRecipeToDiet(estranea, engine, 'lunch', 'training');
  assert.equal(vista.added.length, 1);
  assert.equal(vista.added[0].ingredientId, 'riso');
  assert.equal(vista.added[0].amountText, '80g');
  // Pasto non coperto dalla struttura → nessuna vista
  assert.equal(Domain.alignRecipeToDiet(recipe, engine, 'dinner', 'training'), null);
  assert.equal(Domain.alignRecipeToDiet(recipe, null, 'lunch', 'training'), null);
});

// ---- Contesto (cache e online) ----

test('loadContext online: profilo assegnato salvato in cache e motore valido', async () => {
  delete store['pn_saas_profile_u1'];
  const profile = v3Profile();
  global.callSaasFunction = async () => ({ state: 'assigned', profile });
  try {
    const context = await saas.loadContext('u1');
    assert.equal(context.state, 'assigned');
    assert.equal(context.profile.structureRevisionId, 'rev1');
    assert.ok(store['pn_saas_profile_u1'], 'profilo salvato in cache');
    const cached = saas.cachedContext('u1');
    assert.equal(cached.state, 'assigned');
    assert.equal(cached.offline, true);
    assert.equal(cached.profile.structureId, 's1');
  } finally {
    delete global.callSaasFunction;
  }
});

test('loadContext offline: fallback sull’ultima versione verificata', async () => {
  const profile = v3Profile();
  global.callSaasFunction = async () => { throw new Error('rete assente'); };
  try {
    const context = await saas.loadContext('u1');
    assert.equal(context.state, 'assigned');
    assert.equal(context.fallback, undefined);
    assert.equal(context.offline, true, 'contesto dalla cache verificata');
    assert.equal(context.profile.structureRevisionId, 'rev1');
  } finally {
    delete global.callSaasFunction;
    delete store['pn_saas_profile_u1'];
  }
});

test('cachedContext: profilo scaduto o senza motore → null', async () => {
  store['pn_saas_profile_u2'] = JSON.stringify({ state: 'assigned', profile: v3Profile({ expiresAt: '2020-01-01T00:00:00.000Z' }) });
  assert.equal(saas.cachedContext('u2'), null, 'assegnazione scaduta');
  const noEngine = v3Profile();
  noEngine.structureRevision = { revisionId: 'rev1', dietPlan: Domain.createEmptyDietPlan({ days: [] }) };
  store['pn_saas_profile_u2'] = JSON.stringify({ state: 'assigned', profile: noEngine });
  assert.equal(saas.cachedContext('u2'), null, 'senza piano a blocchi non si attiva nulla');
  assert.equal(saas.cachedContext('sconosciuto'), null);
  delete store['pn_saas_profile_u2'];
});
