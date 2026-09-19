'use strict';
/* Stato e rendering dell'app cliente (js/app.js) con DOM minimale:
 *  - campanella notifiche sempre visibile e accessibile, badge numerico;
 *  - il badge cambia SOLO quando lo stato server lo conferma;
 *  - sezione "Backup e annullamento" rimossa dalle Impostazioni;
 *  - pulsanti "Ricevute" rimossi (sostituiti dalla campanella);
 *  - "Profilo nutrizionale" solo con collegamento professionale attivo. */
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
    FieldValue: {
      serverTimestamp: () => ({}),
      arrayUnion: (...values) => values,
      arrayRemove: (...values) => values
    }
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

// Utente autenticato anche nel layer firebase.js (currentUser), così le query
// delle richieste in arrivo passano requireUser() come nell'app reale.
initFirebase();
observeAuthState(() => {});
appState.user = { uid: 'u1', email: 'mario@utenti.pianonutrizionale.app' };
appState.deviceSettings = {
  portionProfile: 'single', darkMode: false, lastOpenDate: null,
  recipeLibraryState: { searchQuery: '', openSections: {} }, shopCategoryOrder: []
};
appState.household = null;
appState.saasContext = { state: 'unassigned' };

const stamp = ms => ({ toMillis: () => ms });
const fakeShare = (id, sender = 'anna') => ({
  id, status: 'pending', senderUsername: sender, recipientUid: 'u1', recipeCount: 1, recipes: [], createdAt: stamp(1000)
});
const fakeLink = id => ({ id, status: 'pending', type: 'accountLink', senderUsername: 'anna', recipientUid: 'u1', createdAt: stamp(2000) });
const bell = () => document.getElementById('notification-bell');
const badge = () => document.getElementById('notification-badge');
const headerHtml = () => document.getElementById('global-header-container').innerHTML;

test('la campanella è sempre presente in header con nome accessibile e stato attesa', () => {
  renderGlobalHeader();
  assert.match(headerHtml(), /id="notification-bell"/);
  assert.match(headerHtml(), /aria-label="Notifiche: nessuna richiesta in attesa"/);
  assert.match(headerHtml(), /aria-haspopup="dialog"/);
  assert.match(headerHtml(), /aria-expanded="false"/);
  assert.match(headerHtml(), /aria-controls="incoming-shares-modal"/);
  assert.match(headerHtml(), /notification-badge hidden/, 'senza pendenti il badge non si vede');
  assert.doesNotMatch(headerHtml(), /tabindex/, 'il pulsante è nativamente focusabile da tastiera');
});

test('badge: conteggio numerico, etichetta parlante e formato 9+', () => {
  incomingRecipeShares = [fakeShare('s1')];
  incomingAccountLinks = [];
  updateNotificationBadge();
  assert.equal(badge().textContent, '1');
  assert.equal(badge().classList.contains('hidden'), false);
  assert.equal(bell().getAttribute('aria-label'), 'Notifiche: 1 richiesta in attesa');
  assert.equal(bell().classList.contains('has-pending'), true, 'campanella rossa con scuotimento quando ci sono pendenti');
  incomingAccountLinks = [fakeLink('l1')];
  updateNotificationBadge();
  assert.equal(badge().textContent, '2');
  assert.equal(bell().getAttribute('aria-label'), 'Notifiche: 2 richieste in attesa');
  incomingRecipeShares = Array.from({ length: 9 }, (_, i) => fakeShare(`s${i}`));
  updateNotificationBadge();
  assert.equal(badge().textContent, '9+');
  incomingRecipeShares = [];
  incomingAccountLinks = [];
  notificationsLoadError = false;
  updateNotificationBadge();
  assert.equal(bell().classList.contains('has-pending'), false, 'a zero pendenti la campanella torna al tema');
});

test('il badge si aggiorna solo a operazione conclusa, mai alla sola apertura', () => {
  incomingRecipeShares = [fakeShare('s1')];
  incomingAccountLinks = [fakeLink('l1')];
  syncIncomingRequests();
  assert.equal(badge().textContent, '2', 'pendenti visibili');
  // Simulazione di operazione fallita: gli elenchi restano, il badge non cala.
  updateNotificationBadge();
  assert.equal(badge().textContent, '2', 'un fallimento non cancella la notifica');
  // Simulazione di gestione completata server-side del collegamento.
  incomingAccountLinks = incomingAccountLinks.filter(item => item.id !== 'l1');
  syncIncomingRequests();
  assert.equal(badge().textContent, '1', 'badge aggiornato dopo il rifiuto riuscito');
  incomingRecipeShares = [];
  syncIncomingRequests();
  assert.equal(badge().classList.contains('hidden'), true, 'nessun pendente: badge nascosto');
});

