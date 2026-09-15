# Inviti con email reali — guida operativa

In produzione esiste un solo percorso per invitare un cliente: email reale,
nome e cognome inseriti nella console, link monouso consegnato dal
professionista.

> **Nessun invio automatico di email d'invito.** Il backend costruisce il link
e la console lo mostra con **Copia link** e **Condividi link**. Il
professionista lo consegna a mano; verifica dell'email e recupero password
restano sui template gratuiti di Firebase Auth.

## 1. Flusso cliente

1. In **Clienti** scegli **Invita nuovo cliente**.
2. Inserisci email reale, nome e cognome. Non usare indirizzi tecnici o
   identificativi al posto dell'email.
3. Crea l'invito e consegna il link dalla finestra **Link d'invito pronto**.
4. Il cliente apre `index.html#/invito/<token>`: email, nome e cognome sono
   mostrati già compilati e non modificabili.
5. Il cliente sceglie la password e verifica l'indirizzo. Solo dopo la
   verifica il collegamento con il professionista diventa attivo.

Se esiste già un account per quell'indirizzo, la console mostra una richiesta
che il cliente può accettare o rifiutare dall'app. Un invito pendente può essere
rinnovato o corretto dalla scheda cliente; il link precedente viene invalidato.

Regole operative:

- mai un indirizzo tecnico per un cliente reale;
- mai password o token nei moduli, nei log o nei documenti Firestore;
- il link è monouso, ha scadenza e va consegnato solo alla persona indicata;
- non esiste un modulo pubblico per creare account cliente di prova.

## 2. Configurazione Firebase

Verifica che Firebase Authentication abbia attivo **Email/Password**. Non
servono provider email aggiuntivi, chiavi o variabili `INVITE_EMAIL_*` /
`APP_PUBLIC_URL`: il link viene copiato o condiviso dalla console e la mail di
verifica viene gestita da Firebase Auth.

Gli account e i dati già presenti in ambienti di sviluppo vengono gestiti
soltanto dagli strumenti interni di migrazione e dai test automatici; non sono
un percorso della piattaforma live e non devono essere mostrati ai clienti o
al professionista.

## 2-bis. Recupero password e cambio email

- **Password dimenticata?** mostra un messaggio uniforme e invia il link solo
  tramite Firebase Auth.
- Il cambio email viene proposto dalla scheda cliente, confermato dal cliente
  nell'app e seguito da una nuova verifica.
- Nessun dato tecnico o identificativo è richiesto al nutrizionista per
  completare l'invito.

---

## 3. Flusso pratico: invitare un cliente reale

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
| errore email non valida | indirizzo tecnico o formato errato | correggi l'indirizzo e riprova |
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

## 4. Cliente già registrato: richiesta e cambio email

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

## 5. Sicurezza e privacy

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

## 6. Diagnostica rapida

| Sintomo | Causa probabile | Rimedio |
| --- | --- | --- |
| "campi non ammessi (delivery)" o "Backend della console non aggiornato" creando un invito | Functions online non ancora ripubblicate dopo questa modifica | GitHub → Actions → *Deploy Firebase (manuale)* → `functions,firestore:indexes,firestore:rules` |
| "Copia link" non copia | appunti bloccati dal browser | il campo è selezionato: Ctrl+C o pressione lunga |
| "Condividi link" apre WhatsApp Web | nessuna condivisione nativa sul dispositivo | comportamento previsto; in alternativa "Copia link" |
| il cliente dice "link scaduto" | sono passati più di 7 giorni | card cliente → "Nuovo link" |
| "esiste già un account con questa email" | l'indirizzo è già registrato | il cliente accede; se serve il collegamento, usa l'invito come richiesta in app o "Password dimenticata?" |
| il cliente ha verificato ma non vede il profilo | collegamento non ancora attivo | nella card deve risultare "email verificata"; altrimenti reinvia la verifica |

## 7. Deploy delle modifiche

1. `npm test`, `npm --prefix functions test`, `npm run smoke`, `npm run syntax`.
2. Deploy di Functions e regole con il workflow GitHub *Deploy Firebase
   (manuale)* (pulsante **Run workflow** → *functions,firestore:indexes,firestore:rules*).
   Passi senza terminale: [`configurazione-manuale.md`](configurazione-manuale.md).
3. Nessuna variabile d'ambiente da impostare per gli inviti. Prova un invito su
   un indirizzo tuo (Copia link / Condividi link) prima di usarlo con i clienti.
4. Quando modifichi JavaScript, CSS o HTML, incrementa `CACHE_VERSION` in
   `sw.js` (la versione attuale è **87**).
