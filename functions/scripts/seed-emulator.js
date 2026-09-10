'use strict';
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { checksum, structureRevisionChecksum, STRUCTURE_REVISION_SCHEMA_VERSION } = require('../src/domain');
const Domain = require('../../js/domain');

initializeApp({ projectId: 'piano-nutrizionale-test' });
const auth = getAuth();
const db = getFirestore();
const password = 'Demo-sicura-2026';

async function user(username) {
  const email = `${username}@utenti.pianonutrizionale.app`;
  try { return await auth.getUserByEmail(email); }
  catch (_) { return auth.createUser({ email, password, displayName: username }); }
}

(async () => {
  const [admin, nutritionist, patientA, patientB] = await Promise.all([
    user('admin-demo'), user('nutri-demo'), user('cliente-a'), user('cliente-b')
  ]);
  const now = Timestamp.now();
  const rules = Domain.MELLER_GRAMMATURE.map(rule => ({
    family: rule.family, group: rule.group, label: rule.label,
    aliases: [rule.label], slots: JSON.parse(JSON.stringify(rule.slots))
  }));
  const body = { schemaVersion: 1, ruleSetId: 'base', version: '3', rules, overrides: [] };
  const ruleChecksum = checksum(body);
  const batch = db.batch();
  batch.set(db.doc('organizations/demo'), { schemaVersion: 1, name: 'Studio Demo', status: 'active', createdAt: now, updatedAt: now, createdBy: admin.uid, updatedBy: admin.uid });
  batch.set(db.doc(`organizations/demo/members/${admin.uid}`), { schemaVersion: 1, role: 'admin', status: 'active', createdAt: now, updatedAt: now, createdBy: admin.uid, updatedBy: admin.uid });
  batch.set(db.doc(`organizations/demo/members/${nutritionist.uid}`), { schemaVersion: 1, role: 'nutritionist', status: 'active', createdAt: now, updatedAt: now, createdBy: admin.uid, updatedBy: admin.uid });
  batch.set(db.doc('organizations/demo/clients/client-a'), { schemaVersion: 1, authUid: patientA.uid, displayCode: 'CL-001', status: 'active', nutritionistUids: [nutritionist.uid], createdAt: now, updatedAt: now, createdBy: admin.uid, updatedBy: admin.uid });
  batch.set(db.doc('organizations/demo/clients/client-b'), { schemaVersion: 1, authUid: patientB.uid, displayCode: 'CL-002', status: 'active', nutritionistUids: [], createdAt: now, updatedAt: now, createdBy: admin.uid, updatedBy: admin.uid });
  batch.set(db.doc(`accountClientLinks/${patientA.uid}`), { schemaVersion: 1, organizationId: 'demo', clientId: 'client-a', status: 'active', createdAt: now, updatedAt: now });
  batch.set(db.doc(`accountClientLinks/${patientB.uid}`), { schemaVersion: 1, organizationId: 'demo', clientId: 'client-b', status: 'active', createdAt: now, updatedAt: now });
  batch.set(db.doc(`platformMembers/${admin.uid}`), { schemaVersion: 1, role: 'admin', status: 'active', createdAt: now, updatedAt: now });
  // Catalogo globale v2 + struttura dieta seed derivati dallo split
  // deterministico dell'estratto Meller autorevole (nessun ingrediente
  // provvisorio, nessuna quantità nel catalogo ingredienti).
  const extract = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../../docs/catalogo-ingredienti-meller.json'), 'utf8'));
  const seed = Domain.splitMellerSeed(extract);
  const catalogChecksum = checksum({ schemaVersion: 1, categories: seed.categories, ingredients: seed.ingredients });
  seed.categories.forEach(category => batch.set(db.doc(`globalIngredientCatalog/current/categories/${category.categoryId}`), { schemaVersion: 1, ...category, catalogVersion: 1, updatedAt: now }));
  seed.ingredients.forEach(ingredient => batch.set(db.doc(`globalIngredientCatalog/current/ingredients/${ingredient.ingredientId}`), { schemaVersion: 1, ...ingredient, catalogVersion: 1, updatedAt: now }));
  batch.set(db.doc('globalIngredientCatalog/current/meta/summary'), { schemaVersion: 1, catalogVersion: 1, ingredientCount: seed.ingredients.length, categoryCount: seed.categories.length, checksum: catalogChecksum, updatedAt: now });
  const structureChecksum = checksum({ schemaVersion: 1, rules: seed.structureSeed.rules, alternativeGroups: seed.structureSeed.alternativeGroups });
  batch.set(db.doc('organizations/demo/dietStructures/struttura-base'), { schemaVersion: 1, name: 'Struttura base Meller', status: 'active', ownerUid: nutritionist.uid, createdBy: nutritionist.uid, currentRevisionId: '1', latestChecksum: structureChecksum, ruleCount: seed.structureSeed.rules.length, ingredientCatalogVersion: 1, createdAt: now, updatedAt: now });
  batch.set(db.doc('organizations/demo/dietStructures/struttura-base/revisions/1'), { schemaVersion: 1, revisionId: '1', structureId: 'struttura-base', rules: seed.structureSeed.rules, alternativeGroups: seed.structureSeed.alternativeGroups, status: 'published', checksum: structureChecksum, compatibleClientSchema: 6, effectiveAt: now, changelog: 'Seed emulator da split Meller', createdAt: now, updatedAt: now, createdBy: nutritionist.uid, publishedAt: now, publishedBy: nutritionist.uid });
  batch.set(db.doc('globalRuleSets/base'), { schemaVersion: 1, ruleSetId: 'base', scope: 'global', latestPublishedVersion: '3', latestChecksum: ruleChecksum, createdAt: now, updatedAt: now, createdBy: admin.uid, updatedBy: admin.uid });
  batch.set(db.doc('globalRuleSets/base/versions/3'), { ...body, scope: 'global', status: 'published', checksum: ruleChecksum, compatibleClientSchema: 1, effectiveAt: now, changelog: 'Fixture emulator', createdAt: now, updatedAt: now, createdBy: admin.uid, updatedBy: admin.uid, publishedAt: now, publishedBy: admin.uid });
  await batch.commit();
  console.log(JSON.stringify({ organizationId: 'demo', usernames: ['admin-demo','nutri-demo','cliente-a','cliente-b'], password, ruleSet: { scope: 'global', ruleSetId: 'base', version: '3', checksum: ruleChecksum } }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
