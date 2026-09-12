'use strict';
/* Passo 3 — avviso mapping Meller e auto-report:
 *  - avviso nascosto senza problemi, stabile tra i render;
 *  - invio automatico solo per mapping NUOVI, una tantum;
 *  - toast solo a invio riuscito; offline → muto + warn + stato "failed". */
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
global.location = { hash: '#week' };

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

const ASSIGNED = {
  state: 'assigned',
  profile: { clientProfileId: 'cp1', ruleSetId: 'rs1', ruleSetVersion: 'v3' }
};
const alignedRecipe = () => ({
  id: 'L1', slot: 'lunch', name: 'Pasta', emoji: '🍝',
  ingredients: [{ name: 'Pasta di semola', portions: { man: '90 g', ipo: '90 g' } }],
  steps: [], notes: []
});
const unknownRecipe = (name = 'Proteina misteriosa') => ({
  id: 'L9', slot: 'lunch', name: 'Test', emoji: '🍲',
  ingredients: [{ name, portions: { man: '100 g', ipo: '100 g' } }],
  steps: [], notes: []
});
function openModal(recipe, dayKey = null, planSlot = null) {
  currentModal = {
    recipe: JSON.parse(JSON.stringify(recipe)), original: JSON.parse(JSON.stringify(recipe)),
    dayKey, dayType: 'training', slot: null, planSlot, isNew: false, assignAfterSave: null,
    mellerPreviewActive: false, mellerPreviewOriginal: null, mellerSaveWithAdaptation: false
  };
  editMode = false;
}
function assigned() {
  appState.saasContext = JSON.parse(JSON.stringify(ASSIGNED));
  appState.saasPolicy = { mode: 'assigned', migrationRequired: false };
  appState.plan = PianoDomain.migratePlan(createEmptyWeeklyPlan());
  appState.plan = PianoDomain.setAdaptedQuantitiesEnabled(appState.plan, true);
  localStorage.removeItem('mapping_reports_sent_v1');
  localStorage.removeItem('last_mapping_report_status');
}

// ---- Avviso nascosto senza problemi ----

test('avviso nascosto con dosi allineate e stabile tra i render', () => {
  assigned();
  setRecipes([alignedRecipe()]);
  openModal(alignedRecipe());
  assert.equal(mellerNoticeHtml(), '', 'nessun problema: nessun avviso');
  renderModalContent();
  renderModalContent();
  assert.equal(document.getElementById('modal-meller-notice').innerHTML, '', 'i re-render non riattivano l’avviso');
  currentModal = null;
});

test('avviso nascosto per pasti non applicabili (colazione)', () => {
  assigned();
  const breakfast = { ...alignedRecipe(), id: 'B1', slot: 'breakfast' };
  openModal(breakfast);
  assert.equal(mellerNoticeHtml(), '');
  currentModal = null;
});

test('avviso visibile con mapping mancante, testi di prodotto invariati', () => {
  assigned();
  setRecipes([unknownRecipe()]);
  openModal(unknownRecipe());
  const html = mellerNoticeHtml();
  assert.match(html, /Mapping Meller incompleto/);
  assert.match(html, /non hanno un mapping nel catalogo attuale/);
  assert.match(html, /mapping mancante/);
  assert.match(html, /Segnala ingredienti non riconosciuti/, 'pulsante manuale preservato');
  currentModal = null;
});

// ---- Auto-report ----

test('auto-report: invia i mapping nuovi con payload minimizzato e toast unico', async () => {
  assigned();
  const calls = [];
  const toasts = [];
  const prevCall = global.callSaasFunction;
  const prevToast = global.showToast;
  global.callSaasFunction = async (name, body) => { calls.push({ name, body }); return { ok: true }; };
  global.showToast = message => { toasts.push(message); };
  try {
    const result = await sendNewMappingReports([{ recipe: unknownRecipe(), slot: 'lunch' }]);
    assert.equal(result.sent, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'submitMappingReport');
    assert.deepEqual(Object.keys(calls[0].body).sort(), [
      'clientProfileId', 'errorType', 'fingerprint', 'ingredientText', 'ruleSetId', 'ruleSetVersion', 'slot'
    ].sort(), 'solo campi minimizzati');
    assert.equal(calls[0].body.errorType, 'unknown');
    assert.equal(calls[0].body.ingredientText, 'Proteina misteriosa');
    assert.deepEqual(toasts, ['Segnalazione inviata in forma minimizzata ✅'], 'un solo toast a invio riuscito');
    assert.equal(localStorage.getItem('last_mapping_report_status'), 'sent');
  } finally {
    global.callSaasFunction = prevCall;
    global.showToast = prevToast;
  }
});

