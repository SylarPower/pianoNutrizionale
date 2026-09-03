'use strict';
/* Test unitari del Worker Cloudflare per la ricerca ricette dal web.
 * Importa direttamente il modulo ES: nessuna rete reale, fetch viene stubbato. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = '../cloudflare/ai-worker/src/index.js';
// Fonte unica delle regole Meller, condivisa con il Worker.
const PIANO_DOMAIN = require('../js/domain.js');

async function loadWorker() {
  return import(WORKER_PATH);
}

function geminiOk(recipes) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: { parts: [{ functionCall: { name: 'search_recipes', args: { recipes } } }] },
        groundingMetadata: { groundingChunks: [{ web: { title: 'Fonte', uri: 'https://example.com/r' } }] }
      }]
    })
  };
}

test('Worker: modello testuale di default e prefisso models/ rimosso', async () => {
  const { textModelName } = await loadWorker();
  assert.equal(textModelName({}), 'gemini-3.6-flash', 'default gemini-3.6-flash');
  assert.equal(textModelName({ GEMINI_TEXT_MODEL: 'models/gemini-2.0-flash' }), 'gemini-2.0-flash');
});

test('Worker: lista modelli con fallback in ordine e senza duplicati', async () => {
  const { textModelList } = await loadWorker();
  const list = textModelList({});
  assert.equal(list[0], 'gemini-3.6-flash');
  assert.deepEqual(list.slice(1), ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite']);
  const custom = textModelList({ GEMINI_TEXT_MODEL: 'gemini-3.5-flash' });
  assert.equal(custom[0], 'gemini-3.5-flash');
  assert.equal(custom.filter(model => model === 'gemini-3.5-flash').length, 1, 'nessun duplicato');
});

test('Worker: riconosce gli errori di modello ritentabili', async () => {
  const { isRetryableModelError } = await loadWorker();
  assert.equal(isRetryableModelError('boom', 429), true);
  assert.equal(isRetryableModelError('boom', 404), true);
  assert.equal(isRetryableModelError('You exceeded your current quota', 400), true);
  assert.equal(isRetryableModelError('model is no longer available', 400), true);
  assert.equal(isRetryableModelError('billing not enabled', 403), true);
  assert.equal(isRetryableModelError('Invalid argument', 400), false);
});

test('Worker: quota esaurita sul primo modello → fallback sul secondo', async () => {
  const { generateRecipesContent } = await loadWorker();
  const used = [];
  global.fetch = async url => {
    used.push(String(url));
    if (used.length === 1) {
      return { ok: false, status: 429, json: async () => ({ error: { message: 'quota exceeded' } }) };
    }
    return geminiOk([{ name: 'Pollo e riso', ingredients: [{ name: 'Pollo', quantity: '200 g' }], steps: ['Step'] }]);
  };
  const data = await generateRecipesContent({ GEMINI_API_KEY: 'k' }, 'pollo', 10, 'lunch', [], '', '');
  assert.equal(used.length, 2, 'secondo tentativo eseguito');
  assert.match(used[0], /gemini-3\.6-flash/);
  assert.match(used[1], /gemini-3\.5-flash/);
  assert.ok(data.candidates, 'risposta del modello di fallback');
});

test('Worker: se tutti i modelli falliscono restituisce il messaggio italiano sulla quota', async () => {
  const { generateRecipesContent } = await loadWorker();
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota exceeded' } }) });
  await assert.rejects(
    () => generateRecipesContent({ GEMINI_API_KEY: 'k' }, 'pollo', 10, 'lunch', [], '', ''),
    error => {
      assert.match(error.message, /quota gratuita di Gemini/i);
      assert.match(error.message, /ai\.dev\/rate-limit/);
      return true;
    }
  );
});

test('Worker /recipes: inoltra slot, excludeNames, guidelines e mealStructure', async () => {
  const { handleRecipes } = await loadWorker();
  let lastBody = null;
  global.fetch = async (url, init) => {
    lastBody = JSON.parse(init.body);
    return geminiOk([{ name: 'Pollo e riso', slot: 'dinner', ingredients: [{ name: 'Pollo', quantity: '200 g' }], steps: ['Step'] }]);
  };
  const request = {
    json: async () => ({
      query: 'ricetta con pollo e riso per cena',
      slot: 'dinner',
      excludeNames: ['Pollo al curry'],
      guidelines: 'pollame 200 g',
      mealStructure: 'cena: proteine + verdure'
    })
  };
  const response = await handleRecipes(request, { GEMINI_API_KEY: 'k' }, 'https://app');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.recipes[0].slot, 'dinner');
  assert.equal(body.sources.length, 1);
  const systemText = lastBody.systemInstruction.parts[0].text;
  const userText = lastBody.contents[0].parts[0].text;
  assert.match(systemText, /pollame 200 g/, 'guidelines inoltrate');
  assert.match(systemText, /cena: proteine \+ verdure/, 'struttura pasto inoltrata');
  assert.match(systemText, /"dinner"/, 'slot obbligatorio nel system prompt');
  assert.match(systemText, /Pollo al curry/, 'ricette escluse nel system prompt');
  assert.match(userText, /Pollo al curry/, 'ricette escluse nel testo utente');
  assert.ok(lastBody.tools[0].googleSearch, 'Google Search grounding attivo');
  assert.equal(lastBody.tools[1].functionDeclarations[0].name, 'search_recipes');
});

test('Worker /recipes: senza guidelines usa i massimi Meller di fallback', async () => {
  const { handleRecipes } = await loadWorker();
  let lastBody = null;
  global.fetch = async (url, init) => {
    lastBody = JSON.parse(init.body);
    return geminiOk([{ name: 'Pollo e riso', ingredients: [{ name: 'Pollo', quantity: '200 g' }], steps: ['Step'] }]);
  };
  const response = await handleRecipes({ json: async () => ({ query: 'pollo' }) }, { GEMINI_API_KEY: 'k' }, 'https://app');
  assert.equal(response.status, 200);
  const systemText = lastBody.systemInstruction.parts[0].text;
  assert.match(systemText, /pollame 200 g/);
  assert.match(systemText, /frutta secca 20 g/);
});

test('Worker: parseRecipesFromResponse forza lo slot richiesto e limita a 10', async () => {
  const { parseRecipesFromResponse } = await loadWorker();
  const recipes = Array.from({ length: 14 }, (_, i) => ({
    name: `Ricetta ${i}`,
    ingredients: [{ name: 'Pollo', quantity: '200 g' }],
    steps: ['Step']
  }));
  recipes.push({ name: 'Colazione fuori posto', slot: 'breakfast', ingredients: [{ name: 'Pane', quantity: '80 g' }], steps: ['Step'] });
  const data = { candidates: [{ content: { parts: [{ functionCall: { name: 'search_recipes', args: { recipes } } }] } }] };
  const parsed = parseRecipesFromResponse(data, 10, 'dinner');
  assert.equal(parsed.length, 10, 'massimo 10 ricette');
  assert.ok(parsed.every(recipe => recipe.slot === 'dinner'), 'slot forzato a dinner');
  assert.equal(parsed.some(recipe => recipe.name === 'Colazione fuori posto'), false, 'slot diverso scartato');
  assert.equal(parseRecipesFromResponse({ candidates: [{ content: { parts: [] } }] }, 10, 'lunch').length, 0);
});

test('Worker: normalizeRecipe usa il defaultSlot quando lo slot manca o è invalido', async () => {
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
  }, 'breakfast');
  assert.equal(recipe.name, 'Pollo al curry');
  assert.equal(recipe.slot, 'dinner', 'slot valido dell’item ha la precedenza');
  assert.equal(recipe.ingredients.length, 2, 'ingredienti vuoti scartati');
  assert.equal(recipe.steps.length, 2, 'passaggi vuoti scartati');
  assert.equal(recipe.sourceUrl, 'https://example.com/ricetta');
  assert.equal(normalizeRecipe({ name: 'x', slot: 'non-valido' }, 'snack1').slot, 'snack1', 'slot invalido → defaultSlot');
  assert.equal(normalizeRecipe({ name: 'x' }).slot, 'lunch', 'senza defaultSlot → lunch');
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
  assert.equal(extractSources(data).length, 2, 'deduplicati e url non validi scartati');
});

test('Worker /recipes: senza chiamata Gemini risponde 422 con messaggio italiano', async () => {
  const { handleRecipes } = await loadWorker();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'nessuna chiamata' }] } }] })
  });
  const response = await handleRecipes({ json: async () => ({ query: 'ricetta impossibile' }) }, { GEMINI_API_KEY: 'k' }, 'https://app');
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.match(body.error, /non sono riuscito|ricette valide/i);
});

// ---------------------------------------------------------------------
// Fonte unica Meller condivisa tra frontend e Worker.
// ---------------------------------------------------------------------

const CARB_FAMILIES_ATTESE = ['pasta', 'riso', 'gnocchi', 'farroorzo', 'pseudo', 'couscous', 'pane', 'piadina', 'crackers', 'polenta', 'patate'];
const PROTEIN_FAMILIES_ATTESE = ['pollame', 'manzo', 'maiale', 'salumi', 'molluschi', 'pesceBianco', 'tonno', 'pesceOmega', 'fiocchiLatte', 'uova', 'formaggi', 'legumi', 'legumotti'];
const sortedUnique = list => [...new Set(list)].sort();

test('Worker: importa la fonte unica e non ha liste Meller hardcoded', async () => {
  const source = fs.readFileSync(path.join(__dirname, WORKER_PATH), 'utf8');
  assert.match(source, /import PianoDomain from '\.\.\/\.\.\/\.\.\/js\/domain\.js';/, 'il Worker importa js/domain.js');
  assert.doesNotMatch(source, /DEFAULT_GUIDELINES/, 'nessuna costante parziale DEFAULT_GUIDELINES');
  assert.doesNotMatch(source, /DEFAULT_MEAL_STRUCTURE/, 'nessuna struttura pasti hardcoded');
  assert.doesNotMatch(source, /pollame 200 g, manzo 150 g/, 'nessuna lista di grammature scritta a mano');
  const { MELLER_ALTERNATIVES_FALLBACK } = await loadWorker();
  assert.equal(MELLER_ALTERNATIVES_FALLBACK, PIANO_DOMAIN.mellerAlternativesText(), 'fallback generato dalla fonte condivisa');
  assert.equal(MELLER_ALTERNATIVES_FALLBACK, PIANO_DOMAIN.mellerAlternativesText(), 'stesse famiglie e stessi valori del frontend');
});

test('Worker /recipes: inoltra al modello il testo completo delle alternative', async () => {
  const { handleRecipes } = await loadWorker();
  let lastBody = null;
  global.fetch = async (url, init) => {
    lastBody = JSON.parse(init.body);
    return geminiOk([{ name: 'Pollo e riso', ingredients: [{ name: 'Pollo', quantity: '200 g' }], steps: ['Step'] }]);
  };
  const alternatives = PIANO_DOMAIN.mellerAlternativesText();
  const response = await handleRecipes({
    json: async () => ({ query: 'ricetta con pollo e riso', slot: 'dinner', alternatives })
  }, { GEMINI_API_KEY: 'k' }, 'https://app');
  assert.equal(response.status, 200);
  const systemText = lastBody.systemInstruction.parts[0].text;
  assert.ok(systemText.includes(alternatives), 'il testo completo inviato dal frontend finisce nel prompt');
});

test('Worker /recipes: senza alternatives usa il fallback completo della fonte unica', async () => {
  const { handleRecipes } = await loadWorker();
  let lastBody = null;
  global.fetch = async (url, init) => {
    lastBody = JSON.parse(init.body);
    return geminiOk([{ name: 'Pollo e riso', ingredients: [{ name: 'Pollo', quantity: '200 g' }], steps: ['Step'] }]);
  };
  const response = await handleRecipes({ json: async () => ({ query: 'pollo' }) }, { GEMINI_API_KEY: 'k' }, 'https://app');
  assert.equal(response.status, 200);
  const systemText = lastBody.systemInstruction.parts[0].text;
  // Tutte le famiglie carboidrati e proteine, con le grammature canoniche.
  const inFallback = PIANO_DOMAIN.mellerFamiliesInText(systemText);
  assert.deepEqual(sortedUnique(inFallback.carbohydrates), sortedUnique(CARB_FAMILIES_ATTESE), 'tutti i carboidrati nel prompt');
  assert.deepEqual(sortedUnique(inFallback.proteins), sortedUnique(PROTEIN_FAMILIES_ATTESE), 'tutte le proteine nel prompt');
  ['pasta/riso', 'gnocchi', 'farro/orzo', 'quinoa/grano saraceno/amaranto', 'cous cous', 'pane', 'piadina',
    'crackers', 'polenta', 'patate', 'pollame', 'manzo', 'maiale', 'affettati/salumi', 'crostacei/molluschi',
    'pesce bianco', 'tonno', 'omega-3', 'fiocchi di latte', 'uova', 'formaggi', 'legumi', 'legumotti']
    .forEach(token => assert.ok(systemText.toLowerCase().includes(token), `prompt contiene "${token}"`));
  assert.match(systemText, /Patate: pranzo allenamento 450 g, pranzo riposo 350 g, cena 230 g\./);
  assert.match(systemText, /Gnocchi di patate: pranzo allenamento 250 g, pranzo riposo 190 g, cena 120 g\./);
  assert.match(systemText, /Legumotti Barilla: 80 g\./);
});

test('Worker: il prompt di sistema dà le istruzioni Meller obbligatorie', async () => {
  const { recipesSystemInstruction, MELLER_PROMPT_RULES } = await loadWorker();
  const systemText = recipesSystemInstruction('', '', 'dinner', [], '');
  [
    'Usa esclusivamente le grammature Meller fornite.',
    'A cena sono ammessi tutti i carboidrati presenti nella tabella, non solo pane, crackers e patate.',
    'Per i carboidrati usa la dose cena indicata nella tabella.',
    'Non trasformare le proteine secondo la regola dei carboidrati.',
    'Mantieni le dosi proteiche indicate dal manuale.'
  ].forEach(rule => assert.ok(systemText.includes(rule), `istruzione presente: ${rule}`));
  assert.deepEqual(MELLER_PROMPT_RULES.length, 5);
  assert.match(systemText, /"dinner"/, 'slot richiesto nel prompt');
});

test('Meller allineamento fonte unica: popup, grammature, testo AI e fallback Worker', async () => {
  const { MELLER_ALTERNATIVES_FALLBACK } = await loadWorker();
  const canonical = group => sortedUnique(
    PIANO_DOMAIN.mellerFamiliesForGroup(group, { withLunchAndDinner: true })
  );
  const canonicalCarbs = canonical('carb');
  const canonicalProteins = canonical('protein');
  assert.deepEqual(canonicalCarbs, sortedUnique(CARB_FAMILIES_ATTESE));
  assert.deepEqual(canonicalProteins, sortedUnique(PROTEIN_FAMILIES_ATTESE));

  // 1. famiglie delle alternative mostrate nei popup (righe + riferimento);
  const popupCarbs = sortedUnique(PIANO_DOMAIN.MELLER_CARB_ALTERNATIVES
    .flatMap(entry => [entry.family, ...(entry.also || [])])
    .concat(PIANO_DOMAIN.MELLER_GUIDE.alternatives.carbohydrates.reference.families));
  const popupProteins = sortedUnique(PIANO_DOMAIN.MELLER_PROTEIN_ALTERNATIVES
    .map(entry => entry.family)
    .concat(PIANO_DOMAIN.MELLER_GUIDE.alternatives.proteins.reference.families));
  // 2. famiglie nelle grammature canoniche;
  // 3. famiglie nel testo passato al backend;
  const aiText = PIANO_DOMAIN.mellerFamiliesInText(PIANO_DOMAIN.mellerAlternativesText());
  // 4. famiglie nel fallback del Worker.
  const workerFallback = PIANO_DOMAIN.mellerFamiliesInText(MELLER_ALTERNATIVES_FALLBACK);

  [
    ['popup carboidrati', popupCarbs],
    ['testo AI carboidrati', sortedUnique(aiText.carbohydrates)],
    ['fallback Worker carboidrati', sortedUnique(workerFallback.carbohydrates)]
  ].forEach(([surface, families]) => assert.deepEqual(families, canonicalCarbs, surface));
  [
    ['popup proteine', popupProteins],
    ['testo AI proteine', sortedUnique(aiText.proteins)],
    ['fallback Worker proteine', sortedUnique(workerFallback.proteins)]
  ].forEach(([surface, families]) => assert.deepEqual(families, canonicalProteins, surface));

  // Le grammature del fallback Worker sono quelle della fonte canonica.
  PIANO_DOMAIN.MELLER_ALTERNATIVES.carbohydrates.forEach(item => {
    const line = `^${item.label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: pranzo allenamento ${item.lunchTraining} g, pranzo riposo ${item.lunchRest} g, cena ${item.dinner} g\\.$`;
    assert.match(MELLER_ALTERNATIVES_FALLBACK, new RegExp(line, 'm'), `${item.label} nel fallback Worker`);
  });
  PIANO_DOMAIN.MELLER_ALTERNATIVES.proteins.forEach(item => {
    const line = `^${item.label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: ${item.lunchTraining} g\\.$`;
    assert.match(MELLER_ALTERNATIVES_FALLBACK, new RegExp(line, 'm'), `${item.label} nel fallback Worker`);
  });
});
