/*
 * Cloudflare Worker: broker gratuito per Gemini.
 *
 * - POST /token: emette token temporanei per Gemini Live (conversazione vocale
 *   libera). Il Worker non fa da proxy per l'audio.
 * - POST /recipe: cerca una NUOVA ricetta dal web con l'API testuale di Gemini
 *   (Google Search grounding) e restituisce la ricetta pronta per il popup di
 *   importazione. Niente Gemini Live per le ricette.
 *
 * In entrambi i casi autentica l'utente Firebase e la GEMINI_API_KEY resta in
 * un secret Cloudflare, mai nel frontend.
 */

const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const GEMINI_TOKEN_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
// Endpoint REST per l'API testuale (generazione con grounding Google Search):
// usato dall'endpoint /recipe per le nuove ricette dal web, SENZA Gemini Live.
const GEMINI_GENERATE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent';
const DEFAULT_MODEL = 'gemini-3.1-flash-live-preview';
// Modello testuale per la ricerca di ricette: gratuito, non è un modello Live.
const DEFAULT_TEXT_MODEL = 'gemini-2.5-flash';
// Il token effimero viene emesso SENZA vincolarlo a un modello: è il client
// a scegliere il modello nel setup della WebSocket (primario o di riserva).
// GEMINI_LIVE_MODEL/GEMINI_LIVE_FALLBACK_MODEL servono solo a validare il
// modello richiesto dal client e a gestire il fallback in emissione.
const MAX_TOKEN_MINUTES = 30;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
// 30 emissioni per finestra: il client riusa il token per le riconnessioni, quindi
// il margine copre sessioni lunghe/schede multiple senza far scattare il 429.
const MAX_TOKEN_REQUESTS_PER_WINDOW = 30;

let cachedJwks = null;
let cachedJwksExpiresAt = 0;
const tokenRequestWindows = new Map();

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
  const configured = allowedOrigins(env);
  return configured.includes(origin);
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

function pemToDer(value) {
  const base64 = value.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, '');
  return base64UrlToBytes(base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
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

  const keys = await getJwks();
  const jwk = Array.isArray(keys) ? keys.find(item => item.kid === header.kid) : keys[header.kid];
  if (!jwk) {
    cachedJwks = null;
    cachedJwksExpiresAt = 0;
    const refreshed = await getJwks();
    const refreshedKey = Array.isArray(refreshed) ? refreshed.find(item => item.kid === header.kid) : refreshed[header.kid];
    if (!refreshedKey) throw new Error('Chiave Firebase non riconosciuta.');
    return verifySignature(refreshedKey, encodedHeader, encodedPayload, encodedSignature, payload);
  }
  return verifySignature(jwk, encodedHeader, encodedPayload, encodedSignature, payload);
}

async function verifySignature(jwk, encodedHeader, encodedPayload, encodedSignature, payload) {
  const key = await importJwk(jwk);
  const valid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    base64UrlToBytes(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  );
  if (!valid) throw new Error('Firma Firebase non valida.');
  return payload;
}

function checkRateLimit(userId) {
  const now = Date.now();
  // Il Map è intenzionalmente best-effort: gli isolate Cloudflare sono effimeri.
  // Il limite vincolante del provider resta la quota Gemini del progetto.
  for (const [key, window] of tokenRequestWindows) {
    if (window.resetAt <= now) tokenRequestWindows.delete(key);
  }
  const current = tokenRequestWindows.get(userId);
  if (!current || current.resetAt <= now) {
    tokenRequestWindows.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }
  if (current.count >= MAX_TOKEN_REQUESTS_PER_WINDOW) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
  current.count += 1;
  return { allowed: true, retryAfter: 0 };
}

