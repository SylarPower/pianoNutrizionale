#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, '..', 'docs', 'meller-source-v3.json');
const data = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

function aliasKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMatchRegex(aliases) {
  const keys = [...new Set(aliases.map(aliasKey).filter(Boolean))];
  // sort longest first to prioritize specific
  keys.sort((a,b) => b.length - a.length);
  const escaped = keys.map(k => {
    // escape regex, but keep spaces as \s+? No, keep literal space for aliasKey match (spaces)
    // For multi-word, we want to match with space: aliasKey uses single space, so we keep space.
    // Escape then replace escaped space? Actually space doesn't need escaping.
    return escapeRegex(k);
  });
  // Join with |
  // For safety, we return pattern string without slashes
  return escaped.join('|');
}

function buildMatchLiteral(aliases) {
  const pattern = buildMatchRegex(aliases);
  // Return as /pattern/  (no flag, as original)
  // If pattern contains '/', escape
  const safe = pattern.replace(/\//g, '\\/');
  return `/${safe}/`;
}

// Generate MELLER_GRAMMATURE
let grammatureLines = [];
grammatureLines.push('  // === GENERATO DA docs/meller-source-v3.json — NON MODIFICARE A MANO ===');
grammatureLines.push('  // Ordine = priorità discendente (prima regex che matcha vince)');
grammatureLines.push('  // Dosi esplicite Pranzo A/R e Cena A/R (cena esplicita, non derivata 2/3)');
for (const fam of data.families) {
  const matchLit = buildMatchLiteral(fam.aliases);
  const labelEsc = fam.label.replace(/'/g, "\\'");
  const group = fam.group;
  const family = fam.family;
  const doses = fam.doses;
  const lunchT = doses.lunch.training;
  const lunchR = doses.lunch.rest;
  const dinnerT = doses.dinner.training;
  const dinnerR = doses.dinner.rest;
  grammatureLines.push(`    { family: '${family}', group: '${group}', label: '${labelEsc}', match: ${matchLit}, slots: { lunch: { training: ${lunchT}, rest: ${lunchR} }, dinner: { training: ${dinnerT}, rest: ${dinnerR} } } },`);
}

const grammatureCode = `  const MELLER_GROUP = {\n    CARB: 'carb',\n    PROTEIN: 'protein',\n    VEGETABLE: 'vegetable',\n    FAT: 'fat',\n    FRUIT: 'fruit',\n    DAIRY: 'dairy',\n    SWEET: 'sweet',\n    FREE: 'free'\n  };\n\n  const MELLER_GRAMMATURE = [\n${grammatureLines.join('\n')}\n  ];\n`;

// Free ingredient patterns from freeIngredients
let freePatterns = [];
for (const fi of data.freeIngredients) {
  for (const alias of fi.aliases) {
    const k = aliasKey(alias);
    if (!k) continue;
    freePatterns.push(k);
  }
}
// Deduplicate and sort longest first? Keep as regex literals
const freeUnique = [...new Set(freePatterns)];
freeUnique.sort((a,b) => b.length - a.length);
// Build as array of regex literals, grouped 6 per line
let freeLines = [];
let chunk = [];
for (let i=0;i<freeUnique.length;i++) {
  const pat = freeUnique[i];
  const esc = escapeRegex(pat).replace(/\//g, '\\/');
  chunk.push(`/${esc}/`);
  if (chunk.length>=6 || i===freeUnique.length-1) {
    freeLines.push('    ' + chunk.join(', ') + (i===freeUnique.length-1 ? '' : ','));
    chunk=[];
  }
}
const freeCode = `  // Alimenti liberi — generato da freeIngredients (nessuna dose guidata)\n  const MELLER_FREE_INGREDIENT_PATTERNS = [\n${freeLines.join('\n')}\n  ];\n`;

// MELLER_CARB_ALTERNATIVES and PROTEIN alternatives
const carbFamilies = data.families.filter(f => f.group === 'carb');
const proteinFamilies = data.families.filter(f => f.group === 'protein');
const vegFamilies = data.families.filter(f => f.group === 'vegetable');
const fatFamilies = data.families.filter(f => f.group === 'fat');

let carbAltLines = [];
for (const fam of carbFamilies) {
  const labelEsc = fam.alternativeTableLabel.replace(/'/g, "\\'");
  carbAltLines.push(`    { label: '${labelEsc}', family: '${fam.family}' },`);
}
let proteinAltLines = [];
for (const fam of proteinFamilies) {
  const labelEsc = fam.alternativeTableLabel.replace(/'/g, "\\'");
  proteinAltLines.push(`    { label: '${labelEsc}', family: '${fam.family}' },`);
}

// Reference: polloTacchino for protein, cereali for carb? Use first carb as reference? Old used pasta/riso as first.
// New: use cereali as reference for carb, polloTacchino for protein
const carbReference = carbFamilies.find(f => f.family === 'cereali') || carbFamilies[0];
const proteinReference = proteinFamilies.find(f => f.family === 'polloTacchino') || proteinFamilies[0];

const carbAltCode = `  const MELLER_CARB_ALTERNATIVES = [\n${carbAltLines.join('\n')}\n  ];\n`;
const proteinAltCode = `  const MELLER_PROTEIN_ALTERNATIVES = [\n${proteinAltLines.join('\n')}\n  ];\n`;
const proteinRefCode = `  const MELLER_PROTEIN_REFERENCE = { label: '${proteinReference.alternativeTableLabel.replace(/'/g, "\\'")}', family: '${proteinReference.family}' };\n`;

// CARB_FAMILIES for travaso
let carbFamiliesCodeLines = [];
for (const fam of carbFamilies) {
  const matchLit = buildMatchLiteral(fam.aliases);
  const labelEsc = fam.alternativeTableLabel.replace(/'/g, "\\'");
  carbFamiliesCodeLines.push(`    { key: '${fam.family}', family: '${fam.family}', label: '${labelEsc}', match: ${matchLit} },`);
}
const carbFamiliesCode = `  const CARB_FAMILIES = [\n${carbFamiliesCodeLines.join('\n')}\n  ];\n`;

// MELLER_PROTEIN_FREQUENCIES from source
let freqLines = [];
for (const f of data.proteinWeeklyFrequencies) {
  freqLines.push(`    { key: '${f.key}', label: '${f.label.replace(/'/g, "\\'")}', min: ${f.min}, max: ${f.max} },`);
}
const freqCode = `  const MELLER_PROTEIN_FREQUENCIES = [\n${freqLines.join('\n')}\n  ];\n`;

// Build catalog files
// categories from source
const categories = data.categories;

// ingredients
let ingredients = [];
for (const fam of data.families) {
  for (const ci of fam.catalogIngredients) {
    const aliases = [...new Set([...ci.aliases, ci.displayName].map(a=>a.trim()).filter(Boolean))];
    ingredients.push({
      ingredientId: ci.ingredientId,
      displayName: ci.displayName,
      aliases: aliases,
      categoryId: fam.categoryId,
      mappingKind: 'guided',
      mellerFamilyId: fam.family
    });
  }
}
for (const fi of data.freeIngredients) {
  const aliases = [...new Set([...fi.aliases, fi.displayName].map(a=>a.trim()).filter(Boolean))];
  ingredients.push({
    ingredientId: fi.ingredientId,
    displayName: fi.displayName,
    aliases: aliases,
    categoryId: fi.categoryId,
    mappingKind: 'free',
    mellerFamilyId: null
  });
}

// Sort ingredients by ingredientId
ingredients.sort((a,b)=>a.ingredientId.localeCompare(b.ingredientId));

// categories sorted by sortOrder
const sortedCategories = [...categories].sort((a,b)=> (a.sortOrder||0)-(b.sortOrder||0));

const catalogDocFull = {
  categories: sortedCategories.map(c => ({
    categoryId: c.categoryId,
    displayName: c.displayName,
    description: null,
    sortOrder: c.sortOrder
  })),
  ingredients: ingredients
};

// For import, exclude reserved 'free' category (server creates it)
const catalogDocImport = {
  categories: sortedCategories.filter(c => c.categoryId !== 'free').map(c => ({
    categoryId: c.categoryId,
    displayName: c.displayName,
    description: null,
    sortOrder: c.sortOrder
  })),
  ingredients: ingredients
};

const catalogDocPath = path.join(__dirname, '..', 'docs', 'catalogo-ingredienti-meller.json');
const catalogImportPath = path.join(__dirname, '..', 'docs', 'catalogo-import-meller.json');

fs.writeFileSync(catalogDocPath, JSON.stringify(catalogDocFull, null, 2), 'utf8');
fs.writeFileSync(catalogImportPath, JSON.stringify(catalogDocImport, null, 2), 'utf8');

console.log(`Generated ${ingredients.length} ingredients, ${categories.length} categories`);
console.log(`Wrote ${catalogDocPath}`);
console.log(`Wrote ${catalogImportPath}`);

// Now generate code snippets for js/domain.js
const outCode = `// === AUTO-GENERATED FROM docs/meller-source-v3.json ===\n${grammatureCode}\n${freeCode}\n${freqCode}\n${carbFamiliesCode}\n${carbAltCode}\n${proteinAltCode}\n${proteinRefCode}\n`;

fs.writeFileSync(path.join(__dirname, '..', 'docs', 'generated-meller-snippet.js'), outCode, 'utf8');
console.log('Wrote generated snippet');

// Generate functions/src/domain.js MELLER_FAMILY_IDS
const familyIds = data.families.map(f=>f.family);
const familyIdsCode = `const MELLER_FAMILY_IDS = new Set([\n  '${familyIds.join("', '")}'\n]);\n`;
fs.writeFileSync(path.join(__dirname, '..', 'docs', 'generated-family-ids.js'), familyIdsCode, 'utf8');
console.log('Wrote family ids');
