'use strict';
/**
 * Genera il file di import del catalogo globale ingredienti a partire
 * dall'estratto autorevole `docs/catalogo-ingredienti.json`
 * (fonte: `GUIDE_GRAMMATURE` in `js/domain.js`).
 *
 * Il risultato segue il formato descritto in `docs/catalog-import-format.md`
 * ed è quello che il platform admin carica dalla sezione **Catalogo** della
 * console (`importGlobalIngredientCatalog`, prima dry-run e poi commit).
 *
 * Uso:
 *   node functions/scripts/generate-catalog-import.js            # scrive il file
 *   node functions/scripts/generate-catalog-import.js --check     # verifica che sia aggiornato
 *
 * Nessuna quantità entra nel catalogo: le dosi restano nelle strutture dieta.
 * La categoria riservata `free` non si importa (la crea il server), ma gli
 * ingredienti liberi possono referenziarla.
 */
const fs = require('node:fs');
const path = require('node:path');
const Domain = require('../../js/domain');

const ROOT = path.join(__dirname, '..', '..');
const EXTRACT = path.join(ROOT, 'docs', 'catalogo-ingredienti.json');
const OUTPUT = path.join(ROOT, 'docs', 'catalogo-import.json');

// Il motore delle linee guida usa tre famiglie con lettere maiuscole (`pesceBianco`,
// `pesceOmega`, `fiocchiLatte`): restano identiche in `guideFamilyId`, mentre
// l'`ingredientId` del catalogo segue il contratto del server
// (`^[a-z0-9][a-z0-9-]{1,95}$`) → `pesce-bianco`, `pesce-omega`, `fiocchi-latte`.
// Riconoscimento delle ricette e dosi non dipendono dall'uguaglianza fra i due
// identificativi: alias e famiglia restano quelli del motore.
function catalogIngredientId(familyId) {
  return String(familyId)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildImportPayload() {
  const extract = JSON.parse(fs.readFileSync(EXTRACT, 'utf8'));
  const seed = Domain.splitGuideSeed(extract);
  const categories = seed.categories
    .filter(category => category.categoryId !== 'free')
    .map(category => ({
      categoryId: category.categoryId,
      displayName: category.displayName,
      description: category.description ?? null,
      sortOrder: Number(category.sortOrder || 0)
    }));
  const ingredients = seed.ingredients.map(ingredient => ({
    ingredientId: catalogIngredientId(ingredient.ingredientId),
    displayName: ingredient.displayName,
    aliases: [...(ingredient.aliases || [])].sort((a, b) => a.localeCompare(b)),
    categoryId: ingredient.categoryId,
    mappingKind: ingredient.mappingKind,
    guideFamilyId: ingredient.mappingKind === 'guided' ? ingredient.guideFamilyId : null
  })).sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
  // Il payload accettato da `importGlobalIngredientCatalog` è esattamente
  // `{ ingredients, categories }`: il parser server rifiuta chiavi extra.
  const payload = { categories, ingredients };
  const ids = new Set();
  ingredients.forEach(ingredient => {
    if (!/^[a-z0-9][a-z0-9-]{1,95}$/.test(ingredient.ingredientId)) {
      throw new Error(`ingredientId non conforme al contratto server: ${ingredient.ingredientId}`);
    }
    if (ids.has(ingredient.ingredientId)) throw new Error(`ingredientId duplicato: ${ingredient.ingredientId}`);
    ids.add(ingredient.ingredientId);
    const known = categories.some(category => category.categoryId === ingredient.categoryId) || ingredient.categoryId === 'free';
    if (!known) throw new Error(`categoria inesistente per ${ingredient.ingredientId}: ${ingredient.categoryId}`);
  });
  return payload;
}

function serialize(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

if (require.main === module) {
  const payload = buildImportPayload();
  const next = serialize(payload);
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (current !== next) {
      console.error('docs/catalogo-import.json non è aggiornato: esegui node functions/scripts/generate-catalog-import.js');
      process.exitCode = 1;
    } else {
      console.log(`Catalogo di import aggiornato: ${payload.ingredients.length} ingredienti, ${payload.categories.length} categorie.`);
    }
  } else {
    fs.writeFileSync(OUTPUT, next);
    console.log(`Scritto docs/catalogo-import.json: ${payload.ingredients.length} ingredienti, ${payload.categories.length} categorie.`);
  }
}

module.exports = { buildImportPayload, OUTPUT };
