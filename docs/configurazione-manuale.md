# Configurazione manuale — cosa fare a mano, senza terminale

Questa guida è per chi **non usa il terminale**. Dice, in ordine, cosa va fatto
a mano dopo che il codice è stato unito su `main`, e spiega in parole semplici
l'unica impostazione "delicata" dell'app (`PIANO_SAAS_CONFIG.enabled`).

Non servono chiavi, password, domini email o servizi esterni: **gli inviti ai
clienti non partono più via email**. Il link lo consegni tu, con i pulsanti
**Copia link** e **Condividi link** della console.

---

## 1. L'unica cosa obbligatoria: pubblicare le funzioni da GitHub

Il sito (app e console) si aggiorna da solo su GitHub Pages ogni volta che
`main` cambia. Le **Cloud Functions** (la parte che crea gli inviti, i link e i
collegamenti) invece **non si aggiornano da sole**: vanno pubblicate con un
pulsante.

1. Apri <https://github.com/SylarPower/pianoNutrizionale>.
2. Clicca la scheda **Actions** (in alto, accanto a *Pull requests*).
3. Nella colonna di sinistra scegli **Deploy Firebase (manuale)**.
4. A destra premi il pulsante **Run workflow**.
5. Lascia il ramo su **main**.
6. Nel menu **"Cosa pubblicare su Firebase"** scegli
   `functions,firestore:indexes,firestore:rules` (pubblica tutto insieme:
   funzioni, indici e regole di sicurezza; non fa danni se qualcosa è già
   aggiornato).
7. Premi di nuovo **Run workflow**.
8. Aspetta 3-6 minuti. **Pallino verde** = fatto. **Pallino rosso** = clicca la
   riga rossa e leggi l'ultimo blocco di testo: c'è scritto il motivo.

> Il pulsante esegue prima tutti i test automatici: se uno fallisce, la
> pubblicazione **non parte** e nulla cambia online.

