# Pubblicare su Firebase senza usare il terminale del PC

**Risposta breve: sì.** La console di Firebase non ha un pulsante "Pubblica le
Functions", ma puoi pubblicare dal browser in due modi:

- **Modo A (consigliato): un pulsante su GitHub.** Prepari una volta una
  "chiave" e un segreto su GitHub; da quel momento pubblichi con due clic dalla
  scheda *Actions* del repository. Nessun comando, nessuna installazione.
- **Modo B: Cloud Shell di Google.** È un terminale che vive **dentro il
  browser** (si apre da `console.cloud.google.com`). Non installi niente sul PC:
  apri la pagina, incolli 4 righe una alla volta, chiudi la pagina.

In entrambi i casi **non serve il prompt/cmd del tuo computer**.

---

## Modo A — Pulsante "Run workflow" su GitHub

### A1. Preparazione (una sola volta, ~10 minuti)

Serve il **token Firebase**: è una stringa lunga che permette a GitHub di
pubblicare al posto tuo. Trattala come una password.

1. Vai su <https://console.cloud.google.com> ed entra con l'account Google
   **proprietario** del progetto `piano-nutrizionale`.
2. In alto a destra clicca l'icona del **terminale** (`>_`, "Attiva Cloud
   Shell"). Si apre un riquadro nero **nel browser**: è il Cloud Shell, non è il
   tuo PC.
3. Copia e incolla questa riga nel riquadro, poi premi Invio e aspetta circa un
   minuto (serve a installare la Firebase CLI dentro il Cloud Shell):

   ```bash
   npm install -g firebase-tools
   ```

4. Copia e incolla questa seconda riga e premi Invio:

   ```bash
   firebase login:ci --no-localhost
   ```

5. Il terminale ti mostra un link: **cliccalo** (o copialo in una nuova
   scheda). Si apre una pagina Google: scegli l'account giusto e premi
   **Consenti**. La pagina ti dà un **codice**: copialo.
6. Torna al terminale, incolla il codice, premi Invio.
7. Il terminale stampa una riga del tipo `Refresh Token: 1//0g...`.
   **Quella stringa è il token**: copiala tutta.
8. Chiudi pure il Cloud Shell: il token resta valido.

> Se il passaggio 4 dà errore, usa `firebase login:ci` senza `--no-localhost`:
> in Cloud Shell di solito funziona comunque.

### A2. Metti il token su GitHub (una sola volta)

1. Vai su <https://github.com/SylarPower/pianoNutrizionale>.
2. **Settings** → in fondo a sinistra **Secrets and variables** → **Actions**.
3. Scheda **Secrets** → **New repository secret**.
4. **Name**: scrivi esattamente `FIREBASE_TOKEN`.
   **Value**: incolla il token del punto A7.
5. **Add secret**.

> Il token non è più leggibile dopo il salvataggio: è normale. Se lo perdi,
> ripeti A1 e aggiorna il segreto.

### A3. Crea il file del pulsante (una sola volta, nel browser)

GitHub mostra i pulsanti solo per i file presenti nella cartella
`.github/workflows/` del ramo **main**. Il file si crea così, senza PC:

1. Vai su <https://github.com/SylarPower/pianoNutrizionale>.
2. Assicurati in alto a sinistra di essere sul ramo **main**.
3. Premi **Add file** → **Create new file**.
4. Nel campo del nome scrivi esattamente (barre incluse):

   ```text
   .github/workflows/deploy-firebase.yml
   ```

   GitHub crea da solo le cartelle `.github` e `workflows`.
5. Nel corpo del file incolla **esattamente** questo contenuto:

   ```yaml
   # Deploy Firebase dal browser, senza terminale sul PC.
   # Richiede il segreto di repository FIREBASE_TOKEN (vedi docs/deploy-online-senza-terminale.md).

   name: Deploy Firebase (manuale)

   on:
     workflow_dispatch:
       inputs:
         target:
           description: "Cosa pubblicare su Firebase"
           required: true
           type: choice
           default: "functions"
           options:
             - "functions"
             - "firestore:rules"
             - "firestore:indexes"
             - "functions,firestore:indexes,firestore:rules"

   permissions:
     contents: read

   # Un deploy alla volta: due run in parallelo sullo stesso progetto si pestano.
   concurrency:
     group: firebase-deploy
     cancel-in-progress: false

   jobs:
     test:
       name: Test prima del deploy
       runs-on: ubuntu-latest
       steps:
         - name: Scarica il codice
           uses: actions/checkout@v4

         - name: Prepara Node 22
           uses: actions/setup-node@v4
           with:
             node-version: 22

         - name: Test app (npm test)
           run: npm test

         - name: Installa le dipendenze delle Functions
           run: npm --prefix functions install --no-audit --no-fund

         - name: Test Functions
           run: npm --prefix functions test

         - name: Controllo sintassi
           run: npm run syntax

     deploy:
       name: "Pubblica: ${{ inputs.target }}"
       needs: test
       runs-on: ubuntu-latest
       timeout-minutes: 30
       steps:
         - name: Scarica il codice
           uses: actions/checkout@v4

         - name: Prepara Node 22
           uses: actions/setup-node@v4
           with:
             node-version: 22

         - name: Installa la Firebase CLI
           run: npm install -g firebase-tools@15

         - name: Verifica che esista il segreto FIREBASE_TOKEN
           env:
             FIREBASE_TOKEN: ${{ secrets.FIREBASE_TOKEN }}
           run: |
             if [ -z "${FIREBASE_TOKEN}" ]; then
               echo "::error title=Manca il segreto FIREBASE_TOKEN::Vai in Settings -> Secrets and variables -> Actions -> New repository secret e aggiungi FIREBASE_TOKEN."
               exit 1
             fi

         - name: "firebase deploy --only ${{ inputs.target }}"
           env:
             DEPLOY_TARGET: ${{ inputs.target }}
             FIREBASE_TOKEN: ${{ secrets.FIREBASE_TOKEN }}
           run: |
             echo "Pubblicazione in corso: ${DEPLOY_TARGET}"
             firebase deploy --only "${DEPLOY_TARGET}" --project piano-nutrizionale --non-interactive
   ```

