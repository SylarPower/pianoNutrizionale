# Pulizia dati legacy su Firebase

Guida operativa alla pulizia del database Firestore dopo la transizione SaaS.
Obiettivo: eliminare i dati delle collezioni legacy e delle vecchie
organizzazioni **senza rompere gli account attivi** (gabriele, martina, admin,
cliente, nutrizionista) né il codice che ancora li legge.

> ⚠️ Prima di qualunque cancellazione leggi tutto il documento: alcune
> collezioni elencate come "legacy" nel piano originale sono ancora lette dal
> codice in produzione. Le sezioni **Non eliminare** spiegano il perché.

## 1. Prerequisiti

```bash
# Autenticazione (account con ruolo Proprietario/Editor sul progetto)
gcloud auth login
firebase login

# Progetto
gcloud config set project piano-nutrizionale
firebase use piano-nutrizionale
```

## 2. Backup completo (obbligatorio, una tantum)

```bash
# Bucket di backup (una tantum)
gcloud storage buckets create gs://piano-nutrizionale-backup --location=europe-west1

# Export completo di Firestore
gcloud firestore export gs://piano-nutrizionale-backup/$(date +%Y%m%d-%H%M) \
  --project=piano-nutrizionale
```

Conserva anche gli export JSON locali degli utenti storici (sezione 3).

## 3. Dati personali di gabriele e martina (nessuno script di migrazione)

I dati legacy di gabriele e martina **non vengono migrati da script**:
flusso manuale export → reimport dall'app, già coperto dai test
(`test/saas-client.test.js`, round-trip `piano-nutrizionale-recipes`).

1. L'utente apre l'app con il suo account storico (nickname invariato:
   `gabriele` / `martina`, vedi `usernames/{nickname}`).
2. **Impostazioni → Esporta → "Esporta ricette e piano"**: scarica
   `ricette-<nickname>-<data>.json` (formato
   `piano-nutrizionale-recipes`, schema 5, include catalogo ricette e piano).
3. Verifica sul file: deve contenere `format: "piano-nutrizionale-recipes"`,
   `schemaVersion: 5`, `recipes[]` e `plan.days`.
4. **Impostazioni → Importa** e seleziona lo stesso file: il validatore
   rifiuta file manomessi (ricette vuote, pasti sconosciuti, riferimenti
   mancanti) e riscrive catalogo + piano + spesa in un unico batch.
5. Controlla in app che settimana, ricette e lista spesa siano corrette.

Solo dopo che **tutti** gli account storici hanno rieseguito export+reimport
si può valutare la sezione 5 (dati personali legacy).

## 4. Cancellazioni sicure (eseguibili subito, in quest'ordine)

### 4.1 Organizzazioni diverse da `piano`

```bash
# 1) Elenca le organizzazioni presenti
gcloud firestore collections list --project=piano-nutrizionale | grep organizations

# 2) Per OGNI organizzazione != piano (sostituisci <ORG>):
firebase firestore:delete organizations/<ORG> --recursive --project=piano-nutrizionale -y
```

### 4.2 `globalRuleSets/**` — SOLO dopo aver verificato zero assegnazioni v1

Le callable (`getMyAssignedProfile`) leggono ancora `globalRuleSets` per i
profili cliente con assegnazione v1 (`rules[]` dirette). Prerequisito:

```bash
cd functions
node -e "
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'piano-nutrizionale' });
const db = admin.firestore();
(async () => {
  const snap = await db.collectionGroup('assignments')
    .where('status', 'in', ['active', 'scheduled']).get();
  const v1 = snap.docs.filter(d => (d.data().profileSchemaVersion || 1) === 1);
  console.log('Assegnazioni v2 attive/programmate profileSchemaVersion=1:', v1.length);
  v1.forEach(d => console.log(' -', d.ref.path));
  if (v1.length) process.exit(1);
})();
"
```

Se il conteggio è 0:

```bash
firebase firestore:delete globalRuleSets --recursive --project=piano-nutrizionale -y
```

### 4.3 Pulizia delle Security Rules

Dopo le cancellazioni, rimuovi da `firestore.rules` i blocchi `match` non più
utilizzati (es. `globalRuleSets`) e ridistribuisci:

```bash
firebase deploy --only firestore:rules
```

## 5. NON eliminare (discrepanza rispetto al piano originale)

Il piano di pulizia originale elencava `users/**`, `households/**`,
`recipes`, `shoppingList` e `globalIngredientCatalog/config` come eliminabili.
**Non è vero con il codice attuale**: cancellarli romperebbe gli account in
produzione.

| Percorso | Perché NON va eliminato |
|---|---|
| `users/{uid}/content/recipeCatalog`, `users/{uid}/config/shoppingList`, `users/{uid}/backups/*` | È lo storage **attuale** dell'app client (anche di gabriele/martina dopo il reimport): `js/firebase.js` ci legge e scrive a ogni uso. |
| `households/**` | Storage dell'area condivisa degli account collegati, attivo in `js/firebase.js`. |
| `globalIngredientCatalog/config/docs/import`, `globalIngredientCatalog/config/docs/denylist` | Letti dalle callable in produzione (`importGlobalIngredientCatalog`, proposte di mapping in `functions/src/index.js`). Nel piano originale erano indicati come "refusi": è una discrepanza del brief, il codice li usa. |
| `globalIngredientCatalog/current/**` | Catalogo ingredienti globale attivo (console + strutture v2). |
| `usernames/**` | Directory nickname→uid: serve a inviti, condivisioni e login. |
| `recipeShares/**`, `priceEntries/**`, `priceMeta/**`, `accountClientLinks/**`, `platformMembers/**` | Funzionalità attive (condivisioni, prezzi, collegamenti account). |
| `organizations/piano/**` | Organizzazione SaaS attiva. |

Le collezioni della sezione 5 diventano eliminabili solo dopo un refactoring
dello storage client (fuori scope): a quel punto questo documento va
aggiornato insieme al codice.

## 6. Account Firebase Auth

Nessun account Auth va cancellato: gabriele, martina, admin, cliente e
nutrizionista restano attivi con i nickname esistenti. L'email tecnica
resta `<nickname>@utenti.pianonutrizionale.app`.

## 7. Verifica finale

```bash
# Le collections attese in produzione
gcloud firestore collections list --project=piano-nutrizionale
# Smoke test client + funzioni
npm test && npm run test:functions
```

Atteso: le cancellazioni della sezione 4 non devono cambiare il comportamento
dell'app (le callable non leggono quelle collezioni, tranne il caso
v1 di `globalRuleSets` già verificato).
