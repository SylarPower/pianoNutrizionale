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

test('schermata pubblica invito: form dedicato, accessibile, separato dal login', () => {
  // Markup della nuova schermata di registrazione da link invito.
  for (const id of ['invite-screen', 'invite-form', 'invite-username', 'invite-password', 'invite-submit', 'invite-error', 'invite-title']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /aria-labelledby="invite-title"/);
  assert.match(html, /id="invite-error" class="login-error" role="alert"/);
  assert.match(html, /autocomplete="new-password"/);
  assert.match(html, /minlength="8"/);
  assert.match(html, /maxlength="20"/);
  assert.doesNotMatch(html, /<form id="invite-form"[^>]*>[\s\S]*?type="email"/);
  assert.match(styleCss, /\.login-hint/);
  // Le tre schermate si escludono a vicenda.
  assert.match(html, /<main id="invite-screen" class="login-screen hidden">/);
  assert.match(appJs, /document\.getElementById\("invite-screen"\)\?\.classList\.add\("hidden"\)/);
});

test('registrazione: username 3-20 senza spazi, password ≥ 8, email tecnica sul dominio utenti', () => {
  assert.match(firebaseJs, /async function signUpWithUsername/);
  assert.match(firebaseJs, /createUserWithEmailAndPassword/);
  assert.ok(firebaseJs.includes('/^[a-z0-9._-]{3,20}$/'));
  assert.match(firebaseJs, /String\(password \|\| ""\)\.length < 8/);
  // Stessa email interna degli account creati dalla console (dominio vincolato dalle rules).
  assert.match(firebaseJs, /usernameToInternalEmail\(normalized\)/);
  assert.ok(firebaseJs.includes('utenti.pianonutrizionale.app'));
  // Validazione client-side nella schermata invito, prima della chiamata ad Auth.
  assert.ok(appJs.includes('const INVITE_NICKNAME_RE = /^[a-z0-9._-]{3,20}$/;'));
  assert.ok(appJs.includes('Niente spazi.'));
  assert.ok(appJs.includes('La password deve avere almeno 8 caratteri.'));
});

test('token da URL: parsing hash, persistenza in sessione, riscatto via callable dedicata', () => {
  assert.ok(appJs.includes("match(/^#\\/invite\\/([a-f0-9]{64})$/i)"));
  assert.ok(appJs.includes('sessionStorage.setItem(PENDING_INVITE_STORAGE'));
  assert.ok(appJs.includes('sessionStorage.getItem(PENDING_INVITE_STORAGE'));
  assert.ok(appJs.includes('sessionStorage.removeItem(PENDING_INVITE_STORAGE'));
  // Dopo la registrazione: directory username poi accettazione invito lato server.
  assert.ok(appJs.includes('await ensureUsernameDirectory();'));
  assert.ok(appJs.includes('callSaasFunction("acceptOrganizationInvite", { token: pendingInviteToken })'));
  // Schermata invito mostrata solo da token in sospeso e logout forzato su errore.
  assert.ok(appJs.includes('if (pendingInviteToken) showInviteScreen();'));
  assert.ok(appJs.includes('await signOutUser();'));
  // Account già autenticato che apre il link: messaggio esplicito, nessun riscatto.
  assert.ok(appJs.includes("Per usare un invito cliente esci dall'account attuale e riapri il link"));
  assert.ok(appJs.includes('function mapInviteError(error)'));
  assert.ok(appJs.includes('chiedi un nuovo link al tuo nutrizionista'));
});

test('console: invito professionisti visibile solo al creatore, link cliente completo', () => {
  // Gate UI deciso dal server (platformAdmin), mai da storage locali.
  assert.ok(adminJs.includes('adminState.isCreator = Boolean(professional.platformAdmin);'));
  assert.ok(adminJs.includes("$('invite-nutritionist-form').classList.toggle('hidden', !adminState.isCreator);"));
  assert.ok(adminJs.includes("adminState.isCreator = false;"));
  // Il link consegnato al cliente è l'URL completo dell'app con hash invito.
  assert.ok(adminJs.includes("function inviteLinkForToken(token)"));
  assert.ok(adminJs.includes('`./#/invite/${token}`'));
  assert.ok(adminJs.includes("new URL('./index.html', location.href)"));
  assert.ok(adminJs.includes('linkInput.select()'));
  assert.match(adminHtml, /id="invite-client-link"[^>]*readonly[^>]*aria-label="Link di invito da consegnare al cliente"/);
  assert.match(adminCss, /\.invite-link/);
});
