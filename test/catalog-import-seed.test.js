'use strict';
/* Il catalogo di import spedito con l'app deve restare valido e allineato
 * all'estratto Guide: è il file che il platform admin carica dalla sezione
 * Catalogo della console per popolare `globalIngredientCatalog/current`.
 * Se questo test fallisce, il file è da rigenerare con
 * `node functions/scripts/generate-catalog-import.js`. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const domain = require('../functions/src/domain.js');

const root = path.join(__dirname, '..');
const seedPath = path.join(root, 'docs', 'catalogo-import.json');
const text = fs.readFileSync(seedPath, 'utf8');

test('il catalogo di import è JSON con le sole chiavi ammesse dal parser', () => {
  const parsed = domain.parseCatalogPayload('json', text);
  assert.ok(parsed.ingredients.length > 0, 'almeno un ingrediente');
  assert.ok(parsed.categories.length > 0, 'almeno una categoria');
  const root = JSON.parse(text);
  assert.deepEqual(Object.keys(root).sort(), ['categories', 'ingredients'], 'nessuna chiave extra nel payload');
  // La categoria riservata non si importa: la crea il server.
  assert.equal(root.categories.some(category => category.categoryId === 'free'), false);
});

test('il catalogo di import passa la validazione server senza errori', () => {
  const parsed = domain.parseCatalogPayload('json', text);
  const report = domain.validateCatalogImport(parsed, {
    existingIngredients: {}, existingCategories: [], denylist: []
  });
  assert.deepEqual(report.errors, [], `errori di validazione: ${report.errors.join(' | ')}`);
  assert.equal(report.counts.conflicts, 0, 'nessuna collisione di alias');
  assert.equal(report.counts.create, report.normalized.ingredients.length + report.normalized.categories.length);
  // 39 famiglie guidate del motore (v3) con 154 ingredienti guidati + liberi, mai quantità.
  const guided = report.normalized.ingredients.filter(item => item.mappingKind === 'guided');
  const uniqueFamilies = [...new Set(guided.map(item => item.guideFamilyId))];
  assert.equal(uniqueFamilies.length, 39, 'tutte le famiglie guidate del motore v3');
  assert.ok(guided.length >= 39, 'almeno una per famiglia');
  guided.forEach(item => assert.ok(domain.GUIDE_FAMILY_IDS.has(item.guideFamilyId), `${item.ingredientId} → famiglia del motore`));
  const serialized = JSON.stringify(report.normalized);
  assert.doesNotMatch(serialized, /quantity|quantit|dose|grams|slots/i, 'nessuna quantità nel catalogo');
});

test('il catalogo di import resta allineato all\'estratto Guide', () => {
  const { buildImportPayload } = require('../functions/scripts/generate-catalog-import.js');
  assert.equal(`${JSON.stringify(buildImportPayload(), null, 2)}\n`, text,
    'docs/catalogo-import.json non è aggiornato: rigeneralo con functions/scripts/generate-catalog-import.js');
});
