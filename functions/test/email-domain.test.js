'use strict';
/* Validazioni del modello con EMAIL REALE (ADR 0004).
 *
 * Regole coperte:
 *  - normalizzazione: trim, minuscole, divisione locale/dominio, lunghezze;
 *  - riconoscimento ESPLICITO degli indirizzi tecnici legacy (lista chiusa di
 *    domini): un refuso non è legacy e resta solo da correggere;
 *  - gli inviti e i cambi email dei clienti reali rifiutano gli indirizzi
 *    tecnici, che esistono solo per gli account di test;
 *  - il token d'invito è facoltativo al riscatto ma, se presente, deve essere
 *    un 64 hex valido;
 *  - nessun validatore accetta campi extra (exactObject).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const domain = require('../src/domain');

test('normalizeEmail: trim, minuscole, coerenza locale/dominio', () => {
  assert.equal(domain.normalizeEmail('  Mario.Rossi@Esempio.IT '), 'mario.rossi@esempio.it');
  assert.equal(domain.normalizeEmail('a@b.co'), 'a@b.co');
  // Local part troppo lunga (RFC: massimo 64 caratteri).
  assert.throws(() => domain.normalizeEmail(`${'a'.repeat(65)}@esempio.it`), /non valida/);
  // Dominio senza punto: formato non valido.
  assert.throws(() => domain.normalizeEmail('mario@esempio'), /non valida/);
  assert.throws(() => domain.normalizeEmail('mario@@esempio.it'), /non valida/);
  assert.throws(() => domain.normalizeEmail(''), /non valida/);
  assert.throws(() => domain.normalizeEmail(`${'a'.repeat(250)}@esempio.it`), /non valida/);
});

test('isLegacyTestEmail: riconoscimento esplicito, mai per somiglianza', () => {
  for (const address of [
    'cliente-a@utenti.pianonutrizionale.app',
    'x@sotto.utenti.pianonutrizionale.app',
    'mario@pianonutrizionale.app',
    'mario@pianonutrizionale'
  ]) {
    assert.equal(domain.isLegacyTestEmail(address), true, `${address} è un indirizzo tecnico`);
  }
  for (const address of ['mario.rossi@esempio.it', 'mario@gmial.com', 'mario@pianonutrizionale.com', 'x@notpianonutrizionale.app']) {
    assert.equal(domain.isLegacyTestEmail(address), false, `${address} non è un indirizzo tecnico`);
  }
  assert.deepEqual([...domain.LEGACY_TEST_EMAIL_DOMAINS], ['utenti.pianonutrizionale.app', 'pianonutrizionale.app', 'pianonutrizionale']);
});

test('emailFingerprint e maskEmail non espongono l’indirizzo in chiaro', () => {
  const normalized = 'mario.rossi@esempio.it';
  const fingerprint = domain.emailFingerprint('  MARIO.ROSSI@Esempio.it ');
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint, domain.emailFingerprint(normalized), 'stesso indirizzo normalizzato → stesso hash');
  const masked = domain.maskEmail(normalized);
  assert.ok(!masked.includes('rossi'), 'la parte locale non è leggibile');
  assert.ok(masked.includes('esempio.it'), 'il dominio resta riconoscibile per i log');
  assert.equal(domain.maskEmail(''), '***');
  assert.equal(domain.maskEmail('mario@'), '***');
});

test('invito email: email reale, nome e cognome obbligatori, consegna controllata', () => {
  const valid = domain.validateInviteClientEmail({
    organizationId: 'pianoNutrizionale', email: '  Mario.Rossi@Esempio.it ', firstName: ' Mario ', lastName: "D'Angelo",
    nutritionistUid: null, delivery: 'email', idempotencyKey: 'k1'
  });
  assert.equal(valid.email, 'mario.rossi@esempio.it');
  assert.equal(valid.firstName, 'Mario');
  assert.equal(valid.delivery, 'email');

  assert.throws(() => domain.validateInviteClientEmail({
    organizationId: 'pianoNutrizionale', email: 'cliente-a@utenti.pianonutrizionale.app', firstName: 'Mario', lastName: 'Rossi',
    nutritionistUid: null, delivery: 'email', idempotencyKey: 'k2'
  }), /indirizzo tecnico|flusso legacy/, 'un cliente reale non può usare un indirizzo tecnico');

  assert.throws(() => domain.validateInviteClientEmail({
    organizationId: 'pianoNutrizionale', email: 'mario@esempio.it', firstName: '', lastName: 'Rossi',
    nutritionistUid: null, delivery: 'email', idempotencyKey: 'k3'
  }), /firstName/);

  assert.throws(() => domain.validateInviteClientEmail({
    organizationId: 'pianoNutrizionale', email: 'mario@esempio.it', firstName: 'Mario', lastName: 'Rossi',
    nutritionistUid: null, delivery: 'sms', idempotencyKey: 'k4'
  }), /delivery non valida/);

  assert.throws(() => domain.validateInviteClientEmail({
    organizationId: 'pianoNutrizionale', email: 'mario@esempio.it', firstName: 'Mario', lastName: 'Rossi',
    nutritionistUid: null, delivery: 'email', idempotencyKey: 'k5', password: 'segreta'
  }), /campi non ammessi/);
});

test('riscatto invito: token facoltativo ma 64 hex quando presente', () => {
  assert.deepEqual(domain.validateRedeemClientInvite({ token: null, idempotencyKey: 'k1' }).token, null);
  assert.deepEqual(domain.validateRedeemClientInvite({ token: '', idempotencyKey: 'k1' }).token, null);
  const token = 'a'.repeat(64);
  assert.equal(domain.validateRedeemClientInvite({ token, idempotencyKey: 'k1' }).token, token);
  assert.throws(() => domain.validateRedeemClientInvite({ token: 'abc', idempotencyKey: 'k1' }), /token/);
  assert.throws(() => domain.validateRedeemClientInvite({ token: 'Z'.repeat(64), idempotencyKey: 'k1' }), /token/);
});

test('correzione e annullamento invito: campi obbligatori e motivo per l’audit', () => {
  const corrected = domain.validateCorrectClientInvite({
    organizationId: 'pianoNutrizionale', inviteId: 'invito-1', email: 'nuova@esempio.it',
    firstName: 'Giulia', lastName: 'Bianchi', delivery: 'manual-link', idempotencyKey: 'k1'
  });
  assert.equal(corrected.inviteId, 'invito-1');
  assert.equal(corrected.email, 'nuova@esempio.it');
  assert.throws(() => domain.validateCancelClientInvite({ organizationId: 'pianoNutrizionale', inviteId: 'invito-1', reason: 'x', idempotencyKey: 'k' }), /reason/);
  const cancelled = domain.validateCancelClientInvite({ organizationId: 'pianoNutrizionale', inviteId: 'invito-1', reason: 'Richiesta ritirata', idempotencyKey: 'k' });
  assert.equal(cancelled.reason, 'Richiesta ritirata');
  const resend = domain.validateResendClientInvite({ organizationId: 'pianoNutrizionale', inviteId: 'invito-1', delivery: '', idempotencyKey: 'k' });
  assert.equal(resend.delivery, 'email', 'la consegna predefinita è l’email');
});

test('anagrafica e cambio email: nome e cognome validati, cambio email solo con indirizzi reali', () => {
  const profile = domain.validateUpdateClientProfileByStaff({
    organizationId: 'pianoNutrizionale', clientId: 'cliente-1', firstName: 'Mario', lastName: 'Rossi',
    displayName: 'Mario R.', idempotencyKey: 'k1'
  });
  assert.equal(profile.displayName, 'Mario R.');
  assert.throws(() => domain.validateUpdateClientProfileByStaff({
    organizationId: 'pianoNutrizionale', clientId: 'cliente-1', firstName: 'Mario1', lastName: 'Rossi',
    displayName: null, idempotencyKey: 'k1'
  }), /firstName/);

  assert.throws(() => domain.validateProposeClientEmailChange({
    organizationId: 'pianoNutrizionale', clientId: 'cliente-1', newEmail: 'cliente-a@utenti.pianonutrizionale.app',
    reason: '', idempotencyKey: 'k2'
  }), /indirizzo tecnico|indirizzi tecnici/);

  const proposal = domain.validateProposeClientEmailChange({
    organizationId: 'pianoNutrizionale', clientId: 'cliente-1', newEmail: ' Nuova@Esempio.it ', reason: '', idempotencyKey: 'k3'
  });
  assert.equal(proposal.newEmail, 'nuova@esempio.it');

  assert.equal(domain.validateRespondClientEmailChange({ requestId: 'req-1', decision: 'accept', idempotencyKey: 'k4' }).decision, 'accept');
  assert.throws(() => domain.validateRespondClientEmailChange({ requestId: 'req-1', decision: 'forse', idempotencyKey: 'k4' }), /decision non valida/);
});
