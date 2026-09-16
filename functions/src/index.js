'use strict';

const crypto = require('node:crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const {
  SINGLE_ORGANIZATION_ID, ROLES, REPORT_STATUSES, STRUCTURE_REVISION_SCHEMA_VERSION, STRUCTURE_REVISION_SCHEMA_VERSION_WITH_PLAN, exactObject, text, optionalText, id, checksum,
  hashToken, normalizeUsername,
  reportKey, validateReport, validateMapping, validateRuleSetRules, validateAssignment, validateStructureAssignment,
  validateDietStructureRules, validateAlternativeGroups, validateDietPlan, structureRevisionChecksum, verifyStructureRevision, effectiveAssignment,
  CATALOG_IMPORT_MODES, parseCatalogPayload, validateCatalogImport, catalogImportPreviewId,
  validateInviteOrganizationUser, validateInviteClientLink, validateRespondClientLink,
  validateRemoveClientLink, validateMemberStatus, validateRemoveNutritionist,
  validateTransferStructureOwnership,
  normalizeEmail, isLegacyTestEmail, emailFingerprint, maskEmail, INVITE_DELIVERY_CHANNEL,
  validateInviteClientEmail, validateCorrectClientInvite, validateResendClientInvite,
  validateCancelClientInvite, validateUpdateClientProfileByStaff, validateDeleteClientPermanently,
  validateProposeClientEmailChange, validateRespondClientEmailChange, validateRedeemClientInvite,
  CLIENT_FREQUENCY_KEYS, CLIENT_FREQUENCY_LABELS, CLIENT_FREQUENCY_DEFAULTS,
  DOSE_EDITABLE_ASSIGNMENT_STATUSES,
  validateClientDoseOverrides, validateGetClientDoses,
  validateUpdateClientDoseOverrides, validateCopyClientDoses,
  PROFESSIONAL_RECIPE_VISIBILITY, validateProfessionalRecipe,
  GRAMMATURE_TABLE_LIMITS, validateGrammatureTable
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

// ---- Organizzazione singola ----
// Tutta la piattaforma usa una sola organizzazione: 'pianoNutrizionale'. Qualunque orgId
// diverso è rifiutato (restringimento, mai allentamento). Il campo org non è
// più digitabile in console: è assegnato di default.
function enforceSingleOrg(organizationId) {
  const orgId = id(organizationId, 'organizationId');
  if (orgId !== SINGLE_ORGANIZATION_ID) {
    throw new HttpsError('permission-denied', 'Organizzazione non valida: usa quella predefinita');
  }
  return orgId;
}

async function membership(organizationId, uid) {
  const orgId = enforceSingleOrg(organizationId);
  const snap = await db.doc(`organizations/${orgId}/members/${uid}`).get();
  const value = snap.data();
  if (!snap.exists || value?.status !== 'active' || !ROLES.has(value?.role)) {
    throw new HttpsError('permission-denied', 'Membership non valida');
  }
  return { organizationId: orgId, uid, role: value.role, isCreator: false };
}

async function platformAdmin(uid) {
  const snap = await db.doc(`platformMembers/${uid}`).get();
  if (!snap.exists || snap.data()?.status !== 'active' || snap.data()?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Ruolo creatore richiesto');
  }
  return { uid, role: 'creator', isCreator: true, organizationId: SINGLE_ORGANIZATION_ID };
}

async function isCreatorUid(uid) {
  const snap = await db.doc(`platformMembers/${uid}`).get();
  return snap.exists && snap.data()?.status === 'active' && snap.data()?.role === 'admin';
}

// Actor: creatore (platformMembers admin) ha pieni poteri e bypassa la
// membership org; altrimenti serve membership nutritionist attiva nella org singola.
async function actorContext(organizationId, uid) {
  const orgId = enforceSingleOrg(organizationId);
  if (await isCreatorUid(uid)) {
    return { organizationId: orgId, uid, role: 'creator', isCreator: true };
  }
  return await membership(orgId, uid);
}

async function authorizedClient(actor, clientId) {
  const ref = db.doc(`organizations/${actor.organizationId}/clients/${id(clientId, 'clientId')}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.status === 'deleted') throw new HttpsError('not-found', 'Cliente non trovato');
  const client = snap.data();
  if (actor.role === 'nutritionist' && !(client.nutritionistUids || []).includes(actor.uid)) {
    throw new HttpsError('permission-denied', 'Cliente non autorizzato');
  }
  // creator bypassa il controllo nutritionistUids
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
        // Compatibilità: i documenti importati prima del cambio nome hanno
        // la famiglia sulla chiave storica mellerFamilyId.
        guideFamilyId: item.guideFamilyId || item.mellerFamilyId || null,
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
    clientOverrides: publicClientOverrides(assignment),
    compatibleClientSchema: rules.compatibleClientSchema || 1
  };
}

// Personalizzazioni per cliente (console "Dosi clienti"): override sparsi
// serviti insieme al profilo. Solo revisione + celle valorizzate: metadati
// interni (autore, timestamp) non escono mai verso il client.
function publicClientOverrides(assignment) {
  const overrides = assignment?.clientOverrides;
  if (!overrides) return null;
  return {
    revision: Number(overrides.revision || 0),
    doses: overrides.doses || {},
    frequencies: overrides.frequencies || {}
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
// nel client via structureRevisionToGuideRules (stesso motore, nessun fork
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
    clientOverrides: publicClientOverrides(assignment),
    compatibleClientSchema: 6
  };
}

exports.getMyAssignedProfile = callable(async (_data, uid) => {
  const link = await db.doc(`accountClientLinks/${uid}`).get();
  if (!link.exists || link.data()?.status !== 'active') return { state: 'unassigned', fallback: 'original-only' };
  const { organizationId, clientId } = link.data();
  if (organizationId !== SINGLE_ORGANIZATION_ID) {
    // Vecchie org diverse dalla singola non servono più profili: original-only
    return { state: 'unassigned', fallback: 'original-only' };
  }
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
  if (link.data().organizationId !== SINGLE_ORGANIZATION_ID) return { notifications: [] };
  const snapshot = await db.collection(`organizations/${link.data().organizationId}/notifications`)
    .where('recipientUid', '==', uid).orderBy('createdAt', 'desc').limit(30).get();
  return { notifications: snapshot.docs.map(doc => ({ id: doc.id, type: doc.data().type, subjectId: doc.data().subjectId, readAt: doc.data().readAt, createdAt: doc.data().createdAt })) };
});

exports.markNotificationRead = callable(async (data, uid) => {
  exactObject(data, ['notificationId']);
  const link = await db.doc(`accountClientLinks/${uid}`).get();
  if (!link.exists || link.data()?.status !== 'active') throw new HttpsError('permission-denied', 'Profilo non autorizzato');
  if (link.data().organizationId !== SINGLE_ORGANIZATION_ID) throw new HttpsError('permission-denied', 'Profilo non autorizzato');
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
  if (organizationId !== SINGLE_ORGANIZATION_ID) throw new HttpsError('permission-denied', 'Profilo cliente non autorizzato');
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
  const actor = await actorContext(data.organizationId, uid);
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
  const actor = await actorContext(data.organizationId, uid);
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
  else actor = await actorContext(data.organizationId, uid);
  const orgId = enforceSingleOrg(data.organizationId);
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
  const actor = await actorContext(data.organizationId, uid);
  // Vista Clienti unificata: ogni professionista vede i propri clienti in
  // tutti gli stati operativi (attivi, in attesa, inattivi); il creatore li
  // vede tutti. Un solo filtro per query (ADR 0003): la selezione degli
  // stati e l'ordinamento avvengono in codice, senza nuovi indici composti.
  let query = db.collection(`organizations/${actor.organizationId}/clients`);
  if (actor.role === 'nutritionist') query = query.where('nutritionistUids', 'array-contains', uid);
  const snapshot = await query.limit(100).get();
  const rows = snapshot.docs
    .map(doc => ({ id: doc.id, data: doc.data() }))
    .filter(row => row.data?.status !== 'deleted')
    .sort((a, b) => (b.data?.updatedAt?.toMillis?.() || 0) - (a.data?.updatedAt?.toMillis?.() || 0));
  const fallbackUsernames = await Promise.all(rows.map(row => row.data.invitedUsername || !row.data.authUid ? null : usernameOfUid(row.data.authUid)));
  const authorizedIds = new Set(rows.map(row => row.id));
  // Inviti, richieste di collegamento e proposte di cambio email visibili al
  // professionista autorizzato: servono alle azioni della vista Clienti.
  // Singolo filtro per ruolo (nessun indice composto): il nutrizionista
  // filtra per nutritionistUid e seleziona lo stato in codice.
  const invitesQuery = actor.role === 'nutritionist'
    ? db.collection(`organizations/${actor.organizationId}/invitations`).where('nutritionistUid', '==', uid)
    : db.collection(`organizations/${actor.organizationId}/invitations`).where('status', '==', 'pending');
  const requestsQuery = actor.role === 'nutritionist'
    ? db.collection(`organizations/${actor.organizationId}/clientLinkRequests`).where('nutritionistUid', '==', uid)
    : db.collection(`organizations/${actor.organizationId}/clientLinkRequests`).where('status', '==', 'pending');
  const [invitesSnap, requestsSnap, emailChangesSnap] = await Promise.all([
    invitesQuery.limit(50).get(),
    requestsQuery.limit(50).get(),
    db.collection(`organizations/${actor.organizationId}/emailChangeRequests`).where('status', '==', 'pending').limit(50).get()
  ]);
  return {
    clients: rows.map((row, index) => ({
      id: row.id, displayCode: row.data.displayCode || row.id,
      firstName: row.data.firstName || null, lastName: row.data.lastName || null,
      email: row.data.emailNormalized || null, emailVerified: row.data.emailVerified === true,
      username: row.data.invitedUsername || fallbackUsernames[index] || null,
      status: row.data.status || 'active', activeAssignment: row.data.activeAssignment || null,
      nutritionistUids: row.data.nutritionistUids || [],
      createdAt: iso(row.data.createdAt), updatedAt: iso(row.data.updatedAt)
    })),
    invitations: invitesSnap.docs
      .filter(doc => actor.role !== 'nutritionist' || authorizedIds.has(doc.data()?.clientId))
      .filter(doc => doc.data()?.status === 'pending')
      .map(publicInvitationRow),
    requests: requestsSnap.docs
      .filter(doc => actor.role !== 'nutritionist' || authorizedIds.has(doc.data()?.clientId))
      .filter(doc => !doc.data()?.status || doc.data()?.status === 'pending')
      .map(publicRequestRow),
    emailChanges: emailChangesSnap.docs
      .filter(doc => actor.role !== 'nutritionist' || authorizedIds.has(doc.data()?.clientId))
      .map(publicEmailChangeRow)
  };
});

// Storico collegamenti di un cliente (scheda cliente): inviti e richieste
// non più pendenti (accettati, rifiutati, revocati, scaduti, sostituiti).
// Singolo filtro per clientId (ADR 0003); mai token o hash in risposta.
exports.getClientHistory = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'clientId']);
  const actor = await actorContext(data.organizationId, uid);
  const client = await authorizedClient(actor, data.clientId);
  const [invitesSnap, requestsSnap] = await Promise.all([
    db.collection(`organizations/${actor.organizationId}/invitations`).where('clientId', '==', client.id).limit(20).get(),
    db.collection(`organizations/${actor.organizationId}/clientLinkRequests`).where('clientId', '==', client.id).limit(20).get()
  ]);
  const byCreatedDesc = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  return {
    clientId: client.id,
    invitations: invitesSnap.docs
      .filter(doc => doc.data()?.status !== 'pending')
      .map(publicInvitationRow)
      .sort(byCreatedDesc),
    requests: requestsSnap.docs
      .filter(doc => doc.data()?.status && doc.data()?.status !== 'pending')
      .map(publicRequestRow)
      .sort(byCreatedDesc)
  };
});

exports.publishRuleSetVersion = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'scope', 'ruleSetId', 'version', 'rules', 'overrides', 'effectiveAt', 'changelog', 'reviewNotes', 'idempotencyKey']);
  const scope = text(data.scope, 'scope', { pattern: /^(tenant|global)$/ });
  const orgId = enforceSingleOrg(data.organizationId);
  const actor = scope === 'global' ? await platformAdmin(uid) : await actorContext(orgId, uid);
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
  const actor = await actorContext(data.organizationId, uid);
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
  const actor = await actorContext(input.organizationId, uid);
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
  const actor = await actorContext(data.organizationId, uid);
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
  const actor = await actorContext(input.organizationId, uid);
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

// ---- Dosi e frequenze personalizzate per cliente (console "Dosi clienti") ----
// Gli override vivono sull'assegnazione (revisionati, non-retroattivi): la
// revisione della struttura assegnata non viene mai toccata.

// Assegnazione + famiglie dosabili (dosi studio dalla revisione/struttura).
// Senza assignmentId esplicito usa il puntatore state/activeAssignment.
async function loadClientDoseContext(actor, client, assignmentId) {
  let snap;
  if (assignmentId) {
    snap = await client.ref.collection('assignments').doc(assignmentId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Assegnazione non trovata');
  } else {
    const state = await client.ref.collection('state').doc('activeAssignment').get();
    const activeId = state.data()?.assignmentId;
    if (!activeId) return { ref: null, assignment: null, families: [] };
    snap = await client.ref.collection('assignments').doc(activeId).get();
    if (!snap.exists) return { ref: null, assignment: null, families: [] };
  }
  const assignment = snap.data();
  let families = [];
  if (assignment.structure?.structureId) {
    const { doc } = await authorizedStructure(actor, assignment.structure.structureId);
    const revision = await doc.ref.collection('revisions').doc(String(assignment.structure.revisionId)).get();
    if (!revision.exists) throw new HttpsError('failed-precondition', 'Revisione della struttura assegnata non trovata');
    families = (revision.data().rules || [])
      .filter(rule => rule.enabled !== false && (rule.guideFamilyId || rule.mellerFamilyId))
      .map(rule => ({ family: rule.guideFamilyId || rule.mellerFamilyId, studio: rule.quantityGrams || null, ingredientIds: rule.ingredientIds || [] }));
  } else if (assignment.ruleSet) {
    const versionRef = await ruleVersionRef(actor.organizationId, assignment.ruleSet);
    const version = await versionRef.get();
    if (!version.exists) throw new HttpsError('failed-precondition', 'Versione rule set assegnata non trovata');
    families = (version.data().rules || [])
      .filter(rule => rule.family)
      .map(rule => ({ family: rule.family, label: rule.label || rule.family, studio: rule.slots || null, ingredientIds: [] }));
  }
  return { ref: snap.ref, assignment, families };
}

function isoOrNull(value) {
  return value?.toDate?.()?.toISOString?.() || null;
}

exports.getClientDoses = callable(async (data, uid) => {
  const input = validateGetClientDoses(data);
  const actor = await actorContext(input.organizationId, uid);
  const client = await authorizedClient(actor, input.clientId);
  const context = await loadClientDoseContext(actor, client, input.assignmentId);
  if (!context.assignment) {
    return {
      clientId: client.id, displayCode: client.displayCode || client.id,
      assignment: null, families: [], overrides: { doses: {}, frequencies: {} },
      frequencyDefaults: CLIENT_FREQUENCY_KEYS.map(key => ({ key, label: CLIENT_FREQUENCY_LABELS[key], ...CLIENT_FREQUENCY_DEFAULTS[key] }))
    };
  }
  const catalog = await loadGlobalCatalog();
  const names = new Map(catalog.ingredients.map(item => [item.ingredientId, item.displayName || item.ingredientId]));
  return {
    clientId: client.id,
    displayCode: client.displayCode || client.id,
    assignment: {
      assignmentId: context.assignment.assignmentId || context.ref.id,
      status: context.assignment.status,
      structureName: context.assignment.structureName || context.assignment.structure?.structureId || null,
      effectiveAt: isoOrNull(context.assignment.effectiveAt),
      expiresAt: isoOrNull(context.assignment.expiresAt),
      overridesRevision: Number(context.assignment.clientOverrides?.revision || 0)
    },
    families: context.families.map(item => ({
      family: item.family,
      label: item.label || item.family,
      ingredients: item.ingredientIds.map(ingredientId => names.get(ingredientId) || ingredientId),
      studio: item.studio
    })),
    overrides: {
      doses: context.assignment.clientOverrides?.doses || {},
      frequencies: context.assignment.clientOverrides?.frequencies || {}
    },
    frequencyDefaults: CLIENT_FREQUENCY_KEYS.map(key => ({ key, label: CLIENT_FREQUENCY_LABELS[key], ...CLIENT_FREQUENCY_DEFAULTS[key] }))
  };
});

exports.updateClientDoseOverrides = callable(async (data, uid) => {
  const input = validateUpdateClientDoseOverrides(data);
  const actor = await actorContext(input.organizationId, uid);
  const client = await authorizedClient(actor, input.clientId);
  const context = await loadClientDoseContext(actor, client, input.assignmentId);
  if (!context.assignment) throw new HttpsError('failed-precondition', 'Il cliente non ha un’assegnazione attiva da personalizzare');
  if (!DOSE_EDITABLE_ASSIGNMENT_STATUSES.has(context.assignment.status)) {
    throw new HttpsError('failed-precondition', 'Assegnazione non modificabile: solo quelle attive o programmate accettano dosi personalizzate');
  }
  const clean = validateClientDoseOverrides(
    { doses: input.doses, frequencies: input.frequencies },
    { families: context.families.map(item => item.family) }
  );
  const assignmentId = context.assignment.assignmentId || context.ref.id;
  const nextRevision = input.expectedRevision + 1;
  const eventId = checksum(`assignment.doses:${assignmentId}:${nextRevision}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const fresh = await tx.get(context.ref);
    if (!fresh.exists) throw new HttpsError('not-found', 'Assegnazione non trovata');
    const current = Number(fresh.data()?.clientOverrides?.revision || 0);
    if (current !== input.expectedRevision) {
      throw new HttpsError('failed-precondition', 'Le dosi sono state modificate da un altro operatore: ricarica e riprova');
    }
    tx.update(context.ref, {
      clientOverrides: {
        schemaVersion: 1, revision: nextRevision,
        doses: clean.doses, frequencies: clean.frequencies,
        updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
      },
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({
      orgId: actor.organizationId, eventId, type: 'assignment.doses_updated', actor,
      subject: { type: 'assignment', id: assignmentId }, idempotencyKey: eventId,
      metadata: { clientId: client.id, assignmentId, revision: nextRevision, families: Object.keys(clean.doses), frequencyKeys: Object.keys(clean.frequencies) }
    }));
  });
  return { revision: nextRevision };
});

