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

test('motore locale: richieste intra-app mappate sui tool deterministici', () => {
  const today = assistant.todayKey();
  const tomorrow = assistant.resolveDay('domani', today);
  assert.deepEqual(assistant.analyzeLocalIntent('cosa prevede il piano di oggi'), { tool: 'get_current_plan', args: { day: today } });
  assert.deepEqual(assistant.analyzeLocalIntent("che cosa c'è per cena domani"), { tool: 'get_meal_details', args: { day: tomorrow, slot: 'dinner' } });
  assert.deepEqual(assistant.analyzeLocalIntent('cosa mangio a pranzo'), { tool: 'get_meal_details', args: { day: today, slot: 'lunch' } });
  assert.deepEqual(assistant.analyzeLocalIntent("quanta frutta c'è nello spuntino"), { tool: 'get_fruit_quantity', args: { day: today, slot: 'snack1' } });
  assert.deepEqual(assistant.analyzeLocalIntent('quanta frutta nella merenda'), { tool: 'get_fruit_quantity', args: { day: today, slot: 'snack2' } });
  assert.deepEqual(assistant.analyzeLocalIntent('cosa devo comprare per la spesa'), { tool: 'get_shopping_list', args: {} });
  assert.deepEqual(assistant.analyzeLocalIntent('prossimo'), { tool: 'next_cooking_item', args: {} });
  assert.deepEqual(assistant.analyzeLocalIntent('a che punto siamo con la preparazione'), { tool: 'get_cooking_status', args: {} });
  assert.deepEqual(assistant.analyzeLocalIntent('cuciniamo la cena'), { tool: 'start_cooking_session', args: { day: today, slot: 'dinner' } });
  assert.deepEqual(assistant.analyzeLocalIntent('dimmi le linee guida del dottor Meller'), { tool: 'search_app_content', args: { query: 'linee guida dott Meller' } });
});

test('motore locale: saluti, chiusura e fuori tema senza consumare Gemini', () => {
  assert.ok(assistant.analyzeLocalIntent('ciao').localReply, 'saluto gestito in locale');
  assert.deepEqual(assistant.analyzeLocalIntent('chiudi assistente'), { tool: 'close_assistant', args: {} });
  const outOfScope = assistant.analyzeLocalIntent('che tempo fa domani a Bologna');
  assert.equal(outOfScope.outOfScope, true);
  assert.match(outOfScope.message, /non è di mia competenza/);
  assert.equal(assistant.analyzeLocalIntent('parlami dei benefici delle proteine'), null, 'conversazione libera: serve Gemini');
});

test('linee guida Meller: le ricette dal web non superano i massimi', () => {
  const adapted = assistant.adaptRecipeToGuidelines({
    name: 'Pollo al limone', slot: 'dinner',
    ingredients: [
      { name: 'Pollo', quantity: '300 g' },
      { name: 'Olio EVO', quantity: '20 g' },
      { name: 'Pasta', quantity: '150 g' },
      { name: 'Limone', quantity: 'q.b.' },
      { name: 'Marmellata', quantity: '60 g' }
    ],
    steps: ['Cuoci il pollo', 'Condisci con limone']
  });
  const quantityOf = name => adapted.recipe.ingredients.find(item => item.name === name).quantity;
  assert.equal(quantityOf('Pollo'), '200 g', 'pollame massimo 200 g');
  assert.equal(quantityOf('Olio EVO'), '10 g', 'olio massimo 10 g');
  assert.equal(quantityOf('Pasta'), '90 g', 'pasta massimo 90 g');
  assert.equal(quantityOf('Marmellata'), '30 g', 'marmellata massimo 30 g');
  assert.equal(quantityOf('Limone'), 'q.b.', 'le dosi libere restano invariate');
  assert.match(adapted.recipe.notes.join(' '), /dott\. Meller/);
  assert.equal(adapted.report.length, 4, 'rapporto con tutte le correzioni');
  assert.deepEqual(adapted.recipe.steps, ['Cuoci il pollo', 'Condisci con limone']);
});

test('linee guida Meller: dosi già conformi non vengono toccate', () => {
  const adapted = assistant.adaptRecipeToGuidelines({
    name: 'Insalata', slot: 'lunch',
    ingredients: [{ name: 'Merluzzo', quantity: '200 g' }, { name: 'Olio EVO', quantity: '8 g' }],
    steps: ['Mescola']
  });
  assert.equal(adapted.report.length, 0);
  assert.match(adapted.recipe.notes.join(' '), /^(?!.*Meller)/, 'nessuna nota di adattamento se nulla è cambiato');
});
