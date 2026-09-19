'use strict';

const crypto = require('node:crypto');

const SINGLE_ORGANIZATION_ID = 'pianoNutrizionale';
const ROLES = new Set(['nutritionist']);
const ASSIGNMENT_STATUSES = new Set(['scheduled', 'active', 'suspended', 'revoked', 'expired']);

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

// ---------------------------------------------------------------------
// Email reali vs account tecnici legacy (ADR 0004)
//
// `LEGACY_TEST_EMAIL_DOMAINS` è una LISTA CHIUSA e documentata: solo gli
// indirizzi su questi domini sono considerati "account tecnici di test".
// Non si inferisce mai che un'email non valida sia un account di test: le
// email non valide vengono semplicemente rifiutate.
// ---------------------------------------------------------------------

const LEGACY_TEST_EMAIL_DOMAINS = Object.freeze([
  'utenti.pianonutrizionale.app',
  'pianonutrizionale.app',
  'pianonutrizionale'
]);
const EMAIL_MAX_LENGTH = 254;
const EMAIL_LOCAL_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const EMAIL_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
// Nomi e cognomi: lettere (anche accentate), apostrofi, trattini, spazi
// singoli. Nessun numero, nessun markup, nessuna email.
const PERSON_NAME_PATTERN = /^[A-Za-zÀ-ÖØ-öø-ÿ]+(?:[ '-][A-Za-zÀ-ÖØ-öø-ÿ]+)*$/;

// Normalizzazione unica degli indirizzi email: trim, minuscole, forma
// verificata (una sola chiocciola, dominio con almeno un punto, nessun punto
// iniziale/finale o doppio nella parte locale). Gli indirizzi internazionali
// vanno inseriti in forma ASCII (punycode).
function normalizeEmail(value, name = 'email') {
  const clean = String(value == null ? '' : value).trim().toLowerCase();
  if (!clean || clean.length > EMAIL_MAX_LENGTH) fail('invalid-argument', `${name} non valida`);
  const parts = clean.split('@');
  if (parts.length !== 2) fail('invalid-argument', `${name} non valida`);
  const [local, domain] = parts;
  if (!local || local.length > 64 || !EMAIL_LOCAL_PATTERN.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    fail('invalid-argument', `${name} non valida`);
  }
  if (!domain || domain.length > 253 || !EMAIL_DOMAIN_PATTERN.test(domain)) {
    fail('invalid-argument', `${name} non valida`);
  }
  return `${local}@${domain}`;
}

function emailDomainOf(value) {
  const clean = String(value == null ? '' : value).trim().toLowerCase();
  const at = clean.lastIndexOf('@');
  return at < 1 ? null : clean.slice(at + 1);
}

// Condizione ESPLICITA (mai per esclusione): il dominio appartiene alla lista
// chiusa dei domini tecnici o a un suo sottodominio.
function isLegacyTestEmail(value) {
  const domain = emailDomainOf(value);
  if (!domain) return false;
  return LEGACY_TEST_EMAIL_DOMAINS.some(item => domain === item || domain.endsWith(`.${item}`));
}

// Impronta dell'email normalizzata: consente i controlli di unicità e i
// riferimenti tecnici senza duplicare l'indirizzo in chiaro dove non serve.
function emailFingerprint(value) {
  return crypto.createHash('sha256').update(normalizeEmail(value), 'utf8').digest('hex');
}

// Mascheramento per i log: mai indirizzi completi nei log applicativi.
// La parte locale sparisce (identifica la persona); il dominio resta leggibile
// perché serve a riconoscere a colpo d'occhio un indirizzo tecnico legacy.
function maskEmail(value) {
  const clean = String(value == null ? '' : value).trim().toLowerCase();
  const at = clean.lastIndexOf('@');
  if (at < 1 || at === clean.length - 1) return '***';
  return `${clean.slice(0, 1)}***@${clean.slice(at + 1)}`;
}

// Consegna dell'invito: sempre manuale. Il backend costruisce il link e la
// console lo mostra con "Copia link" e "Condividi link" (nessun invio
// automatico di email). Il canale è registrato nel documento per lo storico.
const INVITE_DELIVERY_CHANNEL = 'manual-link';
const EMAIL_CHANGE_STATUSES = new Set(['pending', 'accepted', 'rejected', 'cancelled']);
// Stati di un invito email: il documento resta sempre come traccia storica.
const CLIENT_EMAIL_INVITE_STATUSES = new Set(['pending', 'accepted', 'expired', 'revoked', 'superseded']);

// Contratto assegnazione: il cliente sceglie solo Cliente, Struttura dieta,
// Decorrenza, Scadenza (o il flag "Senza scadenza") e Note. Revisione e
// checksum della struttura sono risolti server-side; Ambito/Versione/
// Strategia/anteprima non esistono più nel payload.
function validateStructureAssignment(input) {
  exactObject(input, ['organizationId', 'clientId', 'structureId', 'effectiveAt', 'expiresAt', 'withoutExpiration', 'notes', 'idempotencyKey']);
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
  if (!hasStructure) {
    fail('invalid-argument', 'Indica la struttura dieta da assegnare (structureId)');
  }
  return {
    organizationId: id(input.organizationId, 'organizationId'),
    clientId: id(input.clientId, 'clientId'),
    structureId: id(input.structureId, 'structureId'),
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

// Quantità strutturata {value, unit} di blocchi, override, voci e template:
// numero 0–5000 + unità del vocabolario chiuso dei piani dieta. Nessuna dose
// vive fuori dalle strutture o dai template equivalenze del singolo
// professionista. Schema esatto: docs/schema-catalogo-strutture-v3.json.
function validateDietAmount(value, name) {
  if (!value || typeof value !== 'object') fail('invalid-argument', `${name} mancante`);
  exactObject(value, ['value', 'unit'], name);
  const number = value.value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 5000) {
    fail('invalid-argument', `${name}.value deve essere un numero tra 0 e 5000`);
  }
  const unit = text(value.unit, `${name}.unit`, { max: 16 });
  if (!DIET_PLAN_UNITS.has(unit)) fail('invalid-argument', `${name}.unit non valida`);
  return { value: number, unit };
}

// Checksum della revisione struttura. Schema 4 (modello a blocchi): copre
// solo il dietPlan; le regole classiche per famiglie e i gruppi alternativi
// non esistono più. Le revisioni 1–3 sono state eliminate col reset
// pre-lancio: non restano documenti da verificare.
const STRUCTURE_REVISION_SCHEMA_VERSION = 4;

function structureRevisionChecksum({ schemaVersion, dietPlan }) {
  return checksum({ schemaVersion, dietPlan: dietPlan === undefined ? null : dietPlan });
}

function verifyStructureRevision(value) {
  if (!value || value.status !== 'published') return false;
  const schemaVersion = Number(value.schemaVersion || 0);
  if (schemaVersion !== STRUCTURE_REVISION_SCHEMA_VERSION) return false;
  if (!value.dietPlan || !Array.isArray(value.dietPlan.days) || !value.dietPlan.days.length) return false;
  return value.checksum === structureRevisionChecksum({ schemaVersion, dietPlan: value.dietPlan });
}

// ---------------------------------------------------------------------
// Strutture dieta — piano a blocchi (dietPlan schema 2)
// Lo stesso vocabolario vive in js/domain.js per la console; qui la
// validazione è bloccante (fail) e ogni campo ha un limite. L'esistenza di
// famiglie/ingredienti/template nel catalogo è verificata dalla callable
// (serve Firestore): qui solo forma e coerenza interna.
// ---------------------------------------------------------------------

const DIET_PLAN_SCHEMA_VERSION = 2;
const DIET_PLAN_DAY_TYPES = new Set(['training', 'rest', 'other']);
const DIET_PLAN_MEAL_IDS = new Set(['breakfast', 'morning-snack', 'lunch', 'afternoon-snack', 'dinner', 'evening-snack']);
const DIET_PLAN_UNITS = new Set(['g', 'kg', 'ml', 'l', 'pz', 'fette', 'cucchiai', 'cucchiaini', 'tazze', 'bicchieri', 'porzioni', 'scatolette', 'misurini', 'qb']);
const DIET_PLAN_OPTION_TYPES = new Set(['family-block', 'ingredients', 'recipe']);
// Le etichette A/B/C/D NON si persistono più: sono una derivazione di UI
// quando un pasto ha più opzioni (decisione di prodotto).
const DIET_PLAN_LIMITS = {
  days: 14, mealsPerDay: 10, optionsPerMeal: 4, itemsPerOption: 20,
  blocksPerOption: 8, label: 80, note: 1000, generalNotes: 2000
};

function dietPlanText(value, name, { max, optional = false } = {}) {
  if (optional && (value == null || value === '')) return '';
  return text(value, name, { max });
}

function validateDietPlanBlock(block, name) {
  exactObject(block, ['blockId', 'referenceFamilyId', 'referenceIngredientId', 'referenceAmount', 'templateId', 'templateSnapshot', 'overrides'], name);
  const blockId = text(block.blockId, `${name}.blockId`, { max: 64, pattern: /^[a-z0-9][a-z0-9-]{0,63}$/ });
  const referenceFamilyId = id(block.referenceFamilyId, `${name}.referenceFamilyId`);
  const referenceIngredientId = block.referenceIngredientId == null || block.referenceIngredientId === ''
    ? null
    : id(block.referenceIngredientId, `${name}.referenceIngredientId`);
  const referenceAmount = validateDietAmount(block.referenceAmount, `${name}.referenceAmount`);
  // Il template è fissato nella revisione pubblicata: snapshot non
  // retroattivo + override espliciti della struttura. La coerenza col
  // template corrente (famiglia, ingredienti) è verificata in callable.
  let templateSnapshot = null;
  if (block.templateId != null && block.templateId !== '') {
    const templateId = id(block.templateId, `${name}.templateId`);
    if (!block.templateSnapshot || typeof block.templateSnapshot !== 'object') {
      fail('invalid-argument', `${name}.templateSnapshot mancante per il template ${templateId}`);
    }
    exactObject(block.templateSnapshot, ['revisionId', 'referenceAmount', 'equivalents'], `${name}.templateSnapshot`);
    templateSnapshot = {
      revisionId: text(block.templateSnapshot.revisionId, `${name}.templateSnapshot.revisionId`, { max: 32 }),
      referenceAmount: validateDietAmount(block.templateSnapshot.referenceAmount, `${name}.templateSnapshot.referenceAmount`),
      equivalents: validateTemplateSnapshotEquivalents(block.templateSnapshot.equivalents, `${name}.templateSnapshot.equivalents`)
    };
    if (Number(templateSnapshot.referenceAmount.value) <= 0) {
      fail('invalid-argument', `${name}.templateSnapshot.referenceAmount deve essere maggiore di zero`);
    }
  } else if (block.templateSnapshot != null) {
    fail('invalid-argument', `${name}.templateSnapshot presente senza templateId`);
  }
  const overrides = validateDietPlanOverrides(block.overrides, referenceFamilyId, `${name}.overrides`);
  return { blockId, referenceFamilyId, referenceIngredientId, referenceAmount, templateId: templateSnapshot ? block.templateId : null, templateSnapshot, overrides };
}

function validateTemplateSnapshotEquivalents(input, name) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 30) {
    fail('invalid-argument', `${name}: da 1 a 30 equivalenti`);
  }
  const seen = new Set();
  return input.map((equivalent, index) => {
    exactObject(equivalent, ['familyId', 'ingredientId', 'amount'], `${name}[${index}]`);
    const familyId = id(equivalent.familyId, `${name}[${index}].familyId`);
    if (seen.has(familyId)) fail('invalid-argument', `${name}: famiglia equivalente duplicata (${familyId})`);
    seen.add(familyId);
    return {
      familyId,
      ingredientId: equivalent.ingredientId == null || equivalent.ingredientId === ''
        ? null
        : id(equivalent.ingredientId, `${name}[${index}].ingredientId`),
      amount: validateDietAmount(equivalent.amount, `${name}[${index}].amount`)
    };
  });
}

function validateDietPlanOverrides(input, blockFamilyId, name) {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 30) fail('invalid-argument', `${name}: massimo 30 override`);
  const seen = new Set();
  return input.map((override, index) => {
    exactObject(override, ['familyId', 'ingredientId', 'amount'], `${name}[${index}]`);
    const familyId = id(override.familyId, `${name}[${index}].familyId`);
    if (familyId === blockFamilyId) fail('invalid-argument', `${name}[${index}]: la famiglia di riferimento del blocco non è un override`);
    const key = `${familyId}|${override.ingredientId || ''}`;
    if (seen.has(key)) fail('invalid-argument', `${name}: override duplicato (${key})`);
    seen.add(key);
    return {
      familyId,
      ingredientId: override.ingredientId == null || override.ingredientId === ''
        ? null
        : id(override.ingredientId, `${name}[${index}].ingredientId`),
      amount: validateDietAmount(override.amount, `${name}[${index}].amount`)
    };
  });
}

