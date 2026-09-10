'use strict';

const crypto = require('node:crypto');

const ROLES = new Set(['admin', 'nutritionist']);
const REPORT_STATUSES = new Set(['open', 'triaged', 'needs-review', 'resolved', 'rejected', 'duplicate']);
const ASSIGNMENT_STATUSES = new Set(['scheduled', 'active', 'suspended', 'revoked', 'expired']);
const ASSIGNMENT_STRATEGIES = new Set(['freeze', 'migrate-on-confirmation', 'original-only']);
const MAPPING_KINDS = new Set(['guided', 'free']);
const GROUPS = new Set(['carb', 'protein', 'dairy', 'fat', 'sweet', 'fruit', 'free']);

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
function validateStructureAssignment(input) {
  exactObject(input, ['organizationId', 'clientId', 'ruleSetId', 'effectiveAt', 'expiresAt', 'withoutExpiration', 'notes', 'idempotencyKey']);
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
  return {
    organizationId: id(input.organizationId, 'organizationId'),
    clientId: id(input.clientId, 'clientId'),
    ruleSetId: id(input.ruleSetId, 'ruleSetId'),
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
    if (!rule.quantityGrams || typeof rule.quantityGrams !== 'object') fail('invalid-argument', `rules[${index}].quantityGrams mancante`);
    exactObject(rule.quantityGrams, ['lunch', 'dinner'], `rules[${index}].quantityGrams`);
    const quantityGrams = {};
    for (const meal of ['lunch', 'dinner']) {
      const slot = rule.quantityGrams[meal];
      if (slot == null) { quantityGrams[meal] = null; continue; }
      exactObject(slot, ['training', 'rest'], `rules[${index}].quantityGrams.${meal}`);
      quantityGrams[meal] = {
        training: grams(slot.training, `rules[${index}].quantityGrams.${meal}.training`),
        rest: grams(slot.rest, `rules[${index}].quantityGrams.${meal}.rest`)
      };
      if (quantityGrams[meal].training == null && quantityGrams[meal].rest == null) quantityGrams[meal] = null;
    }
    if (quantityGrams.lunch == null && quantityGrams.dinner == null) {
      fail('invalid-argument', `rules[${index}]: almeno una dose per pranzo o cena`);
    }
    const ingredientIds = Array.isArray(rule.ingredientIds)
      ? rule.ingredientIds.map((value, i) => id(value, `rules[${index}].ingredientIds[${i}]`))
      : [];
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

module.exports = {
  ROLES, REPORT_STATUSES, ASSIGNMENT_STATUSES, ASSIGNMENT_STRATEGIES,
  fail, exactObject, text, optionalText, id, isoDate, canonicalJson, checksum,
  normalizeIngredient, reportKey, validateReport, validateMapping, validateRuleSetRules, validateAssignment,
  validateStructureAssignment, validateDietStructureRules, effectiveAssignment
};

