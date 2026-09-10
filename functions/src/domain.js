'use strict';

const crypto = require('node:crypto');

const ROLES = new Set(['admin', 'nutritionist']);
const REPORT_STATUSES = new Set(['open', 'triaged', 'needs-review', 'resolved', 'rejected', 'duplicate']);
const ASSIGNMENT_STATUSES = new Set(['scheduled', 'active', 'suspended', 'revoked', 'expired']);
const ASSIGNMENT_STRATEGIES = new Set(['freeze', 'migrate-on-confirmation', 'original-only']);
const MAPPING_KINDS = new Set(['guided', 'free']);
const GROUPS = new Set(['carb', 'protein', 'dairy', 'fat', 'sweet', 'fruit', 'free']);

// ID delle 25 famiglie del motore Meller (js/domain.js → MELLER_GRAMMATURE).
// SOLO identificativi: nessuna quantità, nessuna dose, nessuna regola di
// riconoscimento. Il server li usa per rifiutare strutture/catalogo che
// puntano a famiglie inesistenti nel motore; la parità con il client è
// verificata dai test (functions/test/domain.test.js). Se il manuale aggiunge
// una famiglia, aggiornare qui + engine + catalogo nello stesso deploy.
const MELLER_FAMILY_IDS = new Set([
  'gnocchi', 'polenta', 'piadina', 'pseudo', 'couscous', 'farroorzo', 'pasta',
  'riso', 'crackers', 'patate', 'pane', 'pollame', 'manzo', 'maiale', 'salumi',
  'pesceOmega', 'molluschi', 'tonno', 'pesceBianco', 'legumotti', 'legumi',
  'uova', 'fiocchiLatte', 'formaggi', 'olio'
]);

const MEMBER_STATUSES = new Set(['active', 'suspended', 'removed']);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function exactObject(value, allowed, name = 'payload') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-argument', `${name} non valido`);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) fail('invalid-argument', `${name}: campi non ammessi (${extra.join(', ')})`);
  return value;
}

function text(value, name, { min = 1, max = 160, pattern = null } = {}) {
  if (typeof value !== 'string') fail('invalid-argument', `${name} non valido`);
  const clean = value.trim();
  if (clean.length < min || clean.length > max || (pattern && !pattern.test(clean))) {
    fail('invalid-argument', `${name} non valido`);
  }
  return clean;
}

function optionalText(value, name, max = 500) {
  if (value == null || value === '') return null;
  return text(value, name, { max });
}

function id(value, name) {
  return text(value, name, { max: 100, pattern: /^[a-zA-Z0-9._:-]+$/ });
}

