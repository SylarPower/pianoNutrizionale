'use strict';
/* Smoke browser-like dell'orb: verifica l'UI vocale (nessun pannello), la
 * modalità locale gratuita, il popup di importazione ricette, i token e il
 * fallback di modello. Non apre microfono o rete reale. */
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
window.PIANO_AI_CONFIG = { tokenEndpoint: '', model: 'gemini-3.1-flash-live-preview', language: 'it-IT', voiceName: 'Aoede', recognitionSilenceMs: 120 };
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
const toasts = [];
const spoken = [];
window.showToast = (message, isError) => toasts.push({ message, isError });

vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/assistant-domain.js'), 'utf8'), dom.getInternalVMContext(), { filename: 'js/assistant-domain.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/assistant.js'), 'utf8'), dom.getInternalVMContext(), { filename: 'js/assistant.js' });
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

assert.ok(window.PianoAssistant, 'API globale assistente presente');
window.PianoAssistant.setAvailability(true);
const fab = window.document.getElementById('assistant-fab');
assert.ok(fab, 'orb presente');
assert.equal(fab.classList.contains('hidden'), false, 'orb visibile con account attivo');
assert.equal(window.document.getElementById('assistant-panel'), null, 'nessun pannello: l’assistente è solo vocale');

// ---- Modalità locale gratuita: riconoscimento browser + risposte del codice
let lastRecognition = null;
class FakeRecognition {
  constructor() { this.continuous = false; this.interimResults = false; }
  start() { lastRecognition = this; }
  stop() {}
}
window.SpeechRecognition = FakeRecognition;
window.speechSynthesis = {
  cancel() {},
  speak(utterance) {
    spoken.push(utterance.text);
    const done = utterance.onend || utterance.onerror;
    if (done) done();
  }
};
window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
const ALL_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
window.appState.plan = { days: Object.fromEntries(ALL_DAYS.map(day => [day, { type: 'training', breakfast: '', snack1: '', lunch: '', snack2: '', dinner: '' }])) };

window.PianoAssistant.open();
assert.equal(window.PianoAssistant._state.open, true, 'assistente aperto');
assert.equal(window.PianoAssistant._state.mode, 'local', 'modalità locale attiva (gratis, senza Gemini)');
assert.equal(fab.dataset.state, 'listening', 'orb in ascolto');
assert.ok(lastRecognition, 'riconoscimento vocale del browser avviato');
assert.equal(spoken.length, 0, 'nessun saluto automatico all’avvio');

const simulateSpeech = transcript => lastRecognition.onresult({
  resultIndex: 0,
  results: [{ 0: { transcript }, isFinal: true, length: 1 }]
});
// I risultati finali passano dal debounce di fine eloquio: nei test sincroni
// il buffer viene svuotato subito con l'hook dedicato.
const speakAndFlush = transcript => {
  simulateSpeech(transcript);
  window.PianoAssistant._flushRecognition();
};

speakAndFlush('cosa prevede il piano di oggi');
assert.ok(spoken.some(text => /Piano di/.test(text)), 'piano letto a voce in locale');
assert.equal(fab.dataset.state, 'listening', 'orb di nuovo in ascolto dopo la risposta');

speakAndFlush('che tempo fa domani a Bologna');
assert.ok(spoken.some(text => /non è di mia competenza/.test(text)), 'fuori tema rifiutato in locale, senza Gemini');

// Frase senza pasto: domanda chiarificatrice locale, niente Gemini Live.
speakAndFlush('cosa devo mangiare oggi');
assert.ok(spoken.some(text => /quale pasto/i.test(text)), 'domanda chiarificatrice sul pasto');
assert.equal(window.PianoAssistant._state.mode, 'local', 'la chiarificazione resta in locale');

speakAndFlush('chiudi assistente');
assert.equal(window.PianoAssistant._state.open, false, 'chiusura vocale');
assert.equal(window.PianoAssistant._state.mode, 'idle');
assert.equal(fab.dataset.state, 'idle', 'orb tornato a riposo');
assert.ok(toasts.some(entry => /microfono spento/.test(entry.message)), 'conferma vocale della chiusura');

