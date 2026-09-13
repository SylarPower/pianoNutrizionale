'use strict';
/* Servizio email isolato per gli inviti (ADR 0004).
 *
 * Perché è isolato: gli inviti personalizzati non sono coperti dai template
 * Firebase Auth (che restano usati per verifica email e reset password, senza
 * costi aggiuntivi). L'invio è quindi astratto dietro questo modulo, con tre
 * adapter:
 *
 *  - `none`   nessun provider configurato: la consegna avviene con il link
 *             mostrato alla console ("mostra link"). Non è un errore.
 *  - `memory` adapter di TEST/EMULATORE: accumula i messaggi in memoria
 *             (`memoryOutbox`) senza inviare nulla. Rifiutato in produzione.
 *  - `resend` provider HTTP transazionale configurato via variabili
 *             d'ambiente (Secret Manager / GitHub Actions Secrets). Nessuna
 *             chiave sta nel repository.
 *
 * Regole di sicurezza:
 *  - nessun token, nessuna password e nessun indirizzo completo nei log;
 *  - un invio fallito NON è mai dichiarato "inviato": `sendInviteEmail`
 *    restituisce `{ ok: false }` con la causa e il chiamante la registra
 *    nello stato di consegna dell'invito.
 */

const { maskEmail } = require('./domain');

const EMAIL_PROVIDERS = new Set(['none', 'memory', 'resend']);
const DEFAULT_RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Casella in memoria dell'adapter di test: usata dai test automatici e
// dall'emulatore per verificare il contenuto dell'invito senza inviare email.
const memoryOutbox = [];

function resetMemoryOutbox() {
  memoryOutbox.length = 0;
}

function currentEnv(env) {
  if (env) return env;
  return (typeof process !== 'undefined' && process.env) ? process.env : {};
}

function isEmulatorEnv(env) {
  return Boolean(env.FIRESTORE_EMULATOR_HOST || env.FUNCTIONS_EMULATOR);
}

// Configurazione risolta dalle variabili d'ambiente. `provider` non valido o
// incompleto => `configured: false` con la causa in italiano: il chiamante
// deve fallire in modo esplicito quando serve davvero l'invio.
function resolveEmailConfig(envOverride) {
  const env = currentEnv(envOverride);
  const isEmulator = isEmulatorEnv(env);
  const provider = String(env.INVITE_EMAIL_PROVIDER || '').trim().toLowerCase()
    || (isEmulator ? 'memory' : 'none');
  if (!EMAIL_PROVIDERS.has(provider)) {
    return {
      provider: 'invalid', configured: false, isEmulator,
      error: `Provider email non riconosciuto ("${provider}"): valori ammessi none, memory, resend`
    };
  }
  if (provider === 'memory' && !isEmulator) {
    return {
      provider: 'invalid', configured: false, isEmulator,
      error: 'L\'adapter email di test (memory) non è utilizzabile in produzione: configura un provider reale oppure consegna il link a mano'
    };
  }
  if (provider === 'memory') {
    // Adapter di test: nessun invio reale, i messaggi restano in memoria.
    return { provider: 'memory', configured: false, isEmulator };
  }
  if (provider === 'resend') {
    const apiKey = String(env.INVITE_EMAIL_API_KEY || '').trim();
    const from = String(env.INVITE_EMAIL_FROM || '').trim();
    if (!apiKey || !from) {
      return {
        provider: 'invalid', configured: false, isEmulator,
        error: 'Invio email non configurato: imposta INVITE_EMAIL_API_KEY e INVITE_EMAIL_FROM (Secret Manager), vedi docs/inviti-email.md'
      };
    }
    return {
      provider, configured: true, isEmulator, apiKey, from,
      endpoint: String(env.INVITE_EMAIL_ENDPOINT || '').trim() || DEFAULT_RESEND_ENDPOINT
    };
  }
  return { provider: 'none', configured: false, isEmulator };
}

// URL pubblico dell'app: base per i link di invito. Configurabile con
// APP_PUBLIC_URL (es. https://utente.github.io/pianoNutrizionale).
function publicAppUrl(envOverride) {
  const env = currentEnv(envOverride);
  const raw = String(env.APP_PUBLIC_URL || 'https://sylarpower.github.io/pianoNutrizionale').trim();
  return raw.replace(/\/+$/, '');
}

function buildInviteLink(baseUrl, token) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('URL pubblico dell\'app non configurato (APP_PUBLIC_URL)');
  return `${base}/#/invito/${token}`;
}

