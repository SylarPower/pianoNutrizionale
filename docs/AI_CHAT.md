# Chat AI — assistente testuale

La chat AI di Piano Nutrizionale è **solo testuale**: un pulsante fluttuante apre
una chat in cui puoi scrivere (o dettare con il microfono della tastiera nativa
del telefono/browser). Non esiste più alcun riconoscimento o sintesi vocale
in-app né Gemini Live.

## Cosa fa

- **Domande sulla webapp** (piano della settimana, singolo pasto, lista della
  spesa, batch cooking, guida e alternative di Meller, account): risposte
  calcolate **localmente dai dati dell'app**, senza alcuna chiamata AI esterna,
  gratis e funzionanti anche offline.
- **Nuove ricette dal web**: l'unica richiesta che esce verso internet. Scrivi
  ad esempio *"ricetta con pollo e riso"* o *"ricette con orata"*: l'AI cerca
  sul web e propone **fino a 10 ricette pertinenti**. Ogni proposta si apre nel
  popup classico con ingredienti e preparazione e può essere importata nel
  ricettario con il normale pulsante di salvataggio.
- **Grammature del dott. Meller**: le ricette importate, nuove o modificate che
  non rispettano le grammature del manuale per il proprio pasto e giorno A/R
  vengono **segnalate** (banner nel popup e badge ⚠ nel ricettario) e si
  correggono con un click su **"Adatta a Meller"**.

La chat non esegue modifiche: è in sola lettura. Le correzioni restano manuali.

## Architettura

- `js/chat-domain.js` — dominio puro: interpreta il testo italiano e risolve
  giorno/pasto/intento senza DOM né rete.
- `js/chat.js` — interfaccia e motore della chat (`window.PianoChat`), risposte
  locali e chiamata al Worker per la ricerca di ricette.
- `js/chat-config.js` — configurazione pubblica (URL del Worker).
- `js/domain.js` — grammature Meller (`checkMellerAdaptation`,
  `adaptRecipeToMeller`) usate da popup e ricettario.
- `cloudflare/ai-worker` — Worker con un solo endpoint `POST /recipes`
  che interroga Gemini (API testuale, modello `gemini-3.6-flash` di default) con
  Google Search grounding e restituisce le ricette candidate.

## Configurazione gratuita

Sono due quote separate e gratuite:

1. **Cloudflare Workers Free** — ospita l'endpoint `/recipes`.
2. **Gemini API free tier** — esegue la ricerca di ricette con Google Search
   grounding (modello Flash, quote del progetto Google AI Studio).

Nessun acquisto automatico: se il provider rifiuta una richiesta l'app mostra
un errore comprensibile.

### 1. Crea la chiave Gemini

