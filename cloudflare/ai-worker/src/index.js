/*
 * Cloudflare Worker: ricerca di NUOVE ricette dal web per la PWA.
 *
 * - POST /recipes: cerca ricette con le caratteristiche richieste dall'utente
 *   usando l'API generateContent di Gemini con Google Search grounding e
 *   output JSON strutturato, e restituisce fino a 10 ricette candidate (nome,
 *   pasto, ingredienti, preparazione, fonte) pronte per il popup di
 *   importazione della PWA.
 *
 * Pipeline di una richiesta (nel caso normale UNA sola chiamata Gemini):
 *   1. chiamata grounded con `tools: [{ googleSearch: {} }]` e
 *      `generationConfig.responseMimeType = "application/json"` +
 *      `responseSchema = RECIPES_RESPONSE_SCHEMA`. Nessuna functionDeclaration:
 *      la combinazione googleSearch + function calling su generateContent non
 *      è documentata come affidabile e il modello rispondeva in testo libero
 *      invece che con la chiamata `search_recipes`.
 *   2. se Gemini rifiuta la combinazione grounding + JSON strutturato
 *      (400 INVALID_ARGUMENT "…unsupported…"), il Worker passa da solo alla
 *      variante in due passaggi: chiamata grounded in testo libero (JSON nel
 *      testo) e, solo se il testo non è già JSON valido, una chiamata NON
 *      grounded che normalizza il testo nello schema. La scelta viene
 *      ricordata per il modello, così i click successivi non ripetono il
 *      tentativo fallito.
 *   3. parsing difensivo: JSON diretto, JSON dentro ```json```, JSON immerso
 *      nel testo, array troncato da MAX_TOKENS; normalizzazione, filtro sullo
 *      slot richiesto, massimo 10 ricette. Le fonti arrivano SEMPRE anche da
 *      groundingMetadata; nessun URL viene inventato.
 *
 * Modelli: GEMINI_TEXT_MODEL (default gemini-3.5-flash-lite) e un solo
 * fallback (gemini-3.1-flash-lite), usato SOLO per errori ritentabili (quota,
 * modello ritirato/non trovato, grounding non disponibile, 5xx). Gli errori di
 * configurazione (API key, richiesta rifiutata) non vengono ritentati.
 *
 * Errori verso il frontend (campo `code` nel JSON):
 *   429 GEMINI_QUOTA          quota/rate limit reale di Gemini
 *   429 WORKER_RATE_LIMIT     limite interno per utente del Worker
 *   502 GEMINI_CONFIGURATION  modello ritirato/non trovato, grounding non
 *                             disponibile, configurazione rifiutata, API key,
 *                             fatturazione
 *   502 GEMINI_UNAVAILABLE    Gemini irraggiungibile o 5xx
 *   422 GEMINI_INVALID_RESPONSE  Gemini ha risposto ma senza ricette valide
 * Ogni errore viene registrato in Cloudflare Observability come JSON
 * strutturato (modello, HTTP status, error.code/status/message/details) senza
 * MAI API key, header Authorization, token Firebase o URL con `?key=`.
 *
 * La GEMINI_API_KEY resta in un secret Cloudflare e viaggia solo nell'header
 * `x-goog-api-key` (mai nell'URL), mai nel frontend. Ogni richiesta è
 * autenticata con il Firebase ID token dell'utente.
 *
 * GRAMMATURE: NON stanno in questo prompt. Il modello si occupa solo di
 * trovare sul web le ricette più pertinenti ai criteri dell'utente e le
 * restituisce con le dosi della fonte originale. Il confronto con il manuale
 * e la correzione con un click vivono nell'app (`checkMellerAdaptation` /
 * `adaptRecipeToMeller` in `js/domain.js`), dove i valori sono deterministici,
 * verificabili dai test e non consumano token.
 *
 * Il Worker è quindi un file singolo senza dipendenze: si pubblica sia con
 * `npx wrangler deploy` sia copiando questo file nella dashboard Cloudflare.
 */

const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
// Endpoint REST generateContent (v1beta): la chiave va nell'header x-goog-api-key.
const GEMINI_GENERATE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent';
// Modello predefinito: Gemini 3.5 Flash-Lite (GA dal 21/07/2026). Supporta
// Google Search grounding e structured outputs; nel piano gratuito del progetto
// risultano 15 RPM, 250K TPM, 500 RPD e 500 richieste di grounding al giorno.
// Sovrascrivibile con la variabile GEMINI_TEXT_MODEL.
const DEFAULT_TEXT_MODEL = 'gemini-3.5-flash-lite';
// Unico fallback: Gemini 3.1 Flash-Lite (stabile, ritiro annunciato per il
// 07/05/2027). gemini-3.6-flash (grounding 0/0 nel progetto) e
// gemini-2.5-flash-lite (non più disponibile ai nuovi utenti) sono stati tolti.
// Sovrascrivibile con GEMINI_FALLBACK_MODELS (lista separata da virgola, anche vuota).
const FALLBACK_TEXT_MODELS = ['gemini-3.1-flash-lite'];
// Mai più di due modelli per click e mai più di quattro chiamate Gemini per
// singola ricerca, qualunque sia la sequenza di errori.
const MAX_MODELS_PER_REQUEST = 2;
const MAX_GEMINI_CALLS_PER_REQUEST = 4;
// Se un modello rifiuta grounding + JSON strutturato, si ricorda la cosa per
// questo intervallo e si usa direttamente la variante in due passaggi.
const STRUCTURED_GROUNDING_SUSPENSION_MS = 6 * 60 * 60 * 1000;
// I token di "thinking" dei modelli Gemini 3 contano nel limite di output:
// serve margine oltre ai ~4K token del JSON con 10 ricette.
const MAX_OUTPUT_TOKENS = 16384;
const MAX_NORMALIZE_INPUT_CHARS = 24000;
const MAX_EXCLUDED_NAMES = 30;
const MAX_TEXT_FIELD_LENGTH = 2000;
const MAX_LOG_TEXT_LENGTH = 600;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
// 30 ricerche per finestra: più che sufficienti per un uso personale.
const MAX_REQUESTS_PER_WINDOW = 30;
const DEFAULT_MAX_RECIPES = 10;
const MAX_RECIPES = 10;
const SLOTS = ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'];

