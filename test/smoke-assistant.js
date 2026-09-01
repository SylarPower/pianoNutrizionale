'use strict';
/* Smoke browser-like dell'orb: verifica il montaggio UI e la chiusura sicura
 * quando il Worker non è ancora configurato. Non apre microfono o rete. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://sylarpower.github.io/pianoNutrizionale/',
  runScripts: 'outside-only'
});
const window = dom.window;
window.PIANO_AI_CONFIG = { tokenEndpoint: '', model: 'gemini-3.1-flash-live-preview', language: 'it-IT', voiceName: 'Aoede' };
window.PianoDomain = {};
window.appState = {
  user: { email: 'mario@utenti.pianonutrizionale.app' },
  plan: null,
  recipes: [],
  recipesById: {},
  household: null,
  deviceSettings: { portionProfile: 'man' }
};
window.getPortionProfile = () => 'man';
window.MELLER_GUIDE = {};

vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/assistant-domain.js'), 'utf8'), dom.getInternalVMContext(), { filename: 'js/assistant-domain.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/assistant.js'), 'utf8'), dom.getInternalVMContext(), { filename: 'js/assistant.js' });
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

assert.ok(window.PianoAssistant, 'API globale assistente presente');
window.PianoAssistant.setAvailability(true);
const fab = window.document.getElementById('assistant-fab');
const panel = window.document.getElementById('assistant-panel');
assert.equal(fab.classList.contains('hidden'), false, 'orb visibile con account attivo');
window.PianoAssistant.open();
assert.equal(panel.classList.contains('hidden'), false, 'pannello aperto');
assert.match(window.document.getElementById('assistant-error').textContent, /Worker/);
window.PianoAssistant.close();
assert.equal(panel.classList.contains('hidden'), true, 'pannello chiuso');

// Regressione: il form di testo e il suo input erano referenziati su
// ui.form/ui.input ma mai assegnati in ensureUi(): il listener 'submit'
// andava in TypeError ("Cannot read properties of undefined"), interrompendo
// il montaggio e lasciando l'app bloccata dopo il login.
const form = window.document.getElementById('assistant-text-form');
const input = window.document.getElementById('assistant-text-input');
assert.ok(form, 'form testuale presente nel pannello');
assert.ok(input, 'input testuale presente nel pannello');
assert.doesNotThrow(() => form.dispatchEvent(new window.Event('submit', { cancelable: true })), 'submit del form gestito senza crash');
const quickButton = panel.querySelector('[data-assistant-text]');
assert.ok(quickButton, 'azione rapida presente');
assert.doesNotThrow(() => quickButton.dispatchEvent(new window.Event('click', { bubbles: true })), 'click azione rapida gestito senza crash');

/*
 * Regressione "Mi collego…" infinito: due blocchi distinti.
 *  1) 429 del Worker → il client deve fermarsi (cooldown) senza altre chiamate;
 *  2) 200 con { token, expiresAt } → il token effimero deve essere riusato,
 *     quindi 3 utilizzi devono richiedere UNA sola emissione.
 * jsdom non espone fetch/Response: si stubbano entrambi (nessuna rete reale).
 */
