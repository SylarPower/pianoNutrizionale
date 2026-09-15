const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const firebaseJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'firebase.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin.js'), 'utf8');
const adminCss = fs.readFileSync(path.join(__dirname, '..', 'css', 'admin.css'), 'utf8');
const styleCss = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');

test('schermata pubblica invito email: dati precompilati e solo password', () => {
  for (const id of ['email-invite-screen', 'email-invite-form', 'email-invite-email', 'email-invite-name', 'email-invite-password', 'email-invite-submit', 'email-invite-error', 'email-invite-title']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /aria-labelledby="email-invite-title"/);
  assert.match(html, /autocomplete="new-password"/);
  assert.doesNotMatch(html, /id="invite-screen"|id="invite-form"|id="invite-username"/);
  assert.match(styleCss, /\.login-hint/);
});

test('registrazione reale: email verificabile e password scelta dal cliente', () => {
  assert.match(firebaseJs, /async function signUpWithRealEmail/);
  assert.match(firebaseJs, /createUserWithEmailAndPassword/);
  assert.match(firebaseJs, /validateEmailAddress\(email/);
  assert.match(firebaseJs, /String\(password \|\| ""\)\.length < 8/);
  assert.doesNotMatch(appJs, /INVITE_NICKNAME_RE|signUpWithUsername/);
  assert.ok(appJs.includes('La password deve avere almeno 8 caratteri.'));
});

test('token da URL: parsing hash, persistenza in sessione, riscatto via callable dedicata', () => {
  assert.ok(appJs.includes("match(/^#\\/invito\\/([a-f0-9]{64})$/i)"));
  assert.ok(appJs.includes('sessionStorage.setItem(PENDING_EMAIL_INVITE_STORAGE'));
  assert.ok(appJs.includes('sessionStorage.getItem(PENDING_EMAIL_INVITE_STORAGE'));
  assert.ok(appJs.includes('sessionStorage.removeItem(PENDING_EMAIL_INVITE_STORAGE'));
  // Il percorso pubblico usa solo email reale e riscatto dell'invito email.
  assert.ok(appJs.includes('signUpWithRealEmail'));
  assert.ok(appJs.includes('redeemClientInvite(inviteToken'));
  assert.doesNotMatch(appJs, /showInviteScreen|pendingInviteToken|acceptOrganizationInvite/);
  assert.ok(appJs.includes('await signOutUser();'));
  assert.ok(appJs.includes('function mapEmailInviteError(error)'));
  assert.ok(appJs.includes('chiedi un nuovo link al tuo nutrizionista'));
  assert.ok(appJs.includes('emailInvitePreview.email'));
});

test('console: invito professionisti visibile solo al creatore, link cliente completo', () => {
  // Gate UI deciso dal server (platformAdmin), mai da storage locali.
  assert.ok(adminJs.includes('adminState.isCreator = Boolean(professional.platformAdmin);'));
  assert.ok(adminJs.includes("$('invite-nutritionist-form').classList.toggle('hidden', !adminState.isCreator);"));
  assert.ok(adminJs.includes("adminState.isCreator = false;"));
  // Il link consegnato al cliente è l'URL completo dell'app con hash invito.
  assert.doesNotMatch(adminJs, /inviteLinkForToken|inviteClientLink/);
  assert.ok(adminJs.includes('invite-link-url'));
  assert.match(adminHtml, /id="invite-link-url"[^>]*readonly[^>]*aria-label="Link di invito da consegnare al cliente"/);
  assert.match(adminCss, /\.invite-link/);
});
