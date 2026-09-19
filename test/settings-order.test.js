'use strict';
/* Sessione 1 — Impostazioni riordinate, via il nome mostrato, anagrafica nutrizionista.
 *
 * Contratto verificato senza rete, per sola lettura dei sorgenti e DOM minimale:
 *  - sezioni con eyebrow in ordine: PROFILO NUTRIZIONALE, PROFESSIONISTA,
 *    ACCOUNT COLLEGATI, LA MIA DIETA (se assegnata), ASPETTO, USCITA;
 *  - account-card rimossa, profile-name-form rimosso;
 *  - USCITA contiene logoutCurrentUser() e nessun altro logout duplicato;
 *  - il toggle tema è penultimo, prima di USCITA.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

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
    focus: () => { el.focused = true; },
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
  el._fire = (name, event) => { (listeners[name] || []).forEach(fn => fn(event || {})); };
  return el;
}

const elements = new Map();
const doc = {
  getElementById: id => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  },
  createElement: tag => makeElement(tag),
  querySelector: sel => makeElement(sel),
  querySelectorAll: () => [],
  addEventListener: (name, fn) => { doc['_on_' + name] = fn; },
  body: makeElement('body'),
  documentElement: makeElement('html')
};

global.window = global;
global.document = doc;
global.localStorage = {
  _data: {},
  getItem(key) { return key in this._data ? this._data[key] : null; },
  setItem(key, value) { this._data[key] = String(value); },
  removeItem(key) { delete this._data[key]; }
};
Object.defineProperty(global, 'navigator', { value: {}, configurable: true, writable: true });

const dbStub = {
  collection: () => dbStub,
  doc: () => dbStub,
  where: () => dbStub,
  orderBy: () => dbStub,
  limit: () => dbStub,
  get: async () => ({ exists: false, forEach: () => {}, data: () => ({}) }),
  set: async () => {},
  add: async () => ({ id: 'x' }),
  update: async () => {},
  delete: async () => {},
  enablePersistence: async () => {},
  onSnapshot: () => () => {},
  batch: () => ({ set: () => {}, update: () => {}, delete: () => {}, commit: async () => {} })
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
    setPersistence: async () => {},
    signInWithEmailAndPassword: async () => ({}),
    signOut: async () => {},
    onAuthStateChanged: fn => { fn(global.__fakeUser); return () => {}; }
  })
};
global.firebase.auth.Auth = { Persistence: { LOCAL: 'local' } };
global.__fakeUser = { uid: 'u1', email: 'mario@utenti.pianonutrizionale.app' };

for (const file of ['js/domain.js', 'js/saas-config.js', 'js/saas.js', 'js/data.js', 'js/prices.js', 'js/firebase.js', 'js/app.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
}

initFirebase();
observeAuthState(() => {});
appState.user = { uid: 'u1', email: 'mario@utenti.pianonutrizionale.app' };
appState.deviceSettings = {
  portionProfile: 'single', darkMode: false, lastOpenDate: null,
  recipeLibraryState: { searchQuery: '', openSections: {} }, shopCategoryOrder: []
};
appState.household = null;
appState.saasContext = { state: 'unassigned' };
appState.clientLink = { requests: [], link: { organizationId: 'org-1', organizationName: 'Studio A', clientId: 'c1', firstName: 'Mario', lastName: 'Rossi', email: 'mario@esempio.it', emailVerified: true, nutritionistUsername: 'nutri1', nutritionistDisplayName: 'Dott. Bianchi' } };

test('Impostazioni: tema penultimo e uscita davvero ultima', () => {
  // Con una dieta assegnata la sezione LA MIA DIETA è visibile: serve un
  // profilo v3 valido (struttura con piano a blocchi).
  const previousContext = appState.saasContext;
  const previousPolicy = appState.saasPolicy;
  appState.saasContext = { state: 'assigned', profile: {
    schemaVersion: 3, clientProfileId: 'cp1', assignmentId: 'a1',
    structureId: 's1', structureRevisionId: 'rev1', structureChecksum: 'chk',
    structureName: 'Struttura base', ingredientCatalogVersion: 1,
    structureRevision: { revisionId: 'rev1', dietPlan: PianoDomain.createEmptyDietPlan() },
    catalog: { categories: [], families: [], ingredients: [] },
    compatibleClientSchema: 7
  } };
  appState.saasPolicy = { mode: 'assigned', plan: appState.plan, migrationRequired: false };
  try {
  renderSettings();
  const html = document.getElementById('view-settings').innerHTML;
  const idxProfilo = html.indexOf('PROFILO NUTRIZIONALE');
  const idxProfessionista = html.indexOf('PROFESSIONISTA');
  const idxAccount = html.indexOf('ACCOUNT COLLEGATI');
  const idxDieta = html.indexOf('LA MIA DIETA');
  const idxAspetto = html.indexOf('ASPETTO');
  const idxUscita = html.indexOf('USCITA');
  assert.ok(idxProfilo >= 0, 'manca PROFILO NUTRIZIONALE');
  assert.ok(idxProfessionista >= 0, 'manca PROFESSIONISTA');
  assert.ok(idxAccount >= 0, 'manca ACCOUNT COLLEGATI');
  assert.ok(idxDieta >= 0, 'manca LA MIA DIETA');
  assert.ok(idxAspetto >= 0, 'manca ASPETTO');
  assert.ok(idxUscita >= 0, 'manca USCITA');
  assert.ok(idxProfilo < idxProfessionista, 'PROFILO NUTRIZIONALE prima di PROFESSIONISTA');
  assert.ok(idxProfessionista < idxAccount, 'PROFESSIONISTA prima di ACCOUNT COLLEGATI');
  assert.ok(idxAccount < idxDieta, 'ACCOUNT COLLEGATI prima di LA MIA DIETA');
  assert.ok(idxDieta < idxAspetto, 'LA MIA DIETA prima di ASPETTO');
  assert.ok(idxAspetto < idxUscita, 'ASPETTO prima di USCITA');
  // Ogni sezione ha eyebrow
  assert.match(html, /<p class="eyebrow">PROFILO NUTRIZIONALE<\/p>/);
  assert.match(html, /<p class="eyebrow">PROFESSIONISTA<\/p>/);
  assert.match(html, /<p class="eyebrow">ACCOUNT COLLEGATI<\/p>/);
  assert.match(html, /<p class="eyebrow">LA MIA DIETA<\/p>/);
  assert.match(html, /<p class="eyebrow">ASPETTO<\/p>/);
  assert.match(html, /<p class="eyebrow">USCITA<\/p>/);
  assert.match(html, /Tema scuro/);
  assert.match(html, /settings-dark-mode-toggle/);
  // Testata della pagina Impostazioni senza manuale alimentare rimosso
  assert.doesNotMatch(html, /LINEE GUIDA/);
  assert.doesNotMatch(html, /manuale alimentare/i);
  } finally {
    appState.saasContext = previousContext;
    appState.saasPolicy = previousPolicy;
  }
});

test('Impostazioni: account-card e form nome mostrato rimossi, logout unico in USCITA', () => {
  renderSettings();
  const html = document.getElementById('view-settings').innerHTML;
  assert.doesNotMatch(html, /account-card/);
  assert.doesNotMatch(html, /profile-name-form/);
  assert.doesNotMatch(html, /client-display-name/);
  assert.doesNotMatch(html, /saveClientDisplayName/);
  assert.match(html, /logoutCurrentUser\(\)/);
  // Un solo logoutCurrentUser nella vista Impostazioni (nella sezione USCITA)
  const matches = html.match(/logoutCurrentUser/g) || [];
  assert.equal(matches.length, 1, 'un solo logout in Impostazioni');
  assert.match(html, /Esci in sicurezza/);
  assert.match(html, /Uscita dall'account/);
  // Il contenitore impostazioni non contiene più la card Accesso personale
  assert.doesNotMatch(html, /Accesso personale/);
});

test('sorgenti: nessun riferimento residuo al nome mostrato cliente', () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const domainJs = fs.readFileSync(path.join(ROOT, 'js/domain.js'), 'utf8');
  const adminJs = fs.readFileSync(path.join(ROOT, 'js/admin.js'), 'utf8');
  const functionsIndex = fs.readFileSync(path.join(ROOT, 'functions/src/index.js'), 'utf8');
  const functionsDomain = fs.readFileSync(path.join(ROOT, 'functions/src/domain.js'), 'utf8');
  // app.js: solo catalogo può avere displayName, mai cliente
  assert.doesNotMatch(appJs, /client-display-name/);
  assert.doesNotMatch(appJs, /profile-name-form/);
  assert.doesNotMatch(appJs, /saveClientDisplayName/);
  // domain.js: titolo senza displayName
  const titleFn = domainJs.slice(domainJs.indexOf('function clientDisplayTitle'), domainJs.indexOf('function clientInitials'));
  assert.doesNotMatch(titleFn, /displayName/);
  assert.match(titleFn, /maskEmailClient/);
  // admin.js: anagrafica cliente senza displayName
  assert.doesNotMatch(adminJs, /client-profile-display-name/);
  // functions: nessuna occorrenza client displayName residua (solo cataloghi e professionisti)
  assert.doesNotMatch(functionsIndex, /clientData\.displayName/);
  assert.doesNotMatch(functionsIndex, /row\.data\.displayName.*firstName/);
  assert.doesNotMatch(functionsDomain, /displayName.*client/);
  // Sintassi: nessuna callable updateMy* residua
  assert.doesNotMatch(functionsIndex, /exports\.updateMyClientProfile/);
  assert.doesNotMatch(functionsIndex, /exports\.updateMyMemberProfile/);
  assert.match(functionsIndex, /exports\.updateMemberProfileByStaff/);
});

test('transazioni: letture prima delle scritture in removeClientLink e requestClientUnlink', () => {
  const functionsIndex = fs.readFileSync(path.join(ROOT, 'functions/src/index.js'), 'utf8');
  const checkOrder = (exportName) => {
    const start = functionsIndex.indexOf(`exports.${exportName}`);
    assert.ok(start >= 0, `manca ${exportName}`);
    // Trova la transazione corrispondente (prima occorrenza di runTransaction dopo l'export)
    const txStart = functionsIndex.indexOf('db.runTransaction', start);
    assert.ok(txStart >= 0, `manca runTransaction in ${exportName}`);
    const txEnd = functionsIndex.indexOf('});', txStart + 500);
    const block = functionsIndex.slice(txStart, txEnd + 500);
    const firstGet = block.indexOf('tx.get(');
    const firstUpdate = block.indexOf('tx.update(');
    const firstDelete = block.indexOf('tx.delete(');
    const firstCreate = block.indexOf('tx.create(');
    const firstWrite = Math.min(
      firstUpdate >= 0 ? firstUpdate : Infinity,
      firstDelete >= 0 ? firstDelete : Infinity,
      firstCreate >= 0 ? firstCreate : Infinity
    );
    assert.ok(firstGet >= 0, `nessuna tx.get in ${exportName}`);
    assert.ok(firstWrite >= 0, `nessuna scrittura in ${exportName}`);
    assert.ok(firstGet < firstWrite, `in ${exportName} le letture devono precedere le scritture (Sessione 1)`);
    // Verifica che non ci siano tx.get dopo il primo tx.update
    const afterFirstWrite = block.slice(firstWrite);
    // Se c'è un tx.get dopo la prima scrittura, è un errore (tranne Promise.resolve null)
    const getAfterWrite = afterFirstWrite.indexOf('tx.get(');
    assert.equal(getAfterWrite, -1, `in ${exportName} nessuna tx.get dopo la prima scrittura`);
  };
  checkOrder('requestClientUnlink');
  checkOrder('removeClientLink');
});