test('offline: i pendenti noti non spariscono, il conteggio torna dal server', () => {
  incomingRecipeShares = [fakeShare('s1')];
  incomingAccountLinks = [];
  syncIncomingRequests();
  assert.equal(pendingNotificationCount(), 1);
  // Il listener va in errore (rete assente): stato congelato, non azzerato.
  incomingRecipeShares = [];
  markNotificationsLoadFailed();
  assert.equal(pendingNotificationCount(), 1, 'badge tenuto sull’ultimo conteggio noto');
  // Alla riconnessione lo stato reale torna a fare fede.
  applyIncomingRequests([fakeShare('s1'), fakeShare('s2')], []);
  assert.equal(pendingNotificationCount(), 2);
});

test('pannello: apertura/chiusura non marca nulla come letto e gestisce focus ed Escape', async () => {
  incomingRecipeShares = [];
  incomingAccountLinks = [];
  notificationsLoadError = false;
  // Lo stub getElementById auto-crea qualunque id: la guardia anti-duplicati
  // di setupTransferModals esce subito, quindi il binder Escape (idempotente
  // nell'app) viene attivato direttamente.
  setupTransferModals();
  bindTransferEscapeKeys();
  // Come il markup generato dall'app, le modali nascono chiuse: senza questa
  // precondizione lo stub auto-creato farebbe credere aperta la modale dei
  // conflitti e l'Escape chiuderebbe quella invece del pannello notifiche.
  document.getElementById('share-conflict-modal').classList.add('hidden');
  document.getElementById('incoming-shares-modal').classList.add('hidden');
  await openIncomingShares();
  const modal = document.getElementById('incoming-shares-modal');
  assert.equal(modal.classList.contains('hidden'), false, 'pannello aperto');
  assert.equal(bell().getAttribute('aria-expanded'), 'true');
  assert.match(document.getElementById('incoming-shares-list').innerHTML, /Nessuna richiesta/, 'testo esplicito senza notifiche');
  assert.equal(pendingNotificationCount(), 0, 'l’apertura non altera il conteggio');
  // Escape chiude il pannello e ripristina lo stato attesa della campanella.
  doc._on_keydown({ key: 'Escape' });
  assert.equal(modal.classList.contains('hidden'), true, 'Escape chiude il pannello');
  assert.equal(bell().getAttribute('aria-expanded'), 'false');
});

test('Impostazioni: niente sezione backup, annullamento o badge "Backup pronto"', () => {
  writeLocalJson('backup_meta', { operation: 'import-replace', description: 'test', createdAt: new Date().toISOString() });
  renderSettings();
  const html = document.getElementById('view-settings').innerHTML;
  assert.doesNotMatch(html, /Backup e annullamento/);
  assert.doesNotMatch(html, /Annulla ultima modifica/);
  assert.doesNotMatch(html, /Backup pronto|backup-status/);
  assert.match(html, /PROFESSIONISTA/, 'le altre impostazioni restano intatte');
  assert.match(html, /USCITA/);
  assert.doesNotMatch(html, /account-card/);
  assert.doesNotMatch(html, /profile-name-form/);
});

test('Impostazioni: niente sezione "Dati e sincronizzazione", import dal Ricettario', () => {
  renderSettings();
  const html = document.getElementById('view-settings').innerHTML;
  assert.doesNotMatch(html, /Dati e sincronizzazione/, 'sezione rimossa come "Backup e annullamento"');
  assert.doesNotMatch(html, /cloud-section|Importa o ripristina ricette/, 'niente input file/import dedicato nelle Impostazioni');
  assert.match(html, /ACCOUNT COLLEGATI/, 'il resto delle Impostazioni è intatto');
  assert.match(html, /USCITA/);
  assert.doesNotMatch(html, /account-card/);
  renderRecipes();
  const recipesHtml = document.getElementById('view-recipes').innerHTML;
  assert.match(recipesHtml, /openTransferModal/, 'l\u2019importazione resta disponibile dal Ricettario (modale Importa/Esporta)');
  const appSource = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  assert.match(appSource, /id="recipe-transfer-modal"/, 'modale Importa/Esporta installata');
  assert.match(appSource, /prepareRecipeImport\(this\.files\[0\]\)/, 'il ripristino/import ricette resta attivo');
});

test('pulsanti "Ricevute" rimossi da Impostazioni e Ricettario', () => {
  renderSettings();
  assert.doesNotMatch(document.getElementById('view-settings').innerHTML, /Ricevute/);
  renderRecipes();
  assert.doesNotMatch(document.getElementById('view-recipes').innerHTML, /Ricevute/);
});

