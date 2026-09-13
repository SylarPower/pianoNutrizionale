'use strict';
/* Interfaccia del nuovo modello con email reali (ADR 0004).
 *
 * Verifica statica di client e console:
 *  - schermata invito email `#/invito/<token>` con email, nome e cognome
 *    precompilati e NON modificabili; il cliente sceglie solo la password;
 *  - il flusso legacy `#/invite/<token>` resta intatto e separato;
 *  - "Password dimenticata?" con messaggio uniforme;
 *  - banner di verifica email con reinvio anti-abuso;
 *  - console: invito con email, anagrafica, proposta di cambio email e azioni
 *    su inviti pendenti; mai password o token nei moduli.
 * Il file è autonomo: nessuna richiesta di rete, solo lettura dei sorgenti.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const html = read('index.html');
const appJs = read('js/app.js');
const firebaseJs = read('js/firebase.js');
const adminHtml = read('admin.html');
const adminJs = read('js/admin.js');
const indexJs = read('functions/src/index.js');

test('schermata invito email: dati del nutrizionista bloccati e solo password scelta dal cliente', () => {
  for (const id of ['email-invite-screen', 'email-invite-form', 'email-invite-email', 'email-invite-name', 'email-invite-password', 'email-invite-submit', 'email-invite-error', 'email-invite-toggle']) {
    assert.match(html, new RegExp(`id="${id}"`), `manca #${id}`);
  }
  assert.match(html, /aria-labelledby="email-invite-title"/);
  // Nessun campo email modificabile nel modulo di registrazione: l'indirizzo
  // arriva dall'invito e si mostra come testo.
  const form = html.match(/<form id="email-invite-form"[\s\S]*?<\/form>/)[0];
  assert.doesNotMatch(form, /type="email"/, 'l’email non si ridigita nel modulo');
  assert.doesNotMatch(form, /id="email-invite-(email|name)"/, 'email e nome non sono campi del modulo');
  assert.match(form, /autocomplete="new-password"/);
  assert.match(form, /minlength="8"/);
  // Messaggio esplicito sull'origine dei dati.
  assert.match(html, /Questi dati sono stati inseriti dal tuo nutrizionista/);
  assert.match(appJs, /email-invite-state/);
  assert.match(appJs, /emailInvitePreview\.email/);
});

test('percorso nuovo separato dal legacy: `#/invito/<token>` e `#/invite/<token>`', () => {
  assert.ok(appJs.includes('match(/^#\\/invito\\/([a-f0-9]{64})$/i)'), 'parsing del link email');
  assert.ok(appJs.includes('match(/^#\\/invite\\/([a-f0-9]{64})$/i)'), 'parsing del link legacy conservato');
  assert.ok(appJs.includes('PENDING_EMAIL_INVITE_STORAGE'));
  assert.ok(appJs.includes('await ensureUsernameDirectory();'), 'il legacy continua a creare la directory username');
  assert.ok(appJs.includes('callSaasFunction("acceptOrganizationInvite", { token: pendingInviteToken })'));
  assert.match(appJs, /callSaasFunction is not defined|previewClientInvite/);
  assert.match(firebaseJs, /async function previewClientInvite\(token\)/);
  assert.match(firebaseJs, /"getClientInvitePreview"/);
  assert.match(firebaseJs, /async function redeemClientInvite\(token, idempotencyKey\)/);
  assert.match(firebaseJs, /"redeemClientInvite"/);
  assert.match(appJs, /email-verification-required/);
});

test('email reale = credenziale: nessuna email tecnica e riconoscimento legacy esplicito', () => {
  // La registrazione reale non passa MAI da usernameToInternalEmail.
  const signUpStart = firebaseJs.indexOf('async function signUpWithRealEmail');
  const signUpEnd = firebaseJs.indexOf('async function signInWithEmailAddress');
  assert.ok(signUpStart > 0 && signUpEnd > signUpStart);
  const signUpBody = firebaseJs.slice(signUpStart, signUpEnd);
  assert.ok(!signUpBody.includes('usernameToInternalEmail'), 'nessun username tecnico per i clienti reali');
  assert.match(signUpBody, /createUserWithEmailAndPassword/);
  // Lista chiusa e replicata lato server.
  assert.match(firebaseJs, /const LEGACY_TEST_EMAIL_DOMAINS = Object\.freeze\(\[/);
  assert.match(firebaseJs, /function isLegacyTestEmailAddress\(email\)/);
  assert.match(indexJs, /function legacyTestInvitesAllowed\(\)/);
  assert.match(indexJs, /LEGACY_TEST_INVITES_ENABLED/);
  assert.match(indexJs, /client\.invite-blocked-legacy/);
  assert.match(adminHtml, /LEGACY_TEST_INVITES_ENABLED=true/);
});

test('recupero password e verifica email nel client', () => {
  assert.match(html, /id="login-reset-password"/);
  assert.match(html, /Password dimenticata\?/);
  assert.match(html, /id="reset-form"/);
  assert.match(html, /id="reset-email"[\s\S]*?type="email"/);
  assert.match(appJs, /async function performLogin\(identifier, password\)/);
  assert.match(appJs, /value\.includes\("@"\)/, 'login con email o username');
  assert.match(appJs, /sendPasswordResetForEmail/);
  assert.match(firebaseJs, /async function sendPasswordResetForEmail\(email\)/);
  // Messaggio uniforme: non si rivela se l'account esiste.
  assert.match(firebaseJs, /Se l'indirizzo è registrato/);
  // Gli indirizzi tecnici non ricevono reset reali.
  assert.match(firebaseJs, /isLegacyTestEmailAddress\(user\.email\)/);
  // Banner di verifica con reinvio limitato nel tempo.
  assert.match(html, /id="email-verification-banner"/);
  assert.match(html, /id="email-verification-resend"/);
  assert.match(appJs, /VERIFICATION_RESEND_COOLDOWN_MS/);
  assert.match(appJs, /await sendVerificationEmailToCurrentUser\(\)/);
  assert.match(firebaseJs, /async function sendVerificationEmailToCurrentUser\(\)/);
});

test('console: invito con email, stati distinti e azioni su inviti e anagrafica', () => {
  for (const id of ['invite-client-email-form', 'invite-client-email', 'invite-client-first-name', 'invite-client-last-name', 'invite-client-email-delivery', 'invite-client-email-result', 'invite-client-email-link', 'invite-fix-dialog', 'client-profile-dialog', 'email-change-dialog']) {
    assert.match(adminHtml, new RegExp(`id="${id}"`), `manca #${id}`);
  }
  // Nessun campo password nei moduli della console.
  assert.doesNotMatch(adminHtml, /id="invite-.*password"/);
  for (const callable of ['inviteClientByEmail', 'resendClientInvite', 'correctClientInvite', 'cancelClientInvite', 'updateClientProfileByStaff', 'proposeClientEmailChange']) {
    assert.match(adminJs, new RegExp(`['"]${callable}['"]`), `callable ${callable} non usata`);
  }
  // Stati del nuovo flusso riconosciuti dalla console.
  for (const status of ['invited', 'invite-resent', 'invite-corrected', 'delivery-failed', 'already-pending', 'link-request-created', 'already-linked-same', 'already-linked-other']) {
    assert.match(adminJs, new RegExp(`'${status}'`), `stato ${status} non gestito`);
  }
  assert.match(adminJs, /NON inviata/, 'un invio fallito non viene dichiarato riuscito');
  // Il link lo costruisce il server: la console lo mostra senza inventarlo.
  assert.match(adminJs, /result\.inviteUrl/);
  assert.match(read('functions/src/email-service.js'), /#\/invito\/\$\{token\}/, 'il link email usa il percorso nuovo');
});

test('clienti: dati identificativi visibili all’utente, cambio email solo su conferma', () => {
  assert.match(appJs, /window\.respondMyEmailChangeRequest/);
  assert.match(appJs, /respondMyEmailChange/);
  assert.match(appJs, /Nome, cognome ed email dell'account li aggiorna il tuo nutrizionista/);
  assert.match(appJs, /linked-identity/);
  assert.match(appJs, /link\.emailChange/);
  // Il cliente non ha alcun percorso per scrivere email o anagrafica da solo.
  assert.doesNotMatch(appJs, /updateClientProfileByStaff/);
  assert.doesNotMatch(appJs, /proposeClientEmailChange/);
  assert.doesNotMatch(appJs, /correctClientInvite/);
});

test('privacy e sicurezza: nessun tokenHash o password nelle risposte e nei documenti', () => {
  // Le risposte della console non espongono mai l'hash del token.
  assert.doesNotMatch(indexJs, /tokenHash:\s*value\.tokenHash/);
  assert.match(indexJs, /MAI tokenHash/, 'commento esplicito sulla risposta senza tokenHash');
  // Nessuna scrittura di password su Firestore.
  assert.doesNotMatch(indexJs, /password:\s*(?!null)/, 'nessun campo password nei documenti');
  assert.doesNotMatch(adminJs, /invite-[a-z-]*password/i, 'i moduli invito non chiedono password');
  assert.doesNotMatch(adminJs, /callAdminSaasFunction\([^)]*password/i, 'nessuna password inviata alle callable');
  // Il token in chiaro esiste solo nella risposta di creazione/reinvio.
  assert.match(indexJs, /crypto\.randomBytes\(32\)\.toString\('hex'\)/);
  assert.match(indexJs, /hashToken\(token\)/);
  assert.match(indexJs, /Tutti i dati anagrafici|nome e cognome|firstName: input\.firstName/, 'nome e cognome gestiti server-side');
});
