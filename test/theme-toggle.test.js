'use strict';
/* Interruttore del tema (app + console).
 *
 * Contratto verificato senza rete, per sola lettura dei sorgenti:
 *  - nell'app il controllo del tema vive solo nelle Impostazioni;
 *  - l'header dell'app non contiene più il toggle;
 *  - accessibilità: switch nativo con etichetta localizzata;
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

test('app: il tema è nelle Impostazioni e non più nell’header', () => {
  const headerStart = appJs.indexOf('function renderGlobalHeader()');
  const headerEnd = appJs.indexOf('window.changePortionProfile = function');
  assert.ok(headerStart > 0 && headerEnd > headerStart, 'renderGlobalHeader trovato');
  const headerView = appJs.slice(headerStart, headerEnd);
  assert.doesNotMatch(headerView, /class="theme-toggle"/);
  assert.doesNotMatch(headerView, /toggleDarkModeFromHeader\(/);

  const settingsStart = appJs.indexOf('function renderThemeSettingsSection()');
  const settingsEnd = appJs.indexOf('window.toggleDarkMode = function');
  assert.ok(settingsStart > 0 && settingsEnd > settingsStart, 'vista Impostazioni trovata');
  const settingsView = appJs.slice(settingsStart, settingsEnd);
  assert.match(settingsView, /ASPETTO/);
  assert.match(settingsView, /Tema scuro/);
  assert.match(settingsView, /id="settings-dark-mode-toggle"/);
  assert.match(settingsView, /role="switch"/);
  assert.match(settingsView, /toggleDarkMode\(this\.checked\)/);
  assert.match(settingsView, /renderSaasProfileSection\(\)/);
  assert.match(settingsView, /renderClientLinkSection\(\)/);
  assert.match(settingsView, /renderLinkedAccountsSection\(\)/);
  assert.match(settingsView, /USCITA/);
  assert.match(settingsView, /Dieta e alternative/);
  assert.doesNotMatch(settingsView, /account-card/);
  assert.doesNotMatch(settingsView, /profile-name-form/);
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

test('tema e movimento ridotto: il nuovo switch dell’app resta compatibile', () => {
  assert.match(styleCss, /prefers-reduced-motion/);
  assert.match(adminCss, /prefers-reduced-motion/);
  assert.match(styleCss, /\.switch-track/);
  const switchStart = styleCss.indexOf('.switch-track {');
  const switchBlockEnd = styleCss.indexOf('@media (prefers-reduced-motion: reduce)', switchStart);
  const switchRules = styleCss.slice(switchStart, switchBlockEnd);
  assert.doesNotMatch(switchRules, /@keyframes|animation:/);
});