const ERROR_CODES = Object.freeze({
  WORKER_RATE_LIMIT: 'WORKER_RATE_LIMIT',
  GEMINI_QUOTA: 'GEMINI_QUOTA',
  GEMINI_CONFIGURATION: 'GEMINI_CONFIGURATION',
  GEMINI_UNAVAILABLE: 'GEMINI_UNAVAILABLE',
  GEMINI_INVALID_RESPONSE: 'GEMINI_INVALID_RESPONSE'
});

// Classificazione degli errori del provider: per ogni causa, il codice
// restituito al frontend, se vale la pena provare il modello di fallback e lo
// status HTTP finale. `retryable` significa "il problema è legato a QUESTO
// modello (quota, ritiro, disponibilità)", non "riprova alla cieca".
const FAILURE_KINDS = Object.freeze({
  quota: { code: ERROR_CODES.GEMINI_QUOTA, retryable: true, httpStatus: 429 },
  model_retired: { code: ERROR_CODES.GEMINI_CONFIGURATION, retryable: true, httpStatus: 502 },
  model_not_found: { code: ERROR_CODES.GEMINI_CONFIGURATION, retryable: true, httpStatus: 502 },
  grounding_unavailable: { code: ERROR_CODES.GEMINI_CONFIGURATION, retryable: true, httpStatus: 502 },
  billing_disabled: { code: ERROR_CODES.GEMINI_CONFIGURATION, retryable: true, httpStatus: 502 },
  invalid_api_key: { code: ERROR_CODES.GEMINI_CONFIGURATION, retryable: false, httpStatus: 502 },
  permission_denied: { code: ERROR_CODES.GEMINI_CONFIGURATION, retryable: false, httpStatus: 502 },
  location_unsupported: { code: ERROR_CODES.GEMINI_CONFIGURATION, retryable: false, httpStatus: 502 },
  // Grounding + JSON strutturato rifiutati insieme: gestito internamente con
  // la variante in due passaggi sullo stesso modello, non con il fallback.
  structured_grounding_unsupported: { code: ERROR_CODES.GEMINI_CONFIGURATION, retryable: false, httpStatus: 502 },
  unsupported_configuration: { code: ERROR_CODES.GEMINI_CONFIGURATION, retryable: false, httpStatus: 502 },
  missing_api_key: { code: ERROR_CODES.GEMINI_CONFIGURATION, retryable: false, httpStatus: 502 },
  provider_error: { code: ERROR_CODES.GEMINI_UNAVAILABLE, retryable: true, httpStatus: 502 },
  network_error: { code: ERROR_CODES.GEMINI_UNAVAILABLE, retryable: true, httpStatus: 502 },
  call_budget_exhausted: { code: ERROR_CODES.GEMINI_UNAVAILABLE, retryable: false, httpStatus: 502 }
});

const SHORT_REASON_IT = Object.freeze({
  quota: 'quota o rate limit raggiunti',
  model_retired: 'modello ritirato da Google',
  model_not_found: 'modello non trovato',
  grounding_unavailable: 'Google Search grounding non disponibile',
  billing_disabled: 'fatturazione richiesta',
  invalid_api_key: 'API key non valida',
  permission_denied: 'permesso negato',
  location_unsupported: 'regione non supportata',
  structured_grounding_unsupported: 'Google Search + JSON strutturato non supportati insieme',
  unsupported_configuration: 'configurazione rifiutata',
  missing_api_key: 'API key mancante',
  provider_error: 'errore del provider',
  network_error: 'Gemini irraggiungibile',
  call_budget_exhausted: 'limite di chiamate per ricerca raggiunto'
});

let cachedJwks = null;
let cachedJwksExpiresAt = 0;
const requestWindows = new Map();
const structuredGroundingSuspendedUntil = new Map();
const secretValues = new Set();

// ---------------------------------------------------------------------------
// Risposte HTTP e CORS
// ---------------------------------------------------------------------------

function json(body, status = 200, origin = '', extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
      'cache-control': 'no-store',
      ...extraHeaders
    }
  });
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin || 'null',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-expose-headers': 'Retry-After',
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

// ---------------------------------------------------------------------------
// Log strutturati senza segreti (Cloudflare Observability / Workers Logs)
// ---------------------------------------------------------------------------

function registerSecret(value) {
  const secret = String(value || '');
  if (secret.length >= 8) secretValues.add(secret);
}

function truncate(value, maxLength) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

// Oscura API key Google, token Bearer, JWT e parametri ?key= in qualunque
// stringa destinata ai log o al frontend. Applicato anche ai messaggi che
// arrivano dal provider, per non fidarsi del loro contenuto.
function redactSecrets(value) {
  let text = String(value ?? '');
  for (const secret of secretValues) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/([?&]key=)[^&\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9\-_.=]+/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9\-_]{5,}\.[A-Za-z0-9\-_]{5,}\.[A-Za-z0-9\-_]{5,}/g, '[REDACTED_JWT]');
}

