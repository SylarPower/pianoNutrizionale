'use strict';
/* Test unitari del Worker Cloudflare dell'assistente (logica token effimeri).
 * Importa direttamente il modulo ES: nessuna rete reale, fetch viene stubbato. */
const test = require('node:test');
const assert = require('node:assert/strict');

const WORKER_PATH = '../cloudflare/assistant-worker/src/index.js';

async function loadWorker() {
  return import(WORKER_PATH);
}

const envWithFallback = {
  GEMINI_API_KEY: 'test-key',
  GEMINI_LIVE_MODEL: 'gemini-3.1-flash-live-preview',
  GEMINI_LIVE_FALLBACK_MODEL: 'gemini-2.5-flash-native-audio-preview-12-2025'
};

test('Worker: il token effimero non viene vincolato al modello', async () => {
  const { createEphemeralToken } = await loadWorker();
  let lastBody = null;
  global.fetch = async (url, init) => {
    lastBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ name: 'tokens/eph-1' }) };
  };
  const result = await createEphemeralToken(envWithFallback, 'gemini-3.1-flash-live-preview');
  assert.equal(result.model, 'gemini-3.1-flash-live-preview');
  assert.equal(result.token, 'tokens/eph-1');
  assert.equal(lastBody.uses, 0, 'uses:0 per riconnessioni senza nuove emissioni');
  assert.equal(lastBody.bidiGenerateContentSetup, undefined, 'nessun setup: il token vale per qualunque modello');
  assert.equal(lastBody.fieldMask, undefined, 'nessun fieldMask');
});

test('Worker: se il modello richiesto fallisce in emissione si prova il modello di riserva', async () => {
  const { createEphemeralToken } = await loadWorker();
  let calls = 0;
  global.fetch = async (url, init) => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, json: async () => ({ error: { message: 'Quota superata per questo modello.' } }) };
    }
    return { ok: true, json: async () => ({ name: 'tokens/eph-native' }) };
  };
  const result = await createEphemeralToken(envWithFallback, 'gemini-3.1-flash-live-preview');
  assert.equal(result.model, 'gemini-2.5-flash-native-audio-preview-12-2025', 'emesso per il modello di riserva');
  assert.equal(result.token, 'tokens/eph-native');
  assert.equal(calls, 2, 'prima il modello richiesto, poi quello di riserva');
});

test('Worker: senza modello di riserva l’errore di emissione risale al chiamante', async () => {
  const { createEphemeralToken } = await loadWorker();
  global.fetch = async () => ({ ok: false, json: async () => ({ error: { message: 'Chiave non valida.' } }) });
  await assert.rejects(
    () => createEphemeralToken({ GEMINI_API_KEY: 'x', GEMINI_LIVE_MODEL: 'gemini-3.1-flash-live-preview' }, 'gemini-3.1-flash-live-preview'),
    /Chiave non valida/
  );
});

test('Worker: resolveModel accetta solo i modelli configurati', async () => {
  const { resolveModel } = await loadWorker();
  const request = model => ({ json: async () => (model ? { model } : {}) });
  assert.equal(await resolveModel(request('models/gemini-3.1-flash-live-preview'), envWithFallback), 'gemini-3.1-flash-live-preview');
  assert.equal(await resolveModel(request('gemini-2.5-flash-native-audio-preview-12-2025'), envWithFallback), 'gemini-2.5-flash-native-audio-preview-12-2025');
  // Modelli estranei o assenti: si emette per il modello principale.
  assert.equal(await resolveModel(request('models/modello-estraneo'), envWithFallback), 'gemini-3.1-flash-live-preview');
  assert.equal(await resolveModel(request(''), envWithFallback), 'gemini-3.1-flash-live-preview');
});

test('Worker /recipe: GEMINI_TEXT_MODEL di default e sovrascrivibile', async () => {
  const { textModelName } = await loadWorker();
  assert.equal(textModelName({}), 'gemini-2.5-flash', 'default gemini-2.5-flash senza variabile');
  assert.equal(textModelName({ GEMINI_TEXT_MODEL: 'models/gemini-2.0-flash' }), 'gemini-2.0-flash', 'prefisso models/ rimosso');
});

test('Worker /recipe: parsing del functionCall import_recipe', async () => {
  const { extractRecipeFunctionCall, parseRecipeFromResponse } = await loadWorker();
  const response = {
    candidates: [{
      content: { parts: [{ functionCall: { name: 'import_recipe', args: { name: 'Pollo al limone', slot: 'dinner', emoji: '🍋', ingredients: [{ name: 'Pollo', quantity: '300 g' }], steps: ['Cuoci il pollo'], notes: [] } } }] }
    }]
  };
  const call = extractRecipeFunctionCall(response);
  assert.equal(call.name, 'import_recipe');
  const recipe = parseRecipeFromResponse(response);
  assert.equal(recipe.name, 'Pollo al limone');
  assert.equal(recipe.slot, 'dinner');
  assert.equal(recipe.emoji, '🍋');
  assert.deepEqual(recipe.ingredients, [{ name: 'Pollo', quantity: '300 g' }]);
  assert.deepEqual(recipe.steps, ['Cuoci il pollo']);
});

test('Worker /recipe: senza functionCall il parsing restituisce null (→ 422)', async () => {
  const { parseRecipeFromResponse } = await loadWorker();
  assert.equal(parseRecipeFromResponse({ candidates: [{ content: { parts: [{ text: 'Mi dispiace.' }] } }] }), null);
  assert.equal(parseRecipeFromResponse({ candidates: [] }), null);
  assert.equal(parseRecipeFromResponse({}), null);
  assert.equal(parseRecipeFromResponse({ candidates: [{ content: { parts: [{ functionCall: { name: 'altro', args: {} } }] } }] }), null);
});

test('Worker /recipe: handleRecipe chiama Gemini testuale con grounding e restituisce 200', async () => {
  const { handleRecipe } = await loadWorker();
  let lastUrl = '';
  let lastBody = null;
  global.fetch = async (url, init) => {
    lastUrl = String(url);
    lastBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ functionCall: { name: 'import_recipe', args: { name: 'Pollo al limone', slot: 'dinner', ingredients: [{ name: 'Pollo', quantity: '300 g' }], steps: ['Cuoci'], notes: [] } } }] } }]
      })
    };
  };
  const response = await handleRecipe(
    { json: async () => ({ query: 'trovami una ricetta con pollo', language: 'it-IT' }) },
    envWithFallback,
    'https://app.test'
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.recipe.name, 'Pollo al limone');
  assert.match(lastUrl, /gemini-2\.5-flash:generateContent/, 'modello testuale (non Live)');
  assert.ok(lastBody.tools.some(tool => tool.googleSearch), 'Google Search grounding presente');
  const declarations = lastBody.tools.find(tool => tool.functionDeclarations)?.functionDeclarations || [];
  assert.ok(declarations.some(tool => tool.name === 'import_recipe'), 'tool import_recipe presente');
  assert.match(lastBody.systemInstruction.parts[0].text, /dott\. Meller/, 'system instruction con i massimi Meller');
  assert.match(lastBody.systemInstruction.parts[0].text, /pollame 200 g/);
});

test('Worker /recipe: senza chiamata Gemini risponde 422 con messaggio italiano', async () => {
  const { handleRecipe } = await loadWorker();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Non posso aiutarti.' }] } }] }) });
  const response = await handleRecipe(
    { json: async () => ({ query: 'trovami una ricetta' }) },
    envWithFallback,
    'https://app.test'
  );
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.match(body.error, /ricetta valida|Riprova/i);
});
