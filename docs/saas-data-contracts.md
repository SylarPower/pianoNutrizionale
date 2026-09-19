# Contratti SaaS — modello v3 (catalogo globale, strutture a blocchi, template equivalenze)

Tutte le date API sono ISO-8601; in Firestore sono `Timestamp`. Le stringhe utente sono trim, con lunghezze massime e senza HTML. I payload non accettano campi inattesi.

Principio portante del modello: **identità e logica clinica separate**. Il catalogo globale contiene solo identità (nomi, alias, categoria, famiglia, flag dietetici); grammature, equivalenze e proporzioni vivono esclusivamente nel perimetro organizzazione (strutture dieta, template equivalenze, override). Lo schema JSON di riferimento: `docs/schema-catalogo-strutture-v3.json`.

## Membership e permessi

| Operazione | admin | nutritionist | cliente | platform admin |
|---|---:|---:|---:|---:|
| Leggere clienti | tutti | autorizzati | solo sé via callable | no |
| Assegnare/sospendere struttura | sì | autorizzati | no | no |
| Gestire strutture/template | sì | propri/autorizzati | no | no |
| Proporre ingredienti (coda) | no | no | sì, per sé | no |
| Risolvere la coda ingredienti | no | no | no | sì |
| Importare il catalogo globale | no | no | no | sì |
| Audit tenant | sì | eventi dei clienti autorizzati | no | no |

La membership autorevole è `organizations/{orgId}/members/{uid}` con `role`, `status`, `schemaVersion`. Per un nutrizionista `clients/{clientId}.nutritionistUids` limita l'accesso. `accountClientLinks/{uid}` è scritto solo server-side.

## Catalogo globale ingredienti (v3)

`globalIngredientCatalog/current/{meta,families,ingredients,categories}` + `meta/summary` `{schemaVersion: 3, catalogVersion, checksum, ingredientCount, familyCount, categoryCount}`. Snapshot immutabili in `globalIngredientCatalog/versions/snapshots/<n>`; config server-only in `globalIngredientCatalog/config/{import,denylist}`. Ogni commit/restore crea una nuova versione mai sovrascritta; le revisioni strutture conservano `ingredientCatalogVersion` (non-retroattività).

```js
// families/{familyId} — famiglia globale stabile, unità di equivalenza
{ schemaVersion: 3, familyId: "cereali", displayName: "Cereali e derivati",
  categoryId: "carb", sortOrder: 10, status: "active",
  catalogVersion, updatedAt }

// ingredients/{ingredientId} — SOLO identità, zero dosi
{ schemaVersion: 3, ingredientId: "riso", displayName: "Riso",
  normalizedName: "riso", aliases: ["risotto", "riso in bianco"],
  searchTokens: ["riso", "risotto", "bianco"],
  categoryId: "carb", familyId: "cereali",
  dietaryFlags: { vegetarian: true, vegan: true },
  status: "active", catalogVersion, updatedAt }
```

Qualsiasi chiave dose (`quantity*`, `grams`, `dose*`, `slots`…) è vietata dal validatore e rifiuta l'intero import. Il client riceve il catalogo come snapshot dentro il profilo assegnato (`publicCatalogSnapshot`): categorie, famiglie e ingredienti attivi, nessun campo server-only. Formato e ciclo di vita dell'import: `docs/catalog-import-format.md`.

## Struttura dieta (revisioni schema 4, dietPlan schema 2)

Le strutture sono org-scoped: `organizations/{orgId}/dietStructures/{structureId}` con metadati `{name, description, status, ownerId, createdAt, updatedAt}` e subcollection `revisions/{revisionId}` immutabile:

```js
{
  schemaVersion: 4,
  revisionId, status: "published",
  dietPlan: { … schema 2, sotto … },
  checksum: "sha256 hex",            // structureRevisionChecksum({schemaVersion, dietPlan})
  ingredientCatalogVersion,          // congelato alla pubblicazione
  changelog, restoredFromRevisionId,
  createdAt, updatedAt, createdBy, publishedAt, publishedBy
}
```