function sanitizeForLog(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return redactSecrets(truncate(value, MAX_LOG_TEXT_LENGTH));
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 6) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeForLog(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/authorization|api[_-]?key|token|secret|password/i.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = sanitizeForLog(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function logEvent(level, payload) {
  const method = typeof console[level] === 'function' ? level : 'log';
  try {
    console[method](sanitizeForLog({ source: 'piano-nutrizionale-ai', ...payload }));
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Autenticazione Firebase
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Modelli
// ---------------------------------------------------------------------------

function normalizeModelName(value) {
  return String(value || '').replace(/^models\//, '').trim();
}

function textModelName(env) {
  return normalizeModelName(env.GEMINI_TEXT_MODEL) || DEFAULT_TEXT_MODEL;
}

function fallbackModelList(env) {
  if (env && typeof env.GEMINI_FALLBACK_MODELS === 'string') {
    return env.GEMINI_FALLBACK_MODELS.split(',').map(normalizeModelName).filter(Boolean);
  }
  return FALLBACK_TEXT_MODELS.slice();
}

function textModelList(env) {
  const primary = textModelName(env);
  return [primary, ...fallbackModelList(env)]
    .filter((model, index, list) => model && list.indexOf(model) === index)
    .slice(0, MAX_MODELS_PER_REQUEST);
}

// ---------------------------------------------------------------------------
// Classificazione degli errori Gemini
// ---------------------------------------------------------------------------

class GeminiError extends Error {
  constructor(message, info) {
    super(message);
    this.name = 'GeminiError';
    Object.assign(this, info);
  }
}

class RecipeSearchError extends Error {
  constructor(message, info) {
    super(message);
    this.name = 'RecipeSearchError';
    Object.assign(this, info);
  }
}

function parseDurationSeconds(value) {
  if (value == null) return 0;
  if (typeof value === 'object') {
    const seconds = Number(value.seconds) || 0;
    const nanos = Number(value.nanos) || 0;
    return Math.ceil(seconds + nanos / 1e9);
  }
  const match = /^([\d.]+)\s*s$/i.exec(String(value).trim());
  return match ? Math.ceil(Number(match[1])) : 0;
}

// Legge QuotaFailure/RetryInfo dai details di google.rpc.Status. `quotaZero`
// distingue "quota esaurita" da "il progetto non ha alcuna quota per questo
// modello" (limit: 0): nel secondo caso il blocco è nel progetto Google.
function extractQuotaInfo(details, message) {
  const violations = [];
  let retryAfter = 0;
  for (const detail of Array.isArray(details) ? details : []) {
    const type = String(detail?.['@type'] || '');
    if (/QuotaFailure/.test(type) && Array.isArray(detail.violations)) {
      for (const violation of detail.violations) {
        violations.push({
          metric: String(violation?.quotaMetric || ''),
          id: String(violation?.quotaId || ''),
          value: violation?.quotaValue == null ? '' : String(violation.quotaValue),
          dimensions: violation?.quotaDimensions && typeof violation.quotaDimensions === 'object' ? violation.quotaDimensions : {}
        });
      }
    }
    if (/RetryInfo/.test(type) && detail.retryDelay) retryAfter = parseDurationSeconds(detail.retryDelay);
  }
  const text = String(message || '');
  if (!retryAfter) {
    const match = /retry in ([\d.]+)\s*s/i.exec(text);
    if (match) retryAfter = Math.ceil(Number(match[1]));
  }
  const quotaZero = /limit:\s*0\b/i.test(text) || violations.some(violation => violation.value === '0');
  return { violations, retryAfter, quotaZero };
}

function classifyGeminiFailure({ httpStatus = 0, error = null, networkError = null } = {}) {
  const status = Number(httpStatus) || 0;
  const errorStatus = String(error?.status || '').toUpperCase();
  const message = String(error?.message || networkError?.message || '');
  const text = message.toLowerCase();
  const details = Array.isArray(error?.details) ? error.details : [];
  const detailReasons = details.map(detail => String(detail?.reason || '')).join(' ').toUpperCase();
  const unsupportedWords = /unsupported|not supported|not allowed|cannot be used|isn't supported|is not available/;

  let reason;
  if (networkError) reason = 'network_error';
  else if (status === 429 || errorStatus === 'RESOURCE_EXHAUSTED' || /quota|rate limit|too many requests/.test(text)) reason = 'quota';
  else if (/no longer available|deprecated|shut ?down|retired|discontinued/.test(text)) reason = 'model_retired';
  else if (/api key not valid|api_key_invalid|invalid api key|api key expired/.test(text) || /API_KEY_INVALID|API_KEY_EXPIRED/.test(detailReasons)) reason = 'invalid_api_key';
  else if (/billing/.test(text)) reason = 'billing_disabled';
  else if (/location is not supported|user location/.test(text)) reason = 'location_unsupported';
  else if (status === 404 || errorStatus === 'NOT_FOUND' || /is not found|not found for api version|does not exist/.test(text)) reason = 'model_not_found';
  // Es. "Tool use with a response mime type: 'application/json' is unsupported":
  // il modello non accetta grounding e JSON strutturato nella stessa chiamata.
  else if (/mime.?type|response.?schema|response.?format|json|structured/.test(text) && /tool|search|grounding/.test(text) && unsupportedWords.test(text)) reason = 'structured_grounding_unsupported';
  else if (/mime.?type|response.?schema|response.?format|structured/.test(text) && unsupportedWords.test(text)) reason = 'unsupported_configuration';
  else if (/google.?search|grounding/.test(text) && (unsupportedWords.test(text) || /disabled|not enabled/.test(text))) reason = 'grounding_unavailable';
  else if (status === 403 || errorStatus === 'PERMISSION_DENIED') reason = 'permission_denied';
  else if (status >= 500 || ['UNAVAILABLE', 'INTERNAL', 'DEADLINE_EXCEEDED', 'UNKNOWN'].includes(errorStatus) || /overloaded|internal error/.test(text)) reason = 'provider_error';
  else if (status === 400 || ['INVALID_ARGUMENT', 'FAILED_PRECONDITION'].includes(errorStatus) || /unsupported|not supported|unknown name|invalid/.test(text)) reason = 'unsupported_configuration';
  else reason = 'provider_error';

  const kind = FAILURE_KINDS[reason];
  const quota = reason === 'quota' ? extractQuotaInfo(details, message) : { violations: [], retryAfter: 0, quotaZero: false };
  return {
    reason,
    code: kind.code,
    retryable: kind.retryable,
    httpStatus: status,
    errorCode: error?.code == null ? (status || null) : error.code,
    errorStatus: String(error?.status || ''),
    providerMessage: message,
    details,
    retryAfter: quota.retryAfter,
    quotaZero: quota.quotaZero,
    quotaViolations: quota.violations
  };
}

function quotaLabel(failure) {
  const violation = (failure.quotaViolations || [])[0];
  if (!violation) return '';
  return violation.id || violation.metric.split('/').pop() || '';
}

function describeGeminiFailure(failure) {
  const model = failure.model || 'modello sconosciuto';
  const where = failure.httpStatus
    ? `${model} (HTTP ${failure.httpStatus}${failure.errorStatus ? ` ${failure.errorStatus}` : ''})`
    : model;
  const providerMessage = redactSecrets(failure.providerMessage || '');
  const detail = providerMessage ? ` Messaggio Google: "${truncate(providerMessage, 220)}".` : '';
  switch (failure.reason) {
    case 'quota': {
      const label = quotaLabel(failure);
      if (failure.quotaZero) {
        return `Il progetto Google della API key non ha alcuna quota per ${where}${label ? ` (limite 0 su ${label})` : ' (limite 0)'}. Il blocco è nel progetto/API key Google (piano gratuito non disponibile per questo modello, fatturazione o regione), non nel codice del Worker: controlla https://aistudio.google.com/rate-limit oppure usa una chiave di un altro progetto.`;
      }
      return `Quota o rate limit Gemini raggiunti per ${where}${label ? `: ${label}` : ''}. ${failure.retryAfter ? `Riprova tra circa ${failure.retryAfter} secondi.` : 'Riprova più tardi: la quota si azzera da sola.'}`;
    }
    case 'model_retired':
      return `Il modello ${where} è stato ritirato da Google e non è più disponibile: aggiorna GEMINI_TEXT_MODEL nel Worker.${detail}`;
    case 'model_not_found':
      return `Il modello ${where} non esiste o non supporta generateContent con questa API key: controlla GEMINI_TEXT_MODEL.${detail}`;
    case 'grounding_unavailable':
      return `Google Search grounding non è disponibile per ${where} con questa API key.${detail}`;
    case 'billing_disabled':
      return `Google richiede la fatturazione attiva sul progetto per usare ${where}.${detail}`;
    case 'invalid_api_key':
      return `La GEMINI_API_KEY configurata nel Worker non è valida per Google (${where}): rigenerala su https://aistudio.google.com/apikey e aggiorna il secret.`;
    case 'permission_denied':
      return `L'API key non è autorizzata a usare ${where}.${detail}`;
    case 'location_unsupported':
      return `Google non abilita l'API Gemini per la regione della richiesta (${where}).${detail}`;
    case 'structured_grounding_unsupported':
      return `${where} non accetta Google Search grounding e output JSON strutturato nella stessa chiamata.${detail}`;
    case 'unsupported_configuration':
      return `Gemini ha rifiutato la configurazione della richiesta del Worker per ${where}.${detail} Serve un aggiornamento del Worker, non un'attesa.`;
    case 'network_error':
      return `Il Worker non è riuscito a contattare Gemini (${model}): ${truncate(providerMessage || 'errore di rete', 160)}.`;
    case 'call_budget_exhausted':
      return `Raggiunto il numero massimo di chiamate Gemini per una singola ricerca (${MAX_GEMINI_CALLS_PER_REQUEST}) senza ottenere ricette.`;
    case 'missing_api_key':
      return 'GEMINI_API_KEY non configurata nel Worker: aggiungila come secret in Settings → Variables and Secrets.';
    default:
      return `Gemini non ha risposto correttamente per ${where}.${detail}`;
  }
}

function toGeminiError({ model, stage, httpStatus = 0, body = null, networkError = null }) {
  const providerError = body?.error && typeof body.error === 'object' ? body.error : null;
  const classification = classifyGeminiFailure({ httpStatus, error: providerError, networkError });
  if (!classification.providerMessage && body?.message) classification.providerMessage = String(body.message);
  const failure = { model, stage, ...classification };
  return new GeminiError(describeGeminiFailure(failure), failure);
}

function shortFailure(failure) {
  const base = SHORT_REASON_IT[failure.reason] || 'errore';
  const status = failure.httpStatus ? ` (HTTP ${failure.httpStatus}${failure.errorStatus ? ` ${failure.errorStatus}` : ''})` : '';
  return `${base}${failure.quotaZero ? ', limite 0 nel progetto Google' : ''}${status}`;
}

function publicAttempt(failure) {
  return {
    model: failure.model || '',
    stage: failure.stage || '',
    reason: failure.reason || 'provider_error',
    httpStatus: failure.httpStatus || 0,
    status: failure.errorStatus || '',
    message: truncate(redactSecrets(failure.providerMessage || failure.message || ''), 300)
  };
}

// Stato finale quando tutti i modelli hanno fallito: lo status HTTP segue la
// causa del modello PRINCIPALE (è quella su cui si può agire), il messaggio
// elenca anche il fallback. Nessun messaggio generico sulla quota gratuita.
function aggregateFailures(failures) {
  const primary = failures[0];
  const kind = FAILURE_KINDS[primary.reason] || FAILURE_KINDS.provider_error;
  const parts = [primary.message];
  failures.slice(1).forEach(failure => parts.push(`Fallback ${failure.model}: ${shortFailure(failure)}.`));
  const retryAfter = failures.reduce((max, failure) => Math.max(max, Number(failure.retryAfter) || 0), 0);
  return new RecipeSearchError(parts.join(' '), {
    status: kind.httpStatus,
    code: kind.code,
    reason: primary.reason,
    retryAfter: retryAfter || (kind.httpStatus === 429 ? 60 : 0),
    attempts: failures.map(publicAttempt)
  });
}

// ---------------------------------------------------------------------------
// Schema, prompt e richieste
// ---------------------------------------------------------------------------

// Schema OpenAPI (sottoinsieme accettato da responseSchema) del risultato.
// Lo stesso schema viene usato dalla chiamata grounded e dalla normalizzazione.
const RECIPES_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    recipes: {
      type: 'ARRAY',
      description: 'Ricette trovate sul web, ordinate per pertinenza (massimo 10).',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'Nome della ricetta in italiano' },
          slot: { type: 'STRING', format: 'enum', enum: SLOTS, description: 'Pasto di appartenenza: breakfast, snack1, lunch, snack2, dinner' },
          emoji: { type: 'STRING', description: 'Una sola emoji rappresentativa (facoltativa)' },
          ingredients: {
            type: 'ARRAY',
            description: 'Ingredienti con la dose per una persona così come indicata dalla fonte',
            items: {
              type: 'OBJECT',
              properties: {
                name: { type: 'STRING', description: 'Nome ingrediente' },
                quantity: { type: 'STRING', description: 'Dose con unità, es. "150 g" oppure "q.b."' }
              },
              required: ['name', 'quantity'],
              propertyOrdering: ['name', 'quantity']
            }
          },
          steps: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Preparazione: un passaggio per elemento' },
          notes: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Note facoltative' },
          sourceUrl: { type: 'STRING', description: 'URL reale della fonte restituita da Google Search; stringa vuota se non disponibile' },
          sourceTitle: { type: 'STRING', description: 'Titolo o sito della fonte' }
        },
        required: ['name', 'slot', 'ingredients', 'steps'],
        propertyOrdering: ['name', 'slot', 'emoji', 'ingredients', 'steps', 'notes', 'sourceUrl', 'sourceTitle']
      }
    }
  },
  required: ['recipes']
};

