'use strict';
/* Il file di import del catalogo globale (docs/catalogo-import.json) è
 * coerente con il formato accettato dalla callable importGlobalIngredientCatalog:
 *  - solo le chiavi { categories, families, ingredients };
 *  - validazione server senza errori, nessuna collisione di alias;
 *  - identità e solo identità: nessuna dose nel payload;
 *  - il file è allineato all'estratto autorevole docs/catalogo-ingredienti.json
 *    (lo rigenera functions/scripts/generate-catalog-import.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const domain = require('../functions/src/domain.js');

const root = path.join(__dirname, '..');
const text = fs.readFileSync(path.join(root, 'docs', 'catalogo-import.json'), 'utf8');

test('il catalogo di import è JSON con le sole chiavi ammesse dal parser', () => {
  const parsed = domain.parseCatalogPayload('json', text);
  assert.ok(parsed.ingredients.length > 0, 'almeno un ingrediente');
  assert.ok(parsed.categories.length > 0, 'almeno una categoria');
  assert.ok(parsed.families.length > 0, 'almeno una famiglia');
  const rootPayload = JSON.parse(text);
  assert.deepEqual(Object.keys(rootPayload).sort(), ['categories', 'families', 'ingredients'], 'nessuna chiave extra nel payload');
  // La categoria «free» viaggia nel file: famiglie e ingredienti la
  // referenziano e il server non la crea automaticamente.
  assert.equal(rootPayload.categories.some(category => category.categoryId === 'free'), true);
});

test('il catalogo di import passa la validazione server senza errori', () => {
  const parsed = domain.parseCatalogPayload('json', text);
  const report = domain.validateCatalogImport(parsed, {
    existingIngredients: {}, existingCategories: [], existingFamilies: {}, denylist: []
  });
  assert.deepEqual(report.errors, [], `errori di validazione: ${report.errors.join(' | ')}`);
  assert.equal(report.counts.conflicts, 0, 'nessuna collisione di alias');
  assert.equal(
    report.counts.create,
    report.normalized.ingredients.length + report.normalized.categories.length + report.normalized.families.length,
    'tutto il file è di nuova creazione su catalogo vuoto'
  );
  // Identità pura: nessuna dose, porzione o frequenza nel catalogo.
  const serialized = JSON.stringify(report.normalized);
  assert.doesNotMatch(serialized, /quantity|quantit|dose|grams|slots|frequency/i, 'nessuna quantità nel catalogo');
  // Flag dietetici sempre booleani, alias ordinati.
  report.normalized.ingredients.forEach(item => {
    assert.equal(typeof item.dietaryFlags.vegetarian, 'boolean', `${item.ingredientId}: vegetarian booleano`);
    assert.equal(typeof item.dietaryFlags.vegan, 'boolean', `${item.ingredientId}: vegan booleano`);
  });
});

test('il catalogo di import resta allineato all’estratto autorevole', () => {
  const { buildImportPayload } = require('../functions/scripts/generate-catalog-import.js');
  assert.equal(`${JSON.stringify(buildImportPayload(), null, 2)}\n`, text,
    'docs/catalogo-import.json non è aggiornato: rigeneralo con functions/scripts/generate-catalog-import.js');
});

test('il generatore rifiuta estratti con campi fuori contratto', () => {
  const { buildImportPayload } = require('../functions/scripts/generate-catalog-import.js');
  // Lo schema dell'estratto è verificato: un estratto con versione sbagliata
  // non può produrre silenziosamente un file di import.
  const original = fs.readFileSync(path.join(root, 'docs', 'catalogo-ingredienti.json'), 'utf8');
  const tampered = JSON.parse(original);
  tampered.schemaVersion = 1;
  const readFileSync = fs.readFileSync;
  fs.readFileSync = (file, encoding) => String(file).endsWith('catalogo-ingredienti.json') ? JSON.stringify(tampered) : readFileSync(file, encoding);
  try {
    assert.throws(() => buildImportPayload(), /schemaVersion/);
  } finally {
    fs.readFileSync = readFileSync;
  }
});
