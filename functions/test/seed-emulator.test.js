'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const domain = require('../src/domain');

// Carica scripts/seed-emulator.js senza firebase-admin installato: lo stub
// replica l'interfaccia usata dallo script e main() non parte (require.main
// è null nel contesto VM).
function loadSeed() {
  const context = {
    exports: {}, module: { exports: {} }, console, process: { env: {} },
    __dirname: path.join(__dirname, '..', 'scripts'), __filename: 'seed-emulator.js',
    setTimeout, clearTimeout,
    require(name) {
      if (name === '../src/domain') return domain;
      if (name === 'node:fs') return fs;
      if (name === 'node:path') return path;
      if (name === 'firebase-admin/app') return { initializeApp() { throw new Error('non in test'); } };
      if (name === 'firebase-admin/auth') return { getAuth() { throw new Error('non in test'); } };
      if (name === 'firebase-admin/firestore') return { getFirestore() { throw new Error('non in test'); }, FieldValue: {} };
      throw new Error(`Unexpected dependency ${name}`);
    }
  };
  context.require.main = null;
  context.module.exports = context.exports;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/seed-emulator.js'), 'utf8'), context, { filename: 'seed-emulator.js' });
  return context.module.exports;
}

test('seed: catalogo, template e struttura validi per costruzione', () => {
  const { buildSeedData } = loadSeed();
  const data = buildSeedData();
  assert.equal(data.categories.length, 6); // include la categoria riservata 'free'
  assert.equal(data.families.length, 49);
  assert.equal(data.ingredients.length, 229);
  // Checksum ricalcolati con le stesse funzioni del server
  assert.equal(data.templateChecksum, domain.equivalenceTemplateRevisionChecksum(data.templateRevision));
  assert.equal(data.structureChecksum, domain.structureRevisionChecksum({ schemaVersion: domain.STRUCTURE_REVISION_SCHEMA_VERSION, dietPlan: data.dietPlan }));
  // Sommario contatori coerente col piano
  assert.equal(data.summary.dayCount, 2);
  assert.equal(data.summary.mealCount, 8);
  assert.equal(data.summary.recipeOptionCount, 0);
});

test('seed: ogni riferimento del dietPlan esiste nel catalogo globale', () => {
  const { buildSeedData } = loadSeed();
  const { dietPlan } = buildSeedData();
  const extract = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/catalogo-ingredienti.json'), 'utf8'));
  const ingredientIds = new Set(extract.ingredients.map(item => item.ingredientId));
  const familyIds = new Set(extract.families.map(item => item.familyId));
  const assertFamily = (familyId, where) => assert.ok(familyIds.has(familyId), `${where}: famiglia ${familyId} non in catalogo`);
  const assertIngredient = (ingredientId, where) => assert.ok(ingredientIds.has(ingredientId), `${where}: ingrediente ${ingredientId} non in catalogo`);
  dietPlan.days.forEach(day => day.meals.forEach(meal => meal.options.forEach(option => {
    (option.blocks || []).forEach(block => {
      assertFamily(block.referenceFamilyId, `${day.dayId}/${meal.mealId}`);
      if (block.referenceIngredientId) assertIngredient(block.referenceIngredientId, `${day.dayId}/${meal.mealId}`);
      (block.templateSnapshot?.equivalents || []).forEach(equivalent => {
        assertFamily(equivalent.familyId, `${day.dayId}/${meal.mealId}/template`);
        if (equivalent.ingredientId) assertIngredient(equivalent.ingredientId, `${day.dayId}/${meal.mealId}/template`);
      });
      (block.overrides || []).forEach(override => {
        assertFamily(override.familyId, `${day.dayId}/${meal.mealId}/override`);
        if (override.ingredientId) assertIngredient(override.ingredientId, `${day.dayId}/${meal.mealId}/override`);
      });
    });
    (option.items || []).forEach(item => assertIngredient(item.ingredientId, `${day.dayId}/${meal.mealId}/items`));
  })));
});

test('seed: blocco con template ha snapshot fissato e override esplicito', () => {
  const { buildSeedData, SEED_TEMPLATE } = loadSeed();
  const { dietPlan, templateRevision } = buildSeedData();
  const block = dietPlan.days[0].meals.find(meal => meal.mealId === 'lunch').options[0].blocks[0];
  assert.equal(block.templateId, 'tpl-amidi-cereali');
  assert.equal(block.templateSnapshot.revisionId, '1');
  assert.deepEqual(block.templateSnapshot.equivalents, templateRevision.equivalents);
  // L'override esplicito della struttura vince sul template (gnocchi 150g vs 120g)
  const gnocchiTemplate = SEED_TEMPLATE.equivalents.find(equivalent => equivalent.familyId === 'gnocchi');
  const gnocchiOverride = block.overrides.find(override => override.familyId === 'gnocchi');
  assert.equal(gnocchiTemplate.amount.value, 120);
  assert.equal(gnocchiOverride.amount.value, 150);
});

test('seed: il catalogo resta identità pura (nessuna dose)', () => {
  const { buildSeedData } = loadSeed();
  const { ingredients, families, categories } = buildSeedData();
  const identityOnly = /quantit|grams?|doses?|slots?|portions?|kgs?|millilit|calor/i;
  [...ingredients, ...families, ...categories].forEach(entry => {
    Object.keys(entry).forEach(key => assert.ok(!identityOnly.test(key), `campo dose nel catalogo: ${key}`));
  });
  ingredients.forEach(ingredient => {
    assert.deepEqual(Object.keys(ingredient).sort(), ['aliases', 'categoryId', 'dietaryFlags', 'displayName', 'familyId', 'ingredientId', 'status']);
    assert.equal(typeof ingredient.dietaryFlags.vegetarian, 'boolean');
    assert.equal(typeof ingredient.dietaryFlags.vegan, 'boolean');
  });
});