exports.copyClientDoses = callable(async (data, uid) => {
  const input = validateCopyClientDoses(data);
  const actor = await actorContext(input.organizationId, uid);
  const from = await authorizedClient(actor, input.fromClientId);
  const to = await authorizedClient(actor, input.toClientId);
  const fromContext = await loadClientDoseContext(actor, from, null);
  const toContext = await loadClientDoseContext(actor, to, null);
  if (!fromContext.assignment || !toContext.assignment) {
    throw new HttpsError('failed-precondition', 'Entrambi i clienti devono avere un’assegnazione attiva');
  }
  if (!DOSE_EDITABLE_ASSIGNMENT_STATUSES.has(toContext.assignment.status)) {
    throw new HttpsError('failed-precondition', 'Assegnazione di destinazione non modificabile: solo quelle attive o programmate accettano dosi personalizzate');
  }
  const toFamilies = new Set(toContext.families.map(item => item.family));
  const copied = {};
  const skippedFamilies = [];
  Object.entries(fromContext.assignment.clientOverrides?.doses || {}).forEach(([family, patch]) => {
    if (toFamilies.has(family)) copied[family] = patch;
    else skippedFamilies.push(family);
  });
  const clean = validateClientDoseOverrides(
    { doses: copied, frequencies: fromContext.assignment.clientOverrides?.frequencies || {} },
    { families: [...toFamilies] }
  );
  const assignmentId = toContext.assignment.assignmentId || toContext.ref.id;
  const nextRevision = input.expectedRevision + 1;
  const eventId = checksum(`assignment.doses.copy:${assignmentId}:${nextRevision}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const fresh = await tx.get(toContext.ref);
    if (!fresh.exists) throw new HttpsError('not-found', 'Assegnazione non trovata');
    const current = Number(fresh.data()?.clientOverrides?.revision || 0);
    if (current !== input.expectedRevision) {
      throw new HttpsError('failed-precondition', 'Le dosi sono state modificate da un altro operatore: ricarica e riprova');
    }
    tx.update(toContext.ref, {
      clientOverrides: {
        schemaVersion: 1, revision: nextRevision,
        doses: clean.doses, frequencies: clean.frequencies,
        updatedAt: FieldValue.serverTimestamp(), updatedBy: uid,
        copiedFromClientId: from.id
      },
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({
      orgId: actor.organizationId, eventId, type: 'assignment.doses_copied', actor,
      subject: { type: 'assignment', id: assignmentId }, idempotencyKey: eventId,
      metadata: { fromClientId: from.id, toClientId: to.id, assignmentId, revision: nextRevision, copiedFamilies: Object.keys(clean.doses), skippedFamilies }
    }));
  });
  return { revision: nextRevision, copiedFamilies: Object.keys(clean.doses), skippedFamilies };
});

// Sezione "Strutture dieta" (schema v2, docs/schema-catalogo-strutture-v2.json):
// aggregato mutabile + revisioni immutabili, privacy per ownerUid. Il
// nutritionist vede/tocca solo le proprie strutture; il creatore le vede
// tutte. Niente campo "Versione" verso l'UI; il checksum è riservato al creatore.

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
    hasDietPlan: data.hasDietPlan === true,
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
        throw new HttpsError('failed-precondition', `Ingrediente "${ingredientId}" inesistente o archiviato in catalogo (famiglia ${rule.guideFamilyId})`);
      }
    });
    if (rule.categoryId && rule.categoryId !== 'free' && !lookup.categoryIds.has(rule.categoryId)) {
      throw new HttpsError('failed-precondition', `Categoria "${rule.categoryId}" inesistente in catalogo (famiglia ${rule.guideFamilyId})`);
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
  if (!actor.isCreator && (mustOwn || actor.role === 'nutritionist') && (doc.data().ownerUid || doc.data().createdBy) !== actor.uid) {
    throw new HttpsError('permission-denied', 'Puoi gestire soltanto le tue strutture dieta');
  }
  return { ref, doc };
}

// Ricettario professionisti (ADR 0006): lettura/modifica solo proprietario
// con mustOwn (vale ANCHE per il creatore: non modifica le ricette altrui).
// La visibilità 'studio' abilita lettura e invio, mai la modifica.
async function authorizedProfessionalRecipe(actor, recipeId, { mustOwn = false } = {}) {
  const ref = db.doc(`organizations/${actor.organizationId}/recipes/${id(recipeId, 'recipeId')}`);
  const doc = await ref.get();
  if (!doc.exists) throw new HttpsError('not-found', 'Ricetta non trovata');
  if (mustOwn && doc.data().ownerUid !== actor.uid) {
    throw new HttpsError('permission-denied', 'Puoi modificare soltanto le tue ricette');
  }
  return { ref, doc };
}

exports.listDietStructures = callable(async (data, uid) => {
  exactObject(data, ['organizationId']);
  const actor = await actorContext(data.organizationId, uid);
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
  const actor = await actorContext(data.organizationId, uid);
  const { doc } = await authorizedStructure(actor, data.structureId);
  const revisionId = data.revisionId == null || data.revisionId === ''
    ? doc.data().currentRevisionId
    : id(String(data.revisionId), 'revisionId');
  if (!revisionId) throw new HttpsError('not-found', 'Nessuna revisione pubblicata');
  const revision = await doc.ref.collection('revisions').doc(revisionId).get();
  if (!revision.exists) throw new HttpsError('not-found', 'Revisione non trovata');
  const structure = structureDoc(doc, { includeChecksum: Boolean(actor.isCreator) });
  return {
    structure,
    revision: {
      revisionId: revision.id,
      schemaVersion: Number(revision.data().schemaVersion || 1),
      rules: revision.data().rules || [],
      alternativeGroups: revision.data().alternativeGroups || [],
      dietPlan: revision.data().dietPlan || null,
      ingredientCatalogVersion: revision.data().ingredientCatalogVersion ?? null,
      checksum: actor.isCreator ? revision.data().checksum || null : undefined,
      publishedAt: revision.data().publishedAt?.toDate?.()?.toISOString() || null,
      changelog: revision.data().changelog || null,
      restoredFromRevisionId: revision.data().restoredFromRevisionId || null
    }
  };
});

exports.createDietStructure = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'name', 'rules', 'alternativeGroups', 'dietPlan', 'idempotencyKey']);
  const actor = await actorContext(data.organizationId, uid);
  const name = text(data.name, 'name', { min: 3, max: 80 });
  const dietPlan = validateDietPlan(data.dietPlan);
  const rules = validateDietStructureRules(data.rules, { allowEmpty: Boolean(dietPlan) });
  const alternativeGroups = validateAlternativeGroups(data.alternativeGroups);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const catalog = await loadGlobalCatalog();
  assertCatalogReferences({ rules, alternativeGroups }, catalogLookup(catalog));
  const structureId = checksum(`${actor.organizationId}:${uid}:${name}:${idem}`).slice(0, 24);
  const ref = db.doc(`organizations/${actor.organizationId}/dietStructures/${structureId}`);
  const revisionSchema = dietPlan ? STRUCTURE_REVISION_SCHEMA_VERSION_WITH_PLAN : STRUCTURE_REVISION_SCHEMA_VERSION;
  const revisionChecksum = structureRevisionChecksum({ schemaVersion: revisionSchema, rules, alternativeGroups, dietPlan });
  const eventId = checksum(`structure.created:${structureId}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [existing, audit] = await Promise.all([tx.get(ref), tx.get(auditRef(actor.organizationId, eventId))]);
    if (existing.exists || audit.exists) return;
    tx.create(ref, {
      schemaVersion: 1, name, status: 'active', ownerUid: uid, createdBy: uid,
      currentRevisionId: '1', latestChecksum: revisionChecksum, ruleCount: rules.length,
      alternativeGroupCount: alternativeGroups.length, hasDietPlan: Boolean(dietPlan),
      ingredientCatalogVersion: catalog.catalogVersion,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(ref.collection('revisions').doc('1'), {
      schemaVersion: revisionSchema, revisionId: '1', structureId, rules, alternativeGroups,
      dietPlan, status: 'published', checksum: revisionChecksum, ingredientCatalogVersion: catalog.catalogVersion,
      compatibleClientSchema: 6, changelog: 'Prima revisione', createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(), createdBy: uid, publishedAt: FieldValue.serverTimestamp(), publishedBy: uid
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'structure.created', actor, subject: { type: 'dietStructure', id: structureId }, idempotencyKey: idem, metadata: { name, ruleCount: rules.length, alternativeGroupCount: alternativeGroups.length, hasDietPlan: Boolean(dietPlan), ingredientCatalogVersion: catalog.catalogVersion } }));
  });
  return { structureId, revisionId: '1' };
});

