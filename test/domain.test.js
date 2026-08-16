'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const d = require('../js/domain.js');

const ROOT = path.join(__dirname, '..');
const PORTIONS = { ipo: '60g', training: '90g', rest: '70g' };

function ingredient(name, portions = PORTIONS, ingredientId = null) {
  const item = { name, portions };
  if (ingredientId) item.ingredientId = ingredientId;
  return item;
}

function recipe(id, name, slot, ingredients, proteinCategory = '') {
  return { id, name, slot, proteinCategory, ingredients, steps: ['Passo 1'] };
}

function planWith(days, extra = {}) {
  return { schemaVersion: 4, days, defaultDays: JSON.parse(JSON.stringify(days)), batchRules: {}, batchTemplates: [], ...extra };
}

// ---- Migrazioni schema 3 → 4 ----

test('migrazione ricetta schema 3 → 4: ingredientId e porzioni legacy', () => {
  const migrated = d.migrateRecipe(recipe('R1', 'Uova', 'lunch', [ingredient('Uova intere (sode)')], 'Uova'));
  assert.equal(migrated.ingredients[0].ingredientId, 'whole-eggs');
  assert.deepEqual(migrated.ingredients[0].portions, {
    ipoTraining: '60g', ipoRest: '60g', manTraining: '90g', manRest: '70g'
  });
});

test('migrazione idempotente', () => {
  const once = d.migrateRecipe(recipe('R1', 'Uova', 'lunch', [ingredient('Uova intere')]));
  const twice = d.migrateRecipe(once);
  assert.deepEqual(once, twice);
});

test('migrazione catalogo a schema 4 con alias incorporati', () => {
  const catalog = d.migrateCatalog({ schemaVersion: 3, recipes: [recipe('R1', 'X', 'lunch', [ingredient('Pomodorini')])] });
  assert.equal(catalog.schemaVersion, 4);
  assert.equal(catalog.recipeCount, 1);
  assert.equal(catalog.ingredientAliases['pomodorini'], 'cherry-tomatoes');
});

test('migrazione piano: batchRules testuali → batchTemplates strutturati', () => {
  const plan = planWith({}, {
    batchRules: { monday: { dinner: 'C1', nextLunch: 'P1', actions: ['[5 min] Prepara il riso'] } }
  });
  const migrated = d.migratePlan(plan);
  assert.equal(migrated.schemaVersion, 4);
  assert.equal(migrated.batchTemplates.length, 1);
  assert.equal(migrated.batchTemplates[0].anchor.recipeId, 'C1');
  assert.equal(migrated.batchTemplates[0].target.recipeId, 'P1');
  assert.equal(migrated.batchTemplates[0].tasks[0].storage.maxDays, 1);
});

// ---- Alias ingredienti ----

test('alias minimi convergono a ingredientId stabili', () => {
  assert.equal(d.ingredientIdFor('Uovo intero'), 'whole-eggs');
  assert.equal(d.ingredientIdFor('Uova intere'), 'whole-eggs');
  assert.equal(d.ingredientIdFor('Uova intere (sode)'), 'whole-eggs');
  assert.equal(d.ingredientIdFor('Uova intere (barzotte)'), 'whole-eggs');
  assert.equal(d.ingredientIdFor('Pomodorini'), 'cherry-tomatoes');
  assert.equal(d.ingredientIdFor('Salmone'), 'salmon');
  assert.equal(d.ingredientIdFor('Tonno al naturale sgocciolato'), 'tuna');
  assert.equal(d.ingredientIdFor('Yogurt greco magro o Skyr'), 'greek-yogurt');
  assert.equal(d.ingredientIdFor('Pane integrale o di segale'), 'bread');
  assert.equal(d.ingredientIdFor('Limone'), 'lemon');
  assert.equal(d.ingredientIdFor('Zucchine'), 'zucchini');
});

test('ingredienti senza ingredientId ricevono uno slug stabile', () => {
  assert.equal(d.ingredientIdFor('Pollo'), 'pollo');
  assert.equal(d.ingredientIdFor('Riso venere'), 'riso-venere');
});

test('ingredientId esistente non viene sovrascritto', () => {
  assert.equal(d.ingredientIdFor('Uova intere', 'my-eggs'), 'my-eggs');
});

// ---- Lista della spesa ----