function isoDate(value, name, optional = false) {
  if (optional && (value == null || value === '')) return null;
  const clean = text(value, name, { max: 40 });
  const date = new Date(clean);
  if (!Number.isFinite(date.getTime())) fail('invalid-argument', `${name} non valida`);
  return date;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function checksum(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function normalizeIngredient(value) {
  return text(value, 'ingredientText', { max: 120 })
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

// Stessa normalizzazione di `aliasKey` in js/domain.js (port server-side):
// lowercase, accenti rimossi, parentesi e punteggiatura → spazi. Usata per
// dedup/collisioni alias dell'import catalogo e per i searchTokens. La parità
// esatta con il client è verificata dai test su casi accentati e alias.
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

// Rigenerazione server-side dei token di ricerca: displayName + alias,
// normalizzati e univoci (max 200). Il file di import non può imporre token.
function searchTokensFor(displayName, aliases = []) {
  const tokens = new Set();
  [displayName, ...(Array.isArray(aliases) ? aliases : [])].forEach(value => {
    const key = aliasKey(value);
    if (!key) return;
    key.split(' ').forEach(word => { if (word) tokens.add(word); });
  });
  return [...tokens].slice(0, 200);
}

// Username esatto normalizzato (stesse regole dell'Auth per username:
// js/firebase.js). La ricerca è sempre per uguaglianza: nessun prefisso,
// nessuna enumerazione.
function normalizeUsername(value) {
  const clean = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(clean)) fail('invalid-argument', 'username non valido');
  return clean;
}

// Hash SHA-256 esadecimale di un token opaco (inviti monouso). Nel documento
// Firestore viene conservato SOLO questo hash, mai il token in chiaro.
function hashToken(token) {
  if (typeof token !== 'string' || !token) fail('invalid-argument', 'token non valido');
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function reportKey({ organizationId, fingerprint, ruleSetId, ruleSetVersion, errorType }) {
  return checksum({
    organizationId: id(organizationId, 'organizationId'),
    fingerprint: text(fingerprint, 'fingerprint', { max: 128 }),
    ruleSetId: id(ruleSetId, 'ruleSetId'),
    ruleSetVersion: id(String(ruleSetVersion), 'ruleSetVersion'),
    errorType: text(errorType, 'errorType', { pattern: /^(unknown|ambiguous)$/ })
  });
}

function validateReport(input) {
  exactObject(input, ['clientProfileId', 'fingerprint', 'ingredientText', 'slot', 'errorType', 'ruleSetId', 'ruleSetVersion']);
  return {
    clientProfileId: id(input.clientProfileId, 'clientProfileId'),
    fingerprint: text(input.fingerprint, 'fingerprint', { max: 128 }),
    ingredientText: text(input.ingredientText, 'ingredientText', { max: 120 }),
    normalizedIngredient: normalizeIngredient(input.ingredientText),
    slot: text(input.slot, 'slot', { pattern: /^(lunch|dinner)$/ }),
    errorType: text(input.errorType, 'errorType', { pattern: /^(unknown|ambiguous)$/ }),
    ruleSetId: id(input.ruleSetId, 'ruleSetId'),
    ruleSetVersion: id(String(input.ruleSetVersion), 'ruleSetVersion')
  };
}

function validateMapping(input) {
  exactObject(input, ['kind', 'canonicalIngredientId', 'aliases', 'family', 'group', 'doses']);
  const kind = text(input.kind, 'mapping.kind');
  if (!MAPPING_KINDS.has(kind)) fail('invalid-argument', 'mapping.kind non valido');
  const aliases = Array.isArray(input.aliases) ? [...new Set(input.aliases.map(normalizeIngredient))] : [];
  if (!aliases.length || aliases.length > 30) fail('invalid-argument', 'mapping.aliases non valido');
  const mapping = {
    kind,
    canonicalIngredientId: id(input.canonicalIngredientId, 'mapping.canonicalIngredientId'),
    aliases,
    family: kind === 'guided' ? id(input.family, 'mapping.family') : 'free',
    group: kind === 'guided' ? text(input.group, 'mapping.group') : 'free',
    doses: kind === 'guided' ? input.doses : null
  };
  if (!GROUPS.has(mapping.group)) fail('invalid-argument', 'mapping.group non valido');
  if (kind === 'guided') validateDoses(mapping.doses);
  return mapping;
}

function validateDoses(doses) {
  exactObject(doses, ['lunch', 'dinner'], 'mapping.doses');
  for (const slot of ['lunch', 'dinner']) {
    exactObject(doses[slot], ['training', 'rest'], `mapping.doses.${slot}`);
    for (const day of ['training', 'rest']) {
      const value = doses[slot][day];
      if (!Number.isFinite(value) || value <= 0 || value > 5000) fail('invalid-argument', `Dose ${slot}/${day} non valida`);
    }
  }
}

function validateRuleSetRules(input) {
  if (!Array.isArray(input) || !input.length || input.length > 300) fail('invalid-argument', 'rules non valide');
  const families = new Set();
  return input.map((rule, index) => {
    exactObject(rule, ['family', 'group', 'label', 'aliases', 'slots'], `rules[${index}]`);
    const family = id(rule.family, `rules[${index}].family`);
    if (families.has(family)) fail('invalid-argument', `Famiglia duplicata: ${family}`);
    families.add(family);
    const group = text(rule.group, `rules[${index}].group`);
    if (!GROUPS.has(group) || group === 'free') fail('invalid-argument', `Gruppo non valido: ${group}`);
    const aliases = Array.isArray(rule.aliases) ? [...new Set(rule.aliases.map(normalizeIngredient))] : [];
    if (!aliases.length || aliases.length > 30) fail('invalid-argument', `Alias non validi: ${family}`);
    validateDoses(rule.slots);
    return { family, group, label: text(rule.label, `rules[${index}].label`, { max: 100 }), aliases, slots: rule.slots };
  });
}

function validateAssignment(input) {
  exactObject(input, ['organizationId', 'clientId', 'ruleSet', 'effectiveAt', 'expiresAt', 'strategy', 'reason', 'idempotencyKey']);
  exactObject(input.ruleSet, ['scope', 'ruleSetId', 'version', 'checksum'], 'ruleSet');
  const effectiveAt = isoDate(input.effectiveAt, 'effectiveAt');
  const expiresAt = isoDate(input.expiresAt, 'expiresAt', true);
  if (expiresAt && expiresAt <= effectiveAt) fail('invalid-argument', 'expiresAt deve essere successiva a effectiveAt');
  const strategy = text(input.strategy, 'strategy');
  if (!ASSIGNMENT_STRATEGIES.has(strategy)) fail('invalid-argument', 'strategy non valida');
  return {
    organizationId: id(input.organizationId, 'organizationId'),
    clientId: id(input.clientId, 'clientId'),
    ruleSet: {
      scope: text(input.ruleSet.scope, 'ruleSet.scope', { pattern: /^(global|tenant)$/ }),
      ruleSetId: id(input.ruleSet.ruleSetId, 'ruleSet.ruleSetId'),
      version: id(String(input.ruleSet.version), 'ruleSet.version'),
      checksum: text(input.ruleSet.checksum, 'ruleSet.checksum', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ })
    },
    effectiveAt,
    expiresAt,
    strategy,
    reason: text(input.reason, 'reason', { min: 3, max: 500 }),
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
}

// Contratto assegnazione v2: il cliente sceglie solo Cliente, Struttura dieta,
// Decorrenza, Scadenza (o il flag "Senza scadenza") e Note. Revisione e
// checksum della struttura sono risolti server-side; Ambito/Versione/
// Strategia/anteprima non esistono più nel payload.
//
// Fase 2: il campo operativo è `structureId` (dietStructures). `ruleSetId` è
// accettato SOLO come alias legacy per retrocompatibilità (console/client già
// rilasciati): esattamente uno dei due deve essere presente.
function validateStructureAssignment(input) {
  exactObject(input, ['organizationId', 'clientId', 'structureId', 'ruleSetId', 'effectiveAt', 'expiresAt', 'withoutExpiration', 'notes', 'idempotencyKey']);
  const withoutExpiration = input.withoutExpiration === true;
  const effectiveAt = isoDate(input.effectiveAt, 'effectiveAt');
  const expiresAt = isoDate(input.expiresAt, 'expiresAt', true);
  if (!withoutExpiration && !expiresAt) {
    fail('failed-precondition', 'Indica una scadenza oppure seleziona "Senza scadenza"');
  }
  if (withoutExpiration && expiresAt) {
    fail('invalid-argument', 'expiresAt non ammessa quando il flag "Senza scadenza" è attivo');
  }
  if (expiresAt && expiresAt <= effectiveAt) fail('invalid-argument', 'expiresAt deve essere successiva a effectiveAt');
  const hasStructure = input.structureId != null && input.structureId !== '';
  const hasLegacy = input.ruleSetId != null && input.ruleSetId !== '';
  if (hasStructure === hasLegacy) {
    fail('invalid-argument', 'Indica la struttura dieta da assegnare (structureId)');
  }
  return {
    organizationId: id(input.organizationId, 'organizationId'),
    clientId: id(input.clientId, 'clientId'),
    structureId: hasStructure ? id(input.structureId, 'structureId') : null,
    ruleSetId: hasLegacy ? id(input.ruleSetId, 'ruleSetId') : null,
    effectiveAt,
    expiresAt: withoutExpiration ? null : expiresAt,
    withoutExpiration,
    // Note: default solo personale autorizzato (il cliente non le legge).
    notes: optionalText(input.notes, 'notes', 500) || '',
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
}

function effectiveAssignment(assignment, now = new Date()) {
  if (!assignment) return { valid: false, reason: 'missing' };
  if (!ASSIGNMENT_STATUSES.has(assignment.status)) return { valid: false, reason: 'invalid-status' };
  if (['suspended', 'revoked', 'expired'].includes(assignment.status)) return { valid: false, reason: assignment.status };
  const effectiveAt = new Date(assignment.effectiveAt);
  const expiresAt = assignment.expiresAt ? new Date(assignment.expiresAt) : null;
  if (effectiveAt > now) return { valid: false, reason: 'scheduled' };
  if (expiresAt && expiresAt <= now) return { valid: false, reason: 'expired' };
  return { valid: assignment.status === 'active', reason: assignment.status === 'active' ? null : assignment.status };
}

// Regole di una revisione struttura dieta (schema v2): famiglie Meller con
// dosi per pasto (pranzo/cena) × giorno (allenamento/riposo). Le quantità sono
// interi in grammi tra 1 e 2000; un pasto può essere `null` se non gestito,
// mai entrambi. Schema esatto: docs/schema-catalogo-strutture-v2.json.
function grams(value, name) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 2000) fail('invalid-argument', `${name} deve essere un intero tra 1 e 2000`);
  return number;
}

// Blocco dosi pranzo/cena × allenamento/riposo condiviso da regole famiglia e
// voci dei gruppi alternativi: stessi vincoli, stessi messaggi.
function validateContextQuantity(value, name) {
  if (!value || typeof value !== 'object') fail('invalid-argument', `${name} mancante`);
  exactObject(value, ['lunch', 'dinner'], name);
  const quantityGrams = {};
  for (const meal of ['lunch', 'dinner']) {
    const slot = value[meal];
    if (slot == null) { quantityGrams[meal] = null; continue; }
    exactObject(slot, ['training', 'rest'], `${name}.${meal}`);
    quantityGrams[meal] = {
      training: grams(slot.training, `${name}.${meal}.training`),
      rest: grams(slot.rest, `${name}.${meal}.rest`)
    };
    if (quantityGrams[meal].training == null && quantityGrams[meal].rest == null) quantityGrams[meal] = null;
  }
  if (quantityGrams.lunch == null && quantityGrams.dinner == null) {
    fail('invalid-argument', `${name}: almeno una dose per pranzo o cena`);
  }
  return quantityGrams;
}

function validateDietStructureRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > 40) {
    fail('invalid-argument', 'rules deve contenere tra 1 e 40 famiglie');
  }
  const seen = new Set();
  return rules.map((rule, index) => {
    exactObject(rule, ['mellerFamilyId', 'ingredientIds', 'quantityGrams', 'enabled', 'categoryId'], `rules[${index}]`);
    const mellerFamilyId = id(rule.mellerFamilyId, `rules[${index}].mellerFamilyId`);
    if (seen.has(mellerFamilyId)) fail('invalid-argument', `Famiglia Meller duplicata: ${mellerFamilyId}`);
    seen.add(mellerFamilyId);
    // La famiglia deve esistere nel motore: niente regole orfane che il
    // client convertirebbe in silenzio in "nessuna dose".
    if (!MELLER_FAMILY_IDS.has(mellerFamilyId)) {
      fail('invalid-argument', `rules[${index}].mellerFamilyId non esiste nel motore Meller`);
    }
    const quantityGrams = validateContextQuantity(rule.quantityGrams, `rules[${index}].quantityGrams`);
    const ingredientIds = Array.isArray(rule.ingredientIds)
      ? rule.ingredientIds.map((value, i) => id(value, `rules[${index}].ingredientIds[${i}]`))
      : [];
    if (ingredientIds.length > 100) fail('invalid-argument', `rules[${index}].ingredientIds: massimo 100 ingredienti`);
    if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') {
      fail('invalid-argument', `rules[${index}].enabled deve essere booleano`);
    }
    return {
      mellerFamilyId,
      ingredientIds,
      quantityGrams,
      enabled: rule.enabled === undefined ? true : rule.enabled,
      categoryId: rule.categoryId == null || rule.categoryId === '' ? null : id(rule.categoryId, `rules[${index}].categoryId`)
    };
  });
}

