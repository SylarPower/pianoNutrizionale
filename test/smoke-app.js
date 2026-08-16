'use strict';
/* Smoke test: carica gli script come classic scripts con stub DOM minimi ed
 * esegue i principali percorsi di rendering per scovare errori a runtime.
 * Non fa parte di `npm test`: si esegue con `node test/smoke-app.js`. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

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

const localStorage = {
  _data: {},
  getItem: key => (key in localStorage._data ? localStorage._data[key] : null),
  setItem: (key, value) => { localStorage._data[key] = String(value); },
  removeItem: key => { delete localStorage._data[key]; }
};

const dbStub = {
  collection: () => dbStub,
  doc: () => dbStub,
  where: () => dbStub,
  limit: () => dbStub,
  get: async () => ({ exists: false, forEach: () => {}, data: () => ({}) }),
  set: async () => {},
  delete: async () => {},
  batch: () => ({ set: () => {}, delete: () => {}, commit: async () => {} }),
  runTransaction: async fn => fn({ get: async () => ({ exists: false, data: () => ({}) }), set: () => {}, delete: () => {} })
};

global.window = global;
global.document = doc;
global.localStorage = localStorage;
Object.defineProperty(global, 'navigator', { value: {}, configurable: true, writable: true });
global.firebase = {
  apps: [],
  initializeApp: () => {},
  appCheck: () => ({ activate: () => {} }),
  firestore: () => dbStub,
  auth: () => ({
    setPersistence: async () => {},
    signInWithEmailAndPassword: async () => ({}),
    signOut: async () => {},
    onAuthStateChanged: () => {}
  }),
  firestore: { FieldValue: { serverTimestamp: () => ({}) } }
};

for (const file of ['js/domain.js', 'js/data.js', 'js/firebase.js', 'js/app.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
}

// ---- Set up stato applicativo finto ----
const R = (id, name, slot, cat) => ({
  id, name, slot, proteinCategory: cat, emoji: '🍲', frequency: '',
  ingredients: [
    { name: 'Riso venere', ingredientId: 'riso-venere', portions: { ipoTraining: '60g', ipoRest: '50g', manTraining: '90g', manRest: '70g' } },
    { name: 'Uova intere', ingredientId: 'whole-eggs', portions: { ipoTraining: '2', ipoRest: '2', manTraining: '2', manRest: '2' } }
  ],
  steps: ['Passo uno'], notes: ['Nota uno'], specialNote: ''
});
const recipes = [
  R('L1', 'Riso e uova', 'lunch', 'Legumi'),
  R('L2', 'Pollo', 'lunch', 'Pollame'),
  R('D1', 'Salmone', 'dinner', 'Pesce omega-3'),
  R('B1', 'Avena', 'breakfast', ''),
  R('S1', 'Frutta', 'snack1', ''),
  R('M1', 'Yogurt', 'snack2', '')
];
const samePortion = value => ({ ipoTraining: value, ipoRest: value, manTraining: value, manRest: value });
recipes.find(item => item.id === 'L1').ingredients.push({ name: 'Basilico', ingredientId: 'basilico', portions: samePortion('1') });
recipes.find(item => item.id === 'D1').ingredients.push({ name: 'Basilico', ingredientId: 'basilico', portions: samePortion('un mazzetto') });
const days = {};
window.PianoDomain.DAYS.forEach(day => {
  days[day] = { type: ['monday', 'wednesday', 'friday', 'sunday'].includes(day) ? 'training' : 'rest', breakfast: 'B1', snack1: 'S1', lunch: 'L1', snack2: 'M1', dinner: 'D1' };
});
const plan = {
  schemaVersion: 4,
  days,
  defaultDays: JSON.parse(JSON.stringify(days)),
  batchRules: {},
  batchTemplates: [{
    id: 'batch-x',
    anchor: { slot: 'dinner', recipeId: 'D1' },
    target: { slot: 'lunch', recipeId: 'L1', lookAheadDays: 3 },
    tasks: [{ id: 'cook-rice', label: 'Cuoci il riso', storage: { method: 'fridge', maxDays: 1 }, quantitySource: { recipeId: 'L1', ingredientId: 'riso-venere' } }]
  }]
};
appState.user = { uid: 'u1', email: 'mario@utenti.pianonutrizionale.app' };
setRecipes(recipes);
appState.plan = plan;
appState.shopping = {
  selectedMeals: Object.fromEntries(window.PianoDomain.DAYS.map(day => [day, ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner']])),
  includePantry: true, excludedItems: [], customQuantities: {}
};
appState.deviceSettings = { portionProfile: 'man', darkMode: false, chefSelectedDay: 'monday', lastOpenDate: null };

// ---- Percorsi di rendering ----
renderGlobalHeader();
renderChef();
renderWeek();
renderRecipes();
assert.match(document.getElementById('view-recipes').innerHTML, /recipe-section-toggle collapsed/);
assert.match(document.getElementById('view-recipes').innerHTML, /recipe-section-body hidden/);
renderShop();
shopSettingsVisible = true;
renderShop();
assert.match(document.getElementById('view-shop').innerHTML, /toggleShopDay\('monday'\)/);
assert.equal(shoppingAmountText({ id: 'opaque-a', legacyId: 'opaque-a', totals: { pz: 28 }, opaque: { 'Uomo: 8-10': 2, 'Donna IPO: 8-10': 1 }, free: false }), '28 pz');
assert.equal(shoppingAmountText({ id: 'opaque-b', legacyId: 'opaque-b', totals: {}, opaque: { 'Uomo: 1 mazzetto': 1, 'Donna IPO: 1 mazzetto': 1 }, free: false }), '2 mazzetti');
assert.equal(shoppingAmountText({ id: 'opaque-only', legacyId: 'opaque-only', totals: {}, opaque: { 'Uomo: una confezione piccola': 2 }, free: false }), 'Uomo: una confezione piccola');
assert.equal(shoppingAmountText({ id: 'spoons', legacyId: 'spoons', totals: { g: 50 }, opaque: {}, free: false }), '50g');
const exportedShopping = shoppingText();
assert.match(exportedShopping, /Basilico - 7 pz/);
assert.doesNotMatch(exportedShopping, /Basilico[^\n]*mazzetto/);
renderSettings();
assert.match(document.getElementById('view-settings').innerHTML, /Account collegati/);
renderIncomingShares();
openRecipeModal('L1', 'monday');
renderModalContent();
openMealActions('monday', 'lunch');
renderMealSwapList();
openGeneratorModal();
computeGeneratorProposal(false);
openShareDialog();
openShareConflictPreview({ id: 'sh1', senderUsername: 'anna', recipes: [R('L9', 'Nuova', 'lunch', 'Uova')], includesPlan: false, plan: null }, 'recipes');

// Modalità modifica ricetta
openRecipeModal('L1', 'monday');
document.getElementById('modal-edit-btn')._fire('click');
addIngredient();
removeIngredient(0);
addStep();
moveStep(0, 1);

// ---- Regressione: l'overlay di caricamento deve chiudersi con showApp() ----
// L'avvio rapido da cache chiama applyState() -> showApp() e poi
// loadUserData({ silent: true }), che nel finally non esegue clearLoading():
// senza il clearLoading() dentro showApp() l'overlay "Caricamento…" resta
// visibile per sempre dopo un refresh.
setLoading('Caricamento…');
assert.equal(
  document.getElementById('loading-overlay').classList.contains('hidden'),
  false
);
assert.equal(document.getElementById('loading-message').textContent, 'Caricamento…');
showApp();
assert.equal(
  document.getElementById('loading-overlay').classList.contains('hidden'),
  true
);

console.log('SMOKE OK — tutti i percorsi di rendering eseguiti senza errori');