function inviteExpiryDate({ days = 7, now = new Date() } = {}) {
  return new Date(now.getTime() + days * 24 * 3600 * 1000);
}

function inviteEmailContent({ firstName, lastName, organizationName, nutritionistName, link, expiresAt }) {
  const nome = [firstName, lastName].filter(Boolean).join(' ');
  const studio = organizationName || 'Piano Nutrizionale';
  const chi = nutritionistName ? `${nutritionistName} (${studio})` : studio;
  const scadenza = expiresAt ? new Date(expiresAt).toLocaleDateString('it-IT') : null;
  const subject = `${studio}: crea il tuo account personale`;
  const lines = [
    `Ciao ${firstName || ''},`.trim(),
    '',
    `${chi} ti ha invitato a creare il tuo account personale su ${studio}.`,
    'Con l\'account scegli tu la password e potrai verificare l\'indirizzo email, recuperare la password e vedere i contenuti condivisi dal tuo nutrizionista.',
    '',
    `Completa la registrazione da questo link personale e monouso: ${link}`,
    scadenza ? `Il link scade il ${scadenza}.` : null,
    '',
    'L\'email e i tuoi dati anagrafici sono stati inseriti dal tuo nutrizionista: se non sono corretti, contattalo e chiedi la correzione dell\'invito.',
    '',
    'Se non hai richiesto tu questo invito, puoi ignorare il messaggio: nessun account verrà creato senza di te.',
    `${studio}`
  ].filter(line => line !== null);
  return {
    subject,
    text: lines.join('\n'),
    html: lines.map(line => (line === '' ? '<br>' : `<p>${escapeHtml(line)}</p>`)).join('')
  };
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Invio dell'invito. Restituisce sempre un risultato strutturato, MAI
// un'eccezione non gestita, così lo stato di consegna resta coerente.
async function sendInviteEmail(message, options = {}) {
  const config = options.config || resolveEmailConfig();
  const logger = options.logger || (typeof console !== 'undefined' ? console : { info() {}, warn() {} });
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const recipientMasked = maskEmail(message?.to);
  const content = inviteEmailContent(message || {});

  if (config.provider === 'memory') {
    // Nessun invio reale: il messaggio resta in memoria per test/emulatore.
    memoryOutbox.push({
      to: message.to, subject: content.subject, text: content.text,
      link: message.link, sentAt: new Date().toISOString(), provider: 'memory'
    });
    logger.info('Invito email (adapter di test in memoria)', { to: recipientMasked });
    return { ok: true, provider: 'memory', messageId: `memoria-${memoryOutbox.length}` };
  }
  if (!config.configured) {
    return {
      ok: false, provider: config.provider || 'none', code: 'not-configured',
      message: config.error || 'Invio email non configurato: consegna il link a mano oppure configura un provider'
    };
  }
  if (!fetchImpl) {
    return { ok: false, provider: config.provider, code: 'not-configured', message: 'Ambiente senza client HTTP: invio email non disponibile' };
  }
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        from: config.from,
        to: [message.to],
        subject: content.subject,
        text: content.text,
        html: content.html
      })
    });
    if (!response?.ok) {
      const status = response?.status || 0;
      logger.warn('Invio invito rifiutato dal provider', { status, to: recipientMasked, provider: config.provider });
      return {
        ok: false, provider: config.provider, code: 'provider-error', status,
        message: `Il provider email ha rifiutato l'invio (codice ${status}): l'invito resta pendente, riprova o consegna il link a mano`
      };
    }
    const payload = await response.json().catch(() => ({}));
    logger.info('Invito email inviato', { to: recipientMasked, provider: config.provider, messageId: payload?.id || null });
    return { ok: true, provider: config.provider, messageId: payload?.id || null };
  } catch (error) {
    logger.warn('Invio invito non riuscito', { to: recipientMasked, provider: config.provider, code: error?.code || 'network' });
    return {
      ok: false, provider: config.provider, code: 'network',
      message: 'Invio email non riuscito per un problema di rete: l\'invito resta pendente, riprova o consegna il link a mano'
    };
  }
}

module.exports = {
  EMAIL_PROVIDERS,
  DEFAULT_RESEND_ENDPOINT,
  memoryOutbox,
  resetMemoryOutbox,
  resolveEmailConfig,
  publicAppUrl,
  buildInviteLink,
  inviteExpiryDate,
  inviteEmailContent,
  sendInviteEmail
};
