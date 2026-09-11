'use strict';
/* Passo 2 (livello app) — Riposo/Allenamento effettivi e editor numero+unità:
 *  - resolvePlannedRecipe usa il tipo giorno del piano (90 g / 70 g);
 *  - changeDayType persiste e ri-renderizza;
 *  - editor: controlli numero+unità, q.b. senza numero, originali verbatim. */
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
    hidden: false,
    focused: false,
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
  addEventListener: () => {},
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
    FieldValue: { serverTimestamp: () => ({}), arrayUnion: (...v) => v, arrayRemove: (...v) => v }
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
  portionProfile: 'man', darkMode: false, lastOpenDate: null,
  recipeLibraryState: { searchQuery: '', openSections: {} }, shopCategoryOrder: []
};
appState.household = null;
appState.saasContext = { state: 'unassigned' };
appState.saasPolicy = { mode: 'assigned', migrationRequired: false };

const PASTA = {
  id: 'L1', slot: 'lunch', name: 'Pasta', emoji: '🍝',
  ingredients: [{ name: 'Pasta di semola', portions: { man: '90 g', ipo: '70 g' } }],
  steps: [], notes: [], specialNote: ''
};

function setupPlan() {
  setRecipes([JSON.parse(JSON.stringify(PASTA))]);
  appState.plan = PianoDomain.migratePlan(createEmptyWeeklyPlan());
  appState.plan.days.monday.type = 'training';
  appState.plan.days.monday.lunch = 'L1';
  appState.plan = PianoDomain.setAdaptedQuantitiesEnabled(appState.plan, true);
  appState.saasPolicy = { mode: 'assigned', migrationRequired: false };
}

// ---- Riposo/Allenamento ----

test('resolvePlannedRecipe: dosi distinte tra allenamento e riposo', () => {
  setupPlan();
  const training = resolvePlannedRecipe(getRecipe('L1'), 'monday', 'lunch');
  assert.equal(training.applied, true);
  assert.equal(training.recipe.ingredients[0].portions.man, '90 g');
  appState.plan.days.monday.type = 'rest';
  const rest = resolvePlannedRecipe(getRecipe('L1'), 'monday', 'lunch');
  assert.equal(rest.applied, true);
  assert.equal(rest.recipe.ingredients[0].portions.man, '70 g');
});

test('changeDayType: persiste il tipo giorno e ri-renderizza la settimana', async () => {
  setupPlan();
  const calls = [];
  const previous = global.saveWeeklyPlan;
  global.saveWeeklyPlan = async plan => { calls.push(plan.days.monday.type); };
  try {
    await changeDayType('monday', 'rest');
    assert.equal(appState.plan.days.monday.type, 'rest');
    assert.deepEqual(calls, ['rest'], 'tipo giorno persistito');
    assert.match(document.getElementById('view-week').innerHTML, /Piano settimanale/, 'settimana ri-renderizzata');
  } finally {
    global.saveWeeklyPlan = previous;
  }
});

// ---- Editor numero+unità ----

test('quantityEditorState: precompila solo i valori rappresentabili', () => {
  assert.deepEqual(quantityEditorState('60 g'), { num: '60', unit: 'g', qb: false });
  assert.deepEqual(quantityEditorState('60g'), { num: '60', unit: 'g', qb: false });
  assert.deepEqual(quantityEditorState('1,5 g'), { num: '1.5', unit: 'g', qb: false });
  assert.deepEqual(quantityEditorState('2 pz'), { num: '2', unit: 'pz', qb: false });
  assert.deepEqual(quantityEditorState('1 cucchiaio'), { num: '1', unit: 'cucchiaio', qb: false });
  assert.deepEqual(quantityEditorState('q.b.'), { num: '', unit: 'q.b.', qb: true });
  assert.deepEqual(quantityEditorState('—'), { num: '', unit: 'g', qb: false });
  // Non rappresentabili: segnaposto, mai grammi attribuiti.
  assert.deepEqual(quantityEditorState('2'), { num: '2', unit: '', qb: false });
  assert.deepEqual(quantityEditorState('8-10 g'), { num: '', unit: '', qb: false });
  assert.deepEqual(quantityEditorState('1 mazzetto'), { num: '', unit: '', qb: false });
});

