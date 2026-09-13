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
                label: 'A', note: '',
                items: [
                  { foodGroup: 'cereali', description: 'Riso Venere', quantity: 80, unit: 'g', quantityState: 'crudo', netOfWaste: false, alternative: 'Pasta integrale 80 g' },
                  { foodGroup: 'verdura', description: 'Zucchine', quantity: 200, unit: 'g', quantityState: null, netOfWaste: true, alternative: '' }
                ]
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
  const rules = [{ mellerFamilyId: 'riso', ingredientIds: [], quantityGrams: { lunch: { training: 80, rest: 60 }, dinner: null }, enabled: true, categoryId: null }];
  const v2 = structureRevisionChecksum({ schemaVersion: 2, rules, alternativeGroups: [] });
  assert.equal(v2, structureRevisionChecksum({ schemaVersion: 2, rules, alternativeGroups: [] }));
  assert.notEqual(v2, structureRevisionChecksum({ schemaVersion: 3, rules, alternativeGroups: [], dietPlan: plan }));
});

test('verifyStructureRevision: v1/v2 come prima, v3 con regole vuote solo se c’è il piano', () => {
  const rules = [{ mellerFamilyId: 'riso', ingredientIds: [], quantityGrams: { lunch: { training: 80, rest: 60 }, dinner: null }, enabled: true, categoryId: null }];
  const v2sum = structureRevisionChecksum({ schemaVersion: 2, rules, alternativeGroups: [] });
  assert.equal(verifyStructureRevision({ status: 'published', schemaVersion: 2, rules, alternativeGroups: [], checksum: v2sum }), true);
  assert.equal(verifyStructureRevision({ status: 'published', schemaVersion: 2, rules, alternativeGroups: [], checksum: 'x'.repeat(64) }), false);
  const plan = validateDietPlan(validPlan());
  const v3sum = structureRevisionChecksum({ schemaVersion: 3, rules: [], alternativeGroups: [], dietPlan: plan });
  assert.equal(verifyStructureRevision({ status: 'published', schemaVersion: 3, rules: [], alternativeGroups: [], dietPlan: plan, checksum: v3sum }), true);
  assert.equal(verifyStructureRevision({ status: 'published', schemaVersion: 3, rules: [], alternativeGroups: [], dietPlan: null, checksum: v3sum }), false);
  assert.equal(verifyStructureRevision({ status: 'draft', schemaVersion: 3, rules: [], alternativeGroups: [], dietPlan: plan, checksum: v3sum }), false);
});

test('regole vuote ammesse solo con piano guidato (strutture descrittive)', () => {
  assert.deepEqual(validateDietStructureRules([], { allowEmpty: true }), []);
  assert.throws(() => validateDietStructureRules([]), /tra 1 e 40/);
  assert.throws(() => validateDietStructureRules([], {}), /tra 1 e 40/);
  const rule = { mellerFamilyId: 'riso', ingredientIds: [], quantityGrams: { lunch: { training: 80, rest: 60 }, dinner: null }, enabled: true, categoryId: null };
  assert.equal(validateDietStructureRules([rule]).length, 1);
  assert.equal(validateDietStructureRules([rule], { allowEmpty: true }).length, 1);
});