function modelName(env) {
  return String(env.GEMINI_LIVE_MODEL || DEFAULT_MODEL).replace(/^models\//, '');
}

// Modello che il client può chiedere in alternativa (es. quando il modello
// principale risponde 1011 quota / 1008 modello ritirato). Facoltativo.
function fallbackModelName(env) {
  return String(env.GEMINI_LIVE_FALLBACK_MODEL || '').replace(/^models\//, '').trim();
}

// Modello testuale per la ricerca di ricette dal web (endpoint /recipe).
function textModelName(env) {
  return String(env.GEMINI_TEXT_MODEL || DEFAULT_TEXT_MODEL).replace(/^models\//, '').trim();
}

// Il client invia nel body il modello desiderato: viene accettato SOLO se
// coincide con il modello principale o con quello di riserva configurati,
// altrimenti si emette il token per il modello principale.
async function resolveModel(request, env) {
  const allowed = [modelName(env), fallbackModelName(env)].filter(Boolean);
  try {
    const body = await request.json();
    const requested = String(body?.model || '').replace(/^models\//, '').trim();
    if (requested && allowed.includes(requested)) return requested;
  } catch (_) {}
  return modelName(env);
}

async function createEphemeralToken(env, modelOverride) {
  const now = Date.now();
  const expiresAt = new Date(now + MAX_TOKEN_MINUTES * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(now + 60 * 1000).toISOString();
  const requested = modelOverride || modelName(env);
  // Il token NON viene vincolato a un modello (niente bidiGenerateContentSetup
  // né fieldMask nella richiesta ad auth_tokens): secondo l'API ufficiale, se
  // il setup è assente il setup effettivo della sessione è quello inviato dal
  // client sulla WebSocket. Così un solo token vale per qualunque modello e
  // il client può passare al modello di riserva senza una nuova emissione.
  // Se Gemini rifiuta di emettere il token per il modello richiesto, si prova
  // subito il modello di riserva configurato prima di restituire un errore.
  const attempts = [...new Set([requested, fallbackModelName(env)].filter(Boolean))];
  let lastError = null;
  for (const model of attempts) {
    try {
      const response = await fetch(GEMINI_TOKEN_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': String(env.GEMINI_API_KEY || '')
        },
        body: JSON.stringify({
          // uses:0 = nessun limite di utilizzi per il token (resta valido
          // fino a expireTime): le riconnessioni della stessa sessione non
          // consumano una nuova emissione.
          uses: 0,
          expireTime: expiresAt,
          newSessionExpireTime
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body?.error?.message || body?.message || `Gemini non ha emesso il token per ${model}.`);
      }
      const token = body.name || body.token?.name || body.token || body.accessToken;
      if (!token) throw new Error('Risposta Gemini senza token temporaneo.');
      return { token, expiresAt, model };
    } catch (error) {
      lastError = error;
      console.warn(`Token Gemini non emesso per ${model}: ${error.message}`);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------
// Endpoint /recipe: nuove ricette dal web con l'API testuale di Gemini
// (Google Search grounding), SENZA Gemini Live. Stesso schema import_recipe
// del client, così la ricetta torna pronta per il popup di importazione.
// ---------------------------------------------------------------------

const RECIPE_TOOL = {
  name: 'import_recipe',
  description: 'Prepara una NUOVA ricetta trovata sul web per importarla nel ricettario. Si usa solo su richiesta esplicita dell’utente di una nuova ricetta. Quantità già adattate alle linee guida del dott. Meller; l’app apre il popup di importazione.',
  parameters: {
    type: 'OBJECT',
    properties: {
      name: { type: 'STRING', description: 'Nome della ricetta' },
      slot: { type: 'STRING', enum: ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'], description: 'Pasto di appartenenza' },
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
      notes: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Note opzionali' }
    },
    required: ['name', 'ingredients', 'steps']
  }
};

function recipeSystemInstruction() {
  return [
    'Sei Piano, l’aiuto-cuoco della webapp Piano Nutrizionale.',
    'Rispondi SOLO con la chiamata di funzione import_recipe: nessun altro testo.',
    'Usa Google Search per trovare una ricetta adatta alla richiesta dell’utente.',
    'La ricetta è per una persona e deve rispettare i massimi del dott. Meller: pollame 200 g, manzo 150 g, maiale 100 g, pesce 250 g, legumi 240 g, uova 180 g, pasta/riso 90 g, gnocchi 250 g, patate 450 g, pane 120 g, olio EVO 10 g, miele 20 g, marmellata 30 g, yogurt 200 g, latte 250 g, formaggi 60 g, crackers 40 g, frutta fresca 250 g, frutta secca 20 g.',
    'Ogni ingrediente deve avere una dose con unità (es. "150 g", "2 cucchiai" oppure "q.b.").',
    'Scrivi tutto in italiano: nome, slot (breakfast/snack1/lunch/snack2/dinner), emoji, ingredienti, passaggi di preparazione e note.'
  ].join('\n');
}

// Estrae il functionCall import_recipe dalla risposta generateContent.
function extractRecipeFunctionCall(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part?.functionCall?.name === 'import_recipe') return part.functionCall;
  }
  return null;
}

// Normalizza gli argomenti del functionCall in una ricetta pulita per il client.
function normalizeRecipeFromArgs(args = {}) {
  return {
    name: String(args.name || '').trim(),
    slot: String(args.slot || '').trim(),
    emoji: String(args.emoji || '').trim(),
    ingredients: (Array.isArray(args.ingredients) ? args.ingredients : [])
      .map(item => ({
        name: String(item?.name || '').trim(),
        quantity: String(item?.quantity || '').trim()
      }))
      .filter(item => item.name),
    steps: (Array.isArray(args.steps) ? args.steps : []).map(step => String(step || '').trim()).filter(Boolean),
    notes: (Array.isArray(args.notes) ? args.notes : []).map(note => String(note || '').trim()).filter(Boolean)
  };
}

// Restituisce la ricetta pronta oppure null quando Gemini non produce la chiamata.
function parseRecipeFromResponse(data) {
  const call = extractRecipeFunctionCall(data);
  if (!call) return null;
  const recipe = normalizeRecipeFromArgs(call.args);
  if (!recipe.name || !recipe.ingredients.length) return null;
  return recipe;
}

// Chiama l'API REST generateContent con Google Search grounding e
// functionDeclarations [import_recipe].
async function generateRecipeContent(env, query) {
  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY non configurata nel Worker.');
  const model = textModelName(env);
  const url = `${GEMINI_GENERATE_URL.replace('{model}', encodeURIComponent(model))}?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: query }] }],
      systemInstruction: { parts: [{ text: recipeSystemInstruction() }] },
      tools: [
        { googleSearch: {} },
        { functionDeclarations: [RECIPE_TOOL] }
      ],
      generationConfig: { temperature: 0.4, maxOutputTokens: 1500 }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `Gemini ha risposto ${response.status}.`);
  }
  return data;
}

// Handler dell'endpoint /recipe: autenticazione e rate-limit sono già stati
// applicati dal fetch principale (stesso budget di 30 richieste/15 min).
async function handleRecipe(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch (_) {}
  const query = String(body?.query || '').trim();
  if (!query) return json({ error: 'Manca il testo della richiesta di ricetta.' }, 400, origin);

  let data;
  try {
    data = await generateRecipeContent(env, query);
  } catch (error) {
    console.error(error);
    return json({ error: error.message || 'Gemini non ha risposto alla richiesta di ricetta.' }, 502, origin);
  }

  const recipe = parseRecipeFromResponse(data);
  if (!recipe) {
    return json({ error: 'Non sono riuscito a comporre una ricetta valida. Riprova con una richiesta diversa.' }, 422, origin);
  }
  return json({ recipe }, 200, origin);
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
    if (pathname !== '/token' && pathname !== '/recipe') return json({ error: 'Endpoint non trovato.' }, 404, origin);
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

    try {
      if (pathname === '/recipe') return await handleRecipe(request, env, origin);
      const model = await resolveModel(request, env);
      const token = await createEphemeralToken(env, model);
      return json(token, 200, origin);
    } catch (error) {
      console.error(error);
      return json({ error: error.message || 'Gemini non disponibile in questo momento.' }, 502, origin);
    }
  }
};

// Export per i test unitari (node --test): il default export resta l'handler.
export {
  createEphemeralToken,
  fallbackModelName,
  modelName,
  resolveModel,
  textModelName,
  extractRecipeFunctionCall,
  normalizeRecipeFromArgs,
  parseRecipeFromResponse,
  generateRecipeContent,
  handleRecipe
};
