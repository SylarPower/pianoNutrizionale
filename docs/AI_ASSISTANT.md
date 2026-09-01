# Assistente vocale AI

L'assistente di Piano Nutrizionale usa Gemini Live **solo per la conversazione vocale libera**. Per le nuove ricette dal web usa invece l'**API testuale** di Gemini con Google Search grounding, tramite un secondo endpoint del Worker Cloudflare (`/recipe`): una chiamata REST gratuita, senza sessione Live. Il Worker continua inoltre a emettere i token temporanei per Live su `/token`. La PWA resta statica: il Worker non inoltra il flusso audio.

## Cosa è già implementato

- pulsante orb fluttuante visibile dopo l'accesso: al tocco cambia solo colore/stato, nessuna finestra;
- all'avvio l'assistente NON parla: resta in ascolto della richiesta;
- **modalità locale gratuita**: piano, ricette, dosi, frutta, spesa, batch cooking, cucina passo-passo, guida Meller e comandi rispondono con il codice dell'app (riconoscimento e sintesi vocale del browser), **senza consumare quota Gemini**;
- Gemini Live viene usato solo per la conversazione libera, quando la richiesta non è gestibile in locale;
- richieste fuori tema (meteo, notizie, sport, ecc.) rifiutate: "non è di mia competenza";
- per le informazioni sull'app Gemini usa solo gli strumenti locali, mai Google Search;
- **nuove ricette dal web = API testuale (niente Live)**: il client riconosce la richiesta con `analyzeRecipeRequest` e chiama il Worker su `/recipe`, che interroga Gemini (modello testuale `GEMINI_TEXT_MODEL`, default `gemini-2.5-flash`) con Google Search grounding e il tool `import_recipe`;
- Google Search solo per le nuove ricette richieste sul web, **adattate obbligatoriamente alle linee guida del dott. Meller** (massimi per pasto applicati dal codice e dal Worker);
- una nuova ricetta apre il popup di importazione dell'app con dosi, preparazione e note, pronta per il salvataggio nel cloud;
- comandi `prossimo`, `avanti`, `ripeti`, `indietro`, `salta`, `pausa`, `ricomincia`, `quanto manca`, `chiudi assistente`;
- audio e cronologia non salvati dalla webapp;
- sospensione dell'ascolto quando la pagina viene nascosta. Il browser può sospendere completamente una PWA o negare il microfono con lo schermo bloccato: questo non è aggirabile da una webapp.

## Configurazione gratuita

Sono due quote separate:

1. **Cloudflare Workers Free**: ospita gli endpoint `/token` (token Live) e `/recipe` (ricette dal web).
2. **Gemini API free tier**: esegue Gemini Live (conversazione) e Gemini testuale (ricette dal web) entro le quote correnti del progetto Google AI Studio.

Nessuna delle due quote è illimitata. L'app non configura pagamenti automatici e mostra un errore comprensibile quando il provider rifiuta una richiesta.

### Quanto consuma l'assistente

- **Modalità locale (richieste intra-app): 0 chiamate Gemini.** Piano, ricette, spesa, frutta, batch e cucina usano solo il riconoscimento e la sintesi vocale del browser: gratuiti e senza limite giornaliero.
- **Gemini Live**: parte solo per la conversazione libera. Una sessione = una connessione; il token effimero viene emesso **una sola volta per sessione** (30 minuti) e riusato per le riconnessioni, quindi non si spreca nulla a ogni tentativo.
- **Gemini testuale (ricette dal web)**: una richiesta `generateContent` per ogni nuova ricetta chiesta esplicitamente. Non apre nessuna sessione Live. Le dosi arrivano già adattate dal Worker e vengono ricalcolate anche dal client (`adaptRecipeToGuidelines`, doppia sicurezza sui massimi Meller).
- Il budget del Worker (30 richieste ogni 15 minuti per utente) è **condiviso** tra `/token` e `/recipe`.
- I limiti del free tier (RPD, RPM, TPM e minuti audio per il modello Live) dipendono dal progetto Google e si vedono esattamente su <https://aistudio.google.com/rate-limit>; per i modelli Flash il free tier è nell'ordine di 1500 richieste/giorno, ma per i modelli Live il vincolo pratico sono i token al minuto e la durata audio. Con la modalità locale, la quota Gemini resta per le sole richieste che la meritano.