function shoppingFixture() {
  const days = {
    monday: { type: 'training', breakfast: null, snack1: 'SN1', lunch: 'L1', snack2: null, dinner: 'D1' },
    tuesday: { type: 'rest', breakfast: null, snack1: 'SN2', lunch: 'L2', snack2: null, dinner: 'D2' },
    wednesday: { type: 'training', breakfast: null, snack1: 'SN1', lunch: 'L3', snack2: null, dinner: 'D3' },
    thursday: { type: 'rest', breakfast: null, snack1: 'SN2', lunch: 'L4', snack2: null, dinner: 'D4' },
    friday: { type: 'training', breakfast: null, snack1: 'SN1', lunch: 'L5', snack2: null, dinner: 'D5' },
    saturday: { type: 'rest', breakfast: null, snack1: 'SN2', lunch: 'L6', snack2: null, dinner: 'D6' },
    sunday: { type: 'training', breakfast: null, snack1: 'SN1', lunch: 'L7', snack2: null, dinner: 'D7' }
  };
  const recipesById = {};
  [
    recipe('L1', 'Pollo A', 'lunch', [ingredient('Petto di pollo', { ipoTraining: '150g', ipoRest: '140g', manTraining: '200g', manRest: '180g' })], 'Pollame'),
    recipe('L2', 'Pollo R', 'lunch', [ingredient('Petto di pollo', { ipoTraining: '150g', ipoRest: '140g', manTraining: '200g', manRest: '180g' })], 'Pollame'),
    recipe('L3', 'Uova A', 'lunch', [ingredient('Uova intere', { ipoTraining: '2', ipoRest: '2', manTraining: '2', manRest: '2' })], 'Uova'),
    recipe('L4', 'Uovo A', 'lunch', [ingredient('Uovo intero', { ipoTraining: '2', ipoRest: '2', manTraining: '2', manRest: '2' })], 'Uova'),
    recipe('L5', 'Riso', 'lunch', [ingredient('Riso venere', { ipoTraining: '60g', ipoRest: '50g', manTraining: '90g', manRest: '70g' })], 'Legumi'),
    recipe('L6', 'Zucchine', 'lunch', [ingredient('Zucchine', { ipoTraining: '—', ipoRest: '—', manTraining: '—', manRest: '—' })], ''),
    recipe('L7', 'Tonno', 'lunch', [ingredient('Tonno al naturale sgocciolato', { ipoTraining: '150g', ipoRest: '150g', manTraining: '150g', manRest: '150g' })], 'Altro pesce e molluschi'),
    recipe('D1', 'Salmone', 'dinner', [ingredient('Salmone', { ipoTraining: '100g', ipoRest: '100g', manTraining: '100g', manRest: '100g' })], 'Pesce omega-3'),
    recipe('D2', 'Verdure', 'dinner', [ingredient('Zucchine', { ipoTraining: '200g', ipoRest: '200g', manTraining: '200g', manRest: '200g' })], ''),
    recipe('D3', 'Riso D', 'dinner', [ingredient('Riso venere', { ipoTraining: '60g', ipoRest: '50g', manTraining: '90g', manRest: '70g' })], 'Legumi'),
    recipe('D4', 'Salmone D', 'dinner', [ingredient('Salmone', { ipoTraining: '100g', ipoRest: '100g', manTraining: '100g', manRest: '100g' })], 'Pesce omega-3'),
    recipe('D5', 'Yogurt', 'dinner', [ingredient('Yogurt greco magro o Skyr', { ipoTraining: '100g', ipoRest: '100g', manTraining: '150g', manRest: '150g' })], 'Latticini e formaggi'),
    recipe('D6', 'Riso D6', 'dinner', [ingredient('Riso venere', { ipoTraining: '60g', ipoRest: '50g', manTraining: '90g', manRest: '70g' })], 'Legumi'),
    recipe('D7', 'Pesce D7', 'dinner', [ingredient('Merluzzo', { ipoTraining: '250g', ipoRest: '250g', manTraining: '250g', manRest: '250g' })], 'Altro pesce e molluschi'),
    recipe('SN1', 'Spuntino A', 'snack1', [ingredient('Crackers', { ipoTraining: '30g', ipoRest: '—', manTraining: '30g', manRest: '—' })], ''),
    recipe('SN2', 'Spuntino R', 'snack1', [ingredient('Frutta', { ipoTraining: '250g', ipoRest: '250g', manTraining: '250g', manRest: '250g' })], '')
  ].forEach(recipe => { recipesById[recipe.id] = recipe; });
  return { days, recipesById };
}

