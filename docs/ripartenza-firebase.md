# Ripartenza pulita su Firebase — la struttura nuova, passo passo

Questa guida serve a **costruire la struttura nuova** e a riportare online gli
account che vuoi tenere:

| Profilo | Ruolo | Cosa diventa |
|---|---|---|
| Account amministrativo | platform admin | entra nella console `admin.html` con i poteri di gestione |
| Account professionale | nutrizionista | entra nella console e segue i clienti assegnati |
| Clienti reali | cliente | vengono invitati dalla console con email, nome e cognome |

È il **complemento** dell'altra guida: qui si costruisce, in
[pulizia-dati-legacy.md](pulizia-dati-legacy.md) si cancella. L'ordine giusto è:

1. **prima** questa guida (Passi 1-6): se cancelli per primo, gli account
   restano senza appartenenza;
2. **poi** la pulizia (organizzazioni vecchie tipo `prova`, `globalRuleSets`);
3. **infine** la verifica (Passo 8).

Tutti i passaggi si fanno **con il mouse**, senza terminale. Nessuna credenziale
va scritta in questa repo.

## Perché esiste ancora `organizations`, se l'organizzazione è una sola?

Perché è il **contenitore** di tutto il lavoro professionale, non un'etichetta:

```text
organizations/pianoNutrizionale/members/{uid}        chi può usare la console
organizations/pianoNutrizionale/clients/{clientId}   i profili seguiti + assegnazioni
organizations/pianoNutrizionale/dietStructures/...   le strutture dieta
organizations/pianoNutrizionale/invitations|clientLinkRequests|...
organizations/pianoNutrizionale/auditLog             chi ha fatto cosa
```

Le regole di sicurezza (`firestore.rules`), le indici e tutte le Cloud Functions
sono scritte per leggere e scrivere **dentro** quel percorso: la console non ha
diritto di scrittura diretta sui dati professionali (passa solo dalle Functions)
e il client non vede nulla se non il proprio profilo. Togliere il livello
`organizations` significherebbe riscrivere regole, indici e una ventina di
callable, senza alcun vantaggio pratico: il costo è alto, il beneficio zero.

C'è però un **guadagno reale** a tenerlo: il giorno in cui servisse un secondo
studio, basterebbe creare una seconda `organizations/...` e le stesse regole
isolerebbero i dati automaticamente (oggi le Functions accettano un solo id:
`'pianoNutrizionale'`, quindi qualunque altro valore viene rifiutato).

Nota sul cambio di nome: nella versione precedente l'organizzazione si chiamava
«piano». Ora è **`pianoNutrizionale`** in tutto il codice (`functions/src/domain.js`,
`js/domain.js`, `js/saas-config.js`, `firestore.rules`, script e documenti).
Il documento creato prima con id «piano» è quindi **un'organizzazione vecchia**:
alla fine, al Passo 9, puoi cancellarlo come `prova`.

---

## Passo 1 — Il paracadute (5 minuti)

Segui **Passo 1 di [pulizia-dati-legacy.md](pulizia-dati-legacy.md)**: attiva la
**point-in-time recovery** su Firestore (7 giorni). È l'"annulla" che useremo se
qualcosa non torna. Puoi farlo anche adesso: non crea né tocca dati.

---

## Passo 2 — Deploy allineato (una volta)

La console e le callable girano su Cloud Functions + regole + indici: finché
questi non sono aggiornati, i passi successivi possono fallire con errori di
permesso.

- Regole e indici: segui
  [deploy-online-senza-terminale.md](deploy-online-senza-terminale.md) (per le
  sole regole la modalità "manuale" è sufficiente: incolla il contenuto di
  `firestore.rules` nell'editor della console Firebase).
- Functions: stesso documento, sezione del workflow GitHub. Senza le Functions
  aggiornate, la console mostra "Servizi della console non disponibili".

---

## Passo 3 — L'organizzazione `pianoNutrizionale`

Tutta la piattaforma professionale usa **una sola** organizzazione, chiamata
`pianoNutrizionale`: le Functions rifiutano qualsiasi altro id.

1. Firebase Console → **Firestore Database** → scheda **Dati**.
2. Apri la collezione `organizations`.
3. Guarda se esiste il documento **`pianoNutrizionale`**:
   - **esiste** → apri il documento e assicurati che `status` sia `active`;
   - **non esiste** → **Aggiungi documento**, ID documento: `pianoNutrizionale`,
     poi aggiungi questi campi e salva:

   | Campo | Tipo | Valore |
   |---|---|---|
   | `schemaVersion` | number | `1` |
   | `name` | string | `Piano Nutrizionale` |
   | `status` | string | `active` |
   | `createdAt` | timestamp | adesso |
   | `updatedAt` | timestamp | adesso |

> `organizations/prova` (o qualunque altra) si cancella **dopo**, al passo di
> pulizia: serve ancora per copiare l'appartenenza del nutrizionista (Passo 5).

---

## Passo 4 — Il creatore (`admin`)

Solo il **creatore** vede il pulsante per invitare professionisti, la sezione
**Catalogo** e può ascoltare tutti i clienti.

1. Firebase Console → **Authentication** → **Utenti**: trova la riga
   dell'account `admin` e copia la colonna **UID**.
2. Torna su Firestore → collezione `platformMembers`.
3. Apri (o crea) il documento con ID **esattamente uguale a quell'UID** e
   imposta:

   | Campo | Tipo | Valore |
   |---|---|---|
   | `schemaVersion` | number | `1` |
   | `role` | string | `admin` |
   | `status` | string | `active` |
   | `username` | string | `admin` (facoltativo) |

Se il documento esiste già, controlla solo che `role` sia `admin` e `status`
sia `active`.

---

## Passo 5 — Il nutrizionista

Scegli **uno** dei due modi.

**Modo A — dalla console (consigliato).**

1. Apri `admin.html` e accedi con `admin`.
2. Menu **Utenti** → scheda **Professionista** → username: `nutrizionista` →
   **Invita professionista**.
3. Se l'account esiste (è il tuo caso), la membership viene creata subito in
   `organizations/pianoNutrizionale/members/{uid}`.

**Modo B — a mano, se la console non è ancora pronta.**

1. Firebase Console → Firestore → `organizations` → `pianoNutrizionale` → `members`.
2. **Aggiungi documento** con ID = UID dell'account `nutrizionista` (lo trovi in
   Authentication come al Passo 4) e questi campi:

   | Campo | Tipo | Valore |
   |---|---|---|
   | `schemaVersion` | number | `1` |
   | `role` | string | `nutritionist` |
   | `status` | string | `active` |
   | `username` | string | `nutrizionista` |
   | `createdAt` / `updatedAt` | timestamp | adesso |