test('Profilo nutrizionale: nascosto senza collegamento professionale attivo', () => {
  // Nessuno stato (in caricamento): nessun lampo della sezione.
  appState.clientLink = null;
  assert.equal(renderSaasProfileSection(), '', 'stato sconosciuto: sezione nascosta');
  appState.clientLink = { requests: [], link: null };
  assert.equal(renderSaasProfileSection(), '', 'nessun collegamento: sezione nascosta');
  appState.clientLink = { requests: [{ requestId: 'r1' }], link: null };
  assert.equal(renderSaasProfileSection(), '', 'richiesta pendente: sezione nascosta');
  appState.clientLink = { requests: [], link: null, error: true };
  assert.equal(renderSaasProfileSection(), '', 'stato in errore/offline: sezione nascosta');
  renderSettings();
  assert.doesNotMatch(document.getElementById('view-settings').innerHTML, /PROFILO NUTRIZIONALE/, 'nessuna sezione nelle Impostazioni');
});

test('Profilo nutrizionale: collegamento attivo mostra sezione informativa o profilo', () => {
  appState.saasContext = { state: 'unassigned' };
  appState.clientLink = { requests: [], link: { organizationId: 'org-1', organizationName: 'Studio A', clientId: 'c1' } };
  const informative = renderSaasProfileSection();
  assert.match(informative, /PROFILO NUTRIZIONALE/);
  assert.match(informative, /Dosi originali attive/, 'collegamento attivo senza profilo: sezione informativa');
  // Profilo assegnato e verificato.
  appState.saasContext = {
    state: 'assigned',
    profile: { structureId: 'str-1', structureName: 'Base proteine', structureRevisionId: '4', schemaVersion: 1 }
  };
  appState.saasPolicy = { mode: 'assigned', migrationRequired: false };
  const assigned = renderSaasProfileSection();
  assert.match(assigned, /Profilo verificato/);
  assert.match(assigned, /Base proteine · revisione n\. 4/);
  // Nuovo profilo da confermare: flusso di conferma preservato.
  appState.saasPolicy = { mode: 'pending-confirmation', migrationRequired: true };
  const pending = renderSaasProfileSection();
  assert.match(pending, /Nuovo profilo da confermare/);
  assert.match(pending, /openProfileUpdateModal\(\)/);
});

test('Profilo nutrizionale: flag SaaS disattivato non mostra mai la sezione', () => {
  const previous = window.PIANO_SAAS_CONFIG.enabled;
  window.PIANO_SAAS_CONFIG.enabled = false;
  appState.clientLink = { requests: [], link: { organizationId: 'org-1' } };
  try {
    assert.equal(renderSaasProfileSection(), '');
  } finally {
    window.PIANO_SAAS_CONFIG.enabled = previous;
  }
});

test('errore collegamento non viene attribuito alla modalità offline e consente riprova', async () => {
  const previous = window.callSaasFunction;
  const previousLocation = window.location;
  window.location = { hash: '#settings' };
  window.callSaasFunction = async () => { throw new Error('internal'); };
  try {
    await refreshClientLinkState();
    assert.equal(appState.clientLink.error, true);
    const html = renderClientLinkSection();
    assert.match(html, /Stato del collegamento non disponibile/);
    assert.doesNotMatch(html, /offline|Nessun collegamento/);
    assert.match(html, /onclick="refreshClientLinkState\(\)"/);
    window.callSaasFunction = async () => ({ requests: [], link: { organizationId: 'org-1', organizationName: 'Studio ripristinato', clientId: 'c1' } });
    await refreshClientLinkState();
    assert.match(renderClientLinkSection(), /Studio ripristinato/);
    assert.doesNotMatch(renderClientLinkSection(), /Stato del collegamento non disponibile/);
  } finally {
    window.callSaasFunction = previous;
    window.location = previousLocation;
  }
});