function validateDietPlanItem(item, name) {
  exactObject(item, ['itemId', 'ingredientId', 'amount'], name);
  text(item.itemId, `${name}.itemId`, { max: 64, pattern: /^[a-z0-9][a-z0-9-]{0,63}$/ });
  return {
    itemId: item.itemId,
    ingredientId: id(item.ingredientId, `${name}.ingredientId`),
    amount: validateDietAmount(item.amount, `${name}.amount`)
  };
}

function validateDietPlanOption(option, name) {
  exactObject(option, ['optionId', 'type', 'recipeId', 'recipeMultiplier', 'blocks', 'items', 'note'], name);
  text(option.optionId, `${name}.optionId`, { max: 64, pattern: /^[a-z0-9][a-z0-9-]{0,63}$/ });
  const type = text(option.type, `${name}.type`);
  if (!DIET_PLAN_OPTION_TYPES.has(type)) fail('invalid-argument', `${name}.type non valido`);
  const note = dietPlanText(option.note, `${name}.note`, { max: DIET_PLAN_LIMITS.note, optional: true });
  if (type === 'recipe') {
    if (option.recipeId == null || option.recipeId === '') fail('invalid-argument', `${name}.recipeId obbligatorio`);
    const multiplier = option.recipeMultiplier == null ? 1 : Number(option.recipeMultiplier);
    if (!Number.isFinite(multiplier) || multiplier < 0.1 || multiplier > 10) {
      fail('invalid-argument', `${name}.recipeMultiplier deve essere tra 0,1 e 10`);
    }
    if (option.blocks?.length || option.items?.length) {
      fail('invalid-argument', `${name}: le opzioni ricetta non contengono blocchi né ingredienti`);
    }
    return { optionId: option.optionId, type, recipeId: id(option.recipeId, `${name}.recipeId`), recipeMultiplier: multiplier, note };
  }
  if (option.recipeId != null) fail('invalid-argument', `${name}.recipeId non ammesso fuori dalle opzioni ricetta`);
  if (type === 'ingredients') {
    if (!Array.isArray(option.items) || !option.items.length) fail('invalid-argument', `${name}.items: serve almeno un ingrediente`);
    if (option.items.length > DIET_PLAN_LIMITS.itemsPerOption) fail('invalid-argument', `${name}.items: massimo ${DIET_PLAN_LIMITS.itemsPerOption}`);
    if (option.blocks?.length) fail('invalid-argument', `${name}: tipi di opzione mutuamente esclusivi`);
    return {
      optionId: option.optionId, type, note,
      items: option.items.map((item, index) => validateDietPlanItem(item, `${name}.items[${index}]`))
    };
  }
  if (!Array.isArray(option.blocks) || !option.blocks.length) fail('invalid-argument', `${name}.blocks: serve almeno un blocco`);
  if (option.blocks.length > DIET_PLAN_LIMITS.blocksPerOption) fail('invalid-argument', `${name}.blocks: massimo ${DIET_PLAN_LIMITS.blocksPerOption}`);
  if (option.items?.length) fail('invalid-argument', `${name}: tipi di opzione mutuamente esclusivi`);
  return {
    optionId: option.optionId, type, note,
    blocks: option.blocks.map((block, index) => validateDietPlanBlock(block, `${name}.blocks[${index}]`))
  };
}

