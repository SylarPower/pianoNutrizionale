'use strict';
/* Seed della tabella grammature di esempio per un nutrizionista.
 *
 * Crea la tabella «Tabella grammature — alternative carboidrati e proteine»
 * (docs/tabella-grammature-esempio.json) nella raccolta personale
 * organizations/pianoNutrizionale/grammatureTables, intestata al
 * nutrizionista indicato.
 *
 * Uso (richiede credenziali Admin del progetto di produzione):
 *   GOOGLE_APPLICATION_CREDENTIALS=<service-account.json> \
 *   node functions/scripts/seed-grammature-tables.js [--force]
 *
 * Opzioni tramite variabili d'ambiente:
 *   FIREBASE_PROJECT_ID  progetto Firebase (default: piano-nutrizionale)
 *   NUTRITIONIST_UID     uid proprietario della tabella
 *                        (default: 2WVr880Y9DTpPQPJGPDHshMczdI2, account «nutrizionista»)
 *
 * Idempotenza: usa un ID documento fisso; senza --force non sovrascrive una
 * tabella già presente (le modifiche del nutrizionista restano intatte).
 * Per provare in locale contro l'emulatore:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=piano-nutrizionale-test \
 *   node functions/scripts/seed-grammature-tables.js --force
 */
const path = require('path');
const fs = require('fs');

process.env.FIREBASE_PROJECT_ID ||= 'piano-nutrizionale';
const projectId = process.env.FIREBASE_PROJECT_ID;
if (!process.env.FIRESTORE_EMULATOR_HOST && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.warn('Attenzione: GOOGLE_APPLICATION_CREDENTIALS non impostato. Senza credenziali Admin la scrittura su Firestore di produzione fallirà.');
}

const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const ORGANIZATION_ID = 'pianoNutrizionale';
const DEFAULT_NUTRITIONIST_UID = '2WVr880Y9DTpPQPJGPDHshMczdI2';
const TABLE_DOC_ID = 'tabella-esempio-guide';

initializeApp({ projectId });
const db = getFirestore();

const force = process.argv.includes('--force');
const ownerUid = process.env.NUTRITIONIST_UID || DEFAULT_NUTRITIONIST_UID;
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/tabella-grammature-esempio.json'), 'utf8'));

(async () => {
  const ref = db.doc(`organizations/${ORGANIZATION_ID}/grammatureTables/${TABLE_DOC_ID}`);
  const existing = await ref.get();
  if (existing.exists && !force) {
    console.log(`Tabella già presente (doc ${TABLE_DOC_ID}, owner ${existing.data().ownerUid}): nessuna scrittura. Usa --force per sovrascriverla.`);
    return;
  }
  const now = FieldValue.serverTimestamp();
  await ref.set({
    schemaVersion: 1,
    name: fixture.name,
    description: fixture.description || null,
    rows: fixture.rows,
    ownerUid,
    createdBy: ownerUid,
    updatedBy: ownerUid,
    createdAt: existing.exists ? existing.data().createdAt : now,
    updatedAt: now
  });
  console.log(JSON.stringify({
    ok: true,
    organizationId: ORGANIZATION_ID,
    tableId: TABLE_DOC_ID,
    ownerUid,
    name: fixture.name,
    rowCount: fixture.rows.length,
    overwritten: existing.exists
  }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
