# 🥗 Piano Nutrizionale WebApp

Una WebApp mobile-first completa per gestire il proprio piano nutrizionale settimanale. 
Costruita interamente in **Vanilla JavaScript, HTML5 e CSS3**, senza alcun framework o dipendenza esterna, progettata per essere rapida, responsiva e consultabile ovunque.

## ✨ Funzionalità

- **📱 Interfaccia Mobile-First**: Design pulito, navigazione a schede in stile app (Oggi, Settimana, Spesa, Impostazioni) e supporto **PWA** (Installabile nella Home del telefono).
- **📅 Gestione Giornaliera**: Visualizzazione dinamica dei pasti divisi tra giorni di **Allenamento 🏋️** e **Riposo 😴**, con orari, badge e countdown per il pasto successivo.
- **🍳 Ricette Dettagliate e Modificabili**: Ogni pasto ha la sua scheda con ingredienti, passaggi di preparazione e avvisi per il **Batch Cooking**. Le ricette possono essere modificate e ripristinate all'originale.
- **🛒 Lista della Spesa Intelligente**: Generatore automatico della lista della spesa calcolata in base ai giorni selezionati. Scala in automatico le grammature in base al numero di persone (es: moltiplicatore x1.75 per uomo+donna; la % della donna è configurabile dalle Impostazioni ed è sincronizzata su tutti i dispositivi). Esportabile su WhatsApp o copiabile in formato testuale raggruppato per categoria.
- **🔔 Notifiche Push**: Notifiche programmate per ricordarti i pasti e le eventuali preparazioni serali (Batch Cooking).
- **☁️ Firebase Ready**: Predisposta per la sincronizzazione cloud in tempo reale con Firebase Firestore, ma perfettamente funzionante anche in modalità "Offline" tramite mock in locale.

## 🛠️ Stack Tecnologico

- **Frontend**: HTML5, CSS3, Vanilla JavaScript (ES6+)
- **Routing**: SPA (Single Page Application) gestita tramite Hash Routing locale
- **Database / Sync**: Firebase Firestore (Compat version via CDN)
- **Hosting Target**: Ottimizzata per GitHub Pages (sito statico)

## 🚀 Setup e Installazione (Sincronizzazione Firebase)

L'app funziona in modalità offline "out of the box". Se desideri abilitare il salvataggio in cloud e la sincronizzazione tra più dispositivi (es. tra PC e Cellulare):

1. Crea un progetto gratuito su [Firebase](https://firebase.google.com/).
2. Attiva **Firestore Database**.
3. Apri il file `js/firebase.js`.
4. Sostituisci l'oggetto `firebaseConfig` con le chiavi del tuo progetto Firebase:
   ```javascript
   const firebaseConfig = {
     apiKey: "LA_TUA_API_KEY",
     authDomain: "IL_TUO_DOMAIN",
     projectId: "IL_TUO_PROJECT_ID",
     // ...
   };