function validateDietPlanMeal(meal, name) {
  exactObject(meal, ['mealId', 'time', 'options', 'note'], name);
  const mealId = text(meal.mealId, `${name}.mealId`);
  if (!DIET_PLAN_MEAL_IDS.has(mealId)) fail('invalid-argument', `${name}.mealId non valido`);
  const time = meal.time == null || meal.time === '' ? '' : text(meal.time, `${name}.time`, { max: 10, pattern: /^\d{1,2}[:.]\d{2}$/ });
  if (!Array.isArray(meal.options) || !meal.options.length || meal.options.length > DIET_PLAN_LIMITS.optionsPerMeal) {
    fail('invalid-argument', `${name}.options: da 1 a ${DIET_PLAN_LIMITS.optionsPerMeal} opzioni`);
  }
  const optionIds = new Set();
  meal.options.forEach((option, index) => {
    if (optionIds.has(option?.optionId)) fail('invalid-argument', `${name}: optionId duplicato (${option?.optionId})`);
    optionIds.add(option?.optionId);
  });
  return {
    mealId,
    time,
    options: meal.options.map((option, index) => validateDietPlanOption(option, `${name}.options[${index}]`)),
    note: dietPlanText(meal.note, `${name}.note`, { max: DIET_PLAN_LIMITS.note, optional: true })
  };
}

function validateDietPlanDay(day, name) {
  exactObject(day, ['dayId', 'label', 'dayType', 'meals', 'supplements', 'hydration', 'note'], name);
  const dayId = text(day.dayId, `${name}.dayId`, { max: 64, pattern: /^[a-z0-9][a-z0-9-]{0,63}$/ });
  const dayType = text(day.dayType, `${name}.dayType`);
  if (!DIET_PLAN_DAY_TYPES.has(dayType)) fail('invalid-argument', `${name}.dayType non valido`);
  const label = dietPlanText(day.label, `${name}.label`, { max: DIET_PLAN_LIMITS.label, optional: true });
  if (!Array.isArray(day.meals) || !day.meals.length || day.meals.length > DIET_PLAN_LIMITS.mealsPerDay) {
    fail('invalid-argument', `${name}.meals: da 1 a ${DIET_PLAN_LIMITS.mealsPerDay} pasti`);
  }
  const mealIds = new Set();
  day.meals.forEach(meal => {
    if (mealIds.has(meal?.mealId)) fail('invalid-argument', `${name}: pasto duplicato (${meal?.mealId})`);
    mealIds.add(meal?.mealId);
  });
  return {
    dayId,
    label,
    dayType,
    meals: day.meals.map((meal, index) => validateDietPlanMeal(meal, `${name}.meals[${index}]`)),
    supplements: dietPlanText(day.supplements, `${name}.supplements`, { max: DIET_PLAN_LIMITS.note, optional: true }),
    hydration: dietPlanText(day.hydration, `${name}.hydration`, { max: DIET_PLAN_LIMITS.note, optional: true }),
    note: dietPlanText(day.note, `${name}.note`, { max: DIET_PLAN_LIMITS.note, optional: true })
  };
}

function validateDietPlan(plan) {
  if (!plan || typeof plan !== 'object') fail('invalid-argument', 'dietPlan mancante');
  exactObject(plan, ['schemaVersion', 'days', 'generalNotes'], 'dietPlan');
  if (Number(plan.schemaVersion) !== DIET_PLAN_SCHEMA_VERSION) {
    fail('invalid-argument', `dietPlan.schemaVersion non supportata (${plan.schemaVersion})`);
  }
  if (!Array.isArray(plan.days) || !plan.days.length || plan.days.length > DIET_PLAN_LIMITS.days) {
    fail('invalid-argument', `dietPlan.days: da 1 a ${DIET_PLAN_LIMITS.days} giornate`);
  }
  const dayIds = new Set();
  plan.days.forEach(day => {
    if (dayIds.has(day?.dayId)) fail('invalid-argument', `dietPlan: dayId duplicato (${day?.dayId})`);
    dayIds.add(day?.dayId);
  });
  return {
    schemaVersion: DIET_PLAN_SCHEMA_VERSION,
    days: plan.days.map((day, index) => validateDietPlanDay(day, `dietPlan.days[${index}]`)),
    generalNotes: dietPlanText(plan.generalNotes, 'dietPlan.generalNotes', { max: DIET_PLAN_LIMITS.generalNotes, optional: true })
  };
}