// ---- Popup di importazione: solo per le nuove ricette, dosi adattate
let importedRecipe = null;
window.importRecipeFromAssistant = recipe => { importedRecipe = recipe; };
const importResult = window.PianoAssistant.executeTool('import_recipe', {
  name: 'Pollo al limone',
  slot: 'dinner',
  ingredients: [{ name: 'Pollo', quantity: '300 g' }, { name: 'Olio EVO', quantity: '20 g' }],
  steps: ['Cuoci il pollo', 'Condisci con limone']
});
assert.ok(importedRecipe, 'popup di importazione aperto');
assert.equal(importedRecipe.ingredients.find(item => item.name === 'Pollo').quantity, '200 g', 'pollame adattato al massimo Meller');
assert.equal(importedRecipe.ingredients.find(item => item.name === 'Olio EVO').quantity, '10 g', 'olio adattato al massimo Meller');
assert.ok(importedRecipe.notes.some(note => /Meller/.test(note)), 'nota linee guida aggiunta');
assert.match(importResult.message, /Meller/, 'conferma vocale dell’adattamento');
assert.deepEqual(importedRecipe.steps, ['Cuoci il pollo', 'Condisci con limone'], 'preparazione importata');

// ---- Da qui in poi: percorso Gemini Live (senza riconoscimento browser)
window.SpeechRecognition = undefined;
window.webkitSpeechRecognition = undefined;

