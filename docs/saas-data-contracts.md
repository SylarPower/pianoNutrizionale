# Contratti SaaS — schema 1 (profili v1) + schema 2 (strutture, Fase 2)

Tutte le date API sono ISO-8601; in Firestore sono `Timestamp`. Le stringhe utente sono trim, con lunghezze massime e senza HTML. I payload non accettano campi inattesi.

## Membership e permessi

| Operazione | admin | nutritionist | cliente | platform admin |
|---|---:|---:|---:|---:|
| Leggere coda mapping tenant | sì | sì, casi dei clienti autorizzati | no | no |
| Segnalare mapping | sì | sì | sì, per sé | no |
| Proporre mapping tenant | sì | sì | no | no |
| Pubblicare mapping tenant | sì | sì | no | no |
| Pubblicare mapping globale | no | no | no | sì |
| Leggere clienti | tutti | autorizzati | solo sé via callable | no |
| Assegnare/sospendere profilo | sì | autorizzati | no | no |
| Modificare rule set tenant | sì | propri/autorizzati | no | no |
| Audit tenant | sì | eventi dei clienti autorizzati | no | no |

La membership autorevole è `organizations/{orgId}/members/{uid}` con `role`, `status`, `schemaVersion`. Per un nutrizionista `clients/{clientId}.nutritionistUids` limita l'accesso. `accountClientLinks/{uid}` è scritto solo server-side.

## RuleSetVersion

```js
{
  schemaVersion: 1,
  ruleSetId: "guide-base",
  version: "3",                 // monotona nel ruleSet
  status: "draft|published|retired",
  scope: "global|tenant",
  base: { ruleSetId, version, checksum } | null,
  effectiveAt: "ISO date",
  compatibleClientSchema: 1,
  rules: [{
    family: "pasta",
    group: "carb",
    label: "Pasta",
    aliases: ["pasta", "spaghetti"],
    slots: {
      lunch: { training: 90, rest: 70 },
      dinner: { training: 40, rest: 40 }
    }
  }],
  overrides: [],
  changelog: "...",
  reviewNotes: "...",
  checksum: "sha256 hex",
  createdAt, updatedAt, createdBy, updatedBy,
  publishedAt, publishedBy
}
```

Il checksum è SHA-256 del JSON canonico di `{schemaVersion, ruleSetId, version, rules, overrides}`. Dopo `published`, le Rules impediscono scritture client e le Functions rifiutano mutazioni in-place.

## Assignment

```js
{
  schemaVersion: 1,
  assignmentId,
  clientId,
  ruleSet: { scope: "global|tenant", ruleSetId, version, checksum },
  status: "scheduled|active|suspended|revoked|expired",
  effectiveAt,
  expiresAt: null,
  strategy: "freeze|migrate-on-confirmation|original-only",
  reason: "...",
  previousAssignmentId: null,
  idempotencyKey,
  createdAt, updatedAt, createdBy, updatedBy
}
```

`clients/{clientId}/state/activeAssignment` è una proiezione server-side. La cronologia rimane nella subcollection `assignments`. La proiezione non sostituisce la fonte storica.

## Snapshot piano

```js
plan.nutritionSnapshot = {
  schemaVersion: 1,
  clientProfileId: "client-id",
  assignmentId: "assignment-id",
  ruleSetId: "guide-base",
  ruleSetVersion: "3",
  ruleSetChecksum: "sha256",
  mappingCatalogChecksum: "sha256",
  resolvedAt: "ISO date",
  migrationDecision: "confirmed"
}
```

Se snapshot e assegnazione non coincidono, il client non ricalcola: imposta i pasti Guide su `original` e mostra una richiesta di conferma. La lista spesa non viene rigenerata silenziosamente.

## MappingReport

