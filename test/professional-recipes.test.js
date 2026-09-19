'use strict';
/* Parte C (client) — ricette del professionista (ADR 0003):
 * - merge puro: catalogo preservato, sostituzione per stesso id, flag
 *   fromProfessional con provenienza;
 * - anteprima conflitti: nota di sola lettura al posto dei select;
 * - badge 🩺 in notifica, ricettario e modale; modifica bloccata. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PianoDomain = require('../js/domain');
const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');

function recipe(id, name, extra = {}) {
  return { id, name, slot: 'lunch', emoji: '🍲', ingredients: [], steps: [], notes: [], ...extra };
}

// ---- merge puro ----

test('applyProfessionalRecipes: preserva, sostituisce per id, marca provenienza', () => {
  const current = [recipe('A', 'Mia A'), recipe('B', 'Mia B')];
  const incoming = [recipe('B', 'Pro B'), recipe('C', 'Pro C')];
  const out = PianoDomain.applyProfessionalRecipes(current, incoming, {
    senderUid: 'n1', senderUsername: 'dottore', organizationId: 'pianoNutrizionale', receivedAt: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(out.length, 3);
  assert.equal(out.find(r => r.id === 'A').name, 'Mia A', 'non toccata: resta senza flag');
  assert.equal(out.find(r => r.id === 'A').fromProfessional, undefined);
  const b = out.find(r => r.id === 'B');
  assert.equal(b.name, 'Pro B', 'stesso id: sostituita');
  assert.deepEqual(b.fromProfessional, {
    senderUid: 'n1', senderUsername: 'dottore', organizationId: 'pianoNutrizionale', receivedAt: '2026-01-01T00:00:00.000Z'
  });
  assert.ok(out.find(r => r.id === 'C').fromProfessional, 'nuova: marcata');
  assert.deepEqual(out.map(r => r.id), ['A', 'B', 'C'], 'ordinato per id');
  assert.equal(current.find(r => r.id === 'B').name, 'Mia B', 'input non mutato');
});

test('applyProfessionalRecipes: replace e input sporco', () => {
  const incoming = [recipe('R1', 'Pro')];
  const replaced = PianoDomain.applyProfessionalRecipes([], incoming, { senderUid: 'n1' });
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].fromProfessional.senderUid, 'n1');
  assert.deepEqual(replaced[0].fromProfessional.receivedAt, null);
  const dirty = PianoDomain.applyProfessionalRecipes([recipe('A', 'Mia')], [null, { name: 'senza id' }], {});
  assert.equal(dirty.length, 1, 'voci senza id ignorate');
  assert.equal(PianoDomain.isProfessionalRecipe(replaced[0]), true);
  assert.equal(PianoDomain.isProfessionalRecipe(recipe('A', 'Mia')), false);
  assert.equal(PianoDomain.isProfessionalRecipe(null), false);
});

// ---- harness app ----

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
    title: '',
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
appState.clientLink = null;

const PRO_SHARE = {
  id: 'sh-pro', senderUid: 'n1', senderUsername: 'dottore', senderRole: 'professional',
  organizationId: 'pianoNutrizionale', status: 'pending', recipeCount: 1,
  recipes: [recipe('A', 'Pro A', { ingredients: [{ name: 'Riso', portions: { single: '80 g' } }] })]
};
const USER_SHARE = {
  id: 'sh-user', senderUid: 'u2', senderUsername: 'amico', status: 'pending', recipeCount: 1,
  recipes: [recipe('A', 'Amico A')]
};

test('anteprima professionale: nota di sola lettura, nessun select, theirs forzato', () => {
  appState.recipes = [recipe('A', 'Mia A')];
  appState.plan = PianoDomain.migratePlan({});
  openShareConflictPreview(PRO_SHARE, 'recipes');
  const html = document.getElementById('share-conflict-body').innerHTML;
  assert.match(html, /Aggiornamenti dal professionista/);
  assert.match(html, /restano in sola lettura/);
  assert.doesNotMatch(html, /data-conflict-index/, 'niente select di risoluzione');
  assert.equal(pendingShareAccept.resolution.A, 'theirs', 'conflitto forzato a theirs');
  closeShareConflictModal();
});

test('anteprima tra utenti: select di risoluzione invariati', () => {
  appState.recipes = [recipe('A', 'Mia A')];
  appState.plan = PianoDomain.migratePlan({});
  openShareConflictPreview(USER_SHARE, 'recipes');
  const html = document.getElementById('share-conflict-body').innerHTML;
  assert.match(html, /Conflitti: scegli per ogni ricetta/);
  assert.match(html, /data-conflict-index/, 'select presenti');
  assert.doesNotMatch(html, /sola lettura/);
  closeShareConflictModal();
});

test('notifica in arrivo: tag professionista sulla card', () => {
  incomingRecipeShares = [PRO_SHARE, USER_SHARE];
  incomingAccountLinks = [];
  renderIncomingShares();
  const html = document.getElementById('incoming-shares-list').innerHTML;
  assert.match(html, /Dal tuo professionista/);
  assert.equal((html.match(/Dal tuo professionista/g) || []).length, 1, 'solo sulla professionale');
  incomingRecipeShares = [];
});

test('ricettario: badge sulla card professionale', () => {
  appState.recipes = [
    recipe('A', 'Mia A'),
    recipe('B', 'Pro B', { fromProfessional: { senderUsername: 'dottore' } })
  ];
  renderRecipes();
  const html = document.getElementById('view-recipes').innerHTML;
  assert.match(html, /<span class="pro-badge">🩺 Professionista<\/span>/);
  assert.equal((html.match(/pro-badge/g) || []).length, 1);
  appState.recipes = [];
});

test('modale ricetta: badge e modifica bloccata', () => {
  appState.saasPolicy = { mode: 'assigned', migrationRequired: false };
  currentModal = {
    recipe: recipe('B', 'Pro B', {
      fromProfessional: { senderUid: 'n1', senderUsername: 'dottore' },
      ingredients: [{ name: 'Riso', portions: { single: '80 g' } }]
    }),
    original: null, dayKey: null, dayType: 'training', slot: null, planSlot: null, isNew: false
  };
  editMode = false;
  renderModalContent();
  const timeHtml = document.getElementById('modal-time').innerHTML;
  assert.match(timeHtml, /Dal tuo professionista · sola lettura/);
  assert.match(timeHtml, /title="Inviata da dottore"/);
  const editBtn = document.getElementById('modal-edit-btn');
  assert.equal(editBtn.disabled, true);
  assert.equal(editBtn.title, 'Ricetta del professionista: sola lettura');
  currentModal = null;
});

test('stile badge: token scala, niente valori a mano', () => {
  assert.match(css, /\.pro-badge \{ [^}]*font-size: var\(--fs-badge\);[^}]*\}/);
  assert.match(css, /\.pro-badge \{ [^}]*padding: 4px 8px;[^}]*\}/);
});
