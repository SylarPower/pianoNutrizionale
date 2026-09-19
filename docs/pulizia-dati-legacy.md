# Pulizia dei dati vecchi (legacy) su Firebase — guida passo passo

Versione "senza terminale": ogni passaggio si fa **con il mouse nel browser**.
Se un passaggio ha una riga grigia da copiare, vuol dire che esiste anche una
scorciatoia per chi usa il terminale: **puoi ignorarla**, trovi sempre la
versione con i clic.

Obiettivo: cancellare i dati delle vecchie organizzazioni e delle collezioni
morte **senza rompere gli account attivi** (`cliente-1`, `cliente-2`, `admin`,
`cliente`, `nutrizionista`) e senza rompere il codice che è in produzione.

> ⚠️ Leggi prima il **Passo 0**: contiene l'elenco delle cose che **non**
> vanno cancellate. È la parte più importante della guida.

> 🧭 **Da dove partire?** Se devi ancora **costruire** la struttura nuova
> (organizzazione `pianoNutrizionale`, creatore, nutrizionista, catalogo, collegamento di
> `cliente-1` e `cliente-2`), fai prima
> [ripartenza-firebase.md](ripartenza-firebase.md): qui si cancella, là si
> costruisce. Cancellare per primo lascerebbe gli account senza appartenenza.

---

## Passo 0 — Cosa NON cancellare (leggilo prima di tutto)

Un piano di pulizia precedente diceva che si potevano cancellare `users`,
`households`, `recipes`, `shoppingList` e `globalIngredientCatalog/config`.
**Non è vero con il codice di oggi**: cancellarli romperebbe l'app in
produzione. Questo documento corregge quel piano.

