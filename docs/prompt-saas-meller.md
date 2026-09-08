# Prompt autonomo — SaaS/admin Meller per Piano Nutrizionale

Sei un agente di sviluppo che lavora in una nuova sessione sul repository `SylarPower/pianoNutrizionale`.

## Contesto

L’app attuale è una PWA vanilla HTML/CSS/JavaScript, senza framework, bundler o dipendenze runtime aggiuntive. Il client contiene già:

- ricettario personale fedele alle dosi originali;
- piano settimanale e contesto Meller per slot pranzo/cena;
- adattamento contestuale non distruttivo, con dosi Uomo/Donna × Allenamento/Riposo a crudo;
- gestione di ingredienti liberi, mapping mancanti e blocco dell’applicazione quando il mapping non è affidabile;
- import/export, household/account link, generatore, batch cooking, lista spesa, registro prezzi e tema dark AMOLED;
- Firebase client esistente in `js/firebase.js`;
- primitive di dominio in `js/domain.js` e test Node in `test/`.

La fase precedente **non** ha implementato il SaaS. Ha soltanto lasciato nel client le segnalazioni locali e i metadati necessari per poter raccogliere in futuro i casi di mapping mancanti.

## Obiettivo della sessione

Progettare e implementare il livello SaaS/admin multi-tenant che permetta di governare in modo sicuro e versionato:

1. segnalazioni di ingredienti non riconosciuti o ambigui;
2. mapping Meller approvati e loro alias;
3. versioni delle regole e delle grammature pubblicate;
4. ruoli, organizzazioni, household, inviti e permessi;
5. notifiche operative e contenuti editoriali approvati;
6. audit, privacy, consenso e gestione GDPR;
7. strumenti admin senza esporre segreti o privilegi nel client.

Non riscrivere il ricettario e non trasformare automaticamente le ricette originali nel database utente. L’originale deve restare la sorgente immutabile dell’utente; il contesto Meller deve rimanere una risoluzione/versione applicata al piano.

## Vincoli non negoziabili

- Prima di modificare il codice, ispeziona struttura, test, Firebase config, regole Firestore e flussi household esistenti.
- Mantieni il client vanilla: HTML/CSS/JS, senza framework, bundler, transpiler o nuove dipendenze runtime, salvo una motivazione architetturale esplicita e approvata.
- Non introdurre segreti nel client. Tutte le operazioni privilegiate devono passare da Cloud Functions/server-side e dalle Security Rules.
- Non modificare silenziosamente le costanti canoniche del client attuale. Pianifica una migrazione verso configurazioni versionate server-side con compatibilità e rollback.
- Mantieni compatibilità con import/export, piani legacy, household, batch cooking, lista spesa, prezzi, PWA e dark AMOLED.
- Non eliminare test esistenti: devono continuare a passare. Aggiungi test di dominio, Security Rules, funzioni server e flussi UI.
- Nessuna raccolta automatica di dati sensibili non necessaria. Minimizza i dati, applica retention e prepara export/cancellazione secondo GDPR.
- Ogni evento admin deve essere idempotente, auditabile e deduplicabile.
- Usa versionamento esplicito per mapping, regole, contenuti e migrazioni. Mai aggiornamenti distruttivi senza backup e rollback.
- Se emerge un’ambiguità di dominio che può cambiare il comportamento clinico/nutrizionale, fermati e chiedi conferma prima di scegliere.

## Architettura richiesta

### 1. Separazione dei piani dati

Definisci chiaramente questi livelli:

- **Account**: identità Firebase Auth e preferenze personali.
- **Household**: condivisione del piano/ricettario già esistente, senza confonderla con l’organizzazione SaaS.
- **Organization/tenant**: spazio SaaS per admin/editor, policy, configurazioni, contenuti e segnalazioni.
- **Cataloghi globali versionati**: ingredienti, alias, mapping Meller, regole e contenuti pubblicabili.
- **Snapshot applicativi**: il piano utente deve poter conservare la versione delle regole usata per una risoluzione, così una pubblicazione futura non cambia retroattivamente la storia.