function allMeals(days) {
  const selected = {};
  Object.keys(days).forEach(day => { selected[day] = ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner']; });
  return selected;
}

test('lista spesa aggrega per ingredientId (nomi diversi convergono)', () => {
  const { days, recipesById } = shoppingFixture();
  const list = d.aggregateShopping(planWith(days), recipesById, allMeals(days), 'man');
  const eggs = list.find(entry => entry.ingredientId === 'whole-eggs');
  assert.ok(eggs, 'uova aggregate per whole-eggs');
  assert.equal(eggs.totals.pz, 4);
  const rice = list.find(entry => entry.ingredientId === 'riso-venere');
  assert.ok(rice, 'riso venere presente');
  assert.equal(rice.totals.g, 250); // L5 90g (A) + D3 90g (A) + D6 70g (R) profilo uomo
});

test('profilo Uomo usa dosi man', () => {
  const { days, recipesById } = shoppingFixture();
  const list = d.aggregateShopping(planWith(days), recipesById, { monday: ['lunch'] }, 'man');
  assert.equal(list.find(entry => entry.ingredientId === 'petto-di-pollo').totals.g, 200);
});

test('profilo Donna IPO usa dosi ipo', () => {
  const { days, recipesById } = shoppingFixture();
  const list = d.aggregateShopping(planWith(days), recipesById, { monday: ['lunch'] }, 'ipo');
  assert.equal(list.find(entry => entry.ingredientId === 'petto-di-pollo').totals.g, 150);
});

test('profilo Coppia somma dosi uomo + donna', () => {
  const { days, recipesById } = shoppingFixture();
  const list = d.aggregateShopping(planWith(days), recipesById, { monday: ['lunch'] }, 'couple');
  const pollo = list.find(entry => entry.ingredientId === 'petto-di-pollo');
  assert.equal(pollo.totals.g, 350); // 200 uomo + 150 donna IPO
  assert.deepEqual(d.parseSimpleAmount('1 cucchiaio'), { value: 10, unit: 'g' });
  assert.deepEqual(d.parseSimpleAmount('3 cucchiai'), { value: 30, unit: 'g' });
  assert.deepEqual(d.parseSimpleAmount('1 cucchiaino'), { value: 5, unit: 'g' });
  assert.deepEqual(d.parseSimpleAmount('2 cucchiaini'), { value: 10, unit: 'g' });
});

test('dosi "—" non entrano nella lista', () => {
  const { days, recipesById } = shoppingFixture();
  const list = d.aggregateShopping(planWith(days), recipesById, { saturday: ['lunch'] }, 'man');
  const zucchini = list.find(entry => entry.ingredientId === 'zucchini');
  assert.ok(zucchini);
  assert.equal(Object.keys(zucchini.totals).length, 0);
});

test('crackers dinamici A/R: presenti nei giorni A solo via piano', () => {
  const { days, recipesById } = shoppingFixture();
  const selected = { monday: ['snack1'], tuesday: ['snack1'] };
  const list = d.aggregateShopping(planWith(days), recipesById, selected, 'man');
  const crackers = list.find(entry => entry.ingredientId === 'crackers');
  assert.ok(crackers);
  assert.equal(crackers.totals.g, 30); // solo lunedì (A)
  const fruit = list.find(entry => entry.ingredientId === 'frutta');
  assert.equal(fruit.totals.g, 250); // solo martedì (R)
});

// ---- Batch cooking ----

function batchFixture() {
  const days = {
    sunday: { type: 'rest', breakfast: null, snack1: null, lunch: null, snack2: null, dinner: 'C19' },
    monday: { type: 'training', breakfast: null, snack1: null, lunch: 'P16', snack2: null, dinner: 'C20' },
    tuesday: { type: 'rest', breakfast: null, snack1: null, lunch: 'P16', snack2: null, dinner: null },
    wednesday: { type: 'training', breakfast: null, snack1: null, lunch: null, snack2: null, dinner: null }
  };
  const templates = [{
    id: 'batch-c19-p16',
    anchor: { slot: 'dinner', recipeId: 'C19' },
    target: { slot: 'lunch', recipeId: 'P16', lookAheadDays: 3 },
    tasks: [
      { id: 'cook-rice', actionType: 'cook', label: 'Cuoci il riso', storage: { method: 'fridge', maxDays: 1, instructions: 'Da validare.' }, quantitySource: { recipeId: 'P16', ingredientId: 'venere-rice' } },
      { id: 'fresh-salad', actionType: 'prepare', label: 'Lava l\'insalata', storage: { method: 'fridge', maxDays: 0 } }
    ]
  }];
  const recipesById = {
    C19: recipe('C19', 'Pollo alla piastra', 'dinner', [ingredient('Pollo')], 'Pollame'),
    P16: recipe('P16', 'Riso venere e salmone', 'lunch', [
      { name: 'Riso venere', ingredientId: 'venere-rice', portions: { ipoTraining: '60g', ipoRest: '50g', manTraining: '90g', manRest: '70g' } },
      { name: 'Salmone', ingredientId: 'salmon', portions: { ipoTraining: '100g', ipoRest: '100g', manTraining: '100g', manRest: '100g' } }
    ], 'Pesce omega-3'),
    C20: recipe('C20', 'Zucchine', 'dinner', [ingredient('Zucchine')], '')
  };
  return { days, templates, recipesById };
}

test('batch indipendente da A/R del giorno corrente (domenica R → lunedì A)', () => {
  const { days, templates, recipesById } = batchFixture();
  const active = d.activeBatch('sunday', planWith(days, { batchTemplates: templates }), templates, recipesById, 'man');
  assert.equal(active.length, 1);
  assert.equal(active[0].targetDay, 'monday');
  assert.equal(active[0].daysUntilTarget, 1);
  const rice = active[0].tasks.find(task => task.id === 'cook-rice');
  assert.equal(rice.status, 'today'); // maxDays 1 copre 1 giorno
  assert.equal(rice.quantity, '90g'); // man + giorno target A (training)
});

test('quantità batch dipende dal tipo A/R del giorno target', () => {
  const { days, templates, recipesById } = batchFixture();
  days.monday.type = 'rest';
  const active = d.activeBatch('sunday', planWith(days, { batchTemplates: templates }), templates, recipesById, 'man');
  const rice = active[0].tasks.find(task => task.id === 'cook-rice');
  assert.equal(rice.quantity, '70g');
});

test('batch attraversa domenica → lunedì anche oltre il giorno successivo', () => {
  const { days, templates, recipesById } = batchFixture();
  days.monday.lunch = 'ALTRO';
  const active = d.activeBatch('sunday', planWith(days, { batchTemplates: templates }), templates, recipesById, 'man');
  assert.equal(active[0].targetDay, 'tuesday');
  assert.equal(active[0].daysUntilTarget, 2);
  // cook-rice: maxDays 1 < 2 → non ancora preparabile
  assert.equal(active[0].tasks.find(task => task.id === 'cook-rice').status, 'later');
  assert.equal(active[0].tasks.find(task => task.id === 'fresh-salad').status, 'fresh');
});

test('batch parziale: attivo se almeno una preparazione è valida', () => {
  const { days, templates, recipesById } = batchFixture();
  days.monday.lunch = 'ALTRO';
  const active = d.activeBatch('sunday', planWith(days, { batchTemplates: templates }), templates, recipesById, 'man');
  assert.equal(active.length, 1); // fresh-salad è valida
  assert.equal(active[0].validCount, 1);
});

test('batch non attivo se tutte le attività sono oltre la finestra', () => {
  const { days, templates, recipesById } = batchFixture();
  days.monday.lunch = 'ALTRO';
  days.tuesday.lunch = 'ALTRO2';
  const templatesOnlyCooked = [{
    id: 'batch-x',
    anchor: { slot: 'dinner', recipeId: 'C19' },
    target: { slot: 'lunch', recipeId: 'P16', lookAheadDays: 5 },
    tasks: [{ id: 'cook-rice', actionType: 'cook', label: 'Cuoci', storage: { method: 'fridge', maxDays: 1 }, quantitySource: { recipeId: 'P16', ingredientId: 'venere-rice' } }]
  }];
  const active = d.activeBatch('sunday', planWith(days, { batchTemplates: templatesOnlyCooked }), templatesOnlyCooked, recipesById, 'man');
  assert.equal(active.length, 0);
});

test('task duplicati con lo stesso ID non vengono raddoppiati', () => {
  const { days, recipesById } = batchFixture();
  const templates = [
    { id: 't1', anchor: { recipeId: 'C19' }, target: { slot: 'lunch', recipeId: 'P16', lookAheadDays: 3 }, tasks: [{ id: 'same', label: 'A', storage: { maxDays: 1 } }] },
    { id: 't2', anchor: { recipeId: 'C19' }, target: { slot: 'lunch', recipeId: 'P16', lookAheadDays: 3 }, tasks: [{ id: 'same', label: 'B', storage: { maxDays: 1 } }] }
  ];
  const active = d.activeBatch('sunday', planWith(days, { batchTemplates: templates }), templates, recipesById, 'man');
  assert.equal(active.length, 2);
  assert.equal(active[0].tasks.length, 1);
});

// ---- Copia e scambio pasti ----

test('scambio bidirezionale tra giorni dello stesso slot', () => {
  const days = { monday: { type: 'training', lunch: 'A' }, tuesday: { type: 'rest', lunch: 'B' } };
  const swapped = d.swapMeals(planWith(days), 'monday', 'lunch', 'tuesday', 'lunch');
  assert.equal(swapped.days.monday.lunch, 'B');
  assert.equal(swapped.days.tuesday.lunch, 'A');
});

test('scambio tra slot diversi viene rifiutato', () => {
  const days = { monday: { type: 'training', lunch: 'A', dinner: 'C' }, tuesday: { type: 'rest', lunch: 'B' } };
  assert.throws(() => d.swapMeals(planWith(days), 'monday', 'lunch', 'tuesday', 'dinner'), /Slot non compatibili/);
});

test('copia pasto non rimuove il sorgente', () => {
  const days = { monday: { type: 'training', lunch: 'A' }, tuesday: { type: 'rest', lunch: null } };
  const copied = d.copyMeal(planWith(days), 'monday', 'lunch', 'tuesday');
  assert.equal(copied.days.monday.lunch, 'A');
  assert.equal(copied.days.tuesday.lunch, 'A');
});

test('ripristino scelta iniziale', () => {
  const days = { monday: { type: 'training', lunch: 'B' } };
  const plan = planWith(days);
  plan.defaultDays.monday.lunch = 'A';
  assert.equal(d.restoreMeal(plan, 'monday', 'lunch').days.monday.lunch, 'A');
});

// ---- Generatore ----

function generatorCatalog() {
  const main = [
    ['L-P1', 'Pollo 1', 'lunch', 'Pollame'], ['L-P2', 'Pollo 2', 'lunch', 'Pollame'],
    ['L-O1', 'Salmone 1', 'lunch', 'Pesce omega-3'], ['L-O2', 'Salmone 2', 'lunch', 'Pesce omega-3'],
    ['L-L1', 'Ceci 1', 'lunch', 'Legumi'], ['L-L2', 'Ceci 2', 'lunch', 'Legumi'],
    ['L-B1', 'Manzo', 'lunch', 'Manzo/Vitello'],
    ['D-P3', 'Pollo 3', 'dinner', 'Pollame'], ['D-O3', 'Salmone 3', 'dinner', 'Pesce omega-3'],
    ['D-F1', 'Merluzzo 1', 'dinner', 'Altro pesce e molluschi'], ['D-F2', 'Merluzzo 2', 'dinner', 'Altro pesce e molluschi'],
    ['D-D1', 'Ricotta', 'dinner', 'Latticini e formaggi'], ['D-E1', 'Uova 1', 'dinner', 'Uova'], ['D-E2', 'Uova 2', 'dinner', 'Uova'],
    ['D-L3', 'Lenticchie', 'dinner', 'Legumi']
  ].map(([id, name, slot, category]) => recipe(id, name, slot, [ingredient('Pollo', PORTIONS)], category));
  const extras = [
    ['K1', 'Avena', 'breakfast'], ['K2', 'Yogurt', 'breakfast'], ['K3', 'Pancake', 'breakfast'], ['K4', 'Latte', 'breakfast'],
    ['S1', 'Frutta', 'snack1'], ['S2', 'Crackers', 'snack1'], ['S3', 'Frutta 2', 'snack1'],
    ['M1', 'Yogurt greco', 'snack2'], ['M2', 'Mela', 'snack2'], ['M3', 'Mandorle', 'snack2']
  ].map(([id, name, slot]) => recipe(id, name, slot, [ingredient('Alimento')]));
  return [...main, ...extras];
}

function assertConstraints(result) {
  const c = result.counts;
  assert.ok(c.omega >= 2 && c.omega <= 3, `omega 2-3, got ${c.omega}`);
  assert.ok(c.legumes >= 3, `legumi >= 3, got ${c.legumes}`);
  assert.ok(c.beef <= 1, `manzo max 1, got ${c.beef}`);
  assert.ok(c.poultry >= 1 && c.poultry <= 2, `pollame 1-2, got ${c.poultry}`);
  assert.ok(c.otherFish >= 1 && c.otherFish <= 2, `altro pesce 1-2, got ${c.otherFish}`);
  // massimo un pasto di pesce al giorno
  const fishIds = new Set(['L-O1', 'L-O2', 'D-O3', 'D-F1', 'D-F2']);
  d.DAYS.forEach(day => {
    const count = [result.plan.days[day].lunch, result.plan.days[day].dinner].filter(id => fishIds.has(id)).length;
    assert.ok(count <= 1, `giorno ${day} ha ${count} pasti di pesce`);
  });
  // tutti gli slot pranzo/cena riempiti
  d.DAYS.forEach(day => {
    assert.ok(result.plan.days[day].lunch, `pranzo ${day} assegnato`);
    assert.ok(result.plan.days[day].dinner, `cena ${day} assegnata`);
  });
}

test('generatore: vincoli rispettati con catalogo sufficiente', () => {
  const result = d.generateWeek(generatorCatalog(), { seed: 42 });
  assertConstraints(result);
  assert.equal(result.warnings.filter(w => w.startsWith('Vincoli rilassati')).length, 0);
});

test('generatore: risultato riproducibile con lo stesso seed', () => {
  const a = d.generateWeek(generatorCatalog(), { seed: 1234 });
  const b = d.generateWeek(generatorCatalog(), { seed: 1234 });
  assert.deepEqual(a.plan, b.plan);
});

test('generatore: blocchi singolo pasto e intera giornata rispettati', () => {
  const plan = d.emptyPlan();
  const result = d.generateWeek(generatorCatalog(), {
    seed: 7,
    plan,
    blocks: { monday: { lunch: 'L-P1' }, tuesday: { all: true } }
  });
  assert.equal(result.plan.days.monday.lunch, 'L-P1');
  assert.equal(result.plan.days.tuesday.lunch, plan.days.tuesday.lunch);
  assert.equal(result.plan.days.tuesday.dinner, plan.days.tuesday.dinner);
});

test('generatore: catalogo vuoto produce avviso e piano vuoto', () => {
  const result = d.generateWeek([], { seed: 1 });
  assert.ok(result.warnings.some(w => /Catalogo vuoto/.test(w)));
  assert.equal(result.plan.days.monday.lunch, null);
});

test('generatore: catalogo insufficiente produce avviso', () => {
  const tiny = [recipe('A', 'A', 'lunch', [ingredient('X')]), recipe('B', 'B', 'dinner', [ingredient('Y')])];
  const result = d.generateWeek(tiny, { seed: 2 });
  assert.ok(result.warnings.some(w => /Catalogo ridotto/.test(w)));
});

test('generatore: non modifica mai i dosaggi', () => {
  const catalog = generatorCatalog();
  const before = JSON.stringify(catalog.map(r => r.ingredients.map(i => i.portions)));
  d.generateWeek(catalog, { seed: 99 });
  assert.equal(JSON.stringify(catalog.map(r => r.ingredients.map(i => i.portions))), before);
});

// ---- Riferimenti piano mancanti ----

test('sanitizePlanForCatalog rimuove i riferimenti a ricette mancanti', () => {
  const days = { monday: { type: 'training', lunch: 'A', dinner: 'MISSING' } };
  const clean = d.sanitizePlanForCatalog(planWith(days), [recipe('A', 'A', 'lunch', [ingredient('X')])]);
  assert.equal(clean.days.monday.lunch, 'A');
  assert.equal(clean.days.monday.dinner, null);
});

test('diffPlans evidenzia le modifiche attuale → proposta', () => {
  const current = { days: { monday: { type: 'training', lunch: 'A', dinner: 'C' } } };
  const proposed = { days: { monday: { type: 'training', lunch: 'B', dinner: 'C' } } };
  const changes = d.diffPlans(current, proposed);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].slot, 'lunch');
  assert.equal(changes[0].from, 'A');
  assert.equal(changes[0].to, 'B');
});