test('observer household: gli snapshot identici non riapplicano lo stato', () => {
  const previousObserve = global.observeSharedDataChanges;
  const previousUser = appState.user;
  const previousPlan = appState.plan;
  const previousRecipes = appState.recipes;
  let sharedCallback = null;
  global.observeSharedDataChanges = callback => { sharedCallback = callback; return () => {}; };
  const planA = createEmptyWeeklyPlan();
  const recipesA = [{ id: 'r1', name: 'Primo piatto', slot: 'lunch', ingredients: [], steps: [] }];
  try {
    appState.user = { uid: 'u1', email: 'mario@utenti.pianonutrizionale.app' };
    bindSharedDataObserver();
    assert.equal(typeof sharedCallback, 'function', 'callback registrato');
    // Primo snapshot: applicato.
    sharedCallback("plan", planA);
    const planRef = appState.plan;
    assert.notEqual(planRef, previousPlan);
    // Snapshot con contenuto IDENTICO (oggetto nuovo): niente riapplicazione.
    sharedCallback("plan", JSON.parse(JSON.stringify(planA)));
    assert.equal(appState.plan, planRef, 'contenuto identico: non riapplicato');
    // Ricette: primo snapshot applicato, il secondo identico salta.
    sharedCallback("recipes", recipesA);
    const recipesRef = appState.recipes;
    const recipesByIdRef = appState.recipesById;
    sharedCallback("recipes", JSON.parse(JSON.stringify(recipesA)));
    assert.equal(appState.recipes, recipesRef, 'contenuto identico: non riapplicato');
    assert.equal(appState.recipesById, recipesByIdRef, 'indice non ricostruito');
    // Cambio reale (monday parte "training" nel piano vuoto): applicato.
    const planB = { ...planA, days: { ...planA.days, monday: { ...planA.days.monday, type: 'rest' } } };
    sharedCallback("plan", planB);
    assert.notEqual(appState.plan, planRef, 'cambio reale applicato');
  } finally {
    global.observeSharedDataChanges = previousObserve;
    appState.user = previousUser;
    appState.plan = previousPlan;
    appState.recipes = previousRecipes;
  }
});

test('avvio rapido: dati e contesto invariati → nessuna riapplicazione né re-render', async () => {
  const previousLocation = window.location;
  window.location = { hash: '#week' };
  const previousUser = appState.user;
  const previousContext = appState.saasContext;
  const previousPolicy = appState.saasPolicy;
  const previousPlan = appState.plan;
  const previousRecipes = appState.recipes;
  const previousShopping = appState.shopping;
  const previousHeader = renderGlobalHeader;
  const previousRoute = handleRoute;
  const previousPrepare = global.prepareDataScope;
  const previousRecipesFn = global.getRecipeCatalog;
  const previousPlanFn = global.getWeeklyPlan;
  const previousShoppingFn = global.getShoppingListCloud;
  const previousSaasFn = global.callSaasFunction;
  const user = { uid: 'u1', email: 'mario@utenti.pianonutrizionale.app' };
  const profile = {
    clientProfileId: 'c1', assignmentId: 'a1', schemaVersion: 1,
    structureId: 's1', structureRevisionId: 'rev1', structureChecksum: 'chk-1',
    structureName: 'Struttura base', ingredientCatalogVersion: 1,
    structureRevision: {
      revisionId: 'rev1',
      dietPlan: PianoDomain.createEmptyDietPlan({ days: [
        PianoDomain.createDietPlanDay('training', { dayId: 't', meals: [
          PianoDomain.createDietPlanMeal('lunch', { options: [
            PianoDomain.createDietPlanOption({ type: 'family-block', blocks: [
              PianoDomain.createDietPlanBlock({ referenceFamilyId: 'cereali', referenceAmount: { value: 80, unit: 'g' } })
            ] })
          ] })
        ] })
      ] })
    },
    catalog: { categories: [], families: [{ familyId: 'cereali', displayName: 'Cereali', categoryId: 'carb', sortOrder: 0 }], ingredients: [] },
    compatibleClientSchema: 7
  };
  const recipesA = [{ id: 'r1', name: 'Primo piatto', slot: 'lunch', ingredients: [], steps: [] }];
  const planA = createEmptyWeeklyPlan();
  // Snapshot confermato: il contesto "assigned" non richiede mai nuova conferma.
  planA.nutritionSnapshot = window.PianoSaas.snapshotFor(profile);
  const shoppingA = { selectedMeals: { monday: ['breakfast'] }, includePantry: false, excludedItems: [], customQuantities: {}, itemOrder: {} };
  let profileStub = { state: 'unassigned' };
  const serverData = { recipes: recipesA, plan: planA, shopping: shoppingA };
  let headerRenders = 0;
  let routeRenders = 0;
  // Il DOM minimale non ha addEventListener globale: serve a setupRouter.
  const previousAddEventListener = global.addEventListener;
  global.addEventListener = () => {};
  renderGlobalHeader = () => { headerRenders += 1; };
  handleRoute = () => { routeRenders += 1; };
  global.prepareDataScope = async () => { clearDataScope(); return null; };
  global.getRecipeCatalog = async () => serverData.recipes;
  global.getWeeklyPlan = async () => serverData.plan;
  global.getShoppingListCloud = async () => serverData.shopping;
  global.callSaasFunction = async name => (name === 'getMyAssignedProfile' ? profileStub : { requests: [], link: null });
  try {
    // Avvio rapido: stato applicato dalla cache locale.
    appState.saasContext = { state: 'unassigned' };
    applyState(recipesA, planA, shoppingA);
    assert.equal(headerRenders, 1);
    const routesAfterBoot = routeRenders;
    // Server identico alla cache + contesto invariato: niente ri-apply né re-render.
    await loadUserData(user, { silent: true });
    assert.equal(headerRenders, 1, 'niente cambiamenti: nessuna riapplicazione');
    assert.equal(routeRenders, routesAfterBoot, 'niente cambiamenti: nessun re-render');
    // Stessi dati ma contesto CAMBIATO (profilo assegnato): si riapplica.
    profileStub = { state: 'assigned', profile };
    await loadUserData(user, { silent: true });
    assert.equal(headerRenders, 2, 'contesto cambiato: riapplicazione');
    assert.equal(appState.saasPolicy.mode, 'assigned', 'policy del profilo confermato');
    assert.equal(routeRenders, routesAfterBoot + 1, 're-render solo per il cambio reale');
    // Tutto di nuovo invariato (dati e contesto): di nuovo skip.
    await loadUserData(user, { silent: true });
    assert.equal(headerRenders, 2, 'secondo refresh invariato: nessuna riapplicazione');
    assert.equal(routeRenders, routesAfterBoot + 1, 'nessun re-render aggiuntivo');
  } finally {
    window.location = previousLocation;
    appState.user = previousUser;
    appState.saasContext = previousContext;
    appState.saasPolicy = previousPolicy;
    appState.plan = previousPlan;
    appState.recipes = previousRecipes;
    appState.shopping = previousShopping;
    renderGlobalHeader = previousHeader;
    handleRoute = previousRoute;
    global.addEventListener = previousAddEventListener;
    global.prepareDataScope = previousPrepare;
    global.getRecipeCatalog = previousRecipesFn;
    global.getWeeklyPlan = previousPlanFn;
    global.getShoppingListCloud = previousShoppingFn;
    global.callSaasFunction = previousSaasFn;
    for (const key of Object.keys(localStorage._data)) delete localStorage._data[key];
  }
});

