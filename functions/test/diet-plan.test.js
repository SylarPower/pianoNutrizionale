'use strict';
/* Strutture dieta lato server — modello v2 (dietPlan schema 2, revisioni
 * schema 4): opzioni a blocchi famiglia / ingredienti / ricetta, template
 * equivalenze agganciati con snapshot non retroattivo, override espliciti.
 * Il vocabolario resta allineato a js/domain.js (unica fonte condivisa). */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DIET_PLAN_SCHEMA_VERSION, DIET_PLAN_MEAL_IDS, DIET_PLAN_UNITS, DIET_PLAN_OPTION_TYPES,
  DIET_PLAN_DAY_TYPES, DIET_PLAN_LIMITS, validateDietPlan,
  STRUCTURE_REVISION_SCHEMA_VERSION, structureRevisionChecksum, verifyStructureRevision,
  EQUIVALENCE_TEMPLATE_SCHEMA_VERSION
} = require('../src/domain');
const ClientDomain = require('../../js/domain');

function amount(value, unit = 'g') { return { value, unit }; }

function validPlan() {
  return {
    schemaVersion: DIET_PLAN_SCHEMA_VERSION,
    generalNotes: '  Bere durante i pasti. ',
    days: [
      {
        dayId: 'giorno-allenamento', label: 'Giorno di allenamento', dayType: 'training',
        meals: [
          {
            mealId: 'lunch', time: '12:30', note: '',
            options: [
              {
                optionId: 'pranzo-blocchi', type: 'family-block',
                blocks: [
                  {
                    blockId: 'amidi-riso', referenceFamilyId: 'cereali', referenceIngredientId: 'riso',
                    referenceAmount: amount(80),
                    templateId: 'tpl-amidi',
                    templateSnapshot: {
                      revisionId: '1',
                      referenceAmount: amount(80),
                      equivalents: [{ familyId: 'patate', ingredientId: 'patate', amount: amount(250) }]
                    },
                    overrides: [{ familyId: 'gnocchi', ingredientId: null, amount: amount(150) }]
                  },
                  { blockId: 'verdura', referenceFamilyId: 'verdura', referenceIngredientId: 'zucchine', referenceAmount: amount(200), templateId: null, templateSnapshot: null, overrides: [] }
                ]
              },
              {
                optionId: 'pranzo-ricetta', type: 'recipe', recipeId: 'ricetta-pollo', recipeMultiplier: 1.5, note: ''
              }
            ]
          },
          {
            mealId: 'breakfast', time: '',
            options: [
              {
                optionId: 'colazione', type: 'ingredients',
                items: [{ itemId: 'avena', ingredientId: 'avena', amount: amount(60, 'g') }]
              }
            ]
          }
        ],
        supplements: 'Vitamina D', hydration: '2 litri', note: ''
      }
    ]
  };
}

test('validateDietPlan accetta un piano valido e lo normalizza', () => {
  const parsed = validateDietPlan(validPlan());
  assert.equal(parsed.generalNotes, 'Bere durante i pasti.');
  assert.equal(parsed.days[0].dayType, 'training');
  assert.equal(parsed.days[0].meals[0].options[1].recipeMultiplier, 1.5);
  // Il blocco template mantiene snapshot e override espliciti.
  const block = parsed.days[0].meals[0].options[0].blocks[0];
  assert.equal(block.templateId, 'tpl-amidi');
  assert.equal(block.templateSnapshot.revisionId, '1');
  assert.equal(block.overrides.length, 1);
});

