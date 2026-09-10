'use strict';

const crypto = require('node:crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const {
  ROLES, REPORT_STATUSES, STRUCTURE_REVISION_SCHEMA_VERSION, exactObject, text, optionalText, id, checksum,
  hashToken, normalizeUsername,
  reportKey, validateReport, validateMapping, validateRuleSetRules, validateAssignment, validateStructureAssignment,
  validateDietStructureRules, validateAlternativeGroups, structureRevisionChecksum, verifyStructureRevision, effectiveAssignment,
  CATALOG_IMPORT_MODES, parseCatalogPayload, validateCatalogImport, catalogImportPreviewId,
  validateInviteOrganizationUser, validateInviteClientLink, validateRespondClientLink,
  validateRemoveClientLink, validateMemberStatus, validateRemoveNutritionist,
  validateTransferStructureOwnership
} = require('./domain');

initializeApp();
const db = getFirestore();
const REGION = 'europe-west1';
const callableOptions = { region: REGION, enforceAppCheck: true, cors: true };

function apiError(error) {
  if (error instanceof HttpsError) return error;
  const allowed = new Set(['invalid-argument', 'not-found', 'permission-denied', 'failed-precondition', 'already-exists', 'resource-exhausted']);
  if (allowed.has(error?.code)) return new HttpsError(error.code, error.message);
  logger.error('SaaS callable failed', { code: error?.code, message: error?.message });
  return new HttpsError('internal', 'Operazione non disponibile');
}

function callable(handler) {
  return onCall(callableOptions, async request => {
    try {
      if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Autenticazione richiesta');
      return await handler(request.data || {}, request.auth.uid, request);
    } catch (error) {
      throw apiError(error);
    }
  });
}

async function membership(organizationId, uid) {
  const orgId = id(organizationId, 'organizationId');
  const snap = await db.doc(`organizations/${orgId}/members/${uid}`).get();
  const value = snap.data();
  if (!snap.exists || value?.status !== 'active' || !ROLES.has(value?.role)) {
    throw new HttpsError('permission-denied', 'Membership non valida');
  }
  return { organizationId: orgId, uid, role: value.role };
}

async function platformAdmin(uid) {
  const snap = await db.doc(`platformMembers/${uid}`).get();
  if (!snap.exists || snap.data()?.status !== 'active' || snap.data()?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Ruolo platform admin richiesto');
  }
  return { uid, role: 'admin' };
}

async function authorizedClient(actor, clientId) {
  const ref = db.doc(`organizations/${actor.organizationId}/clients/${id(clientId, 'clientId')}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.status === 'deleted') throw new HttpsError('not-found', 'Cliente non trovato');
  const client = snap.data();
  if (actor.role === 'nutritionist' && !(client.nutritionistUids || []).includes(actor.uid)) {
    throw new HttpsError('permission-denied', 'Cliente non autorizzato');
  }
  return { ref, id: snap.id, ...client };
}

function auditRef(orgId, eventId) {
  return db.doc(`organizations/${orgId}/auditLog/${eventId}`);
}

function platformAuditRef(eventId) {
  return db.doc(`platformAuditLog/${eventId}`);
}

// Catalogo globale corrente: meta + ingredienti + categorie. Letto server-side
// per incorporare uno snapshot nel profilo cliente, per validare le strutture
// (ingredientIds/categoryId esistenti) e come base del dry-run import.
async function loadGlobalCatalog() {
  const [meta, ingredientsSnap, categoriesSnap] = await Promise.all([
    db.doc('globalIngredientCatalog/current/meta/summary').get(),
    db.collection('globalIngredientCatalog/current/ingredients').limit(2000).get(),
    db.collection('globalIngredientCatalog/current/categories').limit(500).get()
  ]);
  return {
    catalogVersion: Number(meta.data()?.catalogVersion || 0),
    checksum: meta.data()?.checksum || null,
    ingredients: ingredientsSnap.docs.map(doc => ({ ingredientId: doc.id, ...doc.data() })),
    categories: categoriesSnap.docs.map(doc => ({ categoryId: doc.id, ...doc.data() }))
  };
}

// Sottoinsieme sicuro del catalogo incorporato nel profilo cliente: solo
// identità/alias/categorie, mai quantità (il catalogo non ne contiene).
function publicCatalogSnapshot(catalog) {
  return {
    catalogVersion: catalog.catalogVersion,
    ingredients: catalog.ingredients
      .filter(item => item.status !== 'archived')
      .map(item => ({
        ingredientId: item.ingredientId,
        displayName: item.displayName,
        categoryId: item.categoryId || null,
        aliases: Array.isArray(item.aliases) ? item.aliases : [],
        searchTokens: Array.isArray(item.searchTokens) ? item.searchTokens : [],
        mappingKind: item.mappingKind || 'guided',
        mellerFamilyId: item.mellerFamilyId || null,
        status: 'active'
      })),
    categories: catalog.categories
      .filter(item => item.status !== 'archived')
      .map(item => ({ categoryId: item.categoryId, displayName: item.displayName }))
  };
}

function catalogLookup(catalog) {
  return {
    ingredientIds: new Set(catalog.ingredients.filter(item => item.status !== 'archived').map(item => item.ingredientId)),
    categoryIds: new Set(catalog.categories.filter(item => item.status !== 'archived').map(item => item.categoryId))
  };
}

function assignmentDates(assignment) {
  return {
    ...assignment,
    effectiveAt: assignment.effectiveAt?.toDate?.() || assignment.effectiveAt,
    expiresAt: assignment.expiresAt?.toDate?.() || assignment.expiresAt
  };
}

function auditEvent({ orgId, eventId, type, actor, subject, idempotencyKey, metadata = {} }) {
  return {
    schemaVersion: 1, eventId, type, organizationId: orgId,
    actor: { uid: actor.uid, role: actor.role }, subject, idempotencyKey,
    occurredAt: FieldValue.serverTimestamp(), metadata
  };
}

function applyMappingCatalogs(baseRules, ...catalogs) {
  const rules = JSON.parse(JSON.stringify(baseRules || []));
  const freeAliases = [];
  catalogs.forEach(catalog => Object.values(catalog?.entries || {}).forEach(entry => {
    const mapping = entry?.mapping;
    if (!mapping) return;
    if (mapping.kind === 'free') {
      freeAliases.push(...(mapping.aliases || []));
      return;
    }
    let rule = rules.find(item => item.family === mapping.family);
    if (!rule) {
      rule = { family: mapping.family, group: mapping.group, label: mapping.canonicalIngredientId, aliases: [], slots: mapping.doses };
      rules.push(rule);
    }
    rule.aliases = [...new Set([...(rule.aliases || []), ...(mapping.aliases || [])])];
    if (mapping.doses) rule.slots = mapping.doses;
  }));
  return { rules, freeAliases: [...new Set(freeAliases)] };
}

function publicAssignment(assignment, clientId, rules, catalogs = []) {
  const resolved = applyMappingCatalogs(rules.rules, ...catalogs);
  return {
    schemaVersion: 1,
    clientProfileId: clientId,
    assignmentId: assignment.assignmentId,
    ruleSetId: assignment.ruleSet.ruleSetId,
    ruleSetVersion: assignment.ruleSet.version,
    ruleSetChecksum: assignment.ruleSet.checksum,
    mappingCatalogChecksum: checksum(catalogs.map(item => item?.checksum || null)),
    effectiveAt: assignment.effectiveAt,
    expiresAt: assignment.expiresAt || null,
    strategy: assignment.strategy,
    rules: resolved.rules,
    freeAliases: resolved.freeAliases,
    compatibleClientSchema: rules.compatibleClientSchema || 1
  };
}

async function ruleVersionRef(orgId, pointer) {
  return pointer.scope === 'global'
    ? db.doc(`globalRuleSets/${pointer.ruleSetId}/versions/${pointer.version}`)
    : db.doc(`organizations/${orgId}/ruleSets/${pointer.ruleSetId}/versions/${pointer.version}`);
}

function verifiedRuleVersion(value, pointer) {
  if (!value || value.status !== 'published' || !Array.isArray(value.rules) || !value.rules.length) return false;
  const expected = checksum({
    schemaVersion: Number(value.schemaVersion || 1),
    ruleSetId: pointer.ruleSetId,
    version: String(pointer.version),
    rules: value.rules,
    overrides: value.overrides || []
  });
  return value.checksum === pointer.checksum && value.checksum === expected;
}

async function resolveDueAssignment(orgId, clientId) {
  const stateRef = db.doc(`organizations/${orgId}/clients/${clientId}/state/activeAssignment`);
  const now = Timestamp.now();
  const due = await db.collection(`organizations/${orgId}/clients/${clientId}/assignments`)
    .where('status', 'in', ['active', 'scheduled'])
    .where('effectiveAt', '<=', now)
    .orderBy('effectiveAt', 'desc').limit(1).get();
  if (due.empty) return null;
  const doc = due.docs[0];
  const assignment = doc.data();
  if (assignment.status === 'scheduled') {
    await db.runTransaction(async tx => {
      const fresh = await tx.get(doc.ref);
      if (fresh.data()?.status !== 'scheduled') return;
      tx.update(doc.ref, { status: 'active', updatedAt: FieldValue.serverTimestamp(), updatedBy: 'system:scheduler' });
      tx.set(stateRef, { schemaVersion: 1, assignmentId: doc.id, updatedAt: FieldValue.serverTimestamp() });
    });
    assignment.status = 'active';
  }
  return assignment;
}

// Profilo v2: la revisione della Struttura dieta + uno snapshot del catalogo
// globale al momento della lettura. La conversione in regole motore avviene
// nel client via structureRevisionToMellerRules (stesso motore, nessun fork
// server-side delle dosi). Note e checksum interni non escono mai: il client
// riceve solo il checksum di snapshot ereditato dal contratto v1.
function publicStructureAssignment({ assignment, clientId, structure, revision, catalog }) {
  return {
    schemaVersion: 2,
    clientProfileId: clientId,
    assignmentId: assignment.assignmentId,
    structureId: assignment.structure.structureId,
    structureRevisionId: assignment.structure.revisionId,
    structureChecksum: assignment.structure.checksum,
    structureName: structure.name || assignment.structure.structureId,
    ingredientCatalogVersion: catalog.catalogVersion,
    effectiveAt: assignment.effectiveAt,
    expiresAt: assignment.expiresAt || null,
    structureRevision: {
      revisionId: revision.revisionId,
      rules: revision.rules || [],
      alternativeGroups: revision.alternativeGroups || []
    },
    catalog: publicCatalogSnapshot(catalog),
    compatibleClientSchema: 6
  };
}

exports.getMyAssignedProfile = callable(async (_data, uid) => {
  const link = await db.doc(`accountClientLinks/${uid}`).get();
  if (!link.exists || link.data()?.status !== 'active') return { state: 'unassigned', fallback: 'original-only' };
  const { organizationId, clientId } = link.data();
  const client = await db.doc(`organizations/${organizationId}/clients/${clientId}`).get();
  if (!client.exists || client.data()?.authUid !== uid || client.data()?.status !== 'active') {
    return { state: 'unassigned', fallback: 'original-only' };
  }
  const assignment = await resolveDueAssignment(organizationId, clientId);
  const effective = effectiveAssignment(assignment && assignmentDates(assignment));
  if (!effective.valid) return { state: effective.reason || 'unassigned', fallback: 'original-only', clientProfileId: clientId };
  // Fase 2: le assegnazioni v2 puntano alla revisione di una Struttura dieta
  // (pointer {structureId, revisionId, checksum}); quelle storiche v1 al rule
  // set. La revisione assegnata resta servita anche se la struttura viene
  // archiviata dopo (non-retroattività: governa l'assignment, non la testata).
  if (assignment.structure?.structureId) {
    const revisionId = String(assignment.structure.revisionId || '');
    if (!revisionId) return { state: 'invalid-rule-set', fallback: 'original-only', clientProfileId: clientId };
    const structureRef = db.doc(`organizations/${organizationId}/dietStructures/${assignment.structure.structureId}`);
    const [structure, revision, catalog] = await Promise.all([
      structureRef.get(),
      structureRef.collection('revisions').doc(revisionId).get(),
      loadGlobalCatalog()
    ]);
    if (!structure.exists || !revision.exists
      || revision.id !== String(assignment.structure.revisionId)
      || revision.data().checksum !== assignment.structure.checksum
      || !verifyStructureRevision(revision.data())) {
      return { state: 'invalid-rule-set', fallback: 'original-only', clientProfileId: clientId };
    }
    return {
      state: 'assigned', fallback: 'original-only',
      profile: publicStructureAssignment({ assignment, clientId, structure: structure.data(), revision: revision.data(), catalog })
    };
  }
  const versionRef = await ruleVersionRef(organizationId, assignment.ruleSet);
  const [version, globalCatalog, tenantCatalog] = await Promise.all([
    versionRef.get(),
    db.doc('globalMappingCatalog/current').get(),
    db.doc(`organizations/${organizationId}/mappingCatalog/current`).get()
  ]);
  if (!version.exists || !verifiedRuleVersion(version.data(), assignment.ruleSet)) {
    return { state: 'invalid-rule-set', fallback: 'original-only', clientProfileId: clientId };
  }
  return {
    state: 'assigned', fallback: 'original-only',
    profile: publicAssignment(assignment, clientId, version.data(), [globalCatalog.data() || {}, tenantCatalog.data() || {}])
  };
});

exports.listMyNotifications = callable(async (data, uid) => {
  exactObject(data, []);
  const link = await db.doc(`accountClientLinks/${uid}`).get();
  if (!link.exists || link.data()?.status !== 'active') return { notifications: [] };
  const snapshot = await db.collection(`organizations/${link.data().organizationId}/notifications`)
    .where('recipientUid', '==', uid).orderBy('createdAt', 'desc').limit(30).get();
  return { notifications: snapshot.docs.map(doc => ({ id: doc.id, type: doc.data().type, subjectId: doc.data().subjectId, readAt: doc.data().readAt, createdAt: doc.data().createdAt })) };
});

exports.markNotificationRead = callable(async (data, uid) => {
  exactObject(data, ['notificationId']);
  const link = await db.doc(`accountClientLinks/${uid}`).get();
  if (!link.exists || link.data()?.status !== 'active') throw new HttpsError('permission-denied', 'Profilo non autorizzato');
  const ref = db.doc(`organizations/${link.data().organizationId}/notifications/${id(data.notificationId, 'notificationId')}`);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.recipientUid !== uid) throw new HttpsError('not-found', 'Notifica non trovata');
    if (!snap.data()?.readAt) tx.update(ref, { readAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
});

exports.submitMappingReport = callable(async (data, uid) => {
  const payload = validateReport(data);
  const link = await db.doc(`accountClientLinks/${uid}`).get();
  if (!link.exists || link.data()?.status !== 'active' || link.data()?.clientId !== payload.clientProfileId) {
    throw new HttpsError('permission-denied', 'Profilo cliente non autorizzato');
  }
  const { organizationId, clientId } = link.data();
  const client = await db.doc(`organizations/${organizationId}/clients/${clientId}`).get();
  if (!client.exists || client.data()?.authUid !== uid) throw new HttpsError('permission-denied', 'Profilo cliente non autorizzato');

  const key = reportKey({ organizationId, ...payload });
  const reportRef = db.doc(`organizations/${organizationId}/mappingReports/${key}`);
  const eventRef = reportRef.collection('events').doc(checksum(`${uid}:${key}:${payload.fingerprint}`).slice(0, 32));
  const limitRef = db.doc(`organizations/${organizationId}/rateLimits/mapping-${uid}`);
  await db.runTransaction(async tx => {
    const [existing, rate] = await Promise.all([tx.get(reportRef), tx.get(limitRef)]);
    const nowMs = Date.now();
    const windowStart = rate.data()?.windowStart?.toMillis?.() || 0;
    const count = nowMs - windowStart < 3600000 ? Number(rate.data()?.count || 0) : 0;
    if (count >= 30) throw new HttpsError('resource-exhausted', 'Troppe segnalazioni: riprova più tardi');
    tx.set(limitRef, {
      schemaVersion: 1,
      windowStart: count ? rate.data().windowStart : FieldValue.serverTimestamp(),
      count: count + 1,
      updatedAt: FieldValue.serverTimestamp()
    });
    if (existing.exists) {
      tx.update(reportRef, { occurrenceCount: FieldValue.increment(1), lastSeenAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    } else {
      tx.create(reportRef, {
        schemaVersion: 1, reportId: key, organizationId, clientId,
        clientRef: checksum(`${organizationId}:${clientId}`).slice(0, 16),
        normalizedFingerprint: payload.fingerprint,
        normalizedIngredient: payload.normalizedIngredient,
        ingredientText: payload.ingredientText,
        context: { slot: payload.slot, errorType: payload.errorType },
        ruleSet: { id: payload.ruleSetId, version: payload.ruleSetVersion },
        status: 'open', occurrenceCount: 1, resolution: null,
        firstSeenAt: FieldValue.serverTimestamp(), lastSeenAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        createdBy: uid, updatedBy: uid
      });
    }
    tx.create(eventRef, {
      schemaVersion: 1, type: 'mapping.reported', from: null,
      to: existing.exists ? existing.data().status : 'open', actorUid: uid,
      occurredAt: FieldValue.serverTimestamp()
    });
  });
  return { reportId: key, deduplicated: (await reportRef.get()).data().occurrenceCount > 1 };
});

exports.listMappingReports = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'status', 'pageSize', 'cursor']);
  const actor = await membership(data.organizationId, uid);
  const pageSize = Math.min(Math.max(Number(data.pageSize || 25), 1), 50);
  const status = data.status ? text(data.status, 'status') : null;
  if (status && !REPORT_STATUSES.has(status)) throw new HttpsError('invalid-argument', 'Stato non valido');
  let query = db.collection(`organizations/${actor.organizationId}/mappingReports`).orderBy('updatedAt', 'desc');
  if (status) query = query.where('status', '==', status);
  if (data.cursor) {
    const cursor = await db.doc(`organizations/${actor.organizationId}/mappingReports/${id(data.cursor, 'cursor')}`).get();
    if (cursor.exists) query = query.startAfter(cursor);
  }
  const snapshot = await query.limit(pageSize + 1).get();
  let rows = snapshot.docs;
  if (actor.role === 'nutritionist') {
    const authorized = new Set((await db.collection(`organizations/${actor.organizationId}/clients`).where('nutritionistUids', 'array-contains', uid).get()).docs.map(doc => doc.id));
    rows = rows.filter(doc => authorized.has(doc.data().clientId));
  }
  const hasMore = rows.length > pageSize;
  rows = rows.slice(0, pageSize);
  return {
    reports: rows.map(doc => ({ id: doc.id, ...doc.data(), clientId: undefined, createdBy: undefined })),
    nextCursor: hasMore ? rows.at(-1)?.id || null : null
  };
});

exports.proposeMapping = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'reportId', 'mapping', 'rationale', 'idempotencyKey']);
  const actor = await membership(data.organizationId, uid);
  const reportId = id(data.reportId, 'reportId');
  const mapping = validateMapping(data.mapping);
  const rationale = text(data.rationale, 'rationale', { min: 3, max: 500 });
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const proposalId = checksum(`${actor.organizationId}:${idem}`).slice(0, 32);
  const proposalRef = db.doc(`organizations/${actor.organizationId}/mappingProposals/${proposalId}`);
  const reportRef = db.doc(`organizations/${actor.organizationId}/mappingReports/${reportId}`);
  const eventId = checksum(`mapping.proposed:${proposalId}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [existing, report] = await Promise.all([tx.get(proposalRef), tx.get(reportRef)]);
    if (existing.exists) return;
    if (!report.exists) throw new HttpsError('not-found', 'Segnalazione non trovata');
    if (actor.role === 'nutritionist') await authorizedClient(actor, report.data().clientId);
    const body = { schemaVersion: 1, proposalId, reportId, scope: 'tenant', mapping, status: 'draft', version: '1', rationale };
    tx.create(proposalRef, { ...body, checksum: checksum(body), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid, updatedBy: uid });
    tx.update(reportRef, { status: 'needs-review', updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'mapping.proposed', actor, subject: { type: 'mappingProposal', id: proposalId }, idempotencyKey: idem }));
  });
  return { proposalId };
});

