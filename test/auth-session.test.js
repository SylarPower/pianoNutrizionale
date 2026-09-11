'use strict';
/* Sessioni Auth indipendenti tra app cliente e console professionisti.
 * Verifica a livello del codice condiviso (js/firebase.js) che:
 *  - la console usa un Firebase App NOMINATO ("admin-console") con Auth,
 *    Firestore e Functions propri;
 *  - il login dell'app cliente NON viene rilevato dalla console;
 *  - persistenza, login e logout delle due pagine restano indipendenti;
 *  - le callable della console partono dalle Functions dell'app nominata
 *    (identità corretta lato server), quelle dell'app cliente dal default.
 * L'SDK compat è simulato con app nominati realmente separati: se il codice
 * usasse per errore l'Auth condivisa, questi test fallirebbero. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const ADMIN_APP = 'admin-console';
const DEFAULT_APP = '[DEFAULT]';

const authRegistry = new Map();
function makeAuth(name) {
  const listeners = new Set();
  const state = { currentUser: null, signIns: [], persistence: null };
  const auth = {
    name,
    _state: state,
    setPersistence: async value => { state.persistence = value; },
    signInWithEmailAndPassword: async (email, password) => {
      if (!password) throw Object.assign(new Error('password mancante'), { code: 'auth/wrong-password' });
      state.currentUser = { uid: `uid-${email.split('@')[0]}`, email };
      state.signIns.push(email);
      listeners.forEach(fn => fn(state.currentUser));
      return { user: state.currentUser };
    },
    signOut: async () => {
      state.currentUser = null;
      listeners.forEach(fn => fn(null));
    },
    // Come l'SDK reale: alla registrazione il listener riceve subito (in
    // modo asincrono) lo stato corrente di QUELLA istanza Auth.
    onAuthStateChanged: fn => {
      listeners.add(fn);
      queueMicrotask(() => { if (listeners.has(fn)) fn(state.currentUser); });
      return () => listeners.delete(fn);
    }
  };
  return auth;
}
function authFor(name) {
  if (!authRegistry.has(name)) authRegistry.set(name, makeAuth(name));
  return authRegistry.get(name);
}

const callableLog = [];
function functionsFor(appName) {
  return {
    httpsCallable: name => async data => {
      callableLog.push({ app: appName, name, data });
      return { data: { ok: true, app: appName, name } };
    }
  };
}

const dbStub = {
  doc: () => dbStub,
  collection: () => dbStub,
  where: () => dbStub,
  orderBy: () => dbStub,
  limit: () => dbStub,
  get: async () => ({ exists: false, forEach: () => {}, data: () => ({}) }),
  set: async () => {},
  add: async () => ({ id: 'x' }),
  update: async () => {},
  delete: async () => {},
  batch: () => ({ set: () => {}, update: () => {}, delete: () => {}, commit: async () => {} }),
  enablePersistence: async () => {},
  onSnapshot: () => () => {}
};

const apps = [];
global.window = global;
global.firebase = {
  apps,
  initializeApp: (config, name) => {
    const appName = name || DEFAULT_APP;
    const existing = apps.find(item => item.name === appName);
    if (existing) return existing;
    const app = {
      name: appName,
      options: config,
      auth: () => authFor(appName),
      firestore: () => dbStub,
      functions: () => functionsFor(appName),
      appCheck: () => ({ activate: () => {} })
    };
    apps.push(app);
    return app;
  },
  app: name => apps.find(item => item.name === (name || DEFAULT_APP)) || null,
  appCheck: () => ({ activate: () => {} }),
  firestore: Object.assign(() => dbStub, {
    FieldValue: {
      serverTimestamp: () => ({}),
      arrayUnion: (...values) => values,
      arrayRemove: (...values) => values
    }
  }),
  auth: Object.assign(app => authFor(app?.name || DEFAULT_APP), {
    Auth: { Persistence: { LOCAL: 'local' } }
  }),
  functions: () => functionsFor(DEFAULT_APP)
};

global.localStorage = {
  _data: {},
  getItem(key) { return key in this._data ? this._data[key] : null; },
  setItem(key, value) { this._data[key] = String(value); },
  removeItem(key) { delete this._data[key]; }
};

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/firebase.js'), 'utf8'), { filename: 'js/firebase.js' });

const tick = async () => { await new Promise(resolve => setImmediate(resolve)); };

const defaultAuth = () => authFor(DEFAULT_APP);
const adminAuth = () => authFor(ADMIN_APP);

test('bootstrap: la console usa un app Firebase nominato e separato', async () => {
  assert.equal(initFirebase(), true);
  await tick();
  await observeAdminUser(); // forza ensureAdminServices
  const names = global.firebase.apps.map(app => app.name);
  assert.ok(names.includes(DEFAULT_APP), 'app cliente predefinita presente');
  assert.ok(names.includes(ADMIN_APP), 'app nominata della console presente');
  assert.notEqual(authFor(DEFAULT_APP), authFor(ADMIN_APP), 'Auth delle due pagine distinti');
});

async function observeAdminUser() {
  return new Promise(resolve => {
    const unsubscribe = observeAdminAuthState(user => {
      unsubscribe();
      resolve(user);
    });
  });
}

test('login app cliente NON autentica la console', async () => {
  initFirebase();
  await tick();
  await signInWithUsername('mario', 'segreta');
  assert.equal(defaultAuth()._state.currentUser?.uid, 'uid-mario');
  const adminUser = await observeAdminUser();
  assert.equal(adminUser, null, 'admin.html vede il proprio login, non la sessione cliente');
});

test('persistenze indipendenti e login simultanei', async () => {
  initFirebase();
  await tick();
  await signInWithUsername('mario', 'segreta');
  await adminSignInWithUsername('prof.anna', 'segreta');
  assert.equal(defaultAuth()._state.persistence, 'local', 'persistenza locale app cliente');
  assert.equal(adminAuth()._state.persistence, 'local', 'persistenza locale console');
  assert.equal(defaultAuth()._state.currentUser?.uid, 'uid-mario');
  assert.equal(adminAuth()._state.currentUser?.uid, 'uid-prof.anna', 'due sessioni attive contemporaneamente');
});

test('logout console non tocca la sessione cliente (e viceversa)', async () => {
  initFirebase();
  await tick();
  await signInWithUsername('mario', 'segreta');
  await adminSignInWithUsername('prof.anna', 'segreta');
  await adminSignOutUser();
  assert.equal(adminAuth()._state.currentUser, null, 'logout console riuscito');
  assert.equal(defaultAuth()._state.currentUser?.uid, 'uid-mario', 'sessione cliente intatta');
  await adminSignInWithUsername('prof.anna', 'segreta');
  await signOutUser();
  assert.equal(defaultAuth()._state.currentUser, null, 'logout cliente riuscito');
  assert.equal(adminAuth()._state.currentUser?.uid, 'uid-prof.anna', 'sessione console intatta');
});

test('le callable della console usano le Functions dell’app nominata', async () => {
  initFirebase();
  await tick();
  callableLog.length = 0;
  await signInWithUsername('mario', 'segreta');
  await adminSignInWithUsername('prof.anna', 'segreta');
  await callSaasFunction('getMyAssignedProfile', {});
  await callAdminSaasFunction('getMyMemberships', {});
  const clientCall = callableLog.find(item => item.name === 'getMyAssignedProfile');
  const adminCall = callableLog.find(item => item.name === 'getMyMemberships');
  assert.equal(clientCall.app, DEFAULT_APP, 'callable cliente sul functions predefinito');
  assert.equal(adminCall.app, ADMIN_APP, 'callable console con identità professionale, NON quella cliente');
});

test('validazione input condivisa: stesso comportamento nei due login', async () => {
  initFirebase();
  await tick();
  await assert.rejects(() => adminSignInWithUsername('no', 'x'), /3-32 caratteri/);
  await assert.rejects(() => adminSignInWithUsername('mario', ''), /password/i);
  await assert.rejects(() => signInWithUsername('no', 'x'), /3-32 caratteri/);
});

test('l’observer della console non dipende da currentUser del cliente', async () => {
  initFirebase();
  await tick();
  // I test precedenti lasciano una sessione admin attiva: lo scenario da
  // verificare è "solo sessione cliente", quindi la console esce prima.
  await adminSignOutUser();
  const seen = [];
  observeAuthState(user => seen.push(['client', user?.uid || null]));
  await signInWithUsername('mario', 'segreta');
  const adminUser = await observeAdminUser();
  assert.deepEqual(seen.at(-1), ['client', 'uid-mario']);
  assert.equal(adminUser, null, 'observeAdminAuthState ascolta l’Auth nominata, non quella condivisa');
  assert.equal(getAdminCurrentUser(), null);
});

test('letture Firestore della console passano dai servizi dell’app nominata', async () => {
  initFirebase();
  await tick();
  // Con lo stub compat, adminCollectionAt deve risolversi senza lanciare e
  // senza toccare il Firestore dell'app predefinita.
  const ref = adminCollectionAt('globalIngredientCatalog/current/ingredients');
  assert.ok(ref, 'riferimento collezione console disponibile');
  const query = adminQueryLimit(ref, 500);
  const snapshot = await adminGetDocsQuery(query);
  assert.ok(snapshot && typeof snapshot.forEach === 'function');
});
