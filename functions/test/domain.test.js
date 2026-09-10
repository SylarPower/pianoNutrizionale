'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalJson, checksum, normalizeIngredient, reportKey, validateReport,
  validateMapping, validateRuleSetRules, validateAssignment, validateStructureAssignment, validateDietStructureRules, effectiveAssignment
} = require('../src/domain');

test('canonicalJson e checksum sono indipendenti dall’ordine delle chiavi', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(checksum({ b: 2, a: 1 }), checksum({ a: 1, b: 2 }));
});

test('normalizzazione ingrediente è deterministica e minimizza il fingerprint', () => {
  assert.equal(normalizeIngredient('  Rìso   Venere! '), 'riso venere');
});

test('reportKey deduplica lo stesso caso e separa versioni diverse', () => {
  const base = { organizationId: 'org-1', fingerprint: 'abc', ruleSetId: 'meller', ruleSetVersion: '3', errorType: 'unknown' };
  assert.equal(reportKey(base), reportKey({ ...base }));
  assert.notEqual(reportKey(base), reportKey({ ...base, ruleSetVersion: '4' }));
});

test('validateReport rifiuta campi extra e slot non clinici', () => {
  const valid = { clientProfileId: 'c1', fingerprint: 'fp', ingredientText: 'Riso', slot: 'lunch', errorType: 'unknown', ruleSetId: 'rs', ruleSetVersion: '3' };
  assert.equal(validateReport(valid).normalizedIngredient, 'riso');
  assert.throws(() => validateReport({ ...valid, authUid: 'leak' }), /campi non ammessi/);
  assert.throws(() => validateReport({ ...valid, slot: 'breakfast' }), /slot non valido/);
});

test('mapping guidato richiede tutte le dosi; libero non accetta dosi cliniche', () => {
  const guided = validateMapping({ kind: 'guided', canonicalIngredientId: 'riso', aliases: ['Riso'], family: 'riso', group: 'carb', doses: { lunch: { training: 90, rest: 70 }, dinner: { training: 40, rest: 40 } } });
  assert.equal(guided.aliases[0], 'riso');
  assert.throws(() => validateMapping({ ...guided, doses: { lunch: { training: 90, rest: 70 } } }), /mapping.doses/);
  const free = validateMapping({ kind: 'free', canonicalIngredientId: 'basilico', aliases: ['Basilico'], family: null, group: null, doses: null });
  assert.equal(free.group, 'free');
  assert.equal(free.doses, null);
});

test('rule set rifiuta famiglie duplicate e normalizza gli alias', () => {
  const rule = { family: 'pasta', group: 'carb', label: 'Pasta', aliases: ['Pàsta'], slots: { lunch: { training: 90, rest: 70 }, dinner: { training: 40, rest: 40 } } };
  assert.equal(validateRuleSetRules([rule])[0].aliases[0], 'pasta');
  assert.throws(() => validateRuleSetRules([rule, rule]), /duplicata/);
});

test('assignment valida checksum e intervallo temporale', () => {
  const input = {
    organizationId: 'org-1', clientId: 'client-1',
    ruleSet: { scope: 'tenant', ruleSetId: 'rs', version: '3', checksum: 'a'.repeat(64) },
    effectiveAt: '2026-09-09T10:00:00.000Z', expiresAt: '2026-10-09T10:00:00.000Z',
    strategy: 'migrate-on-confirmation', reason: 'Nuovo piano concordato', idempotencyKey: 'idem-1'
  };
  assert.equal(validateAssignment(input).ruleSet.version, '3');
  assert.throws(() => validateAssignment({ ...input, expiresAt: '2026-08-01T00:00:00Z' }), /successiva/);
  assert.throws(() => validateAssignment({ ...input, ruleSet: { ...input.ruleSet, checksum: 'bad' } }), /checksum/);
});

test('assenza, sospensione, programmazione e scadenza producono original-only', () => {
  const now = new Date('2026-09-09T12:00:00Z');
  assert.equal(effectiveAssignment(null, now).reason, 'missing');
  assert.equal(effectiveAssignment({ status: 'suspended', effectiveAt: '2026-09-01' }, now).valid, false);
  assert.equal(effectiveAssignment({ status: 'active', effectiveAt: '2026-09-10' }, now).reason, 'scheduled');
  assert.equal(effectiveAssignment({ status: 'active', effectiveAt: '2026-09-01', expiresAt: '2026-09-09T11:00:00Z' }, now).reason, 'expired');
  assert.equal(effectiveAssignment({ status: 'active', effectiveAt: '2026-09-01', expiresAt: null }, now).valid, true);
});

