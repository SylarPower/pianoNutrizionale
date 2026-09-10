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
  targetUid, targetUsername, nutritionistUid,
  status: "pending|accepted|rejected|revoked",
  createdAt, updatedAt, createdBy, decidedAt, decidedBy
}
```

Stati cliente: `pending` (invitato), `active`, `unlinked` (legame revocato,
doc conservato). La rimozione revoca link + sospende assignment, senza
cancellare Auth/household/ricette/backup.

## Catalogo globale e import (Fase 2)

`globalIngredientCatalog/current/{ingredients,categories}/…` + `meta/summary`
`{catalogVersion, checksum, counts}`. Snapshot in
`globalIngredientCatalog/versions/<n>`; config server-only in
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
- `listAuthorizedClients({ organizationId })`
- `listDietStructures({ organizationId })`
- `getDietStructureRevision({ organizationId, structureId, revisionId? })`
- `createDietStructure({ organizationId, name, rules, alternativeGroups?, idempotencyKey })`
- `updateDietStructureRevision({ organizationId, structureId, name?, rules, alternativeGroups?, changelog?, restoredFromRevisionId?, idempotencyKey })`
- `archiveDietStructure({ organizationId, structureId, archived, idempotencyKey })`
- `compareDietStructures({ organizationId, structureIds[2..8] })`
- `assignClientStructure({ organizationId, clientId, structureId, effectiveAt, expiresAt?, withoutExpiration, notes?, idempotencyKey })`
- `importGlobalIngredientCatalog({ format, mode, payload?, previewId?, confirm?, restoreVersion? })`
- `searchUserByUsername({ organizationId, username })` → `{ found, userId }`
- `inviteOrganizationUser({ organizationId, username, role: 'nutritionist', idempotencyKey })`
- `acceptOrganizationInvite({ token })`
- `listOrganizationUsers({ organizationId })`
- `setMemberStatus({ organizationId, userId, status: 'active|suspended', idempotencyKey })`
- `inviteClientLink({ organizationId, username, nutritionistUid?, idempotencyKey })`
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
