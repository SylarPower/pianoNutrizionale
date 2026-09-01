/* Configurazione pubblica dell'assistente vocale.
 *
 * Questo file NON deve contenere la chiave Gemini. L'URL del Worker è un
 * endpoint pubblico, mentre la chiave resta nel secret GEMINI_API_KEY del
 * Worker Cloudflare.
 */
window.PIANO_AI_CONFIG = Object.freeze({
  // Dopo il deploy del Worker inserisci qui il suo URL /token, per esempio:
  // https://piano-nutrizionale-ai.<account>.workers.dev/token
  tokenEndpoint: "https://piano-nutrizionale-ai.sylarpower.workers.dev/token",
  // Modello Live verificato/configurabile dal Worker. Non è una chiave segreta.
  model: "gemini-3.1-flash-live-preview",
  // Modello di riserva: se Gemini rifiuta il principale (1011 quota gratuita
  // esaurita oppure 1008 modello ritirato), l'assistente riprova da solo con
  // questo modello, ancora disponibile sul free tier. Il Worker deve
  // esporlo in GEMINI_LIVE_FALLBACK_MODEL. Con "" il fallback è disattivato.
  fallbackModel: "gemini-2.5-flash-native-audio-preview-12-2025",
  language: "it-IT",
  voiceName: "Aoede",
  sessionMinutes: 30,
  // Il Worker può essere pubblicato sia su GitHub Pages sia su Firebase Hosting.
  // L'elenco effettivo delle origini autorizzate si configura nel Worker.
  allowGoogleSearch: true
});