```js
{
  schemaVersion: 1,
  reportId, organizationId,
  clientRef: "hash/pseudonimo",
  clientId,                       // server-only nella risposta cliente
  normalizedFingerprint,
  ingredientText,
  context: { slot: "lunch|dinner", errorType: "unknown|ambiguous" },
  ruleSet: { id, version },
  status: "open|triaged|needs-review|resolved|rejected|duplicate",
  occurrenceCount,
  firstSeenAt, lastSeenAt,
  resolution: null,
  createdAt, updatedAt, createdBy, updatedBy
}
```

La chiave di deduplica è SHA-256 di organization, fingerprint, rule set/versione e tipo errore. Ogni transizione aggiunge un evento append-only. Il rate limit è per UID e finestra temporale server-side.

## MappingProposal

```js
{
  schemaVersion: 1,
  proposalId, reportId,
  scope: "tenant|global",
  mapping: {
    kind: "guided|free",
    canonicalIngredientId,
    aliases: ["..."],
    family: "...",
    group: "carb|protein|dairy|fat|sweet|fruit|free",
    doses: { lunch: { training, rest }, dinner: { training, rest } } | null
  },
  status: "draft|published|rejected",
  version: "1",
  checksum,
  rationale,
  createdAt, updatedAt, createdBy, updatedBy, publishedAt, publishedBy
}
```

Priorità offline deterministica: override profilo > mapping tenant pubblicato > mapping globale pubblicato > ingrediente libero esplicito > sconosciuto. A parità di livello un alias esatto prevale; più risultati allo stesso livello producono `ambiguous`, mai una scelta silenziosa.

## Struttura dieta (schema 2, Fase 2)

