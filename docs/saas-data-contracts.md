# Contratti SaaS — schema 1

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

## Event envelope

```js
{
  schemaVersion: 1,
  eventId,
  type: "mapping.reported|mapping.published|assignment.created|assignment.status-changed",
  organizationId,
  actor: { uid, role },
  subject: { type, id },
  idempotencyKey,
  occurredAt,
  metadata: {} // mai testo libero sensibile o ricette
}
```
