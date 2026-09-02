/*
 * Cloudflare Worker: ricerca di NUOVE ricette dal web per la chat AI.
 *
 * - POST /recipes: cerca ricette con le caratteristiche richieste dall'utente
 *   usando l'API testuale di Gemini con Google Search grounding e restituisce
 *   fino a 10 ricette candidate (nome, pasto, ingredienti, preparazione,
 *   fonte) pronte per il popup di importazione della PWA.
 *
 * La GEMINI_API_KEY resta in un secret Cloudflare, mai nel frontend. Ogni
 * richiesta è autenticata con il Firebase ID token dell'utente.
 */

const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
// Endpoint REST per l'API testuale con grounding Google Search.
const GEMINI_GENERATE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent';
const DEFAULT_TEXT_MODEL = 'gemini-3.6-flash';
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
// 30 ricerche per finestra: più che sufficienti per un uso personale.
const MAX_REQUESTS_PER_WINDOW = 30;
const DEFAULT_MAX_RECIPES = 10;
const SLOTS = ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'];

let cachedJwks = null;
let cachedJwksExpiresAt = 0;
const requestWindows = new Map();

function json(body, status = 200, origin = '') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
      'cache-control': 'no-store'
    }
  });
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin || 'null',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '600',
    vary: 'Origin'
  };
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  return allowedOrigins(env).includes(origin);
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function base64UrlToJson(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

async function getJwks() {
  const now = Date.now();
  if (cachedJwks && cachedJwksExpiresAt > now) return cachedJwks;
  const response = await fetch(FIREBASE_JWKS_URL, {
    cf: { cacheTtl: 3600, cacheEverything: true }
  });
  if (!response.ok) throw new Error('Chiavi pubbliche Firebase non disponibili.');
  const body = await response.json();
  cachedJwks = body.keys || body;
  cachedJwksExpiresAt = now + 60 * 60 * 1000;
  return cachedJwks;
}

async function importJwk(jwk) {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

async function verifySignature(jwk, encodedHeader, encodedPayload, encodedSignature) {
  const key = await importJwk(jwk);
  const valid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    base64UrlToBytes(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  );
  if (!valid) throw new Error('Firma Firebase non valida.');
}

async function verifyFirebaseIdToken(rawToken, env) {
  const token = String(rawToken || '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Token Firebase non valido.');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = base64UrlToJson(encodedHeader);
  const payload = base64UrlToJson(encodedPayload);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Firma Firebase non valida.');

  const projectId = String(env.FIREBASE_PROJECT_ID || '').trim();
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID non configurato.');
  if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('Token Firebase destinato a un progetto diverso.');
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.sub !== 'string' || payload.sub.length > 128 || !Number.isFinite(payload.exp) || payload.exp <= now || !Number.isFinite(payload.iat) || payload.iat > now + 60) {
    throw new Error('Token Firebase scaduto o non ancora valido.');
  }

  let keys = await getJwks();
  let jwk = Array.isArray(keys) ? keys.find(item => item.kid === header.kid) : keys[header.kid];
  if (!jwk) {
    cachedJwks = null;
    cachedJwksExpiresAt = 0;
    keys = await getJwks();
    jwk = Array.isArray(keys) ? keys.find(item => item.kid === header.kid) : keys[header.kid];
    if (!jwk) throw new Error('Chiave Firebase non riconosciuta.');
  }
  await verifySignature(jwk, encodedHeader, encodedPayload, encodedSignature);
  return payload;
}

function checkRateLimit(userId) {
  const now = Date.now();
  for (const [key, window] of requestWindows) {
    if (window.resetAt <= now) requestWindows.delete(key);
  }
  const current = requestWindows.get(userId);
  if (!current || current.resetAt <= now) {
    requestWindows.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }
  if (current.count >= MAX_REQUESTS_PER_WINDOW) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
  current.count += 1;
  return { allowed: true, retryAfter: 0 };
}

function textModelName(env) {
  return String(env.GEMINI_TEXT_MODEL || DEFAULT_TEXT_MODEL).replace(/^models\//, '').trim();
}

const RECIPES_TOOL = {
  name: 'search_recipes',
  description: 'Restituisce le ricette trovate sul web per la richiesta dell’utente, ordinate per pertinenza.',
  parameters: {
    type: 'OBJECT',
    properties: {
      recipes: {
        type: 'ARRAY',
        description: 'Elenco delle ricette trovate (fino a 10).',
        items: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING', description: 'Nome della ricetta in italiano' },
            slot: { type: 'STRING', enum: SLOTS, description: 'Pasto di appartenenza (breakfast, snack1, lunch, snack2, dinner)' },
            emoji: { type: 'STRING', description: 'Emoji rappresentativa (opzionale)' },
            ingredients: {
              type: 'ARRAY',
              description: 'Ingredienti con dose per una persona',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING', description: 'Nome ingrediente' },
                  quantity: { type: 'STRING', description: 'Dose con unità, es. "150 g" oppure "q.b."' }
                },
                required: ['name', 'quantity']
              }
            },
            steps: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Preparazione: un passaggio per elemento' },
            notes: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Note opzionali' },
            sourceUrl: { type: 'STRING', description: 'URL della fonte usata da Google Search' },
            sourceTitle: { type: 'STRING', description: 'Titolo della fonte' }
          },
          required: ['name', 'ingredients', 'steps']
        }
      }
    },
    required: ['recipes']
  }
};