### 1. Crea la chiave Gemini

1. Apri [Google AI Studio](https://aistudio.google.com/apikey).
2. Crea una API key per il progetto desiderato.
3. Non copiarla in `index.html`, `js/assistant.js`, `js/assistant-config.js` o in Git.
4. Tienila pronta per il comando `wrangler secret put` del passaggio successivo.

Il modello Live principale è configurato come `gemini-3.1-flash-live-preview`. Se Google lo rifiuta con **1011** (quota gratuita esaurita) o **1008** (modello ritirato), l'app passa da sola al modello di riserva `gemini-2.5-flash-native-audio-preview-12-2025` (vedi sotto), anch'esso sul free tier e con la stessa voce configurata.

> Nota sul modello di riserva vocale: `gemini-2.5-flash-native-audio-preview-12-2025` è deprecato ma ancora funzionante; **non va cambiato** per ora. Quando Google lo spegnerà, l'app mostrerà l'errore relativo e la **modalità locale** continuerà a coprire tutte le richieste intra-app, mentre le **nuove ricette dal web restano disponibili** perché usano l'API testuale (`GEMINI_TEXT_MODEL`), non Live.

> Nota: `gemini-2.0-flash-live-001` è stato **spento da Google il 9 dicembre 2025** e oggi risponde `1008 ... is not found`: non usarlo come modello. Se cambierai modello in futuro, usa sempre un modello Live ancora disponibile nel tuo account (elenco in AI Studio o su <https://ai.google.dev/gemini-api/docs/deprecations>).

### 2. Crea e pubblica il Worker

### Percorso manuale dalla dashboard Cloudflare

Questo è il percorso da usare se non vuoi usare il terminale. Non servono Pages, KV, D1, Durable Objects, domini personalizzati o un piano Workers Paid.

1. Accedi a [Cloudflare Dashboard](https://dash.cloudflare.com/) e seleziona il tuo account.
2. Vai in **Workers & Pages** → **Create application** → crea un nuovo **Worker** (non un sito Pages).
3. Come nome inserisci esattamente `piano-nutrizionale-ai` e pubblica una prima versione Hello World.
4. Apri il Worker appena creato, scegli **Edit code** oppure **Edit** e sostituisci tutto il codice con il contenuto del file `cloudflare/assistant-worker/src/index.js` presente in questo repository. È un singolo file JavaScript e non devi incollare `wrangler.toml` nell'editor.
5. Vai in **Settings** → **Variables and Secrets** → **Add**. Crea queste variabili nell'ambiente **Production**:

   | Tipo | Nome | Valore |
   | --- | --- | --- |
   | Text | `FIREBASE_PROJECT_ID` | `piano-nutrizionale` |
   | Text | `GEMINI_LIVE_MODEL` | `gemini-3.1-flash-live-preview` |
   | Text | `GEMINI_LIVE_FALLBACK_MODEL` | `gemini-2.5-flash-native-audio-preview-12-2025` |
   | Text | `GEMINI_TEXT_MODEL` | `gemini-2.5-flash` (modello testuale per le ricette dal web) |
   | Text | `ALLOWED_ORIGINS` | `https://sylarpower.github.io,http://localhost:8000,http://127.0.0.1:8000,https://piano-nutrizionale.web.app` |
   | **Secret** | `GEMINI_API_KEY` | la chiave Gemini, incollata nel campo segreto |

   `GEMINI_API_KEY` deve essere di tipo **Secret**, non una variabile Text. Non inserire virgolette, spazi o `Bearer` nel suo valore.
6. Salva le variabili e scegli **Deploy**. Se Cloudflare chiede di attivare il sottodominio `workers.dev`, abilitalo: è sufficiente per questa integrazione e non richiede DNS o un dominio personale.
7. Nel Worker vai in **Overview** oppure **Settings** → **Domains & Routes** e copia l'indirizzo `workers.dev` assegnato. L'endpoint della PWA è quell'indirizzo con `/token` alla fine.

Il codice risponde su due endpoint:

- `POST /token` — emette il token temporaneo per Gemini Live (conversazione);
- `POST /recipe` — cerca una nuova ricetta dal web con Gemini testuale + Google Search grounding e restituisce `{ recipe: {...} }`.

Aprire l'indirizzo senza `/token` o `/recipe` e ricevere `Endpoint non trovato` è normale. Entrambi gli endpoint richiedono `Authorization: Bearer <idToken Firestore>` e condividono lo stesso rate limit (30 richieste/15 minuti per utente).

Il token Gemini viene emesso **senza vincolarlo a un modello**: il modello è scelto dal client nel setup della WebSocket (primario o di riserva), quindi un solo token vale per entrambi e non serve una nuova emissione per il fallback. Se Gemini rifiuta l'emissione del token per il modello richiesto, il Worker prova da solo il modello `GEMINI_LIVE_FALLBACK_MODEL` prima di rispondere con un errore. Il modello richiesto dal client viene comunque accettato solo se coincide con uno dei due modelli configurati.

Serve Node.js 18 o superiore solo se preferisci il percorso da terminale:

```bash
cd cloudflare/assistant-worker
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

Quando richiesto da `secret put`, incolla la chiave Gemini nel terminale, non in chat e non in un file del repository.

Al termine Wrangler mostra un URL simile a:

```text
https://piano-nutrizionale-ai.<account>.workers.dev
```

L'endpoint usato dalla PWA sarà:

```text
https://piano-nutrizionale-ai.<account>.workers.dev/token
```

Per provare il Worker in locale:

```bash
npx wrangler dev
```

Per il deploy reale usa sempre `wrangler deploy`; il server locale non deve essere inserito nella configurazione pubblica.

### 3. Inserisci l'URL nella PWA

Apri `js/assistant-config.js` e valorizza solo l'URL pubblico del Worker:

```js
window.PIANO_AI_CONFIG = Object.freeze({
  tokenEndpoint: "https://piano-nutrizionale-ai.<account>.workers.dev/token",
  model: "gemini-3.1-flash-live-preview",
  // Modello usato in automatico se il principale viene rifiutato (1011/1008).
  fallbackModel: "gemini-2.5-flash-native-audio-preview-12-2025",
  language: "it-IT",
  voiceName: "Aoede",
  sessionMinutes: 30,
  allowGoogleSearch: true
});
```

L'URL non è un segreto. La chiave Gemini deve restare soltanto nel secret Cloudflare. Dopo aver modificato `assistant-config.js`, incrementa `CACHE_VERSION` in `sw.js` prima del deploy, così i dispositivi che hanno già aperto la PWA ricevono subito la configurazione aggiornata.

### 4. Origini autorizzate

Nel file `cloudflare/assistant-worker/wrangler.toml`, `ALLOWED_ORIGINS` contiene già gli indirizzi previsti:

```toml
ALLOWED_ORIGINS = "https://sylarpower.github.io,https://piano-nutrizionale.web.app,http://localhost:8000,http://127.0.0.1:8000"
```

Regole:

- usa solo l'origine, senza percorso e senza slash finale;
- per GitHub Pages del repository `SylarPower/pianoNutrizionale` l'origine è normalmente `https://sylarpower.github.io`;
- per Firebase Hosting aggiungi l'origine `https://piano-nutrizionale.web.app` o quella mostrata dalla console;
- se usi un dominio personale, aggiungilo e ripubblica il Worker:

```bash
npx wrangler deploy
```

Dopo ogni modifica a `wrangler.toml` non serve ricreare il secret.

## Pubblicazione frontend consigliata

Per questo repository consiglio **GitHub Pages**: il progetto è già una PWA statica e il Worker è indipendente. Firebase Hosting è ugualmente possibile: `firebase.json` include già una configurazione `hosting` che pubblica la root e non include test, documentazione, codice Worker o dipendenze.

Con GitHub Pages:

1. pubblica la root del repository come sito Pages;
2. aggiungi `sylarpower.github.io` tra gli Authorized domains di Firebase Authentication;
3. verifica che il sito usi HTTPS;
4. apri la webapp, accedi e prova l'orb AI.

Con Firebase Hosting:

```bash
# dalla root del repository, dopo aver creato .firebaserc dal progetto corretto
npx firebase-tools login
npx firebase-tools use piano-nutrizionale
npx firebase-tools deploy --only hosting
```

La configurazione lascia Firestore separato: per pubblicare le regole usa, quando serve, `npx firebase-tools deploy --only firestore:rules`. Aggiungi il dominio Hosting effettivo sia in Firebase Authentication sia in `ALLOWED_ORIGINS` del Worker.

Per sviluppo locale avvia sempre un server HTTP, non aprire `index.html` con doppio clic:

```bash
npx serve . -l 8000
```

`http://localhost` è consentito dai browser per il microfono; un dominio online deve usare HTTPS.

## Sicurezza e privacy

- il Worker accetta solo richieste POST su `/token` da origini configurate;
- verifica il Firebase ID token prima di chiedere un token Gemini;
- applica un limite best-effort di trenta emissioni per utente ogni quindici minuti per isolate (il client riusa il token già emesso, una sola emissione per modello e per sessione);
- il token Gemini scade in ~30 minuti ed è riusato dal client per le riconnessioni della stessa sessione (una sola emissione per modello);
- l'app non salva audio, trascrizioni o cronologia in Firestore;
- il contesto inviato al modello è quello necessario per la richiesta;
- il free tier Gemini è soggetto alle condizioni Google sull'uso dei dati per migliorare i prodotti, accettate per questa integrazione;
- non attivare auto-top-up o billing Google per questa prima fase.

## Problemi comuni

### `Assistente non ancora configurato`
Controlla `tokenEndpoint` in `js/assistant-config.js`. L'URL deve terminare con `/token`.

### `Origine non autorizzata`
L'origine aperta nel browser non compare in `ALLOWED_ORIGINS`, oppure hai lasciato uno slash/percorso dove non dovrebbe esserci. Modifica `wrangler.toml` e ripubblica.

### `Autenticazione richiesta`
L'utente non è autenticato o la sessione Firebase è scaduta. Esci e accedi di nuovo.

### `Risposta Gemini senza token temporaneo`
Controlla che `GEMINI_API_KEY` sia stato caricato con `npx wrangler secret put GEMINI_API_KEY`, che il progetto abbia accesso a Gemini Live e che il modello indicato sia ancora disponibile.

### `Non sono riuscito a comporre una ricetta valida` (422)
Il Worker ha interpellato Gemini ma non ha ricevuto la chiamata `import_recipe`. Riprova con una richiesta diversa. Se l'errore persiste, verifica che `GEMINI_TEXT_MODEL` sia impostato (default `gemini-2.5-flash`) e che la chiave abbia accesso all'API testuale con Google Search grounding.

### Il microfono non parte
Concedi il permesso al sito, usa Chrome/Edge/Safari aggiornato, verifica HTTPS e assicurati che nessun'altra app stia usando il microfono. Con cuffie o auricolari l'interruzione della voce è più pulita.

### Gemini chiude con 1011 (quota) o 1008 (modello non trovato)
L'app tenta da sola il modello di riserva configurato: se il principale viene rifiutato con 1011 (quota gratuita esaurita o fatturazione non attiva) o 1008 (modello ritirato da Google), la sessione riparte automaticamente sul modello `fallbackModel` di `js/assistant-config.js`. Il token effimero non è vincolato al modello, quindi il passaggio avviene senza una nuova emissione. Dopo il primo successo il modello di riserva viene ricordato per la sessione, così le riconnessioni non ripetono il tentativo fallito. La voce configurata (es. `Aoede`) resta la stessa. Se anche il modello di riserva viene rifiutato, compare l'errore con il motivo: niente loop di riconnessione.

### Quota gratuita esaurita
La webapp non effettua acquisti automatici. La quota del free tier Gemini si azzera da sola: verifica uso e limiti del progetto su <https://aistudio.google.com/rate-limit>. Nel frattempo l'app usa il modello di riserva. Se entrambi i modelli rispondono 1011 anche con chiavi appena create, è un limite temporaneo lato Google sui modelli Live in anteprima: riprova più tardi, nessuna correzione lato app può aggirarlo.