const JSON_SHAPE_EXAMPLE = '{"recipes":[{"name":"Nome ricetta","slot":"breakfast|snack1|lunch|snack2|dinner","emoji":"🍽️","ingredients":[{"name":"Ingrediente","quantity":"dose con unità"}],"steps":["Passaggio"],"notes":["Nota facoltativa"],"sourceUrl":"https://…","sourceTitle":"Titolo della fonte"}]}';

// Il prompt NON contiene le grammature del manuale: il modello cerca sul web
// le ricette più pertinenti ai criteri dell'utente e le restituisce con le
// dosi della fonte originale. Il confronto con il manuale e la correzione con
// un click avvengono nell'app (checkMellerAdaptation / adaptRecipeToMeller in
// js/domain.js), dove i valori sono deterministici e verificabili.
function recipesSystemInstruction(slot, excludeNames) {
  const excluded = (Array.isArray(excludeNames) ? excludeNames : []).filter(Boolean);
  return [
    'Sei l’aiuto-cuoco della webapp Piano Nutrizionale: trovi NUOVE ricette dal web.',
    'Usa Google Search per trovare ricette reali adatte alla richiesta dell’utente.',
    'Proponi fino a 10 ricette in italiano, ordinate dalla più pertinente: contano l’aderenza agli ingredienti richiesti e al tipo di pasto.',
    'Riporta gli ingredienti e le dosi COSÌ COME sono indicati dalla fonte, per una persona: non riscalare, non arrotondare, non adattare le quantità ad alcuna dieta.',
    'Usa unità esplicite dove la fonte le indica (es. "150 g", "2 cucchiai", "q.b.").',
    'Preferisci ricette di fonti diverse tra loro ed evita varianti quasi identiche della stessa ricetta.',
    slot
      ? `Tutte le ricette devono appartenere OBBLIGATORIAMENTE al pasto "${slot}": imposta slot="${slot}" su ogni ricetta.`
      : 'Indica sempre il pasto di appartenenza (slot: breakfast/snack1/lunch/snack2/dinner).',
    excluded.length ? `Escludi tassativamente queste ricette già proposte: ${excluded.join('; ')}.` : '',
    'Compila sourceUrl e sourceTitle con la fonte reale restituita da Google Search; se non hai un URL reale lascia sourceUrl vuoto: non inventare indirizzi.',
    'Rispondi SOLO con un oggetto JSON valido, senza markdown e senza testo prima o dopo, con questa struttura:',
    JSON_SHAPE_EXAMPLE,
    'Se non trovi ricette adatte, rispondi con {"recipes":[]}.'
  ].filter(Boolean).join('\n');
}

