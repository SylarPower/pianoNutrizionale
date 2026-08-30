/*
 * Cloudflare Worker: broker gratuito per token temporanei Gemini Live.
 *
 * Il Worker non fa da proxy per l'audio: autentica l'utente Firebase, chiede a
 * Gemini un token a breve durata e lo restituisce alla PWA. La GEMINI_API_KEY
 * resta quindi in un secret Cloudflare e non entra mai nel frontend.
 */

const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const GEMINI_TOKEN_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
const DEFAULT_MODEL = 'gemini-3.1-flash-live-preview';
const MAX_TOKEN_MINUTES = 30;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_TOKEN_REQUESTS_PER_WINDOW = 6;

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

async function createEphemeralToken(env) {
  const now = Date.now();
  const expiresAt = new Date(now + MAX_TOKEN_MINUTES * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(now + 60 * 1000).toISOString();
  const model = modelName(env);
  const requestBody = {
    uses: 1,
    expireTime: expiresAt,
    newSessionExpireTime,
    liveConnectConstraints: {
      model: `models/${model}`,
      config: {
        responseModalities: ['AUDIO'],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        sessionResumption: {},
        contextWindowCompression: { slidingWindow: {} }
      }
    }
  };

  const response = await fetch(GEMINI_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': String(env.GEMINI_API_KEY || '')
    },
    body: JSON.stringify(requestBody)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error?.message || body?.message || 'Gemini non ha emesso il token.';
    throw new Error(detail);
  }
  const token = body.name || body.token?.name || body.token || body.accessToken;
  if (!token) throw new Error('Risposta Gemini senza token temporaneo.');
  return { token, expiresAt, model };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') {
      if (!isAllowedOrigin(origin, env)) return new Response('Origine non autorizzata.', { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (!isAllowedOrigin(origin, env)) return json({ error: 'Origine non autorizzata.' }, 403, '');
    if (new URL(request.url).pathname !== '/token') return json({ error: 'Endpoint non trovato.' }, 404, origin);
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
      return new Response(JSON.stringify({ error: 'Hai raggiunto il limite temporaneo di avvii dell’assistente. Riprova più tardi.' }), {
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
      const token = await createEphemeralToken(env);
      return json(token, 200, origin);
    } catch (error) {
      console.error(error);
      return json({ error: error.message || 'Gemini non disponibile in questo momento.' }, 502, origin);
    }
  }
};
