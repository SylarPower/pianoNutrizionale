# ADR 0003 — Transizione ruleSets → dietStructures unificate (Fase 2)

- Stato: accettato
- Data: 2026-09-10
- Decisione di prodotto: owner
- Precede: ADR 0001 (multi-tenant), ADR 0002 (schema 6, separazione catalogo/strutture)

## Contesto

Dopo la PR #54 esistevano due modelli paralleli: i `ruleSets` legacy
(runtime delle assegnazioni) e le `dietStructures` (gestione in console).
La console assegnava revisioni ruleSet mentre le strutture restavano isolate;
il cliente non riceveva mai le regole delle strutture.

## Decisioni

1. **Le Strutture dieta alimentano assegnazioni e cliente.** `assignClientStructure`
   risolve server-side `currentRevisionId` + checksum dalla revisione corrente
   della struttura e scrive l'assignment con pointer
   `{structureId, revisionId, checksum}` (schema 2). `getMyAssignedProfile`
   serve revisione + snapshot catalogo; la conversione in regole motore resta
   nel client (`structureRevisionToMellerRules`), senza fork server-side delle dosi.
2. **Compatibilità.** Il callable legacy `assignClientRuleSet` e i reader v1
   restano per i client già rilasciati; `publishRuleSetVersion`,
   `previewClientRuleSet` e `listRuleSets` sono deprecati lato UI ma mantenuti
   server-side. Le revisioni schema 1 restano verificabili in lettura.
3. **Contratto struttura.** Revisioni schema 2 con `rules` + `alternativeGroups`,
   checksum su entrambi, `ingredientCatalogVersion` stampigliato a ogni
   pubblicazione (non-retroattività). Validazione server-side: famiglie
   esistenti nel motore (allowlist di soli ID, parità testata), ingredienti e
   categorie esistenti in catalogo.
4. **Confronto e import.** `compareDietStructures` calcola la matrice
   server-side (sola lettura). L'import catalogo è atomico, versionato e
   reversibile dietro `CATALOG_IMPORT_ENABLED` (default OFF in produzione);
   la denylist provvisoria è configurazione server-side, mai nel repository.
5. **Utenti.** Inviti monouso con solo hash conservato, richieste accettate in
   app (idempotenti), rimozione = sola revoca dell'associazione (mai account,
   household, ricette, backup), rimozione nutritionist bloccata con conteggio
   clienti pendenti, strutture mai trasferite in silenzio (`ownerUid` invariato).
6. **Spesa.** `requestShoppingReward` verifica server-side: assignment attivo →
   accesso senza reward; altrimenti `failed-precondition` a flag OFF. Nessuna
   ricevuta è considerata attendibile senza provider reale.

## Conseguenze

- Snapshot v2 con `structureId`/`structureRevisionId`/`ingredientCatalogVersion`:
  revisioni e catalogo nuovi richiedono conferma cliente (nudge), mai ricalcoli
  retroattivi.
- Nessun nuovo indice composito: le query Utenti/inviti/link usano singoli
  filtri + selezione in codice.
- Rules: accesso diretto a strutture/revisioni negato; inviti/link leggibili
  solo dai contraenti; catalogo `current/` leggibile, `config/` e `versions/`
  server-only.
