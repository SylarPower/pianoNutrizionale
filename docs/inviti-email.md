# Inviti con email reali — guida operativa

Riferimento: [ADR 0004](adr/0004-email-reali-inviti.md). Questa guida dice cosa
fare in pratica: come invitare un cliente reale, come convivono gli account
tecnici di test, come si consegna il link e cosa fare quando qualcosa non
funziona.

> **Aggiornamento (2026-09-14): nessun invio automatico di email d'invito.**
> Il servizio di invio (`functions/src/email-service.js`) è stato eliminato:
> non esistono più provider, chiavi, variabili d'ambiente né stati di "invio
> fallito". Il backend costruisce solo il link e la console lo mostra con i
> pulsanti **Copia link** e **Condividi link**; il nutrizionista lo consegna a
> mano. Verifica dell'email e recupero password restano sui template gratuiti
> di Firebase Auth. Guida passo passo senza terminale:
> [`configurazione-manuale.md`](configurazione-manuale.md).

## 1. Due modelli, esplicitamente separati

| | Cliente reale (consigliato) | Account tecnico di test (legacy) |
| --- | --- | --- |
| Credenziale | **email reale** del cliente | username trasformato in `username@utenti.pianonutrizionale.app` |
| Chi sceglie la password | il cliente, dal link d'invito | il cliente (o chi prepara il test) |
| Verifica email | obbligatoria per attivare il collegamento | non prevista (indirizzo fittizio) |
| Recupero password | link "Password dimenticata?" | non applicabile |
| Dove si crea | console → **Invita → Cliente con email reale** | console → **Invita → Cliente con account di test (legacy)** |
| Link | `index.html#/invito/<token>` | `index.html#/invite/<token>` |
| Attivazione collegamento | dopo la verifica dell'email | al riscatto del link |
| A chi serve | clienti veri, anche durante la fase di prova | test automatici, demo, emulatori |

Regole non negoziabili:

- **mai** un indirizzo tecnico per un cliente reale: il backend lo rifiuta;
- **mai** convertire da solo un account tecnico in account reale: le due strade
  restano separate e la conversione non esiste;
- gli account tecnici **esistenti** continuano a funzionare: non si cancellano,
  non si migrano, non si obbligano al nuovo onboarding;
- i test automatici che usano email fittizie restano validi: nessuna email
  viene inviata a nessuno (né il flusso legacy né quello con email reale
  inviano email: entrambi mostrano un link da consegnare a mano).

## 2. Nuovi account tecnici: il flag esplicito

Il modulo legacy crea account con **email fittizia**. Per evitare che venga
usato per errore con clienti reali, la creazione di **nuovi** account tecnici è
consentita solo:

- negli emulatori (`FUNCTIONS_EMULATOR` o `FIRESTORE_EMULATOR_HOST` presenti), oppure
- con la variabile d'ambiente `LEGACY_TEST_INVITES_ENABLED=true` impostata sulla
  funzione.

In produzione, senza flag, `inviteClientLink` risponde:

```text
La creazione di nuovi account tecnici di test è disattivata: invita il cliente
con la sua email reale (modulo “Invita cliente con email”)
```

Gli account tecnici **già esistenti** non sono toccati dal flag: login, riscatto
di inviti già emessi e collegamento continuano a funzionare.

### Come preparare i test in locale

```bash
npm --prefix functions run seed:emulator     # admin-demo, nutri-demo, cliente-a, cliente-b
firebase emulators:start --only auth,firestore,functions
```

Utenti creati dal seed (email tecniche, password `Demo-sicura-2026`):
`admin-demo`, `nutri-demo`, `cliente-a`, `cliente-b`. Le guide e i test
automatici usano questi account: **non** usare un account tecnico per verificare
la verifica email o il recupero password reali (non hanno una casella).

## 3. Consegna del link: Copia link e Condividi link

Verifica email e recupero password usano i **template di Firebase Auth**
(`sendEmailVerification`, `sendPasswordResetEmail`): non richiedono provider
esterni e restano dentro le quote gratuite per il volume atteso.

