'use strict';
/* Passo 2 — quantità e unità di misura:
 *  - Riposo/Allenamento: dosi distinte in base al tipo giorno;
 *  - parseQuantity: parser stretto senza reinterpretazioni;
 *  - Meller e carboidrati: solo grammi espliciti, resto testuale;
 *  - somme/spesa: cucchiai, pezzi e ml mai convertiti in grammi. */
const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../js/domain.js');

const pastaLunch = (man = '90 g', ipo = '70 g') => ({
  id: 'L1', slot: 'lunch', name: 'Pasta', emoji: '🍝',
  ingredients: [{ name: 'Pasta di semola', portions: { man, ipo } }]
});

test('parseQuantity: vuoti, q.b., quantità, opachi', () => {
  assert.deepEqual(d.parseQuantity(''), { kind: 'empty' });
  assert.deepEqual(d.parseQuantity('—'), { kind: 'empty' });
  assert.deepEqual(d.parseQuantity('-'), { kind: 'empty' });
  assert.deepEqual(d.parseQuantity('0 g'), { kind: 'empty' });
  assert.deepEqual(d.parseQuantity('q.b.'), { kind: 'free', text: 'q.b.' });
  assert.deepEqual(d.parseQuantity('qb'), { kind: 'free', text: 'qb' });
  assert.deepEqual(d.parseQuantity('a piacere'), { kind: 'free', text: 'a piacere' });
  assert.deepEqual(d.parseQuantity('60 g'), { kind: 'amount', value: 60, unit: 'g' });
  assert.deepEqual(d.parseQuantity('60g'), { kind: 'amount', value: 60, unit: 'g' });
  assert.deepEqual(d.parseQuantity('1,5 g'), { kind: 'amount', value: 1.5, unit: 'g' });
  assert.deepEqual(d.parseQuantity('½ cucchiaino'), { kind: 'amount', value: 0.5, unit: 'cucchiaino' });
  assert.deepEqual(d.parseQuantity('2'), { kind: 'amount', value: 2, unit: null });
  assert.deepEqual(d.parseQuantity('2 pz'), { kind: 'amount', value: 2, unit: 'pz' });
  assert.deepEqual(d.parseQuantity('1 cucchiaio'), { kind: 'amount', value: 1, unit: 'cucchiaio' });
  assert.deepEqual(d.parseQuantity('2 Cucchiai'), { kind: 'amount', value: 2, unit: 'cucchiaio' });
  assert.deepEqual(d.parseQuantity('250 ml'), { kind: 'amount', value: 250, unit: 'ml' });
  // Intervalli, misure non censite e note: opachi, mai reinterpretati.
  assert.deepEqual(d.parseQuantity('8-10 g'), { kind: 'opaque', text: '8-10 g' });
  assert.deepEqual(d.parseQuantity('1-2 cucchiai'), { kind: 'opaque', text: '1-2 cucchiai' });
  assert.deepEqual(d.parseQuantity('1 mazzetto'), { kind: 'opaque', text: '1 mazzetto' });
  assert.deepEqual(d.parseQuantity('a fette'), { kind: 'opaque', text: 'a fette' });
  assert.deepEqual(d.parseQuantity('60gr'), { kind: 'opaque', text: '60gr' });
});

test('formatAmount: grammi compatti, altre unità con spazio e plurale', () => {
  assert.equal(d.formatAmount(120, 'g'), '120g');
  assert.equal(d.formatAmount(200, 'ml'), '200ml');
  assert.equal(d.formatAmount(6, 'pz'), '6 pz');
  assert.equal(d.formatAmount(1, 'pz'), '1 pz');
  assert.equal(d.formatAmount(1, 'cucchiaio'), '1 cucchiaio');
  assert.equal(d.formatAmount(3, 'cucchiaio'), '3 cucchiai');
  assert.equal(d.formatAmount(1, 'cucchiaino'), '1 cucchiaino');
  assert.equal(d.formatAmount(2, 'cucchiaino'), '2 cucchiaini');
  assert.equal(d.formatAmount(1.5, 'cucchiaio'), '1,5 cucchiai');
});

test('somme: i cucchiai restano cucchiai, unità diverse non si fondono', () => {
  assert.equal(d.sumPortionStrings('1 cucchiaio', '2 cucchiai'), '3 cucchiai');
  assert.equal(d.sumPortionStrings('1 cucchiaino', '1 cucchiaino'), '2 cucchiaini');
  assert.equal(d.sumPortionStrings('120g', '1 cucchiaio'), '120g + 1 cucchiaio');
  assert.equal(d.sumPortionStrings('200g', '200g'), '400g');
  assert.equal(d.sumPortionStrings('3', '3'), '6 pz');
});

test('adattamento Meller: solo grammi espliciti, resto invariato', () => {
  const adapted = d.resolveRecipeForPlan(pastaLunch('120 g', '120 g'), 'lunch', 'meller', 'training').recipe;
  assert.equal(adapted.ingredients[0].portions.man, '90 g');
  assert.equal(adapted.ingredients[0].portions.ipo, '90 g');
  for (const dose of ['120', '2 pz', '1 cucchiaio', '250 ml', 'q.b.', '1 mazzetto', '8-10 g', '—']) {
    const result = d.resolveRecipeForPlan(pastaLunch(dose, dose), 'lunch', 'meller', 'training').recipe;
    assert.equal(result.ingredients[0].portions.man, dose, `dose "${dose}" invariata`);
  }
});