// Gruppi alternativi della revisione (schema v2: carboidrati/proteine/...):
// voci con ingrediente globale + dosi proprie. L'esistenza degli ingredienti
// in catalogo è verificata dalla callable (serve Firestore); qui solo forma.
function validateAlternativeGroups(groups) {
  if (groups == null) return [];
  if (!Array.isArray(groups) || groups.length > 20) {
    fail('invalid-argument', 'alternativeGroups deve contenere al massimo 20 gruppi');
  }
  const seen = new Set();
  return groups.map((group, index) => {
    exactObject(group, ['alternativeGroupId', 'displayName', 'items'], `alternativeGroups[${index}]`);
    const alternativeGroupId = text(group.alternativeGroupId, `alternativeGroups[${index}].alternativeGroupId`, { max: 96, pattern: /^[a-z0-9][a-z0-9-]{1,95}$/ });
    if (seen.has(alternativeGroupId)) fail('invalid-argument', `Gruppo alternativo duplicato: ${alternativeGroupId}`);
    seen.add(alternativeGroupId);
    const displayName = text(group.displayName, `alternativeGroups[${index}].displayName`, { max: 160 });
    if (!Array.isArray(group.items) || group.items.length === 0 || group.items.length > 50) {
      fail('invalid-argument', `alternativeGroups[${index}].items deve contenere tra 1 e 50 voci`);
    }
    const seenItems = new Set();
    const items = group.items.map((item, itemIndex) => {
      exactObject(item, ['ingredientId', 'quantityGrams'], `alternativeGroups[${index}].items[${itemIndex}]`);
      const ingredientId = id(item.ingredientId, `alternativeGroups[${index}].items[${itemIndex}].ingredientId`);
      if (seenItems.has(ingredientId)) fail('invalid-argument', `alternativeGroups[${index}]: ingrediente duplicato ${ingredientId}`);
      seenItems.add(ingredientId);
      return {
        ingredientId,
        quantityGrams: validateContextQuantity(item.quantityGrams, `alternativeGroups[${index}].items[${itemIndex}].quantityGrams`)
      };
    });
    return { alternativeGroupId, displayName, items };
  });
}

