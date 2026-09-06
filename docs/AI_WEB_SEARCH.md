# Ricerca ricette online

L'AI di Piano Nutrizionale serve **solo a trovare nuove ricette dal web**: non
esiste più alcuna chat, né risposte generaliste, né voce in-app.

Il principio è la **separazione dei ruoli**:

| Chi | Cosa fa |
| --- | --- |
| Il modello (Gemini + Google Search) | Trova sul web le **10 ricette più pertinenti** e le riporta **con le dosi originali della fonte**. Non conosce le grammature del dott. Meller. |
| L'app | Confronta le ricette trovate con le grammature Meller, **mostra le discrepanze** e le **corregge con un click**, sulla singola ricetta o su tutte. |

Il vantaggio è duplice: le ricerche restano fedeli alle ricette reali (nessuna
riscrittura inventata dal modello) e il Worker resta un **file singolo senza
dipendenze**, pubblicabile dalla dashboard Cloudflare con un copia-incolla.

## Come si usa

1. Apri il **Ricettario** e tocca il pulsante **🌐 Cerca nel web** (primo
   pulsante della barra strumenti; è presente anche nello stato vuoto).
2. Compila il form della modale:
   - **Ingredienti essenziali** (obbligatorio) — es. `pollo, riso, zucchine`;
   - **Tipo di pasto** (obbligatorio) — colazione, spuntino mattina, pranzo,
     spuntino pomeriggio, cena (default: pranzo);
   - **Preferenze** (facoltativo) — es. `veloce`, `senza glutine`, `al forno`.
3. Premi **🔎 Cerca**: il Worker interroga Gemini con Google Search grounding e
   restituisce le **prime 10 ricette per rilevanza e attinenza** al pasto scelto,
   con le dosi così come le riporta la fonte.
4. Su ogni scheda l'app segnala le dosi che **non rispettano le grammature
   Meller** (`300 g → 200 g`) e offre **Correggi dosi Meller** per allinearle con
   un click. Il pulsante **✓ Correggi tutte (Meller)** lo fa su tutte insieme.
