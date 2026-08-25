'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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
  return { schemaVersion: 5, days, defaultDays: JSON.parse(JSON.stringify(days)), batchRules: {}, batchTemplates: [], ...extra };
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

test('migrazione catalogo a schema 5 con alias incorporati', () => {
  const catalog = d.migrateCatalog({ schemaVersion: 3, recipes: [recipe('R1', 'X', 'lunch', [ingredient('Pomodorini')])] });
  assert.equal(catalog.schemaVersion, 5);
  assert.equal(catalog.recipeCount, 1);
  assert.equal(catalog.ingredientAliases['pomodorini'], 'cherry-tomatoes');
});

test('migrazione piano: batchRules testuali → batchTemplates strutturati', () => {
  const plan = planWith({}, {
    batchRules: { monday: { dinner: 'C1', nextLunch: 'P1', actions: ['[5 min] Prepara il riso'] } }
  });
  const migrated = d.migratePlan(plan);
  assert.equal(migrated.schemaVersion, 5);
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

test('parseSimpleAmount usa il massimo degli intervalli e normalizza le unità', () => {
  assert.deepEqual(d.parseSimpleAmount('8-10'), { value: 10, unit: 'pz' });
  assert.deepEqual(d.parseSimpleAmount('8-10 pz'), { value: 10, unit: 'pz' });
  assert.deepEqual(d.parseSimpleAmount('1-2 cucchiai'), { value: 20, unit: 'g' });
  assert.deepEqual(d.parseSimpleAmount('8–10 pz'), { value: 10, unit: 'pz' });
  assert.deepEqual(d.parseSimpleAmount('1—2 cucchiai'), { value: 20, unit: 'g' });
});

test('lista spesa somma valori fissi e intervalli per Uomo, Donna IPO e Coppia', () => {
  const samePortions = (man, ipo) => ({
    ipoTraining: ipo, ipoRest: ipo, manTraining: man, manRest: man
  });
  const days = {
    monday: { type: 'training', lunch: 'T1' },
    tuesday: { type: 'rest', lunch: 'T2' },
    wednesday: { type: 'training', lunch: 'T3' }
  };
  const recipesById = {
    T1: recipe('T1', 'Pomodorini fissi', 'lunch', [ingredient('Pomodorini', samePortions('10', '8'))]),
    T2: recipe('T2', 'Pomodorini intervallo', 'lunch', [ingredient('Pomodorini', samePortions('8-10', '8-10 pz'))]),
    T3: recipe('T3', 'Pomodorini intervallo lungo', 'lunch', [ingredient('Pomodorini', samePortions('8—10 pz', '—'))])
  };
  const selected = { monday: ['lunch'], tuesday: ['lunch'], wednesday: ['lunch'] };
  const expected = { man: 30, ipo: 18, couple: 48 };

  Object.entries(expected).forEach(([profile, total]) => {
    const list = d.aggregateShopping(planWith(days), recipesById, selected, profile);
    const tomatoes = list.find(entry => entry.ingredientId === 'cherry-tomatoes');
    assert.equal(tomatoes.totals.pz, total, `totale profilo ${profile}`);
    assert.deepEqual(tomatoes.opaque, {}, `nessun intervallo opaco per ${profile}`);
  });
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

test('resolveShopCategoryOrder usa il default quando manca un ordine salvato', () => {
  const defaults = ['🥩 Carne', '🐟 Pesce', '🥬 Verdura'];
  assert.deepEqual(d.resolveShopCategoryOrder(null, defaults), defaults);
});

test('resolveShopCategoryOrder completa le categorie mancanti e scarta duplicati', () => {
  const defaults = ['🥩 Carne', '🐟 Pesce', '🥬 Verdura', '🍚 Carboidrati'];
  const saved = ['🥬 Verdura', '🐟 Pesce', '🥬 Verdura'];
  assert.deepEqual(
    d.resolveShopCategoryOrder(saved, defaults),
    ['🥬 Verdura', '🐟 Pesce', '🥩 Carne', '🍚 Carboidrati']
  );
});

test('resolveShopCategoryOrder mette in coda le categorie non previste dal default', () => {
  const defaults = ['🥩 Carne', '🐟 Pesce', '🥬 Verdura'];
  const saved = ['🐟 Pesce', '🥩 Carne'];
  assert.deepEqual(
    d.resolveShopCategoryOrder(saved, defaults, ['❄️ Surgelati', '🥬 Verdura', '❄️ Surgelati']),
    ['🐟 Pesce', '🥩 Carne', '🥬 Verdura', '❄️ Surgelati']
  );
});

test('resolveShopItemOrder rispetta l\'ordine salvato per gli id ancora presenti', () => {
  assert.deepEqual(
    d.resolveShopItemOrder(['whole-eggs', 'greek-yogurt'], ['greek-yogurt', 'whole-eggs', 'basilico']),
    ['whole-eggs', 'greek-yogurt', 'basilico']
  );
});

test('resolveShopItemOrder ignora gli id salvati non più presenti', () => {
  assert.deepEqual(
    d.resolveShopItemOrder(['old-id', 'whole-eggs', 'another-old-id', 'basilico'], ['basilico', 'whole-eggs', 'riso-venere']),
    ['whole-eggs', 'basilico', 'riso-venere']
  );
});

test('resolveShopItemOrder accoda gli id nuovi dopo quelli salvati', () => {
  assert.deepEqual(
    d.resolveShopItemOrder(['whole-eggs', 'basilico'], ['basilico', 'new-ingredient', 'whole-eggs']),
    ['whole-eggs', 'basilico', 'new-ingredient']
  );
});

test('resolveShopItemOrder senza ordine salvato lascia invariato l\'ordine corrente', () => {
  const current = ['greek-yogurt', 'whole-eggs', 'basilico'];
  assert.deepEqual(d.resolveShopItemOrder([], current), current);
  assert.deepEqual(d.resolveShopItemOrder(undefined, current), current);
  assert.deepEqual(d.resolveShopItemOrder(null, current), current);
  assert.deepEqual(d.resolveShopItemOrder('non-sono-un-array', current), current);
});

test('resolveShopItemOrder non duplica mai un id e non ne perde nessuno', () => {
  assert.deepEqual(
    d.resolveShopItemOrder(['whole-eggs', 'whole-eggs', 'basilico'], ['basilico', 'whole-eggs', 'whole-eggs', 'riso-venere']),
    ['whole-eggs', 'basilico', 'riso-venere']
  );
  // Idempotente: risolvere di nuovo il risultato non cambia l'ordine.
  const once = d.resolveShopItemOrder(['basilico', 'whole-eggs'], ['whole-eggs', 'riso-venere', 'basilico']);
  assert.deepEqual(d.resolveShopItemOrder(once, ['whole-eggs', 'riso-venere', 'basilico']), once);
});

// ---- Adattamento carboidrati pranzo <-> cena ----

test('carbSourceForName riconosce i carboidrati (gnocchi prima di patate)', () => {
  assert.equal(d.carbSourceForName('Gnocchi di patate').key, 'gnocchi');
  assert.equal(d.carbSourceForName('Patate').key, 'patate');
  assert.equal(d.carbSourceForName('Pasta integrale').key, 'pasta');
  assert.equal(d.carbSourceForName('Riso venere').key, 'riso');
  assert.equal(d.carbSourceForName('Pane integrale').key, 'pane');
  assert.equal(d.carbSourceForName('Polenta cotta').key, 'polenta');
  assert.equal(d.carbSourceForName('Crackers').key, 'crackers');
  assert.equal(d.carbSourceForName('Quinoa').key, 'pseudo');
  assert.equal(d.carbSourceForName('Cous cous').key, 'couscous');
  assert.equal(d.carbSourceForName('Farro').key, 'farroorzo');
  assert.equal(d.carbSourceForName('Trofie secche').key, 'trofie');
  assert.equal(d.carbSourceForName('Uova intere'), null);
  assert.equal(d.carbSourceForName('Petto di pollo'), null);
});

test('isPranzoCenaCross solo tra pranzo e cena', () => {
  assert.equal(d.isPranzoCenaCross('dinner', 'lunch'), true);
  assert.equal(d.isPranzoCenaCross('lunch', 'dinner'), true);
  assert.equal(d.isPranzoCenaCross('lunch', 'lunch'), false);
  assert.equal(d.isPranzoCenaCross('dinner', 'dinner'), false);
  assert.equal(d.isPranzoCenaCross('breakfast', 'lunch'), false);
});

test('adatta carboidrato cena -> pranzo (A: 60g -> 120g, R: 60g -> 90g)', () => {
  const pane = ingredient('Pane', { ipoTraining: '60g', ipoRest: '60g', manTraining: '60g', manRest: '60g' }, 'bread');
  const adapted = d.adaptIngredientForSlot(pane, 'dinner', 'lunch');
  assert.equal(adapted.portions.manTraining, '120g');
  assert.equal(adapted.portions.manRest, '90g');
  assert.equal(adapted.portions.ipoTraining, '120g');
  assert.equal(adapted.name, 'Pane');
  assert.equal(adapted.ingredientId, 'bread');
});

test('adatta carboidrato pranzo -> cena (pane 120g -> 60g)', () => {
  const pane = ingredient('Pane', { ipoTraining: '120g', ipoRest: '90g', manTraining: '120g', manRest: '90g' }, 'bread');
  const adapted = d.adaptIngredientForSlot(pane, 'lunch', 'dinner');
  assert.equal(adapted.portions.manTraining, '60g');
  assert.equal(adapted.portions.manRest, '60g');
});

test('pranzo -> cena: carboidrato non previsto (pasta) diventa pane 60g di default', () => {
  const pasta = ingredient('Pasta di semola', { ipoTraining: '90g', ipoRest: '70g', manTraining: '90g', manRest: '70g' });
  const adapted = d.adaptIngredientForSlot(pasta, 'lunch', 'dinner');
  assert.equal(adapted.name, 'Pane');
  assert.equal(adapted.portions.manTraining, '60g');
  assert.equal(adapted.portions.manRest, '60g');
});

test('pranzo -> cena: il carboidrato di default è configurabile (patate)', () => {
  const pasta = ingredient('Pasta', { ipoTraining: '90g', ipoRest: '70g', manTraining: '90g', manRest: '70g' });
  const adapted = d.adaptIngredientForSlot(pasta, 'lunch', 'dinner', { cenaFallbackKey: 'patate' });
  assert.equal(adapted.name, 'Patate');
  assert.equal(adapted.portions.manTraining, '230g');
});

test('pranzo -> cena: trofie e cous cous diventano il carboidrato cena di default', () => {
  // Entrambi sono carboidrati solo del pranzo (cena: null): spostati a cena si
  // convertono nel carboidrato cena scelto nelle impostazioni (pane 60g default).
  const trofie = ingredient('Trofie secche', { ipoTraining: '90g', ipoRest: '70g', manTraining: '90g', manRest: '70g' });
  const adaptedT = d.adaptIngredientForSlot(trofie, 'lunch', 'dinner', { cenaFallbackKey: 'pane' });
  assert.equal(adaptedT.name, 'Pane');
  assert.equal(adaptedT.portions.manTraining, '60g');

  const couscous = ingredient('Cous cous', { ipoTraining: '80g', ipoRest: '60g', manTraining: '80g', manRest: '60g' });
  const adaptedC = d.adaptIngredientForSlot(couscous, 'lunch', 'dinner', { cenaFallbackKey: 'pane' });
  assert.equal(adaptedC.name, 'Pane');
  assert.equal(adaptedC.portions.manTraining, '60g');
});

test('ingredienti non carboidrati non vengono adattati', () => {
  const eggs = ingredient('Uova intere', { ipoTraining: '3', ipoRest: '3', manTraining: '3', manRest: '3' }, 'whole-eggs');
  assert.equal(d.adaptIngredientForSlot(eggs, 'dinner', 'lunch'), null);
  assert.equal(d.adaptIngredientForSlot(eggs, 'lunch', 'dinner'), null);
});

test('nessun adattamento nello slot nativo o in pasti non incrociati', () => {
  const pane = ingredient('Pane', { ipoTraining: '60g', ipoRest: '60g', manTraining: '60g', manRest: '60g' }, 'bread');
  assert.equal(d.adaptIngredientForSlot(pane, 'dinner', 'dinner'), null);
  assert.equal(d.adaptIngredientForSlot(pane, 'lunch', 'lunch'), null);
  assert.equal(d.adaptIngredientForSlot(pane, 'breakfast', 'lunch'), null);
});

test('lista spesa adatta i carboidrati di una cena spostata a pranzo', () => {
  const days = { monday: { type: 'training', lunch: 'C15' } };
  const recipesById = {
    C15: recipe('C15', 'Frittata ai peperoni', 'dinner', [
      ingredient('Uova intere', { ipoTraining: '3', ipoRest: '3', manTraining: '3', manRest: '3' }, 'whole-eggs'),
      ingredient('Peperone', { ipoTraining: '1', ipoRest: '1', manTraining: '1', manRest: '1' }),
      ingredient('Pane', { ipoTraining: '60g', ipoRest: '60g', manTraining: '60g', manRest: '60g' }, 'bread')
    ], 'Uova')
  };
  const list = d.aggregateShopping(planWith(days), recipesById, { monday: ['lunch'] }, 'man', {}, { cenaFallbackKey: 'pane' });
  assert.equal(list.find(e => e.ingredientId === 'bread').totals.g, 120); // 60g -> 120g (pranzo A)
  assert.equal(list.find(e => e.ingredientId === 'whole-eggs').totals.pz, 3); // uova invariate
});

test('lista spesa converte pasta di un pranzo spostato a cena in pane 60g', () => {
  const days = { monday: { type: 'training', dinner: 'P1' } };
  const recipesById = {
    P1: recipe('P1', 'Pasta al tonno', 'lunch', [
      ingredient('Pasta', { ipoTraining: '90g', ipoRest: '70g', manTraining: '90g', manRest: '70g' }),
      ingredient('Tonno al naturale', { ipoTraining: '150g', ipoRest: '150g', manTraining: '150g', manRest: '150g' }, 'tuna')
    ], 'Altro pesce e molluschi')
  };
  const list = d.aggregateShopping(planWith(days), recipesById, { monday: ['dinner'] }, 'man', {}, { cenaFallbackKey: 'pane' });
  assert.equal(list.find(e => e.ingredientId === 'bread').totals.g, 60); // pasta -> pane 60g
  assert.equal(list.find(e => e.ingredientId === 'tuna').totals.g, 150); // proteina invariata
  assert.ok(!list.find(e => e.ingredientId === 'pasta'), 'la pasta non resta come voce separata');
});

test('lista spesa non adatta le ricette nel loro slot nativo', () => {
  const days = { monday: { type: 'training', dinner: 'D1' } };
  const recipesById = {
    D1: recipe('D1', 'Cena con pane', 'dinner', [
      ingredient('Pane', { ipoTraining: '60g', ipoRest: '60g', manTraining: '60g', manRest: '60g' }, 'bread')
    ], 'Pollame')
  };
  const list = d.aggregateShopping(planWith(days), recipesById, { monday: ['dinner'] }, 'man', {}, { cenaFallbackKey: 'pane' });
  assert.equal(list.find(e => e.ingredientId === 'bread').totals.g, 60); // dose nativa, non adattata
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

// ---- Batch cooking "doppia porzione" (ricetta comune cena + pranzo) ----

function commonBatchFixture() {
  const days = {
    monday: { type: 'training', breakfast: null, snack1: null, lunch: 'ALTRO', snack2: null, dinner: 'C1' },
    tuesday: { type: 'training', breakfast: null, snack1: null, lunch: 'C1', snack2: null, dinner: null },
    wednesday: { type: 'rest', breakfast: null, snack1: null, lunch: 'C2', snack2: null, dinner: null }
  };
  const recipesById = {
    C1: recipe('C1', 'Pollo e pane', 'dinner', [
      ingredient('Petto di pollo', { ipoTraining: '200g', ipoRest: '180g', manTraining: '200g', manRest: '180g' }),
      ingredient('Pane', { ipoTraining: '60g', ipoRest: '60g', manTraining: '60g', manRest: '60g' }, 'bread'),
      ingredient('Verdura', { ipoTraining: '—', ipoRest: '—', manTraining: '—', manRest: '—' })
    ], 'Pollame'),
    C2: recipe('C2', 'Pasta', 'lunch', [
      ingredient('Pasta', { ipoTraining: '90g', ipoRest: '70g', manTraining: '90g', manRest: '70g' })
    ], 'Legumi')
  };
  return { days, recipesById };
}

test('batch doppia porzione: stessa ricetta a cena e al pranzo successivo', () => {
  const { days, recipesById } = commonBatchFixture();
  const batch = d.commonRecipeBatch('monday', planWith(days), recipesById, 'man', { cenaFallbackKey: 'pane' });
  assert.ok(batch, 'batch generato');
  assert.equal(batch.targetDay, 'tuesday');
  assert.equal(batch.daysUntilTarget, 1);
  assert.equal(batch.commonRecipe, true);
  // Pollo: 200g cena + 200g pranzo = 400g
  const pollo = batch.tasks.find(t => /pollo/i.test(t.label));
  assert.equal(pollo.quantity, '400g');
  // Pane: 60g cena (nativa) + 120g pranzo (cross-slot, training) = 180g
  const pane = batch.tasks.find(t => t.label === 'Pane');
  assert.equal(pane.quantity, '180g');
  // Verdura "—" esclusa dal batch
  assert.ok(!batch.tasks.find(t => /verdura/i.test(t.label)));
});

test('batch doppia porzione attivo solo per il pranzo del giorno dopo', () => {
  const { recipesById } = commonBatchFixture();
  // La stessa ricetta è a cena lunedì e a pranzo mercoledì (2 giorni): oltre la
  // conservazione in frigo (1 giorno), non deve essere suggerito.
  const days = {
    monday: { type: 'training', dinner: 'C1' },
    wednesday: { type: 'training', lunch: 'C1' }
  };
  const batch = d.commonRecipeBatch('monday', planWith(days), recipesById, 'man', { cenaFallbackKey: 'pane' });
  assert.equal(batch, null);
});

test('batch doppia porzione: niente pranzo futuro con la stessa ricetta', () => {
  const { days, recipesById } = commonBatchFixture();
  days.tuesday.lunch = 'DIVERSA';
  const batch = d.commonRecipeBatch('monday', planWith(days), recipesById, 'man', { cenaFallbackKey: 'pane' });
  assert.equal(batch, null);
});

test('sumPortionStrings: numeriche sommate, opache concatenate', () => {
  assert.equal(d.sumPortionStrings('200g', '200g'), '400g');
  assert.equal(d.sumPortionStrings('60g', '120g'), '180g');
  assert.equal(d.sumPortionStrings('3', '3'), '6 pz');
  assert.equal(d.sumPortionStrings('—', '—'), '—');
  assert.equal(d.sumPortionStrings('q.b.', '10g'), 'q.b.');
  assert.equal(d.sumPortionStrings('1 mazzetto', '1 mazzetto'), '1 mazzetto + 1 mazzetto');
});

test('batch doppia porzione con ricetta di pranzo spostata a cena (cross-slot)', () => {
  // Una ricetta di PRANZO (pasta) messa anche a cena: la dose di cena adatta
  // i carboidrati (pasta non prevista a cena -> pane 60g), la dose di pranzo
  // resta nativa (pasta 90g). La somma combina i due carboidrati.
  const days = {
    monday: { type: 'training', dinner: 'C2', lunch: 'ALTRO' },
    tuesday: { type: 'training', lunch: 'C2' }
  };
  const { recipesById } = commonBatchFixture();
  const batch = d.commonRecipeBatch('monday', planWith(days), recipesById, 'man', { cenaFallbackKey: 'pane' });
  assert.ok(batch);
  // cena: pasta -> pane 60g; pranzo: pasta 90g. Diversi carboidrati -> "60g + 90g"
  const carb = batch.tasks.find(t => /pane|pasta/i.test(t.label));
  assert.ok(/60g \+ 90g|90g \+ 60g/.test(carb.quantity), `quantità inattesa: ${carb.quantity}`);
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
  ].map(([id, name, slot, category]) => {
    const ingredientsByCategory = {
      'Pollame': 'Pollo', 'Pesce omega-3': 'Salmone', 'Legumi': 'Ceci',
      'Manzo/Vitello': 'Manzo', 'Altro pesce e molluschi': 'Merluzzo',
      'Latticini e formaggi': 'Ricotta', 'Uova': 'Uova intere'
    };
    return recipe(id, name, slot, [ingredient(ingredientsByCategory[category], PORTIONS)], category);
  });
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
test('generatore: omega-3 distribuiti (non in giorni consecutivi)', () => {
  [1, 2, 3, 5, 8, 13, 21, 34, 55].forEach(seed => {
    const result = d.generateWeek(generatorCatalog(), { seed });
    const omegaDays = d.DAYS.filter(day =>
      [result.plan.days[day].lunch, result.plan.days[day].dinner]
        .some(id => {
          const r = generatorCatalog().find(x => x.id === id);
          return r && d.classifyProtein(r) === 'omega';
        })
    );
    omegaDays.forEach(day => {
      const next = d.DAYS[(d.DAYS.indexOf(day) + 1) % 7];
      assert.ok(!omegaDays.includes(next),
        `seed ${seed}: omega adiacenti ${day}-${next}`);
    });
  });
});
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

test('generatore: le frequenze reggono su molti seed diversi', () => {
  const catalog = generatorCatalog();
  [1, 2, 3, 5, 8, 13, 21, 34, 55, 89].forEach(seed => {
    const result = d.generateWeek(catalog, { seed });
    assertConstraints(result);
    assert.equal(result.warnings.filter(w => w.startsWith('Vincoli rilassati')).length, 0, `seed ${seed}: nessun vincolo rilassato`);
  });
});

test('generatore: batchPairs accoppia cena di oggi → pranzo di domani', () => {
  const result = d.generateWeek(generatorCatalog(), { seed: 11, batchPairs: 3 });
  assert.ok(result.pairs.length >= 1 && result.pairs.length <= 3, `attese 1-3 accoppiate, trovate ${result.pairs.length}`);
  result.pairs.forEach(pair => {
    const targetIndex = (d.DAYS.indexOf(pair.anchorDay) + 1) % 7;
    const targetDay = d.DAYS[targetIndex];
    assert.equal(result.plan.days[pair.anchorDay].dinner, pair.recipeId, `cena ${pair.anchorDay} = ricetta della coppia`);
    assert.equal(result.plan.days[targetDay].lunch, pair.recipeId, `pranzo ${targetDay} = ricetta della coppia`);
  });
  // La ricetta della coppia conta due pasti della sua categoria.
  const first = result.pairs[0];
  const recipe = generatorCatalog().find(r => r.id === first.recipeId);
  const cat = d.classifyProtein(recipe);
  assert.ok(!cat || result.counts[cat] >= 2, 'la coppia contribuisce per intero alle frequenze');
});

test('generatore: nessuna coppia batch quando batchPairs = 0', () => {
  const result = d.generateWeek(generatorCatalog(), { seed: 11, batchPairs: 0 });
  assert.equal(result.pairs.length, 0);
});

test('generatore: batchPairs 6 e 7 programma tutte le coppie possibili senza crash', () => {
  [6, 7].forEach(batchPairs => {
    const result = d.generateWeek(generatorCatalog(), {
      seed: 11,
      batchPairs,
      maxRepeats: 7,
      constraints: { poultryMax: 7, omegaMax: 7, otherFishMax: 7, beefMax: 7, dairyMax: 7, eggsMax: 7, legumesMax: 7 }
    });
    assert.equal(result.pairs.length, batchPairs, `${batchPairs} accoppiate programmate`);
    result.pairs.forEach(pair => {
      const targetDay = d.DAYS[(d.DAYS.indexOf(pair.anchorDay) + 1) % d.DAYS.length];
      assert.equal(result.plan.days[pair.anchorDay].dinner, pair.recipeId);
      assert.equal(result.plan.days[targetDay].lunch, pair.recipeId);
    });
  });
});

test('generatore: batchPairs 7 avvisa senza crash se i vincoli rendono impossibili le coppie', () => {
  const result = d.generateWeek(generatorCatalog(), { seed: 11, batchPairs: 7, maxRepeats: 1 });
  assert.ok(result.pairs.length < 7, 'i vincoli possono lasciare alcune coppie non pianificate');
  assert.ok(result.warnings.some(warning => /Batch cena → pranzo/.test(warning)), 'il vincolo impossibile è segnalato');
});


test('generatore: batchPairs ripiega su un catalogo di soli pranzi', () => {
  const onlyLunch = generatorCatalog().filter(r => r.slot === 'lunch');
  const result = d.generateWeek(onlyLunch, { seed: 3, batchPairs: 2, allowCrossSlot: true });
  assert.ok(result.pairs.length >= 1, 'almeno una accoppiata anche senza ricette di cena');
});

test('generatore: maxRepeats limita le ripetizioni settimanali', () => {
  [4, 17, 42, 101].forEach(seed => {
    const result = d.generateWeek(generatorCatalog(), { seed, maxRepeats: 2 });
    const tally = {};
    d.DAYS.forEach(day => ['lunch', 'dinner'].forEach(slot => {
      const value = result.plan.days[day][slot];
      if (value) tally[value] = (tally[value] || 0) + 1;
    }));
    Object.entries(tally).forEach(([id, times]) => {
      assert.ok(times <= 2, `seed ${seed}: ricetta ${id} ripetuta ${times} volte`);
    });
  });
});

test('generatore: i pasti bloccati contano nelle frequenze e nel limite pesce/giorno', () => {
  const plan = d.emptyPlan();
  plan.days.monday.lunch = 'L-O1'; // pesce omega-3 bloccato a pranzo
  const result = d.generateWeek(generatorCatalog(), {
    seed: 7,
    plan,
    blocks: { monday: { lunch: true } }
  });
  assert.equal(result.plan.days.monday.lunch, 'L-O1');
  const fishIds = new Set(['L-O1', 'L-O2', 'D-O3', 'D-F1', 'D-F2']);
  const mondayFish = [result.plan.days.monday.lunch, result.plan.days.monday.dinner].filter(id => fishIds.has(id)).length;
  assert.ok(mondayFish <= 1, `lunedì con pesce bloccato: niente secondo pesce a cena (${result.plan.days.monday.dinner})`);
  assert.ok(result.counts.omega >= 1, 'il pasto bloccato entra nei conteggi');
});

test('generatore: gli slot disabilitati restano come sono e contano nelle frequenze', () => {
  const plan = d.emptyPlan();
  d.DAYS.forEach(day => { plan.days[day].lunch = 'L-L1'; });
  const result = d.generateWeek(generatorCatalog(), {
    seed: 9,
    plan,
    slots: { lunch: false, breakfast: false, snack1: false, snack2: false }
  });
  d.DAYS.forEach(day => {
    assert.equal(result.plan.days[day].lunch, 'L-L1', `pranzo ${day} invariato`);
    assert.ok(result.plan.days[day].dinner, `cena ${day} generata`);
  });
  assert.ok(result.counts.legumes >= 7, 'i sette pranzi mantenuti conteggiano almeno 7 legumi');
});

test('generatore: cross-slot riempie il pranzo col catalogo di sole cene', () => {
  const onlyDinner = generatorCatalog().filter(r => r.slot === 'dinner');
  const without = d.generateWeek(onlyDinner, { seed: 5 });
  assert.equal(without.plan.days.monday.lunch, null, 'senza cross-slot il pranzo resta vuoto');
  const withCross = d.generateWeek(onlyDinner, { seed: 5, allowCrossSlot: true });
  assert.ok(withCross.plan.days.monday.lunch, 'con cross-slot il pranzo viene riempito');
  assert.ok(d.DAYS.every(day => withCross.plan.days[day].lunch && withCross.plan.days[day].dinner), 'tutti i pasti principali riempiti');
});

test('generatore: inferenza della categoria dagli ingredienti senza proteinCategory', () => {
  assert.equal(d.classifyProtein({ id: 'X', slot: 'dinner', proteinCategory: '', ingredients: [{ name: 'Petto di pollo', portions: {} }] }), 'poultry');
  assert.equal(d.classifyProtein({ id: 'Y', slot: 'dinner', proteinCategory: '', ingredients: [{ name: 'Salmone', portions: {} }] }), 'omega');
  assert.equal(d.classifyProtein({ id: 'Z', slot: 'dinner', proteinCategory: '', ingredients: [{ name: 'Lenticchie', portions: {} }, { name: 'Zucchine', portions: {} }] }), 'legumes');
  // Gli ingredienti effettivi hanno priorità sulla categoria salvata.
  assert.equal(d.classifyProtein({ id: 'W', slot: 'dinner', proteinCategory: 'Pesce omega-3', ingredients: [{ name: 'Petto di pollo', portions: {} }] }), 'poultry');
  // La categoria salvata resta compatibile per una ricetta legacy senza ingredienti riconoscibili.
  assert.equal(d.classifyProtein({ id: 'V', slot: 'dinner', proteinCategory: 'Pesce omega-3', ingredients: [{ name: 'Zucchine', portions: {} }] }), 'omega');
});

test('generatore: vincoli personalizzati vengono inseguiti (legumi 4-5)', () => {
  const result = d.generateWeek(generatorCatalog(), {
    seed: 6,
    constraints: { legumesMin: 4, legumesMax: 5 }
  });
  assert.ok(result.counts.legumes >= 4, `legumi almeno 4, trovati ${result.counts.legumes}`);
  assert.ok(result.counts.legumes <= 5, `legumi al massimo 5, trovati ${result.counts.legumes}`);
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

test('classifica manzo-maiale e affettati-carnI miste in categorie distinte', () => {
  assert.equal(
    d.classifyProtein({ ingredients: [{ name: 'Lonza di maiale' }] }),
    'beef'
  );

  assert.equal(
    d.classifyProtein({ ingredients: [{ name: 'Bresaola' }] }),
    'curedMeats'
  );

  assert.equal(
    d.classifyProtein({ ingredients: [{ name: 'Macinato misto' }] }),
    'curedMeats'
  );
});

test('vincoli nutrizionali di default aggiornati', () => {
  assert.equal(d.DEFAULT_CONSTRAINTS.legumesMin, 3);
  assert.equal(d.DEFAULT_CONSTRAINTS.legumesMax, 14);

  assert.equal(d.DEFAULT_CONSTRAINTS.beefMin, 0);
  assert.equal(d.DEFAULT_CONSTRAINTS.beefMax, 1);

  assert.equal(d.DEFAULT_CONSTRAINTS.curedMeatsMin, 0);
  assert.equal(d.DEFAULT_CONSTRAINTS.curedMeatsMax, 1);

  assert.equal(d.DEFAULT_CONSTRAINTS.dairyMin, 1);
  assert.equal(d.DEFAULT_CONSTRAINTS.dairyMax, 2);

  assert.equal(d.DEFAULT_CONSTRAINTS.eggsMin, 1);
  assert.equal(d.DEFAULT_CONSTRAINTS.eggsMax, 2);
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
  const catalog = { schemaVersion: 5, recipes: [recipe('A', 'A', 'lunch', [ingredient('X')])] };
  const plan = d.emptyPlan();
  const shopping = { selectedMeals: {}, includePantry: true, excludedItems: [], customQuantities: {} };
  const backup = d.buildBackup(catalog, plan, shopping, 'import-replace', 'Sostituzione catalogo');
  assert.equal(backup.schemaVersion, 5);
  assert.deepEqual(backup.catalog, catalog);
  assert.deepEqual(backup.plan, plan);
  assert.deepEqual(backup.shoppingList, shopping);
  assert.equal(backup.operation, 'import-replace');
  assert.ok(backup.createdAt);
});

// ---- Schema 5: rimozione legacy `frequency` ----

test('migrazione ricetta schema 4 → 5: rimuove il campo frequency', () => {
  const raw = { id: 'R1', name: 'X', slot: 'lunch', frequency: '2x settimana', proteinCategory: 'Pollame', ingredients: [{ name: 'Pollo', portions: PORTIONS }], steps: [] };
  const migrated = d.migrateRecipe(raw);
  assert.equal(Object.prototype.hasOwnProperty.call(migrated, 'frequency'), false, 'frequency rimosso');
  assert.equal(migrated.name, 'X');
  assert.equal(migrated.proteinCategory, 'Pollame', 'gli altri campi restano');
});

test('migrazione ricetta non muta l\'oggetto originale', () => {
  const raw = { id: 'R1', name: 'X', slot: 'lunch', frequency: '1x', ingredients: [{ name: 'Pollo', portions: PORTIONS }], steps: [] };
  const copy = JSON.parse(JSON.stringify(raw));
  d.migrateRecipe(raw);
  assert.deepEqual(raw, copy, 'l\'input non viene modificato');
});

test('migrazione ricetta idempotente anche dopo rimozione frequency', () => {
  const once = d.migrateRecipe({ id: 'R1', name: 'X', slot: 'lunch', frequency: '3x', ingredients: [{ name: 'Ceci', portions: PORTIONS }], steps: [] });
  const twice = d.migrateRecipe(once);
  assert.deepEqual(once, twice);
  assert.equal(Object.prototype.hasOwnProperty.call(twice, 'frequency'), false);
});

test('migrazione catalogo a schema 5 rimuove frequency da tutte le ricette', () => {
  const catalog = d.migrateCatalog({
    schemaVersion: 4,
    recipes: [
      { id: 'A', name: 'A', slot: 'lunch', frequency: '2x', ingredients: [{ name: 'Pollo', portions: PORTIONS }], steps: [] },
      { id: 'B', name: 'B', slot: 'dinner', frequency: '1x', ingredients: [{ name: 'Salmone', portions: PORTIONS }], steps: [] }
    ]
  });
  assert.equal(catalog.schemaVersion, 5);
  catalog.recipes.forEach(recipe => {
    assert.equal(Object.prototype.hasOwnProperty.call(recipe, 'frequency'), false);
  });
});

test('catalogHasLegacyFrequency rileva ricette con frequency', () => {
  assert.equal(d.catalogHasLegacyFrequency([{ id: 'A', frequency: '1x' }]), true);
  assert.equal(d.catalogHasLegacyFrequency([{ id: 'A' }]), false);
  assert.equal(d.catalogHasLegacyFrequency([]), false);
});

// ---- Classificazione: ingredienti prevalgono su proteinCategory ----

test('classifyProtein: ingrediente riconoscibile prevale su proteinCategory discordante', () => {
  const recipe = { ingredients: [{ name: 'Petto di pollo' }], proteinCategory: 'curedMeats' };
  assert.equal(d.classifyProtein(recipe), 'poultry');
});

test('classifyProtein: fallback su proteinCategory tecnica (curedMeats) senza ingredienti riconoscibili', () => {
  const recipe = { ingredients: [{ name: 'Zucchine' }], proteinCategory: 'curedMeats' };
  assert.equal(d.classifyProtein(recipe), 'curedMeats');
});

test('classifyProtein: fallback su proteinCategory legacy testuale', () => {
  assert.equal(d.classifyProtein({ ingredients: [{ name: 'Zucchine' }], proteinCategory: 'Affettati' }), 'curedMeats');
  assert.equal(d.classifyProtein({ ingredients: [{ name: 'Zucchine' }], proteinCategory: 'Manzo/Vitello' }), 'beef');
  assert.equal(d.classifyProtein({ ingredients: [{ name: 'Zucchine' }], proteinCategory: 'Pesce omega-3' }), 'omega');
});

test('classifyProtein: chiave tecnica diretta riconosciuta senza regex', () => {
  assert.equal(d.classifyProtein({ ingredients: [{ name: 'Zucchine' }], proteinCategory: 'poultry' }), 'poultry');
  assert.equal(d.classifyProtein({ ingredients: [{ name: 'Zucchine' }], proteinCategory: 'beef' }), 'beef');
  assert.equal(d.classifyProtein({ ingredients: [{ name: 'Zucchine' }], proteinCategory: 'omega' }), 'omega');
  assert.equal(d.classifyProtein({ ingredients: [{ name: 'Zucchine' }], proteinCategory: 'dairy' }), 'dairy');
});

test('classifyProtein: ricetta senza ingredienti né categoria → null', () => {
  assert.equal(d.classifyProtein({ ingredients: [{ name: 'Zucchine' }] }), null);
  assert.equal(d.classifyProtein({ ingredients: [] }), null);
});

// ---- Generatore: beef e curedMeats separati ----

test('generatore: beef e curedMeats sono conteggiati separatamente', () => {
  const catalog = [
    recipe('B1', 'Lonza', 'lunch', [ingredient('Lonza di maiale', PORTIONS)], ''),
    recipe('CM1', 'Bresaola', 'lunch', [ingredient('Bresaola', PORTIONS)], ''),
    recipe('CM2', 'Prosciutto', 'dinner', [ingredient('Prosciutto crudo', PORTIONS)], ''),
    recipe('P1', 'Pollo', 'lunch', [ingredient('Petto di pollo', PORTIONS)], ''),
    recipe('P2', 'Pollo 2', 'dinner', [ingredient('Petto di pollo', PORTIONS)], ''),
    recipe('O1', 'Salmone', 'lunch', [ingredient('Salmone', PORTIONS)], ''),
    recipe('O2', 'Salmone 2', 'dinner', [ingredient('Salmone', PORTIONS)], ''),
    recipe('O3', 'Sgombro', 'lunch', [ingredient('Sgombro', PORTIONS)], ''),
    recipe('F1', 'Merluzzo', 'dinner', [ingredient('Merluzzo', PORTIONS)], ''),
    recipe('F2', 'Merluzzo 2', 'lunch', [ingredient('Merluzzo', PORTIONS)], ''),
    recipe('L1', 'Ceci', 'lunch', [ingredient('Ceci', PORTIONS)], ''),
    recipe('L2', 'Lenticchie', 'dinner', [ingredient('Lenticchie', PORTIONS)], ''),
    recipe('L3', 'Fagioli', 'lunch', [ingredient('Fagioli', PORTIONS)], ''),
    recipe('L4', 'Ceci 2', 'dinner', [ingredient('Ceci', PORTIONS)], ''),
    recipe('D1', 'Ricotta', 'dinner', [ingredient('Ricotta', PORTIONS)], ''),
    recipe('E1', 'Uova', 'dinner', [ingredient('Uova intere', PORTIONS)], ''),
    ...Array.from({ length: 10 }, (_, i) => recipe(`X${i}`, `Extra ${i}`, i % 2 === 0 ? 'lunch' : 'dinner', [ingredient('Alimento', PORTIONS)]))
  ];
  const result = d.generateWeek(catalog, { seed: 42 });
  assert.ok(result.counts.beef !== undefined, 'beef conteggiato');
  assert.ok(result.counts.curedMeats !== undefined, 'curedMeats conteggiato');
  assert.ok(result.counts.beef <= 1, `beef max 1, got ${result.counts.beef}`);
  assert.ok(result.counts.curedMeats <= 1, `curedMeats max 1, got ${result.counts.curedMeats}`);
});

test('generatore: legumesMax 14 accettato senza crash', () => {
  const result = d.generateWeek(generatorCatalog(), { seed: 7, constraints: { legumesMax: 14 } });
  assert.ok(result.plan.days.monday.lunch, 'piano generato correttamente');
});

test('generatore: warning centralizzati includono curedMeats quando fuori intervallo', () => {
  // Con un catalogo di soli affettati (curedMeats), il generatore non può
  // rispettare il vincolo max 1 e produce un warning leggibile.
  const onlyCured = Array.from({ length: 14 }, (_, i) =>
    recipe(`CM${i}`, `Affettato ${i}`, i % 2 === 0 ? 'lunch' : 'dinner', [ingredient('Bresaola', PORTIONS)], '')
  );
  const result = d.generateWeek(onlyCured, { seed: 1 });
  const hasCuredMeatsWarning = result.warnings.some(w => /Affettati e carni miste/.test(w));
  assert.ok(hasCuredMeatsWarning, 'warning centralizzato per Affettati presente');
});

test('generatore: nessuna crash con preferenze migrate (version 2)', () => {
  const prefs = {
    version: 2,
    batchPairs: 2,
    maxRepeats: 2,
    constraints: {
      legumesMin: 3, legumesMax: 14, omegaMin: 2, omegaMax: 3,
      poultryMin: 1, poultryMax: 2, beefMin: 0, beefMax: 1,
      curedMeatsMin: 0, curedMeatsMax: 1, dairyMin: 1, dairyMax: 2,
      eggsMin: 1, eggsMax: 2, otherFishMin: 1, otherFishMax: 2
    }
  };
  const result = d.generateWeek(generatorCatalog(), { seed: 5, constraints: prefs.constraints });
  assert.ok(result.plan.days.monday.lunch, 'piano generato con prefs migrate');
});

// ---- Service worker e PWA ----

test('service worker: shell versionata derivata da una sola versione con asset esistenti', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const versionMatch = sw.match(/const CACHE_VERSION = (\d+);/);
  assert.ok(versionMatch, 'CACHE_VERSION presente');
  // La policy di sw.js chiede di incrementare la versione a ogni modifica:
  // il test verifica solo che sia un intero positivo, senza pinnarla.
  assert.ok(Number.isInteger(Number(versionMatch[1])) && Number(versionMatch[1]) > 0, 'CACHE_VERSION è un intero positivo');
  assert.equal((sw.match(/const CACHE_VERSION/g) || []).length, 1);
  assert.match(sw, /const CACHE = `piano-nutrizionale-shell-v\$\{CACHE_VERSION\}`;/);
  assert.match(sw, /incrementare CACHE_VERSION a OGNI modifica di CSS, JS o index\.html/);
  const shellMatch = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(shellMatch, 'SHELL presente');
  const assets = [...shellMatch[1].matchAll(/'(\.[^']+)'/g)].map(m => m[1]);
  assert.ok(assets.length >= 10);
  assert.ok(assets.includes('./js/prices.js'), 'la shell include il dominio prezzi');
  assets.forEach(asset => {
    const filePath = path.join(ROOT, asset.replace(/^\.\//, ''));
    assert.ok(fs.existsSync(filePath), `asset shell mancante: ${asset}`);
  });
  // Il lettore barcode esterno è versionato e precaricato come l'SDK Firebase.
  assert.match(sw, /html5-qrcode@2\.3\.8\/html5-qrcode\.min\.js/);
  assert.match(sw, /isCachedCdnAsset/);
});

test('service worker: non intercetta Firebase, pulisce cache, gestisce SKIP_WAITING', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(sw, /isFirebaseRequest/);
  assert.match(sw, /if \(event\.data === 'SKIP_WAITING'\) self\.skipWaiting\(\)/);
  assert.match(sw, /offline\.html/);
  assert.match(sw, /caches\.delete/);
  assert.match(sw, /mode === 'navigate'/);
  const installHandler = sw.match(/self\.addEventListener\('install',[\s\S]*?\n\}\);/);
  assert.ok(installHandler, 'gestore install presente');
  assert.doesNotMatch(installHandler[0], /self\.skipWaiting/, 'il worker deve attendere il click sul banner');
});

test('service worker: SDK Firebase in cache, endpoint runtime mai intercettati', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const context = {
    self: {
      location: { origin: 'https://example.github.io' },
      listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      clients: { claim: () => {} },
      skipWaiting: () => {}
    },
    caches: {
      open: async () => ({ addAll: async () => {}, put: async () => {} }),
      match: async () => undefined,
      keys: async () => []
    },
    fetch: async () => ({ ok: true, clone: () => ({}) }),
    URL,
    Promise,
    console
  };
  vm.createContext(context);
  vm.runInContext(sw, context, { filename: 'sw.js' });

  const fetchHandler = context.self.listeners.fetch;
  assert.equal(typeof fetchHandler, 'function', 'gestore fetch registrato');

  const dispatch = url => {
    const event = {
      request: { url, mode: 'cors' },
      intercepted: false,
      respondWith() { this.intercepted = true; }
    };
    fetchHandler(event);
    return event.intercepted;
  };

  // I quattro file statici dell'SDK vengono gestiti dalla cache del worker.
  [
    'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
    'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js',
    'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-check-compat.js'
  ].forEach(url => {
    assert.equal(dispatch(url), true, `SDK non gestito dalla cache: ${url}`);
  });

  // Le chiamate runtime a Firestore, Auth, App Check e installations NON
  // devono mai essere intercettate: romperebbero login e sincronizzazione.
  [
    'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel',
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword',
    'https://firebaseinstallations.googleapis.com/v1/projects/x/installations',
    'https://firebaseappcheck.googleapis.com/v1/projects/x/apps/y:exchangeRecaptchaV3Token',
    'https://piano-nutrizionale.firebaseio.com/.ws',
    'https://www.google.com/recaptcha/api.js'
  ].forEach(url => {
    assert.equal(dispatch(url), false, `endpoint runtime intercettato: ${url}`);
  });

  // Anche gli altri asset cross-origin di gstatic (non /firebasejs/) restano fuori.
  assert.equal(dispatch('https://fonts.gstatic.com/s/font.woff2'), false);

  // Gli asset della shell dello stesso origin restano gestiti dal worker.
  assert.equal(dispatch('https://example.github.io/pianoNutrizionale/js/app.js'), true);

  // L'install precarica l'SDK con un catch mirato: la CDN irraggiungibile non
  // deve far fallire l'installazione della shell.
  assert.match(sw, /FIREBASE_SDK[\s\S]*catch/, 'precache SDK con catch mirato');
  assert.match(sw, /response\.ok/, 'nessuna risposta opaca o di errore in cache');
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
