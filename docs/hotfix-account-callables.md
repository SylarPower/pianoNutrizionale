# Hotfix collegamenti account — Passo 0

## Ambito

Questo rilascio riguarda **solo il Passo 0** della richiesta: errori delle callable al login console e nel collegamento professionista. I passi 1–4 (micro-UI, quantità/unità, segnalazioni automatiche, gestione clienti completa) e i relativi nuovi test non sono implementati in questa PR.

- `getMyMemberships`: implementazione richiesta con enumerazione delle organizzazioni e letture puntuali `members/{uid}`. Nessuna dipendenza da un campo `uid` nei documenti. Restano ammessi solo ruoli professionali attivi e admin piattaforma attivo.
- `listMyClientLinkRequests` e `respondClientLink`: helper condiviso con enumerazione delle organizzazioni e query **di collezione** `targetUid == UID autenticato`. Il requestId non è derivabile dal solo UID: per le richieste non è possibile usare la stessa lettura puntuale delle membership. Si usa l'indice single-field COLLECTION automatico, senza collection-group, migrazioni, nuove regole o indici.
- Rimosso il limite di 20 applicato prima del filtro di stato: gli inviti storici non devono nascondere quelli pendenti. La risposta agli inviti riusa lo stesso percorso, preservando transazioni, audit, idempotenza e controlli esistenti.
- L'errore della sezione cliente non viene più descritto impropriamente come assenza di connessione. Lo stato rimane sconosciuto, con pulsante Riprova; una risposta riuscita ripristina lo stato reale.
- SW: `CACHE_VERSION` 65 → 66, un solo incremento; `js/app.js` è già nella shell.

## Diagnosi e limiti

La query `collectionGroup('members').where(FieldPath.documentId(), '==', uid)` era presente nel checkout: il confronto con UID semplice è invalido in collection group.

La seconda causa (indice collection-group su `clientLinkRequests.targetUid` mancante) rimane **probabile, non verificata nei log di produzione**. Il tentativo `firebase functions:log --only listMyClientLinkRequests --project piano-nutrizionale` non è eseguibile qui: Firebase CLI assente. La configurazione degli indici nel repository non contiene quell'indice. La modifica elimina tale dipendenza anche per l'accettazione degli inviti.

Trade-off: costo e parallelismo crescono con il numero di organizzazioni; la lettura delle richieste cresce con lo storico del singolo UID. Adatto al contesto dichiarato di poche organizzazioni. Se crescono, introdurre un indice inverso additivo/paginazione con test, non ripristinare un limite che nasconda inviti. Le organizzazioni devono esistere come documenti, come nel modello attuale; sottocollezioni orfane non vengono enumerate. Eventuali esclusioni manuali degli indici automatici in produzione non sono verificabili da questa sandbox.

Nessuna scrittura, cancellazione o migrazione di dati introdotta; nessun cambiamento alle dosi o ai controlli ruolo.

## Verifiche locali

- `npm test`: 217/217.
- `npm run test:functions`: 32/32, inclusi sei nuovi test con stub sulle callable reali (wrapper autenticazione e App Check inclusi nella verifica di configurazione).
- `npm run syntax`: OK.
- `npm run smoke`: OK.
- `node --check js/firebase.js`, `js/app.js`, `js/admin.js`, `sw.js`: OK.
- `npm run test:rules`: tentato ma non avviato, `firebase: not found`; manca anche Java.
- Nessuna verifica live di Auth/App Check/Firestore in produzione, nessun deploy dalla sandbox. Gli stub non provano la configurazione effettiva degli indici o la validazione reale dei token.

## Procedura sul PC dopo il merge (utente)

1. Apri GitHub Desktop sul repository `pianoNutrizionale`, seleziona **main**, premi **Fetch origin**, poi **Pull origin** se compare. Se segnala modifiche locali o conflitti, fermati: non scartare file e non usare reset.
2. Dal menu **Repository → Open in Terminal**, apri il terminale della cartella appena aggiornata. Non eseguire il deploy da una vecchia cartella o da un vecchio ZIP.
3. Nel terminale esegui un comando per volta:

   ```sh
   git log -1 --oneline
   npm --prefix functions ci
   firebase deploy --only functions --project piano-nutrizionale
   ```

   Il primo comando serve a verificare che sia arrivato il merge di questa PR. Per le Functions usa Node.js 22, come richiesto da `functions/package.json`. Se Firebase chiede l'accesso, esegui `firebase login` sul tuo PC e ripeti il deploy. Non condividere password o codici. Se un comando fallisce, fermati e conserva il messaggio d'errore.
4. Attendi **Deploy complete!**. Se viene proposta una cancellazione di funzioni o dati, non confermarla: fermati e chiedi verifica. Questo hotfix non richiede cancellazioni. Non eseguire deploy di Hosting: il sito resta su GitHub Pages. Non serve `firestore:indexes` per questa soluzione.
5. Attendi la pubblicazione GitHub Pages. Apri l'app e applica l'aggiornamento PWA quando compare il banner; poi ricarica. Il solo aggiornamento del sito **non** aggiorna le Cloud Functions.
6. Nella console professionisti, prova il login con un account professionale attivo: non deve apparire il 500 di `getMyMemberships`. Un account solo cliente deve continuare a essere rifiutato.
7. Nell'app cliente apri **Impostazioni → Collegamento professionista → Riprova**: verifica inviti o collegamento effettivo. Con un account di prova e un invito concordato, verifica accettazione/rifiuto. Non usare clienti reali per prove che ne cambino il collegamento senza accordo.
8. Se resta un errore, esegui sul PC:

   ```sh
   firebase functions:log --only getMyMemberships,listMyClientLinkRequests,respondClientLink --project piano-nutrizionale
   ```

   Riporta codice errore e orario, oscurando UID, nomi e altri dati personali. I messaggi reCAPTCHA `401 pat`, `private-token` e `requestStorageAccess` indicati nella richiesta non sono oggetto di questo fix.