exports.publishMapping = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'proposalId', 'targetScope', 'idempotencyKey']);
  const targetScope = text(data.targetScope, 'targetScope', { pattern: /^(tenant|global)$/ });
  const proposalId = id(data.proposalId, 'proposalId');
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  let actor;
  if (targetScope === 'global') actor = await platformAdmin(uid);
  else actor = await membership(data.organizationId, uid);
  const orgId = id(data.organizationId, 'organizationId');
  const proposalRef = db.doc(`organizations/${orgId}/mappingProposals/${proposalId}`);
  const proposal = await proposalRef.get();
  if (!proposal.exists) throw new HttpsError('not-found', 'Proposta non trovata');
  const mappingId = proposal.data().mapping.canonicalIngredientId;
  const version = String(Date.now());
  const target = targetScope === 'global'
    ? db.doc(`globalMappings/${mappingId}/versions/${version}`)
    : db.doc(`organizations/${orgId}/mappings/${mappingId}/versions/${version}`);
  const catalogRef = targetScope === 'global'
    ? db.doc('globalMappingCatalog/current')
    : db.doc(`organizations/${orgId}/mappingCatalog/current`);
  const eventId = checksum(`mapping.published:${targetScope}:${proposalId}:${idem}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [audit, fresh, catalog] = await Promise.all([
      tx.get(auditRef(orgId, eventId)), tx.get(proposalRef), tx.get(catalogRef)
    ]);
    if (audit.exists || fresh.data()?.status === 'published') return;
    const published = { schemaVersion: 1, mappingId, version, scope: targetScope, status: 'published', mapping: fresh.data().mapping, checksum: fresh.data().checksum, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid, updatedBy: uid, publishedAt: FieldValue.serverTimestamp(), publishedBy: uid };
    const entries = { ...(catalog.data()?.entries || {}), [mappingId]: { version, mapping: fresh.data().mapping, checksum: fresh.data().checksum } };
    tx.create(target, published);
    tx.set(catalogRef, { schemaVersion: 1, scope: targetScope, entries, checksum: checksum(entries), updatedAt: FieldValue.serverTimestamp(), updatedBy: uid }, { merge: true });
    tx.update(proposalRef, { status: 'published', scope: targetScope, publishedAt: FieldValue.serverTimestamp(), publishedBy: uid, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.update(db.doc(`organizations/${orgId}/mappingReports/${fresh.data().reportId}`), { status: 'resolved', resolution: { mappingId, version, scope: targetScope }, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.create(auditRef(orgId, eventId), auditEvent({ orgId, eventId, type: 'mapping.published', actor, subject: { type: 'mapping', id: mappingId }, idempotencyKey: idem, metadata: { version, scope: targetScope } }));
  });
  return { mappingId, version, scope: targetScope };
});

exports.listAuthorizedClients = callable(async (data, uid) => {
  exactObject(data, ['organizationId']);
  const actor = await membership(data.organizationId, uid);
  let query = db.collection(`organizations/${actor.organizationId}/clients`).where('status', '==', 'active');
  if (actor.role === 'nutritionist') query = query.where('nutritionistUids', 'array-contains', uid);
  const snapshot = await query.limit(100).get();
  return { clients: snapshot.docs.map(doc => ({ id: doc.id, displayCode: doc.data().displayCode || doc.id, activeAssignment: doc.data().activeAssignment || null })) };
});

exports.publishRuleSetVersion = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'scope', 'ruleSetId', 'version', 'rules', 'overrides', 'effectiveAt', 'changelog', 'reviewNotes', 'idempotencyKey']);
  const scope = text(data.scope, 'scope', { pattern: /^(tenant|global)$/ });
  const orgId = id(data.organizationId, 'organizationId');
  const actor = scope === 'global' ? await platformAdmin(uid) : await membership(orgId, uid);
  const ruleSetId = id(data.ruleSetId, 'ruleSetId');
  const version = id(String(data.version), 'version');
  const rules = validateRuleSetRules(data.rules);
  const overrides = Array.isArray(data.overrides) ? data.overrides : [];
  const effectiveAt = new Date(text(data.effectiveAt, 'effectiveAt', { max: 40 }));
  if (!Number.isFinite(effectiveAt.getTime())) throw new HttpsError('invalid-argument', 'effectiveAt non valida');
  const changelog = text(data.changelog, 'changelog', { min: 3, max: 2000 });
  const reviewNotes = optionalText(data.reviewNotes, 'reviewNotes', 2000);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const rootRef = scope === 'global'
    ? db.doc(`globalRuleSets/${ruleSetId}`)
    : db.doc(`organizations/${orgId}/ruleSets/${ruleSetId}`);
  const versionRef = rootRef.collection('versions').doc(version);
  const body = { schemaVersion: 1, ruleSetId, version, rules, overrides };
  const ruleChecksum = checksum(body);
  const eventId = checksum(`ruleset.published:${scope}:${ruleSetId}:${version}:${idem}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [root, existing, audit] = await Promise.all([tx.get(rootRef), tx.get(versionRef), tx.get(auditRef(orgId, eventId))]);
    if (existing.exists) {
      if (existing.data()?.checksum === ruleChecksum) return;
      throw new HttpsError('already-exists', 'Questa versione esiste già ed è immutabile');
    }
    if (scope === 'tenant' && actor.role === 'nutritionist' && root.exists && root.data()?.createdBy !== uid) {
      throw new HttpsError('permission-denied', 'Il nutrizionista può modificare soltanto i propri rule set');
    }
    if (audit.exists) return;
    const common = { schemaVersion: 1, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid };
    tx.set(rootRef, { ...common, ruleSetId, scope, createdAt: root.exists ? root.data().createdAt : FieldValue.serverTimestamp(), createdBy: root.exists ? root.data().createdBy : uid, latestPublishedVersion: version, latestChecksum: ruleChecksum }, { merge: true });
    tx.create(versionRef, { ...body, scope, status: 'published', checksum: ruleChecksum, compatibleClientSchema: 1, effectiveAt: Timestamp.fromDate(effectiveAt), changelog, reviewNotes, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid, updatedBy: uid, publishedAt: FieldValue.serverTimestamp(), publishedBy: uid });
    tx.create(auditRef(orgId, eventId), auditEvent({ orgId, eventId, type: 'ruleset.published', actor, subject: { type: 'ruleSetVersion', id: `${ruleSetId}:${version}` }, idempotencyKey: idem, metadata: { scope, checksum: ruleChecksum } }));
  });
  return { ruleSetId, version, checksum: ruleChecksum, scope };
});

