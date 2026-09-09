'use strict';
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { before, after } = require('node:test');
const {
  initializeTestEnvironment, assertSucceeds, assertFails
} = require('@firebase/rules-unit-testing');

let env;
const projectId = 'piano-nutrizionale-test';

before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8') }
  });
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await db.doc('organizations/org-a').set({ schemaVersion: 1, name: 'Studio A' });
    await db.doc('organizations/org-a/members/admin-a').set({ schemaVersion: 1, role: 'admin', status: 'active' });
    await db.doc('organizations/org-a/members/nutri-a').set({ schemaVersion: 1, role: 'nutritionist', status: 'active' });
    await db.doc('organizations/org-a/members/nutri-b').set({ schemaVersion: 1, role: 'nutritionist', status: 'active' });
    await db.doc('organizations/org-a/clients/client-a').set({ schemaVersion: 1, authUid: 'patient-a', status: 'active', nutritionistUids: ['nutri-a'] });
    await db.doc('organizations/org-a/clients/client-b').set({ schemaVersion: 1, authUid: 'patient-b', status: 'active', nutritionistUids: ['nutri-b'] });
    await db.doc('organizations/org-a/clients/client-a/assignments/asg-a').set({ schemaVersion: 1, status: 'active' });
    await db.doc('organizations/org-a/mappingReports/report-a').set({ schemaVersion: 1, clientId: 'client-a', status: 'open' });
    await db.doc('accountClientLinks/patient-a').set({ organizationId: 'org-a', clientId: 'client-a', status: 'active' });
    await db.doc('globalRuleSets/base/versions/3').set({ status: 'published' });
  });
});

after(async () => { await env?.cleanup(); });

function db(uid) { return env.authenticatedContext(uid, { email: `${uid}@example.test` }).firestore(); }

test('admin legge i clienti ma non può scrivere direttamente', async () => {
  await assertSucceeds(db('admin-a').doc('organizations/org-a/clients/client-a').get());
  await assertFails(db('admin-a').doc('organizations/org-a/clients/client-a').update({ status: 'deleted' }));
});

test('nutritionist legge soltanto il cliente autorizzato (cross-client negato)', async () => {
  await assertSucceeds(db('nutri-a').doc('organizations/org-a/clients/client-a').get());
  await assertFails(db('nutri-a').doc('organizations/org-a/clients/client-b').get());
  await assertFails(db('nutri-a').doc('organizations/org-a/clients/client-b/assignments/asg-b').get());
});

test('cliente non legge né seleziona profili o assignment di altri clienti', async () => {
  await assertFails(db('patient-a').doc('organizations/org-a/clients/client-b').get());
  await assertFails(db('patient-a').doc('organizations/org-a/clients/client-a/assignments/asg-a').get());
  await assertFails(db('patient-a').doc('organizations/org-a/clients/client-a/state/activeAssignment').set({ assignmentId: 'asg-b' }));
});

test('link cliente, cataloghi globali e coda mapping passano soltanto da callable', async () => {
  await assertFails(db('patient-a').doc('accountClientLinks/patient-a').get());
  await assertFails(db('patient-a').doc('globalRuleSets/base/versions/3').get());
  await assertFails(db('admin-a').doc('organizations/org-a/mappingReports/report-a').get());
});

test('household non conferisce privilegi SaaS', async () => {
  await env.withSecurityRulesDisabled(context => context.firestore().doc('households/hh/members/placeholder').set({ ok: true }));
  await assertFails(db('patient-a').doc('organizations/org-a/clients/client-a').get());
});
