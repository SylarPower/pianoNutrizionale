'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalJson, checksum, normalizeIngredient, reportKey, validateReport,
  validateMapping, validateRuleSetRules, validateAssignment, effectiveAssignment
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