5. Importa come preferisci:
   - **una alla volta** — tocca la scheda: si apre il **popup ricetta classico**
     già in modalità modifica, con ingredienti, preparazione e la fonte nelle
     note. Salvi con il normale **Salva nel cloud**;
   - **in blocco** — **⤓ Importa tutte (10)** aggiunge tutte le ricette mostrate
     al ricettario in una sola scrittura, **insieme a quelle esistenti** (gli id
     duplicati vengono rinominati come nell'import da file).
6. Il pulsante **↻ Altre 10 ricette** ripete la ricerca **escludendo le ricette
   già mostrate**; **← Modifica ricerca** riporta al form.

## Grammature del dott. Meller

Le grammature vivono **solo nell'app**, in `js/domain.js`
(`MELLER_GRAMMATURE`), che resta la **fonte unica**. Da lì derivano:

- le tabelle delle alternative dei popup e delle Impostazioni
  (`mellerAlternativeGroups(dayType)`, `MELLER_GUIDE`);
- il riconoscimento carboidrati/proteine degli ingredienti
  (`isMellerCarbIngredient` / `isMellerProteinIngredient`);
- la verifica delle ricette (`checkMellerAdaptation`) e la correzione con un
  click (`adaptRecipeToMeller`), usate sia nel ricettario sia nei risultati
  della ricerca online.

Il flusso resta lo stesso per tutte le ricette, da qualunque origine: quelle
importate, nuove o modificate che non rispettano il manuale per pasto e giorno
A/R vengono **segnalate** (banner nel popup, badge ⚠ nel ricettario, avviso
sulla scheda di ricerca) e si correggono con **"Adatta a Meller"**.

> Una ricetta trovata sul web ha **una sola dose** per ingrediente, mentre il
> manuale distingue allenamento e riposo: nella ricerca si applica il
> riferimento **più restrittivo** (es. riso 70 g), così la dose va bene in
> entrambe le giornate. Nel popup, invece, la ricetta ha quattro porzioni e ogni
> giornata viene adattata al proprio valore.

### Cosa riceve il modello

Il prompt di sistema **non contiene grammature**. Chiede soltanto:

```text
Usa Google Search per trovare ricette reali adatte alla richiesta dell’utente.
Proponi fino a 10 ricette in italiano, ordinate dalla più pertinente: contano
l’aderenza agli ingredienti richiesti e al tipo di pasto.
Riporta gli ingredienti e le dosi COSÌ COME sono indicati dalla fonte, per una
persona: non riscalare, non arrotondare, non adattare le quantità ad alcuna dieta.
Preferisci ricette di fonti diverse tra loro ed evita varianti quasi identiche
della stessa ricetta.
```

Il test `test/web-search-worker.test.js` verifica che nel Worker non compaia
alcuna grammatura, che il prompt non nomini mai Meller e che il frontend non
invii i campi `alternatives` / `guidelines` / `mealStructure`.

## Architettura

- `js/web-search-config.js` — configurazione pubblica (URL del Worker, lingua,
  numero massimo di ricette).
- `js/web-search.js` — modale e logica di ricerca (`window.PianoWebSearch`):
  form, chiamata al Worker, schede risultato, **confronto Meller e correzione
  con un click**, importazione singola e in blocco, "Altre 10 ricette".
- `js/app.js` — `importRecipeFromWebSearch(recipe)` (popup, una ricetta) e
  `importRecipesFromWebSearchBulk(list)` (import in blocco tramite
  `PianoDomain.mergeRecipeCatalogs`).
- `js/domain.js` — fonte unica delle grammature Meller (`MELLER_GRAMMATURE`,
  `MELLER_GUIDE`, `mellerAlternativeGroups`, `checkMellerAdaptation`,
  `adaptRecipeToMeller`).
- `cloudflare/ai-worker` — Worker con un solo endpoint `POST /recipes` che
  interroga Gemini (modello `gemini-3.5-flash-lite` di default) con Google
  Search grounding e **output JSON strutturato** (`responseMimeType:
  application/json` + `responseSchema`). **Nessun import di file locali**: è un
  file autosufficiente.

### Body della richiesta `POST /recipes`

```json
{
  "query": "ricetta con pollo, riso per pranzo — veloce",
  "slot": "lunch",
  "language": "it-IT",
  "maxRecipes": 10,
  "excludeNames": ["Pollo al curry"]
}
```

Nessun campo dietetico: la richiesta contiene solo i criteri dell'utente. Il
Worker filtra le ricette restituite tenendo solo quelle dello `slot` richiesto e
ne restituisce al massimo 10, insieme alle fonti.

### Come il Worker interroga Gemini

Una sola chiamata `generateContent` con:

- `tools: [{ googleSearch: {} }]` — **solo** Google Search grounding. La vecchia
  combinazione `googleSearch` + `functionDeclarations` (function call
  `search_recipes`) è stata rimossa: non va reintrodotta senza prova documentata
  e testata che l'API la supporti, perché produceva risposte senza function call
  e quindi 502/422 a catena.
- `generationConfig.responseMimeType: "application/json"` +
  `generationConfig.responseSchema` con lo schema `recipes[] { name, slot,
  emoji, ingredients[] { name, quantity }, steps[], notes[], sourceUrl,
  sourceTitle }`. La documentazione Gemini (sezione *Structured outputs with
  tools*) indica che sui modelli Gemini 3 l'output strutturato è combinabile con
  Google Search; `gemini-3.5-flash-lite` e `gemini-3.1-flash-lite` dichiarano
  supporto sia a *Search grounding* sia a *Structured outputs*.
- Chiave API nell'header `x-goog-api-key` (mai nell'URL `?key=`), nessun
  `temperature`/`topP`/`topK` (deprecati da Google per Gemini 3).

