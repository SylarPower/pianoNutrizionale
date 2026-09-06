'use strict';
/* Smoke browser-like della ricerca ricette online: modale, invio del form,
 * schede risultato con le discrepanze Meller calcolate nell'app, correzione
 * con un click, importazione singola e in blocco, "Altre 10 ricette" con
 * esclusione delle ricette già mostrate. Nessuna rete reale. */
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

window.PIANO_WEB_SEARCH_CONFIG = { recipesEndpoint: 'https://worker.test/recipes', language: 'it-IT', maxRecipes: 10 };
// La fonte unica Meller NON viene più inviata al Worker: serve alla schermata
// dei risultati per segnalare le discrepanze e correggerle con un click.
window.PianoDomain = require('../js/domain.js');
window.firebase = { auth: () => ({ currentUser: { getIdToken: async () => 'fake-token' } }) };
window.appState = { user: { email: 'mario@utenti.pianonutrizionale.app' }, recipes: [], recipesById: {} };
window.escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const toasts = [];
window.showToast = (message, isError) => toasts.push({ message, isError });
const imported = [];
window.importRecipeFromWebSearch = recipe => imported.push(recipe);
const bulkImports = [];
window.importRecipesFromWebSearchBulk = async list => {
  bulkImports.push(list.map(recipe => recipe.name));
  return true;
};

const calls = [];
function recipeBatch(prefix) {
  return Array.from({ length: 10 }, (_, i) => ({
    name: `${prefix} ${i + 1}`,
    slot: 'lunch',
    emoji: '🍛',
    // Dosi della fonte volutamente sopra i riferimenti Meller (pollame 200 g,
    // riso 70 g a pranzo nel giorno di riposo): l'app deve accorgersene.
    ingredients: [{ name: 'Pollo', quantity: '300 g' }, { name: 'Riso', quantity: '150 g' }],
    steps: ['Cuoci il pollo', 'Aggiungi il riso'],
    notes: [],
    sourceUrl: 'https://example.com/ricetta',
    sourceTitle: 'Esempio'
  }));
}
window.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url: String(url), body });
  return {
    ok: true,
    status: 200,
    json: async () => ({
      recipes: recipeBatch(calls.length === 1 ? 'Ricetta' : 'Extra'),
      sources: [{ title: 'Esempio', url: 'https://example.com/ricetta' }]
    })
  };
};

vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/web-search.js'), 'utf8'), dom.getInternalVMContext(), { filename: 'js/web-search.js' });
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

assert.ok(window.PianoWebSearch, 'API globale PianoWebSearch presente');

window.PianoWebSearch.open();
const modal = window.document.getElementById('web-search-modal');
assert.ok(modal, 'modale presente');
assert.equal(modal.classList.contains('hidden'), false, 'modale aperta');
assert.equal(window.PianoWebSearch.isOpen(), true);

const wait = () => new Promise(resolve => setTimeout(resolve, 0));

