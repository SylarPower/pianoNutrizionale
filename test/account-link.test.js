'use strict';
/* Test di regressione sul collegamento account (js/firebase.js).
 * Bug coperto: dopo "Collega account" con base "Usa la settimana di [mittente]"
 * le ricette sparivano da ENTRAMBI gli account perché il documento condiviso
 * households/{id}/content/recipeCatalog poteva restare (o venire scritto) vuoto.
 * Firestore è simulato con uno store in memoria indicizzato per percorso. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// ---- Stub Firestore basato su percorsi ----

const store = new Map();
const ops = [];

function makeSnapshot(docPath) {
  return {
    id: docPath.split('/').pop(),
    exists: store.has(docPath),
    data: () => store.get(docPath)
  };
}

function makeDocRef(docPath) {
  return {
    path: docPath,
    collection: name => makeCollectionRef(`${docPath}/${name}`),
    get: async () => makeSnapshot(docPath),
    set: async data => { store.set(docPath, data); ops.push({ type: 'set', path: docPath, data }); },
    update: async data => { ops.push({ type: 'update', path: docPath, data }); },
    delete: async () => { store.delete(docPath); ops.push({ type: 'delete', path: docPath }); }
  };
}

function makeQuery(colPath) {
  return {
    where: () => makeQuery(colPath),
    orderBy: () => makeQuery(colPath),
    limit: () => makeQuery(colPath),
    get: async () => ({
      _logged: ops.push({ type: 'query', path: colPath }),
      forEach: fn => {
        const depth = colPath.split('/').length + 1;
        for (const [docPath, data] of store) {
          if (docPath.startsWith(`${colPath}/`) && docPath.split('/').length === depth) {
            fn({ id: docPath.split('/').pop(), data: () => data });
          }
        }
      }
    })
  };
}

function makeCollectionRef(colPath) {
  return {
    doc: id => makeDocRef(`${colPath}/${id || `auto-${Math.random().toString(36).slice(2)}`}`),
    where: () => makeQuery(colPath),
    orderBy: () => makeQuery(colPath),
    limit: () => makeQuery(colPath)
  };
}

const dbStub = {
  collection: name => makeCollectionRef(name),
  // L'SDK Firestore espone anche doc(pathString) / collection(pathString)
  // con percorso completo a slash: serve ai builder di riferimenti.
  doc: pathString => makeDocRef(pathString),
  batch: () => {
    const pending = [];
    return {
      set: (ref, data) => pending.push({ type: 'set', path: ref.path, data }),
      update: (ref, data) => pending.push({ type: 'update', path: ref.path, data }),
      delete: ref => pending.push({ type: 'delete', path: ref.path }),
      commit: async () => pending.forEach(op => {
        if (op.type === 'set') store.set(op.path, op.data);
        if (op.type === 'delete') store.delete(op.path);
        ops.push(op);
      })
    };
  },
  runTransaction: async fn => fn({
    get: async ref => makeSnapshot(ref.path),
    set: (ref, data) => store.set(ref.path, data),
    delete: ref => store.delete(ref.path)
  }),
  enablePersistence: async () => {}
};

// ---- Ambiente globale minimo per js/firebase.js ----

global.window = global;
global.localStorage = {
  _data: {},
  getItem: key => (key in global.localStorage._data ? global.localStorage._data[key] : null),
  setItem: (key, value) => { global.localStorage._data[key] = String(value); },
  removeItem: key => { delete global.localStorage._data[key]; }
};

const firestoreFn = () => dbStub;
firestoreFn.FieldValue = {
  serverTimestamp: () => 'SERVER_TS',
  arrayUnion: (...values) => ({ __arrayUnion: values }),
  arrayRemove: (...values) => ({ __arrayRemove: values })
};
const authFn = () => ({
  setPersistence: async () => {},
  onAuthStateChanged: fn => { fn({ uid: 'u2', email: 'anna@utenti.pianonutrizionale.app' }); return () => {}; }
});
authFn.Auth = { Persistence: { LOCAL: 'local' } };
global.firebase = {
  apps: [{}],
  initializeApp: () => {},
  firestore: firestoreFn,
  auth: authFn
};

for (const file of ['js/data.js', 'js/firebase.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
}
assert.equal(initFirebase(), true);
observeAuthState(() => {});

// ---- Dati di prova ----

function sampleRecipe(id, name) {
  return {
    id, name, slot: 'lunch',
    ingredients: [{ name: 'Riso', portions: { manTraining: '90g' } }],
    steps: ['Cuoci']
  };
}
const samplePlan = { schemaVersion: 4, days: { monday: { type: 'training' } } };

function seedPendingLink(overrides = {}) {
  store.set('recipeShares/link1', {
    type: 'accountLink',
    status: 'pending',
    senderUid: 'u1',
    senderUsername: 'mario',
    recipientUid: 'u2',
    recipientUsername: 'anna',
    sourceHouseholdId: 'hh1',
    sourceMemberUids: ['u1'],
    sourceMemberUsernames: ['mario'],
    recipes: [sampleRecipe('L1', 'Riso del mittente')],
    recipeCount: 1,
    includesPlan: true,
    plan: samplePlan,
    shoppingList: {},
    ...overrides
  });
}

function reset() {
  store.clear();
  ops.length = 0;
  global.localStorage._data = {};
  clearDataScope();
}

// ---- Test ----

test('acceptAccountLink con base "sender" scrive SEMPRE i dati del mittente nel documento condiviso', async () => {
  reset();
  seedPendingLink();
  store.set('households/hh1', { ownerUid: 'u1', memberUids: ['u1'], memberUsernames: ['mario'] });

  await acceptAccountLink('link1', 'sender', [sampleRecipe('L2', 'Riso del destinatario')], samplePlan, null);

  const sharedCatalog = store.get('households/hh1/content/recipeCatalog');
  assert.ok(sharedCatalog, 'il catalogo condiviso deve essere scritto nel batch di collegamento');
  assert.equal(sharedCatalog.recipeCount, 1);
  assert.equal(sharedCatalog.recipes[0].id, 'L1', 'deve contenere le ricette della base scelta (mittente)');
  assert.ok(store.get('households/hh1/config/weeklyPlan'), 'il piano condiviso deve essere scritto');
  assert.ok(store.get('households/hh1/config/shoppingList'), 'la lista spesa condivisa deve essere scritta');
  assert.ok(!store.has('recipeShares/link1'), 'la richiesta va consumata nello stesso batch');
  assert.ok(ops.some(op => op.type === 'update' && op.path === 'households/hh1'), 'il destinatario entra nella household via update atomico');
});

test('acceptAccountLink blocca il collegamento se la base scelta ha 0 ricette e l\'altra ne ha', async () => {
  reset();
  seedPendingLink({ recipes: [], recipeCount: 0 });
  store.set('households/hh1', { ownerUid: 'u1', memberUids: ['u1'], memberUsernames: ['mario'] });

  await assert.rejects(
    () => acceptAccountLink('link1', 'sender', [sampleRecipe('L2', 'Riso del destinatario')], samplePlan, null),
    /non contiene ricette/
  );
  assert.ok(!store.has('households/hh1/content/recipeCatalog'), 'nessuna scrittura condivisa deve avvenire');
  assert.ok(store.has('recipeShares/link1'), 'la richiesta resta disponibile per la scelta corretta');
  assert.equal(ops.length, 0, 'l\'operazione deve fermarsi prima di qualsiasi scrittura');
});

test('acceptAccountLink blocca anche la base "recipient" vuota quando il mittente ha ricette', async () => {
  reset();
  seedPendingLink();

  await assert.rejects(
    () => acceptAccountLink('link1', 'recipient', [], samplePlan, null),
    /non contiene ricette/
  );
  assert.equal(ops.length, 0);
});

test('getRecipeCatalog non inizializza mai un catalogo vuoto sul documento condiviso mancante', async () => {
  reset();
  store.set('households/hh-shared', { ownerUid: 'u1', memberUids: ['u1', 'u2'], memberUsernames: ['mario', 'anna'] });
  const household = await prepareDataScope();
  assert.equal(household.id, 'hh-shared');

  const recipes = await getRecipeCatalog();
  assert.deepEqual(recipes, []);
  assert.ok(!store.has('households/hh-shared/content/recipeCatalog'), 'il documento condiviso non deve essere creato vuoto');
  assert.equal(ops.filter(op => op.type === 'set').length, 0, 'nessuna scrittura deve partire dalla lettura');
});

test('getRecipeCatalog inizializza il catalogo vuoto SOLO in ambito personale', async () => {
  reset();

  const recipes = await getRecipeCatalog();
  assert.deepEqual(recipes, []);
  const personal = store.get('users/u2/content/recipeCatalog');
  assert.ok(personal, 'il primo avvio personale crea il documento privato');
  assert.equal(personal.initializedEmpty, true);
  assert.ok(!Array.from(store.keys()).some(key => key.startsWith('households/')), 'nessun documento household coinvolto');
});

test('saveBackup personale + restore in household: ripristina la copia personale senza sovrascrivere i dati condivisi', async () => {
  reset();
  const soloRecipes = [sampleRecipe('L9', 'Ricetta personale prima del collegamento')];
  await saveBackup(soloRecipes, samplePlan, { selectedMeals: {}, includePantry: true, excludedItems: [], customQuantities: {} }, 'account-link-accept', 'Prima del collegamento');
  const backupDoc = store.get('users/u2/backups/previous');
  assert.equal(backupDoc.scope, 'personal', 'il backup salva il contesto originale');

  store.set('households/hh-live', { ownerUid: 'u1', memberUids: ['u1', 'u2'], memberUsernames: ['mario', 'anna'] });
  store.set('households/hh-live/content/recipeCatalog', {
    schemaVersion: 5,
    recipes: [sampleRecipe('L1', 'Ricetta condivisa')],
    recipeCount: 1
  });
  await prepareDataScope();
  assert.equal(getCurrentHousehold().id, 'hh-live');

  const restored = await restoreBackupAtomic();
  assert.equal(restored.catalog.recipes[0].id, 'L9');
  assert.ok(!store.has('users/u2/backups/previous'), 'il backup one-shot viene consumato');
  assert.equal(store.get('users/u2/content/recipeCatalog').recipes[0].id, 'L9', 'il catalogo personale viene ripristinato');
  assert.equal(store.get('households/hh-live/content/recipeCatalog').recipes[0].id, 'L1', 'i dati condivisi attuali non vengono sovrascritti');
  assert.ok(ops.some(op => op.type === 'update' && op.path === 'households/hh-live'), 'il restore esce dalla household corrente');
  assert.equal(getCurrentHousehold(), null, 'dopo il restore l\'utente torna all\'ambito personale');
});

// ---- Casella condivisioni: query unica per ricette e collegamenti account ----

test('getPendingIncomingRequests: una sola query server ripartisce ricette e collegamenti', async () => {
  reset();
  const ts = millis => ({ toMillis: () => millis });
  // Condivisione storica di sole ricette: NESSUN campo `type` (le regole lo
  // consentono). Deve finire tra le ricette, non tra i collegamenti account.
  store.set('recipeShares/legacy1', {
    status: 'pending',
    senderUid: 'u1',
    senderUsername: 'mario',
    recipientUid: 'u2',
    recipes: [sampleRecipe('L1', 'Riso storico')],
    recipeCount: 1,
    createdAt: ts(1000)
  });
  store.set('recipeShares/share2', {
    type: 'recipe',
    status: 'pending',
    senderUid: 'u3',
    senderUsername: 'luca',
    recipientUid: 'u2',
    recipes: [sampleRecipe('L2', 'Riso nuovo')],
    recipeCount: 1,
    createdAt: ts(3000)
  });
  store.set('recipeShares/link2', {
    type: 'accountLink',
    status: 'pending',
    senderUid: 'u1',
    senderUsername: 'mario',
    recipientUid: 'u2',
    recipes: [],
    createdAt: ts(2000)
  });
  // Richiesta già consumata: non deve comparire in nessun elenco.
  store.set('recipeShares/done1', {
    status: 'accepted',
    recipientUid: 'u2',
    createdAt: ts(4000)
  });

  const { recipeShares, accountLinks } = await getPendingIncomingRequests();

  const queries = ops.filter(op => op.type === 'query' && op.path === 'recipeShares');
  assert.equal(queries.length, 1, 'una singola apertura deve eseguire UNA sola query su recipeShares');

  assert.deepEqual(recipeShares.map(item => item.id), ['share2', 'legacy1'], 'ricette ordinate per createdAt decrescente; la condivisione senza `type` resta tra le ricette');
  assert.deepEqual(accountLinks.map(item => item.id), ['link2']);
  assert.equal(recipeShares[1].recipes[0].name, 'Riso storico', 'la forma { id, ...data } resta invariata');
});

test('getPendingRecipeShares e getPendingAccountLinks restano compatibili sopra la query condivisa', async () => {
  reset();
  store.set('recipeShares/legacy1', {
    status: 'pending',
    recipientUid: 'u2',
    recipes: [sampleRecipe('L1', 'Riso storico')],
    createdAt: { toMillis: () => 1000 }
  });
  store.set('recipeShares/link2', {
    type: 'accountLink',
    status: 'pending',
    recipientUid: 'u2',
    createdAt: { toMillis: () => 2000 }
  });

  const shares = await getPendingRecipeShares();
  assert.deepEqual(shares.map(item => item.id), ['legacy1']);
  const links = await getPendingAccountLinks();
  assert.deepEqual(links.map(item => item.id), ['link2']);
});
