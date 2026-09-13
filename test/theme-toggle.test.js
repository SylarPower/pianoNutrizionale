'use strict';
/* Interruttore del tema nell'intestazione (app + console).
 *
 * Contratto verificato senza rete, per sola lettura dei sorgenti:
 *  - un solo controllo del tema, nell'header, con icone sole/luna;
 *  - nessun duplicato nelle Impostazioni dell'app;
 *  - accessibilità: bottone nativo, aria-pressed, etichetta localizzata;
 *  - persistenza su dispositivo + rispetto di prefers-reduced-motion.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const appJs = read('js/app.js');
const adminJs = read('js/admin.js');
const adminHtml = read('admin.html');
const styleCss = read('css/style.css');
const adminCss = read('css/admin.css');

test('app: interruttore unico nell’header con sole/luna ed etichette italiane', () => {
  assert.match(appJs, /toggleDarkModeFromHeader/);
  assert.match(appJs, /class="theme-toggle"/);
  assert.match(appJs, /aria-pressed="/);
  assert.match(appJs, /Attiva il tema chiaro/);
  assert.match(appJs, /Attiva il tema scuro/);
  assert.match(appJs, /☀️/);
  assert.match(appJs, /🌙/);
  // Lo stato vero si legge dal DOM, così icona ed etichetta non mentono.
  assert.match(appJs, /classList\.contains\("dark-mode"\)/);
  assert.match(styleCss, /\.theme-toggle/);
});

test('app: nessun duplicato del tema nelle Impostazioni', () => {
  const settingsStart = appJs.indexOf('Preferenze e manuale alimentare');
  const settingsEnd = appJs.indexOf('window.toggleDarkMode = function');
  assert.ok(settingsStart > 0 && settingsEnd > settingsStart, 'vista Impostazioni trovata');
  const settingsView = appJs.slice(settingsStart, settingsEnd);
  assert.doesNotMatch(settingsView, /Tema scuro/, 'niente checkbox duplicata');
  assert.doesNotMatch(settingsView, /toggleDarkMode\(this\.checked\)/);
  // Il resto delle Impostazioni resta intatto (account, guide).
  assert.match(settingsView, /Accesso personale/);
  assert.match(settingsView, /Dieta e alternative/);
});

test('app: persistenza su dispositivo e primo paint nel tema giusto', () => {
  assert.match(appJs, /pn_theme/);
  assert.match(appJs, /deviceSettings\.darkMode/);
  assert.match(appJs, /applyTheme\(readBootTheme\(\)\)/);
});

test('console: interruttore nel topbar con persistenza separata', () => {
  assert.match(adminHtml, /id="theme-toggle"/);
  assert.match(adminHtml, /aria-pressed="false"/);
  assert.match(adminHtml, /Attiva il tema scuro/);
  assert.match(adminHtml, /id="theme-toggle-icon"/);
  assert.match(adminJs, /pn_admin_theme/);
  assert.match(adminJs, /function applyConsoleTheme\(theme\)/);
  assert.match(adminJs, /function toggleConsoleTheme\(\)/);
  assert.match(adminJs, /prefers-color-scheme/);
  assert.match(adminCss, /\.theme-toggle/);
  assert.match(adminCss, /html\.dark-mode/);
});

test('tema e movimento ridotto: nessuna animazione nel commutatore', () => {
  assert.match(styleCss, /prefers-reduced-motion/);
  assert.match(adminCss, /prefers-reduced-motion/);
  // Il commutatore non introduce animazioni proprie (solo :hover statico).
  const start = styleCss.indexOf('.theme-toggle {');
  const focusRule = styleCss.indexOf('.theme-toggle:focus-visible');
  const toggleRules = styleCss.slice(start, styleCss.indexOf('}', focusRule));
  assert.doesNotMatch(toggleRules, /@keyframes|animation:/);
});
