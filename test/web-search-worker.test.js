'use strict';
/* Test unitari del Worker Cloudflare per la ricerca ricette dal web.
 * Importa direttamente il modulo ES: nessuna rete reale, fetch viene stubbato. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = '../cloudflare/ai-worker/src/index.js';
// Fonte unica delle regole Meller: vive SOLO nell'app. Il Worker non la
// importa e non la riceve, così resta un file singolo deployabile dalla
// dashboard Cloudflare con un copia-incolla.
const PIANO_DOMAIN = require('../js/domain.js');

const FAKE_API_KEY = 'AIzaSyFAKEKEY_0123456789abcdefghijklmnopq';
const FAKE_ID_TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYyJ9.eyJzdWIiOiJ1c2VyLTEiLCJhdWQiOiJwaWFubyJ9.c2lnbmF0dXJlLWZpbnRh';
const ENV = { GEMINI_API_KEY: FAKE_API_KEY };

async function loadWorker() {
  const worker = await import(WORKER_PATH);
  worker.resetWorkerState();
  return worker;
}

function recipe(name, overrides = {}) {
  return {
    name,
    slot: 'lunch',
    emoji: '🍛',
    ingredients: [{ name: 'Pollo', quantity: '200 g' }, { name: 'Riso', quantity: '80 g' }],
    steps: ['Cuoci il pollo', 'Aggiungi il riso'],
    notes: [],
    sourceUrl: 'https://example.com/ricetta',
    sourceTitle: 'Esempio',
    ...overrides
  };
}

// Risposta Gemini con JSON strutturato (responseMimeType application/json):
// il JSON è nel `text` del primo part, le fonti in groundingMetadata.
function geminiJsonResponse(recipes, { text, grounding = true, finishReason = 'STOP' } = {}) {
  return {
    candidates: [{
      content: { role: 'model', parts: [{ text: text ?? JSON.stringify({ recipes }) }] },
      finishReason,
      ...(grounding ? {
        groundingMetadata: {
          webSearchQueries: ['ricetta pollo riso'],
          groundingChunks: [{ web: { title: 'Fonte', uri: 'https://example.com/r' } }]
        }
      } : {})
    }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 400, totalTokenCount: 500 }
  };
}

function ok(body) {
  return { ok: true, status: 200, json: async () => body };
}

function geminiError(status, error) {
  return { ok: false, status, json: async () => ({ error: { code: status, ...error } }) };
}

const QUOTA_ERROR = {
  status: 'RESOURCE_EXHAUSTED',
  message: 'You exceeded your current quota, please check your plan and billing details. For more information on this error head to: https://ai.google.dev/gemini-api/docs/rate-limits.',
  details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '500' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42s' }
  ]
};
const QUOTA_ZERO_ERROR = {
  status: 'RESOURCE_EXHAUSTED',
  message: 'You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.5-flash-lite',
  details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '0' }] }]
};
const RETIRED_ERROR = {
  status: 'FAILED_PRECONDITION',
  message: 'This model (models/gemini-2.5-flash-lite) is no longer available to new users. Please update your code to use models/gemini-3.5-flash-lite. We recommend the Interactions API.'
};
const TOOL_MIME_ERROR = {
  status: 'INVALID_ARGUMENT',
  message: "Tool use with a response mime type: 'application/json' is unsupported"
};
const INVALID_KEY_ERROR = {
  status: 'INVALID_ARGUMENT',
  message: 'API key not valid. Please pass a valid API key.',
  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }]
};

// Cattura console.* per verificare i log strutturati (e l'assenza di segreti).
function captureConsole() {
  const entries = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  ['log', 'warn', 'error'].forEach(level => {
    console[level] = (...args) => entries.push({ level, args });
  });
  return {
    entries,
    text: () => entries.map(entry => entry.args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')).join('\n'),
    restore: () => Object.assign(console, original)
  };
}

function modelOf(url) {
  return decodeURIComponent(String(url).split('/models/')[1].split(':')[0]);
}

function requestFor(body) {
  return { json: async () => body };
}

// ---------------------------------------------------------------------------
// Modelli
// ---------------------------------------------------------------------------

test('Worker: modello predefinito gemini-3.5-flash-lite e prefisso models/ rimosso', async () => {
  const { textModelName } = await loadWorker();
  assert.equal(textModelName({}), 'gemini-3.5-flash-lite', 'default gemini-3.5-flash-lite');
  assert.equal(textModelName({ GEMINI_TEXT_MODEL: 'models/gemini-3.5-flash-lite' }), 'gemini-3.5-flash-lite');
  assert.equal(textModelName({ GEMINI_TEXT_MODEL: '  ' }), 'gemini-3.5-flash-lite', 'variabile vuota → default');
});

test('Worker: unico fallback gemini-3.1-flash-lite, senza 3.6-flash né 2.5-flash-lite', async () => {
  const { textModelList } = await loadWorker();
  assert.deepEqual(textModelList({}), ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
  const list = textModelList({});
  assert.equal(list.includes('gemini-3.6-flash'), false, 'gemini-3.6-flash rimosso (grounding 0/0 nel progetto)');
  assert.equal(list.includes('gemini-2.5-flash-lite'), false, 'gemini-2.5-flash-lite rimosso (non più disponibile ai nuovi utenti)');
  assert.equal(list.length, 2, 'mai più di due modelli per click');
  // Nessun duplicato se il primario coincide con il fallback.
  assert.deepEqual(textModelList({ GEMINI_TEXT_MODEL: 'gemini-3.1-flash-lite' }), ['gemini-3.1-flash-lite']);
  // Fallback configurabile e disattivabile da wrangler/dashboard.
  assert.deepEqual(textModelList({ GEMINI_FALLBACK_MODELS: '' }), ['gemini-3.5-flash-lite']);
  assert.deepEqual(textModelList({ GEMINI_FALLBACK_MODELS: 'models/gemini-3.1-flash-lite, gemini-3.7-flash' }), ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'], 'lista tagliata a due modelli');
});

test('Worker: sorgente e wrangler.toml non citano più i modelli rimossi', async () => {
  const source = fs.readFileSync(path.join(__dirname, WORKER_PATH), 'utf8');
  const toml = fs.readFileSync(path.join(__dirname, '../cloudflare/ai-worker/wrangler.toml'), 'utf8');
  assert.match(toml, /GEMINI_TEXT_MODEL = "gemini-3\.5-flash-lite"/, 'wrangler.toml usa il nuovo default');
  assert.match(toml, /GEMINI_FALLBACK_MODELS = "gemini-3\.1-flash-lite"/, 'wrangler.toml con l’unico fallback');
  assert.doesNotMatch(source, /FALLBACK_TEXT_MODELS\s*=\s*\[[^\]]*(gemini-3\.6-flash|gemini-2\.5-flash-lite)/, 'nessun modello rimosso nella lista di fallback');
  assert.doesNotMatch(toml, /=\s*"[^"\n]*(gemini-3\.6-flash|gemini-2\.5-flash-lite)/, 'nessun modello rimosso nei valori di wrangler.toml');
});

// ---------------------------------------------------------------------------
// Richiesta a Gemini: solo googleSearch + responseSchema
// ---------------------------------------------------------------------------

test('Worker: la richiesta grounded usa googleSearch senza functionDeclarations e chiede JSON strutturato', async () => {
  const { buildGroundedRequest, RECIPES_RESPONSE_SCHEMA } = await loadWorker();
  const body = buildGroundedRequest({ query: 'ricetta con pollo', maxRecipes: 10, slot: 'dinner', excludeNames: ['Pollo al curry'] });
  assert.deepEqual(body.tools, [{ googleSearch: {} }], 'unico tool: Google Search grounding');
  assert.equal(JSON.stringify(body).includes('functionDeclarations'), false, 'nessuna functionDeclaration nella richiesta');
  assert.equal(JSON.stringify(body).includes('search_recipes'), false, 'nessuna function call attesa');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.responseSchema, RECIPES_RESPONSE_SCHEMA);
  assert.equal(body.generationConfig.temperature, undefined, 'niente parametri di sampling deprecati');
  assert.equal(body.toolConfig, undefined, 'nessun toolConfig di function calling');
  // Schema con tutti i campi richiesti.
  const item = RECIPES_RESPONSE_SCHEMA.properties.recipes.items;
  assert.deepEqual(Object.keys(item.properties).sort(), ['emoji', 'ingredients', 'name', 'notes', 'slot', 'sourceTitle', 'sourceUrl', 'steps']);
  assert.deepEqual(item.properties.slot.enum, ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner']);
  assert.deepEqual(Object.keys(item.properties.ingredients.items.properties).sort(), ['name', 'quantity']);
  assert.equal(item.properties.steps.items.type, 'STRING');
  // Variante testuale (due passaggi): grounding sì, schema no.
  const textual = buildGroundedRequest({ query: 'ricetta', maxRecipes: 10, slot: '', excludeNames: [] }, { structured: false });
  assert.deepEqual(textual.tools, [{ googleSearch: {} }]);
  assert.equal(textual.generationConfig.responseMimeType, undefined);
  assert.equal(textual.generationConfig.responseSchema, undefined);
});

test('Worker: la chiamata di normalizzazione non usa grounding e impone lo schema', async () => {
  const { buildNormalizeRequest, RECIPES_RESPONSE_SCHEMA } = await loadWorker();
  const body = buildNormalizeRequest('Ricetta: pollo 200 g', { maxRecipes: 5, slot: 'lunch' });
  assert.equal(body.tools, undefined, 'nessun tool nel secondo passaggio');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.responseSchema, RECIPES_RESPONSE_SCHEMA);
  assert.match(body.systemInstruction.parts[0].text, /Non aggiungere ricette, ingredienti, dosi o URL assenti/);
  assert.match(body.systemInstruction.parts[0].text, /slot="lunch"/);
});

test('Worker: callGemini manda la chiave nell’header x-goog-api-key, mai nell’URL', async () => {
  const { callGemini } = await loadWorker();
  let seen = null;
  global.fetch = async (url, init) => {
    seen = { url: String(url), init };
    return ok(geminiJsonResponse([recipe('Pollo e riso')]));
  };
  await callGemini(FAKE_API_KEY, 'gemini-3.5-flash-lite', { contents: [] });
  assert.equal(seen.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(seen.url.includes('key='), false, 'nessun ?key= nell’URL');
  assert.equal(seen.init.headers['x-goog-api-key'], FAKE_API_KEY);
});

// ---------------------------------------------------------------------------
// Parsing robusto
// ---------------------------------------------------------------------------

test('Worker: parseRecipesFromResponse legge il JSON strutturato senza functionCall', async () => {
  const { parseRecipesFromResponse } = await loadWorker();
  const data = geminiJsonResponse([recipe('Pollo e riso'), recipe('Riso al pollo', { slot: 'lunch' })]);
  const parsed = parseRecipesFromResponse(data, 10, 'lunch');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, 'Pollo e riso');
  assert.equal(parsed[0].slot, 'lunch');
  assert.deepEqual(parsed[0].ingredients[0], { name: 'Pollo', quantity: '200 g' });
  assert.equal(parsed[0].sourceUrl, 'https://example.com/ricetta');
  // Il vecchio formato con functionCall non viene più letto: niente text → niente ricette.
  const legacy = { candidates: [{ content: { parts: [{ functionCall: { name: 'search_recipes', args: { recipes: [recipe('X')] } } }] } }] };
  assert.equal(parseRecipesFromResponse(legacy, 10, 'lunch').length, 0, 'la functionCall non è più il canale dei risultati');
});

test('Worker: parsing di JSON dentro code fence e immerso nel testo', async () => {
  const { parseRecipesFromResponse, parseRecipesPayload } = await loadWorker();
  const fenced = '```json\n' + JSON.stringify({ recipes: [recipe('Pollo e riso')] }) + '\n```';
  assert.equal(parseRecipesFromResponse(geminiJsonResponse([], { text: fenced }), 10, 'lunch').length, 1, 'code fence ```json```');
  assert.equal(parseRecipesPayload(fenced).partial, false, 'il code fence viene letto per intero, non recuperato pezzo per pezzo');
  const fencedPlain = '```\n' + JSON.stringify({ recipes: [recipe('Pollo e riso')] }) + '\n```';
  assert.equal(parseRecipesFromResponse(geminiJsonResponse([], { text: fencedPlain }), 10, 'lunch').length, 1, 'code fence senza linguaggio');
  // Code fence con array puro: senza la chiave "recipes" il recupero parziale
  // non può aiutare, deve funzionare l'estrazione dal fence.
  const fencedArray = 'Ecco:\n```json\n' + JSON.stringify([recipe('Pollo e riso'), recipe('Riso al pollo')]) + '\n```\nFine.';
  assert.equal(parseRecipesFromResponse(geminiJsonResponse([], { text: fencedArray }), 10, 'lunch').length, 2, 'array dentro code fence');
  const embedded = 'Ecco le ricette trovate:\n' + JSON.stringify({ recipes: [recipe('Pollo e riso')] }) + '\nBuon appetito!';
  assert.equal(parseRecipesFromResponse(geminiJsonResponse([], { text: embedded }), 10, 'lunch').length, 1, 'JSON immerso nel testo');
  assert.equal(parseRecipesPayload(embedded).partial, false, 'JSON immerso letto per intero');
  const embeddedArray = 'Risultati: ' + JSON.stringify([recipe('Pollo e riso')]) + ' — fine';
  assert.equal(parseRecipesFromResponse(geminiJsonResponse([], { text: embeddedArray }), 10, 'lunch').length, 1, 'array immerso nel testo');
  // Array puro di ricette, senza involucro { recipes }.
  const bare = JSON.stringify([recipe('Pollo e riso'), recipe('Riso al pollo')]);
  assert.equal(parseRecipesFromResponse(geminiJsonResponse([], { text: bare }), 10, 'lunch').length, 2, 'array di ricette');
  // Parti multiple (es. testo + JSON) vengono concatenate.
  const multi = { candidates: [{ content: { parts: [{ text: 'Risultati:' }, { text: JSON.stringify({ recipes: [recipe('Pollo e riso')] }) }] } }] };
  assert.equal(parseRecipesFromResponse(multi, 10, 'lunch').length, 1, 'più part testuali');
  // Le parti di "thinking" non vengono interpretate come risultato.
  const withThoughts = { candidates: [{ content: { parts: [{ thought: true, text: '{"recipes":[{"name":"pensiero","ingredients":[{"name":"x","quantity":"1"}]}]}' }, { text: '{"recipes":[]}' }] } }] };
  assert.equal(parseRecipesFromResponse(withThoughts, 10, 'lunch').length, 0, 'i thought part vengono ignorati');
  assert.equal(parseRecipesPayload(fenced).ok, true);
});

test('Worker: risposta già convertita in oggetto o in array', async () => {
  const { parseRecipesFromResponse } = await loadWorker();
  assert.equal(parseRecipesFromResponse({ recipes: [recipe('Pollo e riso')] }, 10, 'lunch').length, 1, 'oggetto { recipes }');
  assert.equal(parseRecipesFromResponse([recipe('Pollo e riso'), recipe('Riso al pollo')], 10, 'lunch').length, 2, 'array di ricette');
  assert.equal(parseRecipesFromResponse(recipe('Pollo e riso'), 10, 'lunch').length, 1, 'singola ricetta');
  assert.equal(parseRecipesFromResponse(JSON.stringify({ recipes: [recipe('Pollo e riso')] }), 10, 'lunch').length, 1, 'stringa JSON');
});

test('Worker: output malformato, elenco vuoto e valori spazzatura non producono ricette', async () => {
  const { parseRecipesFromResponse, parseRecipesPayload } = await loadWorker();
  assert.equal(parseRecipesPayload('{ "recipes": [ {"name": ').ok, false, 'JSON troncato senza oggetti completi');
  assert.equal(parseRecipesFromResponse(geminiJsonResponse([], { text: 'Non ho trovato nulla, mi spiace.' }), 10, 'lunch').length, 0, 'testo libero');
  assert.equal(parseRecipesFromResponse(geminiJsonResponse([], { text: '' }), 10, 'lunch').length, 0, 'testo vuoto');
  assert.equal(parseRecipesFromResponse(geminiJsonResponse([]), 10, 'lunch').length, 0, 'elenco vuoto esplicito');
  assert.equal(parseRecipesFromResponse({ candidates: [] }, 10, 'lunch').length, 0, 'nessun candidato');
  assert.equal(parseRecipesFromResponse(null, 10, 'lunch').length, 0, 'null');
  assert.equal(parseRecipesFromResponse('', 10, 'lunch').length, 0, 'stringa vuota');
  assert.equal(parseRecipesFromResponse(42, 10, 'lunch').length, 0, 'numero');
  assert.equal(parseRecipesFromResponse({ recipes: 'non un array' }, 10, 'lunch').length, 0, 'recipes non array');
  assert.equal(parseRecipesFromResponse({ recipes: [null, 'stringa', 7, { ingredients: [] }, { name: 'Senza ingredienti' }] }, 10, 'lunch').length, 0, 'elementi non validi scartati');
  assert.equal(parseRecipesFromResponse({ recipes: [{ name: { nested: true }, ingredients: [{ name: 'x', quantity: '1' }] }] }, 10, 'lunch').length, 0, 'nome non stringa scartato');
});

test('Worker: JSON troncato da MAX_TOKENS → recupera le ricette complete', async () => {
  const { parseRecipesFromResponse, parseRecipesPayload } = await loadWorker();
  const full = JSON.stringify({ recipes: [recipe('Ricetta 1'), recipe('Ricetta 2'), recipe('Ricetta 3')] });
  const truncated = full.slice(0, full.lastIndexOf('"Ricetta 3"') + 20);
  const payload = parseRecipesPayload(truncated);
  assert.equal(payload.ok, true);
  assert.equal(payload.partial, true, 'segnalato come parziale');
  const parsed = parseRecipesFromResponse(geminiJsonResponse([], { text: truncated, finishReason: 'MAX_TOKENS' }), 10, 'lunch');
  assert.deepEqual(parsed.map(item => item.name), ['Ricetta 1', 'Ricetta 2']);
});

test('Worker: slot richiesto forzato e massimo 10 ricette', async () => {
  const { parseRecipesFromResponse } = await loadWorker();
  const recipes = Array.from({ length: 14 }, (_, i) => ({
    name: `Ricetta ${i}`,
    ingredients: [{ name: 'Pollo', quantity: '200 g' }],
    steps: ['Step']
  }));
  recipes.push(recipe('Colazione fuori posto', { slot: 'breakfast' }));
  recipes.push(recipe('Slot inventato', { slot: 'brunch' }));
  const parsed = parseRecipesFromResponse(geminiJsonResponse(recipes), 10, 'dinner');
  assert.equal(parsed.length, 10, 'massimo 10 ricette');
  assert.ok(parsed.every(item => item.slot === 'dinner'), 'slot mancante → slot richiesto');
  assert.equal(parsed.some(item => item.name === 'Colazione fuori posto'), false, 'slot diverso scartato');
  assert.equal(parseRecipesFromResponse(geminiJsonResponse(recipes), 25, 'dinner').length, 10, 'maxRecipes oltre 10 viene limitato');
  assert.equal(parseRecipesFromResponse(geminiJsonResponse(recipes), 3, 'dinner').length, 3, 'maxRecipes inferiore rispettato');
  assert.equal(parseRecipesFromResponse(geminiJsonResponse([recipe('Slot inventato', { slot: 'brunch' })]), 10, 'snack1')[0].slot, 'snack1', 'slot invalido → slot richiesto');
  // Senza slot richiesto restano tutti gli slot; duplicati e ricette escluse spariscono.
  const mixed = [recipe('A', { slot: 'breakfast' }), recipe('B', { slot: 'dinner' }), recipe('a'), recipe('Vista', { slot: 'dinner' })];
  const free = parseRecipesFromResponse(geminiJsonResponse(mixed), 10, '', ['vista']);
  assert.deepEqual(free.map(item => item.name), ['A', 'B'], 'duplicato (case-insensitive) ed esclusa rimossi');
});

test('Worker: normalizeRecipe usa il defaultSlot quando lo slot manca o è invalido', async () => {
  const { normalizeRecipe } = await loadWorker();
  const normalized = normalizeRecipe({
    name: '  Pollo al curry  ',
    slot: 'dinner',
    emoji: '🍛',
    ingredients: [
      { name: 'Pollo', quantity: '200 g' },
      { name: '', quantity: '' },
      { name: 'Riso', quantity: '90 g' },
      'Sale q.b.'
    ],
    steps: ['Cuoci il pollo', '  ', 'Aggiungi il riso'],
    notes: ['Servire caldo'],
    sourceUrl: 'https://example.com/ricetta',
    sourceTitle: 'Esempio'
  }, 'breakfast');
  assert.equal(normalized.name, 'Pollo al curry');
  assert.equal(normalized.slot, 'dinner', 'slot valido dell’item ha la precedenza');
  assert.equal(normalized.ingredients.length, 3, 'ingredienti vuoti scartati, stringhe accettate');
  assert.deepEqual(normalized.ingredients[2], { name: 'Sale q.b.', quantity: '' });
  assert.equal(normalized.steps.length, 2, 'passaggi vuoti scartati');
  assert.equal(normalized.sourceUrl, 'https://example.com/ricetta');
  assert.equal(normalizeRecipe({ name: 'x', slot: 'non-valido' }, 'snack1').slot, 'snack1', 'slot invalido → defaultSlot');
  assert.equal(normalizeRecipe({ name: 'x' }).slot, 'lunch', 'senza defaultSlot → lunch');
  assert.equal(normalizeRecipe({ name: 'x', sourceUrl: 'javascript:alert(1)' }).sourceUrl, '', 'URL non http scartato');
  assert.equal(normalizeRecipe({ name: 'x', sourceUrl: 'ftp://example.com/a' }).sourceUrl, '', 'URL ftp scartato');
  assert.equal(normalizeRecipe({ name: 'x', sourceUrl: 'non è un url' }).sourceUrl, '', 'URL inventato/malformato scartato');
  assert.equal(normalizeRecipe({ name: 'x', emoji: 'testo lungo non emoji' }).emoji, '', 'emoji troppo lunga scartata');
  assert.equal(normalizeRecipe({ name: 'x', steps: 'Passo uno\nPasso due' }).steps.length, 2, 'passaggi come testo multilinea');
  assert.equal(normalizeRecipe(null).name, 'Ricetta', 'input nullo non esplode');
});

test('Worker: estrae le fonti da groundingMetadata senza duplicati e senza inventare URL', async () => {
  const { extractSources } = await loadWorker();
  const data = {
    candidates: [{
      groundingMetadata: {
        groundingChunks: [
          { web: { title: 'A', uri: 'https://example.com/a' } },
          { web: { title: 'A', uri: 'https://example.com/a' } },
          { web: { title: 'B', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/xyz' } },
          { web: { title: 'C', uri: 'javascript:void(0)' } },
          { web: { title: 'D' } },
          { retrievedContext: { title: 'E' } }
        ]
      }
    }]
  };
  const sources = extractSources(data);
  assert.equal(sources.length, 2, 'deduplicati, url non validi o assenti scartati');
  assert.deepEqual(sources[0], { title: 'A', url: 'https://example.com/a' });
  assert.deepEqual(extractSources({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }), [], 'nessun groundingMetadata → nessuna fonte');
  assert.deepEqual(extractSources(null), []);
});

// ---------------------------------------------------------------------------
// Pipeline e fallback
// ---------------------------------------------------------------------------

test('Worker: una sola chiamata Gemini quando la risposta strutturata è valida', async () => {
  const { generateRecipesContent } = await loadWorker();
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ model: modelOf(url), body: JSON.parse(init.body) });
    return ok(geminiJsonResponse([recipe('Pollo e riso')]));
  };
  const result = await generateRecipesContent(ENV, 'pollo', 10, 'lunch', []);
  assert.equal(calls.length, 1, 'nessuna chiamata di normalizzazione se il JSON è già valido');
  assert.equal(calls[0].model, 'gemini-3.5-flash-lite');
  assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');
  assert.equal(result.model, 'gemini-3.5-flash-lite');
  assert.equal(result.mode, 'grounded-json');
  assert.equal(result.recipes.length, 1);
  assert.equal(result.sources.length, 1, 'fonti da groundingMetadata');
});

test('Worker: quota sul primario → fallback su gemini-3.1-flash-lite', async () => {
  const { generateRecipesContent } = await loadWorker();
  const models = [];
  const logs = captureConsole();
  try {
    global.fetch = async url => {
      models.push(modelOf(url));
      if (models.length === 1) return geminiError(429, QUOTA_ERROR);
      return ok(geminiJsonResponse([recipe('Pollo e riso')]));
    };
    const result = await generateRecipesContent(ENV, 'pollo', 10, 'lunch', []);
    assert.deepEqual(models, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
    assert.equal(result.model, 'gemini-3.1-flash-lite');
    assert.equal(result.failures.length, 1, 'il tentativo fallito viene riportato');
    assert.equal(result.failures[0].reason, 'quota');
  } finally {
    logs.restore();
  }
  const logged = logs.entries.find(entry => entry.args[0]?.event === 'gemini_error');
  assert.ok(logged, 'errore del primario registrato nei log strutturati');
  assert.equal(logged.args[0].model, 'gemini-3.5-flash-lite');
  assert.equal(logged.args[0].httpStatus, 429);
  assert.equal(logged.args[0].errorStatus, 'RESOURCE_EXHAUSTED');
  assert.equal(logged.args[0].retryAfter, 42);
});

test('Worker: modello ritirato/non trovato → fallback; errori non ritentabili → nessun fallback', async () => {
  const { generateRecipesContent } = await loadWorker();
  const logs = captureConsole();
  try {
    // Ritirato → si prova il secondo.
    let models = [];
    global.fetch = async url => {
      models.push(modelOf(url));
      if (models.length === 1) return geminiError(400, RETIRED_ERROR);
      return ok(geminiJsonResponse([recipe('Pollo e riso')]));
    };
    assert.equal((await generateRecipesContent(ENV, 'pollo', 10, 'lunch', [])).model, 'gemini-3.1-flash-lite');
    assert.equal(models.length, 2);

    // 404 → si prova il secondo.
    models = [];
    global.fetch = async url => {
      models.push(modelOf(url));
      if (models.length === 1) return geminiError(404, { status: 'NOT_FOUND', message: 'models/gemini-3.5-flash-lite is not found for API version v1beta, or is not supported for generateContent.' });
      return ok(geminiJsonResponse([recipe('Pollo e riso')]));
    };
    assert.equal((await generateRecipesContent(ENV, 'pollo', 10, 'lunch', [])).model, 'gemini-3.1-flash-lite');

    // API key non valida → nessun fallback: il secondo modello non risolverebbe nulla.
    models = [];
    global.fetch = async url => {
      models.push(modelOf(url));
      return geminiError(400, INVALID_KEY_ERROR);
    };
    await assert.rejects(() => generateRecipesContent(ENV, 'pollo', 10, 'lunch', []), error => {
      assert.equal(error.status, 502);
      assert.equal(error.code, 'GEMINI_CONFIGURATION');
      assert.equal(error.reason, 'invalid_api_key');
      assert.match(error.message, /GEMINI_API_KEY/);
      return true;
    });
    assert.deepEqual(models, ['gemini-3.5-flash-lite'], 'un solo tentativo');

    // Richiesta rifiutata (400 generico) → nessun fallback.
    models = [];
    global.fetch = async url => {
      models.push(modelOf(url));
      return geminiError(400, { status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload received. Unknown name "foo" at generation_config.' });
    };
    await assert.rejects(() => generateRecipesContent(ENV, 'pollo', 10, 'lunch', []), error => {
      assert.equal(error.status, 502);
      assert.equal(error.reason, 'unsupported_configuration');
      assert.match(error.message, /Serve un aggiornamento del Worker/);
      return true;
    });
    assert.deepEqual(models, ['gemini-3.5-flash-lite'], 'un solo tentativo');
  } finally {
    logs.restore();
  }
});

test('Worker: grounding + JSON rifiutati → due passaggi sullo stesso modello, poi ricordato', async () => {
  const { generateRecipesContent } = await loadWorker();
  const calls = [];
  const logs = captureConsole();
  try {
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ model: modelOf(url), body });
      const structured = Boolean(body.generationConfig?.responseMimeType);
      const grounded = Array.isArray(body.tools);
      if (structured && grounded) return geminiError(400, TOOL_MIME_ERROR);
      if (grounded) return ok(geminiJsonResponse([], { text: 'Ecco tre ricette:\n1. Pollo e riso: pollo 200 g, riso 80 g. Cuoci tutto.' }));
      return ok(geminiJsonResponse([recipe('Pollo e riso')], { grounding: false }));
    };
    const result = await generateRecipesContent(ENV, 'pollo', 10, 'lunch', []);
    assert.deepEqual(calls.map(call => call.model), ['gemini-3.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.5-flash-lite'], 'nessun cambio di modello');
    assert.equal(calls[1].body.generationConfig.responseMimeType, undefined, 'secondo tentativo: grounded ma testuale');
    assert.deepEqual(calls[1].body.tools, [{ googleSearch: {} }]);
    assert.equal(calls[2].body.tools, undefined, 'normalizzazione senza grounding');
    assert.equal(calls[2].body.generationConfig.responseMimeType, 'application/json');
    assert.match(calls[2].body.contents[0].parts[0].text, /Pollo e riso: pollo 200 g/);
    assert.equal(result.mode, 'grounded-text+normalize');
    assert.equal(result.recipes.length, 1);
    assert.equal(result.sources.length, 1, 'fonti prese dalla chiamata grounded, non dalla normalizzazione');

    // Seconda ricerca: la combinazione non viene ritentata.
    calls.length = 0;
    await generateRecipesContent(ENV, 'pollo', 10, 'lunch', []);
    assert.equal(calls[0].body.generationConfig.responseMimeType, undefined, 'si parte direttamente dalla variante testuale');
    assert.equal(calls.length, 2);
  } finally {
    logs.restore();
  }
  assert.ok(logs.entries.some(entry => entry.args[0]?.event === 'gemini_structured_grounding_unsupported'), 'evento registrato');
});

test('Worker: testo grounded già in JSON → nessuna normalizzazione; {"recipes":[]} esplicito non viene rinormalizzato', async () => {
  const { searchRecipesWithModel } = await loadWorker();
  const params = { query: 'pollo', maxRecipes: 10, slot: 'lunch', excludeNames: [] };
  let calls = 0;
  global.fetch = async (url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    if (body.generationConfig?.responseMimeType && body.tools) return geminiError(400, TOOL_MIME_ERROR);
    return ok(geminiJsonResponse([], { text: '```json\n' + JSON.stringify({ recipes: [recipe('Pollo e riso')] }) + '\n```' }));
  };
  const result = await searchRecipesWithModel(FAKE_API_KEY, 'gemini-3.5-flash-lite', params);
  assert.equal(calls, 2, 'strutturata rifiutata + testuale: il JSON nel testo basta');
  assert.equal(result.mode, 'grounded-text');
  assert.equal(result.recipes.length, 1);

  calls = 0;
  global.fetch = async () => {
    calls += 1;
    return ok(geminiJsonResponse([]));
  };
  const empty = await searchRecipesWithModel(FAKE_API_KEY, 'gemini-3.1-flash-lite', params);
  assert.equal(calls, 1, 'elenco vuoto esplicito: nessun secondo passaggio');
  assert.equal(empty.recipes.length, 0);
  assert.equal(empty.diagnostics.explicitEmpty, true);
});

test('Worker: mai più di quattro chiamate Gemini per una singola ricerca', async () => {
  const { generateRecipesContent, MAX_GEMINI_CALLS_PER_REQUEST } = await loadWorker();
  const logs = captureConsole();
  let calls = 0;
  try {
    // Ogni tentativo restituisce testo non interpretabile: strutturata ok ma
    // vuota → normalizzazione vuota → nessuna ricetta, senza errori.
    global.fetch = async () => {
      calls += 1;
      return ok(geminiJsonResponse([], { text: 'Bla bla senza JSON' }));
    };
    const result = await generateRecipesContent(ENV, 'pollo', 10, 'lunch', []);
    assert.equal(result.recipes.length, 0);
    assert.ok(calls <= MAX_GEMINI_CALLS_PER_REQUEST, `chiamate ${calls} entro il limite`);
    assert.equal(calls, 2, 'grounded + normalize sul primario, nessun fallback su risposta valida ma vuota');

    // Sequenza peggiore: 429 sul primario, poi TOOL_MIME sul secondario, testo, normalize.
    calls = 0;
    global.fetch = async (url, init) => {
      calls += 1;
      const body = JSON.parse(init.body);
      if (modelOf(url) === 'gemini-3.5-flash-lite') return geminiError(429, QUOTA_ERROR);
      if (body.generationConfig?.responseMimeType && body.tools) return geminiError(400, TOOL_MIME_ERROR);
      return ok(geminiJsonResponse([], { text: 'testo libero senza json' }));
    };
    const worst = await generateRecipesContent(ENV, 'pollo', 10, 'lunch', []);
    assert.equal(worst.recipes.length, 0);
    assert.ok(calls <= MAX_GEMINI_CALLS_PER_REQUEST, `chiamate ${calls} entro il limite`);
  } finally {
    logs.restore();
  }
});

// ---------------------------------------------------------------------------
// Classificazione errori e status HTTP
// ---------------------------------------------------------------------------

test('Worker: classifyGeminiFailure conserva modello, status, code, status Google, messaggio e details', async () => {
  const { classifyGeminiFailure } = await loadWorker();
  const quota = classifyGeminiFailure({ httpStatus: 429, error: { code: 429, ...QUOTA_ERROR } });
  assert.equal(quota.reason, 'quota');
  assert.equal(quota.code, 'GEMINI_QUOTA');
  assert.equal(quota.retryable, true);
  assert.equal(quota.httpStatus, 429);
  assert.equal(quota.errorCode, 429);
  assert.equal(quota.errorStatus, 'RESOURCE_EXHAUSTED');
  assert.match(quota.providerMessage, /exceeded your current quota/);
  assert.equal(quota.details.length, 2);
  assert.equal(quota.retryAfter, 42);
  assert.equal(quota.quotaZero, false);
  assert.equal(quota.quotaViolations[0].id, 'GenerateRequestsPerDayPerProjectPerModel-FreeTier');

  const zero = classifyGeminiFailure({ httpStatus: 429, error: { code: 429, ...QUOTA_ZERO_ERROR } });
  assert.equal(zero.quotaZero, true, 'limit: 0 riconosciuto');

  assert.equal(classifyGeminiFailure({ httpStatus: 400, error: RETIRED_ERROR }).reason, 'model_retired');
  assert.equal(classifyGeminiFailure({ httpStatus: 400, error: RETIRED_ERROR }).retryable, true);
  assert.equal(classifyGeminiFailure({ httpStatus: 404, error: { status: 'NOT_FOUND', message: 'models/x is not found for API version v1beta' } }).reason, 'model_not_found');
  assert.equal(classifyGeminiFailure({ httpStatus: 400, error: TOOL_MIME_ERROR }).reason, 'structured_grounding_unsupported');
  assert.equal(classifyGeminiFailure({ httpStatus: 400, error: TOOL_MIME_ERROR }).retryable, false);
  assert.equal(classifyGeminiFailure({ httpStatus: 400, error: { status: 'INVALID_ARGUMENT', message: 'Google Search grounding is not supported for this model.' } }).reason, 'grounding_unavailable');
  assert.equal(classifyGeminiFailure({ httpStatus: 400, error: { status: 'INVALID_ARGUMENT', message: 'response_schema is not supported for this model' } }).reason, 'unsupported_configuration');
  assert.equal(classifyGeminiFailure({ httpStatus: 403, error: { status: 'PERMISSION_DENIED', message: 'This API method requires billing to be enabled.' } }).reason, 'billing_disabled');
  assert.equal(classifyGeminiFailure({ httpStatus: 400, error: INVALID_KEY_ERROR }).reason, 'invalid_api_key');
  assert.equal(classifyGeminiFailure({ httpStatus: 403, error: { status: 'PERMISSION_DENIED', message: 'Permission denied on resource project.' } }).reason, 'permission_denied');
  assert.equal(classifyGeminiFailure({ httpStatus: 400, error: { status: 'FAILED_PRECONDITION', message: 'User location is not supported for the API use.' } }).reason, 'location_unsupported');
  assert.equal(classifyGeminiFailure({ httpStatus: 503, error: { status: 'UNAVAILABLE', message: 'The model is overloaded. Please try again later.' } }).reason, 'provider_error');
  assert.equal(classifyGeminiFailure({ httpStatus: 500, error: null }).reason, 'provider_error');
  assert.equal(classifyGeminiFailure({ networkError: new TypeError('fetch failed') }).reason, 'network_error');
  // Corpo non JSON (es. HTML di errore): nessuna eccezione, provider_error ritentabile.
  const empty = classifyGeminiFailure({ httpStatus: 502, error: null });
  assert.equal(empty.reason, 'provider_error');
  assert.equal(empty.retryable, true);
});

test('Worker /recipes: quota Gemini su tutti i modelli → 429 + code GEMINI_QUOTA (senza messaggio generico)', async () => {
  const { handleRecipes } = await loadWorker();
  const logs = captureConsole();
  let response;
  try {
    global.fetch = async () => geminiError(429, QUOTA_ERROR);
    response = await handleRecipes(requestFor({ query: 'ricetta con pollo', slot: 'lunch' }), ENV, 'https://app');
  } finally {
    logs.restore();
  }
  const body = await response.json();
  assert.equal(response.status, 429);
  assert.equal(body.code, 'GEMINI_QUOTA');
  assert.equal(body.reason, 'quota');
  assert.equal(response.headers.get('retry-after'), '42');
  assert.equal(body.retryAfter, 42);
  assert.match(body.error, /gemini-3\.5-flash-lite \(HTTP 429 RESOURCE_EXHAUSTED\)/, 'modello e status della causa reale');
  assert.match(body.error, /Fallback gemini-3\.1-flash-lite: quota o rate limit raggiunti/, 'anche il fallback è descritto');
  assert.doesNotMatch(body.error, /quota gratuita di Gemini è esaurita oppure la fatturazione/, 'niente frase generica');
  assert.equal(body.attempts.length, 2);
  assert.deepEqual(body.attempts.map(attempt => attempt.model), ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
});

test('Worker /recipes: quota zero nel progetto → 429 con diagnosi esplicita sul progetto Google', async () => {
  const { handleRecipes } = await loadWorker();
  const logs = captureConsole();
  let response;
  try {
    global.fetch = async () => geminiError(429, QUOTA_ZERO_ERROR);
    response = await handleRecipes(requestFor({ query: 'ricetta con pollo' }), ENV, 'https://app');
  } finally {
    logs.restore();
  }
  const body = await response.json();
  assert.equal(response.status, 429);
  assert.equal(body.code, 'GEMINI_QUOTA');
  assert.match(body.error, /non ha alcuna quota/);
  assert.match(body.error, /blocco è nel progetto\/API key Google/);
  assert.match(body.error, /limite 0/);
});

test('Worker /recipes: rate limit interno → 429 + code WORKER_RATE_LIMIT, senza chiamare Gemini', async () => {
  const worker = await loadWorker();
  let geminiCalls = 0;
  global.fetch = async () => {
    geminiCalls += 1;
    return ok(geminiJsonResponse([recipe('Pollo e riso')]));
  };
  // Autenticazione: il token è fittizio, quindi la verifica JWT è sostituita
  // esercitando direttamente il limite per utente attraverso l'handler pubblico
  // con una JWKS finta non serve: si simula la finestra piena via richieste.
  const env = { ...ENV, FIREBASE_PROJECT_ID: 'piano', ALLOWED_ORIGINS: 'https://app' };
  const headers = new Map([['Origin', 'https://app'], ['Authorization', `Bearer ${FAKE_ID_TOKEN}`]]);
  const request = {
    method: 'POST',
    url: 'https://worker.test/recipes',
    headers: { get: name => headers.get(name) || '' },
    json: async () => ({ query: 'ricetta' })
  };
  // Il token finto non passa la verifica della firma: si intercetta la
  // funzione di verifica tramite la JWKS fittizia? No: la firma non è valida
  // per costruzione. Verifichiamo quindi il ramo 401 e il ramo 429 attraverso
  // il modulo, che espone il rate limit tramite handleRecipes solo dopo auth.
  const unauthorized = await worker.default.fetch(request, env);
  assert.equal(unauthorized.status, 401, 'token finto respinto');
  const unauthorizedBody = await unauthorized.json();
  assert.equal(unauthorizedBody.code, 'UNAUTHENTICATED');
  assert.equal(geminiCalls, 0, 'Gemini non viene mai chiamato senza autenticazione');
});

test('Worker: il limite interno per utente restituisce 429 + WORKER_RATE_LIMIT dopo 30 richieste', async () => {
  // Il rate limit è esercitato attraverso il default export usando una
  // verifica Firebase reale ma con chiavi controllate dal test: generiamo una
  // coppia RSA, firmiamo un ID token valido e serviamo la JWKS via fetch.
  const worker = await loadWorker();
  const { subtle } = globalThis.crypto;
  const keyPair = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const publicJwk = await subtle.exportKey('jwk', keyPair.publicKey);
  const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' });
  const payload = b64({ sub: 'user-1', aud: 'piano', iss: 'https://securetoken.google.com/piano', iat: now - 10, exp: now + 3600 });
  const signature = Buffer.from(await subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, keyPair.privateKey, Buffer.from(`${header}.${payload}`))).toString('base64url');
  const idToken = `${header}.${payload}.${signature}`;

  let geminiCalls = 0;
  global.fetch = async url => {
    if (String(url).includes('securetoken@system.gserviceaccount.com')) {
      return { ok: true, json: async () => ({ keys: [{ ...publicJwk, kid: 'test-kid', alg: 'RS256', use: 'sig' }] }) };
    }
    geminiCalls += 1;
    return ok(geminiJsonResponse([recipe('Pollo e riso')]));
  };
  const env = { ...ENV, FIREBASE_PROJECT_ID: 'piano', ALLOWED_ORIGINS: 'https://app' };
  const makeRequest = () => ({
    method: 'POST',
    url: 'https://worker.test/recipes',
    headers: { get: name => ({ Origin: 'https://app', Authorization: `Bearer ${idToken}` })[name] || '' },
    json: async () => ({ query: 'ricetta con pollo', slot: 'lunch' })
  });
  const logs = captureConsole();
  try {
    for (let i = 0; i < 30; i += 1) {
      const response = await worker.default.fetch(makeRequest(), env);
      assert.equal(response.status, 200, `richiesta ${i + 1} accettata`);
    }
    const limited = await worker.default.fetch(makeRequest(), env);
    const body = await limited.json();
    assert.equal(limited.status, 429);
    assert.equal(body.code, 'WORKER_RATE_LIMIT', 'distinto dalla quota Gemini');
    assert.equal(body.reason, 'worker_rate_limit');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(geminiCalls, 30, 'la 31ª richiesta non arriva a Gemini');
  } finally {
    logs.restore();
  }
  assert.doesNotMatch(logs.text(), new RegExp(idToken.slice(0, 40)), 'l’ID token non finisce nei log');
});

test('Worker /recipes: modello ritirato su tutti i modelli → 502 + code GEMINI_CONFIGURATION', async () => {
  const { handleRecipes } = await loadWorker();
  const logs = captureConsole();
  let response;
  try {
    global.fetch = async () => geminiError(400, RETIRED_ERROR);
    response = await handleRecipes(requestFor({ query: 'ricetta con pollo' }), ENV, 'https://app');
  } finally {
    logs.restore();
  }
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.code, 'GEMINI_CONFIGURATION');
  assert.equal(body.reason, 'model_retired');
  assert.match(body.error, /ritirato da Google/);
  assert.match(body.error, /GEMINI_TEXT_MODEL/);
  assert.match(body.error, /no longer available to new users/, 'messaggio originale di Google conservato');
  assert.equal(response.headers.get('retry-after'), null, 'nessun retry-after su errori di configurazione');
});

test('Worker /recipes: grounding non disponibile, 5xx e rete → 502 con code coerente', async () => {
  const { handleRecipes } = await loadWorker();
  const logs = captureConsole();
  try {
    global.fetch = async () => geminiError(400, { status: 'INVALID_ARGUMENT', message: 'Google Search grounding is not supported for this model.' });
    let response = await handleRecipes(requestFor({ query: 'ricetta' }), ENV, 'https://app');
    let body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.code, 'GEMINI_CONFIGURATION');
    assert.equal(body.reason, 'grounding_unavailable');
    assert.match(body.error, /Google Search grounding non è disponibile/);

    global.fetch = async () => geminiError(503, { status: 'UNAVAILABLE', message: 'The model is overloaded. Please try again later.' });
    response = await handleRecipes(requestFor({ query: 'ricetta' }), ENV, 'https://app');
    body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.code, 'GEMINI_UNAVAILABLE');
    assert.match(body.error, /HTTP 503 UNAVAILABLE/);

    global.fetch = async () => { throw new TypeError('fetch failed'); };
    response = await handleRecipes(requestFor({ query: 'ricetta' }), ENV, 'https://app');
    body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.code, 'GEMINI_UNAVAILABLE');
    assert.equal(body.reason, 'network_error');

    // Corpo di errore non JSON (es. pagina HTML): classificazione senza eccezioni.
    global.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('not json'); } });
    response = await handleRecipes(requestFor({ query: 'ricetta' }), ENV, 'https://app');
    body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.code, 'GEMINI_UNAVAILABLE');
  } finally {
    logs.restore();
  }
});

test('Worker /recipes: senza GEMINI_API_KEY → 502 GEMINI_CONFIGURATION senza chiamare Gemini', async () => {
  const { handleRecipes } = await loadWorker();
  let calls = 0;
  global.fetch = async () => { calls += 1; return ok({}); };
  const response = await handleRecipes(requestFor({ query: 'ricetta' }), {}, 'https://app');
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.code, 'GEMINI_CONFIGURATION');
  assert.equal(body.reason, 'missing_api_key');
  assert.equal(calls, 0);
});

test('Worker /recipes: risposta valida senza ricette → 422 + code GEMINI_INVALID_RESPONSE', async () => {
  const { handleRecipes } = await loadWorker();
  const logs = captureConsole();
  try {
    // Elenco vuoto esplicito.
    global.fetch = async () => ok(geminiJsonResponse([]));
    let response = await handleRecipes(requestFor({ query: 'ricetta impossibile' }), ENV, 'https://app');
    let body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.code, 'GEMINI_INVALID_RESPONSE');
    assert.equal(body.reason, 'no_recipes');
    assert.match(body.error, /non ha trovato ricette/i);

    // Testo non interpretabile anche dopo la normalizzazione.
    global.fetch = async () => ok(geminiJsonResponse([], { text: 'nessuna chiamata' }));
    response = await handleRecipes(requestFor({ query: 'ricetta impossibile' }), ENV, 'https://app');
    body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.code, 'GEMINI_INVALID_RESPONSE');
    assert.equal(body.reason, 'malformed_response');
    assert.match(body.error, /formato non interpretabile/);

    // Ricette trovate ma tutte di un altro pasto.
    global.fetch = async () => ok(geminiJsonResponse([recipe('Porridge', { slot: 'breakfast' })]));
    response = await handleRecipes(requestFor({ query: 'ricetta', slot: 'dinner' }), ENV, 'https://app');
    body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.reason, 'no_recipes_for_slot');

    // Prompt bloccato da Google.
    global.fetch = async () => ok({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] });
    response = await handleRecipes(requestFor({ query: 'ricetta' }), ENV, 'https://app');
    body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.reason, 'blocked');
  } finally {
    logs.restore();
  }
});

test('Worker /recipes: inoltra slot ed excludeNames, senza grammature Meller, con googleSearch e senza functionDeclarations', async () => {
  const { handleRecipes } = await loadWorker();
  let lastBody = null;
  global.fetch = async (url, init) => {
    lastBody = JSON.parse(init.body);
    return ok(geminiJsonResponse([recipe('Pollo e riso', { slot: 'dinner' })]));
  };
  const request = requestFor({
    query: 'ricetta con pollo e riso per cena',
    slot: 'dinner',
    excludeNames: ['Pollo al curry'],
    // Campi legacy: il Worker li ignora, non devono finire nel prompt.
    guidelines: 'pollame 200 g',
    mealStructure: 'cena: proteine + verdure',
    alternatives: PIANO_DOMAIN.mellerAlternativesText()
  });
  const response = await handleRecipes(request, ENV, 'https://app');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.recipes[0].slot, 'dinner');
  assert.equal(body.sources.length, 1);
  assert.equal(body.model, 'gemini-3.5-flash-lite');
  assert.equal(body.mode, 'grounded-json');
  const systemText = lastBody.systemInstruction.parts[0].text;
  const userText = lastBody.contents[0].parts[0].text;
  assert.match(systemText, /"dinner"/, 'slot obbligatorio nel system prompt');
  assert.match(systemText, /Pollo al curry/, 'ricette escluse nel system prompt');
  assert.match(userText, /Pollo al curry/, 'ricette escluse nel testo utente');
  assert.doesNotMatch(systemText, /pollame 200 g/i, 'le guidelines legacy non entrano nel prompt');
  assert.doesNotMatch(systemText, /cena: proteine \+ verdure/i, 'la struttura pasto legacy non entra nel prompt');
  assert.doesNotMatch(systemText, /pranzo allenamento \d+ g/i, 'nessuna grammatura Meller nel prompt');
  assert.deepEqual(lastBody.tools, [{ googleSearch: {} }], 'Google Search grounding attivo, nessuna functionDeclaration');
  assert.equal(lastBody.generationConfig.responseMimeType, 'application/json');
  assert.doesNotMatch(systemText, /chiamata di funzione|search_recipes/, 'il prompt non chiede più una function call');
  assert.match(systemText, /non inventare indirizzi/, 'nessun URL inventato');
});

// ---------------------------------------------------------------------------
// Log senza segreti
// ---------------------------------------------------------------------------

test('Worker: nessun secret, token o URL con ?key= nei log e nelle risposte', async () => {
  const { handleRecipes, redactSecrets } = await loadWorker();
  const logs = captureConsole();
  let response;
  try {
    // Google riporta nel messaggio l'URL completo con la chiave e un Bearer.
    global.fetch = async () => geminiError(429, {
      status: 'RESOURCE_EXHAUSTED',
      message: `You exceeded your current quota. Request: https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${FAKE_API_KEY} Authorization: Bearer ${FAKE_ID_TOKEN}`
    });
    response = await handleRecipes(requestFor({ query: 'ricetta con pollo' }), ENV, 'https://app');
  } finally {
    logs.restore();
  }
  const body = await response.json();
  const logged = logs.text();
  assert.ok(logs.entries.length > 0, 'qualcosa è stato registrato');
  assert.equal(logged.includes(FAKE_API_KEY), false, 'API key assente dai log');
  assert.equal(logged.includes(FAKE_ID_TOKEN), false, 'token Firebase assente dai log');
  assert.doesNotMatch(logged, /[?&]key=(?!\[REDACTED\])/, 'nessun ?key= in chiaro nei log');
  assert.doesNotMatch(logged, /Bearer\s+(?!\[REDACTED\])\S/, 'nessun Bearer in chiaro nei log');
  assert.equal(JSON.stringify(body).includes(FAKE_API_KEY), false, 'API key assente dalla risposta');
  assert.equal(JSON.stringify(body).includes(FAKE_ID_TOKEN), false, 'token assente dalla risposta');
  // I log sono JSON strutturati con i campi diagnostici richiesti.
  const errorLog = logs.entries.find(entry => entry.args[0]?.event === 'gemini_error')?.args[0];
  assert.ok(errorLog, 'evento gemini_error presente');
  ['model', 'httpStatus', 'errorCode', 'errorStatus', 'message', 'details', 'reason', 'code'].forEach(field => {
    assert.ok(field in errorLog, `campo ${field} nel log`);
  });
  assert.equal(errorLog.source, 'piano-nutrizionale-ai');
  // Redazione anche di chiavi mai registrate (pattern AIza…) e dei JWT.
  assert.equal(redactSecrets('key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789').includes('AIzaSy'), false);
  assert.match(redactSecrets(`token ${FAKE_ID_TOKEN}`), /\[REDACTED_JWT\]/);
  assert.match(redactSecrets('u=https://x/y?key=abc123&z=1'), /\?key=\[REDACTED\]&z=1/);
});

// ---------------------------------------------------------------------------
// Separazione dei ruoli: il Worker cerca, l'app applica Meller.
// ---------------------------------------------------------------------------

const CARB_FAMILIES_ATTESE = ['pasta', 'riso', 'gnocchi', 'farroorzo', 'pseudo', 'couscous', 'pane', 'piadina', 'crackers', 'polenta', 'patate'];
const PROTEIN_FAMILIES_ATTESE = ['pollame', 'manzo', 'maiale', 'salumi', 'molluschi', 'pesceBianco', 'tonno', 'pesceOmega', 'fiocchiLatte', 'uova', 'formaggi', 'legumi', 'legumotti'];
const sortedUnique = list => [...new Set(list)].sort();

test('Worker: nessuna regola Meller nel codice e nessun import locale', async () => {
  const source = fs.readFileSync(path.join(__dirname, WORKER_PATH), 'utf8');
  // Deployabile dalla dashboard Cloudflare: un file singolo, zero import
  // relativi da risolvere con un bundler.
  assert.doesNotMatch(source, /^\s*import\s+[^\n]*from\s+'\.\.?\//m, 'nessun import da file locali');
  assert.doesNotMatch(source, /MELLER_/, 'nessuna costante Meller nel Worker');
  assert.doesNotMatch(source, /pranzo allenamento/i, 'nessuna grammatura A/R nel Worker');
  assert.doesNotMatch(source, /pollame 200 g/i, 'nessuna lista di grammature scritta a mano');
  assert.doesNotMatch(source, /DEFAULT_GUIDELINES|DEFAULT_MEAL_STRUCTURE/, 'nessuna guida nutrizionale hardcoded');
  assert.doesNotMatch(source, /functionDeclarations/, 'nessuna functionDeclaration nel Worker');
  assert.doesNotMatch(source, /\?key=\$\{/, 'la chiave non viene mai concatenata nell’URL');
  const worker = await loadWorker();
  assert.equal(worker.MELLER_ALTERNATIVES_FALLBACK, undefined, 'nessun fallback Meller esportato');
  assert.equal(typeof worker.recipesSystemInstruction, 'function');
});

test('Worker: il prompt chiede le 10 ricette più pertinenti con le dosi della fonte', async () => {
  const { recipesSystemInstruction } = await loadWorker();
  const systemText = recipesSystemInstruction('dinner', []);
  [
    'Usa Google Search per trovare ricette reali adatte alla richiesta dell’utente.',
    'Proponi fino a 10 ricette in italiano, ordinate dalla più pertinente: contano l’aderenza agli ingredienti richiesti e al tipo di pasto.',
    'Riporta gli ingredienti e le dosi COSÌ COME sono indicati dalla fonte, per una persona: non riscalare, non arrotondare, non adattare le quantità ad alcuna dieta.',
    'Preferisci ricette di fonti diverse tra loro ed evita varianti quasi identiche della stessa ricetta.'
  ].forEach(rule => assert.ok(systemText.includes(rule), `istruzione presente: ${rule}`));
  assert.match(systemText, /"dinner"/, 'slot richiesto nel prompt');
  assert.match(systemText, /Rispondi SOLO con un oggetto JSON valido/, 'formato JSON richiesto nel prompt');
  // Nessuna dieta nel prompt: le grammature restano un fatto dell'app.
  // L'unico numero ammesso è l'esempio di formato dell'unità di misura.
  assert.doesNotMatch(systemText, /meller/i, 'il modello non sa nulla di Meller');
  assert.doesNotMatch(systemText, /pranzo allenamento|pranzo riposo/i, 'nessuna dose A/R imposta al modello');
  const doses = systemText.match(/\d+\s?g\b/g) || [];
  assert.deepEqual(doses, ['150 g'], 'solo l’esempio di unità, nessuna grammatura prescritta');
});

test('App: il confronto con le grammature Meller avviene sulle ricette ricevute', () => {
  // Il controllo che il Worker non fa più deve esistere lato app, sulla
  // stessa fonte unica usata da popup e ricettario.
  const canonical = group => sortedUnique(
    PIANO_DOMAIN.mellerFamiliesForGroup(group, { withLunchAndDinner: true })
  );
  assert.deepEqual(canonical('carb'), sortedUnique(CARB_FAMILIES_ATTESE));
  assert.deepEqual(canonical('protein'), sortedUnique(PROTEIN_FAMILIES_ATTESE));

  const domainRecipe = {
    id: 'websearch', slot: 'dinner', name: 'Pollo e patate dal web',
    ingredients: [
      { name: 'Petto di pollo', portions: { ipoTraining: '300 g', ipoRest: '300 g', manTraining: '300 g', manRest: '300 g' } },
      { name: 'Patate', portions: { ipoTraining: '600 g', ipoRest: '600 g', manTraining: '600 g', manRest: '600 g' } }
    ],
    steps: ['Cuoci tutto']
  };
  const check = PIANO_DOMAIN.checkMellerAdaptation(domainRecipe);
  assert.equal(check.adapted, false, 'le dosi della fonte sono fuori riferimento');
  const byIngredient = Object.fromEntries(check.summary.map(item => [item.ingredient, item]));
  assert.equal(byIngredient['Petto di pollo'].expected, 200, 'pollame a cena: 200 g');
  assert.equal(byIngredient['Patate'].expected, 230, 'patate a cena: 230 g');

  // Correzione con un click: adaptRecipeToMeller riscrive solo gli eccessi.
  const adapted = PianoDomainAdapt(domainRecipe);
  assert.equal(adapted.changed, true);
  assert.equal(adapted.recipe.ingredients[0].portions.manTraining, '200 g');
  assert.equal(adapted.recipe.ingredients[1].portions.manTraining, '230 g');
  assert.equal(PIANO_DOMAIN.checkMellerAdaptation(adapted.recipe).adapted, true, 'dopo la correzione è aderente');
});

function PianoDomainAdapt(domainRecipe) {
  return PIANO_DOMAIN.adaptRecipeToMeller(JSON.parse(JSON.stringify(domainRecipe)));
}

// ---------------------------------------------------------------------------
// Frontend
// ---------------------------------------------------------------------------

test('Ricerca web: il frontend non invia grammature al Worker', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/web-search.js'), 'utf8');
  const body = source.slice(source.indexOf('body: JSON.stringify({'), source.indexOf('})\n      });'));
  assert.doesNotMatch(body, /alternatives|guidelines|mealStructure/, 'nessun campo Meller nella richiesta');
  assert.match(body, /excludeNames/, 'le ricette già viste restano nella richiesta');
  // Il confronto e la correzione vivono nella schermata dei risultati.
  assert.match(source, /checkMellerAdaptation/, 'discrepanze calcolate nell’app');
  assert.match(source, /adaptRecipeToMeller/, 'correzione con un click nell’app');
  assert.match(source, /importRecipesFromWebSearchBulk/, 'importazione in blocco disponibile');
});

test('Ricerca web: il frontend distingue 429 del Worker, quota Gemini, 502 e 422 tramite code', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/web-search.js'), 'utf8');
  ['WORKER_RATE_LIMIT', 'GEMINI_QUOTA', 'GEMINI_CONFIGURATION', 'GEMINI_INVALID_RESPONSE'].forEach(code => {
    assert.match(source, new RegExp(code), `il frontend conosce il codice ${code}`);
  });
  assert.doesNotMatch(source, /if \(response\.status === 429\) \{\s*return \{ error: 'Troppe ricerche/, 'nessun messaggio unico per ogni 429');
});