function normalizeSystemInstruction(slot, maxRecipes) {
  return [
    'Converti in JSON strutturato le ricette contenute nel testo fornito dall’utente.',
    'Non aggiungere ricette, ingredienti, dosi o URL assenti nel testo; se manca l’indirizzo della fonte lascia sourceUrl vuoto.',
    'Mantieni le dosi esattamente come compaiono nel testo, senza riscalarle.',
    `Restituisci al massimo ${maxRecipes} ricette, nell’ordine del testo.`,
    slot ? `Imposta slot="${slot}" su ogni ricetta.` : 'Indica il pasto di appartenenza (slot: breakfast/snack1/lunch/snack2/dinner).',
    'Se il testo non contiene ricette, restituisci {"recipes":[]}.'
  ].join('\n');
}

function buildGroundedRequest({ query, maxRecipes, slot, excludeNames }, { structured = true } = {}) {
  const excluded = (Array.isArray(excludeNames) ? excludeNames : []).filter(Boolean);
  const userText = [
    `L’utente chiede: ${query}. Proponi fino a ${maxRecipes} ricette.`,
    slot ? `Tutte le ricette devono essere per il pasto "${slot}".` : '',
    excluded.length ? `Escludi queste ricette già mostrate: ${excluded.join('; ')}.` : ''
  ].filter(Boolean).join(' ');
  // Niente temperature/topP/topK (deprecati da Google per Gemini 3) e nessun
  // thinkingConfig: per i Flash-Lite il livello predefinito è già "minimal" e
  // un valore esplicito darebbe errore sui modelli che non lo supportano.
  const generationConfig = { maxOutputTokens: MAX_OUTPUT_TOKENS };
  if (structured) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = RECIPES_RESPONSE_SCHEMA;
  }
  return {
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    systemInstruction: { parts: [{ text: recipesSystemInstruction(slot, excluded) }] },
    // Solo Google Search grounding: nessuna functionDeclaration.
    tools: [{ googleSearch: {} }],
    generationConfig
  };
}

function buildNormalizeRequest(text, { maxRecipes, slot }) {
  return {
    contents: [{ role: 'user', parts: [{ text: `Testo da convertire:\n${String(text || '').slice(0, MAX_NORMALIZE_INPUT_CHARS)}` }] }],
    systemInstruction: { parts: [{ text: normalizeSystemInstruction(slot, maxRecipes) }] },
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RECIPES_RESPONSE_SCHEMA,
      maxOutputTokens: MAX_OUTPUT_TOKENS
    }
  };
}

// ---------------------------------------------------------------------------
// Parsing difensivo della risposta
// ---------------------------------------------------------------------------

function extractResponseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(part => part && typeof part.text === 'string' && part.thought !== true)
    .map(part => part.text)
    .join('\n')
    .trim();
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (_) {
    return { ok: false, value: null };
  }
}

// Stringhe candidate da provare, nell'ordine: blocchi ```json```, il testo
// intero, la porzione tra la prima graffa e l'ultima, quella tra le quadre.
function jsonCandidates(text) {
  const candidates = [];
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(text)) !== null) {
    if (match[1].trim()) candidates.push(match[1].trim());
  }
  candidates.push(text);
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) candidates.push(text.slice(firstBracket, lastBracket + 1));
  return [...new Set(candidates)];
}

// Recupera gli oggetti completi da un array "recipes" troncato (MAX_TOKENS):
// meglio 6 ricette intere che nessuna.
function salvageRecipeObjects(text) {
  const start = text.search(/"recipes"\s*:\s*\[/);
  if (start < 0) return [];
  const arrayStart = text.indexOf('[', start);
  const items = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;
  for (let index = arrayStart + 1; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      if (depth === 0) objectStart = index;
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        const parsed = tryParseJson(text.slice(objectStart, index + 1));
        if (parsed.ok) items.push(parsed.value);
        objectStart = -1;
      }
    } else if (character === ']' && depth === 0) {
      break;
    }
  }
  return items;
}

function looksLikeRecipe(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.name && Array.isArray(value.ingredients));
}