test('planSlotsForRecipeRemoval elenca gli slot che diventerebbero vuoti', () => {
  const days = { monday: { type: 'training', lunch: 'A', dinner: 'B' }, tuesday: { type: 'rest', lunch: 'B', dinner: 'C' } };
  const slots = d.planSlotsForRecipeRemoval(planWith(days), ['A', 'B']);
  assert.equal(slots.length, 3);
});

// ---- Import Aggiungi / Sostituisci ----

test('import Aggiungi: mantiene le ricette esistenti e rinomina gli ID duplicati', () => {
  const current = [recipe('A', 'Mia', 'lunch', [ingredient('X')])];
  const incoming = [recipe('A', 'Ricevuta', 'lunch', [ingredient('Y')]), recipe('B', 'Nuova', 'lunch', [ingredient('Z')])];
  const merged = d.mergeRecipeCatalogs(current, incoming);
  assert.equal(merged.length, 3);
  assert.ok(merged.some(r => r.id === 'A' && r.name === 'Mia'));
  assert.ok(merged.some(r => r.id !== 'A' && r.name.includes('Ricevuta')));
  assert.ok(merged.some(r => r.id === 'B'));
});

test('import Sostituisci: mantiene solo le ricette importate e sanifica il piano', () => {
  const current = [recipe('A', 'Vecchia', 'lunch', [ingredient('X')])];
  const incoming = [recipe('B', 'Nuova', 'lunch', [ingredient('Y')])];
  const plan = planWith({ monday: { type: 'training', lunch: 'A', dinner: null } });
  const clean = d.sanitizePlanForCatalog(plan, incoming);
  assert.equal(clean.days.monday.lunch, null);
  assert.equal(d.importedPlanIsUsable(plan, incoming), false);
});

