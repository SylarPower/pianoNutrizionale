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
    const orgId = 'pianoNutrizionale';
    await db.doc(`organizations/${orgId}`).set({ schemaVersion: 1, name: 'Piano' });
    // Creatore = platformMembers admin
    await db.doc('platformMembers/creator-a').set({ schemaVersion: 1, role: 'admin', status: 'active' });
    await db.doc(`organizations/${orgId}/members/nutri-a`).set({ schemaVersion: 1, role: 'nutritionist', status: 'active' });
    await db.doc(`organizations/${orgId}/members/nutri-b`).set({ schemaVersion: 1, role: 'nutritionist', status: 'active' });
    await db.doc(`organizations/${orgId}/clients/client-a`).set({ schemaVersion: 1, authUid: 'patient-a', status: 'active', nutritionistUids: ['nutri-a'] });
    await db.doc(`organizations/${orgId}/clients/client-b`).set({ schemaVersion: 1, authUid: 'patient-b', status: 'active', nutritionistUids: ['nutri-b'] });
    await db.doc(`organizations/${orgId}/clients/client-a/assignments/asg-a`).set({ schemaVersion: 1, status: 'active', structure: { structureId: 'struttura-a', revisionId: '1', checksum: 'x' } });
    await db.doc('accountClientLinks/patient-a').set({ organizationId: orgId, clientId: 'client-a', status: 'active' });
    // Strutture, template, coda richieste, inviti, link, catalogo.
    await db.doc(`organizations/${orgId}/dietStructures/struttura-a`).set({ schemaVersion: 1, name: 'Base', status: 'active', ownerUid: 'nutri-a', currentRevisionId: '1' });
    await db.doc(`organizations/${orgId}/dietStructures/struttura-a/revisions/1`).set({
      schemaVersion: 1, status: 'published', checksum: 'x', ingredientCatalogVersion: 1,
      dietPlan: { schemaVersion: 1, generalNotes: '', days: [{ dayId: 'giorno-a', label: 'Giorno A', dayType: 'training',
        meals: [{ mealId: 'lunch', time: '', note: '', options: [{ optionId: 'pranzo', type: 'family-block', note: '',
          blocks: [{ blockId: 'amidi', referenceFamilyId: 'cereali', referenceIngredientId: 'riso', referenceAmount: { value: 80, unit: 'g' }, templateId: null, templateSnapshot: null, overrides: [] }] }] }],
        supplements: '', hydration: '', note: '' }] }
    });
    await db.doc(`organizations/${orgId}/equivalenceTemplates/tpl-a`).set({ schemaVersion: 1, name: 'Amidi', status: 'active', ownerUid: 'nutri-a', currentRevisionId: '1' });
    await db.doc(`organizations/${orgId}/catalogRequests/req-cat`).set({ schemaVersion: 1, status: 'pending', ingredientText: 'tonno al naturale', clientId: 'client-a' });
    await db.doc(`organizations/${orgId}/invitations/invite-a`).set({ schemaVersion: 1, type: 'client', targetUsername: 'cliente-x', tokenHash: 'h', status: 'pending', createdBy: 'nutri-a' });
    await db.doc(`organizations/${orgId}/clientLinkRequests/req-a`).set({ schemaVersion: 1, clientId: 'client-a', targetUid: 'patient-a', nutritionistUid: 'nutri-a', status: 'pending' });
    await db.doc('globalIngredientCatalog/current/meta/summary').set({ schemaVersion: 1, catalogVersion: 1, checksum: 'x', ingredientCount: 1, familyCount: 1, categoryCount: 1 });
    await db.doc('globalIngredientCatalog/current/families/cereali').set({ schemaVersion: 1, familyId: 'cereali', displayName: 'Cereali', categoryId: 'carb', sortOrder: 0, status: 'active' });
    await db.doc('globalIngredientCatalog/current/ingredients/riso').set({ schemaVersion: 1, ingredientId: 'riso', displayName: 'Riso', categoryId: 'carb', familyId: 'cereali', dietaryFlags: { vegetarian: true, vegan: true }, status: 'active' });
    await db.doc('globalIngredientCatalog/config/docs/denylist').set({ ingredientIds: [] });
    await db.doc('globalIngredientCatalog/versions/snapshots/0').set({ schemaVersion: 1, catalogVersion: 0 });
    // Org vecchia non valida più: per testare che non sia leggibile
    await db.doc('organizations/org-a').set({ schemaVersion: 1, name: 'Vecchia' });
    await db.doc('organizations/org-a/members/nutri-a').set({ schemaVersion: 1, role: 'nutritionist', status: 'active' });
  });
});

after(async () => { await env?.cleanup(); });

function db(uid) { return env.authenticatedContext(uid, { email: `${uid}@example.test` }).firestore(); }

test('creatore legge i clienti ma non può scrivere direttamente', async () => {
  await assertSucceeds(db('creator-a').doc('organizations/pianoNutrizionale/clients/client-a').get());
  await assertFails(db('creator-a').doc('organizations/pianoNutrizionale/clients/client-a').update({ status: 'deleted' }));
});