exports.updateDietStructureRevision = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'structureId', 'name', 'rules', 'alternativeGroups', 'dietPlan', 'changelog', 'restoredFromRevisionId', 'idempotencyKey']);
  const actor = await actorContext(data.organizationId, uid);
  const dietPlan = validateDietPlan(data.dietPlan);
  const rules = validateDietStructureRules(data.rules, { allowEmpty: Boolean(dietPlan) });
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
  const revisionSchema = dietPlan ? STRUCTURE_REVISION_SCHEMA_VERSION_WITH_PLAN : STRUCTURE_REVISION_SCHEMA_VERSION;
  const revisionChecksum = structureRevisionChecksum({ schemaVersion: revisionSchema, rules, alternativeGroups, dietPlan });
  const eventId = checksum(`structure.revision:${ref.id}:${nextRevisionId}:${idem}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const audit = await tx.get(auditRef(actor.organizationId, eventId));
    if (audit.exists) return;
    tx.update(ref, {
      ...(name ? { name } : {}),
      currentRevisionId: nextRevisionId, latestChecksum: revisionChecksum, ruleCount: rules.length,
      alternativeGroupCount: alternativeGroups.length, hasDietPlan: Boolean(dietPlan),
      ingredientCatalogVersion: catalog.catalogVersion,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    });
    tx.create(ref.collection('revisions').doc(nextRevisionId), {
      schemaVersion: revisionSchema, revisionId: nextRevisionId, structureId: ref.id, rules, alternativeGroups,
      dietPlan, status: 'published', checksum: revisionChecksum, ingredientCatalogVersion: catalog.catalogVersion,
      compatibleClientSchema: 6, changelog: changelog || (restoredFrom ? `Ripristino dalla revisione ${restoredFrom}` : 'Nuova revisione'),
      restoredFromRevisionId: restoredFrom || null,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      createdBy: uid, publishedAt: FieldValue.serverTimestamp(), publishedBy: uid
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'structure.revision.published', actor, subject: { type: 'dietStructure', id: ref.id }, idempotencyKey: idem, metadata: { revisionId: nextRevisionId, restoredFromRevisionId: restoredFrom || null, alternativeGroupCount: alternativeGroups.length, hasDietPlan: Boolean(dietPlan), ingredientCatalogVersion: catalog.catalogVersion } }));
  });
  return { structureId: ref.id, revisionId: nextRevisionId };
});

exports.archiveDietStructure = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'structureId', 'archived', 'idempotencyKey']);
  const actor = await actorContext(data.organizationId, uid);
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
// il creatore tutte. Non modifica dati; le differenze sono calcolate per famiglia
// (presenza, stato, ingredienti, dosi) e per gruppi alternativi.
exports.compareDietStructures = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'structureIds']);
  const actor = await actorContext(data.organizationId, uid);
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
    // Anche le revisioni legacy con la chiave storica entrano nel confronto.
    const family = rule?.guideFamilyId || rule?.mellerFamilyId;
    if (family) familyIds.add(family);
  }));
  const rows = [...familyIds].sort((a, b) => String(a).localeCompare(String(b), 'it')).map(family => {
    const cells = {};
    loaded.forEach(({ structure, revision }) => {
      const rule = (revision?.rules || []).find(item => (item?.guideFamilyId || item?.mellerFamilyId) === family);
      cells[structure.id] = rule
        ? { present: true, enabled: rule.enabled !== false, ingredientCount: (rule.ingredientIds || []).length, quantityGrams: rule.quantityGrams || null }
        : { present: false };
    });
    const signatures = new Set(loaded.map(({ structure }) => checksum(cells[structure.id])));
    return { guideFamilyId: family, cells, differs: signatures.size > 1 };
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

// ---- Import catalogo globale (creatore, docs/catalog-import-format.md) ----

// Feature flag CATALOG_IMPORT_ENABLED: variabile d'ambiente se impostata,
// altrimenti documento config, altrimenti default sicuro (ON in emulatore per
// i test, OFF in produzione finché il catalogo non è approvato).
async function catalogImportConfig() {
  const flag = process.env.CATALOG_IMPORT_ENABLED;
  if (flag === 'true') return { enabled: true, source: 'env' };
  if (flag === 'false') return { enabled: false, source: 'env' };
  const doc = await db.doc('globalIngredientCatalog/config/docs/import').get();
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
    mappingKind: item.mappingKind,
    // Fallback alla chiave storica: un documento importato prima del cambio
    // nome non deve generare falsi aggiornamenti nel diff dell'import.
    guideFamilyId: item.guideFamilyId || item.mellerFamilyId || null,
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
      db.doc(`globalIngredientCatalog/versions/snapshots/${restoreVersion}`).get(),
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
      tx.set(db.doc(`globalIngredientCatalog/versions/snapshots/${catalog.catalogVersion}`), {
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
    db.doc('globalIngredientCatalog/config/docs/denylist').get()
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
    tx.set(db.doc(`globalIngredientCatalog/versions/snapshots/${catalog.catalogVersion}`), {
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
  const actor = await actorContext(data.organizationId, uid);
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

// ---- Utenti, inviti e associazioni nutritionist-cliente ----
// Account, membership, associazione professionale, assignment e household
// restano concetti separati: nessuno conferisce privilegi negli altri.
// "Rimuovere" revoca sempre e solo l'associazione: mai Auth, household,
// ricette o backup (conservati) e mai strutture altrui (ownerUid mantenuto).
// Unica org: 'pianoNutrizionale'. Creatore = platformMembers admin, può fare tutto.

function requireCreator(actor) {
  if (!actor.isCreator) throw new HttpsError('permission-denied', 'Operazione riservata al creatore');
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
// Sessione 1: tutte le letture avvengono prima delle scritture, mai dopo.
async function suspendClientAssignmentsTx(tx, clientRef, uid, reason, openSnap = null) {
  const open = openSnap || await tx.get(clientRef.collection('assignments').where('status', 'in', ['active', 'scheduled']));
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
  await actorContext(data.organizationId, uid);
  const userId = await usernameOwner(data.username);
  return { found: Boolean(userId), userId: userId || null };
});

// Riga cliente per la console: nessun dato di altri professionisti, nessun
// token. `username` resta popolato solo per gli account tecnici legacy; per i
// clienti reali la chiave di lettura è l'email (più nome e cognome).
function publicClientRow(item, username) {
  const value = item.data;
  return {
    id: item.id, displayCode: value.displayCode || item.id,
    firstName: value.firstName || null, lastName: value.lastName || null,
    email: value.emailNormalized || null, emailVerified: value.emailVerified === true,
    username: value.invitedUsername || username || null,
    status: value.status || 'active', nutritionistUids: value.nutritionistUids || [],
    activeAssignment: value.activeAssignment || null, updatedAt: iso(value.updatedAt)
  };
}

function publicRequestRow(doc) {
  const value = doc.data();
  return {
    requestId: doc.id, clientId: value.clientId || null, channel: value.channel || null,
    targetUsername: value.targetUsername || null, targetEmail: value.targetEmailNormalized || null,
    nutritionistUid: value.nutritionistUid || null, status: value.status, createdAt: iso(value.createdAt)
  };
}

// Invito lato console: MAI tokenHash né token in chiaro (l'unico momento in cui
// il link esiste è la risposta di creazione, reinvio o correzione, che la
// console mostra con "Copia link" e "Condividi link").
function publicInvitationRow(doc) {
  const value = doc.data();
  return {
    inviteId: doc.id, type: value.type, channel: value.channel || null,
    targetUsername: value.targetUsername || null, targetEmail: value.targetEmailNormalized || null,
    firstName: value.firstName || null, lastName: value.lastName || null,
    clientId: value.clientId || null, status: value.status,
    deliveryStatus: value.delivery?.status || null,
    deliveryChannel: value.delivery?.channel || value.channel || null,
    expiresAt: iso(value.expiresAt), createdAt: iso(value.createdAt)
  };
}

function publicEmailChangeRow(doc) {
  const value = doc.data();
  return {
    requestId: doc.id, clientId: value.clientId || null,
    newEmail: value.newEmailNormalized || null, status: value.status,
    createdAt: iso(value.createdAt)
  };
}

exports.listOrganizationUsers = callable(async (data, uid) => {
  exactObject(data, ['organizationId']);
  const actor = await actorContext(data.organizationId, uid);
  const orgId = actor.organizationId;
  if (actor.role === 'nutritionist') {
    const [clientsSnap, requestsSnap, emailChangesSnap] = await Promise.all([
      db.collection(`organizations/${orgId}/clients`).where('nutritionistUids', 'array-contains', uid).limit(100).get(),
      db.collection(`organizations/${orgId}/clientLinkRequests`).where('nutritionistUid', '==', uid).limit(50).get(),
      db.collection(`organizations/${orgId}/emailChangeRequests`).where('status', '==', 'pending').limit(50).get()
    ]);
    const clients = clientsSnap.docs.map(doc => ({ id: doc.id, data: doc.data() }));
    const usernames = await Promise.all(clients.map(item => item.data.invitedUsername ? null : usernameOfUid(item.data.authUid)));
    const authorizedIds = new Set(clients.map(item => item.id));
    const pendingRequests = requestsSnap.docs.filter(doc => doc.data()?.status === 'pending');
    return {
      clients: clients.map((item, index) => publicClientRow(item, usernames[index])),
      requests: pendingRequests.map(publicRequestRow),
      emailChanges: emailChangesSnap.docs
        .filter(doc => authorizedIds.has(doc.data()?.clientId))
        .map(publicEmailChangeRow),
      members: [], invitations: []
    };
  }
  const [membersSnap, clientsSnap, invitesSnap, requestsSnap, emailChangesSnap] = await Promise.all([
    db.collection(`organizations/${orgId}/members`).limit(100).get(),
    db.collection(`organizations/${orgId}/clients`).limit(100).get(),
    db.collection(`organizations/${orgId}/invitations`).where('status', '==', 'pending').limit(50).get(),
    db.collection(`organizations/${orgId}/clientLinkRequests`).where('status', '==', 'pending').limit(50).get(),
    db.collection(`organizations/${orgId}/emailChangeRequests`).where('status', '==', 'pending').limit(50).get()
  ]);
  const clientRows = clientsSnap.docs.map(doc => ({ id: doc.id, data: doc.data() }));
  const clientFallbackUsernames = await Promise.all(clientRows.map(row => row.data.invitedUsername || !row.data.authUid ? null : usernameOfUid(row.data.authUid)));
  return {
    members: membersSnap.docs.map(doc => ({
      userId: doc.id, username: doc.data().username || null, displayName: doc.data().displayName || null,
      firstName: doc.data().firstName || null, lastName: doc.data().lastName || null,
      role: doc.data().role, status: doc.data().status, updatedAt: iso(doc.data().updatedAt)
    })),
    clients: clientRows.map((row, index) => publicClientRow(row, clientFallbackUsernames[index])),
    invitations: invitesSnap.docs.map(publicInvitationRow),
    requests: requestsSnap.docs.map(publicRequestRow),
    emailChanges: emailChangesSnap.docs.map(publicEmailChangeRow)
  };
});

// Invito nutritionist (creatore): account esistente → membership immediata;
// account inesistente → invito monouso con scadenza 7gg. Il token in chiaro
// Invito di un membro dello studio (nutritionist) da parte dell'admin.
// Supporta sia l'email reale (con generazione link monouso come per i clienti)
// sia lo username per retrocompatibilità.
exports.inviteOrganizationUser = callable(async (data, uid) => {
  const input = validateInviteOrganizationUser(data);
  const actor = await actorContext(input.organizationId, uid);
  requireCreator(actor);
  const orgId = actor.organizationId;

  if (input.email) {
    const authUser = await authUserByEmail(input.email);
    if (authUser) {
      const memberRef = db.doc(`organizations/${orgId}/members/${authUser.uid}`);
      const eventId = checksum(`member.added:${orgId}:${authUser.uid}:${input.idempotencyKey}`).slice(0, 32);
      let status = 'member-added';
      await db.runTransaction(async tx => {
        const [member, audit] = await Promise.all([tx.get(memberRef), tx.get(auditRef(orgId, eventId))]);
        if (audit.exists) return;
        if (member.exists && member.data()?.status === 'active') { status = 'already-member'; return; }
        const memberData = {
          schemaVersion: 1, role: 'nutritionist', status: 'active',
          email: input.email, emailNormalized: input.email,
          firstName: input.firstName || '', lastName: input.lastName || '',
          displayName: [input.firstName, input.lastName].filter(Boolean).join(' ') || input.email,
          updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
        };
        if (member.exists) tx.update(memberRef, memberData);
        else tx.create(memberRef, { ...memberData, createdAt: FieldValue.serverTimestamp(), createdBy: uid });
        tx.create(auditRef(orgId, eventId), auditEvent({
          orgId, eventId, type: 'member.added', actor,
          subject: { type: 'member', id: authUser.uid }, idempotencyKey: input.idempotencyKey,
          metadata: { role: 'nutritionist', email: maskEmail(input.email) }
        }));
      });
      return { status, userId: authUser.uid, email: input.email };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const inviteId = checksum(`${orgId}:nutri-invite:${input.email}:${input.idempotencyKey}`).slice(0, 32);
    const inviteRef = db.doc(`organizations/${orgId}/invitations/${inviteId}`);
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const eventId = checksum(`member.invited:${inviteId}`).slice(0, 32);
    let created = true;

    await db.runTransaction(async tx => {
      const [existing, audit] = await Promise.all([tx.get(inviteRef), tx.get(auditRef(orgId, eventId))]);
      if (existing.exists || audit.exists) { created = false; return; }
      tx.create(inviteRef, {
        schemaVersion: 2, inviteId, type: 'nutritionist', channel: 'manual-link',
        targetEmail: input.email, targetEmailNormalized: input.email,
        targetEmailHash: emailFingerprint(input.email),
        firstName: input.firstName || '', lastName: input.lastName || '',
        tokenHash: hashToken(token), status: 'pending', expiresAt: Timestamp.fromDate(expiresAt),
        delivery: { schemaVersion: 2, channel: 'manual-link', status: 'manual', handedToConsole: true, updatedAt: FieldValue.serverTimestamp() },
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid
      });
      tx.create(auditRef(orgId, eventId), auditEvent({
        orgId, eventId, type: 'member.invited', actor,
        subject: { type: 'invitation', id: inviteId }, idempotencyKey: input.idempotencyKey,
        metadata: { role: 'nutritionist', email: maskEmail(input.email) }
      }));
    });

    const inviteUrl = buildInviteLink(APP_PUBLIC_URL, token);
    return {
      status: created ? 'invited' : 'already-invited',
      inviteId,
      expiresAt: expiresAt.toISOString(),
      inviteUrl,
      token,
      delivery: { channel: 'manual-link', status: 'manual', handedToConsole: true }
    };
  }

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
  const snap = await findInvitationByTokenHash(tokenHash);
  if (snap.empty || snap.size > 1) throw new HttpsError('not-found', 'Invito non valido o già utilizzato');
  const inviteDoc = snap.docs[0];
  const invite = inviteDoc.data();
  const orgId = inviteDoc.ref.path.split('/')[1];
  if (orgId !== SINGLE_ORGANIZATION_ID) throw new HttpsError('permission-denied', 'Invito non valido per questa organizzazione');
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

// Attivazione/sospensione membership (creatore). Non si può modificare il proprio
// stato.
exports.setMemberStatus = callable(async (data, uid) => {
  const input = validateMemberStatus(data);
  const actor = await actorContext(input.organizationId, uid);
  requireCreator(actor);
  if (input.userId === uid) throw new HttpsError('failed-precondition', 'Non puoi modificare il tuo stato');
  const memberRef = db.doc(`organizations/${actor.organizationId}/members/${input.userId}`);
  const eventId = checksum(`member.status:${input.userId}:${input.status}:${input.idempotencyKey}`).slice(0, 32);
  const member = await memberRef.get();
  if (!member.exists || member.data()?.status === 'removed') throw new HttpsError('not-found', 'Membership non trovata: usa un nuovo invito');
  if (member.data()?.status === input.status) return { userId: input.userId, status: input.status, unchanged: true };
  await db.runTransaction(async tx => {
    if ((await tx.get(auditRef(actor.organizationId, eventId))).exists) return;
    tx.update(memberRef, { status: input.status, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'member.status-changed', actor, subject: { type: 'member', id: input.userId }, idempotencyKey: input.idempotencyKey, metadata: { status: input.status } }));
  });
  return { userId: input.userId, status: input.status };
});

// Invito di collegamento cliente: account esistente → richiesta da accettare
// in app; account inesistente → invito monouso (7gg, solo hash conservato).
// Il nutritionist invita solo per sé; il creatore può indicare il nutritionist
// destinatario oppure lasciarlo temporaneamente senza professionista.
exports.inviteClientLink = callable(async (data, uid) => {
  const input = validateInviteClientLink(data);
  const actor = await actorContext(input.organizationId, uid);
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
        // `channel: legacy-test` distingue esplicitamente le richieste del
        // flusso tecnico (username) da quelle con email reale (`channel: email`).
        schemaVersion: 1, requestId, organizationId: actor.organizationId, clientId,
        channel: 'legacy-test',
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
  // Compatibilità controllata (ADR 0004): l'account tecnico è un account di
  // test. La sua CREAZIONE è consentita solo con un flag esplicito o negli
  // emulatori; gli account tecnici esistenti continuano invece a funzionare
  // senza limiti (login, collegamento, riscatto degli inviti già emessi).
  if (!legacyTestInvitesAllowed()) {
    const blockedEventId = checksum(`client.invite-blocked-legacy:${actor.organizationId}:${input.username}:${input.idempotencyKey}`).slice(0, 32);
    await recordInviteAudit({
      orgId: actor.organizationId, actor, eventId: blockedEventId,
      type: 'client.invite-blocked-legacy', subject: { type: 'client', id: clientId },
      idempotencyKey: input.idempotencyKey, metadata: { channel: 'legacy-test' }
    });
    throw new HttpsError(
      'failed-precondition',
      'La creazione di nuovi account tecnici di test è disattivata: invita il cliente con la sua email reale (modulo “Invita cliente con email”)'
    );
  }
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
      // Invito legacy: tipo 'client' + channel 'legacy-test'. Solo per i test;
      // non viene mai creato per un invito reale (vedi inviteClientByEmail).
      schemaVersion: 1, inviteId, type: 'client', channel: 'legacy-test',
      targetUsername: input.username, clientId,
      nutritionistUid: nutritionistUid || null, tokenHash: hashToken(token),
      status: 'pending', expiresAt: Timestamp.fromDate(expiresAt),
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'client.link-invited', actor, subject: { type: 'client', id: clientId }, idempotencyKey: input.idempotencyKey, metadata: { via: 'invite' } }));
  });
  if (!created) return { status: 'already-invited', clientId, inviteId };
  return { status: 'invited', clientId, inviteId, expiresAt: expiresAt.toISOString(), token };
});

// =====================================================================
// Inviti con EMAIL REALE (nuovo flusso — ADR 0004) e convivenza legacy
// =====================================================================
// Regole di base di questo blocco:
//  - i nuovi clienti reali usano l'email reale come credenziale: nessun
//    username e nessuna email tecnica;
//  - gli account tecnici legacy (email fittizie) restano utilizzabili nei
//    test, non vengono migrati, cancellati né forzati al nuovo onboarding;
//  - la creazione di NUOVI account tecnici è possibile solo con un flag
//    esplicito (`LEGACY_TEST_INVITES_ENABLED=true`) o negli emulatori: il
//    fallback legacy non si attiva mai da solo per un invito reale;
//  - un invito reale non viene mai trasformato in un invito legacy;
//  - la consegna dell'invito è SEMPRE manuale: il backend costruisce il link
//    e lo restituisce alla console, che lo mostra con "Copia link" e
//    "Condividi link". Nessun provider email, nessuna chiave, nessuna
//    variabile d'ambiente e nessuno stato di "invio fallito". Verifica
//    dell'email e recupero password restano sui template di Firebase Auth.

const INVITE_TTL_DAYS = 7;
const CLIENT_EMAIL_INVITE_TYPE = 'clientEmail';
const LEGACY_CLIENT_INVITE_TYPE = 'client';

// Indirizzo pubblico dell'app dei clienti (GitHub Pages): base fissa dei link
// d'invito `#/invito/<token>`. Non è un segreto e non dipende dall'ambiente.
const APP_PUBLIC_URL = 'https://sylarpower.github.io/pianoNutrizionale';

function buildInviteLink(baseUrl, token) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Indirizzo pubblico dell’app non configurato');
  return `${base}/#/invito/${token}`;
}

function inviteExpiryDate({ days = INVITE_TTL_DAYS, now = new Date() } = {}) {
  return new Date(now.getTime() + days * 24 * 3600 * 1000);
}

async function findInvitationByTokenHash(tokenHash) {
  try {
    const primarySnap = await db.collection(`organizations/${SINGLE_ORGANIZATION_ID}/invitations`)
      .where('tokenHash', '==', tokenHash)
      .limit(2)
      .get();
    if (!primarySnap.empty) return primarySnap;
  } catch (err) {
    logger.warn('Ricerca inviti su collezione primaria fallita', { err: err?.message });
  }

  try {
    return await db.collectionGroup('invitations')
      .where('tokenHash', '==', tokenHash)
      .limit(2)
      .get();
  } catch (err) {
    logger.warn('collectionGroup invitations fallback non disponibile o indice mancante', { err: err?.message });
    return { empty: true, size: 0, docs: [] };
  }
}

// Flag esplicito e documentato per la creazione di account tecnici di test.
// In produzione è spento per default: si accende solo con la variabile
// d'ambiente `LEGACY_TEST_INVITES_ENABLED=true`.
function legacyTestInvitesAllowed() {
  if (typeof process === 'undefined' || !process.env) return true; // harness dei test senza `process`
  const flag = String(process.env.LEGACY_TEST_INVITES_ENABLED || '').trim().toLowerCase();
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return Boolean(process.env.FIRESTORE_EMULATOR_HOST || process.env.FUNCTIONS_EMULATOR);
}

// Require pigra: gli harness dei test esistenti caricano questo file senza
// stubbare `firebase-admin/auth`.
let adminAuthInstance = null;
function adminAuth() {
  if (!adminAuthInstance) adminAuthInstance = require('firebase-admin/auth').getAuth();
  return adminAuthInstance;
}