Il `dietPlan` schema 2 è il solo contenuto clinico: giornate → pasti → **opzioni**. Tre tipi di opzione, mutuamente esclusivi:

- `family-block` — 1–8 **blocchi famiglia di riferimento**: quantità sull'ingrediente di riferimento, equivalenti dal template (snapshot non retroattivo), override espliciti della struttura;
- `ingredients` — 1–20 ingredienti singoli con quantità;
- `recipe` — una ricetta professionale con moltiplicatore ×0,1–10.

```js
{ schemaVersion: 2, generalNotes: "…", days: [{
  dayId: "giorno-allenamento", label: "Giorno di allenamento", dayType: "training|rest|other",
  meals: [{
    mealId: "breakfast|morning-snack|lunch|afternoon-snack|dinner|evening-snack",
    time: "12:30", note: "",
    options: [{                        // 1–4; pasto a opzione singola = un solo elemento
      optionId: "pranzo-blocchi", type: "family-block", note: "",
      blocks: [{
        blockId: "amidi-riso",
        referenceFamilyId: "cereali",        // famiglia globale stabile
        referenceIngredientId: "riso",       // null = famiglia senza riferimento
        referenceAmount: { value: 80, unit: "g" },
        templateId: "tpl-amidi",             // null = nessun template
        templateSnapshot: {                  // congelato alla pubblicazione
          revisionId: "1",
          referenceAmount: { value: 80, unit: "g" },
          equivalents: [
            { familyId: "patate", ingredientId: "patate", amount: { value: 250, unit: "g" } }
          ]
        },
        overrides: [                         // espliciti, mai la famiglia di riferimento
          { familyId: "gnocchi", ingredientId: null, amount: { value: 150, unit: "g" } }
        ]
      }]
    }]
  }],
  supplements: "", hydration: "", note: ""
}] }
```

Le etichette A/B/C/D **non si persistono**: sono derivazione di UI quando un pasto ha più opzioni; un pasto con una sola opzione si renderizza senza etichette. Limiti: 14 giornate, 10 pasti/giornata, 4 opzioni/pasto, 8 blocchi/opzione, 20 voci/opzione, 30 equivalenti/override, quantità 0–5000 con unità del vocabolario chiuso. Validazione bloccante server-side (`validateDietPlan`); la console pre-valida in italiano con lo stesso vocabolario.

## Template equivalenze (revisioni schema 1)

`organizations/{orgId}/equivalenceTemplates/{templateId}` + `revisions/{revisionId}`. N template riusabili, versionati, **mai retroattivi**: una revisione pubblicata è immutabile e i blocchi che la referenziano ne incapsulano uno snapshot.

```js
{
  schemaVersion: 1,
  name: "Amidi — riferimento riso 80 g",
  referenceFamilyId: "cereali",        // famiglia globale, non categorie vaghe
  referenceIngredientId: "riso",       // eventuale ingrediente di riferimento
  referenceAmount: { value: 80, unit: "g" },
  equivalents: [                        // 1–30, quantità proporzionali
    { familyId: "patate", ingredientId: "patate", amount: { value: 250, unit: "g" } },
    { familyId: "pane-e-affini", ingredientId: "pane", amount: { value: 55, unit: "g" } }
  ],
  checksum: "sha256 hex"               // equivalenceTemplateRevisionChecksum(revisione)
}
```

La famiglia di riferimento non può comparire tra gli equivalenti. Il calcolo proporzionale (`dietBlockEquivalents` in `js/domain.js`) scala le quantità rispetto alla `referenceAmount` del blocco.

## Assegnazione struttura (v3)

