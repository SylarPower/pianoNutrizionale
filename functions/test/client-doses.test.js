'use strict';
/* Passo 4 (server) — dosi e frequenze personalizzate per cliente:
 *  - validatori puri degli override;
 *  - getClientDoses / updateClientDoseOverrides / copyClientDoses con ruoli,
 *    concorrenza ottimistica, audit e non-retroattività;
 *  - getMyAssignedProfile serve gli override al cliente.
 *  Singola org: 'piano'. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const domain = require('../src/domain');

// Harness Firestore esteso: doc/collection con query semplici, transazioni
// con scritture reali sullo store, FieldValue/Timestamp minimi.
function harness(entries = {}) {
  const store = new Map(Object.entries(entries));
  const snapshot = path => ({
    id: path.split('/').pop(), exists: store.has(path), data: () => store.get(path)
  });
  const makeRef = path => ({
    path, id: path.split('/').pop(),
    collection: name => makeCollection(`${path}/${name}`),
    get: async () => ({ ...snapshot(path), ref: makeRef(path) })
  });
  function makeCollection(path) {
    const filters = [];
    let order = null;
    let lim = null;
    const query = {
      where(field, op, value) { filters.push([field, op, value]); return query; },
      orderBy(field, direction) { order = [field, direction]; return query; },
      limit(n) { lim = n; return query; },
      doc(docId) { return makeRef(`${path}/${docId}`); },
      async get() {
        let docs = [...store.keys()]
          .filter(key => key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1)
          .map(key => ({ ...snapshot(key), ref: makeRef(key) }));
        filters.forEach(([field, op, value]) => {
          docs = docs.filter(snap => {
            const fieldValue = snap.data()[field];
            if (op === '==') return fieldValue === value;
            if (op === 'in') return value.includes(fieldValue);
            if (op === '<=') return fieldValue <= value;
            throw new Error(`Operatore non supportato dallo stub: ${op}`);
          });
        });
        if (order) {
          const [field, direction] = order;
          docs.sort((a, b) => (direction === 'desc' ? -1 : 1) * (a.data()[field] > b.data()[field] ? 1 : -1));
        }
        if (lim != null) docs = docs.slice(0, lim);
        return { docs, empty: docs.length === 0 };
      }
    };
    return query;
  }
  const txOps = {
    get: ref => ref.get(),
    set: (ref, value) => { store.set(ref.path, value); },
    create: (ref, value) => {
      if (store.has(ref.path)) throw new Error('ALREADY_EXISTS');
      store.set(ref.path, value);
    },
    update: (ref, value) => {
      if (!store.has(ref.path)) throw new Error('NOT_FOUND');
      store.set(ref.path, { ...store.get(ref.path), ...value });
    },
    delete: ref => { store.delete(ref.path); }
  };
  const db = {
    doc: path => makeRef(path),
    collection: path => makeCollection(path),
    runTransaction: async fn => fn(txOps)
  };
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const regions = [];
  const context = {
    exports: {}, console,
    require(name) {
      if (name === './domain') return domain;
      if (name === 'node:crypto') return require(name);
      if (name === 'firebase-functions/v2/https') return { HttpsError, onCall: (options, handler) => {
        regions.push(options);
        return handler;
      } };
      if (name === 'firebase-functions/v2/scheduler') return { onSchedule: () => null };
      if (name === 'firebase-functions') return { logger: { error() {} } };
      if (name === 'firebase-admin/app') return { initializeApp() {} };
      if (name === 'firebase-admin/firestore') return {
        getFirestore: () => db,
        FieldValue: { serverTimestamp: () => ({ __ts: true }), increment: n => ({ __inc: n }) },
        Timestamp: { now: () => Date.now(), fromDate: date => date.getTime() }
      };
      throw new Error(`Unexpected dependency ${name}`);
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/index'), 'utf8'), context);
  regions.forEach(options => {
    assert.equal(options.region, 'europe-west1');
    assert.equal(options.enforceAppCheck, true);
  });
  return { api: context.exports, store };
}
const invoke = (api, name, uid = 'me', data = {}) => api[name]({ auth: uid ? { uid } : null, data });
// Gli oggetti attraversano il confine vm (realm diversa): normalizzazione
// prima dei deepEqual per non confrontare i prototipi.
const plain = value => JSON.parse(JSON.stringify(value));

// ---- Fixture org con struttura, revisione e assegnazione ----

const RULES = [
  { mellerFamilyId: 'pasta', ingredientIds: ['pasta-semola'], quantityGrams: { lunch: { training: 90, rest: 70 }, dinner: { training: 40, rest: 40 } }, enabled: true, categoryId: null },
  { mellerFamilyId: 'pollame', ingredientIds: ['petto-pollo'], quantityGrams: { lunch: { training: 150, rest: 150 }, dinner: { training: 150, rest: 150 } }, enabled: true, categoryId: null }
];
const REVISION_CHECKSUM = domain.structureRevisionChecksum({ schemaVersion: 1, rules: RULES, alternativeGroups: [] });

function orgEntries({ clients = ['c1'], overrides = null, assignmentStatus = 'active' } = {}) {
  const orgId = 'piano';
  const entries = {
    [`organizations/${orgId}/members/me`]: { role: 'nutritionist', status: 'active', username: 'doctor' },
    [`organizations/${orgId}/dietStructures/s1`]: { ownerUid: 'me', status: 'active', currentRevisionId: 'r1', latestChecksum: REVISION_CHECKSUM },
    [`organizations/${orgId}/dietStructures/s1/revisions/r1`]: { status: 'published', schemaVersion: 1, rules: RULES, alternativeGroups: [], checksum: REVISION_CHECKSUM },
    'globalIngredientCatalog/current/meta/summary': { catalogVersion: 7, checksum: 'cat' },
    'globalIngredientCatalog/current/ingredients/pasta-semola': { displayName: 'Pasta di semola', status: 'active' },
    'globalIngredientCatalog/current/ingredients/petto-pollo': { displayName: 'Petto di pollo', status: 'active' }
  };
  clients.forEach((clientId, index) => {
    entries[`organizations/${orgId}/clients/${clientId}`] = {
      status: 'active', nutritionistUids: ['me'], displayCode: `CLI-${clientId}`, authUid: `user-${clientId}`
    };
    entries[`organizations/${orgId}/clients/${clientId}/state/activeAssignment`] = { assignmentId: `a-${clientId}` };
    entries[`organizations/${orgId}/clients/${clientId}/assignments/a-${clientId}`] = {
      schemaVersion: 2, assignmentId: `a-${clientId}`, clientId,
      structure: { structureId: 's1', revisionId: 'r1', checksum: REVISION_CHECKSUM },
      structureName: 'Base',
      status: assignmentStatus, effectiveAt: Date.now() - 1000, expiresAt: null,
      ...(index === 0 && overrides ? { clientOverrides: overrides } : {})
    };
  });
  return entries;
}

// ---- Validatori puri ----

test('validateClientDoseOverrides: sparsi validi, celle vuote scartate', () => {
  const clean = domain.validateClientDoseOverrides({
    doses: {
      pasta: { lunch: { training: 120, rest: null }, dinner: { training: '', rest: null } },
      pollame: { lunch: { training: 150, rest: 150 } }
    },
    frequencies: { legumes: { min: 2, max: '' }, eggs: {} }
  }, { families: ['pasta', 'pollame'] });
  assert.deepEqual(clean, {
    doses: { pasta: { lunch: { training: 120 } }, pollame: { lunch: { training: 150, rest: 150 } } },
    frequencies: { legumes: { min: 2 } }
  });
});

test('validateClientDoseOverrides: rifiuti (famiglie, grammi, frequenze, chiavi)', () => {
  const families = ['pasta'];
  assert.throws(() => domain.validateClientDoseOverrides({ doses: { riso: { lunch: { training: 80 } } }, frequencies: {} }, { families }), /non presente nella struttura/);
  for (const bad of [0, 2001, 1.5, 'x', -5]) {
    assert.throws(() => domain.validateClientDoseOverrides({ doses: { pasta: { lunch: { training: bad } } }, frequencies: {} }, { families }), /tra 1 e 2000/);
  }
  assert.throws(() => domain.validateClientDoseOverrides({ doses: { pasta: { merenda: {} } }, frequencies: {} }, { families }), /campi non ammessi/);
  assert.throws(() => domain.validateClientDoseOverrides({ doses: {}, frequencies: { tofu: { min: 1 } } }, { families }), /Frequenza non valida/);
  assert.throws(() => domain.validateClientDoseOverrides({ doses: {}, frequencies: { eggs: { min: 3, max: 2 } } }, { families }), /min non può superare max/);
  assert.throws(() => domain.validateClientDoseOverrides({ doses: {}, frequencies: { eggs: { max: 15 } } }, { families }), /tra 0 e 14/);
  assert.throws(() => domain.validateClientDoseOverrides({ doses: {}, frequencies: {}, extra: 1 }, { families }), /campi non ammessi/);
});

test('validateCopyClientDoses: origine e destinazione diversi, revisioni sane', () => {
  assert.throws(() => domain.validateCopyClientDoses({ organizationId: 'piano', fromClientId: 'c1', toClientId: 'c1', expectedRevision: 0 }), /diversi/);
  assert.throws(() => domain.validateUpdateClientDoseOverrides({ organizationId: 'piano', clientId: 'c1', assignmentId: null, doses: {}, frequencies: {}, expectedRevision: -1 }), /expectedRevision/);
});

// ---- getClientDoses ----

test('getClientDoses: famiglie studio, nomi catalogo, default frequenze', async () => {
  const { api } = harness(orgEntries());
  const result = plain(await invoke(api, 'getClientDoses', 'me', { organizationId: 'piano', clientId: 'c1' }));
  assert.equal(result.clientId, 'c1');
  assert.equal(result.assignment.overridesRevision, 0);
  assert.equal(result.assignment.status, 'active');
  assert.deepEqual(result.families.find(item => item.family === 'pasta').studio.lunch, { training: 90, rest: 70 });
  assert.deepEqual(result.families.find(item => item.family === 'pasta').ingredients, ['Pasta di semola']);
  assert.equal(result.frequencyDefaults.length, 8);
  assert.deepEqual(result.frequencyDefaults.find(item => item.key === 'legumes'), { key: 'legumes', label: 'Legumi e derivati', min: 3, max: 14 });
  assert.deepEqual(result.overrides, { doses: {}, frequencies: {} });
});

test('getClientDoses: senza assegnazione restituisce struttura vuota', async () => {
  const orgId = 'piano';
  const { api } = harness({
    [`organizations/${orgId}/members/me`]: { role: 'nutritionist', status: 'active' },
    [`organizations/${orgId}/clients/c9`]: { status: 'active', nutritionistUids: ['me'], displayCode: 'CLI-c9' }
  });
  const result = plain(await invoke(api, 'getClientDoses', 'me', { organizationId: orgId, clientId: 'c9' }));
  assert.equal(result.assignment, null);
  assert.deepEqual(result.families, []);
});

test('getClientDoses: ruoli (non autenticato, cliente altrui, cliente archiviato)', async () => {
  const { api } = harness(orgEntries());
  await assert.rejects(invoke(api, 'getClientDoses', null, { organizationId: 'piano', clientId: 'c1' }), /Autenticazione richiesta/);
  const other = harness({
    ...orgEntries(),
    'organizations/piano/clients/c1': { status: 'active', nutritionistUids: ['other'], displayCode: 'CLI-c1' }
  });
  await assert.rejects(invoke(other.api, 'getClientDoses', 'me', { organizationId: 'piano', clientId: 'c1' }), /Cliente non autorizzato/);
  const deleted = harness({
    ...orgEntries(),
    'organizations/piano/clients/c1': { status: 'deleted', nutritionistUids: ['me'] }
  });
  await assert.rejects(invoke(deleted.api, 'getClientDoses', 'me', { organizationId: 'piano', clientId: 'c1' }), /Cliente non trovato/);
});

// ---- updateClientDoseOverrides ----

test('updateClientDoseOverrides: scrive override revisionati con audit, revisione intatta', async () => {
  const { api, store } = harness(orgEntries());
  const before = JSON.stringify(store.get('organizations/piano/dietStructures/s1/revisions/r1'));
  const result = plain(await invoke(api, 'updateClientDoseOverrides', 'me', {
    organizationId: 'piano', clientId: 'c1',
    doses: { pasta: { lunch: { training: 120 } } },
    frequencies: { legumes: { min: 2, max: 4 } },
    expectedRevision: 0
  }));
  assert.equal(result.revision, 1);
  const saved = plain(store.get('organizations/piano/clients/c1/assignments/a-c1').clientOverrides);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.doses, { pasta: { lunch: { training: 120 } } });
  assert.deepEqual(saved.frequencies, { legumes: { min: 2, max: 4 } });
  assert.equal(saved.updatedBy, 'me');
  const audits = [...store.keys()].filter(key => key.includes('/auditLog/'));
  assert.equal(audits.length, 1);
  assert.equal(store.get(audits[0]).type, 'assignment.doses_updated');
  assert.equal(JSON.stringify(store.get('organizations/piano/dietStructures/s1/revisions/r1')), before, 'revisione struttura non toccata (non-retroattività)');
});

test('updateClientDoseOverrides: concorrenza, validazione, stati non modificabili', async () => {
  const { api } = harness(orgEntries());
  await invoke(api, 'updateClientDoseOverrides', 'me', {
    organizationId: 'piano', clientId: 'c1', doses: {}, frequencies: {}, expectedRevision: 0
  });
  await assert.rejects(invoke(api, 'updateClientDoseOverrides', 'me', {
    organizationId: 'piano', clientId: 'c1', doses: {}, frequencies: {}, expectedRevision: 0
  }), /altro operatore/);
  await assert.rejects(invoke(api, 'updateClientDoseOverrides', 'me', {
    organizationId: 'piano', clientId: 'c1',
    doses: { riso: { lunch: { training: 80 } } }, frequencies: {}, expectedRevision: 1
  }), /non presente nella struttura/);
  const revoked = harness(orgEntries({ assignmentStatus: 'revoked' }));
  await assert.rejects(invoke(revoked.api, 'updateClientDoseOverrides', 'me', {
    organizationId: 'piano', clientId: 'c1', doses: {}, frequencies: {}, expectedRevision: 0
  }), /non modificabile/);
});

// ---- copyClientDoses ----

test('copyClientDoses: copia con intersezione famiglie, audit e provenienza', async () => {
  const { api, store } = harness(orgEntries({
    clients: ['c1', 'c2'],
    overrides: {
      schemaVersion: 1, revision: 2,
      doses: { pasta: { lunch: { training: 120 } }, quinoa: { lunch: { training: 80 } } },
      frequencies: { legumes: { min: 2 } }
    }
  }));
  const result = plain(await invoke(api, 'copyClientDoses', 'me', {
    organizationId: 'piano', fromClientId: 'c1', toClientId: 'c2', expectedRevision: 0
  }));
  assert.equal(result.revision, 1);
  assert.deepEqual(result.copiedFamilies, ['pasta']);
  assert.deepEqual(result.skippedFamilies, ['quinoa'], 'famiglia assente nella struttura di destinazione');
  const saved = plain(store.get('organizations/piano/clients/c2/assignments/a-c2').clientOverrides);
  assert.deepEqual(saved.doses, { pasta: { lunch: { training: 120 } } });
  assert.deepEqual(saved.frequencies, { legumes: { min: 2 } });
  assert.equal(saved.copiedFromClientId, 'c1');
  const audits = [...store.keys()].filter(key => key.includes('/auditLog/'));
  assert.equal(store.get(audits[0]).type, 'assignment.doses_copied');
  // L'origine resta intatta.
  assert.equal(store.get('organizations/piano/clients/c1/assignments/a-c1').clientOverrides.revision, 2);
});

test('copyClientDoses: rifiuti (stesso cliente, concorrenza, ruoli)', async () => {
  const { api } = harness(orgEntries({ clients: ['c1', 'c2'] }));
  await assert.rejects(invoke(api, 'copyClientDoses', 'me', {
    organizationId: 'piano', fromClientId: 'c1', toClientId: 'c1', expectedRevision: 0
  }), /diversi/);
  await invoke(api, 'updateClientDoseOverrides', 'me', {
    organizationId: 'piano', clientId: 'c2', doses: {}, frequencies: {}, expectedRevision: 0
  });
  await assert.rejects(invoke(api, 'copyClientDoses', 'me', {
    organizationId: 'piano', fromClientId: 'c1', toClientId: 'c2', expectedRevision: 0
  }), /altro operatore/);
  const other = harness({
    ...orgEntries({ clients: ['c1', 'c2'] }),
    'organizations/piano/clients/c2': { status: 'active', nutritionistUids: ['other'], displayCode: 'CLI-c2' }
  });
  await assert.rejects(invoke(other.api, 'copyClientDoses', 'me', {
    organizationId: 'piano', fromClientId: 'c1', toClientId: 'c2', expectedRevision: 0
  }), /Cliente non autorizzato/);
});

// ---- Serving al cliente ----

test('getMyAssignedProfile include gli override del cliente (metadati esclusi)', async () => {
  const overrides = {
    schemaVersion: 1, revision: 3,
    doses: { pasta: { lunch: { training: 120 } } },
    frequencies: { legumes: { min: 2 } },
    updatedBy: 'me', updatedAt: { __ts: true }
  };
  const { api } = harness({
    ...orgEntries({ overrides }),
    'accountClientLinks/user-c1': { status: 'active', organizationId: 'piano', clientId: 'c1' }
  });
  const result = plain(await invoke(api, 'getMyAssignedProfile', 'user-c1', {}));
  assert.equal(result.state, 'assigned');
  assert.deepEqual(result.profile.clientOverrides, {
    revision: 3,
    doses: { pasta: { lunch: { training: 120 } } },
    frequencies: { legumes: { min: 2 } }
  });
});

test('orgId diversa da piano rifiutata', async () => {
  const { api } = harness(orgEntries());
  await assert.rejects(invoke(api, 'getClientDoses', 'me', { organizationId: 'vecchia', clientId: 'c1' }), /Organizzazione non valida/);
});