test('nutritionist legge soltanto il cliente autorizzato (cross-client negato)', async () => {
  await assertSucceeds(db('nutri-a').doc('organizations/pianoNutrizionale/clients/client-a').get());
  await assertFails(db('nutri-a').doc('organizations/pianoNutrizionale/clients/client-b').get());
  await assertFails(db('nutri-a').doc('organizations/pianoNutrizionale/clients/client-b/assignments/asg-b').get());
});

test('cliente non legge né seleziona profili o assignment di altri clienti', async () => {
  await assertFails(db('patient-a').doc('organizations/pianoNutrizionale/clients/client-b').get());
  await assertFails(db('patient-a').doc('organizations/pianoNutrizionale/clients/client-a/assignments/asg-a').get());
  await assertFails(db('patient-a').doc('organizations/pianoNutrizionale/clients/client-a/state/activeAssignment').set({ assignmentId: 'asg-b' }));
});

test('link cliente, config catalogo e coda ingredienti passano soltanto da callable', async () => {
  await assertFails(db('patient-a').doc('accountClientLinks/patient-a').get());
  await assertFails(db('creator-a').doc('globalIngredientCatalog/config/docs/import').get());
  await assertFails(db('creator-a').doc('organizations/pianoNutrizionale/catalogRequests/req-cat').get());
  await assertFails(db('patient-a').doc('organizations/pianoNutrizionale/catalogRequests/req-cat').get());
});

test('template equivalenze: nessun accesso diretto, nemmeno al proprietario', async () => {
  await assertFails(db('nutri-a').doc('organizations/pianoNutrizionale/equivalenceTemplates/tpl-a').get());
  await assertFails(db('nutri-a').doc('organizations/pianoNutrizionale/equivalenceTemplates/tpl-a/revisions/1').get());
  await assertFails(db('creator-a').doc('organizations/pianoNutrizionale/equivalenceTemplates/tpl-a').update({ name: 'X' }));
});

test('strutture dieta: nessun accesso diretto, privacy ownerUid solo via callable', async () => {
  // Nemmeno il proprietario né il creatore leggono direttamente: passa da callable.
  await assertFails(db('nutri-a').doc('organizations/pianoNutrizionale/dietStructures/struttura-a').get());
  await assertFails(db('nutri-a').doc('organizations/pianoNutrizionale/dietStructures/struttura-a/revisions/1').get());
  await assertFails(db('creator-a').doc('organizations/pianoNutrizionale/dietStructures/struttura-a').get());
  await assertFails(db('nutri-a').doc('organizations/pianoNutrizionale/dietStructures/struttura-a').update({ name: 'X' }));
});

test('catalogo: current leggibile, config e snapshot server-only, scritture negate', async () => {
  await assertSucceeds(db('patient-a').doc('globalIngredientCatalog/current/ingredients/riso').get());
  await assertFails(db('patient-a').doc('globalIngredientCatalog/config/docs/denylist').get());
  await assertFails(db('creator-a').doc('globalIngredientCatalog/config/docs/denylist').get());
  await assertFails(db('patient-a').doc('globalIngredientCatalog/versions/snapshots/0').get());
  await assertFails(db('patient-a').doc('globalIngredientCatalog/current/ingredients/riso').update({ displayName: 'X' }));
  await assertFails(db('creator-a').doc('globalIngredientCatalog/current/ingredients/nuovo').set({ displayName: 'Y' }));
});

test('inviti e collegamenti: lettura solo ai contraenti, scritture negate', async () => {
  await assertSucceeds(db('creator-a').doc('organizations/pianoNutrizionale/invitations/invite-a').get());
  await assertSucceeds(db('nutri-a').doc('organizations/pianoNutrizionale/invitations/invite-a').get());
  await assertFails(db('nutri-b').doc('organizations/pianoNutrizionale/invitations/invite-a').get());
  await assertFails(db('patient-a').doc('organizations/pianoNutrizionale/invitations/invite-a').get());
  await assertSucceeds(db('creator-a').doc('organizations/pianoNutrizionale/clientLinkRequests/req-a').get());
  await assertSucceeds(db('nutri-a').doc('organizations/pianoNutrizionale/clientLinkRequests/req-a').get());
  await assertSucceeds(db('patient-a').doc('organizations/pianoNutrizionale/clientLinkRequests/req-a').get());
  await assertFails(db('nutri-b').doc('organizations/pianoNutrizionale/clientLinkRequests/req-a').get());
  await assertFails(db('patient-b').doc('organizations/pianoNutrizionale/clientLinkRequests/req-a').get());
  await assertFails(db('nutri-a').doc('organizations/pianoNutrizionale/clientLinkRequests/req-a').update({ status: 'accepted' }));
  await assertFails(db('patient-a').doc('organizations/pianoNutrizionale/clientLinkRequests/req-a').update({ status: 'accepted' }));
});

test('organizzazione singola piano: vecchia org non leggibile da nutritionist', async () => {
  await assertFails(db('nutri-a').doc('organizations/org-a').get());
  await assertFails(db('nutri-a').doc('organizations/org-a/members/nutri-a').get());
});

test('household non conferisce privilegi SaaS', async () => {
  await env.withSecurityRulesDisabled(context => context.firestore().doc('households/hh/members/placeholder').set({ ok: true }));
  await assertFails(db('patient-a').doc('organizations/pianoNutrizionale/clients/client-a').get());
});