test('validateDietPlan rifiuta versione, campi extra, duplicati e limiti', () => {
  assert.throws(() => validateDietPlan(null), /dietPlan mancante/);
  assert.throws(() => validateDietPlan({ ...validPlan(), schemaVersion: 1 }), /schemaVersion/);
  assert.throws(() => validateDietPlan({ ...validPlan(), extra: 1 }), /campi non ammessi/);
  // dayId duplicato
  const dupDay = validPlan();
  dupDay.days.push(JSON.parse(JSON.stringify(dupDay.days[0])));
  assert.throws(() => validateDietPlan(dupDay), /dayId duplicato/);
  // Pasto duplicato
  const dupMeal = validPlan();
  dupMeal.days[0].meals.push(JSON.parse(JSON.stringify(dupMeal.days[0].meals[0])));
  assert.throws(() => validateDietPlan(dupMeal), /pasto duplicato/);
  // opzione duplicata
  const dupOption = validPlan();
  dupOption.days[0].meals[0].options.push(JSON.parse(JSON.stringify(dupOption.days[0].meals[0].options[0])));
  assert.throws(() => validateDietPlan(dupOption), /optionId duplicato/);
  // limite giornate
  const tooManyDays = validPlan();
  tooManyDays.days = Array.from({ length: DIET_PLAN_LIMITS.days + 1 }, () => JSON.parse(JSON.stringify(validPlan().days[0])));
  assert.throws(() => validateDietPlan(tooManyDays), /giornate/);
  // tipo giornata e pasto sconosciuti
  const badDayType = validPlan();
  badDayType.days[0].dayType = 'sconosciuto';
  assert.throws(() => validateDietPlan(badDayType), /dayType/);
  const badMeal = validPlan();
  badMeal.days[0].meals[0].mealId = 'brunch';
  assert.throws(() => validateDietPlan(badMeal), /mealId/);
});

test('vocabolario server allineato al client (pasti, unità, tipi opzione)', () => {
  assert.equal(DIET_PLAN_SCHEMA_VERSION, ClientDomain.DIET_PLAN_SCHEMA_VERSION);
  assert.deepEqual([...DIET_PLAN_MEAL_IDS], ClientDomain.DIET_PLAN_MEALS.map(meal => meal.id));
  assert.deepEqual([...DIET_PLAN_UNITS], ClientDomain.DIET_PLAN_UNITS.map(unit => unit.id));
  assert.deepEqual([...DIET_PLAN_OPTION_TYPES], ClientDomain.DIET_PLAN_OPTION_TYPES.map(type => type.id));
  assert.deepEqual([...DIET_PLAN_DAY_TYPES], ClientDomain.DIET_PLAN_DAY_TYPES);
  // Le etichette A–D non si persistono: restano una derivazione di UI.
  assert.equal(DIET_PLAN_LIMITS.optionsPerMeal, 4);
});

test('revisioni struttura: checksum dedicato e verifica fail-closed', () => {
  const dietPlan = validateDietPlan(validPlan());
  const checksum = structureRevisionChecksum({ schemaVersion: STRUCTURE_REVISION_SCHEMA_VERSION, dietPlan });
  assert.equal(verifyStructureRevision({
    schemaVersion: STRUCTURE_REVISION_SCHEMA_VERSION, status: 'published', dietPlan, checksum
  }), true);
  // Contenuto diverso → checksum diverso → verifica negativa.
  assert.equal(verifyStructureRevision({
    schemaVersion: STRUCTURE_REVISION_SCHEMA_VERSION, status: 'published',
    dietPlan: { ...dietPlan, generalNotes: 'altre note' }, checksum
  }), false);
  // Schema obsoleto e stato non pubblicato: rifiutati.
  assert.equal(verifyStructureRevision({ schemaVersion: 2, status: 'published', dietPlan, checksum }), false);
  assert.equal(verifyStructureRevision({ schemaVersion: STRUCTURE_REVISION_SCHEMA_VERSION, status: 'draft', dietPlan, checksum }), false);
});

test('opzioni ricetta: recipeId + moltiplicatore, tipi mutuamente esclusivi', () => {
  const base = validPlan();
  // Ricetta senza id rifiutata; moltiplicatore fuori scala rifiutato.
  const noId = validPlan();
  noId.days[0].meals[0].options[1].recipeId = null;
  assert.throws(() => validateDietPlan(noId), /recipeId obbligatorio/);
  const badMultiplier = validPlan();
  badMultiplier.days[0].meals[0].options[1].recipeMultiplier = 42;
  assert.throws(() => validateDietPlan(badMultiplier), /recipeMultiplier/);
  // Blocchi/ingredienti mai insieme alla ricetta.
  const mixed = validPlan();
  mixed.days[0].meals[0].options[1].blocks = base.days[0].meals[0].options[0].blocks;
  assert.throws(() => validateDietPlan(mixed), /non contengono blocchi né ingredienti/);
  // recipeId fuori dalle opzioni ricetta rifiutato.
  const strayRecipe = validPlan();
  strayRecipe.days[0].meals[0].options[0].recipeId = 'r-x';
  assert.throws(() => validateDietPlan(strayRecipe), /recipeId non ammesso/);
});

