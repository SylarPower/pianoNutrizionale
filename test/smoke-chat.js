'use strict';
/* Smoke browser-like della chat AI: verifica il pulsante fluttuante, il
 * pannello chat, le risposte locali sui dati dell'app e la ricerca di nuove
 * ricette (fetch stubbato) con apertura del popup di importazione.
 * Nessuna rete né microfono reale. */
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

window.PIANO_AI_CONFIG = { recipesEndpoint: 'https://worker.test/recipes', language: 'it-IT', maxRecipes: 10 };
window.PianoDomain = {};
window.firebase = { auth: () => ({ currentUser: { getIdToken: async () => 'fake-token' } }) };

const days = {};
['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach(day => {
  days[day] = { type: 'training', breakfast: null, snack1: null, lunch: null, snack2: null, dinner: null };
});
window.appState = {
  user: { email: 'mario@utenti.pianonutrizionale.app' },
  plan: { days },
  recipes: [],
  recipesById: {},
  household: null,
  deviceSettings: { portionProfile: 'man' }
};
window.getPortionProfile = () => 'man';
window.MELLER_GUIDE = {};
window.getVisibleShoppingEntries = () => [];
window.shoppingAmountText = () => '';
window.getActiveBatch = () => [];

const toasts = [];
window.showToast = (message, isError) => toasts.push({ message, isError });
const imported = [];
window.importRecipeFromChat = recipe => imported.push(recipe);
window.openRecipeModal = recipeId => { window._openedRecipe = recipeId; };

vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/chat-domain.js'), 'utf8'), dom.getInternalVMContext(), { filename: 'js/chat-domain.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/chat.js'), 'utf8'), dom.getInternalVMContext(), { filename: 'js/chat.js' });
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

assert.ok(window.PianoChat, 'API globale chat presente');
window.PianoChat.setAvailability(true);
const fab = window.document.getElementById('chat-fab');
assert.ok(fab, 'pulsante fluttuante presente');
assert.equal(fab.classList.contains('hidden'), false, 'pulsante visibile con account attivo');

window.PianoChat.open();
const panel = window.document.getElementById('chat-panel');
assert.ok(panel, 'pannello chat presente');
assert.equal(panel.classList.contains('hidden'), false, 'pannello aperto');
assert.match(window.document.getElementById('chat-messages').innerHTML, /Ciao!/, 'messaggio di benvenuto');

(async () => {
  // ---- Risposta locale sui dati dell'app (nessuna rete) ----
  await window.PianoChat._send('cosa mangio oggi');
  assert.match(window.document.getElementById('chat-messages').innerHTML, /Piano di/, 'risposta locale con il piano');

  // ---- Ricerca web di nuove ricette (fetch stubbato nel contesto vm) ----
  window.fetch = async (url, init) => {
    assert.match(String(url), /\/recipes$/, 'chiama l’endpoint /recipes');
    assert.equal(JSON.parse(init.body).query, 'ricetta con pollo e riso');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        recipes: [{
          name: 'Pollo e riso al curry',
          slot: 'lunch',
          emoji: '🍛',
          ingredients: [{ name: 'Pollo', quantity: '200 g' }, { name: 'Riso', quantity: '90 g' }],
          steps: ['Cuoci il pollo', 'Aggiungi il riso'],
          notes: [],
          sourceUrl: 'https://example.com/ricetta',
          sourceTitle: 'Esempio'
        }],
        sources: [{ title: 'Esempio', url: 'https://example.com/ricetta' }]
      })
    };
  };
  await window.PianoChat._send('ricetta con pollo e riso');
  const html = window.document.getElementById('chat-messages').innerHTML;
  assert.match(html, /chat-recipe-card/, 'scheda ricetta renderizzata');
  assert.match(html, /Pollo e riso al curry/, 'nome della ricetta visibile');

  const card = window.document.querySelector('.chat-recipe-card[data-action="open-ai-recipe"]');
  assert.ok(card, 'scheda cliccabile');
  card.click();
  assert.equal(imported.length, 1, 'popup di importazione aperto');
  assert.equal(imported[0].name, 'Pollo e riso al curry');

  // ---- Azioni rapide ----
  const quick = window.document.querySelector('#chat-quick-actions button[data-action="send-quick"]');
  assert.ok(quick, 'azione rapida presente');
  quick.click();
  assert.match(window.document.getElementById('chat-messages').innerHTML, /Cosa mangio oggi/, 'azione rapida inviata come messaggio');

  // ---- Chiusura ----
  window.PianoChat.close();
  assert.equal(panel.classList.contains('hidden'), true, 'pannello chiuso');
  window.PianoChat.setAvailability(false);
  assert.equal(fab.classList.contains('hidden'), true, 'pulsante nascosto senza account');

  console.log('smoke-chat: OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
