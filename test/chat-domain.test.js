'use strict';
/* Test unitari del dominio puro della chat AI: interpretazione del testo,
 * risoluzione giorno/pasto, parser delle quantità, rilevamento delle richieste
 * di nuove ricette dal web e lettura dei pasti. Nessuna rete, nessun DOM. */
const test = require('node:test');
const assert = require('node:assert/strict');
const piano = require('../js/domain.js');
const chat = require('../js/chat-domain.js');

const portion = (manTraining, manRest = manTraining, ipoTraining = manTraining, ipoRest = manRest) => ({
  manTraining, manRest, ipoTraining, ipoRest
});

const recipes = [
  {
    id: 'S1', name: 'Frutta e yogurt', slot: 'snack1',
    ingredients: [
      { name: 'Mela', ingredientId: 'mela', portions: portion('250g', '250g', '200g', '200g') },
      { name: 'Kiwi', ingredientId: 'kiwi', portions: portion('50g', '50g', '40g', '40g') },
      { name: 'Yogurt greco', ingredientId: 'greek-yogurt', portions: portion('150g') }
    ],
    steps: ['Lava la frutta.', 'Tagliala e aggiungi lo yogurt.']
  },
  {
    id: 'D1', name: 'Cena di pollo', slot: 'dinner',
    ingredients: [
      { name: 'Petto di pollo', ingredientId: 'pollo', portions: portion('200g') },
      { name: 'Zucchine', ingredientId: 'zucchine', portions: portion('200g') }
    ],
    steps: ['Taglia le zucchine.', 'Cuoci il pollo in padella.']
  }
];

const days = {};
chat.DAYS.forEach(day => {
  days[day] = { type: 'training', breakfast: null, snack1: 'S1', lunch: null, snack2: null, dinner: 'D1' };
});
const state = { recipes, recipesById: Object.fromEntries(recipes.map(recipe => [recipe.id, recipe])), plan: { days } };

// ---- Risoluzione giorno / pasto ----
test('risolve giorni e pasti italiani', () => {
  assert.equal(chat.resolveDay('domani', 'sunday'), 'monday');
  assert.equal(chat.resolveDay('lunedì prossimo', 'wednesday'), 'monday');
  assert.equal(chat.resolveDay('il prossimo sabato', 'wednesday'), 'saturday');
  assert.equal(chat.resolveDay('fine settimana', 'monday'), 'saturday');
  assert.equal(chat.resolveDay('weekend', 'monday'), 'saturday');
  assert.equal(chat.resolveSlot('mezzogiorno'), 'lunch');
  assert.equal(chat.resolveSlot('pomeriggio'), 'snack2');
  assert.equal(chat.resolveSlot('sera'), 'dinner');
  assert.equal(chat.resolveSlot('spuntino 2'), 'snack2');
});

// ---- Parser quantità ----
test('interpreta le quantità italiane', () => {
  assert.deepEqual(chat.parseFoodAmount('un etto'), { value: 100, unit: 'g' });
  assert.deepEqual(chat.parseFoodAmount('due etti'), { value: 200, unit: 'g' });
  assert.deepEqual(chat.parseFoodAmount('mezzo chilo'), { value: 500, unit: 'g' });
  assert.deepEqual(chat.parseFoodAmount('un cucchiaio'), { value: 10, unit: 'g' });
  assert.deepEqual(chat.parseFoodAmount('un cucchiaino'), { value: 5, unit: 'g' });
  assert.deepEqual(chat.parseFoodAmount('150 g'), { value: 150, unit: 'g' });
  assert.equal(chat.parseFoodAmount('q.b.').free, true);
});

// ---- Rilevamento richieste di nuove ricette dal web ----
test('riconosce le richieste di nuove ricette dal web', () => {
  for (const text of [
    'trovami una ricetta',
    'inventa una ricetta con pollo',
    'ricetta nuova',
    'proponimi una ricetta per cena',
    'cerca una ricetta per il pranzo',
    'voglio una ricetta diversa',
    'cercami una ricetta sul web',
    'ricetta con pollo e riso',
    'ricette con orata',
    'ricette vegetariane',
    'ricetta di orata',
    'vorrei una ricetta leggera'
  ]) {
    assert.equal(chat.analyzeRecipeRequest(text), true, `attesa ricerca web: "${text}"`);
  }
});

