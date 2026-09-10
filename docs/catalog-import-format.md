# Import batch del catalogo globale ingredienti (platform admin)

Documento di contratto per l'import del catalogo ingredienti globale v2 (`globalIngredientCatalog/current/...`). L'import è riservato al **platform admin**, è **versionato** (`catalogVersion`), **atomico**, **reversibile via feature flag** (`CATALOG_IMPORT_ENABLED`, default off in produzione) e si esegue via callable backend — mai da scritture client.

## Formati ammessi

### JSON (array radice o oggetto con chiave `ingredients`)

```json
[
  {
    "ingredientId": "riso",
    "displayName": "Riso",
    "aliases": ["risotto", "riso in bianco"],
    "categoryId": "altri-cereali",
    "mappingKind": "guided",
    "mellerFamilyId": "riso"
  },
  {
    "ingredientId": "free-broccol",
    "displayName": "Broccoli (categoria libera)",
    "aliases": ["broccol"],
    "categoryId": "free",
    "mappingKind": "free",
    "mellerFamilyId": null
  }
]
```

### CSV (separatore `;` o `,`, intestazione obbligatoria)

```
ingredientId;displayName;aliases;categoryId;mappingKind;mellerFamilyId
riso;Riso;risotto|riso in bianco;altri-cereali;guided;riso
free-broccol;Broccoli (categoria libera);broccol;free;free;
```

Gli `aliases` sono separati da `|` (CSV) o array di stringhe (JSON). `mellerFamilyId` è opzionale: solo gli ingredienti guidati Meller ce l'hanno; un `free` con `mellerFamilyId` valorizzato è errore bloccante.

## Regole di validazione (bloccanti, tutte lato server)

1. **Zero quantità**: qualsiasi colonna o chiave che somigli a una dose (`quantity*`, `grams`, `dose*`, `slots`) rifiuta l'intero file — le dosi appartengono alle strutture/famiglie, non al catalogo.
2. **Niente ingredienti provvisori**: gli ID del lotto provvisorio (i 58 ingredienti non approvati dal dott. Meller) sono nella denylist e rifiutano l'import.
3. **Deduplica**: `ingredientId` duplicato nel file → errore; `displayName`/`alias` normalizzato che collida con un ingrediente esistente *diverso* → errore di collisione alias con elenco dei conflitti nel report.
4. **Riferimenti**: `categoryId` deve esistere nel set categorie dell'import o del catalogo corrente + la categoria riservata `free`.
5. Alias normalizzati: trim, lowercase, rimozione accenti; alias vuoti rimossi; `searchTokens` rigenerati dai dati (`displayName + aliases`), mai accettati tali quali dal file.

## Ciclo di vita

1. **Dry-run** (default): nessuna scrittura. Output: conteggi per esito (creazioni, aggiornamenti identici, conflitti, errori) + diff dettagliato (max 200 righe) + `previewId`.
2. **Commit**: invio della stessa payload con `previewId` e conferma esplicita → transazione atomica: bump `catalogVersion`, scrittura ingredienti/categorie, snapshot della versione precedente in `globalIngredientCatalog/versions/<n-1>` per rollback operativo, evento `catalog.imported` in audit con checksum.
3. **Rollback**: feature-flag `CATALOG_IMPORT_ENABLED` può essere disattivato in qualsiasi momento; lo snapshot precedente permette il ripristino con lo stesso callable in modalità `restore`.

Le versioni del catalogo **non collassano** con le revisioni delle strutture: ogni revisione pubblicata conserva il riferimento `ingredientCatalogVersion` al momento della pubblicazione (non-retroattività, ADR 0001/0002).

## Fixture

- `functions/test/fixtures/catalog-import-valid.json` — import valido (2 ingredienti, 1 categoria estesa).
- `functions/test/fixtures/catalog-import-alias-collision.json` — alias che collideva con un ingrediente esistente → dry-run con conflitto.
- `functions/test/fixtures/catalog-import-provisional-denied.json` — ID provvisorio in denylist → rifiuto bloccante.

> **Stato (Fase 2)**: il callable `importGlobalIngredientCatalog` e le fixture (`functions/test/fixtures/`) sono implementati; il commit/restore in produzione resta dietro `CATALOG_IMPORT_ENABLED=false` finché il catalogo definitivo del dott. Meller non sarà approvato (il dry-run è sempre disponibile al platform admin). In attesa, il seed deriva **solo** da `MELLER_GRAMMATURE`/estratto autorevole (`splitMellerSeed`). La denylist dei 58 ID provvisori vive solo nella configurazione server-side (`globalIngredientCatalog/config/denylist`) e non entra mai nel repository: la fixture `…-provisional-denied.json` usa un ID segnaposto per dimostrare il meccanismo.
