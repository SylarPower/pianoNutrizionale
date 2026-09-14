# ADR 0004 — Inviti e autenticazione con email reali

- **Stato**: accettata (fase di building); **aggiornata il 2026-09-14** — consegna
  dell'invito solo manuale (Copia link / Condividi link), servizio email eliminato
- **Data**: 2026-09-13
- **Contesto**: Piano Nutrizionale, organizzazione singola `pianoNutrizionale`
- **Documenti collegati**: `docs/inviti-email.md` (guida operativa), `docs/saas-data-contracts.md`, `docs/saas-runbook.md`, `docs/ripartenza-firebase.md`, `docs/pulizia-dati-legacy.md`

## 1. Perché questa decisione

Fino a oggi i clienti entrano nell'app con un **username** trasformato lato client in
un'email tecnica (`username@utenti.pianonutrizionale.app`). Quel modello ha tre
problemi: il cliente non ha un'email vera con cui recuperare la password, le
email tecniche non sono indirizzi raggiungibili (nessuna verifica possibile) e la
console non distingue un account di prova da un cliente reale.

Il nuovo modello usa **l'email reale del cliente come credenziale** e lascia
nome e cognome come dati di profilo inseriti dal nutrizionista. Gli account
tecnici già esistenti restano **esattamente come sono**: servono ai test e a
nessun'altra cosa. Nessuna migrazione automatica, nessuna cancellazione.

## 2. Mappa dei flussi esistenti (prima della modifica)

| Flusso | Come funziona oggi | Dove sta nel codice |
| --- | --- | --- |
| Invito cliente (console) | il nutrizionista digita uno **username**; se l'account non esiste il backend genera un token da 64 hex, ne salva **solo l'hash** nel documento `organizations/{org}/invitations/{inviteId}` (campi `type: 'client'`, `targetUsername`, `expiresAt` a 7 giorni) e restituisce `{ status, clientId, inviteId, expiresAt, token }`; il token in chiaro esiste una sola volta. Idempotenza via `idempotencyKey`. | `functions/src/index.js` → `inviteClientLink` |
| Accettazione invito | il cliente apre `index.html#/invite/<64hex>`; il token viene messo in `sessionStorage` (`pn_pending_invite_token`); la registrazione crea l'account con l'email tecnica, crea la voce `usernames/{username}` e chiama `acceptOrganizationInvite`, che risolve l'invito con `collectionGroup('invitations')` su `tokenHash` + confronto `targetUsername`. | `js/app.js` → `setupInviteForm`, `functions/src/index.js` → `acceptOrganizationInvite` |
| Login cliente | username + password → email tecnica; nessuna verifica email, nessun recupero password. | `js/firebase.js` → `signInWithUsername`, `signUpWithUsername` |
| Consulenza/associazione | se l'account esiste già ma non è associato viene creata una richiesta (`clientLinkRequests`) che il cliente Accetta/Rifiuta in Impostazioni; "Scollegati" invia una richiesta di revoca. | `respondClientLink`, `listMyClientLinkRequests`, `requestClientUnlink`, `js/app.js` → `renderClientLinkSection` |
| Profilo cliente | anagrafica e associazione sono in mano al nutrizionista; il `displayName` cliente è stato rimosso (Sessione 1). | `updateClientProfileByStaff` |
| Console | stati `invited` / `already-invited` / `already-member`; il link mostrato è `index.html#/invite/<token>`. | `js/admin.js` → `submitClientInvite`, `inviteLinkForToken` |
| Account tecnici | utenti `admin-demo`, `nutri-demo`, `cliente-a`, `cliente-b` con password `Demo-sicura-2026` e email `@utenti.pianonutrizionale.app`; usati da seed e test. | `functions/scripts/seed-emulator.js`, test in `test/` e `functions/test/` |

Punti rilevanti trovati prima di modificare:

1. `firestore.rules` vincola `usernames/{username}` all'email tecnica: il nuovo
   flusso **non tocca quella directory** (i clienti reali non creano username),
   quindi le regole restano valide.
2. `test/invite-flow.test.js` blinda il modello legacy: va mantenuto e
   affiancato da test distinti per il flusso email.
3. Il modulo client `js/firebase.js` ha già due app separate (`default` e
   `admin-console`): la console continua a lavorare sull'app admin.

## 3. Nuovo flusso (dopo la modifica)

