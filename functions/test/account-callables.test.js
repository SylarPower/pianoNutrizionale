'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const domain = require('../src/domain');

// Carica le callable reali, inclusi wrapper autenticazione e gestione errori.
// Singola org 'piano', creatore = platformMembers admin.
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

test('membership legge doc UID senza campo uid; solo nutritionist nella singola org', async () => {
  const { api, reads } = harness({
    'organizations/piano': { name: 'Piano' },
    'organizations/piano/members/me': { role: 'nutritionist', status: 'active', username: 'doctor' },
    'platformMembers/me': { role: 'admin', status: 'active' }
  });
  const result = await invoke(api, 'getMyMemberships');
  assert.deepEqual(JSON.parse(JSON.stringify(result)).memberships, [{ organizationId: 'piano', role: 'nutritionist', username: 'doctor' }]);
  assert.equal(result.platformAdmin, true);
  assert.equal(result.singleOrganizationId, 'piano');
  assert.ok(!reads.some(path => path.includes('/other')));
});

test('membership vecchia org diversa da piano è ignorata', async () => {
  const { api } = harness({
    'organizations/org-a': { name: 'Vecchia' },
    'organizations/org-a/members/me': { role: 'nutritionist', status: 'active', username: 'doctor' },
    'organizations/piano/members/me': { role: 'nutritionist', status: 'suspended' },
    'platformMembers/me': { role: 'admin', status: 'active' }
  });
  const result = await invoke(api, 'getMyMemberships');
  // Vecchia org ignorata, piano sospesa → nessuna membership attiva, ma platformAdmin true
  assert.equal(result.memberships.length, 0);
  assert.equal(result.platformAdmin, true);
});

test('membership vuote e admin piattaforma inattivo restano fail-closed', async () => {
  const { api } = harness({ 'platformMembers/me': { role: 'admin', status: 'suspended' } });
  const result = await invoke(api, 'getMyMemberships');
  assert.equal(result.memberships.length, 0);
  assert.equal(result.platformAdmin, false);
});

test('lista inviti isola UID, risolve nomi e non nasconde pendenti dopo 20 storici', async () => {
  const entries = {
    'organizations/piano': { name: 'Studio Piano' },
    'accountClientLinks/me': { organizationId: 'piano', clientId: 'client-me', status: 'active' },
    'organizations/piano/clientLinkRequests/foreign': { targetUid: 'other', status: 'pending', organizationId: 'piano' }
  };
  for (let i = 0; i < 25; i++) entries[`organizations/piano/clientLinkRequests/old${i}`] = { targetUid: 'me', status: 'rejected', organizationId: 'piano' };
  entries['organizations/piano/clientLinkRequests/pending'] = { targetUid: 'me', status: 'pending', organizationId: 'piano' };
  const { api } = harness(entries);
  const result = await invoke(api, 'listMyClientLinkRequests');
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].requestId, 'pending');
  assert.equal(result.requests[0].organizationName, 'Studio Piano');
  assert.equal(result.link.organizationName, 'Studio Piano');
  assert.equal(result.link.clientId, 'client-me');
});

test('assenza di inviti e link revocato non diventano errore o link attivo', async () => {
  const { api } = harness({ 'accountClientLinks/me': { organizationId: 'piano', status: 'revoked' } });
  const result = await invoke(api, 'listMyClientLinkRequests');
  assert.equal(result.requests.length, 0);
  assert.equal(result.link, null);
});

test('risposta a invito altrui non può accedere al documento e usa query senza group', async () => {
  const { api } = harness({
    'organizations/piano': {},
    'organizations/piano/clientLinkRequests/foreign': { targetUid: 'other', status: 'pending', organizationId: 'piano' }
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

test('orgId diversa da piano rifiutata nelle callable che richiedono membership', async () => {
  const { api } = harness({
    'organizations/piano/members/me': { role: 'nutritionist', status: 'active' }
  });
  await assert.rejects(invoke(api, 'listAuthorizedClients', 'me', { organizationId: 'org-a' }), { code: 'permission-denied' });
});
