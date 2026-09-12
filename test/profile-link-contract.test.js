'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync('js/app.js', 'utf8');
const admin = fs.readFileSync('js/admin.js', 'utf8');
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

test('la console usa il fallback nome, username, codice', () => {
  assert.match(admin, /function clientLabel\(client\) \{ return client\.displayName \|\| client\.username \|\| client\.displayCode; \}/);
  assert.match(admin, /filter\(item => !item\.status \|\| item\.status === 'pending'\)/);
});

test('le callable profilo sono idempotenti e auditabili', () => {
  assert.match(functions, /exports\.updateMyClientProfile/);
  assert.match(functions, /exports\.updateMyMemberProfile/);
  assert.match(functions, /client\.profile-updated/);
  assert.match(functions, /member\.profile-updated/);
});