// ---- Conflitti condivisione ----

function shareFixture() {
  const current = [
    recipe('A', 'Mia A', 'lunch', [ingredient('Uova intere', { ipo: '2' }, 'whole-eggs')], 'Uova'),
    recipe('B', 'Mia B', 'lunch', [ingredient('Pollo', PORTIONS, 'chicken-breast')], 'Pollame')
  ];
  const incoming = [
    recipe('A', 'Ricevuta A (modificata)', 'lunch', [ingredient('Uova intere (sode)', { ipo: '3' }, 'whole-eggs')], 'Uova'),
    recipe('B', 'Mia B', 'lunch', [ingredient('Pollo', PORTIONS, 'chicken-breast')], 'Pollame'),
    recipe('C', 'Nuova C', 'dinner', [ingredient('Salmone', PORTIONS, 'salmon')], 'Pesce omega-3'),
    recipe('D', 'Mancante di ingredientId', 'dinner', [{ name: 'Zucchine', portions: { ipo: '200g' } }], '')
  ];
  return { current, incoming };
}

test('analyzeShare: nuove, identiche, conflitti e ingredienti migrati', () => {
  const { current, incoming } = shareFixture();
  const analysis = d.analyzeShare(current, incoming);
  assert.equal(analysis.newRecipes.length, 2); // C e D
  assert.equal(analysis.identical.length, 1); // B
  assert.equal(analysis.conflicts.length, 1); // A
  assert.equal(analysis.missingIngredientIds.length, 1); // Zucchine
  assert.equal(analysis.migratedIngredients, 1);
});

