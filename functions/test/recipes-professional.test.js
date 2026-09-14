'use strict';
/* Parte C (server) — ricettario professionisti (ADR 0006):
 * - raccolta server-only organizations/pianoNutrizionale/recipes;
 * - list/create/update/archive/share/send/cancel + listProfessionalShares;
 * - concorrenza ottimistica su revision, visibilità private/studio;
 * - update/archive solo proprietario (vale anche per il creatore);
 * - share solo creatore; send con failed-precondition se cliente non
 *   assegnato o senza authUid; riuso recipeShares con senderRole.
 *  Singola org: 'pianoNutrizionale'. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const domain = require('../src/domain');
const ClientDomain = require('../../js/domain');

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
const plain = value => JSON.parse(JSON.stringify(value));
async function errCode(promise) {
  try { await promise; } catch (error) { return error.code; }
  throw new assert.AssertionError({ message: 'atteso errore, operazione riuscita' });
}

// ---- Fixture ----

const RECIPE = {
  name: 'Riso al telefono', emoji: '🍚', slot: 'lunch', proteinCategory: null,
  ingredients: [{ name: 'Riso', ingredientId: null, portions: { man: '80 g', ipo: '60 g' } }],
  steps: ['Cuoci il riso.'], notes: []
};

function orgEntries() {
  return {
    'organizations/pianoNutrizionale/members/nutri1': { status: 'active', role: 'nutritionist' },
    'organizations/pianoNutrizionale/members/nutri2': { status: 'active', role: 'nutritionist' },
    'platformMembers/creator': { status: 'active', role: 'admin' },
    'organizations/pianoNutrizionale/recipes/R1': {
      ...RECIPE, revision: 1, visibility: 'private', status: 'active', ownerUid: 'nutri1', createdBy: 'nutri1'
    },
    'organizations/pianoNutrizionale/recipes/R2': {
      ...RECIPE, name: 'Zuppa studio', revision: 2, visibility: 'studio', status: 'active', ownerUid: 'nutri2', createdBy: 'nutri2'
    },
    'organizations/pianoNutrizionale/recipes/R3': {
      ...RECIPE, name: 'Privata altrui', revision: 1, visibility: 'private', status: 'active', ownerUid: 'nutri2', createdBy: 'nutri2'
    },
    'organizations/pianoNutrizionale/recipes/R4': {
      ...RECIPE, name: 'Archiviata mia', revision: 3, visibility: 'private', status: 'archived', ownerUid: 'nutri1', createdBy: 'nutri1'
    },
    'organizations/pianoNutrizionale/clients/c1': { status: 'active', authUid: 'u-c1', nutritionistUids: ['nutri1'], invitedUsername: 'cliente1' },
    'organizations/pianoNutrizionale/clients/c2': { status: 'active', authUid: 'u-c2', nutritionistUids: ['nutri2'], invitedUsername: 'cliente2' },
    'organizations/pianoNutrizionale/clients/c3': { status: 'active', authUid: null, nutritionistUids: ['nutri1'], invitedUsername: 'cliente3' },
    'organizations/pianoNutrizionale/clients/c4': { status: 'deleted', authUid: 'u-c4', nutritionistUids: ['nutri1'] },
    'recipeShares/s1': {
      senderUid: 'nutri1', senderUsername: 'nutri1', senderRole: 'professional', organizationId: 'pianoNutrizionale',
      recipientUid: 'u-c1', status: 'pending', recipeCount: 1, recipes: [{ ...RECIPE, id: 'R1' }],
      professionalRecipeIds: ['R1'], includesPlan: false, plan: null
    },
    'recipeShares/s2': {
      senderUid: 'nutri2', senderRole: 'professional', organizationId: 'altra-org',
      recipientUid: 'u-c2', status: 'pending', recipeCount: 1, recipes: [{ ...RECIPE, id: 'R2' }], professionalRecipeIds: ['R2']
    },
    'recipeShares/s3': {
      senderUid: 'u-xyz', senderUsername: 'utente', recipientUid: 'u-c1',
      status: 'pending', recipeCount: 1, recipes: [{ ...RECIPE, id: 'L9' }]
    }
  };
}

// ---- list ----

test('list: il nutrizionista vede le proprie + quelle di studio, mai le private altrui', async () => {
  const { api } = harness(orgEntries());
  const result = await invoke(api, 'listProfessionalRecipes', 'nutri1', { organizationId: 'pianoNutrizionale' });
  assert.deepEqual(plain(result.recipes.map(r => r.id).sort()), ['R1', 'R2']);
});

test('list: includeArchived mostra anche le archiviate proprie', async () => {
  const { api } = harness(orgEntries());
  const result = await invoke(api, 'listProfessionalRecipes', 'nutri1', { organizationId: 'pianoNutrizionale', includeArchived: true });
  assert.deepEqual(plain(result.recipes.map(r => r.id).sort()), ['R1', 'R2', 'R4']);
});

test('list: il creatore vede tutto, anche le private altrui', async () => {
  const { api } = harness(orgEntries());
  const result = await invoke(api, 'listProfessionalRecipes', 'creator', { organizationId: 'pianoNutrizionale', includeArchived: true });
  assert.deepEqual(plain(result.recipes.map(r => r.id).sort()), ['R1', 'R2', 'R3', 'R4']);
});

test('list: senza auth o senza membership → errore', async () => {
  const { api } = harness(orgEntries());
  assert.equal(await errCode(invoke(api, 'listProfessionalRecipes', null, { organizationId: 'pianoNutrizionale' })), 'unauthenticated');
  assert.equal(await errCode(invoke(api, 'listProfessionalRecipes', 'estraneo', { organizationId: 'pianoNutrizionale' })), 'permission-denied');
});

// ---- create ----

test('create: revision 1, visibilità privata, proprietario = chiamante', async () => {
  const { api, store } = harness(orgEntries());
  const result = await invoke(api, 'createProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipe: RECIPE, idempotencyKey: 'k1'
  });
  assert.match(result.recipeId, /^R[0-9a-f]{12}$/);
  assert.equal(result.revision, 1);
  const saved = store.get(`organizations/pianoNutrizionale/recipes/${result.recipeId}`);
  assert.equal(saved.visibility, 'private');
  assert.equal(saved.status, 'active');
  assert.equal(saved.ownerUid, 'nutri1');
  assert.equal(saved.name, RECIPE.name);
  assert.ok([...store.keys()].some(k => k.includes('/auditLog/')), 'evento audit creato');
});

test('create: idempotente sulla stessa chiave', async () => {
  const { api, store } = harness(orgEntries());
  const first = await invoke(api, 'createProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipe: RECIPE, idempotencyKey: 'idem-x'
  });
  const second = await invoke(api, 'createProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipe: RECIPE, idempotencyKey: 'idem-x'
  });
  assert.equal(first.recipeId, second.recipeId);
  assert.equal([...store.keys()].filter(k => k.startsWith('organizations/pianoNutrizionale/recipes/')).length, 5, '4 fixture + 1 creata (retry idempotente)');
});

test('create: ricetta non valida → invalid-argument', async () => {
  const { api } = harness(orgEntries());
  const base = { organizationId: 'pianoNutrizionale', idempotencyKey: 'k' };
  assert.equal(await errCode(invoke(api, 'createProfessionalRecipe', 'nutri1', { ...base, recipe: { ...RECIPE, slot: 'brunch' } })), 'invalid-argument');
  assert.equal(await errCode(invoke(api, 'createProfessionalRecipe', 'nutri1', { ...base, recipe: { ...RECIPE, ingredients: [] } })), 'invalid-argument');
  assert.equal(await errCode(invoke(api, 'createProfessionalRecipe', 'nutri1', { ...base, recipe: { ...RECIPE, id: 'X1' } })), 'invalid-argument');
  assert.equal(await errCode(invoke(api, 'createProfessionalRecipe', 'nutri1', { ...base, recipe: { ...RECIPE, name: '  ' } })), 'invalid-argument');
});

// ---- update ----

test('update: proprietario avanza di una revisione', async () => {
  const { api, store } = harness(orgEntries());
  const result = await invoke(api, 'updateProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipeId: 'R1', recipe: { ...RECIPE, name: 'Riso v2' }, revision: 1, idempotencyKey: 'u1'
  });
  assert.deepEqual(plain(result), { recipeId: 'R1', revision: 2 });
  const saved = store.get('organizations/pianoNutrizionale/recipes/R1');
  assert.equal(saved.name, 'Riso v2');
  assert.equal(saved.revision, 2);
  assert.equal(saved.visibility, 'private', 'la visibilità non cambia con update');
  assert.equal(saved.ownerUid, 'nutri1', 'il proprietario non cambia con update');
});

test('update: revisione stale, altrui, creatore su altrui, archiviata → errore', async () => {
  const { api } = harness(orgEntries());
  const base = { organizationId: 'pianoNutrizionale', recipeId: 'R1', recipe: RECIPE, idempotencyKey: 'u' };
  assert.equal(await errCode(invoke(api, 'updateProfessionalRecipe', 'nutri1', { ...base, revision: 9 })), 'failed-precondition');
  assert.equal(await errCode(invoke(api, 'updateProfessionalRecipe', 'nutri2', { ...base, revision: 1 })), 'permission-denied');
  assert.equal(await errCode(invoke(api, 'updateProfessionalRecipe', 'creator', { ...base, revision: 1 })), 'permission-denied');
  assert.equal(await errCode(invoke(api, 'updateProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipeId: 'R4', recipe: RECIPE, revision: 3, idempotencyKey: 'u'
  })), 'failed-precondition');
  assert.equal(await errCode(invoke(api, 'updateProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipeId: 'RX', recipe: RECIPE, revision: 1, idempotencyKey: 'u'
  })), 'not-found');
});

// ---- archive ----

test('archive: proprietario archivia (senza ripristino), idempotente', async () => {
  const { api, store } = harness(orgEntries());
  const result = await invoke(api, 'archiveProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipeId: 'R1', idempotencyKey: 'a1'
  });
  assert.deepEqual(plain(result), { recipeId: 'R1', status: 'archived' });
  assert.equal(store.get('organizations/pianoNutrizionale/recipes/R1').status, 'archived');
  const again = await invoke(api, 'archiveProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipeId: 'R1', idempotencyKey: 'a2'
  });
  assert.equal(again.status, 'archived');
});

test('archive: altrui e creatore su altrui → permission-denied', async () => {
  const { api } = harness(orgEntries());
  const base = { organizationId: 'pianoNutrizionale', recipeId: 'R1', idempotencyKey: 'a' };
  assert.equal(await errCode(invoke(api, 'archiveProfessionalRecipe', 'nutri2', base)), 'permission-denied');
  assert.equal(await errCode(invoke(api, 'archiveProfessionalRecipe', 'creator', base)), 'permission-denied');
});

// ---- share ----

test('share: solo il creatore cambia visibilità', async () => {
  const { api, store } = harness(orgEntries());
  const result = await invoke(api, 'shareProfessionalRecipe', 'creator', {
    organizationId: 'pianoNutrizionale', recipeId: 'R1', visibility: 'studio', idempotencyKey: 's1'
  });
  assert.deepEqual(plain(result), { recipeId: 'R1', visibility: 'studio' });
  assert.equal(store.get('organizations/pianoNutrizionale/recipes/R1').visibility, 'studio');
  const back = await invoke(api, 'shareProfessionalRecipe', 'creator', {
    organizationId: 'pianoNutrizionale', recipeId: 'R1', visibility: 'private', idempotencyKey: 's2'
  });
  assert.equal(back.visibility, 'private');
});

test('share: nutrizionista, visibilità ignota, archiviata → errore', async () => {
  const { api } = harness(orgEntries());
  assert.equal(await errCode(invoke(api, 'shareProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipeId: 'R1', visibility: 'studio', idempotencyKey: 's'
  })), 'permission-denied');
  assert.equal(await errCode(invoke(api, 'shareProfessionalRecipe', 'creator', {
    organizationId: 'pianoNutrizionale', recipeId: 'R1', visibility: 'pubblica', idempotencyKey: 's'
  })), 'invalid-argument');
  assert.equal(await errCode(invoke(api, 'shareProfessionalRecipe', 'creator', {
    organizationId: 'pianoNutrizionale', recipeId: 'R4', visibility: 'studio', idempotencyKey: 's'
  })), 'failed-precondition');
});

// ---- send ----

test('send: crea recipeShare professionale al cliente assegnato', async () => {
  const { api, store } = harness(orgEntries());
  const result = await invoke(api, 'sendProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipeIds: ['R1'], clientId: 'c1', idempotencyKey: 'send1'
  });
  assert.equal(result.recipeCount, 1);
  const share = store.get(`recipeShares/${result.shareId}`);
  assert.equal(share.senderRole, 'professional');
  assert.equal(share.organizationId, 'pianoNutrizionale');
  assert.equal(share.senderUid, 'nutri1');
  assert.equal(share.recipientUid, 'u-c1');
  assert.equal(share.status, 'pending');
  assert.equal(share.includesPlan, false);
  assert.ok(!('type' in share), 'senza type: atterra tra le recipeShares');
  assert.deepEqual(plain(share.professionalRecipeIds), ['R1']);
  assert.deepEqual(Object.keys(share.recipes[0]).sort(), ['emoji', 'id', 'ingredients', 'name', 'notes', 'professionalRevision', 'proteinCategory', 'slot', 'steps']);
  assert.equal(share.recipes[0].professionalRevision, 1);
});

test('send: idempotente sulla stessa chiave', async () => {
  const { api, store } = harness(orgEntries());
  const payload = { organizationId: 'pianoNutrizionale', recipeIds: ['R1'], clientId: 'c1', idempotencyKey: 'send-x' };
  const first = await invoke(api, 'sendProfessionalRecipe', 'nutri1', payload);
  const second = await invoke(api, 'sendProfessionalRecipe', 'nutri1', payload);
  assert.equal(first.shareId, second.shareId);
});

test('send: cliente non assegnato o senza app → failed-precondition', async () => {
  const { api } = harness(orgEntries());
  assert.equal(await errCode(invoke(api, 'sendProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipeIds: ['R1'], clientId: 'c2', idempotencyKey: 's'
  })), 'failed-precondition');
  assert.equal(await errCode(invoke(api, 'sendProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipeIds: ['R1'], clientId: 'c3', idempotencyKey: 's'
  })), 'failed-precondition');
  assert.equal(await errCode(invoke(api, 'sendProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipeIds: ['R1'], clientId: 'c4', idempotencyKey: 's'
  })), 'not-found');
});

test('send: privata altrui → permission-denied, di studio → ok, creatore bypassa', async () => {
  const { api } = harness(orgEntries());
  assert.equal(await errCode(invoke(api, 'sendProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipeIds: ['R3'], clientId: 'c1', idempotencyKey: 's'
  })), 'permission-denied');
  const studio = await invoke(api, 'sendProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipeIds: ['R2'], clientId: 'c1', idempotencyKey: 's-studio'
  });
  assert.equal(studio.recipeCount, 1);
  const byCreator = await invoke(api, 'sendProfessionalRecipe', 'creator', {
    organizationId: 'pianoNutrizionale', recipeIds: ['R3'], clientId: 'c2', idempotencyKey: 's-creator'
  });
  assert.equal(byCreator.recipeCount, 1);
  assert.equal(await errCode(invoke(api, 'sendProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipeIds: ['R4'], clientId: 'c1', idempotencyKey: 's'
  })), 'failed-precondition');
  assert.equal(await errCode(invoke(api, 'sendProfessionalRecipe', 'nutri1', {
    organizationId: 'pianoNutrizionale', recipeIds: ['RX'], clientId: 'c1', idempotencyKey: 's'
  })), 'not-found');
});

// ---- cancel ----

test('cancel: mittente annulla la pendente, documento rimosso', async () => {
  const { api, store } = harness(orgEntries());
  const result = await invoke(api, 'cancelProfessionalShare', 'nutri1', {
    organizationId: 'pianoNutrizionale', shareId: 's1', idempotencyKey: 'c1'
  });
  assert.deepEqual(plain(result), { shareId: 's1', cancelled: true });
  assert.equal(store.has('recipeShares/s1'), false);
});

test('cancel: altri mittenti, creatore, non professionali, non pendenti', async () => {
  const { api } = harness(orgEntries());
  assert.equal(await errCode(invoke(api, 'cancelProfessionalShare', 'nutri2', {
    organizationId: 'pianoNutrizionale', shareId: 's1', idempotencyKey: 'c'
  })), 'permission-denied');
  assert.equal(await errCode(invoke(api, 'cancelProfessionalShare', 'nutri1', {
    organizationId: 'pianoNutrizionale', shareId: 's3', idempotencyKey: 'c'
  })), 'failed-precondition');
  assert.equal(await errCode(invoke(api, 'cancelProfessionalShare', 'nutri1', {
    organizationId: 'pianoNutrizionale', shareId: 'sx', idempotencyKey: 'c'
  })), 'not-found');
  const byCreator = await invoke(api, 'cancelProfessionalShare', 'creator', {
    organizationId: 'pianoNutrizionale', shareId: 's1', idempotencyKey: 'c-creator'
  });
  assert.equal(byCreator.cancelled, true);
});

// ---- listProfessionalShares ----

test('listProfessionalShares: solo pendenti professionali della org, per mittente', async () => {
  const { api } = harness(orgEntries());
  const mine = await invoke(api, 'listProfessionalShares', 'nutri1', { organizationId: 'pianoNutrizionale' });
  assert.deepEqual(plain(mine.shares.map(s => s.id)), ['s1']);
  const creator = await invoke(api, 'listProfessionalShares', 'creator', { organizationId: 'pianoNutrizionale' });
  assert.deepEqual(plain(creator.shares.map(s => s.id)), ['s1']);
  const other = await invoke(api, 'listProfessionalShares', 'nutri2', { organizationId: 'pianoNutrizionale' });
  assert.deepEqual(plain(other.shares), [], 'nutri2 non ha pendenti proprie (s2 è di altra org)');
});

// ---- parità client ----

test('RECIPE_SLOTS: parità esatta con js/domain.js SLOTS', () => {
  assert.deepEqual([...domain.RECIPE_SLOTS].sort(), [...ClientDomain.SLOTS].sort());
});
