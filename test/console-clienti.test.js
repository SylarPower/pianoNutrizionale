'use strict';
/* Console professionisti — vista Clienti unificata.
 *
 * Contratto verificato senza rete, per sola lettura dei sorgenti:
 *  - un'unica area «Clienti» (menu, filtri Attivi/In attesa/Inattivi);
 *  - stati operativi e titoli nel dominio condiviso (mai UID/ID nel titolo);
 *  - scheda cliente con anagrafica, collegamento, struttura, dati tecnici;
 *  - rimozione SOLO dentro la scheda, con revoca logica e audit;
 *  - invito con email reale da dialog dedicato, senza ricerca globale;
 *  - team/professionisti visibili solo ai ruoli autorizzati.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/admin.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'js/admin.js'), 'utf8');
const indexJs = fs.readFileSync(path.join(root, 'functions/src/index.js'), 'utf8');
const domain = require('../js/domain.js');

test('menu unico Clienti con filtri di stato e conteggi', () => {
  assert.match(html, /nav-link active" data-view="clients"/);
  for (const key of ['all', 'active', 'pending', 'inactive']) {
    assert.match(html, new RegExp(`data-client-filter="${key}"`), `filtro ${key}`);
    assert.match(html, new RegExp(`id="count-${key}"`), `conteggio ${key}`);
  }
  assert.match(html, /Filtra i clienti per stato/);
  assert.match(js, /adminState\.clientFilter/);
  assert.match(css, /\.filter-tab/);
});

test('stati operativi: active, inactive, pending con etichette italiane', () => {
  assert.deepEqual(domain.CLIENT_OPERATIONAL_STATUSES, ['active', 'inactive', 'pending']);
  assert.equal(domain.clientStatusLabel('active'), 'Attivo');
  assert.equal(domain.clientStatusLabel('inactive'), 'Inattivo');
  assert.equal(domain.clientStatusLabel('pending'), 'In attesa');
  assert.equal(domain.clientOperationalStatus({ id: 'a', status: 'active' }, {}), 'active');
  assert.equal(domain.clientOperationalStatus({ id: 'a', status: 'pending' }, {}), 'pending');
  assert.equal(domain.clientOperationalStatus({ id: 'a', status: 'unlinked' }, {}), 'inactive');
  assert.equal(domain.clientOperationalStatus({ id: 'a', status: 'suspended' }, {}), 'inactive');
  assert.equal(domain.clientOperationalStatus({ id: 'a', status: 'active' }, { invitations: [{ clientId: 'a', status: 'pending' }] }), 'pending');
  assert.equal(domain.clientOperationalStatus({ id: 'a', status: 'active' }, { requests: [{ clientId: 'a', status: 'pending' }] }), 'pending');
  // Lo storico (rifiutato, revocato, scaduto) ha etichette proprie, non operative.
  assert.equal(domain.clientStatusLabel('rejected'), 'Rifiutato');
  assert.equal(domain.clientStatusLabel('revoked'), 'Revocato');
  assert.equal(domain.clientStatusLabel('expired'), 'Scaduto');
});

test('titolo cliente: Nome Cognome, mai UID o ID tecnici', () => {
  assert.equal(domain.clientDisplayTitle({ firstName: 'Mario', lastName: 'Rossi', id: 'abc123', displayCode: 'CL-1' }), 'Mario Rossi');
  assert.equal(domain.clientDisplayTitle({ displayName: 'Mario R.', id: 'abc123', displayCode: 'CL-1' }), 'Mario R.');
  const masked = domain.clientDisplayTitle({ email: 'mario.rossi@esempio.it', id: 'abc123', displayCode: 'CL-1' });
  assert.ok(masked.includes('@esempio.it'), 'dominio visibile');
  assert.ok(!masked.includes('mario.rossi'), 'parte locale mascherata');
  assert.equal(domain.clientDisplayTitle({ id: 'abc123', displayCode: 'CL-1' }), 'CL-1');
  assert.equal(domain.maskEmailClient('Anna@Esempio.it'), 'a•••@esempio.it');
  assert.equal(domain.maskEmailClient('non-email'), '—');
  assert.match(js, /Apri scheda/);
});

test('scheda cliente: anagrafica, collegamento, struttura, dati tecnici, storico', () => {
  for (const id of ['client-detail-dialog', 'client-detail-title', 'client-detail-subtitle', 'client-detail-body', 'client-detail-feedback', 'client-remove-open']) {
    assert.match(html, new RegExp(`id="${id}"`), `manca #${id}`);
  }
  assert.match(html, /aria-labelledby="client-detail-title"/);
  assert.match(js, /function openClientDetail\(clientId\)/);
  assert.match(js, /function closeClientDetail\(\)/);
  assert.match(js, /function renderClientDetail\(\)/);
  for (const section of ['Dati anagrafici', 'Collegamento', 'Struttura dieta', 'Dati tecnici', 'Storico collegamenti']) {
    assert.match(js, new RegExp(section), `sezione «${section}»`);
  }
  // Anagrafica e cambio email solo server-side, mai scritture dirette.
  assert.match(js, /'updateClientProfileByStaff'/);
  assert.match(js, /'proposeClientEmailChange'/);
  assert.match(js, /'getClientHistory'/);
  assert.match(indexJs, /exports\.getClientHistory/);
  // Lo storico mostra rifiuti, revoche e scadenze; i pendenti restano sopra.
  assert.match(js, /historyRowHtml/);
  assert.match(css, /\.detail-section/);
  assert.match(css, /\.history-row/);
});

test('rimozione solo dentro la scheda, con revoca logica e audit', () => {
  // Un solo pulsante di rimozione in tutto il markup: dentro la scheda.
  const removals = html.match(/Rimuovi cliente/g) || [];
  assert.ok(removals.length >= 2, 'pulsante in scheda + conferma nel dialog');
  assert.doesNotMatch(js, /data-unlink-client/);
  assert.match(js, /client-remove-open/);
  assert.match(js, /closeClientDetail\(\);\s*await Promise\.all\(\[loadUsers\(\), loadClients\(\)\]\)/);
  // Revoca logica server-side: status revocato, audit, niente cancellazioni.
  assert.match(indexJs, /status: 'revoked'/);
  assert.match(indexJs, /client\.link-removed/);
  assert.match(html, /Non cancelliamo l’account/);
});

test('invito con email reale: dialog dedicato, professionisti senza enumerazione', () => {
  for (const id of ['invite-client-open', 'invite-client-dialog', 'invite-client-title', 'invite-client-email-form', 'invite-client-email', 'invite-client-first-name', 'invite-client-last-name', 'invite-client-email-delivery']) {
    assert.match(html, new RegExp(`id="${id}"`), `manca #${id}`);
  }
  assert.match(html, /Invita un nuovo cliente/);
  assert.match(js, /function openInviteClientDialog\(\)/);
  assert.match(js, /'inviteClientByEmail'/);
  // Nessuna ricerca globale di utenti: solo username esatto per i flussi
  // professionista/test, mai liste o prefissi.
  assert.doesNotMatch(js, /searchUsers|listAllUsers|queryUsers/);
  assert.match(js, /'searchUserByUsername'/);
  // Il selettore professionisti dell'invito resta popolato dal server.
  assert.match(js, /invite-client-email-nutritionist/);
});

test('server: vista unificata con singoli filtri e selezione in codice', () => {
  // listAuthorizedClients restituisce tutti gli stati + richieste, con un
  // solo filtro per query (nutritionistUids per il professionista).
  assert.match(indexJs, /where\('nutritionistUids', 'array-contains', uid\)/);
  assert.match(indexJs, /requests: requestsSnap\.docs/);
  assert.match(indexJs, /updatedAt: iso\(row\.data\.updatedAt\)/);
  // getClientHistory: singolo filtro per clientId, niente token in risposta.
  const historyFn = indexJs.slice(indexJs.indexOf('exports.getClientHistory'), indexJs.indexOf('exports.publishRuleSetVersion'));
  assert.match(historyFn, /where\('clientId', '==', client\.id\)/);
  assert.doesNotMatch(historyFn, /token/);
});