(async () => {
  const stubHeaders = { 'retry-after': '90' };
  class StubResponse {
    constructor(body, init = {}) {
      this._body = body;
      this.status = init.status === undefined ? 200 : init.status;
      this.ok = this.status >= 200 && this.status < 300;
      // Headers reali: get() è case-insensitive.
      this.headers = { get: name => stubHeaders[String(name).toLowerCase()] ?? null };
    }
    json() { return Promise.resolve(this._body); }
  }
  window.Response = StubResponse;
  window.currentUser = { getIdToken: async () => 'tok' };

  let fetchCalls = 0;
  let lastInit = null;
  let nextBody = null;
  let nextStatus = 200;
  window.fetch = (url, init) => {
    fetchCalls += 1;
    lastInit = init;
    return Promise.resolve(new StubResponse(nextBody, { status: nextStatus }));
  };

  window.PIANO_AI_CONFIG.tokenEndpoint = 'https://piano-nutrizionale-ai.example.workers.dev/token';
  const { _fetchEphemeralToken, _resetRateLimit, _state: state } = window.PianoAssistant;
  _resetRateLimit();

  // 1) 429 con Retry-After: errore di rate-limit, e nessun'altra chiamata.
  nextStatus = 429;
  nextBody = { error: 'Troppe richieste di token.' };
  await assert.rejects(
    () => _fetchEphemeralToken(),
    error => error.rateLimited === true && error.name === 'RateLimitError' && /Troppe attivazioni/.test(error.message),
    'il 429 diventa un errore di rate-limit leggibile'
  );
  assert.equal(fetchCalls, 1, 'una sola chiamata al Worker');
  assert.ok(state.rateLimitUntil > Date.now(), 'cooldown attivo fino alla scadenza');
  assert.equal(state.ephemeralToken, null, 'nessun token in cache dopo un 429');
  await assert.rejects(() => _fetchEphemeralToken(), error => error.rateLimited === true);
  await assert.rejects(() => _fetchEphemeralToken(), error => error.rateLimited === true);
  assert.equal(fetchCalls, 1, 'durante il cooldown non partono nuove richieste');

  // Aprire il pannello con cooldown in corso non deve toccare la rete.
  window.PianoAssistant.open();
  assert.equal(fetchCalls, 1, 'open() durante il cooldown non chiama il Worker');
  assert.match(window.document.getElementById('assistant-error').textContent, /Troppe attivazioni/);
  window.PianoAssistant.close();

  // 2) 200 con token: riutilizzato da 3 chiamate consecutive.
  _resetRateLimit();
  for (const key of Object.keys(stubHeaders)) delete stubHeaders[key];
  nextStatus = 200;
  nextBody = { token: 'eph-abc', expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
  assert.equal(await _fetchEphemeralToken(), 'eph-abc', 'token emesso dal Worker');
  assert.equal(fetchCalls, 2, 'emissione avvenuta');
  assert.equal(lastInit.method, 'POST');
  assert.equal(lastInit.headers.Authorization, 'Bearer tok', 'idToken Firebase inoltrato');
  assert.equal(await _fetchEphemeralToken(), 'eph-abc');
  assert.equal(await _fetchEphemeralToken(), 'eph-abc');
  assert.equal(fetchCalls, 2, '3 utilizzi del token = 1 sola emissione (niente 429)');
  assert.ok(state.ephemeralTokenExpiresAt > Date.now(), 'scadenza con margine di sicurezza');
  assert.equal(state.rateLimitUntil, 0, 'un 200 azzera il cooldown');

  // 3) Modello di riserva: una sola emissione dedicata, con il modello nel
  //    body; i token restano in cache separati e non si sovrascrivono.
  const fallbackModel = 'gemini-2.5-flash-native-audio-preview-12-2025';
  nextBody = { token: 'eph-native', model: fallbackModel, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
  assert.equal(await _fetchEphemeralToken(fallbackModel), 'eph-native', 'token per il modello di riserva');
  assert.equal(fetchCalls, 3, 'una nuova emissione per il modello di riserva');
  assert.equal(JSON.parse(lastInit.body).model, fallbackModel, 'il modello richiesto viaggia nel body');
  assert.equal(state.activeModel, fallbackModel, 'modello attivo aggiornato al token in uso');
  assert.equal(await _fetchEphemeralToken(fallbackModel), 'eph-native');
  assert.equal(await _fetchEphemeralToken(), 'eph-abc', 'il token primario resta in cache');
  assert.equal(fetchCalls, 3, 'il token di riserva viene riusato (una sola emissione)');

  _resetRateLimit();
  window.PianoAssistant.setAvailability(false);
  assert.equal(fab.classList.contains('hidden'), true, 'orb nascosto senza account');
})()
  .then(() => console.log('ASSISTANT SMOKE OK — UI montata senza microfono o rete; 429 in cooldown e token riusato'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
