# 🥗 Piano Nutrizionale

WebApp PWA privata per gestire colazioni, spuntini, pranzi, cene, batch cooking e lista della spesa. Usa Firebase Authentication e Cloud Firestore.

## Cosa offre

- accesso personale con username e password, senza email mostrata nell'interfaccia;
- account utilizzabile anche con ricettario completamente vuoto;
- creazione manuale di ricette con dosi Donna IPO A/R e Uomo A/R;
- importazione ed esportazione JSON di una ricetta o dell'intero catalogo (schema 4);
- condivisione di ricette **e/o della struttura della settimana** con un altro username, con anteprima dei conflitti e scelta della modalità di sostituzione;
- collegamento di due o più account in una **household**: piano, catalogo, batch cooking e spesa condivisi in tempo reale, con profilo porzioni locale per ogni persona;
- invito al collegamento per username, scelta della settimana base, backup automatico di entrambi gli account e scollegamento con copia indipendente;
- richieste ricevute con **Solo ricette**, **Solo settimana**, **Importa tutto**, **Sostituisci ricette**, scelta della base account oppure **Rifiuta**;
- catalogo opzionale di partenza fornito nel file esterno `firebase-seed.json` (mai committato nel repository);
- colazioni e spuntini inclusi nel piano;
- crackers dello spuntino mattutino aggiunti nei giorni A e rimossi nei giorni R (dinamici, derivati dal piano);
- vista ricetta completa in una singola schermata (ingredienti, quantità, preparazione, note e batch cooking);
- operazioni sui pasti: sostituisci con una ricetta, scambia con un altro giorno, copia in un altro giorno, ripristina scelta iniziale;
- **sostituzione pranzo ↔ cena** con adattamento automatico dei carboidrati alle dosi del pasto (es. frittata di cena a pranzo con pane da 120g invece di 60g);
- **suggerimento batch cooking nella sostituzione**: cambiando un pranzo viene evidenziata la cena del giorno prima (e cambiando una cena il pranzo del giorno dopo), così un tocco attiva la "doppia porzione";
- generatore automatico della settimana con parametri strutturali (slot da rigenerare, **accoppiate cena → pranzo per il batch**, tetto ripetizioni, cross-slot pranzo ↔ cena, frequenze proteiche min–max), vincoli nutrizionali, blocchi pasto/giornata che contano nelle frequenze, seed riproducibile, anteprima e diff;
- batch cooking dinamico basato su `batchTemplates` strutturati (cena di oggi → pranzo futuro), con stato “Prepara oggi / Prepara al momento / Non ancora preparabile” e quantità calcolate da profilo, ricetta target e tipo A/R del giorno target;
- backup precedente (`users/{uid}/backups/previous`) e **Annulla ultima modifica** prima delle operazioni distruttive;
- lista della spesa aggregata per `ingredientId` con profili Uomo, Donna IPO e Coppia;
- PWA offline con shell versionata, aggiornamento one-tap e fallback offline comprensibile;
- alternative alimentari di Meller sempre consultabili nelle Impostazioni;
- **registro prezzi condiviso** (scheda Prezzi): un unico database tra tutti gli utenti per registrare i prezzi nei negozi (con barcode Open Food Facts), confrontare il prezzo normalizzato €/kg tra negozi con indicazione del migliore (ricerca prodotto con suggerimenti live mentre si digita, prodotti recenti a un tocco, navigazione da tastiera), giudizio rispetto allo storico (minimo storico / affare / caro), suggerimento del nome prodotto già in archivio quando quello scannerizzato è una variante più lunga ("Cereali di grano duro" → "Cereali"), archivio con modifica delle proprie voci e importazione/esportazione di backup JSON (incluso il vecchio formato "Spesa Smart");
- **pagina negozio** (Prezzi → Negozi): per ogni negozio l'ultimo prezzo registrato di ogni prodotto, con indicazione di dove quel prodotto costa meno (🏆 miglior prezzo, scostamento % rispetto al migliore, "solo qui");
- nessuna funzionalità di notifica (né push né locali).

## Dove si trovano i dati

Le ricette non sono hardcoded nel repository GitHub. Il codice contiene soltanto interfaccia, regole di visualizzazione, servizi di dominio puri (`js/domain.js`) e manuale di Meller.

Finché l'account è indipendente, i dati si trovano nei documenti privati:

```text
users/{uid}/content/recipeCatalog
users/{uid}/config/weeklyPlan
users/{uid}/config/shoppingList
```

Quando l'account entra in un gruppo, le stesse funzioni puntano invece ai documenti condivisi:

