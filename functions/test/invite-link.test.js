'use strict';
/* Link d'invito consegnato a mano (evoluzione dell'ADR 0004).
 *
 * Il servizio di invio email è stato eliminato: il backend costruisce solo il
 * link e lo restituisce alla console, che lo mostra con "Copia link" e
 * "Condividi link". Regole verificate:
 *  - nessun modulo di invio email nel codice delle Functions;
 *  - nessun provider, nessuna chiave e nessuna variabile d'ambiente dedicata
 *    agli inviti (INVITE_EMAIL_*, APP_PUBLIC_URL);
 *  - nessuno stato di "invio fallito" nelle risposte o nell'audit;
 *  - il link è `<indirizzo pubblico fisso>/#/invito/<token>` e la scadenza è
 *    di 7 giorni;
 *  - verifica email e recupero password restano affidati a Firebase Auth
 *    (non compaiono qui: sono lato client).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', 'src');
const indexJs = fs.readFileSync(path.join(srcDir, 'index.js'), 'utf8');
const domainJs = fs.readFileSync(path.join(srcDir, 'domain.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

test('il servizio email non esiste più: nessun modulo, nessun require, nessun controllo di sintassi', () => {
  assert.ok(!fs.existsSync(path.join(srcDir, 'email-service.js')), 'functions/src/email-service.js deve essere eliminato');
  assert.doesNotMatch(indexJs, /email-service/, 'nessun require del servizio email');
  assert.doesNotMatch(indexJs, /sendInviteEmail|inviteEmailContent|resolveEmailConfig|memoryOutbox/, 'nessuna funzione di invio');
  assert.doesNotMatch(packageJson.scripts.syntax, /email-service/, 'lo script syntax non controlla più il file eliminato');
  assert.doesNotMatch(indexJs, /\bfetch\s*\(/, 'nessuna chiamata HTTP verso provider esterni');
});

test('nessun provider, nessuna chiave, nessuna variabile d’ambiente per gli inviti', () => {
  for (const source of [indexJs, domainJs]) {
    assert.doesNotMatch(source, /INVITE_EMAIL_[A-Z_]+/, 'nessuna variabile INVITE_EMAIL_*');
    assert.doesNotMatch(source, /process\.env\.APP_PUBLIC_URL/, 'l’indirizzo pubblico non arriva dall’ambiente');
    assert.doesNotMatch(source, /api\.resend\.com|'resend'|provider: 'resend'/i, 'nessun provider email');
    assert.doesNotMatch(source, /\bapiKey\b|api_key|Authorization: `Bearer/i, 'nessuna chiave di un provider');
  }
  // L'indirizzo pubblico è una costante non segreta nel codice.
  assert.match(indexJs, /const APP_PUBLIC_URL = 'https:\/\/sylarpower\.github\.io\/pianoNutrizionale';/);
});

test('nessuno stato di invio fallito: né nelle risposte, né nell’audit, né nel documento', () => {
  assert.doesNotMatch(indexJs, /delivery-failed/, 'lo stato delivery-failed non esiste più');
  assert.doesNotMatch(indexJs, /email-invite-delivery-failed/, 'nessun evento di audit per invio fallito');
  assert.doesNotMatch(indexJs, /deliveryError/, 'nessun errore di consegna nelle risposte');
  assert.doesNotMatch(indexJs, /status: 'sent'|status: 'failed'/, 'il documento non registra invii riusciti o falliti');
  assert.doesNotMatch(indexJs, /NON inviata/, 'nessun messaggio su email non inviate');
  // L'unico canale è la consegna manuale, dichiarata una sola volta nel dominio.
  assert.match(domainJs, /const INVITE_DELIVERY_CHANNEL = 'manual-link';/);
  assert.doesNotMatch(domainJs, /INVITE_DELIVERY_MODES/, 'nessuna lista di modalità di consegna');
  assert.match(indexJs, /channel: INVITE_DELIVERY_CHANNEL, status: 'manual'/);
  assert.match(indexJs, /handedToConsole: true/);
});

test('costruzione del link: percorso `#/invito/<token>` sull’indirizzo pubblico e scadenza a 7 giorni', () => {
  // Le due funzioni vivono in index.js e non sono esportate come callable:
  // si verificano eseguendo il loro codice sorgente isolato.
  const linkSource = indexJs.match(/function buildInviteLink\(baseUrl, token\) \{[\s\S]*?\n\}/);
  const expirySource = indexJs.match(/function inviteExpiryDate\(\{[\s\S]*?\n\}/);
  assert.ok(linkSource, 'buildInviteLink presente in index.js');
  assert.ok(expirySource, 'inviteExpiryDate presente in index.js');
  const INVITE_TTL_DAYS = 7;
  assert.match(indexJs, /const INVITE_TTL_DAYS = 7;/);
  // eslint-disable-next-line no-new-func
  const buildInviteLink = new Function(`${linkSource[0]}; return buildInviteLink;`)();
  // eslint-disable-next-line no-new-func
  const inviteExpiryDate = new Function('INVITE_TTL_DAYS', `${expirySource[0]}; return inviteExpiryDate;`)(INVITE_TTL_DAYS);

  const token = 'a'.repeat(64);
  assert.equal(buildInviteLink('https://sylarpower.github.io/pianoNutrizionale', token), `https://sylarpower.github.io/pianoNutrizionale/#/invito/${token}`);
  assert.equal(buildInviteLink('https://app.esempio.it/', token), `https://app.esempio.it/#/invito/${token}`, 'le barre finali non raddoppiano');
  assert.throws(() => buildInviteLink('', token), /Indirizzo pubblico/);
  const expiry = inviteExpiryDate({ now: new Date('2026-09-13T10:00:00Z') });
  assert.equal(expiry.toISOString(), '2026-09-20T10:00:00.000Z');
  assert.equal(inviteExpiryDate({ days: 1, now: new Date('2026-09-13T10:00:00Z') }).toISOString(), '2026-09-14T10:00:00.000Z');
  // Il link viene costruito dalle callable con la costante pubblica.
  assert.match(indexJs, /buildInviteLink\(APP_PUBLIC_URL, token\)/);
});

test('le callable di invito, reinvio e correzione restituiscono sempre il link alla console', () => {
  const inviteFn = indexJs.slice(indexJs.indexOf('exports.inviteClientByEmail'), indexJs.indexOf('exports.getClientInvitePreview'));
  const resendFn = indexJs.slice(indexJs.indexOf('exports.resendClientInvite'), indexJs.indexOf('exports.cancelClientInvite'));
  const correctFn = indexJs.slice(indexJs.indexOf('exports.correctClientInvite'), indexJs.indexOf('exports.updateClientProfileByStaff'));
  for (const [name, source] of [['inviteClientByEmail', inviteFn], ['resendClientInvite', resendFn], ['correctClientInvite', correctFn]]) {
    assert.match(source, /deliverClientInvite\(\{ inviteRef(: newRef)?, token, updatedBy: uid \}\)/, `${name}: consegna senza scelta di canale`);
    assert.doesNotMatch(source, /input\.delivery/, `${name}: il payload non ha più la scelta di consegna`);
    assert.match(source, /Copia link|Condividi link/, `${name}: il messaggio guida alla consegna a mano`);
  }
  // Il messaggio della risposta non promette mai un invio automatico.
  assert.doesNotMatch(indexJs, /email inviata al cliente/i);
});
