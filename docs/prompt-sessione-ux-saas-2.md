# Prompt completo per nuova sessione — Ricette, catalogo globale, Strutture dieta e console SaaS

Lavora sul repository `SylarPower/pianoNutrizionale`, partendo dall’ultima versione di `main` che include la PR #53 (`47f6f21`). La nuova sessione non ha accesso a questa conversazione: considera questo documento e i due JSON `catalogo-ingredienti-meller.json` e `schema-catalogo-strutture-v2.json` come allegati autorevoli forniti insieme al messaggio iniziale; questi tre file non sono ancora presenti su `main`. Prima di modificare il codice, leggi nel repository gli ADR, `docs/saas-data-contracts.md`, `docs/saas-runbook.md` e i test esistenti. Usa il JSON Schema allegato come direzione del nuovo contratto, adattandolo alle convenzioni effettive del repository, e conserva nel repository la documentazione/contratti aggiornati durante l’implementazione.

Non sacrificare sicurezza clinica, isolamento multi-tenant, accessibilità, compatibilità dei dati, audit e non-retroattività. Se trovi una vera incoerenza non risolta, chiedimi conferma prima di scegliere autonomamente.

## Consegna per fasi e catalogo futuro

La webapp deve poter essere implementata subito senza attendere il nuovo catalogo alimentare che verrà revisionato con il dott. Meller nei prossimi giorni.

- Non importare come dati approvati i 58 ingredienti del lotto provvisorio e non inventare le quantità mancanti.
- Implementa subito schema, repository/service layer, autocomplete, CRUD Strutture dieta, assegnazioni, permessi, migrazioni e UI usando come seed soltanto i dati Meller già autorevoli presenti nel repository.
- Progetta il catalogo come dato esterno/versionato, non come array hardcoded nella UI: il nuovo JSON/CSV approvato dovrà poter essere caricato successivamente senza riscrivere l’app.
- Predisponi per il platform admin un import globale JSON/CSV con validazione, deduplica, collisioni alias, preview, dry-run e commit atomico; nessun admin tenant o nutritionist può pubblicare il catalogo globale.
- Un ingrediente nuovo senza famiglia/dosaggi approvati può essere ricercabile, ma non deve attivare adattamenti, regex di fallback o quantità presunte.
- Documenta il formato esatto del file futuro e aggiungi fixture/test d’importazione; non bloccare il rilascio della nuova UX in attesa del dataset completo.
- Mantieni feature flag e migrazione in modo che l’attivazione del catalogo nuovo sia controllata e reversibile.

## Architettura dati richiesta

Il JSON Meller estratto non deve essere importato direttamente come catalogo globale: oggi mescola famiglie, espressioni di riconoscimento e quantità. Separalo in tre concetti.

1. **Catalogo ingredienti globale**
   - contiene ingredienti, nomi canonici, alias e categorie globali;
   - non contiene quantità;
   - usa ID stabili e riferimenti opzionali alle famiglie di dosaggio Meller;
   - è governato dal platform admin separato, secondo le decisioni esistenti;
   - è la fonte dell’autocompletamento nell’editor ricetta.
2. **Famiglie/motore di dosaggio Meller**
   - mantiene la logica che determina le quantità adattate per allenamento/riposo e pranzo/cena;
   - non riscrive mai la quantità originale della ricetta;
   - lavora tramite ID, non tramite etichette fragili o regex come contratto principale;
   - alias/regex legacy possono restare solo per migrazione e fallback controllato.
3. **Strutture dieta private del nutrizionista, dentro l’organizzazione**
   - sostituiscono il concetto UI di Rule set;
   - appartengono sempre a una sola organizzazione e hanno un `ownerUid`: nessun campo Ambito nella UI;
   - referenziano ingredienti globali/categorie/famiglie Meller e contengono regole, alternative e quantità configurabili per quella struttura;
   - ogni nutritionist vede, crea, duplica, modifica, confronta, archivia e assegna soltanto le proprie strutture e soltanto ai propri clienti autorizzati;
   - l’admin dell’organizzazione vede e gestisce tutte le strutture di tutti i nutrizionisti, con autore/proprietario sempre evidente e audit completo;
   - un nutrizionista non può leggere, usare, duplicare o modificare le strutture private di un altro nutrizionista;
   - le revisioni tecniche restano immutabili nel backend per audit, rollback e snapshot, ma il numero di versione non viene mostrato come campo operativo.