function recipesSystemInstruction() {
  return [
    'Sei Piano, l’aiuto-cuoco della webapp Piano Nutrizionale.',
    'Rispondi SOLO con la chiamata di funzione search_recipes: nessun altro testo.',
    'Usa Google Search per trovare ricette reali adatte alla richiesta dell’utente.',
    'Proponi fino a 10 ricette diverse e pertinenti, in italiano, ordinate dalla più pertinente.',
    'Ogni ricetta è per una persona e va costruita con ingredienti e dosi plausibili per una porzione (es. "150 g", "2 cucchiai", "q.b."), coerenti con i massimi del dott. Meller: pollame 200 g, manzo 150 g, maiale 100 g, pesce 250 g, legumi 240 g, uova 180 g, pasta/riso 90 g, gnocchi 250 g, patate 450 g, pane 120 g, olio EVO 10 g, miele 20 g, marmellata 30 g, yogurt 200 g, latte 250 g, formaggi 60 g, crackers 40 g, frutta fresca 250 g, frutta secca 20 g.',
    'Indica sempre il pasto di appartenenza (slot: breakfast/snack1/lunch/snack2/dinner), ingredienti con dose, e una preparazione essenziale a passaggi.',
    'Compila sourceUrl e sourceTitle con la fonte reale restituita da Google Search.',
    'Se non trovi ricette adatte, restituisci comunque la chiamata con un elenco vuoto.'
  ].join('\n');
}

function extractRecipesFunctionCall(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part?.functionCall?.name === 'search_recipes') return part.functionCall;
  }
  return null;
}

function normalizeRecipe(item) {
  const name = String(item?.name || '').trim();
  const ingredients = (Array.isArray(item?.ingredients) ? item.ingredients : [])
    .map(ing => ({
      name: String(ing?.name || '').trim(),
      quantity: String(ing?.quantity || '').trim()
    }))
    .filter(ing => ing.name);
  const steps = (Array.isArray(item?.steps) ? item.steps : []).map(step => String(step || '').trim()).filter(Boolean);
  const notes = (Array.isArray(item?.notes) ? item.notes : []).map(note => String(note || '').trim()).filter(Boolean);
  const slot = SLOTS.includes(String(item?.slot || '')) ? String(item.slot) : 'lunch';
  let sourceUrl = '';
  try {
    const parsed = new URL(String(item?.sourceUrl || ''));
    if (['http:', 'https:'].includes(parsed.protocol)) sourceUrl = parsed.href;
  } catch (_) {}
  return {
    name: name || 'Ricetta',
    slot,
    emoji: String(item?.emoji || '').trim(),
    ingredients,
    steps,
    notes,
    sourceUrl,
    sourceTitle: String(item?.sourceTitle || '').trim()
  };
}

