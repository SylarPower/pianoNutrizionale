# Editor dieta guidata — guida operativa

L'editor guidato crea diete **descrittive** (come un piano stampato):
giornate, pasti, opzioni A/B/C/D, quantità con unità di misura. Non calcola
nulla: i valori energetici della giornata sono appunti manuali del
professionista. Contratto dati: `docs/saas-data-contracts.md` (dietPlan v1);
decisioni: `docs/adr/0005-console-unificata-dieta-guidata.md`.

## Quando usare quale editor

| Caso | Editor | Note |
|---|---|---|
| Dieta descrittiva da leggere/stampare | Guidata («＋ Nuova dieta guidata») | revisioni schema 3, badge «Dieta guidata» |
| Famiglie e dosi per il calcolo automatico | Classica («＋ Nuova struttura classica») | revisioni schema 2, come prima |
| Struttura esistente con badge «Dieta guidata» | Guidata (si apre da sola in modifica) | conserva le regole classiche |
| Struttura esistente senza badge | Classica | conserva l'eventuale piano guidato |

## Passo passo

1. **Nome dieta** (almeno 3 caratteri).
2. **Giornate**: tipo (allenamento, riposo, altra), titolo facoltativo,
   valori facoltativi (kcal, proteine, carboidrati, grassi, acqua in ml).
   Si possono aggiungere (max 14), duplicare, riordinare (↑ ↓) ed eliminare.
3. **Pasti** (max 10 per giornata): tipo (colazione, spuntini, pranzo,
   merenda, cena), orario facoltativo, nota facoltativa.
4. **Opzioni A/B/C/D** (max 4 per pasto): alternative equivalenti dello
   stesso pasto. Si possono aggiungere, duplicare ed eliminare (ne resta
   sempre almeno una).
5. **Alimenti** (max 20 per opzione): gruppo alimentare, descrizione,
   quantità + unità (g, kg, ml, l, pz, fette, cucchiai, cucchiaini, tazze,
   bicchieri, porzioni, scatolette, misurini, q.b.), peso a crudo o a cotto,
   flag «al netto degli scarti», alternativa «oppure» facoltativa.
6. **Integrazione, idratazione, nota** per giornata + **note generali**.
7. **Anteprima**: «Mostra anteprima» riepiloga la bozza (conteggi + testo);
   resta aggiornata mentre si digita e segnala i problemi in italiano.
8. **Pubblica dieta**: valida tutto e pubblica una nuova revisione. Le
   revisioni precedenti restano intatte e ripristinabili.

Le operazioni strutturali (aggiungi, duplica, sposta, elimina) rileggono
sempre il modulo prima di ridisegnarlo: **il testo digitato non si perde**.

## Regole di compatibilità

- Salvare con l'editor classico una struttura guidata **conserva** il piano
  (lo dice una nota nel dialog); vale il viceversa per le regole classiche.
- Le strutture solo-guidate non hanno famiglie di dosi: nella vista Dosi si
  personalizzano solo le frequenze; il cliente vede le dosi originali.
- Il confronto strutture confronta famiglie e gruppi (non il piano
  descrittivo): per le solo-guidate mostra «—».
- L'app dei clienti non mostra ancora il piano guidato: è lavoro futuro.

## Errori frequenti

| Messaggio | Causa |
|---|---|
| «Descrivi l’alimento» | voce senza descrizione |
| «opzione X duplicata» | due opzioni con la stessa etichetta (l'editor le assegna da solo: ricarica la bozza) |
| «quantità non valida» | numero negativo, non numerico o oltre 5000 |
| «unità di misura non valida» | unità fuori elenco |
| «Backend della console non aggiornato» | ripubblicare le Cloud Functions |

## Vista Clienti unificata (promemoria)

- Filtri Tutti/Attivi/In attesa/Inattivi con conteggi; titolo sempre Nome
  e Cognome.
- «Invita nuovo cliente» apre il dialog con email reale (l'unico invito per
  i clienti veri); gli account di test legacy restano nel pannello
  richiuso in fondo.
- La scheda si apre con «Apri scheda →» e contiene anagrafica, collegamento,
  struttura dieta, dati tecnici e storico. «Rimuovi cliente» esiste solo lì.
