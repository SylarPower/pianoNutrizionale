# ADR 0004 — Rifondazione pre-lancio: catalogo identità, strutture a blocchi, template equivalenze

- Stato: accettato
- Data: 2026-09-19
- Decisione di prodotto: owner
- Supera le decisioni pre-rifondazione su catalogo (v2 con mappingKind/guideFamilyId), runtime dosi (ruleSets con regole per famiglia), piano dieta (dietPlan v1 con revisioni a regole per famiglia, vista Dosi) ed editor (opzioni free-foods, gruppi scelta): gli ADR che le documentavano non esistono più nella ripartenza pulita dell'archivio
- Allegati normativi: `docs/schema-catalogo-strutture.json`, `docs/catalog-import-format.md`, `docs/saas-data-contracts.md`

## Contesto

Prima del lancio il modello dati accumulava strati incoerenti:

- `GUIDE_GRAMMATURE` come fonte globale delle dosi: identità ingredienti, grammature e logica clinica mescolate in un unico oggetto lato client.
- `ruleSets` legacy e doppie fonti di verità (runtime assegnazioni vs strutture in console).
- Catalogo v2 con `mappingKind` (`guided`/`free`) e `guideFamilyId` (a sua volta figlio di un refuso di nomina, corretto in corso d'opera): l'appartenenza guidata era un attributo dell'ingrediente globale, quindi una scelta clinica spalmata sull'identità.
- dietPlan v1 con opzioni `free-foods`, `choiceGroups`, `target` kcal e campi peso legacy (`quantityState`, `netOfWaste`, `alternative`): un formato descrittivo ibrido.
- Refusi di nomina nei campi, ponti di compatibilità, fallback legacy e cataloghi sintetici.

Nessun dato di produzione esiste ancora: la pulizia distruttiva è ammessa ed è la scelta più pulita.

## Decisione

**Separazione rigida identità / logica clinica.**

1. **Catalogo globale autorevole** `globalIngredientCatalog/current/` (schemaVersion 1) con `families/{familyId}` e `ingredients/{ingredientId}`: displayName, aliases, searchTokens, categoryId, familyId, dietaryFlags.vegetarian/.vegan, status. **Zero dosi**: qualsiasi chiave dose rifiuta l'intero import. Famiglie globali e stabili, fonte unica per cliente, nutrizionista, admin, backend, autocomplete, motore di riconoscimento e persistenza degli `ingredientId`. Import batch versionato/atomico/reversibile riservato al platform admin (`docs/catalog-import-format.md`).
2. **Template equivalenze org-scoped** (`equivalenceTemplates`, revisioni schema 1): N riusabili, versionati, basati su **famiglia di riferimento** globale (+ eventuale ingrediente di riferimento) con quantità proporzionali. Mai retroattivi: i blocchi incapsulano uno `templateSnapshot` congelato alla pubblicazione della revisione struttura.
3. **Strutture dieta org-scoped** (`dietStructures`, revisioni schema 1, dietPlan schema 1): giornate → pasti → opzioni di tre tipi mutuamente esclusivi — `family-block` (blocchi famiglia di riferimento con override espliciti), `ingredients` (ingredienti singoli), `recipe` (ricetta professionale + moltiplicatore). Le etichette A/B/C/D non si persistono: derivazione di UI; un pasto a opzione singola resta `options:[…]` con un elemento e si renderizza senza etichette.
4. **Riconoscimento** a stati distinti `resolved / recognized-generic / ambiguous / unknown`: i termini noti e coerenti si risolvono (es. `uovo`/`uova`); i termini generici riconosciuti ma ambigui (es. `tonno`) non vengono mai auto-canonizzati; un `ingredientId` valido non si perde in editing; nessun falso "unknown".
5. **Coda ingredienti** senza dosi, gestita solo dal platform admin: il cliente propone termine + categoria + famiglia per un unknown (`submitCatalogRequest`), l'admin risolve con accept/edit/reject e l'accettazione entra nel catalogo globale come nuova versione.
6. **Assegnazioni**: puntatore verificato `{structureId, revisionId, checksum}` + `ingredientCatalogVersion` congelato. Il cliente vede tutto da `getMyAssignedProfile`; la scelta dosi originali vs allineate è ovunque (settimana, ricettario, spesa) ma **non modifica mai la ricetta originale**.

## Cosa viene eliminato (pulizia distruttiva autorizzata)

- `GUIDE_GRAMMATURE` e ogni sua derivazione come fonte di dosi.
- `ruleSets`, `globalRuleSets`, callable legacy (`publishRuleSetVersion`, `previewClientRuleSet`, `assignClientRuleSet`, `listRuleSets`, `submitMappingReport`, `proposeMapping`, `publishMapping`), percorso di assegnazione v1.
- `mappingKind`/`guideFamilyId` e ogni campo refuso o collegato.
- dietPlan v1: `free-foods`, `choiceGroups`, `target` kcal, campi peso legacy, label A–D persistite, revisioni strutture 1–3 con regole per famiglia e gruppi alternativi.
- Editor strutture "classico" e vista console «Dosi».
- Fallback legacy, bridge e cataloghi sintetici.

## Conseguenze

- Il checksum delle revisioni strutture copre solo il `dietPlan` (schema 1); le regole classiche non esistono più.
- La validazione dosi vive in un solo posto per lato (server `validateDietPlan`, client `js/domain.js` builder), con vocabolari allineati via test.
- La migrazione dei dati pre-lancio non è prevista: si riparte da catalogo importato + strutture ricreate in console.
