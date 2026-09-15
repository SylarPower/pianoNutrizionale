'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = file => fs.readFileSync(file, 'utf8');
const root = process.cwd();
const index = read(`${root}/index.html`);
const admin = read(`${root}/admin.html`);
const appCss = read(`${root}/css/style.css`);
const adminCss = read(`${root}/css/admin.css`);
const loading = read(`${root}/js/loading.js`);
const firebase = read(`${root}/js/firebase.js`);
const app = read(`${root}/js/app.js`);


test('overlay loading globale: app e console hanno centro, messaggio e sfocatura', () => {
  for (const html of [index, admin]) {
    assert.match(html, /<script src="js\/loading\.js"><\/script>/);
    assert.match(html, /id="loading-overlay"/);
    assert.match(html, /id="loading-message"/);
    assert.match(html, /aria-live="polite"/);
  }
  assert.match(appCss, /backdrop-filter:\s*blur\(8px\)/);
  assert.match(adminCss, /\.loading-overlay\{[^}]*backdrop-filter:blur\(8px\)/);
  assert.match(adminCss, /place-content:center/);
  assert.match(loading, /pending/);
  assert.match(loading, /start\(message/);
  assert.match(loading, /stop\(\)/);
  assert.match(loading, /reset\(\)/);
});


test('loading copre anche le operazioni cloud della console e dell’app', () => {
  assert.match(app, /window\.PianoLoading\.start\(message\)/);
  assert.match(app, /window\.PianoLoading\.stop\(\)/);
  assert.match(firebase, /async function callSaasFunction[\s\S]*?PianoLoading\?\.start/);
  assert.match(firebase, /async function callAdminSaasFunction[\s\S]*?PianoLoading\?\.start/);
  assert.match(firebase, /async function adminGetDocsQuery[\s\S]*?PianoLoading\?\.start/);
});

test('logo del loading senza sfondo e overlay solo per operazioni lente', () => {
  // Console: il logo del loading non ha più la tessera colorata dietro.
  assert.doesNotMatch(adminCss, /\.loading-brand\{[^}]*background/);
  assert.doesNotMatch(adminCss, /dark-mode \.loading-brand\{[^}]*background/);
  // Il grace period evita il lampeggio sulle operazioni istantanee.
  assert.match(loading, /GRACE_MS/);
  assert.match(loading, /setTimeout/);
  assert.match(loading, /cancelScheduledShow|clearTimeout/);
});
