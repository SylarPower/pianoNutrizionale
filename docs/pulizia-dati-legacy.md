# Pulizia dei dati vecchi (legacy) su Firebase — guida passo passo

Versione "senza terminale": ogni passaggio si fa **con il mouse nel browser**.
Se un passaggio ha una riga grigia da copiare, vuol dire che esiste anche una
scorciatoia per chi usa il terminale: **puoi ignorarla**, trovi sempre la
versione con i clic.

Obiettivo: cancellare i dati delle vecchie organizzazioni e delle collezioni
morte **senza rompere gli account attivi** (`gabriele`, `martina`, `admin`,
`cliente`, `nutrizionista`) e senza rompere il codice che è in produzione.

> ⚠️ Leggi prima il **Passo 0**: contiene l'elenco delle cose che **non**
> vanno cancellate. È la parte più importante della guida.

---

## Passo 0 — Cosa NON cancellare (leggilo prima di tutto)

Un piano di pulizia precedente diceva che si potevano cancellare `users`,
`households`, `recipes`, `shoppingList` e `globalIngredientCatalog/config`.
**Non è vero con il codice di oggi**: cancellarli romperebbe l'app in
produzione. Questo documento corregge quel piano.

| Cosa lasciare stare | Perché |
|---|---|
| `users/{uid}/content/recipeCatalog`, `users/{uid}/config/shoppingList`, `users/{uid}/config/weeklyPlan`, `users/{uid}/backups/*` | È il magazzino **attuale** dell'app: `js/firebase.js` ci legge e ci scrive a ogni utilizzo (righe 476, 484, 508). Vale anche per `gabriele` e `martina` dopo il re-import. |
| `households/**` | Area condivisa degli account collegati: usata da `js/firebase.js` (righe 456-501, 667-688). |
| `globalIngredientCatalog/config/docs/import` e `.../denylist` | Le leggono le Cloud Functions in produzione (`functions/src/index.js:1188` per l'import, `functions/src/domain.js:598` per la denylist). Non sono "refusi". |
| `globalIngredientCatalog/current/**` | Catalogo ingredienti globale attivo (`functions/src/index.js:118-120`). |
| `usernames/**` | Rubrica nickname → UID: serve a inviti, condivisioni e ricerca utenti (`functions/src/index.js:1432-1438`). |
| `recipeShares/**`, `priceEntries/**`, `priceMeta/**`, `accountClientLinks/**`, `platformMembers/**` | Funzionalità attive: condivisioni, prezzi, collegamenti account. |
| `organizations/piano/**` | È l'organizzazione SaaS **in uso**. Le Functions accettano solo questa (`SINGLE_ORGANIZATION_ID = 'piano'`, `functions/src/domain.js:5`). |

Queste collezioni diventeranno cancellabili solo dopo aver riscritto il
magazzino dati del client: lavoro fuori scope. Quando succederà, aggiorna
questa guida insieme al codice.

**In pratica si cancellano solo due cose**: le organizzazioni diverse da
`piano` (Passo 3) e, solo dopo un controllo, `globalRuleSets` (Passo 4).

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

## Passo 2 — `gabriele` e `martina`: export e re-import (nessuno script)

I dati storici di `gabriele` e `martina` **non vengono migrati da nessuno
script**: si rifà un export e un import dall'app. Il formato è già coperto dai
test automatici (`test/saas-client.test.js`, round-trip
`piano-nutrizionale-recipes`).

Da fare **una volta per ciascun account**, e **prima** di qualsiasi
cancellazione di dati personali.

1. Apri l'app con l'account di `gabriele`. Il nickname non cambia.
2. Vai nella schermata **Ricettario**.
3. Premi il pulsante **Esporta**. Scarica un file chiamato
   `ricette-gabriele-AAAA-MM-GG.json`.
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
8. Ripeti dal punto 1 con l'account di `martina`.

Se l'import si blocca con un errore, **non insistere**: il validatore ha
rifiutato il file (ricette vuote, pasti sconosciuti, riferimenti mancanti).
Sistemalo o rifai l'export; i dati su Firebase nel frattempo non sono stati
toccati.

> Correzione rispetto alla guida precedente: l'export **non** è nelle
> Impostazioni. I pulsanti **Esporta** / **Importa** sono nella schermata
> **Ricettario** (`js/app.js:1532-1533`, funzione `exportAllRecipes`).

---

## Passo 3 — Cancella le organizzazioni diverse da `piano`

Perché è sicuro:

- le Cloud Functions accettano soltanto l'organizzazione `piano`: qualunque
  altro ID viene respinto (`enforceSingleOrg`, `functions/src/index.js:52-58`);
- se un vecchio collegamento account punta a un'organizzazione cancellata,
  `getMyAssignedProfile` risponde "nessuna assegnazione, dosi originali" invece
  di rompersi (`functions/src/index.js:302-305`);
- la console (`admin.html`) parla sempre e solo con `piano`
  (`js/admin.js:9`).

Come fare:

1. <https://console.firebase.google.com> → progetto **piano-nutrizionale** →
   **Firestore Database** → scheda **Data**.
2. Nell'elenco di sinistra apri la collezione **organizations**.
3. **Prendi nota su un foglio** dei nomi dei documenti che vedi. Alla fine deve
   restare soltanto `piano`.
4. Per **ogni documento che non si chiama `piano`**:
   1. clicca il documento;
   2. clicca i tre puntini (**⋮**) e scegli **Delete document**;
   3. nella finestra di conferma accetta anche la cancellazione delle
      sottocollezioni (`clients`, `members`, `auditLog`, …);
   4. conferma.
5. Ricarica la pagina (F5): in `organizations` deve comparire solo `piano`.

> Non toccare `piano`. Non cancellare la collezione `organizations` in sé:
> svuota solo i documenti che non ti servono.

---

## Passo 4 — `globalRuleSets`: prima controlli, poi (forse) cancelli

**Cosa sono.** Versioni pubblicate di "rule set" con ambito *globale*. Le
Cloud Functions le leggono ancora **solo** quando un cliente ha
un'assegnazione **vecchia** che punta a un rule set globale.

**Cosa succede se sbagli.** L'app non si rompe: `getMyAssignedProfile` non
trova la versione e risponde `invalid-rule-set` con ripiego alle dosi
originali (`functions/src/index.js:343-345`). Il cliente però **perde il
profilo assegnato**: è esattamente ciò che vogliamo evitare.

> Correzione rispetto alla guida precedente: il controllo usava un campo
> `profileSchemaVersion`. **Quel campo non esiste nel codice** (nessun file del
> repository lo contiene). Il campo giusto è **`schemaVersion`**, scritto da
> `assignClientStructure`: `1` = assegnazione vecchia a un rule set,
> `2` = assegnazione a una Struttura dieta (`functions/src/index.js:733`).
> Quello che decide davvero è però la presenza di `ruleSet.scope: "global"`.

### 4a. Il controllo (senza comandi)

1. Firebase console → **Firestore Database** → **Data**.
2. Apri `organizations` → **piano** → **clients**.
3. Entra in ogni cliente e apri la sottocollezione **assignments**.
4. Apri ogni documento assegnazione e guarda i campi:

   | Cosa vedi nel documento | Significa | Azione |
   |---|---|---|
   | ha `structure` (con `structureId`, `revisionId`) e `schemaVersion: 2` | assegnazione nuova | ✅ nessuna |
   | ha `ruleSet` con `scope: "tenant"` | assegnazione vecchia ma sul rule set del tenant | ✅ nessuna |
   | ha `ruleSet` con `scope: "global"` | assegnazione vecchia che **usa `globalRuleSets`** | 🛑 **stop**: non cancellare |
   | `status: "revoked"` o `"expired"` | assegnazione storica non più attiva | ✅ nessuna |

   Guarda solo le assegnazioni con `status` **`active`** o **`scheduled`**: sono
   quelle che l'app può ancora servire.

Se i clienti sono tanti, invece di sfogliarli a mano puoi usare **Firestore
Studio** (Google Cloud console → Firestore → database `(default)` → menu a
sinistra **Firestore Studio** → scheda **Query Builder**):

- *Query scope*: **Collection group**, valore `assignments`;
- filtro: `status` `==` `active` (poi ripeti con `scheduled`);
- **Run query**.

Se compare un errore che parla di *index*, clicca il link **Create index**
nell'errore e aspetta 1-2 minuti: `firestore.indexes.json` oggi non contiene
indici "collection group", quindi la prima volta va creato.

### 4b. La cancellazione (solo se il controllo è pulito)

Se **nessuna** assegnazione attiva o programmata ha `ruleSet.scope: "global"`:

1. Firebase console → **Firestore Database** → **Data**.
2. Apri la collezione **globalRuleSets**.
3. Elimina i documenti: tre puntini (**⋮**) sul documento → **Delete document**
   → conferma anche le sottocollezioni (`versions`). Se il menu della
   collezione offre **Delete collection**, puoi usare quello.
4. Ricarica la pagina: la collezione deve essere vuota.

---

## Passo 5 — Pulizia delle regole di sicurezza (facoltativa)

In `firestore.rules` c'è ancora il blocco che protegge `globalRuleSets`
(righe 228-230):

```text
match /globalRuleSets/{ruleSetId}/{document=**} {
  allow read, write: if false;
}
```

Lasciarlo **non rompe niente** (nega l'accesso ai browser, le Functions passano
comunque dall'Admin SDK). Togliendolo il file resta semplicemente più pulito.

Se vuoi toglierlo, sempre dal browser:

1. Apri <https://github.com/SylarPower/pianoNutrizionale> e premi il tasto
   **`.`** (punto) sulla tastiera: si apre l'editor di GitHub nel browser.
2. Apri `firestore.rules` e cancella quelle tre righe.
3. In alto a destra **Commit changes** → messaggio "rimuove globalRuleSets
   dalle rules" → **Commit changes**.
4. Pubblica le regole, in uno di questi due modi:
   - **con i clic**: Firebase console → **Firestore Database** → scheda
     **Rules** → sostituisci tutto il testo con il contenuto del nuovo
     `firestore.rules` → **Publish**;
   - **con il pulsante**: GitHub → **Actions** → *Deploy Firebase (manuale)* →
     **Run workflow** → scegli `firestore:rules`.
     Vedi [`deploy-online-senza-terminale.md`](deploy-online-senza-terminale.md).

---

## Passo 6 — Account (Firebase Authentication): niente da cancellare

Nessun account Auth va cancellato. `gabriele`, `martina`, `admin`, `cliente` e
`nutrizionista` restano attivi con i nickname attuali e con l'email tecnica
`<nickname>@utenti.pianonutrizionale.app`.

---

## Passo 7 — Verifica finale (10 minuti, solo clic)

1. Apri l'app con `gabriele`: settimana, ricette e lista della spesa devono
   essere quelle di prima.
2. Apri l'app con `martina`: idem.
3. Apri `admin.html` con `admin` e poi con `nutrizionista`: le sezioni
   **Clienti**, **Dosi clienti**, **Strutture dieta**, **Utenti** e **Coda
   ingredienti** devono caricarsi senza messaggi rossi.
4. Firebase console → **Firestore Database** → **Data**: nell'elenco devono
   ancora esserci `users`, `households`, `usernames`, `recipeShares`,
   `priceEntries`, `priceMeta`, `accountClientLinks`, `platformMembers`,
   `globalIngredientCatalog` e `organizations` (con il solo documento `piano`).
5. Firebase console → **Functions**: tutte le funzioni attive, con la data
   dell'ultimo deploy.

Atteso: le cancellazioni dei Passi 3 e 4 **non cambiano il comportamento
dell'app**, perché le Cloud Functions non leggono quelle collezioni (unica
eccezione: il caso `ruleSet.scope: "global"` già verificato al Passo 4).

Se hai anche un modo di lanciare i test automatici (per esempio il workflow
`Test` su GitHub, che parte da solo a ogni modifica): `npm test` = 286 test,
`npm --prefix functions test` = 46 test, tutti verdi.
`npm run smoke` **oggi fallisce già su `main`** (`test/smoke-app.js:231`,
"profilo coppia visibile e contestualizzato"): è un problema preesistente, non
dipende dalla pulizia.

---

## Riepilogo in 8 righe

1. Attiva il ripristino a 7 giorni (Disaster Recovery).
2. `gabriele` e `martina`: **Esporta** e poi **Importa** dal Ricettario.
3. In `organizations` cancella tutto tranne `piano`.
4. Controlla le assegnazioni: nessuna attiva/programmata con
   `ruleSet.scope: "global"`.
5. Solo allora svuota `globalRuleSets`.
6. (Facoltativo) togli il blocco dalle `firestore.rules` e ripubblica.
7. Nessun account Auth da cancellare.
8. Verifica app + console + Functions.

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

# Passo 4: verifica zero assegnazioni v1 con rule set globale
cd functions
node -e "
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'piano-nutrizionale' });
const db = admin.firestore();
(async () => {
  const snap = await db.collectionGroup('assignments')
    .where('status', 'in', ['active', 'scheduled']).get();
  const v1Global = snap.docs.filter(d => d.data().ruleSet?.scope === 'global');
  console.log('Assegnazioni attive/programmate con ruleSet.scope=global:', v1Global.length);
  v1Global.forEach(d => console.log(' -', d.ref.path));
  if (v1Global.length) process.exit(1);
})();
"
firebase firestore:delete globalRuleSets --recursive --project=piano-nutrizionale -y

# Passo 5 e 7
firebase deploy --only firestore:rules --project piano-nutrizionale
npm test && npm --prefix functions test
```
