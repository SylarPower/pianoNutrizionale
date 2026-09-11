'use strict';
/**
 * Migrazione non distruttiva verso singola organizzazione 'piano'.
 * - Crea organizations/piano se manca.
 * - Per ogni member active in vecchie org (admin/nutritionist), copia in
 *   organizations/piano/members/{uid} come nutritionist (downgrade se admin
 *   non creator). Zero cancellazioni di org/clienti/strutture.
 * - Per gli admin org che non sono creator (platformMembers admin), archivia
 *   la membership vecchia impostando status removed (conserva documento).
 *
 * Esecuzione:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node functions/scripts/migrate-to-single-org.js
 *   oppure in produzione con credenziali ADC:
 *   node functions/scripts/migrate-to-single-org.js
 */

const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();
const SINGLE_ORG_ID = 'piano';

async function isCreator(uid) {
  const snap = await db.doc(`platformMembers/${uid}`).get();
  return snap.exists && snap.data()?.status === 'active' && snap.data()?.role === 'admin';
}

(async () => {
  const orgsSnap = await db.collection('organizations').listDocuments();
  // Assicura org singola
  const singleRef = db.doc(`organizations/${SINGLE_ORG_ID}`);
  const singleSnap = await singleRef.get();
  if (!singleSnap.exists) {
    await singleRef.set({
      schemaVersion: 1,
      name: 'Piano',
      status: 'active',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      migratedFrom: orgsSnap.map(ref => ref.id).filter(id => id !== SINGLE_ORG_ID)
    });
    console.log(`Creata organizzazione ${SINGLE_ORG_ID}`);
  } else {
    console.log(`Organizzazione ${SINGLE_ORG_ID} già esistente`);
  }

  let copied = 0;
  let archivedOldAdmins = 0;

  for (const orgRef of orgsSnap) {
    const orgId = orgRef.id;
    if (orgId === SINGLE_ORG_ID) continue;
    const membersSnap = await orgRef.collection('members').where('status', '==', 'active').get();
    for (const memberDoc of membersSnap.docs) {
      const data = memberDoc.data();
      const uid = memberDoc.id;
      const role = data?.role;
      if (!['admin', 'nutritionist'].includes(role)) continue;

      const creator = await isCreator(uid);
      const targetRef = db.doc(`organizations/${SINGLE_ORG_ID}/members/${uid}`);
      const targetSnap = await targetRef.get();

      if (!targetSnap.exists || targetSnap.data()?.status !== 'active') {
        await targetRef.set({
          schemaVersion: 1,
          role: 'nutritionist',
          status: 'active',
          username: data?.username || null,
          migratedFrom: orgId,
          previousRole: role,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          createdBy: 'system:migration',
          updatedBy: 'system:migration'
        }, { merge: true });
        copied++;
        console.log(`Copiato ${uid} (${data?.username || 'no-username'}) da ${orgId} → ${SINGLE_ORG_ID} come nutritionist (era ${role}${creator ? ', creator' : ''})`);
      }

      // Se era admin non creator, archivia vecchia membership (status removed)
      if (role === 'admin' && !creator) {
        await memberDoc.ref.update({
          status: 'removed',
          previousRole: role,
          archivedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: 'system:migration',
          migrationNote: `Migrato in ${SINGLE_ORG_ID} come nutritionist`
        });
        archivedOldAdmins++;
        console.log(`Archiviata vecchia membership admin ${uid} in ${orgId}`);
      }
    }
  }

  console.log(`Migrazione completata: copiati ${copied} membri, archiviati ${archivedOldAdmins} admin non creator.`);
  console.log('Clienti e strutture restano nelle vecchie org, accessibili al creatore. Nuovi solo in piano. Zero cancellazioni di documenti org/clienti/strutture.');
})().catch(err => {
  console.error('Migrazione fallita', err);
  process.exitCode = 1;
});
