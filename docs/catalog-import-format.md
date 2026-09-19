# Import batch del catalogo globale ingredienti (platform admin)

Documento di contratto per l'import del catalogo ingredienti globale v3 (`globalIngredientCatalog/current/...`). L'import è riservato al **platform admin**, è **versionato** (`catalogVersion`), **atomico**, **reversibile** e si esegue via callable backend (`importGlobalIngredientCatalog`) — mai da scritture client.

Il catalogo contiene **solo identità**: nomi canonici, alias, categoria, famiglia, flag dietetici vegetarian/vegan, `searchTokens` (rigenerati dal server). **Zero dosi**: qualsiasi chiave che somigli a una dose rifiuta l'intero file — grammature e proporzioni vivono esclusivamente nelle strutture dieta e nei template equivalenze del singolo professionista.

## Formati ammessi

### JSON (array di ingredienti oppure oggetto con `categories`, `families`, `ingredients`)

```json
{
  "categories": [
    { "categoryId": "cereali-minori", "displayName": "Cereali minori", "description": null, "sortOrder": 90 }
  ],
  "families": [
    { "familyId": "sorgo-e-affini", "displayName": "Sorgo e affini", "categoryId": "cereali-minori", "sortOrder": 10 }
  ],
  "ingredients": [
    {
      "ingredientId": "sorgo",
      "displayName": "Sorgo",
      "aliases": ["sorghum"],
      "categoryId": "cereali-minori",
      "familyId": "sorgo-e-affini",
      "dietaryFlags": { "vegetarian": true, "vegan": true },
      "status": "active"
    }
  ]
}
```

Tutte le sezioni sono opzionali (un file può importare solo ingredienti); `families` è il posto dove nascono famiglie nuove, `categories` dove nascono categorie nuove.

### CSV (separatore `;` o `,`, intestazione obbligatoria)

```
ingredientId;displayName;aliases;categoryId;familyId;vegetarian;vegan
sorgo;Sorgo;sorghum|grano di sorgo;cereali-minori;sorgo-e-affini;true;true
```

Gli `aliases` sono separati da `|` (CSV) o array di stringhe (JSON). Le colonne `vegetarian`/`vegan` accettano `true`/`1`/vuoto (vuoto = non dichiarato → `false`). Il CSV importa **solo ingredienti**: famiglie e categorie nuove vanno dichiarate via JSON o già presenti nel catalogo corrente.

## Regole di validazione (bloccanti, tutte lato server)

1. **Zero dosi**: qualsiasi colonna o chiave che somigli a una dose (`quantity*`, `grams`, `dose*`, `slots`, …) rifiuta l'intero file (`campo dose vietato`).
2. **Famiglie globali stabili**: ogni ingrediente dichiara `familyId`; la famiglia deve esistere nel file o nel catalogo corrente, altrimenti `familyId inesistente`. Il `categoryId` dell'ingrediente deve coincidere con quello della famiglia (`categoryId diverso da quello della famiglia …`).
3. **Flag dietetici**: `vegetarian`/`vegan` booleani; `vegan: true` con `vegetarian: false` è rifiutato (`dietaryFlags: vegan implica vegetarian`).
4. **Deduplica**: `ingredientId` duplicato nel file → errore; `displayName`/`alias` normalizzato che collida con un ingrediente esistente *diverso* → errore di collisione alias con elenco dei conflitti nel report. Stesso ID = aggiornamento, non collisione.
5. **Riferimenti**: `categoryId` deve esistere tra quelle del file o del catalogo corrente.
6. **Niente ingredienti provvisori**: gli ID nella denylist (`globalIngredientCatalog/config/docs/denylist`, ID proposti dai clienti e non ancora approvati) rifiutano l'import.
7. **Normalizzazione server**: alias trimmati/minuscoli/senza accenti e deduplicati; `searchTokens` rigenerati da `displayName + aliases`; `normalizedName` calcolato — mai accettati tali quali dal file.

## Ciclo di vita

1. **Dry-run** (default): nessuna scrittura. Output: conteggi per esito (`counts.create/update/unchanged/conflict/error`, create include ingredienti + famiglie + categorie) + diff dettagliato (max 200 righe) + `previewId` (SHA-256 di baseCatalogVersion + contenuto normalizzato).
2. **Commit**: stessa payload con `previewId` del dry-run, `confirm: true` e feature flag `CATALOG_IMPORT_ENABLED` attivo → transazione atomica: bump `catalogVersion`, scrittura ingredienti/famiglie/categorie in `current/`, snapshot della versione precedente in `globalIngredientCatalog/versions/snapshots/<n-1>`, evento `catalog.imported` in audit con checksum. Limite di 400 voci per commit: file più grandi vanno suddivisi.
3. **Restore**: modalità `restore` con `restoreVersion` + `confirm: true` ripristina uno snapshot (cancellando ciò che non vi compare) come nuova versione; snapshot della versione sostituita e audit `catalog.restored`.

Le versioni del catalogo **non collassano** con le revisioni delle strutture: ogni revisione pubblicata conserva il riferimento `ingredientCatalogVersion` al momento della pubblicazione (non-retroattività).

## Fixture

- `functions/test/fixtures/catalog-import-valid.json` / `.csv` — import valido (2 ingredienti, 1 categoria, 1 famiglia).
- `functions/test/fixtures/catalog-import-alias-collision.json` — alias che collide con un ingrediente esistente → dry-run con conflitto.
- `functions/test/fixtures/catalog-import-provisional-denied.json` — ID in denylist → rifiuto bloccante.

> **Stato**: callable, fixture e test sono allineati al formato v3. Il commit/restore in produzione resta dietro `CATALOG_IMPORT_ENABLED` (default off); il dry-run è sempre disponibile al platform admin. La denylist vive solo nella configurazione server-side e non entra mai nel repository: la fixture `…-provisional-denied.json` usa un ID segnaposto per dimostrare il meccanismo.