Testata mutabile + revisioni immutabili, org-scoped con `ownerUid`. Il
nutritionist vede/gestisce solo le proprie; l'admin org tutte. Niente campo
"Versione" in UI; `currentRevisionId`/`checksum` sono interni (checksum visibile
solo all'admin dentro "Dettagli tecnici", mai al nutritionist).

```js
// organizations/{orgId}/dietStructures/{structureId}
{
  schemaVersion: 1,
  name: "Base Guide",
  status: "active|archived",
  ownerUid: "uid-proprietario",
  currentRevisionId: "3",
  latestChecksum: "sha256 hex",   // solo callable; UI admin via getDietStructureRevision
  ruleCount: 25,
  alternativeGroupCount: 2,
  ingredientCatalogVersion: 4,    // catalogo al momento della pubblicazione
  createdAt, updatedAt, createdBy, updatedBy
}

// .../revisions/{revisionId} — immutabile
{
  schemaVersion: 2,
  revisionId: "3",
  structureId,
  rules: [{
    guideFamilyId: "riso",       // deve esistere nel motore Guide
    ingredientIds: ["riso", "riso-venere"],  // devono esistere in catalogo
    quantityGrams: {
      lunch: { training: 80, rest: 60 },
      dinner: { training: 40, rest: 40 }      // pasto null = non gestito (mai entrambi)
    },
    enabled: true,
    categoryId: "carb" | null     // deve esistere in catalogo (o 'free')
  }],
  alternativeGroups: [{
    alternativeGroupId: "carboidrati",
    displayName: "Alternative carboidrati",
    items: [{ ingredientId: "pasta", quantityGrams: { lunch, dinner } }]
  }],
  status: "published",
  checksum: "sha256 hex",         // di {schemaVersion: 2, rules, alternativeGroups}
  ingredientCatalogVersion: 4,
  compatibleClientSchema: 6,
  changelog, restoredFromRevisionId,
  createdAt, updatedAt, createdBy, publishedAt, publishedBy
}
```

Dosi: interi 1–2000 g. Le revisioni schema 1 (solo `rules`, checksum su
`{schemaVersion: 1, rules}`) restano verificabili in lettura. Ogni salvataggio
pubblica una nuova revisione; "ripristina" crea una nuova revisione copiando la
selezionata. Le strutture archiviate non sono assegnabili ma restano servite
per gli assignment già creati (non-retroattività).

## Assignment v2 (Fase 2)

```js
{
  schemaVersion: 2,
  assignmentId, clientId,
  structure: { structureId, revisionId, checksum },  // risolti server-side
  structureName: "Base Guide",     // denormalizzato per la console
  status: "scheduled|active|suspended|revoked|expired",
  effectiveAt, expiresAt: null,
  withoutExpiration: true,
  strategy: "migrate-on-confirmation",  // interno, non in UI
  reason: "…", notesVisibility: "staff", notes?: "…",  // mai al cliente
  previousAssignmentId, idempotencyKey,
  createdAt, updatedAt, createdBy, updatedBy
}
```

Il profilo cliente v2 (`getMyAssignedProfile`) contiene revisione + snapshot
catalogo; la conversione in regole motore avviene nel client via
`structureRevisionToGuideRules`. Lo snapshot registra `structureId`,
`structureRevisionId`, `structureChecksum` e `ingredientCatalogVersion`: un
cambio di catalogo richiede conferma (nudge) senza ricalcoli retroattivi.

## Inviti e collegamenti (Fase 2)

```js
// organizations/{orgId}/invitations/{inviteId} — token SOLO in hash
{
  schemaVersion: 1, inviteId,
  type: "nutritionist|client",
  targetUsername: "cliente-1",
  clientId,                    // solo type client
  nutritionistUid,             // proponente/destinatario (client)
  tokenHash: "sha256 hex",     // il chiaro è mostrato UNA volta alla creazione
  status: "pending|accepted|revoked|expired",
  expiresAt,                   // 7 giorni
  createdAt, updatedAt, createdBy, decidedAt, decidedBy
}

// organizations/{orgId}/clientLinkRequests/{requestId}
{
  schemaVersion: 1, requestId, organizationId, clientId,
  channel: "legacy-test|email",   // email = richiesta del nuovo modello
  targetUid, targetUsername, targetEmailNormalized?, targetEmailHash?,
  nutritionistUid, status: "pending|accepted|rejected|revoked",
  createdAt, updatedAt, createdBy, decidedAt, decidedBy
}

// Invito con EMAIL REALE (ADR 0004): type clientEmail
{
  schemaVersion: 2, inviteId, type: "clientEmail", channel: "email",
  organizationId,
  targetEmailNormalized, targetEmailHash,   // mai l'indirizzo in chiaro nelle risposte altrui
  firstName, lastName,                      // inseriti dal nutrizionista, non modificabili dal cliente
  clientId, nutritionistUid,
  tokenHash: "sha256 hex",                  // il chiaro esiste una sola volta (creazione/reinvio/correzione)
  status: "pending|accepted|expired|superseded|revoked",
  delivery: { schemaVersion: 2, channel: "manual-link", status: "pending|manual", handedToConsole? },  // link consegnato a mano dalla console (Copia link / Condividi link); nessun invio email
  expiresAt, tokenRotation?, supersededBy?, redeemedBy?, verifiedAt?,
  createdAt, updatedAt, createdBy
}

// organizations/{orgId}/invitationSecrets/{inviteId} — token IN CHIARO
// Regole: `allow read, write: if false` (solo Admin SDK, dentro
// getClientInviteLink). Serve a riconsegnare lo stesso link dalla console
// ("Copia link") finché l'invito è pendente.
{
  schemaVersion: 1, inviteId, organizationId,
  token: "64 hex",             // chiaro: mai nelle risposte non autorizzate
  tokenHash: "sha256 hex",     // deve corrispondere a invitations/{inviteId}.tokenHash
  createdAt, updatedAt, createdBy
}

// organizations/{orgId}/emailChangeRequests/{requestId} (server-only)
{
  schemaVersion: 1, requestId, organizationId, clientId, targetUid,
  oldEmailNormalized, newEmailNormalized,
  status: "pending|accepted|rejected", reason?,
  createdAt, updatedAt, createdBy, decidedAt, decidedBy, appliedAt?
}

// organizations/{orgId}/clients/{clientId} — campi del nuovo modello
{
  authUid, status: "pending|active|unlinked",
  email, emailNormalized, emailVerified: true|false,
  firstName, lastName,
  invitedUsername,                          // solo account tecnici legacy
  nutritionistUids, activeAssignment, displayCode,
  createdAt, updatedAt, createdBy, updatedBy
}
```

Stati cliente: `pending` (invitato, oppure account creato senza email
verificata), `active`, `unlinked` (legame revocato, doc conservato). Il
collegamento diventa attivo **dopo la verifica email** per gli inviti con email
reale; per gli account tecnici legacy vale il comportamento storico (attivo al
riscatto). La rimozione revoca link + sospende assignment, senza cancellare
Auth/household/ricette/backup. Dettagli operativi: `docs/inviti-email.md`.

## Catalogo globale e import (Fase 2)

`globalIngredientCatalog/current/{ingredients,categories}/…` + `meta/summary`
`{catalogVersion, checksum, counts}`. Snapshot in
`globalIngredientCatalog/versions/snapshots/<n>`; config server-only in
`globalIngredientCatalog/config/{import,denylist}`. Ogni commit/restore crea una
nuova versione mai sovrascritta; le revisioni strutture conservano
`ingredientCatalogVersion`. Formato e validazioni: `docs/catalog-import-format.md`.

## Callable principali

- `getMyAssignedProfile({})`
- `submitMappingReport({ clientProfileId, fingerprint, ingredientText, slot, errorType, ruleSetId, ruleSetVersion })`
- `listMappingReports({ organizationId, status?, pageSize?, cursor? })`
- `proposeMapping({ organizationId, reportId, mapping, rationale, idempotencyKey })`
- `publishMapping({ organizationId, proposalId, targetScope, idempotencyKey })`
- `publishRuleSetVersion({ organizationId, scope, ruleSetId, version, rules, overrides, effectiveAt, changelog, reviewNotes?, idempotencyKey })`
- `previewClientRuleSet({ organizationId, clientId, ruleSet })`
- `assignClientRuleSet({ organizationId, clientId, ruleSet, effectiveAt, expiresAt?, strategy, reason, idempotencyKey })`
- `updateAssignmentStatus({ organizationId, clientId, assignmentId, status, reason, idempotencyKey })`
- `listAuthorizedClients({ organizationId })` → `{ clients, invitations, requests, emailChanges }`
- `getClientHistory({ organizationId, clientId })` → storico non pendente del cliente
- `listDietStructures({ organizationId })`
- `getDietStructureRevision({ organizationId, structureId, revisionId? })` → include `dietPlan?`
- `createDietStructure({ organizationId, name, rules, alternativeGroups?, dietPlan?, idempotencyKey })`
- `updateDietStructureRevision({ organizationId, structureId, name?, rules, alternativeGroups?, dietPlan?, changelog?, restoredFromRevisionId?, idempotencyKey })`
- `archiveDietStructure({ organizationId, structureId, archived, idempotencyKey })`
- `compareDietStructures({ organizationId, structureIds[2..8] })`
- `assignClientStructure({ organizationId, clientId, structureId, effectiveAt, expiresAt?, withoutExpiration, notes?, idempotencyKey })`
- `importGlobalIngredientCatalog({ format, mode, payload?, previewId?, confirm?, restoreVersion? })`
- `searchUserByUsername({ organizationId, username })` → `{ found, userId }`
- `inviteOrganizationUser({ organizationId, username, role: 'nutritionist', idempotencyKey })`
- `acceptOrganizationInvite({ token })`
- `listOrganizationUsers({ organizationId })`
- `setMemberStatus({ organizationId, userId, status: 'active|suspended', idempotencyKey })`
- `inviteClientLink({ organizationId, username, nutritionistUid?, idempotencyKey })` — compatibilità interna per emulatori/migrazioni; non è esposto dalla console live
- `inviteClientByEmail({ organizationId, email, firstName, lastName, nutritionistUid?, idempotencyKey })` → `{ status, inviteUrl?, expiresAt?, … }` — il link si consegna a mano (nessun campo `delivery`)
- `getClientInvitePreview({ token })` — non autenticata **e pubblica** (`enforceAppCheck: false`, `cors: true`): il token è il segreto e il link viene aperto anche fuori dall'app registrata → `{ status: 'valid|expired|used|superseded|revoked|not-found', type, email, firstName, lastName, expiresAt, organizationName, nutritionistName }`
- `getClientInviteLink({ organizationId, inviteId })` (alias `getInviteLink`) — solo staff autorizzato: restituisce il link **già emesso** di un invito `pending`, senza rigenerare il token → `{ inviteId, clientId, type, targetEmail, firstName, lastName, expiresAt, inviteUrl, token, delivery: { channel: 'manual' } }`; il token in chiaro è letto da `organizations/{orgId}/invitationSecrets/{inviteId}` (Admin SDK, regole chiuse)
- `redeemClientInvite({ token|null, idempotencyKey })` — attiva il collegamento solo con email verificata; con `token: null` l'app lo richiama a ogni accesso/ricarica (ID token rinnovato a forza) e il server risponde `link-active` / `no-pending-invite`
- `resendClientInvite({ organizationId, inviteId, idempotencyKey })` → nuovo `inviteUrl`
- `correctClientInvite({ organizationId, inviteId, email, firstName, lastName, idempotencyKey })` → nuovo `inviteUrl`
- `cancelClientInvite({ organizationId, inviteId, reason, idempotencyKey })`
- `updateClientProfileByStaff({ organizationId, clientId, firstName, lastName, idempotencyKey })`
- `updateMemberProfileByStaff({ organizationId, userId, firstName, lastName, idempotencyKey })` — solo creatore
- `proposeClientEmailChange({ organizationId, clientId, newEmail, reason?, idempotencyKey })`
- `respondMyEmailChange({ requestId, decision: 'accept'|'reject', idempotencyKey })`
- `listMyClientLinkRequests({})`
- `respondClientLink({ requestId, decision: 'accept|reject' })`
- `requestClientUnlink({})`
- `removeClientLink({ organizationId, clientId, reason, idempotencyKey })`
- `removeNutritionist({ organizationId, userId, idempotencyKey })`
- `transferStructureOwnership({ organizationId, structureId, newOwnerUid, idempotencyKey })`
- `requestShoppingReward({ receipt?, placement? })`

Deprecati lato UI ma mantenuti per i client legacy: `publishRuleSetVersion`,
`previewClientRuleSet`, `assignClientRuleSet`, `listRuleSets`.

## Event envelope

```js
{
  schemaVersion: 1,
  eventId,
  type: "mapping.reported|mapping.published|assignment.created|assignment.status-changed|structure.created|structure.revision.published|structure.archived|structure.restored|structure.ownership-transferred|member.added|member.invited|member.status-changed|member.removed|client.link-invited|client.link-accepted|client.link-rejected|client.link-removed|client.unlinked",
  organizationId,
  actor: { uid, role },
  subject: { type, id },
  idempotencyKey,
  occurredAt,
  metadata: {} // mai testo libero sensibile o ricette
}
```


## Profili mostrati

Le risposte di `listAuthorizedClients` includono `firstName`, `lastName`, `username` e `status` per i clienti autorizzati (il `displayName` è stato rimosso). `listOrganizationUsers` include per i membri `firstName`, `lastName`, `displayName` (legacy) e `username`; il nome visualizzato del professionista segue `firstName lastName → displayName → username`. `listMyClientLinkRequests` include `nutritionistUsername` e `nutritionistDisplayName` (con fallback `firstName lastName`) sia nelle richieste sia nel collegamento attivo, senza mai esporre token.

Per i clienti `displayName` non esiste più: l'anagrafica è `firstName`/`lastName` gestita solo dallo staff via `updateClientProfileByStaff`. Per i professionisti l'anagrafica `firstName`/`lastName` è gestita solo dal creatore via `updateMemberProfileByStaff` (vedi sotto).

## Vista Clienti unificata (console, ADR 0005)

La console ha un'unica area «Clienti»: niente vista «Utenti» separata. Il
team dello studio è riservato all'admin; richieste e inviti del cliente vivono
nella scheda del cliente, senza elenco duplicato. L'invito con email reale è un
dialog dedicato e il nutrizionista vede solo i propri clienti, in tutti gli
stati operativi.

Stati operativi (calcolati in `js/domain.js`, `clientOperationalStatus`):

| Stato | Etichetta | Quando |
|---|---|---|
| `active` | Attivo | profilo `active`, nessun invito/richiesta pendente |
| `pending` | In attesa | profilo `pending`, oppure invito o richiesta pendente |
| `inactive` | Inattivo | tutto il resto (`unlinked`, `suspended`, …) |

Titolo del cliente (mai UID o ID tecnici): «Nome Cognome» → email
mascherata (`m•••@dominio.it`) → «Cliente». Username, codici e identificativi
restano dati interni e non vengono mostrati al nutrizionista.

`listAuthorizedClients({ organizationId })` restituisce `{ clients,
invitations, requests, emailChanges }`: clienti in ogni stato (ordinati per
aggiornamento), inviti email pendenti, richieste di collegamento pendenti e
proposte di cambio email, sempre limitati ai clienti autorizzati. Un solo
filtro per query (ADR 0003); la selezione degli stati avviene in codice.

`getClientHistory({ organizationId, clientId })` restituisce lo storico non
pendente del cliente (`invitations` + `requests`: accettati, rifiutati,
revocati, scaduti, sostituiti), con singolo filtro per `clientId` e senza mai
token o hash. La scheda cliente lo mostra in «Storico collegamenti».

La rimozione esiste SOLO dentro la scheda («Rimuovi cliente» → dialog
esplicativo → `removeClientLink`): revoca logica con audit, senza cancellare
Auth/household/ricette/backup.

## Dieta guidata (dietPlan v1, revisioni schema 3, ADR 0005)

Il piano guidato è un documento **descrittivo** dentro la revisione struttura:
giornate, pasti, opzioni A/B/C/D, quantità con unità, note, integrazione e
idratazione. Non esegue calcoli clinici: i valori energetici della giornata
sono appunti manuali del professionista. Il motore dosi continua a usare le
regole classiche; una struttura solo-guidata ha `rules: []` (ammesso solo con
`dietPlan` valido) e la vista Dosi personalizza solo le frequenze.

```js
// .../revisions/{revisionId} quando presente il piano (schema 3)
{
  schemaVersion: 3,
  rules: [],                        // ammesso vuoto solo con dietPlan
  alternativeGroups: [],
  dietPlan: {
    schemaVersion: 1,
    days: [{
      dayId: null | "id-stabile",
      label: "Lunedì" | null,
      dayType: "training|rest|other",
      target: { kcal, proteinG, carbsG, fatG, waterMl },  // appunti, null se vuoti
      meals: [{                        // ordine fisso per tipo (il sort è stabile)
        mealId: "breakfast|morning-snack|lunch|afternoon-snack|dinner|evening-snack",
        time: "12:30" | null,
        options: [{
          label: "A|B|C|D",
          type: "free-foods|recipe",   // due tipi mutuamente esclusivi
          // — tipo «free-foods» —
          items: [{                    // 0–20 voci (con almeno un gruppo scelta se 0)
            foodGroup: "cereali|…|altro",  // 15 gruppi chiusi
            description: "Riso Venere",
            quantity: 80 | null, unit: "g|…|qb" | null   // sempre al netto e a crudo
          }],
          choiceGroups: [{             // 0–3 gruppi scelta («Scegli 1 tra:»)
            title: "Scegli 1 carboidrato tra:",
            optional: true,            // false = il cliente deve scegliere
            alternatives: [{ foodGroup, description, quantity, unit }]  // 1–30, dose editabile
          }],
          // — tipo «recipe» —
          recipeId: "id-ricetta-professionale",  // obbligatorio se type recipe
          recipeMultiplier: 1.5,       // ×0,1–10, default 1; solo se type recipe
          items: [], choiceGroups: [], // vuoti per le opzioni ricetta
          note: null
        }],                               // 1–4 opzioni
        note: null
      }],                                 // 1–10 pasti (UI: un solo pasto per tipo)
      supplements: null, hydration: null, note: null
    }],                                   // 1–14 giornate
    generalNotes: null
  },
  status: "published",
  checksum: "sha256 hex",   // di {schemaVersion: 3, rules, alternativeGroups, dietPlan}
  ingredientCatalogVersion, compatibleClientSchema: 6,
  changelog, restoredFromRevisionId,
  createdAt, updatedAt, createdBy, publishedAt, publishedBy
}

// Testata struttura: nuovo flag (assente = false nelle vecchie)
{ hasDietPlan: true|false }
```

Limiti: 14 giornate, 10 pasti/giornata, 4 opzioni/pasto, 20 voci/opzione,
3 gruppi scelta/opzione, 30 alternative/gruppo, moltiplicatore ricetta
0,1–10; testi 20–2000 caratteri secondo campo; quantità 0–5000. Validazione
bloccante server-side (`validateDietPlan`); la console pre-valida in italiano.

**Compatibilità con le revisioni precedenti.** I piani salvati prima
dell'evoluzione del contratto possono contenere `quantityState`
(crudo/cotto), `netOfWaste` e `alternative` («oppure») e opzioni senza
`type`: restano validi in lettura e round-trip (la validazione li rivalida e
li conserva), ma i nuovi piani non li producono più — i pesi sono sempre al
netto degli scarti e a crudo. Le opzioni senza `type` sono «free-foods».
L'editor console ignora i campi rimossi alla riapertura (migrazione silenziosa
al primo salvataggio). Le revisioni 1/2 restano verificabili e modificabili
con l'editor classico, che conserva l'eventuale `dietPlan`.
`createDietStructure` e `updateDietStructureRevision` accettano `dietPlan?`
(null per le classiche). Guida operativa: `docs/editor-dieta-guidata.md`;
decisioni: `docs/adr/0007-opzioni-ricetta-e-gruppi-scelta.md`.

