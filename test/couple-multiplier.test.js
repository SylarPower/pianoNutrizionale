'use strict';
/* Moltiplicatore porzioni — solo app clienti, solo profilo coppia:
 *  - il controllo −/＋ vive nell'header ed è renderizzato solo in coppia;
 *  - scala la dose singola mostrata e i totali della lista della spesa;
 *  - la preferenza resta nelle impostazioni locali del dispositivo;
 *  - la console non espone più un campo moltiplicatore visibile. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const adminJs = fs.readFileSync(path.join(root, 'js/admin.js'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');

test('header: il controllo moltiplicatore esiste ed è solo per il profilo coppia', () => {
  assert.match(appJs, /function getCoupleMultiplier/);
  assert.match(appJs, /function applyCoupleMultiplier/);
  assert.match(appJs, /window\.changeCoupleMultiplier/);
  assert.match(appJs, /class="couple-mult"/);
  // Il blocco è renderizzato soltanto quando il profilo è couple.
  assert.match(appJs, /profile === "couple" \? `[\s\S]*couple-mult[\s\S]*` : ""/);
  // Limiti ×0,5–×3, passo 0,05.
  assert.match(appJs, /Math\.min\(3, Math\.max\(0\.5/);
  assert.match(appJs, /changeCoupleMultiplier\(0\.05\)/);
  assert.match(appJs, /changeCoupleMultiplier\(-0\.05\)/);
});

test('la dose singola e la spesa seguono il moltiplicatore', () => {
  assert.match(appJs, /getPortionProfile\(\) === "couple"[\s\S]*applyCoupleMultiplier\(amount\)/);
  // La spesa passa il moltiplicatore solo quando il profilo è coppia.
  assert.match(appJs, /quantityMultiplier: getPortionProfile\(\) === "couple" \? getCoupleMultiplier\(\) : 1/);
});

test('preferenza salvata nelle impostazioni locali del dispositivo', () => {
  assert.match(appJs, /appState\.deviceSettings\.coupleMultiplier = next/);
  assert.match(appJs, /saveLocalDeviceSettings\(appState\.deviceSettings\)/);
});

test('stile: controllo coerente col tema (chiaro e scuro)', () => {
  assert.match(styleCss, /\.couple-mult \{/);
  assert.match(styleCss, /\.couple-mult-btn \{/);
  assert.match(styleCss, /\.couple-mult-value \{/);
  assert.match(styleCss, /body\.dark-mode \.couple-mult \{/);
});

test('console: nessun campo moltiplicatore porzioni (vista Dosi rimossa)', () => {
  // La vista «Dosi clienti» e i suoi override sono stati rimossi: nessun
  // campo moltiplicatore, visibile o nascosto, vive nella console.
  assert.doesNotMatch(adminJs, /option-mult/, 'nessun campo moltiplicatore');
  assert.doesNotMatch(adminJs, /class="diet-mult"/, 'nessun campo visibile');
});
