'use strict';
/* Dieta guidata server-side: validazione bloccante, checksum schema 3 e
 * compatibilità con le revisioni 1/2. Solo funzioni pure: nessuna rete. */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DIET_PLAN_SCHEMA_VERSION, STRUCTURE_REVISION_SCHEMA_VERSION,
  STRUCTURE_REVISION_SCHEMA_VERSION_WITH_PLAN,
  validateDietPlan, validateDietStructureRules,
  structureRevisionChecksum, verifyStructureRevision
} = require('../src/domain');
const ClientDomain = require('../../js/domain');

function validPlan() {
  return {
    schemaVersion: 1,
    generalNotes: '  Bere durante i pasti. ',
    days: [
      {
        dayId: null, label: 'Lunedì', dayType: 'training',
        target: { kcal: 2200, proteinG: 140, carbsG: 260, fatG: 70, waterMl: 2000 },
        meals: [
          {
            mealId: 'lunch', time: '12:30', note: '',
            options: [
              {
                label: 'A', type: 'free-foods', recipeId: null, recipeMultiplier: null, note: '',
                items: [
                  { foodGroup: 'cereali', description: 'Riso Venere', quantity: 80, unit: 'g' },
                  { foodGroup: 'verdura', description: 'Zucchine', quantity: 200, unit: 'g' }
                ],
                choiceGroups: [{
                  title: 'Scegli 1 carboidrato tra:', optional: true,
                  alternatives: [
                    { foodGroup: 'cereali', description: 'Riso basmati', quantity: 80, unit: 'g' },
                    { foodGroup: 'cereali', description: 'Pasta integrale', quantity: 80, unit: 'g' }
                  ]
                }]
              },
              {
                label: 'B', type: 'recipe', recipeId: 'ricetta-pollo', recipeMultiplier: 1, items: [], choiceGroups: [], note: ''
              }
            ]
          }
        ],
        supplements: '', hydration: '', note: ''
      }
    ]
  };
}

test('validateDietPlan accetta un piano valido, normalizza e restituisce null se assente', () => {
  assert.equal(DIET_PLAN_SCHEMA_VERSION, 1);
  assert.equal(validateDietPlan(null), null);
  assert.equal(validateDietPlan(undefined), null);
  const clean = validateDietPlan(validPlan());
  assert.equal(clean.schemaVersion, 1);
  assert.equal(clean.generalNotes, 'Bere durante i pasti.');
  assert.equal(clean.days.length, 1);
  assert.equal(clean.days[0].meals[0].options[0].items[0].description, 'Riso Venere');
  assert.equal(clean.days[0].meals[0].note, null);
});

test('validateDietPlan rifiuta versione, campi extra, duplicati e limiti', () => {
  assert.throws(() => validateDietPlan({ ...validPlan(), schemaVersion: 99 }), /schemaVersion/);
  assert.throws(() => validateDietPlan({ ...validPlan(), kcal: 100 }), /campi non ammessi/);
  assert.throws(() => validateDietPlan({ ...validPlan(), days: [] }), /da 1 a 14/);
  const dup = validPlan();
  dup.days[0].meals[0].options.push({ label: 'A', note: '', items: [{ foodGroup: 'altro', description: 'X', quantity: null, unit: null, quantityState: null, netOfWaste: false, alternative: '' }] });
  assert.throws(() => validateDietPlan(dup), /duplicata/);
  const badQty = validPlan();
  badQty.days[0].meals[0].options[0].items[0].quantity = 99999;
  assert.throws(() => validateDietPlan(badQty), /quantity/);
  const badUnit = validPlan();
  badUnit.days[0].meals[0].options[0].items[0].unit = 'tazzine';
  assert.throws(() => validateDietPlan(badUnit), /unit/);
  const badMeal = validPlan();
  badMeal.days[0].meals[0].mealId = 'brunch';
  assert.throws(() => validateDietPlan(badMeal), /mealId/);
  const badGroup = validPlan();
  badGroup.days[0].meals[0].options[0].items[0].foodGroup = 'sushi';
  assert.throws(() => validateDietPlan(badGroup), /foodGroup/);
  const noDesc = validPlan();
  noDesc.days[0].meals[0].options[0].items[0].description = '   ';
  assert.throws(() => validateDietPlan(noDesc), /description/);
});