// Accetta: risposta Gemini grezza, stringa JSON (anche dentro ```json``` o
// immersa nel testo), oggetto già convertito, array di ricette. Restituisce
// `ok=false` quando non c'è nulla di interpretabile.
function parseRecipesPayload(input) {
  if (input == null) return { ok: false, recipes: [], partial: false };
  if (typeof input === 'object') {
    if (Array.isArray(input)) return { ok: true, recipes: input, partial: false };
    if (Array.isArray(input.recipes)) return { ok: true, recipes: input.recipes, partial: false };
    if (Array.isArray(input.candidates) || input.promptFeedback) return parseRecipesPayload(extractResponseText(input));
    if (looksLikeRecipe(input)) return { ok: true, recipes: [input], partial: false };
    return { ok: false, recipes: [], partial: false };
  }
  const text = String(input).trim();
  if (!text) return { ok: false, recipes: [], partial: false };
  for (const candidate of jsonCandidates(text)) {
    const parsed = tryParseJson(candidate);
    if (!parsed.ok) continue;
    const value = parsed.value;
    if (Array.isArray(value)) return { ok: true, recipes: value, partial: false };
    if (value && typeof value === 'object' && Array.isArray(value.recipes)) return { ok: true, recipes: value.recipes, partial: false };
    if (looksLikeRecipe(value)) return { ok: true, recipes: [value], partial: false };
  }
  const salvaged = salvageRecipeObjects(text);
  if (salvaged.length) return { ok: true, recipes: salvaged, partial: true };
  return { ok: false, recipes: [], partial: false };
}

function cleanField(value, maxLength) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : (typeof value === 'number' ? String(value) : '');
  return text.trim().slice(0, maxLength);
}

function toStringList(value, maxItems, maxLength) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/\n+/) : []);
  return list
    .map(item => cleanField(typeof item === 'object' && item ? (item.text ?? item.step ?? item.description) : item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (['http:', 'https:'].includes(parsed.protocol)) return parsed.href;
  } catch (_) {}
  return '';
}

function normalizeRecipe(item, defaultSlot) {
  const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
  const name = cleanField(source.name, 200);
  const ingredients = (Array.isArray(source.ingredients) ? source.ingredients : [])
    .slice(0, 40)
    .map(ingredient => {
      if (typeof ingredient === 'string') return { name: cleanField(ingredient, 200), quantity: '' };
      return {
        name: cleanField(ingredient?.name, 200),
        quantity: cleanField(ingredient?.quantity ?? ingredient?.amount ?? ingredient?.dose, 100)
      };
    })
    .filter(ingredient => ingredient.name);
  const steps = toStringList(source.steps ?? source.instructions ?? source.preparation, 40, 2000);
  const notes = toStringList(source.notes, 20, 1000);
  const slot = SLOTS.includes(String(source.slot || ''))
    ? String(source.slot)
    : (SLOTS.includes(String(defaultSlot || '')) ? String(defaultSlot) : 'lunch');
  const emoji = cleanField(source.emoji, 16);
  return {
    name: name || 'Ricetta',
    slot,
    emoji: emoji.length <= 8 ? emoji : '',
    ingredients,
    steps,
    notes,
    sourceUrl: safeHttpUrl(source.sourceUrl ?? source.url ?? source.source),
    sourceTitle: cleanField(source.sourceTitle ?? source.sourceName, 200)
  };
}

function clampRecipes(value) {
  return Math.max(1, Math.min(Number(value) || DEFAULT_MAX_RECIPES, MAX_RECIPES));
}

// Normalizza, scarta ricette senza nome o ingredienti, impone lo slot
// richiesto, elimina duplicati e ricette già escluse, taglia a 10.
function finalizeRecipes(rawRecipes, maxRecipes, defaultSlot, excludeNames) {
  const wantedSlot = SLOTS.includes(String(defaultSlot || '')) ? String(defaultSlot) : '';
  const excluded = new Set((Array.isArray(excludeNames) ? excludeNames : []).map(name => String(name || '').trim().toLowerCase()).filter(Boolean));
  const seen = new Set();
  return (Array.isArray(rawRecipes) ? rawRecipes : [])
    .filter(item => item && typeof item === 'object' && !Array.isArray(item) && cleanField(item.name, 200))
    .map(item => normalizeRecipe(item, wantedSlot))
    .filter(recipe => recipe.name && recipe.ingredients.length)
    .filter(recipe => !wantedSlot || recipe.slot === wantedSlot)
    .filter(recipe => {
      const key = recipe.name.toLowerCase();
      if (seen.has(key) || excluded.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, clampRecipes(maxRecipes));
}

function parseRecipesFromResponse(data, maxRecipes, defaultSlot, excludeNames) {
  return finalizeRecipes(parseRecipesPayload(data).recipes, maxRecipes, defaultSlot, excludeNames);
}

function extractSources(data) {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = (Array.isArray(chunks) ? chunks : []).map(chunk => ({
    title: cleanField(chunk?.web?.title, 200),
    url: safeHttpUrl(chunk?.web?.uri || chunk?.web?.url || '')
  })).filter(source => source.url);
  return [...new Map(sources.map(source => [source.url, source])).values()].slice(0, MAX_RECIPES);
}

function analyzeGroundedResponse(data, params) {
  const candidate = data?.candidates?.[0];
  const text = extractResponseText(data);
  const payload = parseRecipesPayload(text);
  return {
    text,
    parsed: payload.ok,
    partial: Boolean(payload.partial),
    rawCount: payload.recipes.length,
    recipes: finalizeRecipes(payload.recipes, params.maxRecipes, params.slot, params.excludeNames),
    finishReason: String(candidate?.finishReason || ''),
    blockReason: String(data?.promptFeedback?.blockReason || ''),
    groundingQueries: Array.isArray(candidate?.groundingMetadata?.webSearchQueries) ? candidate.groundingMetadata.webSearchQueries.length : 0
  };
}

// ---------------------------------------------------------------------------
// Chiamate Gemini
// ---------------------------------------------------------------------------

async function callGemini(apiKey, model, requestBody, { stage = 'grounded-json', budget = null } = {}) {
  if (budget) {
    if (budget.used >= budget.max) {
      throw new GeminiError(describeGeminiFailure({ model, stage, reason: 'call_budget_exhausted' }), {
        model, stage, reason: 'call_budget_exhausted', ...FAILURE_KINDS.call_budget_exhausted, httpStatus: 0, errorStatus: '', providerMessage: '', details: []
      });
    }
    budget.used += 1;
  }
  const url = GEMINI_GENERATE_URL.replace('{model}', encodeURIComponent(model));
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(requestBody)
    });
  } catch (networkError) {
    throw toGeminiError({ model, stage, networkError });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw toGeminiError({ model, stage, httpStatus: response.status, body: data });
  return data;
}

