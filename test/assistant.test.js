'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../js/assistant.js');

function portions(manA = '90g', manR = '70g', ipoA = '60g', ipoR = '60g') {
  return { ipoTraining: ipoA, ipoRest: ipoR, manTraining: manA, manRest: manR };
}

function ingredient(name, p = portions()) {
  return { name, portions: p };
}

function recipe(id, name, slot, ingredients, proteinCategory = '') {
  return { id, name, slot, proteinCategory, ingredients, steps: ['Metti tutto in padella.', 'Cuoci per 20 minuti.'] };
}

function planWith(days) {
  return { schemaVersion: 5, days, defaultDays: JSON.parse(JSON.stringify(days)) };
}

function fixture() {
  const recipes = [
    recipe('B1', 'Porridge di avena', 'breakfast', [ingredient('Avena', portions('40g', '40g', '40g', '40g'))]),
    recipe('P1', 'Pollo e riso', 'lunch', [ingredient('Petto di pollo', portions('200g', '200g', '150g', '150g')), ingredient('Riso', portions('90g', '70g', '70g', '60g'))], 'poultry'),
    recipe('C1', 'Frittata di verdure', 'dinner', [ingredient('Uova intere', portions('180g', '180g', '120g', '120g'))], 'eggs'),
    recipe('S1', 'Salmone al forno', 'dinner', [ingredient('Salmone', portions('150g', '150g', '120g', '120g')), ingredient('Patate', portions('230g', '230g', '230g', '230g'))], 'omega')
  ];
  const days = {
    monday: { type: 'training', breakfast: 'B1', snack1: null, lunch: 'P1', snack2: null, dinner: 'C1' },
    tuesday: { type: 'rest', breakfast: 'B1', snack1: null, lunch: 'P1', snack2: null, dinner: 'S1' },
    wednesday: { type: 'training', breakfast: 'B1', snack1: null, lunch: 'P1', snack2: null, dinner: 'C1' },
    thursday: { type: 'rest', breakfast: 'B1', snack1: null, lunch: 'P1', snack2: null, dinner: 'C1' },
    friday: { type: 'training', breakfast: 'B1', snack1: null, lunch: 'P1', snack2: null, dinner: 'S1' },
    saturday: { type: 'rest', breakfast: 'B1', snack1: null, lunch: 'P1', snack2: null, dinner: 'C1' },
    sunday: { type: 'training', breakfast: 'B1', snack1: null, lunch: 'P1', snack2: null, dinner: 'C1' }
  };
  return { recipes, plan: planWith(days) };
}

function context(overrides = {}) {
  const base = fixture();
  const shoppingEntries = [
    { name: 'Petto di pollo', amount: '1,4 kg' },
    { name: 'Riso', amount: '630g' }
  ];
  return a.buildContext({
    plan: base.plan,
    recipes: base.recipes,
    shoppingEntries,
    today: 'monday',
    profile: 'man',
    ...overrides
  });
}

test('buildContext: 7 giorni, profilo e lista spesa', () => {
  const ctx = context();
  assert.equal(ctx.days.length, 7);
  assert.equal(ctx.today, 'monday');
  assert.equal(ctx.profileLabel, 'Uomo · dosi A/R');
  assert.equal(ctx.shopping.count, 2);
  assert.equal(ctx.days[0].label, 'Lunedì');
  assert.equal(ctx.days[0].typeLabel, 'allenamento');
});

test('buildContext: pasto con ricetta e ingredienti formattati', () => {
  const ctx = context();
  const lunch = ctx.days[0].meals.find(meal => meal.slot === 'lunch');
  assert.equal(lunch.hasRecipe, true);
  assert.equal(lunch.recipeName, 'Pollo e riso');
  assert.deepEqual(lunch.ingredients, ['Petto di pollo 200g', 'Riso 90g']);
});

test('ingredientText: profilo coppia mostra entrambe le dosi', () => {
  assert.equal(
    a.ingredientText(ingredient('Petto di pollo'), 'couple', 'training'),
    'Petto di pollo (Uomo 90g · Donna IPO 60g)'
  );
  assert.equal(
    a.ingredientText(ingredient('Avena', portions('40g', '40g', '40g', '40g')), 'ipo', 'training'),
    'Avena 40g'
  );
});

test('proteinCounts: conta solo pranzo e cena', () => {
  const base = fixture();
  const recipesById = Object.fromEntries(base.recipes.map(r => [r.id, r]));
  const counts = a.proteinCounts(base.plan, recipesById, null);
  assert.equal(counts.poultry, 7);
  assert.equal(counts.omega, 2);
  assert.equal(counts.eggs, 5);
});