function parseRecipesFromResponse(data, maxRecipes) {
  const call = extractRecipesFunctionCall(data);
  const rawRecipes = Array.isArray(call?.args?.recipes) ? call.args.recipes : [];
  return rawRecipes
    .map(normalizeRecipe)
    .filter(recipe => recipe.name && recipe.ingredients.length)
    .slice(0, Math.max(1, Math.min(Number(maxRecipes) || DEFAULT_MAX_RECIPES, 10)));
}

function extractSources(data) {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = chunks.map(chunk => ({
    title: chunk?.web?.title || '',
    url: chunk?.web?.uri || chunk?.web?.url || ''
  })).filter(source => {
    try {
      const parsed = new URL(source.url);
      return ['http:', 'https:'].includes(parsed.protocol);
    } catch (_) {
      return false;
    }
  });
  return [...new Map(sources.map(source => [source.url, source])).values()].slice(0, 10);
}

async function generateRecipesContent(env, query, maxRecipes) {
  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY non configurata nel Worker.');
  const model = textModelName(env);
  const url = `${GEMINI_GENERATE_URL.replace('{model}', encodeURIComponent(model))}?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `L’utente chiede: ${query}. Proponi fino a ${maxRecipes} ricette.` }] }],
      systemInstruction: { parts: [{ text: recipesSystemInstruction() }] },
      tools: [
        { googleSearch: {} },
        { functionDeclarations: [RECIPES_TOOL] }
      ],
      generationConfig: { temperature: 0.5, maxOutputTokens: 4000 }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `Gemini ha risposto ${response.status}.`);
  }
  return data;
}

async function handleRecipes(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch (_) {}
  const query = String(body?.query || '').trim();
  if (!query) return json({ error: 'Manca il testo della richiesta di ricetta.' }, 400, origin);
  const maxRecipes = Math.max(1, Math.min(Number(body?.maxRecipes) || DEFAULT_MAX_RECIPES, 10));

  let data;
  try {
    data = await generateRecipesContent(env, query, maxRecipes);
  } catch (error) {
    console.error(error);
    return json({ error: error.message || 'Gemini non ha risposto alla ricerca delle ricette.' }, 502, origin);
  }

  const recipes = parseRecipesFromResponse(data, maxRecipes);
  const sources = extractSources(data);
  if (!recipes.length) {
    return json({ error: 'Non sono riuscito a trovare ricette valide. Riprova con una richiesta diversa.' }, 422, origin);
  }
  return json({ recipes, sources }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') {
      if (!isAllowedOrigin(origin, env)) return new Response('Origine non autorizzata.', { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (!isAllowedOrigin(origin, env)) return json({ error: 'Origine non autorizzata.' }, 403, '');
    const pathname = new URL(request.url).pathname;
    if (pathname !== '/recipes') return json({ error: 'Endpoint non trovato.' }, 404, origin);
    if (request.method !== 'POST') return json({ error: 'Metodo non consentito.' }, 405, origin);

    const authorization = request.headers.get('Authorization') || '';
    if (!authorization.startsWith('Bearer ')) return json({ error: 'Autenticazione richiesta.' }, 401, origin);

    let claims;
    try {
      claims = await verifyFirebaseIdToken(authorization.slice(7), env);
    } catch (error) {
      console.error(error);
      return json({ error: error.message || 'Autenticazione non riuscita.' }, 401, origin);
    }

    const rate = checkRateLimit(claims.sub);
    if (!rate.allowed) {
      return new Response(JSON.stringify({ error: 'Hai raggiunto il limite temporaneo di richieste. Riprova più tardi.' }), {
        status: 429,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'retry-after': String(rate.retryAfter),
          ...corsHeaders(origin),
          'cache-control': 'no-store'
        }
      });
    }

    return handleRecipes(request, env, origin);
  }
};

// Export per i test unitari (node --test): il default export resta l'handler.
export {
  textModelName,
  normalizeRecipe,
  parseRecipesFromResponse,
  extractSources,
  generateRecipesContent,
  handleRecipes
};