test('validateStructureAssignment (v2): risolve solo il contratto della modale', () => {
  const base = {
    organizationId: 'org-1', clientId: 'c1', ruleSetId: 'struttura-base',
    effectiveAt: '2026-09-12T09:00:00Z', expiresAt: '2026-12-31T00:00:00Z',
    withoutExpiration: false, notes: 'Percorso iniziale', idempotencyKey: 'k1'
  };
  const parsed = validateStructureAssignment(base);
  assert.equal(parsed.ruleSetId, 'struttura-base');
  assert.equal(parsed.notes, 'Percorso iniziale');
  assert.equal(parsed.withoutExpiration, false);
  // Il contratto rifiuta revisione/checksum/strategia inviati dal client.
  assert.throws(() => validateStructureAssignment({ ...base, checksum: 'a'.repeat(64) }), /campi non ammessi/);
  assert.throws(() => validateStructureAssignment({ ...base, strategy: 'freeze' }), /campi non ammessi/);
});

test('validateStructureAssignment: scadenza obbligatoria o flag esplicito', () => {
  const base = {
    organizationId: 'org-1', clientId: 'c1', ruleSetId: 'rs',
    effectiveAt: '2026-09-12T09:00:00Z', expiresAt: null,
    withoutExpiration: false, notes: '', idempotencyKey: 'k1'
  };
  // Senza scadenza E senza flag → rifiutato.
  assert.throws(() => validateStructureAssignment(base), /Senza scadenza/);
  // Con flag esplicito → accettato, expiresAt svuotato.
  const open = validateStructureAssignment({ ...base, withoutExpiration: true });
  assert.equal(open.expiresAt, null);
  assert.equal(open.withoutExpiration, true);
  // Flag attivo + data di scadenza → inconsistente.
  assert.throws(() => validateStructureAssignment({ ...base, withoutExpiration: true, expiresAt: '2026-12-31T00:00:00Z' }), /Senza scadenza/);
  // Note omessa → stringa vuota (nessun dato sanitario obbligatorio).
  assert.equal(validateStructureAssignment({ ...base, expiresAt: '2026-12-31T00:00:00Z' }).notes, '');
});

test('validateDietStructureRules: contratto revisione struttura (schema v2)', () => {
  const base = {
    mellerFamilyId: 'pane', ingredientIds: ['pane'],
    quantityGrams: { lunch: { training: 120, rest: 90 }, dinner: { training: 60, rest: 60 } },
    enabled: true, categoryId: 'pane'
  };
  const parsed = validateDietStructureRules([base])[0];
  assert.equal(parsed.mellerFamilyId, 'pane');
  assert.equal(parsed.quantityGrams.lunch.training, 120);
  // Un pasto può essere null (non gestito dalla struttura), mai entrambi.
  const onlyLunch = validateDietStructureRules([{ ...base, quantityGrams: { lunch: base.quantityGrams.lunch, dinner: null } }])[0];
  assert.equal(onlyLunch.quantityGrams.dinner, null);
  assert.throws(() => validateDietStructureRules([{ ...base, quantityGrams: { lunch: null, dinner: null } }]), /almeno una dose/);
  // Dosi fuori range o non intere → bloccanti, mai quantità inventate.
  assert.throws(() => validateDietStructureRules([{ ...base, quantityGrams: { ...base.quantityGrams, lunch: { training: 2001, rest: 10 } } }]), /1 e 2000/);
  assert.throws(() => validateDietStructureRules([{ ...base, quantityGrams: { ...base.quantityGrams, lunch: { training: 12.5, rest: 10 } } }]), /1 e 2000/);
  // enabled default true; enabled non booleano → errore.
  assert.equal(validateDietStructureRules([{ mellerFamilyId: 'x', quantityGrams: { lunch: { training: 10, rest: 10 }, dinner: null } }])[0].enabled, true);
  assert.throws(() => validateDietStructureRules([{ ...base, enabled: 'sì' }]), /booleano/);
});

test('validateDietStructureRules: niente famiglie duplicate né campi extra', () => {
  const rule = id => ({ mellerFamilyId: id, quantityGrams: { lunch: { training: 50, rest: 40 }, dinner: null } });
  assert.throws(() => validateDietStructureRules([rule('pane'), rule('pane')]), /duplicata/);
  assert.throws(() => validateDietStructureRules([{ ...rule('riso'), version: '3' }]), /campi non ammessi/);
  assert.throws(() => validateDietStructureRules([]), /tra 1 e 40/);
});
