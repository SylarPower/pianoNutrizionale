'use strict';
/* Passo 4 (integrazione app) — frequenze professionali nel generatore e dosi
 * override fino a settimana e spesa:
 *  - saasGeneratorConstraints solo con assegnazione confermata e personale;
 *  - computeGeneratorProposal usa le frequenze del profilo + nota in UI;
 *  - dosi override attivate nel motore: settimana e spesa coerenti. */
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

// Struttura dieta assegnata (profilo v3, blocco cereali 80g a pranzo).
const ASSIGNED_CATALOG = {
  catalogVersion: 1,
  categories: [{ categoryId: 'carb', displayName: 'Carboidrati', sortOrder: 0 }],
  families: [{ familyId: 'cereali', displayName: 'Cereali', categoryId: 'carb', sortOrder: 0 }],
  ingredients: [
    { ingredientId: 'pasta-di-semola', displayName: 'Pasta di semola', aliases: ['pasta'], categoryId: 'carb', familyId: 'cereali', dietaryFlags: { vegetarian: true, vegan: true }, status: 'active' },
    { ingredientId: 'riso', displayName: 'Riso', aliases: [], categoryId: 'carb', familyId: 'cereali', dietaryFlags: { vegetarian: true, vegan: true }, status: 'active' }
  ]
};
function assignedStructure(extraMealValue = 80) {
  return {
    schemaVersion: 1, clientProfileId: 'cp1', assignmentId: 'a1',
    structureId: 's1', structureRevisionId: 'rev1', structureChecksum: 'chk',
    structureName: 'Base', ingredientCatalogVersion: 1,
    effectiveAt: '2026-01-01T00:00:00.000Z', expiresAt: null,
    structureRevision: { revisionId: 'rev1', dietPlan: PianoDomain.createEmptyDietPlan({ days: [
      PianoDomain.createDietPlanDay('training', { dayId: 't', meals: [
        PianoDomain.createDietPlanMeal('lunch', { options: [
          PianoDomain.createDietPlanOption({ type: 'family-block', blocks: [
            PianoDomain.createDietPlanBlock({ referenceFamilyId: 'cereali', referenceIngredientId: 'riso', referenceAmount: { value: extraMealValue, unit: 'g' } })
          ] })
        ] })
      ] })
    ] }) },
    catalog: JSON.parse(JSON.stringify(ASSIGNED_CATALOG)),
    compatibleClientSchema: 7
  };
}
function assignedWithStructure() {
  appState.household = null;
  appState.saasContext = { state: 'assigned', profile: assignedStructure() };
  appState.saasPolicy = { mode: 'assigned', migrationRequired: false };
  appState.plan = PianoDomain.migratePlan(createEmptyWeeklyPlan());
  appState.plan = PianoDomain.setPlanAlignedDosesEnabled(appState.plan, true);
  invalidateDietEngine();
}

// ---- Generatore: solo preferenze strutturali, mai frequenze cliniche ----

test('generatore: nessun vincolo di frequenza dal profilo assegnato', () => {
  assignedWithStructure();
  setRecipes([]);
  appState.deviceSettings.generatorPrefs = null;
  generatorState.seed = 7;
  const previous = PianoDomain.generateWeek;
  let captured = null;
  PianoDomain.generateWeek = (catalog, options) => { captured = options; return previous(catalog, options); };
  try {
    computeGeneratorProposal(false);
    assert.equal(captured.constraints, undefined, 'il generatore non riceve vincoli di frequenza');
    assert.ok(captured.batchPairs !== undefined && captured.slots !== undefined && captured.maxRepeats !== undefined, 'solo opzioni strutturali');
  } finally {
    PianoDomain.generateWeek = previous;
  }
});

test('generatore: household, pending e assenza restano sul comportamento standard', () => {
  assignedWithStructure();
  appState.household = { id: 'h1' };
  appState.saasContext = { state: 'unassigned' };
  appState.saasPolicy = { mode: 'original-only', migrationRequired: false };
  setRecipes([]);
  appState.deviceSettings.generatorPrefs = null;
  generatorState.seed = 7;
  computeGeneratorProposal(false);
  assert.ok(document.getElementById('generator-preview').innerHTML.length > 0, 'anteprima generata con le preferenze dispositivo');
});

test('computeGeneratorProposal: senza profilo usa le preferenze dispositivo', () => {
  appState.household = null;
  appState.saasContext = { state: 'unassigned' };
  appState.saasPolicy = { mode: 'original-only', migrationRequired: false };
  appState.plan = PianoDomain.migratePlan(createEmptyWeeklyPlan());
  setRecipes([]);
  appState.deviceSettings.generatorPrefs = null;
  generatorState.seed = 7;
  computeGeneratorProposal(false);
  assert.doesNotMatch(document.getElementById('generator-preview').innerHTML, /Frequenze del tuo profilo professionale/);
});

// ---- Dosi override fino a settimana e spesa ----

test('dosi della struttura: settimana e spesa seguono la dieta assegnata', () => {
  assignedWithStructure();
  const recipe = {
    id: 'L1', slot: 'lunch', name: 'Pasta', emoji: '🍝',
    ingredients: [{ name: 'Pasta di semola', ingredientId: 'pasta-di-semola', portions: { single: '120 g' } }],
    steps: [], notes: []
  };
  setRecipes([recipe]);
  appState.plan.days.monday.type = 'training';
  appState.plan.days.monday.lunch = 'L1';
  const resolved = resolvePlannedRecipe(getRecipe('L1'), 'monday', 'lunch');
  assert.equal(resolved.aligned, true);
  assert.equal(resolved.recipe.ingredients[0].portions.single, '80g', 'settimana con la dose della struttura');
  const list = PianoDomain.aggregateShopping(
    appState.plan, { L1: getRecipe('L1') }, { monday: ['lunch'] }, 'single',
    {}, { resolveRecipe: shoppingResolveRecipe }
  );
  const pasta = list.find(entry => entry.ingredientId === 'pasta-di-semola');
  assert.equal(pasta.totals.g, 80, 'spesa unica riflette la dose della struttura');
});

test('interazione: switch dosi allineate OFF → originali anche con profilo assegnato', () => {
  assignedWithStructure();
  appState.plan = PianoDomain.setPlanAlignedDosesEnabled(appState.plan, false);
  const recipe = {
    id: 'L1', slot: 'lunch', name: 'Pasta', emoji: '🍝',
    ingredients: [{ name: 'Pasta di semola', ingredientId: 'pasta-di-semola', portions: { single: '200 g' } }],
    steps: [], notes: []
  };
  setRecipes([recipe]);
  appState.plan.days.monday.type = 'training';
  appState.plan.days.monday.lunch = 'L1';
  const resolved = resolvePlannedRecipe(getRecipe('L1'), 'monday', 'lunch');
  assert.equal(resolved.aligned, false);
  assert.equal(resolved.recipe.ingredients[0].portions.single, '200 g');
});
