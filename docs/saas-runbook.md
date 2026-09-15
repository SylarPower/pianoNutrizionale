# Runbook SaaS — deploy, migrazione, privacy e incidenti

## Audit iniziale (2026-09-09)

- Client vanilla senza bundler; Firebase SDK modulare da CDN e fallback compat per test.
- Dati personali sotto `users/{uid}`, dati domestici sotto `households/{id}`.
- Le vecchie Rules proteggono UID/household ma non esistevano tenant, Functions, indici o test emulatori.
- Le ricette e i piani sono documenti aggregati; import/export include il piano.
- Guide viveva interamente in `js/domain.js`; i mapping mancanti erano soltanto locali.
- Rischi rilevati: confondere household e paziente; selezione autonoma di un protocollo; aggiornamento retroattivo; IDOR cross-client; PII nei report; scritture admin dal browser; cache di una versione revocata; assenza di rate limit/audit.

## Prerequisiti

- Firebase progetto Blaze (Cloud Functions e scheduler).
- Node 22, Firebase CLI e Java 21 per gli emulatori.
- App Check configurato e enforced per le callable in produzione.
- Nessun segreto nei file web. Nessun provider email: gli inviti si consegnano
  a mano dalla console (Copia link / Condividi link). L'eventuale provider
  advertising, se mai attivato, va in Secret Manager.

## Test locale

```bash
npm ci
npm --prefix functions ci
npm run test:all
npm run test:rules
firebase emulators:start --project piano-nutrizionale-test
# in un secondo terminale:
npm --prefix functions run seed:emulator
```

Il seed stampa organization ID, username demo, password e checksum del rule set da usare nella console. `PIANO_SAAS_CONFIG.enabled` in `js/saas-config.js` è **già `true`** ed è il valore di produzione: non va toccato né per provare l'emulatore né per il deploy (vedi «Feature flag client» più sotto). Il test Rules richiede Java. In questa sandbox Java non è installato: eseguire `npm run test:rules` in CI o su una macchina con JRE 21.

## Fixture minima per prova end-to-end

Con Admin SDK o Emulator UI (mai dal client), creare:

```text
organizations/demo
organizations/demo/members/{adminUid} = {schemaVersion:1, role:"admin", status:"active"}
organizations/demo/members/{nutritionistUid} = {schemaVersion:1, role:"nutritionist", status:"active"}
organizations/demo/clients/client-a = {schemaVersion:1, authUid:"patientAUid", displayCode:"CL-001", status:"active", nutritionistUids:[nutritionistUid]}
organizations/demo/clients/client-b = {schemaVersion:1, authUid:"patientBUid", displayCode:"CL-002", status:"active", nutritionistUids:[]}
accountClientLinks/{patientAUid} = {schemaVersion:1, organizationId:"demo", clientId:"client-a", status:"active"}
```

Creare `globalRuleSets/base/versions/3` con il contratto documentato, `status:"published"` e checksum corretto. Aprire `/admin.html`, indicare `demo`, assegnare base v3 al Cliente A. Verificare:

1. Cliente A riceve soltanto il proprio profilo tramite `getMyAssignedProfile`.
2. Cliente B non legge A (test Rules e callable).
3. Il client mostra “Nuovo profilo da confermare” e usa dosi originali.
4. Dopo conferma, il piano contiene `nutritionSnapshot` con client/rule/version/checksum.
5. Pubblicare v4: il piano v3 non cambia.
6. Assegnare v4: torna `original-only` finché il cliente non conferma.
7. Sospendere/revocare: al caricamento successivo il client usa originali.
8. Creare una ricetta con ingrediente sconosciuto, inviare opt-in, aprire coda, proporre e pubblicare mapping. La ricetta originale deve restare identica.

## Deploy graduale

1. Backup Firestore/PITR e annotazione release corrente.
2. Deploy Rules e indici:
   ```bash
   firebase deploy --only firestore:rules,firestore:indexes
   ```
3. Attendere che gli indici siano `Enabled`. Fase 2: nessun nuovo indice
   composito (le query Utenti/inviti/link usano singoli filtri + selezione
   in codice; verificare comunque `firebase/firestore.indexes.json` in deploy).
4. Deploy Functions:
   ```bash
   firebase deploy --only functions,firestore:indexes,firestore:rules
   ```
5. Smoke callable con account test admin e paziente.
6. Deploy Hosting (GitHub Pages) con `PIANO_SAAS_CONFIG.enabled = true`
   (valore attuale: **non** cambiarlo durante il deploy; la procedura storica
   che lo spegneva prima della pubblicazione non vale più).