Migra l’attuale `MELLER_GRAMMATURE` senza perdere dati: le quantità entrano nel seed della Struttura dieta iniziale/motore Meller; ingredienti e categorie entrano nel catalogo globale normalizzato. Non trattare etichette di famiglia come catalogo esaustivo di singoli alimenti: crea record canonici e alias espliciti.

## Creazione e modifica ricette

1. La preparazione non deve essere obbligatoria. Una ricetta senza passaggi deve poter essere salvata, visualizzata, esportata, importata e condivisa senza errori.
2. In creazione, porta subito il focus sul nome e seleziona interamente “Nuova ricetta”, così la digitazione lo sostituisce. Non forzare questo comportamento durante la modifica di una ricetta esistente.
3. Correggi il bug della scheda Preparazione: al primo passaggio da Ingredienti a Preparazione, dati e controlli devono essere già correttamente renderizzati. Non deve servire tornare a Ingredienti e poi riaprire Preparazione.
4. Rimuovi la scheda Batch cooking dall’editor. Conserva la rilevazione automatica del batch quando ricette uguali sono vicine, come avviene attualmente.
5. Mostra un solo campo di quantità/grammatura originale per ingrediente. Non mostrare campi diversi per allenamento, riposo, pranzo o cena. Le quantità adattate sono derivate al livello del piano e non modificano la ricetta.
6. Il campo ingrediente deve essere un combobox/autocomplete accessibile alimentato dal catalogo globale:
   - suggerimenti filtrati mentre si digita;
   - ricerca tollerante a maiuscole, accenti e alias;
   - navigazione da tastiera, screen reader, touch e focus visibile;
   - visualizzazione della categoria per disambiguare risultati omonimi;
   - salvataggio di `ingredientId` stabile e nome visualizzato;
   - continua a consentire testo non riconosciuto, marcandolo come mapping mancante e permettendo la segnalazione al SaaS; non inventare mapping o quantità.
7. Mantieni compatibilità e migrazione con ricette precedenti, import/export, household e condivisione.

## Piano settimanale e quantità

8. Nella schermata Settimana aggiungi il controllo accessibile **“Ricette con quantità adattate alle linee guida”**.
9. Il controllo vale per il piano/settimana corrente:
   - attivo: pranzo e cena possono usare le quantità adattate della Struttura dieta assegnata e confermata, rispettando allenamento/riposo e pranzo/cena;
   - disattivo: tutte le ricette conservano sempre le quantità originali, in qualunque giorno/slot;
   - assignment assente, invalido, scaduto o non confermato: `original-only` anche con controllo attivo.
10. Prima di implementare, chiedimi solo quale debba essere il default del controllo per nuovi piani e la migrazione dei piani esistenti.
11. Il controllo persiste una modalità del piano, non quantità derivate nelle ricette. Preserva snapshot, lista spesa, batch e non-retroattività.
12. Nascondi a tutti il menu **Prezzi** e ogni entry point/routing. Non cancellare dati o logica: predisponi una feature flag disattivata per riattivarlo in futuro.

## Console nutrizionista/admin

13. Dopo il login, `nutritionist` atterra direttamente in **Clienti**. L’admin atterra in Clienti salvo una motivazione UX documentata e approvata. Mantieni l’isolamento dei clienti autorizzati.
14. Il contatore Coda ingredienti deve essere un badge accessibile:
    - > 0: rosso;
    - = 0: verde;
    - testo/ARIA che comunichi lo stato anche senza colore.
