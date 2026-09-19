'use strict';

const crypto = require('node:crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const {
  SINGLE_ORGANIZATION_ID, ROLES, STRUCTURE_REVISION_SCHEMA_VERSION, exactObject, text, optionalText, id, checksum,
  hashToken, normalizeUsername, normalizeIngredient, searchTokensFor,
  validateStructureAssignment, validateDietPlan, structureRevisionChecksum, verifyStructureRevision, effectiveAssignment,
  validateEquivalenceTemplateRevision, equivalenceTemplateRevisionChecksum, verifyEquivalenceTemplateRevision,
  validateCatalogRequestSubmit, validateCatalogRequestResolve,
  CATALOG_IMPORT_MODES, parseCatalogPayload, validateCatalogImport, catalogImportPreviewId,
  validateInviteOrganizationUser, validateInviteClientLink, validateRespondClientLink,
  validateRemoveClientLink, validateMemberStatus, validateRemoveNutritionist,
  validateTransferStructureOwnership,
  normalizeEmail, isLegacyTestEmail, emailFingerprint, maskEmail, INVITE_DELIVERY_CHANNEL,
  validateInviteClientEmail, validateCorrectClientInvite, validateResendClientInvite,
  validateGetInviteLink,
  validateCancelClientInvite, validateUpdateClientProfileByStaff, validateDeleteClientPermanently,
  validateProposeClientEmailChange, validateRespondClientEmailChange, validateRedeemClientInvite,
  PROFESSIONAL_RECIPE_VISIBILITY, validateProfessionalRecipe
} = require('./domain');

initializeApp();
const db = getFirestore();
const REGION = 'europe-west1';
const callableOptions = { region: REGION, enforceAppCheck: true, cors: true };
// Callable PUBBLICHE (nessuna autenticazione richiesta): il segreto è il token
// d'invito presente nel link `#/invito/<token>`. App Check è disattivato di
// proposito perché il link viene aperto da chiunque e da qualsiasi contesto
// (browser desktop, WebView di WhatsApp/Instagram, navigazione privata): se il
// token App Check manca o non è ancora pronto, con `enforceAppCheck: true` la
// chiamata veniva scartata prima del handler e l'anteprima rispondeva 500.
// `cors: true` serve perché l'app è pubblicata su GitHub Pages (altra origine).
const publicCallableOptions = { region: 'europe-west1', enforceAppCheck: false, cors: true };

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
// Catalogo globale v2: ingredienti, categorie e FAMIGLIE (fonte unica di
// identità). Nessuna dose vive qui: grammature ed equivalenze appartengono ai
// template e alle strutture organization-scoped.
async function loadGlobalCatalog() {
  const [meta, ingredientsSnap, categoriesSnap, familiesSnap] = await Promise.all([
    db.doc('globalIngredientCatalog/current/meta/summary').get(),
    db.collection('globalIngredientCatalog/current/ingredients').limit(2000).get(),
    db.collection('globalIngredientCatalog/current/categories').limit(500).get(),
    db.collection('globalIngredientCatalog/current/families').limit(500).get()
  ]);
  return {
    catalogVersion: Number(meta.data()?.catalogVersion || 0),
    checksum: meta.data()?.checksum || null,
    ingredients: ingredientsSnap.docs.map(doc => ({ ingredientId: doc.id, ...doc.data() })),
    categories: categoriesSnap.docs.map(doc => ({ categoryId: doc.id, ...doc.data() })),
    families: familiesSnap.docs.map(doc => ({ familyId: doc.id, ...doc.data() }))
  };
}

// Sottoinsieme sicuro del catalogo incorporato nel profilo cliente: solo
// identità (nomi, alias, token di ricerca, categoria, famiglia, flag
// dietetici), mai quantità (il catalogo non ne contiene).
function publicCatalogSnapshot(catalog) {
  return {
    catalogVersion: catalog.catalogVersion,
    ingredients: catalog.ingredients
      .filter(item => item.status !== 'archived')
      .map(item => ({
        ingredientId: item.ingredientId,
        displayName: item.displayName,
        categoryId: item.categoryId || null,
        familyId: item.familyId || null,
        aliases: Array.isArray(item.aliases) ? item.aliases : [],
        searchTokens: Array.isArray(item.searchTokens) ? item.searchTokens : [],
        dietaryFlags: {
          vegetarian: item.dietaryFlags?.vegetarian === true,
          vegan: item.dietaryFlags?.vegan === true
        },
        status: 'active'
      })),
    categories: catalog.categories
      .filter(item => item.status !== 'archived')
      .map(item => ({ categoryId: item.categoryId, displayName: item.displayName })),
    families: catalog.families
      .filter(item => item.status !== 'archived')
      .map(item => ({ familyId: item.familyId, displayName: item.displayName, categoryId: item.categoryId || null }))
  };
}