L'**invito** non viene inviato dal sistema. Le callable `inviteClientByEmail`,
`resendClientInvite` e `correctClientInvite` restituiscono sempre `inviteUrl`
(`https://sylarpower.github.io/pianoNutrizionale/#/invito/<token>`, indirizzo
fisso nel codice) e la console apre la finestra **Link d'invito pronto** con:

| Pulsante | Cosa fa | Se non è disponibile |
| --- | --- | --- |
| **Copia link** | copia il solo URL negli appunti (`navigator.clipboard`, con fallback `execCommand('copy')`) | il campo resta selezionato: copia con Ctrl+C o tenendo premuto |
| **Condividi link** | apre la condivisione nativa (`navigator.share`) con un messaggio pronto: saluto, istruzioni, scadenza e link | apre WhatsApp Web con lo stesso messaggio (come la Lista della spesa dell'app) |

Il messaggio condiviso è:

```text
Ciao Mario, ti ho invitato a Piano Nutrizionale: apri questo link personale,
scegli la password e verifica la tua email. Il link scade il 21/09/2026.
https://sylarpower.github.io/pianoNutrizionale/#/invito/…
```

Regole:

- il link compare **una sola volta** per token: chiudendo la finestra sparisce
  dal documento e non viene più rimostrato (su Firestore c'è solo l'hash);
- **Nuovo link** e **Correggi dati** generano un token nuovo e riaprono la
  stessa finestra; il link precedente smette di funzionare;
- il documento dell'invito registra `delivery: { channel: 'manual-link',
  status: 'manual', handedToConsole: true }`: non esistono stati `sent` o
  `failed`;
- nessuna variabile d'ambiente, nessun secret e nessun dominio mittente da
  configurare. Le voci `INVITE_EMAIL_*` e `APP_PUBLIC_URL`, se ancora presenti
  in vecchie configurazioni, sono ignorate e si possono rimuovere.

## 4. Flusso pratico: invitare un cliente reale

1. Console → **Clienti → ＋ Invita nuovo cliente** (dialog con email reale).
2. Inserisci **email, nome e cognome** (dati che il cliente vedrà precompilati e
   non modificabili) e, se sei admin, il professionista destinatario. Non c'è
   nessuna scelta di consegna: premi **Crea invito**.
3. La console risponde con uno degli stati possibili:

| Stato | Significato | Cosa fare |
| --- | --- | --- |
| `invited` | invito creato: si apre la finestra con il link | consegna il link con **Copia link** o **Condividi link** |
| `already-pending` | c'è già un invito o una richiesta in attesa | usa "Nuovo link" o "Correggi dati" dalla card del cliente |
| `link-request-created` | l'account esiste già: richiesta da accettare in app | il cliente accetta o rifiuta dall'app |
| `already-linked-same` | il cliente è già collegato a te | niente |
| `already-linked-other` | account collegato a un altro professionista | niente: nessun dato dell'altro professionista viene mostrato |
| errore email non valida | indirizzo tecnico o formato errato | correggi l'indirizzo (o usa il modulo legacy per un test) |
| errore account disabilitato | account Auth disattivato | riabilita l'account in Firebase Auth prima di reinvitare |

4. Il cliente apre il link, vede **email, nome e cognome** inseriti da te, sceglie
   la password e crea l'account. Riceve poi l'email di verifica (Firebase
   Auth): **il collegamento si attiva quando l'indirizzo è verificato**.

### Correggere un invito pendente o scaduto

Dalla card o dalla scheda del cliente (vista **Clienti**):

- **Nuovo link** → nuovo token monouso mostrato nella finestra del link; il
  precedente smette di funzionare;
- **Correggi dati** → modifica email, nome o cognome: nasce un nuovo token
  (mostrato nella stessa finestra) e il vecchio viene marcato `superseded`;
- **Annulla invito** → l'invito passa a `revoked` e resta in storico con il motivo.

Non esistono mai due inviti pendenti attivi per lo stesso cliente.

### Stati di un invito

`pending` (in attesa) → `accepted` (registrato) / `expired` (scaduto) /
`superseded` (sostituito da una correzione o da un reinvio) / `revoked`
(annullato). Uno stato consumato non si riutilizza: per ripartire si crea un
nuovo invito.

## 5. Cliente già registrato: richiesta e cambio email

- **Account esistente senza collegamento**: il nutrizionista invita, il cliente
  riceve una richiesta con nome del professionista e organizzazione e risponde
  **Accetta/Rifiuta** dall'app (in console resta "In attesa"). Nessun secondo
  account, nessuna password reimpostata.
- **Associazione già attiva**: l'invito è bloccato, con messaggi distinti per
  "già collegato a te" e "collegato a un altro professionista".
- **Anagrafica**: il nutrizionista corregge nome e cognome dalla card del
  cliente (il cliente riceve una notifica). Il cliente modifica liberamente solo
  il **nome mostrato**.
- **Cambio email del cliente registrato**: due passi obbligatori.
  1. Console → **Proponi cambio email** (nuovo indirizzo + motivo).
  2. Il cliente conferma dall'app (Impostazioni → *Collegamento professionista*).
  Solo dopo la conferma l'email cambia in Firebase Auth, la verifica torna da
  fare e l'indirizzo precedente smette di funzionare. Fino a quel momento
  l'indirizzo attuale resta valido: nessuno può "prendere" l'account.

## 6. Sicurezza e privacy

- L'email è una credenziale: non è mai pubblica, non compare nelle risposte ad
  altre persone e non viene usata come ID Firestore (l'ID è sempre `clientId`).
- Ogni attore vede solo i propri clienti e i propri dati: i professionisti non
  vedono clienti o inviti altrui.
- Il token d'invito esiste **in chiaro una sola volta** (creazione, reinvio o
  correzione); su Firestore resta solo l'hash SHA-256.
- Nei log non finiscono token completi né password; gli indirizzi sono
  mascherati (`m***@esempio.it`).
- Password mai al nutrizionista, mai in Firestore, mai nei log e mai nelle
  email.
- Il recupero password dà sempre lo stesso messaggio: non si può capire se un
  indirizzo è registrato.
- Prima della verifica email non si accede a dati professionali: il
  collegamento (e quindi il profilo assegnato) esiste solo dopo la verifica.

## 7. Diagnostica rapida

| Sintomo | Causa probabile | Rimedio |
| --- | --- | --- |
| "campi non ammessi (delivery)" o "Backend della console non aggiornato" creando un invito | Functions online non ancora ripubblicate dopo questa modifica | GitHub → Actions → *Deploy Firebase (manuale)* → `functions,firestore:indexes,firestore:rules` |
| "Copia link" non copia | appunti bloccati dal browser | il campo è selezionato: Ctrl+C o pressione lunga |
| "Condividi link" apre WhatsApp Web | nessuna condivisione nativa sul dispositivo | comportamento previsto; in alternativa "Copia link" |
| il cliente dice "link scaduto" | sono passati più di 7 giorni | card cliente → "Nuovo link" |
| "esiste già un account con questa email" | l'indirizzo è già registrato | il cliente accede; se serve il collegamento, usa l'invito come richiesta in app o "Password dimenticata?" |
| il cliente ha verificato ma non vede il profilo | collegamento non ancora attivo | nella card deve risultare "email verificata"; altrimenti reinvia la verifica |
| errore "account tecnici" nel modulo legacy | flag non attivo | usa il modulo con email reale, oppure imposta `LEGACY_TEST_INVITES_ENABLED=true` solo per i test |

## 8. Deploy delle modifiche

1. `npm test`, `npm --prefix functions test`, `npm run smoke`, `npm run syntax`.
2. Deploy di Functions e regole con il workflow GitHub *Deploy Firebase
   (manuale)* (pulsante **Run workflow** → *functions,firestore:indexes,firestore:rules*).
   Passi senza terminale: [`configurazione-manuale.md`](configurazione-manuale.md).
3. Nessuna variabile d'ambiente da impostare per gli inviti. Prova un invito su
   un indirizzo tuo (Copia link / Condividi link) prima di usarlo con i clienti.
4. Non attivare il flag legacy in produzione se non per una prova concordata.
5. Quando modifichi JavaScript, CSS o HTML, incrementa `CACHE_VERSION` in
   `sw.js` (la versione attuale è **76**).