test('auto-report: dedup una tantum, solo i nuovi viaggiano', async () => {
  assigned();
  const calls = [];
  const toasts = [];
  const prevCall = global.callSaasFunction;
  const prevToast = global.showToast;
  global.callSaasFunction = async (name, body) => { calls.push(body.ingredientText); return { ok: true }; };
  global.showToast = message => { toasts.push(message); };
  try {
    await sendNewMappingReports([{ recipe: unknownRecipe(), slot: 'lunch' }]);
    assert.equal(calls.length, 1);
    // Secondo invio identico: silenzio totale.
    const again = await sendNewMappingReports([{ recipe: unknownRecipe(), slot: 'lunch' }]);
    assert.equal(again.sent, 0);
    assert.equal(calls.length, 1, 'nessun re-invio dello stesso mapping');
    assert.equal(toasts.length, 1, 'nessun toast senza novità');
    // Nuova ricetta con altro sconosciuto: viaggia solo lui.
    const other = unknownRecipe('Minerale lunare');
    other.id = 'L10';
    const result = await sendNewMappingReports([
      { recipe: unknownRecipe(), slot: 'lunch' },
      { recipe: other, slot: 'lunch' }
    ]);
    assert.equal(result.sent, 1);
    assert.deepEqual(calls, ['Proteina misteriosa', 'Minerale lunare']);
    assert.equal(toasts.length, 2, 'toast solo per il nuovo invio');
  } finally {
    global.callSaasFunction = prevCall;
    global.showToast = prevToast;
  }
});

test('auto-report: offline/errore → muto, warn e stato failed, senza eccezioni', async () => {
  assigned();
  const toasts = [];
  const warns = [];
  const prevCall = global.callSaasFunction;
  const prevToast = global.showToast;
  const prevWarn = console.warn;
  global.callSaasFunction = async () => { throw new Error('offline'); };
  global.showToast = message => { toasts.push(message); };
  console.warn = (...args) => { warns.push(args); };
  try {
    const result = await sendNewMappingReports([{ recipe: unknownRecipe(), slot: 'lunch' }]);
    assert.equal(result.failed, true);
    assert.equal(toasts.length, 0, 'flusso automatico muto in caso di errore');
    assert.equal(warns.length, 1, 'console.warn registrato');
    assert.equal(localStorage.getItem('last_mapping_report_status'), 'failed');
    assert.deepEqual(getSentMappingFingerprints(), [], 'fallimento non marcato come inviato');
  } finally {
    global.callSaasFunction = prevCall;
    global.showToast = prevToast;
    console.warn = prevWarn;
  }
});

test('auto-report: senza collegamento assegnato non invia e non rompe nulla', async () => {
  appState.saasContext = { state: 'unassigned' };
  appState.saasPolicy = { mode: 'original-only', migrationRequired: false };
  localStorage.removeItem('mapping_reports_sent_v1');
  localStorage.removeItem('last_mapping_report_status');
  let called = false;
  const prevCall = global.callSaasFunction;
  global.callSaasFunction = async () => { called = true; return {}; };
  try {
    const result = await sendNewMappingReports([{ recipe: unknownRecipe(), slot: 'lunch' }]);
    assert.equal(result.sent, 0);
    assert.equal(called, false);
    assert.equal(localStorage.getItem('last_mapping_report_status'), null);
  } finally {
    global.callSaasFunction = prevCall;
  }
});

