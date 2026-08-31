const test = require('node:test');
const assert = require('node:assert/strict');
const piano = require('../js/domain.js');
const assistant = require('../js/assistant-domain.js');

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
assistant.DAYS.forEach(day => {
  days[day] = { type: 'training', breakfast: null, snack1: 'S1', lunch: null, snack2: null, dinner: 'D1' };
});
const state = { recipes, recipesById: Object.fromEntries(recipes.map(recipe => [recipe.id, recipe])), plan: { days } };

test('calcola solo la frutta dello spuntino per il profilo attivo', () => {
  const result = assistant.sumFruitQuantity(recipes[0], 'snack1', 'training', 'man', piano);
  assert.equal(result.found, true);
  assert.equal(result.complete, true);
  assert.equal(result.grams, 300);
  assert.equal(result.message, 'Lo spuntino include 300 grammi di frutta.');
  assert.deepEqual(result.items.map(item => item.name), ['Mela', 'Kiwi']);
});

test('calcola le due dosi senza confonderle nel profilo coppia', () => {
  const result = assistant.sumFruitQuantity(recipes[0], 'snack1', 'training', 'couple', piano);
  assert.deepEqual(result.grams, { man: 300, ipo: 240 });
  assert.match(result.message, /300 grammi/);
  assert.match(result.message, /240 grammi/);
});

test('classifica anche la frutta comune per le domande vocali e la spesa', () => {
  assert.equal(piano.categoryForIngredient('Mela'), '🍑 Frutta');
  assert.equal(piano.categoryForIngredient('Banana'), '🍑 Frutta');
  assert.equal(piano.categoryForIngredient('Fragole'), '🍑 Frutta');
});

test('costruisce una sessione cucina colloquiale e sequenziale', () => {
  const meal = assistant.mealDetails(state, 'saturday', 'dinner', 'man', piano);
  const session = assistant.createCookingSession(meal);
  assert.equal(assistant.currentCookingItem(session).text, 'Prendi 200 grammi di Petto di pollo.');

  let result = assistant.advanceCooking(session);
  assert.equal(result.message, 'Prendi 200 grammi di Zucchine.');
  result = assistant.advanceCooking(session);
  assert.equal(result.message, 'Abbiamo preso tutto. Vuoi che iniziamo a preparare?');
  assert.equal(result.status.awaitingPreparationConfirmation, true);

  result = assistant.startPreparation(session);
  assert.equal(result.message, 'Perfetto. Taglia le zucchine.');
  result = assistant.advanceCooking(session);
  assert.equal(result.message, 'Cuoci il pollo in padella.');
  result = assistant.advanceCooking(session);
  assert.match(result.message, /Abbiamo finito/);
});

test('riconosce i comandi vocali senza richiedere una parola di attivazione', () => {
  assert.equal(assistant.commandFor('Prossimo'), 'next');
  assert.equal(assistant.commandFor('Puoi ripetere'), 'repeat');
  assert.equal(assistant.commandFor('Indietro'), 'previous');
  assert.equal(assistant.commandFor('Pausa'), 'pause');
  assert.equal(assistant.commandFor('Chiudi assistente'), 'close');
  assert.equal(assistant.commandFor('Basta'), 'close');
  assert.equal(assistant.resolveDay('domani', 'sunday'), 'monday');
  assert.equal(assistant.resolveSlot('spuntino 2'), 'snack2');
  assert.equal(assistant.commandFor('Iniziamo'), 'start-preparation');
});

test('cerca nei contenuti senza restituire documenti interi', () => {
  const results = assistant.searchText([
    { title: 'Cena', section: 'Ricette', text: 'pollo zucchine olio', excerpt: 'pollo e zucchine' },
    { title: 'Acqua', section: 'Guida', text: 'bevi acqua durante la giornata', excerpt: 'acqua' }
  ], 'zucchine');
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Cena');
  assert.equal(Object.prototype.hasOwnProperty.call(results[0], 'score'), false);
});
