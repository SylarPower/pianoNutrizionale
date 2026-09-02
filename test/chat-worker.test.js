'use strict';
/* Test unitari del Worker Cloudflare della chat AI (ricerca ricette dal web).
 * Importa direttamente il modulo ES: nessuna rete reale, fetch viene stubbato. */
const test = require('node:test');
const assert = require('node:assert/strict');

const WORKER_PATH = '../cloudflare/ai-worker/src/index.js';

async function loadWorker() {
  return import(WORKER_PATH);
}

test('Worker: modello testuale di default e prefisso models/ rimosso', async () => {
  const { textModelName } = await loadWorker();
  assert.equal(textModelName({}), 'gemini-2.5-flash', 'default gemini-2.5-flash');
  assert.equal(textModelName({ GEMINI_TEXT_MODEL: 'models/gemini-2.0-flash' }), 'gemini-2.0-flash');
});

test('Worker: normalizza una ricetta pulita', async () => {
  const { normalizeRecipe } = await loadWorker();
  const recipe = normalizeRecipe({
    name: '  Pollo al curry  ',
    slot: 'dinner',
    emoji: '🍛',
    ingredients: [
      { name: 'Pollo', quantity: '200 g' },
      { name: '', quantity: '' },
      { name: 'Riso', quantity: '90 g' }
    ],
    steps: ['Cuoci il pollo', '  ', 'Aggiungi il riso'],
    notes: ['Servire caldo'],
    sourceUrl: 'https://example.com/ricetta',
    sourceTitle: 'Esempio'
  });
  assert.equal(recipe.name, 'Pollo al curry');
  assert.equal(recipe.slot, 'dinner');
  assert.equal(recipe.ingredients.length, 2, 'ingredienti vuoti scartati');
  assert.equal(recipe.steps.length, 2, 'passaggi vuoti scartati');
  assert.equal(recipe.sourceUrl, 'https://example.com/ricetta');
  assert.equal(normalizeRecipe({ name: 'x', slot: 'non-valido' }).slot, 'lunch', 'slot invalido → lunch');
});

test('Worker: estrae e filtra le ricette dalla chiamata search_recipes', async () => {
  const { parseRecipesFromResponse } = await loadWorker();
  const recipes = Array.from({ length: 14 }, (_, i) => ({
    name: `Ricetta ${i}`,
    ingredients: [{ name: 'Pollo', quantity: '200 g' }],
    steps: ['Step']
  }));
  const data = {
    candidates: [{ content: { parts: [{ functionCall: { name: 'search_recipes', args: { recipes } } }] } }]
  };
  const parsed = parseRecipesFromResponse(data, 10);
  assert.equal(parsed.length, 10, 'massimo 10 ricette');
  assert.equal(parsed[0].name, 'Ricetta 0');
  assert.equal(parseRecipesFromResponse({ candidates: [{ content: { parts: [] } }] }, 10).length, 0, 'nessuna chiamata → vuoto');
});

test('Worker: estrae le fonti da groundingMetadata senza duplicati', async () => {
  const { extractSources } = await loadWorker();
  const data = {
    candidates: [{
      groundingMetadata: {
        groundingChunks: [
          { web: { title: 'A', uri: 'https://example.com/a' } },
          { web: { title: 'A', uri: 'https://example.com/a' } },
          { web: { title: 'B', uri: 'https://example.com/b' } },
          { web: { title: 'C', uri: 'javascript:void(0)' } }
        ]
      }
    }]
  };
  const sources = extractSources(data);
  assert.equal(sources.length, 2, 'deduplicati e url non validi scartati');
});

test('Worker /recipes: chiama Gemini testuale con grounding e restituisce le ricette', async () => {
  const { handleRecipes } = await loadWorker();
  let lastBody = null;
  global.fetch = async (url, init) => {
    lastBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        candidates: [{
          content: { parts: [{ functionCall: { name: 'search_recipes', args: { recipes: [{ name: 'Pollo e riso', ingredients: [{ name: 'Pollo', quantity: '200 g' }], steps: ['Step'] }] } } }] },
          groundingMetadata: { groundingChunks: [{ web: { title: 'Fonte', uri: 'https://example.com/r' } }] }
        }]
      })
    };
  };
  const request = { json: async () => ({ query: 'ricetta con pollo e riso' }) };
  const response = await handleRecipes(request, { GEMINI_API_KEY: 'k', GEMINI_TEXT_MODEL: 'gemini-2.5-flash' }, 'https://app');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.recipes.length, 1);
  assert.equal(body.recipes[0].name, 'Pollo e riso');
  assert.equal(body.sources.length, 1);
  assert.ok(lastBody.tools[0].googleSearch, 'Google Search grounding attivo');
  assert.equal(lastBody.tools[1].functionDeclarations[0].name, 'search_recipes');
});

test('Worker /recipes: senza chiamata Gemini risponde 422 con messaggio italiano', async () => {
  const { handleRecipes } = await loadWorker();
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'nessuna chiamata' }] } }] })
  });
  const request = { json: async () => ({ query: 'ricetta impossibile' }) };
  const response = await handleRecipes(request, { GEMINI_API_KEY: 'k' }, 'https://app');
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.match(body.error, /non sono riuscito|ricette valide/i);
});