> Se hai già eseguito in passato `functions/scripts/migrate-to-single-org.js`,
> questo passo può essere già stato fatto: apri `organizations/pianoNutrizionale/members` e
> verifica che i due documenti (`admin`, `nutrizionista`) ci siano con
> `status: active`.

---

## Passo 6 — Il catalogo alimenti (obbligatorio)

Senza catalogo la console **non riesce a salvare le Strutture dieta**: il
salvataggio viene rifiutato perché gli alimenti non esistono in catalogo.

### 6a. Scarica il file pronto

1. Su GitHub apri `docs/catalogo-import.json`.
2. Clicca **Raw** (in alto a destra nel riquadro del file).
3. Salva la pagina sul computer con nome `catalogo-import.json`
   (Ctrl+S / Cmd+S, formato "solo testo").

Il file contiene 75 ingredienti e 6 categorie, con gli id del motore Guide. Per
rigenerarlo identico in futuro c'è
`node functions/scripts/generate-catalog-import.js` (con `--check` per la sola
verifica).

### 6b. Abilita l'import (senza terminale)

L'import in scrittura è protetto da un interruttore server-side. Si accende dal
browser:

1. Firebase Console → Firestore → collezione `globalIngredientCatalog` →
   documento `config` → collezione `docs` → documento `import`.
2. Se il campo `enabled` non c'è: **Aggiungi campo** → nome `enabled`, tipo
   **boolean**, valore **true**. Se c'è già ed è `false`, cambialo in `true`.

> È il percorso `globalIngredientCatalog/config/docs/import`. Non toccare
> `.../docs/denylist`: è l'elenco degli id provvisori da rifiutare, lo leggono
> le Functions.

### 6c. Import dalla console (due passaggi, nessuna sorpresa)

1. Apri `admin.html` e accedi con `admin`.
2. Menu **Catalogo** (lo vedi solo tu, come creatore).
3. **Scegli file** → seleziona `catalogo-import.json`.
4. Clicca **Analizza file (dry-run)**: non scrive nulla. Devi vedere
   **0 errori** e i conteggi (nuovi / aggiornati / già identici).
5. Se l'analisi è pulita, **Conferma import** diventa attivo: cliccalo e
   conferma.
6. Ricarica **Aggiorna stato**: deve comparire la **versione** del catalogo con
   ingredienti e categorie.

Cosa lascia dietro di sé (per controllo, non serve toccarlo):

```text
globalIngredientCatalog/current/ingredients/{id}     catalogo attivo
globalIngredientCatalog/current/categories/{id}
globalIngredientCatalog/current/meta/summary         versione + conteggi + checksum
globalIngredientCatalog/versions/snapshots/{n}       copia della versione precedente
```

L'import è atomico e **crea sempre una nuova versione**: le Strutture già
pubblicate non cambiano da sole. Per tornare indietro si importa di nuovo il file
giusto, oppure si usa la modalità `restore` del callable (server-side).