// ---------------------------------------------------------------------
// Template equivalenze (organization-scoped, revisioni immutabili).
// Famiglia di riferimento obbligatoria (mai categorie vaghe), eventuale
// ingrediente di riferimento, quantità di riferimento ed equivalenti
// proporzionali. L'esistenza di famiglie/ingredienti nel catalogo è
// verificata dalla callable: qui solo forma e coerenza.
// ---------------------------------------------------------------------

const EQUIVALENCE_TEMPLATE_SCHEMA_VERSION = 1;
const EQUIVALENCE_TEMPLATE_LIMITS = { name: 80, equivalents: 30, changelog: 500 };

function validateEquivalenceTemplateRevision(input) {
  if (!input || typeof input !== 'object') fail('invalid-argument', 'template mancante');
  exactObject(input, ['name', 'referenceFamilyId', 'referenceIngredientId', 'referenceAmount', 'equivalents'], 'template');
  const name = text(input.name, 'template.name', { min: 3, max: EQUIVALENCE_TEMPLATE_LIMITS.name });
  const referenceFamilyId = id(input.referenceFamilyId, 'template.referenceFamilyId');
  const referenceIngredientId = input.referenceIngredientId == null || input.referenceIngredientId === ''
    ? null
    : id(input.referenceIngredientId, 'template.referenceIngredientId');
  const referenceAmount = validateDietAmount(input.referenceAmount, 'template.referenceAmount');
  if (Number(referenceAmount.value) <= 0) fail('invalid-argument', 'template.referenceAmount deve essere maggiore di zero');
  if (!Array.isArray(input.equivalents) || !input.equivalents.length || input.equivalents.length > EQUIVALENCE_TEMPLATE_LIMITS.equivalents) {
    fail('invalid-argument', `template.equivalents: da 1 a ${EQUIVALENCE_TEMPLATE_LIMITS.equivalents}`);
  }
  const seen = new Set();
  const equivalents = input.equivalents.map((equivalent, index) => {
    exactObject(equivalent, ['familyId', 'ingredientId', 'amount'], `template.equivalents[${index}]`);
    const familyId = id(equivalent.familyId, `template.equivalents[${index}].familyId`);
    if (familyId === referenceFamilyId) {
      fail('invalid-argument', `template.equivalents[${index}]: la famiglia di riferimento non è un equivalente`);
    }
    const key = `${familyId}|${equivalent.ingredientId || ''}`;
    if (seen.has(key)) fail('invalid-argument', `template.equivalents: equivalente duplicato (${key})`);
    seen.add(key);
    return {
      familyId,
      ingredientId: equivalent.ingredientId == null || equivalent.ingredientId === ''
        ? null
        : id(equivalent.ingredientId, `template.equivalents[${index}].ingredientId`),
      amount: validateDietAmount(equivalent.amount, `template.equivalents[${index}].amount`)
    };
  });
  return { schemaVersion: EQUIVALENCE_TEMPLATE_SCHEMA_VERSION, name, referenceFamilyId, referenceIngredientId, referenceAmount, equivalents };
}

function equivalenceTemplateRevisionChecksum(revision) {
  return checksum({
    schemaVersion: EQUIVALENCE_TEMPLATE_SCHEMA_VERSION,
    name: revision.name,
    referenceFamilyId: revision.referenceFamilyId,
    referenceIngredientId: revision.referenceIngredientId,
    referenceAmount: revision.referenceAmount,
    equivalents: revision.equivalents
  });
}

function verifyEquivalenceTemplateRevision(value) {
  if (!value || value.status !== 'published') return false;
  if (Number(value.schemaVersion) !== EQUIVALENCE_TEMPLATE_SCHEMA_VERSION) return false;
  return value.checksum === equivalenceTemplateRevisionChecksum(value);
}

// ---------------------------------------------------------------------
// Richieste catalogo (flusso cliente → admin). Il cliente propone categoria
// e famiglia globale per un ingrediente non riconosciuto; l'amministratore
// accetta (con inserimento nel catalogo), modifica o rifiuta. Nessuna dose.
// ---------------------------------------------------------------------

const CATALOG_REQUEST_STATUSES = new Set(['pending', 'accepted', 'rejected', 'superseded']);

function validateCatalogRequestSubmit(input) {
  exactObject(input, ['ingredientText', 'proposedCategoryId', 'proposedFamilyId', 'idempotencyKey']);
  const ingredientText = text(input.ingredientText, 'ingredientText', { min: 2, max: 120 });
  return {
    ingredientText,
    normalizedIngredient: normalizeIngredient(input.ingredientText),
    proposedCategoryId: id(input.proposedCategoryId, 'proposedCategoryId'),
    proposedFamilyId: id(input.proposedFamilyId, 'proposedFamilyId'),
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
}

// Payload di risoluzione admin: accept usa la proposta (con eventuali
// correzioni), edit impone l'ingrediente corretto, reject richiede un motivo.
function validateCatalogRequestResolve(input) {
  exactObject(input, ['requestId', 'action', 'ingredient', 'reason', 'idempotencyKey']);
  const requestId = id(input.requestId, 'requestId');
  const action = text(input.action, 'action', { pattern: /^(accept|edit|reject)$/ });
  const idempotencyKey = id(input.idempotencyKey, 'idempotencyKey');
  if (action === 'reject') {
    const reason = text(input.reason, 'reason', { min: 3, max: 500 });
    if (input.ingredient != null) fail('invalid-argument', 'ingredient non ammesso con action reject');
    return { requestId, action, ingredient: null, reason, idempotencyKey };
  }
  const raw = input.ingredient;
  if (!raw || typeof raw !== 'object') fail('invalid-argument', 'ingredient obbligatorio');
  exactObject(raw, ['ingredientId', 'displayName', 'aliases', 'categoryId', 'familyId', 'vegetarian', 'vegan'], 'ingredient');
  const ingredientId = String(raw.ingredientId || '').trim();
  if (!CATALOG_INGREDIENT_ID_PATTERN.test(ingredientId)) fail('invalid-argument', 'ingredient.ingredientId non valido');
  const displayName = text(raw.displayName, 'ingredient.displayName', { max: 160 });
  const aliases = Array.isArray(raw.aliases)
    ? [...new Set(raw.aliases.map(alias => normalizeIngredient(alias)).filter(Boolean))].slice(0, 100)
    : [];
  const categoryId = id(raw.categoryId, 'ingredient.categoryId');
  const familyId = id(raw.familyId, 'ingredient.familyId');
  if (typeof raw.vegetarian !== 'boolean' || typeof raw.vegan !== 'boolean') {
    fail('invalid-argument', 'ingredient: vegetarian e vegan devono essere booleani');
  }
  return {
    requestId,
    action,
    ingredient: {
      ingredientId,
      displayName,
      aliases,
      categoryId,
      familyId,
      dietaryFlags: { vegetarian: raw.vegetarian, vegan: raw.vegan }
    },
    reason: optionalText(input.reason, 'reason', 500) || '',
    idempotencyKey
  };
}

// ---------------------------------------------------------------------
// Catalogo ingredienti globale — import v2 (identità e solo identità).
// Ingredienti, categorie e FAMIGLIE con flag dietetici; nessuna dose, nessun
// mapping clinico: qualsiasi chiave che somigli a una quantità rifiuta il
// file. Le dosi appartengono a template equivalenze e strutture, mai al
// catalogo.
// ---------------------------------------------------------------------

const CATALOG_IMPORT_FORMATS = new Set(['json', 'csv']);
const CATALOG_IMPORT_MODES = new Set(['dry-run', 'commit', 'restore']);
const CATALOG_CSV_COLUMNS = ['ingredientId', 'displayName', 'aliases', 'categoryId', 'familyId', 'vegetarian', 'vegan'];
const CATALOG_INGREDIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,95}$/;
const CATALOG_CATEGORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const CATALOG_FAMILY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const CATALOG_DOSE_KEY_PATTERN = /(quantit|grams?|doses?|slots?|portions?|kgs?|millilit|calor)/i;