async function authUserByEmail(emailNormalized) {
  try {
    return await adminAuth().getUserByEmail(emailNormalized);
  } catch (error) {
    if (error?.code === 'auth/user-not-found') return null;
    logger.error('Verifica account Auth non riuscita', { code: error?.code, email: maskEmail(emailNormalized) });
    throw new HttpsError('internal', 'Verifica dell’account non disponibile: riprova tra poco');
  }
}

async function clientProfilesByEmail(orgId, emailNormalized) {
  const snap = await db.collection(`organizations/${orgId}/clients`)
    .where('emailNormalized', '==', emailNormalized).limit(5).get();
  return snap.docs.map(doc => ({ ref: doc.ref, id: doc.id, ...doc.data() }));
}

async function pendingEmailInvites(orgId, emailNormalized) {
  // Singolo filtro (ADR 0003): lo stato si seleziona in codice, senza
  // indici composti (la combinazione email+stato non è indicizzata).
  const snap = await db.collection(`organizations/${orgId}/invitations`)
    .where('targetEmailNormalized', '==', emailNormalized).limit(10).get();
  return snap.docs
    .filter(doc => doc.data()?.status === 'pending')
    .map(doc => ({ ref: doc.ref, id: doc.id, ...doc.data() }));
}

async function pendingLinkRequestsByEmail(orgId, emailNormalized) {
  // Singolo filtro (ADR 0003): lo stato si seleziona in codice.
  const snap = await db.collection(`organizations/${orgId}/clientLinkRequests`)
    .where('targetEmailNormalized', '==', emailNormalized).limit(10).get();
  return snap.docs
    .filter(doc => doc.data()?.status === 'pending')
    .map(doc => ({ ref: doc.ref, id: doc.id, ...doc.data() }));
}

function inviteExpiryIso(invite) {
  return invite?.expiresAt?.toDate?.()?.toISOString?.() || null;
}

// Un invito è modificabile/visibile solo al creatore piattaforma o al
// professionista che lo ha emesso (stesso principio delle Rules).
function authorizeInviteActor(actor, invite) {
  if (actor.isCreator) return true;
  return Boolean(invite?.createdBy) && invite.createdBy === actor.uid;
}

// Nome del professionista per l'anteprima dell'invito: mai dati di altri ruoli.
// Sessione 1: fallback [firstName lastName] → displayName → username.
async function professionalDisplayName(orgId, nutritionistUid) {
  if (!nutritionistUid) return null;
  const member = await db.doc(`organizations/${orgId}/members/${nutritionistUid}`).get();
  if (!member.exists) return null;
  const data = member.data() || {};
  const first = String(data.firstName || '').trim();
  const last = String(data.lastName || '').trim();
  const full = `${first} ${last}`.trim();
  if (full) return full;
  return data.displayName || data.username || null;
}

async function organizationDisplayName(orgId) {
  const org = await db.doc(`organizations/${orgId}`).get();
  return org.exists ? (org.data()?.name || orgId) : orgId;
}

// Audit idempotente anche per le operazioni bloccate (nessuna PII nei metadati).
async function recordInviteAudit({ orgId, actor, eventId, type, subject, idempotencyKey, metadata = {} }) {
  const ref = auditRef(orgId, eventId);
  await db.runTransaction(async tx => {
    if ((await tx.get(ref)).exists) return;
    tx.create(ref, auditEvent({ orgId, eventId, type, actor, subject, idempotencyKey, metadata }));
  });
}

// Consegna dell'invito: il link viene costruito qui e consegnato alla console,
// che lo mostra al nutrizionista con "Copia link" e "Condividi link". Il
// documento registra solo che il link è stato consegnato alla console: nessun
// invio automatico, nessuno stato di "invio fallito".
async function deliverClientInvite({ inviteRef, token, updatedBy }) {
  const link = buildInviteLink(APP_PUBLIC_URL, token);
  await inviteRef.update({
    delivery: {
      schemaVersion: 2, channel: INVITE_DELIVERY_CHANNEL, status: 'manual',
      handedToConsole: true, updatedAt: FieldValue.serverTimestamp()
    },
    updatedAt: FieldValue.serverTimestamp(), updatedBy
  });
  return { delivery: { channel: INVITE_DELIVERY_CHANNEL, status: 'manual' }, inviteUrl: link };
}

// Invito di un cliente con email reale. Idempotente per `idempotencyKey`,
// monouso (solo hash del token), con audit e stati distinti verso la console.
exports.inviteClientByEmail = callable(async (data, uid) => {
  const input = validateInviteClientEmail(data);
  const actor = await actorContext(input.organizationId, uid);
  const orgId = actor.organizationId;
  let nutritionistUid = input.nutritionistUid;
  // Come per il flusso legacy: il nutritionist invita solo per sé, il
  // creatore può indicare un professionista attivo oppure lasciare vuoto.
  if (actor.role === 'nutritionist') {
    if (nutritionistUid && nutritionistUid !== uid) {
      throw new HttpsError('permission-denied', 'Puoi invitare clienti solo per te');
    }
    nutritionistUid = uid;
  } else if (nutritionistUid) {
    const target = await db.doc(`organizations/${orgId}/members/${nutritionistUid}`).get();
    if (!target.exists || target.data()?.status !== 'active' || target.data()?.role !== 'nutritionist') {
      throw new HttpsError('failed-precondition', 'Nutritionist destinatario non valido');
    }
  }
  const [authUser, profiles, invites, requests] = await Promise.all([
    authUserByEmail(input.email),
    clientProfilesByEmail(orgId, input.email),
    pendingEmailInvites(orgId, input.email),
    pendingLinkRequestsByEmail(orgId, input.email)
  ]);
  const profile = profiles[0] || null;
  const link = authUser ? await db.doc(`accountClientLinks/${authUser.uid}`).get() : null;
  const activeLink = link?.exists ? link.data() : null;

  // 1) associazione già attiva: nessun duplicato e nessun dato di altri
  //    professionisti (il nome dell'altro professionista non esce mai).
  if (activeLink && activeLink.status === 'active') {
    const linkedClient = await db.doc(`organizations/${activeLink.organizationId}/clients/${activeLink.clientId}`).get();
    const linkedNutritionists = linkedClient.exists ? (linkedClient.data()?.nutritionistUids || []) : [];
    const sameProfessional = nutritionistUid ? linkedNutritionists.includes(nutritionistUid) : linkedNutritionists.length === 0;
    const blockedEventId = checksum(`client.invite-blocked:${orgId}:${input.email}:${input.idempotencyKey}`).slice(0, 32);
    await recordInviteAudit({
      orgId, actor, eventId: blockedEventId,
      type: sameProfessional ? 'client.invite-blocked-same' : 'client.invite-blocked-other',
      subject: { type: 'client', id: activeLink.clientId }, idempotencyKey: input.idempotencyKey,
      metadata: { channel: 'email' }
    });
    return sameProfessional
      ? { status: 'already-linked-same', clientId: activeLink.clientId, message: 'Questo cliente è già associato a te.' }
      : { status: 'already-linked-other', message: 'Questo account è già associato a un altro professionista e non può ricevere un nuovo invito.' };
  }

  // 2) richiesta di collegamento già pendente
  if (requests.length) {
    const mine = requests.find(item => item.nutritionistUid === nutritionistUid) || null;
    return {
      status: 'already-pending',
      requestId: (mine || requests[0]).id,
      clientId: (mine || requests[0]).clientId,
      message: mine
        ? 'Esiste già una richiesta in attesa di risposta del cliente.'
        : 'Esiste già una richiesta in attesa per questo indirizzo.'
    };
  }

  // 3) invito già pendente
  if (invites.length) {
    const replay = invites.find(item => item.idempotencyKey === input.idempotencyKey) || null;
    if (replay) {
      return {
        status: 'already-pending', inviteId: replay.id, expiresAt: inviteExpiryIso(replay),
        idempotentReplay: true,
        message: 'Invito già creato in precedenza: nessun nuovo token emesso.'
      };
    }
    const mine = invites.find(item => item.nutritionistUid === nutritionistUid) || null;
    return {
      status: 'already-pending',
      ...(mine ? { inviteId: mine.id, expiresAt: inviteExpiryIso(mine) } : {}),
      message: mine
        ? 'Esiste già un invito pendente per questo indirizzo: usa "Rinvia" per un nuovo link oppure "Correggi" per cambiare i dati.'
        : 'Esiste già un invito pendente per questo indirizzo.'
    };
  }

  const clientId = profile?.id || checksum(`${orgId}:clientemail:${input.email}:${input.idempotencyKey}`).slice(0, 24);
  const clientRef = db.doc(`organizations/${orgId}/clients/${clientId}`);
  const displayCode = profile?.displayCode || `CL-${checksum(clientId).slice(0, 6).toUpperCase()}`;
  const nutritionistUids = nutritionistUid ? [nutritionistUid] : [];

  // 4) account già esistente senza associazione → richiesta da accettare in app
  if (authUser) {
    if (authUser.disabled) {
      throw new HttpsError('failed-precondition', 'Account disabilitato: va riabilitato dall’amministrazione prima di un nuovo invito');
    }
    const requestId = checksum(`${orgId}:linkreq:${input.email}:${input.idempotencyKey}`).slice(0, 32);
    const requestRef = db.doc(`organizations/${orgId}/clientLinkRequests/${requestId}`);
    const eventId = checksum(`client.link-requested:${requestId}`).slice(0, 32);
    await db.runTransaction(async tx => {
      const [client, existing, audit] = await Promise.all([
        tx.get(clientRef), tx.get(requestRef), tx.get(auditRef(orgId, eventId))
      ]);
      if (existing.exists || audit.exists) return;
      const commonProfile = {
        schemaVersion: 2, authUid: authUser.uid, displayCode, status: 'pending',
        email: input.email, emailNormalized: input.email,
        firstName: input.firstName, lastName: input.lastName,
        nutritionistUids, activeAssignment: null,
        updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
      };
      if (client.exists) tx.update(clientRef, commonProfile);
      else tx.create(clientRef, { ...commonProfile, invitedUsername: null, createdAt: FieldValue.serverTimestamp(), createdBy: uid });
      tx.create(requestRef, {
        schemaVersion: 2, requestId, organizationId: orgId, clientId, channel: 'email',
        targetUid: authUser.uid, targetEmailNormalized: input.email,
        targetEmailHash: emailFingerprint(input.email),
        nutritionistUid: nutritionistUid || null, status: 'pending',
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid
      });
      tx.create(auditRef(orgId, eventId), auditEvent({
        orgId, eventId, type: 'client.link-requested', actor,
        subject: { type: 'client', id: clientId }, idempotencyKey: input.idempotencyKey,
        metadata: { channel: 'email', nutritionistUid: nutritionistUid || null }
      }));
      tx.create(db.doc(`organizations/${orgId}/notifications/${eventId}`), {
        schemaVersion: 1, notificationId: eventId, recipientUid: authUser.uid,
        type: 'client.link-requested', subjectId: clientId, readAt: null, dedupeKey: eventId,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        delivery: { inApp: 'pending', email: 'disabled' }
      });
    });
    return {
      status: 'link-request-created', clientId, requestId,
      message: 'Richiesta inviata: il cliente accetta o rifiuta dall’app.'
    };
  }

  // 5) cliente nuovo → invito monouso (token salvato solo come hash)
  const inviteId = checksum(`${orgId}:clientemail-invite:${input.email}:${input.idempotencyKey}`).slice(0, 32);
  const inviteRef = db.doc(`organizations/${orgId}/invitations/${inviteId}`);
  const eventId = checksum(`client.email-invited:${inviteId}`).slice(0, 32);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = inviteExpiryDate({ days: INVITE_TTL_DAYS });
  let created = true;
  await db.runTransaction(async tx => {
    const [client, existing, audit] = await Promise.all([
      tx.get(clientRef), tx.get(inviteRef), tx.get(auditRef(orgId, eventId))
    ]);
    if (existing.exists || audit.exists) { created = false; return; }
    // Un solo invito pendente per indirizzo/cliente: i precedenti vengono
    // invalidati (il vecchio link smette di funzionare) e restano in storico.
    // Singolo filtro (ADR 0003): lo stato si seleziona in codice.
    const stale = await tx.get(
      db.collection(`organizations/${orgId}/invitations`)
        .where('targetEmailNormalized', '==', input.email)
    );
    stale.docs.filter(doc => doc.id !== inviteId && doc.data()?.status === 'pending').forEach(doc => tx.update(doc.ref, {
      status: 'superseded', supersededBy: inviteId,
      supersededAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    }));
    const commonProfile = {
      schemaVersion: 2, authUid: null, displayCode, status: 'pending',
      email: input.email, emailNormalized: input.email,
      firstName: input.firstName, lastName: input.lastName,
      nutritionistUids, activeAssignment: null,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    };
    if (client.exists) tx.update(clientRef, commonProfile);
    else tx.create(clientRef, { ...commonProfile, invitedUsername: null, createdAt: FieldValue.serverTimestamp(), createdBy: uid });
    tx.create(inviteRef, {
      schemaVersion: 2, inviteId, type: CLIENT_EMAIL_INVITE_TYPE, channel: 'email',
      organizationId: orgId, targetEmailNormalized: input.email,
      targetEmailHash: emailFingerprint(input.email),
      firstName: input.firstName, lastName: input.lastName,
      clientId, nutritionistUid: nutritionistUid || null,
      tokenHash: hashToken(token), status: 'pending',
      expiresAt: Timestamp.fromDate(expiresAt),
      delivery: { schemaVersion: 2, channel: INVITE_DELIVERY_CHANNEL, status: 'pending', updatedAt: FieldValue.serverTimestamp() },
      idempotencyKey: input.idempotencyKey,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid
    });
    tx.create(auditRef(orgId, eventId), auditEvent({
      orgId, eventId, type: 'client.email-invited', actor,
      subject: { type: 'invitation', id: inviteId }, idempotencyKey: input.idempotencyKey,
      metadata: { clientId, nutritionistUid: nutritionistUid || null, delivery: INVITE_DELIVERY_CHANNEL }
    }));
  });
  if (!created) {
    return {
      status: 'already-pending', inviteId, expiresAt: expiresAt.toISOString(),
      idempotentReplay: true, message: 'Invito già creato in precedenza: nessun nuovo token emesso.'
    };
  }
  const deliveryResult = await deliverClientInvite({ inviteRef, token, updatedBy: uid });
  const deliveredEventId = checksum(`client.email-invite-delivered:${inviteId}`).slice(0, 32);
  await recordInviteAudit({
    orgId, actor, eventId: deliveredEventId, type: 'client.email-invite-delivered',
    subject: { type: 'invitation', id: inviteId }, idempotencyKey: input.idempotencyKey,
    metadata: { channel: deliveryResult.delivery.channel, status: deliveryResult.delivery.status }
  });
  return {
    inviteId, clientId, expiresAt: expiresAt.toISOString(), ...deliveryResult,
    status: 'invited',
    message: 'Invito creato: consegna questo link al cliente con “Copia link” o “Condividi link”.'
  };
});

