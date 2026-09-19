'use strict';
/* Dieta guidata — modello v2 (dietPlan schema 2, strutture a blocchi).
 *
 * Contratto verificato senza rete:
 *  - vocabolario condiviso (giornate, pasti, unità, tipi opzione, limiti);
 *  - opzioni di tre tipi mutuamente esclusivi: family-block, ingredients, recipe;
 *  - blocchi con famiglia di riferimento, quantità, template snapshot e override;
 *  - etichette A/B/C/D solo per la UI, mai persistite;
 *  - ordine pasti fisso e stabile, nessun riordino manuale;
 *  - builder puri e pre-validazione console in italiano;
 *  - riepilogo per l'anteprima (conteggi, mai calcoli clinici);
 *  - il modello v1 (choiceGroups, free-foods, label opzione persistita,
 *    target kcal) non esiste più in nessun punto del client.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/admin.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'js/admin.js'), 'utf8');
const domain = require('../js/domain.js');

function familyBlockBlock(overrides = {}) {
  return domain.createDietPlanBlock({
    blockId: 'amidi-riso',
    referenceFamilyId: 'cereali',
    referenceIngredientId: 'riso',
    referenceAmount: { value: 80, unit: 'g' },
    ...overrides
  });
}

function validPlan() {
  return domain.createEmptyDietPlan({ generalNotes: 'Bere durante i pasti.', days: [
    domain.createDietPlanDay('training', {
      dayId: 'giorno-allenamento', label: 'Giorno di allenamento',
      meals: [
        domain.createDietPlanMeal('lunch', {
          time: '12:30',
          options: [
            domain.createDietPlanOption({
              optionId: 'pranzo-riso',
              type: 'family-block',
              blocks: [
                familyBlockBlock({
                  templateId: 'tpl-amidi',
                  templateSnapshot: {
                    revisionId: '1',
                    referenceAmount: { value: 80, unit: 'g' },
                    equivalents: [{ familyId: 'patate', ingredientId: 'patate', amount: { value: 250, unit: 'g' } }]
                  },
                  overrides: [{ familyId: 'gnocchi', ingredientId: null, amount: { value: 150, unit: 'g' } }]
                }),
                domain.createDietPlanBlock({ referenceFamilyId: 'verdura', referenceIngredientId: 'zucchine', referenceAmount: { value: 200, unit: 'g' } })
              ]
            }),
            domain.createDietPlanOption({
              optionId: 'pranzo-ricetta',
              type: 'recipe',
              recipeId: 'ricetta-pollo',
              recipeMultiplier: 1.5
            })
          ]
        }),
        domain.createDietPlanMeal('breakfast', {
          options: [domain.createDietPlanOption({
            optionId: 'colazione',
            type: 'ingredients',
            items: [domain.createDietPlanItem({ itemId: 'avena', ingredientId: 'avena', amount: { value: 60, unit: 'g' } })]
          })]
        })
      ],
      supplements: 'Vitamina D', hydration: '2 litri', note: ''
    }),
    domain.createDietPlanDay('rest', {
      dayId: 'giorno-riposo',
      meals: [domain.createDietPlanMeal('dinner', {
        options: [domain.createDietPlanOption({
          optionId: 'cena-legumi',
          type: 'ingredients',
          items: [domain.createDietPlanItem({ itemId: 'lenticchie', ingredientId: 'lenticchie', amount: { value: 90, unit: 'g' } })]
        })]
      })]
    })
  ] });
}

test('vocabolario condiviso: versioni, tipi, pasti, unità, opzioni', () => {
  assert.equal(domain.DIET_PLAN_SCHEMA_VERSION, 2);
  assert.deepEqual(domain.DIET_PLAN_DAY_TYPES, ['training', 'rest', 'other']);
  assert.equal(domain.DIET_PLAN_MEALS.length, 6);
  assert.deepEqual(domain.DIET_PLAN_MEALS.map(meal => meal.id), ['breakfast', 'morning-snack', 'lunch', 'afternoon-snack', 'dinner', 'evening-snack']);
  assert.deepEqual(domain.DIET_PLAN_OPTION_TYPES.map(type => type.id), ['family-block', 'ingredients', 'recipe']);
  // Le etichette A–D esistono solo come derivazione di UI per i pasti a più opzioni.
  assert.deepEqual(domain.DIET_PLAN_OPTION_LABELS, ['A', 'B', 'C', 'D']);
  const units = domain.DIET_PLAN_UNITS.map(unit => unit.id);
  assert.ok(units.includes('g') && units.includes('ml') && units.includes('pz') && units.includes('qb'));
  assert.equal(domain.DIET_PLAN_LIMITS.days, 14);
  assert.equal(domain.DIET_PLAN_LIMITS.optionsPerMeal, 4);
  assert.equal(domain.DIET_PLAN_LIMITS.blocksPerOption, 8);
  assert.equal(domain.DIET_PLAN_LIMITS.equivalentsPerTemplate, 30);
});

test('builder puri: piano iniziale con allenamento + riposo e valori neutri', () => {
  const emptyPlan = domain.createEmptyDietPlan();
  assert.equal(emptyPlan.schemaVersion, 2);
  assert.deepEqual(emptyPlan.days.map(day => day.dayType), ['training', 'rest']);
  assert.equal(emptyPlan.generalNotes, '');
  // Le giornate partono senza pasti né note: il professionista costruisce.
  emptyPlan.days.forEach(day => {
    assert.deepEqual(day.meals, []);
    assert.equal(day.label, '');
    assert.equal(day.supplements, '');
    assert.equal(day.hydration, '');
    assert.equal(day.note, '');
  });
  const day = domain.createDietPlanDay('rest', { dayId: 'riposo' });
  assert.equal(day.dayType, 'rest');
  assert.equal(day.meals.length, 0);
  // Tipo giornata sconosciuto → allenamento, mai un campo libero
  assert.equal(domain.createDietPlanDay('sconosciuto').dayType, 'training');
});

test('ordine pasti fisso e stabile, nessun riordino manuale', () => {
  const meals = ['dinner', 'breakfast', 'lunch'].map(mealId => domain.createDietPlanMeal(mealId));
  const day = domain.createDietPlanDay('training', { meals });
  assert.deepEqual(day.meals.map(meal => meal.mealId), ['breakfast', 'lunch', 'dinner']);
  // Pasto sconosciuto in coda, non ruba la posizione di uno valido
  const withUnknown = domain.sortDietPlanMeals([{ mealId: 'dinner' }, { mealId: 'caffe' }, { mealId: 'lunch' }]);
  assert.deepEqual(withUnknown.map(meal => meal.mealId), ['lunch', 'dinner', 'caffe']);
});

test('opzioni: tre tipi mutuamente esclusivi con campi dedicati', () => {
  const block = domain.createDietPlanOption({ type: 'family-block', blocks: [familyBlockBlock()] });
  assert.equal(block.type, 'family-block');
  assert.ok(Array.isArray(block.blocks) && block.blocks.length === 1);
  assert.equal(block.items, undefined);
  assert.equal(block.recipeId, undefined);
  const items = domain.createDietPlanOption({ type: 'ingredients', items: [domain.createDietPlanItem({ ingredientId: 'avena', amount: { value: 60, unit: 'g' } })] });
  assert.equal(items.type, 'ingredients');
  assert.ok(Array.isArray(items.items) && items.items.length === 1);
  assert.equal(items.blocks, undefined);
  const recipe = domain.createDietPlanOption({ type: 'recipe', recipeId: 'r1', recipeMultiplier: 2 });
  assert.equal(recipe.recipeId, 'r1');
  assert.equal(recipe.recipeMultiplier, 2);
  assert.equal(recipe.blocks, undefined);
  assert.equal(recipe.items, undefined);
  // Moltiplicatore sempre entro i limiti (0,1–10)
  assert.equal(domain.createDietPlanOption({ type: 'recipe', recipeId: 'r1', recipeMultiplier: 99 }).recipeMultiplier, 10);
  assert.equal(domain.createDietPlanOption({ type: 'recipe', recipeId: 'r1', recipeMultiplier: 0 }).recipeMultiplier, 0.1);
});

test('blocchi famiglia: riferimento, template snapshot non retroattivo e override', () => {
  const block = familyBlockBlock({
    templateId: 'tpl-amidi',
    templateSnapshot: {
      revisionId: '1',
      referenceAmount: { value: 80, unit: 'g' },
      equivalents: [{ familyId: 'patate', ingredientId: 'patate', amount: { value: 250, unit: 'g' } }]
    },
    overrides: [{ familyId: 'gnocchi', amount: { value: 150, unit: 'g' } }]
  });
  assert.equal(block.referenceFamilyId, 'cereali');
  assert.equal(block.referenceIngredientId, 'riso');
  assert.deepEqual(block.referenceAmount, { value: 80, unit: 'g' });
  // Lo snapshot fissa la revisione del template nella struttura pubblicata.
  assert.equal(block.templateId, 'tpl-amidi');
  assert.equal(block.templateSnapshot.revisionId, '1');
  // L'override esplicito vince sul template senza riscriverlo.
  assert.equal(block.overrides.length, 1);
  assert.deepEqual(block.overrides[0].amount, { value: 150, unit: 'g' });
  // Senza template niente snapshot: il blocco resta autonomo.
  const plain = familyBlockBlock();
  assert.equal(plain.templateId, null);
  assert.equal(plain.templateSnapshot, null);
  assert.deepEqual(plain.overrides, []);
});

const mealById = (plan, dayIndex, mealId) => plan.days[dayIndex].meals.find(meal => meal.mealId === mealId);

test('pre-validazione console: piano valido e messaggi in italiano', () => {
  const result = domain.validateDietPlanSoft(validPlan());
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test('pre-validazione console: opzione ricetta senza ricetta o moltiplicatore assurdo', () => {
  const plan = validPlan();
  const lunch = mealById(plan, 0, 'lunch');
  lunch.options[1].recipeId = '';
  lunch.options[1].recipeMultiplier = 42;
  const { errors } = domain.validateDietPlanSoft(plan);
  assert.ok(errors.some(message => /seleziona la ricetta/.test(message)), 'ricetta mancante segnalata');
  assert.ok(errors.some(message => /moltiplicatore ricetta non valido/.test(message)), 'moltiplicatore segnalato');
});

test('pre-validazione console: blocchi e opzioni incomplete segnalate in italiano', () => {
  const plan = validPlan();
  // Svuota i blocchi della prima opzione del pranzo: resta il tipo family-block senza blocchi
  mealById(plan, 0, 'lunch').options[0].blocks = [];
  // Svuota gli ingredienti della colazione della giornata di riposo
  mealById(plan, 1, 'dinner').options[0].items = [];
  const { errors } = domain.validateDietPlanSoft(plan);
  assert.ok(errors.some(message => /aggiungi almeno un blocco/.test(message)), 'blocco mancante');
  assert.ok(errors.some(message => /aggiungi almeno un ingrediente/.test(message)), 'ingrediente mancante');
  // Identificativi duplicati
  const dup = validPlan();
  dup.days[1].dayId = dup.days[0].dayId;
  const dupResult = domain.validateDietPlanSoft(dup);
  assert.ok(dupResult.errors.some(message => /identificativo duplicato/.test(message)), 'dayId duplicato');
});

test('riepilogo per l’anteprima: solo conteggi, nessun calcolo clinico', () => {
  const summary = domain.dietPlanSummary(validPlan());
  assert.deepEqual(summary, {
    dayCount: 2,
    mealCount: 3,
    optionCount: 4,
    blockCount: 2,
    itemCount: 2,
    recipeOptionCount: 1
  });
  // Nessuna chiave clinica nel riepilogo: è solo un resoconto strutturale.
  assert.deepEqual(Object.keys(summary).sort(), ['blockCount', 'dayCount', 'itemCount', 'mealCount', 'optionCount', 'recipeOptionCount']);
});

test('editor console: dialog, catalogo e anteprima presenti, niente editor classico', () => {
  assert.ok(html.includes('id="diet-plan-dialog"'), 'dialog struttura dieta');
  assert.ok(html.includes('id="diet-catalog-options"'), 'datalist catalogo per autocomplete');
  assert.ok(html.includes('id="diet-plan-preview"'), 'anteprima piano');
  assert.ok(js.includes('function renderDietPlanEditor()'), 'renderer editor');
  assert.ok(js.includes('function collectDietPlanFromEditor()'), 'collettore editor');
  // L'editor «classico» v1 e il routing per flag sono stati rimossi.
  assert.doesNotMatch(js, /classicMode|classicPlan|dietPlanV1/i);
  assert.doesNotMatch(html, /choiceGroups|free-foods/i);
});

test('compatibilità: il modello v1 non ritorna né si accetta in input', () => {
  // I builder ignorano silenziosamente le chiavi v1: nessuna migrazione,
  // nessun campo clinico (kcal, macro) nel piano v2.
  const legacyLike = domain.createDietPlanDay('training', {
    label: 'Lunedì',
    target: { kcal: 2200, proteinG: 140 },
    meals: [{
      mealId: 'lunch',
      options: [{
        label: 'A', type: 'free-foods',
        items: [{ foodGroup: 'cereali', description: 'Riso', quantity: 80, unit: 'g' }],
        choiceGroups: [{ title: 'Scegli 1 tra:' }]
      }]
    }]
  });
  assert.equal(day_target(legacyLike), undefined, 'nessun target kcal');
  assert.equal(legacyLike.meals[0].options[0].label, undefined, 'etichetta opzione non persistita');
  assert.notEqual(legacyLike.meals[0].options[0].type, 'free-foods', 'tipo v1 non accettato');
  assert.equal(legacyLike.meals[0].options[0].choiceGroups, undefined, 'choiceGroups ignorati');
  // Il CSS non contiene più le classi dell'editor v1.
  assert.doesNotMatch(css, /choice-group|free-food/i);
});

function day_target(day) {
  return day.target;
}