exports.previewClientRuleSet = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'clientId', 'ruleSet']);
  exactObject(data.ruleSet, ['scope', 'ruleSetId', 'version', 'checksum'], 'ruleSet');
  const actor = await membership(data.organizationId, uid);
  const client = await authorizedClient(actor, data.clientId);
  const pointer = {
    scope: text(data.ruleSet.scope, 'ruleSet.scope', { pattern: /^(global|tenant)$/ }),
    ruleSetId: id(data.ruleSet.ruleSetId, 'ruleSet.ruleSetId'),
    version: id(String(data.ruleSet.version), 'ruleSet.version'),
    checksum: text(data.ruleSet.checksum, 'ruleSet.checksum', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ })
  };
  const nextSnap = await (await ruleVersionRef(actor.organizationId, pointer)).get();
  if (!nextSnap.exists || !verifiedRuleVersion(nextSnap.data(), pointer)) throw new HttpsError('failed-precondition', 'Versione non valida');
  let previousRules = [];
  const activeId = client.activeAssignment?.assignmentId;
  if (activeId) {
    const active = await client.ref.collection('assignments').doc(activeId).get();
    if (active.exists) {
      const previous = await (await ruleVersionRef(actor.organizationId, active.data().ruleSet)).get();
      if (previous.exists) previousRules = previous.data().rules || [];
    }
  }
  const previous = new Map(previousRules.map(rule => [rule.family, rule]));
  const next = new Map((nextSnap.data().rules || []).map(rule => [rule.family, rule]));
  const added = [...next.keys()].filter(key => !previous.has(key));
  const removed = [...previous.keys()].filter(key => !next.has(key));
  const changed = [...next.keys()].filter(key => previous.has(key) && checksum(next.get(key).slots) !== checksum(previous.get(key).slots)).map(family => ({ family, before: previous.get(family).slots, after: next.get(family).slots }));
  return { from: client.activeAssignment?.ruleSet || null, to: pointer, summary: { added, removed, changed, totalChanges: added.length + removed.length + changed.length } };
});