test('risoluzione conflitti: mantieni la mia', () => {
  const { current, incoming } = shareFixture();
  const resolved = d.resolveRecipeConflicts(current, incoming, { A: 'mine' });
  const a = resolved.find(r => r.id === 'A');
  assert.equal(a.name, 'Mia A');
});

test('risoluzione conflitti: usa quella ricevuta', () => {
  const { current, incoming } = shareFixture();
  const resolved = d.resolveRecipeConflicts(current, incoming, { A: 'theirs' });
  assert.equal(resolved.find(r => r.id === 'A').name, 'Ricevuta A (modificata)');
});

test('risoluzione conflitti: salva entrambe con nuovo ID', () => {
  const { current, incoming } = shareFixture();
  const resolved = d.resolveRecipeConflicts(current, incoming, { A: 'both' });
  const withA = resolved.filter(r => r.name.includes('Mia A') || r.name.includes('Ricevuta A'));
  assert.equal(withA.length, 2);
  assert.equal(resolved.filter(r => r.id === 'A').length, 1);
  assert.ok(resolved.some(r => r.id !== 'A' && r.name.includes('Ricevuta A')));
});

test('condivisione solo ricette: il piano attuale resta', () => {
  const { current, incoming } = shareFixture();
  const plan = planWith({ monday: { type: 'training', lunch: 'B', dinner: null } });
  const resolved = d.resolveRecipeConflicts(current, incoming, {});
  const nextPlan = d.sanitizePlanForCatalog(plan, resolved);
  assert.equal(nextPlan.days.monday.lunch, 'B');
});

