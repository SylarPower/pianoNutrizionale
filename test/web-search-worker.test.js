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
  assert.equal(textModelName({}), 'gemini-3.5-flash', 'default gemini-3.5-flash');
  assert.equal(textModelName({ GEMINI_TEXT_MODEL: 'models/gemini-2.0-flash' }), 'gemini-2.0-flash');
});

test('Worker: lista modelli con fallback in ordine e senza duplicati', async () => {
  const { textModelList } = await loadWorker();
  const list = textModelList({});
  assert.equal(list[0], 'gemini-3.5-flash');
  assert.deepEqual(list.slice(1), ['gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite']);
  const custom = textModelList({ GEMINI_TEXT_MODEL: 'gemini-3.6-flash' });
  assert.equal(custom[0], 'gemini-3.6-flash');
  assert.equal(custom.filter(model => model === 'gemini-3.6-flash').length, 1, 'nessun duplicato');
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
  const data = await generateRecipesContent({ GEMINI_API_KEY: 'k' }, 'pollo', 10, 'lunch', []);
  assert.equal(used.length, 2, 'secondo tentativo eseguito');
  assert.match(used[0], /gemini-3\.5-flash/);
  assert.match(used[1], /gemini-3\.6-flash/);
  assert.ok(data.candidates, 'risposta del modello di fallback');
});

test('Worker: se tutti i modelli falliscono restituisce il messaggio italiano sulla quota', async () => {
  const { generateRecipesContent } = await loadWorker();
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota exceeded' } }) });
  await assert.rejects(
    () => generateRecipesContent({ GEMINI_API_KEY: 'k' }, 'pollo', 10, 'lunch', []),
    error => {
      assert.match(error.message, /quota gratuita di Gemini/i);
      assert.match(error.message, /ai\.dev\/rate-limit/);
      return true;
    }
  );
});

test('Worker /recipes: inoltra slot ed excludeNames, senza grammature Meller', async () => {
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
      // Campi legacy: il Worker li ignora, non devono finire nel prompt.
      guidelines: 'pollame 200 g',
      mealStructure: 'cena: proteine + verdure',
      alternatives: PIANO_DOMAIN.mellerAlternativesText()
    })
  };
  const response = await handleRecipes(request, { GEMINI_API_KEY: 'k' }, 'https://app');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.recipes[0].slot, 'dinner');
  assert.equal(body.sources.length, 1);
  const systemText = lastBody.systemInstruction.parts[0].text;
  const userText = lastBody.contents[0].parts[0].text;
  assert.match(systemText, /"dinner"/, 'slot obbligatorio nel system prompt');
  assert.match(systemText, /Pollo al curry/, 'ricette escluse nel system prompt');
  assert.match(userText, /Pollo al curry/, 'ricette escluse nel testo utente');
  assert.doesNotMatch(systemText, /pollame 200 g/i, 'le guidelines legacy non entrano nel prompt');
  assert.doesNotMatch(systemText, /cena: proteine \+ verdure/i, 'la struttura pasto legacy non entra nel prompt');
  assert.doesNotMatch(systemText, /pranzo allenamento \d+ g/i, 'nessuna grammatura Meller nel prompt');
  assert.ok(lastBody.tools[0].googleSearch, 'Google Search grounding attivo');
  assert.equal(lastBody.tools[1].functionDeclarations[0].name, 'search_recipes');
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
// Separazione dei ruoli: il Worker cerca, l'app applica Meller.
// ---------------------------------------------------------------------

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

  const recipe = {
    id: 'websearch', slot: 'dinner', name: 'Pollo e patate dal web',
    ingredients: [
      { name: 'Petto di pollo', portions: { ipoTraining: '300 g', ipoRest: '300 g', manTraining: '300 g', manRest: '300 g' } },
      { name: 'Patate', portions: { ipoTraining: '600 g', ipoRest: '600 g', manTraining: '600 g', manRest: '600 g' } }
    ],
    steps: ['Cuoci tutto']
  };
  const check = PIANO_DOMAIN.checkMellerAdaptation(recipe);
  assert.equal(check.adapted, false, 'le dosi della fonte sono fuori riferimento');
  const byIngredient = Object.fromEntries(check.summary.map(item => [item.ingredient, item]));
  assert.equal(byIngredient['Petto di pollo'].expected, 200, 'pollame a cena: 200 g');
  assert.equal(byIngredient['Patate'].expected, 230, 'patate a cena: 230 g');

  // Correzione con un click: adaptRecipeToMeller riscrive solo gli eccessi.
  const adapted = PianoDomainAdapt(recipe);
  assert.equal(adapted.changed, true);
  assert.equal(adapted.recipe.ingredients[0].portions.manTraining, '200 g');
  assert.equal(adapted.recipe.ingredients[1].portions.manTraining, '230 g');
  assert.equal(PIANO_DOMAIN.checkMellerAdaptation(adapted.recipe).adapted, true, 'dopo la correzione è aderente');
});

function PianoDomainAdapt(recipe) {
  return PIANO_DOMAIN.adaptRecipeToMeller(JSON.parse(JSON.stringify(recipe)));
}

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
