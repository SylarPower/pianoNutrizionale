'use strict';
/* Smoke browser-like della ricerca ricette online: modale, invio del form,
 * schede risultato, apertura del popup di importazione e "Altre 10 ricette"
 * con esclusione delle ricette già mostrate. Nessuna rete reale. */
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
// Lo stub espone le tre funzioni della fonte unica usate da js/web-search.js:
// `alternatives` è il testo completo delle famiglie Meller per il modello AI.
window.PianoDomain = {
  mellerAlternativesText: () => 'ALTERNATIVE CARBOIDRATI MELLER:\nPasta, Riso: pranzo allenamento 90 g, pranzo riposo 70 g, cena 40 g.',
  mellerGuidelinesText: () => 'pollame 200 g',
  mellerMealStructureText: () => 'pranzo: proteine + carboidrati + verdure'
};
window.firebase = { auth: () => ({ currentUser: { getIdToken: async () => 'fake-token' } }) };
window.appState = { user: { email: 'mario@utenti.pianonutrizionale.app' }, recipes: [], recipesById: {} };
window.escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const toasts = [];
window.showToast = (message, isError) => toasts.push({ message, isError });
const imported = [];
window.importRecipeFromWebSearch = recipe => imported.push(recipe);

const calls = [];
function recipeBatch(prefix) {
  return Array.from({ length: 10 }, (_, i) => ({
    name: `${prefix} ${i + 1}`,
    slot: 'lunch',
    emoji: '🍛',
    ingredients: [{ name: 'Pollo', quantity: '200 g' }, { name: 'Riso', quantity: '90 g' }],
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
  assert.equal(calls[0].body.guidelines, 'pollame 200 g', 'guidelines Meller inviate');
  assert.equal(
    calls[0].body.alternatives,
    window.PianoDomain.mellerAlternativesText(),
    'testo completo delle alternative Meller inviato al Worker'
  );
  assert.match(calls[0].body.alternatives, /ALTERNATIVE CARBOIDRATI MELLER/, 'campo alternatives derivato da PianoDomain');
  assert.match(calls[0].body.mealStructure, /pranzo:/, 'struttura dei pasti inviata');

  const cards = window.document.querySelectorAll('.websearch-card');
  assert.equal(cards.length, 10, '10 schede ricetta');
  assert.match(cards[0].textContent, /Ricetta 1/);

  // ---- Apertura + importazione ----
  cards[0].dispatchEvent(new window.Event('click'));
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
  assert.equal(calls[1].body.alternatives, window.PianoDomain.mellerAlternativesText(), 'alternative inviate anche nella seconda ricerca');
  assert.ok(calls[1].body.excludeNames.includes('Ricetta 1'));
  assert.equal(window.document.querySelectorAll('.websearch-card').length, 10, 'nuove 10 schede');
  assert.match(window.document.querySelector('.websearch-card').textContent, /Extra 1/);

  window.PianoWebSearch.close();
  assert.equal(modal.classList.contains('hidden'), true, 'modale chiusa');

  console.log('smoke-web-search: OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
