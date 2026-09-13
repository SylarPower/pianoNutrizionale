'use strict';
/* Servizio email degli inviti (ADR 0004).
 *
 * Regole verificate:
 *  - nessun provider configurato → l'invito resta consegnabile a mano, ma
 *    l'invio NON viene mai dichiarato riuscito;
 *  - l'adapter in memoria è utilizzabile solo negli emulatori (mai in
 *    produzione);
 *  - un errore del provider (HTTP, rete) non produce mai un esito positivo;
 *  - i segreti arrivano solo da variabili d'ambiente, mai dal repository;
 *  - il link d'invito è `#/invito/<token>` e il testo non contiene password.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/email-service');

test('senza configurazione l’invio non è disponibile e non viene mai dichiarato riuscito', async () => {
  const config = service.resolveEmailConfig({});
  assert.equal(config.provider, 'none');
  assert.equal(config.configured, false);
  const result = await service.sendInviteEmail(
    { to: 'mario.rossi@esempio.it', firstName: 'Mario', lastName: 'Rossi', link: 'https://app.esempio.it/#/invito/x', expiresAt: new Date() },
    { config, logger: { info() {}, warn() {} }, fetchImpl: () => { throw new Error('non deve essere chiamato'); } }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-configured');
  assert.match(result.message, /link a mano|non configurato/i);
});

test('adapter in memoria: solo emulatori, outbox senza invio reale', async () => {
  const rejected = service.resolveEmailConfig({ INVITE_EMAIL_PROVIDER: 'memory' });
  assert.equal(rejected.configured, false, 'in produzione l’adapter di test è rifiutato');
  assert.match(rejected.error, /non è utilizzabile in produzione/);

  const config = service.resolveEmailConfig({ INVITE_EMAIL_PROVIDER: 'memory', FIRESTORE_EMULATOR_HOST: 'localhost:8080' });
  assert.equal(config.provider, 'memory');
  service.resetMemoryOutbox();
  const result = await service.sendInviteEmail(
    { to: 'mario.rossi@esempio.it', firstName: 'Mario', lastName: 'Rossi', organizationName: 'Studio Piano', link: 'https://app.esempio.it/#/invito/abc', expiresAt: new Date() },
    { config, logger: { info() {}, warn() {} } }
  );
  assert.equal(result.ok, true);
  assert.equal(service.memoryOutbox.length, 1);
  assert.equal(service.memoryOutbox[0].to, 'mario.rossi@esempio.it');
  assert.ok(/link personale e monouso/.test(service.memoryOutbox[0].text));
  assert.ok(service.memoryOutbox[0].text.includes('#/invito/'), 'il link è quello nuovo');
});

test('provider HTTP: successo solo con risposta 2xx, errore altrimenti', async () => {
  const env = {
    INVITE_EMAIL_PROVIDER: 'resend',
    INVITE_EMAIL_API_KEY: 'chiave-di-test',
    INVITE_EMAIL_FROM: 'Studio Piano <inviti@esempio.it>',
    INVITE_EMAIL_ENDPOINT: 'https://api.test/emails'
  };
  const config = service.resolveEmailConfig(env);
  assert.equal(config.configured, true);
  assert.equal(config.apiKey, 'chiave-di-test');

  const ok = await service.sendInviteEmail(
    { to: 'cliente@esempio.it', firstName: 'Cliente', link: 'https://app.esempio.it/#/invito/abc' },
    { config, logger: { info() {}, warn() {} }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id: 'msg-1' }) }) }
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.messageId, 'msg-1');

  const rejected = await service.sendInviteEmail(
    { to: 'cliente@esempio.it', firstName: 'Cliente', link: 'https://app.esempio.it/#/invito/abc' },
    { config, logger: { info() {}, warn() {} }, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'provider-error');
  assert.equal(rejected.status, 500);

  const network = await service.sendInviteEmail(
    { to: 'cliente@esempio.it', firstName: 'Cliente', link: 'https://app.esempio.it/#/invito/abc' },
    { config, logger: { info() {}, warn() {} }, fetchImpl: async () => { throw new Error('offline'); } }
  );
  assert.equal(network.ok, false);
  assert.equal(network.code, 'network');
});

test('provider sconosciuto o incompleto: nessun invio, messaggio in italiano', () => {
  assert.match(service.resolveEmailConfig({ INVITE_EMAIL_PROVIDER: 'carrier-pigeon' }).error, /non riconosciuto/);
  const missingKey = service.resolveEmailConfig({ INVITE_EMAIL_PROVIDER: 'resend', INVITE_EMAIL_FROM: 'a@b.it' });
  assert.equal(missingKey.configured, false);
  assert.match(missingKey.error, /INVITE_EMAIL_API_KEY/);
});

test('link e contenuto dell’invito: percorso nuovo, nome del professionista, nessun segreto inutile', () => {
  const token = 'a'.repeat(64);
  const link = service.buildInviteLink('https://app.esempio.it/', token);
  assert.equal(link, `https://app.esempio.it/#/invito/${token}`);
  assert.throws(() => service.buildInviteLink('', token), /APP_PUBLIC_URL/);
  const content = service.inviteEmailContent({
    firstName: 'Mario', lastName: 'Rossi', organizationName: 'Studio Piano', nutritionistName: 'Dott.ssa Verdi',
    link, expiresAt: new Date('2026-09-20T10:00:00Z')
  });
  assert.match(content.subject, /Studio Piano/);
  assert.match(content.text, /Dott\.ssa Verdi/);
  assert.match(content.text, /inseriti dal tuo nutrizionista/);
  assert.match(content.text, /20\/09\/2026/);
  // Si parla della password scelta dal cliente, ma nessuna credenziale reale
  // compare nel messaggio: l'unico segreto è il link monouso.
  assert.match(content.text, /scegli tu la password/);
  assert.equal((content.text.match(/https:\/\/app\.esempio\.it/) || []).length, 1, 'un solo link nel messaggio');
  assert.ok(!/tokenHash/i.test(content.html));
  const expiry = service.inviteExpiryDate({ days: 7, now: new Date('2026-09-13T10:00:00Z') });
  assert.equal(expiry.toISOString(), '2026-09-20T10:00:00.000Z');
});
