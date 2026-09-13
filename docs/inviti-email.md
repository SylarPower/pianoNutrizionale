# Inviti con email reali — guida operativa

Riferimento: [ADR 0004](adr/0004-email-reali-inviti.md). Questa guida dice cosa
fare in pratica: come invitare un cliente reale, come convivono gli account
tecnici di test, cosa configurare per l'invio email e cosa fare quando qualcosa
non funziona.

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
  reale viene inviata a un indirizzo fittizio (il flusso legacy non invia mai
  email, mostra solo un link).

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

## 3. Configurazione dell'invio email

Verifica email e recupero password usano i **template di Firebase Auth**
(`sendEmailVerification`, `sendPasswordResetEmail`): non richiedono provider
esterni e restano dentro le quote gratuite per il volume atteso.

L'invio dell'**invito** è invece gestito da `functions/src/email-service.js`,
con tre modalità:

| Provider | Quando | Effetto |
| --- | --- | --- |
| *(nessuno)* | ambiente di prova, fornitore non ancora scelto | nessuna email: in console si usa **"Non inviare: mostra il link"** e si consegna il link a mano |
| `memory` | solo emulatori | nessun invio reale, il messaggio resta in memoria (test automatici) |
| `resend` | produzione | invio reale via API HTTP |

Variabili d'ambiente per l'invio reale (mai nel repository, mai in chiaro nei
file pubblicati):

```text
INVITE_EMAIL_PROVIDER=resend
INVITE_EMAIL_API_KEY=<chiave del provider>
INVITE_EMAIL_FROM=Studio Piano <inviti@tuodominio.it>
APP_PUBLIC_URL=https://sylarpower.github.io/pianoNutrizionale
# opzionali
INVITE_EMAIL_ENDPOINT=https://api.resend.com/emails
```

Queste variabili sono lette **a runtime** dalle funzioni che inviano gli inviti
(`inviteClientByEmail`, `resendClientInvite`, `correctClientInvite`): non basta
esportarle nella macchina che pubblica. Dove impostarle, in alternativa tra
loro:

1. **Console Google Cloud** (consigliato, senza terminale) → *Cloud Functions* →
   le tre funzioni `inviteclientbyemail`, `resendclientinvite`,
   `correctclientinvite` → *Modifica* → **Variabili di ambiente** → aggiungi le
   coppie chiave/valore → *Distribuisci*;
2. file locale `functions/.env.piano-nutrizionale` (ignorato da `.gitignore`) con
   le stesse righe, seguito da `firebase deploy --only functions`;
3. `firebase functions:secrets:set` **non** è sufficiente da solo: il codice legge
   le variabili d'ambiente, quindi i secret di Secret Manager andrebbero
   collegati alle funzioni dalla console.

I valori non vanno **mai** nel repository. Se il provider non è configurato, la
callable **non dichiara mai l'invio riuscito**: risponde `delivery-failed` con il
motivo e l'invito resta pendente, recuperabile con "Rinvio" o con "mostra il
link". L'adapter `memory` viene **rifiutato in produzione** con un messaggio
esplicito.

### Dominio mittente, SPF, DKIM, DMARC

Per consegnare le email senza finire nello spam serve un dominio controllato:

1. verifica il dominio nel pannello del provider e aggiungi i record DNS che
   propone (SPF `TXT`, DKIM `CNAME`/`TXT`);
2. pubblica una policy DMARC, prima in monitoraggio:
   `_dmarc.tuodominio.it  TXT  v=DMARC1; p=none; rua=mailto:dmarc@tuodominio.it`;
3. quando i report sono puliti, passa a `p=quarantine` e poi `p=reject`;
4. usa un mittente del dominio verificato (`inviti@tuodominio.it`) e un
   sottoindirizzo di risposta monitorato.

Verifica email e reset password possono invece usare il mittente predefinito di
Firebase Auth (o un mittente personalizzato da **Authentication → Templates**).

## 4. Flusso pratico: invitare un cliente reale

1. Console → **Utenti → Invita → Cliente con email reale**.
2. Inserisci **email, nome e cognome** (dati che il cliente vedrà precompilati e
   non modificabili), scegli il professionista destinatario e la consegna
   (`Invia l'email al cliente` oppure `Non inviare: mostra il link`).
3. La console risponde con uno degli stati possibili:

| Stato | Significato | Cosa fare |
| --- | --- | --- |
| `invited` | invito creato, email inviata (o link mostrato) | niente: attendi la registrazione |
| `delivery-failed` | invito creato ma **email non inviata** | "Rinvio" oppure "mostra il link" |
| `already-pending` | c'è già un invito richiesta in attesa | usa "Reinvia" o "Correggi" dalla card del cliente |
| `link-request-created` | l'account esiste già: richiesta da accettare in app | il cliente accetta o rifiuta dall'app |
| `already-linked-same` | il cliente è già collegato a te | niente |
| `already-linked-other` | account collegato a un altro professionista | niente: nessun dato dell'altro professionista viene mostrato |
| errore email non valida | indirizzo tecnico o formato errato | correggi l'indirizzo (o usa il modulo legacy per un test) |
| errore account disabilitato | account Auth disattivato | riabilita l'account in Firebase Auth prima di reinvitare |

4. Il cliente apre il link, vede **email, nome e cognome** inseriti da te, sceglie
   la password e crea l'account. Riceve poi l'email di verifica: **il
   collegamento si attiva quando l'indirizzo è verificato**.

### Correggere un invito pendente o scaduto

Dalla card del cliente (vista **Clienti**) o della riga in **Utenti**:

- **Reinvia** → nuovo token monouso; il link precedente smette di funzionare;
- **Correggi** → modifica email, nome, cognome o consegna: nasce un nuovo token e
  il vecchio viene marcato `superseded`;
- **Annulla** → l'invito passa a `revoked` e resta in storico con il motivo.

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
| la console mostra "Invito creato ma email NON inviata" | provider non configurato o errore del provider | controlla i secret, poi "Reinvia"; in alternativa "mostra il link" |
| il cliente dice "link scaduto" | sono passati più di 7 giorni | card cliente → "Reinvia" |
| "esiste già un account con questa email" | l'indirizzo è già registrato | il cliente accede; se serve il collegamento, usa l'invito come richiesta in app o "Password dimenticata?" |
| il cliente ha verificato ma non vede il profilo | collegamento non ancora attivo | nella card deve risultare "email verificata"; altrimenti reinvia la verifica |
| errore "account tecnici" nel modulo legacy | flag non attivo | usa il modulo con email reale, oppure imposta `LEGACY_TEST_INVITES_ENABLED=true` solo per i test |

## 8. Deploy delle modifiche

1. `npm test`, `npm --prefix functions test`, `npm run smoke`, `npm run syntax`.
2. Deploy di Functions e regole con il workflow GitHub *Deploy Firebase*
   (pulsante **Run workflow** → scegli *functions* o *functions,firestore:indexes,firestore:rules*).
3. Imposta le variabili d'ambiente del provider **prima** di provare l'invio
   (vedi §3) e fai un invito su un indirizzo tuo prima di usarlo con i clienti.
4. Non attivare il flag legacy in produzione se non per una prova concordata.
5. Quando modifichi JavaScript, CSS o HTML, incrementa `CACHE_VERSION` in
   `sw.js` (la versione attuale è **74**).