Proponi un modello Firestore con documenti e subcollection, evitando query impossibili o scansioni globali dal client. Ogni documento deve avere `schemaVersion`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy` quando applicabile.

### 2. Ruoli e autorizzazioni

Progetta almeno:

- `owner`: gestione tenant e amministratori;
- `admin`: mapping, regole, utenti, audit e contenuti;
- `editor`: proposta/modifica contenuti e mapping, senza pubblicazione finale se la policy lo vieta;
- `reviewer`: revisione e approvazione;
- `viewer`: sola lettura;
- utente finale separato, con accesso solo ai propri dati/household e alle configurazioni pubblicate.

Usa custom claims soltanto per informazioni coarse-grained e non come unica fonte di verità. La fonte autorevole deve essere il documento di membership verificato server-side. Definisci matrice permessi, revoca, inviti con scadenza, accettazione idempotente e protezione contro escalation.

### 3. Mapping Meller e segnalazioni

Progetta un flusso completo:

1. il client crea una segnalazione non privilegiata tramite callable function o endpoint protetto;
2. la segnalazione contiene solo il minimo necessario: fingerprint normalizzato, testo ingrediente, contesto slot, tipo di errore, versione regole e metadati tecnici;
3. deduplica per tenant/fingerprint/versione e rate limit server-side;
4. stato: `open`, `triaged`, `needs-review`, `resolved`, `rejected`, `duplicate`;
5. audit trail immutabile per ogni transizione;
6. un admin può proporre alias, famiglia, gruppo, dose o stato “libero”; 
7. un reviewer può approvare/pubblicare una nuova versione;
8. la pubblicazione non altera le ricette originali già salvate;
9. il client scarica solo il catalogo pubblicato e verificato, con cache e fallback all’ultima versione valida;
10. la risoluzione di un mapping deve essere deterministica e testabile offline.

Prevedi distinzione tra:

- ingredienti liberi espliciti;
- ingredienti guidati;
- ingredienti sconosciuti;
- gruppi ambigui;
- alias locali/tenant e alias globali;
- conflitti tra mapping e priorità di risoluzione.

### 4. Versionamento delle regole

Disegna un formato per `mellerRuleSet` immutabile dopo la pubblicazione, con:

- `ruleSetId`, semver o versione monotona, stato draft/review/published/retired;
- checksum;
- origine e note di revisione;
- data di efficacia;
- compatibilità schema;
- changelog leggibile;
- eventuale approvazione doppia;
- possibilità di rollback all’ultima versione valida.

Il client deve poter risolvere un piano con la versione fissata nello snapshot oppure, esplicitamente, migrare a una versione nuova mostrando l’impatto. Non cambiare le grammature canoniche esistenti senza una procedura di revisione e test di regressione.

### 5. Admin UI

Realizza una dashboard vanilla accessibile e responsive con:

- coda segnalazioni filtrabile e paginata;
- dettaglio ingrediente/fingerprint e casi d’uso anonimizzati;
- editor mapping con preview della risoluzione;
- diff tra versioni e changelog;
- workflow proposta → revisione → pubblicazione;
- utenti, tenant, membership, inviti e revoche;
- audit log ricercabile;
- contenuti editoriali con bozza, revisione, pubblicazione, archiviazione;
- indicatori operativi senza esporre dati personali non necessari.

Niente logica di autorizzazione affidata soltanto a pulsanti o route client: ogni callable e ogni documento devono essere verificati lato server/rules.

### 6. Notifiche

Progetta notifiche in-app e, solo se necessario, email tramite provider server-side:

- nuova segnalazione assegnata;
- mapping approvato o rifiutato;
- invito tenant;
- pubblicazione/rollback di regole;
- contenuto editoriale pubblicato.

Prevedi preferenze, deduplica, stato letto/non letto, retry e dead-letter senza inserire token o credenziali nel client.

### 7. GDPR e sicurezza

Definisci e implementa almeno:

- minimizzazione e classificazione dei dati;
- retention configurabile per segnalazioni e audit;
- export dati utente/tenant;
- cancellazione o anonimizzazione con job server-side;
- gestione consenso per comunicazioni;
- privacy notice e registro delle finalità;
- accesso ai dati limitato per tenant;
- App Check, rate limiting, validazione schema, sanitizzazione e logging senza dati sensibili;
- Security Rules testate con emulatori per utente, household, editor, reviewer e admin;
- protezione da IDOR, replay di inviti e callable non autorizzate.

## Piano di lavoro obbligatorio

1. **Audit iniziale**: mappa file, flussi dati, regole Firebase, deploy, test e rischi.
2. **Decision record**: scrivi un breve ADR con modello tenant, ruoli, collections, versione regole e strategia di migrazione.
3. **Contratti**: definisci schema JSON/TypeScript-like per API, Firestore, eventi, mapping e audit, pur restando vanilla nel runtime.
4. **Emulatori e test di sicurezza**: prepara fixture minime e test di accesso negato/concesso prima delle feature UI.
5. **Backend incrementale**: funzioni idempotenti, validazione, audit e mapping pubblicato.
6. **Client incrementale**: feature flag, fallback offline, visualizzazione versione e invio segnalazioni senza bloccare il piano locale.
7. **Admin UI**: implementa una slice verticale completa, non una dashboard finta.
8. **Migrazione**: importa eventuali segnalazioni locali in modo opt-in, deduplicato e reversibile.
9. **Osservabilità**: metriche di errori, tempi di risoluzione, backlog e pubblicazioni.
10. **Verifica finale**: test esistenti + nuovi test, `node --check`, smoke, emulatori, security rules e piano di rollback.

## Deliverable richiesti

- ADR architetturale;
- schema dati e matrice permessi;
- Security Rules e test emulatori;
- Cloud Functions/server handlers idempotenti;
- contratto/versioning del catalogo Meller;
- admin UI funzionante per la coda mapping;
- client integrato con feature flag e fallback;
- migrazione dati documentata e reversibile;
- test automatici e manual checklist;
- runbook deploy, rollback, backup e incident response;
- elenco esplicito di ciò che resta fuori scope.

Prima di chiudere la sessione, mostra:

- quali file hai modificato;
- quali rischi restano;
- come un reviewer può provare il flusso end-to-end in emulatori;
- risultati esatti dei test;
- eventuali decisioni che richiedono approvazione di prodotto o nutrizionale.