Finché non pubblichi le funzioni, la console aggiornata mostra un errore quando
crei un invito ("campi non ammessi" oppure "Backend della console non
aggiornato"): è normale, sparisce appena il pallino è verde.

Se il pulsante non compare o chiede il segreto `FIREBASE_TOKEN`, la
preparazione una tantum è spiegata in
[`deploy-online-senza-terminale.md`](deploy-online-senza-terminale.md) (sezione
A1 e A2). Va fatta **una sola volta** ed è probabilmente già fatta.

---

## 2. Prova subito con un tuo indirizzo

1. Apri la console (`admin.html`) ed entra con il tuo account.
2. **Clienti → ＋ Invita nuovo cliente**: inserisci una **tua** email reale
   (diversa da quella con cui usi la console), nome e cognome, poi **Crea
   invito**.
3. Si apre la finestra **Link d'invito pronto** con due pulsanti:
   - **Copia link** → mette il link negli appunti: incollalo dove vuoi (email,
     SMS, chat, un foglio).
   - **Condividi link** → sul telefono apre la condivisione del sistema (WhatsApp,
     Telegram, Mail…); sul computer, se la condivisione non è disponibile, apre
     **WhatsApp Web** con il messaggio già scritto.
4. Apri il link dal tuo indirizzo: vedi email, nome e cognome già compilati,
   scegli la password, poi conferma l'email dal messaggio di verifica che ti
   arriva **da Firebase** (questa email esiste ancora: è gratuita e non
   dipende da nessuna configurazione).

Il messaggio che parte con **Condividi link** è questo (nome e data cambiano):

```text
Ciao Mario, ti ho invitato a Piano Nutrizionale: apri questo link personale,
scegli la password e verifica la tua email. Il link scade il 21/09/2026.
https://sylarpower.github.io/pianoNutrizionale/#/invito/…
```

Il link è **personale e monouso** e scade dopo **7 giorni**. Se scade o lo
perdi: scheda del cliente → **Nuovo link** (il vecchio smette di funzionare).
Se hai sbagliato email o nome: **Correggi dati** (anche qui nasce un nuovo
link). Dopo ogni operazione si riapre la stessa finestra con i due pulsanti.

---

## 3. Cosa NON devi più fare

- **Nessun provider email da configurare**: non esistono più chiavi, variabili
  d'ambiente (`INVITE_EMAIL_*`, `APP_PUBLIC_URL`) né domini da verificare
  (SPF, DKIM, DMARC). Se trovi queste istruzioni in vecchie note, ignorale.
- **Nessuna variabile su GitHub o su Google Cloud** per gli inviti.
- **Nessuno stato "email non inviata"** da controllare: la console non invia
  niente, quindi non può fallire l'invio.

Restano invece attive, perché le gestisce Firebase gratuitamente:

- l'email di **verifica dell'indirizzo** dopo la registrazione;
- l'email di **recupero password** ("Password dimenticata?").

Gli ambienti di sviluppo e i dati storici vengono gestiti separatamente dagli
strumenti interni: non sono un percorso da mostrare o usare nella piattaforma
live.

---

## 4. `PIANO_SAAS_CONFIG.enabled` in `js/saas-config.js` — a cosa serve

Nel file `js/saas-config.js` c'è questa riga:

```js
enabled: true,
```

È l'**interruttore generale** della parte "professionale" dell'app cliente:
collegamento con il nutrizionista, profilo/dosi assegnate, notifiche, richieste
da accettare, inviti con email reale. In pratica:

| Valore | Cosa succede nell'app dei clienti |
| --- | --- |
| `true` (**valore normale, lascialo così**) | il cliente vede il collegamento con il professionista, riceve il profilo assegnato e le notifiche; gli inviti funzionano |
| `false` (**solo emergenza**) | l'app torna a funzionare "da sola": nessuna chiamata al server professionale, dosi originali, nessun collegamento visibile. I dati **non** vengono cancellati: al ritorno a `true` tutto ricompare |

Quando metterlo a `false`: **solo** se il server professionale ha un problema
grave e vuoi che i clienti continuino a usare ricette e settimana senza errori,
finché non risolvi. Non è un'impostazione di sicurezza (il file è pubblico) e
non è un passaggio del deploy: **non** va messo a `false` prima di pubblicare
e rimesso a `true` dopo. Resta `true`.

Come cambiarlo senza terminale, se davvero serve: su GitHub apri
`js/saas-config.js`, clicca la matita (*Edit*), cambia `true` in `false`,
**Commit changes** su `main`. Poi aumenta di uno `CACHE_VERSION` in `sw.js`
nello stesso modo, altrimenti i telefoni continuano a usare la versione in
cache. Per tornare indietro, ripeti al contrario.

---

## 5. Se qualcosa non va

| Cosa vedi | Perché | Cosa fare |
| --- | --- | --- |
| "campi non ammessi" o "Backend della console non aggiornato" creando un invito | le funzioni online sono ancora quelle vecchie | fai il passo 1 (pubblica le funzioni) |
| **Copia link** dice che la copia automatica non è disponibile | il browser blocca gli appunti (pagina non sicura o permesso negato) | il link è già selezionato nel campo: copialo con Ctrl+C (o tieni premuto sul telefono) |
| **Condividi link** apre WhatsApp Web invece del menu del telefono | il dispositivo o il browser non ha la condivisione nativa | è il comportamento previsto: scegli il contatto e invia; oppure usa **Copia link** |
| il cliente dice "link scaduto" o "link sostituito" | sono passati 7 giorni, oppure hai premuto **Nuovo link** / **Correggi dati** dopo averglielo mandato | mandagli l'ultimo link mostrato dalla console (scheda cliente → **Nuovo link**) |
| il cliente si è registrato ma non vede il profilo | non ha ancora confermato l'email | deve aprire l'email di verifica di Firebase; nella scheda cliente deve comparire "email verificata" |
| il cliente non riceve l'email di verifica o di recupero password | finita nello spam, oppure indirizzo scritto male | controlla lo spam; se l'indirizzo è sbagliato usa **Correggi dati** (invito) o **Proponi cambio email** (cliente già registrato) |

---

## 6. Ricettario professionisti: bozze, studio e invii

Dopo aver pubblicato le funzioni (§1), la console ha la voce **Ricette**.
Non serve nient'altro: niente regole da cambiare, niente indici da creare.

**Creare una ricetta**: Ricette → **+ Nuova**. Nasce come *bozza privata*:
la vedi solo tu. Nome, emoji, Pasto (Colazione…Cena), righe ingrediente
con dose Uomo e Donna, passi e note. **Salva** crea la revisione 1.

**Condividerla con lo studio** (solo il creatore dello studio):
nella scheda ricetta premi **Condividi**: diventa visibile a tutti i
professionisti, che possono leggerla, duplicarla e inviarla. Con
**Rendi privata** torna solo tua. Ognuno modifica solo le proprie.

**Inviarla a un cliente**: **Invia…**, scegli il cliente collegato,
**Invia ricetta**. Il cliente la trova nella campanella e con **Accetta**
entra nel suo ricettario con il badge «Studio», in sola lettura: può
usarla ed eliminarla, ma non modificarla. Finché non accetta, l'invio
resta in **Invii in attesa** e puoi annullarlo.

**Archiviare**: **Archivia** toglie la ricetta dall'uso (non si modifica
né si invia più). Non si può ripristinare: archivia solo ciò che non serve
più. Con **Duplica** fai una copia privata di una ricetta qualsiasi.

| Cosa vedi | Perché | Cosa fare |
| --- | --- | --- |
| «Revisione non più attuale, ricarica» salvando | un collega ha salvato prima di te | ricarica la vista e rifai la modifica |
| «Solo il creatore dello studio può…» | non sei il creatore | chiedi al creatore di condividere |
| «Solo clienti collegati» inviando | il cliente non ha un collegamento attivo | collegalo prima dalla vista Clienti |