> **Se "Conferma import" risponde "Operazione non disponibile" (500) mentre il
> dry-run funziona**: le Functions pubblicate sono una versione che scrive lo
> snapshot su `globalIngredientCatalog/versions/<n>` (3 segmenti: per Firestore
> è una collezione, non un documento) e il client Admin lo rifiuta prima di
> qualunque scrittura. Nessuna scrittura parziale avviene: il catalogo resta
> integro alla versione precedente. Rimedio: ripubblica **solo le Cloud
> Functions** aggiornate (regole e indici non c'entrano), poi ripeti dry-run e
> Conferma import.

---

## Passo 7 — I clienti reali

Per ogni persona da seguire ripeti:

1. Console → **Clienti → ＋ Invita nuovo cliente**.
2. Inserisci l'**email reale**, nome e cognome; se sei admin puoi scegliere il
   professionista destinatario.
3. Crea l'invito e consegna il link monouso con **Copia link** o
   **Condividi link**.
4. Il cliente apre `#/invito/<token>`: email, nome e cognome sono già
   precompilati, sceglie solo la password e verifica l'indirizzo email.
5. Dopo la verifica il collegamento diventa attivo. A quel punto vai in
   **Clienti → Assegna profilo**, scegli una Struttura dieta e salva; il cliente
   conferma dall'app.
6. **Rimuovi cliente** interrompe il collegamento senza cancellare credenziali,
   ricette o backup.

Non creare account cliente direttamente in Authentication e non usare indirizzi
tecnici: la piattaforma live non espone percorsi di prova.

---

## Consegna degli inviti — nessuna email da configurare

Gli inviti **non vengono inviati via email**: la console mostra il link con
**Copia link** e **Condividi link** e lo consegni tu (WhatsApp, condivisione
del telefono, incollandolo dove vuoi). Non esistono provider, chiavi o
variabili d'ambiente da impostare: le vecchie voci `INVITE_EMAIL_*` e
`APP_PUBLIC_URL`, se le trovi ancora configurate su Google Cloud, sono ignorate
e puoi rimuoverle.

Verifica email e recupero password usano i template di Firebase Auth e non
richiedono nulla. Dettagli: [`inviti-email.md`](inviti-email.md); passi manuali
senza terminale: [`configurazione-manuale.md`](configurazione-manuale.md).

---

## Passo 8 — Le ricette già presenti

I file di esportazione che hai già scaricato restano validi per sempre.

1. Dopo la pulizia, apri l'app client con l'email del cliente interessato.
2. **Ricettario** → **Importa** (attenzione: **non** in Impostazioni).
3. Il formato è `piano-nutrizionale-recipes`, schema **5**: in modalità
   "sostituisci" il server salva prima una copia in
   `users/{uid}/backups/previous` — è l'undo automatico.
4. Controlla che il numero di ricette e i nomi tornino.

---

## Passo 9 — Cancellare le vecchie strutture

Solo adesso passa a
**[pulizia-dati-legacy.md](pulizia-dati-legacy.md)**, Passi 3 e 4:

- cancella le organizzazioni diverse da `pianoNutrizionale` (nel tuo caso `prova`);
- cancella `globalRuleSets` **solo** se il controllo del Passo 4a non trova
  assegnazioni attive collegate;
- **non** cancellare `users/...`, `households`, `usernames`, `accountClientLinks`,
  `platformMembers`, `globalIngredientCatalog` (la guida spiega perché);
- in **Authentication** non si cancella nessun account.

---

## Passo 10 — Verifica finale (10 minuti, solo clic)

Ordine consigliato:

1. **App con un cliente reale**: login con email, ricette presenti, Settimana, Lista della spesa.
2. **App con un secondo cliente reale**: come sopra.
3. **Console con l'admin**: menu **Team dello studio** mostra i professionisti autorizzati;
   **Clienti** mostra i clienti collegati; **Strutture dieta** apre e salva senza
   errori; **Catalogo** mostra la versione importata.
4. **Console con `nutrizionista`**: entra, vede i suoi clienti, **non** vede la
   voce Catalogo né il riquadro "Invita professionista" (è riservato al
   creatore: se li vedesse sarebbe un errore).
5. **App con un cliente invitato**: login, verifica email, eventuale richiesta
   di collegamento accettata e piano applicato.

Se un passo non riesce, l'errore mostrato in pagina dice cosa manca: la console
traduce i codici delle Functions (permesso negato, membership non valida,
organizzazione non valida) e le due cause più comuni sono l'appartenenza
mancante (Passo 5) e il catalogo non importato (Passo 6).

---

## Riepilogo in 10 righe

1. Attiva la point-in-time recovery.
2. Porta online regole, indici e Functions aggiornati.
3. Crea `organizations/pianoNutrizionale` (se manca).
4. Metti il tuo UID in `platformMembers` con `role: admin`, `status: active`.
5. Fai entrare `nutrizionista` in `organizations/pianoNutrizionale/members`.
6. Accendi `globalIngredientCatalog/config/docs/import = { enabled: true }`.
7. Console → Catalogo → dry-run → Conferma import del file Guide.
8. Collega i clienti reali invitati e assegna loro una struttura.
9. Re-importa le ricette eventualmente già presenti nel Ricettario.
10. Pulisci le organizzazioni vecchie e verifica tutto.


### Nome visualizzato e inviti esistenti

Un invito a un account già esistente compare nella campanella dell’app, con il nome del professionista e i pulsanti per accettare o rifiutare. Nome e cognome sono facoltativi: si possono salvare dalla sezione di collegamento professionista (cliente) o dalla console (professionista).