test('vocabolario server allineato al client (pasti, gruppi, unità, opzioni)', () => {
  const plan = validPlan();
  plan.days[0].meals.push({
    mealId: 'evening-snack', time: '', note: '',
    options: [{ label: 'B', note: '', items: [{ foodGroup: 'frutta-secca', description: 'Noci', quantity: 20, unit: 'g', quantityState: null, netOfWaste: false, alternative: '' }] }]
  });
  const clean = validateDietPlan(plan);
  assert.equal(clean.days[0].meals[1].mealId, 'evening-snack');
  // Le etichette lette dalla console restano quelle del dominio client.
  assert.equal(ClientDomain.dietPlanMealLabel('evening-snack'), 'Spuntino serale');
  assert.equal(ClientDomain.dietPlanFoodGroupLabel('frutta-secca'), 'Frutta secca e semi');
  assert.equal(ClientDomain.validateDietPlanSoft(ClientDomain.createEmptyDietPlan(plan)).valid, true);
});

test('revisioni: schema 3 con piano, 1/2 invariati, checksum dedicato', () => {
  assert.equal(STRUCTURE_REVISION_SCHEMA_VERSION, 2);
  assert.equal(STRUCTURE_REVISION_SCHEMA_VERSION_WITH_PLAN, 3);
  const plan = validateDietPlan(validPlan());
  const v3a = structureRevisionChecksum({ schemaVersion: 3, rules: [], alternativeGroups: [], dietPlan: plan });
  const v3b = structureRevisionChecksum({ schemaVersion: 3, rules: [], alternativeGroups: [], dietPlan: plan });
  assert.equal(v3a, v3b);
  assert.equal(v3a.length, 64);
  // Il piano entra nel checksum: due piani diversi danno checksum diversi.
  const other = validateDietPlan({ ...validPlan(), generalNotes: 'Altro' });
  assert.notEqual(v3a, structureRevisionChecksum({ schemaVersion: 3, rules: [], alternativeGroups: [], dietPlan: other }));
  // Schema 2 invariato: stesso input, stesso checksum di prima.
  const rules = [{ mellerFamilyId: 'cereali', ingredientIds: [], quantityGrams: { lunch: { training: 80, rest: 60 }, dinner: null }, enabled: true, categoryId: null }];
  const v2 = structureRevisionChecksum({ schemaVersion: 2, rules, alternativeGroups: [] });
  assert.equal(v2, structureRevisionChecksum({ schemaVersion: 2, rules, alternativeGroups: [] }));
  assert.notEqual(v2, structureRevisionChecksum({ schemaVersion: 3, rules, alternativeGroups: [], dietPlan: plan }));
});

test('verifyStructureRevision: v1/v2 come prima, v3 con regole vuote solo se c’è il piano', () => {
  const rules = [{ mellerFamilyId: 'cereali', ingredientIds: [], quantityGrams: { lunch: { training: 80, rest: 60 }, dinner: null }, enabled: true, categoryId: null }];
  const v2sum = structureRevisionChecksum({ schemaVersion: 2, rules, alternativeGroups: [] });
  assert.equal(verifyStructureRevision({ status: 'published', schemaVersion: 2, rules, alternativeGroups: [], checksum: v2sum }), true);
  assert.equal(verifyStructureRevision({ status: 'published', schemaVersion: 2, rules, alternativeGroups: [], checksum: 'x'.repeat(64) }), false);
  const plan = validateDietPlan(validPlan());
  const v3sum = structureRevisionChecksum({ schemaVersion: 3, rules: [], alternativeGroups: [], dietPlan: plan });
  assert.equal(verifyStructureRevision({ status: 'published', schemaVersion: 3, rules: [], alternativeGroups: [], dietPlan: plan, checksum: v3sum }), true);
  assert.equal(verifyStructureRevision({ status: 'published', schemaVersion: 3, rules: [], alternativeGroups: [], dietPlan: null, checksum: v3sum }), false);
  assert.equal(verifyStructureRevision({ status: 'draft', schemaVersion: 3, rules: [], alternativeGroups: [], dietPlan: plan, checksum: v3sum }), false);
});