| Cosa lasciare stare | Perché |
|---|---|
| `users/{uid}/content/recipeCatalog`, `users/{uid}/config/shoppingList`, `users/{uid}/config/weeklyPlan`, `users/{uid}/backups/*` | È il magazzino **attuale** dell'app: `js/firebase.js` ci legge e ci scrive a ogni utilizzo (righe 476, 484, 508). Vale anche per `cliente-1` e `cliente-2` dopo il re-import. |
| `households/**` | Area condivisa degli account collegati: usata da `js/firebase.js` (righe 456-501, 667-688). |
| `globalIngredientCatalog/config/docs/import` e `.../denylist` | Le leggono le Cloud Functions in produzione (`functions/src/index.js:1188` per l'import, `functions/src/domain.js:598` per la denylist). Non sono "refusi". |
| `globalIngredientCatalog/current/**` | Catalogo ingredienti globale attivo (`functions/src/index.js:118-120`). |
| `usernames/**` | Rubrica nickname → UID: serve a inviti, condivisioni e ricerca utenti (`functions/src/index.js:1432-1438`). |
| `recipeShares/**`, `priceEntries/**`, `priceMeta/**`, `accountClientLinks/**`, `platformMembers/**` | Funzionalità attive: condivisioni, prezzi, collegamenti account. |
| `organizations/pianoNutrizionale/**` | È l'organizzazione SaaS **in uso**. Le Functions accettano solo questa (`SINGLE_ORGANIZATION_ID = 'pianoNutrizionale'`, `functions/src/domain.js:5`). |

La rifondazione pre-lancio (ADR 0008) ha eliminato dal codice ruleSets,
globalRuleSets, code mapping e ogni ponte legacy: le collezioni elencate qui
non sono più lette da nessuna Function né dal client.

**In pratica si cancellano**: le organizzazioni diverse da `pianoNutrizionale`
(Passo 3) e le collezioni del modello eliminato — `globalRuleSets`,
`mappingReports`, `mappingProposals` — senza controlli preliminari (Passo 4).

---

## Passo 1 — Il paracadute (5 minuti)

Prima di cancellare qualunque cosa, attiva la rete di sicurezza.

1. Vai su <https://console.cloud.google.com> con l'account **proprietario** del
   progetto.
2. Nella barra in alto cerca **Firestore** e aprilo.
3. Nella pagina **Databases** clicca il database `(default)`.
4. Nel menu a sinistra clicca **Disaster Recovery**.
5. Clicca **Edit** (Modifica), spunta **Enable point-in-time recovery** e premi
   **Save**.
6. Ricarica la pagina: nella sezione *Settings* la voce **Retention period**
   deve dire **7 days**.

Cosa significa: da adesso, per 7 giorni, puoi riportare il database a **qualsiasi
minuto** degli ultimi 7 giorni. È il tuo "annulla".

Note:

- ha un piccolo costo di archiviazione; si può disattivare dalla stessa pagina
  quando la pulizia è finita e verificata;
- **la protezione parte da ora**: non copre i 7 giorni precedenti;
- i file di export del Passo 2 restano per sempre sul tuo computer e sono la
  copia "umana" dei dati più preziosi.

---

## Passo 2 — Account con dati storici (es. `cliente-1`, `cliente-2`): export e re-import (nessuno script)

I dati storici degli account clienti (es. `cliente-1` e `cliente-2`) **non vengono migrati da nessuno
script**: si rifà un export e un import dall'app. Il formato è già coperto dai
test automatici (`test/saas-client.test.js`, round-trip
`piano-nutrizionale-recipes`).

Da fare **una volta per ciascun account**, e **prima** di qualsiasi
cancellazione di dati personali.

1. Apri l'app con l'account del primo cliente (es. `cliente-1`). Il nickname non cambia.
2. Vai nella schermata **Ricettario**.
3. Premi il pulsante **Esporta**. Scarica un file chiamato
   `ricette-<nickname>-AAAA-MM-GG.json`.
4. Apri il file con un editor di testo e controlla che contenga queste righe:
   - `"format": "piano-nutrizionale-recipes"`
   - `"schemaVersion": 5`
   - `"recipes": [ ... ]`
   - `"plan": { ... }` (c'è perché l'export include anche il piano)

   Se manca `plan` o `recipes` è vuoto, non procedere: rifai l'export.
5. Nella stessa schermata **Ricettario** premi **Importa** e seleziona lo
   stesso file.
6. Scegli la modalità **Sostituisci**. L'app crea prima un backup automatico in
   `users/{uid}/backups/previous`, poi riscrive catalogo ricette + piano +
   lista della spesa in un'unica operazione.
7. Controlla a schermo: settimana completa, ricette presenti, lista della spesa
   coerente.
8. Ripeti dal punto 1 con gli altri account clienti.

Se l'import si blocca con un errore, **non insistere**: il validatore ha
rifiutato il file (ricette vuote, pasti sconosciuti, riferimenti mancanti).
Sistemalo o rifai l'export; i dati su Firebase nel frattempo non sono stati
toccati.

> Correzione rispetto alla guida precedente: l'export **non** è nelle
> Impostazioni. I pulsanti **Esporta** / **Importa** sono nella schermata
> **Ricettario** (`js/app.js:1532-1533`, funzione `exportAllRecipes`).

---

## Passo 3 — Cancella le organizzazioni diverse da `pianoNutrizionale`

Perché è sicuro:

- le Cloud Functions accettano soltanto l'organizzazione `pianoNutrizionale`: qualunque
  altro ID viene respinto (`enforceSingleOrg`, `functions/src/index.js:52-58`);
- se un vecchio collegamento account punta a un'organizzazione cancellata,
  `getMyAssignedProfile` risponde "nessuna assegnazione, dosi originali" invece
  di rompersi (`functions/src/index.js:302-305`);
- la console (`admin.html`) parla sempre e solo con `pianoNutrizionale`
  (`js/admin.js:9`).

Come fare:

1. <https://console.firebase.google.com> → progetto **piano-nutrizionale** →
   **Firestore Database** → scheda **Data**.
2. Nell'elenco di sinistra apri la collezione **organizations**.
3. **Prendi nota su un foglio** dei nomi dei documenti che vedi. Alla fine deve
   restare soltanto `pianoNutrizionale`.
4. Per **ogni documento che non si chiama `pianoNutrizionale`**:
   1. clicca il documento;
   2. clicca i tre puntini (**⋮**) e scegli **Delete document**;
   3. nella finestra di conferma accetta anche la cancellazione delle
      sottocollezioni (`clients`, `members`, `auditLog`, …);
   4. conferma.
5. Ricarica la pagina (F5): in `organizations` deve comparire solo `pianoNutrizionale`.

> Non toccare `pianoNutrizionale`. Non cancellare la collezione `organizations` in sé:
> svuota solo i documenti che non ti servono.

---

## Passo 4 — Collezioni del modello eliminato: si cancellano sempre

**Cosa sono.** `globalRuleSets` (rule set globali), `mappingReports` e
`mappingProposals` (vecchia coda di mappatura ingredienti). Appartengono al
modello pre-rifondazione: **nessuna Function e nessun client le legge più**.

**Perché niente controlli.** Le versioni precedenti di questa guida chiedevano
di verificare che nessuna assegnazione attiva puntasse a un rule set globale:
il runtime ruleSets non esiste più nel codice, quindi la verifica non ha
oggetto. Un'assegnazione storica che conserva un vecchio puntatore viene
semplicemente ignorata.

### 4a. La cancellazione (senza comandi)

1. Firebase console → **Firestore Database** → **Data**.
2. Apri una alla volta le collezioni **globalRuleSets**, **mappingReports** e
   **mappingProposals** (se esistono).
3. Elimina i documenti: tre puntini (**⋮**) sul documento → **Delete document**
   → conferma anche le sottocollezioni (`versions`). Se il menu della
   collezione offre **Delete collection**, puoi usare quello.
4. Ricarica la pagina: le collezioni devono essere vuote (o scomparse).

---

## Passo 5 — Regole di sicurezza: già pulite

Le `firestore.rules` attuali non contengono più alcun blocco per
`globalRuleSets` o le code mapping (rimossi con la rifondazione): non c'è
niente da modificare a mano. Se le regole del progetto sono state pubblicate
prima della rifondazione, ripubblicale dal workflow *Deploy Firebase (manuale)*
o da Firebase console → Firestore → **Rules** (vedi
[`deploy-online-senza-terminale.md`](deploy-online-senza-terminale.md)).

---

## Passo 6 — Account (Firebase Authentication): niente da cancellare

Nessun account Auth va cancellato. `cliente-1`, `cliente-2`, `admin`, `cliente` e
`nutrizionista` restano attivi con i nickname attuali e con l'email tecnica
`<nickname>@utenti.pianonutrizionale.app`.

---

## Passo 7 — Verifica finale (10 minuti, solo clic)

1. Apri l'app con il primo account cliente: settimana, ricette e lista della spesa devono
   essere quelle di prima.
2. Ripeti con gli altri account clienti: idem.
3. Apri `admin.html` con `admin` e poi con `nutrizionista`: le sezioni
   **Clienti**, **Dosi clienti**, **Strutture dieta**, **Utenti** e **Coda
   ingredienti** devono caricarsi senza messaggi rossi. Con `admin` (creatore)
   deve esserci in più la sezione **Catalogo**, che mostra la versione
   importata; con `nutrizionista` la voce **non** deve comparire.
4. Firebase console → **Firestore Database** → **Data**: nell'elenco devono
   ancora esserci `users`, `households`, `usernames`, `recipeShares`,
   `priceEntries`, `priceMeta`, `accountClientLinks`, `platformMembers`,
   `globalIngredientCatalog` e `organizations` (con il solo documento `pianoNutrizionale`).
5. Firebase console → **Functions**: tutte le funzioni attive, con la data
   dell'ultimo deploy.

Atteso: le cancellazioni dei Passi 3 e 4 **non cambiano il comportamento
dell'app**, perché le Cloud Functions non leggono quelle collezioni.

Se hai anche un modo di lanciare i test automatici (per esempio il workflow
`Test` su GitHub, che parte da solo a ogni modifica): `npm test` = 345 test,
`npm --prefix functions test` = 111 test, `npm run smoke` = SMOKE OK,
`npm run syntax` = OK. Tutti verdi sul ramo aggiornato.

> Conteggi aggiornati alla rifondazione (ADR 0008): 345 test client e 111
> test Functions.

> Gli account tecnici con email fittizia (`@utenti.pianonutrizionale.app`)
> restano intatti dopo la pulizia: servono ai test e alla demo. Le nuove
> registrazioni dei clienti reali usano l’email vera del cliente e sono
> descritte in `docs/inviti-email.md`; nessun account fittizio viene convertito.

> Nota storica: fino a settembre 2026 lo smoke test falliva
> (`test/smoke-app.js`, "profilo coppia") perché controllava l'etichetta del
> profilo nella Settimana invece che nell'header: era un test disallineato al
> codice attuale ed è stato corretto.

---

## Riepilogo in 8 righe

1. Attiva il ripristino a 7 giorni (Disaster Recovery).
2. Ogni account cliente con dati storici: **Esporta** e poi **Importa** dal Ricettario.
3. In `organizations` cancella tutto tranne `pianoNutrizionale` (che deve esistere: vedi
   [ripartenza-firebase.md](ripartenza-firebase.md)).
4. Svuota `globalRuleSets`, `mappingReports`, `mappingProposals` (modello eliminato).
5. Ripubblica le `firestore.rules` correnti se il progetto ha le vecchie.
6. Nessun account Auth da cancellare.
7. Verifica app + console + Functions.

---

## Appendice — gli stessi passaggi per chi usa il terminale

Riferimento rapido per chi ha Firebase CLI e `gcloud` configurati. È
l'equivalente esatto dei passi qui sopra; **non serve** per seguire la guida.

```bash
# Passo 1: backup completo (alternativa al PITR)
gcloud storage buckets create gs://piano-nutrizionale-backup --location=europe-west1
gcloud firestore export gs://piano-nutrizionale-backup/$(date +%Y%m%d-%H%M) \
  --project=piano-nutrizionale

# Passo 3: organizzazioni diverse da piano
gcloud firestore collections list --project=piano-nutrizionale | grep organizations
firebase firestore:delete organizations/<ORG> --recursive --project=piano-nutrizionale -y

# Passo 4: collezioni del modello eliminato
firebase firestore:delete globalRuleSets --recursive --project=piano-nutrizionale -y
firebase firestore:delete mappingReports --recursive --project=piano-nutrizionale -y || true
firebase firestore:delete mappingProposals --recursive --project=piano-nutrizionale -y || true

# Passo 5 e 7
firebase deploy --only firestore:rules --project piano-nutrizionale
npm test && npm --prefix functions test
```