15. Su mobile, indicatori e cerchi non devono sovrapporsi al testo; devono occupare spazio nel layout e funzionare a 320 px.
16. Il drawer mobile si chiude cliccando/toccando il backdrop o fuori dal menu, con Escape, corretta gestione focus e ARIA.
17. Correggi la tipografia: `Inter` è dichiarato ma non incluso. Includilo preferibilmente self-hosted, con licenza e fallback corretti, senza dipendenza runtime da Google Fonts.

## Gestione “Struttura dieta”

18. Rinomina ovunque il concetto utente “Rule set” in **“Struttura dieta”**. Gli identificativi tecnici interni non devono comparire nelle operazioni normali.
19. Gestione e visibilità delle Strutture dieta:
    - ogni nutritionist può creare una Struttura dieta privata di cui diventa `ownerUid`;
    - può vedere, selezionare, duplicare, modificare, confrontare, archiviare/rimuovere dalla UI e ripristinare soltanto le proprie strutture;
    - può assegnare le proprie strutture soltanto ai clienti sui quali è autorizzato;
    - l’admin vede e gestisce tutte le strutture dell’organizzazione, incluse quelle dei diversi nutrizionisti;
    - l’admin può creare proprie strutture e assegnare qualunque struttura dell’organizzazione ai clienti autorizzati;
    - ogni card/selettore admin mostra chiaramente il proprietario/autore;
    - un nutritionist non può leggere né usare la struttura privata di un altro nutritionist;
    - “Elimina” usa archiviazione/soft-delete, per non distruggere audit, revisioni e assegnazioni storiche.
20. La pagina elenco/editor mostra in sola lettura:
    - **Data creazione**, con data e ora locali;
    - **Data ultima modifica**, con data e ora locali.
    Non mostra un campo “Versione”.
21. Ogni salvataggio pubblicato crea comunque una revisione immutabile interna. Il pulsante **Ripristina versione precedente** non riscrive la storia: crea una nuova revisione corrente copiando la revisione selezionata e registra autore, data e audit.
22. Aggiungi **CONFRONTA** per selezionare almeno 2 strutture, senza limite artificiale irragionevole. Mostra una matrice responsive con differenze tra ingredienti, categorie, alternative, quantità e regole; evidenzia valori uguali/differenti senza affidarti solo al colore. Il confronto non modifica dati.
23. La modifica della tabella alternative deve permettere di aggiungere/rimuovere ingredienti globali e modificare quantità. Usa autocomplete globale e validazione server-side. Nessuna modifica si applica retroattivamente a un cliente senza nuova conferma.
24. Admin e nutritionist possono auto-pubblicare senza seconda approvazione: il nutritionist soltanto le proprie strutture private, l’admin tutte quelle dell’organizzazione. Nessuno dei due può modificare strutture di altre organizzazioni o il catalogo globale.

## Assegnazione cliente semplificata

25. Elimina dalla UI **Ambito**: esistono solo Strutture dieta dell’organizzazione corrente.
26. Sostituisci Rule set ID con un selettore umano **Struttura dieta**, ricercabile, che mostra nome e ultima modifica. Il backend riceve un ID stabile risolto dalla selezione, mai testo arbitrario.
27. Elimina il campo UI **Versione**. Il backend assegna atomicamente la revisione pubblicata corrente e la salva nello snapshot interno.
28. **Checksum SHA-256**:
    - mai mostrato al nutritionist;
    - per l’admin, eventualmente visibile in sola lettura dentro “Dettagli tecnici”, mai modificabile;
    - sempre ricalcolato e verificato server-side.
29. Mantieni **Decorrenza**.
30. **Scadenza obbligatoria** per default. Per lasciarla vuota, admin/nutritionist deve selezionare esplicitamente un flag **“Senza scadenza”**. Il flag disabilita/svuota il campo e il backend rifiuta payload senza scadenza quando `withoutExpiration !== true`.
31. Elimina **Strategia** dalla UI e dal payload pubblico. Comportamento unico: una nuova assegnazione/revisione richiede conferma cliente; fino ad allora restano le quantità originali/snapshot precedente secondo la policy sicura.
32. Rinomina **Motivazione** in **Note**. Mantieni lunghezza massima, sanitizzazione e audit; chiarisci se il cliente può o non può leggerle (default: solo personale autorizzato).
33. Elimina l’anteprima differenze dal flusso di assegnazione. Il pulsante CONFRONTA appartiene alla gestione Strutture dieta, non alla modale di assegnazione.
34. La modale di assegnazione mostra soltanto:
    - Cliente;
    - Struttura dieta;
    - Decorrenza;
    - Scadenza oppure “Senza scadenza”;
    - Note;
    - Conferma.