exports.assignClientRuleSet = callable(async (data, uid) => {
  const input = validateAssignment(data);
  const actor = await membership(input.organizationId, uid);
  const client = await authorizedClient(actor, input.clientId);
  const versionRef = await ruleVersionRef(actor.organizationId, input.ruleSet);
  const version = await versionRef.get();
  if (!version.exists || !verifiedRuleVersion(version.data(), input.ruleSet)) {
    throw new HttpsError('failed-precondition', 'Versione rule set non pubblicata o checksum non valido');
  }
  const assignmentId = checksum(`${actor.organizationId}:${input.clientId}:${input.idempotencyKey}`).slice(0, 32);
  const assignmentRef = client.ref.collection('assignments').doc(assignmentId);
  const stateRef = client.ref.collection('state').doc('activeAssignment');
  const eventId = checksum(`assignment.created:${assignmentId}`).slice(0, 32);
  const now = new Date();
  const immediate = input.effectiveAt <= now;
  await db.runTransaction(async tx => {
    const [existing, state] = await Promise.all([tx.get(assignmentRef), tx.get(stateRef)]);
    if (existing.exists) return;
    const previousAssignmentId = state.data()?.assignmentId || null;
    if (immediate && previousAssignmentId) {
      tx.update(client.ref.collection('assignments').doc(previousAssignmentId), { status: 'revoked', revocationReason: 'Sostituito da una nuova assegnazione', updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    }
    tx.create(assignmentRef, {
      schemaVersion: 1, assignmentId, clientId: client.id, ruleSet: input.ruleSet,
      status: immediate ? 'active' : 'scheduled', effectiveAt: Timestamp.fromDate(input.effectiveAt),
      expiresAt: input.expiresAt ? Timestamp.fromDate(input.expiresAt) : null,
      strategy: input.strategy, reason: input.reason, previousAssignmentId, idempotencyKey: input.idempotencyKey,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid, updatedBy: uid
    });
    if (immediate) {
      tx.set(stateRef, { schemaVersion: 1, assignmentId, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
      tx.update(client.ref, { activeAssignment: { assignmentId, ruleSet: input.ruleSet }, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    }
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'assignment.created', actor, subject: { type: 'assignment', id: assignmentId }, idempotencyKey: input.idempotencyKey, metadata: { clientId: client.id, ruleSet: input.ruleSet, effectiveAt: input.effectiveAt.toISOString() } }));
    if (client.authUid) {
      tx.create(db.doc(`organizations/${actor.organizationId}/notifications/${eventId}`), {
        schemaVersion: 1, notificationId: eventId, recipientUid: client.authUid,
        type: immediate ? 'profile.assigned' : 'profile.scheduled', subjectId: assignmentId,
        readAt: null, dedupeKey: eventId, createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(), delivery: { inApp: 'pending', email: 'disabled' }
      });
    }
  });
  return { assignmentId, status: immediate ? 'active' : 'scheduled', requiresClientConfirmation: true };
});

// DEPRECATO (Fase 2): la console usa listDietStructures. Mantenuto per i
// client già rilasciati che risolvono ancora ruleSets legacy.
exports.listRuleSets = callable(async (data, uid) => {
  exactObject(data, ['organizationId']);
  const actor = await membership(data.organizationId, uid);
  let query = db.collection(`organizations/${actor.organizationId}/ruleSets`);
  if (actor.role === 'nutritionist') query = query.where('createdBy', '==', uid);
  const snapshot = await query.limit(50).get();
  const ruleSets = snapshot.docs
    .map(doc => ({
      ruleSetId: doc.id,
      latestPublishedVersion: doc.data().latestPublishedVersion || null,
      updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || null
    }))
    .filter(item => item.latestPublishedVersion)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { ruleSets };
});

// Assegnazione v2: niente Ambito/Versione/Strategia/anteprima dal client.
// Revisione e checksum sono risolti server-side dalla pubblicazione più
// recente; il backend rifiuta payload senza scadenza se senza flag esplicito.
// Le note restano visibili solo al personale autorizzato.
//
// Fase 2: il percorso operativo risolve `structureId` dalle dietStructures
// (pointer {structureId, revisionId, checksum} sull'assignment). Il percorso
// `ruleSetId` resta SOLO per retrocompatibilità dei client già rilasciati.
exports.assignClientStructure = callable(async (data, uid) => {
  const input = validateStructureAssignment(data);
  const actor = await membership(input.organizationId, uid);
  const client = await authorizedClient(actor, input.clientId);
  let structurePointer = null;
  let legacyPointer = null;
  let structureName = null;
  if (input.structureId) {
    const { doc } = await authorizedStructure(actor, input.structureId);
    if (doc.data().status === 'archived') {
      throw new HttpsError('failed-precondition', 'La struttura è archiviata: riattivala prima di assegnarla');
    }
    const revisionId = doc.data().currentRevisionId;
    const revisionChecksum = doc.data().latestChecksum;
    if (!revisionId || !revisionChecksum) {
      throw new HttpsError('not-found', 'Struttura dieta non trovata o senza pubblicazioni');
    }
    const revision = await doc.ref.collection('revisions').doc(String(revisionId)).get();
    if (!revision.exists || revision.data().checksum !== revisionChecksum || !verifyStructureRevision(revision.data())) {
      throw new HttpsError('failed-precondition', 'Pubblicazione della struttura non valida');
    }
    structurePointer = { structureId: doc.id, revisionId: String(revisionId), checksum: revisionChecksum };
    structureName = doc.data().name || doc.id;
  } else {
    const rootRef = db.doc(`organizations/${actor.organizationId}/ruleSets/${input.ruleSetId}`);
    const root = await rootRef.get();
    if (!root.exists || !root.data()?.latestPublishedVersion || !root.data()?.latestChecksum) {
      throw new HttpsError('not-found', 'Struttura dieta non trovata o senza pubblicazioni');
    }
    if (actor.role === 'nutritionist' && root.data().createdBy !== uid) {
      throw new HttpsError('permission-denied', 'Puoi assegnare soltanto le tue strutture dieta');
    }
    legacyPointer = {
      scope: 'tenant', ruleSetId: input.ruleSetId,
      version: root.data().latestPublishedVersion,
      checksum: root.data().latestChecksum
    };
    const versionRef = await ruleVersionRef(actor.organizationId, legacyPointer);
    const versionDoc = await versionRef.get();
    if (!versionDoc.exists || !verifiedRuleVersion(versionDoc.data(), legacyPointer)) {
      throw new HttpsError('failed-precondition', 'Pubblicazione della struttura non valida');
    }
  }
  const notesMetadata = input.notes ? { notes: input.notes, notesVisibility: 'staff' } : {};
  const assignmentId = checksum(`${actor.organizationId}:${input.clientId}:${input.idempotencyKey}`).slice(0, 32);
  const assignmentRef = client.ref.collection('assignments').doc(assignmentId);
  const stateRef = client.ref.collection('state').doc('activeAssignment');
  const eventId = checksum(`assignment.created:${assignmentId}`).slice(0, 32);
  const now = new Date();
  const immediate = input.effectiveAt <= now;
  // Audit: il percorso v2 registra structureId + revisionId (mai il checksum
  // in chiaro verso la console: resta nel documento interno e nello snapshot).
  const auditMetadata = structurePointer
    ? { clientId: client.id, structureId: structurePointer.structureId, revisionId: structurePointer.revisionId, effectiveAt: input.effectiveAt.toISOString(), expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null, withoutExpiration: input.withoutExpiration }
    : { clientId: client.id, ruleSetId: legacyPointer.ruleSetId, revision: legacyPointer.version, effectiveAt: input.effectiveAt.toISOString(), expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null, withoutExpiration: input.withoutExpiration };
  const projection = structurePointer
    ? { assignmentId, structureId: structurePointer.structureId, structureName }
    : { assignmentId, ruleSet: legacyPointer };
  await db.runTransaction(async tx => {
    const [existing, state] = await Promise.all([tx.get(assignmentRef), tx.get(stateRef)]);
    if (existing.exists) return;
    const previousAssignmentId = state.data()?.assignmentId || null;
    if (immediate && previousAssignmentId) {
      tx.update(client.ref.collection('assignments').doc(previousAssignmentId), { status: 'revoked', revocationReason: 'Sostituito da una nuova assegnazione', updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    }
    tx.create(assignmentRef, {
      schemaVersion: structurePointer ? 2 : 1, assignmentId, clientId: client.id,
      ...(structurePointer ? { structure: structurePointer, structureName } : { ruleSet: legacyPointer }),
      status: immediate ? 'active' : 'scheduled', effectiveAt: Timestamp.fromDate(input.effectiveAt),
      expiresAt: input.expiresAt ? Timestamp.fromDate(input.expiresAt) : null,
      withoutExpiration: input.withoutExpiration,
      strategy: 'migrate-on-confirmation', reason: input.notes || 'Assegnazione da console',
      notesVisibility: 'staff', ...notesMetadata,
      previousAssignmentId, idempotencyKey: input.idempotencyKey,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid, updatedBy: uid
    });
    if (immediate) {
      tx.set(stateRef, { schemaVersion: 1, assignmentId, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
      tx.update(client.ref, { activeAssignment: projection, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    }
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'assignment.created', actor, subject: { type: 'assignment', id: assignmentId }, idempotencyKey: input.idempotencyKey, metadata: auditMetadata }));
    if (client.authUid) {
      tx.create(db.doc(`organizations/${actor.organizationId}/notifications/${eventId}`), {
        schemaVersion: 1, notificationId: eventId, recipientUid: client.authUid,
        type: immediate ? 'profile.assigned' : 'profile.scheduled', subjectId: assignmentId,
        readAt: null, dedupeKey: eventId, createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(), delivery: { inApp: 'pending', email: 'disabled' }
      });
    }
  });
  // La risposta NON include mai il checksum: le versioni chiuse sono interne.
  return { assignmentId, status: immediate ? 'active' : 'scheduled' };
});

// Sezione "Strutture dieta" (schema v2, docs/schema-catalogo-strutture-v2.json):
// aggregato mutabile + revisioni immutabili, privacy per ownerUid. Il
// nutritionist vede/tocca solo le proprie strutture; l'admin org le vede
// tutte. Niente campo "Versione" verso l'UI; il checksum è riservato all'admin.

function structureDoc(structure, { includeChecksum = false } = {}) {
  const data = structure.data();
  const doc = {
    id: structure.id,
    name: data.name || structure.id,
    status: data.status || 'active',
    ownerUid: data.ownerUid || data.createdBy || null,
    createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
    currentRevisionId: data.currentRevisionId || null,
    ruleCount: data.ruleCount ?? null,
    alternativeGroupCount: data.alternativeGroupCount ?? 0,
    ingredientCatalogVersion: data.ingredientCatalogVersion ?? null
  };
  if (includeChecksum) doc.latestChecksum = data.latestChecksum || null;
  return doc;
}

// Riferimenti al catalogo globale: ogni ingrediente e categoria citati dalla
// revisione devono esistere (e non essere archiviati) al momento della
// pubblicazione. Le dosi restano nella struttura; il catalogo non ne ha.
function assertCatalogReferences({ rules, alternativeGroups }, lookup) {
  rules.forEach(rule => {
    (rule.ingredientIds || []).forEach(ingredientId => {
      if (!lookup.ingredientIds.has(ingredientId)) {
        throw new HttpsError('failed-precondition', `Ingrediente "${ingredientId}" inesistente o archiviato in catalogo (famiglia ${rule.mellerFamilyId})`);
      }
    });
    if (rule.categoryId && rule.categoryId !== 'free' && !lookup.categoryIds.has(rule.categoryId)) {
      throw new HttpsError('failed-precondition', `Categoria "${rule.categoryId}" inesistente in catalogo (famiglia ${rule.mellerFamilyId})`);
    }
  });
  (alternativeGroups || []).forEach(group => {
    (group.items || []).forEach(item => {
      if (!lookup.ingredientIds.has(item.ingredientId)) {
        throw new HttpsError('failed-precondition', `Ingrediente "${item.ingredientId}" inesistente o archiviato in catalogo (gruppo ${group.alternativeGroupId})`);
      }
    });
  });
}

async function authorizedStructure(actor, structureId, { mustOwn = false } = {}) {
  const ref = db.doc(`organizations/${actor.organizationId}/dietStructures/${structureId}`);
  const doc = await ref.get();
  if (!doc.exists) throw new HttpsError('not-found', 'Struttura dieta non trovata');
  if ((mustOwn || actor.role === 'nutritionist') && (doc.data().ownerUid || doc.data().createdBy) !== actor.uid) {
    throw new HttpsError('permission-denied', 'Puoi gestire soltanto le tue strutture dieta');
  }
  return { ref, doc };
}

exports.listDietStructures = callable(async (data, uid) => {
  exactObject(data, ['organizationId']);
  const actor = await membership(data.organizationId, uid);
  let query = db.collection(`organizations/${actor.organizationId}/dietStructures`);
  if (actor.role === 'nutritionist') query = query.where('ownerUid', '==', uid);
  const snapshot = await query.limit(100).get();
  const structures = snapshot.docs
    .map(doc => structureDoc(doc))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { structures };
});

exports.getDietStructureRevision = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'structureId', 'revisionId']);
  const actor = await membership(data.organizationId, uid);
  const { doc } = await authorizedStructure(actor, data.structureId);
  const revisionId = data.revisionId == null || data.revisionId === ''
    ? doc.data().currentRevisionId
    : id(String(data.revisionId), 'revisionId');
  if (!revisionId) throw new HttpsError('not-found', 'Nessuna revisione pubblicata');
  const revision = await doc.ref.collection('revisions').doc(revisionId).get();
  if (!revision.exists) throw new HttpsError('not-found', 'Revisione non trovata');
  const structure = structureDoc(doc, { includeChecksum: actor.role === 'admin' });
  return {
    structure,
    revision: {
      revisionId: revision.id,
      rules: revision.data().rules || [],
      alternativeGroups: revision.data().alternativeGroups || [],
      ingredientCatalogVersion: revision.data().ingredientCatalogVersion ?? null,
      checksum: actor.role === 'admin' ? revision.data().checksum || null : undefined,
      publishedAt: revision.data().publishedAt?.toDate?.()?.toISOString() || null,
      changelog: revision.data().changelog || null,
      restoredFromRevisionId: revision.data().restoredFromRevisionId || null
    }
  };
});

exports.createDietStructure = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'name', 'rules', 'alternativeGroups', 'idempotencyKey']);
  const actor = await membership(data.organizationId, uid);
  const name = text(data.name, 'name', { min: 3, max: 80 });
  const rules = validateDietStructureRules(data.rules);
  const alternativeGroups = validateAlternativeGroups(data.alternativeGroups);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const catalog = await loadGlobalCatalog();
  assertCatalogReferences({ rules, alternativeGroups }, catalogLookup(catalog));
  const structureId = checksum(`${actor.organizationId}:${uid}:${name}:${idem}`).slice(0, 24);
  const ref = db.doc(`organizations/${actor.organizationId}/dietStructures/${structureId}`);
  const revisionChecksum = structureRevisionChecksum({ schemaVersion: STRUCTURE_REVISION_SCHEMA_VERSION, rules, alternativeGroups });
  const eventId = checksum(`structure.created:${structureId}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [existing, audit] = await Promise.all([tx.get(ref), tx.get(auditRef(actor.organizationId, eventId))]);
    if (existing.exists || audit.exists) return;
    tx.create(ref, {
      schemaVersion: 1, name, status: 'active', ownerUid: uid, createdBy: uid,
      currentRevisionId: '1', latestChecksum: revisionChecksum, ruleCount: rules.length,
      alternativeGroupCount: alternativeGroups.length, ingredientCatalogVersion: catalog.catalogVersion,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(ref.collection('revisions').doc('1'), {
      schemaVersion: STRUCTURE_REVISION_SCHEMA_VERSION, revisionId: '1', structureId, rules, alternativeGroups,
      status: 'published', checksum: revisionChecksum, ingredientCatalogVersion: catalog.catalogVersion,
      compatibleClientSchema: 6, changelog: 'Prima revisione', createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(), createdBy: uid, publishedAt: FieldValue.serverTimestamp(), publishedBy: uid
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'structure.created', actor, subject: { type: 'dietStructure', id: structureId }, idempotencyKey: idem, metadata: { name, ruleCount: rules.length, alternativeGroupCount: alternativeGroups.length, ingredientCatalogVersion: catalog.catalogVersion } }));
  });
  return { structureId, revisionId: '1' };
});

exports.updateDietStructureRevision = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'structureId', 'name', 'rules', 'alternativeGroups', 'changelog', 'restoredFromRevisionId', 'idempotencyKey']);
  const actor = await membership(data.organizationId, uid);
  const rules = validateDietStructureRules(data.rules);
  const alternativeGroups = validateAlternativeGroups(data.alternativeGroups);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const name = optionalText(data.name, 'name', 80);
  const changelog = optionalText(data.changelog, 'changelog', 500);
  const restoredFrom = optionalText(data.restoredFromRevisionId, 'restoredFromRevisionId', 40);
  const { ref, doc } = await authorizedStructure(actor, data.structureId, { mustOwn: actor.role === 'nutritionist' });
  if (doc.data().status === 'archived') throw new HttpsError('failed-precondition', 'Riattiva la struttura prima di pubblicare una nuova revisione');
  const catalog = await loadGlobalCatalog();
  assertCatalogReferences({ rules, alternativeGroups }, catalogLookup(catalog));
  const nextRevisionId = String(Number(doc.data().currentRevisionId || '0') + 1);
  const revisionChecksum = structureRevisionChecksum({ schemaVersion: STRUCTURE_REVISION_SCHEMA_VERSION, rules, alternativeGroups });
  const eventId = checksum(`structure.revision:${ref.id}:${nextRevisionId}:${idem}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const audit = await tx.get(auditRef(actor.organizationId, eventId));
    if (audit.exists) return;
    tx.update(ref, {
      ...(name ? { name } : {}),
      currentRevisionId: nextRevisionId, latestChecksum: revisionChecksum, ruleCount: rules.length,
      alternativeGroupCount: alternativeGroups.length, ingredientCatalogVersion: catalog.catalogVersion,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    });
    tx.create(ref.collection('revisions').doc(nextRevisionId), {
      schemaVersion: STRUCTURE_REVISION_SCHEMA_VERSION, revisionId: nextRevisionId, structureId: ref.id, rules, alternativeGroups,
      status: 'published', checksum: revisionChecksum, ingredientCatalogVersion: catalog.catalogVersion,
      compatibleClientSchema: 6, changelog: changelog || (restoredFrom ? `Ripristino dalla revisione ${restoredFrom}` : 'Nuova revisione'),
      restoredFromRevisionId: restoredFrom || null,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      createdBy: uid, publishedAt: FieldValue.serverTimestamp(), publishedBy: uid
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'structure.revision.published', actor, subject: { type: 'dietStructure', id: ref.id }, idempotencyKey: idem, metadata: { revisionId: nextRevisionId, restoredFromRevisionId: restoredFrom || null, alternativeGroupCount: alternativeGroups.length, ingredientCatalogVersion: catalog.catalogVersion } }));
  });
  return { structureId: ref.id, revisionId: nextRevisionId };
});