// Checksum della revisione struttura. Schema 2 (Fase 2): copre rules +
// alternativeGroups. Schema 1 legacy: solo rules (compatibilità di verifica
// per le revisioni pubblicate prima della Fase 2).
const STRUCTURE_REVISION_SCHEMA_VERSION = 2;

function structureRevisionChecksum({ schemaVersion, rules, alternativeGroups }) {
  if (Number(schemaVersion) === 1) return checksum({ schemaVersion: 1, rules });
  return checksum({ schemaVersion: 2, rules, alternativeGroups: alternativeGroups || [] });
}

function verifyStructureRevision(value) {
  if (!value || value.status !== 'published' || !Array.isArray(value.rules) || !value.rules.length) return false;
  const expected = structureRevisionChecksum({
    schemaVersion: Number(value.schemaVersion || 1),
    rules: value.rules,
    alternativeGroups: value.alternativeGroups || []
  });
  return value.checksum === expected;
}

// ---------------------------------------------------------------------
// Import catalogo globale ingredienti — docs/catalog-import-format.md
// Contratto puro (nessun Firestore): parsing JSON/CSV, validazione bloccante,
// dry-run senza scritture. La callable aggiunge: platform-admin, feature flag
// CATALOG_IMPORT_ENABLED, lettura catalogo corrente, transazione atomica.
// ---------------------------------------------------------------------