const waitFor = async (predicate, label, timeoutMs = 3000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout in attesa di: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

/*
 * Regressione "Mi collego…" infinito e quota: token/429 gestiti senza rete.
 */
(async () => {
  // ---- Debounce di fine eloquio: DUE finali separati = UNA sola frase ----
  // "cosa devo mangiare oggi" + pausa breve + "a pranzo" deve produrre
  // get_meal_details(lunch) sulla frase intera, MAI get_current_plan (elenco
  // completo) sull'intento troncato.
  {
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;
    spoken.length = 0;
    window.PianoAssistant.open();
    assert.equal(window.PianoAssistant._state.mode, 'local', 'modalità locale attiva');
    simulateSpeech('cosa devo mangiare oggi');
    assert.equal(spoken.length, 0, 'il primo finale NON viene processato subito (debounce attivo)');
    await new Promise(resolve => setTimeout(resolve, 40)); // pausa sotto la soglia di silenzio
    simulateSpeech('a pranzo');
    await waitFor(() => spoken.length > 0, 'risposta dopo il silenzio di fine eloquio');
    assert.ok(spoken.some(text => /pranzo/i.test(text)), 'risposta sul SOLO pranzo (get_meal_details)');
    assert.ok(!spoken.some(text => /^Piano di/.test(text)), 'nessun elenco completo dei pasti (get_current_plan)');
    assert.equal(window.PianoAssistant._state.mode, 'local', 'frase gestita in locale, niente Gemini Live');
    assert.equal(window.PianoAssistant._state.ws, null, 'nessuna WebSocket Live aperta');
    assert.equal(window.PianoAssistant._state.recognitionBuffer, '', 'buffer svuotato dopo il flush');
    window.PianoAssistant.close();
    window.SpeechRecognition = undefined;
    window.webkitSpeechRecognition = undefined;
  }

  // ---- Nuove ricette dal web: API testuale /recipe, MAI Gemini Live ----
  {
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;
    importedRecipe = null;
    window.currentUser = { getIdToken: async () => 'tok' };
    window.PIANO_AI_CONFIG.tokenEndpoint = 'https://piano-nutrizionale-ai.example.workers.dev/token';

    let recipeFetch = null;
    window.fetch = (url, init) => {
      recipeFetch = { url: String(url), init };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          recipe: {
            name: 'Pollo al curry',
            slot: 'dinner',
            emoji: '🍛',
            ingredients: [{ name: 'Pollo', quantity: '300 g' }, { name: 'Riso', quantity: '150 g' }, { name: 'Olio EVO', quantity: '20 g' }],
            steps: ['Cuoci il pollo', 'Servi con il riso'],
            notes: []
          }
        })
      });
    };

    window.PianoAssistant.open();
    assert.equal(window.PianoAssistant._state.mode, 'local', 'modalità locale per la ricerca di ricette');
    speakAndFlush('trovami una ricetta con pollo');
    await waitFor(() => importedRecipe && importedRecipe.name === 'Pollo al curry', 'popup import ricetta dal web');
    assert.equal(importedRecipe.ingredients.find(item => item.name === 'Pollo').quantity, '200 g', 'pollame adattato (doppia sicurezza)');
    assert.equal(importedRecipe.ingredients.find(item => item.name === 'Riso').quantity, '90 g', 'riso adattato al massimo Meller');
    assert.equal(importedRecipe.ingredients.find(item => item.name === 'Olio EVO').quantity, '10 g', 'olio adattato al massimo Meller');
    assert.ok(recipeFetch.url.endsWith('/recipe'), 'chiama /recipe, non /token');
    assert.equal(recipeFetch.init.headers.Authorization, 'Bearer tok', 'idToken Firebase inoltrato');
    assert.deepEqual(JSON.parse(recipeFetch.init.body), { query: 'trovami una ricetta con pollo', language: 'it-IT' }, 'body con query e lingua');
    assert.equal(window.PianoAssistant._state.mode, 'local', 'resta in modalità locale: niente Live');
    assert.equal(window.PianoAssistant._state.ws, null, 'nessuna WebSocket Live aperta');
    assert.ok(spoken.some(text => /Controlla il popup/.test(text)), 'conferma vocale della ricetta');
    window.PianoAssistant.close();
    window.SpeechRecognition = undefined;
    window.webkitSpeechRecognition = undefined;
  }

  const stubHeaders = { 'retry-after': '90' };
  class StubResponse {
    constructor(body, init = {}) {
      this._body = body;
      this.status = init.status === undefined ? 200 : init.status;
      this.ok = this.status >= 200 && this.status < 300;
      this.headers = { get: name => stubHeaders[String(name).toLowerCase()] ?? null };
    }
    json() { return Promise.resolve(this._body); }
  }
  window.Response = StubResponse;
  window.currentUser = { getIdToken: async () => 'tok' };

  let fetchCalls = 0;
  let lastInit = null;
  let nextBody = null;
  let nextBodyFn = null;
  let nextStatus = 200;
  window.fetch = (url, init) => {
    fetchCalls += 1;
    lastInit = init;
    const body = nextBodyFn ? nextBodyFn(init) : nextBody;
    return Promise.resolve(new StubResponse(body, { status: nextStatus }));
  };

  window.PIANO_AI_CONFIG.tokenEndpoint = 'https://piano-nutrizionale-ai.example.workers.dev/token';
  const { _fetchEphemeralToken, _resetRateLimit, _state: state } = window.PianoAssistant;
  _resetRateLimit();

  // 1) 429 con Retry-After: errore di rate-limit, nessun'altra chiamata.
  nextStatus = 429;
  nextBody = { error: 'Troppe richieste di token.' };
  await assert.rejects(
    () => _fetchEphemeralToken(),
    error => error.rateLimited === true && error.name === 'RateLimitError' && /Troppe attivazioni/.test(error.message),
    'il 429 diventa un errore di rate-limit leggibile'
  );
  assert.equal(fetchCalls, 1, 'una sola chiamata al Worker');
  assert.ok(state.rateLimitUntil > Date.now(), 'cooldown attivo fino alla scadenza');
  await assert.rejects(() => _fetchEphemeralToken(), error => error.rateLimited === true);
  assert.equal(fetchCalls, 1, 'durante il cooldown non partono nuove richieste');

  // Aprire l'orb con cooldown in corso (percorso Live) non tocca la rete.
  window.PianoAssistant.open();
  assert.equal(fetchCalls, 1, 'open() durante il cooldown non chiama il Worker');
  assert.equal(fab.dataset.state, 'error', 'orb rosso: troppe attivazioni');
  assert.ok(toasts.some(entry => /Troppe attivazioni/.test(entry.message)), 'errore visibile come toast');
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

  // 3) Modello di riserva: emissione dedicata con il modello nel body.
  const fallbackModel = 'gemini-2.5-flash-native-audio-preview-12-2025';
  nextBody = { token: 'eph-native', model: fallbackModel, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
  assert.equal(await _fetchEphemeralToken(fallbackModel), 'eph-native', 'token per il modello di riserva');
  assert.equal(fetchCalls, 3, 'una nuova emissione per il modello di riserva');
  assert.equal(JSON.parse(lastInit.body).model, fallbackModel, 'il modello richiesto viaggia nel body');
  assert.equal(state.activeModel, fallbackModel, 'modello attivo aggiornato al token in uso');
  assert.equal(await _fetchEphemeralToken(fallbackModel), 'eph-native');
  assert.equal(await _fetchEphemeralToken(), 'eph-abc', 'il token primario resta in cache');
  assert.equal(fetchCalls, 3, 'il token di riserva viene riusato (una sola emissione)');

  // 4) Fallback end-to-end: la WebSocket del modello principale chiude con
  //    1008 prima del setupComplete, la sessione riparte sul modello di
  //    riserva e non parte nessun saluto automatico.
  _resetRateLimit();
  state.open = true;
  state.userClosed = false;
  state.messages = [];
  state.preferFallback = false;
  const primaryModel = 'gemini-3.1-flash-live-preview';
  let wsOpened = 0;
  const declaredModels = [];
  class StubWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1; // OPEN
      this.sent = [];
      wsOpened += 1;
      queueMicrotask(() => this.onopen?.());
    }
    send(payload) {
      const message = JSON.parse(payload);
      this.sent.push(message);
      if (!message.setup) return;
      const declared = message.setup.model;
      declaredModels.push(declared);
      queueMicrotask(() => {
        if (declared === `models/${primaryModel}`) {
          this.onclose?.({ code: 1008, reason: `${declared} is not found for API version v1main, or is not supported for bidiGenerateContent.` });
        } else {
          this.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
          this.onmessage?.({ data: JSON.stringify({ serverContent: { inputTranscription: { text: 'Cosa prevede il piano di oggi?' } } }) });
          this.onmessage?.({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ text: 'Ciao! Ecco il piano di oggi.' }] }, turnComplete: true } }) });
        }
      });
    }
    close() {}
  }
  window.WebSocket = StubWebSocket;
  window.WebSocket.OPEN = 1;

  nextBodyFn = init => {
    const requested = JSON.parse(init.body).model;
    return {
      token: requested === fallbackModel ? 'eph-native' : 'eph-abc',
      model: requested,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    };
  };

  await window.PianoAssistant._openLiveWithFallback();
  assert.equal(wsOpened, 2, 'primario rifiutato (1008) e poi riserva');
  assert.deepEqual(declaredModels, [`models/${primaryModel}`, `models/${fallbackModel}`], 'modelli dichiarati nel setup');
  assert.equal(state.activeModel, fallbackModel, 'sessione attiva sul modello di riserva');
  assert.equal(state.preferFallback, true, 'il modello di riserva diventa preferito');
  assert.equal(state.pendingFallback, false, 'flag di fallback azzerato');

  // Nessun saluto automatico: dopo il setup il client non invia nulla.
  assert.ok(state.messages.some(message => /Ciao! Ecco il piano di oggi\./.test(message.text)), 'risposta del modello registrata');
  assert.ok(state.messages.some(message => /Cosa prevede il piano di oggi\?/.test(message.text)), 'domanda dell’utente registrata');
  const lastSocket = state.ws;
  assert.equal(lastSocket.sent.length, 1, 'dopo il setup nessun messaggio automatico');
  assert.ok(lastSocket.sent[0].setup, 'unico messaggio inviato: il setup');

  // Al secondo avvio si va dritti al modello di riserva, senza nuove emissioni.
  const fetchCallsBeforeSecondRun = fetchCalls;
  await window.PianoAssistant._openLiveWithFallback();
  assert.equal(wsOpened, 3, 'una sola nuova WebSocket');
  assert.equal(declaredModels[2], `models/${fallbackModel}`, 'secondo avvio sul modello di riserva');
  assert.equal(fetchCalls, fetchCallsBeforeSecondRun, 'token di riserva riusato dalla cache');

  // 5) Frame binari della WebSocket (i modelli native-audio li usano per
  //    l'audio): il testo JSON va decodificato anche da Blob/ArrayBuffer.
  const { _messageDataToText } = window.PianoAssistant;
  assert.equal(await _messageDataToText('{"ok":true}'), '{"ok":true}', 'testo JSON passato inalterato');
  assert.equal(await _messageDataToText(new window.Blob(['{"ok":true}'])), '{"ok":true}', 'Blob con JSON decodificato in testo');
  const jsonBytes = new window.Uint8Array([123, 34, 111, 107, 34, 58, 116, 114, 117, 101, 125]);
  assert.equal(await _messageDataToText(jsonBytes.buffer), '{"ok":true}', 'ArrayBuffer con JSON decodificato in testo');

  _resetRateLimit();
  window.PianoAssistant.setAvailability(false);
  assert.equal(fab.classList.contains('hidden'), true, 'orb nascosto senza account');
})()
  .then(() => console.log('ASSISTANT SMOKE OK — orb vocale senza pannello; modalità locale gratuita; debounce di fine eloquio (due finali = una frase, get_meal_details e non get_current_plan); domanda chiarificatrice senza slot; 429 in cooldown; token riusato; fallback di modello; popup import ricette con linee guida'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