exports.archiveDietStructure = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'structureId', 'archived', 'idempotencyKey']);
  const actor = await membership(data.organizationId, uid);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  if (typeof data.archived !== 'boolean') throw new HttpsError('invalid-argument', 'archived deve essere booleano');
  const { ref } = await authorizedStructure(actor, data.structureId, { mustOwn: actor.role === 'nutritionist' });
  const eventId = checksum(`structure.status:${ref.id}:${data.archived}:${idem}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const audit = await tx.get(auditRef(actor.organizationId, eventId));
    if (audit.exists) return;
    tx.update(ref, { status: data.archived ? 'archived' : 'active', updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: data.archived ? 'structure.archived' : 'structure.restored', actor, subject: { type: 'dietStructure', id: ref.id }, idempotencyKey: idem, metadata: {} }));
  });
  return { structureId: ref.id, status: data.archived ? 'archived' : 'active' };
});

// CONFRONTA (sola lettura, matrice server-side): confronta le revisioni
// correnti di 2-8 strutture. Il nutritionist può confrontare solo le proprie;
// l'admin tutte. Non modifica dati; le differenze sono calcolate per famiglia
// (presenza, stato, ingredienti, dosi) e per gruppi alternativi.
exports.compareDietStructures = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'structureIds']);
  const actor = await membership(data.organizationId, uid);
  if (!Array.isArray(data.structureIds)) throw new HttpsError('invalid-argument', 'structureIds non valido');
  const ids = [...new Set(data.structureIds.map(value => id(value, 'structureId')))];
  if (ids.length < 2 || ids.length > 8) {
    throw new HttpsError('invalid-argument', 'Seleziona da 2 a 8 strutture da confrontare');
  }
  const loaded = [];
  for (const structureId of ids) {
    const { doc } = await authorizedStructure(actor, structureId);
    const revisionId = doc.data().currentRevisionId;
    const revision = revisionId ? await doc.ref.collection('revisions').doc(String(revisionId)).get() : null;
    loaded.push({
      structure: structureDoc(doc),
      revision: revision?.exists ? revision.data() : null
    });
  }
  const familyIds = new Set();
  loaded.forEach(({ revision }) => (revision?.rules || []).forEach(rule => {
    if (rule?.mellerFamilyId) familyIds.add(rule.mellerFamilyId);
  }));
  const rows = [...familyIds].sort((a, b) => String(a).localeCompare(String(b), 'it')).map(family => {
    const cells = {};
    loaded.forEach(({ structure, revision }) => {
      const rule = (revision?.rules || []).find(item => item?.mellerFamilyId === family);
      cells[structure.id] = rule
        ? { present: true, enabled: rule.enabled !== false, ingredientCount: (rule.ingredientIds || []).length, quantityGrams: rule.quantityGrams || null }
        : { present: false };
    });
    const signatures = new Set(loaded.map(({ structure }) => checksum(cells[structure.id])));
    return { mellerFamilyId: family, cells, differs: signatures.size > 1 };
  });
  const groupIds = new Set();
  loaded.forEach(({ revision }) => (revision?.alternativeGroups || []).forEach(group => {
    if (group?.alternativeGroupId) groupIds.add(group.alternativeGroupId);
  }));
  const groupRows = [...groupIds].sort((a, b) => String(a).localeCompare(String(b), 'it')).map(groupId => {
    const cells = {};
    loaded.forEach(({ structure, revision }) => {
      const group = (revision?.alternativeGroups || []).find(item => item?.alternativeGroupId === groupId);
      cells[structure.id] = group
        ? { present: true, displayName: group.displayName || groupId, itemCount: (group.items || []).length }
        : { present: false };
    });
    const signatures = new Set(loaded.map(({ structure }) => checksum(cells[structure.id])));
    return { alternativeGroupId: groupId, cells, differs: signatures.size > 1 };
  });
  return {
    structures: loaded.map(({ structure }) => ({
      id: structure.id, name: structure.name, status: structure.status,
      ruleCount: structure.ruleCount, alternativeGroupCount: structure.alternativeGroupCount,
      updatedAt: structure.updatedAt
    })),
    rows,
    groupRows,
    comparedAt: new Date().toISOString()
  };
});

// ---- Import catalogo globale (platform admin, docs/catalog-import-format.md) ----

// Feature flag CATALOG_IMPORT_ENABLED: variabile d'ambiente se impostata,
// altrimenti documento config, altrimenti default sicuro (ON in emulatore per
// i test, OFF in produzione finché il catalogo Meller non è approvato).
async function catalogImportConfig() {
  const flag = process.env.CATALOG_IMPORT_ENABLED;
  if (flag === 'true') return { enabled: true, source: 'env' };
  if (flag === 'false') return { enabled: false, source: 'env' };
  const doc = await db.doc('globalIngredientCatalog/config/import').get();
  if (doc.exists && typeof doc.data()?.enabled === 'boolean') {
    return { enabled: doc.data().enabled, source: 'firestore' };
  }
  return { enabled: Boolean(process.env.FIRESTORE_EMULATOR_HOST), source: 'default' };
}

function canonicalCatalogEntry(item, kind) {
  if (kind === 'category') {
    return {
      categoryId: item.categoryId, displayName: item.displayName,
      description: item.description || null, sortOrder: Number(item.sortOrder || 0),
      status: item.status || 'active'
    };
  }
  return {
    ingredientId: item.ingredientId, displayName: item.displayName,
    categoryId: item.categoryId, aliases: [...(item.aliases || [])].sort(),
    mappingKind: item.mappingKind, mellerFamilyId: item.mellerFamilyId || null,
    status: item.status || 'active'
  };
}

function catalogContentChecksum(ingredients, categories, catalogVersion) {
  const byIngredient = (a, b) => String(a.ingredientId).localeCompare(String(b.ingredientId));
  const byCategory = (a, b) => String(a.categoryId).localeCompare(String(b.categoryId));
  return checksum({
    schemaVersion: 2,
    catalogVersion,
    ingredients: ingredients.map(item => canonicalCatalogEntry(item, 'ingredient')).sort(byIngredient),
    categories: categories.map(item => canonicalCatalogEntry(item, 'category')).sort(byCategory)
  });
}

// Limite transazionale: commit/restore atomici in UNA transazione Firestore
// (max 500 scritture). File più grandi vanno suddivisi.
const CATALOG_COMMIT_WRITE_LIMIT = 400;

exports.importGlobalIngredientCatalog = callable(async (data, uid) => {
  exactObject(data, ['format', 'mode', 'payload', 'previewId', 'confirm', 'restoreVersion']);
  const actor = await platformAdmin(uid);
  const mode = text(data.mode == null || data.mode === '' ? 'dry-run' : data.mode, 'mode');
  if (!CATALOG_IMPORT_MODES.has(mode)) throw new HttpsError('invalid-argument', 'mode non valido (dry-run|commit|restore)');
  const metaRef = db.doc('globalIngredientCatalog/current/meta/summary');

  if (mode === 'restore') {
    const config = await catalogImportConfig();
    if (!config.enabled) throw new HttpsError('failed-precondition', 'Import catalogo disabilitato (flag CATALOG_IMPORT_ENABLED)');
    if (data.confirm !== true) throw new HttpsError('failed-precondition', 'Ripristino richiede conferma esplicita (confirm: true)');
    const restoreVersion = Number(data.restoreVersion);
    if (!Number.isInteger(restoreVersion) || restoreVersion < 0) {
      throw new HttpsError('invalid-argument', 'restoreVersion non valida');
    }
    const [snapshot, catalog] = await Promise.all([
      db.doc(`globalIngredientCatalog/versions/${restoreVersion}`).get(),
      loadGlobalCatalog()
    ]);
    if (!snapshot.exists) throw new HttpsError('not-found', 'Snapshot non trovato');
    if (restoreVersion === catalog.catalogVersion) {
      throw new HttpsError('failed-precondition', 'La versione richiesta è già quella corrente');
    }
    const snapIngredients = Array.isArray(snapshot.data().ingredients) ? snapshot.data().ingredients : [];
    const snapCategories = Array.isArray(snapshot.data().categories) ? snapshot.data().categories : [];
    const snapIds = new Set(snapIngredients.map(item => item?.ingredientId).filter(Boolean));
    const snapCatIds = new Set(snapCategories.map(item => item?.categoryId).filter(Boolean));
    // La categoria riservata 'free' non si cancella mai con un ripristino.
    const deleteIds = catalog.ingredients.map(item => item.ingredientId).filter(idValue => !snapIds.has(idValue));
    const deleteCatIds = catalog.categories.map(item => item.categoryId).filter(idValue => idValue !== 'free' && !snapCatIds.has(idValue));
    const totalWrites = snapIngredients.length + snapCategories.length + deleteIds.length + deleteCatIds.length + 3;
    if (totalWrites > 500) throw new HttpsError('failed-precondition', 'Ripristino troppo grande per una transazione atomica: contatta il supporto');
    const nextVersion = catalog.catalogVersion + 1;
    const restoredChecksum = catalogContentChecksum(snapIngredients, snapCategories, nextVersion);
    const eventId = checksum(`catalog.restored:${restoreVersion}:${nextVersion}`).slice(0, 32);
    const currentSnapshot = JSON.stringify({ ingredients: catalog.ingredients, categories: catalog.categories });
    if (currentSnapshot.length > 950000) throw new HttpsError('failed-precondition', 'Catalogo corrente troppo grande per lo snapshot: contatta il supporto');
    await db.runTransaction(async tx => {
      const fresh = await tx.get(metaRef);
      if (Number(fresh.data()?.catalogVersion || 0) !== catalog.catalogVersion) {
        throw new HttpsError('failed-precondition', 'Il catalogo è cambiato durante il ripristino: riprova');
      }
      if ((await tx.get(platformAuditRef(eventId))).exists) return;
      snapIngredients.forEach(entry => {
        tx.set(db.doc(`globalIngredientCatalog/current/ingredients/${entry.ingredientId}`), {
          ...entry, schemaVersion: 2, catalogVersion: nextVersion, updatedAt: FieldValue.serverTimestamp()
        });
      });
      snapCategories.forEach(entry => {
        tx.set(db.doc(`globalIngredientCatalog/current/categories/${entry.categoryId}`), {
          ...entry, schemaVersion: 2, catalogVersion: nextVersion, updatedAt: FieldValue.serverTimestamp()
        });
      });
      deleteIds.forEach(idValue => tx.delete(db.doc(`globalIngredientCatalog/current/ingredients/${idValue}`)));
      deleteCatIds.forEach(idValue => tx.delete(db.doc(`globalIngredientCatalog/current/categories/${idValue}`)));
      tx.set(db.doc(`globalIngredientCatalog/versions/${catalog.catalogVersion}`), {
        schemaVersion: 2, catalogVersion: catalog.catalogVersion, checksum: catalog.checksum,
        ingredients: catalog.ingredients, categories: catalog.categories,
        supersededBy: nextVersion, createdAt: FieldValue.serverTimestamp(), createdBy: uid
      });
      tx.set(metaRef, {
        schemaVersion: 2, catalogVersion: nextVersion, checksum: restoredChecksum,
        ingredientCount: snapIngredients.length, categoryCount: snapCategories.length,
        updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
      });
      tx.create(platformAuditRef(eventId), {
        schemaVersion: 1, eventId, type: 'catalog.restored', actor: { uid: actor.uid, role: actor.role },
        subject: { type: 'ingredientCatalog', id: `v${nextVersion}` }, idempotencyKey: eventId,
        occurredAt: FieldValue.serverTimestamp(),
        metadata: { restoredFrom: restoreVersion, catalogVersion: nextVersion, checksum: restoredChecksum }
      });
    });
    return { mode, catalogVersion: nextVersion, restoredFrom: restoreVersion, checksum: restoredChecksum };
  }

  const parsed = parseCatalogPayload(data.format, data.payload);
  const [catalog, denylistDoc] = await Promise.all([
    loadGlobalCatalog(),
    db.doc('globalIngredientCatalog/config/denylist').get()
  ]);
  const denylist = Array.isArray(denylistDoc.data()?.ingredientIds) ? denylistDoc.data().ingredientIds : [];
  const existingIngredients = {};
  catalog.ingredients.forEach(item => { existingIngredients[item.ingredientId] = item; });
  const report = validateCatalogImport(parsed, {
    existingIngredients,
    existingCategories: catalog.categories.map(item => item.categoryId),
    denylist
  });
  const previewId = catalogImportPreviewId(report.normalized, catalog.catalogVersion);
  // Dry-run (default): nessuna scrittura. Conteggi + diff (≤200) + errori.
  if (mode === 'dry-run') {
    return {
      mode, previewId, baseCatalogVersion: catalog.catalogVersion,
      counts: report.counts, diff: report.diff, diffTruncated: report.diffTruncated, errors: report.errors
    };
  }

  // Commit: flag + conferma esplicita + previewId identico al dry-run + zero
  // errori. Transazione atomica: bump versione, scritture, snapshot della
  // versione precedente, audit con checksum.
  const config = await catalogImportConfig();
  if (!config.enabled) throw new HttpsError('failed-precondition', 'Import catalogo disabilitato (flag CATALOG_IMPORT_ENABLED)');
  if (data.confirm !== true) throw new HttpsError('failed-precondition', 'Commit richiede conferma esplicita (confirm: true)');
  if (!data.previewId || data.previewId !== previewId) {
    throw new HttpsError('failed-precondition', 'previewId non corrispondente: riesegui il dry-run sullo stesso file');
  }
  if (report.errors.length) {
    throw new HttpsError('failed-precondition', `Import bloccato: ${report.errors.length} errori — correggi il file e riesegui il dry-run`);
  }
  const writeCount = report.normalized.ingredients.length + report.normalized.categories.length;
  if (writeCount > CATALOG_COMMIT_WRITE_LIMIT) {
    throw new HttpsError('failed-precondition', `Commit atomico limitato a ${CATALOG_COMMIT_WRITE_LIMIT} voci: suddividi il file`);
  }
  const mergedIngredients = new Map(catalog.ingredients.map(item => [item.ingredientId, item]));
  report.normalized.ingredients.forEach(entry => mergedIngredients.set(entry.ingredientId, entry));
  const mergedCategories = new Map(catalog.categories.map(item => [item.categoryId, item]));
  report.normalized.categories.forEach(entry => mergedCategories.set(entry.categoryId, entry));
  const createdOrUpdated = report.counts.create + report.counts.update;
  if (createdOrUpdated === 0) throw new HttpsError('failed-precondition', 'Niente da scrivere: il file non contiene novità');
  const nextVersion = catalog.catalogVersion + 1;
  const newChecksum = catalogContentChecksum([...mergedIngredients.values()], [...mergedCategories.values()], nextVersion);
  const currentSnapshot = JSON.stringify({ ingredients: catalog.ingredients, categories: catalog.categories });
  if (currentSnapshot.length > 950000) throw new HttpsError('failed-precondition', 'Catalogo corrente troppo grande per lo snapshot: contatta il supporto');
  const eventId = checksum(`catalog.imported:${previewId}:${nextVersion}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const fresh = await tx.get(metaRef);
    if (Number(fresh.data()?.catalogVersion || 0) !== catalog.catalogVersion) {
      throw new HttpsError('failed-precondition', 'Il catalogo è cambiato dopo il dry-run: riesegui il dry-run');
    }
    if ((await tx.get(platformAuditRef(eventId))).exists) return;
    report.normalized.ingredients.forEach(entry => {
      tx.set(db.doc(`globalIngredientCatalog/current/ingredients/${entry.ingredientId}`), {
        schemaVersion: 2, ...entry, catalogVersion: nextVersion, updatedAt: FieldValue.serverTimestamp()
      });
    });
    report.normalized.categories.forEach(entry => {
      tx.set(db.doc(`globalIngredientCatalog/current/categories/${entry.categoryId}`), {
        schemaVersion: 2, ...entry, catalogVersion: nextVersion, updatedAt: FieldValue.serverTimestamp()
      });
    });
    tx.set(db.doc(`globalIngredientCatalog/versions/${catalog.catalogVersion}`), {
      schemaVersion: 2, catalogVersion: catalog.catalogVersion, checksum: catalog.checksum,
      ingredients: catalog.ingredients, categories: catalog.categories,
      supersededBy: nextVersion, createdAt: FieldValue.serverTimestamp(), createdBy: uid
    });
    tx.set(metaRef, {
      schemaVersion: 2, catalogVersion: nextVersion, checksum: newChecksum,
      ingredientCount: mergedIngredients.size, categoryCount: mergedCategories.size,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    });
    tx.create(platformAuditRef(eventId), {
      schemaVersion: 1, eventId, type: 'catalog.imported', actor: { uid: actor.uid, role: actor.role },
      subject: { type: 'ingredientCatalog', id: `v${nextVersion}` }, idempotencyKey: previewId,
      occurredAt: FieldValue.serverTimestamp(),
      metadata: { baseCatalogVersion: catalog.catalogVersion, catalogVersion: nextVersion, checksum: newChecksum, counts: report.counts, format: text(data.format, 'format') }
    });
  });
  return { mode, catalogVersion: nextVersion, checksum: newChecksum, counts: report.counts, previewId };
});