// Anteprima pubblica dell'invito (nessuna autenticazione: il token è il
// segreto). Non scrive nulla e non rivela dati di altri utenti.
exports.getClientInvitePreview = onCall(callableOptions, async request => {
  try {
    exactObject(request.data || {}, ['token']);
    const token = text((request.data || {}).token, 'token', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const snap = await findInvitationByTokenHash(hashToken(token));
    if (snap.empty || snap.size > 1) return { status: 'not-found' };
    const doc = snap.docs[0];
    const invite = doc.data();
    const orgId = doc.ref.path.split('/')[1];
    if ((invite.type !== CLIENT_EMAIL_INVITE_TYPE && invite.type !== 'nutritionist') || orgId !== SINGLE_ORGANIZATION_ID) {
      return { status: 'not-found' };
    }
    const expiresAt = invite.expiresAt?.toDate?.() || null;
    const expired = !expiresAt || expiresAt.getTime() <= Date.now();
    let status = 'expired';
    if (invite.status === 'pending') status = expired ? 'expired' : 'valid';
    else if (invite.status === 'accepted') status = 'used';
    else if (invite.status === 'superseded') status = 'superseded';
    else if (invite.status === 'revoked') status = 'revoked';
    let organizationName;
    if (invite.type === 'nutritionist') {
      const orgDisplay = await organizationDisplayName(orgId);
      organizationName = (orgDisplay && orgDisplay !== orgId) ? orgDisplay : 'Studio Professionale';
      if (organizationName === orgId) organizationName = 'Studio Professionale';
    } else {
      organizationName = await organizationDisplayName(orgId);
    }
    const nutritionistName = status === 'valid' ? await professionalDisplayName(orgId, invite.nutritionistUid) : null;
    return {
      status,
      type: invite.type || CLIENT_EMAIL_INVITE_TYPE,
      email: invite.targetEmailNormalized || invite.targetEmail || null,
      firstName: invite.firstName || null,
      lastName: invite.lastName || null,
      expiresAt: inviteExpiryIso(invite),
      organizationName,
      nutritionistName
    };
  } catch (error) {
    throw apiError(error);
  }
});

// Riscatto dell'invito email da parte del cliente autenticato. Il collegamento
// diventa attivo SOLO con l'email verificata (decisione ADR 0004): qui il
// token non viene mai consumato prima. Il token è facoltativo perché l'invito
// resta recuperabile anche solo dall'email autenticata e verificata.
exports.redeemClientInvite = callable(async (data, uid, request) => {
  const input = validateRedeemClientInvite(data);
  const emailVerified = request?.auth?.token?.email_verified === true;
  const authEmail = String(request?.auth?.token?.email || '').trim().toLowerCase();
  let inviteDoc = null;
  let invite = null;
  if (input.token) {
    const snap = await findInvitationByTokenHash(hashToken(input.token));
    if (snap.empty || snap.size > 1) throw new HttpsError('not-found', 'Invito non valido o già utilizzato');
    inviteDoc = snap.docs[0];
    invite = inviteDoc.data();
    if (invite.type !== CLIENT_EMAIL_INVITE_TYPE && invite.type !== 'nutritionist') {
      throw new HttpsError('not-found', 'Invito non valido o già utilizzato');
    }
  } else {
    if (!emailVerified || !authEmail) return { status: 'no-pending-invite' };
    const snap = await db.collection(`organizations/${SINGLE_ORGANIZATION_ID}/invitations`)
      .where('targetEmailNormalized', '==', authEmail)
      .where('status', '==', 'pending').limit(2).get();
    if (snap.empty) return { status: 'no-pending-invite' };
    inviteDoc = snap.docs[0];
    invite = inviteDoc.data();
    // Solo gli inviti del nuovo modello si riscattano via email: quelli legacy
    // passano dal percorso con token e username.
    if (invite.type !== CLIENT_EMAIL_INVITE_TYPE) return { status: 'no-pending-invite' };
  }
  const orgId = inviteDoc.ref.path.split('/')[1];
  if (orgId !== SINGLE_ORGANIZATION_ID) throw new HttpsError('not-found', 'Invito non valido');
  const expiresAt = invite.expiresAt?.toDate?.() || null;
  if (invite.status !== 'pending') {
    if (invite.status === 'accepted' && invite.redeemedBy === uid) {
      if (invite.type === 'nutritionist') {
        return { status: 'already-linked', role: 'nutritionist', organizationId: orgId };
      }
      return { status: 'already-linked', organizationId: orgId, clientId: invite.clientId };
    }
    throw new HttpsError('failed-precondition', invite.status === 'superseded'
      ? 'Questo link è stato sostituito: usa il link più recente oppure chiedine uno nuovo al tuo nutrizionista'
      : 'Invito non più valido: chiedi un nuovo link al tuo nutrizionista');
  }
  if (!expiresAt || expiresAt.getTime() <= Date.now()) {
    // Marcatura di scadenza: nessun consumo del token, riprova impossibile.
    await inviteDoc.ref.update({ status: 'expired', updatedAt: FieldValue.serverTimestamp() });
    throw new HttpsError('failed-precondition', 'Invito scaduto: chiedi un nuovo link al tuo nutrizionista');
  }
  const targetEmailNorm = invite.targetEmailNormalized || null;
  const targetEmailRaw = invite.targetEmail ? String(invite.targetEmail).trim().toLowerCase() : null;
  const emailMatches = (targetEmailNorm && targetEmailNorm === authEmail) || (targetEmailRaw && targetEmailRaw === authEmail) || (!targetEmailNorm && !targetEmailRaw);
  if (targetEmailNorm && targetEmailNorm !== authEmail && !(targetEmailRaw && targetEmailRaw === authEmail)) {
    // Per retrocompatibilità manteniamo il controllo stretto, ma consentiamo match su targetEmail
    if (!emailMatches) {
      throw new HttpsError('permission-denied', 'Questo invito è stato emesso per un altro indirizzo email');
    }
  } else if (!emailMatches) {
    throw new HttpsError('permission-denied', 'Questo invito è stato emesso per un altro indirizzo email');
  }
  // Il collegamento abilita dati professionali: si attiva dopo la verifica.
  if (!emailVerified) {
    return {
      status: 'email-verification-required', email: authEmail,
      ...(invite.type === 'nutritionist' ? {} : { clientId: invite.clientId }),
      message: 'Verifica il tuo indirizzo email: poi il collegamento si attiva da solo.'
    };
  }

  if (invite.type === 'nutritionist') {
    const firstName = invite.firstName || '';
    const lastName = invite.lastName || '';
    const displayName = [firstName, lastName].filter(Boolean).join(' ') || authEmail;
    const memberRef = db.doc(`organizations/${orgId}/members/${uid}`);
    const eventId = checksum(`member.invite-redeemed:${inviteDoc.id}:${uid}`).slice(0, 32);
    const actor = { uid, role: 'nutritionist' };
    await db.runTransaction(async tx => {
      const [fresh, member, audit] = await Promise.all([
        tx.get(inviteDoc.ref), tx.get(memberRef), tx.get(auditRef(orgId, eventId))
      ]);
      if (audit.exists) return;
      if (fresh.data()?.status !== 'pending') throw new HttpsError('failed-precondition', 'Invito non più valido: chiedi un nuovo link');
      const prev = member.exists ? member.data() : {};
      tx.set(memberRef, {
        schemaVersion: 1,
        role: 'nutritionist',
        status: 'active',
        email: authEmail,
        emailNormalized: authEmail,
        firstName,
        lastName,
        displayName,
        createdAt: prev.createdAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        createdBy: prev.createdBy || uid,
        updatedBy: uid
      }, { merge: true });
      tx.update(inviteDoc.ref, {
        status: 'accepted',
        redeemedBy: uid,
        registeredAt: FieldValue.serverTimestamp(),
        verifiedAt: FieldValue.serverTimestamp(),
        decidedAt: FieldValue.serverTimestamp(),
        decidedBy: uid,
        updatedAt: FieldValue.serverTimestamp()
      });
      tx.create(auditRef(orgId, eventId), auditEvent({
        orgId, eventId, type: 'member.invite-redeemed', actor,
        subject: { type: 'member', id: uid }, idempotencyKey: input.idempotencyKey,
        metadata: { via: 'invite', email: authEmail }
      }));
    });
    return { status: 'link-active', role: 'nutritionist', organizationId: orgId };
  }

  const linkSnap = await db.doc(`accountClientLinks/${uid}`).get();
  if (linkSnap.exists && linkSnap.data()?.status === 'active' && linkSnap.data()?.clientId !== invite.clientId) {
    throw new HttpsError('failed-precondition', 'Questo account è già associato a un altro professionista e non può ricevere un nuovo invito');
  }
  const clientRef = db.doc(`organizations/${orgId}/clients/${invite.clientId}`);
  const eventId = checksum(`client.invite-redeemed:${inviteDoc.id}:${uid}`).slice(0, 32);
  const actor = { uid, role: 'client' };
  await db.runTransaction(async tx => {
    const [fresh, client, audit] = await Promise.all([
      tx.get(inviteDoc.ref), tx.get(clientRef), tx.get(auditRef(orgId, eventId))
    ]);
    if (audit.exists) return;
    if (fresh.data()?.status !== 'pending') throw new HttpsError('failed-precondition', 'Invito non più valido: chiedi un nuovo link al tuo nutrizionista');
    const previous = client.exists ? client.data() : {};
    tx.set(clientRef, {
      schemaVersion: 2, authUid: uid, status: 'active',
      email: authEmail, emailNormalized: authEmail, emailVerified: true,
      firstName: invite.firstName, lastName: invite.lastName,
      invitedUsername: previous.invitedUsername || null,
      nutritionistUids: previous.nutritionistUids || (invite.nutritionistUid ? [invite.nutritionistUid] : []),
      activeAssignment: previous.activeAssignment || null,
      createdAt: previous.createdAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(), createdBy: previous.createdBy || uid, updatedBy: uid
    }, { merge: true });
    tx.set(db.doc(`accountClientLinks/${uid}`), {
      schemaVersion: 2, organizationId: orgId, clientId: invite.clientId, status: 'active',
      channel: 'email', linkedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    tx.update(inviteDoc.ref, {
      status: 'accepted', redeemedBy: uid, registeredAt: FieldValue.serverTimestamp(),
      verifiedAt: FieldValue.serverTimestamp(), decidedAt: FieldValue.serverTimestamp(), decidedBy: uid,
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(auditRef(orgId, eventId), auditEvent({
      orgId, eventId, type: 'client.link-accepted', actor,
      subject: { type: 'client', id: invite.clientId }, idempotencyKey: input.idempotencyKey,
      metadata: { via: 'email-invite', channel: 'email' }
    }));
    tx.create(db.doc(`organizations/${orgId}/notifications/${eventId}`), {
      schemaVersion: 1, notificationId: eventId, recipientUid: uid,
      type: 'client.link-activated', subjectId: invite.clientId, readAt: null, dedupeKey: eventId,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      delivery: { inApp: 'pending', email: 'disabled' }
    });
  });
  return {
    status: 'link-active', organizationId: orgId, clientId: invite.clientId,
    email: authEmail,
    message: 'Collegamento attivo: il tuo nutrizionista può condividere il profilo.'
  };
});

// Reinvio di un invito email: ruota il token (il vecchio link smette di
// funzionare) mantenendo gli stessi dati, con audit e nuovo stato di consegna.
exports.resendClientInvite = callable(async (data, uid) => {
  const input = validateResendClientInvite(data);
  const actor = await actorContext(input.organizationId, uid);
  const orgId = actor.organizationId;
  const inviteRef = db.doc(`organizations/${orgId}/invitations/${input.inviteId}`);
  const snapshot = await inviteRef.get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Invito non trovato');
  const invite = snapshot.data();
  if (!authorizeInviteActor(actor, invite)) throw new HttpsError('permission-denied', 'Invito non autorizzato');
  if (invite.type !== CLIENT_EMAIL_INVITE_TYPE && invite.type !== 'nutritionist') {
    throw new HttpsError('failed-precondition', 'Questo invito usa il flusso legacy: creane uno nuovo dal modulo legacy oppure annullalo');
  }
  if (invite.status === 'accepted') throw new HttpsError('failed-precondition', 'Invito già utilizzato: il cliente è registrato');
  if (invite.status === 'revoked') throw new HttpsError('failed-precondition', 'Invito annullato: creane uno nuovo');
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = inviteExpiryDate({ days: INVITE_TTL_DAYS });
  const eventId = checksum(`client.email-invite-resent:${input.inviteId}:${input.idempotencyKey}`).slice(0, 32);
  let rotated = true;
  await db.runTransaction(async tx => {
    const [fresh, audit] = await Promise.all([tx.get(inviteRef), tx.get(auditRef(orgId, eventId))]);
    if (audit.exists) { rotated = false; return; }
    if (fresh.data()?.status === 'accepted') throw new HttpsError('failed-precondition', 'Invito già utilizzato: il cliente è registrato');
    if (fresh.data()?.status === 'revoked') throw new HttpsError('failed-precondition', 'Invito annullato: creane uno nuovo');
    tx.update(inviteRef, {
      tokenHash: hashToken(token), status: 'pending', expiresAt: Timestamp.fromDate(expiresAt),
      delivery: { schemaVersion: 2, channel: INVITE_DELIVERY_CHANNEL, status: 'pending', updatedAt: FieldValue.serverTimestamp() },
      tokenRotation: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    });
    tx.create(auditRef(orgId, eventId), auditEvent({
      orgId, eventId, type: 'client.email-invite-resent', actor,
      subject: { type: 'invitation', id: input.inviteId }, idempotencyKey: input.idempotencyKey,
      metadata: { delivery: INVITE_DELIVERY_CHANNEL }
    }));
  });
  if (!rotated) return { status: 'already-pending', inviteId: input.inviteId, message: 'Reinvio già effettuato.' };
  const deliveryResult = await deliverClientInvite({ inviteRef, token, updatedBy: uid });
  return {
    inviteId: input.inviteId, clientId: invite.clientId || null, expiresAt: expiresAt.toISOString(), ...deliveryResult,
    status: 'invite-resent',
    message: 'Nuovo link pronto: il link precedente non funziona più. Consegnalo con “Copia link” o “Condividi link”.'
  };
});

// Annullamento di un invito pendente (email o legacy): il token non è più
// riscattabile, il documento resta in storico come "revoked".
exports.cancelClientInvite = callable(async (data, uid) => {
  const input = validateCancelClientInvite(data);
  const actor = await actorContext(input.organizationId, uid);
  const orgId = actor.organizationId;
  const inviteRef = db.doc(`organizations/${orgId}/invitations/${input.inviteId}`);
  const snapshot = await inviteRef.get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Invito non trovato');
  const invite = snapshot.data();
  if (!authorizeInviteActor(actor, invite)) throw new HttpsError('permission-denied', 'Invito non autorizzato');
  const isClientInvite = invite.type === CLIENT_EMAIL_INVITE_TYPE || invite.type === LEGACY_CLIENT_INVITE_TYPE;
  if (!isClientInvite) throw new HttpsError('failed-precondition', 'Solo gli inviti cliente si annullano da qui');
  if (invite.status === 'accepted') throw new HttpsError('failed-precondition', 'Invito già utilizzato: usa "Rimuovi collegamento" dalla vista Clienti');
  const eventId = checksum(`client.email-invite-cancelled:${input.inviteId}:${input.idempotencyKey}`).slice(0, 32);
  let cancelled = true;
  await db.runTransaction(async tx => {
    const [fresh, audit] = await Promise.all([tx.get(inviteRef), tx.get(auditRef(orgId, eventId))]);
    if (audit.exists) { cancelled = false; return; }
    if (fresh.data()?.status === 'accepted') throw new HttpsError('failed-precondition', 'Invito già utilizzato: usa "Rimuovi collegamento" dalla vista Clienti');
    tx.update(inviteRef, {
      status: 'revoked', revocationReason: input.reason,
      decidedAt: FieldValue.serverTimestamp(), decidedBy: uid,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    });
    tx.create(auditRef(orgId, eventId), auditEvent({
      orgId, eventId, type: 'client.invite-cancelled', actor,
      subject: { type: 'invitation', id: input.inviteId }, idempotencyKey: input.idempotencyKey,
      metadata: { reason: input.reason }
    }));
  });
  return { inviteId: input.inviteId, status: cancelled ? 'revoked' : 'already-revoked' };
});

// Correzione dei dati di un invito pendente/scaduto: nuovo token, vecchio
// link invalidato, nessun invito concorrente, audit completo.
exports.correctClientInvite = callable(async (data, uid) => {
  const input = validateCorrectClientInvite(data);
  const actor = await actorContext(input.organizationId, uid);
  const orgId = actor.organizationId;
  const oldRef = db.doc(`organizations/${orgId}/invitations/${input.inviteId}`);
  const snapshot = await oldRef.get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Invito non trovato');
  const previous = snapshot.data();
  if (!authorizeInviteActor(actor, previous)) throw new HttpsError('permission-denied', 'Invito non autorizzato');
  if (previous.type !== CLIENT_EMAIL_INVITE_TYPE) {
    throw new HttpsError('failed-precondition', 'Questo invito usa il flusso legacy: annullalo e crea un nuovo invito legacy');
  }
  if (previous.status === 'accepted') {
    throw new HttpsError('failed-precondition', 'Il cliente è già registrato: usa la vista Clienti per aggiornare i dati');
  }
  if (!['pending', 'expired', 'superseded'].includes(previous.status)) {
    throw new HttpsError('failed-precondition', 'Invito non correggibile: creane uno nuovo');
  }
  const authUser = await authUserByEmail(input.email);
  if (authUser) {
    throw new HttpsError('already-exists', 'Esiste già un account con questo indirizzo: invitalo come cliente esistente (riceverà una richiesta da accettare in app)');
  }
  const clientId = previous.clientId;
  const clientRef = db.doc(`organizations/${orgId}/clients/${clientId}`);
  const nextExpiry = inviteExpiryDate({ days: INVITE_TTL_DAYS });
  const token = crypto.randomBytes(32).toString('hex');
  const inviteId = checksum(`${orgId}:clientemail-invite:${input.email}:${input.idempotencyKey}`).slice(0, 32);
  const sameDocument = inviteId === input.inviteId;
  const newRef = sameDocument ? oldRef : db.doc(`organizations/${orgId}/invitations/${inviteId}`);
  const eventId = checksum(`client.email-invite-corrected:${input.inviteId}:${input.idempotencyKey}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [old, audit] = await Promise.all([tx.get(oldRef), tx.get(auditRef(orgId, eventId))]);
    if (audit.exists) return;
    if (old.data()?.status === 'accepted') {
      throw new HttpsError('failed-precondition', 'Il cliente è già registrato: usa la vista Clienti per aggiornare i dati');
    }
    // Singolo filtro (ADR 0003): lo stato si seleziona in codice.
    const otherPending = await tx.get(
      db.collection(`organizations/${orgId}/invitations`)
        .where('targetEmailNormalized', '==', input.email)
    );
    otherPending.docs.filter(doc => doc.id !== inviteId && doc.data()?.status === 'pending').forEach(doc => tx.update(doc.ref, {
      status: 'superseded', supersededBy: inviteId,
      supersededAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    }));
    const inviteBody = {
      schemaVersion: 2, inviteId, type: CLIENT_EMAIL_INVITE_TYPE, channel: 'email',
      organizationId: orgId, targetEmailNormalized: input.email,
      targetEmailHash: emailFingerprint(input.email),
      firstName: input.firstName, lastName: input.lastName,
      clientId, nutritionistUid: previous.nutritionistUid || null,
      tokenHash: hashToken(token), status: 'pending',
      expiresAt: Timestamp.fromDate(nextExpiry),
      delivery: { schemaVersion: 2, channel: INVITE_DELIVERY_CHANNEL, status: 'pending', updatedAt: FieldValue.serverTimestamp() },
      idempotencyKey: input.idempotencyKey,
      correctedFrom: input.inviteId, createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(), createdBy: previous.createdBy || uid
    };
    if (sameDocument) {
      tx.set(newRef, inviteBody, { merge: true });
    } else {
      tx.set(oldRef, {
        status: 'superseded', supersededBy: inviteId,
        supersededAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
      }, { merge: true });
      tx.create(newRef, inviteBody);
    }
    // `authUid` non viene toccato: se il cliente si era già registrato senza
    // completare la verifica, il suo account resta il suo.
    tx.set(clientRef, {
      schemaVersion: 2, status: 'pending',
      email: input.email, emailNormalized: input.email,
      firstName: input.firstName, lastName: input.lastName,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    }, { merge: true });
    const changed = [];
    if (previous.targetEmailNormalized !== input.email) changed.push('email');
    if (previous.firstName !== input.firstName) changed.push('firstName');
    if (previous.lastName !== input.lastName) changed.push('lastName');
    tx.create(auditRef(orgId, eventId), auditEvent({
      orgId, eventId, type: 'client.email-invite-corrected', actor,
      subject: { type: 'invitation', id: inviteId }, idempotencyKey: input.idempotencyKey,
      metadata: { previousInviteId: input.inviteId, changed, delivery: INVITE_DELIVERY_CHANNEL }
    }));
  });
  const deliveryResult = await deliverClientInvite({ inviteRef: newRef, token, updatedBy: uid });
  return {
    inviteId, clientId, expiresAt: nextExpiry.toISOString(), ...deliveryResult,
    status: 'invite-corrected',
    message: 'Dati corretti: il link precedente non funziona più. Consegna il nuovo link con “Copia link” o “Condividi link”.'
  };
});

// Anagrafica del cliente (nome, cognome ed eventuale email) aggiornata dal nutrizionista.
// Se l'email viene modificata, viene aggiornata direttamente sia sul profilo cliente
// sia su Firebase Authentication (se l'account esiste già).
exports.updateClientProfileByStaff = callable(async (data, uid) => {
  const input = validateUpdateClientProfileByStaff(data);
  const actor = await actorContext(input.organizationId, uid);
  const client = await authorizedClient(actor, input.clientId);
  const orgId = actor.organizationId;
  const eventId = checksum(`client.profile-updated-staff:${client.id}:${input.idempotencyKey}`).slice(0, 32);

  const newEmail = input.email ? input.email : null;
  const currentEmail = client.emailNormalized || client.email || null;
  const emailChanging = Boolean(newEmail && newEmail !== currentEmail);

  if (emailChanging) {
    const otherProfiles = await clientProfilesByEmail(orgId, newEmail);
    if (otherProfiles.some(item => item.id !== client.id)) {
      throw new HttpsError('already-exists', 'Esiste già un profilo cliente con questo indirizzo email');
    }
  }

  await db.runTransaction(async tx => {
    const [fresh, audit] = await Promise.all([tx.get(client.ref), tx.get(auditRef(actor.organizationId, eventId))]);
    if (audit.exists) return;
    const updateData = {
      firstName: input.firstName, lastName: input.lastName,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    };
    if (emailChanging) {
      updateData.email = newEmail;
      updateData.emailNormalized = newEmail;
      updateData.emailVerified = false;
    }
    tx.update(client.ref, updateData);

    // Se ci sono inviti pendenti per questo cliente, aggiorniamo l'email e l'anagrafica
    if (emailChanging) {
      const pendingInvites = await tx.get(
        db.collection(`organizations/${orgId}/invitations`).where('clientId', '==', client.id)
      );
      pendingInvites.docs.filter(doc => doc.data()?.status === 'pending').forEach(doc => {
        tx.update(doc.ref, {
          targetEmailNormalized: newEmail,
          firstName: input.firstName,
          lastName: input.lastName,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: uid
        });
      });
    }

    tx.create(auditRef(actor.organizationId, eventId), auditEvent({
      orgId: actor.organizationId, eventId, type: 'client.profile-updated-staff', actor,
      subject: { type: 'client', id: client.id }, idempotencyKey: input.idempotencyKey,
      metadata: { fields: emailChanging ? ['firstName', 'lastName', 'email'] : ['firstName', 'lastName'] }
    }));
    if (fresh.data()?.authUid) {
      tx.create(db.doc(`organizations/${actor.organizationId}/notifications/${eventId}`), {
        schemaVersion: 1, notificationId: eventId, recipientUid: fresh.data().authUid,
        type: 'client.profile-updated', subjectId: client.id, readAt: null, dedupeKey: eventId,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        delivery: { inApp: 'pending', email: 'disabled' }
      });
    }
  });

  if (emailChanging && client.authUid) {
    try {
      await adminAuth().updateUser(client.authUid, { email: newEmail, emailVerified: false });
    } catch (error) {
      if (error?.code === 'auth/email-already-exists') {
        throw new HttpsError('already-exists', 'Esiste già un account con questo nuovo indirizzo email');
      }
      logger.error('Aggiornamento email Auth non riuscito', { code: error?.code, email: maskEmail(newEmail) });
      throw new HttpsError('internal', 'Aggiornamento email di autenticazione non riuscito');
    }
  }

  return {
    clientId: client.id, firstName: input.firstName, lastName: input.lastName,
    ...(emailChanging ? { email: newEmail } : {})
  };
});

// Eliminazione definitiva di un cliente dalla piattaforma (SOLO ADMIN / CREATORE).
// Esegue un wipe completo: cancella la scheda cliente, lo storico delle assegnazioni,
// activeAssignment, accountClientLinks/{authUid}, eventuali inviti/richieste, e cancella
// l'account Firebase Authentication corrispondente liberando l'indirizzo email.
exports.deleteClientPermanently = callable(async (data, uid) => {
  const input = validateDeleteClientPermanently(data);
  const actor = await actorContext(input.organizationId, uid);
  requireCreator(actor);
  const orgId = actor.organizationId;
  const clientRef = db.doc(`organizations/${orgId}/clients/${input.clientId}`);
  const clientSnap = await clientRef.get();
  if (!clientSnap.exists) throw new HttpsError('not-found', 'Cliente non trovato');
  const clientData = clientSnap.data();
  const authUid = clientData.authUid || null;
  const eventId = checksum(`client.deleted-permanently:${input.clientId}:${input.idempotencyKey}`).slice(0, 32);

  await db.runTransaction(async tx => {
    const [assignmentsSnap, pendingRequests, pendingInvites] = await Promise.all([
      tx.get(db.collection(`organizations/${orgId}/clients/${input.clientId}/assignments`)),
      tx.get(db.collection(`organizations/${orgId}/clientLinkRequests`).where('clientId', '==', input.clientId)),
      tx.get(db.collection(`organizations/${orgId}/invitations`).where('clientId', '==', input.clientId))
    ]);

    assignmentsSnap.docs.forEach(doc => tx.delete(doc.ref));
    tx.delete(db.doc(`organizations/${orgId}/clients/${input.clientId}/state/activeAssignment`));
    tx.delete(clientRef);

    if (authUid) {
      tx.delete(db.doc(`accountClientLinks/${authUid}`));
    }

    pendingRequests.docs.forEach(doc => tx.delete(doc.ref));
    pendingInvites.docs.forEach(doc => tx.delete(doc.ref));

    tx.create(auditRef(orgId, eventId), auditEvent({
      orgId, eventId, type: 'client.deleted-permanently', actor,
      subject: { type: 'client', id: input.clientId }, idempotencyKey: input.idempotencyKey,
      metadata: { authUid, email: maskEmail(clientData.email || clientData.emailNormalized) }
    }));
  });

  if (authUid) {
    try {
      await adminAuth().deleteUser(authUid);
    } catch (err) {
      logger.warn('Cancellazione utente Auth non riuscita o già rimosso', { authUid, err: err?.message });
    }
  }

  return { clientId: input.clientId, status: 'deleted-permanently' };
});

// Anagrafica professionista gestita solo da admin (Sessione 1)
exports.updateMemberProfileByStaff = callable(async (data, uid) => {
  const input = validateUpdateMemberProfileByStaff(data);
  const actor = await actorContext(input.organizationId, uid);
  requireCreator(actor);
  const memberRef = db.doc(`organizations/${actor.organizationId}/members/${input.userId}`);
  const eventId = checksum(`member.profile-updated-staff:${input.userId}:${input.idempotencyKey}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [member, audit] = await Promise.all([tx.get(memberRef), tx.get(auditRef(actor.organizationId, eventId))]);
    if (audit.exists) return;
    if (!member.exists) throw new HttpsError('not-found', 'Profilo professionista non trovato');
    const updatePayload = {
      firstName: input.firstName, lastName: input.lastName,
      displayName: `${input.firstName} ${input.lastName}`.trim(),
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    };
    if (input.email) {
      updatePayload.email = input.email;
      updatePayload.emailNormalized = input.email;
    }
    tx.update(memberRef, updatePayload);
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({
      orgId: actor.organizationId, eventId, type: 'member.profile-updated-staff', actor,
      subject: { type: 'member', id: input.userId }, idempotencyKey: input.idempotencyKey,
      metadata: { fields: input.email ? ['firstName', 'lastName', 'email'] : ['firstName', 'lastName'] }
    }));
  });

  if (input.email) {
    try {
      await adminAuth().updateUser(input.userId, { email: input.email });
    } catch (err) {
      logger.warn('Aggiornamento email Auth professionista non riuscito o utente non Auth', { userId: input.userId, err: err?.message });
    }
  }

  return { userId: input.userId, firstName: input.firstName, lastName: input.lastName, email: input.email || null };
});

// Proposta di cambio email (nutrizionista → cliente). Nulla cambia finché il
// cliente non conferma dall'app: nessuna finestra di takeover.
exports.proposeClientEmailChange = callable(async (data, uid) => {
  const input = validateProposeClientEmailChange(data);
  const actor = await actorContext(input.organizationId, uid);
  const orgId = actor.organizationId;
  const client = await authorizedClient(actor, input.clientId);
  if (!client.authUid) {
    throw new HttpsError('failed-precondition', 'Il cliente non ha ancora completato la registrazione: correggi l’invito pendente');
  }
  if (!client.emailNormalized) {
    throw new HttpsError('failed-precondition', 'Questo cliente usa un account tecnico legacy: il cambio email non è supportato, serve un nuovo account con email reale');
  }
  if (client.emailNormalized === input.newEmail) {
    return { status: 'unchanged', clientId: client.id, message: 'L’indirizzo è già quello del cliente.' };
  }
  const otherProfiles = await clientProfilesByEmail(orgId, input.newEmail);
  if (otherProfiles.some(item => item.id !== client.id)) {
    throw new HttpsError('already-exists', 'Esiste già un profilo cliente con questo indirizzo email');
  }
  const authUser = await authUserByEmail(input.newEmail);
  if (authUser && authUser.uid !== client.authUid) {
    throw new HttpsError('already-exists', 'Esiste già un account con questo indirizzo email');
  }
  const requestId = checksum(`${orgId}:emailchange:${client.id}:${input.newEmail}:${input.idempotencyKey}`).slice(0, 32);
  const requestRef = db.doc(`organizations/${orgId}/emailChangeRequests/${requestId}`);
  const eventId = checksum(`client.email-change-requested:${requestId}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [existing, audit] = await Promise.all([tx.get(requestRef), tx.get(auditRef(orgId, eventId))]);
    if (existing.exists || audit.exists) return;
    tx.create(requestRef, {
      schemaVersion: 1, requestId, organizationId: orgId, clientId: client.id,
      targetUid: client.authUid, channel: 'email',
      oldEmailNormalized: client.emailNormalized, newEmailNormalized: input.newEmail,
      status: 'pending', reason: input.reason || null,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid
    });
    tx.create(auditRef(orgId, eventId), auditEvent({
      orgId, eventId, type: 'client.email-change-requested', actor,
      subject: { type: 'client', id: client.id }, idempotencyKey: input.idempotencyKey,
      metadata: { clientId: client.id }
    }));
    tx.create(db.doc(`organizations/${orgId}/notifications/${eventId}`), {
      schemaVersion: 1, notificationId: eventId, recipientUid: client.authUid,
      type: 'client.email-change-requested', subjectId: client.id, readAt: null, dedupeKey: eventId,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      delivery: { inApp: 'pending', email: 'disabled' }
    });
  });
  return {
    status: 'requested', requestId, clientId: client.id,
    message: 'Proposta inviata: il cliente deve confermare dall’app prima che l’email cambi.'
  };
});

// Conferma/rifiuto del cambio email da parte del cliente. Solo la conferma
// esplicita aggiorna l'email in Firebase Auth (e richiede nuova verifica).
exports.respondMyEmailChange = callable(async (data, uid) => {
  const input = validateRespondClientEmailChange(data);
  const orgId = SINGLE_ORGANIZATION_ID;
  const requestRef = db.doc(`organizations/${orgId}/emailChangeRequests/${input.requestId}`);
  const snapshot = await requestRef.get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Richiesta non trovata');
  const request = snapshot.data();
  if (request.targetUid !== uid) throw new HttpsError('not-found', 'Richiesta non trovata');
  const linkSnap = await db.doc(`accountClientLinks/${uid}`).get();
  if (!linkSnap.exists || linkSnap.data()?.status !== 'active' || linkSnap.data()?.clientId !== request.clientId) {
    throw new HttpsError('permission-denied', 'Collegamento professionista non attivo');
  }
  if (request.status !== 'pending') {
    if (request.status === 'accepted' && input.decision === 'accept') {
      return { status: 'already-accepted', email: request.newEmailNormalized };
    }
    throw new HttpsError('failed-precondition', request.status === 'accepted'
      ? 'Email già aggiornata'
      : 'Richiesta non più valida: chiedi al tuo nutrizionista');
  }
  const eventId = checksum(`client.email-change-${input.decision}:${input.requestId}`).slice(0, 32);
  const actor = { uid, role: 'client' };
  if (input.decision === 'reject') {
    await db.runTransaction(async tx => {
      const [fresh, audit] = await Promise.all([tx.get(requestRef), tx.get(auditRef(orgId, eventId))]);
      if (audit.exists) return;
      if (fresh.data()?.status !== 'pending') throw new HttpsError('failed-precondition', 'Richiesta non più valida');
      tx.update(requestRef, {
        status: 'rejected', decidedAt: FieldValue.serverTimestamp(), decidedBy: uid,
        updatedAt: FieldValue.serverTimestamp()
      });
      tx.create(auditRef(orgId, eventId), auditEvent({
        orgId, eventId, type: 'client.email-change-rejected', actor,
        subject: { type: 'client', id: request.clientId }, idempotencyKey: input.idempotencyKey, metadata: {}
      }));
    });
    return { status: 'rejected', message: 'Proposta rifiutata: il tuo indirizzo email resta invariato.' };
  }
  const newEmail = request.newEmailNormalized;
  const existing = await authUserByEmail(newEmail);
  if (existing && existing.uid !== uid) {
    throw new HttpsError('already-exists', 'Esiste già un account con il nuovo indirizzo: contatta il tuo nutrizionista');
  }
  await db.runTransaction(async tx => {
    const [fresh, audit] = await Promise.all([tx.get(requestRef), tx.get(auditRef(orgId, eventId))]);
    if (audit.exists) return;
    if (fresh.data()?.status !== 'pending') throw new HttpsError('failed-precondition', 'Richiesta non più valida: chiedi al tuo nutrizionista');
    tx.update(requestRef, {
      status: 'accepted', decidedAt: FieldValue.serverTimestamp(), decidedBy: uid,
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(auditRef(orgId, eventId), auditEvent({
      orgId, eventId, type: 'client.email-change-accepted', actor,
      subject: { type: 'client', id: request.clientId }, idempotencyKey: input.idempotencyKey,
      metadata: { clientId: request.clientId }
    }));
  });
  // Solo ora l'email cambia in Firebase Auth; la verifica torna da fare e le
  // sessioni attive vengono invalidate da Firebase (il cliente accede con la
  // nuova email e la password scelta da lui: il nutrizionista non la conosce).
  try {
    await adminAuth().updateUser(uid, { email: newEmail, emailVerified: false });
  } catch (error) {
    if (error?.code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'Esiste già un account con il nuovo indirizzo: contatta il tuo nutrizionista');
    }
    logger.error('Cambio email non riuscito', { code: error?.code, email: maskEmail(newEmail) });
    throw new HttpsError('internal', 'Cambio email non riuscito: riprova o contatta l’assistenza');
  }
  // Auth è la fonte di verità per l'accesso: se l'allineamento del profilo
  // Firestore fallisce, l'email è comunque cambiata e il caso resta tracciato
  // (nessun blocco per il cliente, nessun dato perso).
  const clientRef = db.doc(`organizations/${orgId}/clients/${request.clientId}`);
  try {
    await db.runTransaction(async tx => {
      const fresh = await tx.get(clientRef);
      if (!fresh.exists || fresh.data()?.authUid !== uid) {
        tx.set(requestRef, { profileSyncPending: true, appliedAt: FieldValue.serverTimestamp() }, { merge: true });
        return;
      }
      tx.update(clientRef, {
        email: newEmail, emailNormalized: newEmail, emailVerified: false,
        updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
      });
      tx.set(requestRef, { appliedAt: FieldValue.serverTimestamp(), profileSyncPending: false }, { merge: true });
    });
  } catch (error) {
    logger.error('Profilo cliente non allineato dopo il cambio email', { code: error?.code, email: maskEmail(newEmail), clientId: request.clientId });
    await requestRef.set({ profileSyncPending: true }, { merge: true }).catch(() => {});
  }
  return {
    status: 'email-changed', email: newEmail, requiresVerification: true,
    message: 'Email aggiornata: accedi con il nuovo indirizzo e verificalo per continuare.'
  };
});

// Membership professionali dell'utente autenticato (console professionisti).
// È il gate deciso dal server per l'accesso alla dashboard: le membership
// vere in Firestore (organizations/{org}/members/{uid}) sono la fonte
// autorevole, senza fidarsi di ruoli scritti nel browser né di custom claims.
// Read-only, niente audit: nessuna PII oltre a orgId/ruolo del chiamante.
// Unica org: 'pianoNutrizionale'. Creatore = platformMembers admin.
exports.getMyMemberships = callable(async (data, uid) => {
  exactObject(data, []);
  const orgId = SINGLE_ORGANIZATION_ID;
  const [memberSnap, platform] = await Promise.all([
    db.doc(`organizations/${orgId}/members/${uid}`).get(),
    db.doc(`platformMembers/${uid}`).get()
  ]);
  const memberships = [];
  if (memberSnap.exists) {
    const value = memberSnap.data();
    if (value?.status === 'active' && ROLES.has(value?.role)) {
      memberships.push({ organizationId: orgId, role: value.role, username: value?.username || null });
    }
  }
  const platformAdminActive = platform.exists && platform.data()?.status === 'active' && platform.data()?.role === 'admin';
  return {
    memberships,
    platformAdmin: platformAdminActive,
    platformCreator: platformAdminActive,
    singleOrganizationId: orgId
  };
});

// Singola organizzazione: query diretta su organizzazioni/piano, niente
// collectionGroup, nessun indice aggiuntivo.
async function clientLinkRequestsForUid(uid) {
  const orgId = SINGLE_ORGANIZATION_ID;
  const snap = await db.collection(`organizations/${orgId}/clientLinkRequests`).where('targetUid', '==', uid).get();
  return { docs: snap.docs };
}

// Richieste di collegamento in attesa + stato del collegamento attuale per
// l'account autenticato (app, Impostazioni). Solo i propri dati, mai PII altrui.
exports.listMyClientLinkRequests = callable(async (data, uid) => {
  exactObject(data, []);
  const [snap, link] = await Promise.all([
    clientLinkRequestsForUid(uid),
    db.doc(`accountClientLinks/${uid}`).get()
  ]);
  const pending = snap.docs.filter(doc => doc.data()?.status === 'pending');
  const orgIds = new Set(pending.map(doc => doc.data().organizationId).filter(Boolean));
  if (link.exists && link.data()?.status === 'active' && link.data()?.organizationId) {
    if (link.data().organizationId === SINGLE_ORGANIZATION_ID) orgIds.add(link.data().organizationId);
  }
  const orgNames = new Map();
  const memberNames = new Map();
  const memberRefs = new Map();
  let activeMemberRef = null;
  let activeClientProfile = null;
  pending.forEach(doc => { const value = doc.data(); if (value.nutritionistUid) memberRefs.set(`${value.organizationId}/${value.nutritionistUid}`, value); });
  if (link.exists && link.data()?.status === 'active' && link.data().organizationId === SINGLE_ORGANIZATION_ID) {
    const client = await db.doc(`organizations/${SINGLE_ORGANIZATION_ID}/clients/${link.data().clientId}`).get();
    const clientData = client.data() || {};
    activeClientProfile = {
      firstName: clientData.firstName || null,
      lastName: clientData.lastName || null,
      email: clientData.emailNormalized || null,
      emailVerified: clientData.emailVerified === true
    };
    const nutritionistUid = clientData.nutritionistUids?.[0];
    if (nutritionistUid) {
      activeMemberRef = { organizationId: SINGLE_ORGANIZATION_ID, nutritionistUid };
      memberRefs.set(`${SINGLE_ORGANIZATION_ID}/${nutritionistUid}`, activeMemberRef);
    }
  }
  // Proposte di cambio email in attesa di conferma del cliente (solo le proprie).
  // Singolo filtro (ADR 0003): lo stato si seleziona in codice (già fatto sotto).
  const emailChangeSnap = await db.collection(`organizations/${SINGLE_ORGANIZATION_ID}/emailChangeRequests`)
    .where('targetUid', '==', uid).limit(5).get();
  const pendingEmailChange = emailChangeSnap.docs
    .find(doc => doc.data()?.status === 'pending') || null;
  const emailChange = pendingEmailChange ? {
    requestId: pendingEmailChange.id,
    newEmail: pendingEmailChange.data()?.newEmailNormalized || null,
    createdAt: iso(pendingEmailChange.data()?.createdAt)
  } : null;
  await Promise.all([...orgIds].map(async orgId => {
    const org = await db.doc(`organizations/${orgId}`).get();
    orgNames.set(orgId, org.exists ? (org.data()?.name || orgId) : orgId);
  }));
  await Promise.all([...memberRefs.entries()].map(async ([key, value]) => {
    const member = await db.doc(`organizations/${value.organizationId}/members/${value.nutritionistUid}`).get();
    if (!member.exists) { memberNames.set(key, { username: null, displayName: null, firstName: null, lastName: null }); return; }
    const data = member.data() || {};
    const first = String(data.firstName || '').trim();
    const last = String(data.lastName || '').trim();
    const full = `${first} ${last}`.trim();
    memberNames.set(key, {
      username: data.username || null,
      displayName: full || data.displayName || null,
      firstName: data.firstName || null, lastName: data.lastName || null
    });
  }));
  const person = value => memberNames.get(`${value.organizationId}/${value.nutritionistUid}`) || { username: null, displayName: null };
  return {
    requests: pending.map(doc => ({
      requestId: doc.id, organizationId: doc.data().organizationId,
      organizationName: orgNames.get(doc.data().organizationId) || doc.data().organizationId,
      nutritionistUsername: doc.data().nutritionistUid ? person(doc).username : null,
      nutritionistDisplayName: doc.data().nutritionistUid ? person(doc).displayName : null,
      createdAt: iso(doc.data().createdAt)
    })),
    link: link.exists && link.data()?.status === 'active' && link.data().organizationId === SINGLE_ORGANIZATION_ID
      ? { organizationId: link.data().organizationId, organizationName: orgNames.get(link.data().organizationId) || link.data().organizationId,
          clientId: link.data().clientId,
          firstName: activeClientProfile?.firstName || null, lastName: activeClientProfile?.lastName || null,
          email: activeClientProfile?.email || null, emailVerified: activeClientProfile?.emailVerified === true,
          emailChange,
          nutritionistUsername: activeMemberRef ? person(activeMemberRef).username : null,
          nutritionistDisplayName: activeMemberRef ? person(activeMemberRef).displayName : null }
      : null
  };
});

// updateMyClientProfile e updateMyMemberProfile rimossi (Sessione 1): il displayName cliente non esiste più
// e l'anagrafica professionista è gestita solo da admin via updateMemberProfileByStaff.

// Accettazione/rifiuto dal cliente (app). IDEMPOTENTE: decisioni già prese
// ritornano no-op; ogni transizione è registrata in audit.
exports.respondClientLink = callable(async (data, uid, call) => {
  const input = validateRespondClientLink(data);
  const snap = await clientLinkRequestsForUid(uid);
  const found = snap.docs.find(doc => doc.id === input.requestId);
  if (!found) throw new HttpsError('not-found', 'Richiesta non trovata');
  const request = found.data();
  const orgId = SINGLE_ORGANIZATION_ID;
  if (request.organizationId && request.organizationId !== orgId) throw new HttpsError('not-found', 'Richiesta non trovata');
  // Le richieste nate da un invito con email reale (canale "email") richiedono
  // l'email verificata: il collegamento abilita dati professionali (ADR 0004).
  // Le richieste legacy (username, solo test) non sono toccate.
  if (request.channel === 'email' && call?.auth?.token?.email_verified !== true) {
    throw new HttpsError('failed-precondition', 'Verifica prima il tuo indirizzo email: poi potrai accettare o rifiutare la richiesta');
  }
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
  if (orgId !== SINGLE_ORGANIZATION_ID) return { status: 'already-unlinked' };
  const clientRef = db.doc(`organizations/${orgId}/clients/${clientId}`);
  const eventId = checksum(`client.unlinked:${orgId}:${clientId}:${uid}`).slice(0, 32);
  const actor = { uid, role: 'client' };
  let suspended = 0;
  await db.runTransaction(async tx => {
    const [freshLink, client, audit, openAssignments] = await Promise.all([
      tx.get(linkRef), tx.get(clientRef), tx.get(auditRef(orgId, eventId)),
      tx.get(clientRef.collection('assignments').where('status', 'in', ['active', 'scheduled']))
    ]);
    if (audit.exists) return;
    if (!freshLink.exists || freshLink.data()?.status !== 'active') return;
    // Tutte le letture prima delle scritture (Sessione 1)
    suspended = openAssignments.size;
    tx.update(linkRef, { status: 'revoked', updatedAt: FieldValue.serverTimestamp() });
    if (client.exists) {
      tx.update(clientRef, { status: 'unlinked', authUid: null, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    }
    openAssignments.docs.forEach(doc => {
      tx.update(doc.ref, {
        status: 'suspended', statusReason: 'Scollegamento richiesto dal cliente',
        updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
      });
    });
    tx.delete(clientRef.collection('state').doc('activeAssignment'));
    // activeAssignment azzerato senza sovrascrivere lo stato già impostato
    if (client.exists) {
      tx.update(clientRef, { activeAssignment: null, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    } else {
      tx.update(clientRef, { activeAssignment: null, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    }
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
  const actor = await actorContext(input.organizationId, uid);
  const client = await authorizedClient(actor, input.clientId);
  const eventId = checksum(`client.link-removed:${client.id}:${input.idempotencyKey}`).slice(0, 32);
  let suspended = 0;
  await db.runTransaction(async tx => {
    const [fresh, audit, link, openAssignments, pendingRequests, pendingInvites] = await Promise.all([
      tx.get(client.ref),
      tx.get(auditRef(actor.organizationId, eventId)),
      client.authUid ? tx.get(db.doc(`accountClientLinks/${client.authUid}`)) : Promise.resolve(null),
      tx.get(client.ref.collection('assignments').where('status', 'in', ['active', 'scheduled'])),
      tx.get(client.ref.parent.parent.collection('clientLinkRequests').where('clientId', '==', client.id)),
      tx.get(client.ref.parent.parent.collection('invitations').where('clientId', '==', client.id))
    ]);
    if (audit.exists) return;
    // Tutte le letture prima delle scritture (Sessione 1)
    suspended = openAssignments.size;
    if (link?.exists && link.data()?.status === 'active') {
      tx.update(link.ref, { status: 'revoked', updatedAt: FieldValue.serverTimestamp() });
    }
    tx.update(client.ref, { status: 'unlinked', authUid: null, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    openAssignments.docs.forEach(doc => {
      tx.update(doc.ref, {
        status: 'suspended', statusReason: input.reason,
        updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
      });
    });
    tx.delete(client.ref.collection('state').doc('activeAssignment'));
    tx.update(client.ref, { activeAssignment: null, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    // Singolo filtro (ADR 0003): lo stato si seleziona in codice.
    pendingRequests.docs.filter(doc => doc.data()?.status === 'pending').forEach(doc => tx.update(doc.ref, { status: 'revoked', decidedAt: FieldValue.serverTimestamp(), decidedBy: uid, updatedAt: FieldValue.serverTimestamp() }));
    pendingInvites.docs.filter(doc => doc.data()?.status === 'pending').forEach(doc => tx.update(doc.ref, { status: 'revoked', decidedAt: FieldValue.serverTimestamp(), decidedBy: uid, updatedAt: FieldValue.serverTimestamp() }));
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'client.link-removed', actor, subject: { type: 'client', id: client.id }, idempotencyKey: input.idempotencyKey, metadata: { reason: input.reason, suspendedAssignments: suspended } }));
  });
  return { clientId: client.id, status: 'unlinked', suspendedAssignments: suspended };
});

// Rimozione nutritionist (creatore): BLOCCATA se restano clienti collegati o in
// attesa (conteggio + elenco in risposta). Le strutture restano con ownerUid
// invariato (visibili al creatore, non trasferite in silenzio).
exports.removeNutritionist = callable(async (data, uid) => {
  const input = validateRemoveNutritionist(data);
  const actor = await actorContext(input.organizationId, uid);
  requireCreator(actor);
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

// Passaggio di proprietà struttura (SOLO creatore, mai silenzioso): audit
// completo, nessun trasferimento implicito alla rimozione del professionista.
exports.transferStructureOwnership = callable(async (data, uid) => {
  const input = validateTransferStructureOwnership(data);
  const actor = await actorContext(input.organizationId, uid);
  requireCreator(actor);
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
  if (link.exists && link.data()?.status === 'active' && link.data()?.organizationId === SINGLE_ORGANIZATION_ID) {
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
  // Solo org singola
  const orgId = SINGLE_ORGANIZATION_ID;
  const due = await db.collection(`organizations/${orgId}/clients`).get().then(async clientsSnap => {
    const all = [];
    for (const clientDoc of clientsSnap.docs) {
      const dueSnap = await db.collection(`organizations/${orgId}/clients/${clientDoc.id}/assignments`).where('status', '==', 'scheduled').where('effectiveAt', '<=', Timestamp.now()).limit(20).get();
      all.push(...dueSnap.docs);
    }
    return { size: all.length, docs: all };
  });
  for (const doc of due.docs) {
    const parts = doc.ref.path.split('/');
    const clientId = parts[3];
    await resolveDueAssignment(orgId, clientId);
  }
  const expired = await db.collectionGroup('assignments').where('status', '==', 'active').where('expiresAt', '<=', Timestamp.now()).limit(200).get();
  for (const doc of expired.docs) {
    const parts = doc.ref.path.split('/');
    const orgIdPart = parts[1];
    if (orgIdPart !== SINGLE_ORGANIZATION_ID) continue;
    const clientId = parts[3];
    const clientRef = db.doc(`organizations/${orgIdPart}/clients/${clientId}`);
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

// ---- Ricettario professionisti (ADR 0006) ----
// Raccolta server-only organizations/{org}/recipes (rules: catch-all senza
// accesso diretto). Concorrenza ottimistica su `revision`; visibilità
// 'private' (solo proprietario) o 'studio' (lettura+invio per lo studio).
// Invio al cliente = documento recipeShares con senderRole 'professional'
// (stessa casella delle condivisioni tra utenti, nessun indice nuovo).

exports.listProfessionalRecipes = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'includeArchived']);
  const actor = await actorContext(data.organizationId, uid);
  const includeArchived = data.includeArchived === true;
  const snapshot = await db.collection(`organizations/${actor.organizationId}/recipes`).limit(200).get();
  const recipes = snapshot.docs
    .map(doc => {
      const data = doc.data();
      return {
        id: doc.id, ...data,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
        archivedAt: data.archivedAt?.toDate?.()?.toISOString() || null
      };
    })
    .filter(item => {
      if (!includeArchived && item.status === 'archived') return false;
      if (actor.isCreator) return true;
      if (item.ownerUid === uid) return true;
      return item.visibility === 'studio' && item.status !== 'archived';
    })
    .sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
  return { recipes };
});

exports.createProfessionalRecipe = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'recipe', 'idempotencyKey']);
  const actor = await actorContext(data.organizationId, uid);
  const recipe = validateProfessionalRecipe(data.recipe);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const recipeId = `R${checksum(`${actor.organizationId}:${uid}:${recipe.name}:${idem}`).slice(0, 12)}`;
  const ref = db.doc(`organizations/${actor.organizationId}/recipes/${recipeId}`);
  const eventId = checksum(`recipe.created:${recipeId}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [existing, audit] = await Promise.all([tx.get(ref), tx.get(auditRef(actor.organizationId, eventId))]);
    if (existing.exists || audit.exists) return;
    tx.create(ref, {
      schemaVersion: 1, ...recipe, revision: 1, visibility: 'private', status: 'active',
      ownerUid: uid, createdBy: uid,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'recipe.created', actor, subject: { type: 'professionalRecipe', id: recipeId }, idempotencyKey: idem, metadata: { name: recipe.name, slot: recipe.slot } }));
  });
  return { recipeId, revision: 1 };
});

exports.updateProfessionalRecipe = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'recipeId', 'recipe', 'revision', 'idempotencyKey']);
  const actor = await actorContext(data.organizationId, uid);
  const recipe = validateProfessionalRecipe(data.recipe);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  if (!Number.isInteger(data.revision) || data.revision < 1) throw new HttpsError('invalid-argument', 'revision non valida');
  const { ref, doc } = await authorizedProfessionalRecipe(actor, data.recipeId, { mustOwn: true });
  const current = doc.data();
  if (current.status === 'archived') throw new HttpsError('failed-precondition', 'Ricetta archiviata: non più modificabile');
  if (current.revision !== data.revision) throw new HttpsError('failed-precondition', 'Versione non aggiornata: ricarica la ricetta e riprova');
  const nextRevision = current.revision + 1;
  const eventId = checksum(`recipe.updated:${ref.id}:${nextRevision}:${idem}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const audit = await tx.get(auditRef(actor.organizationId, eventId));
    if (audit.exists) return;
    tx.update(ref, { ...recipe, revision: nextRevision, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'recipe.updated', actor, subject: { type: 'professionalRecipe', id: ref.id }, idempotencyKey: idem, metadata: { revision: nextRevision } }));
  });
  return { recipeId: ref.id, revision: nextRevision };
});

exports.archiveProfessionalRecipe = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'recipeId', 'idempotencyKey']);
  const actor = await actorContext(data.organizationId, uid);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const { ref, doc } = await authorizedProfessionalRecipe(actor, data.recipeId, { mustOwn: true });
  if (doc.data().status === 'archived') return { recipeId: ref.id, status: 'archived' };
  const eventId = checksum(`recipe.archived:${ref.id}:${idem}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const audit = await tx.get(auditRef(actor.organizationId, eventId));
    if (audit.exists) return;
    tx.update(ref, { status: 'archived', archivedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'recipe.archived', actor, subject: { type: 'professionalRecipe', id: ref.id }, idempotencyKey: idem, metadata: {} }));
  });
  return { recipeId: ref.id, status: 'archived' };
});