7. Verificare audit e smoke post-deploy (vista Clienti, invito di prova con
   Copia link / Condividi link).

### Feature flag client: `PIANO_SAAS_CONFIG.enabled`

- Valore di produzione: **`true`**, sempre. È l'interruttore della parte
  professionale dell'app cliente (collegamento, profilo assegnato, notifiche,
  inviti con email reale).
- `false` è **solo la via di emergenza**: l'app cliente torna al comportamento
  legacy (dosi originali, nessuna chiamata al server professionale) senza
  cancellare nulla; al ritorno a `true` tutto ricompare. Da usare soltanto in
  incident response, con bump di `CACHE_VERSION` in `sw.js`.
- Il flag è pubblico e non è un controllo di sicurezza: le autorizzazioni
  restano nelle Rules e nelle callable.

## Console unificata e dieta guidata (ADR 0005, 2026-09-13)

- Deploy come sempre: Rules/indici (invariati: nessun nuovo indice
  composito), Functions, Hosting con bump di `CACHE_VERSION`.
- Alcune query combinavano due `where` senza indice composto dichiarato
  (inviti/richieste per email+stato o clientId+stato, cambi email per
  uid+stato): in produzione rispondevano `failed-precondition`. Ora usano un
  solo filtro + selezione in codice (ADR 0003). Se in log vedi ancora errori
  `failed-precondition` con «requires an index», è una Functions non
  ripubblicata: ridistribuisci.
- Dieta guidata: nessun dato da migrare (`hasDietPlan` assente = classica).
  Le revisioni schema 3 convivono con 1/2; rollback = pubblicare una nuova
  revisione classica dalla stessa struttura.
- Smoke post-deploy: apri la vista Clienti (filtri + scheda + storico),
  crea una dieta guidata di prova, pubblicala, verifica badge e anteprima.

## Migrazione reversibile

- Non creare assignment per utenti legacy.
- Non spostare né riscrivere ricette.
- Import segnalazioni locali solo opt-in: calcolare fingerprint, chiamare `submitMappingReport`, registrare l'esito; la deduplica rende il retry sicuro.
- Prima di associare `authUid` a un client verificare consenso e identità; scrivere `accountClientLinks` server-side.
- Rollback client (solo emergenza): `enabled:false` ripristina il comportamento legacy senza cancellare snapshot; in condizioni normali il flag resta `true`.
- Rollback clinico: nuova assignment verso la versione precedente; mai modificare il documento pubblicato.
- Rollback mapping: pubblicare una nuova versione correttiva/retired, non cancellare la storia.

## Feature flag server-side (Fase 2)