```js
// organizations/{orgId}/clients/{clientId}/assignments/{assignmentId}
{
  schemaVersion: 3, assignmentId, organizationId, clientId,
  structure: { structureId, revisionId, checksum },   // puntatore verificato
  ingredientCatalogVersion,
  status: "active|suspended|revoked",
  effectiveAt, expiresAt, withoutExpiration: true|false,
  notes, previousAssignmentId, idempotencyKey,
  createdAt, updatedAt, createdBy, updatedBy
}
```

`clients/{clientId}/state/activeAssignment` è una proiezione server-side; la cronologia resta nella subcollection `assignments`. Payload `assignClientStructure`: campi esatti `[organizationId, clientId, structureId, effectiveAt, expiresAt, withoutExpiration, notes, idempotencyKey]` — niente strategie né checksum lato client. Senza `expiresAt` è obbligatorio `withoutExpiration`.

Il cliente legge tutto da `getMyAssignedProfile({})` → `profile` (schema 3): `{clientProfileId, assignmentId, structureId, structureRevisionId, structureChecksum, structureName, ingredientCatalogVersion, effectiveAt, expiresAt, structureRevision: {revisionId, dietPlan}, catalog: {catalogVersion, categories, families, ingredients}, compatibleClientSchema: 7}`. Lo snapshot client (`js/saas.js`, persistito nel piano settimanale come campo `nutritionSnapshot`) è `{schemaVersion: 2, clientProfileId, assignmentId, resolvedAt, migrationDecision: "confirmed", structureId, structureRevisionId, structureChecksum, ingredientCatalogVersion}`.

## Coda ingredienti (client → platform admin)

Il cliente propone categoria+famiglia per un termine non riconosciuto (`submitCatalogRequest`); il platform admin risolve con **accept / edit / reject** (`resolveCatalogRequest`). Accettare o modificare inserisce l'ingrediente nel catalogo globale come nuova versione (con snapshot e audit). Nessuna dose passa mai da questo flusso.

```js
// organizations/{orgId}/catalogRequests/{requestId}
{ schemaVersion: 1, requestId, status: "pending|accepted|rejected",
  ingredientText: "tonno al naturale", normalizedIngredient: "tonno al naturale",
  proposedCategoryId: "protein", proposedFamilyId: "pesce-scatola-naturale",
  clientId, clientTitle, submittedByUid, idempotencyKey,
  resolution: { action: "accept|edit|reject", ingredientId? },
  resolutionNote, resolvedAt, resolvedBy, createdAt, updatedAt }
```

## Inviti e collegamenti

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

Stati cliente: `pending` (invitato, oppure account creato senza email verificata), `active`, `unlinked` (legame revocato, doc conservato). Il collegamento diventa attivo **dopo la verifica email** per gli inviti con email reale; per gli account tecnici legacy vale il comportamento storico (attivo al riscatto). La rimozione revoca link + sospende assignment, senza cancellare Auth/household/ricette/backup. Dettagli operativi: `docs/inviti-email.md`.

## Callable principali

Strutture, assegnazioni e template:

- `listDietStructures({ organizationId })`
- `getDietStructureRevision({ organizationId, structureId, revisionId? })` → include `dietPlan?`
- `createDietStructure({ organizationId, name, dietPlan, idempotencyKey })`
- `updateDietStructureRevision({ organizationId, structureId, name?, dietPlan, changelog?, restoredFromRevisionId?, idempotencyKey })`
- `archiveDietStructure({ organizationId, structureId, archived, idempotencyKey })`
- `compareDietStructures({ organizationId, structureIds[2..8] })`
- `assignClientStructure({ organizationId, clientId, structureId, effectiveAt, expiresAt?, withoutExpiration, notes?, idempotencyKey })`
- `updateAssignmentStatus({ organizationId, clientId, assignmentId, status, reason, idempotencyKey })`
- `listEquivalenceTemplates({ organizationId })`
- `getEquivalenceTemplateRevision({ organizationId, templateId, revisionId? })`
- `saveEquivalenceTemplate({ organizationId, templateId?, name, referenceFamilyId, referenceIngredientId?, referenceAmount, equivalents, idempotencyKey })`
- `archiveEquivalenceTemplate({ organizationId, templateId, archived, idempotencyKey })`
- `transferStructureOwnership({ organizationId, structureId, newOwnerUid, idempotencyKey })`

