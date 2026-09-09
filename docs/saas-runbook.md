# Runbook SaaS — deploy, migrazione, privacy e incidenti

## Audit iniziale (2026-09-09)

- Client vanilla senza bundler; Firebase SDK modulare da CDN e fallback compat per test.
- Dati personali sotto `users/{uid}`, dati domestici sotto `households/{id}`.
- Le vecchie Rules proteggono UID/household ma non esistevano tenant, Functions, indici o test emulatori.
- Le ricette e i piani sono documenti aggregati; import/export include il piano.
- Meller viveva interamente in `js/domain.js`; i mapping mancanti erano soltanto locali.
- Rischi rilevati: confondere household e paziente; selezione autonoma di un protocollo; aggiornamento retroattivo; IDOR cross-client; PII nei report; scritture admin dal browser; cache di una versione revocata; assenza di rate limit/audit.

## Prerequisiti

- Firebase progetto Blaze (Cloud Functions e scheduler).
- Node 22, Firebase CLI e Java 21 per gli emulatori.
- App Check configurato e enforced per le callable in produzione.
- Nessun segreto nei file web. Provider email/advertising in Secret Manager.

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

Il seed stampa organization ID, username demo, password e checksum del rule set da usare nella console. Per provare il client SaaS nell'emulatore impostare temporaneamente `enabled: true` in `js/saas-config.js` e ripristinarlo a `false` prima del deploy generale. Il test Rules richiede Java. In questa sandbox Java non è installato: eseguire `npm run test:rules` in CI o su una macchina con JRE 21.

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
3. Attendere che gli indici siano `Enabled`.
4. Deploy Functions:
   ```bash
   firebase deploy --only functions
   ```
5. Smoke callable con account test admin e paziente.
6. Deploy Hosting con `PIANO_SAAS_CONFIG.enabled = false`.
7. Provisionare un tenant pilota e verificare audit.
8. Attivare il flag solo per la release concordata. Il flag è pubblico e non è un controllo di sicurezza.

## Migrazione reversibile

- Non creare assignment per utenti legacy.
- Non spostare né riscrivere ricette.
- Import segnalazioni locali solo opt-in: calcolare fingerprint, chiamare `submitMappingReport`, registrare l'esito; la deduplica rende il retry sicuro.
- Prima di associare `authUid` a un client verificare consenso e identità; scrivere `accountClientLinks` server-side.
- Rollback client: `enabled:false` ripristina il comportamento legacy senza cancellare snapshot.
- Rollback clinico: nuova assignment verso la versione precedente; mai modificare il documento pubblicato.
- Rollback mapping: pubblicare una nuova versione correttiva/retired, non cancellare la storia.

## Advertising rewarded / Lista spesa

Decisione: sblocco per 24 ore. L'integrazione reale è disattivata finché non viene scelto un provider web compatibile.

- Consenso UE separato, revocabile e versionato.
- Il provider riceve solo placement e identificatore pubblicitario consentito: mai ricette, ingredienti, diagnosi, rule set o client ID.
- La ricevuta del provider deve essere verificata da `grantShoppingReward` server-side; il timestamp locale non è fonte autorevole.
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

1. Disattivare feature flag client; se necessario disabilitare la Function coinvolta.
2. Revocare membership compromessa e token Auth.
3. Conservare audit e log minimizzati; identificare tenant/documenti coinvolti.
4. Ripristinare da backup o assegnare versione precedente.
5. Valutare notifica data breach con DPO entro i termini GDPR.
6. Pubblicare post-mortem senza dati personali.

## Fuori scope esplicito della slice

- provider pubblicitario reale e verifica ricevuta `grantShoppingReward`;
- billing/abbonamenti;
- email provider, retry queue e dead-letter;
- UI completa inviti, audit, contenuti editoriali e GDPR self-service;
- job definitivi export/cancellazione/retention;
- analytics esterne;
- conversione automatica dei rule set canonici già in produzione;
- claim provisioning e pannello platform globale;
- test Functions con Firestore emulator (i validatori puri e le Rules sono coperti separatamente).

Queste parti non devono essere simulate nel client. La slice consegnata copre coda mapping, pubblicazione tenant/globale autorizzata, assegnazione cliente, snapshot/fallback e UI professionale.
