# ADR 0006 — Ricettario professionisti con condivisioni di studio

- **Stato**: accettata (fase di building)
- **Data**: 2026-09-14
- **Contesto**: Piano Nutrizionale, organizzazione singola `pianoNutrizionale`
- **Documenti collegati**: `docs/saas-data-contracts.md` (ricette
  professionali), `docs/configurazione-manuale.md` (§6, uso operativo)

## 1. Perché questa decisione

Le ricette vivevano solo sui telefoni dei clienti: i professionisti non
avevano un ricettario di studio condiviso e inviavano pasti copiando testi
a mano. Serviva una raccolta centrale — bozze private, ricette di studio,
invii tracciati — senza duplicare l'infrastruttura di condivisione che
esiste già fra clienti (`recipeShares`).

## 2. Modello dati

Collezione `organizations/pianoNutrizionale/recipes/{recipeId}`
(server-only: le regole negano tutto ai client, senza modifiche a
rules né indici):

```js
{
  id: "R" + 12 hex, organizationId, ownerUid, ownerUsername,
  name, emoji, slot, proteinCategory?, ingredients, steps, notes,
  batch?: "man" | "ipo" | null,   // solo duplicati da dosi cliente
  visibility: "private" | "studio",
  status: "active" | "archived",
  revision: 1, version: 1, archivedAt?, createdAt, updatedAt, createdBy
}
```

Ingredienti, pasti (`slot`) e validazione riusano le regole del dominio
condiviso (`js/domain.js`, specchiate in `functions/src/domain.js`):
nome 1–120, almeno 1 ingrediente, max 12 ingredienti / 12 passi / 8 note,
dosi Uomo/Donna fino a 120 caratteri.

## 3. Callable (tutte le scritture passano di qui)

`listProfessionalRecipes` (lettura: proprie + studio, filtri in JS,
ordinamento per `updatedAt`, nessun indice composto),
`createProfessionalRecipe` (bozza privata, id `R`+12hex, chiave
idempotente `recipe-create:<uid>:<key>`),
`updateProfessionalRecipe` (solo proprietario, revisione ottimistica:
`revision` attesa obbligatoria, 409 in caso di conflitto),
`archiveProfessionalRecipe` (solo proprietario, **senza ripristino**),
`shareProfessionalRecipe` (solo creatore, `private`↔`studio`),
`sendProfessionalRecipe` (1–5 ricette attive e visibili, solo a clienti
collegati), `cancelProfessionalShare` (solo mittente o creatore),
`listProfessionalShares` (pendenti dello studio). Impersonificazione
vietata ovunque: `professionalUid` esplicito rifiutato.

## 4. Invii: riuso di `recipeShares`

Gli invii ai clienti riusano la collezione `recipeShares` con
`senderRole: "professional"`, snapshot `professionalRevision` e tipo
`"professional"` (senza `plan` né `doses`: solo la ricetta così com'è).
Il cliente riceve
l'invito nella campanella come gli altri: **Accetta** sostituisce
(`replace`) o unisce, con il preview che mostra la versione dello
studio così com'è (con nota esplicativa), perché non esistono campi
modificabili da confrontare.

## 5. Copie cliente e sola lettura

La copia accettata conserva lo **stesso `id`** della ricetta di studio
e il flag `fromProfessional: { recipeId, revision, organizationId,
senderUid, senderUsername, acceptedAt, shareType }`, che sopravvive a
trasferimenti ed export/import (la provenienza viaggia col contenuto).
Le copie professionali sono **in sola lettura**: badge «Studio» in
notifica, scheda e modale; modifica disabilitata con messaggio;
eliminazione consentita (è solo la propria copia). Il badge usa la scala
tipografica dell'app (`--fs-badge`).

## 6. Console: vista Ricette

Voce «Ricette» nel menu, vista `view-recipes` con filtri
(Tutte/Mie/Studio/Archiviate), editor con righe ingrediente
(nome + dose Uomo/Donna, come l'app), invio ai clienti collegati e
pannello «Invii in attesa» con annullo. Permessi UI: modifica e archivia
solo proprietario (pulsanti disabilitati agli altri), condividi di
studio solo creatore. Le archiviate non sono modificabili né inviabili.

## 7. Audit e limiti

Eventi `recipe.created/updated/archived/visibility/sent/shareCancelled`
su `auditLog`. Nessun ripristino delle archiviate, nessun rinnovo
automatico delle copie cliente quando lo studio pubblica una nuova
revisione (la copia resta fotografia della revisione accettata).
Limite 200 ricette/invii per elenco. Test: 21 callable
(`functions/test/recipes-professional.test.js`), 28 validatori
(`functions/test/domain.test.js`), 8 merge client
(`test/professional-recipes.test.js`), 6 console
(`test/console-recipes.test.js`).
