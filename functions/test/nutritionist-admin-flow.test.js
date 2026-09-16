'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const domain = require('../src/domain');

test('domain: validateInviteOrganizationUser accetta email reale e nome/cognome', () => {
  const valid = domain.validateInviteOrganizationUser({
    organizationId: 'pianoNutrizionale',
    email: 'dott.rossi@studio.it',
    firstName: 'Marco',
    lastName: 'Rossi',
    role: 'nutritionist',
    idempotencyKey: 'idem-1'
  });
  assert.equal(valid.email, 'dott.rossi@studio.it');
  assert.equal(valid.firstName, 'Marco');
  assert.equal(valid.lastName, 'Rossi');
  assert.equal(valid.role, 'nutritionist');
});

test('domain: validateInviteOrganizationUser retrocompatibile con username', () => {
  const valid = domain.validateInviteOrganizationUser({
    organizationId: 'pianoNutrizionale',
    username: 'dr_rossi',
    role: 'nutritionist',
    idempotencyKey: 'idem-legacy'
  });
  assert.equal(valid.username, 'dr_rossi');
  assert.equal(valid.role, 'nutritionist');
});

test('domain: validateUpdateMemberProfileByStaff accetta email opzionale normalizzata', () => {
  const valid = domain.validateUpdateMemberProfileByStaff({
    organizationId: 'pianoNutrizionale',
    userId: 'nutri-123',
    firstName: 'Marco',
    lastName: 'Bianchi',
    email: 'NUOVA.EMAIL@studio.it',
    idempotencyKey: 'idem-2'
  });
  assert.equal(valid.firstName, 'Marco');
  assert.equal(valid.lastName, 'Bianchi');
  assert.equal(valid.email, 'nuova.email@studio.it');
});

test('domain: validateUpdateMemberProfileByStaff funziona anche senza email', () => {
  const valid = domain.validateUpdateMemberProfileByStaff({
    organizationId: 'pianoNutrizionale',
    userId: 'nutri-123',
    firstName: 'Marco',
    lastName: 'Bianchi',
    idempotencyKey: 'idem-3'
  });
  assert.equal(valid.firstName, 'Marco');
  assert.equal(valid.lastName, 'Bianchi');
  assert.equal(valid.email, undefined);
});