function isStructuredGroundingSuspended(model) {
  const until = structuredGroundingSuspendedUntil.get(model) || 0;
  if (until > Date.now()) return true;
  structuredGroundingSuspendedUntil.delete(model);
  return false;
}

function suspendStructuredGrounding(model, error) {
  structuredGroundingSuspendedUntil.set(model, Date.now() + STRUCTURED_GROUNDING_SUSPENSION_MS);
  logEvent('warn', {
    event: 'gemini_structured_grounding_unsupported',
    model,
    httpStatus: error.httpStatus,
    errorStatus: error.errorStatus,
    message: error.providerMessage,
    action: 'two-step fallback (grounded text + normalize)'
  });
}

function usageSummary(data) {
  const usage = data?.usageMetadata;
  if (!usage || typeof usage !== 'object') return null;
  return {
    promptTokens: usage.promptTokenCount ?? null,
    candidatesTokens: usage.candidatesTokenCount ?? null,
    thoughtsTokens: usage.thoughtsTokenCount ?? null,
    totalTokens: usage.totalTokenCount ?? null
  };
}

// Pipeline per un singolo modello. Restituisce le ricette già normalizzate,
// le fonti di grounding e la diagnostica; lancia GeminiError sugli errori.
async function searchRecipesWithModel(apiKey, model, params, budget = { used: 0, max: MAX_GEMINI_CALLS_PER_REQUEST }) {
  let mode = 'grounded-json';
  let grounded = null;
  if (!isStructuredGroundingSuspended(model)) {
    try {
      grounded = await callGemini(apiKey, model, buildGroundedRequest(params, { structured: true }), { stage: 'grounded-json', budget });
    } catch (error) {
      // Solo il rifiuto della combinazione grounding + JSON strutturato viene
      // assorbito qui (variante in due passaggi). Quota, modello ritirato,
      // API key e ogni altra causa risalgono al chiamante.
      if (error?.reason !== 'structured_grounding_unsupported') throw error;
      suspendStructuredGrounding(model, error);
    }
  }
  if (!grounded) {
    mode = 'grounded-text';
    grounded = await callGemini(apiKey, model, buildGroundedRequest(params, { structured: false }), { stage: 'grounded-text', budget });
  }
  const analysis = analyzeGroundedResponse(grounded, params);
  let recipes = analysis.recipes;
  let normalized = null;
  // Secondo passaggio solo quando serve davvero: testo presente ma non
  // interpretabile (o interpretabile ma senza ricette utilizzabili). Un
  // {"recipes":[]} esplicito non viene rinormalizzato.
  const explicitEmpty = analysis.parsed && analysis.rawCount === 0;
  if (!recipes.length && analysis.text && !explicitEmpty && budget.used < budget.max) {
    normalized = await callGemini(apiKey, model, buildNormalizeRequest(analysis.text, params), { stage: 'normalize', budget });
    recipes = parseRecipesFromResponse(normalized, params.maxRecipes, params.slot, params.excludeNames);
    mode += '+normalize';
  }
  return {
    model,
    mode,
    recipes,
    sources: extractSources(grounded),
    raw: grounded,
    diagnostics: {
      parsed: analysis.parsed || Boolean(normalized && parseRecipesPayload(normalized).ok),
      partial: analysis.partial,
      rawCount: analysis.rawCount,
      explicitEmpty,
      finishReason: analysis.finishReason,
      blockReason: analysis.blockReason,
      groundingQueries: analysis.groundingQueries,
      normalized: Boolean(normalized),
      calls: budget.used,
      usage: usageSummary(grounded)
    }
  };
}

async function generateRecipesContent(env, query, maxRecipes, slot, excludeNames) {
  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new RecipeSearchError(describeGeminiFailure({ reason: 'missing_api_key' }), {
      status: FAILURE_KINDS.missing_api_key.httpStatus,
      code: FAILURE_KINDS.missing_api_key.code,
      reason: 'missing_api_key',
      attempts: []
    });
  }
  registerSecret(apiKey);
  const models = textModelList(env);
  const params = {
    query,
    maxRecipes: clampRecipes(maxRecipes),
    slot: SLOTS.includes(String(slot || '')) ? String(slot) : '',
    excludeNames: (Array.isArray(excludeNames) ? excludeNames : []).filter(Boolean)
  };
  const budget = { used: 0, max: MAX_GEMINI_CALLS_PER_REQUEST };
  const failures = [];
  for (const model of models) {
    if (budget.used >= budget.max) break;
    try {
      const result = await searchRecipesWithModel(apiKey, model, params, budget);
      result.failures = failures.map(publicAttempt);
      return result;
    } catch (error) {
      const failure = error instanceof GeminiError ? error : new GeminiError(String(error?.message || error), {
        model, stage: 'pipeline', reason: 'provider_error', ...FAILURE_KINDS.provider_error, httpStatus: 0, errorStatus: '', providerMessage: String(error?.message || error), details: []
      });
      failures.push(failure);
      logEvent('error', {
        event: 'gemini_error',
        model: failure.model,
        stage: failure.stage,
        reason: failure.reason,
        code: failure.code,
        retryable: failure.retryable,
        httpStatus: failure.httpStatus,
        errorCode: failure.errorCode ?? null,
        errorStatus: failure.errorStatus,
        message: failure.providerMessage,
        details: failure.details,
        quotaZero: failure.quotaZero || false,
        retryAfter: failure.retryAfter || 0,
        quotaViolations: failure.quotaViolations || [],
        callsUsed: budget.used
      });
      if (!failure.retryable) break;
    }
  }
  throw aggregateFailures(failures);
}

// ---------------------------------------------------------------------------
// Endpoint /recipes
// ---------------------------------------------------------------------------

function cleanText(value) {
  return String(value || '').trim().slice(0, MAX_TEXT_FIELD_LENGTH);
}

function errorResponse(error, origin) {
  const status = Number(error?.status) || 502;
  const payload = {
    error: redactSecrets(error?.message || 'Gemini non ha risposto alla ricerca delle ricette.'),
    code: error?.code || ERROR_CODES.GEMINI_UNAVAILABLE,
    reason: error?.reason || 'provider_error'
  };
  if (error?.retryAfter) payload.retryAfter = Number(error.retryAfter);
  if (Array.isArray(error?.attempts) && error.attempts.length) payload.attempts = error.attempts;
  const headers = status === 429 ? { 'retry-after': String(Number(error?.retryAfter) || 60) } : {};
  return json(payload, status, origin, headers);
}