test('fallbackClassify: dagli ingredienti quando manca la categoria', () => {
  assert.equal(a.fallbackClassify(recipe('X1', 'X', 'lunch', [ingredient('Petto di pollo')])), 'poultry');
  assert.equal(a.fallbackClassify(recipe('X2', 'X', 'dinner', [ingredient('Salmone')])), 'omega');
  assert.equal(a.fallbackClassify(recipe('X3', 'X', 'dinner', [ingredient('Bresaola')])), 'curedMeats');
});

test('buildDayNarration: giorno completo con quantità', () => {
  const text = a.buildDayNarration(context(), 'monday');
  assert.match(text, /Lunedì/);
  assert.match(text, /allenamento/);
  assert.match(text, /Colazione: Porridge di avena con Avena 40g/);
  assert.match(text, /Pranzo: Pollo e riso con Petto di pollo 200g, Riso 90g/);
  assert.match(text, /Cena: Frittata di verdure con Uova intere 180g/);
});

test('buildDayNarration: filtro per singolo pasto', () => {
  const text = a.buildDayNarration(context(), 'monday', { slot: 'dinner' });
  assert.match(text, /Cena/);
  assert.doesNotMatch(text, /Colazione/);
});

test('answerLocally: cosa mangio oggi', () => {
  const answer = a.answerLocally('cosa mangio oggi?', context());
  assert.ok(answer);
  assert.match(answer.text, /Lunedì/);
  assert.match(answer.text, /Pollo e riso/);
});

test('answerLocally: cosa mangio domani', () => {
  const answer = a.answerLocally('cosa mangio domani?', context());
  assert.match(answer.text, /Martedì/);
});

test('answerLocally: cena di un giorno specifico', () => {
  const answer = a.answerLocally('cosa mangio a cena lunedì?', context());
  assert.match(answer.text, /Cena/);
  assert.doesNotMatch(answer.text, /Colazione/);
});

test('answerLocally: lista della spesa', () => {
  const answer = a.answerLocally('cosa devo comprare?', context());
  assert.match(answer.text, /2 alimenti/);
  assert.match(answer.text, /Petto di pollo/);
});

test('answerLocally: frequenze proteiche', () => {
  const answer = a.answerLocally('quante volte mangio pesce?', context());
  assert.match(answer.text, /Pesce ricco di omega-3/);
});

test('answerLocally: batch cooking', () => {
  const answer = a.answerLocally('cosa preparo in anticipo?', context());
  assert.match(answer.text, /Non ci sono preparazioni in anticipo/);
});

test('answerLocally: ricerca ricetta per nome', () => {
  const answer = a.answerLocally('come preparo la frittata?', context());
  assert.ok(answer);
  assert.match(answer.text, /Frittata di verdure/);
  assert.match(answer.text, /Uova intere/);
});

test('answerLocally: aiuto sull\'app', () => {
  const answer = a.answerLocally('come funziona l\'app?', context());
  assert.match(answer.text, /Piano Nutrizionale/);
});

test('answerLocally: domanda fuori contesto restituisce null', () => {
  assert.equal(a.answerLocally('quanti abitanti ha la luna?', context()), null);
});

test('contextToText: riepilogo per il prompt', () => {
  const text = a.contextToText(context());
  assert.match(text, /PIANO SETTIMANALE/);
  assert.match(text, /LISTA DELLA SPESA/);
  assert.match(text, /FREQUENZE PROTEICHE/);
});

test('buildSystemPrompt: istruzioni e contesto', () => {
  const prompt = a.buildSystemPrompt(context());
  assert.match(prompt, /Coach/);
  assert.match(prompt, /PIANO SETTIMANALE/);
});

test('findRecipe: per nome e per id', () => {
  const base = fixture();
  const byId = Object.fromEntries(base.recipes.map(r => [r.id, r]));
  assert.equal(a.findRecipe('come cucino il salmone?', byId).id, 'S1');
  assert.equal(a.findRecipe('ricetta P1', byId).id, 'P1');
});

test('quantityText: solo la dose, senza il nome', () => {
  assert.equal(a.quantityText(ingredient('Petto di pollo'), 'man', 'training'), '90g');
  assert.equal(a.quantityText(ingredient('Petto di pollo'), 'man', 'rest'), '70g');
  assert.equal(a.quantityText(ingredient('Petto di pollo'), 'ipo', 'training'), '60g');
  assert.equal(a.quantityText(ingredient('Petto di pollo'), 'couple', 'training'), 'Uomo 90g · Donna IPO 60g');
  assert.equal(a.quantityText(ingredient('Frutta', portions('250g', '250g', '250g', '250g')), 'man', 'rest'), '250g');
});

