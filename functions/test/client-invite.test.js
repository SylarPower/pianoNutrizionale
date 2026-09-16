'use strict';
/* Inviti e associazioni (requisiti utente):
 *  - un nutritionist NON può invitare un altro nutritionist: l'invito di
 *    professionisti resta del creatore (platformMembers admin);
 *  - il nutritionist invita clienti solo per sé (nessun destinatario diverso);
 *  - l'invito a un cliente senza account produce un link monouso (token in
 *    chiaro una volta sola) e prepara il profilo cliente già associato al
 *    nutritionist che ha invitato;
 *  - alla registrazione dal link (username + password, nessun dato in più) il
 *    profilo diventa attivo e nasce accountClientLinks: associazione automatica.
 * Le callable reali girano su un Firestore finto con transazioni. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const domain = require('../src/domain');

const ORG = 'pianoNutrizionale';

function harness(entries = {}) {
  const store = new Map(Object.entries(entries).map(([key, value]) => [key, { ...value }]));
  const reads = [];
  const writes = [];
  const value = path => store.get(path);
  const snapshot = path => ({
    id: path.split('/').pop(),
    exists: store.has(path),
    data: () => value(path),
    ref: {
      path,
      update: async patch => { writes.push(`update ${path}`); store.set(path, { ...value(path), ...patch }); },
      parent: { parent: { id: path.split('/').at(-3) } }
    }
  });
  const matches = (key, path, filter, limit) => key.startsWith(`${path}/`)
    && key.split('/').length === path.split('/').length + 1
    && (!filter || value(key)[filter[0]] === filter[1]);
  const collection = path => {
    let filter = null;
    let max = Infinity;
    const query = {
      select() { return query; },
      where(field, op, val) { assert.equal(op, '=='); filter = [field, val]; return query; },
      limit(n) { max = n; return query; },
      async get() {
        reads.push(path);
        return { empty: false, size: 0, docs: [...store.keys()].filter(key => matches(key, path, filter, max)).slice(0, max).map(snapshot) };
      }
    };
    return query;
  };
  const db = {
    // Il recupero invito cerca per tokenHash nella collection group: un invito
    // pendente deve essere unico (size > 1 = invito ambiguo).
    collectionGroup(name) {
      assert.equal(name, 'invitations');
      let filter = null;
      let max = Infinity;
      const query = {
        where(field, op, val) { assert.equal(op, '=='); filter = [field, val]; return query; },
        limit(n) { max = n; return query; },
        async get() {
          const docs = [...store.keys()]
            .filter(key => key.split('/').at(-2) === name && (!filter || value(key)[filter[0]] === filter[1]))
            .slice(0, max).map(snapshot);
          return { empty: docs.length === 0, size: docs.length, docs };
        }
      };
      return query;
    },
    doc(path) {
      return {
        path,
        id: path.split('/').pop(),
        get: async () => { reads.push(path); return snapshot(path); },
        create: async data => { writes.push(`create ${path}`); store.set(path, data); },
        set: async (data, options) => {
          writes.push(`set ${path}`);
          store.set(path, options?.merge ? { ...value(path), ...data } : data);
        },
        update: async patch => { writes.push(`update ${path}`); store.set(path, { ...value(path), ...patch }); },
        delete: async () => { writes.push(`delete ${path}`); store.delete(path); }
      };
    },
    collection,
    async runTransaction(fn) {
      const tx = {
        get: async ref => { reads.push(ref.path); return snapshot(ref.path); },
        create: (ref, data) => { writes.push(`create ${ref.path}`); store.set(ref.path, data); },
        set: (ref, data, options) => {
          writes.push(`set ${ref.path}`);
          store.set(ref.path, options?.merge ? { ...value(ref.path), ...data } : data);
        },
        update: (ref, patch) => { writes.push(`update ${ref.path}`); store.set(ref.path, { ...value(ref.path), ...patch }); },
        delete: ref => { writes.push(`delete ${ref.path}`); store.delete(ref.path); }
      };
      return fn(tx);
    }
  };
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const context = {
    exports: {}, console, Date, Set, Map,
    require(name) {
      if (name === './domain') return domain;
      if (name === 'node:crypto') return require(name);
      if (name === 'firebase-functions/v2/https') return { HttpsError, onCall: (options, handler) => {
        assert.equal(options.region, 'europe-west1');
        // Callable private (true) e callable pubbliche come l'anteprima invito
        // (false): conta che la scelta sia esplicita, non il singolo valore.
        assert.ok(typeof options.enforceAppCheck === 'boolean'); return handler;
      } };
      if (name === 'firebase-functions/v2/scheduler') return { onSchedule: () => null };
      // logger completo: il codice usa anche warn (es. segreto d'invito mancante).
      if (name === 'firebase-functions') return { logger: { error() {}, warn() {}, info() {} } };
      if (name === 'firebase-admin/app') return { initializeApp() {} };
      if (name === 'firebase-admin/firestore') {
        return {
          getFirestore: () => db,
          FieldValue: { serverTimestamp: () => 'server-timestamp' },
          Timestamp: { fromDate: date => ({ toDate: () => date, toISOString: () => date.toISOString() }) }
        };
      }
      throw new Error(`Unexpected dependency ${name}`);
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/index'), 'utf8'), context);
  return { api: context.exports, store, writes };
}

const invoke = (api, name, uid = 'me', data = {}) => api[name]({ auth: uid ? { uid } : null, data });

const base = () => ({
  [`organizations/${ORG}`]: { name: 'Piano Nutrizionale', status: 'active' },
  [`organizations/${ORG}/members/nutri-1`]: { role: 'nutritionist', status: 'active', username: 'nutrizionista' },
  [`organizations/${ORG}/members/nutri-2`]: { role: 'nutritionist', status: 'active', username: 'altro-nutrizionista' },
  'platformMembers/admin-1': { role: 'admin', status: 'active' }
});

test('un nutritionist non può invitare un altro nutritionist', async () => {
  const { api } = harness(base());
  await assert.rejects(
    invoke(api, 'inviteOrganizationUser', 'nutri-1', {
      organizationId: ORG, username: 'nuovo-nutrizionista', role: 'nutritionist', idempotencyKey: 'k1'
    }),
    error => error.code === 'permission-denied' && /riservata al creatore/.test(error.message)
  );
});

test('il creatore può invece invitare un nutritionist', async () => {
  const { api, store } = harness(base());
  const result = await invoke(api, 'inviteOrganizationUser', 'admin-1', {
    organizationId: ORG, username: 'nuovo-nutrizionista', role: 'nutritionist', idempotencyKey: 'k2'
  });
  assert.equal(result.status, 'invited');
  assert.match(result.token, /^[a-f0-9]{64}$/, 'token monouso in chiaro una sola volta');
  assert.equal(store.get(`organizations/${ORG}/invitations/${result.inviteId}`).type, 'nutritionist');
});

test('il nutritionist invita clienti solo per sé', async () => {
  const { api } = harness(base());
  await assert.rejects(
    invoke(api, 'inviteClientLink', 'nutri-1', {
      organizationId: ORG, username: 'nuovo-cliente', nutritionistUid: 'nutri-2', idempotencyKey: 'k3'
    }),
    error => error.code === 'permission-denied' && /solo per te/.test(error.message)
  );
});

test('invito cliente: link monouso e profilo già associato al nutritionist', async () => {
  const { api, store } = harness(base());
  const result = await invoke(api, 'inviteClientLink', 'nutri-1', {
    organizationId: ORG, username: 'cliente-nuovo', nutritionistUid: null, idempotencyKey: 'k4'
  });
  assert.equal(result.status, 'invited');
  assert.match(result.token, /^[a-f0-9]{64}$/);
  const client = store.get(`organizations/${ORG}/clients/${result.clientId}`);
  assert.equal(client.status, 'pending');
  assert.equal(client.authUid, null, 'nessun accesso prima della registrazione');
  assert.deepEqual([...client.nutritionistUids], ['nutri-1'], 'associato a chi ha invitato');
  const invite = store.get(`organizations/${ORG}/invitations/${result.inviteId}`);
  assert.equal(invite.type, 'client');
  assert.equal(invite.clientId, result.clientId);
  assert.equal(invite.nutritionistUid, 'nutri-1');
  assert.notEqual(invite.tokenHash, result.token, 'in chiaro non resta su Firestore');
});

test('registrazione dal link: profilo attivo e collegamento automatico', async () => {
  const { api, store } = harness(base());
  const invited = await invoke(api, 'inviteClientLink', 'nutri-1', {
    organizationId: ORG, username: 'cliente-nuovo', nutritionistUid: null, idempotencyKey: 'k5'
  });
  // La registrazione in app crea username e account Auth (email tecnica interna).
  store.set('usernames/cliente-nuovo', { uid: 'cliente-1', email: 'cliente-nuovo@utenti.pianonutrizionale.app' });
  const accepted = await invoke(api, 'acceptOrganizationInvite', 'cliente-1', { token: invited.token });
  assert.equal(accepted.status, 'link-active');
  assert.deepEqual([accepted.organizationId, accepted.clientId], [ORG, invited.clientId]);
  const client = store.get(`organizations/${ORG}/clients/${invited.clientId}`);
  assert.equal(client.status, 'active');
  assert.equal(client.authUid, 'cliente-1');
  const link = store.get('accountClientLinks/cliente-1');
  assert.equal(link.status, 'active');
  assert.equal(link.organizationId, ORG);
  assert.equal(link.clientId, invited.clientId, 'il cliente ritrova il suo professionista');
  assert.equal(store.get(`organizations/${ORG}/invitations/${invited.inviteId}`).status, 'accepted');
});
