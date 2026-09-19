# ADR 0005 — Console Clienti unificata, tema in header e dieta guidata

- **Stato**: accettata in parte — la console Clienti unificata resta valida;
  dietPlan v1, revisioni schema 3 e vista Dosi sono superati da ADR 0008
- **Data**: 2026-09-13
- **Contesto**: Piano Nutrizionale, organizzazione singola `pianoNutrizionale`
- **Documenti collegati**: `docs/saas-data-contracts.md` (vista unificata,
  dietPlan v1), `docs/editor-dieta-guidata.md` (guida operativa),
  `docs/inviti-email.md`, `docs/saas-runbook.md`, ADR 0003, ADR 0004

## 1. Perché questa decisione

La console aveva due viste sovrapposte («Clienti» e «Utenti») con elenchi,
inviti e rimozioni in posti diversi: il professionista non aveva un solo
posto per ogni persona seguita. Inoltre la creazione delle diete richiedeva
l'editor tecnico a famiglie/dosi anche per piani descrittivi semplici, e il
tema scuro viveva solo nelle Impostazioni dell'app (non raggiungibile in
console).

Il riferimento funzionale per l'editor è il piano di esempio del brief
(giornate di allenamento/riposo/«altro», valori nutrizionali, pasti con
opzioni A/B, gruppi alimentari, alternative «oppure», quantità con unità e
peso crudo/cotto/netto scarti, note, integrazione, idratazione, anteprima):
il PDF citato non era allegato alla sessione di lavoro, quindi il modello è
stato derivato dall'esempio testuale del brief, senza upload, parsing o
lettura automatica di alcun documento.

## 2. Vista Clienti unificata

1. **Un'unica area «Clienti»**: la vista «Utenti» è eliminata. Team dello
   studio (admin/creatore), richieste di collegamento e invito legacy
   (richiuso in un pannello, solo test) sono ricollocati dentro Clienti;
   l'invito con email reale è un dialog dedicato («Invita nuovo cliente»).
2. **Stati operativi** calcolati nel dominio condiviso (`js/domain.js`):
   `active` (Attivo), `pending` (In attesa), `inactive` (Inattivo). Filtri con
   conteggi; lo storico (`rejected`, `revoked`, `expired`, `superseded`,
   `accepted`) vive solo nella scheda.
3. **Titolo sempre «Nome Cognome»** (`clientDisplayTitle`): fallback
   email mascherata → displayCode. Mai UID/ID tecnici nel
   titolo; lo username resta solo info secondaria per i test legacy.
4. **Scheda cliente** con anagrafica (server-side), collegamento (invito +
   richiesta + azioni), struttura dieta (assegnazione + salto alle dosi),
   dati tecnici (sola lettura) e storico collegamenti (`getClientHistory`).
5. **Rimozione solo in scheda** («Rimuovi cliente» → dialog esplicativo →
   `removeClientLink`): revoca logica con audit, nessun elenco con azioni
   distruttive.
6. **Privacy invariata**: il nutrizionista vede solo i propri clienti;
   nessuna ricerca globale o enumerazione (solo username esatto per i flussi
   professionista/test). `listAuthorizedClients` restituisce clienti in ogni
   stato + inviti + richieste + cambi email, con un solo filtro per query e
   selezione in codice (ADR 0003).

## 3. Correzione indici composti mancanti (bug necessario)

Alcune query combinavano due `where` senza indice composto dichiarato in
`firestore.indexes.json` (inviti/richieste per email+stato o clientId+stato,
cambi email per uid+stato): in produzione avrebbero risposto
`failed-precondition`, mentre l'emulatore non le blocca. Sono state
convertite a singolo filtro + selezione in codice, senza cambi di
comportamento e senza nuovi indici. Dettaglio nel runbook.

## 4. Tema scuro in header

Un solo controllo del tema nell'intestazione, in app (`renderGlobalHeader`)
e in console (topbar): bottone nativo con icone sole/luna, etichetta
localizzata, `aria-pressed`, persistenza su dispositivo
(`pn_theme` / `pn_admin_theme`, la console rispetta anche
`prefers-color-scheme` al primo avvio) e nessuna animazione propria
(sicuro con `prefers-reduced-motion`). Il duplicato «Tema scuro» è rimosso
dalle Impostazioni; la console ha un tema scuro dedicato in `css/admin.css`.

## 5. Dieta guidata (dietPlan v1)

1. **Modello descrittivo, non clinico**: `dietPlan` opzionale della revisione
   struttura (giornate `training|rest|other`, target energetici come appunti
   manuali, pasti, opzioni A–D, voci con gruppo/unità/crudo-cotto/netto
   scarti/alternativa «oppure», note, integrazione, idratazione). Nessun
   calcolo automatico, nessuna derivazione di macro o dosi.
2. **Versionamento**: revisioni schema 3 con checksum su
   `{schemaVersion: 3, rules, alternativeGroups, dietPlan}`; le revisioni 1/2
   restano verificabili e modificabili. `rules: []` ammesso solo con piano
   valido; il flag `hasDietPlan` guida badge e routing degli editor.
3. **Compatibilità editor**: l'editor classico conserva il piano guidato al
   salvataggio (e lo dichiara); l'editor guidato conserva le regole
   classiche. Confronto e assegnazioni invariati; le strutture solo-guidate
   personalizzano solo le frequenze nella vista Dosi.
4. **Client invariato**: l'app dei clienti ignora i campi nuovi
   (`compatibleClientSchema: 6`); la lettura del piano guidato in app è
   lavoro futuro e documentato come tale.

## 6. Conseguenze

- Test aggiornati al nuovo contratto (`admin-ui`, `profile-link-contract`,
  `app-ui-state` come canari) + nuovi (`console-clienti`, `theme-toggle`,
  `diet-plan` client e server).
- `CACHE_VERSION` incrementata (console + CSS/JS toccati).
- Nessuna migrazione dati: `hasDietPlan` assente = false, `dietPlan` assente
  = struttura classica, nessun rewrite storico.