```text
households/{householdId}
households/{householdId}/content/recipeCatalog
households/{householdId}/config/weeklyPlan
households/{householdId}/config/shoppingList
```

Altri dati:

```text
users/{uid}/backups/previous
usernames/{username}
recipeShares/{requestId}
```

Il registro prezzi è invece un database **unico e condiviso tra tutti gli utenti** (non è legato né all'account né alla household):

```text
priceEntries/{entryId}
priceMeta/global
```

`priceEntries` contiene un documento per ogni prezzo registrato (negozio, prodotto, marca, prezzo, quantità, unità, prezzo normalizzato, data e autore). Tutti gli account autenticati leggono l'intera collezione; ogni utente può modificare o eliminare solo le voci che ha creato. `priceMeta/global` è la rubrica condivisa dei nomi di negozi, prodotti e marche usati, per i suggerimenti durante la digitazione; viene aggiornata con `arrayUnion` solo quando compare un nome nuovo.

`households/{householdId}` contiene gli UID autorizzati; le regole Firestore consentono a ogni membro di leggere e modificare i tre documenti condivisi. `usernames` contiene solamente username e UID, necessari per individuare il destinatario. `recipeShares` contiene sia le condivisioni ricetta sia gli inviti `accountLink` ancora da accettare o rifiutare. `backups/previous` rimane sempre personale e contiene un'unica copia (catalogo + piano + lista spesa), cancellata dopo il ripristino.

## Chiamate Firestore

Un normale avvio cerca prima l'eventuale household e poi carica i tre documenti (catalogo completo, piano settimanale, lista della spesa):

- **account indipendente**: tre letture documento in parallelo, come sempre (non ci sono listener attivi);
- **account collegati**: i listener `onSnapshot` sui tre documenti condivisi rileggono comunque quei documenti, quindi con una cache locale valida l'avvio parte dalla cache e lascia che sia il primo snapshot dei listener a popolare lo stato, **senza letture duplicate**. Senza cache utilizzabile restano le tre letture dirette come fallback.

Il catalogo è un unico documento: 62 ricette non generano 62 letture. Per gli account collegati sono attivi listener `onSnapshot` sui tre documenti condivisi e sulla membership, così le modifiche compaiono in tempo reale su tutti i dispositivi.

Le interazioni con la lista della spesa (spunte dei pasti, quantità personalizzate, esclusioni) aggiornano subito interfaccia e `localStorage`, ma la scrittura del documento Firestore è accorpata con un **debounce di ~800 ms**: configurare l'intera settimana produce una manciata di scritture invece di 50-100. La scrittura pendente viene forzata su `visibilitychange` (pagina nascosta) e `pagehide`, così chiudere la scheda non perde nulla.

La casella delle condivisioni viene interrogata solo quando si preme **Ricevute**, con **una sola query** su `recipeShares` ripartita lato client tra condivisioni ricette e inviti di collegamento account (quei documenti incorporano interi cataloghi: la query unica dimezza anche il traffico in uscita).

Operazioni indicative (catalogo medio ~60 ricette):

- esportazione JSON: zero chiamate Firebase;
- importazione **Aggiungi**: una scrittura catalogo (+ una scrittura piano solo se cambiano riferimenti);
- importazione **Sostituisci tutte**: backup (1 scrittura) + catalogo (1) + piano (1);
- invio condivisione o invito account: una lettura per cercare il destinatario + una scrittura richiesta (l'invito crea prima un backup personale);
- accettazione condivisione: catalogo, piano (se incluso) e rimozione richiesta in un **unico batch**;
- accettazione collegamento: backup del destinatario + membership, tre documenti condivisi quando necessari e rimozione invito in un **unico batch**;
- rifiuto: una cancellazione della richiesta;
- **Annulla ultima modifica**: una **transazione atomica** (legge backup, riscrive catalogo/piano/spesa, elimina il backup);
- generatore: solo letture locali; l'applicazione scrive il piano (1) preceduta dal backup (1);
- migrazione schema 3 → 4: una sola scrittura per documento, al primo avvio che rileva la versione precedente.

Il registro prezzi (scheda Prezzi) è progettato per costare poco:

- apertura della scheda: 1 lettura della rubrica `priceMeta/global` (poi resta in cache locale);
- registrazione di un prezzo: 1 scrittura della voce + 0-1 scritture della rubrica (solo se il negozio/prodotto/marca non era mai stato usato da nessuno); dopo il salvataggio l'archivio e la rubrica vengono aggiornati in memoria senza nuove letture, e la cache delle query viene invalidata solo per il prodotto/negozio toccato;
- confronto di un prodotto: una sola query `where productKey` (tante letture quante sono le voci registrate per quel prodotto, normalmente poche), in cache per l'intera sessione;
- archivio: una sola query con limite 150, ricaricata al massimo una volta al minuto; l'elenco già in cache viene mostrato subito a ogni ingresso nella scheda e non viene mai svuotato durante l'aggiornamento;
- importazione backup JSON: qualche lettura di controllo (una ogni 30 voci, per riconoscere le voci già importate e non duplicarle) + scritture in batch da massimo 450 voci + al massimo 1 scrittura della rubrica;
- pagina negozio: una query per il negozio (in cache per la sessione) + una query per prodotto (in cache se già letto), solo quando si apre il dettaglio del negozio.

La cache offline Firestore è abilitata. Tema, profilo porzioni e metadati del backup restano in `localStorage`.

### Limiti Firestore e piano gratuito

- Un documento Firestore ha un limite di **1 MiB**: il catalogo viene rifiutato sopra i **900 KB** di JSON serializzato, con ampio margine.
- Piano gratuito Spark (stima indicativa, senza garanzie): ~50.000 letture, ~20.000 scritture e ~1 GiB di trasferimento al giorno. Un avvio normale costa 3 letture: un uso quotidiano intenso (decine di accessi al giorno) resta ampiamente dentro le quote. Le condivisioni aggiungono 1-3 scritture per richiesta.

---

# Pubblicazione online — guida 101

Seguire i passaggi nell'ordine indicato.

## Parte 1 — Preparare Firebase

### Passaggio 1: aprire il progetto

1. Vai su [https://console.firebase.google.com](https://console.firebase.google.com).
2. Accedi con il tuo account Google.
3. Apri il progetto **piano-nutrizionale**.
4. Se il progetto non esiste, premi **Crea un progetto** e completa la procedura.

Il file `js/firebase.js` contiene già la configurazione del progetto `piano-nutrizionale`. Se ne crei uno con un nome diverso, devi sostituire `firebaseConfig` con quello mostrato da Firebase in **Impostazioni progetto → Le tue app → Web app**.

### Passaggio 2: abilitare username e password

Firebase usa tecnicamente email/password. L'app nasconde l'email e la costruisce partendo dallo username.

1. Nel menu Firebase apri **Authentication**.
2. Premi **Inizia**, se richiesto.
3. Apri la scheda **Sign-in method**.
4. Seleziona **Email/Password**.
5. Attiva **Email/Password**.
6. Non è necessario attivare Email Link.
7. Premi **Salva**.

### Passaggio 3: creare il primo utente

1. Vai in **Authentication → Users**.
2. Premi **Add user / Aggiungi utente**.
3. Scegli uno username, per esempio `mario`.
4. Nel campo email scrivi esattamente:

   ```text
   mario@utenti.pianonutrizionale.app
   ```

5. Imposta una password di almeno 6 caratteri, preferibilmente più lunga.
6. Salva.

Nella webapp l'utente inserirà:

```text
Username: mario
Password: la password scelta
```

Non inserire mai password nei file JavaScript, su GitHub o in Firestore.

Per creare `anna`, usa:

```text
anna@utenti.pianonutrizionale.app
```

### Passaggio 4: creare Firestore

1. Nel menu Firebase apri **Firestore Database**.
2. Premi **Create database / Crea database**.
3. Seleziona la modalità produzione.
4. Scegli una regione europea vicina, se disponibile.
5. Conferma.

Non devi creare manualmente collezioni o documenti.

### Passaggio 5: pubblicare le regole di sicurezza

Questo passaggio è obbligatorio, soprattutto per la condivisione.

1. Nel progetto locale apri il file `firestore.rules` con un editor di testo.
2. Copia tutto il contenuto.
3. In Firebase apri **Firestore Database → Rules**.
4. Seleziona tutte le regole presenti e sostituiscile con quelle copiate.
5. Premi **Publish / Pubblica**.

Le regole garantiscono che:

- ogni utente possa modificare solo i propri dati e backup personali;
- solo gli UID elencati nella household possano leggere o modificare piano, catalogo e spesa condivisi;
- l'ingresso in una household sia possibile soltanto tramite un invito `accountLink` pending destinato all'UID autenticato;
- ogni membro possa rimuovere soltanto se stesso dal gruppo;
- lo username possa essere registrato solo dal relativo account Firebase;
- il mittente possa creare una richiesta;
- solo il destinatario possa accettarla, rifiutarla o eliminarla.

In alternativa, se usi Firebase CLI:

```bash
firebase deploy --only firestore:rules --project piano-nutrizionale
```

### Passaggio 6: dominio autorizzato

1. Apri **Authentication → Settings → Authorized domains**.
2. Per GitHub Pages aggiungi il dominio:

   ```text
   TUO-USERNAME-GITHUB.github.io
   ```

3. Non inserire `https://` e non inserire il nome del repository.
4. Se userai un dominio personale, aggiungi anche quel dominio.

---

## Parte 2 — Provare tutto in locale

### Passaggio 7: estrarre lo ZIP

1. Scarica `piano-nutrizionale-locale.zip`.
2. Estrai il contenuto.
3. Troverai:

   ```text
   pianoNutrizionale/
   firebase-seed.json
   LEGGIMI-PRIMA.txt
   ```

`firebase-seed.json` è opzionale. Serve solo se vuoi partire dal catalogo completo già preparato.

### Passaggio 8: avviare un server locale

Non aprire `index.html` facendo doppio clic.

Apri il terminale nella cartella `pianoNutrizionale` ed esegui:

```bash
python3 -m http.server 8080 --bind 0.0.0.0
```

Apri nel browser:

```text
http://localhost:8080
```

### Passaggio 9: primo accesso

1. Inserisci username e password.
2. La webapp si apre anche se non hai importato alcun JSON.
3. Il Ricettario può essere vuoto.
4. Premi **Ricettario → + Nuova** per creare una ricetta manualmente.
5. Compila nome, tipo di pasto, ingredienti, quattro dosi e preparazione.
6. Premi **Salva su Firebase**.

Se crei una ricetta dal riquadro vuoto di un pasto giornaliero, viene anche assegnata automaticamente a quel giorno.

### Passaggio 10: importare il catalogo opzionale

1. Apri **Ricettario**.
2. Premi **Importa**.
3. Seleziona `firebase-seed.json`.
4. Scegli:
   - **Aggiungi**: mantiene le ricette già presenti;
   - **Sostituisci tutte**: elimina il catalogo attuale e usa quello del file.
5. Se il catalogo è vuoto, il piano incluso nel seed viene applicato anche scegliendo Aggiungi.

---

## Parte 3 — Esportazione, importazione e condivisione

### Esportare tutte le ricette

1. Apri **Ricettario**.
2. Premi **Esporta**.
3. Il browser scarica un file JSON con tutte le ricette.

L'esportazione non usa chiamate Firestore aggiuntive.

### Esportare una sola ricetta

1. Apri la ricetta.
2. Premi **Esporta JSON**.
3. Il browser scarica soltanto quella ricetta.

### Importare successivamente

1. Apri **Ricettario → Importa**.
2. Seleziona un file esportato in precedenza.
3. Scegli **Aggiungi** oppure **Sostituisci tutte**.
4. In modalità Aggiungi, eventuali ID duplicati vengono rinominati, così le ricette esistenti non vengono sovrascritte.

### Inviare tutte le ricette a un altro utente

1. Entrambi gli utenti devono aver aperto almeno una volta l'ultima versione della webapp.
2. Apri **Ricettario**.
3. Premi **Invia tutte**.
4. Inserisci lo username del destinatario, senza dominio tecnico.
5. Premi **Invia richiesta**.

### Inviare una sola ricetta

1. Apri la ricetta.
2. Premi **Invia**.
3. Inserisci lo username del destinatario.
4. Conferma.

### Accettare o rifiutare

Il destinatario deve:

1. aprire **Ricettario**;
2. premere **Ricevute**;
3. scegliere una delle opzioni:
   - **Aggiungi**: conserva il proprio catalogo e aggiunge le ricette ricevute;
   - **Sostituisci tutte**: conserva esclusivamente quelle ricevute;
   - **Rifiuta**: elimina la richiesta senza modificare il catalogo.

Una richiesta accettata o rifiutata viene rimossa da Firestore.

---

## Parte 4 — Pubblicare su GitHub Pages

### Passaggio 11: controllare i file da non pubblicare

La cartella del repository contiene `.gitignore` con:

```text
/exports/
```

Il file `firebase-seed.json` fornito nello ZIP si trova fuori dalla cartella del repository. Non copiarlo dentro il repository pubblico.

Le chiavi presenti in `firebaseConfig` identificano l'app Firebase ma non sono password. La protezione reale è garantita da Authentication e dalle regole Firestore.

### Passaggio 12: caricare su GitHub

Se usi Git da terminale:

```bash
cd pianoNutrizionale
git status
git add .
git commit -m "Aggiorna webapp nutrizionale"
git push
```

Prima di `git add .`, verifica che non compaiano password, ZIP o `firebase-seed.json`.

Se non usi Git:

1. apri il repository su GitHub;
2. usa **Add file → Upload files**;
3. carica il contenuto della cartella `pianoNutrizionale`;
4. non caricare `firebase-seed.json`;
5. conferma il commit.

### Passaggio 13: attivare GitHub Pages

1. Apri il repository su GitHub.
2. Vai in **Settings**.
3. Nel menu laterale apri **Pages**.
4. In **Build and deployment**, scegli **Deploy from a branch**.
5. Seleziona la branch `main`.
6. Seleziona la cartella `/ (root)`.
7. Premi **Save**.
8. Attendi alcuni minuti.

L'indirizzo sarà simile a:

```text
https://TUO-USERNAME-GITHUB.github.io/pianoNutrizionale/
```

### Passaggio 14: verifica finale

Apri l'indirizzo online e controlla, nell'ordine:

1. login con username e password;
2. apertura con ricettario vuoto;
3. creazione e salvataggio di una ricetta;
4. logout e nuovo login: la ricetta deve essere ancora presente;
5. esportazione singola e completa;
6. importazione Aggiungi e Sostituisci;
7. login con un secondo utente;
8. invio di una ricetta tra i due account;
9. accettazione e rifiuto delle richieste;
10. cambio A/R e presenza/assenza crackers;
11. lista della spesa;
12. alternative di Meller nelle Impostazioni.

Se la condivisione restituisce “utente non trovato”, fai accedere il destinatario almeno una volta all'ultima versione e riprova.

---

# Schema 4 e servizi di dominio

## Schema ricette v4

Il catalogo usa `schemaVersion: 4`. Ogni ingrediente ha una struttura stabile:

```javascript
{
  ingredientId: "whole-eggs",
  name: "Uova intere",
  portions: {
    ipoTraining: "2",
    ipoRest: "2",
    manTraining: "2",
    manRest: "2"
  }
}
```

- `ingredientId` è l'identificatore **stabile** usato per aggregare la lista della spesa;
- `name` è solo l'etichetta visualizzata;
- la migrazione è **idempotente** e avviene **solo quando necessario** (versione precedente rilevata), con una sola scrittura per documento;
- le porzioni legacy (`ipo`, `training`, `rest`) continuano a funzionare e vengono normalizzate senza cambiare i valori;
- importazioni, esportazioni e condivisioni sono normalizzate a schema 4;
- il catalogo ingredienti canonici (alias + etichette) è incorporato nel documento catalogo (`ingredientAliases`, `canonicalIngredients`);
- nessuna lettura Firestore per singolo ingrediente.

### Alias comuni

```text
Uovo intero / Uova intere / Uova intere (sode) / Uova intere (barzotte) → whole-eggs
Pomodorini → cherry-tomatoes          Salmone → salmon
Tonno (al naturale sgocciolato) → tuna   Yogurt greco → greek-yogurt
Pane (integrale / di segale) → bread     Limone → lemon
Zucchina / Zucchine → zucchini
```

Gli alias sono estendibili in `js/domain.js` (`INGREDIENT_ALIASES`) e nel documento catalogo. I nomi non in elenco ricevono uno slug stabile (es. `Riso venere` → `riso-venere`).

## Migrazioni retrocompatibili

Vengono gestite senza perdita di dati:

- porzioni schema precedente (`ipo`/`training`/`rest`);
- ricette senza `ingredientId`;
- `batchRules` testuali → `batchTemplates` strutturati;
- piani schema 3 (aggiunta di `batchTemplates`);
- catalogo vuoto (primo avvio);
- vecchia sottocollezione `recipes` (già migrata a documento unico nelle versioni precedenti);
- riferimenti del piano a ricette mancanti (rimossi/sanificati);
- condivisioni vecchie solo ricette e nuove ricette + piano.

Tutte le migrazioni sono idempotenti, eseguite solo alla rilevazione di una versione precedente e salvate una sola volta (nessuna scrittura automatica a ogni avvio).

# Batch cooking dinamico

Il batch non usa più le vecchie `batchRules` testuali: dipende da **`batchTemplates`** strutturati.

```javascript
{
  id: "batch-c19-p16",
  anchor: { slot: "dinner", recipeId: "C19" },
  target: { slot: "lunch", recipeId: "P16", lookAheadDays: 3 },
  tasks: [
    {
      id: "prepare-rice",
      ingredientId: "venere-rice",
      actionType: "cook",
      label: "Cuoci il riso venere",
      durationMinutes: 35,
      quantitySource: { recipeId: "P16", ingredientId: "venere-rice" },
      storage: { method: "fridge", maxDays: 1, instructions: "Durata prudenziale da validare." }
    }
  ]
}
```

Comportamento:

- l'**anchor** è la cena del giorno corrente; il **target** è un pranzo futuro (ricerca ricorrente: domenica → lunedì e oltre, entro `lookAheadDays`);
- il tipo A/R del giorno corrente **non** disattiva mai il batch; il tipo A/R del **giorno target** determina solo le quantità;
- ogni task ha una finestra di conservazione (`storage.maxDays`):
  - `0` = fresco → **Prepara al momento**;
  - copre i giorni fino al target → **Prepara oggi**;
  - oltre la finestra → **Non ancora preparabile**;
- il batch resta attivo se **almeno una** preparazione è valida; non compare se tutte sono oltre la finestra;
- i task con lo stesso ID non vengono duplicati;
- le durate migrate sono prudenti (0 per il fresco, 1 giorno per il migrato), configurabili nei dati e **da validare per la sicurezza alimentare**;
- la UI mostra giorno target, testo “tra N giorni” e quantità calcolate da ricetta target, profilo e tipo A/R target.

# Backup precedente e annullamento

Prima di ogni operazione distruttiva (importazione **Sostituisci tutte**, accettazione condivisione **Sostituisci ricette**/**Importa tutto**, applicazione del generatore) viene salvato un unico documento:

```text
users/{uid}/backups/previous
```

```javascript
{
  catalog: { recipes: [...], schemaVersion: 4 },
  plan: { ... },
  shoppingList: { ... },
  operation: "import-replace",
  description: "...",
  createdAt: "..."
}
```

Nelle **Impostazioni** è disponibile **Annulla ultima modifica**, con conferma, ultima operazione e data del backup. Il ripristino è **atomico** (transazione Firestore), **utilizzabile una sola volta** e cancella il backup dopo il ripristino, aggiornando anche cache locale e UI.

# Copia e scambio pasti

Nella vista **Settimana** ogni pasto ha un menu operazioni:

- **Sostituisci con una ricetta** (stesso tipo pasto). Per pranzo e cena sono mostrate anche le ricette del **pasto opposto**: i carboidrati vengono adattati alle quantità del pasto di destinazione (vedi sotto);
- **Scambia con altro pasto** (bidirezionale, solo stesso tipo: `breakfast ↔ breakfast`, `snack1 ↔ snack1`, `lunch ↔ lunch`, `snack2 ↔ snack2`, `dinner ↔ dinner`);
- **Copia in altro giorno** (il sorgente resta invariato);
- **Ripristina scelta iniziale** (torna a `defaultDays`).

Ogni operazione chiede conferma, salva il piano una sola volta e aggiorna batch, lista spesa, frequenze e feedback. Il piano resta coerente con le ricette mancanti.

## Adattamento carboidrati pranzo ↔ cena

Quando una ricetta di cena viene collocata a pranzo (o viceversa), **solo il carboidrato** viene ricalcolato alle quantità del pasto di destinazione; proteine, uova, verdura e condimenti restano invariati. Le quantità seguono le linee guida del nutrizionista e distinguono giorno di Allenamento e Riposo per il pranzo (la cena è uguale in A e R):

| Carboidrato | Pranzo (A / R) | Cena |
|---|---|---|
| Pasta, Riso | 90 / 70g | non previsto |
| Gnocchi di patate | 250 / 190g | non previsto |
| Quinoa, Grano saraceno, Amaranto | 80 / 60g | non previsto |
| Piadina | 110 / 80g | non previsto |
| Farro, Orzo | 90 / 70g | non previsto |
| Pane | 120 / 90g | 60g |
| Crackers, Grissini, Crostini | 70 / 60g | 40g |
| Patate | 450 / 350g | 230g |
| Polenta cotta | 430 / 340g | 220g |

Andando **pranzo → cena**, i carboidrati non previsti a cena (pasta, riso, gnocchi, quinoa, piadina, farro, orzo) vengono **convertiti nel carboidrato cena di default** (Pane 60g), scelto nelle **Impostazioni → Sostituzioni pranzo ↔ cena**. Andando **cena → pranzo** non ci sono conversioni: pane, crackers, patate e polenta esistono in entrambi i pasti e cambia solo la quantità. I valori sono uguali per tutti i profili porzioni (Uomo, Donna IPO, Coppia).

L'adattamento è applicato ovunque le dosi vengono mostrate o sommate: vista **Oggi**, modale ricetta (con avviso e marcatore ↻ sugli ingredienti adattati), vista **Settimana** (piccolo ↻ sul pasto) e **Lista della spesa** (le quantità tengono conto del pasto in cui la ricetta è collocata). Le funzioni pure sono in `js/domain.js` (`adaptIngredientForSlot`, `carbSourceForName`, `isPranzoCenaCross`).

# Generatore automatico della settimana

Funzioni pure in `js/domain.js` (`generateWeek`), nessun rendering DOM nel motore.

## Parametri (salvati per dispositivo, mai su Firestore)

Nella UI (vista Settimana → **Genera settimana**) il primo passo è il pannello **parametri**:

- **Cosa generare**: quali slot rigenerare (colazione, spuntino, pranzo, merenda, cena). Gli slot esclusi restano come sono e contano nelle frequenze;
- **🍳 Batch cena → pranzo** (0-5 giorni): quante cene vengono **pianificate in coppia** col pranzo del giorno dopo (doppia porzione). Le coppie vengono piazzate per prime, contano per intero nelle frequenze e alimentano il batch cooking automatico;
- **🔁 Stessa ricetta al massimo** (1-4 volte): tetto alle ripetizioni in settimana;
- **↻ Cross-slot pranzo ↔ cena**: il motore può pescare anche dal pasto opposto; i carboidrati si adattano da soli alle dosi del pasto scelto (come per lo scambio manuale);
- **Frequenze proteiche min–max** (pannello avanzato): intervallo settimanale per legumi, pesce omega-3, altro pesce/molluschi, pollame, manzo/vitello, latticini/formaggi, uova. "Valori predefiniti" ripristina quelli del manuale;
- **blocco di un singolo pasto** e **blocco dell'intera giornata**: mai sovrascritti e, soprattutto, **contano nelle frequenze** (bug corretto: prima venivano ignorati);
- **seed** opzionale: risultato riproducibile con lo stesso seed; "Rigenera" pesca un seed nuovo.

## Come lavora il motore

Vincoli rispettati:

- rispetta i tipi A/R del piano e **non modifica mai i dosaggi**;
- massimo un pasto di pesce al giorno (considerando anche i pasti bloccati/mantenuti);
- insegue **sia i minimi sia i massimi** delle frequenze proteiche: riempimento con punteggio (categorie sotto il minimo premiate) e **riparazione mirata** finale che scambia pasti generati per chiudere i minimi mancanti, senza violare massimi, pesce/giorno né spingere altre categorie sotto il proprio minimo;
- evita ripetizioni **immediate e settimanali** (`maxRepeats`);
- favorisce le combinazioni batch strutturali (`batchTemplates` cena anchor ↔ pranzo target) e pianifica le coppie **doppia porzione** richieste;
- ricette senza `proteinCategory`: la categoria viene **dedotta dagli ingredienti** (es. petto di pollo → pollame) invece di sfuggire a tutti i vincoli;
- gestisce catalogo vuoto/insufficiente con avvisi; quando i vincoli non sono soddisfabili li rilassa **a gradini**, con un unico avviso per pasto, anziché lasciare pasti vuoti.

Nella UI: anteprima con diff attuale → proposto, chip verdi/rossi delle frequenze rispetto all'intervallo scelto, elenco delle coppie batch programmate, applica (con backup) e annulla.

# Condivisione di ricette e settimana

## Invio

Il mittente sceglie se inviare solo le ricette oppure ricette + struttura della settimana:

```javascript
{ recipes: [...], includesPlan: true, plan: { ... } }
```

Le condivisioni precedenti (solo `recipes`) restano compatibili.

## Ricezione

Per una condivisione con settimana inclusa: **Solo ricette**, **Solo settimana**, **Importa tutto**, **Sostituisci ricette**, **Rifiuta**.

- **Solo ricette**: importa le ricette, mantiene il piano attuale aggiornando solo i riferimenti necessari;
- **Solo settimana**: mantiene il catalogo, importa il piano ricevuto e rimuove i riferimenti a ricette mancanti (con avviso);
- **Importa tutto**: ricette + piano, entrambi normalizzati, nessun riferimento invalido;
- **Sostituisci ricette**: distruttivo, con conferma esplicita (numero di ricette rimosse, slot che diventano vuoti) e backup.

## Conflitti

Anteprima prima dell'accettazione con: mittente, numero di ricette, ricette nuove, ricette identiche, conflitti, ricette non valide, ingredienti migrati e ingredienti senza `ingredientId`. Per ogni conflitto: **Mantieni la mia**, **Usa quella ricevuta**, **Salva entrambe con nuovo ID**.

# PWA offline

`sw.js` (cache versionata `piano-nutrizionale-shell-v8`):

- shell dell'app: `index.html`, CSS, JS, manifest, icone, `offline.html`;
- navigazione **network-first** con fallback in cache (e pagina offline comprensibile);
- asset statici **cache-first / stale-while-revalidate**;
- SDK Firebase compat da `www.gstatic.com/firebasejs/` in cache **cache-first** (file immutabili versionati): l'app si inizializza anche offline con la cache HTTP scaduta;
- nessuna intercettazione delle chiamate runtime di Firebase Auth, Firestore o App Check;
- pulizia delle cache obsolete;
- percorsi relativi (supporto sottocartella GitHub Pages `/pianoNutrizionale/`);
- banner **Nuova versione disponibile → Aggiorna ora** (nessun loop di refresh);
- funzionamento offline con i dati Firestore già persistiti localmente.

Test consigliati: primo caricamento, caricamento offline dopo un accesso precedente, aggiornamento del service worker, navigazione sotto `/pianoNutrizionale/`.

# Firebase App Check

App Check è già configurato in `main`: la **Site Key reCAPTCHA v3** pubblica è in `js/firebase.js` (`APP_CHECK_SITE_KEY`) e **non deve essere sostituita con un placeholder**. Non inserire mai la **Secret Key** (è riservata al server) né token debug nel repository.

### Configurazione Console

1. Firebase Console → **App Check** → **Apps** → la tua Web App;
2. scegli **reCAPTCHA v3**;
3. registra il dominio autorizzato (es. `TUO-USERNAME-GITHUB.github.io`);
4. copia la **Site Key** pubblica in `APP_CHECK_SITE_KEY` (già presente).

### Differenza Site Key / Secret Key

- **Site Key**: pubblica, sta nel codice client, inizia con `6L...`;
- **Secret Key**: riservata al server (Console → reCAPTCHA admin), **non va mai committata** né usata nel browser.

### Debug locale

In sviluppo locale usa il **provider debug** con un **debug token** locale (mai committato). Nella webapp i token debug vanno attivati solo tramite le impostazioni di sviluppo di App Check/Firebase.

### Monitoraggio ed Enforcement

- prima valida in **modalità monitoraggio** (App Check attivo ma senza blocchi);
- dopo aver verificato produzione e offline, attiva **Enforcement** per Firestore e Authentication dalla Console.

App Check **non sostituisce** Authentication né Firestore Rules: le regole in `firestore.rules` continuano a proteggere i dati utente per UID.

### Domini Firebase

- `piano-nutrizionale.firebaseapp.com` (auth);
- `TUO-USERNAME-GITHUB.github.io` (GitHub Pages) da aggiungere in **Authentication → Settings → Authorized domains**;
- dominio reCAPTCHA v3 corrispondente a quello di pubblicazione.

# Test

```bash
npm test
npm run syntax
git diff --check
```

I test (`test/domain.test.js`) coprono: migrazioni schema 3→4 e idempotenza, alias ingredienti, ingredienti senza ID, porzioni legacy, lista spesa per `ingredientId`, profili Uomo/Donna IPO/Coppia, crackers A/R, **adattamento carboidrati pranzo↔cena** (riconoscimento carboidrati, conversione dosi A/R, fallback configurabile pranzo→cena, propagazione alla lista spesa), batch indipendente da A/R, batch cena→pranzo futuro, attraversamento domenica→lunedì, batch parziale, `maxDays` diversi, quantità target A/R, copia/scambio pasti, blocchi, generatore e vincoli (frequenze su molti seed, **accoppiate batch cena → pranzo**, tetto ripetizioni, blocchi che contano nelle frequenze e nel pesce/giorno, slot disabilitati, cross-slot, inferenza della categoria dagli ingredienti, vincoli personalizzati), cataloghi vuoto/insufficiente, riferimenti piano mancanti, import Aggiungi/Sostituisci, conflitti condivisione (solo ricette/solo settimana/completa), backup, service worker (shell, cache, fallback offline, aggiornamento).

Smoke test locale:

```bash
python3 -m http.server 8080 --bind 0.0.0.0
```

# Note di sicurezza e deploy

- `firebase-seed.json` resta fuori dal repository (vedi `.gitignore` e lo ZIP separato);
- nessuna ricetta o dosaggio hardcoded: i dati arrivano da Firestore;
- non pubblicare Secret Key, token debug, credenziali o service account;
- il tema scuro AMOLED (nero puro) e l'assenza di notifiche sono intenzionali e vanno preservati.