// Opzioni ricetta: recipeId obbligatorio, moltiplicatore 0,1–10, nessun item.
test('opzioni ricetta: recipeId + moltiplicatore, tipi mutuamente esclusivi', () => {
  const plan = validPlan();
  plan.days[0].meals[0].options[0] = {
    label: 'A', type: 'recipe', recipeId: 'ricetta-1', recipeMultiplier: 1.5, items: [], choiceGroups: [], note: ''
  };
  const clean = validateDietPlan(plan);
  const option = clean.days[0].meals[0].options[0];
  assert.equal(option.type, 'recipe');
  assert.equal(option.recipeId, 'ricetta-1');
  assert.equal(option.recipeMultiplier, 1.5);
  assert.deepEqual(option.items, []);
  assert.deepEqual(option.choiceGroups, []);
  // Senza recipeId: rifiutato.
  const noRecipe = validPlan();
  noRecipe.days[0].meals[0].options[0] = { label: 'A', type: 'recipe', recipeId: '', items: [], choiceGroups: [], note: '' };
  assert.throws(() => validateDietPlan(noRecipe), /recipeId/);
  // Moltiplicatore fuori scala: rifiutato.
  const badMult = validPlan();
  badMult.days[0].meals[0].options[0] = { label: 'A', type: 'recipe', recipeId: 'ricetta-1', recipeMultiplier: 0.01, items: [], choiceGroups: [], note: '' };
  assert.throws(() => validateDietPlan(badMult), /recipeMultiplier/);
  // Con lista alimenti: rifiutato (tipi esclusivi).
  const mixed = validPlan();
  mixed.days[0].meals[0].options[0] = { label: 'A', type: 'recipe', recipeId: 'ricetta-1', items: [{ foodGroup: 'carne', description: 'X', quantity: null, unit: null }], note: '' };
  assert.throws(() => validateDietPlan(mixed), /items/);
  // recipeId su opzione alimenti: rifiutato.
  const stray = validPlan();
  stray.days[0].meals[0].options[0].recipeId = 'ricetta-1';
  assert.throws(() => validateDietPlan(stray), /recipeId/);
  // Type assurdo: rifiutato.
  const badType = validPlan();
  badType.days[0].meals[0].options[0].type = 'mist';
  assert.throws(() => validateDietPlan(badType), /type/);
});

// Opzioni senza `type`: revisioni precedenti, restano «free-foods».
test('opzioni legacy senza type: normalizzate «free-foods»', () => {
  const plan = validPlan();
  delete plan.days[0].meals[0].options[0].type;
  const clean = validateDietPlan(plan);
  assert.equal(clean.days[0].meals[0].options[0].type, 'free-foods');
  assert.equal(clean.days[0].meals[0].options[0].recipeId, null);
  assert.equal(clean.days[0].meals[0].options[0].recipeMultiplier, null);
  assert.equal(clean.days[0].meals[0].options[0].choiceGroups.length, 1, 'i gruppi scelta della voce legacy si conservano');
});