function describeEmptyResult(result) {
  const diagnostics = result.diagnostics || {};
  if (diagnostics.blockReason) {
    return { reason: 'blocked', message: `Google ha bloccato la richiesta (${diagnostics.blockReason}): riformula la ricerca con altri termini.` };
  }
  if (!diagnostics.parsed) {
    const finish = diagnostics.finishReason && diagnostics.finishReason !== 'STOP' ? ` (finishReason ${diagnostics.finishReason})` : '';
    return { reason: 'malformed_response', message: `Gemini (${result.model}) ha risposto in un formato non interpretabile${finish}: riprova, eventualmente con una richiesta più semplice.` };
  }
  if (diagnostics.rawCount > 0) {
    return { reason: 'no_recipes_for_slot', message: 'Le ricette trovate non appartengono al pasto richiesto o erano già state proposte: prova a cambiare pasto, ingredienti o preferenze.' };
  }
  return { reason: 'no_recipes', message: 'Gemini non ha trovato ricette adatte alla richiesta: prova con altri ingredienti o preferenze.' };
}

async function handleRecipes(request, env, origin) {
  let body = {};
  try { body = await request.json(); } catch (_) {}
  const query = cleanText(body?.query);
  if (!query) return json({ error: 'Manca il testo della richiesta di ricetta.', code: 'BAD_REQUEST' }, 400, origin);
  const maxRecipes = clampRecipes(body?.maxRecipes);
  const slot = SLOTS.includes(String(body?.slot || '')) ? String(body.slot) : '';
  const excludeNames = (Array.isArray(body?.excludeNames) ? body.excludeNames : [])
    .map(name => cleanText(name))
    .filter(Boolean)
    .slice(0, MAX_EXCLUDED_NAMES);
  // `guidelines`, `mealStructure` e `alternatives` non vengono più letti né
  // inoltrati al modello: le grammature restano nell'app, che confronta le
  // ricette ricevute e propone le correzioni con un click. I client vecchi
  // possono continuare a inviarli, vengono semplicemente ignorati.

  const startedAt = Date.now();
  let result;
  try {
    result = await generateRecipesContent(env, query, maxRecipes, slot, excludeNames);
  } catch (error) {
    if (!(error instanceof RecipeSearchError)) {
      logEvent('error', { event: 'recipes_unexpected_error', message: String(error?.message || error) });
    }
    return errorResponse(error, origin);
  }

  const diagnostics = result.diagnostics || {};
  if (!result.recipes.length) {
    const outcome = describeEmptyResult(result);
    logEvent('warn', {
      event: 'recipes_empty',
      model: result.model,
      mode: result.mode,
      reason: outcome.reason,
      finishReason: diagnostics.finishReason,
      blockReason: diagnostics.blockReason,
      rawCount: diagnostics.rawCount,
      calls: diagnostics.calls,
      durationMs: Date.now() - startedAt
    });
    return json({ error: outcome.message, code: ERROR_CODES.GEMINI_INVALID_RESPONSE, reason: outcome.reason, model: result.model }, 422, origin);
  }
  logEvent('log', {
    event: 'recipes_ok',
    model: result.model,
    mode: result.mode,
    recipes: result.recipes.length,
    sources: result.sources.length,
    partial: diagnostics.partial,
    groundingQueries: diagnostics.groundingQueries,
    calls: diagnostics.calls,
    usage: diagnostics.usage,
    fallbackFrom: result.failures && result.failures.length ? result.failures.map(failure => `${failure.model}:${failure.reason}`) : undefined,
    durationMs: Date.now() - startedAt
  });
  return json({ recipes: result.recipes, sources: result.sources, model: result.model, mode: result.mode }, 200, origin);
}

// Solo per i test: azzera lo stato in memoria dell'isolate.
function resetWorkerState() {
  requestWindows.clear();
  structuredGroundingSuspendedUntil.clear();
  secretValues.clear();
  cachedJwks = null;
  cachedJwksExpiresAt = 0;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') {
      if (!isAllowedOrigin(origin, env)) return new Response('Origine non autorizzata.', { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (!isAllowedOrigin(origin, env)) return json({ error: 'Origine non autorizzata.', code: 'FORBIDDEN_ORIGIN' }, 403, '');
    const pathname = new URL(request.url).pathname;
    if (pathname !== '/recipes') return json({ error: 'Endpoint non trovato.', code: 'NOT_FOUND' }, 404, origin);
    if (request.method !== 'POST') return json({ error: 'Metodo non consentito.', code: 'METHOD_NOT_ALLOWED' }, 405, origin);

    const authorization = request.headers.get('Authorization') || '';
    if (!authorization.startsWith('Bearer ')) return json({ error: 'Autenticazione richiesta.', code: 'UNAUTHENTICATED' }, 401, origin);

    let claims;
    try {
      claims = await verifyFirebaseIdToken(authorization.slice(7), env);
    } catch (error) {
      logEvent('warn', { event: 'auth_failed', message: String(error?.message || error) });
      return json({ error: error.message || 'Autenticazione non riuscita.', code: 'UNAUTHENTICATED' }, 401, origin);
    }

    const rate = checkRateLimit(claims.sub);
    if (!rate.allowed) {
      return json({
        error: 'Hai raggiunto il limite temporaneo di ricerche del Worker per il tuo account. Riprova più tardi.',
        code: ERROR_CODES.WORKER_RATE_LIMIT,
        reason: 'worker_rate_limit',
        retryAfter: rate.retryAfter
      }, 429, origin, { 'retry-after': String(rate.retryAfter) });
    }

    return handleRecipes(request, env, origin);
  }
};

// Export per i test unitari (node --test): il default export resta l'handler.
export {
  ERROR_CODES,
  FAILURE_KINDS,
  RECIPES_RESPONSE_SCHEMA,
  MAX_GEMINI_CALLS_PER_REQUEST,
  textModelName,
  textModelList,
  classifyGeminiFailure,
  describeGeminiFailure,
  redactSecrets,
  buildGroundedRequest,
  buildNormalizeRequest,
  callGemini,
  recipesSystemInstruction,
  normalizeRecipe,
  parseRecipesPayload,
  parseRecipesFromResponse,
  extractResponseText,
  extractSources,
  searchRecipesWithModel,
  generateRecipesContent,
  handleRecipes,
  resetWorkerState
};