exports.shareProfessionalRecipe = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'recipeId', 'visibility', 'idempotencyKey']);
  const actor = await actorContext(data.organizationId, uid);
  if (!actor.isCreator) throw new HttpsError('permission-denied', 'Solo il creatore condivide le ricette con lo studio');
  const visibility = text(data.visibility, 'visibility', { max: 20 });
  if (!PROFESSIONAL_RECIPE_VISIBILITY.has(visibility)) throw new HttpsError('invalid-argument', 'visibility non valida');
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const ref = db.doc(`organizations/${actor.organizationId}/recipes/${id(data.recipeId, 'recipeId')}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Ricetta non trovata');
  if (snap.data().status === 'archived') throw new HttpsError('failed-precondition', 'Ricetta archiviata: non più condivisibile');
  const eventId = checksum(`recipe.visibility:${ref.id}:${visibility}:${idem}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const audit = await tx.get(auditRef(actor.organizationId, eventId));
    if (audit.exists) return;
    tx.update(ref, { visibility, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'recipe.visibility', actor, subject: { type: 'professionalRecipe', id: ref.id }, idempotencyKey: idem, metadata: { visibility } }));
  });
  return { recipeId: ref.id, visibility };
});

exports.sendProfessionalRecipe = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'recipeIds', 'clientId', 'idempotencyKey']);
  const actor = await actorContext(data.organizationId, uid);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const clientId = id(data.clientId, 'clientId');
  if (!Array.isArray(data.recipeIds) || !data.recipeIds.length || data.recipeIds.length > 50) {
    throw new HttpsError('invalid-argument', 'recipeIds non validi');
  }
  const recipeIds = [...new Set(data.recipeIds.map(value => id(value, 'recipeId')))];
  const clientSnap = await db.doc(`organizations/${actor.organizationId}/clients/${clientId}`).get();
  if (!clientSnap.exists || clientSnap.data()?.status === 'deleted') throw new HttpsError('not-found', 'Cliente non trovato');
  const client = clientSnap.data();
  if (!actor.isCreator && !(client.nutritionistUids || []).includes(uid)) {
    throw new HttpsError('failed-precondition', 'Il cliente non è assegnato a questo professionista');
  }
  if (!client.authUid) throw new HttpsError('failed-precondition', 'Il cliente non ha ancora collegato l’app: impossibile inviare');
  const recipes = [];
  for (const recipeId of recipeIds) {
    const snap = await db.doc(`organizations/${actor.organizationId}/recipes/${recipeId}`).get();
    if (!snap.exists) throw new HttpsError('not-found', `Ricetta ${recipeId} non trovata`);
    const recipe = snap.data();
    if (recipe.status === 'archived') throw new HttpsError('failed-precondition', `Ricetta ${recipeId} archiviata: non più inviabile`);
    if (!actor.isCreator && recipe.ownerUid !== uid && recipe.visibility !== 'studio') {
      throw new HttpsError('permission-denied', `Ricetta ${recipeId} privata di un altro professionista`);
    }
    recipes.push({
      id: snap.id, name: recipe.name, emoji: recipe.emoji || null, slot: recipe.slot,
      proteinCategory: recipe.proteinCategory || null, ingredients: recipe.ingredients || [],
      steps: recipe.steps || [], notes: recipe.notes || [], professionalRevision: recipe.revision ?? null
    });
  }
  const shareId = checksum(`recipeShare:professional:${actor.organizationId}:${uid}:${clientId}:${idem}`).slice(0, 20);
  const shareRef = db.doc(`recipeShares/${shareId}`);
  const eventId = checksum(`recipe.sent:${shareId}`).slice(0, 32);
  const [senderUsername, recipientUsername] = await Promise.all([
    usernameOfUid(uid),
    client.invitedUsername ? Promise.resolve(client.invitedUsername) : usernameOfUid(client.authUid)
  ]);
  await db.runTransaction(async tx => {
    const [existing, audit] = await Promise.all([tx.get(shareRef), tx.get(auditRef(actor.organizationId, eventId))]);
    if (existing.exists || audit.exists) return;
    tx.create(shareRef, {
      senderUid: uid, senderUsername: senderUsername || null, senderRole: 'professional',
      organizationId: actor.organizationId, recipientUid: client.authUid, recipientUsername: recipientUsername || null,
      status: 'pending', recipeCount: recipes.length, recipes,
      professionalRecipeIds: recipeIds, includesPlan: false, plan: null,
      createdAt: FieldValue.serverTimestamp()
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'recipe.sent', actor, subject: { type: 'recipeShare', id: shareId }, idempotencyKey: idem, metadata: { clientId, recipeIds, shareId } }));
  });
  return { shareId, recipeCount: recipes.length };
});

