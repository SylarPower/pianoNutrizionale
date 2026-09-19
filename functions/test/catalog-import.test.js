'use strict';
/* Import del catalogo globale (docs/catalog-import-format.md): la callable
 * reale `importGlobalIngredientCatalog` eseguita su un Firestore finto che
 * RIPRODUCE le regole del client vero, altrimenti il bug di produzione non
 * viene catturato:
 *  - doc()/collection() validano la parità dei segmenti (documento = PARI,
 *    collezione = DISPARI) e lanciano un Error SENZA `code`: è così che il
 *    vecchio snapshot su `globalIngredientCatalog/versions/<n>` (3 segmenti)
 *    falliva prima di ogni scrittura e il wrapper apiError lo trasformava in
 *    500 "Operazione non disponibile";
 *  - nessun valore undefined nei documenti scritti (ricorsivo su oggetti e
 *    array);
 *  - in transazione le letture devono precedere le scritture (come nel
 *    client vero) e se l'handler lancia, nessuna scrittura viene applicata;
 *  - `process` è esposto nel contesto vm perché catalogImportConfig legge
 *    process.env per la feature flag CATALOG_IMPORT_ENABLED.
 * Casi: dry-run sul file Guide, commit, guardie, file con errori, doppia
 * conferma, ripristino (restore) e permessi. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const domain = require('../src/domain');

const CREATOR = 'admin-1';
const seedPayload = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'catalogo-import.json'), 'utf8');

// ---- Firestore finto fedele alle regole del client vero ----

function assertDocPath(documentPath) {
  const segments = String(documentPath || '').split('/');
  if (segments.some(segment => segment === '')) {
    throw new Error(`Value for argument "documentPath" must point to a document, but was "${documentPath}". Your path contains an empty segment.`);
  }
  if (segments.length % 2 !== 0) {
    // Errore SENZA `code`, esattamente come @google-cloud/firestore.
    throw new Error(`Value for argument "documentPath" must point to a document, but was "${documentPath}". Your path does not contain an even number of components.`);
  }
}

function assertCollectionPath(collectionPath) {
  const segments = String(collectionPath || '').split('/');
  if (segments.some(segment => segment === '')) {
    throw new Error(`Value for argument "collectionPath" must point to a collection, but was "${collectionPath}". Your path contains an empty segment.`);
  }
  if (segments.length % 2 === 0) {
    throw new Error(`Value for argument "collectionPath" must point to a collection, but was "${collectionPath}". Your path does not contain an odd number of components.`);
  }
}

function assertWritable(value, where) {
  if (value === undefined) {
    throw new Error(`Unsupported field value: undefined (in field "${where}"). If you are thinking of using undefined as a Firestore value, use null instead.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertWritable(item, `${where}.${index}`));
    return;
  }
  if (value && typeof value === 'object') {
    if (typeof value.toDate === 'function') return; // Timestamp-like
    Object.entries(value).forEach(([key, item]) => assertWritable(item, where ? `${where}.${key}` : key));
  }
}

function harness(entries = {}, env = { CATALOG_IMPORT_ENABLED: 'true' }) {
  const store = new Map(Object.entries(entries).map(([key, value]) => [key, { ...value }]));
  const reads = [];
  const writes = [];
  const loggedErrors = [];
  const snapshotOf = documentPath => ({
    id: documentPath.split('/').pop(),
    exists: store.has(documentPath),
    data: () => store.get(documentPath),
    get ref() { return refOf(documentPath); }
  });
  const refOf = documentPath => ({
    path: documentPath,
    id: documentPath.split('/').pop(),
    get: async () => { reads.push(documentPath); return snapshotOf(documentPath); },
    create: async data => { assertWritable(data, ''); writes.push(`create ${documentPath}`); store.set(documentPath, data); },
    set: async data => { assertWritable(data, ''); writes.push(`set ${documentPath}`); store.set(documentPath, data); },
    update: async patch => { assertWritable(patch, ''); writes.push(`update ${documentPath}`); store.set(documentPath, { ...store.get(documentPath), ...patch }); },
    delete: async () => { writes.push(`delete ${documentPath}`); store.delete(documentPath); }
  });
  const db = {
    doc(documentPath) { assertDocPath(documentPath); return refOf(documentPath); },
    collection(collectionPath) {
      assertCollectionPath(collectionPath);
      const depth = collectionPath.split('/').length;
      const query = {
        limit() { return query; },
        where() { return query; },
        orderBy() { return query; },
        async get() {
          reads.push(collectionPath);
          const docs = [...store.keys()]
            .filter(key => key.startsWith(`${collectionPath}/`) && key.split('/').length === depth + 1)
            .map(snapshotOf);
          return { empty: docs.length === 0, size: docs.length, docs };
        }
      };
      return query;
    },
    // Transazione fedele: letture prima delle scritture, scritture bufferizzate
    // e applicate solo se l'handler completa (nessuna scrittura parziale).
    async runTransaction(handler) {
      const pending = [];
      let wrote = false;
      const tx = {
        async get(ref) {
          if (wrote) {
            throw new Error('Firestore transactions require all reads to be executed before all writes. Reads after writes are not supported.');
          }
          reads.push(ref.path);
          return snapshotOf(ref.path);
        },
        set(ref, data) { assertWritable(data, ''); wrote = true; pending.push(() => { writes.push(`set ${ref.path}`); store.set(ref.path, data); }); },
        create(ref, data) {
          assertWritable(data, '');
          if (store.has(ref.path)) throw new Error(`Document already exists: ${ref.path}`);
          wrote = true;
          pending.push(() => { writes.push(`create ${ref.path}`); store.set(ref.path, data); });
        },
        update(ref, patch) { assertWritable(patch, ''); wrote = true; pending.push(() => { writes.push(`update ${ref.path}`); store.set(ref.path, { ...store.get(ref.path), ...patch }); }); },
        delete(ref) { wrote = true; pending.push(() => { writes.push(`delete ${ref.path}`); store.delete(ref.path); }); }
      };
      const result = await handler(tx); // se lancia, `pending` viene scartato
      pending.forEach(apply => apply());
      return result;
    }
  };
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const context = {
    exports: {}, console, Date, Set, Map,
    // La callable legge process.env per la feature flag CATALOG_IMPORT_ENABLED.
    process: { env: { ...env } },
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
      if (name === 'firebase-functions') return { logger: { error: (...args) => { loggedErrors.push(args); } } };
      if (name === 'firebase-admin/app') return { initializeApp() {} };
      if (name === 'firebase-admin/firestore') {
        return {
          getFirestore: () => db,
          FieldValue: { serverTimestamp: () => 'server-timestamp' },
          Timestamp: { fromDate: date => ({ toDate: () => date }), now: () => ({ toDate: () => new Date() }) }
        };
      }
      throw new Error(`Unexpected dependency ${name}`);
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/index'), 'utf8'), context);
  return { api: context.exports, store, reads, writes, loggedErrors };
}

const invoke = (api, data, uid = CREATOR) => api.importGlobalIngredientCatalog({ auth: { uid }, data });
const base = () => ({ 'platformMembers/admin-1': { role: 'admin', status: 'active' } });
const keysWith = (store, prefix) => [...store.keys()].filter(key => key.startsWith(prefix));
const dryRun = (api, payload = seedPayload) => invoke(api, { format: 'json', mode: 'dry-run', payload });
const commit = (api, previewId, payload = seedPayload) => invoke(api, { format: 'json', mode: 'commit', payload, previewId, confirm: true });

test('dry-run sul file Guide: 234 creazioni, zero errori, nessuna scrittura', async () => {
  const { api, writes } = harness(base());
  const result = await dryRun(api);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.counts.create, 284, '229 ingredienti + 49 famiglie + 6 categorie');
  assert.equal(result.counts.errors, 0);
  assert.deepEqual(result.errors, []);
  assert.match(result.previewId, /^[a-f0-9]{64}$/, 'previewId esadecimale');
  assert.equal(result.baseCatalogVersion, 0);
  assert.deepEqual(writes, [], 'il dry-run non scrive nulla');
});

test('commit con conferma: versione 1, riepilogo, snapshot v0 e audit', async () => {
  const { api, store, loggedErrors } = harness(base());
  const dry = await dryRun(api);
  const result = await commit(api, dry.previewId);
  assert.equal(result.mode, 'commit');
  assert.equal(result.catalogVersion, 1);
  const summary = store.get('globalIngredientCatalog/current/meta/summary');
  assert.equal(summary.catalogVersion, 1);
  assert.equal(summary.ingredientCount, 229);
  assert.equal(summary.categoryCount, 6);
  assert.equal(summary.familyCount, 49);
  assert.equal(summary.checksum, result.checksum, 'checksum restituito = checksum scritto');
  assert.equal(keysWith(store, 'globalIngredientCatalog/current/ingredients/').length, 229);
  assert.equal(keysWith(store, 'globalIngredientCatalog/current/categories/').length, 6);
  assert.equal(keysWith(store, 'globalIngredientCatalog/current/families/').length, 49);
  assert.equal(keysWith(store, 'globalIngredientCatalog/current/categories/').some(key => key.endsWith('/free')), true,
    'la categoria free è una categoria come le altre: si importa col file');
  const snapshotV0 = store.get('globalIngredientCatalog/versions/snapshots/0');
  assert.ok(snapshotV0, 'snapshot della versione precedente in versions/snapshots/0 (4 segmenti)');
  assert.equal(snapshotV0.catalogVersion, 0);
  assert.equal(snapshotV0.supersededBy, 1);
  const audits = keysWith(store, 'platformAuditLog/');
  assert.equal(audits.length, 1, 'un solo evento di audit');
  assert.equal(store.get(audits[0]).type, 'catalog.imported');
  assert.equal(store.get(audits[0]).subject.id, 'v1');
  assert.deepEqual(loggedErrors, [], 'logger.error mai chiamato: nessun errore interno (500)');
});

test('guardie senza scritture: conferma mancante, previewId sbagliato, flag disabilitato', async () => {
  const { api, writes } = harness(base());
  const dry = await dryRun(api);
  await assert.rejects(
    invoke(api, { format: 'json', mode: 'commit', payload: seedPayload, previewId: dry.previewId }),
    error => error.code === 'failed-precondition' && /conferma esplicita/.test(error.message)
  );
  await assert.rejects(
    invoke(api, { format: 'json', mode: 'commit', payload: seedPayload, previewId: 'preview-sbagliato', confirm: true }),
    error => error.code === 'failed-precondition' && /previewId non corrispondente/.test(error.message)
  );
  assert.deepEqual(writes, [], 'le guardie rifiutano prima di qualunque scrittura');
  // Feature flag OFF nel documento di configurazione (nessuna variabile env).
  const off = harness({ ...base(), 'globalIngredientCatalog/config/docs/import': { enabled: false } }, {});
  const dryOff = await dryRun(off.api);
  await assert.rejects(
    commit(off.api, dryOff.previewId),
    error => error.code === 'failed-precondition' && /disabilitato/.test(error.message)
  );
  assert.deepEqual(off.writes, [], 'flag disabilitato: nessuna scrittura');
});

test('file con errore (familyId inesistente): dry-run lo segnala, commit rifiutato', async () => {
  const { api, writes } = harness(base());
  const payload = JSON.stringify({
    categories: [],
    families: [],
    ingredients: [{
      ingredientId: 'ingrediente-fantasia', displayName: 'Ingrediente fantasia',
      aliases: [], categoryId: 'free', familyId: 'famiglia-inesistente',
      dietaryFlags: { vegetarian: true, vegan: true }
    }]
  });
  const dry = await dryRun(api, payload);
  assert.equal(dry.errors.length, 1);
  assert.match(dry.errors[0], /familyId inesistente \("famiglia-inesistente"\)/);
  await assert.rejects(
    commit(api, dry.previewId, payload),
    error => error.code === 'failed-precondition' && /Import bloccato/.test(error.message)
  );
  assert.deepEqual(writes, [], 'anche con conferma: errori nel file = nessuna scrittura');
});

test('doppia conferma dello stesso previewId: la seconda fallisce, la versione resta 1', async () => {
  const { api, store } = harness(base());
  const dry = await dryRun(api);
  const first = await commit(api, dry.previewId);
  assert.equal(first.catalogVersion, 1);
  await assert.rejects(
    commit(api, dry.previewId),
    error => error.code === 'failed-precondition',
    'il previewId è legato alla baseCatalogVersion: dopo il commit non è più valido'
  );
  assert.equal(store.get('globalIngredientCatalog/current/meta/summary').catalogVersion, 1, 'la versione resta 1');
});

test('ripristino della versione 0: versione 2, catalogo svuotato, snapshot v1 presente', async () => {
  const { api, store, loggedErrors } = harness(base());
  const dry = await dryRun(api);
  await commit(api, dry.previewId);
  const result = await invoke(api, { mode: 'restore', restoreVersion: 0, confirm: true });
  assert.equal(result.mode, 'restore');
  assert.equal(result.catalogVersion, 2);
  assert.equal(result.restoredFrom, 0);
  // Il catalogo corrente torna al contenuto dello snapshot v0 (vuoto).
  assert.deepEqual(keysWith(store, 'globalIngredientCatalog/current/ingredients/'), []);
  assert.deepEqual(keysWith(store, 'globalIngredientCatalog/current/categories/'), []);
  assert.deepEqual(keysWith(store, 'globalIngredientCatalog/current/families/'), []);
  const summary = store.get('globalIngredientCatalog/current/meta/summary');
  assert.equal(summary.catalogVersion, 2);
  assert.equal(summary.ingredientCount, 0);
  assert.equal(summary.categoryCount, 0);
  assert.equal(summary.familyCount, 0);
  assert.equal(summary.checksum, result.checksum);
  // Lo snapshot della v1 (corrente prima del ripristino) è presente.
  const snapshotV1 = store.get('globalIngredientCatalog/versions/snapshots/1');
  assert.ok(snapshotV1, 'snapshot v1 in versions/snapshots/1 (4 segmenti)');
  assert.equal(snapshotV1.catalogVersion, 1);
  assert.equal(snapshotV1.ingredients.length, 229);
  assert.equal(snapshotV1.categories.length, 6);
  assert.equal(snapshotV1.families.length, 49);
  assert.equal(snapshotV1.supersededBy, 2);
  assert.ok(store.get('globalIngredientCatalog/versions/snapshots/0'), 'lo snapshot v0 resta');
  const audits = keysWith(store, 'platformAuditLog/').map(key => store.get(key));
  assert.deepEqual(audits.map(event => event.type).sort(), ['catalog.imported', 'catalog.restored']);
  assert.equal(audits.find(event => event.type === 'catalog.restored').subject.id, 'v2');
  assert.deepEqual(loggedErrors, [], 'nessun errore interno durante commit e ripristino');
});

test('permessi: nutritionist attivo senza ruolo piattaforma → permission-denied', async () => {
  const { api, writes } = harness({
    ...base(),
    'organizations/pianoNutrizionale/members/nutri-1': { role: 'nutritionist', status: 'active', username: 'nutrizionista' }
  });
  // La membership nutritionist attiva non basta: l'import è del creatore
  // (platformMembers role=admin), anche in sola lettura (dry-run).
  await assert.rejects(
    invoke(api, { format: 'json', mode: 'dry-run', payload: seedPayload }, 'nutri-1'),
    error => error.code === 'permission-denied' && /creatore/.test(error.message)
  );
  assert.deepEqual(writes, []);
});
