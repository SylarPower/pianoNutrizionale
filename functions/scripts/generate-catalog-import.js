'use strict';
/**
 * Genera il file di import del catalogo globale ingredienti a partire
 * dall'estratto autorevole `docs/catalogo-ingredienti.json` (schema 2:
 * identità e solo identità — nomi, alias, categorie, famiglie, flag dietetici).
 *
 * Il risultato segue il formato accettato da `importGlobalIngredientCatalog`
 * (vedi docs/catalog-import-format.md): `{ ingredients, categories, families }`
 * con SOLO i campi riconosciuti dal validatore server. I `searchTokens` della
 * fonte NON si importano: l'indice di ricerca li rigenera dal nome e dagli
 * alias quando servono.
 *
 * Uso:
 *   node functions/scripts/generate-catalog-import.js            # scrive il file
 *   node functions/scripts/generate-catalog-import.js --check     # verifica che sia aggiornato
 *
 * Nessuna quantità entra nel catalogo: le dosi appartengono ai template
 * equivalenze e alle strutture dieta (organization-scoped). Tutte le
 * categorie dell'estratto viaggiano nel file, «free» compresa: il server
 * non la crea automaticamente e famiglie/ingredienti la referenziano.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const EXTRACT = path.join(ROOT, 'docs', 'catalogo-ingredienti.json');
const OUTPUT = path.join(ROOT, 'docs', 'catalogo-import.json');

const CATEGORY_FIELDS = ['categoryId', 'displayName', 'description', 'sortOrder', 'status'];
const FAMILY_FIELDS = ['familyId', 'displayName', 'categoryId', 'sortOrder', 'status'];
const INGREDIENT_FIELDS = ['ingredientId', 'displayName', 'aliases', 'categoryId', 'familyId', 'dietaryFlags', 'status'];

const pick = (entry, fields) => Object.fromEntries(
  fields.filter(field => entry[field] !== undefined && entry[field] !== null).map(field => [field, entry[field]])
);

function buildImportPayload() {
  const extract = JSON.parse(fs.readFileSync(EXTRACT, 'utf8'));
  if (Number(extract.schemaVersion) !== 2) {
    throw new Error(`Fonte con schemaVersion ${extract.schemaVersion}: attesa 2 (docs/catalogo-ingredienti.json)`);
  }
  const categories = (extract.categories || [])
    .map(category => pick(category, CATEGORY_FIELDS))
    .sort((a, b) => String(a.categoryId).localeCompare(String(b.categoryId)));
  const families = (extract.families || [])
    .map(family => pick(family, FAMILY_FIELDS))
    .sort((a, b) => String(a.familyId).localeCompare(String(b.familyId)));
  const ingredients = (extract.ingredients || [])
    .map(ingredient => {
      const clean = pick(ingredient, INGREDIENT_FIELDS);
      clean.aliases = [...(clean.aliases || [])].sort();
      return clean;
    })
    .sort((a, b) => String(a.ingredientId).localeCompare(String(b.ingredientId)));

  // Verifiche di coerenza (stesse regole del server, fallimento anticipato).
  const ids = new Set();
  const categoryIds = new Set(categories.map(category => category.categoryId));
  const familyIds = new Set(families.map(family => family.familyId));
  ingredients.forEach(ingredient => {
    if (!/^[a-z0-9][a-z0-9-]{1,95}$/.test(ingredient.ingredientId)) {
      throw new Error(`ingredientId non conforme al contratto server: ${ingredient.ingredientId}`);
    }
    if (ids.has(ingredient.ingredientId)) throw new Error(`ingredientId duplicato: ${ingredient.ingredientId}`);
    ids.add(ingredient.ingredientId);
    if (!categoryIds.has(ingredient.categoryId) && ingredient.categoryId !== 'free') {
      throw new Error(`categoria inesistente per ${ingredient.ingredientId}: ${ingredient.categoryId}`);
    }
    if (ingredient.familyId && !familyIds.has(ingredient.familyId)) {
      throw new Error(`famiglia inesistente per ${ingredient.ingredientId}: ${ingredient.familyId}`);
    }
  });
  families.forEach(family => {
    if (family.categoryId && !categoryIds.has(family.categoryId) && family.categoryId !== 'free') {
      throw new Error(`categoria inesistente per la famiglia ${family.familyId}: ${family.categoryId}`);
    }
  });
  return { categories, families, ingredients };
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
      console.log(`Catalogo di import aggiornato: ${payload.ingredients.length} ingredienti, ${payload.categories.length} categorie, ${payload.families.length} famiglie.`);
    }
  } else {
    fs.writeFileSync(OUTPUT, next);
    console.log(`Scritto docs/catalogo-import.json: ${payload.ingredients.length} ingredienti, ${payload.categories.length} categorie, ${payload.families.length} famiglie.`);
  }
}

module.exports = { buildImportPayload, OUTPUT };
