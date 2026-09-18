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

test('cache-first del contesto SaaS e skip delle riapplicazioni senza cambiamenti', () => {
  // L'avvio rapido applica il profilo verificato in cache PRIMA della rete.
  assert.match(app, /PianoSaas\.cachedContext\(cachedSession\.uid\)/);
  assert.match(read('js/saas.js'), /function cachedContext\(uid\)/);
  // Raw JSON dell'ultimo stato applicato: base del confronto "è cambiato?".
  assert.match(app, /const lastAppliedRaw = \{ recipes: null, plan: null, shopping: null \}/);
  // Snapshot household con contenuto già applicato: né riapplica né re-render.
  assert.match(app, /if \(lastAppliedRaw\[kind\] === raw\) return;/);
  // Refresh di avvio con dati E contesto identici alla cache: niente ri-apply,
  // MAI però senza l'app già mostrata (appStarted: altrimenti si saltano
  // showApp/setup del primo caricamento).
  assert.match(app, /const skipReapply = appStarted && dataUnchanged && contextUnchanged;/);
  assert.match(app, /if \(!skipReapply\) applyState\(recipes, plan, shopping\);/);
});

test('avvio: letture SaaS silent e parallele, il refresh non blocca l’interfaccia', () => {
  // Helper di chiamata silent per i refresh di background.
  const silentCall = app.indexOf('callSaasFunction(name, data, { silent: true })');
  assert.ok(silentCall > -1, 'helper silent presente');
  // Contesto SaaS e stato collegamento usano la chiamata/refresh silent.
  const contextStart = app.indexOf('PianoSaas.loadContext(user.uid, silentSaasCall)');
  const linkStart = app.indexOf('refreshClientLinkState({ silent: true })');
  assert.ok(contextStart > silentCall, 'il contesto SaaS usa la chiamata silent');
  assert.ok(linkStart > contextStart, 'il collegamento cliente usa il refresh silent');
  // Le due letture PARTONO insieme (parallelismo) e l'avvio attende entrambe
  // prima di applicare lo stato: niente chiamata cloud che somma sull'altra.
  const awaitContext = app.indexOf('appState.saasContext = await saasContextPromise');
  const awaitLink = app.indexOf('await clientLinkPromise');
  assert.ok(awaitContext > -1 && awaitLink > awaitContext, 'le letture di avvio sono parallele');
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