## Gestione utenti, inviti e associazioni

35. Aggiungi nella console una sezione **Utenti** con permessi distinti:
    - l’admin gestisce nutritionist e clienti della propria organizzazione;
    - il nutritionist gestisce esclusivamente i propri clienti autorizzati;
    - il nutritionist non può invitare, rimuovere, promuovere o modificare altri nutritionist;
    - nessuno può operare su utenti o organizzazioni esterne al proprio perimetro.
36. **Aggiungere un cliente** significa creare un invito/associazione, non impostare una password per conto suo:
    - ricerca soltanto per username esatto normalizzato, senza endpoint di enumerazione utenti;
    - se l’account esiste, invia una richiesta di collegamento che il cliente deve accettare;
    - se non esiste, genera un invito monouso con scadenza da usare dopo la registrazione;
    - l’invito contiene organization, nutritionist proponente, ruolo richiesto, scadenza, stato e token memorizzato solo in forma hash;
    - accettazione/rifiuto devono essere idempotenti, notificati e registrati nell’audit;
    - nessun professionista vede o imposta password, token Firebase o credenziali del cliente.
37. Quando un nutritionist aggiunge un cliente, l’associazione risultante è con quel nutritionist. Quando un admin aggiunge un cliente, deve poter scegliere il nutritionist destinatario oppure lasciarlo temporaneamente senza professionista.
38. **Rimuovere un cliente** significa rimuovere/revocare soltanto l’associazione professionale:
    - non eliminare Firebase Auth, account personale, household, ricette, piano originale o backup;
    - revocare immediatamente l’accesso del professionista ai dati del cliente e viceversa;
    - sospendere/chiudere le assegnazioni della Struttura dieta provenienti da quell’associazione;
    - al successivo refresh il cliente torna obbligatoriamente a `original-only` e perde l’accesso incluso alla Lista della spesa;
    - conservare soltanto audit e snapshot necessari secondo retention/GDPR, senza lasciare letture cross-client;
    - mostrare una conferma forte che spieghi gli effetti prima della rimozione.
39. Il cliente deve poter accettare o rifiutare il collegamento e chiedere di scollegarsi. La richiesta di scollegamento non deve cancellare il suo account personale.
40. Gestione nutritionist da parte dell’admin:
    - invito a entrare nell’organizzazione con ruolo esclusivamente `nutritionist`;
    - attivazione, sospensione e rimozione della membership senza eliminare l’account personale;
    - prima di rimuovere un nutritionist, mostrare clienti associati e strutture private coinvolte;
    - impedire una rimozione distruttiva: richiedere prima riassegnazione o scollegamento dei clienti;
    - le Strutture dieta e revisioni storiche restano visibili all’admin per audit, ma non sono più modificabili/pubblicabili dal nutritionist rimosso;
    - nessuna struttura privata viene trasferita silenziosamente a un altro nutritionist.
41. Le liste utenti devono supportare stato, ricerca, paginazione, realtime e responsive. Mostra codici/nome minimo necessario, non dati clinici o email interne non pertinenti. Tutte le mutazioni avvengono via callable server-side con App Check, autorizzazione, idempotenza e audit.
42. Mantieni separati i concetti di account, membership organizzazione, associazione nutritionist-cliente, assignment nutrizionale e household. Nessuno di questi deve conferire implicitamente privilegi negli altri.

## Accesso alla Lista della spesa