test('condivisione solo settimana: i riferimenti mancanti vengono rimossi', () => {
  const current = [recipe('X', 'X', 'lunch', [ingredient('A')])];
  const receivedPlan = planWith({ monday: { type: 'training', lunch: 'X', dinner: 'MISSING' } });
  const nextPlan = d.sanitizePlanForCatalog(receivedPlan, current);
  assert.equal(nextPlan.days.monday.lunch, 'X');
  assert.equal(nextPlan.days.monday.dinner, null);
});

test('condivisione completa: piano utilizzabile solo se tutti i riferimenti esistono', () => {
  const { current, incoming } = shareFixture();
  const resolved = d.resolveRecipeConflicts(current, incoming, {});
  const days = {};
  d.DAYS.forEach(day => { days[day] = { type: 'rest', breakfast: null, snack1: null, lunch: null, snack2: null, dinner: null }; });
  days.monday = { type: 'training', breakfast: null, snack1: null, lunch: 'C', snack2: null, dinner: 'D' };
  const receivedPlan = planWith(days);
  assert.equal(d.importedPlanIsUsable(receivedPlan, resolved), true);
  const clean = d.sanitizePlanForCatalog(receivedPlan, resolved);
  assert.equal(clean.days.monday.lunch, 'C');
  assert.equal(clean.days.monday.dinner, 'D');
});

