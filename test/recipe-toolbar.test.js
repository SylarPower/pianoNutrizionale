'use strict';
/* Parte B — barra del Ricettario cliente:
 * - 4 pulsanti uguali: Importa/Esporta (modale), Invia a un utente,
 *   + Nuova, Elimina tutte (disabilitata a catalogo vuoto);
 * - modale Importa/Esporta con input file JSON e azione di export;
 * - editor ricetta: etichetta "Pasto" (non più "Tipo") per lo slot;
 * - griglia 4 colonne desktop, 2x2 su mobile. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');

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

function recipesHtml() {
  return document.getElementById('view-recipes').innerHTML;
}

test('toolbar: 4 pulsanti uguali in ordine con le azioni giuste', () => {
  appState.recipes = [];
  renderRecipes();
  const html = recipesHtml();
  const toolbar = html.match(/<div class="recipe-toolbar">[\s\S]*?<\/div>/)[0];
  const buttons = [...toolbar.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.equal(buttons.length, 4, 'la toolbar ha esattamente 4 pulsanti');
  const labels = buttons.map(b => b[2].replace(/<[^>]*>/g, '').trim());
  assert.deepEqual(labels, ['Importa/Esporta', 'Invia a un utente', '+ Nuova', '🗑 Elimina tutte']);
  assert.match(buttons[0][1], /onclick="openTransferModal\(\)"/);
  assert.match(buttons[1][1], /onclick="openShareDialog\(\)"/);
  assert.match(buttons[2][1], /btn-primary/);
  assert.match(buttons[2][1], /onclick="createNewRecipe\(\)"/);
  assert.match(buttons[3][1], /btn-danger/);
  assert.match(buttons[3][1], /onclick="deleteAllRecipes\(\)"/);
  assert.doesNotMatch(html, /Invia tutte/, 'vecchia etichetta rimossa');
  assert.doesNotMatch(toolbar, /type="file"/, 'niente input file diretto in toolbar');
});

test('toolbar: Elimina tutte disabilitata a catalogo vuoto', () => {
  appState.recipes = [];
  renderRecipes();
  assert.match(recipesHtml(), /onclick="deleteAllRecipes\(\)" disabled/, 'disabilitata senza ricette');
  appState.recipes = [{ id: 'L1', name: 'Riso', slot: 'lunch', ingredients: [], steps: [], notes: [] }];
  renderRecipes();
  const toolbar = recipesHtml().match(/<div class="recipe-toolbar">[\s\S]*?<\/div>/)[0];
  assert.doesNotMatch(toolbar, /disabled/, 'abilitata con ricette');
  appState.recipes = [];
});

test('modale Importa/Esporta: input file JSON e azione di export', () => {
  elements.delete('recipe-import-modal');
  const origGet = doc.getElementById;
  doc.getElementById = id => (id === 'recipe-import-modal' && !elements.has(id) ? undefined : origGet(id));
  setupTransferModals();
  doc.getElementById = origGet;
  const bodyHtml = document.body.innerHTML;
  assert.match(bodyHtml, /id="recipe-transfer-modal"/, 'modale installata');
  const modal = bodyHtml.match(/<div id="recipe-transfer-modal"[\s\S]*$/)[0];
  assert.match(modal, /Importa o esporta/);
  assert.match(modal, /type="file" accept="application\/json,\.json"/, 'input file JSON');
  assert.match(modal, /prepareRecipeImport\(this\.files\[0\]\)/, 'import attivo');
  assert.match(modal, /exportAllRecipes\(\)/, 'export attivo');
  const modalEl = document.getElementById('recipe-transfer-modal');
  modalEl.classList.add('hidden');
  openTransferModal();
  assert.equal(modalEl.classList.contains('hidden'), false, 'apertura rimuove hidden');
  closeTransferModal();
  assert.equal(modalEl.classList.contains('hidden'), true, 'chiusura aggiunge hidden');
});

test('editor ricetta: etichetta "Pasto" per lo slot', () => {
  appState.saasPolicy = { mode: 'assigned', migrationRequired: false };
  currentModal = {
    recipe: {
      id: 'L1', slot: 'lunch', name: 'Test', emoji: '🍲',
      ingredients: [{ name: 'Pasta', portions: { single: '90 g' } }],
      steps: [], notes: []
    },
    original: null, dayKey: null, dayType: 'training', slot: null, planSlot: null, isNew: false
  };
  editMode = true;
  renderModalContent();
  const timeHtml = document.getElementById('modal-time').innerHTML;
  assert.match(timeHtml, /<label>Pasto<select id="edit-recipe-slot"/);
  assert.doesNotMatch(timeHtml, />Tipo</);
  currentModal = null;
  editMode = false;
});

test('toolbar responsive: griglia 4 desktop, 2x2 mobile', () => {
  assert.match(css, /\.recipe-toolbar \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.recipe-toolbar \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.recipe-toolbar \.btn \{ width: 100%;/);
});