6. In alto a destra **Commit changes** → **Commit changes**.

Dopo pochi secondi la scheda **Actions** mostra la voce **Deploy Firebase
(manuale)** con il suo pulsante.

> Se preferisci non toccare `main` direttamente: nello stesso punto scegli
> "Create a new branch and start a pull request", poi apri la Pull Request e
> premi **Merge**. Il pulsante compare solo dopo il merge su `main`.

### A4. Uso normale (ogni volta che vuoi pubblicare)

1. GitHub → repository → scheda **Actions**.
2. Nella colonna di sinistra scegli **Deploy Firebase (manuale)**.
3. A destra premi **Run workflow**.
4. Scegli il ramo (di solito `main`).
5. Nel menu a tendina **"Cosa pubblicare su Firebase"** scegli:
   - `functions` → pubblica le Cloud Functions (equivale a
     `firebase deploy --only functions`);
   - `firestore:rules` → pubblica solo le regole di sicurezza;
   - `firestore:indexes` → pubblica solo gli indici;
   - `functions,firestore:indexes,firestore:rules` → tutto insieme.
6. Premi **Run workflow**.
7. Dopo 3-6 minuti compare un **pallino verde** = pubblicato.
   **Pallino rosso** = clicca la riga rossa e leggi l'ultimo blocco di testo:
   lì c'è scritto il motivo in italiano o in inglese.

Verifica finale: console Firebase → progetto `piano-nutrizionale` →
**Build → Functions**: ogni funzione mostra la data dell'ultimo deploy.

### Cosa fa il pulsante prima di pubblicare

Il workflow non pubblica alla cieca: esegue prima `npm test` (test dell'app),
i test delle Functions e il controllo di sintassi. Se uno di questi fallisce,
il deploy **non parte** (pallino rosso sul job "Test prima del deploy").

---

## Modo B — Cloud Shell (terminale nel browser)

Utile se non vuoi configurare GitHub Actions, o per una pubblicazione al volo.

1. <https://console.cloud.google.com> → icona del terminale (`> _`) in alto a
   destra.
2. Incolla **una riga alla volta**, premendo Invio dopo ciascuna:

   ```bash
   gcloud config set project piano-nutrizionale
   git clone https://github.com/SylarPower/pianoNutrizionale.git
   cd pianoNutrizionale
   npm install -g firebase-tools
   firebase login --no-localhost
   ```

   L'ultima riga apre una pagina Google: **Consenti**, copia il codice,
   incollalo nel terminale.
3. Ora pubblica:

   ```bash
   firebase deploy --only functions --project piano-nutrizionale
   ```

   (per le regole: `firebase deploy --only firestore:rules --project piano-nutrizionale`)
4. Chiudi la scheda quando hai finito.

Note:

- il codice pubblicato è quello del ramo `main` di GitHub al momento del clone;
- la cartella resta nella "home" del Cloud Shell: le volte successive ti basta
  riaprire il terminale, entrare nella cartella con `cd pianoNutrizionale`,
  aggiornare con `git pull` e rilanciare il deploy.

---

## Casi particolari

- **Solo le regole di sicurezza**: non serve nulla di tutto questo. Firebase
  console → **Firestore Database** → scheda **Rules** → sostituisci il testo con
  il contenuto di [`firestore.rules`](../firestore.rules) → **Publish**.
- **Solo l'Hosting**: il sito oggi è pubblicato su **GitHub Pages** (vedi
  `README.md`), quindi il deploy `hosting` di Firebase non è il canale usato.
  Il workflow volutamente non lo propone, per non creare un secondo sito.
- **Primo deploy delle Functions in assoluto**: richiede il piano **Blaze** e le
  API Cloud Build / Artifact Registry / Cloud Scheduler attive. Sul progetto
  `piano-nutrizionale` è già stato fatto, quindi i deploy successivi funzionano.

---

## Appendice — controlli automatici a ogni modifica (facoltativo)

Con un secondo file GitHub esegue i test da solo a ogni modifica: vedi un
pallino verde o rosso accanto al commit, senza lanciare niente dal tuo
computer. Si crea come in A3, con il nome
`.github/workflows/test.yml` e questo contenuto:

```yaml
# Controlli automatici a ogni modifica: pallino verde = codice sano.

name: Test

on:
  push:
    branches: ["**"]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  test:
    name: Test e sintassi
    runs-on: ubuntu-latest
    steps:
      - name: Scarica il codice
        uses: actions/checkout@v4

      - name: Prepara Node 22
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Test app (npm test)
        run: npm test

      - name: Installa le dipendenze delle Functions
        run: npm --prefix functions install --no-audit --no-fund

      - name: Test Functions
        run: npm --prefix functions test

      - name: Controllo sintassi
        run: npm run syntax
```

`npm run smoke` non è incluso perché al momento fallisce già su `main`
(`test/smoke-app.js:231`, "profilo coppia visibile e contestualizzato"): è un
problema preesistente. Quando torna verde, aggiungi lo step
`- name: Smoke test` / `run: npm run smoke`.