## Ricettario professionisti (ADR 0006)

Collezione `organizations/{orgId}/recipes/{recipeId}` (server-only: le
regole negano tutto ai client, nessun indice composto):

```js
{
  id: "R" + 12 hex, organizationId, ownerUid, ownerUsername,
  name, emoji, slot, proteinCategory?, ingredients, steps, notes,
  visibility: "private" | "studio", status: "active" | "archived",
  revision: 1, version: 1, archivedAt?, createdAt, updatedAt, createdBy
}
```

Limiti (validazione server `validateProfessionalRecipe`, specchio di
`js/domain.js`): nome 1–120; 1–12 ingredienti (nome 1–120, dosi
Uomo/Donna ≤ 120 caratteri); 0–12 passi (≤ 500); 0–8 note (≤ 500).

Callable: `listProfessionalRecipes` (proprie + studio, filtri in JS,
sort `updatedAt` desc, max 200), `createProfessionalRecipe` (bozza
privata), `updateProfessionalRecipe` (solo proprietario, `revision`
attesa obbligatoria, 409), `archiveProfessionalRecipe` (solo
proprietario, senza ripristino), `shareProfessionalRecipe` (solo
creatore, `private`↔`studio`), `sendProfessionalRecipe` (1–5 ricette
attive e visibili a clienti collegati, `type: "professional"`,
`senderRole: "professional"`, snapshot `professionalRevision`),
`cancelProfessionalShare` (mittente o creatore),
`listProfessionalShares` (pendenti `senderRole professional`, max 200).
Chiave idempotente `recipe-<azione>:<uid>:<key>`.

Copie cliente: stesso `id` + `fromProfessional: { recipeId, revision,
organizationId, senderUid, senderUsername, acceptedAt, shareType }`
(provenienza col contenuto, anche in transfer/export); sola lettura
con badge «Studio». Audit: `recipe.created/updated/archived/visibility/
sent/shareCancelled`.