- `CATALOG_IMPORT_ENABLED` (env Functions, default: ON in emulatore, OFF in
  produzione): abilita commit/restore dell'import catalogo. Il dry-run resta
  sempre disponibile al platform admin (nessuna scrittura). Override
  Firestore: `globalIngredientCatalog/config/docs/import = { enabled: bool }`
  (l'env prevale se impostata).
- `SHOPPING_REWARD_ENABLED` (env Functions, default OFF): con assignment attivo
  `requestShoppingReward` risponde `allowed` senza reward; senza assignment e
  flag OFF → `failed-precondition`. Nessun provider reale: la ricevuta non è
  verificabile e non viene mai considerata attendibile.

## Import catalogo e rollback (Fase 2)

1. Dry-run: `importGlobalIngredientCatalog({ format, mode: 'dry-run', payload })`
   → conteggi, diff (≤200 righe), errori, `previewId`.
2. Correggere il file finché `errors` è vuoto; il commit richiede `confirm: true`
   e lo stesso `previewId` (concorrenza ottimistica sulla `catalogVersion`).
3. Commit atomico in transazione: bump `catalogVersion`, upsert voci, snapshot
   della versione precedente in `globalIngredientCatalog/versions/snapshots/<n-1>`, audit
   `catalog.imported` in `platformAuditLog` con checksum. Limite: 400 voci per
   commit (suddividere i file grandi).
4. Rollback: disattivare il flag (blocca nuovi commit) e ripristinare con
   `mode: 'restore', restoreVersion: <n>, confirm: true` → nuova versione con
   il contenuto dello snapshot + audit `catalog.restored`. La categoria `free`
   non viene mai cancellata da un ripristino.
5. Denylist provvisoria: `globalIngredientCatalog/config/denylist =
   { ingredientIds: [...] }` (server-only, mai nel repository). Le strutture
   pubblicate conservano `ingredientCatalogVersion`: nessun effetto retroattivo.

## Advertising rewarded / Lista spesa

Decisione: sblocco per 24 ore. L'integrazione reale è disattivata finché non viene scelto un provider web compatibile.

- Consenso UE separato, revocabile e versionato.
- Il provider riceve solo placement e identificatore pubblicitario consentito: mai ricette, ingredienti, diagnosi, rule set o client ID.
- La ricevuta del provider deve essere verificata da `requestShoppingReward` server-side; il timestamp locale non è fonte autorevole.
- Frequency cap, fallback in caso di disabilità/assenza inventory e alternativa a pagamento devono essere definiti prima dell'attivazione.
- Niente countdown ingannevoli, pulsanti camuffati o blocco delle ricette.

## GDPR

Classificazione:

- potenzialmente sanitario: client, assignment, override e motivazioni;
- identificativo: authUid e link account-client;
- pseudonimizzato: report mapping (`clientRef`);
- operativo: audit e idempotency key.

Default proposti, da confermare con DPO:

- report risolti: anonimizzazione dopo 180 giorni;
- report rifiutati: 90 giorni;
- assignment e audit clinico: 10 anni o obbligo locale applicabile;
- rate limit: 24 ore;
- inviti scaduti: 30 giorni.

Export/cancellazione devono essere job Admin SDK: export strutturato per tenant/cliente; cancellazione del link Auth, anonimizzazione report, revoca assignment e tombstone audit. Gli audit non vanno cancellati se un obbligo legale impone conservazione; rimuovere i riferimenti diretti.

## Osservabilità

Metriche senza testo ingrediente nei log:

- callable error rate e latenza p95;
- backlog per stato e tempo mediano di risoluzione;
- report deduplicati/rate-limited;
- assignment attive/programmate/scadute;
- pubblicazioni e rollback;
- mismatch checksum e fallback original-only.

Alert: spike permission-denied, checksum mismatch, errori scheduler, backlog oltre SLA. Non loggare payload clinici.

## Incident response

1. Disattivare il feature flag client (`enabled:false`, unica situazione in cui va cambiato); se necessario disabilitare la Function coinvolta.
2. Revocare membership compromessa e token Auth.
3. Conservare audit e log minimizzati; identificare tenant/documenti coinvolti.
4. Ripristinare da backup o assegnare versione precedente.
5. Valutare notifica data breach con DPO entro i termini GDPR.
6. Pubblicare post-mortem senza dati personali.

## Fuori scope esplicito della slice

- provider pubblicitario reale e verifica ricevuta (`requestShoppingReward` verifica solo l'entitlement da assignment);
- billing/abbonamenti;
- UI completa inviti, audit, contenuti editoriali e GDPR self-service;
- job definitivi export/cancellazione/retention;
- analytics esterne;
- conversione automatica dei rule set canonici già in produzione;
- claim provisioning e pannello platform globale;
- test Functions con Firestore emulator (i validatori puri e le Rules sono coperti separatamente).

Queste parti non devono essere simulate nel client. La slice consegnata copre coda mapping, pubblicazione tenant/globale autorizzata, assegnazione cliente, snapshot/fallback e UI professionale.


### Nome visualizzato e inviti esistenti

Un invito a un account già esistente compare nella campanella dell’app, con il nome del professionista e i pulsanti per accettare o rifiutare. Nome e cognome sono facoltativi: si possono salvare dalla sezione di collegamento professionista (cliente) o dalla console (professionista).

### Inviti con email reale (ADR 0004) — link consegnato a mano

La console invita i clienti reali con la loro **email** (**Clienti → ＋ Invita
nuovo cliente**): il cliente sceglie la password dal link `#/invito/<token>` e
il collegamento si attiva **dopo la verifica dell’email**. Gli account tecnici
con email fittizia restano per i test e si creano dal modulo legacy solo negli
emulatori o con `LEGACY_TEST_INVITES_ENABLED=true` (mai in produzione se non per
una prova concordata).

**Nessun invio automatico**: il servizio email è stato eliminato (nessun
provider, chiave o variabile d’ambiente). Le callable restituiscono il link e
la console lo mostra con **Copia link** e **Condividi link** (condivisione
nativa, fallback WhatsApp Web). Verifica email e reset password restano sui
template di Firebase Auth. Dopo il merge l’unico passo manuale è ripubblicare
le Functions dal workflow GitHub *Deploy Firebase (manuale)*: guida senza
terminale in [`docs/configurazione-manuale.md`](configurazione-manuale.md),
dettagli in [`docs/inviti-email.md`](inviti-email.md).
