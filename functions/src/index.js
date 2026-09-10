'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const {
  ROLES, REPORT_STATUSES, exactObject, text, optionalText, id, checksum,
  reportKey, validateReport, validateMapping, validateRuleSetRules, validateAssignment, validateStructureAssignment,
  validateDietStructureRules, effectiveAssignment
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

exports.getMyAssignedProfile = callable(async (_data, uid) => {
  const link = await db.doc(`accountClientLinks/${uid}`).get();
  if (!link.exists || link.data()?.status !== 'active') return { state: 'unassigned', fallback: 'original-only' };
  const { organizationId, clientId } = link.data();
  const client = await db.doc(`organizations/${organizationId}/clients/${clientId}`).get();
  if (!client.exists || client.data()?.authUid !== uid || client.data()?.status !== 'active') {
    return { state: 'unassigned', fallback: 'original-only' };
  }
  const assignment = await resolveDueAssignment(organizationId, clientId);
  const effective = effectiveAssignment(assignment && {
    ...assignment,
    effectiveAt: assignment.effectiveAt?.toDate?.() || assignment.effectiveAt,
    expiresAt: assignment.expiresAt?.toDate?.() || assignment.expiresAt
  });
  if (!effective.valid) return { state: effective.reason || 'unassigned', fallback: 'original-only', clientProfileId: clientId };
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

// Selettore "Struttura dieta" della console: solo ID, ultima pubblicazione e
// data di modifica — revisione e checksum restano interni al backend.
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
exports.assignClientStructure = callable(async (data, uid) => {
  const input = validateStructureAssignment(data);
  const actor = await membership(input.organizationId, uid);
  const client = await authorizedClient(actor, input.clientId);
  const rootRef = db.doc(`organizations/${actor.organizationId}/ruleSets/${input.ruleSetId}`);
  const root = await rootRef.get();
  if (!root.exists || !root.data()?.latestPublishedVersion || !root.data()?.latestChecksum) {
    throw new HttpsError('not-found', 'Struttura dieta non trovata o senza pubblicazioni');
  }
  if (actor.role === 'nutritionist' && root.data().createdBy !== uid) {
    throw new HttpsError('permission-denied', 'Puoi assegnare soltanto le tue strutture dieta');
  }
  const pointer = {
    scope: 'tenant', ruleSetId: input.ruleSetId,
    version: root.data().latestPublishedVersion,
    checksum: root.data().latestChecksum
  };
  const versionRef = await ruleVersionRef(actor.organizationId, pointer);
  const versionDoc = await versionRef.get();
  if (!versionDoc.exists || !verifiedRuleVersion(versionDoc.data(), pointer)) {
    throw new HttpsError('failed-precondition', 'Pubblicazione della struttura non valida');
  }
  const notesMetadata = input.notes ? { notes: input.notes, notesVisibility: 'staff' } : {};
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
      schemaVersion: 1, assignmentId, clientId: client.id, ruleSet: pointer,
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
      tx.update(client.ref, { activeAssignment: { assignmentId, ruleSet: pointer }, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    }
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'assignment.created', actor, subject: { type: 'assignment', id: assignmentId }, idempotencyKey: input.idempotencyKey, metadata: { clientId: client.id, ruleSetId: pointer.ruleSetId, revision: pointer.version, effectiveAt: input.effectiveAt.toISOString(), expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null, withoutExpiration: input.withoutExpiration } }));
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
    ruleCount: data.ruleCount ?? null
  };
  if (includeChecksum) doc.latestChecksum = data.latestChecksum || null;
  return doc;
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
      checksum: actor.role === 'admin' ? revision.data().checksum || null : undefined,
      publishedAt: revision.data().publishedAt?.toDate?.()?.toISOString() || null,
      changelog: revision.data().changelog || null,
      restoredFromRevisionId: revision.data().restoredFromRevisionId || null
    }
  };
});

exports.createDietStructure = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'name', 'rules', 'idempotencyKey']);
  const actor = await membership(data.organizationId, uid);
  const name = text(data.name, 'name', { min: 3, max: 80 });
  const rules = validateDietStructureRules(data.rules);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const structureId = checksum(`${actor.organizationId}:${uid}:${name}:${idem}`).slice(0, 24);
  const ref = db.doc(`organizations/${actor.organizationId}/dietStructures/${structureId}`);
  const body = { schemaVersion: 1, rules };
  const revisionChecksum = checksum(body);
  const eventId = checksum(`structure.created:${structureId}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [existing, audit] = await Promise.all([tx.get(ref), tx.get(auditRef(actor.organizationId, eventId))]);
    if (existing.exists || audit.exists) return;
    tx.create(ref, {
      schemaVersion: 1, name, status: 'active', ownerUid: uid, createdBy: uid,
      currentRevisionId: '1', latestChecksum: revisionChecksum, ruleCount: rules.length,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(ref.collection('revisions').doc('1'), {
      schemaVersion: 1, revisionId: '1', structureId, ...body, status: 'published', checksum: revisionChecksum,
      compatibleClientSchema: 6, changelog: 'Prima revisione', createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(), createdBy: uid, publishedAt: FieldValue.serverTimestamp(), publishedBy: uid
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'structure.created', actor, subject: { type: 'dietStructure', id: structureId }, idempotencyKey: idem, metadata: { name, ruleCount: rules.length } }));
  });
  return { structureId, revisionId: '1' };
});

exports.updateDietStructureRevision = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'structureId', 'name', 'rules', 'changelog', 'restoredFromRevisionId', 'idempotencyKey']);
  const actor = await membership(data.organizationId, uid);
  const rules = validateDietStructureRules(data.rules);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const name = optionalText(data.name, 'name', 80);
  const changelog = optionalText(data.changelog, 'changelog', 500);
  const restoredFrom = optionalText(data.restoredFromRevisionId, 'restoredFromRevisionId', 40);
  const { ref, doc } = await authorizedStructure(actor, data.structureId, { mustOwn: actor.role === 'nutritionist' });
  if (doc.data().status === 'archived') throw new HttpsError('failed-precondition', 'Riattiva la struttura prima di pubblicare una nuova revisione');
  const nextRevisionId = String(Number(doc.data().currentRevisionId || '0') + 1);
  const revisionChecksum = checksum({ schemaVersion: 1, rules });
  const eventId = checksum(`structure.revision:${ref.id}:${nextRevisionId}:${idem}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const audit = await tx.get(auditRef(actor.organizationId, eventId));
    if (audit.exists) return;
    tx.update(ref, {
      ...(name ? { name } : {}),
      currentRevisionId: nextRevisionId, latestChecksum: revisionChecksum, ruleCount: rules.length,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    });
    tx.create(ref.collection('revisions').doc(nextRevisionId), {
      schemaVersion: 1, revisionId: nextRevisionId, structureId: ref.id, rules, status: 'published', checksum: revisionChecksum,
      compatibleClientSchema: 6, changelog: changelog || (restoredFrom ? `Ripristino dalla revisione ${restoredFrom}` : 'Nuova revisione'),
      restoredFromRevisionId: restoredFrom || null,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      createdBy: uid, publishedAt: FieldValue.serverTimestamp(), publishedBy: uid
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'structure.revision.published', actor, subject: { type: 'dietStructure', id: ref.id }, idempotencyKey: idem, metadata: { revisionId: nextRevisionId, restoredFromRevisionId: restoredFrom || null } }));
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