Catalogo globale e coda ingredienti:

- `importGlobalIngredientCatalog({ format, mode, payload?, previewId?, confirm?, restoreVersion? })` — platform admin
- `listCatalogRequests({ status? })` — platform admin
- `resolveCatalogRequest({ requestId, action, ingredient?, reason?, idempotencyKey })` — platform admin
- `submitCatalogRequest({ ingredientText, proposedCategoryId?, proposedFamilyId?, idempotencyKey })` — cliente; `ingredientText` 2–120 caratteri
- `listMyCatalogRequests({})` — cliente

Cliente e profilo:

- `getMyAssignedProfile({})`
- `listMyNotifications({})` / `markNotificationRead({ notificationId })`
- `requestShoppingReward({ receipt?, placement? })`
- `activateScheduledAssignments()` — schedulata

Clienti, membri, inviti e collegamenti:

- `listAuthorizedClients({ organizationId })` → `{ clients, invitations, requests, emailChanges }`
- `getClientHistory({ organizationId, clientId })` → storico non pendente del cliente
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
- `deleteClientPermanently({ organizationId, clientId, idempotencyKey })` — solo creatore, cancellazione fisica
- `proposeClientEmailChange({ organizationId, clientId, newEmail, reason?, idempotencyKey })`
- `respondMyEmailChange({ requestId, decision: 'accept'|'reject', idempotencyKey })`
- `getMyMemberships({})`
- `listMyClientLinkRequests({})`
- `respondClientLink({ requestId, decision: 'accept|reject' })`
- `requestClientUnlink({})`
- `removeClientLink({ organizationId, clientId, reason, idempotencyKey })`
- `removeNutritionist({ organizationId, userId, idempotencyKey })`

## Event envelope

```js
{
  schemaVersion: 1,
  eventId,
  type: "assignment.created|assignment.status-changed|structure.created|structure.revision.published|structure.archived|structure.restored|structure.ownership-transferred|equivalenceTemplate.created|equivalenceTemplate.revision.published|equivalenceTemplate.archived|equivalenceTemplate.restored|catalogRequest.created|catalogRequest.accepted|catalogRequest.rejected|catalog.imported|catalog.restored|recipe.created|recipe.updated|recipe.archived|recipe.visibility|recipe.sent|recipe.shareCancelled|member.added|member.invited|member.invite-redeemed|member.status-changed|member.removed|member.profile-updated-staff|client.link-invited|client.link-accepted|client.link-rejected|client.link-removed|client.unlinked|client.email-invited|client.email-invite-resent|client.email-invite-corrected|client.email-invite-delivered|client.email-invite-cancelled|client.invite-blocked-legacy|client.invite-blocked-same|client.invite-blocked-other|client.link-requested|client.link-activated|client.link-noop|client.profile-updated|client.profile-updated-staff|client.email-change-requested|client.email-change-accepted|client.email-change-rejected|client.deleted-permanently",
  organizationId,
  actor: { uid, role },
  subject: { type, id },
  idempotencyKey,
  occurredAt,
  metadata: {} // mai testo libero sensibile o ricette
}
```

Gli eventi catalogo (`catalog.imported|restored`, `catalogRequest.*`) usano l'audit di piattaforma (`platformAuditLog`), separato dall'audit tenant.

## Profili mostrati