test('resolveQuestion: giorno e pasto dalle domande', () => {
  const ctx = context({ today: 'monday' });
  assert.deepEqual(a.resolveQuestion('cosa mangio a cena lunedì?', ctx), { day: 'monday', slot: 'dinner' });
  assert.deepEqual(a.resolveQuestion('quanti g di frutta nello spuntino di oggi?', ctx), { day: 'monday', slot: 'snack1' });
  assert.deepEqual(a.resolveQuestion('pranzo di domani', ctx), { day: 'tuesday', slot: 'lunch' });
  assert.deepEqual(a.resolveQuestion('cuciniamo la cena di stasera', ctx), { day: 'monday', slot: 'dinner' });
});

test('buildQuantityAnswer: risposta precisa solo con i grammi richiesti', () => {
  const base = fixture();
  base.recipes.push(recipe('SN1', 'Spuntino frutta', 'snack1', [ingredient('Frutta fresca', portions('250g', '250g', '250g', '250g'))]));
  base.plan.days.monday.snack1 = 'SN1';
  const ctx = a.buildContext({ plan: base.plan, recipes: base.recipes, today: 'monday', profile: 'man', shoppingEntries: [] });
  const answer = a.buildQuantityAnswer('quanti grammi di frutta ho nello spuntino di oggi?', ctx);
  assert.ok(answer);
  assert.match(answer.text, /spuntino/i);
  assert.match(answer.text, /Frutta fresca/);
  assert.match(answer.text, /250g/);
  assert.doesNotMatch(answer.text, /Petto di pollo/, 'deve riportare solo la dose richiesta, non tutto il pasto');
});

test('buildQuantityAnswer: senza pasto specifico non risponde', () => {
  const ctx = context({ today: 'monday' });
  assert.equal(a.buildQuantityAnswer('quanti grammi di roba?', ctx), null);
});

test('answerLocally: cucina guidata per la cena di stasera', () => {
  const ctx = context({ today: 'monday' });
  const answer = a.answerLocally('cuciniamo la cena di stasera', ctx);
  assert.ok(answer);
  assert.ok(answer.cooking, 'avvia la sessione di cucina');
  assert.equal(answer.cooking.recipeId, 'C1');
  assert.equal(answer.cooking.dayType, 'training');
  assert.match(answer.text, /Frittata di verdure/);
  assert.match(answer.text, /Prendi 180g di Uova intere/);
});

test('buildCookingStep: sequenza ingredienti → preparazione', () => {
  const base = fixture();
  const recipeWithSteps = recipe('X9', 'Pollo e riso', 'lunch', [
    ingredient('Petto di pollo'), ingredient('Riso')
  ]);
  // Frase umana: "Prendi 90g di Petto di pollo" (non "Ingrediente 1 di 2: …").
  assert.match(a.buildCookingStep(recipeWithSteps, 'man', 'training', 'ingredients', 0), /Prendi 90g di Petto di pollo/);
  assert.match(a.buildCookingStep(recipeWithSteps, 'man', 'training', 'ingredients', 1), /Prendi 90g di Riso/);
  assert.match(a.buildCookingStep(recipeWithSteps, 'man', 'training', 'steps', 0), /Passo 1 di 2/);
  assert.match(a.buildCookingStep(recipeWithSteps, 'man', 'training', 'steps', 1), /Passo 2 di 2/);
  assert.equal(a.buildCookingStep(recipeWithSteps, 'man', 'training', 'ingredients', 2), '');
  // Dose numerica pura ("2") → "Prendi 2 Uova intere".
  const eggRecipe = recipe('X10', 'Frittata', 'dinner', [ingredient('Uova intere', portions('2', '2', '2', '2'))]);
  assert.match(a.buildCookingStep(eggRecipe, 'man', 'training', 'ingredients', 0), /Prendi 2 Uova intere/);
  // Profilo coppia → "Prendi Nome: Uomo … · Donna IPO …".
  assert.match(a.buildCookingStep(recipeWithSteps, 'couple', 'training', 'ingredients', 0), /Prendi Petto di pollo: Uomo 90g · Donna IPO 60g/);
});

test('answerLocally: il comando prossimo non è una domanda di piano', () => {
  // "prossimo" non deve finire nel motore di risposta: la sessione è gestita
  // dalla UI (assistant-ui.js); qui verifichiamo che non produca una risposta.
  const ctx = context({ today: 'monday' });
  const answer = a.answerLocally('prossimo', ctx);
  assert.equal(answer, null);
});
