'use strict';
/* Dosi delle linee guida nella vista Settimana e nei dati derivati:
 *  - con una Struttura dieta assegnata le quantità del pasto seguono le dosi
 *    del cliente e cambiano fra giornata Allenamento e giornata Riposo;
 *  - l'interruttore "Quantità adattate alle linee guida" governa anche spesa e
 *    batch cooking: spento, si tornano a vedere le quantità originali;
 *  - con un profilo SaaS non ancora confermato (policy non "assigned") la vista
 *    resta comunque sulle quantità originali, come già per settimana e modale.
 * Il motore viene attivato con le stesse regole che il server converte da una
 * revisione di struttura (functions/src/domain.js → js/domain.js). */
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
  portionProfile: 'single', darkMode: false, lastOpenDate: null,
  recipeLibraryState: { searchQuery: '', openSections: {} }, shopCategoryOrder: []
};
appState.household = null;

// Struttura dieta del cliente: dosi diverse fra Allenamento e Riposo.
const STRUCTURE = [
  { family: 'pasta', group: 'carb', label: 'Pasta', aliases: ['pasta', 'pasta di semola'], slots: { lunch: { training: 120, rest: 80 }, dinner: { training: 60, rest: 60 } } }
];
const RECIPE = {
  id: 'L1', slot: 'lunch', name: 'Pasta al pomodoro', emoji: '🍝',
  ingredients: [{ name: 'Pasta di semola', portions: { single: '200 g' } }],
  steps: []
};

function scenario({ dayType = 'training', adapted = true, policyMode = 'assigned', profile = true } = {}) {
  appState.household = null;
  appState.saasContext = profile
    ? { state: 'assigned', profile: { clientProfileId: 'c1', assignmentId: 'a1', structureId: 's1', structureRevisionId: '1' } }
    : { state: 'unassigned' };
  appState.saasPolicy = { mode: policyMode, migrationRequired: policyMode !== 'assigned' };
  assert.equal(PianoDomain.activateGuideRuleSet(STRUCTURE, []), true, 'motore con le regole del cliente');
  setRecipes([RECIPE]);
  appState.plan = PianoDomain.migratePlan(createEmptyWeeklyPlan());
  appState.plan = PianoDomain.setAdaptedQuantitiesEnabled(appState.plan, adapted);
  appState.plan.days.monday.type = dayType;
  appState.plan.days.monday.lunch = 'L1';
  appState.shopping = {
    selectedMeals: { monday: ['lunch'] },
    excludeDinners: false, excludedItems: [], customQuantities: {}, itemOrder: {}
  };
  renderWeek();
}

function weekMarkup() { return document.getElementById('view-week').innerHTML; }
function shoppingTotals() {
  const entry = aggregateShoppingList().find(item => item.ingredientId === PianoDomain.ingredientIdFor('Pasta di semola'));
  return entry ? entry.totals.g : null;
}

test('settimana: la dose del cliente cambia fra Allenamento e Riposo', () => {
  scenario({ dayType: 'training' });
  assert.match(weekMarkup(), /Pasta di semola 120 g/, 'giornata Allenamento: dose allenamento');
  assert.doesNotMatch(weekMarkup(), /Pasta di semola 80 g/);

  scenario({ dayType: 'rest' });
  assert.match(weekMarkup(), /Pasta di semola 80 g/, 'giornata Riposo: dose riposo');
  assert.doesNotMatch(weekMarkup(), /Pasta di semola 120 g/);
});

test('settimana: senza struttura assegnata nessuna dose di linee guida', () => {
  scenario({ dayType: 'training', adapted: false });
  assert.doesNotMatch(weekMarkup(), /week-meal-doses/, 'interruttore spento: restano le quantità originali');
  assert.match(weekMarkup(), /Pasta al pomodoro/, 'la ricetta resta visibile');
});

test('settimana: profilo non confermato resta sulle quantità originali', () => {
  scenario({ dayType: 'rest', adapted: true, policyMode: 'pending-confirmation' });
  assert.doesNotMatch(weekMarkup(), /week-meal-doses/, 'adattamento bloccato finché il cliente non conferma');
  assert.equal(shoppingTotals(), 200, 'spesa con la quantità originale della ricetta');
});

test('spesa: interruttore acceso → dosi del cliente; spento → dosi originali', () => {
  scenario({ dayType: 'rest', adapted: true });
  assert.equal(shoppingTotals(), 80, 'spesa allineata alla giornata Riposo');
  scenario({ dayType: 'training', adapted: true });
  assert.equal(shoppingTotals(), 120, 'spesa allineata alla giornata Allenamento');
  scenario({ dayType: 'training', adapted: false });
  assert.equal(shoppingTotals(), 200, 'interruttore spento: quantità originali');
});

test('batch cooking: le quantità seguono lo stesso interruttore', () => {
  const templates = [{
    id: 'batch-p1',
    anchor: { slot: 'dinner', recipeId: 'L1' },
    target: { slot: 'lunch', recipeId: 'L1', lookAheadDays: 2 },
    tasks: [{ id: 'pasta', label: 'Cuoci la pasta', storage: { maxDays: 1 }, quantitySource: { recipeId: 'L1', ingredientId: 'pasta-di-semola' } }]
  }];
  const days = {};
  PianoDomain.DAYS.forEach(day => {
    days[day] = { type: 'training', breakfast: null, snack1: null, lunch: null, snack2: null, dinner: null };
  });
  days.monday.dinner = 'L1';
  days.tuesday.lunch = 'L1';
  const plan = PianoDomain.migratePlan({ days, defaultDays: JSON.parse(JSON.stringify(days)), batchRules: {}, batchTemplates: templates });
  plan.batchTemplates = templates;
  PianoDomain.activateGuideRuleSet(STRUCTURE, []);
  const recipes = { L1: RECIPE };
  const on = PianoDomain.activeBatch('monday', plan, templates, recipes, 'single', { applyGuide: true });
  assert.equal(on[0].tasks[0].quantity, '120 g', 'batch con dosi del cliente');
  const off = PianoDomain.activeBatch('monday', plan, templates, recipes, 'single', { applyGuide: false });
  assert.equal(off[0].tasks[0].quantity, '200 g', 'batch con quantità originali');
});
