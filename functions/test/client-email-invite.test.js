'use strict';
/* Inviti con EMAIL REALE: callable su Firestore finto con transazioni.
 *
 * Copre i requisiti del nuovo modello (ADR 0004):
 *  - invito monouso con solo hash del token, nome e cognome inseriti dal
 *    nutrizionista, scadenza, audit, idempotenza;
 *  - email tecnica legacy rifiutata per i clienti reali;
 *  - account già esistente → richiesta da accettare in app (nessuna seconda
 *    password, nessuna sovrascrittura);
 *  - associazione già attiva → bloccata con messaggi distinti e senza dati di
 *    altri professionisti;
 *  - riscatto con verifica email obbligatoria e token consumato una sola volta;
 *  - correzione/reinvio/annullamento dell'invito con vecchio link invalidato;
 *  - anagrafica e cambio email a due passi (proposta + conferma del cliente);
 *  - nessun tokenHash nelle risposte, nessuna password nei documenti;
 *  - consegna del link SEMPRE manuale (Copia link / Condividi link): nessun
 *    invio automatico di email, nessun provider, nessuno stato "invio fallito".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const domain = require('../src/domain');

const ORG = 'pianoNutrizionale';
const TOKEN_RE = /^[a-f0-9]{64}$/;

// Firestore finto: doc/collezioni, transazioni, collection group sugli inviti.
function harness({ entries = {}, users = {}, env, sandbox = true } = {}) {
  const store = new Map(Object.entries(entries).map(([key, value]) => [key, { ...value }]));
  const writes = [];
  // Scelta di App Check registrata per ogni callable: l'anteprima pubblica del
  // link deve restare l'unica con `enforceAppCheck: false` (fix del 500).
  const appCheckFlags = [];
  const value = path => store.get(path);
  const snapshot = path => {
    if (typeof path !== 'string') {
      const error = new Error(`percorso Firestore non valido: ${String(path)}`);
      if (process.env.DEBUG_EMAIL_INVITE) console.error(error.stack);
      throw error;
    }
    return {
      id: path.split('/').pop(),
      exists: store.has(path),
      data: () => value(path),
      ref: docRef(path)
    };
  };
  const docRef = path => ({
    path,
    id: path.split('/').pop(),
    get: async () => snapshot(path),
    create: async data => { writes.push(`create ${path}`); store.set(path, data); },
    set: async (data, options) => {
      writes.push(`set ${path}`);
      store.set(path, options?.merge ? { ...value(path), ...data } : data);
    },
    update: async patch => { writes.push(`update ${path}`); store.set(path, { ...value(path), ...patch }); },
    delete: async () => { writes.push(`delete ${path}`); store.delete(path); }
  });
  const collection = path => {
    const filters = [];
    let max = Infinity;
    const query = {
      select() { return query; },
      where(field, op, val) { assert.equal(op, '=='); filters.push([field, val]); return query; },
      limit(n) { max = n; return query; },
      async get() {
        const docs = [...store.keys()]
          .filter(key => key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1)
          .filter(key => filters.every(([field, val]) => value(key)[field] === val))
          .slice(0, max).map(snapshot);
        return { empty: docs.length === 0, size: docs.length, docs };
      }
    };
    return query;
  };
  const db = {
    collection,
    doc: docRef,
    collectionGroup(name) {
      const query = {
        where(field, op, val) { assert.equal(op, '=='); query._filter = [field, val]; return query; },
        limit(n) { query._max = n; return query; },
        async get() {
          const docs = [...store.keys()]
            .filter(key => key.split('/').at(-2) === name)
            .filter(key => !query._filter || value(key)[query._filter[0]] === query._filter[1])
            .slice(0, query._max || Infinity).map(snapshot);
          return { empty: docs.length === 0, size: docs.length, docs };
        }
      };
      return query;
    },
    async runTransaction(fn) {
      const tx = {
        // La transazione accetta sia riferimenti documento sia query (stesso
        // contratto di Firestore: `tx.get(query)` restituisce una snapshot).
        get: async ref => (ref && typeof ref.path === 'string' ? snapshot(ref.path) : ref.get()),
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
  const authUsers = new Map(Object.entries(users));
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const context = {
    exports: {}, console, Date, Set, Map,
    require(name) {
      if (name === './domain') return domain;
      // Nessun servizio email: il backend costruisce solo il link. Qualsiasi
      // tentativo di caricare un modulo di invio deve far fallire il test.
      if (name === 'node:crypto') return require(name);
      if (name === 'firebase-functions/v2/https') return { HttpsError, onCall: (options, handler) => {
        assert.equal(options.region, 'europe-west1');
        // Callable private (true) e callable pubbliche come l'anteprima invito
        // (false): conta che la scelta sia esplicita, non il singolo valore.
        assert.ok(typeof options.enforceAppCheck === 'boolean');
        appCheckFlags.push(options.enforceAppCheck); return handler;
      } };
      if (name === 'firebase-functions/v2/scheduler') return { onSchedule: () => null };
      if (name === 'firebase-functions') return {
        logger: {
          error: (message, meta) => { if (process.env.DEBUG_EMAIL_INVITE) console.error('[logger.error]', message, meta); },
          warn: () => {}, info: () => {}
        }
      };
      if (name === 'firebase-admin/app') return { initializeApp() {} };
      if (name === 'firebase-admin/firestore') {
        return {
          getFirestore: () => db,
          FieldValue: { serverTimestamp: () => 'server-timestamp', increment: n => ({ increment: n }) },
          Timestamp: {
            fromDate: date => ({ toDate: () => date, toISOString: () => date.toISOString() }),
            now: () => ({ toDate: () => new Date(), toISOString: () => new Date().toISOString() }),
            fromMillis: millis => ({ toDate: () => new Date(millis), toISOString: () => new Date(millis).toISOString() })
          }
        };
      }
      if (name === 'firebase-admin/auth') return {
        getAuth: () => ({
          getUserByEmail: async email => {
            const found = authUsers.get(String(email).toLowerCase());
            if (!found) { const error = new Error('utente non trovato'); error.code = 'auth/user-not-found'; throw error; }
            return found;
          },
          updateUser: async (uid, patch) => {
            for (const [email, user] of [...authUsers]) {
              if (user.uid !== uid) continue;
              authUsers.delete(email);
              authUsers.set(String(patch.email || email).toLowerCase(), { ...user, ...patch });
            }
            return { uid, ...patch };
          },
          deleteUser: async uid => {
            for (const [email, user] of [...authUsers]) {
              if (user.uid === uid) authUsers.delete(email);
            }
          }
        })
      };
      throw new Error(`Unexpected dependency ${name}`);
    }
  };
  if (!sandbox) delete context.require;
  if (env !== undefined) context.process = { env };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/index'), 'utf8'), context);
  return { api: context.exports, store, writes, authUsers, appCheckFlags };
}

const invoke = (api, name, uid, data, auth = {}) => api[name]({
  auth: uid ? { uid, token: { email: auth.email || null, email_verified: auth.emailVerified === true } } : null,
  data
});
const publicInvite = (api, uid, data) => invoke(api, 'getClientInvitePreview', null, data);

const base = () => ({
  [`organizations/${ORG}`]: { name: 'Studio Piano', status: 'active' },
  [`organizations/${ORG}/members/nutri-1`]: { role: 'nutritionist', status: 'active', username: 'nutrizionista', displayName: 'Dott.ssa Verdi' },
  [`organizations/${ORG}/members/nutri-2`]: { role: 'nutritionist', status: 'active', username: 'altro' },
  'platformMembers/admin-1': { role: 'admin', status: 'active' }
});

// Indirizzo pubblico fisso dell'app: base di ogni link d'invito.
const APP_URL = 'https://sylarpower.github.io/pianoNutrizionale';

const invite = (api, extra = {}) => invoke(api, 'inviteClientByEmail', 'nutri-1', {
  organizationId: ORG, email: 'Mario.Rossi@Esempio.it', firstName: 'Mario', lastName: 'Rossi',
  nutritionistUid: null, idempotencyKey: 'k1', ...extra
});

test('invito reale: profilo in attesa, token monouso e nessun dato sensibile nel documento', async () => {
  const { api, store } = harness({ entries: base() });
  const result = await invite(api);
  assert.equal(result.status, 'invited');
  assert.match(result.inviteUrl, /#\/invito\/[a-f0-9]{64}$/);
  assert.ok(result.inviteUrl.startsWith(`${APP_URL}/#/invito/`), 'il link punta all’app pubblica');
  assert.equal(result.delivery.status, 'manual');
  assert.equal(result.delivery.channel, 'manual-link');
  const inviteDoc = store.get(`organizations/${ORG}/invitations/${result.inviteId}`);
  assert.equal(inviteDoc.type, 'clientEmail');
  assert.equal(inviteDoc.status, 'pending');
  assert.equal(inviteDoc.targetEmailNormalized, 'mario.rossi@esempio.it');
  assert.equal(inviteDoc.firstName, 'Mario');
  assert.equal(inviteDoc.lastName, 'Rossi');
  assert.equal(inviteDoc.nutritionistUid, 'nutri-1');
  assert.match(inviteDoc.tokenHash, /^[a-f0-9]{64}$/);
  assert.ok(!result.inviteUrl.includes(inviteDoc.tokenHash), 'in chiaro e hash sono diversi');
  for (const forbidden of ['password', 'token', 'credentials']) {
    assert.ok(!Object.keys(inviteDoc).includes(forbidden), `nessun campo ${forbidden} nel documento`);
  }
  assert.ok(!JSON.stringify(result).includes('tokenHash'), 'il tokenHash non compare mai nelle risposte');
  const client = store.get(`organizations/${ORG}/clients/${result.clientId}`);
  assert.equal(client.status, 'pending');
  assert.equal(client.authUid, null);
  assert.equal(client.email, 'mario.rossi@esempio.it');
  assert.deepEqual([...client.nutritionistUids], ['nutri-1']);
  assert.ok([...store.keys()].some(key => key.startsWith(`organizations/${ORG}/auditLog/`)), 'audit scritto');
});

test('invito reale: idempotenza sullo stesso idempotencyKey', async () => {
  const { api, store } = harness({ entries: base() });
  const first = await invite(api);
  const second = await invite(api);
  assert.equal(second.status, 'already-pending');
  assert.equal(second.idempotentReplay, true);
  assert.equal(second.inviteId, first.inviteId);
  const invites = [...store.keys()].filter(key => key.startsWith(`organizations/${ORG}/invitations/`));
  assert.equal(invites.length, 1, 'nessun secondo invito creato');
});

test('invito reale: indirizzo tecnico legacy rifiutato, account di test sul flusso separato', async () => {
  const { api, store } = harness({ entries: base() });
  await assert.rejects(
    invite(api, { email: 'cliente-nuovo@utenti.pianonutrizionale.app' }),
    error => error.code === 'invalid-argument' && /tecnic/i.test(error.message)
  );
  assert.equal([...store.keys()].filter(key => key.startsWith(`organizations/${ORG}/invitations/`)).length, 0);
});

test('invito reale: la creazione di nuovi account tecnici richiede il flag esplicito', async () => {
  const data = { organizationId: ORG, username: 'cliente-tecnico', nutritionistUid: null, idempotencyKey: 'lk1' };
  const blocked = harness({ entries: base(), env: { LEGACY_TEST_INVITES_ENABLED: 'false' } });
  await assert.rejects(
    invoke(blocked.api, 'inviteClientLink', 'nutri-1', data),
    error => error.code === 'failed-precondition' && /account tecnici/i.test(error.message)
  );
  assert.equal([...blocked.store.keys()].filter(key => key.startsWith(`organizations/${ORG}/invitations/`)).length, 0);

  const allowed = harness({ entries: base(), env: { LEGACY_TEST_INVITES_ENABLED: 'true' } });
  const result = await invoke(allowed.api, 'inviteClientLink', 'nutri-1', data);
  assert.equal(result.status, 'invited');
  assert.match(result.token, TOKEN_RE);
  const inviteDoc = allowed.store.get(`organizations/${ORG}/invitations/${result.inviteId}`);
  assert.equal(inviteDoc.channel, 'legacy-test', 'il flusso legacy è dichiarato nel documento');
});

test('account esistente senza associazione: richiesta in app, nessun secondo account', async () => {
  const { api, store } = harness({ entries: base(), users: { 'mario.rossi@esempio.it': { uid: 'uid-mario', email: 'mario.rossi@esempio.it', disabled: false } } });
  const result = await invite(api);
  assert.equal(result.status, 'link-request-created');
  const request = store.get(`organizations/${ORG}/clientLinkRequests/${result.requestId}`);
  assert.equal(request.channel, 'email');
  assert.equal(request.targetUid, 'uid-mario');
  assert.equal(request.status, 'pending');
  assert.ok(!request.password, 'nessuna password nelle richieste');
  assert.ok([...store.keys()].some(key => key === `organizations/${ORG}/clients/${result.clientId}`));
  assert.ok(![...store.keys()].some(key => key.startsWith(`organizations/${ORG}/invitations/`)), 'nessun invito monouso per un account esistente');
});

test('account esistente ma disabilitato: errore amministrativo, nessuna nuova identità', async () => {
  const { api } = harness({ entries: base(), users: { 'mario.rossi@esempio.it': { uid: 'uid-mario', email: 'mario.rossi@esempio.it', disabled: true } } });
  await assert.rejects(invite(api), error => error.code === 'failed-precondition' && /disabilitato/i.test(error.message));
});

test('associazione già attiva: stesso professionista o altro, mai dati di altri', async () => {
  const same = harness({
    entries: {
      ...base(),
      'accountClientLinks/uid-mario': { organizationId: ORG, clientId: 'client-1', status: 'active' },
      [`organizations/${ORG}/clients/client-1`]: { status: 'active', displayName: 'Mario Rossi', nutritionistUids: ['nutri-1'], authUid: 'uid-mario' }
    },
    users: { 'mario.rossi@esempio.it': { uid: 'uid-mario', email: 'mario.rossi@esempio.it' } }
  });
  const sameResult = await invite(same.api);
  assert.equal(sameResult.status, 'already-linked-same');
  assert.equal(sameResult.clientId, 'client-1');

  const other = harness({
    entries: {
      ...base(),
      'accountClientLinks/uid-mario': { organizationId: ORG, clientId: 'client-9', status: 'active' },
      [`organizations/${ORG}/clients/client-9`]: { status: 'active', displayName: 'Mario Rossi', nutritionistUids: ['nutri-2'], authUid: 'uid-mario' }
    },
    users: { 'mario.rossi@esempio.it': { uid: 'uid-mario', email: 'mario.rossi@esempio.it' } }
  });
  const otherResult = await invite(other.api);
  assert.equal(otherResult.status, 'already-linked-other');
  assert.ok(!JSON.stringify(otherResult).includes('nutri-2'), 'nessun riferimento ad altri professionisti');
  assert.ok(!JSON.stringify(otherResult).includes('client-9'), 'nessun id di clienti altrui');
});

test('anteprima invito: dati precompilati, scaduto, usato e sostituito', async () => {
  const { api, store, appCheckFlags } = harness({ entries: base() });
  const created = await invite(api);
  const token = created.inviteUrl.split('/').pop();
  const preview = await publicInvite(api, null, { token });
  assert.equal(preview.status, 'valid');
  assert.equal(preview.email, 'mario.rossi@esempio.it');
  assert.deepEqual([preview.firstName, preview.lastName], ['Mario', 'Rossi']);
  assert.equal(preview.nutritionistName, 'Dott.ssa Verdi');
  assert.equal(preview.organizationName, 'Studio Piano');
  assert.ok(!JSON.stringify(preview).includes('tokenHash'));
  // Callable pubblica: App Check NON richiesto, altrimenti il link aperto fuori
  // dall'app registrata riceve un errore e l'anteprima non si carica (500).
  assert.equal(appCheckFlags.filter(flag => flag === false).length, 1, 'solo l’anteprima dell’invito è pubblica');

  const withTokenHash = [...store.values()].some(doc => doc?.tokenHash === token);
  assert.equal(withTokenHash, false, 'in chiaro e hash non coincidono');

  const expired = harness({ entries: base() });
  const expiredInvite = await invite(expired.api);
  const expiredToken = expiredInvite.inviteUrl.split('/').pop();
  const expiredPath = `organizations/${ORG}/invitations/${expiredInvite.inviteId}`;
  expired.store.get(expiredPath).expiresAt = { toDate: () => new Date(Date.now() - 1000), toISOString: () => new Date(Date.now() - 1000).toISOString() };
  assert.equal((await publicInvite(expired.api, null, { token: expiredToken })).status, 'expired');
  // Invito scaduto: il link non si recupera più, serve "Genera nuovo link".
  await assert.rejects(
    invoke(expired.api, 'getClientInviteLink', 'nutri-1', { organizationId: ORG, inviteId: expiredInvite.inviteId }),
    error => error.code === 'failed-precondition' && /scaduto/i.test(error.message)
  );
  // Invito inesistente: not-found con messaggio utilizzabile dalla console.
  await assert.rejects(
    invoke(api, 'getClientInviteLink', 'nutri-1', { organizationId: ORG, inviteId: 'invito-inesistente' }),
    error => error.code === 'not-found'
  );

  const used = harness({ entries: base() });
  const usedInvite = await invite(used.api);
  used.store.get(`organizations/${ORG}/invitations/${usedInvite.inviteId}`).status = 'accepted';
  assert.equal((await publicInvite(used.api, null, { token: usedInvite.inviteUrl.split('/').pop() })).status, 'used');

  const superseded = harness({ entries: base() });
  const supersededInvite = await invite(superseded.api);
  superseded.store.get(`organizations/${ORG}/invitations/${supersededInvite.inviteId}`).status = 'superseded';
  assert.equal((await publicInvite(superseded.api, null, { token: supersededInvite.inviteUrl.split('/').pop() })).status, 'superseded');

  assert.equal((await publicInvite(api, null, { token: 'b'.repeat(64) })).status, 'not-found');
});

test('riscatto: email verificata obbligatoria, token consumato una sola volta', async () => {
  const { api, store } = harness({ entries: base() });
  const created = await invite(api);
  const token = created.inviteUrl.split('/').pop();
  const idempotencyKey = 'redeem-1';

  const unverified = await invoke(api, 'redeemClientInvite', 'uid-mario', { token, idempotencyKey }, { email: 'mario.rossi@esempio.it', emailVerified: false });
  assert.equal(unverified.status, 'email-verification-required');
  assert.equal(store.get(`organizations/${ORG}/invitations/${created.inviteId}`).status, 'pending', 'token non consumato prima della verifica');

  await assert.rejects(
    invoke(api, 'redeemClientInvite', 'uid-anna', { token, idempotencyKey }, { email: 'anna@esempio.it', emailVerified: true }),
    error => error.code === 'permission-denied'
  );

  const accepted = await invoke(api, 'redeemClientInvite', 'uid-mario', { token, idempotencyKey }, { email: 'mario.rossi@esempio.it', emailVerified: true });
  assert.equal(accepted.status, 'link-active');
  assert.equal(accepted.clientId, created.clientId);
  const client = store.get(`organizations/${ORG}/clients/${created.clientId}`);
  assert.equal(client.status, 'active');
  assert.equal(client.authUid, 'uid-mario');
  assert.equal(client.emailVerified, true);
  assert.deepEqual([...client.nutritionistUids], ['nutri-1']);
  const link = store.get('accountClientLinks/uid-mario');
  assert.equal(link.status, 'active');
  assert.equal(link.clientId, created.clientId);
  assert.equal(store.get(`organizations/${ORG}/invitations/${created.inviteId}`).status, 'accepted');
  // Cliente attivo: il segreto del link non esiste più e "Copia link" si ferma.
  assert.equal(store.has(`organizations/${ORG}/invitationSecrets/${created.inviteId}`), false, 'segreto eliminato al riscatto');
  await assert.rejects(
    invoke(api, 'getClientInviteLink', 'nutri-1', { organizationId: ORG, inviteId: created.inviteId }),
    error => error.code === 'failed-precondition' && /già utilizzato/i.test(error.message)
  );

  const again = await invoke(api, 'redeemClientInvite', 'uid-mario', { token, idempotencyKey }, { email: 'mario.rossi@esempio.it', emailVerified: true });
  assert.equal(again.status, 'already-linked', 'il token non è riutilizzabile');
});

test('riscatto senza token: si completa con l’email autenticata e verificata', async () => {
  const { api } = harness({ entries: base() });
  const created = await invite(api);
  // Il cliente si è appena registrato: il token può essere perso, ma l'invito
  // resta recuperabile con l'email autenticata e verificata.
  const result = await invoke(api, 'redeemClientInvite', 'uid-mario', { token: null, idempotencyKey: 'r1' }, { email: 'mario.rossi@esempio.it', emailVerified: true });
  assert.equal(result.status, 'link-active');
  assert.equal(result.clientId, created.clientId);
  const noInvite = await invoke(api, 'redeemClientInvite', 'uid-anna', { token: null, idempotencyKey: 'r2' }, { email: 'anna@esempio.it', emailVerified: true });
  assert.equal(noInvite.status, 'no-pending-invite');
});

test('correzione invito: nuovo token, vecchio link invalidato, audit dello storico', async () => {
  const { api, store } = harness({ entries: base() });
  const created = await invite(api);
  const oldToken = created.inviteUrl.split('/').pop();
  const fixed = await invoke(api, 'correctClientInvite', 'nutri-1', {
    organizationId: ORG, inviteId: created.inviteId, email: 'maria.bianchi@esempio.it',
    firstName: 'Maria', lastName: 'Bianchi', idempotencyKey: 'fix-1'
  });
  assert.equal(fixed.status, 'invite-corrected');
  assert.notEqual(fixed.inviteId, created.inviteId, 'la correzione crea un nuovo invito');
  assert.equal((await publicInvite(api, null, { token: oldToken })).status, 'superseded');
  const newToken = fixed.inviteUrl.split('/').pop();
  const preview = await publicInvite(api, null, { token: newToken });
  assert.equal(preview.status, 'valid');
  assert.equal(preview.email, 'maria.bianchi@esempio.it');
  const oldDoc = store.get(`organizations/${ORG}/invitations/${created.inviteId}`);
  assert.equal(oldDoc.status, 'superseded');
  assert.equal(oldDoc.supersededBy, fixed.inviteId);
  // Il segreto segue l'invito corretto: il vecchio link non è più consegnabile,
  // "Copia link" sul nuovo invito restituisce il nuovo link.
  assert.equal(store.has(`organizations/${ORG}/invitationSecrets/${created.inviteId}`), false, 'segreto vecchio eliminato');
  assert.equal(store.get(`organizations/${ORG}/invitationSecrets/${fixed.inviteId}`).token, newToken);
  assert.equal(
    (await invoke(api, 'getClientInviteLink', 'nutri-1', { organizationId: ORG, inviteId: fixed.inviteId })).inviteUrl,
    fixed.inviteUrl
  );
  await assert.rejects(
    invoke(api, 'getClientInviteLink', 'nutri-1', { organizationId: ORG, inviteId: created.inviteId }),
    error => error.code === 'failed-precondition' && /sostituito/i.test(error.message)
  );
  const client = store.get(`organizations/${ORG}/clients/${fixed.clientId}`);
  assert.equal(client.firstName, 'Maria');
  assert.equal(client.lastName, 'Bianchi');
  assert.equal(client.email, 'maria.bianchi@esempio.it');
  assert.ok([...store.keys()].some(key => JSON.stringify(store.get(key))?.includes('client.email-invite-corrected')), 'audit della correzione');
});

test('reinvio e annullamento: ruotano il token, mai due inviti pendenti', async () => {
  const { api, store } = harness({ entries: base() });
  const created = await invite(api);
  const firstToken = created.inviteUrl.split('/').pop();

  // Link persistente: la console lo recupera senza rigenerare nulla (bottone
  // "Copia link"). Stesso token, stessa scadenza, nessun nuovo invito.
  const secretPath = `organizations/${ORG}/invitationSecrets/${created.inviteId}`;
  assert.equal(store.get(secretPath).token, firstToken, 'il segreto conserva il token emesso');
  assert.equal(store.get(secretPath).tokenHash, store.get(`organizations/${ORG}/invitations/${created.inviteId}`).tokenHash);
  const copied = await invoke(api, 'getClientInviteLink', 'nutri-1', { organizationId: ORG, inviteId: created.inviteId });
  assert.equal(copied.inviteUrl, created.inviteUrl, 'nessuna rigenerazione del link');
  assert.equal(copied.token, firstToken);
  assert.equal(copied.type, 'clientEmail');
  assert.equal(copied.targetEmail, 'mario.rossi@esempio.it');
  assert.deepEqual([copied.firstName, copied.lastName], ['Mario', 'Rossi']);
  assert.equal(copied.clientId, created.clientId);
  assert.deepEqual({ ...copied.delivery }, { channel: 'manual' }, 'consegna a mano');
  assert.equal(copied.expiresAt, created.expiresAt, 'la scadenza non cambia');
  assert.equal(await invoke(api, 'getInviteLink', 'admin-1', { organizationId: ORG, inviteId: created.inviteId }).then(r => r.inviteUrl), created.inviteUrl, 'alias getInviteLink');
  assert.equal([...store.keys()].filter(key => key.startsWith(`organizations/${ORG}/invitations/`)).length, 1, 'recuperare il link non crea inviti');
  // Un professionista diverso non ottiene il link.
  await assert.rejects(
    invoke(api, 'getClientInviteLink', 'nutri-2', { organizationId: ORG, inviteId: created.inviteId }),
    error => error.code === 'permission-denied'
  );

  const resent = await invoke(api, 'resendClientInvite', 'nutri-1', {
    organizationId: ORG, inviteId: created.inviteId, idempotencyKey: 'resend-1'
  });
  assert.equal(resent.status, 'invite-resent');
  const secondToken = resent.inviteUrl.split('/').pop();
  assert.notEqual(firstToken, secondToken);
  assert.equal((await publicInvite(api, null, { token: firstToken })).status, 'not-found', 'il vecchio link non esiste più');
  assert.equal((await publicInvite(api, null, { token: secondToken })).status, 'valid');
  // Il segreto ruota con l'invito: "Copia link" consegna sempre il link nuovo.
  assert.equal(store.get(secretPath).token, secondToken);
  assert.equal((await invoke(api, 'getClientInviteLink', 'nutri-1', { organizationId: ORG, inviteId: created.inviteId })).inviteUrl, resent.inviteUrl);

  const cancelled = await invoke(api, 'cancelClientInvite', 'nutri-1', {
    organizationId: ORG, inviteId: created.inviteId, reason: 'Richiesta ritirata', idempotencyKey: 'cancel-1'
  });
  assert.equal(cancelled.status, 'revoked');
  assert.equal((await publicInvite(api, null, { token: secondToken })).status, 'revoked');
  // Invito annullato: il segreto sparisce e la console non mostra più il link.
  assert.equal(store.has(secretPath), false, 'segreto eliminato all’annullamento');
  await assert.rejects(
    invoke(api, 'getClientInviteLink', 'nutri-1', { organizationId: ORG, inviteId: created.inviteId }),
    error => error.code === 'failed-precondition' && /annullato/i.test(error.message)
  );
  const replay = await invoke(api, 'cancelClientInvite', 'nutri-1', {
    organizationId: ORG, inviteId: created.inviteId, reason: 'Richiesta ritirata', idempotencyKey: 'cancel-1'
  });
  assert.equal(replay.status, 'already-revoked', 'idempotenza sull’annullamento');
});

test('permessi: un nutritionist non tocca gli inviti di un altro', async () => {
  const { api } = harness({ entries: base() });
  const created = await invite(api);
  await assert.rejects(
    invoke(api, 'correctClientInvite', 'nutri-2', {
      organizationId: ORG, inviteId: created.inviteId, email: 'x@esempio.it', firstName: 'X', lastName: 'Y',
      idempotencyKey: 'fix-2'
    }),
    error => error.code === 'permission-denied'
  );
  await assert.rejects(
    invoke(api, 'resendClientInvite', 'nutri-2', { organizationId: ORG, inviteId: created.inviteId, idempotencyKey: 'resend-2' }),
    error => error.code === 'permission-denied'
  );
});

test('anagrafica dal professionista: nome, cognome ed email aggiornati direttamente', async () => {
  const { api, store } = harness({
    entries: {
      ...base(),
      [`organizations/${ORG}/clients/client-1`]: { status: 'active', displayName: 'Mario Rossi', email: 'mario.vecchio@esempio.it', emailNormalized: 'mario.vecchio@esempio.it', authUid: 'uid-mario', nutritionistUids: ['nutri-1'] },
      [`organizations/${ORG}/clients/client-9`]: { status: 'active', displayName: 'Altro', authUid: 'uid-altro', nutritionistUids: ['nutri-2'] }
    }
  });
  const result = await invoke(api, 'updateClientProfileByStaff', 'nutri-1', {
    organizationId: ORG, clientId: 'client-1', firstName: 'Mario', lastName: 'Rossi', email: 'mario.nuovo@esempio.it', idempotencyKey: 'p1'
  });
  assert.equal(result.firstName, 'Mario');
  assert.equal(result.lastName, 'Rossi');
  assert.equal(result.email, 'mario.nuovo@esempio.it');
  assert.equal(store.get(`organizations/${ORG}/clients/client-1`).email, 'mario.nuovo@esempio.it');
  await assert.rejects(
    invoke(api, 'updateClientProfileByStaff', 'nutri-1', {
      organizationId: ORG, clientId: 'client-9', firstName: 'Mario', lastName: 'Rossi', idempotencyKey: 'p2'
    }),
    error => error.code === 'permission-denied'
  );
});

test('eliminazione definitiva cliente: solo creatore/admin, wipe completo', async () => {
  const { api, store } = harness({
    entries: {
      ...base(),
      [`organizations/${ORG}/clients/client-wipe`]: { status: 'active', email: 'wipe@esempio.it', authUid: 'uid-wipe', nutritionistUids: ['nutri-1'] },
      [`organizations/${ORG}/clients/client-wipe/assignments/a1`]: { status: 'active' },
      [`organizations/${ORG}/clients/client-wipe/state/activeAssignment`]: { assignmentId: 'a1' },
      'accountClientLinks/uid-wipe': { organizationId: ORG, clientId: 'client-wipe', status: 'active' },
      [`organizations/${ORG}/invitations/inv-wipe`]: { clientId: 'client-wipe', status: 'pending' }
    }
  });
  // Nutrizionista non può eliminare definitivamente
  await assert.rejects(
    invoke(api, 'deleteClientPermanently', 'nutri-1', {
      organizationId: ORG, clientId: 'client-wipe', idempotencyKey: 'w1'
    }),
    error => error.code === 'permission-denied'
  );
  // Creatore (admin) può eliminare
  const res = await invoke(api, 'deleteClientPermanently', 'admin-1', {
    organizationId: ORG, clientId: 'client-wipe', idempotencyKey: 'w2'
  });
  assert.equal(res.status, 'deleted-permanently');
  assert.equal(store.has(`organizations/${ORG}/clients/client-wipe`), false);
  assert.equal(store.has('accountClientLinks/uid-wipe'), false);
  assert.equal(store.has(`organizations/${ORG}/invitations/inv-wipe`), false);
});

test('cambio email: nulla cambia finché il cliente non conferma; poi serve nuova verifica', async () => {
  const entries = {
    ...base(),
    'accountClientLinks/uid-mario': { organizationId: ORG, clientId: 'client-1', status: 'active' },
    [`organizations/${ORG}/clients/client-1`]: {
      status: 'active', displayName: 'Mario Rossi', firstName: 'Mario', lastName: 'Rossi',
      authUid: 'uid-mario', nutritionistUids: ['nutri-1'], email: 'mario.rossi@esempio.it', emailNormalized: 'mario.rossi@esempio.it', emailVerified: true
    }
  };
  const { api, store, authUsers } = harness({ entries, users: { 'mario.rossi@esempio.it': { uid: 'uid-mario', email: 'mario.rossi@esempio.it' } } });
  const proposal = await invoke(api, 'proposeClientEmailChange', 'nutri-1', {
    organizationId: ORG, clientId: 'client-1', newEmail: 'Nuova.Email@Esempio.it', reason: 'Correzione', idempotencyKey: 'e1'
  });
  assert.equal(proposal.status, 'requested');
  assert.equal(store.get(`organizations/${ORG}/clients/client-1`).emailNormalized, 'mario.rossi@esempio.it', 'il profilo non cambia prima della conferma');
  assert.ok(!authUsers.get('nuova.email@esempio.it'), 'nessun account creato dalla proposta');

  const rejected = await invoke(api, 'respondMyEmailChange', 'uid-mario', { requestId: proposal.requestId, decision: 'reject', idempotencyKey: 'e2' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(store.get(`organizations/${ORG}/emailChangeRequests/${proposal.requestId}`).status, 'rejected');

  const second = await invoke(api, 'proposeClientEmailChange', 'nutri-1', {
    organizationId: ORG, clientId: 'client-1', newEmail: 'nuova.email@esempio.it', reason: '', idempotencyKey: 'e3'
  });
  const accepted = await invoke(api, 'respondMyEmailChange', 'uid-mario', { requestId: second.requestId, decision: 'accept', idempotencyKey: 'e4' });
  assert.equal(accepted.status, 'email-changed');
  assert.equal(accepted.requiresVerification, true);
  assert.equal(store.get(`organizations/${ORG}/clients/client-1`).emailNormalized, 'nuova.email@esempio.it');
  assert.equal(store.get(`organizations/${ORG}/clients/client-1`).emailVerified, false);
  assert.equal(authUsers.get('nuova.email@esempio.it').emailVerified, false, 'nuova verifica obbligatoria in Auth');

  await assert.rejects(
    invoke(api, 'respondMyEmailChange', 'uid-altro', { requestId: second.requestId, decision: 'accept', idempotencyKey: 'e5' }),
    error => error.code === 'not-found',
    'solo il destinatario vede e risponde'
  );
});

test('cambio email verso un indirizzo già usato o tecnico: bloccato senza rivelare nulla', async () => {
  const entries = {
    ...base(),
    [`organizations/${ORG}/clients/client-1`]: {
      status: 'active', displayName: 'Mario Rossi', authUid: 'uid-mario', nutritionistUids: ['nutri-1'],
      email: 'mario.rossi@esempio.it', emailNormalized: 'mario.rossi@esempio.it', emailVerified: true
    },
    [`organizations/${ORG}/clients/client-2`]: { status: 'active', displayName: 'Anna', authUid: 'uid-anna', nutritionistUids: ['nutri-1'], email: 'anna@esempio.it', emailNormalized: 'anna@esempio.it' }
  };
  const { api } = harness({ entries, users: { 'anna@esempio.it': { uid: 'uid-anna', email: 'anna@esempio.it' } } });
  await assert.rejects(
    invoke(api, 'proposeClientEmailChange', 'nutri-1', { organizationId: ORG, clientId: 'client-1', newEmail: 'anna@esempio.it', reason: '', idempotencyKey: 'e1' }),
    error => error.code === 'already-exists'
  );
  await assert.rejects(
    invoke(api, 'proposeClientEmailChange', 'nutri-1', { organizationId: ORG, clientId: 'client-1', newEmail: 'x@utenti.pianonutrizionale.app', reason: '', idempotencyKey: 'e2' }),
    error => error.code === 'invalid-argument'
  );
});

test('clienti con account tecnico legacy: nessun cambio email, nessuna conversione automatica', async () => {
  const entries = {
    ...base(),
    [`organizations/${ORG}/clients/client-legacy`]: {
      status: 'active', displayName: 'Cliente Demo', authUid: 'uid-demo', nutritionistUids: ['nutri-1'],
      invitedUsername: 'cliente-demo'
    }
  };
  const { api, store } = harness({ entries });
  await assert.rejects(
    invoke(api, 'proposeClientEmailChange', 'nutri-1', {
      organizationId: ORG, clientId: 'client-legacy', newEmail: 'cliente.demo@esempio.it', reason: '', idempotencyKey: 'e1'
    }),
    error => error.code === 'failed-precondition' && /legacy/i.test(error.message)
  );
  const client = store.get(`organizations/${ORG}/clients/client-legacy`);
  assert.equal(client.email, undefined, 'nessuna email reale aggiunta automaticamente');
});

test('prima della verifica il cliente non accede ad alcun dato professionale', async () => {
  const { api, store, authUsers } = harness({ entries: base() });
  const created = await invite(api);
  const token = created.inviteUrl.split('/').pop();

  // Cliente registrato ma non ancora verificato: il collegamento non esiste e
  // il server risponde "unassigned" (nessun dato del professionista).
  const beforeVerification = await invoke(api, 'getMyAssignedProfile', 'uid-mario', {});
  assert.equal(beforeVerification.state, 'unassigned');
  assert.equal(beforeVerification.fallback, 'original-only');

  // Anche un collegamento non ancora attivo non apre nulla.
  store.set('accountClientLinks/uid-mario', { organizationId: ORG, clientId: created.clientId, status: 'pending' });
  const pendingLink = await invoke(api, 'getMyAssignedProfile', 'uid-mario', {});
  assert.equal(pendingLink.state, 'unassigned');

  const redeemed = await invoke(api, 'redeemClientInvite', 'uid-mario', { token, idempotencyKey: 'r1' }, { email: 'mario.rossi@esempio.it', emailVerified: true });
  assert.equal(redeemed.status, 'link-active');
  assert.equal(store.get(`organizations/${ORG}/clients/${created.clientId}`).emailVerified, true);
  assert.equal(authUsers.size, 0, 'il riscatto non tocca Firebase Auth: la verifica arriva dal client');
});

test('consegna sempre manuale: link restituito alla console, nessun invio email e nessuno stato di invio fallito', async () => {
  const { api, store } = harness({ entries: base() });
  // Il vecchio campo `delivery` non esiste più: una console non aggiornata
  // riceve un errore esplicito invece di un invio "silenzioso".
  await assert.rejects(
    invite(api, { delivery: 'email' }),
    error => error.code === 'invalid-argument' && /campi non ammessi/.test(error.message)
  );
  const result = await invite(api);
  assert.equal(result.status, 'invited');
  assert.match(result.message, /Copia link|Condividi link/, 'il messaggio guida alla consegna a mano');
  assert.ok(result.inviteUrl.startsWith(`${APP_URL}/#/invito/`));
  assert.equal(result.deliveryError, undefined, 'nessun errore di consegna possibile');
  const inviteDoc = store.get(`organizations/${ORG}/invitations/${result.inviteId}`);
  assert.equal(inviteDoc.status, 'pending', 'l’invito è utilizzabile');
  assert.equal(inviteDoc.delivery.channel, 'manual-link');
  assert.equal(inviteDoc.delivery.status, 'manual');
  assert.equal(inviteDoc.delivery.handedToConsole, true);
  assert.equal(inviteDoc.delivery.errorCode, undefined, 'nessun codice di errore di invio');
  assert.equal(inviteDoc.delivery.provider, undefined, 'nessun provider email');
  const auditTypes = [...store.keys()]
    .filter(key => key.startsWith(`organizations/${ORG}/auditLog/`))
    .map(key => store.get(key)?.type);
  assert.ok(auditTypes.includes('client.email-invite-delivered'), 'audit della consegna alla console');
  assert.ok(!auditTypes.includes('client.email-invite-delivery-failed'), 'nessun audit di invio fallito');
  // Anche reinvio e correzione restituiscono sempre il link, senza scelta di consegna.
  const resent = await invoke(api, 'resendClientInvite', 'nutri-1', { organizationId: ORG, inviteId: result.inviteId, idempotencyKey: 'resend-manual' });
  assert.equal(resent.status, 'invite-resent');
  assert.ok(resent.inviteUrl.startsWith(`${APP_URL}/#/invito/`));
  await assert.rejects(
    invoke(api, 'resendClientInvite', 'nutri-1', { organizationId: ORG, inviteId: result.inviteId, delivery: 'manual-link', idempotencyKey: 'resend-old' }),
    error => error.code === 'invalid-argument'
  );
  const fixed = await invoke(api, 'correctClientInvite', 'nutri-1', {
    organizationId: ORG, inviteId: result.inviteId, email: 'mario.rossi@esempio.it', firstName: 'Mario', lastName: 'Rossi', idempotencyKey: 'fix-manual'
  });
  assert.equal(fixed.status, 'invite-corrected');
  assert.ok(fixed.inviteUrl.startsWith(`${APP_URL}/#/invito/`));
});
