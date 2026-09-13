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
  ruleSetId: "meller-base",
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
  ruleSetId: "meller-base",
  ruleSetVersion: "3",
  ruleSetChecksum: "sha256",
  mappingCatalogChecksum: "sha256",
  resolvedAt: "ISO date",
  migrationDecision: "confirmed"
}
```

Se snapshot e assegnazione non coincidono, il client non ricalcola: imposta i pasti Meller su `original` e mostra una richiesta di conferma. La lista spesa non viene rigenerata silenziosamente.

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
  name: "Base Meller",
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
    mellerFamilyId: "riso",       // deve esistere nel motore Meller
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
  structureName: "Base Meller",     // denormalizzato per la console
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
`structureRevisionToMellerRules`. Lo snapshot registra `structureId`,
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
  delivery: { channel: "email|manual-link", status: "pending|sent|failed|manual", attempts, errorCode? },
  expiresAt, tokenRotation?, supersededBy?, redeemedBy?, verifiedAt?,
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
  firstName, lastName, displayName,
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
- `inviteClientLink({ organizationId, username, nutritionistUid?, idempotencyKey })` — solo account tecnici di test (`LEGACY_TEST_INVITES_ENABLED` o emulatori)
- `inviteClientByEmail({ organizationId, email, firstName, lastName, nutritionistUid?, delivery: 'email'|'manual-link', idempotencyKey })`
- `getClientInvitePreview({ token })` — non autenticata: il token è il segreto
- `redeemClientInvite({ token|null, idempotencyKey })` — attiva il collegamento solo con email verificata
- `resendClientInvite({ organizationId, inviteId, delivery, idempotencyKey })`
- `correctClientInvite({ organizationId, inviteId, email, firstName, lastName, delivery, idempotencyKey })`
- `cancelClientInvite({ organizationId, inviteId, reason, idempotencyKey })`
- `updateClientProfileByStaff({ organizationId, clientId, firstName, lastName, displayName?, idempotencyKey })`
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

Le risposte di `listAuthorizedClients` e `listOrganizationUsers` includono `displayName` (facoltativo), `username` e `status` per i clienti autorizzati. I membri includono `displayName`; il nome visualizzato segue `displayName || username || displayCode`. `listMyClientLinkRequests` include `nutritionistUsername` e `nutritionistDisplayName` sia nelle richieste sia nel collegamento attivo, senza mai esporre token.

Il campo facoltativo `displayName` può comparire in `clients/{id}` e `members/{uid}` soltanto tramite le callable `updateMyClientProfile` e `updateMyMemberProfile`, entrambe idempotenti e con audit.

## Vista Clienti unificata (console, ADR 0005)

La console ha un'unica area «Clienti»: niente vista «Utenti» separata. Team
dello studio, richieste e invito legacy vivono dentro la vista Clienti;
l'invito con email reale è un dialog dedicato. Il nutrizionista vede solo i
propri clienti, in tutti gli stati operativi.

Stati operativi (calcolati in `js/domain.js`, `clientOperationalStatus`):

| Stato | Etichetta | Quando |
|---|---|---|
| `active` | Attivo | profilo `active`, nessun invito/richiesta pendente |
| `pending` | In attesa | profilo `pending`, oppure invito o richiesta pendente |
| `inactive` | Inattivo | tutto il resto (`unlinked`, `suspended`, …) |

Titolo del cliente (`clientDisplayTitle`, mai UID o ID tecnici): «Nome
Cognome» → `displayName` → email mascherata (`m•••@dominio.it`) →
`displayCode`. Lo username resta solo informazione secondaria per gli account
di test legacy.

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
      meals: [{
        mealId: "breakfast|morning-snack|lunch|afternoon-snack|dinner|evening-snack",
        time: "12:30" | null,
        options: [{
          label: "A|B|C|D",
          items: [{
            foodGroup: "cereali|…|altro",  // 15 gruppi chiusi
            description: "Riso Venere",
            quantity: 80 | null, unit: "g|…|qb" | null,
            quantityState: "crudo|cotto" | null,
            netOfWaste: true|false,        // al netto degli scarti
            alternative: "Pasta integrale 80 g" | null   // «oppure»
          }],                             // 1–20 voci
          note: null
        }],                               // 1–4 opzioni
        note: null
      }],                                 // 1–10 pasti
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

Limiti: 14 giornate, 10 pasti/giornata, 4 opzioni/pasto, 20 voci/opzione;
testi 20–2000 caratteri secondo campo; quantità 0–5000. Validazione bloccante
server-side (`validateDietPlan`); la console pre-valida in italiano. Le
revisioni 1/2 restano verificabili e modificabili con l'editor classico, che
conserva l'eventuale `dietPlan`. `createDietStructure` e
`updateDietStructureRevision` accettano `dietPlan?` (null per le classiche).
Guida operativa: `docs/editor-dieta-guidata.md`.
