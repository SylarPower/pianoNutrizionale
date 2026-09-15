'use strict';
/* Attivazione del collegamento professionista dopo la verifica email (ADR 0004).
 *
 * Riproduce il percorso reale con l'SDK compat stubbato e un "server" che
 * risponde come functions/src/index.js:
 *   1. registrazione dal link #/invito/<token> → il backend risponde
 *      `email-verification-required` e NON consuma il token;
 *   2. verifica dell'email fuori dall'app (link nella casella di posta);
 *   3. accesso o ricarica → il client rilegge la verifica, forza
 *      `getIdToken(true)` e richiama `redeemClientInvite` SENZA token: il
 *      collegamento diventa attivo e solo allora il token viene cancellato.
 * Il token in cache del finto SDK resta volutamente con
 * `email_verified: false` finché non viene rinnovato a forza (come nell'SDK
 * reale): senza il rinnovo forzato il backend risponderebbe ancora
 * `email-verification-required` e questi test fallirebbero.
 * Il file è autonomo: nessuna richiesta di rete, solo codice locale.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

// ---- DOM minimale (stessa forma degli altri test di interfaccia) ----
function makeElement(id) {
  const listeners = {};
  const el = {
    id: id || '',
    _innerHTML: '',
    _textContent: '',
    value: '',
    checked: false,
    disabled: false,
    dataset: {},
    style: {},
    children: [],
    classList: {
      _set: new Set(),
      add: (...cls) => cls.forEach(c => el.classList._set.add(c)),
      remove: (...cls) => cls.forEach(c => el.classList._set.delete(c)),
      toggle: (cls, force) => {
        const has = el.classList._set.has(cls);
        const next = force === undefined ? !has : !!force;
        if (next) el.classList._set.add(cls); else el.classList._set.delete(cls);
        return next;
      },
      contains: cls => el.classList._set.has(cls)
    },
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
    removeEventListener: () => {},
    appendChild: child => { el.children.push(child); return child; },
    prepend: child => { el.children.unshift(child); return child; },
    remove: () => {},
    insertAdjacentHTML: (pos, html) => { el._innerHTML += html; },
    setAttribute: (name, value) => { el[name] = value; },
    getAttribute: name => el[name] ?? null,
    focus: () => {},
    click: () => {},
    querySelector: () => makeElement(''),
    querySelectorAll: () => [],
    matches: () => false
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._innerHTML,
    set: value => { el._innerHTML = String(value); }
  });
  Object.defineProperty(el, 'textContent', {
    get: () => el._textContent,
    set: value => { el._textContent = String(value ?? ''); }
  });
  // I gestori sono asincroni: i test attendono i loro esiti.
  el._fire = (name, event) => (listeners[name] || []).map(fn => fn(event || {}));
  return el;
}

const elements = new Map();
const doc = {
  title: 'Piano Nutrizionale',
  getElementById: id => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  },
  createElement: tag => makeElement(tag),
  querySelector: sel => makeElement(sel),
  querySelectorAll: () => [],
  addEventListener: () => {},
  body: makeElement('body'),
  documentElement: makeElement('html')
};

function makeStorage() {
  return {
    _data: {},
    getItem(key) { return key in this._data ? this._data[key] : null; },
    setItem(key, value) { this._data[key] = String(value); },
    removeItem(key) { delete this._data[key]; }
  };
}

const localStorage = makeStorage();
const sessionStorage = makeStorage();

global.window = global;
global.document = doc;
global.localStorage = localStorage;
global.sessionStorage = sessionStorage;
global.location = { hash: '#week', pathname: '/index.html', search: '', hostname: 'esempio.test' };
global.history = { state: null, replaceState: () => {} };
Object.defineProperty(global, 'navigator', { value: {}, configurable: true, writable: true });

// ---- Finto SDK Firebase compat + "server" con il contratto del backend ----
const functionCalls = [];
const idTokenRequests = [];
let emailVerificationsSent = 0;
let uidSeq = 0;

const serverState = {
  invites: new Map(), // token → invito (come organizations/<org>/invitations/<id>)
  links: new Map()    // uid → collegamento attivo (come accountClientLinks/<uid>)
};

const fakeAuth = {
  currentUser: null,
  listeners: new Set(),
  // Stato SERVER dell'utente e claim dell'ID token in cache: due cose distinte,
  // come nell'SDK reale. La verifica email aggiorna il profilo, non il token
  // già emesso né il campo `emailVerified` visibile al client.
  profile: null,
  cachedIdToken: null
};

const currentAuthClaim = () => fakeAuth.cachedIdToken;
const notifyAuth = () => fakeAuth.listeners.forEach(fn => fn(fakeAuth.currentUser));

function makeUser(uid, email) {
  const user = {
    uid,
    email,
    emailVerified: false,
    async getIdToken(force) {
      idTokenRequests.push({ uid, force: force === true });
      if (!force && fakeAuth.cachedIdToken) return 'id-token-dalla-cache';
      fakeAuth.cachedIdToken = { email, email_verified: fakeAuth.profile?.emailVerified === true };
      return 'id-token-rinnovato';
    },
    async reload() {
      // `reload()` è ciò che rende visibile al client la verifica fatta fuori
      // dall'app: senza reload resta il valore dell'ultimo token.
      user.emailVerified = fakeAuth.profile?.emailVerified === true;
    },
    async sendEmailVerification() { emailVerificationsSent += 1; }
  };
  return user;
}

// Registrazione: al momento dell'iscrizione l'SDK emette il primo ID token con
// `email_verified: false` (non passa da getIdToken, come nell'SDK reale).
async function signUpFake(email) {
  uidSeq += 1;
  const uid = `uid-cliente-${uidSeq}`;
  fakeAuth.profile = { email: normalizeEmailAddress(email), emailVerified: false };
  fakeAuth.cachedIdToken = { email: fakeAuth.profile.email, email_verified: false };
  fakeAuth.currentUser = makeUser(uid, fakeAuth.profile.email);
  queueMicrotask(notifyAuth);
  return fakeAuth.currentUser;
}

// Verifica dell'email FUORI dall'app: cambia il profilo sul server, non ciò che
// il client ha in memoria né il token già emesso.
function verificaEmailFuoriDallApp() {
  fakeAuth.profile.emailVerified = true;
}

function callableError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function handleCallable(name, data) {
  functionCalls.push({ name, data });
  const uid = fakeAuth.currentUser?.uid || null;
  const claim = currentAuthClaim();
  const emailVerified = claim?.email_verified === true;
  const authEmail = String(claim?.email || '').toLowerCase();

  if (name === 'getClientInvitePreview') {
    const invite = serverState.invites.get(String(data.token || '').toLowerCase());
    if (!invite) return { status: 'not-found' };
    if (invite.status === 'accepted') return { status: 'used' };
    if (invite.status === 'revoked') return { status: 'revoked' };
    return {
      status: 'valid', email: invite.email, firstName: invite.firstName, lastName: invite.lastName,
      nutritionistName: 'Dott. Guide', organizationName: 'Studio Guide'
    };
  }
  if (name === 'getMyAssignedProfile') return { state: 'unassigned' };
  if (name === 'listMyClientLinkRequests') {
    return { requests: [], link: serverState.links.get(uid) || null, emailVerified };
  }
  if (name === 'redeemClientInvite') {
    const token = data.token ? String(data.token).toLowerCase() : null;
    let invite = null;
    if (token) {
      invite = serverState.invites.get(token) || null;
      if (!invite) throw callableError('not-found', 'Invito non valido o già utilizzato');
    } else {
      // Riscatto senza token: cercato dall'email autenticata e VERIFICATA.
      if (!emailVerified || !authEmail) return { status: 'no-pending-invite' };
      invite = [...serverState.invites.values()]
        .find(item => item.status === 'pending' && item.email === authEmail) || null;
      if (!invite) return { status: 'no-pending-invite' };
    }
    if (invite.status === 'accepted' && invite.redeemedBy === uid) {
      return { status: 'already-linked', organizationId: 'pianoNutrizionale', clientId: invite.clientId };
    }
    if (invite.status !== 'pending') {
      throw callableError('failed-precondition', 'Invito non più valido: chiedi un nuovo link al tuo nutrizionista');
    }
    if (invite.email !== authEmail) {
      throw callableError('permission-denied', 'Questo invito è stato emesso per un altro indirizzo email');
    }
    if (!emailVerified) {
      return { status: 'email-verification-required', email: authEmail, clientId: invite.clientId };
    }
    invite.status = 'accepted';
    invite.redeemedBy = uid;
    serverState.links.set(uid, {
      organizationId: 'pianoNutrizionale', organizationName: 'Studio Guide', clientId: invite.clientId
    });
    return {
      status: 'link-active', organizationId: 'pianoNutrizionale', clientId: invite.clientId, email: authEmail
    };
  }
  throw new Error(`Callable non prevista nel test: ${name}`);
}

const functionsStub = {
  httpsCallable: name => async data => ({ data: handleCallable(name, data || {}) })
};

const dbStub = {
  collection: () => dbStub,
  doc: () => dbStub,
  where: () => dbStub,
  orderBy: () => dbStub,
  limit: () => dbStub,
  get: async () => ({ exists: false, existsSync: false, empty: true, forEach: () => {}, data: () => ({}) }),
  set: async () => {},
  add: async () => ({ id: 'x' }),
  update: async () => {},
  delete: async () => {},
  enablePersistence: async () => {},
  onSnapshot: () => () => {},
  batch: () => ({ set: () => {}, update: () => {}, delete: () => {}, commit: async () => {} }),
  runTransaction: async fn => fn({ get: async () => ({ exists: false, data: () => ({}) }), set: () => {}, delete: () => {} })
};

global.firebase = {
  apps: [],
  initializeApp: () => {},
  appCheck: () => ({ activate: () => {} }),
  firestore: Object.assign(() => dbStub, {
    FieldValue: {
      serverTimestamp: () => ({}),
      arrayUnion: (...values) => values,
      arrayRemove: (...values) => values
    }
  }),
  auth: () => ({
    get currentUser() { return fakeAuth.currentUser; },
    setPersistence: async () => {},
    onAuthStateChanged: fn => { fakeAuth.listeners.add(fn); return () => fakeAuth.listeners.delete(fn); },
    createUserWithEmailAndPassword: async (email, password) => {
      if (String(password || '').length < 8) throw callableError('auth/weak-password', 'password corta');
      return { user: await signUpFake(email) };
    },
    signInWithEmailAndPassword: async () => ({}),
    signOut: async () => {
      fakeAuth.currentUser = null;
      fakeAuth.profile = null;
      fakeAuth.cachedIdToken = null;
      queueMicrotask(notifyAuth);
    }
  }),
  functions: () => functionsStub
};
global.firebase.auth.Auth = { Persistence: { LOCAL: 'local' } };

for (const file of ['js/domain.js', 'js/saas-config.js', 'js/saas.js', 'js/data.js', 'js/prices.js', 'js/firebase.js', 'js/app.js']) {
  vm.runInThisContext(read(file), { filename: file });
}

// Sostituzioni mirate: qui si verifica l'attivazione del collegamento, non il
// rendering delle viste (coperto dagli smoke test). `applyState` e `handleRoute`
// restano fuori dal perimetro.
globalThis.getRecipeCatalog = async () => [];
globalThis.getWeeklyPlan = async () => ({ days: {} });
globalThis.getShoppingListCloud = async () => ({});
globalThis.applyState = () => {};
globalThis.handleRoute = () => {};

initFirebase();
observeAuthState(() => {});
setupEmailInviteForm();
setupVerificationBanner();

// ---- Aiutanti del test ----
const PENDING_KEY = PENDING_EMAIL_INVITE_STORAGE;
const AWAITING_KEY = EMAIL_INVITE_AWAITING_LINK_STORAGE;

function hexToken(n) {
  return n.toString(16).padStart(64, '0');
}

function createInvite({ token, email, clientId }) {
  const invite = {
    token, email: normalizeEmailAddress(email), clientId,
    firstName: 'Mario', lastName: 'Rossi', status: 'pending'
  };
  serverState.invites.set(token, invite);
  return invite;
}

// Percorso reale del link #/invito/<token>: anteprima dal server + submit del
// modulo con la sola password scelta dal cliente.
async function registraClienteDaInvito({ token, email, clientId }) {
  createInvite({ token, email, clientId });
  window.location.hash = `#/invito/${token}`;
  pendingEmailInviteToken = loadPendingEmailInviteToken();
  emailInvitePreview = await previewClientInvite(token);
  renderEmailInvitePreview();
  document.getElementById('email-invite-password').value = 'PasswordSegreta1';
  await Promise.all(document.getElementById('email-invite-form')._fire('submit', { preventDefault() {} }));
}

const redeemCalls = () => functionCalls.filter(call => call.name === 'redeemClientInvite');

test('registrazione da invito → verifica email → attivazione del collegamento al primo accesso', async () => {
  const token = hexToken(1);
  const email = 'cliente1@esempio.it';
  await registraClienteDaInvito({ token, email, clientId: 'client-1' });

  // 1) Registrazione: il server risponde `email-verification-required` e NON
  //    consuma l'invito; il token resta in sessione, in attesa di attivazione.
  assert.ok(fakeAuth.currentUser, 'il cliente è autenticato dopo la registrazione');
  assert.equal(fakeAuth.currentUser.email, email);
  assert.equal(fakeAuth.currentUser.emailVerified, false);
  assert.equal(emailVerificationsSent, 1, 'email di verifica inviata al cliente');
  assert.equal(serverState.invites.get(token).status, 'pending', 'il token non si consuma prima della verifica');
  assert.equal(redeemCalls().at(-1).data.token, token, 'primo riscatto con il token dell’invito');
  assert.equal(serverState.links.size, 0, 'nessun collegamento attivo');
  assert.equal(sessionStorage.getItem(PENDING_KEY), token, 'token d’invito NON cancellato');
  assert.equal(sessionStorage.getItem(AWAITING_KEY) !== null, true, 'invito registrato e in attesa di attivazione');
  assert.equal(idTokenRequests.length, 0, 'alla registrazione il rinnovo forzato non serve');
  assert.equal(document.getElementById('email-invite-screen').classList.contains('hidden'), true, 'schermata di registrazione chiusa');

  // 2) Verifica dell'email fuori dall'app: profilo server verificato, client e
  //    token in cache ancora vecchi (è la causa del collegamento mai attivato).
  verificaEmailFuoriDallApp();
  assert.equal(fakeAuth.currentUser.emailVerified, false, 'il client non sa ancora della verifica');
  assert.equal(currentAuthClaim().email_verified, false, 'il token in cache è vecchio');

  // 3) Accesso o ricarica: loadUserData è il percorso comune ai due casi.
  const primaDelRiscatto = redeemCalls().length;
  await loadUserData(fakeAuth.currentUser, { silent: true });

  assert.equal(redeemCalls().length, primaDelRiscatto + 1, 'un solo riscatto: nessun duplicato');
  assert.equal(redeemCalls().at(-1).data.token, null, 'riscatto SENZA token');
  assert.equal(typeof redeemCalls().at(-1).data.idempotencyKey, 'string');
  assert.ok(idTokenRequests.some(item => item.force === true), 'ID token rinnovato a forza: getIdToken(true)');
  assert.equal(serverState.invites.get(token).status, 'accepted', 'invito riscattato');
  assert.equal(serverState.invites.get(token).redeemedBy, fakeAuth.currentUser.uid);
  assert.equal(appState.clientLink?.link?.organizationName, 'Studio Guide', 'collegamento attivo nello stato dell’app');
  assert.equal(appState.user.emailVerified, true, 'stato di verifica aggiornato nello stato dell’app');
  assert.equal(sessionStorage.getItem(PENDING_KEY), null, 'token cancellato SOLO a collegamento attivo');
  assert.equal(sessionStorage.getItem(AWAITING_KEY), null, 'nessun invito in attesa residuo');
  assert.match(
    document.getElementById('app-toast').textContent,
    /collegamento con il tuo nutrizionista attivato/i,
    'il cliente vede la conferma dell’attivazione'
  );

  // 4) Accesso successivo con collegamento già attivo: nessun nuovo riscatto.
  const chiamateConCollegamento = redeemCalls().length;
  await loadUserData(fakeAuth.currentUser, { silent: true });
  assert.equal(redeemCalls().length, chiamateConCollegamento, 'collegamento attivo: il riscatto non si ripete');
});

test('pulsante "Ho verificato: attiva il collegamento": attivazione immediata dopo la verifica', async () => {
  await signOutUser();
  appState.user = null;
  appState.clientLink = { requests: [], link: null };
  sessionStorage.removeItem(PENDING_KEY);
  sessionStorage.removeItem(AWAITING_KEY);

  const token = hexToken(2);
  const email = 'cliente2@esempio.it';
  await registraClienteDaInvito({ token, email, clientId: 'client-2' });
  // Come dopo la registrazione nell'app: l'observer dell'autenticazione ha
  // portato l'utente nello stato dell'app (qui non si esegue initApp).
  appState.user = fakeAuth.currentUser;
  verificaEmailFuoriDallApp();

  const primaDelClic = redeemCalls().length;
  await Promise.all(document.getElementById('email-verification-confirm')._fire('click', {}));

  assert.equal(redeemCalls().length, primaDelClic + 1, 'il pulsante riscatta una sola volta');
  assert.equal(
    redeemCalls().at(-1).data.token, token,
    'richiesta esplicita: riusa l’invito ancora in attesa in questa scheda'
  );
  assert.ok(idTokenRequests.some(item => item.force === true), 'ID token rinnovato prima del riscatto');
  assert.equal(serverState.invites.get(token).status, 'accepted');
  assert.equal(appState.clientLink?.link?.organizationName, 'Studio Guide', 'collegamento attivo');
  assert.equal(sessionStorage.getItem(PENDING_KEY), null, 'token cancellato a collegamento attivo');
  assert.match(document.getElementById('app-toast').textContent, /attivato/i);
  assert.equal(document.getElementById('email-verification-confirm').disabled, false, 'pulsante riabilitato');
});

test('cliente verificato senza invito pendente: nessun collegamento e token conservato', async () => {
  await signOutUser();
  appState.clientLink = { requests: [], link: null };
  const token = hexToken(3);
  const email = 'cliente3@esempio.it';
  // Registrazione avvenuta altrove: qui resta solo il token in attesa, senza
  // inviti pendenti sul server (es. invito annullato dal professionista).
  sessionStorage.setItem(PENDING_KEY, token);
  sessionStorage.setItem(AWAITING_KEY, JSON.stringify({ token, email }));
  const user = await signUpFake(email);
  verificaEmailFuoriDallApp();

  await loadUserData(user, { silent: true });

  assert.equal(redeemCalls().at(-1).data.token, null, 'riscatto senza token');
  assert.equal(serverState.links.has(user.uid), false, 'nessun collegamento creato');
  assert.equal(appState.clientLink?.link, null, 'nessun collegamento attivo nello stato dell’app');
  assert.equal(appState.clientLink?.error, undefined, 'nessun errore: `no-pending-invite` non è un guasto');
  assert.equal(sessionStorage.getItem(PENDING_KEY), token, 'token conservato: il riscatto non è `link-active`');
});

test('banner di verifica: pulsante "Ho verificato: attiva il collegamento" e reinvio conservato', () => {
  const html = read('index.html');
  const appJs = read('js/app.js');
  const css = read('css/style.css');
  assert.match(html, /id="email-verification-banner"/);
  assert.match(html, /id="email-verification-resend"/);
  assert.match(html, /id="email-verification-confirm"[^>]*>Ho verificato: attiva il collegamento</);
  assert.match(html, /class="email-verification-actions"/);
  assert.match(css, /\.email-verification-actions/);
  assert.match(appJs, /document\.getElementById\("email-verification-confirm"\)/);
  assert.match(appJs, /activateClientLinkAfterVerification\(\{\s*useAwaitingInvite: true,\s*feedback: "always"\s*\}\)/);
  // Il pulsante sparisce solo quando la verifica non serve più o il
  // collegamento è già attivo.
  assert.match(appJs, /confirmButton\.classList\.toggle\("hidden", !needsVerification \|\| linked\)/);
});

test('client: ID token forzato, riscatto senza token e cancellazione solo a `link-active`', () => {
  const appJs = read('js/app.js');
  const firebaseJs = read('js/firebase.js');

  // firebase.js: rinnovo forzato dell'ID token e riscatto senza token.
  assert.match(firebaseJs, /async function forceIdTokenRefresh\(\)/);
  assert.match(firebaseJs, /return user\.getIdToken\(true\)/);
  assert.match(firebaseJs, /async function redeemClientInviteForVerifiedEmail\(idempotencyKey\)/);
  assert.match(firebaseJs, /return redeemClientInvite\(null, idempotencyKey\)/);
  assert.match(firebaseJs, /const CLIENT_LINK_ACTIVE_STATUSES = Object\.freeze\(\["link-active", "already-linked"\]\)/);

  // app.js: l'attivazione parte da loadUserData, cioè da ogni accesso e ricarica.
  const loadStart = appJs.indexOf('async function loadUserData');
  const hookIndex = appJs.indexOf('activateClientLinkAfterVerification({ user })');
  assert.ok(loadStart > 0 && hookIndex > loadStart, 'l’attivazione è agganciata a loadUserData');
  assert.ok(hookIndex < appJs.indexOf('function applyState', loadStart), 'l’attivazione avviene prima di applicare il piano');
  // Guardie: solo clienti con email reale, solo se l’email è verificata e non
  // c’è già un collegamento attivo.
  assert.match(appJs, /if \(!isRealEmailAccount\(user\)\) return null;/);
  assert.match(appJs, /if \(appState\.clientLink\?\.link\) return null;/);

  // Il token d'invito si cancella SOLO nel ramo `link-active` del riscatto.
  const submitIndex = appJs.indexOf('const inviteToken = pendingEmailInviteToken || emailInvitePreview.token;');
  const branchIndex = appJs.indexOf('if (isClientLinkActiveStatus(result?.status)) {', submitIndex);
  const clearIndex = appJs.indexOf('clearPendingEmailInviteToken();', submitIndex);
  const verifyBranchIndex = appJs.indexOf('} else if (result?.status === "email-verification-required")', submitIndex);
  assert.ok(branchIndex > submitIndex, 'ramo di successo presente');
  assert.ok(clearIndex > branchIndex, 'la cancellazione sta nel ramo link-active');
  assert.ok(clearIndex < verifyBranchIndex, 'il ramo della verifica email non cancella il token');
  assert.match(appJs, /markEmailInviteAwaitingLink\(inviteToken, emailInvitePreview\.email\)/);
});

test('contratto server invariato: senza token risponde `link-active`/`no-pending-invite`', () => {
  const indexJs = read('functions/src/index.js');
  assert.match(indexJs, /exports\.redeemClientInvite = callable/);
  assert.match(indexJs, /if \(!emailVerified \|\| !authEmail\) return \{ status: 'no-pending-invite' \};/);
  assert.match(indexJs, /if \(snap\.empty\) return \{ status: 'no-pending-invite' \};/);
  assert.match(indexJs, /status: 'email-verification-required'/);
  // Versione della shell PWA aggiornata per servire il nuovo client.
  assert.match(read('sw.js'), /const CACHE_VERSION = 88/);
});