// Campi peso rimossi: le revisioni vecchie restano valide (round-trip), i
// nuovi piani non li producono più.
test('campi peso legacy: quantityState/netOfWaste/alternative tollerati e conservati', () => {
  const plan = validPlan();
  plan.days[0].meals[0].options[0].items[0].quantityState = 'crudo';
  plan.days[0].meals[0].options[0].items[0].netOfWaste = true;
  plan.days[0].meals[0].options[0].items[0].alternative = 'Pasta integrale 80 g';
  const clean = validateDietPlan(plan);
  const item = clean.days[0].meals[0].options[0].items[0];
  assert.equal(item.quantityState, 'crudo');
  assert.equal(item.netOfWaste, true);
  assert.equal(item.alternative, 'Pasta integrale 80 g');
  // Il valore legacy non valido resta un errore.
  const bad = validPlan();
  bad.days[0].meals[0].options[0].items[0].quantityState = 'surgelato';
  assert.throws(() => validateDietPlan(bad), /quantityState/);
  // Senza campi legacy l'item normalizzato ha solo la forma nuova.
  const fresh = validateDietPlan(validPlan());
  assert.deepEqual(Object.keys(fresh.days[0].meals[0].options[0].items[0]).sort(), ['description', 'foodGroup', 'quantity', 'unit']);
});

// Gruppi scelta: titolo + alternative, scelta facoltativa di default.
test('gruppi scelta: validati con limite alternative e scelta facoltativa', () => {
  const plan = validPlan();
  const clean = validateDietPlan(plan);
  const group = clean.days[0].meals[0].options[0].choiceGroups[0];
  assert.equal(group.title, 'Scegli 1 carboidrato tra:');
  assert.equal(group.optional, true);
  assert.equal(group.alternatives.length, 2);
  assert.deepEqual(Object.keys(group.alternatives[0]).sort(), ['description', 'foodGroup', 'quantity', 'unit']);
  // Senza titolo: rifiutato.
  const noTitle = validPlan();
  noTitle.days[0].meals[0].options[0].choiceGroups[0].title = ' ';
  assert.throws(() => validateDietPlan(noTitle), /title/);
  // Senza alternative: rifiutato.
  const noAlts = validPlan();
  noAlts.days[0].meals[0].options[0].choiceGroups[0].alternatives = [];
  assert.throws(() => validateDietPlan(noAlts), /alternatives/);
  // Troppi gruppi: rifiutato.
  const tooMany = validPlan();
  tooMany.days[0].meals[0].options[0].choiceGroups = [
    { title: 'G1', alternatives: [{ foodGroup: 'cereali', description: 'Riso', quantity: 80, unit: 'g' }] },
    { title: 'G2', alternatives: [{ foodGroup: 'cereali', description: 'Pasta', quantity: 80, unit: 'g' }] },
    { title: 'G3', alternatives: [{ foodGroup: 'cereali', description: 'Pane', quantity: 80, unit: 'g' }] },
    { title: 'G4', alternatives: [{ foodGroup: 'cereali', description: 'Farro', quantity: 80, unit: 'g' }] }
  ];
  assert.throws(() => validateDietPlan(tooMany), /choiceGroups/);
  // optional esplicito false resta false.
  const mandatory = validPlan();
  mandatory.days[0].meals[0].options[0].choiceGroups[0].optional = false;
  assert.equal(validateDietPlan(mandatory).days[0].meals[0].options[0].choiceGroups[0].optional, false);
});

// Opzione completamente vuota: rifiutata anche lato server.
test('opzione senza alimenti e senza gruppi: rifiutata', () => {
  const plan = validPlan();
  plan.days[0].meals[0].options[0].items = [];
  plan.days[0].meals[0].options[0].choiceGroups = [];
  assert.throws(() => validateDietPlan(plan), /almeno un alimento/);
});

test('regole vuote ammesse solo con piano guidato (strutture descrittive)', () => {
  assert.deepEqual(validateDietStructureRules([], { allowEmpty: true }), []);
  assert.throws(() => validateDietStructureRules([]), /tra 1 e 40/);
  assert.throws(() => validateDietStructureRules([], {}), /tra 1 e 40/);
  const rule = { mellerFamilyId: 'cereali', ingredientIds: [], quantityGrams: { lunch: { training: 80, rest: 60 }, dinner: null }, enabled: true, categoryId: null };
  assert.equal(validateDietStructureRules([rule]).length, 1);
  assert.equal(validateDietStructureRules([rule], { allowEmpty: true }).length, 1);
});
