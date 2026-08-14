# 🥗 Piano Nutrizionale

WebApp PWA privata per gestire colazioni, spuntini, pranzi, cene, batch cooking e lista della spesa. Usa Firebase Authentication e Cloud Firestore.

## Cosa offre

- accesso personale con username e password, senza email mostrata nell'interfaccia;
- account utilizzabile anche con ricettario completamente vuoto;
- creazione manuale di ricette con dosi Donna IPO A/R e Uomo A/R;
- importazione ed esportazione JSON di una ricetta o dell'intero catalogo;
- condivisione di una ricetta o di tutto il catalogo con un altro username;
- richieste ricevute accettabili con modalità **Aggiungi** o **Sostituisci tutte**, oppure rifiutabili;
- catalogo opzionale di partenza con 62 ricette, fornito nel file esterno `firebase-seed.json`;
- colazioni e spuntini inclusi nel piano;
- crackers dello spuntino mattutino aggiunti nei giorni A e rimossi nei giorni R;
- batch cooking mostrato solo quando la combinazione attuale lo consente;
- alternative alimentari di Meller sempre consultabili nelle Impostazioni;
- nessuna funzionalità di notifica.

## Dove si trovano i dati

Le ricette non sono hardcoded nel repository GitHub. Il codice contiene soltanto interfaccia, regole di visualizzazione e manuale di Meller.

Dopo il salvataggio, le ricette si trovano nel documento privato:

```text
users/{uid}/content/recipeCatalog
```

Altri dati:

```text
users/{uid}/config/weeklyPlan
users/{uid}/config/shoppingList
usernames/{username}
recipeShares/{requestId}
```

`usernames` contiene solamente username e UID, necessari per individuare il destinatario. `recipeShares` contiene le richieste ancora da accettare o rifiutare.

## Chiamate Firestore

Un normale avvio esegue in parallelo tre letture documento:

1. catalogo completo;
2. piano settimanale;
3. lista della spesa.

Il catalogo è un unico documento: 62 ricette non generano 62 letture. Non ci sono listener realtime permanenti. La casella delle condivisioni viene interrogata solo quando si preme **Ricevute**.

Operazioni indicative:

- esportazione JSON: zero chiamate Firebase;
- importazione: una scrittura catalogo e, se necessario, una scrittura piano;
- invio: una lettura per cercare il destinatario e una scrittura richiesta;
- accettazione: catalogo, piano e rimozione richiesta vengono gestiti in un unico batch;
- rifiuto: una cancellazione della richiesta.

La cache offline Firestore è abilitata. Tema e profilo porzioni restano in `localStorage`.

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

- ogni utente possa modificare solo i propri dati;
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

## Schema 4 e servizi evoluti

Il catalogo usa `schemaVersion: 4`. Ogni ingrediente ha `ingredientId`; gli alias comuni vengono normalizzati senza cambiare nome o dosaggio. La migrazione è idempotente e mantiene leggibili le porzioni legacy (`ipo`, `training`, `rest`). Le regole batch legacy vengono convertite in `batchTemplates`, con task e conservazione espliciti: i valori migrati sono prudenti (1 giorno, oppure 0 per il fresco) e devono essere validati da un professionista della sicurezza alimentare.

Le funzioni pure in `js/domain.js` gestiscono migrazione, aggregazione della spesa, batch circolare domenica→lunedì e copia/scambio pasti. Il catalogo resta un singolo documento; la UI rifiuta cataloghi oltre 900 KB per restare sotto il limite Firestore di 1 MiB.

### Backup e App Check

Le operazioni distruttive devono usare il documento privato `users/{uid}/backups/previous` (una sola copia, ripristinabile una volta) quando viene completata la relativa UI. App Check è predisposto con `APP_CHECK_SITE_KEY` in `js/firebase.js`: sostituire il placeholder con una site key reCAPTCHA v3 pubblica. In Firebase Console: **App Check → Apps → Web → reCAPTCHA v3**, registrare il dominio GitHub Pages e copiare la site key. In locale usare il provider debug solo impostando il token tramite gli strumenti Firebase; non committare token. Verificare prima in modalità monitoraggio, poi attivare Enforcement per Firestore e Authentication dopo aver validato produzione/offline.

Il service worker v4 usa shell versionata, fallback offline per la navigazione, cache degli asset same-origin e non intercetta richieste Firebase. Il banner consente di applicare gli aggiornamenti senza loop. Per GitHub Pages tutti i riferimenti sono relativi (`./`).

### Test

Eseguire `npm test`, `npm run syntax` e `git diff --check`. I test coprono migrazioni, alias, aggregazione, batch circolare/parziale, profilo A/R e copia/scambio. Le ricette e il seed restano esterni al repository.
