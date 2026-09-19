'use strict';
/* Passo 2 — dosi allineate alla dieta assegnata (Settimana, Spesa, Batch):
 *  - la dose del cliente cambia fra Allenamento e Riposo (struttura a blocchi);
 *  - senza struttura assegnata nessuna dose si allinea;
 *  - profilo non confermato (pending-confirmation) → quantità originali;
 *  - spesa e batch cooking seguono lo stesso interruttore del piano;
 *  - le ricette originali non vengono mai riscritte. */
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
global.document = doc;
global.window = global;
global.location = { hash: '#settimana', reload: () => {} };
Object.defineProperty(global, 'navigator', { value: { onLine: true, serviceWorker: { register: async () => {}, addEventListener: () => {} } }, configurable: true, writable: true });
global.addEventListener = () => {};
global.removeEventListener = () => {};
global.requestAnimationFrame = fn => fn();
global.MANIFEST_PLACEHOLDER = '{}';
global.matchMedia = () => ({ matches: false, addEventListener: () => {} });
global.confirm = () => true;
global.alert = () => {};

const store = {};
global.localStorage = {
  getItem: key => (key in store ? store[key] : null),
  setItem: (key, value) => { store[key] = String(value); },
  removeItem: key => { delete store[key]; }
};
const dbStub = {
  collection: () => ({ doc: () => ({}), where: () => ({ get: async () => ({ docs: [] }) }), get: async () => ({ docs: [] }) }),
  doc: () => ({ get: async () => ({ exists: false }), set: async () => {}, onSnapshot: () => () => {} }),
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

// Struttura dieta assegnata (profilo v3, blocchi famiglia): il pranzo
// prevede 80g di cereali nelle giornate di allenamento e 60g in quelle di
// riposo. La ricetta originale del cliente ha 200g di pasta.
const CLIENT_CATALOG = {
  catalogVersion: 1,
  categories: [{ categoryId: 'carb', displayName: 'Carboidrati', sortOrder: 0 }],
  families: [{ familyId: 'cereali', displayName: 'Cereali', categoryId: 'carb', sortOrder: 0 }],
  ingredients: [
    { ingredientId: 'pasta-di-semola', displayName: 'Pasta di semola', aliases: ['pasta'], categoryId: 'carb', familyId: 'cereali', dietaryFlags: { vegetarian: true, vegan: true }, status: 'active' },
    { ingredientId: 'riso', displayName: 'Riso', aliases: [], categoryId: 'carb', familyId: 'cereali', dietaryFlags: { vegetarian: true, vegan: true }, status: 'active' }
  ]
};
const CLIENT_DIET_PLAN = () => PianoDomain.createEmptyDietPlan({ days: [
  PianoDomain.createDietPlanDay('training', { dayId: 'allenamento', meals: [
    PianoDomain.createDietPlanMeal('lunch', { options: [
      PianoDomain.createDietPlanOption({ type: 'family-block', blocks: [
        PianoDomain.createDietPlanBlock({ referenceFamilyId: 'cereali', referenceIngredientId: 'riso', referenceAmount: { value: 80, unit: 'g' } })
      ] })
    ] })
  ] }),
  PianoDomain.createDietPlanDay('rest', { dayId: 'riposo', meals: [
    PianoDomain.createDietPlanMeal('lunch', { options: [
      PianoDomain.createDietPlanOption({ type: 'family-block', blocks: [
        PianoDomain.createDietPlanBlock({ referenceFamilyId: 'cereali', referenceIngredientId: 'riso', referenceAmount: { value: 60, unit: 'g' } })
      ] })
    ] })
  ] })
] });
const CLIENT_PROFILE = () => ({
  schemaVersion: 3,
  clientProfileId: 'cp1',
  assignmentId: 'a1',
  structureId: 's1',
  structureRevisionId: 'rev1',
  structureChecksum: 'chk-1',
  structureName: 'Struttura del nutrizionista',
  ingredientCatalogVersion: 1,
  effectiveAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null,
  structureRevision: { revisionId: 'rev1', dietPlan: CLIENT_DIET_PLAN() },
  catalog: JSON.parse(JSON.stringify(CLIENT_CATALOG)),
  compatibleClientSchema: 7
});
const RECIPE = {
  id: 'L1', slot: 'lunch', name: 'Pasta al pomodoro', emoji: '🍝',
  ingredients: [{ name: 'Pasta di semola', portions: { single: '200g' } }],
  steps: []
};

function scenario({ dayType = 'training', aligned = true, policyMode = 'assigned', profile = true } = {}) {
  appState.household = null;
  appState.saasContext = profile ? { state: 'assigned', profile: CLIENT_PROFILE() } : { state: 'unassigned' };
  appState.saasPolicy = { mode: policyMode, migrationRequired: policyMode !== 'assigned' };
  invalidateDietEngine();
  setRecipes([RECIPE]);
  appState.plan = PianoDomain.migratePlan(createEmptyWeeklyPlan());
  appState.plan = PianoDomain.setPlanAlignedDosesEnabled(appState.plan, aligned);
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
  const entry = aggregateShoppingList().find(item => item.ingredientId === 'pasta-di-semola');
  return entry ? entry.totals.g : null;
}

test('settimana: la dose del cliente cambia fra Allenamento e Riposo', () => {
  scenario({ dayType: 'training' });
  assert.match(weekMarkup(), /Pasta di semola 80g/, 'giornata Allenamento: dose della struttura');
  assert.doesNotMatch(weekMarkup(), /Pasta di semola 60g/);

  scenario({ dayType: 'rest' });
  assert.match(weekMarkup(), /Pasta di semola 60g/, 'giornata Riposo: dose della struttura');
  assert.doesNotMatch(weekMarkup(), /Pasta di semola 80g/);
});

test('settimana: interruttore spento → nessuna dose allineata, ricetta visibile', () => {
  scenario({ dayType: 'training', aligned: false });
  assert.doesNotMatch(weekMarkup(), /week-meal-doses/, 'interruttore spento: restano le quantità originali');
  assert.match(weekMarkup(), /Pasta al pomodoro/, 'la ricetta resta visibile');
});

test('settimana: senza struttura assegnata nessuna dose si allinea', () => {
  scenario({ dayType: 'training', profile: false });
  assert.doesNotMatch(weekMarkup(), /week-meal-doses/, 'nessuna dieta, nessun allineamento');
});

test('settimana: profilo non confermato resta sulle quantità originali', () => {
  scenario({ dayType: 'rest', aligned: true, policyMode: 'pending-confirmation' });
  assert.doesNotMatch(weekMarkup(), /week-meal-doses/, 'allineamento bloccato finché il cliente non conferma');
  assert.equal(shoppingTotals(), 200, 'spesa con la quantità originale della ricetta');
});

test('spesa: interruttore acceso → dosi della struttura; spento → dosi originali', () => {
  scenario({ dayType: 'rest', aligned: true });
  assert.equal(shoppingTotals(), 60, 'spesa allineata alla giornata Riposo');
  scenario({ dayType: 'training', aligned: true });
  assert.equal(shoppingTotals(), 80, 'spesa allineata alla giornata Allenamento');
  scenario({ dayType: 'training', aligned: false });
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
  plan.alignedDosesEnabled = true;
  appState.saasContext = { state: 'assigned', profile: CLIENT_PROFILE() };
  appState.saasPolicy = { mode: 'assigned' };
  // Il resolver legge lo stato dell'app: piano attivo e cache motore coerenti.
  appState.plan = plan;
  invalidateDietEngine();
  const recipes = { L1: RECIPE };
  // La quantità del task segue il pranzo target (martedì, allenamento): 80g
  // della struttura invece dei 200g originali.
  const on = PianoDomain.activeBatch('monday', plan, templates, recipes, 'single', { resolveRecipe: shoppingResolveRecipe });
  assert.equal(on[0].tasks[0].quantity, '80g', 'batch con le dosi allineate della struttura');
  // Interruttore spento: il resolver restituisce null → dose originale
  const off = PianoDomain.activeBatch('monday', plan, templates, recipes, 'single', { resolveRecipe: () => null });
  assert.equal(off[0].tasks[0].quantity, '200g', 'batch con la quantità originale');
  // Le ricette restano intatte
  assert.equal(RECIPE.ingredients[0].portions.single, '200g');
});