test('mellerComparableAmount e parseCarbAmount: g-only, niente naked→grammi', () => {
  assert.deepEqual(d.mellerComparableAmount('60 g'), { value: 60, unit: 'g' });
  assert.deepEqual(d.mellerComparableAmount('60g'), { value: 60, unit: 'g' });
  for (const dose of ['60', '2 pz', '1 cucchiaio', '250 ml', 'q.b.', '1 mazzetto', '8-10 g', '—', '0 g']) {
    assert.equal(d.mellerComparableAmount(dose), null, `non confrontabile: "${dose}"`);
  }
  assert.deepEqual(d.parseCarbAmount('60 g'), { value: 60, unit: 'g' });
  assert.equal(d.parseCarbAmount('250'), null, 'numero nudo non più letto come grammi');
  assert.equal(d.parseCarbAmount('2 pz'), null);
  assert.equal(d.parseCarbAmount('1 cucchiaio'), null);
});

test('carbBaseAmount: riferimento solo se dose mancante o non numerica', () => {
  const source = d.carbSourceForName('Pasta di semola');
  const base = man => d.carbBaseAmount({ name: 'Pasta di semola', portions: { man, ipo: '—' } }, source, 'lunch');
  assert.deepEqual(base('60 g'), { value: 60, unit: 'g' }, 'grammi nativi usati');
  assert.ok(base('—') && base('—').unit === 'g', 'dose mancante → riferimento');
  assert.ok(base('q.b.') && base('q.b.').unit === 'g', 'q.b. → riferimento linee guida');
  assert.ok(base('1 fetta') && base('1 fetta').unit === 'g', 'nota opaca → riferimento');
  assert.equal(base('250'), null, 'numero nudo: né adattamento né fallback');
  assert.equal(base('2 pz'), null, 'unità diversa: resta testuale');
  assert.equal(base('1 cucchiaio'), null, 'cucchiai: restano testuali');
});

test('carboidrato cross-slot con unità non-grammi resta testuale', () => {
  const crossed = d.adaptIngredientForSlot(
    { name: 'Pasta di semola', portions: { man: '2 pz', ipo: '2 pz' } }, 'lunch', 'dinner', 'rest'
  );
  assert.equal(crossed, null, 'niente "50 pz" inventati');
});

test('Riposo/Allenamento: dosi Meller distinte per tipo giorno', () => {
  const training = d.resolveRecipeForPlan(pastaLunch(), 'lunch', 'meller', 'training').recipe;
  const rest = d.resolveRecipeForPlan(pastaLunch(), 'lunch', 'meller', 'rest').recipe;
  assert.equal(training.ingredients[0].portions.man, '90 g');
  assert.equal(rest.ingredients[0].portions.man, '70 g');
  assert.notEqual(training.ingredients[0].portions.man, rest.ingredients[0].portions.man);
});

test('spostamento pranzo→cena: dose cena da tabella su grammi nativi', () => {
  const dinner = d.resolveRecipeForPlan(pastaLunch(), 'dinner', 'meller', 'rest').recipe;
  assert.equal(dinner.ingredients[0].portions.man, '40 g');
});

test('spesa: totali cucchiai separati dai grammi', () => {
  const plan = {
    days: { monday: { type: 'training', lunch: 'L9' } },
    mellerModes: {},
    adaptedQuantitiesEnabled: false
  };
  const recipesById = {
    L9: {
      id: 'L9', slot: 'lunch', name: 'Test',
      ingredients: [
        { name: 'Olio extravergine', portions: { man: '1 cucchiaio', ipo: '1 cucchiaio' } },
        { name: 'Pasta di semola', portions: { man: '90 g', ipo: '70 g' } }
      ]
    }
  };
  const list = d.aggregateShopping(plan, recipesById, { monday: ['lunch'] }, 'man');
  const oil = list.find(entry => entry.ingredientId === d.ingredientIdFor('Olio extravergine'));
  assert.equal(oil.totals.cucchiaio, 1);
  assert.equal(oil.totals.g, undefined, 'nessun grammo inventato dai cucchiai');
  const pasta = list.find(entry => entry.ingredientId === d.ingredientIdFor('Pasta di semola'));
  assert.equal(pasta.totals.g, 90);
});

test('batch cooking: somme con cucchiai e unità miste mai fuse', () => {
  assert.equal(d.combineTaskQuantities('1 cucchiaio', '2 cucchiai'), '3 cucchiai');
  assert.equal(d.combineTaskQuantities('100g', '1 cucchiaio'), '100g + 1 cucchiaio');
  assert.deepEqual(
    d.combineTaskQuantities(
      { man: '1 cucchiaio', ipo: '1 cucchiaio' },
      { man: '1 cucchiaio', ipo: '2 cucchiai' },
      'couple'
    ),
    { man: '2 cucchiai', ipo: '3 cucchiai' }
  );
  assert.equal(d.combineTaskQuantities('2', '3'), '5 pz');
});

test('resolveRecipeForPlan non muta mai la ricetta originale (non-retroattività)', () => {
  const recipe = pastaLunch('120 g', '120 g');
  const before = JSON.stringify(recipe);
  d.resolveRecipeForPlan(recipe, 'lunch', 'meller', 'training');
  d.resolveRecipeForPlan(recipe, 'dinner', 'meller', 'rest');
  assert.equal(JSON.stringify(recipe), before);
});
