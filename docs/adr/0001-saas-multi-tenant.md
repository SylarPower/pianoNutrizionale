# ADR 0001 — Piano SaaS multi-tenant, profili e cataloghi versionati

- Stato: accettato
- Data: 2026-09-09
- Decisione di prodotto: owner

## Contesto

L'app esistente separa già account Firebase e household. Una household condivide ricette, piano e spesa, ma non è un'organizzazione professionale e non assegna protocolli nutrizionali. Le ricette originali devono restare immutabili. Il nuovo livello SaaS deve trattare il profilo nutrizionale come dato potenzialmente sanitario, senza segreti o privilegi nel browser.

## Decisioni

### Separazione dei piani dati

1. **Account**: Firebase Auth e `users/{uid}`.
2. **Household**: condivisione domestica esistente; non attribuisce ruoli né profili clinici.
3. **Organization**: tenant professionale isolato.
4. **Client**: paziente dell'organizzazione, distinto dall'account e collegabile a un solo `authUid`.
5. **Assignment**: risorsa immutabile e storicizzata che collega cliente, rule set e versione.
6. **Catalogo globale**: governato soltanto da `platformMembers`; i tenant possono consumarlo, segnalare problemi e creare versioni private.
7. **Snapshot piano**: conserva cliente, rule set, versione e checksum. Una versione nuova non modifica il piano esistente.

### Ruoli

Per decisione di prodotto l'interfaccia espone soltanto:

- `admin`: tenant, clienti, mapping e assegnazioni;
- `nutritionist`: clienti autorizzati, rule set privati e assegnazioni.

Questa è una deviazione intenzionale dal prompt iniziale, che elencava owner/editor/reviewer/viewer. Il controllo autorevole resta nel documento membership. I custom claims sono soltanto un'indicazione coarse-grained. Un `platform admin` è separato dai ruoli tenant e governa i cataloghi globali. Non è richiesta la separazione autore/reviewer: admin e nutrizionista possono pubblicare le proprie regole tenant-scoped; un platform admin può pubblicare una regola globale.

### Assenza o invalidità dell'assegnazione

Senza assegnazione, oppure con assegnazione sospesa, revocata o scaduta, il client usa **solo le quantità originali**. Nessun fallback Meller implicito. La Lista della spesa è una capability commerciale distinta: resta bloccata e potrà essere sbloccata per 24 ore dopo una pubblicità rewarded. In questa fase il provider pubblicitario non è scelto: esistono soltanto contratto provider-agnostic, consenso e feature flag disattivato. Nessun dato nutrizionale deve essere inviato a un provider advertising.

### Pubblicazione e migrazione

- Le versioni pubblicate sono immutabili e identificate da checksum SHA-256.
- Modifiche e override producono una versione nuova.
- Cambiare assegnazione crea un documento nuovo e chiude quello precedente.
- Il client mostra l'impatto e richiede conferma prima di aggiornare lo snapshot e ricalcolare piano/spesa.
- Gli utenti legacy non ricevono assegnazioni inventate.
- La feature SaaS è spenta per default; con feature attiva e contesto non ancora verificato vale `original-only`.

## Modello Firestore sintetico

```text
platformMembers/{uid}
accountClientLinks/{uid}
globalRuleSets/{ruleSetId}/versions/{version}
globalMappings/{mappingId}/versions/{version}
globalMappingCatalog/current
organizations/{organizationId}
organizations/{organizationId}/members/{uid}
organizations/{organizationId}/clients/{clientId}
organizations/{organizationId}/clients/{clientId}/assignments/{assignmentId}
organizations/{organizationId}/clients/{clientId}/state/activeAssignment
organizations/{organizationId}/ruleSets/{ruleSetId}/versions/{version}
organizations/{organizationId}/mappingReports/{dedupeKey}
organizations/{organizationId}/mappingReports/{dedupeKey}/events/{eventId}
organizations/{organizationId}/mappingProposals/{proposalId}
organizations/{organizationId}/mappingCatalog/current
organizations/{organizationId}/auditLog/{eventId}
organizations/{organizationId}/notifications/{notificationId}
organizations/{organizationId}/invitations/{inviteId}
```

I documenti applicativi includono `schemaVersion`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy` quando applicabile. Gli audit sono append-only e gli identificatori idempotenti derivano dalla richiesta o da un fingerprint.

## Sicurezza

Le mutazioni SaaS passano da callable Functions con Auth, App Check, validazione, membership autorevole, idempotency key, transazioni e audit. Le Rules negano tutte le scritture SaaS dal client. Le letture dirette sono minime; profilo assegnato e dati della coda passano da callable per evitare IDOR e query globali.

## Conseguenze

- La household continua a funzionare senza acquisire privilegi SaaS.
- La prima attivazione SaaS richiede provisioning esplicito di organization, membership, client e assignment.
- Il formato server è indipendente dalle regex incorporate nel client ed è cacheabile/versionabile.
- Email, provider advertising reale, billing, cancellazione automatica e analytics clinici restano dietro feature flag o job server-side documentati nel runbook.
