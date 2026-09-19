# ADR 0005 — Console Clienti unificata e tema in header

- **Stato**: accettata
- **Data**: 2026-09-13
- **Contesto**: Piano Nutrizionale, organizzazione singola `pianoNutrizionale`
- **Documenti collegati**: `docs/saas-data-contracts.md` (vista unificata), `docs/editor-strutture-dieta.md` (guida operativa), `docs/inviti-email.md`, `docs/saas-runbook.md`, ADR 0004

## 1. Perché questa decisione

La console aveva due viste sovrapposte («Clienti» e «Utenti») con elenchi,
inviti e rimozioni in posti diversi: il professionista non aveva un solo
posto per ogni persona seguita. Inoltre il tema scuro viveva solo nelle
Impostazioni dell'app (non raggiungibile in console).

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
   richiesta + azioni), struttura dieta (assegnazione), dati tecnici (sola
   lettura) e storico collegamenti (`getClientHistory`).
5. **Rimozione solo in scheda** («Rimuovi cliente» → dialog esplicativo →
   `removeClientLink`): revoca logica con audit, nessun elenco con azioni
   distruttive.
6. **Privacy invariata**: il nutrizionista vede solo i propri clienti;
   nessuna ricerca globale o enumerazione (solo username esatto per i flussi
   professionista/test). `listAuthorizedClients` restituisce clienti in ogni
   stato + inviti + richieste + cambi email, con un solo filtro per query e
   selezione in codice.

## 3. Correzione indici composti mancanti

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

## 5. Conseguenze

- Test di canarino sulla console (`admin-ui`, `console-clienti`,
  `profile-link-contract`, `app-ui-state`, `theme-toggle`, `settings-order`).
- La gestione delle strutture dieta, dei template equivalenze e del piano
  a blocchi è documentata in ADR 0008 e in `docs/editor-strutture-dieta.md`.