function assertNoDoseKeys(value, where) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoDoseKeys(item, `${where}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      if (CATALOG_DOSE_KEY_PATTERN.test(key)) {
        fail('invalid-argument', `${where}: campo dose vietato nel catalogo ("${key}")`);
      }
      assertNoDoseKeys(item, `${where}.${key}`);
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
  for (const required of ['ingredientId', 'displayName', 'categoryId', 'familyId']) {
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
    // Le colonne dietetiche diventano subito `dietaryFlags`: la riga esce dal
    // parser già nella forma canonica accettata da validateCatalogIngredient.
    if ('vegetarian' in row || 'vegan' in row) {
      const vegetarian = row.vegetarian === '' ? undefined : row.vegetarian === 'true' || row.vegetarian === '1';
      const vegan = row.vegan === '' ? undefined : row.vegan === 'true' || row.vegan === '1';
      row.dietaryFlags = {
        ...(vegetarian !== undefined ? { vegetarian } : {}),
        ...(vegan !== undefined ? { vegan } : {})
      };
      delete row.vegetarian;
      delete row.vegan;
    }
    row.__line = index + 2;
    return row;
  });
}

function parseCatalogPayload(format, payload) {
  const clean = text(format, 'format');
  if (!CATALOG_IMPORT_FORMATS.has(clean)) fail('invalid-argument', 'format non valido (json|csv)');
  if (clean === 'csv') {
    return { ingredients: parseCatalogCsv(payload), categories: [], families: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(payload || ''));
  } catch (_) {
    fail('invalid-argument', 'JSON non valido');
  }
  assertNoDoseKeys(parsed, 'payload');
  if (!Array.isArray(parsed)) exactObject(parsed, ['ingredients', 'categories', 'families'], 'payload');
  const ingredients = Array.isArray(parsed) ? parsed : parsed?.ingredients;
  const categories = Array.isArray(parsed) ? [] : (parsed?.categories == null ? [] : parsed.categories);
  const families = Array.isArray(parsed) ? [] : (parsed?.families == null ? [] : parsed.families);
  if (!Array.isArray(ingredients)) fail('invalid-argument', 'JSON: array radice o oggetto con chiave "ingredients"');
  if (!Array.isArray(categories)) fail('invalid-argument', 'JSON: "categories" deve essere un array');
  if (!Array.isArray(families)) fail('invalid-argument', 'JSON: "families" deve essere un array');
  if (ingredients.length === 0 && categories.length === 0 && families.length === 0) {
    fail('invalid-argument', 'Import vuoto: niente da elaborare');
  }
  if (ingredients.length > 5000) fail('invalid-argument', 'Import troppo grande: massimo 5000 ingredienti per file');
  if (families.length > 500) fail('invalid-argument', 'Import troppo grande: massimo 500 famiglie per file');
  return { ingredients, categories, families };
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

// Normalizza e valida una famiglia del file. `knownCategories` unisce le
// categorie del file + quelle del catalogo corrente. Gli errori sono
// raccolti (non lanciati) per produrre il report dry-run completo.
function validateCatalogFamily(raw, knownCategories, errors, where) {
  const label = where || `famiglie[${raw?.familyId || '?'}]`;
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${label}: voce non valida`);
    return null;
  }
  assertNoDoseKeys(raw, label);
  const extra = Object.keys(raw).filter(key => !['familyId', 'displayName', 'categoryId', 'sortOrder', 'status', '__line'].includes(key) && !key.startsWith('__'));
  extra.forEach(key => problems.push(`campo non riconosciuto ("${key}")`));
  const familyId = String(raw.familyId || '').trim();
  if (!CATALOG_FAMILY_ID_PATTERN.test(familyId)) problems.push('familyId non valido (minuscolo, trattini, 2-64 caratteri)');
  const displayName = String(raw.displayName || '').trim();
  if (!displayName || displayName.length > 100) problems.push('displayName obbligatorio (max 100)');
  const categoryId = String(raw.categoryId || '').trim();
  if (!CATALOG_CATEGORY_ID_PATTERN.test(categoryId)) problems.push('categoryId non valido');
  else if (!knownCategories.has(categoryId)) problems.push(`categoryId inesistente ("${categoryId}")`);
  let sortOrder = 0;
  if (raw.sortOrder != null && raw.sortOrder !== '') {
    sortOrder = Number(raw.sortOrder);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) problems.push('sortOrder intero ≥ 0');
  }
  const status = raw.status == null || raw.status === '' ? 'active' : String(raw.status);
  if (!['active', 'archived'].includes(status)) problems.push('status non valido (active|archived)');
  if (problems.length) {
    errors.push(`${label}: ${problems.join('; ')}`);
    return null;
  }
  return {
    familyId,
    displayName,
    normalizedName: aliasKey(displayName),
    categoryId,
    sortOrder,
    status
  };
}