// ---- Backup ----

test('buildBackup contiene catalogo, piano, spesa e metadati operazione', () => {
  const catalog = { schemaVersion: 4, recipes: [recipe('A', 'A', 'lunch', [ingredient('X')])] };
  const plan = d.emptyPlan();
  const shopping = { selectedMeals: {}, includePantry: true, excludedItems: [], customQuantities: {} };
  const backup = d.buildBackup(catalog, plan, shopping, 'import-replace', 'Sostituzione catalogo');
  assert.equal(backup.schemaVersion, 4);
  assert.deepEqual(backup.catalog, catalog);
  assert.deepEqual(backup.plan, plan);
  assert.deepEqual(backup.shoppingList, shopping);
  assert.equal(backup.operation, 'import-replace');
  assert.ok(backup.createdAt);
});

// ---- Service worker e PWA ----

test('service worker: shell versionata con asset esistenti', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(sw, /piano-nutrizionale-shell-v4/);
  const shellMatch = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(shellMatch, 'SHELL presente');
  const assets = [...shellMatch[1].matchAll(/'(\.[^']+)'/g)].map(m => m[1]);
  assert.ok(assets.length >= 9);
  assets.forEach(asset => {
    const filePath = path.join(ROOT, asset.replace(/^\.\//, ''));
    assert.ok(fs.existsSync(filePath), `asset shell mancante: ${asset}`);
  });
});

test('service worker: non intercetta Firebase, pulisce cache, gestisce SKIP_WAITING', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(sw, /isFirebaseRequest/);
  assert.match(sw, /SKIP_WAITING/);
  assert.match(sw, /offline\.html/);
  assert.match(sw, /caches\.delete/);
  assert.match(sw, /mode === 'navigate'/);
});

test('index.html: banner aggiorna ora senza loop di refresh', () => {
  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(index, /sw-update/);
  assert.match(index, /SKIP_WAITING/);
  assert.match(index, /js\/domain\.js/);
  assert.match(index, /firebase-app-check-compat\.js/);
  // reload() compare una sola volta, dentro il click di "Aggiorna ora".
  assert.equal((index.match(/location\.reload/g) || []).length, 1);
});

test('firestore.rules: backup privato e condivisioni vincolate', () => {
  const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  assert.match(rules, /users\/\{userId\}\/backups/);
  assert.match(rules, /recipientUid == request\.auth\.uid/);
  assert.match(rules, /senderUid == request\.auth\.uid/);
  assert.match(rules, /includesPlan/);
  assert.match(rules, /households\/\{householdId\}/);
  assert.match(rules, /type == 'accountLink'/);
  assert.match(rules, /getAfter/);
});

test('nessuna ricetta hardcoded nei file applicativi', () => {
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const domain = fs.readFileSync(path.join(ROOT, 'js/domain.js'), 'utf8');
  const data = fs.readFileSync(path.join(ROOT, 'js/data.js'), 'utf8');
  assert.doesNotMatch(app + domain + data, /"C19"|"P16"|firebase-seed/);
});