test('non confonde piano e catalogo con la ricerca web', () => {
  for (const text of [
    'cosa prevede la ricetta del lunedì',
    "cosa c'è per cena",
    'quale ricetta è prevista per pranzo',
    'come si prepara la pasta al pomodoro',
    'che ricette hai nel catalogo',
    'cosa mangio oggi a pranzo',
    'ricetta di oggi'
  ]) {
    assert.equal(chat.analyzeRecipeRequest(text), false, `non è ricerca web: "${text}"`);
  }
});

// ---- Intenti locali ----
test('mappa le domande intra-app sugli strumenti locali', () => {
  const today = chat.todayKey();
  const tomorrow = chat.resolveDay('domani', today);
  assert.deepEqual(chat.analyzeLocalIntent('cosa mangio stasera'), { tool: 'get_meal_details', args: { day: today, slot: 'dinner' } });
  assert.deepEqual(chat.analyzeLocalIntent('cosa devo mangiare domani a colazione'), { tool: 'get_meal_details', args: { day: tomorrow, slot: 'breakfast' } });
  assert.deepEqual(chat.analyzeLocalIntent('cosa mangiamo domani a mezzogiorno'), { tool: 'get_meal_details', args: { day: tomorrow, slot: 'lunch' } });
  assert.deepEqual(chat.analyzeLocalIntent('cosa prevede il piano di oggi'), { tool: 'get_current_plan', args: { day: today } });
  assert.deepEqual(chat.analyzeLocalIntent('cosa mangio oggi'), { tool: 'get_current_plan', args: { day: today } });
  assert.deepEqual(chat.analyzeLocalIntent('mostrami la lista della spesa'), { tool: 'get_shopping_list', args: {} });
});

test('saluti, fuori tema e ricerca web restano distinti', () => {
  assert.ok(chat.analyzeLocalIntent('ciao').localReply, 'saluto locale');
  assert.equal(chat.analyzeLocalIntent('che tempo fa oggi').outOfScope, true, 'fuori tema');
  assert.equal(chat.analyzeLocalIntent('trovami una ricetta con pollo'), null, 'esce verso la ricerca web');
});

// ---- Ricerca testuale ----
test('cerca nei contenuti per parole chiave', () => {
  const records = [
    { title: 'Pollo e riso', text: 'pollo riso curry', excerpt: 'pollo riso' },
    { title: 'Orata al forno', text: 'orata patate', excerpt: 'orata' },
    { title: 'Yogurt e frutta', text: 'yogurt mela', excerpt: 'yogurt' }
  ];
  const results = chat.searchText(records, 'pollo riso', 5);
  assert.equal(results[0].title, 'Pollo e riso');
});

// ---- Lettura pasti e frutta ----
test('legge il pasto richiesto con gli ingredienti', () => {
  const meal = chat.mealDetails(state, 'saturday', 'dinner', 'man', piano);
  assert.equal(meal.found, true);
  assert.equal(meal.recipeName, 'Cena di pollo');
  assert.equal(meal.ingredients.length, 2);
  assert.equal(chat.mealDetails(state, 'saturday', 'breakfast', 'man', piano).found, false);
});

test('calcola solo la frutta dello spuntino per il profilo attivo', () => {
  const man = chat.sumFruitQuantity(recipes[0], 'snack1', 'training', 'man', piano);
  assert.equal(man.found, true);
  assert.equal(man.complete, true);
  assert.equal(man.grams, 300);

  const couple = chat.sumFruitQuantity(recipes[0], 'snack1', 'training', 'couple', piano);
  assert.equal(couple.grams.man, 300);
  assert.equal(couple.grams.ipo, 240);
});