exports.updateAssignmentStatus = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'clientId', 'assignmentId', 'status', 'reason', 'idempotencyKey']);
  const actor = await membership(data.organizationId, uid);
  const client = await authorizedClient(actor, data.clientId);
  const assignmentId = id(data.assignmentId, 'assignmentId');
  const status = text(data.status, 'status', { pattern: /^(suspended|revoked)$/ });
  const reason = text(data.reason, 'reason', { min: 3, max: 500 });
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const ref = client.ref.collection('assignments').doc(assignmentId);
  const eventId = checksum(`assignment.${status}:${assignmentId}:${idem}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [assignment, audit] = await Promise.all([tx.get(ref), tx.get(auditRef(actor.organizationId, eventId))]);
    if (audit.exists) return;
    if (!assignment.exists) throw new HttpsError('not-found', 'Assegnazione non trovata');
    tx.update(ref, { status, statusReason: reason, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.delete(client.ref.collection('state').doc('activeAssignment'));
    tx.update(client.ref, { activeAssignment: null, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'assignment.status-changed', actor, subject: { type: 'assignment', id: assignmentId }, idempotencyKey: idem, metadata: { status } }));
    if (client.authUid) {
      tx.create(db.doc(`organizations/${actor.organizationId}/notifications/${eventId}`), {
        schemaVersion: 1, notificationId: eventId, recipientUid: client.authUid,
        type: `profile.${status}`, subjectId: assignmentId, readAt: null,
        dedupeKey: eventId, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        delivery: { inApp: 'pending', email: 'disabled' }
      });
    }
  });
  return { assignmentId, status };
});

// ---- Utenti, inviti e associazioni nutritionist-cliente (Fase 2) ----
// Account, membership, associazione professionale, assignment e household
// restano concetti separati: nessuno conferisce privilegi negli altri.
// "Rimuovere" revoca sempre e solo l'associazione: mai Auth, household,
// ricette o backup (conservati) e mai strutture altrui (ownerUid mantenuto).

function requireAdmin(actor) {
  if (actor.role !== 'admin') throw new HttpsError('permission-denied', 'Operazione riservata all’amministratore');
}

function iso(value) {
  return value?.toDate?.()?.toISOString?.() || null;
}

async function usernameOwner(username) {
  const doc = await db.doc(`usernames/${normalizeUsername(username)}`).get();
  if (!doc.exists) return null;
  return doc.data()?.uid || null;
}

async function usernameOfUid(uid) {
  const snap = await db.collection('usernames').where('uid', '==', uid).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].id;
}

// Sospende assignment attivi/programmati del cliente (revoca associazione).
// Eseguita in transazione con rilettura: nessuna assegnazione resta attiva.
async function suspendClientAssignmentsTx(tx, clientRef, uid, reason) {
  const open = await tx.get(clientRef.collection('assignments').where('status', 'in', ['active', 'scheduled']));
  open.docs.forEach(doc => {
    tx.update(doc.ref, {
      status: 'suspended', statusReason: reason,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    });
  });
  tx.delete(clientRef.collection('state').doc('activeAssignment'));
  tx.update(clientRef, { activeAssignment: null, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
  return open.size;
}

// Ricerca per username ESATTO normalizzato. Ritorna solo esistenza + uid, mai
// PII: nessuna enumerazione, nessun prefisso, nessuna lista.
exports.searchUserByUsername = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'username']);
  await membership(data.organizationId, uid);
  const userId = await usernameOwner(data.username);
  return { found: Boolean(userId), userId: userId || null };
});

exports.listOrganizationUsers = callable(async (data, uid) => {
  exactObject(data, ['organizationId']);
  const actor = await membership(data.organizationId, uid);
  const orgId = actor.organizationId;
  if (actor.role === 'nutritionist') {
    const [clientsSnap, requestsSnap] = await Promise.all([
      db.collection(`organizations/${orgId}/clients`).where('nutritionistUids', 'array-contains', uid).limit(100).get(),
      db.collection(`organizations/${orgId}/clientLinkRequests`).where('nutritionistUid', '==', uid).limit(50).get()
    ]);
    return {
      clients: clientsSnap.docs.map(doc => ({
        id: doc.id, displayCode: doc.data().displayCode || doc.id, status: doc.data().status || 'active',
        activeAssignment: doc.data().activeAssignment || null, updatedAt: iso(doc.data().updatedAt)
      })),
      requests: requestsSnap.docs.map(doc => ({
        requestId: doc.id, clientId: doc.data().clientId || null, targetUsername: doc.data().targetUsername || null,
        status: doc.data().status, createdAt: iso(doc.data().createdAt)
      })),
      members: [], invitations: []
    };
  }
  const [membersSnap, clientsSnap, invitesSnap, requestsSnap] = await Promise.all([
    db.collection(`organizations/${orgId}/members`).limit(100).get(),
    db.collection(`organizations/${orgId}/clients`).limit(100).get(),
    db.collection(`organizations/${orgId}/invitations`).where('status', '==', 'pending').limit(50).get(),
    db.collection(`organizations/${orgId}/clientLinkRequests`).where('status', '==', 'pending').limit(50).get()
  ]);
  return {
    members: membersSnap.docs.map(doc => ({
      userId: doc.id, username: doc.data().username || null, role: doc.data().role, status: doc.data().status, updatedAt: iso(doc.data().updatedAt)
    })),
    clients: clientsSnap.docs.map(doc => ({
      id: doc.id, displayCode: doc.data().displayCode || doc.id, status: doc.data().status || 'active',
      nutritionistUids: doc.data().nutritionistUids || [], activeAssignment: doc.data().activeAssignment || null,
      updatedAt: iso(doc.data().updatedAt)
    })),
    // Mai tokenHash in risposta: il token in chiaro è mostrato una sola volta
    // al momento della creazione dell'invito.
    invitations: invitesSnap.docs.map(doc => ({
      inviteId: doc.id, type: doc.data().type, targetUsername: doc.data().targetUsername || null,
      clientId: doc.data().clientId || null, status: doc.data().status,
      expiresAt: iso(doc.data().expiresAt), createdAt: iso(doc.data().createdAt)
    })),
    requests: requestsSnap.docs.map(doc => ({
      requestId: doc.id, clientId: doc.data().clientId || null, targetUsername: doc.data().targetUsername || null,
      nutritionistUid: doc.data().nutritionistUid || null, status: doc.data().status, createdAt: iso(doc.data().createdAt)
    }))
  };
});

// Invito nutritionist (admin): account esistente → membership immediata;
// account inesistente → invito monouso con scadenza 7gg. Il token in chiaro
// è restituito UNA sola volta; nel documento resta solo l'hash SHA-256.
exports.inviteOrganizationUser = callable(async (data, uid) => {
  const input = validateInviteOrganizationUser(data);
  const actor = await membership(input.organizationId, uid);
  requireAdmin(actor);
  const targetUid = await usernameOwner(input.username);
  const inviteId = checksum(`${actor.organizationId}:member:${input.username}:${input.idempotencyKey}`).slice(0, 32);
  const inviteRef = db.doc(`organizations/${actor.organizationId}/invitations/${inviteId}`);
  if (targetUid) {
    const memberRef = db.doc(`organizations/${actor.organizationId}/members/${targetUid}`);
    const eventId = checksum(`member.added:${actor.organizationId}:${targetUid}:${input.idempotencyKey}`).slice(0, 32);
    let status = 'member-added';
    await db.runTransaction(async tx => {
      const [member, audit] = await Promise.all([tx.get(memberRef), tx.get(auditRef(actor.organizationId, eventId))]);
      if (audit.exists) return;
      if (member.exists && member.data()?.status === 'active') { status = 'already-member'; return; }
      if (member.exists) {
        tx.update(memberRef, { role: 'nutritionist', status: 'active', username: input.username, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
      } else {
        tx.create(memberRef, {
          schemaVersion: 1, role: 'nutritionist', status: 'active', username: input.username,
          createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid, updatedBy: uid
        });
      }
      tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'member.added', actor, subject: { type: 'member', id: targetUid }, idempotencyKey: input.idempotencyKey, metadata: { role: 'nutritionist' } }));
    });
    return { status, userId: targetUid };
  }
  const token = crypto.randomBytes(32).toString('hex');
  const eventId = checksum(`member.invited:${inviteId}`).slice(0, 32);
  let created = true;
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  await db.runTransaction(async tx => {
    const [existing, audit] = await Promise.all([tx.get(inviteRef), tx.get(auditRef(actor.organizationId, eventId))]);
    if (existing.exists || audit.exists) { created = false; return; }
    tx.create(inviteRef, {
      schemaVersion: 1, inviteId, type: 'nutritionist', targetUsername: input.username,
      tokenHash: hashToken(token), status: 'pending', expiresAt: Timestamp.fromDate(expiresAt),
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'member.invited', actor, subject: { type: 'invitation', id: inviteId }, idempotencyKey: input.idempotencyKey, metadata: { role: 'nutritionist' } }));
  });
  // Retry idempotente: l'invito esiste già ma il token NON viene rimostrato.
  if (!created) return { status: 'already-invited', inviteId };
  return { status: 'invited', inviteId, expiresAt: expiresAt.toISOString(), token };
});

// Riscatto invito (post-registrazione): lega l'account allo username invitato.
// Monouso, scadenza 7gg, idempotente per lo stesso utente.
exports.acceptOrganizationInvite = callable(async (data, uid) => {
  exactObject(data, ['token']);
  const token = text(data.token, 'token', { min: 32, max: 256 });
  const tokenHash = hashToken(token);
  const snap = await db.collectionGroup('invitations').where('tokenHash', '==', tokenHash).limit(2).get();
  if (snap.empty || snap.size > 1) throw new HttpsError('not-found', 'Invito non valido o già utilizzato');
  const inviteDoc = snap.docs[0];
  const invite = inviteDoc.data();
  const orgId = inviteDoc.ref.path.split('/')[1];
  const username = await usernameOfUid(uid);
  if (!username || username !== invite.targetUsername) {
    throw new HttpsError('failed-precondition', 'Registra prima l’account con lo username invitato');
  }
  const now = new Date();
  const expiresAt = invite.expiresAt?.toDate?.() || null;
  if (invite.status !== 'pending') {
    if (invite.status === 'accepted' && invite.decidedBy === uid) return { status: 'already-accepted', organizationId: orgId };
    throw new HttpsError('failed-precondition', 'Invito non più valido');
  }
  if (expiresAt && expiresAt <= now) {
    await inviteDoc.ref.update({ status: 'expired', updatedAt: FieldValue.serverTimestamp() });
    throw new HttpsError('failed-precondition', 'Invito scaduto: chiedi un nuovo invito');
  }
  const eventId = checksum(`invite.accepted:${inviteDoc.id}:${uid}`).slice(0, 32);
  const actor = { uid, role: invite.type === 'client' ? 'client' : 'nutritionist' };
  if (invite.type === 'nutritionist') {
    await db.runTransaction(async tx => {
      const [fresh, audit] = await Promise.all([tx.get(inviteDoc.ref), tx.get(auditRef(orgId, eventId))]);
      if (audit.exists) return;
      if (fresh.data()?.status !== 'pending') throw new HttpsError('failed-precondition', 'Invito non più valido');
      tx.set(db.doc(`organizations/${orgId}/members/${uid}`), {
        schemaVersion: 1, role: 'nutritionist', status: 'active', username,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid, updatedBy: uid
      }, { merge: true });
      tx.update(inviteDoc.ref, { status: 'accepted', decidedAt: FieldValue.serverTimestamp(), decidedBy: uid, updatedAt: FieldValue.serverTimestamp() });
      tx.create(auditRef(orgId, eventId), auditEvent({ orgId, eventId, type: 'member.added', actor, subject: { type: 'member', id: uid }, idempotencyKey: eventId, metadata: { via: 'invite' } }));
    });
    return { status: 'member-added', organizationId: orgId };
  }
  // Invito cliente: attiva il collegamento preparato all'invito.
  const clientRef = db.doc(`organizations/${orgId}/clients/${invite.clientId}`);
  await db.runTransaction(async tx => {
    const [fresh, client, link, audit] = await Promise.all([
      tx.get(inviteDoc.ref), tx.get(clientRef),
      tx.get(db.doc(`accountClientLinks/${uid}`)), tx.get(auditRef(orgId, eventId))
    ]);
    if (audit.exists) return;
    if (fresh.data()?.status !== 'pending') throw new HttpsError('failed-precondition', 'Invito non più valido');
    if (!client.exists) throw new HttpsError('not-found', 'Profilo cliente non trovato');
    if (link.exists && link.data()?.status === 'active') throw new HttpsError('failed-precondition', 'Account già collegato a un altro professionista: scollegati prima');
    tx.update(inviteDoc.ref, { status: 'accepted', decidedAt: FieldValue.serverTimestamp(), decidedBy: uid, updatedAt: FieldValue.serverTimestamp() });
    tx.update(clientRef, { status: 'active', authUid: uid, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.set(db.doc(`accountClientLinks/${uid}`), {
      schemaVersion: 1, organizationId: orgId, clientId: clientRef.id, status: 'active',
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(auditRef(orgId, eventId), auditEvent({ orgId, eventId, type: 'client.link-accepted', actor, subject: { type: 'client', id: clientRef.id }, idempotencyKey: eventId, metadata: { via: 'invite' } }));
  });
  return { status: 'link-active', organizationId: orgId, clientId: invite.clientId };
});

// Attivazione/sospensione membership (admin). Non si può modificare il proprio
// stato né sospendere l'ultimo admin attivo (anti-lockout).
exports.setMemberStatus = callable(async (data, uid) => {
  const input = validateMemberStatus(data);
  const actor = await membership(input.organizationId, uid);
  requireAdmin(actor);
  if (input.userId === uid) throw new HttpsError('failed-precondition', 'Non puoi modificare il tuo stato');
  const memberRef = db.doc(`organizations/${actor.organizationId}/members/${input.userId}`);
  const eventId = checksum(`member.status:${input.userId}:${input.status}:${input.idempotencyKey}`).slice(0, 32);
  const member = await memberRef.get();
  if (!member.exists || member.data()?.status === 'removed') throw new HttpsError('not-found', 'Membership non trovata: usa un nuovo invito');
  if (member.data()?.status === input.status) return { userId: input.userId, status: input.status, unchanged: true };
  if (member.data()?.role === 'admin' && input.status === 'suspended') {
    const admins = await db.collection(`organizations/${actor.organizationId}/members`)
      .where('role', '==', 'admin').where('status', '==', 'active').limit(2).get();
    const others = admins.docs.filter(doc => doc.id !== input.userId);
    if (!others.length) throw new HttpsError('failed-precondition', 'Non puoi sospendere l’ultimo amministratore attivo');
  }
  await db.runTransaction(async tx => {
    if ((await tx.get(auditRef(actor.organizationId, eventId))).exists) return;
    tx.update(memberRef, { status: input.status, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'member.status-changed', actor, subject: { type: 'member', id: input.userId }, idempotencyKey: input.idempotencyKey, metadata: { status: input.status } }));
  });
  return { userId: input.userId, status: input.status };
});

// Invito di collegamento cliente: account esistente → richiesta da accettare
// in app; account inesistente → invito monouso (7gg, solo hash conservato).
// Il nutritionist invita solo per sé; l'admin può indicare il nutritionist
// destinatario oppure lasciarlo temporaneamente senza professionista.
exports.inviteClientLink = callable(async (data, uid) => {
  const input = validateInviteClientLink(data);
  const actor = await membership(input.organizationId, uid);
  let nutritionistUid = input.nutritionistUid;
  if (actor.role === 'nutritionist') {
    if (nutritionistUid && nutritionistUid !== uid) {
      throw new HttpsError('permission-denied', 'Puoi invitare clienti solo per te');
    }
    nutritionistUid = uid;
  } else if (nutritionistUid) {
    const target = await db.doc(`organizations/${actor.organizationId}/members/${nutritionistUid}`).get();
    if (!target.exists || target.data()?.status !== 'active' || target.data()?.role !== 'nutritionist') {
      throw new HttpsError('failed-precondition', 'Nutritionist destinatario non valido');
    }
  }
  const targetUid = await usernameOwner(input.username);
  if (targetUid) {
    const link = await db.doc(`accountClientLinks/${targetUid}`).get();
    if (link.exists && link.data()?.status === 'active') {
      throw new HttpsError('already-exists', 'Account già collegato a un professionista');
    }
  }
  const clientId = checksum(`${actor.organizationId}:client:${input.username}:${input.idempotencyKey}`).slice(0, 24);
  const clientRef = db.doc(`organizations/${actor.organizationId}/clients/${clientId}`);
  const displayCode = `CL-${checksum(clientId).slice(0, 6).toUpperCase()}`;
  const nutritionistUids = nutritionistUid ? [nutritionistUid] : [];
  if (targetUid) {
    const requestId = checksum(`${actor.organizationId}:linkreq:${input.username}:${input.idempotencyKey}`).slice(0, 32);
    const requestRef = db.doc(`organizations/${actor.organizationId}/clientLinkRequests/${requestId}`);
    const eventId = checksum(`client.link-invited:${requestId}`).slice(0, 32);
    await db.runTransaction(async tx => {
      const [client, existing, audit] = await Promise.all([tx.get(clientRef), tx.get(requestRef), tx.get(auditRef(actor.organizationId, eventId))]);
      if (existing.exists || audit.exists) return;
      if (!client.exists) {
        tx.create(clientRef, {
          schemaVersion: 1, authUid: null, displayCode, status: 'pending', invitedUsername: input.username,
          nutritionistUids, activeAssignment: null,
          createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid, updatedBy: uid
        });
      }
      tx.create(requestRef, {
        schemaVersion: 1, requestId, organizationId: actor.organizationId, clientId,
        targetUid, targetUsername: input.username, nutritionistUid: nutritionistUid || null,
        status: 'pending', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid
      });
      tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'client.link-invited', actor, subject: { type: 'client', id: clientId }, idempotencyKey: input.idempotencyKey, metadata: { via: 'request' } }));
    });
    const request = await requestRef.get();
    return { status: 'requested', clientId, requestId: request.id };
  }
  const token = crypto.randomBytes(32).toString('hex');
  const inviteId = checksum(`${actor.organizationId}:clientinvite:${input.username}:${input.idempotencyKey}`).slice(0, 32);
  const inviteRef = db.doc(`organizations/${actor.organizationId}/invitations/${inviteId}`);
  const eventId = checksum(`client.link-invited:${inviteId}`).slice(0, 32);
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  let created = true;
  await db.runTransaction(async tx => {
    const [client, existing, audit] = await Promise.all([tx.get(clientRef), tx.get(inviteRef), tx.get(auditRef(actor.organizationId, eventId))]);
    if (existing.exists || audit.exists) { created = false; return; }
    if (!client.exists) {
      tx.create(clientRef, {
        schemaVersion: 1, authUid: null, displayCode, status: 'pending', invitedUsername: input.username,
        nutritionistUids, activeAssignment: null,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid, updatedBy: uid
      });
    }
    tx.create(inviteRef, {
      schemaVersion: 1, inviteId, type: 'client', targetUsername: input.username, clientId,
      nutritionistUid: nutritionistUid || null, tokenHash: hashToken(token),
      status: 'pending', expiresAt: Timestamp.fromDate(expiresAt),
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'client.link-invited', actor, subject: { type: 'client', id: clientId }, idempotencyKey: input.idempotencyKey, metadata: { via: 'invite' } }));
  });
  if (!created) return { status: 'already-invited', clientId, inviteId };
  return { status: 'invited', clientId, inviteId, expiresAt: expiresAt.toISOString(), token };
});

// Richieste di collegamento in attesa + stato del collegamento attuale per
// l'account autenticato (app, Impostazioni). Solo i propri dati, mai PII altrui.
exports.listMyClientLinkRequests = callable(async (data, uid) => {
  exactObject(data, []);
  const [snap, link] = await Promise.all([
    db.collectionGroup('clientLinkRequests').where('targetUid', '==', uid).limit(20).get(),
    db.doc(`accountClientLinks/${uid}`).get()
  ]);
  const pending = snap.docs.filter(doc => doc.data()?.status === 'pending');
  const orgIds = new Set(pending.map(doc => doc.data().organizationId).filter(Boolean));
  if (link.exists && link.data()?.status === 'active' && link.data()?.organizationId) {
    orgIds.add(link.data().organizationId);
  }
  const orgNames = new Map();
  await Promise.all([...orgIds].map(async orgId => {
    const org = await db.doc(`organizations/${orgId}`).get();
    orgNames.set(orgId, org.exists ? (org.data()?.name || orgId) : orgId);
  }));
  return {
    requests: pending.map(doc => ({
      requestId: doc.id,
      organizationId: doc.data().organizationId,
      organizationName: orgNames.get(doc.data().organizationId) || doc.data().organizationId,
      createdAt: iso(doc.data().createdAt)
    })),
    link: link.exists && link.data()?.status === 'active'
      ? {
          organizationId: link.data().organizationId,
          organizationName: orgNames.get(link.data().organizationId) || link.data().organizationId,
          clientId: link.data().clientId
        }
      : null
  };
});

// Accettazione/rifiuto dal cliente (app). IDEMPOTENTE: decisioni già prese
// ritornano no-op; ogni transizione è registrata in audit.
exports.respondClientLink = callable(async (data, uid) => {
  const input = validateRespondClientLink(data);
  const snap = await db.collectionGroup('clientLinkRequests').where('targetUid', '==', uid).limit(20).get();
  const found = snap.docs.find(doc => doc.id === input.requestId);
  if (!found) throw new HttpsError('not-found', 'Richiesta non trovata');
  const request = found.data();
  const orgId = found.ref.path.split('/')[1];
  const clientRef = db.doc(`organizations/${orgId}/clients/${request.clientId}`);
  const actor = { uid, role: 'client' };
  const linkRef = db.doc(`accountClientLinks/${uid}`);
  if (request.status === 'accepted' && input.decision === 'accept') {
    const link = await linkRef.get();
    if (link.exists && link.data()?.status === 'active' && link.data()?.clientId === request.clientId) {
      const noopEventId = checksum(`client.link-noop:${input.requestId}:accept`).slice(0, 32);
      await db.runTransaction(async tx => {
        if ((await tx.get(auditRef(orgId, noopEventId))).exists) return;
        tx.create(auditRef(orgId, noopEventId), auditEvent({ orgId, eventId: noopEventId, type: 'client.link-noop', actor, subject: { type: 'client', id: request.clientId }, idempotencyKey: noopEventId, metadata: { decision: 'accept' } }));
      });
      return { status: 'already-accepted', clientId: request.clientId };
    }
  }
  if (request.status !== 'pending') {
    throw new HttpsError('failed-precondition', request.status === 'accepted'
      ? 'Collegamento già attivo: usa “Scollegati” per interromperlo'
      : 'Richiesta non più valida: chiedi un nuovo invito');
  }
  const eventId = checksum(`client.link-${input.decision}:${input.requestId}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [fresh, client, link, audit] = await Promise.all([
      tx.get(found.ref), tx.get(clientRef), tx.get(linkRef), tx.get(auditRef(orgId, eventId))
    ]);
    if (audit.exists) return;
    if (fresh.data()?.status !== 'pending') throw new HttpsError('failed-precondition', 'Richiesta non più valida: chiedi un nuovo invito');
    if (!client.exists) throw new HttpsError('not-found', 'Profilo cliente non trovato');
    if (input.decision === 'reject') {
      tx.update(found.ref, { status: 'rejected', decidedAt: FieldValue.serverTimestamp(), decidedBy: uid, updatedAt: FieldValue.serverTimestamp() });
      tx.create(auditRef(orgId, eventId), auditEvent({ orgId, eventId, type: 'client.link-rejected', actor, subject: { type: 'client', id: clientRef.id }, idempotencyKey: eventId, metadata: {} }));
      return;
    }
    if (link.exists && link.data()?.status === 'active') {
      throw new HttpsError('failed-precondition', 'Account già collegato a un altro professionista: scollegati prima');
    }
    tx.update(found.ref, { status: 'accepted', decidedAt: FieldValue.serverTimestamp(), decidedBy: uid, updatedAt: FieldValue.serverTimestamp() });
    tx.update(clientRef, { status: 'active', authUid: uid, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.set(linkRef, {
      schemaVersion: 1, organizationId: orgId, clientId: clientRef.id, status: 'active',
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(auditRef(orgId, eventId), auditEvent({ orgId, eventId, type: 'client.link-accepted', actor, subject: { type: 'client', id: clientRef.id }, idempotencyKey: eventId, metadata: {} }));
  });
  return input.decision === 'accept'
    ? { status: 'link-active', clientId: request.clientId }
    : { status: 'link-rejected', clientId: request.clientId };
});

// Scollegamento richiesto dal cliente (app, finestra di conferma): revoca
// solo l'associazione professionale + sospende gli assignment. Account,
// household, ricette e backup restano intatti.
exports.requestClientUnlink = callable(async (data, uid) => {
  exactObject(data, []);
  const linkRef = db.doc(`accountClientLinks/${uid}`);
  const link = await linkRef.get();
  if (!link.exists || link.data()?.status !== 'active') return { status: 'already-unlinked' };
  const { organizationId: orgId, clientId } = link.data();
  const clientRef = db.doc(`organizations/${orgId}/clients/${clientId}`);
  const eventId = checksum(`client.unlinked:${orgId}:${clientId}:${uid}`).slice(0, 32);
  const actor = { uid, role: 'client' };
  let suspended = 0;
  await db.runTransaction(async tx => {
    const [freshLink, client, audit] = await Promise.all([tx.get(linkRef), tx.get(clientRef), tx.get(auditRef(orgId, eventId))]);
    if (audit.exists) return;
    if (!freshLink.exists || freshLink.data()?.status !== 'active') return;
    tx.update(linkRef, { status: 'revoked', updatedAt: FieldValue.serverTimestamp() });
    if (client.exists) {
      tx.update(clientRef, { status: 'unlinked', authUid: null, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    }
    suspended = await suspendClientAssignmentsTx(tx, clientRef, uid, 'Scollegamento richiesto dal cliente');
    tx.create(auditRef(orgId, eventId), auditEvent({ orgId, eventId, type: 'client.unlinked', actor, subject: { type: 'client', id: clientId }, idempotencyKey: eventId, metadata: { suspendedAssignments: suspended } }));
  });
  return { status: 'unlinked', suspendedAssignments: suspended };
});

// Rimozione associazione cliente (console, conferma forte in UI): SOLO revoca
// del legame professionale + sospensione assignment. Nessuna cancellazione di
// account, household, ricette o backup. Il cliente torna original-only e perde
// la Spesa inclusa al successivo refresh.
exports.removeClientLink = callable(async (data, uid) => {
  const input = validateRemoveClientLink(data);
  const actor = await membership(input.organizationId, uid);
  const client = await authorizedClient(actor, input.clientId);
  const eventId = checksum(`client.link-removed:${client.id}:${input.idempotencyKey}`).slice(0, 32);
  let suspended = 0;
  await db.runTransaction(async tx => {
    const [fresh, audit, link] = await Promise.all([
      tx.get(client.ref),
      tx.get(auditRef(actor.organizationId, eventId)),
      client.authUid ? tx.get(db.doc(`accountClientLinks/${client.authUid}`)) : Promise.resolve(null)
    ]);
    if (audit.exists) return;
    if (link?.exists && link.data()?.status === 'active') {
      tx.update(link.ref, { status: 'revoked', updatedAt: FieldValue.serverTimestamp() });
    }
    tx.update(client.ref, { status: 'unlinked', authUid: null, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    suspended = await suspendClientAssignmentsTx(tx, client.ref, uid, input.reason);
    const pendingRequests = await tx.get(client.ref.parent.parent.collection('clientLinkRequests').where('clientId', '==', client.id).where('status', '==', 'pending'));
    pendingRequests.docs.forEach(doc => tx.update(doc.ref, { status: 'revoked', decidedAt: FieldValue.serverTimestamp(), decidedBy: uid, updatedAt: FieldValue.serverTimestamp() }));
    const pendingInvites = await tx.get(client.ref.parent.parent.collection('invitations').where('clientId', '==', client.id).where('status', '==', 'pending'));
    pendingInvites.docs.forEach(doc => tx.update(doc.ref, { status: 'revoked', decidedAt: FieldValue.serverTimestamp(), decidedBy: uid, updatedAt: FieldValue.serverTimestamp() }));
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'client.link-removed', actor, subject: { type: 'client', id: client.id }, idempotencyKey: input.idempotencyKey, metadata: { reason: input.reason, suspendedAssignments: suspended } }));
  });
  return { clientId: client.id, status: 'unlinked', suspendedAssignments: suspended };
});

// Rimozione nutritionist (admin): BLOCCATA se restano clienti collegati o in
// attesa (conteggio + elenco in risposta). Le strutture restano con ownerUid
// invariato (visibili all'admin, non trasferite in silenzio).
exports.removeNutritionist = callable(async (data, uid) => {
  const input = validateRemoveNutritionist(data);
  const actor = await membership(input.organizationId, uid);
  requireAdmin(actor);
  if (input.userId === uid) throw new HttpsError('failed-precondition', 'Non puoi rimuovere la tua membership da qui');
  const memberRef = db.doc(`organizations/${actor.organizationId}/members/${input.userId}`);
  const member = await memberRef.get();
  if (!member.exists || member.data()?.status === 'removed') throw new HttpsError('not-found', 'Membership non trovata');
  if (member.data()?.role !== 'nutritionist') throw new HttpsError('failed-precondition', 'Solo le membership nutritionist si rimuovono da qui');
  const linked = await db.collection(`organizations/${actor.organizationId}/clients`)
    .where('nutritionistUids', 'array-contains', input.userId).limit(100).get();
  const pending = linked.docs.filter(doc => ['active', 'pending'].includes(doc.data()?.status));
  if (pending.length) {
    throw new HttpsError('failed-precondition', `Riassegna o scollega ${pending.length} cliente/i prima di rimuovere il professionista`);
  }
  const eventId = checksum(`member.removed:${input.userId}:${input.idempotencyKey}`).slice(0, 32);
  await db.runTransaction(async tx => {
    if ((await tx.get(auditRef(actor.organizationId, eventId))).exists) return;
    tx.update(memberRef, { status: 'removed', updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'member.removed', actor, subject: { type: 'member', id: input.userId }, idempotencyKey: input.idempotencyKey, metadata: {} }));
  });
  return { userId: input.userId, status: 'removed' };
});

// Passaggio di proprietà struttura (SOLO admin, mai silenzioso): audit
// completo, nessun trasferimento implicito alla rimozione del professionista.
exports.transferStructureOwnership = callable(async (data, uid) => {
  const input = validateTransferStructureOwnership(data);
  const actor = await membership(input.organizationId, uid);
  requireAdmin(actor);
  const { ref, doc } = await authorizedStructure(actor, input.structureId);
  const target = await db.doc(`organizations/${actor.organizationId}/members/${input.newOwnerUid}`).get();
  if (!target.exists || target.data()?.status !== 'active' || !ROLES.has(target.data()?.role)) {
    throw new HttpsError('failed-precondition', 'Nuovo proprietario non valido: deve essere un membro attivo');
  }
  if ((doc.data().ownerUid || doc.data().createdBy) === input.newOwnerUid) {
    return { structureId: ref.id, ownerUid: input.newOwnerUid, unchanged: true };
  }
  const eventId = checksum(`structure.ownership:${ref.id}:${input.newOwnerUid}:${input.idempotencyKey}`).slice(0, 32);
  await db.runTransaction(async tx => {
    if ((await tx.get(auditRef(actor.organizationId, eventId))).exists) return;
    tx.update(ref, { ownerUid: input.newOwnerUid, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'structure.ownership-transferred', actor, subject: { type: 'dietStructure', id: ref.id }, idempotencyKey: input.idempotencyKey, metadata: { newOwnerUid: input.newOwnerUid } }));
  });
  return { structureId: ref.id, ownerUid: input.newOwnerUid };
});

