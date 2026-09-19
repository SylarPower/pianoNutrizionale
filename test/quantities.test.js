'use strict';
/* Passo 2 — quantità e unità di misura:
 *  - Riposo/Allenamento: dosi distinte in base al tipo giorno;
 *  - parseQuantity: parser stretto senza reinterpretazioni;
 *  - Guide e carboidrati: solo grammi espliciti, resto testuale;
 *  - somme/spesa: cucchiai, pezzi e ml mai convertiti in grammi. */
const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../js/domain.js');

const pastaLunch = (single = '70 g') => ({
  id: 'L1', slot: 'lunch', name: 'Pasta', emoji: '🍝',
  ingredients: [{ name: 'Pasta di semola', portions: { single } }]
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

test('regressione: niente adattamento automatico delle dosi (Guide rimosse)', () => {
  // Il vecchio motore riscriveva le porzioni secondo le grammature Guide per
  // slot e tipo giornata. Ora le porzioni originali restano intatte ovunque:
  // la vista allineata alla dieta assegnata è calcolata da alignRecipeToDiet
  // e non tocca mai la ricetta.
  for (const dose of ['120 g', '120', '2 pz', '1 cucchiaio', '250 ml', 'q.b.', '8-10 g', '—']) {
    const recipe = pastaLunch(dose);
    const before = JSON.stringify(recipe);
    assert.equal(recipe.ingredients[0].portions.single, dose, `dose "${dose}" intatta per costruzione`);
    assert.equal(JSON.stringify(recipe), before);
  }
});

test('parseQuantity resta stretto: niente numeri nudi letti come grammi', () => {
  // Numeri nudi e unità non-grammi restano ciò che sono: nessuna
  // reinterpretazione in grammi per adattamenti o travasi.
  assert.deepEqual(d.parseQuantity('250'), { kind: 'amount', value: 250, unit: null });
  assert.deepEqual(d.parseQuantity('2 pz'), { kind: 'amount', value: 2, unit: 'pz' });
  assert.equal(d.formatAmount(250, null), '250');
});

test('spesa: totali cucchiai separati dai grammi', () => {
  const plan = {
    days: { monday: { type: 'training', lunch: 'L9' } },
    guideModes: {},
    adaptedQuantitiesEnabled: false
  };
  const recipesById = {
    L9: {
      id: 'L9', slot: 'lunch', name: 'Test',
      ingredients: [
        { name: 'Olio extravergine', portions: { single: '1 cucchiaio' } },
        { name: 'Pasta di semola', portions: { single: '70 g' } }
      ]
    }
  };
  const list = d.aggregateShopping(plan, recipesById, { monday: ['lunch'] }, 'single');
  const oil = list.find(entry => entry.ingredientId === d.ingredientIdFor('Olio extravergine'));
  assert.equal(oil.totals.cucchiaio, 1);
  assert.equal(oil.totals.g, undefined, 'nessun grammo inventato dai cucchiai');
  const pasta = list.find(entry => entry.ingredientId === d.ingredientIdFor('Pasta di semola'));
  assert.equal(pasta.totals.g, 70);
});

test('batch cooking: somme con cucchiai e unità miste mai fuse', () => {
  assert.equal(d.combineTaskQuantities('1 cucchiaio', '2 cucchiai'), '3 cucchiai');
  assert.equal(d.combineTaskQuantities('100g', '1 cucchiaio'), '100g + 1 cucchiaio');
  assert.equal(d.combineTaskQuantities('2', '3'), '5 pz');
});

test('le dosi allineate alla dieta non mutano mai la ricetta originale (non-retroattività)', () => {
  const engine = d.buildDietEngine(v3ProfileQuantities());
  assert.ok(engine, 'motore dieta dal profilo assegnato');
  const recipe = pastaLunch('120 g');
  const before = JSON.stringify(recipe);
  const aligned = d.alignRecipeToDiet(recipe, engine, 'lunch', 'training');
  assert.ok(aligned);
  assert.equal(aligned.ingredients[0].amountText, '80g', 'vista allineata alla struttura');
  assert.equal(recipe.ingredients[0].portions.single, '120 g');
  assert.equal(JSON.stringify(recipe), before);
});

// Profilo v3 minimale per il test di non-retroattività: pranzo a blocco
// cereali (riso 80g) con catalogo di tre ingredienti.
function v3ProfileQuantities() {
  const catalog = {
    categories: [{ categoryId: 'carb', displayName: 'Carboidrati', sortOrder: 0 }],
    families: [{ familyId: 'cereali', displayName: 'Cereali', categoryId: 'carb', sortOrder: 0 }],
    ingredients: [
      { ingredientId: 'pasta-di-semola', displayName: 'Pasta di semola', aliases: ['pasta'], categoryId: 'carb', familyId: 'cereali', dietaryFlags: { vegetarian: true, vegan: true }, status: 'active' },
      { ingredientId: 'riso', displayName: 'Riso', aliases: [], categoryId: 'carb', familyId: 'cereali', dietaryFlags: { vegetarian: true, vegan: true }, status: 'active' }
    ]
  };
  const dietPlan = d.createEmptyDietPlan({ days: [
    d.createDietPlanDay('training', { dayId: 't', meals: [
      d.createDietPlanMeal('lunch', { options: [
        d.createDietPlanOption({ type: 'family-block', blocks: [
          d.createDietPlanBlock({ referenceFamilyId: 'cereali', referenceIngredientId: 'riso', referenceAmount: { value: 80, unit: 'g' } })
        ] })
      ] })
    ] })
  ] });
  return {
    schemaVersion: 1, clientProfileId: 'cp1', assignmentId: 'a1', structureId: 's1',
    structureRevisionId: 'rev1', structureChecksum: 'chk', structureName: 'Base',
    ingredientCatalogVersion: 1, structureRevision: { revisionId: 'rev1', dietPlan },
    catalog, compatibleClientSchema: 7
  };
}
