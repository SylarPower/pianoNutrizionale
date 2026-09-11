'use strict';
/* Centro notifiche: partizione delle richieste in arrivo e listener realtime
 * (js/firebase.js). Il badge e il pannello devono riflettere SOLO documenti
 * server pendenti: le richieste gestite (status diverso da pending o doc
 * eliminato) spariscono; le query restano limitate al destinatario. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// ---- Stub Firestore con una sola collezione "recipeShares" interrogabile ----

const docs = new Map(); // id -> data
const queries = [];

function snapshotFor(ids) {
  return {
    forEach: fn => ids.forEach(id => fn({ id, data: () => docs.get(id) }))
  };
}

function makeQuery(field, value) {
  const listener = { next: null, error: null };
  const query = {
    field, value,
    onSnapshot(next, error) {
      listener.next = next;
      listener.error = error;
      query.listener = listener;
      return () => { listener.closed = true; };
    },
    get: async () => {
      const ids = [...docs.keys()].filter(id => docs.get(id).recipientUid === value);
      return snapshotFor(ids);
    }
  };
  return query;
}

global.window = global;
global.firebase = {
  apps: [{}],
  initializeApp: () => {},
  appCheck: () => ({ activate: () => {} }),
  firestore: Object.assign(() => ({
    collection: name => ({
      where: (field, op, value) => {
        const query = makeQuery(field, value);
        query.name = name;
        queries.push(query);
        return query;
      },
      doc: () => ({ set: async () => {}, get: async () => ({ exists: false, data: () => ({}) }) })
    }),
    doc: () => ({ set: async () => {}, get: async () => ({ exists: false, data: () => ({}) }), delete: async () => {} }),
    enablePersistence: async () => {},
    batch: () => ({ set: () => {}, update: () => {}, delete: () => {}, commit: async () => {} })
  }), {
    FieldValue: {
      serverTimestamp: () => ({}),
      arrayUnion: (...values) => values,
      arrayRemove: (...values) => values
    }
  }),
  auth: Object.assign(() => ({
    setPersistence: async () => {},
    signInWithEmailAndPassword: async email => ({}),
    signOut: async () => {},
    onAuthStateChanged: fn => { fn(global.__fakeUser); return () => {}; }
  }), { Auth: { Persistence: { LOCAL: 'local' } } })
};
global.__fakeUser = { uid: 'u-recipient', email: 'anna@utenti.pianonutrizionale.app' };
global.localStorage = {
  _data: {},
  getItem(key) { return key in this._data ? this._data[key] : null; },
  setItem(key, value) { this._data[key] = String(value); },
  removeItem(key) { delete this._data[key]; }
};

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/firebase.js'), 'utf8'), { filename: 'js/firebase.js' });

const stamp = ms => ({ toMillis: () => ms });

// Simula l'utente autenticato (currentUser di firebase.js si popola solo
// tramite l'observer dell'Auth).
function signInFakeUser() {
  initFirebase();
  observeAuthState(() => {});
}

test('partizione: ricette e collegamenti, solo pending, ordinati desc', () => {
  docs.clear();
  docs.set('share-old', { status: 'pending', recipientUid: 'u-recipient', senderUsername: 'uno', recipeCount: 2, createdAt: stamp(1000) });
  docs.set('link-new', { status: 'pending', type: 'accountLink', recipientUid: 'u-recipient', senderUsername: 'due', recipeCount: 0, createdAt: stamp(3000) });
  docs.set('share-new', { status: 'pending', recipientUid: 'u-recipient', senderUsername: 'tre', recipeCount: 5, createdAt: stamp(2000) });
  docs.set('share-accepted', { status: 'accepted', recipientUid: 'u-recipient', createdAt: stamp(4000) });
  // Il filtro sul destinatario lo fa la query Firestore (recipientUid == uid);
  // la partizione lavora sul risultato e separa tipo/stato come in produzione.
  const snapshot = snapshotFor(['share-old', 'link-new', 'share-new', 'share-accepted']);
  const { recipeShares, accountLinks } = pendingRequestsFromSnapshot(snapshot);
  assert.deepEqual(recipeShares.map(item => item.id), ['share-new', 'share-old'], 'ricette pendenti ordinate per data desc');
  assert.deepEqual(accountLinks.map(item => item.id), ['link-new'], 'collegamento account riconosciuto via type');
  assert.ok(!recipeShares.some(item => item.id === 'share-accepted'), 'richiesta gestita non più pendente');
});

test('listener realtime: query limitata al destinatario e unsubscribe pulito', async () => {
  signInFakeUser();
  queries.length = 0;
  let lastError = null;
  let lastSnapshot = null;
  const unsubscribe = observeIncomingRequests(snapshot => { lastSnapshot = snapshot; }, error => { lastError = error; });
  assert.equal(queries.length, 1, 'una sola query sottoscritta');
  assert.equal(queries[0].name, 'recipeShares');
  assert.equal(queries[0].field, 'recipientUid', 'nessuna scansione globale: filtro sul destinatario');
  assert.equal(queries[0].value, 'u-recipient');
  queries[0].listener.next(snapshotFor(['link-new']));
  assert.ok(lastSnapshot, 'snapshot iniziale consegnato');
  unsubscribe();
  assert.equal(queries[0].listener.closed, true);
  assert.equal(lastError, null);
});

test('getPendingIncomingRequests passa dalla stessa partizione del listener', async () => {
  signInFakeUser();
  const { recipeShares, accountLinks } = await getPendingIncomingRequests();
  assert.deepEqual(recipeShares.map(item => item.id), ['share-new', 'share-old']);
  assert.deepEqual(accountLinks.map(item => item.id), ['link-new']);
});
