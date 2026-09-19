# ADR 0007 — Opzioni ricetta, gruppi scelta e ordine pasti fisso nell'editor guidata

- **Stato**: superata (storica) — le opzioni ricetta sopravvivono nel dietPlan
  schema 2; gruppi scelta e free-foods sono superati da ADR 0008
- **Data**: 2026-09-15
- **Contesto**: Piano Nutrizionale, editor dieta guidata (dietPlan v1,
  revisioni schema 3)
- **Documenti collegati**: `docs/saas-data-contracts.md` (dietPlan v1
  evoluto), `docs/editor-strutture-dieta.md` (guida operativa, allora `editor-dieta-guidata.md`), ADR 0005
  (dieta guidata), ADR 0006 (ricettario professionisti)

## 1. Perché questa decisione

L'editor guidata consentiva solo opzioni «lista alimenti» con tre campi di
peso che il flusso reale non usa più (crudo/cotto, al netto degli scarti,
«oppure») e pasti liberamente riordinabili, con la possibilità di aggiungere
due volte lo stesso tipo. Le decisioni qui sotto sono state validate con
l'utente prima dell'implementazione.

## 2. Decisioni

1. **Ordine pasti fisso ma flessibile.** I pasti seguono l'ordine canonico di
   `DIET_PLAN_MEALS` (colazione → spuntino mattina → pranzo → merenda →
   cena → spuntino serale). L'utente aggiunge/rimuove pasti ma non li
   riordina (solo le giornate restano riordinabili). Un solo pasto per tipo:
   «＋ Aggiungi pasto» propone solo i tipi mancanti. La normalizzazione
   (`sortDietPlanMeals`) è stabile: dati legacy con tipi ripetuti non si
   mescolano.
2. **Opzioni di due tipi mutuamente esclusivi.** `option.type` è
   `free-foods` (lista alimenti + gruppi scelta) oppure `recipe` (ricetta del
   ricettario professionale, scelta da `adminState.professionalRecipes`, con
   `option.recipeId` e `option.recipeMultiplier`). Le opzioni ricetta non
   hanno lista alimenti; per un'alternativa si crea un'altra opzione A/B/C/D
   (il campo `alternative` degli item è stato rimosso, non spostato).
3. **Dose ricetta = moltiplicatore.** Scelto il moltiplicatore libero
   (×0,1–10, default ×1) invece di porzioni o grammi: le dosi della ricetta
   sono testo libero («80 g»), quindi l'anteprima moltiplica i numeri per
   valore (anche le frazioni: «1/2» ×2 → «1») e mostra l'originale accanto al
   risultato («80 g → 120 g»). «q.b.» e testi senza numeri restano invariati.
   La scalatura è solo anteprima: nel piano viaggiano `recipeId` +
   `recipeMultiplier`, nessun valore clinico calcolato.
4. **Gruppi scelta dentro l'opzione.** Nei soli opzioni «free-foods»
   (`option.choiceGroups`, max 3 per opzione): titolo + alternative (1–30,
   nessun limite di business) ognuna con descrizione + quantità + unità,
   salvate così come digitate (il piano è descrittivo). `optional: true` di
   default: il cliente può saltare il gruppo. Le alternative si precompilano
   dalla tabella di riferimento (carboidrati/proteine) con la dose del pasto
   corrente — pranzo: colonna A/R della giornata, cena: dose serale — e
   restano editabili. Nell'editor il gruppo si mostra minimizzato (solo
   riepilogo) quando è completo e dopo il precompilamento; «Modifica» lo
   espande. La selezione/skip lato cliente minimizzerà il gruppo nella futura
   vista clienti del piano (l'app non mostra ancora `dietPlan`).
5. **Rimozione definitiva dei campi peso.** `quantityState`, `netOfWaste` e
   `alternative` escono dal modello prodotto: i pesi sono sempre al netto
   degli scarti e a crudo. Compatibilità: le revisioni salvate prima con
   questi campi restano leggibili e validabili (il server li rivalida e li
   conserva nel round-trip), l'editor li ignora alla riapertura e il primo
   salvataggio li elimina (migrazione silenziosa in `createDietPlanItem`).
6. **Duplicazione giornata corretta.** La copia ha `dayId` nuovo (null →
   rigenerato al salvataggio), titolo « (copia)», deep copy di target, pasti,
   opzioni e gruppi, ed è inserita dopo l'originale entro il limite di 14
   giornate. Prima della fix la copia riusava il `dayId` e la validazione
   segnalava «identificativo duplicato».

## 3. Conseguenze

- `dietPlan` resta **schemaVersion 1**: l'evoluzione è additiva e tollerante,
  nessuna migrazione di dati lato server.
- La vista Dosi e il motore delle regole classiche non cambiano: il piano
  guidato resta descrittivo, senza calcoli clinici.
- L'anteprima ricetta dipende dal ricettario (`listProfessionalRecipes`):
  l'editor carica l'elenco all'apertura e gli archivi restano selezionabili
  per non perdere i riferimenti delle diete pubblicate.
- Il server non impone l'unicità del tipo pasto (tolleranza legacy): la
  vincola l'interfaccia.