1. Apri [Google AI Studio](https://aistudio.google.com/apikey).
2. Crea una API key per il progetto desiderato.
3. Non copiarla in `index.html`, `js/chat.js`, `js/chat-config.js` o in Git.
4. Tienila pronta per `wrangler secret put`.

### 2. Crea e pubblica il Worker

Il Worker espone un solo endpoint: `POST /recipes`.

**Dalla dashboard Cloudflare** (percorso senza terminale):

1. Vai in **Workers & Pages → Create application → Worker**.
2. Nome esattamente `piano-nutrizionale-ai`.
3. Sostituisci il codice con il contenuto di
   `cloudflare/ai-worker/src/index.js`.
4. In **Settings → Variables and Secrets → Add** (ambiente **Production**):

   | Tipo | Nome | Valore |
   | --- | --- | --- |
   | Text | `FIREBASE_PROJECT_ID` | `piano-nutrizionale` |
   | Text | `GEMINI_TEXT_MODEL` | `gemini-3.6-flash` |
   | Text | `ALLOWED_ORIGINS` | `https://sylarpower.github.io,http://localhost:8000,http://127.0.0.1:8000,https://piano-nutrizionale.web.app` |
   | **Secret** | `GEMINI_API_KEY` | la chiave Gemini, incollata nel campo segreto |

   `GEMINI_API_KEY` deve essere di tipo **Secret**. Nessuna virgoletta, spazio o
   `Bearer` nel valore.
5. Salva e **Deploy**. Abilita il sottodominio `workers.dev` se richiesto.
6. Copia l'indirizzo `https://piano-nutrizionale-ai.<account>.workers.dev`.

Aprire l'indirizzo senza `/recipes` e ricevere `Endpoint non trovato` è normale.
L'endpoint richiede `Authorization: Bearer <idToken Firestore>` e applica un
limite best-effort di 30 richieste ogni 15 minuti per utente.

**Da terminale** (Node 18+):

```bash
cd cloudflare/ai-worker
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

Per provare in locale: `npx wrangler dev` (il server locale non va inserito
nella configurazione pubblica).

### 3. Inserisci l'URL nella PWA

Apri `js/chat-config.js` e valorizza l'URL pubblico del Worker:

```js
window.PIANO_AI_CONFIG = Object.freeze({
  recipesEndpoint: "https://piano-nutrizionale-ai.<account>.workers.dev/recipes",
  language: "it-IT",
  maxRecipes: 10
});
```

L'URL non è un segreto. La chiave Gemini resta solo nel secret Cloudflare.
Dopo la modifica incrementa `CACHE_VERSION` in `sw.js` prima del deploy.

### 4. Origini autorizzate

Nel file `cloudflare/ai-worker/wrangler.toml`, `ALLOWED_ORIGINS` contiene
gli indirizzi previsti: usa solo l'origine, senza percorso e senza slash finale.
Aggiungi il tuo dominio personale se lo userai e ripubblica con
`npx wrangler deploy`.

## Grammature Meller

La tabella in `js/domain.js` (`MELLER_GRAMMATURE`) riporta i valori a crudo del
manuale per **pasto e giorno A/R** (es. pasta 90 g a pranzo A / 70 g a pranzo R,
pane 120/90 g a pranzo, 60 g a cena, pollame 200 g, pesce 250 g, legumi 240 g,
olio EVO 10 g…). Verdura e alimenti liberi non vengono mai segnalati, così come
i "q.b." e le quantità non esprimibili in grammi.

- `checkMellerAdaptation(recipe)` → segnala le dosi che superano il riferimento.
- `adaptRecipeToMeller(recipe)` → riporta le dosi fuori riferimento al valore
  del manuale (un click), lasciando invariate quelle già corrette.

## Sicurezza e privacy

- il Worker accetta solo `POST /recipes` da origini configurate e verifica il
  Firebase ID token prima di interrogare Gemini;
- l'app non salva audio, cronologie della chat o trascrizioni;
- il contesto inviato al modello è la sola richiesta di ricetta dell'utente;
- il free tier Gemini è soggetto alle condizioni Google sull'uso dei dati per
  migliorare i prodotti.

## Problemi comuni

### `Per cercare nuove ricette serve il Worker Cloudflare`
`recipesEndpoint` in `js/chat-config.js` è vuoto o errato. L'URL deve terminare
con `/recipes`. Le domande su piano, ricette e spesa funzionano comunque.

### `Origine non autorizzata`
L'origine aperta nel browser non compare in `ALLOWED_ORIGINS`, oppure c'è uno
slash/percorso di troppo. Modifica `wrangler.toml` e ripubblica.

### `Autenticazione richiesta`
L'utente non è autenticato o la sessione Firebase è scaduta. Esci e accedi di
nuovo.

### `Non sono riuscito a trovare ricette valide` (422)
Il Worker ha interpellato Gemini ma non ha ricevuto la chiamata `search_recipes`
o nessuna ricetta valida. Riprova con una richiesta diversa; verifica che
`GEMINI_TEXT_MODEL` sia impostato e che la chiave abbia accesso all'API
testuale con Google Search grounding.

### Quota gratuita esaurita
La webapp non effettua acquisti automatici. Verifica uso e limiti del progetto
su <https://aistudio.google.com/rate-limit>; le domande sulla webapp restano
sempre disponibili perché non usano Gemini.