test('pulsante manuale: ricetta senza sconosciuti resta silenzioso, già-inviati avvisati', async () => {
  assigned();
  const toasts = [];
  const prevCall = global.callSaasFunction;
  const prevToast = global.showToast;
  global.callSaasFunction = async () => ({ ok: true });
  global.showToast = message => { toasts.push(message); };
  try {
    openModal(alignedRecipe());
    await reportCurrentMissingMappings();
    assert.deepEqual(toasts, [], 'nessuno sconosciuto: silenzio');
    openModal(unknownRecipe());
    await reportCurrentMissingMappings();
    assert.deepEqual(toasts, ['Segnalazione inviata in forma minimizzata ✅']);
    await reportCurrentMissingMappings();
    assert.deepEqual(toasts, [
      'Segnalazione inviata in forma minimizzata ✅',
      'Segnalazione già inviata in precedenza'
    ]);
    currentModal = null;
  } finally {
    global.callSaasFunction = prevCall;
    global.showToast = prevToast;
  }
});

test('salvataggio ricetta: auto-report agganciato senza rompere il flusso', async () => {
  assigned();
  setRecipes([]);
  const calls = [];
  const toasts = [];
  const prevCall = global.callSaasFunction;
  const prevToast = global.showToast;
  const prevCatalog = global.saveRecipeCatalog;
  global.callSaasFunction = async (name, body) => { calls.push(body.ingredientText); return { ok: true }; };
  global.showToast = message => { toasts.push(message); };
  global.saveRecipeCatalog = async () => {};
  try {
    openModal(unknownRecipe());
    currentModal.isNew = true;
    currentModal.original = null;
    editMode = true;
    // L'editor rilegge i campi dal DOM: precompila nome e ingrediente.
    document.getElementById('edit-recipe-name').value = 'Test';
    document.getElementById('edit-recipe-emoji').value = '🍲';
    document.getElementById('edit-recipe-slot').value = 'lunch';
    document.getElementById('edit-ing-name-0').value = 'Proteina misteriosa';
    await saveRecipeEdit(true);
    assert.equal(getRecipe('L9').name, 'Test', 'ricetta salvata');
    assert.deepEqual(calls, ['Proteina misteriosa'], 'auto-report al salvataggio');
    assert.ok(toasts.includes('Ricetta salvata nel cloud ✅'), 'toast salvataggio preservato');
    currentModal = null;
    editMode = false;
  } finally {
    global.callSaasFunction = prevCall;
    global.showToast = prevToast;
    global.saveRecipeCatalog = prevCatalog;
  }
});

test('post-salvataggio settimana: scansiona i pasti pianificati, una tantum', async () => {
  assigned();
  setRecipes([unknownRecipe(), alignedRecipe()]);
  appState.plan.days.monday.type = 'training';
  appState.plan.days.monday.lunch = 'L9';
  appState.plan.days.tuesday.type = 'rest';
  appState.plan.days.tuesday.lunch = 'L1';
  const calls = [];
  const prevCall = global.callSaasFunction;
  const prevToast = global.showToast;
  global.callSaasFunction = async (name, body) => { calls.push(body.ingredientText); return { ok: true }; };
  global.showToast = () => {};
  try {
    await afterWeeklyPlanSaved(appState.plan);
    assert.deepEqual(calls, ['Proteina misteriosa'], 'solo lo sconosciuto pianificato');
    await afterWeeklyPlanSaved(appState.plan);
    assert.deepEqual(calls, ['Proteina misteriosa'], 'seconda scansione silenziosa');
    appState.saasContext = { state: 'unassigned' };
    localStorage.removeItem('mapping_reports_sent_v1');
    await afterWeeklyPlanSaved(appState.plan);
    assert.deepEqual(calls, ['Proteina misteriosa'], 'senza assegnazione nessun invio');
  } finally {
    global.callSaasFunction = prevCall;
    global.showToast = prevToast;
  }
});

test('saveWeeklyPlan richiama il gancio post-salvataggio', () => {
  const source = fs.readFileSync(path.join(ROOT, 'js/firebase.js'), 'utf8');
  assert.match(source, /window\.afterWeeklyPlanSaved/, 'gancio presente nel layer dati');
});
