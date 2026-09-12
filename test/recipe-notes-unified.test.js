'use strict';
/* Note unificate (schema 6): il campo storico `specialNote` confluisce in
 * `notes` (array, una nota per riga) senza prefisso. Qui:
 *  - migrazione idempotente e non distruttiva in js/domain.js;
 *  - editor con un solo campo note (nessuna textarea "Nota speciale");
 *  - rendering con il solo blocco Note (nessuna classe .special-note);
 *  - nessuna occorrenza residua nel client.
 */
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

// ---- Migrazione: specialNote -> notes ----

function legacyRecipe(extra = {}) {
  return {
    id: 'N1', name: 'Pasta al pepe', slot: 'lunch', emoji: '🍝', proteinCategory: '',
    ingredients: [{ name: 'Pasta integrale', portions: { ipo: '70g', man: '90g' } }],
    steps: ['Cuoci la pasta'],
    ...extra
  };
}

test('migrateRecipe unifica la nota speciale in notes come prima riga, senza prefisso', () => {
  const migrated = PianoDomain.migrateRecipe(legacyRecipe({ notes: ['Usa pepe fresco'], specialNote: 'Non scuocere' }));
  assert.deepEqual(migrated.notes, ['Non scuocere', 'Usa pepe fresco']);
  assert.equal('specialNote' in migrated, false, 'il campo obsoleto non resta nella ricetta');
});

test('migrazione idempotente: la seconda passata non duplica la nota', () => {
  const once = PianoDomain.migrateRecipe(legacyRecipe({ notes: ['Usa pepe fresco'], specialNote: 'Non scuocere' }));
  const twice = PianoDomain.migrateRecipe(once);
  assert.deepEqual(twice.notes, ['Non scuocere', 'Usa pepe fresco']);
  assert.deepEqual(once, twice);
});

test('nota speciale gia presente in notes: nessuna duplicazione', () => {
  const migrated = PianoDomain.migrateRecipe(legacyRecipe({ notes: ['Non scuocere', 'Altro'], specialNote: 'Non scuocere' }));
  assert.deepEqual(migrated.notes, ['Non scuocere', 'Altro']);
});

test('note assenti o vuote: notes resta un array vuoto', () => {
  assert.deepEqual(PianoDomain.migrateRecipe(legacyRecipe({ notes: [], specialNote: '' })).notes, []);
  assert.deepEqual(PianoDomain.migrateRecipe(legacyRecipe({ notes: ['  '], specialNote: '   ' })).notes, [], 'righe di soli spazi scartate');
  assert.deepEqual(PianoDomain.migrateRecipe(legacyRecipe()).notes, [], 'notes presente anche se il documento non la aveva');
});

test('migrateCatalog applica la migrazione a tutte le ricette e resta a schema corrente', () => {
  const catalog = PianoDomain.migrateCatalog({
    schemaVersion: 5,
    recipes: [
      legacyRecipe({ id: 'A', notes: [], specialNote: 'Prima' }),
      legacyRecipe({ id: 'B', notes: ['B1'], specialNote: '' })
    ]
  });
  assert.deepEqual(catalog.recipes[0].notes, ['Prima']);
  assert.deepEqual(catalog.recipes[1].notes, ['B1']);
  assert.equal(catalog.schemaVersion, PianoDomain.VERSION, 'lo schema resta 6: la migrazione non cambia la forma di notes');
});

// ---- UI: un solo campo note ----

function modalFixture() {
  currentModal = {
    recipe: legacyRecipe({ notes: ['Non scuocere', 'Usa pepe fresco'] }),
    original: null, dayKey: null, dayType: 'training', slot: null, planSlot: null, isNew: false
  };
  appState.saasPolicy = { mode: 'original-only', migrationRequired: false };
}

test('editor: un solo campo note, nessuna textarea "Nota speciale"', () => {
  modalFixture();
  editMode = true;
  renderModalContent();
  const html = document.getElementById('modal-edit-notes').innerHTML;
  assert.match(html, /id="edit-recipe-notes"/, 'campo note presente');
  assert.match(html, /Note \(una per riga\)/, 'etichetta del campo unico');
  assert.doesNotMatch(html, /edit-recipe-special/, 'campo nota speciale rimosso');
  assert.doesNotMatch(html, /Nota speciale/, 'etichetta obsoleta rimossa');
  editMode = false;
  currentModal = null;
});

test('captureEditState salva solo notes e non ricrea specialNote', () => {
  modalFixture();
  editMode = true;
  renderModalContent();
  document.getElementById('edit-recipe-name').value = 'Pasta al pepe';
  document.getElementById('edit-ing-name-0').value = 'Pasta integrale';
  document.getElementById('edit-ing-man-0').value = '90 g';
  document.getElementById('edit-ing-ipo-0').value = '70 g';
  document.getElementById('edit-recipe-notes').value = 'Non scuocere\nUsa pepe fresco\n\n';
  captureEditState();
  assert.deepEqual(currentModal.recipe.notes, ['Non scuocere', 'Usa pepe fresco'], 'righe vuote scartate');
  assert.equal('specialNote' in currentModal.recipe, false, 'il salvataggio non reintroduce il campo');
  editMode = false;
  currentModal = null;
});

test('lista preparazione: solo il blocco Note, nessun "Importante:" separato', () => {
  modalFixture();
  editMode = false;
  renderModalContent();
  const prep = document.getElementById('modal-prep-list').innerHTML;
  assert.match(prep, /recipe-notes/, 'blocco note renderizzato');
  assert.match(prep, /Non scuocere/, 'prima nota visibile');
  assert.match(prep, /Usa pepe fresco/, 'seconda nota visibile');
  assert.doesNotMatch(prep, /special-note/, 'nessuna classe obsoleta');
  assert.doesNotMatch(prep, /Importante:/, 'nessun blocco concorrente');
  currentModal = null;
});

// ---- CSS e codice: zero residui ----

test('css: classe .special-note rimossa, blocco .recipe-notes preservato', () => {
  assert.doesNotMatch(css, /\.special-note\b/, 'regola obsoleta eliminata');
  assert.match(css, /\.recipe-notes \{/, 'stile del blocco note preservato');
});

test('nessun riferimento residuo a specialNote nel client', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  for (const needle of ['specialNote', 'special-note', 'edit-recipe-special']) {
    assert.equal(appSource.includes(needle), false, `js/app.js non contiene piu ${needle}`);
  }
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.doesNotMatch(indexHtml, /special-note|specialNote/, 'markup pulito');
});