test('stato collegamento: la cache per utente idrata l’avvio e il successo la aggiorna', async () => {
  const previous = window.callSaasFunction;
  const previousLocation = window.location;
  const previousUser = appState.user;
  const previousLink = appState.clientLink;
  const key = 'pn_u1_client_link';
  const storedKey = localStorage.getItem(key);
  window.location = { hash: '#week' };
  appState.user = { uid: 'u1', email: 'mario@utenti.pianonutrizionale.app' };
  appState.clientLink = null;
  const calls = [];
  const pending = [];
  window.callSaasFunction = (name, data, options) => {
    calls.push({ name, silent: options?.silent });
    return new Promise(resolve => pending.push({ name, resolve }));
  };
  const drain = value => pending.shift().resolve(value);
  try {
    // Sessione precedente: l'ultimo stato verificato è in cache locale.
    localStorage.setItem(key, JSON.stringify({ requests: [{ id: 'r1', status: 'pending' }], link: null }));
    // L'avvio idrata subito dalla cache (badge mai a zero) senza aspettare il server.
    const bootRefresh = refreshClientLinkState({ silent: true });
    assert.equal(appState.clientLink.requests.length, 1, 'idratazione istantanea dalla cache');
    assert.equal(calls[0].silent, true, 'il refresh di avvio è silent');
    // Il server risponde: lo stato fresco sostituisce la cache (write-through).
    drain({ requests: [], link: { organizationId: 'org-9' } });
    await bootRefresh;
    assert.equal(appState.clientLink.link.organizationId, 'org-9');
    assert.equal(JSON.parse(localStorage.getItem(key)).link.organizationId, 'org-9', 'write-through al successo');
    // Riprova esplicita (senza opzioni): overlay abilitata, stessa cache riutilizzata.
    appState.clientLink = null;
    const explicitRefresh = refreshClientLinkState();
    assert.equal(appState.clientLink.link.organizationId, 'org-9', 'riutilizza la cache appena scritta');
    assert.notEqual(calls[1].silent, true, "l'operazione esplicita non è silent");
    drain({ requests: [], link: null });
    await explicitRefresh;
  } finally {
    window.callSaasFunction = previous;
    window.location = previousLocation;
    appState.user = previousUser;
    appState.clientLink = previousLink;
    if (storedKey === null) localStorage.removeItem(key);
    else localStorage.setItem(key, storedKey);
  }
});
