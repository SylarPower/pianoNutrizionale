'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync('js/app.js', 'utf8');
const admin = fs.readFileSync('js/admin.js', 'utf8');
const domain = fs.readFileSync('js/domain.js', 'utf8');
const functions = fs.readFileSync('functions/src/index.js', 'utf8');

test('il contratto del profilo cliente usa la callable e il nome professionista', () => {
  assert.match(app, /updateMyClientProfile/);
  assert.match(app, /nutritionistDisplayName \|\| item\.nutritionistUsername/);
});

test('il centro notifiche mostra le richieste SaaS con entrambe le azioni', () => {
  assert.match(app, /saasCards/);
  assert.match(app, /respondClientLinkRequest\('\$\{escapeHtml\(request\.requestId\)\}',\'accept\'\)/);
  assert.match(app, /respondClientLinkRequest\('\$\{escapeHtml\(request\.requestId\)\}',\'reject\'\)/);
});

test('la console usa il fallback nome e cognome, displayName, email, codice', () => {
  // Titolo nel dominio condiviso: «Nome Cognome» prima di tutto, poi
  // displayName, email mascherata e displayCode. Mai username come identità
  // principale (resta solo info secondaria per gli account di test legacy),
  // mai UID o ID tecnici nel titolo.
  assert.match(admin, /clientDisplayTitle/);
  assert.match(domain, /function clientDisplayTitle\(client\)/);
  const titleFn = domain.slice(domain.indexOf('function clientDisplayTitle(client)'), domain.indexOf('function clientInitials('));
  assert.ok(titleFn.indexOf('firstName') < titleFn.indexOf('displayName'), 'nome e cognome prima del displayName');
  assert.ok(titleFn.indexOf('displayName') < titleFn.indexOf('maskEmailClient'), 'displayName prima dell’email mascherata');
  assert.ok(titleFn.indexOf('maskEmailClient') < titleFn.indexOf('displayCode'), 'email prima del codice cliente');
  assert.doesNotMatch(titleFn, /username/, 'lo username non fa parte del titolo');
  assert.match(admin, /filter\(item => !item\.status \|\| item\.status === 'pending'\)/);
});

test('le callable profilo sono idempotenti e auditabili', () => {
  assert.match(functions, /exports\.updateMyClientProfile/);
  assert.match(functions, /exports\.updateMyMemberProfile/);
  assert.match(functions, /client\.profile-updated/);
  assert.match(functions, /member\.profile-updated/);
});
