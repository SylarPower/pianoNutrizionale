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
    limit: () => makeQuery(colPath),
    get: async () => ({
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
    limit: () => makeQuery(colPath)
  };
}

const dbStub = {
  collection: name => makeCollectionRef(name),
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
