# Ricerca ricette online

L'AI di Piano Nutrizionale serve **solo a trovare nuove ricette dal web**: non
esiste più alcuna chat, né risposte generaliste, né voce in-app.

## Come si usa

1. Apri il **Ricettario** e tocca il pulsante **🌐 Cerca nel web** (primo
   pulsante della barra strumenti; è presente anche nello stato vuoto e nelle
   Impostazioni).
2. Compila il form della modale:
   - **Ingredienti essenziali** (obbligatorio) — es. `pollo, riso, zucchine`;
   - **Tipo di pasto** (obbligatorio) — colazione, spuntino mattina, pranzo,
     spuntino pomeriggio, cena (default: pranzo);
   - **Preferenze** (facoltativo) — es. `veloce`, `senza glutine`, `al forno`.
3. Premi **🔎 Cerca**: il Worker interroga Gemini con Google Search grounding e
   restituisce **fino a 10 ricette** del pasto scelto, aderenti alle grammature
   del dott. Meller.
4. Tocca una scheda (mouse, `Invio` o `Spazio`): si apre il **popup ricetta
   classico** già in modalità modifica, con ingredienti, preparazione e la fonte
   nelle note. Salvi con il normale pulsante **Salva nel cloud**.
5. Il pulsante **↻ Altre 10 ricette** ripete la ricerca **escludendo le ricette
   già mostrate**; **← Modifica ricerca** riporta al form.

## Grammature del dott. Meller

Il flusso Meller resta invariato: le ricette importate, nuove o modificate che
non rispettano le grammature del manuale per pasto e giorno A/R vengono
**segnalate** (banner nel popup e badge ⚠ nel ricettario) e si correggono con un
click su **"Adatta a Meller"**.

### Una sola fonte, frontend e Worker

`js/domain.js` (`MELLER_GRAMMATURE`) è la **fonte unica** di famiglie e
grammature. Da lì derivano:

- le tabelle delle alternative dei popup e delle Impostazioni (`MELLER_GUIDE`);
- il riconoscimento carboidrati/proteine degli ingredienti
  (`isMellerCarbIngredient` / `isMellerProteinIngredient`);
- i massimi per porzione (`mellerGuidelinesText()`) e la struttura dei pasti
  (`mellerMealStructureText()`);
- **`mellerAlternativesText()`**: il testo completo con tutte le famiglie di
  carboidrati (pranzo allenamento, pranzo riposo, cena) e tutte le categorie
  proteiche, più le regole del manuale (pesi a crudo, cena = ~2/3 del pranzo di
  riposo arrotondato per difetto alla decina, cena A = cena R, proteine
  invariate tra pranzo e cena).

Il Worker Cloudflare **importa lo stesso file**
(`import PianoDomain from '../../../js/domain.js'`): usa il campo `alternatives`
inviato dal frontend e, se il campo manca, un fallback **generato dalla stessa
fonte**, quindi identico. Nel Worker non esiste più alcuna lista parziale
hardcoded (la vecchia costante `DEFAULT_GUIDELINES` è stata rimossa).

Il prompt di sistema dice esplicitamente al modello:

```text
Usa esclusivamente le grammature Meller fornite.
A cena sono ammessi tutti i carboidrati presenti nella tabella, non solo pane, crackers e patate.
Per i carboidrati usa la dose cena indicata nella tabella.
Non trasformare le proteine secondo la regola dei carboidrati.
Mantieni le dosi proteiche indicate dal manuale.
```

Il test `test/web-search-worker.test.js` confronta programmaticamente le
famiglie presenti nei popup, nelle grammature canoniche, nel testo AI e nel
fallback del Worker: se una famiglia manca in una sola superficie il test
fallisce.

## Architettura

- `js/web-search-config.js` — configurazione pubblica (URL del Worker, lingua,
  numero massimo di ricette).
- `js/web-search.js` — modale e logica di ricerca (`window.PianoWebSearch`):
  form, chiamata al Worker, schede risultato, "Altre 10 ricette".
- `js/app.js` — `importRecipeFromWebSearch(recipe)` riusa il popup ricetta
  esistente per l'importazione.
- `js/domain.js` — fonte unica delle grammature Meller (`MELLER_GRAMMATURE`,
  `MELLER_GUIDE`, `mellerAlternativesText()`, `checkMellerAdaptation`,
  `adaptRecipeToMeller`) usata da popup, ricettario e Worker.
- `cloudflare/ai-worker` — Worker con un solo endpoint `POST /recipes` che
  interroga Gemini (modello `gemini-3.6-flash` di default) con Google Search
  grounding e restituisce le ricette candidate; importa `js/domain.js`, quindi
  condivide col frontend la stessa fonte Meller.

