'use strict';
/* Passo 1 — micro-fix UI client:
 *  - campanella senza cerchio (badge, ARIA, shake e reduced-motion preservati);
 *  - header con sola icona impostazioni (nome accessibile preservato);
 *  - icone ⚙️/🔔 stessa dimensione, allineate al select profilo;
 *  - switch quantità adattate: label, persistenza, blocco pre-conferma;
 *  - chip batch "Cena + pranzo di {giorno successivo}";
 *  - categoria proteica non editabile ma preservata nel salvataggio;
 *  - nessun profilo duplicato nel page-heading della settimana. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
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
appState.saasPolicy = { mode: 'original-only', migrationRequired: false };
setRecipes([]);
appState.plan = PianoDomain.migratePlan(createEmptyWeeklyPlan());

const headerHtml = () => document.getElementById('global-header-container').innerHTML;
const weekHtml = () => document.getElementById('view-week').innerHTML;

// ---- Campanella: niente cerchio, badge/ARIA/shake preservati ----

test('campanella senza bordo né fondo circolare in ogni stato', () => {
  const bellBlock = css.match(/\.notification-bell \{[^}]*\}/)[0];
  assert.match(bellBlock, /border: 0;/);
  assert.match(bellBlock, /background: transparent;/);
  assert.doesNotMatch(bellBlock, /border-radius: 50%/);
  const pendingBlock = css.match(/\.notification-bell\.has-pending \{[^}]*\}/)[0];
  assert.match(pendingBlock, /background: transparent;/);
  assert.doesNotMatch(pendingBlock, /border-color/);
  assert.match(css, /\.notification-bell\.has-pending:hover \{ background: transparent; \}/);
  assert.match(css, /\.notification-bell:hover \{[^}]*background: transparent;[^}]*\}/);
});

test('campanella: badge rosso, shake periodico e reduced-motion preservati', () => {
  const badgeBlock = css.match(/^\.notification-badge \{[^}]*\}/m)[0];
  assert.match(badgeBlock, /background: #c4704b;/, 'badge numerico terracotta (palette nuova, mai rosso)');
  assert.match(css, /@keyframes bell-shake/, 'animazione scuotimento preservata');
  assert.match(css, /\.notification-bell\.has-pending \{[^}]*animation: bell-shake/, 'shake attivo con pendenti');
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.notification-bell\.has-pending \{[^}]*\}[^}]*\}/);
  assert.ok(reduced, 'blocco prefers-reduced-motion presente');
  assert.match(reduced[0], /animation: none;/, 'niente animazione con reduced-motion');
});

test('campanella: ARIA, focus e dialog preservati nel markup', () => {
  incomingRecipeShares = [];
  incomingAccountLinks = [];
  notificationsLoadError = false;
  renderGlobalHeader();
  assert.match(headerHtml(), /id="notification-bell"/);
  assert.match(headerHtml(), /aria-label="Notifiche: nessuna richiesta in attesa"/);
  assert.match(headerHtml(), /aria-haspopup="dialog"/);
  assert.match(headerHtml(), /aria-controls="incoming-shares-modal"/);
  assert.match(headerHtml(), /notification-badge hidden/, 'badge nascosto senza pendenti');
});

// ---- Header: sola icona impostazioni ----

test('header senza nome utente: resta la sola icona con nome accessibile', () => {
  renderGlobalHeader();
  const html = headerHtml();
  assert.match(html, /class="header-account"[^>]*aria-label="Impostazioni"/);
  assert.match(html, /<span aria-hidden="true">⚙️<\/span>/);
  assert.doesNotMatch(html, /mario/, 'il nome utente non compare più in header');
});

// ---- Icone stessa dimensione ----

test('icone impostazioni e campanella: stessa dimensione desktop e mobile', () => {
  const bellBlock = css.match(/\.notification-bell \{[^}]*\}/)[0];
  const gearBlock = css.match(/\.header-account \{[^}]*\}/)[0];
  assert.match(bellBlock, /font-size: 1\.15rem;/);
  assert.match(gearBlock, /font-size: 1\.15rem;/);
  assert.match(gearBlock, /line-height: 1;/);
  assert.match(gearBlock, /align-items: center;/, 'allineamento coerente col select profilo');
  assert.match(css, /\.header-account \{ font-size: 1\.05rem;/, 'mobile: ingranaggio leggibile');
  assert.match(css, /\.notification-bell \{ width: 40px; height: 40px; font-size: 1\.05rem; \}/, 'mobile: campanella stessa misura');
});

// ---- Switch quantità adattate ----

test('switch: label cliccabile, interruttore accessibile e stato persistito', () => {
  appState.saasPolicy = { mode: 'assigned', migrationRequired: false };
  appState.plan = PianoDomain.setAdaptedQuantitiesEnabled(appState.plan, true);
  renderWeek();
  assert.match(weekHtml(), /<label class="week-adapted-row" for="week-adapted-toggle">/, 'testo cliccabile via label');
  assert.match(weekHtml(), /id="week-adapted-toggle"/);
  assert.match(weekHtml(), /role="switch"/);
  assert.match(weekHtml(), /aria-label="Ricette con quantità adattate alle linee guida"/);
  assert.match(weekHtml(), /alle linee guida" checked/, 'stato ON riflesso');
  appState.plan = PianoDomain.setAdaptedQuantitiesEnabled(appState.plan, false);
  renderWeek();
  assert.doesNotMatch(weekHtml(), /alle linee guida" checked/, 'stato OFF riflesso');
  assert.equal(PianoDomain.normalizeAdaptedQuantitiesEnabled(appState.plan), false);
});

test('switch: profilo non confermato mostra il blocco e resta sulle originali', () => {
  appState.plan = PianoDomain.setAdaptedQuantitiesEnabled(appState.plan, true);
  appState.saasPolicy = { mode: 'pending-confirmation', migrationRequired: true };
  assert.equal(window.PIANO_SAAS_CONFIG.enabled, true);
  assert.equal(planAdaptedQuantitiesEffective(), false, 'il blocco impedisce un adattamento non autorizzato');
  renderWeek();
  assert.match(weekHtml(), /Stai vedendo le quantità originali/, 'testo chiaro sul blocco');
  assert.match(weekHtml(), /conferma il nuovo profilo nelle Impostazioni/, 'azione richiesta esplicita');
  appState.saasPolicy = { mode: 'assigned', migrationRequired: false };
  assert.equal(planAdaptedQuantitiesEffective(), true, 'profilo confermato: adattamento effettivo');
});

test('switch: toggle on/off persiste tramite saveWeeklyPlan', async () => {
  const calls = [];
  const previous = global.saveWeeklyPlan;
  global.saveWeeklyPlan = async plan => { calls.push(PianoDomain.normalizeAdaptedQuantitiesEnabled(plan)); };
  try {
    appState.plan = PianoDomain.setAdaptedQuantitiesEnabled(appState.plan, true);
    appState.saasPolicy = { mode: 'assigned', migrationRequired: false };
    await toggleWeekAdaptedQuantities(false);
    assert.equal(PianoDomain.normalizeAdaptedQuantitiesEnabled(appState.plan), false);
    assert.deepEqual(calls, [false], 'persistenza OFF');
    await toggleWeekAdaptedQuantities(true);
    assert.equal(PianoDomain.normalizeAdaptedQuantitiesEnabled(appState.plan), true);
    assert.deepEqual(calls, [false, true], 'persistenza ON');
  } finally {
    global.saveWeeklyPlan = previous;
  }
});

// ---- Chip batch cooking ----

test('chip batch: "Cena + pranzo di {giorno successivo}" con domenica → lunedì', () => {
  assert.equal(batchChipLabel('wednesday', [{ targetDay: 'thursday' }]), 'Cena + pranzo di giovedì');
  assert.equal(batchChipLabel('sunday', [{ targetDay: 'monday' }]), 'Cena + pranzo di lunedì');
  assert.equal(
    batchChipLabel('monday', [{ targetDay: 'tuesday' }, { targetDay: 'wednesday' }]),
    'Cena + pranzo di martedì, mercoledì'
  );
  assert.doesNotMatch(batchChipLabel('monday', [{ targetDay: 'tuesday' }]), /Batch cooking disponibile/);
});

test('chip batch renderizzato nella colonna con testo del giorno successivo', () => {
  const previous = global.getActiveBatch;
  global.getActiveBatch = day => (day === 'wednesday' ? [{ targetDay: 'thursday' }] : []);
  try {
    appState.saasPolicy = { mode: 'assigned', migrationRequired: false };
    renderWeek();
    assert.match(weekHtml(), /Cena \+ pranzo di giovedì/);
    assert.doesNotMatch(weekHtml(), /Batch cooking disponibile/);
  } finally {
    global.getActiveBatch = previous;
  }
});

// ---- Categoria proteica: non editabile, valore preservato ----

test('editor senza controllo categoria proteica, valore preservato al salvataggio', () => {
  appState.saasPolicy = { mode: 'assigned', migrationRequired: false };
  currentModal = {
    recipe: {
      id: 'L1', slot: 'lunch', name: 'Test', emoji: '🍲', proteinCategory: 'poultry',
      ingredients: [{ name: 'Pasta', portions: { ipo: '70 g', man: '90 g' } }],
      steps: [], notes: []
    },
    original: null, dayKey: null, dayType: 'training', slot: null, planSlot: null, isNew: false
  };
  editMode = true;
  renderModalContent();
  const timeHtml = document.getElementById('modal-time').innerHTML;
  assert.doesNotMatch(timeHtml, /edit-recipe-category/);
  assert.doesNotMatch(timeHtml, /Categoria proteica/);
  document.getElementById('edit-recipe-name').value = 'Test';
  document.getElementById('edit-ing-name-0').value = 'Pasta';
  document.getElementById('edit-ing-man-0').value = '90 g';
  document.getElementById('edit-ing-ipo-0').value = '70 g';
  captureEditState();
  assert.equal(currentModal.recipe.proteinCategory, 'poultry', 'il fallback salvato non viene azzerato');
  assert.equal(PianoDomain.classifyProtein(currentModal.recipe), 'poultry', 'classificazione automatica invariata');
  currentModal = null;
  editMode = false;
});

// ---- Nessun profilo duplicato ----

test('page-heading settimana senza chip profilo duplicato', () => {
  appState.saasPolicy = { mode: 'assigned', migrationRequired: false };
  renderWeek();
  assert.doesNotMatch(weekHtml(), /profile-chip/);
  renderGlobalHeader();
  assert.match(headerHtml(), /aria-label="Profilo porzioni"/, 'il profilo resta nel select globale');
});
