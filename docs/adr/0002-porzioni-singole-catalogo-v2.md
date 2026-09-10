# ADR 0002 — Porzione singola per profilo e separazione catalogo/strutture/assegna­zioni (schema 6)

- Stato: accettato
- Data: 2026-09-10
- Decisione di prodotto: owner
- Allegati normativi: `docs/schema-catalogo-strutture-v2.json`, `docs/catalogo-ingredienti-meller.json`, `docs/prompt-sessione-ux-saas-2.md`

## Contesto

Fino allo schema 5 una ricetta conservava **quattro quantità** per ingrediente (uomo/donna × allenamento/riposo). Le dosi di riposo erano quindi duplicate in ogni ricetta, la migrazione delle ricette a ogni variazione delle linee guida era rischiosa e il ricettario "originale" — che deve restare immutabile — conteneva di fatto dati derivati dalle linee guida.

In parallelo, `MELLER_GRAMMATURE` mescolava: identità degli ingredienti (nomi, categorie, alias), regole di dosaggio (quantità per pranzo/cena e giorno A/R) e struttura della dieta. Il prompt-sessione impone la separazione in tre concetti con governance diversa.

## Decisioni

1. **Quantità originale unica per profilo** (`portions: { man, ipo }`, schema 6).
   - La quantità originale è **una sola per profilo** ed è il riferimento del giorno di **allenamento** del pasto canonico della ricetta (il contesto canonico).
   - La dose di riposo (e il travaso pranzo/cena) **deriva a tempo di piano** dalla struttura assegnata (`resolveRecipeForPlan(recipe, slot, mode, dayType)` + `adaptIngredientForSlot(..., dayType)`), mai memorizzata nella ricetta.
   - Le porzioni legacy a 4 campi vengono migrare allo schema 6 preservando i valori di **allenamento**. La migrazione è idempotente.
   - `checkMellerAdaptation`/`checkMellerContext` confrontano l'originale con il **riferimento di allenamento del pasto** (canonico); il riposo non è un difetto dell'originale.

2. **Tre concetti separati** (vedi schema allegato):
   - **Catalogo globale ingredienti** (`globalIngredientCatalog/current/...`): nomi canonici, alias, categorie, `searchTokens`, `mappingKind` (`guided`/`free`), `mellerFamilyId` opzionale. **Zero quantità.** Governance da platform admin. Fonte dell'autocomplete dell'editor.
   - **Motore famiglie Meller**: quantità lunch/dinner × training/rest per famiglia, ordinate per ID (`mellerFamilyId`); le regex legacy restano solo come fallback di migrazione controllato.
   - **Strutture dieta org-scoped**: aggregate mutabile + revisioni immutabili con `ownerUid`; il nutritionist vede solo le proprie strutture, l'admin org tutte. Niente campo "Versione" in UI; `revisionId`/`checksum` sono dettagli interni. "Ripristina" crea una nuova revisione.

3. **`splitMellerSeed(extract)`** (`js/domain.js`): trasforma il JSON authoritative (`catalogo-ingredienti-meller.json`) nelle tre collezioni seed (catalogo, famiglie, struttura base) **senza importare i 58 ingredienti provvisori né inventare quantità**. `structureRevisionToMellerRules` converte una revisione pubblicata nella lista di regole motore (alias dal catalogo; fallback legacy solo per famiglie senza ingredienti in catalogo).

4. **Autocomplete editor**: field di ricerca `buildCatalogIndex` + `searchCatalog` (accents/case tolerant, alias evidenziati, prefisso > substring, ordinamento deterministico italiano, zero risultati per ignoto). L'ignoto è **consentito** ma marcato "mapping mancante": niente mapping né quantità inventate; `ingredientId` stabile se scelto dal catalogo.

5. **Toggle "quantità adattate alle linee guida"** (`plan.adaptedQuantitiesEnabled`, default ON): persiste la **modalità** del piano, non derivations. Con SaaS attivo, assignment assente/invalido/scaduto/non confermato → vista original-only anche a toggle attivo.

6. **Cliente finale**: modale obbligatorio-ideato "Aggiornamento disponibile" (nessuna modifica senza conferma; ricette al sicuro). Lista spesa sempre libera con assignment attivo/confermato, senza pubblicità; il gate rewarded 24h vale solo per i non associati e resta dietro flag provider disattivato.

7. **Sezione Prezzi sospesa**: flag `PRICES_FEATURE_ENABLED = false` in `js/app.js` nasconde menu e rotta senza cancellare logica né dati.

8. **Font Inter self-hosted** (OFL 1.1, `assets/fonts/`), fallback Verdana; nessuna chiamata Google Fonts a runtime.

9. **Import batch del catalogo globale**: gli ingredienti del catalogo si importano solo da **platform admin** via job applicativo (JSON/CSV) con validazione, deduplica e controllo collisioni alias; anteprima con diff, **dry-run** di default e commit atomico versionato ai numeri di catalogo (`catalogVersion`). La funzione è **reversibile con feature flag** (`CATALOG_IMPORT_ENABLED`, default disattivo in produzione finché il catalogo definitivo del dott. Meller non è pronto). Il formato esatto e le fixture vedi `docs/catalog-import-format.md`.

10. **Migrazione JSON Meller → split**: `splitMellerSeed(extract)` divide l'estratto canonico `docs/catalogo-ingredienti-meller.json` (25 famiglie guidate + 50 pattern liberi) in tre collezioni: `categories` (6 categorie del manuale + `free`), `ingredients` (25 guided + 50 free, **zero quantità**), `families` (motore quantità per nome), più `structureSeed.rules` (25) e `alternativeGroups` (carboidrati 10 / proteine 13). Il seed dell'emulatore lo applica tramite lo script `functions/scripts/seed-emulator.js` — nessuna modifica manuale del sorgente tra gli ambienti (App Check off solo in emulator).

## Conseguenze

- Le ricette originali restano immutabili: ogni adattamento è una **risoluzione di piano** (context + dayType), coerente con la non-retroattività (ADR 0001).
- L'editor mostra **un solo campo quantità per profilo**, con combobox di catalogo; la preparazione è opzionale e la tab "Batch cooking" è rimossa dall'editor (rilevazione automatica batch invariata in consultazione).
- Tutti i consumer (spesa, batch, swap, generatore, export) passano per `resolveRecipeForPlan`/`portionFor`, quindi ereditano la singola verità delle dosi derivate.