function catalogLookup(catalog) {
  return {
    ingredientIds: new Set(catalog.ingredients.filter(item => item.status !== 'archived').map(item => item.ingredientId)),
    categoryIds: new Set(catalog.categories.filter(item => item.status !== 'archived').map(item => item.categoryId)),
    families: new Map(catalog.families
      .filter(item => item.status !== 'archived')
      .map(item => [item.familyId, item]))
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

// Profilo v3: la revisione della Struttura dieta (dietPlan a blocchi) + lo
// snapshot del catalogo globale al momento della lettura. Note e checksum
// interni non escono mai verso il cliente.
function publicStructureAssignment({ assignment, clientId, structure, revision, catalog }) {
  return {
    schemaVersion: 3,
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
      dietPlan: revision.dietPlan || null
    },
    catalog: publicCatalogSnapshot(catalog),
    compatibleClientSchema: 7
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
  // Le assegnazioni puntano alla revisione pubblicata di una Struttura dieta
  // (pointer {structureId, revisionId, checksum}). La revisione assegnata
  // resta servita anche se la struttura viene archiviata dopo
  // (non-retroattività: governa l'assignment, non la testata).
  const revisionId = String(assignment.structure?.revisionId || '');
  if (!revisionId) return { state: 'invalid-structure', fallback: 'original-only', clientProfileId: clientId };
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
    return { state: 'invalid-structure', fallback: 'original-only', clientProfileId: clientId };
  }
  return {
    state: 'assigned', fallback: 'original-only',
    profile: publicStructureAssignment({ assignment, clientId, structure: structure.data(), revision: revision.data(), catalog })
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

exports.listAuthorizedClients = callable(async (data, uid) => {
  exactObject(data, ['organizationId']);
  const actor = await actorContext(data.organizationId, uid);
  // Vista Clienti unificata: ogni professionista vede i propri clienti in
  // tutti gli stati operativi (attivi, in attesa, inattivi); il creatore li
  // vede tutti. Un solo filtro per query: la selezione degli
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
// Singolo filtro per clientId; mai token o hash in risposta.
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

exports.assignClientStructure = callable(async (data, uid) => {
  const input = validateStructureAssignment(data);
  const actor = await actorContext(input.organizationId, uid);
  const client = await authorizedClient(actor, input.clientId);
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
  const structurePointer = { structureId: doc.id, revisionId: String(revisionId), checksum: revisionChecksum };
  const structureName = doc.data().name || doc.id;
  const notesMetadata = input.notes ? { notes: input.notes, notesVisibility: 'staff' } : {};
  const assignmentId = checksum(`${actor.organizationId}:${input.clientId}:${input.idempotencyKey}`).slice(0, 32);
  const assignmentRef = client.ref.collection('assignments').doc(assignmentId);
  const stateRef = client.ref.collection('state').doc('activeAssignment');
  const eventId = checksum(`assignment.created:${assignmentId}`).slice(0, 32);
  const now = new Date();
  const immediate = input.effectiveAt <= now;
  // Audit: structureId + revisionId (il checksum resta nel documento interno
  // e nello snapshot, mai in chiaro verso la console).
  const auditMetadata = { clientId: client.id, structureId: structurePointer.structureId, revisionId: structurePointer.revisionId, effectiveAt: input.effectiveAt.toISOString(), expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null, withoutExpiration: input.withoutExpiration };
  const projection = { assignmentId, structureId: structurePointer.structureId, structureName };
  await db.runTransaction(async tx => {
    const [existing, state] = await Promise.all([tx.get(assignmentRef), tx.get(stateRef)]);
    if (existing.exists) return;
    const previousAssignmentId = state.data()?.assignmentId || null;
    if (immediate && previousAssignmentId) {
      tx.update(client.ref.collection('assignments').doc(previousAssignmentId), { status: 'revoked', revocationReason: 'Sostituito da una nuova assegnazione', updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    }
    tx.create(assignmentRef, {
      schemaVersion: 3, assignmentId, clientId: client.id,
      structure: structurePointer, structureName,
      status: immediate ? 'active' : 'scheduled', effectiveAt: Timestamp.fromDate(input.effectiveAt),
      expiresAt: input.expiresAt ? Timestamp.fromDate(input.expiresAt) : null,
      withoutExpiration: input.withoutExpiration,
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
    summary: data.summary || null,
    ingredientCatalogVersion: data.ingredientCatalogVersion ?? null
  };
  if (includeChecksum) doc.latestChecksum = data.latestChecksum || null;
  return doc;
}

// Riferimenti al catalogo globale: ogni famiglia e ingrediente citati dal
// piano dieta devono esistere (e non essere archiviati) al momento della
// pubblicazione. Le dosi restano nella struttura; il catalogo non ne ha.
function assertCatalogReferences(dietPlan, lookup) {
  const failMissing = (kind, ref, where) => {
    throw new HttpsError('failed-precondition', `${kind} "${ref}" inesistente o archiviato in catalogo (${where})`);
  };
  (dietPlan?.days || []).forEach(day => {
    (day?.meals || []).forEach(meal => {
      (meal?.options || []).forEach((option, optionIndex) => {
        const optionWhere = `giornata ${day?.dayId}, ${meal?.mealId}, opzione ${optionIndex + 1}`;
        (option?.blocks || []).forEach(block => {
          if (!lookup.families.has(block.referenceFamilyId)) failMissing('Famiglia', block.referenceFamilyId, optionWhere);
          if (block.referenceIngredientId && !lookup.ingredientIds.has(block.referenceIngredientId)) {
            failMissing('Ingrediente', block.referenceIngredientId, optionWhere);
          }
          (block?.templateSnapshot?.equivalents || []).forEach(equivalent => {
            if (!lookup.families.has(equivalent.familyId)) failMissing('Famiglia', equivalent.familyId, `${optionWhere}, template equivalenze`);
            if (equivalent.ingredientId && !lookup.ingredientIds.has(equivalent.ingredientId)) {
              failMissing('Ingrediente', equivalent.ingredientId, `${optionWhere}, template equivalenze`);
            }
          });
          (block?.overrides || []).forEach(override => {
            if (!lookup.families.has(override.familyId)) failMissing('Famiglia', override.familyId, `${optionWhere}, override`);
            if (override.ingredientId && !lookup.ingredientIds.has(override.ingredientId)) {
              failMissing('Ingrediente', override.ingredientId, `${optionWhere}, override`);
            }
          });
        });
        (option?.items || []).forEach(item => {
          if (!lookup.ingredientIds.has(item.ingredientId)) failMissing('Ingrediente', item.ingredientId, optionWhere);
        });
      });
    });
  });
}

// Sommario del piano per la lista strutture (contatori, no dosi in chiaro).
function dietPlanSummaryData(dietPlan) {
  let meals = 0;
  let options = 0;
  let blocks = 0;
  let items = 0;
  let recipes = 0;
  (dietPlan?.days || []).forEach(day => (day?.meals || []).forEach(meal => {
    meals += 1;
    (meal?.options || []).forEach(option => {
      options += 1;
      if (option?.type === 'recipe') recipes += 1;
      blocks += Array.isArray(option?.blocks) ? option.blocks.length : 0;
      items += Array.isArray(option?.items) ? option.items.length : 0;
    });
  }));
  return { dayCount: (dietPlan?.days || []).length, mealCount: meals, optionCount: options, blockCount: blocks, itemCount: items, recipeOptionCount: recipes };
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
      schemaVersion: Number(revision.data().schemaVersion || 0),
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
  exactObject(data, ['organizationId', 'name', 'dietPlan', 'idempotencyKey']);
  const actor = await actorContext(data.organizationId, uid);
  const name = text(data.name, 'name', { min: 3, max: 80 });
  const dietPlan = validateDietPlan(data.dietPlan);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const catalog = await loadGlobalCatalog();
  assertCatalogReferences(dietPlan, catalogLookup(catalog));
  const summary = dietPlanSummaryData(dietPlan);
  const structureId = checksum(`${actor.organizationId}:${uid}:${name}:${idem}`).slice(0, 24);
  const ref = db.doc(`organizations/${actor.organizationId}/dietStructures/${structureId}`);
  const revisionChecksum = structureRevisionChecksum({ schemaVersion: STRUCTURE_REVISION_SCHEMA_VERSION, dietPlan });
  const eventId = checksum(`structure.created:${structureId}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [existing, audit] = await Promise.all([tx.get(ref), tx.get(auditRef(actor.organizationId, eventId))]);
    if (existing.exists || audit.exists) return;
    tx.create(ref, {
      schemaVersion: 2, name, status: 'active', ownerUid: uid, createdBy: uid,
      currentRevisionId: '1', latestChecksum: revisionChecksum, summary,
      ingredientCatalogVersion: catalog.catalogVersion,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(ref.collection('revisions').doc('1'), {
      schemaVersion: STRUCTURE_REVISION_SCHEMA_VERSION, revisionId: '1', structureId,
      dietPlan, status: 'published', checksum: revisionChecksum, ingredientCatalogVersion: catalog.catalogVersion,
      compatibleClientSchema: 7, changelog: 'Prima revisione', createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(), createdBy: uid, publishedAt: FieldValue.serverTimestamp(), publishedBy: uid
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'structure.created', actor, subject: { type: 'dietStructure', id: structureId }, idempotencyKey: idem, metadata: { name, summary, ingredientCatalogVersion: catalog.catalogVersion } }));
  });
  return { structureId, revisionId: '1' };
});

exports.updateDietStructureRevision = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'structureId', 'name', 'dietPlan', 'changelog', 'restoredFromRevisionId', 'idempotencyKey']);
  const actor = await actorContext(data.organizationId, uid);
  const dietPlan = validateDietPlan(data.dietPlan);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  const name = optionalText(data.name, 'name', 80);
  const changelog = optionalText(data.changelog, 'changelog', 500);
  const restoredFrom = optionalText(data.restoredFromRevisionId, 'restoredFromRevisionId', 40);
  const { ref, doc } = await authorizedStructure(actor, data.structureId, { mustOwn: actor.role === 'nutritionist' });
  if (doc.data().status === 'archived') throw new HttpsError('failed-precondition', 'Riattiva la struttura prima di pubblicare una nuova revisione');
  const catalog = await loadGlobalCatalog();
  assertCatalogReferences(dietPlan, catalogLookup(catalog));
  const summary = dietPlanSummaryData(dietPlan);
  const nextRevisionId = String(Number(doc.data().currentRevisionId || '0') + 1);
  const revisionChecksum = structureRevisionChecksum({ schemaVersion: STRUCTURE_REVISION_SCHEMA_VERSION, dietPlan });
  const eventId = checksum(`structure.revision:${ref.id}:${nextRevisionId}:${idem}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const audit = await tx.get(auditRef(actor.organizationId, eventId));
    if (audit.exists) return;
    tx.update(ref, {
      ...(name ? { name } : {}),
      currentRevisionId: nextRevisionId, latestChecksum: revisionChecksum, summary,
      ingredientCatalogVersion: catalog.catalogVersion,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    });
    tx.create(ref.collection('revisions').doc(nextRevisionId), {
      schemaVersion: STRUCTURE_REVISION_SCHEMA_VERSION, revisionId: nextRevisionId, structureId: ref.id,
      dietPlan, status: 'published', checksum: revisionChecksum, ingredientCatalogVersion: catalog.catalogVersion,
      compatibleClientSchema: 7, changelog: changelog || (restoredFrom ? `Ripristino dalla revisione ${restoredFrom}` : 'Nuova revisione'),
      restoredFromRevisionId: restoredFrom || null,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      createdBy: uid, publishedAt: FieldValue.serverTimestamp(), publishedBy: uid
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: 'structure.revision.published', actor, subject: { type: 'dietStructure', id: ref.id }, idempotencyKey: idem, metadata: { revisionId: nextRevisionId, restoredFromRevisionId: restoredFrom || null, summary, ingredientCatalogVersion: catalog.catalogVersion } }));
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
// CONFRONTA (sola lettura, matrice server-side): confronta le revisioni
// correnti di 2-8 strutture. Il nutritionist può confrontare solo le proprie;
// il creatore tutte. Non modifica dati. Il confronto è per giornata e pasto:
// numero di opzioni, sommario blocchi e tipi di opzione.
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
  const signature = revision => revision ? checksum({
    days: (revision.dietPlan?.days || []).map(day => ({
      dayType: day.dayType,
      meals: (day.meals || []).map(meal => ({
        mealId: meal.mealId,
        options: (meal.options || []).map(option => ({
          type: option.type,
          blocks: (option.blocks || []).map(block => `${block.referenceFamilyId}:${block.referenceAmount?.value ?? ''}:${block.referenceAmount?.unit ?? ''}`),
          items: (option.items || []).map(item => `${item.ingredientId}:${item.amount?.value ?? ''}`),
          recipeId: option.recipeId || null
        }))
      }))
    }))
  }) : null;
  const dayTypes = new Set();
  loaded.forEach(({ revision }) => (revision?.dietPlan?.days || []).forEach(day => dayTypes.add(day.dayType)));
  const rows = [...dayTypes].sort().map(dayType => {
    const cells = {};
    loaded.forEach(({ structure, revision }) => {
      const day = (revision?.dietPlan?.days || []).find(item => item.dayType === dayType);
      cells[structure.id] = day ? { present: true, mealCount: (day.meals || []).length } : { present: false };
    });
    const signatures = new Set(loaded.map(({ structure }) => checksum(cells[structure.id])));
    return { dayType, cells, differs: signatures.size > 1 };
  });
  const mealRows = [];
  const mealKeys = new Set();
  loaded.forEach(({ revision }) => (revision?.dietPlan?.days || []).forEach(day => (day?.meals || []).forEach(meal => {
    mealKeys.add(`${day.dayType}|${meal.mealId}`);
  })));
  [...mealKeys].sort().forEach(key => {
    const [dayType, mealId] = key.split('|');
    const cells = {};
    loaded.forEach(({ structure, revision }) => {
      const day = (revision?.dietPlan?.days || []).find(item => item.dayType === dayType);
      const meal = (day?.meals || []).find(item => item.mealId === mealId);
      cells[structure.id] = meal ? {
        present: true,
        optionCount: (meal.options || []).length,
        optionTypes: [...new Set((meal.options || []).map(option => option.type))]
      } : { present: false };
    });
    const signatures = new Set(loaded.map(({ structure }) => checksum(cells[structure.id])));
    mealRows.push({ dayType, mealId, cells, differs: signatures.size > 1 });
  });
  return {
    structures: loaded.map(({ structure }) => ({
      id: structure.id, name: structure.name, status: structure.status,
      summary: structure.summary, updatedAt: structure.updatedAt
    })),
    rows,
    mealRows,
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
  if (kind === 'family') {
    return {
      familyId: item.familyId, displayName: item.displayName,
      categoryId: item.categoryId, sortOrder: Number(item.sortOrder || 0),
      status: item.status || 'active'
    };
  }
  return {
    ingredientId: item.ingredientId, displayName: item.displayName,
    categoryId: item.categoryId, familyId: item.familyId || null,
    aliases: [...(item.aliases || [])].sort(),
    dietaryFlags: { vegetarian: item.dietaryFlags?.vegetarian === true, vegan: item.dietaryFlags?.vegan === true },
    status: item.status || 'active'
  };
}

function catalogContentChecksum(ingredients, categories, families, catalogVersion) {
  const byIngredient = (a, b) => String(a.ingredientId).localeCompare(String(b.ingredientId));
  const byCategory = (a, b) => String(a.categoryId).localeCompare(String(b.categoryId));
  const byFamily = (a, b) => String(a.familyId).localeCompare(String(b.familyId));
  return checksum({
    schemaVersion: 3,
    catalogVersion,
    ingredients: ingredients.map(item => canonicalCatalogEntry(item, 'ingredient')).sort(byIngredient),
    categories: categories.map(item => canonicalCatalogEntry(item, 'category')).sort(byCategory),
    families: families.map(item => canonicalCatalogEntry(item, 'family')).sort(byFamily)
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
    const snapFamilies = Array.isArray(snapshot.data().families) ? snapshot.data().families : [];
    const snapIds = new Set(snapIngredients.map(item => item?.ingredientId).filter(Boolean));
    const snapCatIds = new Set(snapCategories.map(item => item?.categoryId).filter(Boolean));
    const snapFamilyIds = new Set(snapFamilies.map(item => item?.familyId).filter(Boolean));
    const deleteIds = catalog.ingredients.map(item => item.ingredientId).filter(idValue => !snapIds.has(idValue));
    const deleteCatIds = catalog.categories.map(item => item.categoryId).filter(idValue => !snapCatIds.has(idValue));
    const deleteFamilyIds = catalog.families.map(item => item.familyId).filter(idValue => !snapFamilyIds.has(idValue));
    const totalWrites = snapIngredients.length + snapCategories.length + snapFamilies.length + deleteIds.length + deleteCatIds.length + deleteFamilyIds.length + 3;
    if (totalWrites > 500) throw new HttpsError('failed-precondition', 'Ripristino troppo grande per una transazione atomica: contatta il supporto');
    const nextVersion = catalog.catalogVersion + 1;
    const restoredChecksum = catalogContentChecksum(snapIngredients, snapCategories, snapFamilies, nextVersion);
    const eventId = checksum(`catalog.restored:${restoreVersion}:${nextVersion}`).slice(0, 32);
    const currentSnapshot = JSON.stringify({ ingredients: catalog.ingredients, categories: catalog.categories, families: catalog.families });
    if (currentSnapshot.length > 950000) throw new HttpsError('failed-precondition', 'Catalogo corrente troppo grande per lo snapshot: contatta il supporto');
    await db.runTransaction(async tx => {
      const fresh = await tx.get(metaRef);
      if (Number(fresh.data()?.catalogVersion || 0) !== catalog.catalogVersion) {
        throw new HttpsError('failed-precondition', 'Il catalogo è cambiato durante il ripristino: riprova');
      }
      if ((await tx.get(platformAuditRef(eventId))).exists) return;
      snapIngredients.forEach(entry => {
        tx.set(db.doc(`globalIngredientCatalog/current/ingredients/${entry.ingredientId}`), {
          ...entry, schemaVersion: 3, catalogVersion: nextVersion, updatedAt: FieldValue.serverTimestamp()
        });
      });
      snapCategories.forEach(entry => {
        tx.set(db.doc(`globalIngredientCatalog/current/categories/${entry.categoryId}`), {
          ...entry, schemaVersion: 3, catalogVersion: nextVersion, updatedAt: FieldValue.serverTimestamp()
        });
      });
      snapFamilies.forEach(entry => {
        tx.set(db.doc(`globalIngredientCatalog/current/families/${entry.familyId}`), {
          ...entry, schemaVersion: 3, catalogVersion: nextVersion, updatedAt: FieldValue.serverTimestamp()
        });
      });
      deleteIds.forEach(idValue => tx.delete(db.doc(`globalIngredientCatalog/current/ingredients/${idValue}`)));
      deleteCatIds.forEach(idValue => tx.delete(db.doc(`globalIngredientCatalog/current/categories/${idValue}`)));
      deleteFamilyIds.forEach(idValue => tx.delete(db.doc(`globalIngredientCatalog/current/families/${idValue}`)));
      tx.set(db.doc(`globalIngredientCatalog/versions/snapshots/${catalog.catalogVersion}`), {
        schemaVersion: 3, catalogVersion: catalog.catalogVersion, checksum: catalog.checksum,
        ingredients: catalog.ingredients, categories: catalog.categories, families: catalog.families,
        supersededBy: nextVersion, createdAt: FieldValue.serverTimestamp(), createdBy: uid
      });
      tx.set(metaRef, {
        schemaVersion: 3, catalogVersion: nextVersion, checksum: restoredChecksum,
        ingredientCount: snapIngredients.length, categoryCount: snapCategories.length, familyCount: snapFamilies.length,
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
  const existingFamilies = {};
  catalog.families.forEach(item => { existingFamilies[item.familyId] = item; });
  const report = validateCatalogImport(parsed, {
    existingIngredients,
    existingCategories: catalog.categories.map(item => item.categoryId),
    existingFamilies,
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
  const writeCount = report.normalized.ingredients.length + report.normalized.categories.length + report.normalized.families.length;
  if (writeCount > CATALOG_COMMIT_WRITE_LIMIT) {
    throw new HttpsError('failed-precondition', `Commit atomico limitato a ${CATALOG_COMMIT_WRITE_LIMIT} voci: suddividi il file`);
  }
  const mergedIngredients = new Map(catalog.ingredients.map(item => [item.ingredientId, item]));
  report.normalized.ingredients.forEach(entry => mergedIngredients.set(entry.ingredientId, entry));
  const mergedCategories = new Map(catalog.categories.map(item => [item.categoryId, item]));
  report.normalized.categories.forEach(entry => mergedCategories.set(entry.categoryId, entry));
  const mergedFamilies = new Map(catalog.families.map(item => [item.familyId, item]));
  report.normalized.families.forEach(entry => mergedFamilies.set(entry.familyId, entry));
  const createdOrUpdated = report.counts.create + report.counts.update;
  if (createdOrUpdated === 0) throw new HttpsError('failed-precondition', 'Niente da scrivere: il file non contiene novità');
  const nextVersion = catalog.catalogVersion + 1;
  const newChecksum = catalogContentChecksum([...mergedIngredients.values()], [...mergedCategories.values()], [...mergedFamilies.values()], nextVersion);
  const currentSnapshot = JSON.stringify({ ingredients: catalog.ingredients, categories: catalog.categories, families: catalog.families });
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
        schemaVersion: 3, ...entry, catalogVersion: nextVersion, updatedAt: FieldValue.serverTimestamp()
      });
    });
    report.normalized.categories.forEach(entry => {
      tx.set(db.doc(`globalIngredientCatalog/current/categories/${entry.categoryId}`), {
        schemaVersion: 3, ...entry, catalogVersion: nextVersion, updatedAt: FieldValue.serverTimestamp()
      });
    });
    report.normalized.families.forEach(entry => {
      tx.set(db.doc(`globalIngredientCatalog/current/families/${entry.familyId}`), {
        schemaVersion: 3, ...entry, catalogVersion: nextVersion, updatedAt: FieldValue.serverTimestamp()
      });
    });
    tx.set(db.doc(`globalIngredientCatalog/versions/snapshots/${catalog.catalogVersion}`), {
      schemaVersion: 3, catalogVersion: catalog.catalogVersion, checksum: catalog.checksum,
      ingredients: catalog.ingredients, categories: catalog.categories, families: catalog.families,
      supersededBy: nextVersion, createdAt: FieldValue.serverTimestamp(), createdBy: uid
    });
    tx.set(metaRef, {
      schemaVersion: 3, catalogVersion: nextVersion, checksum: newChecksum,
      ingredientCount: mergedIngredients.size, categoryCount: mergedCategories.size, familyCount: mergedFamilies.size,
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

// Invito lato console: MAI tokenHash né token in chiaro in questa riga. Il link
// si recupera solo con la callable getClientInviteLink (segreto server-only),
// che la console chiama dal bottone "Copia link" finché l'invito è pendente.
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
    let existingInvite = null;

    await db.runTransaction(async tx => {
      const [existing, audit] = await Promise.all([tx.get(inviteRef), tx.get(auditRef(orgId, eventId))]);
      if (existing.exists || audit.exists) { created = false; existingInvite = existing.exists ? existing.data() : null; return; }
      tx.create(inviteRef, {
        schemaVersion: 2, inviteId, type: 'nutritionist', channel: 'manual-link',
        targetEmail: input.email, targetEmailNormalized: input.email,
        targetEmailHash: emailFingerprint(input.email),
        firstName: input.firstName || '', lastName: input.lastName || '',
        tokenHash: hashToken(token), status: 'pending', expiresAt: Timestamp.fromDate(expiresAt),
        delivery: { schemaVersion: 2, channel: 'manual-link', status: 'manual', handedToConsole: true, updatedAt: FieldValue.serverTimestamp() },
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid
      });
      // Il segreto rende il link recuperabile dalla console finché l'invito è
      // pendente: senza, la chiusura della finestra lo perderebbe per sempre.
      writeInviteSecret(tx, { orgId, inviteId, token, uid });
      tx.create(auditRef(orgId, eventId), auditEvent({
        orgId, eventId, type: 'member.invited', actor,
        subject: { type: 'invitation', id: inviteId }, idempotencyKey: input.idempotencyKey,
        metadata: { role: 'nutritionist', email: maskEmail(input.email) }
      }));
    });

    // Replay idempotente: il token appena generato NON è quello dell'invito,
    // quindi non va consegnato. Si ripropone il link già emesso (letto dal
    // segreto) oppure si rimanda a "Copia link" / "Genera nuovo link".
    if (!created) {
      const persisted = await persistedInviteLink(orgId, inviteId, existingInvite);
      return {
        status: 'already-invited',
        inviteId,
        expiresAt: inviteExpiryIso(existingInvite) || expiresAt.toISOString(),
        ...(persisted || {}),
        delivery: { channel: 'manual-link', status: 'manual', handedToConsole: true },
        message: persisted
          ? 'Invito già creato in precedenza: questo è il link ancora valido. Consegnalo con “Copia link”.'
          : 'Invito già creato in precedenza: nessun nuovo token emesso. Usa “Copia link” oppure genera un nuovo link.'
      };
    }

    const inviteUrl = buildInviteLink(APP_PUBLIC_URL, token);
    return {
      status: 'invited',
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
      // Invito accettato: nessun segreto resta leggibile per questo invito.
      tx.delete(inviteSecretRef(orgId, inviteDoc.id));
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
    // Invito accettato: il segreto del link viene eliminato.
    tx.delete(inviteSecretRef(orgId, inviteDoc.id));
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

// Formato del token d'invito: 32 byte casuali in esadecimale (64 caratteri).
const INVITE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

// ---- Segreto del link d'invito (consegna persistente) ----
// Il documento invito conserva SOLO l'hash del token: da lì il link non è
// ricostruibile. Perché la console possa riaprire "Copia link" finché il
// cliente non è attivo, il token in chiaro vive in un documento separato
// `organizations/{orgId}/invitationSecrets/{inviteId}`, chiuso a qualunque
// lettura client dalle Rules e raggiungibile solo dall'Admin SDK (callable
// getClientInviteLink). Ciclo di vita del segreto: creato con l'invito, ruotato
// da reinvio e correzione, eliminato appena l'invito smette di essere
// utilizzabile (annullato, sostituito, riscattato, collegamento rimosso,
// cliente eliminato). Nessuna rigenerazione: il link resta lo stesso.
function inviteSecretRef(orgId, inviteId) {
  return db.doc(`organizations/${orgId}/invitationSecrets/${inviteId}`);
}

function inviteSecretBody({ orgId, inviteId, token, uid }) {
  return {
    schemaVersion: 1, inviteId, organizationId: orgId,
    token, tokenHash: hashToken(token),
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: uid
  };
}

// Scrittura e rotazione del segreto nella STESSA transazione dell'invito: token
// in chiaro e hash non possono mai divergere.
function writeInviteSecret(tx, { orgId, inviteId, token, uid }) {
  tx.set(inviteSecretRef(orgId, inviteId), inviteSecretBody({ orgId, inviteId, token, uid }), { merge: true });
}

// Lettura tollerante del segreto: usata solo nei replay idempotenti, dove un
// segreto mancante non deve far fallire l'operazione (il link si recupera con
// "Copia link" oppure si rinnova con "Genera nuovo link").
async function readInviteSecretToken(orgId, inviteId) {
  try {
    const snap = await inviteSecretRef(orgId, inviteId).get();
    const token = snap.exists ? String(snap.data()?.token || '') : '';
    return INVITE_TOKEN_PATTERN.test(token) ? token : null;
  } catch (error) {
    logger.warn('Segreto dell’invito non leggibile', { inviteId, err: error?.message });
    return null;
  }
}

// Link persistente di un invito già emesso: token e URL vengono restituiti SOLO
// se l'invito è ancora utilizzabile (pendente e non scaduto) e il segreto
// corrisponde all'hash del documento. In ogni altro caso null: si passa da
// "Genera nuovo link".
async function persistedInviteLink(orgId, inviteId, invite) {
  if (invite?.status !== 'pending') return null;
  const expiresAt = invite.expiresAt?.toDate?.() || null;
  if (!expiresAt || expiresAt.getTime() <= Date.now()) return null;
  const token = await readInviteSecretToken(orgId, inviteId);
  if (!token || hashToken(token) !== invite.tokenHash) return null;
  return { token, inviteUrl: buildInviteLink(APP_PUBLIC_URL, token) };
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
  // Singolo filtro: lo stato si seleziona in codice, senza
  // indici composti (la combinazione email+stato non è indicizzata).
  const snap = await db.collection(`organizations/${orgId}/invitations`)
    .where('targetEmailNormalized', '==', emailNormalized).limit(10).get();
  return snap.docs
    .filter(doc => doc.data()?.status === 'pending')
    .map(doc => ({ ref: doc.ref, id: doc.id, ...doc.data() }));
}

async function pendingLinkRequestsByEmail(orgId, emailNormalized) {
  // Singolo filtro: lo stato si seleziona in codice.
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
    // Singolo filtro: lo stato si seleziona in codice.
    const stale = await tx.get(
      db.collection(`organizations/${orgId}/invitations`)
        .where('targetEmailNormalized', '==', input.email)
    );
    stale.docs.filter(doc => doc.id !== inviteId && doc.data()?.status === 'pending').forEach(doc => {
      tx.update(doc.ref, {
        status: 'superseded', supersededBy: inviteId,
        supersededAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      });
      // Un invito sostituito non è più consegnabile: il suo segreto va via.
      tx.delete(inviteSecretRef(orgId, doc.id));
    });
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
    // Segreto del link: finché l'invito è pendente la console può riaprire
    // "Copia link" senza rigenerare il token (nessun link perso).
    writeInviteSecret(tx, { orgId, inviteId, token, uid });
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
// segreto). Non scrive nulla e non rivela dati di altri utenti. È una callable
// PUBBLICA: App Check non è richiesto, altrimenti il link aperto fuori
// dall'app registrata riceveva un 500 senza nemmeno entrare nel handler.
exports.getClientInvitePreview = onCall(publicCallableOptions, async request => {
  try {
    exactObject(request.data || {}, ['token']);
    const token = text((request.data || {}).token, 'token', { min: 64, max: 64, pattern: INVITE_TOKEN_PATTERN });
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
    // Stati verso il link pubblico: valid, expired, used, superseded, revoked.
    let status = 'expired';
    if (invite.status === 'pending') status = expired ? 'expired' : 'valid';
    else if (invite.status === 'accepted') status = 'used';
    else if (invite.status === 'superseded') status = 'superseded';
    else if (invite.status === 'revoked') status = 'revoked';
    // Nomi visuali: ogni lettura è isolata, così un documento mancante o un
    // errore transitorio non trasforma l'anteprima in un 500. Il nome resta
    // null e la schermata mostra i dati dell'invito.
    let organizationName = null;
    try {
      const orgDisplay = await organizationDisplayName(orgId);
      organizationName = orgDisplay || orgId;
      // Per i professionisti il nome dello studio è un dettaglio in più: se non
      // è disponibile si usa un'etichetta neutra (mai l'ID tecnico).
      if (invite.type === 'nutritionist' && organizationName === orgId) organizationName = 'Studio Professionale';
    } catch (error) {
      logger.warn('Nome organizzazione non disponibile per l’anteprima dell’invito', { err: error?.message });
      organizationName = invite.type === 'nutritionist' ? 'Studio Professionale' : null;
    }
    let nutritionistName = null;
    if (status === 'valid') {
      try {
        nutritionistName = await professionalDisplayName(orgId, invite.nutritionistUid);
      } catch (error) {
        logger.warn('Nome professionista non disponibile per l’anteprima dell’invito', { err: error?.message });
        nutritionistName = null;
      }
    }
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

// Recupero del link di un invito PENDENTE per la console ("Copia link").
// Il token non viene rigenerato: si legge il segreto scritto alla creazione
// (o ruotato da reinvio/correzione), quindi il link già consegnato resta
// valido e la chiusura della finestra non lo perde più. Autorizzato come le
// altre callable sugli inviti: creatore oppure professionista che lo ha emesso.
exports.getClientInviteLink = callable(async (data, uid) => {
  const input = validateGetInviteLink(data);
  const actor = await actorContext(input.organizationId, uid);
  const orgId = actor.organizationId;
  const inviteRef = db.doc(`organizations/${orgId}/invitations/${input.inviteId}`);
  const snapshot = await inviteRef.get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Invito non trovato: aggiorna l’elenco e riprova');
  const invite = snapshot.data();
  if (!authorizeInviteActor(actor, invite)) throw new HttpsError('permission-denied', 'Invito non autorizzato');
  if (invite.type !== CLIENT_EMAIL_INVITE_TYPE && invite.type !== 'nutritionist') {
    throw new HttpsError('failed-precondition', 'Questo invito usa il flusso legacy: creane uno nuovo con l’email per ottenere un link');
  }
  if (invite.status === 'accepted') {
    throw new HttpsError('failed-precondition', 'Invito già utilizzato: il collegamento è attivo, nessun link da consegnare');
  }
  if (invite.status === 'revoked') throw new HttpsError('failed-precondition', 'Invito annullato: creane uno nuovo');
  if (invite.status === 'superseded') {
    throw new HttpsError('failed-precondition', 'Questo invito è stato sostituito: usa il link più recente');
  }
  if (invite.status !== 'pending') throw new HttpsError('failed-precondition', 'Invito non più valido: genera un nuovo link');
  const expiresAt = invite.expiresAt?.toDate?.() || null;
  if (!expiresAt || expiresAt.getTime() <= Date.now()) {
    throw new HttpsError('failed-precondition', 'Invito scaduto: genera un nuovo link');
  }
  const secretRef = inviteSecretRef(orgId, input.inviteId);
  let secretSnap;
  try {
    secretSnap = await secretRef.get();
  } catch (error) {
    logger.error('Lettura del segreto d’invito non riuscita', { inviteId: input.inviteId, err: error?.message });
    throw new HttpsError('internal', 'Link non disponibile in questo momento: riprova tra poco');
  }
  const token = secretSnap?.exists ? String(secretSnap.data()?.token || '') : '';
  // Doppio controllo: formato del token e corrispondenza con l'hash dell'invito
  // (un segreto vecchio di un token già ruotato non deve mai essere consegnato).
  if (!INVITE_TOKEN_PATTERN.test(token) || hashToken(token) !== invite.tokenHash) {
    throw new HttpsError('failed-precondition', 'Il link non è più disponibile: genera un nuovo link');
  }
  return {
    inviteId: input.inviteId,
    clientId: invite.clientId || null,
    type: invite.type,
    targetEmail: invite.targetEmailNormalized || invite.targetEmail || null,
    firstName: invite.firstName || null,
    lastName: invite.lastName || null,
    expiresAt: inviteExpiryIso(invite),
    inviteUrl: buildInviteLink(APP_PUBLIC_URL, token),
    token,
    // Consegna sempre a mano: la console mostra "Copia link" e "Condividi link".
    delivery: { channel: 'manual' }
  };
});

// Alias corto usato da alcune schermate della console: stessa callable.
exports.getInviteLink = exports.getClientInviteLink;

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
      // Collegamento attivo: il segreto (e il link consegnabile) non serve più.
      tx.delete(inviteSecretRef(orgId, inviteDoc.id));
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
    // Cliente attivo: il segreto viene eliminato, "Copia link" non ha più senso.
    tx.delete(inviteSecretRef(orgId, inviteDoc.id));
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
    // Rotazione del segreto: da qui il link consegnabile è solo quello nuovo.
    writeInviteSecret(tx, { orgId, inviteId: input.inviteId, token, uid });
    tx.create(auditRef(orgId, eventId), auditEvent({
      orgId, eventId, type: 'client.email-invite-resent', actor,
      subject: { type: 'invitation', id: input.inviteId }, idempotencyKey: input.idempotencyKey,
      metadata: { delivery: INVITE_DELIVERY_CHANNEL }
    }));
  });
  if (!rotated) {
    // Replay idempotente: il token è già stato ruotato una volta, quindi non si
    // ruota di nuovo. Si riconsegna il link attuale, letto dal segreto.
    const current = await inviteRef.get();
    const persisted = await persistedInviteLink(orgId, input.inviteId, current.exists ? current.data() : null);
    return {
      status: 'already-pending', inviteId: input.inviteId, ...(persisted || {}),
      message: 'Reinvio già effettuato.'
    };
  }
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
    // Invito annullato = link non consegnabile: il segreto non ha più ragione
    // di esistere (il documento invito resta in storico).
    tx.delete(inviteSecretRef(orgId, input.inviteId));
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
    // Singolo filtro: lo stato si seleziona in codice.
    const otherPending = await tx.get(
      db.collection(`organizations/${orgId}/invitations`)
        .where('targetEmailNormalized', '==', input.email)
    );
    otherPending.docs.filter(doc => doc.id !== inviteId && doc.data()?.status === 'pending').forEach(doc => {
      tx.update(doc.ref, {
        status: 'superseded', supersededBy: inviteId,
        supersededAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      });
      // Invito sostituito: il suo segreto (e quindi il suo link) viene meno.
      tx.delete(inviteSecretRef(orgId, doc.id));
    });
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
      // Il segreto segue l'invito: quello vecchio sparisce con il link vecchio.
      tx.delete(inviteSecretRef(orgId, input.inviteId));
    }
    // Rotazione: la correzione emette un token nuovo, quindi il segreto
    // dell'invito corretto punta da subito al link appena generato.
    writeInviteSecret(tx, { orgId, inviteId, token, uid });
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
    pendingInvites.docs.forEach(doc => {
      tx.delete(doc.ref);
      // Eliminato l'invito, eliminato anche il suo segreto (token in chiaro).
      tx.delete(inviteSecretRef(orgId, doc.id));
    });

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
  // Singolo filtro: lo stato si seleziona in codice (già fatto sotto).
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
    // Singolo filtro: lo stato si seleziona in codice.
    pendingRequests.docs.filter(doc => doc.data()?.status === 'pending').forEach(doc => tx.update(doc.ref, { status: 'revoked', decidedAt: FieldValue.serverTimestamp(), decidedBy: uid, updatedAt: FieldValue.serverTimestamp() }));
    pendingInvites.docs.filter(doc => doc.data()?.status === 'pending').forEach(doc => {
      tx.update(doc.ref, { status: 'revoked', decidedAt: FieldValue.serverTimestamp(), decidedBy: uid, updatedAt: FieldValue.serverTimestamp() });
      // Collegamento rimosso: i link pendenti non sono più consegnabili.
      tx.delete(inviteSecretRef(actor.organizationId, doc.id));
    });
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

// ---------------------------------------------------------------------
// Template equivalenze (organization-scoped, revisioni immutabili).
// Famiglia di riferimento obbligatoria, ingrediente di riferimento
// facoltativo, quantità di riferimento ed equivalenti proporzionali. La
// pubblicazione congela la revisione (checksum): le strutture che la citano
// ne portano uno snapshot, quindi modifiche future NON sono retroattive.
// ---------------------------------------------------------------------

function serializeEquivalenceTemplate(template, { includeDraft = false } = {}) {
  const data = template.data();
  const doc = {
    id: template.id,
    name: data.name || template.id,
    status: data.status || 'active',
    ownerUid: data.ownerUid || data.createdBy || null,
    currentRevisionId: data.currentRevisionId || null,
    referenceFamilyId: data.referenceFamilyId || null,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null
  };
  if (includeDraft) {
    doc.draftRevision = data.draftRevision || null;
    doc.latestChecksum = data.latestChecksum || null;
  }
  return doc;
}

async function authorizedEquivalenceTemplate(actor, templateId, { mustOwn = false } = {}) {
  const ref = db.doc(`organizations/${actor.organizationId}/equivalenceTemplates/${id(templateId, 'templateId')}`);
  const doc = await ref.get();
  if (!doc.exists) throw new HttpsError('not-found', 'Template equivalenze non trovato');
  if (!actor.isCreator && (mustOwn || actor.role === 'nutritionist') && (doc.data().ownerUid || doc.data().createdBy) !== actor.uid) {
    throw new HttpsError('permission-denied', 'Puoi gestire soltanto i tuoi template equivalenze');
  }
  return { ref, doc };
}

exports.listEquivalenceTemplates = callable(async (data, uid) => {
  exactObject(data, ['organizationId']);
  const actor = await actorContext(data.organizationId, uid);
  let query = db.collection(`organizations/${actor.organizationId}/equivalenceTemplates`);
  if (actor.role === 'nutritionist') query = query.where('ownerUid', '==', uid);
  const snapshot = await query.limit(100).get();
  const templates = snapshot.docs
    .map(doc => serializeEquivalenceTemplate(doc, { includeDraft: Boolean(actor.isCreator) }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { templates };
});

// Restituisce la revisione richiesta (o la corrente) con gli equivalenti
// completi: serve alla console per precompilare i blocchi delle strutture e
// al client per lo snapshot non retroattivo.
exports.getEquivalenceTemplateRevision = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'templateId', 'revisionId']);
  const actor = await actorContext(data.organizationId, uid);
  const { doc } = await authorizedEquivalenceTemplate(actor, data.templateId);
  const revisionId = data.revisionId == null || data.revisionId === ''
    ? doc.data().currentRevisionId
    : id(String(data.revisionId), 'revisionId');
  if (!revisionId) throw new HttpsError('not-found', 'Nessuna revisione pubblicata');
  const revision = await doc.ref.collection('revisions').doc(revisionId).get();
  if (!revision.exists || !verifyEquivalenceTemplateRevision(revision.data())) {
    throw new HttpsError('not-found', 'Revisione del template non valida');
  }
  return { template: serializeEquivalenceTemplate(doc), revision: revision.data() };
});

exports.saveEquivalenceTemplate = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'templateId', 'name', 'referenceFamilyId', 'referenceIngredientId', 'referenceAmount', 'equivalents', 'idempotencyKey']);
  const actor = await actorContext(data.organizationId, uid);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  // Prima la validazione di forma (bloccante)...
  const revision = validateEquivalenceTemplateRevision({
    name: data.name,
    referenceFamilyId: data.referenceFamilyId,
    referenceIngredientId: data.referenceIngredientId,
    referenceAmount: data.referenceAmount,
    equivalents: data.equivalents
  });
  // ...poi la coerenza col catalogo globale: famiglie e ingredienti citati
  // devono esistere, e l'ingrediente di riferimento deve appartenere alla
  // famiglia di riferimento.
  const catalog = await loadGlobalCatalog();
  const lookup = catalogLookup(catalog);
  const referenceFamily = lookup.families.get(revision.referenceFamilyId);
  if (!referenceFamily) throw new HttpsError('failed-precondition', `Famiglia "${revision.referenceFamilyId}" inesistente in catalogo`);
  const assertFamily = (familyId, where) => {
    if (!lookup.families.has(familyId)) throw new HttpsError('failed-precondition', `Famiglia "${familyId}" inesistente in catalogo (${where})`);
  };
  const assertIngredient = (ingredientId, familyId, where) => {
    if (!lookup.ingredientIds.has(ingredientId)) throw new HttpsError('failed-precondition', `Ingrediente "${ingredientId}" inesistente in catalogo (${where})`);
    if (familyId) {
      const ingredient = catalog.ingredients.find(item => item.ingredientId === ingredientId);
      if (ingredient && ingredient.familyId !== familyId) {
        throw new HttpsError('failed-precondition', `Ingrediente "${ingredientId}" non appartiene alla famiglia ${familyId} (${where})`);
      }
    }
  };
  assertIngredient(revision.referenceIngredientId, revision.referenceFamilyId, 'ingrediente di riferimento');
  revision.equivalents.forEach(equivalent => {
    assertFamily(equivalent.familyId, 'equivalente');
    if (equivalent.ingredientId) assertIngredient(equivalent.ingredientId, equivalent.familyId, 'equivalente');
  });
  const revisionChecksum = equivalenceTemplateRevisionChecksum(revision);

  const create = data.templateId == null || data.templateId === '';
  let ref;
  let templateId;
  if (create) {
    templateId = checksum(`${actor.organizationId}:${uid}:${revision.name}:${idem}`).slice(0, 24);
    ref = db.doc(`organizations/${actor.organizationId}/equivalenceTemplates/${templateId}`);
  } else {
    const found = await authorizedEquivalenceTemplate(actor, data.templateId, { mustOwn: actor.role === 'nutritionist' });
    ref = found.ref;
    templateId = ref.id;
  }
  const eventId = checksum(create ? `template.created:${templateId}` : `template.revision:${templateId}:${idem}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [existing, audit] = await Promise.all([tx.get(ref), tx.get(auditRef(actor.organizationId, eventId))]);
    if (existing.exists || audit.exists) {
      if (create) return;
      if (existing.data().status === 'archived') throw new HttpsError('failed-precondition', 'Riattiva il template prima di pubblicare una nuova revisione');
    }
    const nextRevisionId = existing.exists ? String(Number(existing.data().currentRevisionId || '0') + 1) : '1';
    tx.set(ref, {
      schemaVersion: 1, name: revision.name, status: 'active', ownerUid: uid, createdBy: uid,
      currentRevisionId: nextRevisionId, latestChecksum: revisionChecksum,
      referenceFamilyId: revision.referenceFamilyId,
      ingredientCatalogVersion: catalog.catalogVersion,
      createdAt: existing.exists ? existing.data().createdAt : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    }, { merge: true });
    tx.create(ref.collection('revisions').doc(nextRevisionId), {
      schemaVersion: 1, revisionId: nextRevisionId, templateId, ...revision,
      status: 'published', checksum: revisionChecksum, ingredientCatalogVersion: catalog.catalogVersion,
      changelog: create ? 'Prima revisione' : 'Nuova revisione',
      createdAt: FieldValue.serverTimestamp(), publishedAt: FieldValue.serverTimestamp(), publishedBy: uid
    });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({
      orgId: actor.organizationId, eventId,
      type: create ? 'equivalenceTemplate.created' : 'equivalenceTemplate.revision.published',
      actor, subject: { type: 'equivalenceTemplate', id: templateId },
      idempotencyKey: idem,
      metadata: { revisionId: nextRevisionId, referenceFamilyId: revision.referenceFamilyId, equivalentCount: revision.equivalents.length }
    }));
  });
  return { templateId, revisionId: 'current' };
});

exports.archiveEquivalenceTemplate = callable(async (data, uid) => {
  exactObject(data, ['organizationId', 'templateId', 'archived', 'idempotencyKey']);
  const actor = await actorContext(data.organizationId, uid);
  const idem = id(data.idempotencyKey, 'idempotencyKey');
  if (typeof data.archived !== 'boolean') throw new HttpsError('invalid-argument', 'archived deve essere booleano');
  const { ref } = await authorizedEquivalenceTemplate(actor, data.templateId, { mustOwn: actor.role === 'nutritionist' });
  const eventId = checksum(`template.status:${ref.id}:${data.archived}:${idem}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const audit = await tx.get(auditRef(actor.organizationId, eventId));
    if (audit.exists) return;
    tx.update(ref, { status: data.archived ? 'archived' : 'active', updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    tx.create(auditRef(actor.organizationId, eventId), auditEvent({ orgId: actor.organizationId, eventId, type: data.archived ? 'equivalenceTemplate.archived' : 'equivalenceTemplate.restored', actor, subject: { type: 'equivalenceTemplate', id: ref.id }, idempotencyKey: idem, metadata: {} }));
  });
  return { templateId: ref.id, status: data.archived ? 'archived' : 'active' };
});

// ---------------------------------------------------------------------
// Richieste catalogo (flusso cliente → admin). Quando il client incontra un
// ingrediente «unknown» chiede al cliente categoria e famiglia previste; la
// richiesta entra in coda e SOLO l'amministratore la risolve (accetta con
// inserimento in catalogo, modifica o rifiuta). Nessuna dose coinvolta.
// ---------------------------------------------------------------------

function publicCatalogRequestRow(doc, { includeResolution = false } = {}) {
  const data = doc.data();
  const row = {
    requestId: doc.id,
    status: data.status || 'pending',
    ingredientText: data.ingredientText || '',
    proposedCategoryId: data.proposedCategoryId || null,
    proposedFamilyId: data.proposedFamilyId || null,
    clientId: data.clientId || null,
    clientTitle: data.clientTitle || null,
    createdAt: data.createdAt?.toDate?.()?.toISOString() || null
  };
  if (includeResolution) {
    row.resolution = data.resolution || null;
    row.resolvedAt = data.resolvedAt?.toDate?.()?.toISOString() || null;
    row.resolutionNote = data.resolutionNote || null;
  }
  return row;
}

// Cliente: apre una richiesta per un ingrediente non riconosciuto. La
// proposta (categoria + famiglia) nasce dall'autocomplete del catalogo
// stesso: il cliente sceglie tra categorie e famiglie esistenti.
exports.submitCatalogRequest = callable(async (data, uid) => {
  const input = validateCatalogRequestSubmit(data);
  const link = await db.doc(`accountClientLinks/${uid}`).get();
  if (!link.exists || link.data()?.status !== 'active') throw new HttpsError('permission-denied', 'Profilo non autorizzato');
  const { organizationId, clientId } = link.data();
  if (organizationId !== SINGLE_ORGANIZATION_ID) throw new HttpsError('permission-denied', 'Profilo non autorizzato');
  const client = await db.doc(`organizations/${organizationId}/clients/${clientId}`).get();
  if (!client.exists || client.data()?.authUid !== uid || client.data()?.status !== 'active') {
    throw new HttpsError('permission-denied', 'Profilo non autorizzato');
  }
  const catalog = await loadGlobalCatalog();
  const lookup = catalogLookup(catalog);
  if (!lookup.categoryIds.has(input.proposedCategoryId)) throw new HttpsError('failed-precondition', 'Categoria proposta inesistente in catalogo');
  if (!lookup.families.has(input.proposedFamilyId)) throw new HttpsError('failed-precondition', 'Famiglia proposta inesistente in catalogo');
  const requestId = checksum(`catalog.request:${organizationId}:${clientId}:${input.normalizedIngredient}:${input.idempotencyKey}`).slice(0, 32);
  const requestRef = db.doc(`organizations/${organizationId}/catalogRequests/${requestId}`);
  const eventId = checksum(`catalog.request.created:${requestId}`).slice(0, 32);
  await db.runTransaction(async tx => {
    const [existing, audit] = await Promise.all([tx.get(requestRef), tx.get(auditRef(organizationId, eventId))]);
    if (existing.exists || audit.exists) return;
    tx.create(requestRef, {
      schemaVersion: 1, requestId, status: 'pending',
      ingredientText: input.ingredientText, normalizedIngredient: input.normalizedIngredient,
      proposedCategoryId: input.proposedCategoryId, proposedFamilyId: input.proposedFamilyId,
      clientId, clientTitle: client.data()?.title || null,
      submittedByUid: uid, idempotencyKey: input.idempotencyKey,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(auditRef(organizationId, eventId), auditEvent({
      orgId: organizationId, eventId, type: 'catalogRequest.created', actor: { uid, role: 'client' },
      subject: { type: 'catalogRequest', id: requestId }, idempotencyKey: input.idempotencyKey,
      metadata: { ingredientText: input.ingredientText, proposedCategoryId: input.proposedCategoryId, proposedFamilyId: input.proposedFamilyId }
    }));
  });
  return { requestId, status: 'pending' };
});

// Admin platform: coda delle richieste (pending prima, poi risolte).
exports.listCatalogRequests = callable(async (data, uid) => {
  exactObject(data, ['status']);
  await platformAdmin(uid);
  const statusFilter = data.status == null || data.status === '' ? null : text(data.status, 'status');
  let query = db.collection(`organizations/${SINGLE_ORGANIZATION_ID}/catalogRequests`);
  if (statusFilter) query = query.where('status', '==', statusFilter);
  const snapshot = await query.orderBy('createdAt', 'desc').limit(100).get();
  return { requests: snapshot.docs.map(doc => publicCatalogRequestRow(doc, { includeResolution: true })) };
});

// Admin platform: risoluzione. accept = proposta (eventualmente corretta)
// che entra nel catalogo globale con una nuova versione; edit = correzione
// esplicita dell'ingrediente; reject = rifiuto con motivo.
exports.resolveCatalogRequest = callable(async (data, uid) => {
  const input = validateCatalogRequestResolve(data);
  const actor = await platformAdmin(uid);
  const requestRef = db.doc(`organizations/${SINGLE_ORGANIZATION_ID}/catalogRequests/${input.requestId}`);
  const eventId = checksum(`catalog.request.resolved:${input.requestId}:${input.action}:${input.idempotencyKey}`).slice(0, 32);
  const catalog = await loadGlobalCatalog();
  await db.runTransaction(async tx => {
    const [request, audit] = await Promise.all([tx.get(requestRef), tx.get(platformAuditRef(eventId))]);
    if (audit.exists) return;
    const requestData = request.data();
    if (!request.exists || requestData.status !== 'pending') {
      throw new HttpsError('failed-precondition', 'Richiesta non trovata o già risolta');
    }
    if (input.action === 'reject') {
      tx.update(requestRef, {
        status: 'rejected', resolution: { action: 'reject' }, resolutionNote: input.reason,
        resolvedAt: FieldValue.serverTimestamp(), resolvedBy: uid, updatedAt: FieldValue.serverTimestamp()
      });
      tx.create(platformAuditRef(eventId), {
        schemaVersion: 1, eventId, type: 'catalogRequest.rejected', actor: { uid: actor.uid, role: actor.role },
        subject: { type: 'catalogRequest', id: input.requestId }, idempotencyKey: input.idempotencyKey,
        occurredAt: FieldValue.serverTimestamp(), metadata: { requestId: input.requestId, reason: input.reason }
      });
      return;
    }
    const ingredient = input.ingredient;
    const existing = catalog.ingredients.find(item => item.ingredientId === ingredient.ingredientId);
    if (existing && input.action === 'accept') {
      throw new HttpsError('failed-precondition', `L'ingrediente "${ingredient.ingredientId}" esiste già in catalogo: usa «modifica» o scegli un altro ID`);
    }
    const family = catalog.families.find(item => item.familyId === ingredient.familyId);
    if (!family) throw new HttpsError('failed-precondition', `Famiglia "${ingredient.familyId}" inesistente in catalogo`);
    if (family.categoryId !== ingredient.categoryId) {
      throw new HttpsError('failed-precondition', `La categoria "${ingredient.categoryId}" non coincide con quella della famiglia ${family.familyId}`);
    }
    const normalizedIngredient = {
      ingredientId: ingredient.ingredientId,
      displayName: ingredient.displayName,
      normalizedName: normalizeIngredient(ingredient.displayName),
      categoryId: ingredient.categoryId,
      familyId: ingredient.familyId,
      aliases: ingredient.aliases,
      searchTokens: searchTokensFor(ingredient.displayName, ingredient.aliases),
      dietaryFlags: ingredient.dietaryFlags,
      status: 'active'
    };
    const nextVersion = catalog.catalogVersion + 1;
    const merged = new Map(catalog.ingredients.map(item => [item.ingredientId, item]));
    merged.set(normalizedIngredient.ingredientId, normalizedIngredient);
    const newChecksum = catalogContentChecksum([...merged.values()], catalog.categories, catalog.families, nextVersion);
    tx.set(db.doc(`globalIngredientCatalog/current/ingredients/${normalizedIngredient.ingredientId}`), {
      schemaVersion: 3, ...normalizedIngredient, catalogVersion: nextVersion, updatedAt: FieldValue.serverTimestamp()
    });
    tx.set(db.doc('globalIngredientCatalog/versions/snapshots/' + catalog.catalogVersion), {
      schemaVersion: 3, catalogVersion: catalog.catalogVersion, checksum: catalog.checksum,
      ingredients: catalog.ingredients, categories: catalog.categories, families: catalog.families,
      supersededBy: nextVersion, createdAt: FieldValue.serverTimestamp(), createdBy: uid
    });
    tx.set(db.doc('globalIngredientCatalog/current/meta/summary'), {
      schemaVersion: 3, catalogVersion: nextVersion, checksum: newChecksum,
      ingredientCount: merged.size, categoryCount: catalog.categories.length, familyCount: catalog.families.length,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
    });
    tx.update(requestRef, {
      status: 'accepted', resolution: { action: input.action, ingredient: normalizedIngredient },
      resolutionNote: input.reason || '', resolvedIngredientId: normalizedIngredient.ingredientId,
      resolvedAt: FieldValue.serverTimestamp(), resolvedBy: uid, updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(platformAuditRef(eventId), {
      schemaVersion: 1, eventId, type: 'catalogRequest.accepted', actor: { uid: actor.uid, role: actor.role },
      subject: { type: 'catalogRequest', id: input.requestId }, idempotencyKey: input.idempotencyKey,
      occurredAt: FieldValue.serverTimestamp(),
      metadata: { requestId: input.requestId, ingredientId: normalizedIngredient.ingredientId, catalogVersion: nextVersion }
    });
  });
  return { requestId: input.requestId, status: input.action === 'reject' ? 'rejected' : 'accepted' };
});

// Cliente: elenco delle proprie richieste (per lo stato nel pannello).
exports.listMyCatalogRequests = callable(async (_data, uid) => {
  const link = await db.doc(`accountClientLinks/${uid}`).get();
  if (!link.exists || link.data()?.status !== 'active') return { requests: [] };
  const { organizationId, clientId } = link.data();
  if (organizationId !== SINGLE_ORGANIZATION_ID) return { requests: [] };
  const snapshot = await db.collection(`organizations/${organizationId}/catalogRequests`)
    .where('clientId', '==', clientId).orderBy('createdAt', 'desc').limit(20).get();
  return { requests: snapshot.docs.map(doc => publicCatalogRequestRow(doc)) };
});
