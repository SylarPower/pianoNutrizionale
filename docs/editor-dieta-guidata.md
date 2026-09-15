# Editor dieta guidata — guida operativa

L'editor guidato crea diete **descrittive** (come un piano stampato):
giornate, pasti, opzioni A/B/C/D, quantità con unità di misura e alimenti
scelti dal catalogo condiviso. Non richiede la ricopiatura della tabella:
comincia a digitare il nome e seleziona l'alimento suggerito. Contratto dati:
`docs/saas-data-contracts.md` (dietPlan v1); decisioni:
`docs/adr/0005-console-unificata-dieta-guidata.md`.

## Quando usare quale editor

| Caso | Editor | Note |
|---|---|---|
| Dieta descrittiva da leggere/stampare | Guidata («＋ Nuova dieta guidata») | revisioni schema 3, badge «Dieta guidata» |
| Famiglie e dosi per il calcolo automatico | Classica, disponibile solo per modificare strutture già esistenti | revisioni schema 2, come prima |
| Struttura esistente con badge «Dieta guidata» | Guidata (si apre da sola in modifica) | conserva le regole classiche |
| Struttura esistente senza badge | Classica | conserva l'eventuale piano guidato |

## Passo passo

1. **Nome dieta** (almeno 3 caratteri).
2. **Giornate**: tipo (allenamento, riposo, altra) e titolo facoltativo.
   Si possono aggiungere (max 14), duplicare (la copia ha titolo «(copia)» e
   identità nuova), riordinare (↑ ↓) ed eliminare. Non sono richiesti campi
   energetici manuali.
3. **Pasti in ordine fisso** (max 10 per giornata, un solo pasto per tipo):
   colazione → spuntino di metà mattina → pranzo → merenda → cena → spuntino
   serale. «＋ Aggiungi pasto» propone solo i tipi ancora assenti; i pasti non
   si riordinano e non si duplicano: l'ordine è quello del modello. Orario e
   nota facoltativi. All'apertura dell'editor i pasti partono **minimizzati**
   (intestazione + riepilogo compatto); si espandono cliccando
   sull'intestazione. Un pasto con dati incompleti si espande automaticamente
   al salvataggio se la validazione segnala un errore al suo interno.
4. **Opzioni A/B/C/D** (max 4 per pasto): alternative equivalenti dello
   stesso pasto, di due tipi **mutuamente esclusivi**:
   - **Alimenti dal catalogo**: comincia a digitare il nome e scegli tra i
     suggerimenti di ricerca testuale (nessun elenco a categorie); la
     categoria viene dedotta in automatico dal catalogo e viaggia nascosta.
     Completa quantità + unità (g, kg, ml, l, pz, fette,
     cucchiai, cucchiaini, tazze, bicchieri, porzioni, scatolette, misurini,
     q.b.), max 20 voci;
   - **Ricetta**: una ricetta del ricettario professionale, con anteprima
     degli ingredienti scalata live (le dosi testuali come «80 g» si
     moltiplicano; «q.b.» resta tale). Il moltiplicatore porzioni non è più
     un campo della console: il valore salvato resta conservato per
     round-trip e la logica del moltiplicatore vive nell'app clienti
     (profilo coppia, vedi sotto).
   Si possono aggiungere, duplicare ed eliminare (ne resta sempre almeno una).
5. **Pesi sempre al netto degli scarti e a crudo**: non esistono più il
   select crudo/cotto, il flag «al netto degli scarti» né l'alternativa
   «oppure». Le diete salvate prima di questa evoluzione si aprono lo stesso:
   i campi vecchi vengono ignorati e scompaiono al primo salvataggio.
6. **Gruppi scelta** («Scegli 1 tra:», max 3 per opzione, solo opzioni
   alimenti liberi): titolo + alternative a dose editabile (descrizione,
   quantità, unità) che il cliente può scegliere. La scelta è facoltativa di
   default (il cliente può saltare il gruppo). Il gruppo si mostra
   **minimizzato** (solo riepilogo) quando è completo e si espande con
   «Modifica»; «Precompila alternative» riempie il gruppo dalla **tabella
   grammature scelta** nell'intestazione dell'editor (carboidrati o proteine)
   con le dosi del pasto corrente (pranzo: colonna A/R della giornata; cena:
   dose serale) e lo minimizza subito. Se la tabella scelta non ha una dose
   per quel pasto/giorno, si ripiega sulla tabella guida integrata. Le
   alternative restano tutte editabili dopo il precompilamento.