const CATALOG_IMPORT_FORMATS = new Set(['json', 'csv']);
const CATALOG_IMPORT_MODES = new Set(['dry-run', 'commit', 'restore']);
const CATALOG_CSV_COLUMNS = ['ingredientId', 'displayName', 'aliases', 'categoryId', 'mappingKind', 'mellerFamilyId'];
const CATALOG_INGREDIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,95}$/;
const CATALOG_CATEGORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
// Zero quantità: qualsiasi chiave che somigli a una dose rifiuta il file.
// Le dosi appartengono a famiglie/strutture, mai al catalogo ingredienti.
const CATALOG_DOSE_KEY_PATTERN = /(quantit|grams?|doses?|slots?|portions?|kgs?|millilit|calor)/i;
const CATALOG_RESERVED_CATEGORY = 'free';

function assertNoDoseKeys(value, where, seen = null) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoDoseKeys(item, `${where}[${index}]`, seen));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      if (CATALOG_DOSE_KEY_PATTERN.test(key)) {
        fail('invalid-argument', `${where}: campo dose vietato nel catalogo ("${key}")`);
      }
      assertNoDoseKeys(item, `${where}.${key}`, seen);
    });
  }
}

function parseCatalogCsv(payload) {
  const source = String(payload || '').replace(/^\uFEFF/, '');
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  if (!lines.length) fail('invalid-argument', 'CSV vuoto o senza intestazione');
  const separator = lines[0].includes(';') ? ';' : ',';
  const header = lines[0].split(separator).map(cell => cell.trim());
  const unknown = header.filter(column => !CATALOG_CSV_COLUMNS.includes(column));
  const doseColumns = unknown.filter(column => CATALOG_DOSE_KEY_PATTERN.test(column));
  if (doseColumns.length) {
    fail('invalid-argument', `CSV: colonna dose vietata nel catalogo ("${doseColumns[0]}")`);
  }
  if (unknown.length) fail('invalid-argument', `CSV: colonna non riconosciuta ("${unknown[0]}")`);
  for (const required of ['ingredientId', 'displayName', 'categoryId', 'mappingKind']) {
    if (!header.includes(required)) fail('invalid-argument', `CSV: intestazione obbligatoria mancante ("${required}")`);
  }
  return lines.slice(1).map((line, index) => {
    // CSV semplice senza virgolette annidate: il formato concordato usa `;`
    // oppure `,` con alias separati da `|`. Righe malformate → errore chiaro.
    const cells = line.split(separator).map(cell => cell.trim());
    if (cells.length !== header.length) {
      fail('invalid-argument', `CSV riga ${index + 2}: ${cells.length} celle invece di ${header.length}`);
    }
    const row = {};
    header.forEach((column, position) => { row[column] = cells[position]; });
    row.aliases = String(row.aliases || '').split('|').map(part => part.trim()).filter(Boolean);
    row.mellerFamilyId = row.mellerFamilyId === '' || row.mellerFamilyId == null ? null : row.mellerFamilyId;
    row.__line = index + 2;
    return row;
  });
}

function parseCatalogPayload(format, payload) {
  const clean = text(format, 'format');
  if (!CATALOG_IMPORT_FORMATS.has(clean)) fail('invalid-argument', 'format non valido (json|csv)');
  if (clean === 'csv') return { ingredients: parseCatalogCsv(payload), categories: [] };
  let parsed;
  try {
    parsed = JSON.parse(String(payload || ''));
  } catch (_) {
    fail('invalid-argument', 'JSON non valido');
  }
  assertNoDoseKeys(parsed, 'payload');
  if (!Array.isArray(parsed)) exactObject(parsed, ['ingredients', 'categories'], 'payload');
  const ingredients = Array.isArray(parsed) ? parsed : parsed?.ingredients;
  const categories = Array.isArray(parsed) ? [] : (parsed?.categories == null ? [] : parsed.categories);
  if (!Array.isArray(ingredients)) fail('invalid-argument', 'JSON: array radice o oggetto con chiave "ingredients"');
  if (!Array.isArray(categories)) fail('invalid-argument', 'JSON: "categories" deve essere un array');
  if (ingredients.length === 0 && categories.length === 0) fail('invalid-argument', 'Import vuoto: niente da elaborare');
  if (ingredients.length > 5000) fail('invalid-argument', 'Import troppo grande: massimo 5000 ingredienti per file');
  return { ingredients, categories };
}

function catalogEntryKeys(entry) {
  const keys = new Set();
  const name = aliasKey(entry?.displayName);
  if (name) keys.add(name);
  (Array.isArray(entry?.aliases) ? entry.aliases : []).forEach(alias => {
    const key = aliasKey(alias);
    if (key) keys.add(key);
  });
  return keys;
}

