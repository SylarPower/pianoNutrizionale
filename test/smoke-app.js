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
  orderBy: () => dbStub,
  limit: () => dbStub,
  get: async () => ({ exists: false, forEach: () => {}, data: () => ({}) }),
  set: async () => {},
  add: async () => ({ id: 'price-entry-1' }),
  update: async () => {},
  delete: async () => {},
  batch: () => ({ set: () => {}, delete: () => {}, commit: async () => {} }),
  runTransaction: async fn => fn({ get: async () => ({ exists: false, data: () => ({}) }), set: () => {}, delete: () => {} })
};

global.window = global;
// Stub degli event listener globali (es. pagehide): registra i gestori per
// poterli scatenare manualmente nei test.
global.addEventListener = (name, fn) => { global['_on_' + name] = fn; };
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

for (const file of ['js/domain.js', 'js/data.js', 'js/prices.js', 'js/firebase.js', 'js/app.js']) {
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
// Secondo carboidrato nella colazione: serve per verificare l'ordine degli
// alimenti DENTRO una categoria (itemOrder condiviso nel documento spesa).
recipes.find(item => item.id === 'B1').ingredients.push({ name: 'Pane integrale', ingredientId: 'pane-integrale', portions: samePortion('60g') });
const days = {};
window.PianoDomain.DAYS.forEach(day => {
  days[day] = { type: ['monday', 'wednesday', 'friday', 'sunday'].includes(day) ? 'training' : 'rest', breakfast: 'B1', snack1: 'S1', lunch: 'L1', snack2: 'M1', dinner: 'D1' };
});
const plan = {
  schemaVersion: 5,
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
appState.deviceSettings = { portionProfile: 'man', darkMode: false, lastOpenDate: null };

// ---- Percorsi di rendering ----
renderGlobalHeader();
renderWeek();

// Batch cooking: la chip della settimana è cliccabile e apre la modale dosi.
assert.match(document.getElementById('view-week').innerHTML, /batch-chip-btn[^>]*openBatchModal\('monday'\)/, 'chip batch cliccabile nella colonna del giorno');
openBatchModal('monday');
const batchModalList = document.getElementById('batch-modal-list');
assert.match(batchModalList.innerHTML, /Preparazioni in anticipo/, 'titolo del batch nella modale');
assert.match(batchModalList.innerHTML, /Cuoci il riso/, 'task del batch nella modale');
assert.match(batchModalList.innerHTML, /batch-task-quantity/, 'dosi del batch nella modale');
assert.match(batchModalList.innerHTML, /Ingredienti/, 'ingredienti completi già visibili nella modale batch');
assert.match(batchModalList.innerHTML, /Preparazione/, 'preparazione completa già visibile nella modale batch');
assert.match(batchModalList.innerHTML, /Passo uno/, 'passaggi della ricetta già visibili nella modale batch');
assert.doesNotMatch(batchModalList.innerHTML, /Vedi ricetta completa/, 'nessun passaggio a una seconda modale');
assert.doesNotMatch(batchModalList.innerHTML, /Conservazione|batch-task-storage/, 'nessuna nota di conservazione');
assert.doesNotMatch(batchModalList.innerHTML, /Prepara oggi/i, 'nessuna label ridondante per la preparazione odierna');
assert.equal(document.getElementById('batch-modal').classList.contains('hidden'), false, 'modale batch aperta');
closeBatchModal();
assert.equal(document.getElementById('batch-modal').classList.contains('hidden'), true, 'modale batch chiudibile');

// Stessa ricetta a cena e al pranzo successivo: un'unica ricetta completa con
// dosi sommate, senza titolo "Doppia porzione" né indicazione del giorno target.
const originalTemplates = appState.plan.batchTemplates;
const originalTuesdayLunch = appState.plan.days.tuesday.lunch;
appState.plan.batchTemplates = [];
appState.plan.days.tuesday.lunch = 'D1';
openBatchModal('monday');
assert.match(batchModalList.innerHTML, /Ingredienti · dosi totali/, 'dosi totali integrate nella ricetta completa');
assert.match(batchModalList.innerHTML, /230g/, 'dose cena e pranzo sommata');
assert.doesNotMatch(batchModalList.innerHTML, /Doppia porzione|Pranzo di Martedì|tra 1 giorno/, 'testi ridondanti assenti per cena e pranzo successivo');
closeBatchModal();
appState.plan.batchTemplates = originalTemplates;
appState.plan.days.tuesday.lunch = originalTuesdayLunch;

renderWeek();
renderRecipes();
assert.match(document.getElementById('view-recipes').innerHTML, /recipe-section-toggle collapsed/);
assert.match(document.getElementById('view-recipes').innerHTML, /recipe-section-body hidden/);
assert.match(document.getElementById('view-recipes').innerHTML, /recipe-search-clear/, 'ricerca ricette con pulsante rapido di reset');

// Ricettario: ricerca e sezioni aperte/chiuse persistono tra i render.
filterRecipeCards('pollo');
assert.equal(appState.deviceSettings.recipeLibraryState.searchQuery, 'pollo');
assert.equal(document.getElementById('recipe-search-clear').classList.contains('hidden'), false, 'reset ricerca visibile quando il filtro è attivo');
const lunchSectionBody = document.getElementById('recipe-section-lunch');
const lunchToggleButton = makeElement('recipe-toggle-lunch');
lunchSectionBody.classList.add('hidden');
toggleRecipeSection('lunch', lunchToggleButton);
assert.equal(appState.deviceSettings.recipeLibraryState.openSections.lunch, true);
renderRecipes();
assert.match(document.getElementById('view-recipes').innerHTML, /id="recipe-search"[^>]*value="pollo"/);
assert.match(document.getElementById('view-recipes').innerHTML, /id="recipe-section-lunch" class="recipe-section-body "/);

renderShop();
shopSettingsVisible = true;
renderShop();
assert.match(document.getElementById('view-shop').innerHTML, /toggleShopDay\('monday'\)/);
appState.deviceSettings.shopCategoryOrder = ['🐟 Pesce', '🍚 Carboidrati', '🥚 Uova e latticini'];
const exportedShopping = shoppingText();
// Condivisione WhatsApp: mantiene il formato storico con intestazione e
// righe vuote tra le sezioni.
assert.match(exportedShopping, /🛒 Lista della spesa/, 'condivisione con intestazione');
assert.match(exportedShopping, /\n\s*\n/, 'condivisione con righe vuote tra le sezioni');
// Copia: testo compatto, senza intestazione e senza righe vuote tra le sezioni.
const copiedShopping = shoppingTextCompact();
assert.doesNotMatch(copiedShopping, /🛒 Lista della spesa/, 'niente intestazione nel testo copiato');
assert.doesNotMatch(copiedShopping, /\n\s*\n/, 'niente righe vuote tra le sezioni');
assert.ok(copiedShopping.indexOf('----- 🐟 Pesce') < copiedShopping.indexOf('----- 🍚 Carboidrati'));
assert.ok(copiedShopping.indexOf('----- 🍚 Carboidrati') < copiedShopping.indexOf('----- 🥚 Uova e latticini'));
assert.ok(exportedShopping.indexOf('----- 🐟 Pesce') < exportedShopping.indexOf('----- 🍚 Carboidrati'));
assert.ok(exportedShopping.indexOf('----- 🍚 Carboidrati') < exportedShopping.indexOf('----- 🥚 Uova e latticini'));
assert.equal(shoppingAmountText({ id: 'opaque-a', legacyId: 'opaque-a', totals: { pz: 28 }, opaque: { 'Uomo: 8-10': 2, 'Donna IPO: 8-10': 1 }, free: false }), '28 pz');
assert.equal(shoppingAmountText({ id: 'opaque-b', legacyId: 'opaque-b', totals: {}, opaque: { 'Uomo: 1 mazzetto': 1, 'Donna IPO: 1 mazzetto': 1 }, free: false }), '2 mazzetti');
assert.equal(shoppingAmountText({ id: 'opaque-only', legacyId: 'opaque-only', totals: {}, opaque: { 'Uomo: una confezione piccola': 2 }, free: false }), 'Uomo: una confezione piccola');
assert.equal(shoppingAmountText({ id: 'spoons', legacyId: 'spoons', totals: { g: 50 }, opaque: {}, free: false }), '50g');
assert.match(exportedShopping, /Basilico - 7 pz/);
assert.doesNotMatch(exportedShopping, /Basilico[^\n]*mazzetto/);

// ---- Ordine alimenti dentro le categorie (itemOrder condiviso) ----
{
  // Senza itemOrder l'ordine è quello di "primo incontro": la colazione del
  // lunedì viene letta prima delle altre, quindi Riso venere precede Pane.
  assert.ok(exportedShopping.indexOf('Riso venere') < exportedShopping.indexOf('Pane integrale'), 'ordine automatico: riso prima di pane');

  // Le frecce A→Z/Ripristina passano da queueShoppingSave: stub remoto come
  // nel test del debounce, per contare le scritture del documento spesa.
  const originalCloud = global.saveShoppingListCloud;
  let remoteWrites = 0;
  global.saveShoppingListCloud = async () => { remoteWrites += 1; };

  // L'ordine salvato nel documento spesa viene applicato sia al testo sia alla vista.
  appState.shopping.itemOrder = { '🍚 Carboidrati': ['pane-integrale', 'riso-venere'] };
  const reorderedText = shoppingText();
  assert.ok(reorderedText.indexOf('Pane integrale') < reorderedText.indexOf('Riso venere'), 'itemOrder condiviso vale per Copia/Condividi');
  shopSettingsVisible = false;
  renderShop();
  assert.ok(document.getElementById('view-shop').innerHTML.indexOf('Pane integrale') < document.getElementById('view-shop').innerHTML.indexOf('Riso venere'), 'itemOrder condiviso vale per la vista Spesa');

  // Pannello "Ordine alimenti": frecce e scorciatoie A→Z / Ripristina.
  shopSettingsVisible = true;
  renderShop();
  const orderPanelHtml = document.getElementById('view-shop').innerHTML;
  assert.match(orderPanelHtml, /Ordine alimenti/);
  assert.match(orderPanelHtml, /moveShopItem\(0, 1, -1\)/, 'frecce su/giù per gli alimenti di una categoria');
  assert.match(orderPanelHtml, /sortShopItemsAZ\(0\)/, 'scorciatoia A→Z per categoria');
  assert.match(orderPanelHtml, /resetShopItemOrder\(0\)/, 'scorciatoia Ripristina per categoria');

  // Freccia ↑: riso (posizione 1) sale sopra pane e l'ordine viene salvato.
  moveShopItem(0, 1, -1);
  assert.deepEqual(appState.shopping.itemOrder['🍚 Carboidrati'], ['riso-venere', 'pane-integrale'], 'lo spostamento con le frecce aggiorna itemOrder');
  // A→Z: Pane precede Riso alfabeticamente.
  sortShopItemsAZ(0);
  assert.deepEqual(appState.shopping.itemOrder['🍚 Carboidrati'], ['pane-integrale', 'riso-venere'], 'A→Z ordina per nome visibile ma salva ingredientId');
  // Ripristina: torna all'ordine automatico di primo incontro.
  resetShopItemOrder(0);
  assert.equal(appState.shopping.itemOrder['🍚 Carboidrati'], undefined, 'Ripristina rimuove l\'ordine salvato della categoria');
  const afterResetText = shoppingText();
  assert.ok(afterResetText.indexOf('Riso venere') < afterResetText.indexOf('Pane integrale'), 'dopo il ripristino vale di nuovo l\'ordine automatico');
  // Più riordini ravvicinati producono UNA sola scrittura del documento spesa.
  assert.equal(remoteWrites, 0, 'nessuna scrittura remota immediata durante i riordini');
  flushShoppingSave();
  assert.equal(remoteWrites, 1, 'i riordini accodati diventano una sola scrittura remota');

  global.saveShoppingListCloud = originalCloud;
}

// ---- Debounce lista spesa: cache locale subito, una sola scrittura remota ----
{
  const originalLocal = global.saveShoppingListLocal;
  const originalCloud = global.saveShoppingListCloud;
  let localWrites = 0;
  let remoteWrites = 0;
  global.saveShoppingListLocal = value => { localWrites += 1; return value; };
  global.saveShoppingListCloud = async () => { remoteWrites += 1; };

  toggleShopMeal('monday', 'lunch', false);
  toggleShopMeal('monday', 'dinner', false);
  toggleShopPantry(false);
  updateShopItemQty('riso-venere', '500g');
  assert.equal(localWrites, 4, 'la cache locale si aggiorna SUBITO a ogni interazione');
  assert.equal(remoteWrites, 0, 'nessuna scrittura remota immediata: parte il debounce');
  assert.equal(appState.shopping.customQuantities['riso-venere'], '500g', 'l\'ultima modifica digitata resta nello stato');

  flushShoppingSave(); // stesso percorso di visibilitychange/pagehide
  assert.equal(remoteWrites, 1, 'più interazioni ravvicinate producono UNA sola scrittura remota');
  flushShoppingSave();
  assert.equal(remoteWrites, 1, 'senza modifiche pendenti il flush non riscrive');

  // Pagina nascosta: la scrittura pendente parte subito, senza attendere il timer.
  toggleShopPantry(true);
  assert.equal(remoteWrites, 1);
  document.visibilityState = 'hidden';
  document._on_visibilitychange();
  assert.equal(remoteWrites, 2, 'flush della scrittura pendente su visibilitychange');
  document.visibilityState = 'visible';

  // Chiusura della scheda: pagehide esegue il flush della scrittura pendente.
  excludeShopItem('riso-venere');
  assert.equal(remoteWrites, 2);
  window._on_pagehide();
  assert.equal(remoteWrites, 3, 'flush della scrittura pendente su pagehide');
  includeShopItem('riso-venere');
  window._on_pagehide();
  assert.equal(remoteWrites, 4);

  global.saveShoppingListLocal = originalLocal;
  global.saveShoppingListCloud = originalCloud;
}

// ---- Preferenza A/R persistente nell'anteprima del ricettario ----
// Aprendo una ricetta dal ricettario (nessun giorno assegnato) la scelta
// manuale A/R resta memorizzata e riproposta alle aperture successive.
openRecipeModal('L1');
assert.equal(currentModal.dayType, 'training', 'default: Allenamento');
setModalDayType('rest');
assert.equal(currentModal.dayType, 'rest');
assert.equal(appState.deviceSettings.recipePreviewDayType, 'rest', 'la scelta viene salvata nelle impostazioni dispositivo');
closeRecipeModal();
openRecipeModal('L1');
assert.equal(currentModal.dayType, 'rest', 'riaprendo dal ricettario la scelta A/R resta quella dell\'utente');
// La preferenza sopravvive a un riavvio: viene riletta da localStorage.
assert.equal(getLocalDeviceSettings().recipePreviewDayType, 'rest');
// Con un giorno assegnato prevale sempre il tipo A/R del giorno del piano.
openRecipeModal('L1', 'monday');
assert.equal(currentModal.dayType, 'training', 'monday è training nel piano: il giorno vince sull\'anteprima');
setModalDayType('training'); // con dayKey non deve toccare la preferenza salvata
assert.equal(appState.deviceSettings.recipePreviewDayType, 'rest');
closeRecipeModal();
// Anche una nuova ricetta senza giorno parte dalla preferenza salvata.
createNewRecipe('lunch');
assert.equal(currentModal.dayType, 'rest');
closeRecipeModal();

setupModal();

// Duplicazione ricetta: crea una copia in modifica senza salvarla nel catalogo.
openRecipeModal('L1', 'monday', 'lunch');
const recipesBeforeDuplicate = appState.recipes.length;
duplicateRecipe('L1');
assert.equal(editMode, true);
assert.equal(currentModal.isNew, true);
assert.match(currentModal.recipe.name, /\(copia\)$/);
assert.notEqual(currentModal.recipe.id, 'L1');
assert.equal(appState.recipes.length, recipesBeforeDuplicate, 'la copia non entra nel catalogo finché non salvo');
assert.equal(appState.plan.days.monday.lunch, 'L1', 'la ricetta duplicata non finisce nel piano settimanale');
closeRecipeModal();

// Il modal si chiude solo se il primo click parte fuori dal contenuto.
openRecipeModal('L1');
const recipeModal = document.getElementById('recipe-modal');
recipeModal._fire('mousedown', { target: { id: 'modal-title' } });
recipeModal._fire('click', { target: { id: 'recipe-modal' } });
assert.equal(recipeModal.classList.contains('hidden'), false, 'drag/selection partita dentro al modal: non deve chiudersi');
recipeModal._fire('mousedown', { target: { id: 'recipe-modal' } });
recipeModal._fire('click', { target: { id: 'recipe-modal' } });
assert.equal(recipeModal.classList.contains('hidden'), true, 'click iniziato fuori dal modal: deve chiudersi');

// ---- Avvio senza letture duplicate in modalità household ----
// In modalità household i listener onSnapshot rileggono comunque i tre
// documenti: con una cache locale valida loadUserData NON deve eseguire anche
// le .get() iniziali. In modalità personale (nessun listener) le .get()
// devono restare, altrimenti l'app non carica nulla.
const startupChecks = (async () => {
  const originals = {
    prepareDataScope: global.prepareDataScope,
    getCurrentHousehold: global.getCurrentHousehold,
    getRecipeCatalog: global.getRecipeCatalog,
    getWeeklyPlan: global.getWeeklyPlan,
    getShoppingListCloud: global.getShoppingListCloud,
    readLocalJson: global.readLocalJson,
    applyState: global.applyState,
    ensureUsernameDirectory: global.ensureUsernameDirectory
  };
  let reads = 0;
  let applied = null;
  let cache = {};
  global.prepareDataScope = async () => global.getCurrentHousehold();
  global.getRecipeCatalog = async () => { reads += 1; return [R('L1', 'Riso e uova', 'lunch', 'Legumi')]; };
  global.getWeeklyPlan = async () => { reads += 1; return plan; };
  global.getShoppingListCloud = async () => { reads += 1; return appState.shopping; };
  global.readLocalJson = (name, fallback) => (name in cache ? JSON.parse(JSON.stringify(cache[name])) : fallback);
  global.applyState = (recipes, planValue, shopping) => { applied = { recipes, plan: planValue, shopping }; };
  global.ensureUsernameDirectory = async () => {};
  const user = { uid: 'u1', email: 'mario@utenti.pianonutrizionale.app' };

  // Household + cache locale valida: ZERO .get(), stato popolato dalla cache
  // (il primo snapshot dei listener lo allineerà).
  global.getCurrentHousehold = () => ({ id: 'hh1', memberUids: ['u1', 'u2'] });
  cache = { recipe_catalog: [R('L9', 'Dalla cache', 'lunch', 'Uova')], weekly_plan: plan, shopping: {} };
  await loadUserData(user, { silent: true });
  assert.equal(reads, 0, 'household con cache valida: nessuna .get() duplicata (ci pensano i listener)');
  assert.equal(applied.recipes[0].id, 'L9', 'lo stato parte dalla cache locale');
  assert.ok(applied.plan?.days, 'piano popolato dalla cache');
  assert.ok(applied.shopping?.selectedMeals, 'lista spesa normalizzata dalla cache');
  assert.deepEqual(applied.shopping.itemOrder, {}, 'documento spesa senza itemOrder resta valido (merge difensivo)');

  // Household SENZA cache utilizzabile: fallback alle tre letture dirette,
  // nessuna schermata vuota in attesa di listener che potrebbero non arrivare.
  reads = 0; applied = null; cache = {};
  await loadUserData(user, { silent: true });
  assert.equal(reads, 3, 'household senza cache: restano le tre letture di fallback');
  assert.equal(applied.recipes[0].id, 'L1');

  // Modalità personale: le .get() iniziali restano sempre.
  reads = 0; applied = null;
  cache = { recipe_catalog: [R('L9', 'Dalla cache', 'lunch', 'Uova')], weekly_plan: plan, shopping: {} };
  global.getCurrentHousehold = () => null;
  await loadUserData(user, { silent: true });
  assert.equal(reads, 3, 'modalità personale: tre letture iniziali come sempre');

  // Regressione PR #16: il percorso non-silent chiude sempre l\'overlay.
  setLoading('Sincronizzazione del piano personale…');
  await loadUserData(user, { silent: false });
  assert.equal(
    document.getElementById('loading-overlay').classList.contains('hidden'),
    true,
    'loadUserData non-silent deve chiudere l\'overlay (fix PR #16)'
  );

  Object.assign(global, originals);
})();
renderSettings();
assert.match(document.getElementById('view-settings').innerHTML, /Account collegati/);
assert.match(document.getElementById('view-settings').innerHTML, /Backup e annullamento/);
assert.match(document.getElementById('view-settings').innerHTML, /Importazioni che sostituiscono tutte le ricette/);
assert.match(document.getElementById('view-settings').innerHTML, /Nessun backup/);

// ---- Prezzi condivisi (Spesa Smart): rendering delle tre schede ----
// Nello smoke non c'è un Firestore reale: la rubrica prezzi arriva da uno stub
// e l'archivio viene precompilato per non scatenare caricamenti asincroni.
global.getPriceMeta = async () => ({ stores: ['Conad', 'Lidl'], products: ['Latte'], brands: ['Zymil'] });
priceState.archive.loadedAt = Date.now();
renderPrices();
assert.match(document.getElementById('view-prices').innerHTML, /prices-tabs/);
assert.match(document.getElementById('view-prices').innerHTML, /Registra prezzo/);
switchPriceTab('compare');
assert.match(document.getElementById('view-prices').innerHTML, /price-compare-search/);
priceState.compare.productKey = 'latte';
priceState.compare.productName = 'Latte';
priceState.compare.entries = [
  { id: 'p1', store: 'Conad', storeKey: 'conad', brand: 'Zymil', brandKey: 'zymil', product: 'Latte', productKey: 'latte', price: 1.5, weight: 1, unit: 'l', normPrice: 1.5, normUnit: 'l', date: '2026-08-20', createdBy: 'u1', createdByUsername: 'mario', createdAtMs: 200 },
  { id: 'p2', store: 'Lidl', storeKey: 'lidl', brand: 'Zymil', brandKey: 'zymil', product: 'Latte', productKey: 'latte', price: 1.3, weight: 1, unit: 'l', normPrice: 1.3, normUnit: 'l', date: '2026-08-19', createdBy: 'u2', createdByUsername: 'anna', createdAtMs: 100 }
];
renderPriceCompareResults();
assert.match(document.getElementById('price-compare-results').innerHTML, /price-winner-card/);
assert.match(document.getElementById('price-compare-results').innerHTML, /Lidl/);
// Selezione articolo in Confronta: suggerimenti live mentre si digita,
// selezione dal menu e prodotti recenti a un tocco dopo la cancellazione.
priceState.meta.products = ['Latte'];
renderPriceCompareSuggestions('latt');
assert.equal(document.getElementById('price-compare-suggest').classList.contains('hidden'), false, 'menu suggerimenti aperto');
assert.match(document.getElementById('price-compare-suggest').innerHTML, /Latte/);
selectPriceSuggestion(0);
assert.equal(priceState.compare.query, 'Latte', 'selezione dal menu applicata');
assert.equal(readCompareRecents()[0], 'Latte', 'prodotto ricordato nei recenti');
clearPriceCompareSearch();
assert.match(document.getElementById('price-compare-results').innerHTML, /selectPriceQuickPick\(0\)/, 'prodotti rapidi proposti dopo la cancellazione');
assert.match(document.getElementById('price-compare-results').innerHTML, /Latte/);
// Testo senza corrispondenze: feedback esplicito invece dello stato generico.
priceCompareInput('xyzinesistente');
runPriceCompareSearch('xyzinesistente');
assert.match(document.getElementById('price-compare-results').innerHTML, /Nessun prodotto trovato/);
priceState.compare.query = '';
switchPriceTab('archive');
assert.match(document.getElementById('view-prices').innerHTML, /price-archive-content/);
assert.match(document.getElementById('view-prices').innerHTML, /preparePriceBackupImport/, 'import backup presente in archivio');
assert.match(document.getElementById('view-prices').innerHTML, /exportPriceBackup/, 'export backup presente in archivio');
// Regressione archivio: rientrare nella scheda con dati freschi in cache deve
// mostrare SUBITO l'elenco (prima il contenitore ricreato vuoto restava tale
// perché loadPriceArchive usciva senza ridisegnare).
priceState.archive.entries = [
  { id: 'p1', store: 'Conad', storeKey: 'conad', brand: 'Zymil', brandKey: 'zymil', product: 'Latte', productKey: 'latte', price: 1.5, weight: 1, unit: 'l', normPrice: 1.5, normUnit: 'l', date: '2026-08-20', createdBy: 'u1', createdByUsername: 'mario', createdAtMs: 200 }
];
priceState.archive.loadedAt = Date.now();
priceState.archive.loading = false;
switchPriceTab('archive');
assert.match(document.getElementById('price-archive-content').innerHTML, /price-archive-row/, 'archivio in cache mostrato subito al rientro');
renderPriceArchiveList();
assert.match(document.getElementById('price-archive-content').innerHTML, /price-archive-row/);
// Solo le voci proprie mostrano i pulsanti modifica/elimina.
assert.doesNotMatch(document.getElementById('price-archive-content').innerHTML, /startPriceEdit\('p2'\)/);
assert.match(document.getElementById('price-archive-content').innerHTML, /startPriceEdit\('p1'\)/);
switchPriceTab('log');
setupPriceModals();
assert.ok(document.getElementById('price-scan-modal'));
// Regressione: la funzionalità "incolla da volantino" è stata rimossa.
assert.equal(typeof runPriceSmartPasteImport, 'undefined', 'import da volantino rimosso');
assert.equal(typeof togglePriceSmartPaste, 'undefined', 'toggle volantino rimosso');
assert.doesNotMatch(document.getElementById('view-prices').innerHTML, /volantino/i);
// Suggerimenti live nei campi Registra: nome scannerizzato lungo → nome
// semplice già in archivio (menu a discesa al posto delle vecchie pilloline).
priceState.meta.products = ['Cereali', 'Latte'];
renderPriceFieldSuggestions('product', 'Cereali di grano duro', { skipExact: true });
assert.equal(document.getElementById('price-product-suggest').classList.contains('hidden'), false, 'menu aperto con varianti');
assert.match(document.getElementById('price-product-suggest').innerHTML, /Cereali/);
selectPriceFieldSuggestion('product', 0);
assert.equal(priceState.draft.product, 'Cereali');
assert.equal(document.getElementById('price-product-suggest').classList.contains('hidden'), true, 'menu chiuso dopo la selezione');
// Campo negozio vuoto: la rubrica si sceglie a un tocco dal menu.
priceState.meta.stores = ['Conad', 'Lidl'];
renderPriceFieldSuggestions('store', '');
assert.match(document.getElementById('price-store-suggest').innerHTML, /Conad/);
hidePriceFieldSuggestions('store');

// ---- Pagina negozio ----
switchPriceTab('stores');
priceState.meta.stores = ['Conad', 'Lidl'];
renderPrices();
assert.match(document.getElementById('view-prices').innerHTML, /store-card/);
assert.match(document.getElementById('view-prices').innerHTML, /openStoreDetail\(0\)/, 'click negozio via indice (nomi con apostrofi sicuri)');
priceState.stores = {
  view: 'detail', storeKey: 'conad', storeName: 'Conad', loading: false,
  rows: [{ entry: { product: 'Uova', brand: 'Eurovo', store: 'Conad', storeKey: 'conad', price: 2.29, weight: 12, unit: 'pz', normPrice: 0.19, normUnit: 'pz', date: '2026-07-27' }, status: 'best', best: null, deltaPct: null, options: 2 }],
  summary: { total: 1, compared: 1, bestCount: 1 }
};
renderPrices();
assert.match(document.getElementById('view-prices').innerHTML, /store-status-badge best/);
assert.match(document.getElementById('view-prices').innerHTML, /Miglior prezzo per 1 prodotto/);
closeStoreDetail();
assert.equal(priceState.stores.view, 'list');
renderIncomingShares();
openRecipeModal('L1', 'monday');
renderModalContent();
openMealActions('monday', 'lunch');
renderMealSwapList();
// Suggerimento batch cooking nel modale di sostituzione: sostituendo un
// pranzo viene evidenziata la cena del giorno prima (doppia porzione);
// sostituendo una cena viene evidenziato il pranzo del giorno dopo.
openSwapModal('monday', 'lunch');
{
  const swapHtml = document.getElementById('swap-options-list')._innerHTML;
  assert.match(swapHtml, /batch-suggestion-item/, 'suggerimento batch presente nella sostituzione del pranzo');
  assert.match(swapHtml, /cena di Domenica/i, 'evidenziata la cena del giorno prima');
  assert.match(swapHtml, /confirmSwap\('monday', 'lunch', 'D1'\)/, 'suggerimento applicabile con un tocco');
  openSwapModal('tuesday', 'dinner');
  const dinnerSwapHtml = document.getElementById('swap-options-list')._innerHTML;
  assert.match(dinnerSwapHtml, /batch-suggestion-item/, 'suggerimento batch presente nella sostituzione della cena');
  assert.match(dinnerSwapHtml, /pranzo di Mercoledì/i, 'evidenziato il pranzo del giorno dopo');
  openSwapModal('monday', 'breakfast');
  assert.doesNotMatch(document.getElementById('swap-options-list')._innerHTML, /batch-suggestion-item/, 'nessun suggerimento per colazione e spuntini');
  closeSwapModal();
}
openGeneratorModal();
assert.match(document.getElementById('generator-preview')._innerHTML, /Anteprima non ancora generata/, 'placeholder guida prima di lanciare il generatore');
// Pannello parametri: i controlli sono presenti e le preferenze persistono
// nelle impostazioni dispositivo (mai su Firestore).
{
  const paramsHtml = document.getElementById('generator-params')._innerHTML;
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'), /Bloccato = resta identico e conta nelle frequenze/, 'legenda tecnica rimossa dalla modale');
  assert.match(paramsHtml, /Quali pasti vuoi aggiornare\?/, 'titolo semplificato per gli slot');
  assert.match(paramsHtml, /Cucinare una volta e mangiare due volte/, 'titolo batch più semplice');
  assert.match(paramsHtml, /Quante volte può tornare la stessa ricetta\?/, 'titolo ripetizioni più semplice');
  assert.match(paramsHtml, /Vuoi più scelta tra pranzo e cena\?/, 'titolo cross-slot più semplice');
  assert.match(paramsHtml, /Proteine della settimana/, 'sezione avanzata con titolo più semplice');
  assert.match(paramsHtml, /generatorParamChanged\('batchPairs'/, 'controllo batch cena → pranzo presente');
  assert.match(paramsHtml, /value=\"7\"/, 'batch selezionabile fino a sette volte');
  assert.match(paramsHtml, /generatorParamChanged\('maxRepeats'/, 'controllo tetto ripetizioni presente');
  assert.match(paramsHtml, /generatorParamChanged\('allowCrossSlot'/, 'controllo cross-slot presente');
  assert.match(paramsHtml, /generatorSlotToggled\('lunch'/, 'toggle slot pranzo presente');
  assert.match(paramsHtml, /generatorConstraintChanged\('legumesMin'/, 'input frequenze min\/max presente');
  generatorSlotToggled('breakfast', false);
  assert.equal(getGeneratorPrefs().slots.breakfast, false, 'slot escluso salvato nelle preferenze');
  generatorParamChanged('batchPairs', 3);
  assert.equal(getGeneratorPrefs().batchPairs, 3, 'batch cena → pranzo salvato');
  generatorParamChanged('batchPairs', 9);
  assert.equal(getGeneratorPrefs().batchPairs, 7, 'batch limitato a sette volte');
  generatorConstraintChanged('legumesMin', '9');
  assert.equal(getGeneratorPrefs().constraints.legumesMin, 9, 'frequenze limitate a 0-14 pasti');
  generatorConstraintChanged('legumesMax', '20');
  assert.equal(getGeneratorPrefs().constraints.legumesMax, 14, 'massimo frequenze limitato a 14');
  assert.match(paramsHtml, /Affettati e carni miste/, 'riga Affettati e carni miste nelle frequenze');
  assert.match(paramsHtml, /generatorConstraintChanged\('curedMeatsMin'/, 'controllo min curedMeats presente');
  assert.match(paramsHtml, /generatorConstraintChanged\('curedMeatsMax'/, 'controllo max curedMeats presente');
  assert.match(paramsHtml, /max="14"/, 'input frequenze con max 14');
  generatorPrefsReset();
  assert.equal(getGeneratorPrefs().batchPairs, GENERATOR_PREFS_DEFAULTS.batchPairs, 'ripristino valori predefiniti');
  appState.deviceSettings.generatorPrefs = { constraints: { legumesMax: 4 }, slots: {} };
  assert.equal(getGeneratorPrefs().constraints.legumesMax, 14, 'migrazione: legumesMax vecchio default 4 → 14');
  assert.equal(getGeneratorPrefs().version, 2, 'versione assegnata dopo migrazione');
  appState.deviceSettings.generatorPrefs = { version: 2, constraints: { legumesMax: 10 }, slots: {} };
  assert.equal(getGeneratorPrefs().constraints.legumesMax, 10, 'preferenze personalizzate preservate dopo migrazione');
  generatorPrefsReset();
  const advDetails = document.getElementById('generator-advanced');
  if (advDetails) advDetails.open = true;
  generatorConstraintChanged('legumesMin', '4');
  assert.equal(document.getElementById('generator-advanced')?.open, true, 'pannello avanzato resta aperto dopo modifica');
  generatorSlotToggled('breakfast', true);
}
// I blocchi sono espliciti, vicini agli altri parametri e richiudibili.
assert.match(document.getElementById('generator-blocks')._innerHTML, /generator-locks/, 'sezione blocchi richiudibile presente');
assert.match(document.getElementById('generator-blocks')._innerHTML, /Lascia fissi alcuni pasti/, 'titolo semplice per i blocchi');
toggleGeneratorSlotLock('monday', 'lunch', true);
assert.match(document.getElementById('generator-blocks')._innerHTML, /Fisso/, 'badge per il singolo pasto mantenuto');
assert.match(document.getElementById('generator-blocks')._innerHTML, /Lascia questo pasto uguale/, 'tooltip del lucchetto semplificato');
toggleGeneratorDayLock('tuesday', true);
assert.match(document.getElementById('generator-blocks')._innerHTML, /Giorno fisso/, 'pill per l’intera giornata mantenuta');
toggleGeneratorDayLock('tuesday', false);
toggleGeneratorSlotLock('monday', 'lunch', false);
computeGeneratorProposal(false);
assert.match(document.getElementById('generator-preview')._innerHTML, /generator-diff/, 'anteprima con diff renderizzata');
assert.doesNotMatch(document.getElementById('generator-preview')._innerHTML, /↻ .*→/, 'anteprima semplificata senza confronto vecchio → nuovo');
openShareDialog();
openShareConflictPreview({ id: 'sh1', senderUsername: 'anna', recipes: [R('L9', 'Nuova', 'lunch', 'Uova')], includesPlan: false, plan: null }, 'recipes');

// Modalità modifica ricetta: select categoria proteica, niente input frequenza
openRecipeModal('L1', 'monday');
editMode = true;
currentModal.recipe = clone(currentModal.recipe);
renderModalContent();
{
  const editHtml = document.getElementById('modal-ingredients-list')._innerHTML;
  const timeHtml = document.getElementById('modal-time')._innerHTML;
  // Select per proteinCategory con opzione "Automatica dagli ingredienti"
  assert.match(timeHtml, /id="edit-recipe-category"/, 'select categoria presente nell\'editor');
  assert.match(timeHtml, /Automatica dagli ingredienti/, 'opzione fallback automatico presente');
  assert.match(timeHtml, /title="Opzionale: il generatore riconosce prima la proteina dagli ingredienti/, 'tooltip fallback presente');
  // Assenza del vecchio input Frequenza
  assert.doesNotMatch(timeHtml, /edit-recipe-frequency/, 'input frequenza rimosso dall\'editor');
  assert.doesNotMatch(editHtml, /edit-recipe-frequency/, 'nessun campo frequenza negli ingredienti');
}
// Libreria ricette: niente chip frequenza, etichetta leggibile per categoria
{
  renderRecipes();
  const libraryHtml = document.getElementById('view-recipes')._innerHTML;
  assert.doesNotMatch(libraryHtml, /frequency-chip.*recipe/i, 'nessun chip frequenza nella libreria ricette');
}
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

clearTimeout(priceHistoryTimer);
priceHistoryTimer = null;

startupChecks.then(() => {
  console.log('SMOKE OK — tutti i percorsi di rendering eseguiti senza errori');
}, error => {
  console.error(error);
  process.exit(1);
});
