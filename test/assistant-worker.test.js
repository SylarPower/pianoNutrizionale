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