### 3.1 Invito di un cliente reale

1. Il nutrizionista apre "Invita un nuovo cliente" in console e inserisce
   **email reale, nome e cognome**. Non c'è alcuna scelta di consegna: al
   termine la console mostra il link con **Copia link** e **Condividi link** e
   il nutrizionista lo consegna a mano.
2. `inviteClientByEmail` valida e normalizza (trim, minuscole, formato, nome e
   cognome), verifica l'autorizzazione, quindi distingue:
   - account Auth inesistente + nessun profilo → crea/completa il profilo cliente
     (`status: 'pending'`) e l'invito monouso (`status: 'pending'`, token
     salvato **solo come hash**, scadenza 7 giorni, audit);
   - account Auth esistente senza associazione attiva → crea una richiesta di
     collegamento (`clientLinkRequests`, `channel: 'email'`) che il cliente
     accetta o rifiuta dall'app; nessuna email reale viene inviata a indirizzi
     tecnici;
   - associazione già attiva → risponde `already-linked-same` /
     `already-linked-other` senza duplicare nulla e senza rivelare dati di altri
     professionisti.
3. Stati restituiti alla console: `invited` (con `inviteUrl`),
   `already-pending`, `link-request-created`, `already-linked-same`,
   `already-linked-other`, oltre agli errori `invalid-argument` /
   `failed-precondition` (invito scaduto, account disabilitato). Lo stato
   `delivery-failed` non esiste più: non c'è alcun invio che possa fallire.

### 3.2 Riscatto da parte del cliente nuovo

1. Il cliente apre `index.html#/invito/<token>`: `getClientInvitePreview` (non
   autenticata, il token è il segreto) mostra **email, nome e cognome
   precompilati e non modificabili**, con il messaggio "Questi dati sono stati
   inseriti dal tuo nutrizionista".
2. Il cliente sceglie **solo la password** (con mostra/nascondi) e crea
   l'account: `createUserWithEmailAndPassword` con l'email reale (nessun
   username, nessuna email tecnica), poi `redeemClientInvite` con lo stesso
   token.
3. Il token viene consumato solo dopo il controllo di appartenenza, scadenza e
   stato; l'account tecnico non viene mai creato per un invito reale.
4. Il collegamento diventa **attivo** quando l'email è verificata
   (`email_verified`): prima di allora `redeemClientInvite` risponde
   `email-verification-required` e l'app mostra il banner di verifica.
5. Da qui in poi il cliente entra con email + password, verifica l'indirizzo,
   recupera la password e vede i contenuti condivisi.

### 3.3 Utente esistente, cambio email, correzioni

- **Richiesta di collegamento**: il cliente vede nome del nutrizionista e
  organizzazione, Accetta o Rifiuta; lo stato "In attesa" resta visibile in
  console.
- **Correzione di un invito pendente/scaduto** (`correctClientInvite`): il
  vecchio link diventa `superseded`, nasce un nuovo token e non esistono mai
  due inviti pendenti attivi per lo stesso cliente.
- **Reinvio** (`resendClientInvite`): nuovo token, vecchio link invalidato.
- **Annullamento** (`cancelClientInvite`): l'invito passa a `revoked` e resta in
  storico.
- **Modifica anagrafica** (`updateClientProfileByStaff`): nome e cognome con
  audit e notifica al cliente.
- **Modifica email di un cliente registrato**: due passi. Il nutrizionista
  propone (`proposeClientEmailChange`), il cliente conferma
  (`respondMyEmailChange`); solo la conferma aggiorna l'email in Firebase Auth
  (con nuova verifica). Vecchio indirizzo valido fino alla conferma: nessun
  takeover.
- **Cosa può modificare il cliente**: anagrafica e unlink sono gestiti dal nutrizionista/creatore; il `displayName` cliente non esiste più (Sessione 1).
  Email, nome e cognome li corregge il nutrizionista.

### 3.4 Recupero password e verifica email

- Verifica e reset usano i template di Firebase Auth
  (`sendEmailVerification`, `sendPasswordResetEmail`): nessun costo aggiuntivo
  ai volumi attesi (Spark: 1.000 verifica/giorno, 150 reset/giorno).
- Il reset non rivela se l'account esiste (messaggio uniforme) e non viene
  proposto per gli indirizzi tecnici legacy.
