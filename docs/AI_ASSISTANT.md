# Assistente vocale AI

L'assistente di Piano Nutrizionale usa Gemini Live per la conversazione vocale e un piccolo Cloudflare Worker gratuito soltanto per emettere token temporanei. La PWA resta statica: il Worker non inoltra il flusso audio.

## Cosa è già implementato

- pulsante orb fluttuante visibile dopo l'accesso;
- microfono attivo per tutta la modalità, fino alla chiusura manuale o vocale;
- conversazione audio bidirezionale con interruzione mentre Gemini parla;
- risposta testuale dell'ultima richiesta e risposta vocale;
- comandi `prossimo`, `avanti`, `ripeti`, `indietro`, `salta`, `pausa`, `ricomincia`, `quanto manca`, `chiudi assistente`;
- flusso cucina: un ingrediente alla volta, conferma, poi uno step di preparazione alla volta;
- quantità lette dal piano e dal profilo porzioni attivo, non inventate dal modello;
- domanda sui grammi di frutta calcolata dal codice e restituita senza ricapitolare il resto del pasto;
- ricerca nel catalogo, nel piano, nella spesa, nel batch cooking e nella guida Meller;
- Google Search per domande aggiornate, con fonti mostrate nella schermata;
- audio e cronologia non salvati dalla webapp;
- sospensione della cattura quando la pagina viene nascosta. Il browser può sospendere completamente una PWA o negare il microfono con lo schermo bloccato: questo non è aggirabile da una webapp.

## Configurazione gratuita

Sono due quote separate:

1. **Cloudflare Workers Free**: ospita il piccolo endpoint `/token`.
2. **Gemini API free tier**: esegue Gemini Live entro le quote correnti del progetto Google AI Studio.

Nessuna delle due quote è illimitata. L'app non configura pagamenti automatici e mostra un errore comprensibile quando il provider rifiuta una richiesta.

### 1. Crea la chiave Gemini

1. Apri [Google AI Studio](https://aistudio.google.com/apikey).
2. Crea una API key per il progetto desiderato.
3. Non copiarla in `index.html`, `js/assistant.js`, `js/assistant-config.js` o in Git.
4. Tienila pronta per il comando `wrangler secret put` del passaggio successivo.

Il modello Live è configurato come `gemini-3.1-flash-live-preview`. Se Google lo sostituisce o il progetto non lo espone, modifica `GEMINI_LIVE_MODEL` in `wrangler.toml` usando un modello Live audio disponibile nel tuo account.

### 2. Crea e pubblica il Worker

Serve Node.js 18 o superiore.

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
- applica un limite best-effort di sei emissioni per utente ogni quindici minuti per isolate;
- il token Gemini è limitato a una sessione e ha durata breve;
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

### Il microfono non parte
Concedi il permesso al sito, usa Chrome/Edge/Safari aggiornato, verifica HTTPS e assicurati che nessun'altra app stia usando il microfono. Con cuffie o auricolari l'interruzione della voce è più pulita.

### Quota gratuita esaurita
La webapp non effettua acquisti automatici. Riprova quando la quota si rinnova oppure sostituisci il provider/modello seguendo una futura integrazione di fallback.