test('quantityEditorField: markup accessibile numero+unità', () => {
  const grams = quantityEditorField('edit-ing-man-0', 'Quantità · Uomo', '60 g');
  assert.match(grams, /type="number"/);
  assert.match(grams, /value="60"/);
  assert.match(grams, /id="edit-ing-man-0-unit"/);
  assert.match(grams, /<option value="g" selected>/);
  assert.match(grams, /aria-label="Quantità · Uomo: unità di misura"/);
  const naked = quantityEditorField('edit-ing-man-1', 'Quantità · Uomo', '2');
  assert.match(naked, /<option value="" selected disabled>—<\/option>/, 'segnaposto senza unità attribuita');
  const free = quantityEditorField('edit-ing-man-2', 'Quantità · Uomo', 'q.b.');
  assert.match(free, /disabled hidden/, 'numero nascosto e disabilitato con q.b.');
  assert.match(free, /<option value="q\.b\." selected>/);
});

test('onQuantityUnitChange: q.b. nasconde il numero, le unità lo ripristinano', () => {
  const num = document.getElementById('qty-num-test');
  const unit = document.getElementById('qty-num-test-unit');
  num.value = '60';
  unit.value = 'q.b.';
  onQuantityUnitChange('qty-num-test');
  assert.equal(num.disabled, true);
  assert.equal(num.hidden, true);
  assert.equal(num.value, '', 'numero svuotato: con q.b. non serve');
  unit.value = 'g';
  onQuantityUnitChange('qty-num-test');
  assert.equal(num.disabled, false);
  assert.equal(num.hidden, false);
  assert.equal(num.focused, true, 'focus sul numero da compilare');
});

test('readQuantityInput: riga intatta → originale verbatim', () => {
  const num = document.getElementById('qty-ro-test');
  const unit = document.getElementById('qty-ro-test-unit');
  const check = (value, unitValue, original) => {
    num.value = value;
    num.dataset.num = value;
    unit.value = unitValue;
    num.dataset.unit = unitValue;
    assert.equal(readQuantityInput('qty-ro-test', original), original, `verbatim: "${original}"`);
  };
  check('60', 'g', '60 g');
  check('60', 'g', '60g');
  check('2', '', '2');
  check('', '', '1 mazzetto');
  check('', '', '8-10 g');
  check('', 'q.b.', 'q.b.');
  check('', 'g', '—');
});

test('readQuantityInput: riga modificata → stringa canonica', () => {
  const num = document.getElementById('qty-rw-test');
  const unit = document.getElementById('qty-rw-test-unit');
  num.dataset.num = '60';
  num.dataset.unit = 'g';
  // Nuovo numero, stessa unità.
  num.value = '80';
  unit.value = 'g';
  assert.equal(readQuantityInput('qty-rw-test', '60 g'), '80 g');
  // Nuova unità su riga esistente.
  num.value = '2';
  unit.value = 'pz';
  assert.equal(readQuantityInput('qty-rw-test', '60 g'), '2 pz');
  // Passaggio a q.b.
  num.value = '';
  unit.value = 'q.b.';
  assert.equal(readQuantityInput('qty-rw-test', '60 g'), 'q.b.');
  // Svuotamento → dose assente.
  num.dataset.num = '2';
  num.dataset.unit = 'pz';
  num.value = '';
  unit.value = 'pz';
  assert.equal(readQuantityInput('qty-rw-test', '2 pz'), '—');
  // Decimale con punto (formato dell'input numerico).
  num.value = '1.5';
  unit.value = 'g';
  assert.equal(readQuantityInput('qty-rw-test', '2 pz'), '1.5 g');
});