// ---- Entitlement Lista spesa (verifica server-side) ----
// Con assignment attivo non serve alcun reward. Senza assignment e con flag
// provider OFF → failed-precondition. Nient'altro: nessuna ricevuta è
// verificabile finché non esiste un provider reale (documentato).
exports.requestShoppingReward = callable(async (data, uid) => {
  // receipt/placement tollerati ma MAI considerati attendibili senza provider.
  exactObject(data, ['receipt', 'placement']);
  const link = await db.doc(`accountClientLinks/${uid}`).get();
  if (link.exists && link.data()?.status === 'active') {
    const { organizationId, clientId } = link.data();
    const assignment = await resolveDueAssignment(organizationId, clientId);
    const effective = effectiveAssignment(assignment && assignmentDates(assignment));
    if (effective.valid) return { allowed: true, reason: 'assignment', granted: false };
  }
  if (process.env.SHOPPING_REWARD_ENABLED !== 'true') {
    throw new HttpsError('failed-precondition', 'Sblocco non disponibile: nessun provider pubblicitario configurato');
  }
  throw new HttpsError('failed-precondition', 'Provider non configurato: impossibile verificare la ricevuta');
});

exports.activateScheduledAssignments = onSchedule({ region: REGION, schedule: 'every 15 minutes', timeZone: 'Europe/Rome' }, async () => {
  const due = await db.collectionGroup('assignments').where('status', '==', 'scheduled').where('effectiveAt', '<=', Timestamp.now()).limit(200).get();
  for (const doc of due.docs) {
    const parts = doc.ref.path.split('/');
    const orgId = parts[1];
    const clientId = parts[3];
    await resolveDueAssignment(orgId, clientId);
  }
  const expired = await db.collectionGroup('assignments').where('status', '==', 'active').where('expiresAt', '<=', Timestamp.now()).limit(200).get();
  for (const doc of expired.docs) {
    const parts = doc.ref.path.split('/');
    const orgId = parts[1];
    const clientId = parts[3];
    const clientRef = db.doc(`organizations/${orgId}/clients/${clientId}`);
    await db.runTransaction(async tx => {
      const fresh = await tx.get(doc.ref);
      if (fresh.data()?.status !== 'active') return;
      tx.update(doc.ref, { status: 'expired', updatedAt: FieldValue.serverTimestamp(), updatedBy: 'system:scheduler' });
      tx.delete(clientRef.collection('state').doc('activeAssignment'));
      tx.update(clientRef, { activeAssignment: null, updatedAt: FieldValue.serverTimestamp(), updatedBy: 'system:scheduler' });
    });
  }
  logger.info('Scheduled assignments processed', { activated: due.size, expired: expired.size });
});