exports.cancelProfessionalShare = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'shareId', 'idempotencyKey']);
  const actor = await actorContext(data.organizationId, uid);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const shareRef = db.doc(`recipeShares/${id(data.shareId, 'shareId')}`);
  const snap = await shareRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Condivisione non trovata');
  const share = snap.data();
  if (share.senderRole !== 'professional' || share.organizationId !== actor.organizationId) {
    throw new HttpsError('failed-precondition', 'Solo le condivisioni professionali si annullano da qui');
  }
  if (share.status !== 'pending') throw new HttpsError('failed-precondition', 'Condivisione già gestita dal cliente');
  if (!actor.isCreator && share.senderUid !== uid) {
    throw new HttpsError('permission-denied', 'Solo il mittente può annullare l’invio');
  }
  const eventId = checksum(`recipe.shareCancelled:${shareRef.id}:${idem}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const audit = await tx.get(auditRef(actor.organizationId, eventId));
    if (audit.exists) return;
    tx.delete(shareRef);
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'recipe.shareCancelled', actor, subject: { type: 'recipeShare', id: shareRef.id }, idempotencyKey: idem, metadata: { shareId: shareRef.id, recipientUid: share.recipientUid || null } }));
  });
  return { shareId: shareRef.id, cancelled: true };
});

exports.listProfessionalShares = callable(async (data, uid) => {
  exactObject(data, ['organizationId']);
  const actor = await actorContext(data.organizationId, uid);
  // Un solo filtro per query (nessun indice composto): il nutrizionista
  // filtra per mittente, la selezione di ruolo/org/stato avviene in codice.
  let query = db.collection('recipeShares');
  if (!actor.isCreator) query = query.where('senderUid', '==', uid);
  const snapshot = await query.limit(200).get();
  const shares = snapshot.docs
    .map(doc => {
      const data = doc.data();
      return { id: doc.id, ...data, createdAt: data.createdAt?.toDate?.()?.toISOString() || null };
    })
    .filter(share => share.senderRole === 'professional' && share.organizationId === actor.organizationId && share.status === 'pending')
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  return { shares };
});

// ---- Tabelle grammature del nutrizionista ----
// Raccolta personale organizations/{org}/grammatureTables (rules: catch-all
// senza accesso diretto, come le ricette professionali). Ogni nutrizionista
// vede e gestisce solo le proprie tabelle; il creatore le vede tutte.
// Le tabelle alimentano la precompilazione dei gruppi scelta nell'editor
// della dieta guidata: il professionista sceglie la tabella in compilazione.

function serializeGrammatureTable(doc) {
  const data = doc.data();
  return {
    id: doc.id, ...data,
    createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null
  };
}

async function authorizedGrammatureTable(actor, tableId) {
  const ref = db.doc(`organizations/${actor.organizationId}/grammatureTables/${id(tableId, 'tableId')}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Tabella grammature non trovata');
  if (snap.data().ownerUid !== actor.uid) {
    throw new HttpsError('permission-denied', 'Puoi modificare soltanto le tue tabelle');
  }
  return { ref, snap };
}