**Variante in due passaggi.** Se Google risponde che grounding e JSON
strutturato non sono ammessi insieme (es. *"Tool use with a response mime type:
'application/json' is unsupported"*, `structured_grounding_unsupported`), il
Worker ripete la chiamata grounded chiedendo testo libero/JSON e, se il testo
non è già JSON valido, esegue una seconda chiamata **senza grounding** che
normalizza quel testo nello schema. L'esito viene ricordato per modello per 6
ore (`mode: "grounded-text"` o `"grounded-text+normalize"` nella risposta). Le
fonti provengono sempre e solo da `groundingMetadata.groundingChunks`: il Worker
non inventa URL e scarta quelli non `http(s)`.

**Parsing tollerante.** `parseRecipesFromResponse()` legge il JSON nel testo
della risposta (diretto, dentro un code fence ```` ```json ````, immerso nel
testo, array puro, risposta già oggetto) e recupera le ricette complete anche da
un JSON troncato da `MAX_TOKENS`. `normalizeRecipe()` pulisce i campi, impone lo
`slot` richiesto quando manca o non è valido e scarta le ricette di altri pasti;
il risultato è al massimo di 10 ricette, senza duplicati né nomi già visti.

### Modelli e fallback

- Default: **`gemini-3.5-flash-lite`** (`GEMINI_TEXT_MODEL`). È GA dal 21 luglio
  2026, senza data di ritiro, supporta grounding e structured outputs e nel
  progetto gratuito dispone di 15 RPM / 250K TPM / 500 RPD e 500 richieste di
  grounding al giorno (su Gemini 3 **ogni query di ricerca eseguita** dal modello
  consuma una richiesta di grounding: una ricerca dell'app può valerne più di una).
- Unico fallback: **`gemini-3.1-flash-lite`** (`GEMINI_FALLBACK_MODELS`,
  lasciare vuoto per disattivarlo). Google ne ha annunciato il ritiro per il
  7 maggio 2027 con `gemini-3.5-flash-lite` come sostituto.
- Rimossi: `gemini-3.6-flash` (nessuna quota grounding nel progetto) e
  `gemini-2.5-flash-lite` (Google risponde *"no longer available to new users"*).

Il fallback scatta **solo** per errori legati al modello: quota/rate limit
(429), modello ritirato o non trovato, grounding non disponibile, fatturazione
disattivata, errori 5xx o di rete. Con API key non valida, permessi negati,
regione non supportata o richiesta rifiutata il secondo modello non viene
nemmeno provato. Per ogni ricerca il Worker fa al massimo 2 tentativi di modello
e 4 chiamate Gemini in totale.

### Codici di errore restituiti dal Worker

Ogni errore è JSON `{ error, code, reason, attempts[] }` (più `retryAfter` e
header `Retry-After` quando ha senso). Lo status HTTP e il `code` seguono la
causa del **modello primario**; i fallback falliti sono elencati nel messaggio.

| HTTP | `code` | Quando | `reason` |
| --- | --- | --- | --- |
| 429 | `WORKER_RATE_LIMIT` | limite interno del Worker (30 ricerche/15 min per utente), Gemini non viene chiamato | `worker_rate_limit` |
| 429 | `GEMINI_QUOTA` | Google risponde 429 `RESOURCE_EXHAUSTED` per tutti i modelli provati | `quota` |
| 502 | `GEMINI_CONFIGURATION` | modello ritirato/non trovato, grounding non disponibile, combinazione rifiutata, fatturazione disattivata, API key non valida o assente, permessi/regione | `model_retired`, `model_not_found`, `grounding_unavailable`, `structured_grounding_unsupported`, `unsupported_configuration`, `billing_disabled`, `invalid_api_key`, `missing_api_key`, `permission_denied`, `location_unsupported` |
| 502 | `GEMINI_UNAVAILABLE` | errori 5xx o di rete di Google, budget di chiamate esaurito | `provider_error`, `network_error`, `call_budget_exhausted` |
| 422 | `GEMINI_INVALID_RESPONSE` | Gemini ha risposto 200 ma senza ricette utilizzabili | `no_recipes`, `no_recipes_for_slot`, `malformed_response`, `blocked` |

Il messaggio `error` cita sempre modello, status HTTP e status Google della
causa reale (es. *"gemini-3.5-flash-lite (HTTP 429 RESOURCE_EXHAUSTED)"*) e il
messaggio originale di Google: non esiste più la frase generica *"quota gratuita
esaurita"*. Se Google indica **`limit: 0`** (`quotaValue: "0"`), il messaggio
dice esplicitamente che il progetto/API key non ha alcuna quota per quel modello
e che il blocco è lato Google, non nel codice.

I log strutturati (`console.log` JSON, visibili in **Observability**) riportano
per ogni chiamata modello, `httpStatus`, `errorCode`, `errorStatus`, `message`,
`details` e classificazione. Non contengono mai `GEMINI_API_KEY`, l'header
`Authorization`, il token Firebase né URL con `?key=`: ogni stringa passa da
`redactSecrets()`.

## Configurazione gratuita

Sono due quote separate e gratuite:

1. **Cloudflare Workers Free** — ospita l'endpoint `/recipes`.
2. **Gemini API free tier** — esegue la ricerca di ricette con Google Search
   grounding (modello Flash, quote del progetto Google AI Studio).

Nessun acquisto automatico: se il provider rifiuta una richiesta l'app mostra
un errore comprensibile.

## Procedura manuale su Cloudflare (solo dashboard)

Tutto si fa dal browser, con il mouse: **nessun terminale, nessun comando,
nessuna installazione**. Il Worker è un file singolo senza dipendenze, quindi si
pubblica con un copia-incolla.

### Passo 1 — Crea la chiave Gemini

1. Apri <https://aistudio.google.com/apikey> e accedi con il tuo account Google.
2. Premi **Create API key** e scegli il progetto (va bene anche quello di
   default).
3. Premi **Copy** e tieni la chiave negli appunti: serve al passo 4.

> La chiave non va **mai** incollata in `index.html`, `js/web-search.js`,
> `js/web-search-config.js` o in un file del repository. Vive solo nel campo
> segreto di Cloudflare.

### Passo 2 — Crea il Worker

1. Apri <https://dash.cloudflare.com> e accedi.
2. Nel menu di sinistra scegli **Workers & Pages**.
3. Premi **Create application** → scheda **Workers** → **Create Worker**.
4. Nel campo del nome scrivi esattamente `piano-nutrizionale-ai`.
5. Premi **Deploy** (per ora pubblica l'esempio predefinito: lo sostituisci
   subito dopo).

### Passo 3 — Incolla il codice

1. Nella pagina del Worker premi **Edit code** (o **Quick edit**).
2. Apri nel repository il file **`cloudflare/ai-worker/src/index.js`**,
   selezionane **tutto** il contenuto e copialo.
3. Nell'editor Cloudflare seleziona tutto il codice di esempio e **incolla** al
   suo posto quello copiato.
4. Premi **Deploy** in alto a destra.

> Non serve altro: il file non importa nulla dal progetto, quindi non devi
> caricare `js/domain.js` né altri moduli.

### Passo 4 — Variabili e segreto

Torna alla pagina del Worker e vai in **Settings** → **Variables and Secrets**.
Con **Add** inserisci queste voci nell'ambiente **Production**:

| Tipo | Nome | Valore |
| --- | --- | --- |
| Text | `FIREBASE_PROJECT_ID` | `piano-nutrizionale` |
| Text | `GEMINI_TEXT_MODEL` | `gemini-3.5-flash-lite` |
| Text | `GEMINI_FALLBACK_MODELS` | `gemini-3.1-flash-lite` (facoltativa; vuota = nessun fallback) |
| Text | `ALLOWED_ORIGINS` | `https://sylarpower.github.io,http://localhost:8000,http://127.0.0.1:8000,https://piano-nutrizionale.web.app` |
| **Secret** | `GEMINI_API_KEY` | la chiave copiata al passo 1 |

Se avevi impostato in precedenza `GEMINI_TEXT_MODEL = gemini-3.5-flash` (o un
modello rimosso), aggiorna il valore: il Worker usa la variabile così com'è.

Attenzione a `GEMINI_API_KEY`: scegli il tipo **Secret** (non *Text*), così il
valore resta nascosto. Nel valore non devono esserci virgolette, spazi iniziali
o finali, né la parola `Bearer`.

Premi **Deploy** per applicare le variabili.

### Passo 5 — Copia l'indirizzo del Worker

1. Nella pagina del Worker, sezione **Settings** → **Domains & Routes**, trovi
   l'indirizzo `https://piano-nutrizionale-ai.<account>.workers.dev`.
2. Se il sottodominio `workers.dev` risulta disattivato, premi **Enable**.
3. Copia l'indirizzo.

Aprirlo nel browser e leggere `Endpoint non trovato` è **normale**: l'endpoint
risponde solo a `POST /recipes` con `Authorization: Bearer <idToken Firebase>` e
applica un limite best-effort di 30 richieste ogni 15 minuti per utente.

### Passo 6 — Inserisci l'URL nella PWA

Nel repository apri `js/web-search-config.js` e scrivi l'indirizzo copiato,
aggiungendo `/recipes` in fondo:

```js
window.PIANO_WEB_SEARCH_CONFIG = Object.freeze({
  recipesEndpoint: "https://piano-nutrizionale-ai.<account>.workers.dev/recipes",
  language: "it-IT",
  maxRecipes: 10
});
```

L'URL non è un segreto. Dopo la modifica incrementa `CACHE_VERSION` in `sw.js`,
altrimenti i dispositivi continuano a usare la versione in cache.

### Passo 7 — Origini autorizzate

`ALLOWED_ORIGINS` (passo 4) elenca gli indirizzi da cui la webapp può chiamare
il Worker: solo l'origine, **senza percorso e senza slash finale**, separate da
virgola. Se pubblichi l'app su un dominio personale, aggiungilo alla lista dalla
stessa schermata e premi **Deploy**.

Il file `cloudflare/ai-worker/wrangler.toml` contiene gli stessi valori: serve
solo come riferimento (e per chi preferisce pubblicare da terminale), la
dashboard resta la fonte di verità della configurazione.

### Aggiornare il Worker in futuro

Quando `cloudflare/ai-worker/src/index.js` cambia: **Workers & Pages** →
`piano-nutrizionale-ai` → **Edit code** → seleziona tutto, incolla la nuova
versione → **Deploy**. Le variabili e il segreto restano impostati.

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
- `mellerAlternativeGroups(dayType)` → tabelle delle equivalenze per la
  **giornata visualizzata**: `training` mostra `Alimento | Pranzo A | Cena`,
  `rest` mostra `Alimento | Pranzo R | Cena`, `both` (Impostazioni, nessuna
  giornata di contesto) mostra entrambe le colonne pranzo.
- `mellerSlotHasAlternatives(slot)` → le equivalenze valgono **solo a pranzo e a
  cena**. Il manuale costruisce le alternative sul rapporto pranzo/cena: negli
  spuntini, nelle merende e a colazione le dosi sono fisse (crackers 30 g) e non
  intercambiabili, quindi il popup non si apre. Nelle ricette cross-slot conta
  il pasto di **destinazione**, non quello della ricetta.

## Sicurezza e privacy

- il Worker accetta solo `POST /recipes` da origini configurate e verifica il
  Firebase ID token prima di interrogare Gemini;
- l'app non salva cronologie delle ricerche;
- il contesto inviato al modello è la sola richiesta di ricetta dell'utente:
  nessun dato nutrizionale personale, nessuna grammatura del piano;
- il free tier Gemini è soggetto alle condizioni Google sull'uso dei dati per
  migliorare i prodotti.

## Problemi comuni

### `Per cercare ricette dal web serve il Worker Cloudflare`
`recipesEndpoint` in `js/web-search-config.js` è vuoto o errato. L'URL deve
terminare con `/recipes`.

### `Origine non autorizzata`
L'origine aperta nel browser non compare in `ALLOWED_ORIGINS`, oppure c'è uno
slash/percorso di troppo. Correggila in **Settings → Variables and Secrets** e
premi **Deploy**.

### `Autenticazione richiesta`
L'utente non è autenticato o la sessione Firebase è scaduta. Esci e accedi di
nuovo.

### Nessuna ricetta valida (422, `GEMINI_INVALID_RESPONSE`)
Gemini ha risposto correttamente ma il JSON non conteneva ricette utilizzabili
(`reason`: `no_recipes`, `no_recipes_for_slot`, `malformed_response`,
`blocked`). Non è un problema di quota né di configurazione: riprova con
ingredienti o preferenze diversi.

### Quota o rate limit Gemini (429, `GEMINI_QUOTA`)
Google ha risposto `429 RESOURCE_EXHAUSTED` per il modello primario e per il
fallback. Il messaggio riporta il modello, la quota violata (es.
`GenerateRequestsPerDayPerProjectPerModel-FreeTier`) e l'attesa suggerita.
Verifica uso e limiti del progetto su <https://aistudio.google.com/rate-limit>.
Se il messaggio parla di **limite 0**, il progetto/API key non ha alcuna quota
per quel modello: il blocco è lato Google (progetto senza quota gratuita per il
modello, chiave di un altro progetto, restrizioni sulla chiave) e va risolto in
AI Studio / Google Cloud, non nel codice. Prova di controprova: una chiamata
testuale semplice a `gemini-3.5-flash-lite` con la stessa chiave, senza
grounding, deve funzionare; se restituisce ancora quota zero il problema non è
il Worker.

### Troppe ricerche in poco tempo (429, `WORKER_RATE_LIMIT`)
È il limite interno del Worker (30 ricerche ogni 15 minuti per utente), non la
quota di Gemini: l'header `Retry-After` indica quando riprovare.

### Errore di configurazione (502, `GEMINI_CONFIGURATION`)
Il messaggio dice la causa: modello ritirato (*"no longer available"*) o
inesistente → aggiorna `GEMINI_TEXT_MODEL`; grounding non disponibile per il
modello; combinazione grounding + JSON rifiutata (il Worker passa da solo alla
variante in due passaggi); fatturazione disattivata; API key non valida o
assente → controlla il secret `GEMINI_API_KEY`.

### Servizio AI non disponibile (502, `GEMINI_UNAVAILABLE`)
Errore 5xx o di rete lato Google: riprova più tardi. I dettagli (status HTTP,
`errorStatus`, messaggio originale) sono nei log Observability del Worker.

### Per leggere i log
Cloudflare → **Workers & Pages** → `piano-nutrizionale-ai` → **Logs** /
**Observability**. Cerca gli eventi `gemini_error`, `recipes_failed`,
`recipes_ok`: contengono modello, `httpStatus`, `errorCode`, `errorStatus`,
messaggio e `details` di Google, mai chiavi o token.

### Deploy da terminale (alternativa alla dashboard)
Da `cloudflare/ai-worker`: `npx wrangler login`, `npx wrangler secret put
GEMINI_API_KEY`, `npx wrangler deploy`. Le variabili non segrete vengono da
`wrangler.toml`.