- **Attivazione dopo la verifica**: il riscatto non si ferma alla
  registrazione. A ogni accesso o ricarica dell'app, se l'account è un cliente
  con email reale, l'email risulta verificata e non c'è un collegamento
  attivo, il client rinnova a forza l'ID token (`getIdToken(true)`: il claim
  `email_verified` in cache può essere vecchio) e richiama
  `redeemClientInvite` **senza token**: il server ritrova l'invito pendente
  dall'email autenticata e risponde `link-active` oppure `no-pending-invite`.
  Il banner di verifica espone anche il pulsante "Ho verificato: attiva il
  collegamento" per chi ha appena confermato l'indirizzo. Il token dell'invito
  resta in sessione finché il riscatto non è `link-active`: solo allora viene
  cancellato.

## 4. Decisioni

1. **L'email reale è la credenziale**; nome e cognome sono dati di profilo;
   Il `displayName` cliente è stato rimosso; resta solo per i professionisti come fallback. Nessun nuovo username e nessuna nuova
   email tecnica per i clienti reali.
2. **Il collegamento si attiva dopo la verifica email** e non prima; per gli
   account tecnici legacy resta l'attivazione al riscatto (comportamento di
   test, non di produzione).
3. **Invito scaduto o annullato → nuovo invito**: i documenti restano come
   storico con `status` `expired` / `revoked` / `superseded`; mai due inviti
   pendenti attivi per lo stesso indirizzo.
4. **Revoca del collegamento → nuovo invito**: la stessa associazione si
   ricrea solo con una nuova conferma e un nuovo documento, mai riattivando il
   precedente.
5. **Correzione di un invito pendente → nuovo token**, vecchio link
   invalidato, audit completo.
6. **Cambio email del cliente registrato a due passi** (proposta + conferma),
   con nuova verifica e nessuna possibilità di takeover.
7. **Anagrafica di competenza del nutrizionista**; il cliente modifica solo il
   nome mostrato.
8. **Consegna dell'invito: solo manuale** (decisione aggiornata il
   2026-09-14). Il backend costruisce il link
   (`https://sylarpower.github.io/pianoNutrizionale/#/invito/<token>`, base
   fissa nel codice) e lo restituisce alla console, che lo mostra con
   **Copia link** (appunti) e **Condividi link** (condivisione nativa, fallback
   WhatsApp Web: gli stessi gesti della Lista della spesa). Il servizio
   `functions/src/email-service.js`, i provider, le chiavi, le variabili
   d'ambiente (`INVITE_EMAIL_*`, `APP_PUBLIC_URL`) e lo stato `delivery-failed`
   sono stati eliminati. Il payload delle callable non ha più il campo
   `delivery`. Verifica email e reset restano sui template Firebase Auth.
9. **Modello legacy esplicito e controllato**: la creazione di **nuovi**
   account tecnici è consentita solo con `LEGACY_TEST_INVITES_ENABLED=true` o
   negli emulatori; in produzione senza flag l'invito legacy viene rifiutato
   con messaggio che indirizza al flusso email. Gli account tecnici esistenti
   continuano a funzionare senza modifiche.
10. **Nessuna conversione automatica**: un account con email fittizia non
    diventa mai un account reale, e un invito reale non diventa mai un invito
    tecnico.

## 5. Conseguenze

- Nuove callable: `inviteClientByEmail`, `getClientInvitePreview`,
  `redeemClientInvite`, `correctClientInvite`, `resendClientInvite`,
  `cancelClientInvite`, `updateClientProfileByStaff`,
  `proposeClientEmailChange`, `respondMyEmailChange`.
- Nuovo percorso di invito `#/invito/<token>`; il legacy `#/invite/<64hex>`
  resta attivo per gli account tecnici.
- Nuovi campi profilo cliente: `email`, `emailNormalized`, `emailVerified`,
  `firstName`, `lastName` (oltre a `authUid`, `status`; `displayName` rimosso per i clienti, resta solo per i membri come fallback).
- L'invito dei **professionisti** resta sul flusso attuale (username +
  `inviteOrganizationUser`): è un debito tecnico documentato, non oggetto di
  questa modifica.
- La guida operativa (consegna del link, diagnostica) è in
  `docs/inviti-email.md`; i passi manuali senza terminale (solo il deploy delle
  Functions da GitHub) in `docs/configurazione-manuale.md`.
