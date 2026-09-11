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
  portionProfile: 'man', darkMode: false, lastOpenDate: null,
  recipeLibraryState: { searchQuery: '', openSections: {} }, shopCategoryOrder: []
};
appState.household = null;

const FREQ = { legumes: { min: 2, max: 4 } };
function assignedWithFreq() {
  appState.household = null;
  appState.saasContext = { state: 'assigned', profile: { clientOverrides: { revision: 1, doses: {}, frequencies: FREQ } } };
  appState.saasPolicy = { mode: 'assigned', migrationRequired: false };
  appState.plan = PianoDomain.migratePlan(createEmptyWeeklyPlan());
  appState.plan = PianoDomain.setAdaptedQuantitiesEnabled(appState.plan, true);
}

// ---- Vincoli frequenze ----

test('saasGeneratorConstraints: profilo confermato e personale → frequenze profilo', () => {
  assignedWithFreq();
  const constraints = saasGeneratorConstraints();
  assert.equal(constraints.legumesMin, 2);
  assert.equal(constraints.legumesMax, 4);
  assert.equal(constraints.poultryMin, 1, 'default per le altre famiglie');
});

test('saasGeneratorConstraints: household, pending e assenza → null', () => {
  assignedWithFreq();
  appState.household = { id: 'h1' };
  assert.equal(saasGeneratorConstraints(), null, 'household: frequenze standard');
  appState.household = null;
  appState.saasPolicy = { mode: 'pending-confirmation', migrationRequired: true };
  assert.equal(saasGeneratorConstraints(), null, 'non confermato: frequenze standard');
  appState.saasPolicy = { mode: 'assigned', migrationRequired: false };
  appState.saasContext = { state: 'assigned', profile: {} };
  assert.equal(saasGeneratorConstraints(), null, 'senza override: preferenze dispositivo');
});

test('computeGeneratorProposal: usa le frequenze profilo e mostra la nota', () => {
  assignedWithFreq();
  setRecipes([]);
  appState.deviceSettings.generatorPrefs = null;
  generatorState.seed = 7;
  const previous = PianoDomain.generateWeek;
  let captured = null;
  PianoDomain.generateWeek = (catalog, options) => { captured = options.constraints; return previous(catalog, options); };
  try {
    computeGeneratorProposal(false);
    assert.equal(captured.legumesMin, 2, 'generatore guidato dal profilo');
    assert.match(document.getElementById('generator-preview').innerHTML, /Frequenze del tuo profilo professionale/);
  } finally {
    PianoDomain.generateWeek = previous;
  }
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

test('dosi override nel motore: settimana e spesa usano la dose cliente', () => {
  const snapshot = {
    grammature: [...PianoDomain.MELLER_GRAMMATURE],
    carbs: [...PianoDomain.CARB_REFERENCE],
    alternatives: { ...PianoDomain.MELLER_ALTERNATIVES },
    constraints: { ...PianoDomain.DEFAULT_CONSTRAINTS },
    guide: { ...PianoDomain.MELLER_GUIDE }
  };
  try {
    assignedWithFreq();
    // Simula il profilo servito: regole studio + override cliente fusi.
    const engine = PianoSaas.engineRulesFor({
      schemaVersion: 1,
      rules: [{
        family: 'pasta', group: 'carb', label: 'Pasta', aliases: ['pasta', 'pasta di semola'],
        slots: { lunch: { training: 90, rest: 70 }, dinner: { training: 40, rest: 40 } }
      }],
      freeAliases: [],
      clientOverrides: { revision: 1, doses: { pasta: { lunch: { training: 120 } } }, frequencies: {} }
    });
    assert.equal(PianoDomain.activateMellerRuleSet(engine.rules, engine.freeAliases), true);
    const recipe = {
      id: 'L1', slot: 'lunch', name: 'Pasta', emoji: '🍝',
      ingredients: [{ name: 'Pasta di semola', portions: { man: '120 g', ipo: '120 g' } }]
    };
    setRecipes([recipe]);
    appState.plan.days.monday.type = 'training';
    appState.plan.days.monday.lunch = 'L1';
    const resolved = resolvePlannedRecipe(getRecipe('L1'), 'monday', 'lunch');
    assert.equal(resolved.recipe.ingredients[0].portions.man, '120 g', 'settimana con dose cliente');
    const list = PianoDomain.aggregateShopping(
      appState.plan, { L1: getRecipe('L1') }, { monday: ['lunch'] }, 'man'
    );
    const pasta = list.find(entry => entry.ingredientId === PianoDomain.ingredientIdFor('Pasta di semola'));
    assert.equal(pasta.totals.g, 120, 'spesa unica riflette la dose cliente');
  } finally {
    PianoDomain.MELLER_GRAMMATURE.splice(0, PianoDomain.MELLER_GRAMMATURE.length, ...snapshot.grammature);
    PianoDomain.CARB_REFERENCE.splice(0, PianoDomain.CARB_REFERENCE.length, ...snapshot.carbs);
    Object.keys(PianoDomain.MELLER_ALTERNATIVES).forEach(key => delete PianoDomain.MELLER_ALTERNATIVES[key]);
    Object.assign(PianoDomain.MELLER_ALTERNATIVES, snapshot.alternatives);
    Object.assign(PianoDomain.DEFAULT_CONSTRAINTS, snapshot.constraints);
    Object.assign(PianoDomain.MELLER_GUIDE, snapshot.guide);
  }
});

test('interazione: switch adattate OFF → originali anche con profilo assegnato', () => {
  assignedWithFreq();
  appState.plan = PianoDomain.setAdaptedQuantitiesEnabled(appState.plan, false);
  const recipe = {
    id: 'L1', slot: 'lunch', name: 'Pasta', emoji: '🍝',
    ingredients: [{ name: 'Pasta di semola', portions: { man: '200 g', ipo: '200 g' } }]
  };
  setRecipes([recipe]);
  appState.plan.days.monday.type = 'training';
  appState.plan.days.monday.lunch = 'L1';
  const resolved = resolvePlannedRecipe(getRecipe('L1'), 'monday', 'lunch');
  assert.equal(resolved.mode, 'original');
  assert.equal(resolved.recipe.ingredients[0].portions.man, '200 g');
});
