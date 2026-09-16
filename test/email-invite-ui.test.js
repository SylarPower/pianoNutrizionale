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
 *    su inviti pendenti; mai password o token nei moduli;
 *  - consegna del link SEMPRE a mano: finestra con "Copia link" e
 *    "Condividi link" (stessi gesti della Lista della spesa), nessuna scelta
 *    di consegna, nessun invio automatico e nessuno stato di invio fallito.
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

test('il percorso pubblico usa solo l’invito email reale', () => {
  assert.ok(appJs.includes('match(/^#\\/invito\\/([a-f0-9]{64})$/i)'), 'parsing del link email');
  assert.doesNotMatch(appJs, /#\/invite\//, 'nessun percorso pubblico legacy');
  assert.ok(appJs.includes('PENDING_EMAIL_INVITE_STORAGE'));
  assert.doesNotMatch(appJs, /acceptOrganizationInvite/, 'nessun riscatto del vecchio invito');
  assert.match(appJs, /previewClientInvite/);
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
  assert.doesNotMatch(adminHtml, /LEGACY_TEST_INVITES_ENABLED=true|Account di test|legacy-invite-details/);
  assert.doesNotMatch(html, /id="invite-screen"/);
  assert.doesNotMatch(html, /#\/invite\//);
});

test('recupero password e verifica email nel client', () => {
  assert.match(html, /id="login-reset-password"/);
  assert.match(html, /Password dimenticata\?/);
  assert.match(html, /id="reset-form"/);
  assert.match(html, /id="reset-email"[\s\S]*?type="email"/);
  assert.match(appJs, /async function performLogin\(identifier, password\)/);
  assert.match(appJs, /return signInWithEmailAddress\(String\(identifier \|\| ""\)\.trim\(\), password\)/, 'login con email reale');
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
  for (const id of ['invite-client-email-form', 'invite-client-email', 'invite-client-first-name', 'invite-client-last-name', 'invite-client-email-result', 'invite-fix-dialog', 'client-profile-dialog', 'email-change-dialog']) {
    assert.match(adminHtml, new RegExp(`id="${id}"`), `manca #${id}`);
  }
  // Nessun campo password nei moduli della console.
  assert.doesNotMatch(adminHtml, /id="invite-.*password"/);
  for (const callable of ['inviteClientByEmail', 'resendClientInvite', 'correctClientInvite', 'cancelClientInvite', 'updateClientProfileByStaff', 'proposeClientEmailChange']) {
    assert.match(adminJs, new RegExp(`['"]${callable}['"]`), `callable ${callable} non usata`);
  }
  // Stati del nuovo flusso riconosciuti dalla console.
  for (const status of ['invited', 'invite-resent', 'invite-corrected', 'already-pending', 'link-request-created', 'already-linked-same', 'already-linked-other']) {
    assert.match(adminJs, new RegExp(`'${status}'`), `stato ${status} non gestito`);
  }
  // Il link lo costruisce il server: la console lo mostra senza inventarlo.
  assert.match(adminJs, /result\.inviteUrl/);
  assert.match(indexJs, /#\/invito\/\$\{token\}/, 'il link d’invito usa il percorso nuovo');
});

test('console: consegna del link a mano con Copia link e Condividi link, nessun invio automatico', () => {
  // Nessuna scelta di consegna nei moduli: la voce "Non inviare: mostra il
  // link" e l'invio email sono spariti del tutto.
  for (const id of ['invite-client-email-delivery', 'invite-fix-delivery', 'invite-client-email-link']) {
    assert.doesNotMatch(adminHtml, new RegExp(`id="${id}"`), `#${id} non deve più esistere`);
  }
  assert.doesNotMatch(adminHtml, /Non inviare: mostra il link|Invia l’email al cliente|Invita con email/);
  assert.doesNotMatch(adminJs, /delivery-failed|NON inviata|manual-link|deliveryChannel|deliveryStatus|data-delivery/, 'nessuno stato di invio nella console');
  // Finestra del link con i due pulsanti, dichiarata prima dello script.
  const scriptIndex = adminHtml.indexOf('<script src="js/admin.js"></script>');
  const dialog = adminHtml.match(/<div id="invite-link-dialog"[\s\S]*?<\/section><\/div>/);
  assert.ok(dialog, 'manca #invite-link-dialog');
  assert.ok(adminHtml.indexOf('id="invite-link-dialog"') < scriptIndex, 'la finestra del link precede js/admin.js');
  for (const id of ['invite-link-title', 'invite-link-lead', 'invite-link-url', 'invite-link-feedback', 'invite-link-copy', 'invite-link-share']) {
    assert.match(dialog[0], new RegExp(`id="${id}"`), `manca #${id} nella finestra del link`);
  }
  assert.match(dialog[0], /id="invite-link-copy"[^>]*>Copia link</, 'testo esatto “Copia link”');
  assert.match(dialog[0], /id="invite-link-share"[^>]*>Condividi link</, 'testo esatto “Condividi link”');
  assert.match(dialog[0], /id="invite-link-url"[^>]*readonly/, 'il link non si modifica a mano');
  assert.match(dialog[0], /Nessuna email è stata inviata in automatico/);
  // Gli stessi gesti della Lista della spesa: appunti con fallback, condivisione
  // nativa con fallback su WhatsApp Web.
  assert.match(adminJs, /navigator\.clipboard\.writeText/);
  assert.match(adminJs, /document\.execCommand\('copy'\)/);
  assert.match(adminJs, /navigator\.share\(\{ title: inviteLinkState\.title, text: inviteLinkState\.message \}\)/);
  assert.match(adminJs, /https:\/\/api\.whatsapp\.com\/send\?text=\$\{encodeURIComponent\(inviteLinkState\.message\)\}/);
  assert.match(adminJs, /function inviteShareMessage\(/);
  assert.match(adminJs, /ti ho invitato a Piano Nutrizionale: apri questo link personale, scegli la password e verifica la tua email\./);
  // La finestra si apre dopo invito nuovo, reinvio, correzione e nuovo link diretto.
  const openings = adminJs.match(/(?<!function )openInviteLinkDialog\(\{/g) || [];
  assert.ok(openings.length >= 3, 'apertura per invito, reinvio e correzione');
  for (const fn of ['submitClientEmailInvite', 'resendClientInvite', 'submitInviteFix']) {
    const start = adminJs.indexOf(`async function ${fn}(`);
    const end = adminJs.indexOf('\n}\n', start);
    assert.ok(start > 0, `manca ${fn}`);
    assert.match(adminJs.slice(start, end), /openInviteLinkDialog\(\{ ?[\s\S]*?url: result\.inviteUrl/, `${fn} apre la finestra del link`);
    assert.doesNotMatch(adminJs.slice(start, end), /delivery:/, `${fn} non invia più la scelta di consegna`);
  }
  // Chiudendo la finestra il link non resta nel documento.
  assert.match(adminJs, /function closeInviteLinkDialog\(\) \{[\s\S]*?\$\('invite-link-url'\)\.value = '';/);
  // Link persistente: finché l'invito è pendente la console lo recupera con
  // "Copia link" (stesso link, nessuna rigenerazione del token).
  assert.match(adminJs, /data-invite-copy/, 'bottone Copia link sugli inviti pendenti');
  assert.match(adminJs, /async function getExistingInviteLink\(inviteId/);
  assert.match(adminJs, /'getClientInviteLink'/);
  assert.match(indexJs, /exports\.getClientInviteLink = callable/);
  assert.match(indexJs, /exports\.getInviteLink = exports\.getClientInviteLink;/, 'alias getInviteLink');
  // L'anteprima pubblica del link non richiede App Check: è la causa del 500 su
  // getClientInvitePreview quando il link viene aperto fuori dall'app.
  assert.match(indexJs, /const publicCallableOptions = \{ region: 'europe-west1', enforceAppCheck: false, cors: true \};/);
  assert.match(indexJs, /exports\.getClientInvitePreview = onCall\(publicCallableOptions/);
  assert.doesNotMatch(indexJs, /exports\.getClientInvitePreview = onCall\(callableOptions/);
  // Nessuna variabile d'ambiente o provider lato server.
  assert.ok(!fs.existsSync(path.join(root, 'functions', 'src', 'email-service.js')), 'il servizio email è stato eliminato');
  assert.doesNotMatch(indexJs, /INVITE_EMAIL_|APP_PUBLIC_URL \|\||process\.env\.APP_PUBLIC_URL/);
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