test('blocchi famiglia: template snapshot coerente e override espliciti', () => {
  // Snapshot senza templateId rifiutato.
  const noTemplate = validPlan();
  delete noTemplate.days[0].meals[0].options[0].blocks[0].templateId;
  assert.throws(() => validateDietPlan(noTemplate), /templateSnapshot presente senza templateId/);
  // templateId senza snapshot rifiutato.
  const noSnapshot = validPlan();
  noSnapshot.days[0].meals[0].options[0].blocks[0].templateSnapshot = null;
  assert.throws(() => validateDietPlan(noSnapshot), /templateSnapshot mancante/);
  // L'override non può puntare alla famiglia di riferimento del blocco.
  const selfOverride = validPlan();
  selfOverride.days[0].meals[0].options[0].blocks[0].overrides = [{ familyId: 'cereali', ingredientId: null, amount: amount(90) }];
  assert.throws(() => validateDietPlan(selfOverride), /famiglia di riferimento del blocco non è un override/);
  // Override duplicato per stessa famiglia+ingrediente rifiutato.
  const dupOverride = validPlan();
  dupOverride.days[0].meals[0].options[0].blocks[0].overrides = [
    { familyId: 'gnocchi', ingredientId: null, amount: amount(150) },
    { familyId: 'gnocchi', ingredientId: null, amount: amount(120) }
  ];
  assert.throws(() => validateDietPlan(dupOverride), /override duplicato/);
  // Quantità del template: equivalenti da 1 a 30, famiglia duplicata rifiutata.
  const dupEquivalent = validPlan();
  dupEquivalent.days[0].meals[0].options[0].blocks[0].templateSnapshot.equivalents.push(
    { familyId: 'patate', ingredientId: null, amount: amount(100) }
  );
  assert.throws(() => validateDietPlan(dupEquivalent), /famiglia equivalente duplicata/);
  // La quantità di riferimento del template deve essere positiva.
  const zeroRef = validPlan();
  zeroRef.days[0].meals[0].options[0].blocks[0].templateSnapshot.referenceAmount = amount(0);
  assert.throws(() => validateDietPlan(zeroRef), /maggiore di zero/);
});

test('opzione ingredienti: item con ingredientId e quantità obbligatorie', () => {
  const noItems = validPlan();
  noItems.days[0].meals[1].options[0].items = [];
  assert.throws(() => validateDietPlan(noItems), /almeno un ingrediente/);
  const badItem = validPlan();
  badItem.days[0].meals[1].options[0].items = [{ itemId: 'x', ingredientId: '', amount: amount(10) }];
  assert.throws(() => validateDietPlan(badItem), /ingredientId/);
  const noAmount = validPlan();
  noAmount.days[0].meals[1].options[0].items = [{ itemId: 'x', ingredientId: 'avena', amount: { value: null, unit: 'g' } }];
  assert.throws(() => validateDietPlan(noAmount), /amount.value/);
});

test('opzione family-block senza blocchi rifiutata, niente normalizzazioni legacy', () => {
  const empty = validPlan();
  empty.days[0].meals[0].options[0].blocks = [];
  assert.throws(() => validateDietPlan(empty), /almeno un blocco/);
  // Il vecchio vocabolario v1 (choiceGroups, free-foods, label opzione,
  // target kcal) non è accettato né tollerato: nessun campo extra.
  const legacy = validPlan();
  legacy.days[0].meals[0].options[0].choiceGroups = [];
  assert.throws(() => validateDietPlan(legacy), /campi non ammessi/);
  const legacyTarget = validPlan();
  legacyTarget.days[0].target = { kcal: 2200 };
  assert.throws(() => validateDietPlan(legacyTarget), /campi non ammessi/);
});