### Body della richiesta `POST /recipes`

```json
{
  "query": "ricetta con pollo, riso per pranzo — veloce",
  "slot": "lunch",
  "language": "it-IT",
  "maxRecipes": 10,
  "excludeNames": ["Pollo al curry"],
  "alternatives": "…testo completo delle alternative Meller (tutte le famiglie)…",
  "guidelines": "…massimi Meller per porzione…",
  "mealStructure": "…struttura dei pasti…"
}
```

`alternatives`, `guidelines` e `mealStructure` derivano tutti da
`js/domain.js`: `alternatives` è il campo completo usato nel prompt, gli altri
due restano per compatibilità. Se `alternatives` manca, il Worker usa il
fallback generato dalla stessa fonte.

Il Worker filtra le ricette restituite tenendo solo quelle dello `slot`
richiesto e ne restituisce al massimo 10, insieme alle fonti.

### Fallback automatico del modello

Il Worker prova i modelli in ordine: `gemini-3.6-flash` (o `GEMINI_TEXT_MODEL`),
poi `gemini-3.5-flash`, `gemini-3.1-flash-lite`, `gemini-2.5-flash-lite`. Se un
modello risponde 429/404 o segnala quota, fatturazione, modello deprecato o non
disponibile, si passa automaticamente al successivo. Se falliscono tutti, l'app
mostra: *"La quota gratuita di Gemini è esaurita oppure la fatturazione del
progetto Google non è attiva…"*.

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
3. Non copiarla in `index.html`, `js/web-search.js`, `js/web-search-config.js` o in Git.
4. Tienila pronta per `wrangler secret put`.

### 2. Crea e pubblica il Worker

Il Worker espone un solo endpoint: `POST /recipes`.

> ⚠️ Il Worker importa il modulo condiviso `js/domain.js` (fonte unica delle
> grammature Meller): la pubblicazione va fatta con **`npx wrangler deploy`**
> dalla root del repository (o da `cloudflare/ai-worker`), così il bundler
> include il modulo. Il copia-incolla del solo `index.js` nella dashboard non è
> più sufficiente.

**Dalla dashboard Cloudflare** (percorso senza terminale, solo se ricrei il
modulo condiviso):

1. Vai in **Workers & Pages → Create application → Worker**.
2. Nome esattamente `piano-nutrizionale-ai`.
3. Sostituisci il codice con il contenuto di
   `cloudflare/ai-worker/src/index.js` **e** aggiungi il modulo
   `js/domain.js` con il percorso relativo atteso dall'import
   (`../../../js/domain.js`); in alternativa usa `npx wrangler deploy`.
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
npx wrangler deploy   # include nel bundle anche js/domain.js (fonte unica Meller)
```

Per provare in locale: `npx wrangler dev` (il server locale non va inserito
nella configurazione pubblica).

### 3. Inserisci l'URL nella PWA

Apri `js/web-search-config.js` e valorizza l'URL pubblico del Worker:

```js
window.PIANO_WEB_SEARCH_CONFIG = Object.freeze({
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

A cena è ammesso **qualsiasi carboidrato della tabella**, non solo pane,
crackers e patate: la dose cena è `floor(pranzo riposo × 2/3 / 10) × 10` ed è
uguale nei giorni di allenamento e di riposo (pane 60 g, crackers 40 g, patate
230 g, polenta 220 g, piadina 50 g, pasta/riso 40 g, gnocchi 120 g, farro/orzo
40 g, quinoa/grano saraceno/amaranto 40 g, cous cous 40 g). Le proteine
mantengono a cena la stessa dose del pranzo e non vengono mai trasformate.

- `checkMellerAdaptation(recipe)` → segnala le dosi che superano il riferimento.
- `adaptRecipeToMeller(recipe)` → riporta le dosi fuori riferimento al valore
  del manuale (un click), lasciando invariate quelle già corrette.

## Sicurezza e privacy

- il Worker accetta solo `POST /recipes` da origini configurate e verifica il
  Firebase ID token prima di interrogare Gemini;
- l'app non salva cronologie delle ricerche;
- il contesto inviato al modello è la sola richiesta di ricetta dell'utente;
- il free tier Gemini è soggetto alle condizioni Google sull'uso dei dati per
  migliorare i prodotti.

## Problemi comuni

### `Per cercare ricette dal web serve il Worker Cloudflare`
`recipesEndpoint` in `js/web-search-config.js` è vuoto o errato. L'URL deve
terminare con `/recipes`.

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
su <https://aistudio.google.com/rate-limit>. Il Worker prova prima tutti i
modelli di fallback: solo se falliscono tutti mostra l'errore sulla quota.