exports.listMyGrammatureTables = callable(async (data, uid) => {
  exactObject(data, ['organizationId']);
  const actor = await actorContext(data.organizationId, uid);
  const snapshot = await db.collection(`organizations/${actor.organizationId}/grammatureTables`).limit(GRAMMATURE_TABLE_LIMITS.rows * 4).get();
  const tables = snapshot.docs
    .map(doc => serializeGrammatureTable(doc))
    .filter(item => actor.isCreator || item.ownerUid === uid)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { tables };
});

exports.saveGrammatureTable = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'tableId', 'table', 'idempotencyKey']);
  const actor = await actorContext(data.organizationId, uid);
  const table = validateGrammatureTable(data.table);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  if (data.tableId != null && data.tableId !== '') {
    // Aggiornamento di una tabella esistente: solo il proprietario.
    const { ref, snap } = await authorizedGrammatureTable(actor, data.tableId);
    const eventId = checksum(`grammature.updated:${ref.id}:${idem}`).slice(0, 32);
    await db.runTransaction(async tx => {
      const audit = await tx.get(auditRef(actor.organizationId, eventId));
      if (audit.exists) return;
      tx.update(ref, { ...table, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
      tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'grammatureTable.updated', actor, subject: { type: 'grammatureTable', id: ref.id }, idempotencyKey: idem, metadata: { name: table.name, rowCount: table.rows.length } }));
    });
    return { tableId: ref.id, rowCount: table.rows.length };
  }
  // Nuova tabella: id deterministico da contenuto + idempotenza.
  const tableId = `T${checksum(`${actor.organizationId}:${uid}:${table.name}:${idem}`).slice(0, 12)}`;
  const ref = db.doc(`organizations/${actor.organizationId}/grammatureTables/${tableId}`);
  const eventId = checksum(`grammature.created:${tableId}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [existing, audit] = await Promise.all([tx.get(ref), tx.get(auditRef(actor.organizationId, eventId))]);
    if (existing.exists || audit.exists) return;
    tx.create(ref, {
      schemaVersion: 1, ...table, ownerUid: uid, createdBy: uid,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'grammatureTable.created', actor, subject: { type: 'grammatureTable', id: tableId }, idempotencyKey: idem, metadata: { name: table.name, rowCount: table.rows.length } }));
  });
  return { tableId, rowCount: table.rows.length };
});

exports.duplicateGrammatureTable = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'tableId', 'idempotencyKey']);
  const actor = await actorContext(data.organizationId, uid);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const { snap } = await authorizedGrammatureTable(actor, data.tableId);
  const source = snap.data();
  const name = `${String(source.name || 'Tabella').slice(0, GRAMMATURE_TABLE_LIMITS.name - 8)} (copia)`;
  const tableId = `T${checksum(`${actor.organizationId}:${uid}:${name}:${idem}`).slice(0, 12)}`;
  const ref = db.doc(`organizations/${actor.organizationId}/grammatureTables/${tableId}`);
  const eventId = checksum(`grammature.duplicated:${tableId}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [existing, audit] = await Promise.all([tx.get(ref), tx.get(auditRef(actor.organizationId, eventId))]);
    if (existing.exists || audit.exists) return;
    tx.create(ref, {
      schemaVersion: 1, name, description: source.description || null,
      rows: JSON.parse(JSON.stringify(source.rows || [])),
      ownerUid: uid, createdBy: uid,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'grammatureTable.duplicated', actor, subject: { type: 'grammatureTable', id: tableId }, idempotencyKey: idem, metadata: { sourceId: snap.id, name } }));
  });
  return { tableId, sourceId: snap.id };
});

exports.deleteGrammatureTable = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'tableId', 'idempotencyKey']);
  const actor = await actorContext(data.organizationId, uid);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const { ref, snap } = await authorizedGrammatureTable(actor, data.tableId);
  const eventId = checksum(`grammature.deleted:${ref.id}:${idem}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const audit = await tx.get(auditRef(actor.organizationId, eventId));
    if (audit.exists) return;
    tx.delete(ref);
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'grammatureTable.deleted', actor, subject: { type: 'grammatureTable', id: ref.id }, idempotencyKey: idem, metadata: { name: snap.data().name } }));
  });
  return { tableId: ref.id, deleted: true };
});