// Normalizza e valida un ingrediente del file. `knownCategories` unisce le
// categorie del file + quelle del catalogo corrente + 'free'. Gli errori sono
// raccolti (non lanciati) per produrre il report dry-run completo.
function validateCatalogIngredient(raw, knownCategories, errors, where) {
  const label = where || `ingredienti[${raw?.ingredientId || '?'}]`;
  const problems = [];
  const push = message => { problems.push(`${label}: ${message}`); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${label}: voce non valida`);
    return null;
  }
  assertNoDoseKeys(raw, label);
  const extra = Object.keys(raw).filter(key => !['ingredientId', 'displayName', 'aliases', 'categoryId', 'mappingKind', 'mellerFamilyId', '__line'].includes(key) && !key.startsWith('__'));
  extra.forEach(key => push(`campo non riconosciuto ("${key}")`));
  const ingredientId = String(raw.ingredientId || '').trim();
  if (!CATALOG_INGREDIENT_ID_PATTERN.test(ingredientId)) push('ingredientId non valido (minuscolo, trattini, 2-96 caratteri)');
  const displayName = String(raw.displayName || '').trim();
  if (!displayName || displayName.length > 160) push('displayName obbligatorio (max 160)');
  const aliases = [];
  const aliasSeen = new Set();
  (Array.isArray(raw.aliases) ? raw.aliases : []).forEach(alias => {
    const clean = String(alias || '').trim();
    if (!clean) return;
    if (clean.length > 160) { push(`alias troppo lungo ("${clean.slice(0, 40)}…")`); return; }
    const key = aliasKey(clean);
    if (!key || aliasSeen.has(key)) return;
    aliasSeen.add(key);
    aliases.push(clean);
  });
  if (aliases.length > 100) push('massimo 100 alias');
  const categoryId = String(raw.categoryId || '').trim();
  if (!CATALOG_CATEGORY_ID_PATTERN.test(categoryId)) push('categoryId non valido');
  else if (!knownCategories.has(categoryId)) push(`categoryId inesistente ("${categoryId}")`);
  const mappingKind = String(raw.mappingKind || '').trim();
  if (!MAPPING_KINDS.has(mappingKind)) push('mappingKind non valido (guided|free)');
  const mellerFamilyId = raw.mellerFamilyId == null || raw.mellerFamilyId === '' ? null : String(raw.mellerFamilyId).trim();
  if (mappingKind === 'guided') {
    if (!mellerFamilyId) push('guided richiede mellerFamilyId');
    else if (!MELLER_FAMILY_IDS.has(mellerFamilyId)) push(`mellerFamilyId inesistente nel motore ("${mellerFamilyId}")`);
  }
  if (mappingKind === 'free' && mellerFamilyId) push('free non ammette mellerFamilyId');
  if (problems.length) {
    errors.push(...problems);
    return null;
  }
  return {
    ingredientId,
    displayName,
    normalizedName: aliasKey(displayName),
    categoryId,
    aliases,
    // searchTokens SEMPRE rigenerati server-side, mai dal file.
    searchTokens: searchTokensFor(displayName, aliases),
    mappingKind,
    mellerFamilyId: mappingKind === 'guided' ? mellerFamilyId : null,
    status: 'active'
  };
}

function validateCatalogCategory(raw, errors, where) {
  const label = where || `categorie[${raw?.categoryId || '?'}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${label}: voce non valida`);
    return null;
  }
  assertNoDoseKeys(raw, label);
  const problems = [];
  Object.keys(raw).filter(key => !['categoryId', 'displayName', 'description', 'sortOrder', 'status'].includes(key))
    .forEach(key => problems.push(`${label}: campo non riconosciuto ("${key}")`));
  const categoryId = String(raw.categoryId || '').trim();
  if (!CATALOG_CATEGORY_ID_PATTERN.test(categoryId)) problems.push(`${label}: categoryId non valido`);
  if (categoryId === CATALOG_RESERVED_CATEGORY) problems.push(`${label}: la categoria riservata "free" non si importa`);
  const displayName = String(raw.displayName || '').trim();
  if (!displayName || displayName.length > 100) problems.push(`${label}: displayName obbligatorio (max 100)`);
  const description = raw.description == null || raw.description === '' ? null : String(raw.description);
  if (description && description.length > 500) problems.push(`${label}: description max 500`);
  let sortOrder = 0;
  if (raw.sortOrder != null && raw.sortOrder !== '') {
    sortOrder = Number(raw.sortOrder);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) problems.push(`${label}: sortOrder intero ≥ 0`);
  }
  if (problems.length) {
    errors.push(...problems);
    return null;
  }
  return {
    categoryId,
    displayName,
    normalizedName: aliasKey(displayName),
    description,
    sortOrder,
    status: 'active'
  };
}

function sameCatalogEntry(a, b) {
  return canonicalJson({
    displayName: a.displayName, categoryId: a.categoryId, aliases: [...(a.aliases || [])].sort(),
    mappingKind: a.mappingKind, mellerFamilyId: a.mellerFamilyId || null
  }) === canonicalJson({
    displayName: b.displayName, categoryId: b.categoryId, aliases: [...(b.aliases || [])].sort(),
    mappingKind: b.mappingKind, mellerFamilyId: b.mellerFamilyId || null
  });
}

// Validazione completa del file contro il catalogo corrente. Ritorna sempre
// il report (conteggi + diff ≤200 + errori); il commit è consentito solo con
// zero errori. `existing` = {ingredients: Map|Object, categories: Set|Array},
// `denylist` = array di ingredientId provvisori bloccati (configurazione
// server-side, mai nel repository).
function validateCatalogImport(parsed, { existingIngredients = {}, existingCategories = [], denylist = [] } = {}) {
  const errors = [];
  const diff = [];
  const blocked = new Set((Array.isArray(denylist) ? denylist : []).map(entry => String(entry || '').trim()).filter(Boolean));
  const existingById = new Map(Object.entries(existingIngredients || {}));
  const existingKeysById = new Map();
  existingById.forEach((entry, idValue) => existingKeysById.set(idValue, catalogEntryKeys(entry)));
  // Categorie: prima quelle del file (validate), poi unione con le correnti.
  const fileCategories = [];
  const fileCategoryIds = new Set();
  (parsed.categories || []).forEach((raw, index) => {
    const normalized = validateCatalogCategory(raw, errors, `categorie[${index}]`);
    if (!normalized) return;
    if (fileCategoryIds.has(normalized.categoryId) || (existingCategories || []).includes(normalized.categoryId)) {
      diff.push({ categoryId: normalized.categoryId, change: 'identical', detail: 'categoria già presente' });
      return;
    }
    fileCategoryIds.add(normalized.categoryId);
    fileCategories.push(normalized);
    diff.push({ categoryId: normalized.categoryId, change: 'create', detail: 'nuova categoria' });
  });
  const knownCategories = new Set([...(existingCategories || []), ...fileCategoryIds, CATALOG_RESERVED_CATEGORY]);
  // Ingredienti: normalizzazione, dedup, denylist, collisioni alias.
  const normalized = [];
  const seenIds = new Set();
  const fileKeysById = new Map();
  (parsed.ingredients || []).forEach((raw, index) => {
    const label = `ingredienti[${raw?.ingredientId || `riga ${raw?.__line || index + 1}`}]`;
    const entry = validateCatalogIngredient(raw, knownCategories, errors, label);
    if (!entry) return;
    if (seenIds.has(entry.ingredientId)) {
      errors.push(`${label}: ingredientId duplicato nel file ("${entry.ingredientId}")`);
      return;
    }
    seenIds.add(entry.ingredientId);
    if (blocked.has(entry.ingredientId)) {
      errors.push(`${label}: ID provvisorio non importabile (denylist)`);
      diff.push({ ingredientId: entry.ingredientId, change: 'error', detail: 'ID in denylist provvisoria' });
      return;
    }
    normalized.push(entry);
    fileKeysById.set(entry.ingredientId, catalogEntryKeys(entry));
  });
  // Collisioni: (a) dentro il file tra ID diversi; (b) contro ingredienti
  // esistenti DIVERSI (stesso ID = aggiornamento, non collisione).
  const keyOwner = new Map();
  fileKeysById.forEach((keys, idValue) => {
    keys.forEach(key => {
      if (!keyOwner.has(key)) keyOwner.set(key, idValue);
      else if (keyOwner.get(key) !== idValue) {
        errors.push(`ingredienti[${idValue}]: alias/nome "${key}" già usato da "${keyOwner.get(key)}" nello stesso file`);
      }
    });
  });
  normalized.forEach(entry => {
    const keys = fileKeysById.get(entry.ingredientId);
    const conflicts = [];
    existingKeysById.forEach((existingKeys, existingId) => {
      if (existingId === entry.ingredientId) return;
      keys.forEach(key => { if (existingKeys.has(key)) conflicts.push({ alias: key, collidesWith: existingId }); });
    });
    if (conflicts.length) {
      const detail = conflicts.slice(0, 5).map(item => `"${item.alias}" ↔ ${item.collidesWith}`).join('; ');
      errors.push(`ingredienti[${entry.ingredientId}]: collisione alias con ingrediente esistente diverso (${detail})`);
      diff.push({ ingredientId: entry.ingredientId, change: 'conflict', detail });
      return;
    }
    const previous = existingById.get(entry.ingredientId);
    if (!previous) diff.push({ ingredientId: entry.ingredientId, change: 'create', detail: 'nuovo ingrediente' });
    else if (sameCatalogEntry(previous, entry)) diff.push({ ingredientId: entry.ingredientId, change: 'identical', detail: 'già identico' });
    else diff.push({ ingredientId: entry.ingredientId, change: 'update', detail: 'aggiorna metadati (mai quantità)' });
  });
  const counts = { create: 0, identical: 0, update: 0, conflicts: 0, errors: errors.length };
  diff.forEach(row => {
    if (row.change === 'create') counts.create += 1;
    else if (row.change === 'identical') counts.identical += 1;
    else if (row.change === 'update') counts.update += 1;
    else if (row.change === 'conflict') counts.conflicts += 1;
  });
  return {
    normalized: { ingredients: normalized, categories: fileCategories },
    counts,
    diff: diff.slice(0, 200),
    diffTruncated: diff.length > 200,
    errors
  };
}

// previewId = hash del contenuto normalizzato + versione base: il commit deve
// ripresentarlo identico, a prova di file sostituito tra dry-run e commit.
function catalogImportPreviewId(normalized, baseCatalogVersion) {
  return checksum({
    baseCatalogVersion: Number(baseCatalogVersion || 0),
    ingredients: [...(normalized?.ingredients || [])].sort((a, b) => String(a.ingredientId).localeCompare(String(b.ingredientId))),
    categories: [...(normalized?.categories || [])].sort((a, b) => String(a.categoryId).localeCompare(String(b.categoryId)))
  });
}

// ---------------------------------------------------------------------
// Utenti, inviti e associazioni nutritionist-cliente (Fase 2)
// ---------------------------------------------------------------------

function validateInviteOrganizationUser(input) {
  exactObject(input, ['organizationId', 'username', 'role', 'idempotencyKey']);
  const role = text(input.role, 'role');
  if (role !== 'nutritionist') fail('invalid-argument', 'role ammesso: solo nutritionist');
  return {
    organizationId: id(input.organizationId, 'organizationId'),
    username: normalizeUsername(input.username),
    role,
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
}

function validateInviteClientLink(input) {
  exactObject(input, ['organizationId', 'username', 'nutritionistUid', 'idempotencyKey']);
  return {
    organizationId: id(input.organizationId, 'organizationId'),
    username: normalizeUsername(input.username),
    nutritionistUid: input.nutritionistUid == null || input.nutritionistUid === ''
      ? null
      : text(input.nutritionistUid, 'nutritionistUid', { max: 128 }),
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
}

function validateRespondClientLink(input) {
  exactObject(input, ['requestId', 'decision']);
  const decision = text(input.decision, 'decision');
  if (decision !== 'accept' && decision !== 'reject') fail('invalid-argument', 'decision non valida (accept|reject)');
  return { requestId: id(input.requestId, 'requestId'), decision };
}

function validateRemoveClientLink(input) {
  exactObject(input, ['organizationId', 'clientId', 'reason', 'idempotencyKey']);
  return {
    organizationId: id(input.organizationId, 'organizationId'),
    clientId: id(input.clientId, 'clientId'),
    reason: text(input.reason, 'reason', { min: 3, max: 500 }),
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
}

function validateMemberStatus(input) {
  exactObject(input, ['organizationId', 'userId', 'status', 'idempotencyKey']);
  const status = text(input.status, 'status');
  if (status !== 'active' && status !== 'suspended') fail('invalid-argument', 'status non valido (active|suspended)');
  return {
    organizationId: id(input.organizationId, 'organizationId'),
    userId: text(input.userId, 'userId', { max: 128 }),
    status,
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
}

function validateRemoveNutritionist(input) {
  exactObject(input, ['organizationId', 'userId', 'idempotencyKey']);
  return {
    organizationId: id(input.organizationId, 'organizationId'),
    userId: text(input.userId, 'userId', { max: 128 }),
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
}

function validateTransferStructureOwnership(input) {
  exactObject(input, ['organizationId', 'structureId', 'newOwnerUid', 'idempotencyKey']);
  return {
    organizationId: id(input.organizationId, 'organizationId'),
    structureId: id(input.structureId, 'structureId'),
    newOwnerUid: text(input.newOwnerUid, 'newOwnerUid', { max: 128 }),
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
}

module.exports = {
  ROLES, REPORT_STATUSES, ASSIGNMENT_STATUSES, ASSIGNMENT_STRATEGIES, MEMBER_STATUSES,
  MELLER_FAMILY_IDS, STRUCTURE_REVISION_SCHEMA_VERSION,
  fail, exactObject, text, optionalText, id, isoDate, canonicalJson, checksum,
  normalizeIngredient, aliasKey, searchTokensFor, normalizeUsername, hashToken,
  reportKey, validateReport, validateMapping, validateRuleSetRules, validateAssignment,
  validateStructureAssignment, validateDietStructureRules, validateAlternativeGroups,
  validateContextQuantity, structureRevisionChecksum, verifyStructureRevision, effectiveAssignment,
  CATALOG_IMPORT_FORMATS, CATALOG_IMPORT_MODES, CATALOG_CSV_COLUMNS, CATALOG_RESERVED_CATEGORY,
  parseCatalogPayload, parseCatalogCsv, validateCatalogImport, validateCatalogIngredient,
  validateCatalogCategory, catalogImportPreviewId,
  validateInviteOrganizationUser, validateInviteClientLink, validateRespondClientLink,
  validateRemoveClientLink, validateMemberStatus, validateRemoveNutritionist,
  validateTransferStructureOwnership
};