// Normalizza e valida un ingrediente del file. L'ingrediente dichiara la
// famiglia globale; la categoria deve coincidere con quella della famiglia
// (coerenza verificata in validateCatalogImport dopo il caricamento).
// `searchTokens` sono SEMPRE rigenerati server-side, mai dal file.
function validateCatalogIngredient(raw, knownCategories, knownFamilies, errors, where) {
  const label = where || `ingredienti[${raw?.ingredientId || '?'}]`;
  const problems = [];
  const push = message => { problems.push(message); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${label}: voce non valida`);
    return null;
  }
  assertNoDoseKeys(raw, label);
  const extra = Object.keys(raw).filter(key => !['ingredientId', 'displayName', 'aliases', 'categoryId', 'familyId', 'dietaryFlags', 'status', '__line'].includes(key) && !key.startsWith('__'));
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
  const familyId = String(raw.familyId || '').trim();
  if (!CATALOG_FAMILY_ID_PATTERN.test(familyId)) push('familyId non valido');
  else if (knownFamilies && !knownFamilies.has(familyId)) push(`familyId inesistente ("${familyId}")`);
  // Flag dietetici: booleani, default false quando assenti (il flag dice cosa
  // l'alimento È, non cosa contiene in minima parte).
  const flagsRaw = raw.dietaryFlags && typeof raw.dietaryFlags === 'object' ? raw.dietaryFlags : {};
  if (flagsRaw.vegetarian != null && typeof flagsRaw.vegetarian !== 'boolean') push('dietaryFlags.vegetarian deve essere booleano');
  if (flagsRaw.vegan != null && typeof flagsRaw.vegan !== 'boolean') push('dietaryFlags.vegan deve essere booleano');
  const vegetarian = flagsRaw.vegetarian === true;
  const vegan = flagsRaw.vegan === true;
  if (vegan && !vegetarian) push('dietaryFlags: vegan implica vegetarian');
  const status = raw.status == null || raw.status === '' ? 'active' : String(raw.status);
  if (!['active', 'archived'].includes(status)) push('status non valido (active|archived)');
  if (problems.length) {
    errors.push(`${label}: ${problems.join('; ')}`);
    return null;
  }
  return {
    ingredientId,
    displayName,
    normalizedName: aliasKey(displayName),
    categoryId,
    familyId,
    aliases,
    searchTokens: searchTokensFor(displayName, aliases),
    dietaryFlags: { vegetarian, vegan },
    status
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
    .forEach(key => problems.push(`campo non riconosciuto ("${key}")`));
  const categoryId = String(raw.categoryId || '').trim();
  if (!CATALOG_CATEGORY_ID_PATTERN.test(categoryId)) problems.push(`${label}: categoryId non valido`);
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
    displayName: a.displayName, categoryId: a.categoryId, familyId: a.familyId,
    aliases: [...(a.aliases || [])].sort(),
    dietaryFlags: a.dietaryFlags, status: a.status
  }) === canonicalJson({
    displayName: b.displayName, categoryId: b.categoryId, familyId: b.familyId,
    aliases: [...(b.aliases || [])].sort(),
    dietaryFlags: b.dietaryFlags, status: b.status
  });
}

function sameCatalogFamily(a, b) {
  return canonicalJson({
    displayName: a.displayName, categoryId: a.categoryId, sortOrder: a.sortOrder, status: a.status
  }) === canonicalJson({
    displayName: b.displayName, categoryId: b.categoryId, sortOrder: b.sortOrder, status: b.status
  });
}

// Validazione completa del file contro il catalogo corrente. Ritorna sempre
// il report (conteggi + diff ≤200 + errori); il commit è consentito solo con
// zero errori. `existing` = {ingredients, categories, families} del catalogo
// corrente, `denylist` = array di ingredientId provvisori bloccati
// (configurazione server-side, mai nel repository).
function validateCatalogImport(parsed, { existingIngredients = {}, existingCategories = [], existingFamilies = {}, denylist = [] } = {}) {
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
  const knownCategories = new Set([...(existingCategories || []), ...fileCategoryIds]);
  // Famiglie: stesse regole delle categorie, con categoria nota.
  const fileFamilies = [];
  const fileFamilyIds = new Set();
  const familyById = new Map(Object.entries(existingFamilies || {}));
  (parsed.families || []).forEach((raw, index) => {
    const normalized = validateCatalogFamily(raw, knownCategories, errors, `famiglie[${index}]`);
    if (!normalized) return;
    const existing = familyById.get(normalized.familyId);
    if (existing) {
      diff.push({
        familyId: normalized.familyId,
        change: sameCatalogFamily(existing, normalized) ? 'identical' : 'update',
        detail: sameCatalogFamily(existing, normalized) ? 'famiglia già identica' : 'aggiorna metadati famiglia'
      });
    } else {
      diff.push({ familyId: normalized.familyId, change: 'create', detail: 'nuova famiglia' });
    }
    if (fileFamilyIds.has(normalized.familyId)) {
      errors.push(`famiglie[${normalized.familyId}]: familyId duplicato nel file`);
      return;
    }
    fileFamilyIds.add(normalized.familyId);
    fileFamilies.push(normalized);
    familyById.set(normalized.familyId, normalized);
  });
  // Ingredienti: normalizzazione, dedup, denylist, collisioni alias,
  // coerenza categoria↔famiglia.
  const normalized = [];
  const seenIds = new Set();
  const fileKeysById = new Map();
  (parsed.ingredients || []).forEach((raw, index) => {
    const label = `ingredienti[${raw?.ingredientId || `riga ${raw?.__line || index + 1}`}]`;
    const entry = validateCatalogIngredient(raw, knownCategories, familyById, errors, label);
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
    const family = familyById.get(entry.familyId);
    if (family && family.categoryId !== entry.categoryId) {
      errors.push(`${label}: categoryId (${entry.categoryId}) diverso da quello della famiglia ${entry.familyId} (${family.categoryId})`);
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
    else diff.push({ ingredientId: entry.ingredientId, change: 'update', detail: 'aggiorna identità (mai quantità)' });
  });
  const counts = { create: 0, identical: 0, update: 0, conflicts: 0, errors: errors.length };
  diff.forEach(row => {
    if (row.change === 'create') counts.create += 1;
    else if (row.change === 'identical') counts.identical += 1;
    else if (row.change === 'update') counts.update += 1;
    else if (row.change === 'conflict') counts.conflicts += 1;
  });
  return {
    normalized: { ingredients: normalized, categories: fileCategories, families: fileFamilies },
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
    categories: [...(normalized?.categories || [])].sort((a, b) => String(a.categoryId).localeCompare(String(b.categoryId))),
    families: [...(normalized?.families || [])].sort((a, b) => String(a.familyId).localeCompare(String(b.familyId)))
  });
}

// ---------------------------------------------------------------------
// Utenti, inviti e associazioni nutritionist-cliente (Fase 2)
// ---------------------------------------------------------------------

function validateInviteOrganizationUser(input) {
  exactObject(input, ['organizationId', 'username', 'email', 'firstName', 'lastName', 'role', 'idempotencyKey']);
  const role = input.role ? text(input.role, 'role') : 'nutritionist';
  if (role !== 'nutritionist') fail('invalid-argument', 'role ammesso: solo nutritionist');
  const result = {
    organizationId: id(input.organizationId, 'organizationId'),
    role,
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
  if (input.email) {
    result.email = normalizeEmail(input.email);
    result.firstName = input.firstName ? text(input.firstName, 'firstName', { min: 1, max: 80, pattern: PERSON_NAME_PATTERN }) : null;
    result.lastName = input.lastName ? text(input.lastName, 'lastName', { min: 1, max: 80, pattern: PERSON_NAME_PATTERN }) : null;
  } else if (input.username) {
    result.username = normalizeUsername(input.username);
  } else {
    fail('invalid-argument', 'Specificare email o username del professionista');
  }
  return result;
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

// Invito cliente con EMAIL REALE + nome + cognome (nuovo flusso, ADR 0004).
// Gli indirizzi tecnici legacy sono rifiutati qui: la creazione di account di
// test passa solo dal flusso legacy esplicito (`inviteClientLink`).
// Il link viene sempre consegnato a mano dalla console: il payload non ha più
// alcuna scelta di consegna (un vecchio campo `delivery` è rifiutato come
// campo non ammesso, così una console non aggiornata se ne accorge subito).
function validateInviteClientEmail(input) {
  exactObject(input, ['organizationId', 'email', 'firstName', 'lastName', 'nutritionistUid', 'idempotencyKey']);
  const rawEmail = text(input.email, 'email', { min: 5, max: EMAIL_MAX_LENGTH });
  if (isLegacyTestEmail(rawEmail)) {
    fail('invalid-argument', 'Per i clienti reali serve un indirizzo email reale: gli indirizzi tecnici si gestiscono solo dal flusso legacy di test');
  }
  return {
    organizationId: id(input.organizationId, 'organizationId'),
    email: normalizeEmail(rawEmail),
    firstName: text(input.firstName, 'firstName', { min: 1, max: 80, pattern: PERSON_NAME_PATTERN }),
    lastName: text(input.lastName, 'lastName', { min: 1, max: 80, pattern: PERSON_NAME_PATTERN }),
    nutritionistUid: input.nutritionistUid == null || input.nutritionistUid === ''
      ? null
      : text(input.nutritionistUid, 'nutritionistUid', { max: 128 }),
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
}

// Correzione di un invito email pendente o scaduto (email, nome, cognome).
function validateCorrectClientInvite(input) {
  exactObject(input, ['organizationId', 'inviteId', 'email', 'firstName', 'lastName', 'idempotencyKey']);
  const inviteInput = validateInviteClientEmail({
    organizationId: input.organizationId,
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    nutritionistUid: null,
    idempotencyKey: input.idempotencyKey
  });
  return { ...inviteInput, inviteId: id(input.inviteId, 'inviteId') };
}

function validateResendClientInvite(input) {
  exactObject(input, ['organizationId', 'inviteId', 'idempotencyKey']);
  return {
    organizationId: id(input.organizationId, 'organizationId'),
    inviteId: id(input.inviteId, 'inviteId'),
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
}

// Recupero del link di un invito già emesso (bottone "Copia link" della
// console). Nessun nuovo token e nessuna idempotencyKey: l'operazione è una
// lettura autorizzata del segreto dell'invito, ripetibile quante volte serve
// finché il cliente non è attivo.
function validateGetInviteLink(input) {
  exactObject(input, ['organizationId', 'inviteId']);
  return {
    organizationId: id(input.organizationId, 'organizationId'),
    inviteId: id(input.inviteId, 'inviteId')
  };
}

function validateCancelClientInvite(input) {
  exactObject(input, ['organizationId', 'inviteId', 'reason', 'idempotencyKey']);
  return {
    organizationId: id(input.organizationId, 'organizationId'),
    inviteId: id(input.inviteId, 'inviteId'),
    reason: text(input.reason, 'reason', { min: 3, max: 500 }),
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
}

// Anagrafica del cliente aggiornata dal nutrizionista (nome, cognome ed email facoltativa).
function validateUpdateClientProfileByStaff(input) {
  exactObject(input, ['organizationId', 'clientId', 'firstName', 'lastName', 'idempotencyKey', 'email']);
  const result = {
    organizationId: id(input.organizationId, 'organizationId'),
    clientId: id(input.clientId, 'clientId'),
    firstName: text(input.firstName, 'firstName', { min: 1, max: 80, pattern: PERSON_NAME_PATTERN }),
    lastName: text(input.lastName, 'lastName', { min: 1, max: 80, pattern: PERSON_NAME_PATTERN }),
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
  if (input.email !== undefined && input.email !== null && String(input.email).trim() !== '') {
    result.email = normalizeEmail(input.email);
  }
  return result;
}

// Eliminazione definitiva di un cliente dalla piattaforma (solo admin).
function validateDeleteClientPermanently(input) {
  exactObject(input, ['organizationId', 'clientId', 'idempotencyKey']);
  return {
    organizationId: id(input.organizationId, 'organizationId'),
    clientId: id(input.clientId, 'clientId'),
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
}

// Anagrafica del professionista (firstName, lastName ed eventuale email) gestita solo da admin
// via updateMemberProfileByStaff (Sessione 1).
function validateUpdateMemberProfileByStaff(input) {
  exactObject(input, ['organizationId', 'userId', 'firstName', 'lastName', 'email', 'idempotencyKey']);
  const result = {
    organizationId: id(input.organizationId, 'organizationId'),
    userId: text(input.userId, 'userId', { max: 128 }),
    firstName: text(input.firstName, 'firstName', { min: 1, max: 80, pattern: PERSON_NAME_PATTERN }),
    lastName: text(input.lastName, 'lastName', { min: 1, max: 80, pattern: PERSON_NAME_PATTERN }),
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
  if (input.email !== undefined && input.email !== null && String(input.email).trim() !== '') {
    result.email = normalizeEmail(input.email);
  }
  return result;
}

// Proposta di cambio email per un cliente già registrato: non modifica nulla
// finché il cliente non conferma (nessun takeover possibile).
function validateProposeClientEmailChange(input) {
  exactObject(input, ['organizationId', 'clientId', 'newEmail', 'reason', 'idempotencyKey']);
  const rawEmail = text(input.newEmail, 'newEmail', { min: 5, max: EMAIL_MAX_LENGTH });
  if (isLegacyTestEmail(rawEmail)) {
    fail('invalid-argument', 'Per il cambio email serve un indirizzo reale: gli indirizzi tecnici restano solo sugli account di test esistenti');
  }
  return {
    organizationId: id(input.organizationId, 'organizationId'),
    clientId: id(input.clientId, 'clientId'),
    newEmail: normalizeEmail(rawEmail, 'newEmail'),
    reason: optionalText(input.reason, 'reason', 300) || '',
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
}

function validateRespondClientEmailChange(input) {
  exactObject(input, ['requestId', 'decision', 'idempotencyKey']);
  const decision = text(input.decision, 'decision');
  if (decision !== 'accept' && decision !== 'reject') fail('invalid-argument', 'decision non valida (accept|reject)');
  return {
    requestId: id(input.requestId, 'requestId'),
    decision,
    idempotencyKey: id(input.idempotencyKey, 'idempotencyKey')
  };
}

// Riscatto invito email: il token è facoltativo perché il collegamento può
// essere completato anche solo con l'email autenticata e verificata.
function validateRedeemClientInvite(input) {
  exactObject(input, ['token', 'idempotencyKey']);
  const token = input.token == null || input.token === ''
    ? null
    : text(input.token, 'token', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
  return { token, idempotencyKey: id(input.idempotencyKey, 'idempotencyKey') };
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

// ---- Ricettario professionisti (ADR 0006) ----
// Slot pasti: stessi ID del client (js/domain.js SLOTS e MEAL_SLOTS in
// js/app.js). La parità esatta è verificata dai test
// (functions/test/domain.test.js). Le ricette restano server-only: nessun
// accesso diretto da rules (catch-all organizations), solo callable.
const RECIPE_SLOTS = new Set(['breakfast', 'snack1', 'lunch', 'snack2', 'dinner']);
const PROFESSIONAL_RECIPE_VISIBILITY = new Set(['private', 'studio']);
const PROFESSIONAL_RECIPE_LIMITS = {
  name: 120, emoji: 12, proteinCategory: 40,
  ingredients: 100, ingredientName: 120, portion: 40,
  steps: 50, step: 500, notes: 20, note: 500
};

function validateProfessionalRecipePortions(portions) {
  if (portions == null) return { single: null };
  exactObject(portions, ['single'], 'portions');
  const single = optionalText(portions.single, 'portions.single', PROFESSIONAL_RECIPE_LIMITS.portion);
  return { single };
}

function validateProfessionalRecipeIngredient(ingredient, index) {
  const where = `ingredients[${index}]`;
  exactObject(ingredient, ['name', 'ingredientId', 'portions'], where);
  return {
    name: text(ingredient.name, `${where}.name`, { max: PROFESSIONAL_RECIPE_LIMITS.ingredientName }),
    ingredientId: ingredient.ingredientId == null || ingredient.ingredientId === ''
      ? null
      : id(ingredient.ingredientId, `${where}.ingredientId`),
    portions: validateProfessionalRecipePortions(ingredient.portions)
  };
}

function validateProfessionalRecipe(recipe) {
  exactObject(recipe, ['name', 'emoji', 'slot', 'proteinCategory', 'ingredients', 'steps', 'notes'], 'recipe');
  if (!RECIPE_SLOTS.has(recipe.slot)) fail('invalid-argument', 'recipe.slot non valido');
  if (!Array.isArray(recipe.ingredients) || !recipe.ingredients.length || recipe.ingredients.length > PROFESSIONAL_RECIPE_LIMITS.ingredients) {
    fail('invalid-argument', 'recipe.ingredients non validi');
  }
  const steps = recipe.steps == null ? [] : recipe.steps;
  const notes = recipe.notes == null ? [] : recipe.notes;
  if (!Array.isArray(steps) || steps.length > PROFESSIONAL_RECIPE_LIMITS.steps) fail('invalid-argument', 'recipe.steps non validi');
  if (!Array.isArray(notes) || notes.length > PROFESSIONAL_RECIPE_LIMITS.notes) fail('invalid-argument', 'recipe.notes non validi');
  return {
    name: text(recipe.name, 'recipe.name', { max: PROFESSIONAL_RECIPE_LIMITS.name }),
    emoji: optionalText(recipe.emoji, 'recipe.emoji', PROFESSIONAL_RECIPE_LIMITS.emoji),
    slot: recipe.slot,
    proteinCategory: optionalText(recipe.proteinCategory, 'recipe.proteinCategory', PROFESSIONAL_RECIPE_LIMITS.proteinCategory),
    ingredients: recipe.ingredients.map((ingredient, index) => validateProfessionalRecipeIngredient(ingredient, index)),
    steps: steps.map((step, index) => text(step, `steps[${index}]`, { max: PROFESSIONAL_RECIPE_LIMITS.step })),
    notes: notes.map((note, index) => text(note, `notes[${index}]`, { max: PROFESSIONAL_RECIPE_LIMITS.note }))
  };
}

module.exports = {
  SINGLE_ORGANIZATION_ID,
  ROLES, ASSIGNMENT_STATUSES, MEMBER_STATUSES,
  STRUCTURE_REVISION_SCHEMA_VERSION,
  fail, exactObject, text, optionalText, id, isoDate, canonicalJson, checksum,
  normalizeIngredient, aliasKey, searchTokensFor, normalizeUsername, hashToken,
  validateStructureAssignment, structureRevisionChecksum, verifyStructureRevision, effectiveAssignment,
  DIET_PLAN_SCHEMA_VERSION, DIET_PLAN_DAY_TYPES, DIET_PLAN_MEAL_IDS, DIET_PLAN_UNITS,
  DIET_PLAN_OPTION_TYPES, DIET_PLAN_LIMITS, validateDietPlan,
  EQUIVALENCE_TEMPLATE_SCHEMA_VERSION, EQUIVALENCE_TEMPLATE_LIMITS,
  validateEquivalenceTemplateRevision, equivalenceTemplateRevisionChecksum, verifyEquivalenceTemplateRevision,
  CATALOG_REQUEST_STATUSES, validateCatalogRequestSubmit, validateCatalogRequestResolve,
  CATALOG_IMPORT_MODES, CATALOG_CSV_COLUMNS,
  CATALOG_CATEGORY_ID_PATTERN, CATALOG_FAMILY_ID_PATTERN,
  parseCatalogPayload, parseCatalogCsv, validateCatalogImport, validateCatalogIngredient,
  validateCatalogFamily, catalogImportPreviewId,
  validateInviteOrganizationUser, validateInviteClientLink, validateRespondClientLink,
  validateRemoveClientLink, validateMemberStatus, validateRemoveNutritionist,
  validateTransferStructureOwnership,
  LEGACY_TEST_EMAIL_DOMAINS, EMAIL_MAX_LENGTH, PERSON_NAME_PATTERN,
  INVITE_DELIVERY_CHANNEL, EMAIL_CHANGE_STATUSES, CLIENT_EMAIL_INVITE_STATUSES,
  normalizeEmail, emailDomainOf, isLegacyTestEmail, emailFingerprint, maskEmail,
  validateInviteClientEmail, validateCorrectClientInvite, validateResendClientInvite,
  validateGetInviteLink,
  validateCancelClientInvite, validateUpdateClientProfileByStaff, validateDeleteClientPermanently, validateUpdateMemberProfileByStaff,
  validateProposeClientEmailChange, validateRespondClientEmailChange, validateRedeemClientInvite,
  RECIPE_SLOTS, PROFESSIONAL_RECIPE_VISIBILITY, PROFESSIONAL_RECIPE_LIMITS,
  validateProfessionalRecipePortions, validateProfessionalRecipeIngredient, validateProfessionalRecipe
};