43. Aggiorna la policy di accesso:
    - cliente con associazione attiva a un nutritionist: Lista della spesa sempre disponibile, senza pubblicità;
    - cliente senza associazione professionale attiva: Lista della spesa bloccata, sbloccabile per 24 ore solo dopo completamento di una rewarded ad;
    - provider pubblicitario reale ancora assente: mantenere astrazione provider-agnostic, consenso/privacy e feature flag disattivata; finché è disattivata il cliente non associato vede “In arrivo” e non può simulare lo sblocco;
    - la rimozione dell’associazione revoca l’entitlement professionale immediatamente; un eventuale reward pubblicitario già valido resta regolato dalla sua scadenza e dalla policy documentata;
    - entitlement e timestamp sono verificati server-side, non affidati soltanto a localStorage/orologio client.

## Conferma cliente

44. Una nuova Struttura dieta, una revisione o un catalogo mapping aggiornato non deve essere nascosto nelle Impostazioni: mostra un modal/popup evidente come l’aggiornamento obbligatorio dell’app.
45. Il popup deve essere accessibile, responsive e spiegare chiaramente che:
    - nulla viene applicato senza conferma;
    - le ricette originali restano al sicuro;
    - il cliente può capire cosa sta accettando con copy non tecnico.
46. Preserva snapshot e checksum interni. Nessun aggiornamento retroattivo silenzioso.

## Sicurezza e contratti

- Brand: **Piano**.
- Ruoli tenant: soltanto `admin` e `nutritionist`.
- Catalogo ingredienti/categorie globali: platform admin separato.
- Strutture dieta: organization-scoped ma private per `ownerUid`; il nutritionist accede soltanto alle proprie, mentre l’admin dell’organizzazione accede a tutte.
- Le assegnazioni già confermate conservano lo snapshot anche se cambia il nutrizionista; il nuovo nutrizionista non ottiene per questo accesso alla struttura privata del precedente.
- Scritture SaaS solo via Cloud Functions con App Check in produzione.
- Autorizzazione server-side, audit, idempotenza, revisioni immutabili, rollback tracciato, caching/realtime e isolamento organization/client/household.
- Lista della spesa inclusa senza pubblicità per clienti con associazione nutritionist attiva; per clienti non associati, rewarded ad di 24 ore ancora disattivata e senza provider reale.
- Mapping mancanti gestiti dal SaaS, non creati dall’utente finale.
- Aggiorna Firestore Rules, indici, contratti, ADR/runbook, migrazione legacy e seed emulator.
- Il setup Emulator deve funzionare senza modificare manualmente sorgenti, disabilitando App Check esclusivamente quando l’ambiente emulator è rilevato in modo sicuro.

## UX, test e criteri di accettazione

- Nessuna sovrapposizione/overflow da 320 px a desktop; target touch 44×44; tastiera, screen reader, focus, Escape, backdrop e `prefers-reduced-motion`.
- Testa: preparazione opzionale; autofocus/selezione nome; primo rendering Preparazione; assenza tab Batch con batch automatico invariato; quantità singola; autocomplete ingredienti/alias/unknown; toggle settimana; Prezzi nascosto; landing ruolo; badge 0/>0; drawer mobile; CRUD/duplica/archivia/ripristina/confronta Strutture; privacy `ownerUid` tra due nutrizionisti della stessa organizzazione e visibilità completa admin; scadenza obbligatoria/flag; campi tecnici nascosti; popup cliente; invito esistente/nuovo/scaduto/riutilizzato/rifiutato; assenza di enumerazione username; permessi admin/nutritionist; revoca associazione senza cancellazione account; sospensione assignment e ritorno `original-only`; accesso Spesa associato vs non associato e reward 24h; rimozione nutritionist con clienti pendenti; non-retroattività; isolamento Rules.
- Aggiungi test di migrazione dal vecchio rule set e dal JSON Meller monolitico ai nuovi catalogo globale + Struttura dieta.
- Esegui `npm test`, `npm run test:functions`, `npm run test:rules`, `npm run syntax`, `npm run smoke`, audit production root/Functions e `git diff --check`.
- Esegui verifiche visuali reali desktop/tablet/mobile e non dichiarare test non realmente effettuati.
- Crea una PR e verifica i check. Se emergono vere decisioni prodotto non definite, chiedi prima di implementare.
