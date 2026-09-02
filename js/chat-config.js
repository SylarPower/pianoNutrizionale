/* Configurazione pubblica della chat AI.
 *
 * Questo file NON deve contenere alcuna chiave. L'URL del Worker è un
 * endpoint pubblico, mentre la chiave Gemini resta nel secret GEMINI_API_KEY
 * del Worker Cloudflare.
 */
window.PIANO_AI_CONFIG = Object.freeze({
  // Endpoint del Worker per la ricerca di NUOVE ricette dal web (Google Search
  // grounding). Dopo il deploy del Worker inserisci qui il suo URL /recipes:
  // https://piano-nutrizionale-ai.<account>.workers.dev/recipes
  recipesEndpoint: "https://piano-nutrizionale-ai.sylarpower.workers.dev/recipes",
  language: "it-IT",
  // Numero massimo di ricette candidate restituite dalla ricerca web.
  maxRecipes: 10
});