Le risposte di `listAuthorizedClients` includono `firstName`, `lastName`, `username` e `status` per i clienti autorizzati. `listOrganizationUsers` include per i membri `firstName`, `lastName`, `displayName` (legacy) e `username`; il nome visualizzato del professionista segue `firstName lastName → displayName → username`. `listMyClientLinkRequests` include `nutritionistUsername` e `nutritionistDisplayName` (con fallback `firstName lastName`) sia nelle richieste sia nel collegamento attivo, senza mai esporre token.

Per i clienti l'anagrafica è `firstName`/`lastName` gestita solo dallo staff via `updateClientProfileByStaff`. Per i professionisti l'anagrafica `firstName`/`lastName` è gestita solo dal creatore via `updateMemberProfileByStaff`.

## Vista Clienti unificata (console, ADR 0005)

La console ha un'unica area «Clienti»: niente vista «Utenti» separata. Il team dello studio è riservato all'admin; richieste e inviti del cliente vivono nella scheda del cliente, senza elenco duplicato. L'invito con email reale è un dialog dedicato e il nutrizionista vede solo i propri clienti, in tutti gli stati operativi.

Stati operativi (calcolati in `js/domain.js`, `clientOperationalStatus`):

| Stato | Etichetta | Quando |
|---|---|---|
| `active` | Attivo | profilo `active`, nessun invito/richiesta pendente |
| `pending` | In attesa | profilo `pending`, oppure invito o richiesta pendente |
| `inactive` | Inattivo | tutto il resto (`unlinked`, `suspended`, …) |

Titolo del cliente (mai UID o ID tecnici): «Nome Cognome» → email mascherata (`m•••@dominio.it`) → «Cliente». Username, codici e identificativi restano dati interni e non vengono mostrati al nutrizionista.

`getClientHistory({ organizationId, clientId })` restituisce lo storico non pendente del cliente, con singolo filtro per `clientId` e senza mai token o hash. La scheda cliente lo mostra in «Storico collegamenti».

La rimozione esiste SOLO dentro la scheda («Rimuovi cliente» → dialog esplicativo → `removeClientLink`): revoca logica con audit, senza cancellare Auth/household/ricette/backup.

## Ricettario professionisti (ADR 0006)

Collezione `organizations/{orgId}/recipes/{recipeId}` (server-only: le regole negano tutto ai client, nessun indice composto):

```js
{
  id: "R" + 12 hex, organizationId, ownerUid, ownerUsername,
  name, emoji, slot, proteinCategory?, ingredients, steps, notes,
  visibility: "private" | "studio", status: "active" | "archived",
  revision: 1, version: 1, archivedAt?, createdAt, updatedAt, createdBy
}
```

Limiti (validazione server `validateProfessionalRecipe`, specchio di `js/domain.js`): nome 1–120; 1–12 ingredienti (nome 1–120, dosi Uomo/Donna ≤ 120 caratteri); 0–12 passi (≤ 500); 0–8 note (≤ 500).

Callable: `listProfessionalRecipes` (proprie + studio, filtri in JS, sort `updatedAt` desc, max 200), `createProfessionalRecipe` (bozza privata), `updateProfessionalRecipe` (solo proprietario, `revision` attesa obbligatoria, 409), `archiveProfessionalRecipe` (solo proprietario, senza ripristino), `shareProfessionalRecipe` (solo creatore, `private`↔`studio`), `sendProfessionalRecipe` (1–5 ricette attive e visibili a clienti collegati, `type: "professional"`, `senderRole: "professional"`, snapshot `professionalRevision`), `cancelProfessionalShare` (mittente o creatore), `listProfessionalShares` (pendenti `senderRole professional`, max 200). Chiave idempotente `recipe-<azione>:<uid>:<key>`.

Copie cliente: stesso `id` + `fromProfessional: { recipeId, revision, organizationId, senderUid, senderUsername, acceptedAt, shareType }` (provenienza col contenuto, anche in transfer/export); sola lettura con badge «Studio». Audit: `recipe.created/updated/archived/visibility/sent/shareCancelled`.
