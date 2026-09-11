'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const domain = require('../src/domain');

// Carica le callable reali, inclusi wrapper autenticazione e gestione errori.
// Lo stub rifiuta collectionGroup: riproduce il percorso che falliva in prod.
function harness(entries = {}) {
  const store = new Map(Object.entries(entries));
  const reads = [];
  const snapshot = path => ({
    id: path.split('/').pop(), exists: store.has(path), data: () => store.get(path),
    ref: { path, parent: { parent: { id: path.split('/').at(-3) } } }
  });
  const db = {
    collectionGroup() { throw new Error('FAILED_PRECONDITION: collection-group non disponibile'); },
    doc(path) { return { get: async () => { reads.push(path); return snapshot(path); } }; },
    collection(path) {
      let filter;
      const query = {
        select() { return query; },
        where(field, op, value) { assert.equal(op, '=='); filter = [field, value]; return query; },
        async get() {
          reads.push(path);
          return { docs: [...store.keys()].filter(key => key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1)
            .filter(key => !filter || store.get(key)[filter[0]] === filter[1]).map(snapshot) };
        }
      };
      return query;
    }
  };
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const context = {
    exports: {}, console, Date, Set, Map,
    require(name) {
      if (name === './domain') return domain;
      if (name === 'node:crypto') return require(name);
      if (name === 'firebase-functions/v2/https') return { HttpsError, onCall: (options, handler) => {
        assert.equal(options.region, 'europe-west1'); assert.equal(options.enforceAppCheck, true); return handler;
      } };
      if (name === 'firebase-functions/v2/scheduler') return { onSchedule: () => null };
      if (name === 'firebase-functions') return { logger: { error() {} } };
      if (name === 'firebase-admin/app') return { initializeApp() {} };
      if (name === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: {}, Timestamp: {} };
      throw new Error(`Unexpected dependency ${name}`);
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/index'), 'utf8'), context);
  return { api: context.exports, reads };
}
const invoke = (api, name, uid = 'me', data = {}) => api[name]({ auth: uid ? { uid } : null, data });

test('membership legge doc UID senza campo uid; esclude ruoli/status non autorizzati', async () => {
  const { api, reads } = harness({
    'organizations/a': {}, 'organizations/b': {}, 'organizations/c': {}, 'organizations/d': {}, 'organizations/e': {},
    'organizations/a/members/me': { role: 'nutritionist', status: 'active', username: 'doctor' },
    'organizations/b/members/me': { role: 'admin', status: 'active' },
    'organizations/c/members/me': { role: 'admin', status: 'suspended' },
    'organizations/d/members/me': { role: 'client', status: 'active' },
    'organizations/e/members/other': { role: 'admin', status: 'active' },
    'platformMembers/me': { role: 'admin', status: 'active' }
  });
  const result = await invoke(api, 'getMyMemberships');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    memberships: [{ organizationId: 'a', role: 'nutritionist', username: 'doctor' }, { organizationId: 'b', role: 'admin', username: null }], platformAdmin: true
  });
  assert.ok(!reads.some(path => path.endsWith('/other')));
});

test('membership vuote e admin piattaforma inattivo restano fail-closed', async () => {
  const { api } = harness({ 'platformMembers/me': { role: 'admin', status: 'suspended' } });
  const result = await invoke(api, 'getMyMemberships');
  assert.equal(result.memberships.length, 0);
  assert.equal(result.platformAdmin, false);
});

test('lista inviti isola UID, risolve nomi e non nasconde pendenti dopo 20 storici', async () => {
  const entries = {
    'organizations/a': { name: 'Studio A' }, 'organizations/b': { name: 'Studio B' },
    'accountClientLinks/me': { organizationId: 'b', clientId: 'client-me', status: 'active' },
    'organizations/a/clientLinkRequests/foreign': { targetUid: 'other', status: 'pending', organizationId: 'a' }
  };
  for (let i = 0; i < 25; i++) entries[`organizations/a/clientLinkRequests/old${i}`] = { targetUid: 'me', status: 'rejected', organizationId: 'a' };
  entries['organizations/a/clientLinkRequests/pending'] = { targetUid: 'me', status: 'pending', organizationId: 'a' };
  const { api } = harness(entries);
  const result = await invoke(api, 'listMyClientLinkRequests');
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].requestId, 'pending');
  assert.equal(result.requests[0].organizationName, 'Studio A');
  assert.equal(result.link.organizationName, 'Studio B');
  assert.equal(result.link.clientId, 'client-me');
});

test('assenza di inviti e link revocato non diventano errore o link attivo', async () => {
  const { api } = harness({ 'accountClientLinks/me': { organizationId: 'a', status: 'revoked' } });
  const result = await invoke(api, 'listMyClientLinkRequests');
  assert.equal(result.requests.length, 0);
  assert.equal(result.link, null);
});

test('risposta a invito altrui non può accedere al documento e usa query senza group', async () => {
  const { api } = harness({
    'organizations/a': {},
    'organizations/a/clientLinkRequests/foreign': { targetUid: 'other', status: 'pending', organizationId: 'a' }
  });
  await assert.rejects(invoke(api, 'respondClientLink', 'me', { requestId: 'foreign', decision: 'accept' }), { code: 'not-found' });
});

test('callable richiedono autenticazione e rifiutano payload inattesi', async () => {
  const { api } = harness();
  for (const name of ['getMyMemberships', 'listMyClientLinkRequests']) {
    await assert.rejects(invoke(api, name, null), { code: 'unauthenticated' });
    await assert.rejects(invoke(api, name, 'me', { uid: 'other' }), { code: 'invalid-argument' });
  }
});