7. **Integrazione, idratazione, nota** per giornata + **note generali**.
8. **Anteprima**: «Mostra anteprima» riepiloga la bozza (conteggi + testo,
   ricette con dosi scalate, gruppi scelta in una riga); resta aggiornata
   mentre si digita e segnala i problemi in italiano.
9. **Pubblica dieta**: valida tutto e pubblica una nuova revisione. Le
   revisioni precedenti restano intatte e ripristinabili.

Le operazioni strutturali (aggiungi, duplica, sposta, elimina) rileggono
sempre il modulo prima di ridisegnarlo: **il testo digitato non si perde**.

## Tabelle grammature

Ogni nutrizionista ha le proprie **tabelle grammature** (raccolte personali
di alternative carboidrati/proteine con dosi pranzo/cena per giorno di
allenamento e di riposo). Voce di menu a sinistra «Tabelle grammature»:
crea, modifica, duplica ed elimina le proprie tabelle; quelle degli altri
membri sono visibili in elenco ma non modificabili.

- **Righe**: descrizione alimento, gruppo (carboidrati/proteine), categoria
  catalogo facoltativa (dedotta dal suggerimento) e dosi in grammi per
  pranzo A/R e cena A/R. Almeno una dose per riga; le dosi mancanti restano
  vuote.
- **Tabella di esempio**: il profilo demo del nutrizionista viene popolato
  con la tabella guida di riferimento. Per (ri)caricarla si usa lo script
  `functions/scripts/seed-grammature-tables.js` (istruzioni nell'intestazione
  dello script, richieste credenziali Admin di produzione); non è
  un'operazione della console.
- **Scelta in compilazione**: nell'intestazione dell'editor della dieta
  guidata si seleziona la tabella da cui attingere («Tabella guida
  integrata» è sempre disponibile). La precompilazione dei gruppi scelta usa
  la tabella selezionata e ripiega sulla guida quando una dose manca.

### Moltiplicatore porzioni (solo app clienti)

Il moltiplicatore porzioni **non è più un campo della console**: nell'app
clienti, quando è attivo il profilo «Coppia · uomo + donna», compare un
controllo ×0,5–×3 (passo 0,5) che scala in tempo reale le dosi uomo/donna
mostrate (settimana, modali e batch cooking) e i totali della lista della
spesa. La preferenza è salvata nelle impostazioni locali del dispositivo e
vale solo per il profilo coppia.

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
| «Seleziona la ricetta» | opzione di tipo Ricetta senza ricetta scelta |
| «Moltiplicatore ricetta non valido» | valore fuori da ×0,1–×10 |
| «Dai un titolo al gruppo» | gruppo scelta senza titolo |
| «da 1 a 30 alternative» | gruppo scelta senza alternative |
| «opzione X duplicata» | due opzioni con la stessa etichetta (l'editor le assegna da solo: ricarica la bozza) |
| «quantità non valida» | numero negativo, non numerico o oltre 5000 |
| «unità di misura non valida» | unità fuori elenco |
| «Backend della console non aggiornato» | ripubblicare le Cloud Functions |

## Vista Clienti unificata (promemoria)

- Filtri Tutti/Attivi/In attesa/Inattivi con conteggi; titolo sempre Nome
  e Cognome.
- «Invita nuovo cliente» apre il dialog con email reale, nome e cognome;
  il link viene consegnato manualmente e i dati compaiono già compilati al
  cliente.
- La scheda si apre con «Apri scheda →»: nome ed email sono nell'intestazione,
  poi seguono collegamento, struttura dieta e attività. Le informazioni interne
  restano riservate all'admin; «Rimuovi cliente» esiste solo lì.