(async () => {
  // ---- Ricerca ----
  window.document.getElementById('websearch-ingredients').value = 'pollo, riso';
  window.document.getElementById('websearch-slot').value = 'lunch';
  window.document.getElementById('websearch-note').value = 'veloce';
  window.document.getElementById('websearch-form').dispatchEvent(new window.Event('submit'));
  for (let i = 0; i < 10; i += 1) await wait();

  assert.equal(calls.length, 1, 'una POST eseguita');
  assert.match(calls[0].url, /\/recipes$/, 'chiama l’endpoint /recipes');
  assert.match(calls[0].body.query, /pollo, riso/, 'query con gli ingredienti');
  assert.match(calls[0].body.query, /pranzo/i, 'query con il tipo di pasto');
  assert.equal(calls[0].body.slot, 'lunch', 'slot inviato');
  assert.deepEqual(calls[0].body.excludeNames, [], 'prima ricerca senza esclusioni');
  assert.equal(calls[0].body.guidelines, undefined, 'nessuna guideline Meller inviata al modello');
  assert.equal(calls[0].body.alternatives, undefined, 'nessuna grammatura Meller inviata al modello');
  assert.equal(calls[0].body.mealStructure, undefined, 'nessuna struttura pasti inviata al modello');
  assert.equal(calls[0].body.maxRecipes, 10, 'le prime 10 ricette per pertinenza');

  const cards = window.document.querySelectorAll('.websearch-card');
  assert.equal(cards.length, 10, '10 schede ricetta');
  assert.match(cards[0].textContent, /Ricetta 1/);

  // ---- Discrepanze Meller segnalate dall'app ----
  assert.equal(window.document.querySelectorAll('.websearch-meller').length, 10, 'avviso Meller su ogni scheda fuori riferimento');
  assert.match(cards[0].textContent, /dosi non aderenti alle linee guida/, 'discrepanze descritte');
  assert.match(cards[0].textContent, /300 g → 200 g/, 'pollame riportato a 200 g');
  // La ricetta ha una sola dose per ingrediente: si applica il riferimento più
  // restrittivo (pranzo di riposo, 70 g), valido anche in giornata A.
  assert.match(cards[0].textContent, /150 g → 70 g/, 'riso riportato alla dose di pranzo più restrittiva');
  assert.match(window.document.querySelector('.websearch-count').textContent, /10<\/strong> hanno dosi fuori|10 hanno dosi fuori/, 'conteggio delle ricette da correggere');

  // ---- Correzione con un click sulla singola scheda ----
  cards[0].querySelector('.websearch-meller-fix').dispatchEvent(new window.Event('click'));
  const fixedCard = window.document.querySelector('.websearch-card');
  assert.match(fixedCard.textContent, /Ricetta 1/, 'la scheda resta al suo posto');
  assert.match(fixedCard.textContent, /✓ Linee guida/, 'scheda marcata come adattata');
  assert.equal(fixedCard.querySelector('.websearch-meller'), null, 'avviso rimosso dopo la correzione');
  assert.match(fixedCard.textContent, /Pollo 200 g/, 'dose del pollo corretta nell’anteprima');
  assert.equal(window.document.querySelectorAll('.websearch-meller').length, 9, 'restano le altre 9 da correggere');

  // ---- Correzione di tutte le ricette ----
  [...window.document.querySelectorAll('.websearch-actions .btn')]
    .find(button => /Correggi tutte/.test(button.textContent))
    .dispatchEvent(new window.Event('click'));
  assert.equal(window.document.querySelectorAll('.websearch-meller').length, 0, 'nessuna discrepanza residua');
  assert.equal(window.document.querySelectorAll('.websearch-meller-ok').length, 10, 'tutte le schede adattate');

  // ---- Importazione in blocco ----
  const importAll = [...window.document.querySelectorAll('.websearch-actions .btn')]
    .find(button => /Importa tutte/.test(button.textContent));
  assert.ok(importAll, 'pulsante di importazione in blocco presente');
  assert.match(importAll.textContent, /\(10\)/, 'conteggio nel pulsante');
  importAll.dispatchEvent(new window.Event('click'));
  for (let i = 0; i < 10; i += 1) await wait();
  assert.equal(bulkImports.length, 1, 'una sola importazione in blocco');
  assert.equal(bulkImports[0].length, 10, 'tutte e 10 le ricette importate insieme');
  assert.equal(modal.classList.contains('hidden'), true, 'modale chiusa dopo l’importazione in blocco');

  // ---- Apertura + importazione singola ----
  window.PianoWebSearch.open();
  window.document.querySelector('.websearch-card [data-action="open"]').dispatchEvent(new window.Event('click'));
  assert.equal(imported.length, 1, 'popup di importazione aperto');
  assert.equal(imported[0].name, 'Ricetta 1');
  assert.equal(modal.classList.contains('hidden'), true, 'modale chiusa dopo l’apertura della ricetta');

  // ---- Altre 10 ricette ----
  window.PianoWebSearch.open();
  const more = [...window.document.querySelectorAll('.websearch-actions .btn')]
    .find(button => /Altre 10/.test(button.textContent));
  assert.ok(more, 'pulsante "Altre 10 ricette" presente');
  more.dispatchEvent(new window.Event('click'));
  for (let i = 0; i < 10; i += 1) await wait();

  assert.equal(calls.length, 2, 'seconda POST eseguita');
  assert.equal(calls[1].body.excludeNames.length, 10, 'ricette già mostrate escluse');
  assert.equal(calls[1].body.alternatives, undefined, 'nessuna grammatura nemmeno nella seconda ricerca');
  assert.ok(calls[1].body.excludeNames.includes('Ricetta 1'));
  assert.equal(window.document.querySelectorAll('.websearch-card').length, 10, 'nuove 10 schede');
  assert.match(window.document.querySelector('.websearch-card').textContent, /Extra 1/);

  window.PianoWebSearch.close();
  assert.equal(modal.classList.contains('hidden'), true, 'modale chiusa');

  // ---- Errori del Worker distinti per `code`, non solo per status HTTP ----
  const describe = window.PianoWebSearch._describeWorkerError;
  const fakeResponse = (status, headers = {}) => ({ status, headers: { get: name => headers[name.toLowerCase()] ?? null } });
  const workerLimit = describe(fakeResponse(429, { 'retry-after': '600' }), { error: 'Hai raggiunto il limite temporaneo di ricerche del Worker per il tuo account.', code: 'WORKER_RATE_LIMIT', retryAfter: 600 });
  assert.match(workerLimit, /Troppe ricerche in poco tempo dal tuo account/, '429 del Worker → limite personale');
  assert.match(workerLimit, /10 minuti/, 'retry-after tradotto in minuti');
  const quota = describe(fakeResponse(429, { 'retry-after': '42' }), { error: 'Quota o rate limit Gemini raggiunti per gemini-3.5-flash-lite (HTTP 429 RESOURCE_EXHAUSTED): GenerateRequestsPerDayPerProjectPerModel-FreeTier. Riprova tra circa 42 secondi.', code: 'GEMINI_QUOTA', retryAfter: 42 });
  assert.doesNotMatch(quota, /Troppe ricerche in poco tempo/, '429 per quota Gemini NON è il limite del Worker');
  assert.match(quota, /gemini-3\.5-flash-lite/, 'la causa reale (modello) resta visibile');
  const quotaZero = describe(fakeResponse(429), { error: 'Il progetto Google della API key non ha alcuna quota per gemini-3.5-flash-lite (limite 0). Il blocco è nel progetto/API key Google, non nel codice del Worker.', code: 'GEMINI_QUOTA' });
  assert.match(quotaZero, /progetto\/API key Google/, 'quota zero spiegata come problema del progetto');
  const configuration = describe(fakeResponse(502), { error: 'Il modello gemini-3.5-flash-lite (HTTP 400 FAILED_PRECONDITION) è stato ritirato da Google e non è più disponibile: aggiorna GEMINI_TEXT_MODEL nel Worker.', code: 'GEMINI_CONFIGURATION' });
  assert.match(configuration, /problema di configurazione del servizio AI/, '502 di configurazione');
  assert.match(configuration, /ritirato da Google/, 'dettaglio del Worker conservato');
  const unavailable = describe(fakeResponse(502), { error: 'Gemini non ha risposto correttamente per gemini-3.5-flash-lite (HTTP 503 UNAVAILABLE).', code: 'GEMINI_UNAVAILABLE' });
  assert.match(unavailable, /servizio AI non ha risposto/, '502 del provider');
  const invalid = describe(fakeResponse(422), { error: 'Gemini non ha trovato ricette adatte alla richiesta: prova con altri ingredienti o preferenze.', code: 'GEMINI_INVALID_RESPONSE' });
  assert.match(invalid, /altri ingredienti/, '422 → invito a cambiare ricerca');
  assert.doesNotMatch(invalid, /configurazione|quota/i, 'il 422 non parla di quota o configurazione');
  // Worker precedente senza `code`: il 429 generico resta comprensibile.
  assert.match(describe(fakeResponse(429), null), /Troppe richieste in questo momento/);
  assert.match(describe(fakeResponse(500), null), /non è disponibile \(500\)/);
  assert.match(describe(fakeResponse(401), { error: 'Autenticazione richiesta.', code: 'UNAUTHENTICATED' }), /Autenticazione richiesta/);

  // La modale mostra il messaggio del Worker così com'è stato descritto.
  window.fetch = async () => ({
    ok: false,
    status: 429,
    headers: { get: name => (name.toLowerCase() === 'retry-after' ? '42' : null) },
    json: async () => ({ error: 'Quota o rate limit Gemini raggiunti per gemini-3.5-flash-lite (HTTP 429 RESOURCE_EXHAUSTED). Riprova tra circa 42 secondi.', code: 'GEMINI_QUOTA', retryAfter: 42 })
  });
  window.PianoWebSearch.open();
  window.document.getElementById('websearch-form').dispatchEvent(new window.Event('submit'));
  for (let i = 0; i < 10; i += 1) await wait();
  const errorBox = window.document.getElementById('websearch-error');
  assert.equal(errorBox.classList.contains('hidden'), false, 'errore mostrato');
  assert.match(errorBox.textContent, /Quota o rate limit Gemini/, 'messaggio della quota Gemini');
  assert.doesNotMatch(errorBox.textContent, /Troppe ricerche in poco tempo/, 'nessun messaggio del limite interno per la quota Gemini');
  assert.equal(window.document.querySelectorAll('.websearch-card').length, 0, 'nessuna scheda su errore');
  window.PianoWebSearch.close();

  console.log('smoke-web-search: OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
