'use strict';

const adminState = { user: null, catalogRequests: [], clients: [], clientInvitations: [], clientRequests: [], clientEmailChanges: [], clientFilter: 'all', clientSearchQuery: '', detailClientId: null, detailHistory: null, clientDetailReturnFocus: null, structures: [], compareSelection: new Set(), users: null, editingStructure: null, dietPlan: null, dietPlanEditingId: null, selectedRequestId: null, assignableStructures: [], dietPlanRestoredFrom: null, catalogPreview: null, isCreator: false, professionalRecipes: [], recipeFilter: 'all', editingRecipe: null, professionalShares: [], templates: [], editingTemplateId: null };
let catalogIndexCache = null;
let catalogCategoriesCache = [];
let catalogTruncated = false;
const $ = id => document.getElementById(id);
const SINGLE_ORG_ID = (typeof window !== 'undefined' && (window.PIANO_SINGLE_ORG_ID || window.PIANO_SAAS_CONFIG?.singleOrganizationId)) || 'pianoNutrizionale';
const escapeAdmin = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
const orgId = () => SINGLE_ORG_ID;
// Organizzazione singola: l'ID arriva da js/saas-config.js. Se manca, la
// pagina non è stata caricata correttamente e nessuna callable può rispondere.
const ORG_MISSING_MESSAGE = 'Organizzazione non configurata: ricarica la pagina.';
const isoFromLocal = value => value ? new Date(value).toISOString() : null;
const idem = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

function adminError(error) {
  const code = String(error?.code || '').replace('functions/', '');
  if (code === 'permission-denied') return 'Non hai i permessi per questa operazione.';
  if (code === 'failed-precondition') return error.message || 'Controlla versione e checksum.';
  if (code === 'resource-exhausted') return 'Troppe richieste. Attendi qualche minuto.';
  if (code === 'not-found' || code === 'unimplemented') return 'Backend della console non aggiornato: ripubblicare le Cloud Functions.';
  return error?.message || 'Operazione non riuscita. Riprova.';
}

// ---- Richieste catalogo (cliente → admin) ----
// Quando il riconoscimento di un ingrediente restituisce «unknown», il cliente
// propone categoria e famiglia globale; qui l'amministratore decide. La coda
// è visibile SOLO al platform admin (come l'import del catalogo).

const CATALOG_REQUEST_STATUS_LABELS = {
  pending: 'In sospeso', accepted: 'Accettata', rejected: 'Rifiutata', superseded: 'Sostituita'
};

async function loadCatalogRequests() {
  if (!orgId()) { $('requests-feedback').textContent = ORG_MISSING_MESSAGE; return; }
  if (!adminState.isCreator) {
    $('requests-feedback').textContent = 'Solo il platform admin può gestire le richieste catalogo.';
    $('requests-list').innerHTML = '';
    return;
  }
  $('requests-feedback').textContent = 'Aggiornamento delle richieste…';
  try {
    // Scarica sempre l'intera coda (max 100): metriche e badge della
    // navigazione devono contare tutte le richieste, il filtro della vista
    // agisce solo sulla lista mostrata.
    const result = await callAdminSaasFunction('listCatalogRequests', {});
    adminState.catalogRequests = result.requests || [];
    renderCatalogRequests();
  } catch (error) {
    $('requests-feedback').textContent = adminError(error);
    adminState.catalogRequests = [];
    renderCatalogRequests();
  }
}

function renderCatalogRequests() {
  const list = $('requests-list');
  if (!list) return;
  const statusFilter = $('request-status')?.value || '';
  const all = adminState.catalogRequests || [];
  const requests = statusFilter ? all.filter(item => item.status === statusFilter) : all;
  const counts = { pending: 0, accepted: 0, rejected: 0 };
  all.forEach(item => { if (counts[item.status] != null) counts[item.status] += 1; });
  const metricPending = $('metric-pending');
  const metricAccepted = $('metric-accepted');
  const metricRejected = $('metric-rejected');
  if (metricPending) metricPending.textContent = String(counts.pending);
  if (metricAccepted) metricAccepted.textContent = String(counts.accepted);
  if (metricRejected) metricRejected.textContent = String(counts.rejected);
  const badge = $('nav-open-count');
  if (badge) {
    badge.textContent = String(counts.pending);
    badge.classList.toggle('badge-zero', counts.pending === 0);
  }
  const familyLabel = familyId => {
    const family = catalogIndexCache?.familiesById?.get(familyId);
    return family?.displayName || familyId || '—';
  };
  $('requests-feedback').textContent = requests.length ? '' : 'Nessuna richiesta in questa vista.';
  list.innerHTML = requests.map(item => `
    <article class="report-row ${item.status !== 'pending' ? 'report-resolved' : ''}">
      <div>
        <strong>${escapeAdmin(item.ingredientText)}</strong>
        <small>Proposta: ${escapeAdmin(familyLabel(item.proposedFamilyId))}${item.clientTitle ? ` · cliente ${escapeAdmin(item.clientTitle)}` : ''} · ${formatDateOnly(item.createdAt)}</small>
      </div>
      <span class="status ${item.status === 'pending' ? 'status-open' : item.status === 'accepted' ? 'status-resolved' : 'status-history'}">${escapeAdmin(CATALOG_REQUEST_STATUS_LABELS[item.status] || item.status)}</span>
      ${item.status === 'pending'
        ? `<button class="secondary" data-open-request="${escapeAdmin(item.requestId)}">Valuta →</button>`
        : `<small>${escapeAdmin(item.resolutionNote || CATALOG_REQUEST_STATUS_LABELS[item.status] || '')}</small>`}
    </article>`).join('') || '<p class="feedback">Nessuna richiesta catalogo.</p>';
}

function catalogRequestById(requestId) {
  return (adminState.catalogRequests || []).find(item => item.requestId === requestId) || null;
}

function fillCatalogRequestSelects() {
  const domain = window.PianoDomain;
  const categories = [...(catalogIndexCache?.categoriesById?.values() || [])]
    .sort((a, b) => String(a.displayName || a.categoryId).localeCompare(String(b.displayName || b.categoryId), 'it'));
  const categorySelect = $('request-category');
  if (categorySelect) {
    categorySelect.innerHTML = categories.map(item =>
      `<option value="${escapeAdmin(item.categoryId)}">${escapeAdmin(item.displayName || item.categoryId)}</option>`).join('');
  }
  renderRequestFamilyOptions(categorySelect?.value || '');
}

function renderRequestFamilyOptions(categoryId) {
  const families = [...(catalogIndexCache?.familiesById?.values() || [])]
    .filter(family => !categoryId || !family.categoryId || family.categoryId === categoryId)
    .sort((a, b) => String(a.displayName || a.familyId).localeCompare(String(b.displayName || b.familyId), 'it'));
  const familySelect = $('request-family');
  if (!familySelect) return;
  familySelect.innerHTML = families.map(family =>
    `<option value="${escapeAdmin(family.familyId)}">${escapeAdmin(family.displayName || family.familyId)}</option>`).join('');
}

async function openCatalogRequest(requestId) {
  const request = catalogRequestById(requestId);
  if (!request) return;
  adminState.selectedRequestId = requestId;
  try {
    await loadCatalogIndex();
  } catch (error) {
    $('requests-feedback').textContent = adminError(error);
    return;
  }
  fillCatalogRequestSelects();
  $('request-subtitle').textContent = `Proposta del cliente: categoria + famiglia (cliente ${request.clientTitle || 'sconosciuto'})`;
  $('request-display-name').value = String(request.ingredientText || '');
  $('request-ingredient-id').value = canonicalId(request.ingredientText || '');
  $('request-aliases').value = '';
  $('request-reason').value = '';
  // Preselezione dalla proposta del cliente.
  const categorySelect = $('request-category');
  if (categorySelect && request.proposedCategoryId) categorySelect.value = request.proposedCategoryId;
  renderRequestFamilyOptions(categorySelect?.value || request.proposedCategoryId || '');
  const familySelect = $('request-family');
  if (familySelect && request.proposedFamilyId) familySelect.value = request.proposedFamilyId;
  $('request-error').textContent = '';
  $('request-dialog').classList.remove('hidden');
}

function closeCatalogRequest() {
  $('request-dialog').classList.add('hidden');
  adminState.selectedRequestId = null;
}

async function submitCatalogRequestResolution(event) {
  event.preventDefault();
  const requestId = adminState.selectedRequestId;
  if (!requestId) return;
  const displayName = $('request-display-name').value.trim();
  const ingredientId = $('request-ingredient-id').value.trim();
  const categoryId = $('request-category').value;
  const familyId = $('request-family').value;
  const aliases = $('request-aliases').value.split('\n').map(line => line.trim()).filter(Boolean);
  const reason = $('request-reason').value.trim();
  if (!displayName || !ingredientId || !categoryId || !familyId) {
    $('request-error').textContent = 'Compila nome, ID, categoria e famiglia.';
    return;
  }
  try {
    await callAdminSaasFunction('resolveCatalogRequest', {
      requestId,
      action: 'accept',
      ingredient: {
        ingredientId,
        displayName,
        aliases,
        categoryId,
        familyId,
        vegetarian: $('request-vegetarian').checked,
        vegan: $('request-vegan').checked
      },
      reason: reason || undefined,
      idempotencyKey: idem(`request-accept-${requestId}`)
    });
    closeCatalogRequest();
    await loadCatalogRequests();
    $('requests-feedback').textContent = 'Ingrediente inserito nel catalogo globale ✅';
  } catch (error) {
    $('request-error').textContent = adminError(error);
  }
}

async function rejectCatalogRequest() {
  const requestId = adminState.selectedRequestId;
  if (!requestId) return;
  const reason = $('request-reason').value.trim();
  if (reason.length < 3) {
    $('request-error').textContent = 'Per rifiutare serve un motivo (minimo 3 caratteri).';
    return;
  }
  try {
    await callAdminSaasFunction('resolveCatalogRequest', {
      requestId,
      action: 'reject',
      reason,
      idempotencyKey: idem(`request-reject-${requestId}`)
    });
    closeCatalogRequest();
    await loadCatalogRequests();
    $('requests-feedback').textContent = 'Richiesta rifiutata.';
  } catch (error) {
    $('request-error').textContent = adminError(error);
  }
}

async function loadClients() {
  if (!orgId()) { $('clients-feedback').textContent = ORG_MISSING_MESSAGE; return; }
  $('clients-feedback').textContent = 'Caricamento profili autorizzati…';
  try {
    const result = await callAdminSaasFunction('listAuthorizedClients', { organizationId: orgId() });
    adminState.clients = result.clients || [];
    // Inviti email pendenti, richieste di collegamento e proposte di cambio
    // email dei soli clienti autorizzati: nessun dato di altri professionisti.
    adminState.clientInvitations = (result.invitations || []).filter(item => item.channel !== 'legacy-test');
    adminState.clientRequests = result.requests || [];
    adminState.clientEmailChanges = result.emailChanges || [];
    renderClients();
    $('clients-feedback').textContent = adminState.clients.length ? '' : 'Nessun cliente autorizzato.';
  } catch (error) { $('clients-feedback').textContent = adminError(error); adminState.clients = []; adminState.clientInvitations = []; adminState.clientRequests = []; adminState.clientEmailChanges = []; renderClients(); }
}

// Titolo del cliente: Nome e Cognome, mai UID o ID tecnici. Il fallback
// (email mascherata → displayCode) vive nel dominio condiviso.
function clientLabel(client) {
  const full = `${client?.firstName || ''} ${client?.lastName || ''}`.trim();
  if (full) return full;
  try {
    if (window.PianoDomain?.maskEmailClient) {
      const email = String(client?.email || client?.emailNormalized || '').trim();
      if (email) return window.PianoDomain.maskEmailClient(email);
    }
  } catch (_) {}
  // Mai UID, displayCode o altri identificativi come fallback visivo: se il
  // profilo è incompleto, il professionista legge semplicemente «Cliente».
  return 'Cliente';
}

function clientStatusOf(client) {
  try {
    if (window.PianoDomain?.clientOperationalStatus) {
      return PianoDomain.clientOperationalStatus(client, {
        invitations: adminState.clientInvitations,
        requests: adminState.clientRequests
      });
    }
  } catch (_) { /* fallback locale */ }
  if (client?.status === 'pending') return 'pending';
  return client?.status === 'active' ? 'active' : 'inactive';
}

function clientStatusLabelOf(status) {
  try {
    if (window.PianoDomain?.clientStatusLabel) return PianoDomain.clientStatusLabel(status);
  } catch (_) { /* fallback locale */ }
  return ({ active: 'Attivo', inactive: 'Inattivo', pending: 'In attesa' })[status] || 'Sconosciuto';
}

function inviteForClient(clientId) {
  return adminState.clientInvitations.find(item => item.clientId === clientId) || null;
}

function requestForClient(clientId) {
  return adminState.clientRequests.find(item => item.clientId === clientId) || null;
}

function assignmentSummary(client) {
  const active = client.activeAssignment;
  if (!active) return 'Nessuna struttura assegnata';
  return active.structureName ? `Struttura ${active.structureName}` : 'Struttura assegnata';
}

function inviteStatusLabelOf(status) {
  if (status === 'pending') return 'In attesa';
  try {
    if (window.PianoDomain?.clientStatusLabel) return PianoDomain.clientStatusLabel(status);
  } catch (_) { /* fallback locale */ }
  return ({ expired: 'Scaduto', revoked: 'Annullato', rejected: 'Rifiutato', superseded: 'Sostituito', accepted: 'Accettato', consumed: 'Utilizzato' })[status] || String(status || '—');
}

function renderClients() {
  // Un invito email pendente per cliente: stati distinti (In attesa, Scaduto,
  // Annullato) e azioni di correzione, reinvio e annullamento.
  // Il link si consegna sempre a mano (Copia link / Condividi link): la chip
  // mostra solo lo stato dell'invito, senza stati di invio email.
  const inviteChip = invite => {
    if (!invite) return '';
    // Finché l'invito è pendente il link resta recuperabile: "Copia link" lo
    // richiede al server, che restituisce lo stesso link già emesso (nessuna
    // rigenerazione). Chiudere la finestra non lo fa più perdere.
    const copyButton = invite.status === 'pending'
      ? `<button class="text-button" data-invite-copy="${escapeAdmin(invite.inviteId)}">Copia link</button>`
      : '';
    return `<p><small>Invito · ${escapeAdmin(inviteStatusLabelOf(invite.status))} · link da consegnare a mano</small></p>
      <div class="card-actions">
        ${copyButton}
        <button class="text-button" data-invite-resend="${escapeAdmin(invite.inviteId)}">Nuovo link</button>
        <button class="text-button" data-invite-fix="${escapeAdmin(invite.inviteId)}">Correggi dati</button>
        <button class="text-button danger-text" data-invite-cancel="${escapeAdmin(invite.inviteId)}">Annulla invito</button>
      </div>`;
  };
  const emailChip = client => client.email
    ? `<p><small>${escapeAdmin(client.email)} · ${client.emailVerified ? 'email verificata' : 'email da verificare'}</small></p>`
    : '';
  // Filtri di stato con conteggi: Tutti, Attivi, In attesa, Inattivi.
  const withStatus = adminState.clients.map(client => ({ client, status: clientStatusOf(client) }));
  const counts = { all: withStatus.length, active: 0, pending: 0, inactive: 0 };
  withStatus.forEach(({ status }) => { if (counts[status] != null) counts[status] += 1; });
  ['all', 'active', 'pending', 'inactive'].forEach(key => {
    const badge = $(`count-${key}`);
    if (badge) badge.textContent = counts[key];
  });
  document.querySelectorAll('[data-client-filter]').forEach(button => {
    const selected = button.dataset.clientFilter === adminState.clientFilter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
  const query = (adminState.clientSearchQuery || '').trim().toLowerCase();
  const visible = withStatus.filter(({ client, status }) => {
    if (adminState.clientFilter !== 'all' && status !== adminState.clientFilter) return false;
    if (!query) return true;
    const name = `${client.firstName || ''} ${client.lastName || ''}`.toLowerCase();
    const label = clientLabel(client).toLowerCase();
    const email = (client.email || client.emailNormalized || '').toLowerCase();
    const code = (client.displayCode || '').toLowerCase();
    return name.includes(query) || label.includes(query) || email.includes(query) || code.includes(query);
  });
  const emptyHints = {
    all: query ? `Nessun cliente corrisponde alla ricerca “${query}”.` : 'Nessun cliente autorizzato. Usa “Invita nuovo cliente” per iniziare.',
    active: query ? `Nessun cliente attivo corrisponde alla ricerca “${query}”.` : 'Nessun cliente attivo in questo momento.',
    pending: query ? `Nessun cliente in attesa corrisponde alla ricerca “${query}”.` : 'Nessun cliente in attesa: inviti e richieste sono tutti risolti.',
    inactive: query ? `Nessun cliente inattivo corrisponde alla ricerca “${query}”.` : 'Nessun cliente inattivo.'
  };
  $('clients-list').innerHTML = visible.map(({ client, status }) => {
    const invite = inviteForClient(client.id);
    const request = requestForClient(client.id);
    const emailChange = adminState.clientEmailChanges.find(item => item.clientId === client.id) || null;
    // La scheda mostra tutto il resto (anagrafica, collegamento, struttura,
    // storico, rimozione): dalla card si apre la scheda o si assegna il profilo.
    return `<article class="client-card"><p class="eyebrow">CLIENTE</p><h3>${escapeAdmin(clientLabel(client))}</h3><p><span class="status status-client-${escapeAdmin(status)}">${escapeAdmin(clientStatusLabelOf(status))}</span></p>${emailChip(client)}<p>${escapeAdmin(assignmentSummary(client))}</p><p><small>Aggiornato il ${escapeAdmin(formatDateOnly(client.updatedAt))}</small></p>${request ? '<p><small>Richiesta di collegamento · in attesa del cliente</small></p>' : ''}${emailChange ? `<p><small>Cambio email proposto: ${escapeAdmin(emailChange.newEmail || '—')} · in attesa del cliente</small></p>` : ''}${inviteChip(invite)}<div class="card-actions"><button class="secondary" data-client-detail="${escapeAdmin(client.id)}">Apri scheda →</button><button class="secondary" data-assign-client="${escapeAdmin(client.id)}">${client.activeAssignment ? 'Cambia struttura' : 'Assegna struttura'}</button></div></article>`;
  }).join('') || `<p class="feedback">${escapeAdmin(emptyHints[adminState.clientFilter] || emptyHints.all)}</p>`;
  refreshOpenDetail();
}

// ---- Scheda cliente ----
// Un solo posto per nome, email, collegamento e struttura dieta.
// La rimozione («Rimuovi cliente», revoca logica con audit) esiste SOLO qui:
// nessuna azione distruttiva appare negli elenchi.
function detailClient() {
  return adminState.clients.find(item => item.id === adminState.detailClientId) || null;
}

function openClientDetail(clientId) {
  const client = adminState.clients.find(item => item.id === clientId);
  if (!client) return;
  adminState.detailClientId = clientId;
  adminState.detailHistory = null;
  adminState.clientDetailReturnFocus = document.activeElement;
  $('client-detail-feedback').textContent = '';
  $('client-detail-dialog').classList.remove('hidden');
  renderClientDetail();
  loadClientHistory(clientId);
  $('client-detail-dialog').querySelector('.dialog-close')?.focus();
}

function closeClientDetail() {
  $('client-detail-dialog').classList.add('hidden');
  adminState.detailClientId = null;
  adminState.detailHistory = null;
  if (adminState.clientDetailReturnFocus?.focus) adminState.clientDetailReturnFocus.focus();
  adminState.clientDetailReturnFocus = null;
}

async function loadClientHistory(clientId) {
  try {
    const history = await callAdminSaasFunction('getClientHistory', { organizationId: orgId(), clientId });
    if (adminState.detailClientId !== clientId) return;
    adminState.detailHistory = history;
    renderClientDetail();
  } catch (error) {
    if (adminState.detailClientId !== clientId) return;
    $('client-detail-feedback').textContent = `Storico non disponibile: ${adminError(error)}`;
  }
}

function historyRowHtml(kind, item) {
  const label = kind === 'invite' ? 'Invito' : 'Richiesta di collegamento';
  const who = item.targetEmail || 'Cliente';
  return `<div class="history-row"><div><strong>${escapeAdmin(label)}</strong><small>${escapeAdmin(who)}${item.createdAt ? ` · ${escapeAdmin(formatDateOnly(item.createdAt))}` : ''}</small></div><span class="status status-history">${escapeAdmin(inviteStatusLabelOf(item.status))}</span></div>`;
}

function renderClientDetail() {
  const client = detailClient();
  if (!client) return;
  const status = clientStatusOf(client);
  const email = String(client.email || '').trim();
  $('client-detail-title').textContent = clientLabel(client);
  $('client-detail-email').textContent = email
    ? `${email}${client.emailVerified ? ' · email verificata' : ' · email da verificare'}`
    : 'Email non disponibile';
  $('client-detail-subtitle').textContent = `${clientStatusLabelOf(status)} · aggiornato il ${formatDateOnly(client.updatedAt)}`;
  const invite = inviteForClient(client.id);
  const request = requestForClient(client.id);
  const emailChange = adminState.clientEmailChanges.find(item => item.clientId === client.id) || null;
  const history = adminState.detailHistory;
  const historyHtml = !history
    ? '<p class="feedback">Caricamento attività…</p>'
    : ([...(history.invitations || []).map(item => historyRowHtml('invite', item)), ...(history.requests || []).map(item => historyRowHtml('request', item))].join('')
      || '<p class="feedback">Nessuna attività precedente.</p>');
  // La scheda è volutamente operativa: nome ed email sono già nell'intestazione;
  // le informazioni interne restano disponibili soltanto all'admin, mai come
  // campi che il nutrizionista debba interpretare.
  const adminIdentifier = adminState.isCreator
    ? `<p class="detail-admin-meta"><span>Identificativo amministrativo</span><code>${escapeAdmin(client.id)}</code></p>`
    : '';
  const isPendingOrInactive = status !== 'active' || !client.authUid;
  const adminDangerZone = adminState.isCreator
    ? `<section class="detail-section"><h3>Amministrazione</h3><div class="card-actions"><button class="text-button danger-text" data-delete-client-permanent="${escapeAdmin(client.id)}">Elimina definitivamente cliente</button></div></section>`
    : '';
  $('client-detail-body').innerHTML = `
    <section class="detail-section"><h3>Collegamento</h3>
      <dl class="detail-grid">
        <div><dt>Stato</dt><dd><span class="status status-client-${escapeAdmin(status)}">${escapeAdmin(clientStatusLabelOf(status))}</span></dd></div>
        ${invite ? `<div><dt>Invito</dt><dd>${escapeAdmin(inviteStatusLabelOf(invite.status))} · link da consegnare a mano${invite.expiresAt ? ` · scade ${escapeAdmin(formatDateOnly(invite.expiresAt))}` : ''}</dd></div>` : ''}
        ${request ? '<div><dt>Richiesta</dt><dd>In attesa di accettazione dal cliente.</dd></div>' : ''}
        ${!invite && !request ? '<div><dt>Inviti e richieste</dt><dd>Nessuna attività in corso.</dd></div>' : ''}
      </dl>
      <div class="card-actions">
        <button class="secondary" data-client-profile="${escapeAdmin(client.id)}">Modifica anagrafica</button>
        ${isPendingOrInactive ? `<button class="secondary" data-client-new-link="${escapeAdmin(client.id)}">Genera nuovo link</button>` : ''}
        ${email ? `<button class="text-button" data-client-email-change="${escapeAdmin(client.id)}">Proponi cambio email</button>` : ''}
      </div>
      ${invite ? `<div class="card-actions">
        ${invite.status === 'pending' ? `<button class="text-button" data-invite-copy="${escapeAdmin(invite.inviteId)}">Copia link</button>` : ''}
        <button class="text-button" data-invite-resend="${escapeAdmin(invite.inviteId)}">Nuovo link</button>
        <button class="text-button" data-invite-fix="${escapeAdmin(invite.inviteId)}">Correggi dati invito</button>
        <button class="text-button danger-text" data-invite-cancel="${escapeAdmin(invite.inviteId)}">Annulla invito</button>
      </div>` : ''}
      ${emailChange ? `<p class="callout">Cambio email proposto: ${escapeAdmin(emailChange.newEmail || '—')} · in attesa di conferma del cliente.</p>` : ''}
    </section>
    <section class="detail-section"><h3>Struttura dieta</h3>
      <dl class="detail-grid"><div><dt>Assegnazione</dt><dd>${escapeAdmin(assignmentSummary(client))}</dd></div></dl>
      <div class="card-actions">
        <button class="secondary" data-assign-client="${escapeAdmin(client.id)}">${client.activeAssignment ? 'Cambia struttura' : 'Assegna struttura'}</button>

      </div>
    </section>
    <section class="detail-section"><h3>Attività collegamento</h3>${historyHtml}</section>
    ${adminIdentifier}
    ${adminDangerZone}`;
}

// Dopo ogni ricarico dei clienti, la scheda aperta (se c'è) si aggiorna.
function refreshOpenDetail() {
  if (!adminState.detailClientId) return;
  if (!detailClient()) { closeClientDetail(); return; }
  renderClientDetail();
  loadClientHistory(adminState.detailClientId);
}

// Azioni cliente condivise da card, scheda e pannello richieste: dettaglio,
// assegnazione, anagrafica, cambio email, inviti e salto alle dosi.
function handleClientActions(event) {
  const detail = event.target.closest('[data-client-detail]');
  if (detail) { openClientDetail(detail.dataset.clientDetail); return; }
  const assign = event.target.closest('[data-assign-client]');
  if (assign) { openAssignment(assign.dataset.assignClient); return; }
  const profile = event.target.closest('[data-client-profile]');
  if (profile) { openClientProfile(profile.dataset.clientProfile); return; }
  const newLink = event.target.closest('[data-client-new-link]');
  if (newLink) { generateClientNewLink(newLink.dataset.clientNewLink); return; }
  const deletePerm = event.target.closest('[data-delete-client-permanent]');
  if (deletePerm) { openDeleteClientDialog(deletePerm.dataset.deleteClientPermanent); return; }
  const emailChange = event.target.closest('[data-client-email-change]');
  if (emailChange) { openEmailChange(emailChange.dataset.clientEmailChange); return; }
  const copy = event.target.closest('[data-invite-copy]');
  if (copy) { getExistingInviteLink(copy.dataset.inviteCopy, inviteFeedbackIdFor(event)); return; }
  const resend = event.target.closest('[data-invite-resend]');
  if (resend) { resendClientInvite(resend.dataset.inviteResend); return; }
  const fix = event.target.closest('[data-invite-fix]');
  if (fix) { openInviteFix(fix.dataset.inviteFix); return; }
  const cancel = event.target.closest('[data-invite-cancel]');
  if (cancel) cancelClientInvite(cancel.dataset.inviteCancel);
}

// Strutture attive assegnabili a un cliente (dialog assegnazione).
async function loadStructuresList() {
  if (!orgId()) { adminState.assignableStructures = []; return; }
  try {
    const result = await callAdminSaasFunction('listDietStructures', { organizationId: orgId() });
    // Solo strutture attive assegnabili; le archiviate restano consultabili
    // nella sezione Strutture ma non si possono assegnare.
    adminState.assignableStructures = (result.structures || []).filter(item => item.status !== 'archived');
  } catch (error) { adminState.assignableStructures = []; $('assignment-error').textContent = adminError(error); }
  renderStructureOptions();
}

function renderStructureOptions() {
  const format = iso => iso ? new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  const mine = adminState.user?.uid || null;
  $('assignment-structure-list').innerHTML = adminState.assignableStructures
    .map(item => {
      const summary = item.summary || {};
      const summaryBits = [
        Number(summary.dayCount ?? 0) ? `${summary.dayCount} giornate` : null,
        Number(summary.optionCount ?? 0) ? `${summary.optionCount} opzioni` : null
      ].filter(Boolean).join(' · ');
      const other = mine && item.ownerUid && item.ownerUid !== mine ? ' · di un altro professionista' : '';
      return `<option value="${escapeAdmin(item.name)}" data-id="${escapeAdmin(item.id)}">${summaryBits || 'piano da comporre'}${item.updatedAt ? ` · ultima modifica ${format(item.updatedAt)}` : ''}${other}</option>`;
    })
    .join('');
}

async function openAssignment(clientId) {
  const client = adminState.clients.find(item => item.id === clientId); if (!client) return;
  $('assignment-client-id').value = client.id; $('assignment-client').textContent = clientLabel(client);
  const inOneHour = new Date(Date.now() + 3600000); inOneHour.setMinutes(0, 0, 0);
  $('assignment-effective').value = inOneHour.toISOString().slice(0, 16);
  $('assignment-structure').value = ''; $('assignment-expires').value = '';
  $('assignment-no-expiry').checked = false; $('assignment-expires').disabled = false;
  $('assignment-notes').value = '';
  $('assignment-error').textContent = ''; $('assignment-dialog').classList.remove('hidden');
  await loadStructuresList();
  $('assignment-structure').focus();
}
function closeAssignment() { $('assignment-dialog').classList.add('hidden'); }

async function submitAssignment(event) {
  event.preventDefault(); $('assignment-error').textContent = '';
  const withoutExpiration = $('assignment-no-expiry').checked;
  const expiresRaw = $('assignment-expires').value;
  if (!withoutExpiration && !expiresRaw) { $('assignment-error').textContent = 'Indica una scadenza oppure seleziona "Senza scadenza".'; return; }
  const structureName = $('assignment-structure').value.trim();
  const candidates = adminState.assignableStructures.filter(item => item.name === structureName);
  const chosen = adminState.assignableStructures.find(item => item.id === structureName)
    || (candidates.length === 1 ? candidates[0] : null);
  if (!chosen) {
    $('assignment-error').textContent = candidates.length > 1
      ? 'Esistono più strutture con questo nome: rinominane una dalla sezione Strutture dieta.'
      : 'Scegli una struttura dieta dall’elenco.';
    return;
  }
  try {
    const result = await callAdminSaasFunction('assignClientStructure', {
      organizationId: orgId(), clientId: $('assignment-client-id').value,
      structureId: chosen.id,
      effectiveAt: isoFromLocal($('assignment-effective').value),
      expiresAt: withoutExpiration ? null : isoFromLocal(expiresRaw),
      withoutExpiration,
      notes: $('assignment-notes').value.trim(),
      idempotencyKey: idem('assignment')
    });
    closeAssignment(); await loadClients();
    $('clients-feedback').textContent = result.status === 'scheduled' ? 'Assegnazione programmata. Il cliente dovrà confermare l’aggiornamento dall’app.' : 'Struttura assegnata. Il cliente dovrà confermare l’aggiornamento dall’app.';
  } catch (error) { $('assignment-error').textContent = adminError(error); }
}

// ---- Sezione Ricettario professionisti (ADR 0003) ----
// Bozze private del professionista, condivisioni di studio (solo creatore)
// e invii tracciati ai clienti. Tutte le scritture passano dalle callable;
// le archiviate non sono più modificabili né inviabili (senza ripristino).

const RECIPE_SLOT_LABELS = { breakfast: 'Colazione', snack1: 'Spuntino mattina', lunch: 'Pranzo', snack2: 'Merenda', dinner: 'Cena' };
const recipeSlotLabel = slot => RECIPE_SLOT_LABELS[slot] || slot;

async function loadProfessionalRecipes({ quiet = false } = {}) {
  if (!orgId()) { if (!quiet) $('recipes-feedback').textContent = ORG_MISSING_MESSAGE; return; }
  if (!quiet) $('recipes-feedback').textContent = 'Caricamento ricette…';
  try {
    const result = await callAdminSaasFunction('listProfessionalRecipes', { organizationId: orgId(), includeArchived: true });
    adminState.professionalRecipes = result.recipes || [];
    if (!quiet) {
      renderProfessionalRecipes();
      $('recipes-feedback').textContent = adminState.professionalRecipes.length ? '' : 'Nessuna ricetta: creane una.';
    }
  } catch (error) {
    if (quiet) throw error;
    $('recipes-feedback').textContent = adminError(error);
    adminState.professionalRecipes = [];
    renderProfessionalRecipes();
  }
}

function renderProfessionalRecipes() {
  const mine = adminState.user?.uid || null;
  const items = adminState.professionalRecipes.filter(item => {
    if (adminState.recipeFilter === 'mine') return item.ownerUid === mine && item.status !== 'archived';
    if (adminState.recipeFilter === 'studio') return item.visibility === 'studio' && item.status !== 'archived';
    if (adminState.recipeFilter === 'archived') return item.status === 'archived';
    return item.status !== 'archived';
  });
  document.querySelectorAll('[data-recipe-filter]').forEach(tab => tab.classList.toggle('active', tab.dataset.recipeFilter === adminState.recipeFilter));
  $('recipes-list').innerHTML = items.map(item => {
    const isOwner = mine && item.ownerUid === mine;
    const archived = item.status === 'archived';
    const other = mine && item.ownerUid && item.ownerUid !== mine ? ' · di un altro professionista' : '';
    const visibilityTag = item.visibility === 'studio' ? '<p><span class="status status-resolved">Studio</span></p>' : '';
    return `
    <article class="client-card ${archived ? 'structure-archived' : ''}">
      <p class="eyebrow">RICETTA${item.visibility === 'studio' ? ' · STUDIO' : ''}${archived ? ' · ARCHIVIATA' : ''}</p>
      <h3>${escapeAdmin(item.emoji || '🍲')} ${escapeAdmin(item.name)}</h3>
      ${visibilityTag}
      <p>${escapeAdmin(recipeSlotLabel(item.slot))} · ${(item.ingredients || []).length} ingredienti · rev. ${Number(item.revision || 1)}${other}</p>
      <p class="structure-dates"><small>Ultima modifica ${formatDateOnly(item.updatedAt)}</small></p>
      <div class="card-actions">
        <button class="secondary" data-edit-recipe="${escapeAdmin(item.id)}" ${!isOwner || archived ? 'disabled title="Solo il proprietario modifica"' : ''}>Modifica →</button>
        <button class="secondary" data-duplicate-recipe="${escapeAdmin(item.id)}" ${archived ? 'disabled' : ''}>Duplica</button>
        <button class="secondary" data-send-recipe="${escapeAdmin(item.id)}" ${archived ? 'disabled' : ''}>Invia…</button>
        ${adminState.isCreator && !archived ? `<button class="text-button" data-visibility-recipe="${escapeAdmin(item.id)}">${item.visibility === 'studio' ? 'Rendi privata' : 'Condividi'}</button>` : ''}
        ${isOwner && !archived ? `<button class="text-button archive-toggle" data-archive-recipe="${escapeAdmin(item.id)}">Archivia</button>` : ''}
      </div>
    </article>`;
  }).join('') || '<p class="feedback">Nessuna ricetta in questo filtro.</p>';
}

function handleRecipeActions(event) {
  const edit = event.target.closest('[data-edit-recipe]');
  if (edit && !edit.disabled) { openRecipeDialog(edit.dataset.editRecipe); return; }
  const duplicate = event.target.closest('[data-duplicate-recipe]');
  if (duplicate && !duplicate.disabled) { openRecipeDialog(null, duplicate.dataset.duplicateRecipe); return; }
  const send = event.target.closest('[data-send-recipe]');
  if (send && !send.disabled) { openRecipeSendDialog(send.dataset.sendRecipe); return; }
  const visibility = event.target.closest('[data-visibility-recipe]');
  if (visibility) { toggleRecipeVisibility(visibility.dataset.visibilityRecipe); return; }
  const archive = event.target.closest('[data-archive-recipe]');
  if (archive) archiveProfessionalRecipeUI(archive.dataset.archiveRecipe);
}

function recipeIngredientRow(ingredient = {}) {
  const quantity = ingredient.portions?.single ?? '';
  return `
  <div class="recipe-ingredient-row">
    <input class="ing-name" placeholder="Ingrediente (es. Riso)" value="${escapeAdmin(ingredient.name || '')}" aria-label="Ingrediente">
    <input class="ing-qty" placeholder="Quantità (es. 80 g)" value="${escapeAdmin(quantity)}" aria-label="Quantità">
    <button type="button" class="dialog-close ing-remove" aria-label="Rimuovi ingrediente">×</button>
  </div>`;
}

function addRecipeIngredientRow(ingredient = {}) {
  $('recipe-ingredients').insertAdjacentHTML('beforeend', recipeIngredientRow(ingredient));
}

async function openRecipeDialog(recipeId = null, duplicateFrom = null) {
  adminState.editingRecipe = null;
  $('recipe-id').value = ''; $('recipe-revision').value = ''; $('recipe-protein').value = '';
  $('recipe-name').value = ''; $('recipe-emoji').value = ''; $('recipe-slot').value = 'lunch';
  $('recipe-ingredients').innerHTML = ''; $('recipe-steps').value = ''; $('recipe-notes').value = '';
  $('recipe-error').textContent = '';
  const source = recipeId
    ? adminState.professionalRecipes.find(item => item.id === recipeId)
    : duplicateFrom ? adminState.professionalRecipes.find(item => item.id === duplicateFrom) : null;
  if ((recipeId || duplicateFrom) && !source) return;
  if (source) {
    $('recipe-name').value = recipeId ? (source.name || '') : `${source.name || ''} (copia)`;
    $('recipe-emoji').value = source.emoji || '';
    $('recipe-slot').value = source.slot || 'lunch';
    $('recipe-protein').value = source.proteinCategory || '';
    (source.ingredients?.length ? source.ingredients : [{}]).forEach(addRecipeIngredientRow);
    $('recipe-steps').value = (source.steps || []).join('\n');
    $('recipe-notes').value = (source.notes || []).join('\n');
  } else {
    addRecipeIngredientRow();
  }
  if (recipeId && source) {
    adminState.editingRecipe = { id: source.id, revision: source.revision };
    $('recipe-id').value = source.id;
    $('recipe-revision').value = String(source.revision ?? 1);
    $('recipe-title').textContent = 'Modifica ricetta';
    $('recipe-subtitle').textContent = `Revisione ${source.revision ?? 1}: il salvataggio ne crea una nuova. Visibilità e proprietario non cambiano.`;
  } else {
    $('recipe-title').textContent = duplicateFrom ? 'Duplica ricetta' : 'Nuova ricetta';
    $('recipe-subtitle').textContent = duplicateFrom
      ? 'Una copia privata con nuovo codice: la ricetta d’origine resta intatta.'
      : 'Nasce come bozza privata: solo tu la vedi finché il creatore non la condivide con lo studio.';
  }
  $('recipe-dialog').classList.remove('hidden');
  $('recipe-name').focus();
}

function closeRecipeDialog() { $('recipe-dialog').classList.add('hidden'); }

function collectRecipeForm() {
  const ingredients = [...document.querySelectorAll('#recipe-ingredients .recipe-ingredient-row')].map(row => ({
    name: row.querySelector('.ing-name').value.trim(),
    portions: {
      single: row.querySelector('.ing-qty').value.trim()
    }
  })).filter(item => item.name);
  const lines = value => String(value || '').split('\n').map(line => line.trim()).filter(Boolean);
  return {
    name: $('recipe-name').value.trim(),
    emoji: $('recipe-emoji').value.trim(),
    slot: $('recipe-slot').value,
    proteinCategory: $('recipe-protein').value || null,
    ingredients,
    steps: lines($('recipe-steps').value),
    notes: lines($('recipe-notes').value)
  };
}

async function submitRecipeForm(event) {
  event.preventDefault();
  $('recipe-error').textContent = '';
  const recipe = collectRecipeForm();
  if (!recipe.name) { $('recipe-error').textContent = 'Dai un nome alla ricetta.'; return; }
  if (!recipe.ingredients.length) { $('recipe-error').textContent = 'Aggiungi almeno un ingrediente.'; return; }
  const submit = $('recipe-submit');
  submit.disabled = true;
  try {
    const editingId = $('recipe-id').value;
    if (editingId) {
      const result = await callAdminSaasFunction('updateProfessionalRecipe', {
        organizationId: orgId(), recipeId: editingId, recipe,
        revision: Number($('recipe-revision').value) || 1, idempotencyKey: idem('recipe-update')
      });
      closeRecipeDialog();
      await loadProfessionalRecipes();
      $('recipes-feedback').textContent = `Ricetta salvata (revisione ${result.revision}).`;
    } else {
      await callAdminSaasFunction('createProfessionalRecipe', {
        organizationId: orgId(), recipe, idempotencyKey: idem('recipe-create')
      });
      closeRecipeDialog();
      await loadProfessionalRecipes();
      $('recipes-feedback').textContent = 'Ricetta creata come bozza privata.';
    }
  } catch (error) { $('recipe-error').textContent = adminError(error); }
  finally { submit.disabled = false; }
}

async function archiveProfessionalRecipeUI(recipeId) {
  if (!confirm('Archiviare questa ricetta? Non sarà più modificabile né inviabile e non si può ripristinare.')) return;
  try {
    await callAdminSaasFunction('archiveProfessionalRecipe', { organizationId: orgId(), recipeId, idempotencyKey: idem('recipe-archive') });
    await loadProfessionalRecipes();
    $('recipes-feedback').textContent = 'Ricetta archiviata.';
  } catch (error) { $('recipes-feedback').textContent = adminError(error); }
}

async function toggleRecipeVisibility(recipeId) {
  const item = adminState.professionalRecipes.find(entry => entry.id === recipeId);
  if (!item) return;
  const next = item.visibility === 'studio' ? 'private' : 'studio';
  const question = next === 'studio'
    ? `Condividere "${item.name}" con tutto lo studio? Tutti i professionisti potranno leggerla e inviarla.`
    : `Rendere privata "${item.name}"? Gli altri professionisti non la vedranno più.`;
  if (!confirm(question)) return;
  try {
    await callAdminSaasFunction('shareProfessionalRecipe', { organizationId: orgId(), recipeId, visibility: next, idempotencyKey: idem('recipe-share') });
    await loadProfessionalRecipes();
    $('recipes-feedback').textContent = next === 'studio' ? 'Ricetta condivisa con lo studio.' : 'Ricetta resa privata.';
  } catch (error) { $('recipes-feedback').textContent = adminError(error); }
}

async function openRecipeSendDialog(recipeId) {
  const item = adminState.professionalRecipes.find(entry => entry.id === recipeId);
  if (!item) return;
  $('recipe-send-id').value = recipeId;
  $('recipe-send-subtitle').textContent = `"${item.name}" · rev. ${item.revision ?? 1} → cliente`;
  $('recipe-send-error').textContent = '';
  const select = $('recipe-send-client');
  select.innerHTML = '<option value="">— Seleziona —</option>';
  try {
    const result = await callAdminSaasFunction('listAuthorizedClients', { organizationId: orgId() });
    adminState.clients = result.clients || [];
    select.innerHTML += adminState.clients.map(client => `<option value="${escapeAdmin(client.id)}">${escapeAdmin(clientLabel(client))}</option>`).join('');
  } catch (error) { $('recipe-send-error').textContent = adminError(error); }
  $('recipe-send-dialog').classList.remove('hidden');
}

function closeRecipeSendDialog() { $('recipe-send-dialog').classList.add('hidden'); }

async function submitRecipeSend(event) {
  event.preventDefault();
  $('recipe-send-error').textContent = '';
  const clientId = $('recipe-send-client').value;
  if (!clientId) { $('recipe-send-error').textContent = 'Seleziona un cliente.'; return; }
  const submit = $('recipe-send-submit');
  submit.disabled = true;
  try {
    await callAdminSaasFunction('sendProfessionalRecipe', {
      organizationId: orgId(), recipeIds: [$('recipe-send-id').value], clientId, idempotencyKey: idem('recipe-send')
    });
    closeRecipeSendDialog();
    await loadProfessionalShares();
    $('shares-feedback').textContent = 'Inviata: il cliente la troverà nella campanella.';
  } catch (error) { $('recipe-send-error').textContent = adminError(error); }
  finally { submit.disabled = false; }
}

async function loadProfessionalShares() {
  if (!orgId()) { $('shares-feedback').textContent = ORG_MISSING_MESSAGE; return; }
  $('shares-feedback').textContent = 'Caricamento invii…';
  try {
    const result = await callAdminSaasFunction('listProfessionalShares', { organizationId: orgId() });
    adminState.professionalShares = result.shares || [];
    renderProfessionalShares();
    $('shares-feedback').textContent = adminState.professionalShares.length ? '' : 'Nessun invio in attesa.';
  } catch (error) { $('shares-feedback').textContent = adminError(error); adminState.professionalShares = []; renderProfessionalShares(); }
}

function renderProfessionalShares() {
  $('shares-list').innerHTML = adminState.professionalShares.map(share => {
    const names = (share.recipes || []).map(entry => entry.name || entry.id).join(' · ') || '—';
    return `
    <article class="client-card">
      <p class="eyebrow">INVIO PROFESSIONALE</p>
      <h3>${escapeAdmin(names)}</h3>
      <p>→ ${escapeAdmin(share.recipientUsername || share.recipientUid || 'cliente')}</p>
      <p class="structure-dates"><small>Inviato ${formatDateOnly(share.createdAt)} · da ${escapeAdmin(share.senderUsername || 'studio')}</small></p>
      <div class="card-actions">
        <button class="text-button archive-toggle" data-cancel-share="${escapeAdmin(share.id)}">Annulla invio</button>
      </div>
    </article>`;
  }).join('') || '<p class="feedback">Nessun invio in attesa.</p>';
}

async function cancelProfessionalShareUI(shareId) {
  if (!confirm('Annullare questo invio? Il cliente non lo vedrà più.')) return;
  try {
    await callAdminSaasFunction('cancelProfessionalShare', { organizationId: orgId(), shareId, idempotencyKey: idem('recipe-cancel') });
    await loadProfessionalShares();
    $('shares-feedback').textContent = 'Invio annullato.';
  } catch (error) { $('shares-feedback').textContent = adminError(error); }
}

// ---- Sezione Dosi clienti ----
// Override personali sopra la struttura assegnata: celle vuote = studio.
// Ogni salvataggio crea una revisione; il cliente conferma dall'app.

const canonicalId = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function loadCatalogIndex() {
  if (catalogIndexCache) return catalogIndexCache;
  // Letture fatte con il Firestore della console (Auth nominata): l'identità
  // valutata dalle Security Rules è quella dell'account professionale.
  // Stesso tetto del server (functions/src/index.js, loadGlobalCatalog):
  // con un catalogo più grande l'elenco sarebbe incompleto, quindi lo diciamo.
  const ingredientLimit = 2000;
  const [ings, cats, fams] = await Promise.all([
    adminGetDocsQuery(adminQueryLimit(adminCollectionAt('globalIngredientCatalog/current/ingredients'), ingredientLimit)),
    adminGetDocsQuery(adminQueryLimit(adminCollectionAt('globalIngredientCatalog/current/categories'), 500)),
    adminGetDocsQuery(adminQueryLimit(adminCollectionAt('globalIngredientCatalog/current/families'), 500))
  ]);
  catalogTruncated = (ings?.size ?? ings?.docs?.length ?? 0) >= ingredientLimit;
  const ingredients = [];
  const categories = [];
  const families = [];
  snapForEach(ings, doc => ingredients.push({ ingredientId: doc.id, ...doc.data() }));
  snapForEach(cats, doc => categories.push({ categoryId: doc.id, ...doc.data() }));
  snapForEach(fams, doc => families.push({ familyId: doc.id, ...doc.data() }));
  catalogCategoriesCache = categories.filter(item => item.status !== 'archived');
  catalogIndexCache = window.PianoDomain?.buildCatalogIndex
    ? PianoDomain.buildCatalogIndex({ ingredients, categories, families })
    : { items: [], byId: new Map(), familiesById: new Map(), categoriesById: new Map() };
  return catalogIndexCache;
}

function catalogSearch(query, limit = 8) {
  if (!catalogIndexCache || !window.PianoDomain?.searchCatalog) return [];
  return PianoDomain.searchCatalog(catalogIndexCache, query, { limit });
}

async function loadStructures() {
  if (!orgId()) { $('structures-feedback').textContent = ORG_MISSING_MESSAGE; return; }
  $('structures-feedback').textContent = 'Caricamento strutture…';
  try {
    const result = await callAdminSaasFunction('listDietStructures', { organizationId: orgId() });
    adminState.structures = result.structures || [];
    renderStructures();
    $('structures-feedback').textContent = adminState.structures.length ? '' : 'Nessuna struttura dieta: creane una.';
  } catch (error) { $('structures-feedback').textContent = adminError(error); adminState.structures = []; renderStructures(); }
}

function formatDateOnly(iso) {
  return iso ? new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

function renderStructures() {
  $('structures-list').innerHTML = adminState.structures.map(item => {
    const summary = item.summary || {};
    const summaryBits = [
      `${Number(summary.dayCount ?? 0)} giornate`,
      `${Number(summary.optionCount ?? 0)} opzioni`,
      `${Number(summary.blockCount ?? 0)} blocchi`,
      Number(summary.recipeOptionCount ?? 0) ? `${summary.recipeOptionCount} ricette` : null,
      Number(summary.itemCount ?? 0) ? `${summary.itemCount} ingredienti` : null
    ].filter(Boolean);
    return `
    <article class="client-card ${item.status === 'archived' ? 'structure-archived' : ''}">
      <p class="eyebrow">STRUTTURA DIETA${item.status === 'archived' ? ' · ARCHIVIATA' : ''}</p>
      <h3>${escapeAdmin(item.name)}</h3>
      <p>${summaryBits.join(' · ') || 'Piano non ancora composto'}</p>
      <p class="structure-dates"><small>Creata il ${formatDateOnly(item.createdAt)} · ultima modifica ${formatDateOnly(item.updatedAt)}</small></p>
      <div class="card-actions">
        <button class="secondary" data-edit-structure="${escapeAdmin(item.id)}" ${item.status === 'archived' ? 'disabled' : ''}>Modifica →</button>
        <button class="text-button archive-toggle" data-archive-structure="${escapeAdmin(item.id)}" data-archived="${item.status === 'archived' ? '1' : '0'}">${item.status === 'archived' ? 'Riattiva' : 'Archivia'}</button>
        <label class="compare-check"><input type="checkbox" data-compare-structure="${escapeAdmin(item.id)}" ${adminState.compareSelection.has(item.id) ? 'checked' : ''} aria-label="Seleziona ${escapeAdmin(item.name)} per il confronto">Confronta</label>
      </div>
    </article>`;
  }).join('') || '<p class="feedback">Nessuna struttura registrata.</p>';
  renderCompareBar();
}

async function toggleStructureArchive(structureId, archived) {
  try {
    await callAdminSaasFunction('archiveDietStructure', {
      organizationId: orgId(), structureId, archived, idempotencyKey: idem(`structure-archive-${structureId}`)
    });
    await loadStructures();
    // La lista assegnabile dipende dallo stato: tienila coerente.
    loadStructuresList().catch(() => {});
  } catch (error) {
    $('structures-feedback').textContent = adminError(error);
  }
}

function renderCompareBar() {
  const count = adminState.compareSelection.size;
  const button = $('compare-structures');
  button.disabled = count < 2;
  button.textContent = `Confronta (${count})`;
  $('compare-hint').textContent = count < 2
    ? 'Seleziona almeno 2 strutture per confrontarle.'
    : `${count} strutture selezionate: apri il confronto di sola lettura.`;
}

// ---- Editor struttura dieta (modello a blocchi) ----
// La struttura è nome + piano dieta a blocchi (dietPlan v2). Il piano si
// compone nell'editor dedicato (dialog piano dieta); qui si gestiscono
// nome, nota revisione, ripristini e dettagli tecnici.

async function openStructureEditor(structureId) {
  await openDietPlanDialog(structureId);
}

function compareCellText(cell) {
  if (!cell?.present) return '—';
  if (cell.mealCount != null) return `${cell.mealCount} pasti`;
  if (cell.optionCount != null) {
    const types = (cell.optionTypes || []).join(', ');
    return `${cell.optionCount} opzion${cell.optionCount === 1 ? 'e' : 'i'}${types ? ` (${types})` : ''}`;
  }
  return 'presente';
}

function renderCompareMatrix(result) {
  const domain = dietPlanDomain();
  const structures = result.structures || [];
  const head = structures.map(item => {
    const summary = item.summary || {};
    return `<th scope="col">${escapeAdmin(item.name)}<small>${escapeAdmin(item.status === 'archived' ? 'archiviata' : `${summary.dayCount ?? 0} giornate · rev. ${item.currentRevisionId ?? '—'}`)}</small></th>`;
  }).join('');
  const dayRows = (result.rows || []).map(row => `
    <tr data-differs="${row.differs ? '1' : '0'}" class="${row.differs ? 'differs' : 'same'}">
      <th scope="row"><span class="diff-mark" aria-hidden="true">${row.differs ? '≠' : '='}</span> ${escapeAdmin(domain?.DIET_PLAN_DAY_TYPE_LABELS?.[row.dayType] || row.dayType)}<small class="diff-word">${row.differs ? 'diverso' : 'uguale'}</small></th>
      ${structures.map(item => `<td data-label="${escapeAdmin(item.name)}">${escapeAdmin(compareCellText(row.cells?.[item.id]))}</td>`).join('')}
    </tr>`).join('');
  const mealRows = (result.mealRows || []).map(row => `
    <tr data-differs="${row.differs ? '1' : '0'}" class="${row.differs ? 'differs' : 'same'}">
      <th scope="row"><span class="diff-mark" aria-hidden="true">${row.differs ? '≠' : '='}</span> ${escapeAdmin(domain?.dietPlanMealLabel?.(row.mealId) || row.mealId)}<small class="diff-word">${escapeAdmin(domain?.DIET_PLAN_DAY_TYPE_LABELS?.[row.dayType] || row.dayType)} · ${row.differs ? 'diverso' : 'uguale'}</small></th>
      ${structures.map(item => `<td data-label="${escapeAdmin(item.name)}">${escapeAdmin(compareCellText(row.cells?.[item.id]))}</td>`).join('')}
    </tr>`).join('');
  $('compare-matrix').innerHTML = `
    <p class="compare-legend"><span><b>≠ diverso</b></span><span><b>= uguale</b></span><span>Confronto per tipo di giornata e pasto, sulla revisione corrente.</span></p>
    <div class="compare-scroll"><table class="compare-table">
      <caption>Giornate per tipo (allenamento / riposo / altre)</caption>
      <thead><tr><th scope="col">Tipo giornata</th>${head}</tr></thead>
      <tbody>${dayRows || '<tr><td colspan="9">Nessuna giornata da confrontare.</td></tr>'}</tbody>
    </table></div>
    ${mealRows ? `<div class="compare-scroll"><table class="compare-table"><caption>Pasti e opzioni</caption><thead><tr><th scope="col">Pasto</th>${head}</tr></thead><tbody>${mealRows}</tbody></table></div>` : ''}`;
}

async function openCompare() {
  if (adminState.compareSelection.size < 2) return;
  $('compare-feedback').textContent = 'Calcolo il confronto…';
  $('compare-matrix').innerHTML = '';
  $('compare-dialog').classList.remove('hidden');
  try {
    const result = await callAdminSaasFunction('compareDietStructures', {
      organizationId: orgId(), structureIds: [...adminState.compareSelection]
    });
    $('compare-subtitle').textContent = `Sola lettura · confronto del ${new Date(result.comparedAt).toLocaleString('it-IT')}.`;
    renderCompareMatrix(result);
    $('compare-feedback').textContent = '';
  } catch (error) {
    $('compare-feedback').textContent = adminError(error);
  }
}

function closeCompare() { $('compare-dialog').classList.add('hidden'); }

// ---- Editor piano dieta (dietPlan schema 2) ----
// Giornate → pasti → opzioni. Ogni opzione è: blocchi con famiglia di
// riferimento (+ template equivalenze con snapshot non retroattivo e override),
// elenco ingredienti del catalogo globale, oppure una ricetta professionale
// con moltiplicatore. I dati restano sempre options: [...]; con una sola
// opzione la UI cliente non mostra etichette A/B/C.
function dietPlanDomain() { return window.PianoDomain || null; }

// Pasti attualmente espansi (chiave "giornata:pasto"): all'apertura ogni pasto
// parte minimizzato per mostrare subito la struttura della giornata.
const dietMealsExpanded = new Set();

function catalogFamilyLabel(familyId) {
  const family = catalogIndexCache?.familiesById?.get(familyId);
  return family?.displayName || familyId || '—';
}

function catalogIngredientName(ingredientId) {
  const entry = catalogIndexCache?.byId?.get(ingredientId);
  return entry?.ingredient?.displayName || ingredientId || '';
}

function familyOptionsHtml(selectedId) {
  const families = [...(catalogIndexCache?.familiesById?.values() || [])]
    .sort((a, b) => String(a.displayName || a.familyId).localeCompare(String(b.displayName || b.familyId), 'it'));
  return '<option value="">— Scegli famiglia —</option>' + families.map(family =>
    `<option value="${escapeAdmin(family.familyId)}" ${family.familyId === selectedId ? 'selected' : ''}>${escapeAdmin(family.displayName || family.familyId)}</option>`).join('');
}

function unitOptionsHtml(selectedUnit) {
  const units = dietPlanDomain()?.DIET_PLAN_UNITS || [];
  return units.map(unit =>
    `<option value="${escapeAdmin(unit.id)}" ${unit.id === (selectedUnit || 'g') ? 'selected' : ''}>${escapeAdmin(unit.label)}</option>`).join('');
}

function mealOptionsHtml() {
  const meals = dietPlanDomain()?.DIET_PLAN_MEALS || [];
  return meals.map(meal => `<option value="${escapeAdmin(meal.id)}">${escapeAdmin(meal.label)}</option>`).join('');
}

// Template pubblicati per la famiglia di riferimento del blocco: la quantità
// di riferimento e gli equivalenti entrano come snapshot nel blocco stesso.
function blockTemplateOptionsHtml(block) {
  const templates = (adminState.templates || []).filter(template =>
    template.status !== 'archived' && template.referenceFamilyId === block.referenceFamilyId);
  const snapshotRev = block.templateSnapshot?.revisionId;
  return `<option value="">Nessun template (solo famiglia)</option>` + templates.map(template =>
    `<option value="${escapeAdmin(template.id)}" ${template.id === block.templateId ? 'selected' : ''}>${escapeAdmin(template.name)}${snapshotRev && template.id === block.templateId && String(template.currentRevisionId) !== String(snapshotRev) ? ' (template aggiornato: ricarica per allinearlo)' : ''}</option>`).join('');
}

// Datalist condivisa: nomi del catalogo globale per input testuali.
function refreshDietCatalogDatalist() {
  const datalist = $('diet-catalog-options');
  if (!datalist) return;
  const items = (catalogIndexCache?.items || [])
    .slice()
    .sort((a, b) => String(a.ingredient?.displayName || '').localeCompare(String(b.ingredient?.displayName || ''), 'it'))
    .slice(0, 600);
  datalist.innerHTML = items.map(entry =>
    `<option value="${escapeAdmin(entry.ingredient.displayName)}"></option>`).join('');
}

// Riconosce il testo digitato nel catalogo: corrispondenza esatta per nome o
// alias (mai una scelta silenziosa tra omonimi).
function resolveIngredientTextInput(text) {
  const domain = dietPlanDomain();
  const key = domain?.aliasKey ? domain.aliasKey(text) : String(text || '').toLowerCase().trim();
  if (!key || !catalogIndexCache?.byAlias) return null;
  const entries = catalogIndexCache.byAlias.get(key) || [];
  return entries.length === 1 ? entries[0] : null;
}

function dietOptionSummary(option) {
  const domain = dietPlanDomain();
  if (!option) return '—';
  if (option.type === 'recipe') {
    const recipe = (adminState.professionalRecipes || []).find(item => item.id === option.recipeId);
    const multiplier = Number(option.recipeMultiplier ?? 1);
    return `Ricetta: ${recipe ? recipe.name : option.recipeId || '—'}${multiplier !== 1 ? ` ×${multiplier}` : ''}`;
  }
  if (option.type === 'ingredients') {
    const count = (option.items || []).length;
    const names = (option.items || []).slice(0, 3).map(item => catalogIngredientName(item.ingredientId)).filter(Boolean);
    return `${count} ingredient${count === 1 ? 'e' : 'i'}${names.length ? ` · ${names.join(', ')}` : ''}`;
  }
  const blocks = option.blocks || [];
  const names = blocks.map(block => {
    const qty = `${Number(block.referenceAmount?.value ?? 0)} ${dietPlanDomain()?.dietPlanUnitLabel?.(block.referenceAmount?.unit) || block.referenceAmount?.unit || ''}`.trim();
    const overrideCount = (block.overrides || []).length;
    return `${catalogFamilyLabel(block.referenceFamilyId)} ${qty}${block.templateId ? ' ⟳' : ''}${overrideCount ? ` (+${overrideCount})` : ''}`;
  });
  return blocks.length ? names.join(' · ') : 'Nessun blocco';
}

function renderDietPlanEditor() {
  const plan = adminState.dietPlan;
  const container = $('diet-plan-days');
  if (!plan || !container) return;
  const domain = dietPlanDomain();
  const dayTypes = domain?.DIET_PLAN_DAY_TYPES || ['training', 'rest', 'other'];
  container.innerHTML = (plan.days || []).map((day, dayIndex) => {
    const meals = day.meals || [];
    const availableMeals = (domain?.DIET_PLAN_MEALS || []).filter(meal => !meals.some(item => item.mealId === meal.id));
    return `
    <article class="diet-day" data-day-index="${dayIndex}">
      <div class="diet-day-head">
        <strong>Giornata ${dayIndex + 1}</strong>
        <select data-day-field="dayType" aria-label="Tipo giornata">
          ${dayTypes.map(type => `<option value="${escapeAdmin(type)}" ${day.dayType === type ? 'selected' : ''}>${escapeAdmin(domain?.DIET_PLAN_DAY_TYPE_LABELS?.[type] || type)}</option>`).join('')}
        </select>
        <input data-day-field="label" maxlength="80" placeholder="Etichetta (opzionale)" value="${escapeAdmin(day.label || '')}">
        <div class="diet-day-actions"><button type="button" class="text-button danger-text" data-remove-day="${dayIndex}">Elimina giornata</button></div>
      </div>
      <div class="diet-meals">
        ${meals.map((meal, mealIndex) => renderDietPlanMeal(dayIndex, mealIndex, meal)).join('')}
      </div>
      <div class="diet-meal-add">
        ${availableMeals.map(meal => `<button type="button" class="diet-add-chip" data-add-meal="${dayIndex}" data-meal-id="${escapeAdmin(meal.id)}">＋ ${escapeAdmin(meal.label)}</button>`).join('')}
      </div>
      <label>Integrazione<textarea data-day-field="supplements" maxlength="1000" placeholder="Integratori e schemi (testo libero)">${escapeAdmin(day.supplements || '')}</textarea></label>
      <label>Idratazione<input data-day-field="hydration" maxlength="500" placeholder="es. 2,5 L di acqua" value="${escapeAdmin(day.hydration || '')}"></label>
      <label>Nota giornata<textarea data-day-field="note" maxlength="1000" placeholder="Note visibili anche al cliente">${escapeAdmin(day.note || '')}</textarea></label>
    </article>`;
  }).join('');
  const addButton = $('diet-plan-add-day');
  if (addButton) addButton.disabled = (plan.days || []).length >= (domain?.DIET_PLAN_LIMITS?.days || 14);
}

function renderDietPlanMeal(dayIndex, mealIndex, meal) {
  const domain = dietPlanDomain();
  const meals = domain?.DIET_PLAN_MEALS || [];
  const mealMeta = meals.find(item => item.id === meal.mealId);
  const expandedKey = `${dayIndex}:${mealIndex}`;
  const expanded = dietMealsExpanded.has(expandedKey);
  const options = meal.options || [];
  const canAddOption = options.length < (domain?.DIET_PLAN_LIMITS?.optionsPerMeal || 4);
  return `
  <div class="diet-meal ${expanded ? 'expanded' : ''}" data-day-index="${dayIndex}" data-meal-index="${mealIndex}">
    <div class="diet-meal-head">
      <span class="diet-meal-name">${escapeAdmin(mealMeta?.label || meal.mealId)}</span>
      <span class="diet-meal-summary">${options.length === 0 ? 'Nessuna opzione' : options.length === 1 ? dietOptionSummary(options[0]) : `${options.length} opzioni: ${options.map(dietOptionSummary).join(' · ')}`}</span>
      <div class="diet-option-actions">
        <button type="button" class="secondary" data-toggle-meal="${expandedKey}">${expanded ? 'Chiudi' : 'Apri'}</button>
        <button type="button" class="text-button danger-text" data-remove-meal="${dayIndex}:${mealIndex}">Rimuovi</button>
      </div>
    </div>
    <div class="diet-meal-body">
      <div class="diet-options">
        ${options.map((option, optionIndex) => renderDietPlanOption(dayIndex, mealIndex, optionIndex, option)).join('')}
      </div>
      ${canAddOption ? `<button type="button" class="secondary diet-add" data-add-option="${dayIndex}:${mealIndex}">＋ Aggiungi opzione</button>` : ''}
      <label>Nota pasto<textarea data-meal-field="note" maxlength="1000" placeholder="Istruzioni per questo pasto (visibili anche al cliente)">${escapeAdmin(meal.note || '')}</textarea></label>
    </div>
  </div>`;
}

function renderDietPlanOption(dayIndex, mealIndex, optionIndex, option) {
  const domain = dietPlanDomain();
  const types = domain?.DIET_PLAN_OPTION_TYPES || [];
  const labels = domain?.DIET_PLAN_OPTION_LABELS || [];
  const optionCount = (adminState.dietPlan?.days?.[dayIndex]?.meals?.[mealIndex]?.options || []).length;
  const title = optionCount > 1 ? `Opzione ${labels[optionIndex] || optionIndex + 1}` : 'Opzione unica';
  const blocks = option.blocks || [];
  const items = option.items || [];
  return `
  <div class="diet-option ${option.type === 'recipe' ? 'is-recipe' : ''}" data-day-index="${dayIndex}" data-meal-index="${mealIndex}" data-option-index="${optionIndex}">
    <div class="diet-option-head">
      <strong>${escapeAdmin(title)}</strong>
      <div class="diet-option-actions">
        <div class="diet-type-toggle" role="group" aria-label="Tipo opzione">
          ${types.map(type => `<button type="button" class="diet-type-chip ${option.type === type.id ? 'active' : ''}" data-set-option-type="${dayIndex}:${mealIndex}:${optionIndex}:${type.id}" ${option.type === type.id ? 'disabled' : ''}>${escapeAdmin(type.label)}</button>`).join('')}
        </div>
        <button type="button" class="text-button danger-text" data-remove-option="${dayIndex}:${mealIndex}:${optionIndex}">✕</button>
      </div>
    </div>
    ${option.type === 'family-block' ? `
    <div class="diet-blocks">
      ${blocks.map((block, blockIndex) => renderDietPlanBlock(dayIndex, mealIndex, optionIndex, blockIndex, block)).join('')}
    </div>
    <button type="button" class="secondary diet-add" data-add-block="${dayIndex}:${mealIndex}:${optionIndex}">＋ Blocco famiglia</button>` : ''}
    ${option.type === 'ingredients' ? `
    <div class="diet-items">
      ${items.map((item, itemIndex) => `
      <div class="diet-item" data-item-index="${itemIndex}">
        <input list="diet-catalog-options" data-item-field="ingredient" maxlength="200" placeholder="Alimento (dal catalogo)" value="${escapeAdmin(item._displayName || catalogIngredientName(item.ingredientId))}" aria-label="Alimento">
        <div class="diet-qty"><input type="number" min="0" step="0.5" data-item-field="amountValue" value="${Number(item.amount?.value ?? 0)}" aria-label="Quantità"><select data-item-field="amountUnit" aria-label="Unità">${unitOptionsHtml(item.amount?.unit)}</select></div>
        <button type="button" class="text-button danger-text" data-remove-item="${dayIndex}:${mealIndex}:${optionIndex}:${itemIndex}">✕</button>
        ${item.ingredientId ? '' : '<small class="error diet-item-hint" style="grid-column:1/-1">Alimento non riconosciuto: scegline uno dal catalogo.</small>'}
      </div>`).join('')}
    </div>
    <button type="button" class="secondary diet-add" data-add-item="${dayIndex}:${mealIndex}:${optionIndex}">＋ Ingrediente</button>` : ''}
    ${option.type === 'recipe' ? `
    <div class="diet-recipe-fields">
      <label>Ricetta (ricettario professionale)<select data-option-field="recipeId" aria-label="Ricetta">
        <option value="">— Scegli ricetta —</option>
        ${(adminState.professionalRecipes || []).filter(recipe => recipe.status !== 'archived').map(recipe =>
          `<option value="${escapeAdmin(recipe.id)}" ${option.recipeId === recipe.id ? 'selected' : ''}>${escapeAdmin(recipe.name)}</option>`).join('')}
      </select></label>
      <label>Moltiplicatore dose<input type="number" min="0.1" max="10" step="0.1" data-option-field="recipeMultiplier" value="${Number(option.recipeMultiplier ?? 1)}"></label>
      <p class="diet-recipe-hint">Le dosi della ricetta sono mostrate al cliente moltiplicate: la ricetta originale non viene mai modificata.</p>
    </div>` : ''}
    <label>Nota opzione<textarea data-option-field="note" maxlength="1000" placeholder="Varianti, preparazione, suggerimenti">${escapeAdmin(option.note || '')}</textarea></label>
  </div>`;
}

function renderDietPlanBlock(dayIndex, mealIndex, optionIndex, blockIndex, block) {
  const domain = dietPlanDomain();
  const overrides = block.overrides || [];
  const snapshotHint = block.templateSnapshot
    ? `Snapshot rev. ${escapeAdmin(String(block.templateSnapshot.revisionId))}: ${escapeAdmin(String(block.templateSnapshot.equivalents?.length ?? 0))} equivalenti`
    : '';
  return `
  <div class="diet-block" data-block-index="${blockIndex}">
    <div class="diet-block-main">
      <label>Famiglia di riferimento<select data-block-field="referenceFamilyId">${familyOptionsHtml(block.referenceFamilyId)}</select></label>
      <label>Ingrediente di riferimento (opzionale)<input list="diet-catalog-options" data-block-field="referenceIngredient" maxlength="200" placeholder="es. Riso basmati" value="${escapeAdmin(block._referenceIngredientName || catalogIngredientName(block.referenceIngredientId))}"></label>
      <div class="diet-qty"><label>Quantità di riferimento<input type="number" min="0" step="0.5" data-block-field="referenceAmountValue" value="${Number(block.referenceAmount?.value ?? 0)}"><select data-block-field="referenceAmountUnit">${unitOptionsHtml(block.referenceAmount?.unit)}</select></label></div>
      <label>Template equivalenze<select data-block-field="templateId">${blockTemplateOptionsHtml(block)}</select>${snapshotHint ? `<small class="field-hint">${snapshotHint}</small>` : ''}</label>
      <button type="button" class="text-button danger-text" data-remove-block="${dayIndex}:${mealIndex}:${optionIndex}:${blockIndex}">✕ Rimuovi blocco</button>
    </div>
    ${overrides.length ? `
    <details class="diet-block-overrides">
      <summary>Override per questa struttura (${overrides.length})</summary>
      <div class="diet-block-override-rows">
        ${overrides.map((override, overrideIndex) => `
        <div class="diet-block-override" data-override-index="${overrideIndex}">
          <select data-override-field="familyId">${familyOptionsHtml(override.familyId)}</select>
          <input list="diet-catalog-options" data-override-field="ingredient" maxlength="200" placeholder="Ingrediente specifico (opzionale)" value="${escapeAdmin(override._ingredientName || catalogIngredientName(override.ingredientId))}">
          <input type="number" min="0" step="0.5" data-override-field="amountValue" value="${Number(override.amount?.value ?? 0)}" aria-label="Quantità override">
          <select data-override-field="amountUnit">${unitOptionsHtml(override.amount?.unit)}</select>
          <button type="button" class="text-button danger-text" data-remove-override="${dayIndex}:${mealIndex}:${optionIndex}:${blockIndex}:${overrideIndex}">✕</button>
        </div>`).join('')}
      </div>
    </details>` : ''}
    <button type="button" class="text-button" data-add-override="${dayIndex}:${mealIndex}:${optionIndex}:${blockIndex}">＋ Override quantità</button>
  </div>`;
}

// ---- Editor: mutazioni del modello + re-render mirato ----

function dietPlanDay(dayIndex) { return adminState.dietPlan?.days?.[dayIndex] || null; }
function dietPlanMealAt(dayIndex, mealIndex) { return dietPlanDay(dayIndex)?.meals?.[mealIndex] || null; }
function dietPlanOptionAt(dayIndex, mealIndex, optionIndex) { return dietPlanMealAt(dayIndex, mealIndex)?.options?.[optionIndex] || null; }

function addDietPlanDay() {
  const domain = dietPlanDomain();
  adminState.dietPlan.days.push(domain.createDietPlanDay('training'));
  renderDietPlanEditor();
}

function addDietPlanMeal(dayIndex, mealId) {
  const domain = dietPlanDomain();
  const day = dietPlanDay(dayIndex);
  if (!day || day.meals.length >= (domain?.DIET_PLAN_LIMITS?.mealsPerDay || 10)) return;
  day.meals.push(domain.createDietPlanMeal(mealId, {}));
  dietMealsExpanded.add(`${dayIndex}:${day.meals.length - 1}`);
  renderDietPlanEditor();
}

function addDietPlanOption(dayIndex, mealIndex) {
  const domain = dietPlanDomain();
  const meal = dietPlanMealAt(dayIndex, mealIndex);
  if (!meal || meal.options.length >= (domain?.DIET_PLAN_LIMITS?.optionsPerMeal || 4)) return;
  meal.options.push(domain.createDietPlanOption({ type: 'family-block', blocks: [] }));
  renderDietPlanEditor();
}

function addDietPlanBlock(dayIndex, mealIndex, optionIndex) {
  const domain = dietPlanDomain();
  const option = dietPlanOptionAt(dayIndex, mealIndex, optionIndex);
  if (!option || (option.blocks || []).length >= (domain?.DIET_PLAN_LIMITS?.blocksPerOption || 8)) return;
  option.blocks.push(domain.createDietPlanBlock({}));
  renderDietPlanEditor();
}

function addDietPlanItem(dayIndex, mealIndex, optionIndex) {
  const domain = dietPlanDomain();
  const option = dietPlanOptionAt(dayIndex, mealIndex, optionIndex);
  if (!option || (option.items || []).length >= (domain?.DIET_PLAN_LIMITS?.itemsPerOption || 20)) return;
  option.items.push(domain.createDietPlanItem({}));
  renderDietPlanEditor();
}

function addDietPlanOverride(dayIndex, mealIndex, optionIndex, blockIndex) {
  const block = dietPlanOptionAt(dayIndex, mealIndex, optionIndex)?.blocks?.[blockIndex];
  if (!block) return;
  block.overrides = block.overrides || [];
  block.overrides.push({ familyId: '', ingredientId: null, amount: { value: 0, unit: 'g' } });
  renderDietPlanEditor();
}

function setDietPlanOptionType(dayIndex, mealIndex, optionIndex, type) {
  const domain = dietPlanDomain();
  const option = dietPlanOptionAt(dayIndex, mealIndex, optionIndex);
  if (!option || option.type === type) return;
  const fresh = domain.createDietPlanOption({ type, note: option.note || '' });
  adminState.dietPlan.days[dayIndex].meals[mealIndex].options[optionIndex] = fresh;
  renderDietPlanEditor();
}

function removeDietPlanDay(dayIndex) {
  adminState.dietPlan.days.splice(dayIndex, 1);
  renderDietPlanEditor();
}

function removeDietPlanMeal(dayIndex, mealIndex) {
  dietPlanDay(dayIndex)?.meals?.splice(mealIndex, 1);
  renderDietPlanEditor();
}

function removeDietPlanOption(dayIndex, mealIndex, optionIndex) {
  dietPlanMealAt(dayIndex, mealIndex)?.options?.splice(optionIndex, 1);
  renderDietPlanEditor();
}

function removeDietPlanBlock(dayIndex, mealIndex, optionIndex, blockIndex) {
  dietPlanOptionAt(dayIndex, mealIndex, optionIndex)?.blocks?.splice(blockIndex, 1);
  renderDietPlanEditor();
}

function removeDietPlanItem(dayIndex, mealIndex, optionIndex, itemIndex) {
  dietPlanOptionAt(dayIndex, mealIndex, optionIndex)?.items?.splice(itemIndex, 1);
  renderDietPlanEditor();
}

function removeDietPlanOverride(dayIndex, mealIndex, optionIndex, blockIndex, overrideIndex) {
  dietPlanOptionAt(dayIndex, mealIndex, optionIndex)?.blocks?.[blockIndex]?.overrides?.splice(overrideIndex, 1);
  renderDietPlanEditor();
}

// Selezione template: carica subito lo snapshot (revisione corrente) così la
// preview e il salvataggio sono coerenti; il template resta riferito per id.
async function applyDietPlanTemplate(block, templateId) {
  block.templateId = templateId || null;
  block.templateSnapshot = null;
  if (!templateId) return;
  const result = await callAdminSaasFunction('getEquivalenceTemplateRevision', {
    organizationId: orgId(), templateId, revisionId: ''
  });
  const revision = result.revision || {};
  block.templateSnapshot = {
    revisionId: String(revision.revisionId || ''),
    referenceAmount: revision.referenceAmount || null,
    equivalents: (revision.equivalents || []).map(equivalent => ({
      familyId: equivalent.familyId,
      ingredientId: equivalent.ingredientId || null,
      amount: equivalent.amount || null
    }))
  };
}

function bindDietPlanEditorEvents() {
  const container = $('diet-plan-days');
  if (!container || container.dataset.bound === 'v2') return;
  container.dataset.bound = 'v2';

  container.addEventListener('click', event => {
    const target = event.target;
    const addMeal = target.closest('[data-add-meal]');
    if (addMeal) { addDietPlanMeal(Number(addMeal.dataset.addMeal), addMeal.dataset.mealId); return; }
    const toggleMeal = target.closest('[data-toggle-meal]');
    if (toggleMeal) {
      const key = toggleMeal.dataset.toggleMeal;
      if (dietMealsExpanded.has(key)) dietMealsExpanded.delete(key); else dietMealsExpanded.add(key);
      renderDietPlanEditor(); return;
    }
    const removeDay = target.closest('[data-remove-day]');
    if (removeDay) { removeDietPlanDay(Number(removeDay.dataset.removeDay)); return; }
    const removeMeal = target.closest('[data-remove-meal]');
    if (removeMeal) {
      const [dayIndex, mealIndex] = removeMeal.dataset.removeMeal.split(':').map(Number);
      removeDietPlanMeal(dayIndex, mealIndex); return;
    }
    const addOption = target.closest('[data-add-option]');
    if (addOption) {
      const [dayIndex, mealIndex] = addOption.dataset.addOption.split(':').map(Number);
      addDietPlanOption(dayIndex, mealIndex); return;
    }
    const removeOption = target.closest('[data-remove-option]');
    if (removeOption) {
      const [dayIndex, mealIndex, optionIndex] = removeOption.dataset.removeOption.split(':').map(Number);
      removeDietPlanOption(dayIndex, mealIndex, optionIndex); return;
    }
    const setType = target.closest('[data-set-option-type]');
    if (setType) {
      const [dayIndex, mealIndex, optionIndex, type] = setType.dataset.setOptionType.split(':');
      setDietPlanOptionType(Number(dayIndex), Number(mealIndex), Number(optionIndex), type); return;
    }
    const addBlock = target.closest('[data-add-block]');
    if (addBlock) {
      const [dayIndex, mealIndex, optionIndex] = addBlock.dataset.addBlock.split(':').map(Number);
      addDietPlanBlock(dayIndex, mealIndex, optionIndex); return;
    }
    const removeBlock = target.closest('[data-remove-block]');
    if (removeBlock) {
      const [dayIndex, mealIndex, optionIndex, blockIndex] = removeBlock.dataset.removeBlock.split(':').map(Number);
      removeDietPlanBlock(dayIndex, mealIndex, optionIndex, blockIndex); return;
    }
    const addItem = target.closest('[data-add-item]');
    if (addItem) {
      const [dayIndex, mealIndex, optionIndex] = addItem.dataset.addItem.split(':').map(Number);
      addDietPlanItem(dayIndex, mealIndex, optionIndex); return;
    }
    const removeItem = target.closest('[data-remove-item]');
    if (removeItem) {
      const [dayIndex, mealIndex, optionIndex, itemIndex] = removeItem.dataset.removeItem.split(':').map(Number);
      removeDietPlanItem(dayIndex, mealIndex, optionIndex, itemIndex); return;
    }
    const addOverride = target.closest('[data-add-override]');
    if (addOverride) {
      const [dayIndex, mealIndex, optionIndex, blockIndex] = addOverride.dataset.addOverride.split(':').map(Number);
      addDietPlanOverride(dayIndex, mealIndex, optionIndex, blockIndex); return;
    }
    const removeOverride = target.closest('[data-remove-override]');
    if (removeOverride) {
      const [dayIndex, mealIndex, optionIndex, blockIndex, overrideIndex] = removeOverride.dataset.removeOverride.split(':').map(Number);
      removeDietPlanOverride(dayIndex, mealIndex, optionIndex, blockIndex, overrideIndex); return;
    }
  });

  // Cambio della famiglia di riferimento: azzera ingredienti/template non coerenti.
  container.addEventListener('change', async event => {
    const target = event.target;
    const dayEl = target.closest('[data-day-index]');
    if (!dayEl) return;
    const dayIndex = Number(dayEl.dataset.dayIndex);
    const mealEl = target.closest('[data-meal-index]');
    const optionEl = target.closest('[data-option-index]');
    const blockEl = target.closest('[data-block-index]');

    if (!mealEl && target.dataset.dayField) {
      const day = dietPlanDay(dayIndex);
      if (!day) return;
      const field = target.dataset.dayField;
      day[field] = target.value;
      if (field === 'dayType') renderDietPlanEditor();
      return;
    }
    if (!mealEl) return;
    const mealIndex = Number(mealEl.dataset.mealIndex);
    const meal = dietPlanMealAt(dayIndex, mealIndex);
    if (!meal) return;

    if (!optionEl && target.dataset.mealField) {
      meal[target.dataset.mealField] = target.value;
      return;
    }
    if (!optionEl) return;
    const optionIndex = Number(optionEl.dataset.optionIndex);
    const option = dietPlanOptionAt(dayIndex, mealIndex, optionIndex);
    if (!option) return;

    if (!blockEl && target.dataset.optionField) {
      const field = target.dataset.optionField;
      if (field === 'recipeMultiplier') {
        option.recipeMultiplier = Math.min(10, Math.max(0.1, Number(target.value) || 1));
      } else {
        option[field] = target.value;
      }
      return;
    }
    if (!blockEl) return;
    const blockIndex = Number(blockEl.dataset.blockIndex);
    const block = option.blocks?.[blockIndex];
    if (!block) return;

    const field = target.dataset.blockField || target.dataset.overrideField;
    if (target.dataset.overrideField) {
      const overrideEl = target.closest('[data-override-index]');
      const overrideIndex = Number(overrideEl?.dataset.overrideIndex);
      const override = block.overrides?.[overrideIndex];
      if (!override) return;
      if (field === 'familyId') {
        override.familyId = target.value;
        override.ingredientId = null;
        override._ingredientName = '';
      } else if (field === 'ingredient') {
        const entry = resolveIngredientTextInput(target.value);
        override.ingredientId = entry ? entry.ingredient.ingredientId : null;
        override._ingredientName = target.value;
      } else if (field === 'amountValue') {
        override.amount = { ...(override.amount || { unit: 'g' }), value: Number(target.value) || 0 };
      } else if (field === 'amountUnit') {
        override.amount = { value: Number(override.amount?.value ?? 0), unit: target.value };
      }
      return;
    }
    if (field === 'referenceFamilyId') {
      block.referenceFamilyId = target.value;
      block.referenceIngredientId = null;
      block._referenceIngredientName = '';
      block.templateId = null;
      block.templateSnapshot = null;
      renderDietPlanEditor();
      return;
    }
    if (field === 'referenceIngredient') {
      const entry = resolveIngredientTextInput(target.value);
      block.referenceIngredientId = entry ? entry.ingredient.ingredientId : null;
      block._referenceIngredientName = target.value;
      return;
    }
    if (field === 'referenceAmountValue') {
      block.referenceAmount = { ...(block.referenceAmount || { unit: 'g' }), value: Number(target.value) || 0 };
      return;
    }
    if (field === 'referenceAmountUnit') {
      block.referenceAmount = { value: Number(block.referenceAmount?.value ?? 0), unit: target.value };
      return;
    }
    if (field === 'templateId') {
      try {
        await applyDietPlanTemplate(block, target.value);
        renderDietPlanEditor();
      } catch (error) {
        $('diet-plan-error').textContent = adminError(error);
      }
      return;
    }
  });

  // Input ingrediente: aggiorna il nome transient, il riconoscimento avviene
  // su change (blur) per non cancellare battute intermedie.
  container.addEventListener('input', event => {
    const target = event.target;
    if (target.dataset.itemField === 'ingredient') {
      const optionEl = target.closest('[data-option-index]');
      const itemEl = target.closest('[data-item-index]');
      const dayEl = target.closest('[data-day-index]');
      const mealEl = target.closest('[data-meal-index]');
      const item = dietPlanOptionAt(Number(dayEl.dataset.dayIndex), Number(mealEl.dataset.mealIndex), Number(optionEl.dataset.optionIndex))?.items?.[Number(itemEl.dataset.itemIndex)];
      if (item) item._displayName = target.value;
      return;
    }
  });

  container.addEventListener('change', event => {
    const target = event.target;
    if (!target.dataset.itemField) return;
    const dayEl = target.closest('[data-day-index]');
    const mealEl = target.closest('[data-meal-index]');
    const optionEl = target.closest('[data-option-index]');
    const itemEl = target.closest('[data-item-index]');
    const item = dietPlanOptionAt(Number(dayEl?.dataset.dayIndex), Number(mealEl?.dataset.mealIndex), Number(optionEl?.dataset.optionIndex))?.items?.[Number(itemEl?.dataset.itemIndex)];
    if (!item) return;
    const field = target.dataset.itemField;
    if (field === 'ingredient') {
      const entry = resolveIngredientTextInput(target.value);
      item.ingredientId = entry ? entry.ingredient.ingredientId : '';
      item._displayName = target.value;
      const hint = itemEl?.querySelector('.diet-item-hint');
      if (hint) hint.hidden = Boolean(item.ingredientId);
      const meal = dietPlanMealAt(Number(dayEl.dataset.dayIndex), Number(mealEl.dataset.mealIndex));
      const summary = mealEl?.querySelector('.diet-meal-summary');
      if (meal && summary) summary.textContent = meal.options.length === 1 ? dietOptionSummary(meal.options[0]) : `${meal.options.length} opzioni`;
      return;
    }
    if (field === 'amountValue') {
      item.amount = { ...(item.amount || { unit: 'g' }), value: Number(target.value) || 0 };
      return;
    }
    if (field === 'amountUnit') {
      item.amount = { value: Number(item.amount?.value ?? 0), unit: target.value };
    }
  });
}

// Normalizza il piano dell'editor attraverso i factory del dominio: toglie i
// campi transienti (nomi testuali) e rigenera gli id mancanti.
function collectDietPlanFromEditor() {
  const domain = dietPlanDomain();
  if (!domain) return null;
  const plan = adminState.dietPlan || {};
  const days = (plan.days || []).map(day => domain.createDietPlanDay(day.dayType, {
    dayId: day.dayId,
    label: day.label || '',
    dayType: day.dayType,
    meals: (day.meals || []).map(meal => ({
      mealId: meal.mealId,
      note: meal.note || '',
      options: (meal.options || []).map(option => {
        if (option.type === 'recipe') {
          return { type: 'recipe', recipeId: option.recipeId || null, recipeMultiplier: option.recipeMultiplier ?? 1, note: option.note || '' };
        }
        if (option.type === 'ingredients') {
          return { type: 'ingredients', note: option.note || '', items: (option.items || []).map(item => ({ itemId: item.itemId, ingredientId: item.ingredientId, amount: item.amount })) };
        }
        return {
          type: 'family-block',
          note: option.note || '',
          blocks: (option.blocks || []).map(block => ({
            blockId: block.blockId,
            referenceFamilyId: block.referenceFamilyId,
            referenceIngredientId: block.referenceIngredientId || null,
            referenceAmount: block.referenceAmount,
            templateId: block.templateId || null,
            templateSnapshot: block.templateSnapshot || null,
            overrides: (block.overrides || []).map(override => ({
              familyId: override.familyId,
              ingredientId: override.ingredientId || null,
              amount: override.amount
            }))
          }))
        };
      })
    })),
    supplements: day.supplements || '',
    hydration: day.hydration || '',
    note: day.note || ''
  }));
  return {
    schemaVersion: domain.DIET_PLAN_SCHEMA_VERSION,
    days,
    generalNotes: String(plan.generalNotes || '')
  };
}

function renderDietPlanPreview() {
  const domain = dietPlanDomain();
  const plan = collectDietPlanFromEditor();
  const preview = $('diet-plan-preview');
  if (!plan || !preview) return;
  const dayHtml = (plan.days || []).map((day, dayIndex) => `
    <section class="preview-day">
      <h4>${escapeAdmin(day.label || `Giornata ${dayIndex + 1}`)} · ${escapeAdmin(domain.dietPlanDayLabel(day.dayType))}</h4>
      ${day.meals.map(meal => `
        <p class="preview-meal"><strong>${escapeAdmin(domain.dietPlanMealLabel(meal.mealId))}</strong>${meal.note ? ` <small>${escapeAdmin(meal.note)}</small>` : ''}
        ${meal.options.map((option, optionIndex) => `
          <span class="preview-option">· ${meal.options.length > 1 ? `${domain.DIET_PLAN_OPTION_LABELS[optionIndex]}. ` : ''}${escapeAdmin(dietOptionSummary(option))}</span>`).join('')}
        </p>`).join('')}
      ${day.hydration ? `<p class="preview-choice">Idratazione: ${escapeAdmin(day.hydration)}</p>` : ''}
      ${day.supplements ? `<p class="preview-choice">Integrazione: ${escapeAdmin(day.supplements)}</p>` : ''}
    </section>`).join('');
  preview.innerHTML = `
    <p class="preview-meta">${(plan.days || []).length} giornate · revisione ${adminState.dietPlanEditingId ? 'aggiornata' : 'iniziale'}${plan.generalNotes ? ' · note generali presenti' : ''}</p>
    ${dayHtml || '<p class="preview-choice">Nessuna giornata: aggiungine almeno una.</p>'}`;
}

async function openDietPlanDialog(structureId = null) {
  const feedback = $('structures-feedback');
  if (!orgId()) { if (feedback) feedback.textContent = ORG_MISSING_MESSAGE; return; }
  const domain = dietPlanDomain();
  if (!domain) { if (feedback) feedback.textContent = 'Dominio non disponibile: ricarica la pagina.'; return; }
  try {
    await Promise.all([loadCatalogIndex(), loadEquivalenceTemplates()]);
    if (!(adminState.professionalRecipes || []).length) {
      try { await loadProfessionalRecipes({ quiet: true }); } catch (_) { /* ricette opzionali */ }
    }
  } catch (error) {
    if (feedback) feedback.textContent = adminError(error);
    return;
  }
  refreshDietCatalogDatalist();
  adminState.dietPlanEditingId = structureId;
  dietMealsExpanded.clear();
  $('diet-plan-error').textContent = '';
  $('diet-plan-preview').classList.add('hidden');
  $('diet-plan-preview-toggle').textContent = 'Mostra anteprima';
  $('diet-plan-changelog').value = '';
  $('diet-plan-restore-rev').value = '';
  $('diet-plan-general-notes').value = '';
  adminState.dietPlanRestoredFrom = null;
  if (structureId) {
    const result = await callAdminSaasFunction('getDietStructureRevision', { organizationId: orgId(), structureId, revisionId: '' });
    const { structure, revision } = result;
    $('diet-plan-title').textContent = 'Modifica struttura dieta';
    $('diet-plan-name').value = structure.name || '';
    adminState.dietPlan = {
      days: (revision.dietPlan?.days || []).map(day => domain.createDietPlanDay(day.dayType, day)),
      generalNotes: revision.dietPlan?.generalNotes || ''
    };
    $('diet-plan-general-notes').value = revision.dietPlan?.generalNotes || '';
    $('tech-revision').textContent = String(revision.revisionId || '—');
    $('tech-checksum').textContent = String(revision.checksum || structure.latestChecksum || '—').slice(0, 16) || '—';
    $('tech-catalog').textContent = revision.ingredientCatalogVersion != null ? `v${revision.ingredientCatalogVersion}` : '—';
    $('diet-plan-tech-details').classList.remove('hidden');
    $('diet-plan-restore-field').classList.remove('hidden');
  } else {
    $('diet-plan-title').textContent = 'Nuova struttura dieta';
    $('diet-plan-name').value = '';
    adminState.dietPlan = domain.createEmptyDietPlan ? domain.createEmptyDietPlan() : { schemaVersion: domain.DIET_PLAN_SCHEMA_VERSION, days: [], generalNotes: '' };
    $('diet-plan-tech-details').classList.add('hidden');
    $('diet-plan-restore-field').classList.add('hidden');
  }
  bindDietPlanEditorEvents();
  renderDietPlanEditor();
  $('diet-plan-dialog').classList.remove('hidden');
}

function closeDietPlanDialog() {
  $('diet-plan-dialog').classList.add('hidden');
  adminState.dietPlan = null;
  adminState.dietPlanEditingId = null;
}

async function loadDietPlanRevisionFromInput() {
  if (!adminState.dietPlanEditingId) return;
  const revisionId = String($('diet-plan-restore-rev').value || '').trim();
  if (!revisionId) { $('diet-plan-error').textContent = 'Scrivi il numero della revisione da caricare.'; return; }
  const domain = dietPlanDomain();
  try {
    const result = await callAdminSaasFunction('getDietStructureRevision', {
      organizationId: orgId(), structureId: adminState.dietPlanEditingId, revisionId
    });
    adminState.dietPlan = {
      days: (result.revision.dietPlan?.days || []).map(day => domain.createDietPlanDay(day.dayType, day)),
      generalNotes: result.revision.dietPlan?.generalNotes || ''
    };
    $('diet-plan-general-notes').value = result.revision.dietPlan?.generalNotes || '';
    adminState.dietPlanRestoredFrom = String(result.revision.revisionId || '');
    dietMealsExpanded.clear();
    renderDietPlanEditor();
    $('diet-plan-error').textContent = '';
    $('diet-plan-changelog').value = `Ripristino della revisione ${result.revision.revisionId}`;
  } catch (error) {
    $('diet-plan-error').textContent = adminError(error);
  }
}

async function submitDietPlanDialog(event) {
  event.preventDefault();
  const domain = dietPlanDomain();
  if (!domain || !adminState.dietPlan) return;
  const name = $('diet-plan-name').value.trim();
  if (name.length < 3) { $('diet-plan-error').textContent = 'Il nome della struttura richiede almeno 3 caratteri.'; return; }
  const plan = collectDietPlanFromEditor();
  plan.generalNotes = $('diet-plan-general-notes').value.trim();
  if (!plan.days.length) { $('diet-plan-error').textContent = 'Aggiungi almeno una giornata.'; return; }
  // Validazione locale: stessa forma del server, errori leggibili in console.
  const validation = domain.validateDietPlanSoft(plan, catalogIndexCache);
  if (!validation.valid) {
    $('diet-plan-error').textContent = validation.errors.slice(0, 3).join(' ');
    return;
  }
  const changelog = $('diet-plan-changelog').value.trim();
  const payload = {
    organizationId: orgId(),
    name,
    dietPlan: plan,
    idempotencyKey: idem(adminState.dietPlanEditingId ? `structure-rev-${adminState.dietPlanEditingId}` : 'structure-create')
  };
  if (adminState.dietPlanEditingId) {
    payload.structureId = adminState.dietPlanEditingId;
    // updateDietStructureRevision accetta changelog/restoredFromRevisionId;
    // createDietStructure no (exactObject li rifiuterebbe).
    if (changelog) payload.changelog = changelog;
    if (adminState.dietPlanRestoredFrom) payload.restoredFromRevisionId = adminState.dietPlanRestoredFrom;
  }
  $('diet-plan-error').textContent = '';
  $('diet-plan-submit').disabled = true;
  try {
    if (adminState.dietPlanEditingId) {
      await callAdminSaasFunction('updateDietStructureRevision', payload);
    } else {
      await callAdminSaasFunction('createDietStructure', payload);
    }
    closeDietPlanDialog();
    await loadStructures();
    $('structures-feedback').textContent = 'Struttura dieta salvata ✅';
  } catch (error) {
    $('diet-plan-error').textContent = adminError(error);
  } finally {
    $('diet-plan-submit').disabled = false;
  }
}

// ---- Template equivalenze (organization-scoped) ----
// Ogni template dichiara una famiglia di riferimento (più un eventuale
// ingrediente di riferimento), una quantità di riferimento e N equivalenti
// proporzionali. I blocchi delle strutture lo citano per id e ne fotografano
// la revisione: aggiornare il template non cambia retroattivamente i piani.

async function loadEquivalenceTemplates() {
  if (!orgId()) { $('templates-feedback').textContent = ORG_MISSING_MESSAGE; return; }
  $('templates-feedback').textContent = 'Caricamento template…';
  try {
    const result = await callAdminSaasFunction('listEquivalenceTemplates', { organizationId: orgId() });
    adminState.templates = result.templates || [];
    renderEquivalenceTemplates();
    $('templates-feedback').textContent = adminState.templates.length ? '' : 'Nessun template: creane uno per precompilare i blocchi.';
  } catch (error) {
    $('templates-feedback').textContent = adminError(error);
    adminState.templates = [];
    renderEquivalenceTemplates();
  }
}

function renderEquivalenceTemplates() {
  const list = $('templates-list');
  if (!list) return;
  list.innerHTML = (adminState.templates || []).map(template => `
    <article class="client-card ${template.status === 'archived' ? 'structure-archived' : ''}">
      <p class="eyebrow">TEMPLATE EQUIVALENZE${template.status === 'archived' ? ' · ARCHIVIATO' : ''}</p>
      <h3>${escapeAdmin(template.name)}</h3>
      <p>Famiglia di riferimento: ${escapeAdmin(catalogFamilyLabel(template.referenceFamilyId))}</p>
      <p class="structure-dates"><small>Revisione ${escapeAdmin(String(template.currentRevisionId || '—'))} · aggiornato ${formatDateOnly(template.updatedAt)}</small></p>
      <div class="card-actions">
        <button class="secondary" data-edit-template="${escapeAdmin(template.id)}">Modifica →</button>
        <button class="text-button archive-toggle" data-archive-template="${escapeAdmin(template.id)}" data-archived="${template.status === 'archived' ? '1' : '0'}">${template.status === 'archived' ? 'Riattiva' : 'Archivia'}</button>
      </div>
    </article>`).join('') || '<p class="feedback">Nessun template registrato.</p>';
}

function renderTemplateEquivalentRow(equivalent = {}) {
  return `
  <div class="diet-block-override" data-equivalent-index="">
    <select data-equivalent-field="familyId">${familyOptionsHtml(equivalent.familyId)}</select>
    <input list="diet-catalog-options" data-equivalent-field="ingredient" maxlength="200" placeholder="Ingrediente specifico (opzionale)" value="${escapeAdmin(equivalent._ingredientName || catalogIngredientName(equivalent.ingredientId))}">
    <input type="number" min="0" step="0.5" data-equivalent-field="amountValue" value="${Number(equivalent.amount?.value ?? 0)}" aria-label="Quantità equivalente">
    <select data-equivalent-field="amountUnit">${unitOptionsHtml(equivalent.amount?.unit)}</select>
    <button type="button" class="text-button danger-text" data-remove-equivalent>✕</button>
  </div>`;
}

async function openTemplateDialog(templateId = null) {
  if (!orgId()) { $('templates-feedback').textContent = ORG_MISSING_MESSAGE; return; }
  try {
    await loadCatalogIndex();
  } catch (error) {
    $('templates-feedback').textContent = adminError(error);
    return;
  }
  refreshDietCatalogDatalist();
  adminState.editingTemplateId = templateId;
  $('template-error').textContent = '';
  // I selettori si popolano dal catalogo: famiglia di riferimento e unità
  // di misura sono dominio condiviso, non liste hardcoded.
  $('template-family').innerHTML = familyOptionsHtml('');
  $('template-ref-unit').innerHTML = unitOptionsHtml('g');
  const rows = $('template-equivalents');
  if (rows) rows.innerHTML = '';
  if (templateId) {
    try {
      const result = await callAdminSaasFunction('getEquivalenceTemplateRevision', { organizationId: orgId(), templateId, revisionId: '' });
      const { template, revision } = result;
      $('template-name').value = template.name || '';
      $('template-family').value = revision.referenceFamilyId || '';
      $('template-ingredient').value = catalogIngredientName(revision.referenceIngredientId) || '';
      $('template-ref-value').value = Number(revision.referenceAmount?.value ?? 0);
      $('template-ref-unit').value = revision.referenceAmount?.unit || 'g';
      if (rows) rows.innerHTML = (revision.equivalents || []).map(renderTemplateEquivalentRow).join('');
    } catch (error) {
      $('template-error').textContent = adminError(error);
    }
  } else {
    $('template-name').value = '';
    $('template-family').value = '';
    $('template-ingredient').value = '';
    $('template-ref-value').value = '';
    $('template-ref-unit').value = 'g';
    if (rows) rows.innerHTML = renderTemplateEquivalentRow();
  }
  $('template-dialog').classList.remove('hidden');
}

function closeTemplateDialog() {
  $('template-dialog').classList.add('hidden');
  adminState.editingTemplateId = null;
}

async function submitTemplateDialog(event) {
  event.preventDefault();
  const familyId = $('template-family').value;
  const name = $('template-name').value.trim();
  if (!name) { $('template-error').textContent = 'Dai un nome al template.'; return; }
  if (!familyId) { $('template-error').textContent = 'Scegli la famiglia di riferimento.'; return; }
  const referenceIngredientName = $('template-ingredient').value.trim();
  const referenceEntry = referenceIngredientName ? resolveIngredientTextInput(referenceIngredientName) : null;
  if (referenceIngredientName && !referenceEntry) { $('template-error').textContent = 'L’ingrediente di riferimento non è nel catalogo: sceglierlo dall’elenco.'; return; }
  const equivalents = [];
  for (const row of $('template-equivalents').querySelectorAll('[data-equivalent-index]')) {
    const familySelect = row.querySelector('[data-equivalent-field="familyId"]');
    const ingredientInput = row.querySelector('[data-equivalent-field="ingredient"]');
    const amountInput = row.querySelector('[data-equivalent-field="amountValue"]');
    const unitSelect = row.querySelector('[data-equivalent-field="amountUnit"]');
    if (!familySelect.value) continue;
    const ingredientName = ingredientInput.value.trim();
    const entry = ingredientName ? resolveIngredientTextInput(ingredientName) : null;
    if (ingredientName && !entry) {
      $('template-error').textContent = `«${ingredientName}» non è nel catalogo: scegli dall’elenco o lascia vuoto.`;
      return;
    }
    equivalents.push({
      familyId: familySelect.value,
      ingredientId: entry ? entry.ingredient.ingredientId : null,
      amount: { value: Number(amountInput.value) || 0, unit: unitSelect.value }
    });
  }
  if (!equivalents.length) { $('template-error').textContent = 'Aggiungi almeno un equivalente.'; return; }
  try {
    await callAdminSaasFunction('saveEquivalenceTemplate', {
      organizationId: orgId(),
      templateId: adminState.editingTemplateId || '',
      name,
      referenceFamilyId: familyId,
      referenceIngredientId: referenceEntry ? referenceEntry.ingredient.ingredientId : null,
      referenceAmount: { value: Number($('template-ref-value').value) || 0, unit: $('template-ref-unit').value },
      equivalents,
      idempotencyKey: idem(`template-save-${adminState.editingTemplateId || 'new'}`)
    });
    closeTemplateDialog();
    await loadEquivalenceTemplates();
    $('templates-feedback').textContent = 'Template pubblicato: i blocchi esistenti restano sul loro snapshot ✅';
  } catch (error) {
    $('template-error').textContent = adminError(error);
  }
}

async function toggleTemplateArchive(templateId, archived) {
  try {
    await callAdminSaasFunction('archiveEquivalenceTemplate', {
      organizationId: orgId(), templateId, archived, idempotencyKey: idem(`template-archive-${templateId}`)
    });
    await loadEquivalenceTemplates();
  } catch (error) {
    $('templates-feedback').textContent = adminError(error);
  }
}

function bindTemplateDialogEvents() {
  const form = $('template-form');
  if (!form || form.dataset.bound === 'v2') return;
  form.dataset.bound = 'v2';
  $('template-add-equivalent').addEventListener('click', () => {
    $('template-equivalents').insertAdjacentHTML('beforeend', renderTemplateEquivalentRow());
  });
  $('template-equivalents').addEventListener('click', event => {
    if (event.target.closest('[data-remove-equivalent]')) {
      const row = event.target.closest('[data-equivalent-index]');
      if ($('template-equivalents').querySelectorAll('[data-equivalent-index]').length > 1) row.remove();
    }
  });
}

function renderCatalogStatus(summary) {
  const version = Number(summary?.catalogVersion || 0);
  if (!version) {
    $('catalog-status').innerHTML = '<article class="client-card"><p class="eyebrow">CATALOGO</p><h3>Non ancora importato</h3><p>Finché il catalogo è vuoto la console non può salvare Strutture dieta: importa <span class="mono">docs/catalogo-import.json</span>.</p></article>';
    return;
  }
  $('catalog-status').innerHTML = `
    <article class="client-card"><p class="eyebrow">VERSIONE</p><h3>v${version}</h3><p>${Number(summary.ingredientCount || 0)} ingredienti · ${Number(summary.categoryCount || 0)} categorie · ${Number(summary.familyCount || 0)} famiglie</p></article>
    <article class="client-card"><p class="eyebrow">CHECKSUM</p><h3 class="mono">${escapeAdmin(String(summary.checksum || '—').slice(0, 16))}</h3><p>Aggiornato da Firestore, sola lettura.</p></article>`;
}

async function loadCatalogStatus() {
  if (!adminState.isCreator) { $('catalog-feedback').textContent = 'Solo il platform admin può importare il catalogo.'; return; }
  $('catalog-feedback').textContent = 'Lettura del catalogo…';
  try {
    const snapshot = await adminGetDoc('globalIngredientCatalog/current/meta/summary');
    const summary = snapshot && typeof snapshot.exists === 'function' && snapshot.exists() ? snapshot.data() : null;
    renderCatalogStatus(summary);
    $('catalog-feedback').textContent = '';
  } catch (error) {
    $('catalog-feedback').textContent = adminError(error);
  }
}

function catalogReportHtml(result) {
  const counts = result.counts || {};
  const errors = result.errors || [];
  const rows = (result.diff || []).map(row => `<tr><td class="mono">${escapeAdmin(row.ingredientId || row.categoryId || '')}</td><td>${escapeAdmin(row.change)}</td><td>${escapeAdmin(row.detail || '')}</td></tr>`).join('');
  return `
    <p class="callout"><strong>${counts.create || 0} nuovi</strong> · ${counts.update || 0} aggiornati · ${counts.identical || 0} già identici · ${counts.conflicts || 0} conflitti · <strong>${errors.length} errori</strong>${result.diffTruncated ? ' · diff troncato' : ''}</p>
    ${errors.length ? `<div class="feedback" role="alert">${errors.slice(0, 20).map(item => escapeAdmin(item)).join('<br>')}${errors.length > 20 ? '<br>…' : ''}</div>` : ''}
    ${rows ? `<div class="dose-table-wrap"><table class="dose-table"><caption>Differenze proposte</caption><thead><tr><th scope="col">Voce</th><th scope="col">Esito</th><th scope="col">Dettaglio</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
}

async function analyzeCatalogFile() {
  const file = $('catalog-file').files && $('catalog-file').files[0];
  $('catalog-report').innerHTML = '';
  $('catalog-commit').disabled = true;
  adminState.catalogPreview = null;
  if (!file) { $('catalog-feedback').textContent = 'Scegli prima un file JSON.'; return; }
  let payload = '';
  try {
    payload = await file.text();
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.ingredients) || !Array.isArray(parsed.categories)) {
      $('catalog-feedback').textContent = 'Il file deve contenere "ingredients" e "categories".';
      return;
    }
  } catch (_) {
    $('catalog-feedback').textContent = 'File non leggibile: serve un JSON valido.';
    return;
  }
  $('catalog-feedback').textContent = 'Analisi in corso (nessuna scrittura)…';
  try {
    const result = await callAdminSaasFunction('importGlobalIngredientCatalog', {
      format: 'json', mode: 'dry-run', payload
    });
    $('catalog-report').innerHTML = catalogReportHtml(result);
    const clean = !(result.errors || []).length && Number((result.counts || {}).create || 0) + Number((result.counts || {}).update || 0) > 0;
    adminState.catalogPreview = clean ? { payload, previewId: result.previewId, counts: result.counts } : null;
    $('catalog-commit').disabled = !clean;
    $('catalog-feedback').textContent = clean
      ? 'Analisi completata: nessun errore. Puoi confermare l’import.'
      : 'Analisi completata: correggi gli errori segnalati e ripeti il dry-run.';
  } catch (error) {
    $('catalog-feedback').textContent = adminError(error);
  }
}

async function commitCatalogImport() {
  const preview = adminState.catalogPreview;
  if (!preview) return;
  const counts = preview.counts || {};
  if (!window.confirm(`Importare il catalogo?\n\n${Number(counts.create || 0)} nuovi · ${Number(counts.update || 0)} aggiornati · ${Number(counts.identical || 0)} già identici.\n\nLe strutture già pubblicate non cambiano: l'import crea una nuova versione.`)) return;
  $('catalog-commit').disabled = true;
  $('catalog-feedback').textContent = 'Import in corso…';
  try {
    const result = await callAdminSaasFunction('importGlobalIngredientCatalog', {
      format: 'json', mode: 'commit', payload: preview.payload, previewId: preview.previewId, confirm: true
    });
    adminState.catalogPreview = null;
    // Il picker delle Strutture dieta tiene in cache l'indice del catalogo:
    // senza invalidarlo mostrerebbe gli alimenti vecchi fino al ricaricamento.
    catalogIndexCache = null;
    catalogCategoriesCache = [];
    catalogTruncated = false;
    $('catalog-report').innerHTML = `<p class="callout"><strong>Catalogo importato</strong>: versione v${Number(result.catalogVersion || 0)}, checksum <span class="mono">${escapeAdmin(String(result.checksum || '').slice(0, 16))}</span>.</p>`;
    $('catalog-feedback').textContent = 'Import completato: le Strutture dieta possono usare il catalogo.';
    await loadCatalogStatus();
  } catch (error) {
    $('catalog-feedback').textContent = adminError(error);
  }
}

async function loadUsers() {
  if (!orgId()) { $('users-feedback').textContent = ORG_MISSING_MESSAGE; return; }
  $('users-feedback').textContent = 'Caricamento team e richieste…';
  try {
    const result = await callAdminSaasFunction('listOrganizationUsers', { organizationId: orgId() });
    adminState.users = result;
    renderUsers();
    $('users-feedback').textContent = '';
  } catch (error) {
    $('users-feedback').textContent = adminError(error);
    adminState.users = { members: [], clients: [], invitations: [], requests: [] };
    renderUsers();
  }
}

function memberStatusLabel(status) {
  return ({ active: 'Attivo', suspended: 'Sospeso', removed: 'Rimosso' })[status] || status;
}

function openMemberProfile(userId) {
  const member = (adminState.users?.members || []).find(item => item.userId === userId);
  if (!member) return;
  $('member-profile-user-id').value = userId;
  $('member-profile-first-name').value = member.firstName || '';
  $('member-profile-last-name').value = member.lastName || '';
  const currentEmail = member.email || member.emailNormalized || '';
  $('member-profile-email').value = currentEmail;
  $('member-profile-form').dataset.originalEmail = currentEmail;
  $('member-profile-lead').textContent = `Dati anagrafici per ${[member.firstName, member.lastName].filter(Boolean).join(' ') || member.displayName || member.username || 'il professionista'}.`;
  $('member-profile-error').textContent = '';
  $('member-profile-dialog').classList.remove('hidden');
  $('member-profile-first-name').focus();
}

function closeMemberProfile() { $('member-profile-dialog').classList.add('hidden'); }

async function submitMemberProfile(event) {
  event.preventDefault();
  const errorEl = $('member-profile-error');
  errorEl.textContent = '';
  const userId = $('member-profile-user-id').value;
  const firstName = $('member-profile-first-name').value.trim();
  const lastName = $('member-profile-last-name').value.trim();
  const email = $('member-profile-email').value.trim();
  const originalEmail = $('member-profile-form').dataset.originalEmail || '';

  if (email && originalEmail && email.toLowerCase() !== originalEmail.toLowerCase()) {
    const ok = window.confirm(`Confermi la modifica dell'indirizzo email da "${originalEmail}" a "${email}"?\n\nIl professionista utilizzerà il nuovo indirizzo per accedere alla piattaforma.`);
    if (!ok) return;
  }

  try {
    await callAdminSaasFunction('updateMemberProfileByStaff', {
      organizationId: orgId(),
      userId,
      firstName,
      lastName,
      email,
      idempotencyKey: idem('member-profile-' + userId)
    });
    closeMemberProfile();
    $('users-feedback').textContent = 'Anagrafica professionista aggiornata.';
    await loadUsers();
  } catch (error) { errorEl.textContent = adminError(error); }
}

function renderUsers() {
  const data = adminState.users || { members: [], clients: [], invitations: [], requests: [] };
  // Il server omette membri e inviti al nutritionist; il creator resta admin
  // anche quando l'organizzazione non ha ancora altri membri.
  const isAdmin = adminState.isCreator || (data.members || []).length > 0;
  $('users-scope').textContent = isAdmin
    ? 'Solo l’admin vede e gestisce i membri.'
    : 'Come professionista vedi solo i tuoi clienti e i tuoi inviti.';
  const profileBox = document.getElementById('nutritionist-profile-form');
  if (profileBox) profileBox.innerHTML = '';
  // Il professionista non vede l'elenco membri: solo il proprio nome pubblico.
  $('members-list').style.display = isAdmin ? '' : 'none';
  $('members-list').innerHTML = (data.members || []).map(member => `
    <article class="report-row">
      <div class="report-main"><span class="ingredient-mark">⛉</span><div><strong>${escapeAdmin(([member.firstName, member.lastName].filter(Boolean).join(' ') || member.displayName || member.username || member.userId.slice(0, 8)))}</strong><small>${escapeAdmin(member.email || '')}${member.email ? ' · ' : ''}${escapeAdmin(member.role === 'admin' ? 'Admin' : 'Professionista')}</small></div></div>
      <div class="report-meta"><small>Stato</small><strong>${escapeAdmin(memberStatusLabel(member.status))}</strong></div>
      <div class="report-meta"><small>Azioni</small><strong class="member-actions">
        ${member.status === 'active'
          ? `<button class="text-button archive-toggle" data-member-status="${escapeAdmin(member.userId)}" data-status="suspended">Sospendi</button>`
          : member.status === 'suspended' ? `<button class="text-button archive-toggle" data-member-status="${escapeAdmin(member.userId)}" data-status="active">Riattiva</button>` : ''}
        ${member.role === 'nutritionist' && member.status !== 'removed' ? `<button class="text-button archive-toggle danger-text" data-member-remove="${escapeAdmin(member.userId)}">Rimuovi</button>` : ''}
        ${member.role === 'nutritionist' ? `<button class="text-button" data-member-profile="${escapeAdmin(member.userId)}">Modifica anagrafica</button>` : ''}
      </strong></div>
    </article>`).join('') || '<p class="feedback">Nessun membro visibile al tuo ruolo.</p>';
  // Il cliente vede inviti e richieste direttamente nella propria card, dove
  // trova anche l'azione corretta. Non ripetiamo gli stessi dati in un secondo
  // elenco duplicato. Gli inviti ai professionisti restano invece qui,
  // nell'area già riservata all'admin.
  const nutris = (data.members || []).filter(member => member.role === 'nutritionist' && member.status === 'active');
  if ($('invite-client-email-nutritionist')) {
    $('invite-client-email-nutritionist').innerHTML = '<option value="">Senza professionista (solo admin)</option>' +
      nutris.map(member => `<option value="${escapeAdmin(member.userId)}">${escapeAdmin(([member.firstName, member.lastName].filter(Boolean).join(' ') || member.displayName || member.username || member.userId.slice(0, 8)))}</option>`).join('');
  }
  if ($('invite-client-email-nutri-field')) $('invite-client-email-nutri-field').style.display = isAdmin ? '' : 'none';
  const nutriInvites = (data.invitations || []).filter(item => item.type === 'nutritionist');
  if (isAdmin && nutriInvites.length) {
    $('members-list').insertAdjacentHTML('beforeend', nutriInvites.map(item => `
    <article class="report-row pending-member-invite">
      <div class="report-main"><span class="ingredient-mark">◈</span><div><strong>${escapeAdmin(([item.firstName, item.lastName].filter(Boolean).join(' ') || item.targetEmail || item.targetUsername || '—'))}</strong><small>${escapeAdmin(item.targetEmail || item.targetUsername || '')}${item.targetEmail || item.targetUsername ? ' · ' : ''}Invito professionista${item.expiresAt ? ` · scade ${formatDateOnly(item.expiresAt)}` : ''}</small></div></div>
      <div class="report-meta"><small>Stato</small><strong>In attesa di registrazione</strong></div>
      <div class="report-meta"><small>Azioni</small><strong class="member-actions">
        ${item.status === 'pending' && item.targetEmail ? `<button class="text-button" data-invite-copy="${escapeAdmin(item.inviteId)}">Copia link</button>` : ''}
        ${item.status === 'pending' || item.status === 'expired' ? `<button class="text-button" data-resend-nutri-invite="${escapeAdmin(item.inviteId)}">Genera nuovo link</button>` : ''}
      </strong></div>
    </article>`).join(''));
  }
}

// Verifica esistenza account per username esatto: mostra solo trovato/non
// trovato (nessuna PII, nessuna enumerazione). Non sostituisce l'invito.
async function verifyUsername(inputId, outId) {
  const username = $(inputId).value.trim();
  const out = $(outId);
  if (!username) { out.textContent = 'Digita uno username esatto da verificare.'; return; }
  out.textContent = 'Verifica…';
  try {
    const result = await callAdminSaasFunction('searchUserByUsername', { organizationId: orgId(), username });
    out.textContent = result.found
      ? 'Account trovato: l’invito invierà una richiesta da accettare in app.'
      : 'Nessun account con questo username: verrà creato un invito monouso (7 giorni).';
  } catch (error) { out.textContent = adminError(error); }
}

async function submitNutritionistInvite(event) {
  event.preventDefault();
  const out = $('invite-nutritionist-result');
  out.textContent = 'Invito in corso…';
  try {
    const result = await callAdminSaasFunction('inviteOrganizationUser', {
      organizationId: orgId(), username: $('invite-nutritionist-username').value.trim(),
      role: 'nutritionist', idempotencyKey: idem('invite')
    });
    if (result.status === 'invited') {
      out.textContent = `Invito creato (scade ${new Date(result.expiresAt).toLocaleDateString('it-IT')}). Consegna questo token una sola volta, fuori piattaforma: ${result.token}`;
    } else if (result.status === 'already-invited') {
      out.textContent = 'Invito già esistente: il token non viene rimostrato. Crea un nuovo invito se serve.';
    } else {
      out.textContent = result.status === 'already-member' ? 'Account già membro attivo.' : 'Professionista aggiunto.';
    }
    $('invite-nutritionist-username').value = '';
    await loadUsers();
  } catch (error) { out.textContent = adminError(error); }
}

// ---- Inviti con email reale (nuovo flusso) ----
// Il backend distingue le situazioni; la console mostra un messaggio diverso
// per ciascuna, senza inventare stati e senza rimostrare token già consumati.
// Nessun invio automatico: quando il server restituisce `inviteUrl`, il link
// viene mostrato nella finestra dedicata con "Copia link" e "Condividi link".
function clientEmailInviteMessage(result) {
  const scadenza = result?.expiresAt ? `Scade il ${new Date(result.expiresAt).toLocaleDateString('it-IT')}. ` : '';
  switch (result?.status) {
    case 'invited':
      return `${scadenza}Invito creato: consegna il link al cliente con “Copia link” o “Condividi link”. Il cliente sceglie la password e poi verifica l’email.`;
    case 'invite-resent':
      return `${scadenza}Nuovo link pronto: il precedente non funziona più. Consegnalo con “Copia link” o “Condividi link”.`;
    case 'invite-corrected':
      return `${scadenza}Dati corretti: il link precedente non funziona più. Consegna il nuovo link con “Copia link” o “Condividi link”.`;
    case 'already-pending':
      return result.message || 'Esiste già un invito o una richiesta in attesa per questo indirizzo.';
    case 'link-request-created':
      return 'Richiesta inviata: il cliente accetta o rifiuta dall’app.';
    case 'already-linked-same':
      return 'Questo cliente è già associato a te.';
    case 'already-linked-other':
      return 'Questo account è già associato a un altro professionista e non può ricevere un nuovo invito.';
    case 'revoked':
      return 'Invito annullato: il link non è più utilizzabile.';
    case 'already-revoked':
      return 'Invito già annullato.';
    default:
      return result?.message || 'Operazione completata.';
  }
}

// ---- Finestra "Link da consegnare" (Copia link / Condividi link) ----
// Stessi due gesti della Lista della spesa dell'app: copia negli appunti con
// fallback su execCommand; condivisione nativa (navigator.share) con fallback
// su WhatsApp Web quando il dispositivo non la supporta.
const inviteLinkState = { url: '', message: '', title: '' };

// Testo del messaggio da condividere: chiaro, senza dati oltre a nome, link e
// scadenza. Il link è personale e monouso: va inviato solo al cliente.
function inviteShareMessage({ firstName, url, expiresAt }) {
  const nome = String(firstName || '').trim();
  const saluto = nome ? `Ciao ${nome}, ` : 'Ciao, ';
  const scadenza = expiresAt ? ` Il link scade il ${new Date(expiresAt).toLocaleDateString('it-IT')}.` : '';
  return `${saluto}ti ho invitato a Piano Nutrizionale: apri questo link personale, scegli la password e verifica la tua email.${scadenza}\n${url}`;
}

function openInviteLinkDialog({ url, firstName, lastName, email, expiresAt, title }) {
  if (!url) return;
  const nome = [firstName, lastName].filter(Boolean).join(' ').trim();
  const destinatario = nome ? `${nome}${email ? ` (${email})` : ''}` : (email || 'il cliente');
  inviteLinkState.url = url;
  inviteLinkState.title = title || 'Link d’invito pronto';
  inviteLinkState.message = inviteShareMessage({ firstName, url, expiresAt });
  $('invite-link-title').textContent = inviteLinkState.title;
  $('invite-link-lead').textContent = `Consegna questo link a ${destinatario}: il cliente sceglie la password e verifica l’email.${expiresAt ? ` Il link scade il ${new Date(expiresAt).toLocaleDateString('it-IT')}.` : ''}`;
  $('invite-link-url').value = url;
  $('invite-link-feedback').textContent = '';
  $('invite-link-dialog').classList.remove('hidden');
  $('invite-link-copy').focus();
}

function closeInviteLinkDialog() {
  $('invite-link-dialog').classList.add('hidden');
  // Il link resta nel documento solo finché la finestra è aperta.
  $('invite-link-url').value = '';
  inviteLinkState.url = '';
  inviteLinkState.message = '';
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const done = document.execCommand('copy');
      textarea.remove();
      return done;
    } catch (__) { return false; }
  }
}

async function copyInviteLink() {
  const out = $('invite-link-feedback');
  if (!inviteLinkState.url) { out.textContent = 'Nessun link da copiare: crea o rinnova l’invito.'; return; }
  const done = await copyTextToClipboard(inviteLinkState.url);
  if (done) { out.textContent = 'Link copiato: incollalo dove preferisci.'; return; }
  // Ultimo fallback: il campo è selezionato e l'utente copia a mano.
  const input = $('invite-link-url');
  input.focus();
  input.select();
  out.textContent = 'Copia automatica non disponibile: il link è selezionato, copialo con Ctrl+C (o tieni premuto sul telefono).';
}

async function shareInviteLink() {
  const out = $('invite-link-feedback');
  if (!inviteLinkState.url) { out.textContent = 'Nessun link da condividere: crea o rinnova l’invito.'; return; }
  if (navigator.share) {
    try {
      await navigator.share({ title: inviteLinkState.title, text: inviteLinkState.message });
      out.textContent = 'Condivisione avviata.';
      return;
    } catch (error) {
      // Annullato dall'utente: nessun messaggio d'errore.
      if (error?.name === 'AbortError') return;
    }
  }
  // Senza condivisione nativa: WhatsApp Web con il messaggio già pronto,
  // come fa la Lista della spesa.
  window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(inviteLinkState.message)}`, '_blank', 'noopener');
  out.textContent = 'Messaggio pronto su WhatsApp: scegli il contatto e invia.';
}

function openInviteClientDialog() {
  $('invite-client-email-result').textContent = '';
  $('invite-client-dialog').classList.remove('hidden');
  $('invite-client-email').focus();
}

function closeInviteClientDialog() { $('invite-client-dialog').classList.add('hidden'); }

function openInviteNutritionistDialog() {
  $('invite-nutritionist-email-result').textContent = '';
  $('invite-nutritionist-dialog').classList.remove('hidden');
  $('invite-nutritionist-email').focus();
}

function closeInviteNutritionistDialog() {
  $('invite-nutritionist-dialog').classList.add('hidden');
}

async function submitNutritionistEmailInvite(event) {
  event.preventDefault();
  const out = $('invite-nutritionist-email-result');
  out.textContent = 'Creazione invito in corso…';
  const firstName = $('invite-nutritionist-first-name').value.trim();
  const lastName = $('invite-nutritionist-last-name').value.trim();
  const email = $('invite-nutritionist-email').value.trim();
  try {
    const result = await callAdminSaasFunction('inviteOrganizationUser', {
      organizationId: orgId(),
      email,
      firstName,
      lastName,
      role: 'nutritionist',
      idempotencyKey: idem('nutri-email')
    });
    if (result.inviteUrl) {
      $('invite-nutritionist-email').value = '';
      $('invite-nutritionist-first-name').value = '';
      $('invite-nutritionist-last-name').value = '';
      closeInviteNutritionistDialog();
      openInviteLinkDialog({
        url: result.inviteUrl,
        firstName,
        lastName,
        email,
        expiresAt: result.expiresAt,
        title: 'Link professionista pronto'
      });
    }
    await loadUsers();
    // Il replay idempotente arriva con il messaggio del server (link ancora
    // valido oppure invito da rinnovare): ha la precedenza sul testo generico.
    $('users-feedback').textContent = result.message
      || (result.inviteUrl
        ? 'Invito per il professionista creato. Consegnalo con “Copia link” o “Condividi link”.'
        : (result.status === 'already-member' ? 'Account già membro attivo.' : 'Professionista aggiunto.'));
  } catch (error) { out.textContent = adminError(error); }
}

async function resendNutritionistInvite(inviteId) {
  $('users-feedback').textContent = 'Creazione del nuovo link in corso…';
  try {
    const result = await callAdminSaasFunction('resendClientInvite', {
      organizationId: orgId(),
      inviteId,
      idempotencyKey: idem('resend-nutri-invite')
    });
    const invite = (adminState.users?.invitations || []).find(item => item.inviteId === inviteId);
    if (result.inviteUrl) {
      openInviteLinkDialog({
        url: result.inviteUrl,
        firstName: invite?.firstName || '',
        lastName: invite?.lastName || '',
        email: invite?.targetEmail || '',
        expiresAt: result.expiresAt,
        title: 'Nuovo link per il professionista'
      });
    }
    await loadUsers();
    $('users-feedback').textContent = result.message || 'Nuovo link pronto.';
  } catch (error) {
    $('users-feedback').textContent = adminError(error);
  }
}

async function submitClientEmailInvite(event) {
  event.preventDefault();
  const out = $('invite-client-email-result');
  out.textContent = 'Creazione invito in corso…';
  const firstName = $('invite-client-first-name').value.trim();
  const lastName = $('invite-client-last-name').value.trim();
  const email = $('invite-client-email').value.trim();
  try {
    const result = await callAdminSaasFunction('inviteClientByEmail', {
      organizationId: orgId(),
      email,
      firstName,
      lastName,
      nutritionistUid: $('invite-client-email-nutritionist').value || null,
      idempotencyKey: idem('clientemail')
    });
    out.textContent = clientEmailInviteMessage(result);
    if (result.inviteUrl) {
      $('invite-client-email').value = '';
      $('invite-client-first-name').value = '';
      $('invite-client-last-name').value = '';
      closeInviteClientDialog();
      openInviteLinkDialog({ url: result.inviteUrl, firstName, lastName, email, expiresAt: result.expiresAt, title: 'Link d’invito pronto' });
    }
    // Il messaggio va scritto DOPO il ricaricamento: loadClients() ripulisce
    // il riquadro di stato della vista Clienti.
    await Promise.all([loadUsers(), loadClients()]);
    if (result.inviteUrl) $('clients-feedback').textContent = clientEmailInviteMessage(result);
  } catch (error) { out.textContent = adminError(error); }
}

function inviteById(inviteId) {
  return adminState.clientInvitations.find(item => item.inviteId === inviteId)
    || ((adminState.users?.invitations || []).find(item => item.inviteId === inviteId))
    || null;
}

// ---- Link d'invito persistente ("Copia link") ----
// Finché il cliente non è attivo, il link già emesso resta recuperabile: il
// server legge il segreto dell'invito e restituisce lo STESSO link (nessuna
// rigenerazione del token, nessuna nuova scadenza). La console riapre la
// finestra di consegna con "Copia link" e "Condividi link".
async function getExistingInviteLink(inviteId, feedbackId = 'clients-feedback') {
  const invite = inviteById(inviteId);
  const out = $(feedbackId);
  if (out) out.textContent = 'Recupero del link in corso…';
  try {
    const result = await callAdminSaasFunction('getClientInviteLink', { organizationId: orgId(), inviteId });
    openInviteLinkDialog({
      url: result.inviteUrl,
      firstName: result.firstName || invite?.firstName || '',
      lastName: result.lastName || invite?.lastName || '',
      email: result.targetEmail || invite?.targetEmail || '',
      expiresAt: result.expiresAt,
      title: result.type === 'nutritionist' ? 'Link professionista pronto' : 'Link d’invito pronto'
    });
    if (out) out.textContent = 'Link recuperato: consegnalo con “Copia link” o “Condividi link”.';
  } catch (error) {
    if (out) out.textContent = adminError(error);
  }
}

// Il messaggio di esito va nel riquadro della vista da cui arriva il clic: la
// scheda cliente ha il suo, l'elenco clienti e il pannello team ne hanno altri.
function inviteFeedbackIdFor(event) {
  return event?.currentTarget?.id === 'client-detail-body' ? 'client-detail-feedback' : 'clients-feedback';
}

async function resendClientInvite(inviteId) {
  const invite = inviteById(inviteId);
  $('clients-feedback').textContent = 'Creazione del nuovo link in corso…';
  try {
    const result = await callAdminSaasFunction('resendClientInvite', {
      organizationId: orgId(), inviteId, idempotencyKey: idem('invite-resend')
    });
    if (result.inviteUrl) {
      openInviteLinkDialog({
        url: result.inviteUrl, firstName: invite?.firstName, lastName: invite?.lastName,
        email: invite?.targetEmail, expiresAt: result.expiresAt, title: 'Nuovo link d’invito'
      });
    }
    await Promise.all([loadUsers(), loadClients()]);
    $('clients-feedback').textContent = clientEmailInviteMessage(result);
  } catch (error) { $('clients-feedback').textContent = adminError(error); }
}

async function cancelClientInvite(inviteId) {
  const reason = prompt('Motivo dell’annullamento (audit):', 'Invito non più necessario');
  if (reason === null) return;
  if (String(reason).trim().length < 3) { $('clients-feedback').textContent = 'Indica un motivo di almeno 3 caratteri.'; return; }
  try {
    const result = await callAdminSaasFunction('cancelClientInvite', {
      organizationId: orgId(), inviteId, reason: String(reason).trim(), idempotencyKey: idem('invite-cancel')
    });
    await Promise.all([loadUsers(), loadClients()]);
    $('clients-feedback').textContent = clientEmailInviteMessage(result);
  } catch (error) { $('clients-feedback').textContent = adminError(error); }
}

function openInviteFix(inviteId) {
  const invite = inviteById(inviteId);
  if (!invite) { $('clients-feedback').textContent = 'Invito non trovato: aggiorna l’elenco.'; return; }
  $('invite-fix-invite-id').value = invite.inviteId;
  $('invite-fix-email').value = invite.targetEmail || '';
  $('invite-fix-first-name').value = invite.firstName || '';
  $('invite-fix-last-name').value = invite.lastName || '';
  $('invite-fix-lead').textContent = `Invito per ${invite.targetEmail || 'cliente'}: correggendo i dati il link precedente smette di funzionare.`;
  $('invite-fix-error').textContent = '';
  $('invite-fix-dialog').classList.remove('hidden');
  $('invite-fix-email').focus();
}

function closeInviteFix() { $('invite-fix-dialog').classList.add('hidden'); }

async function submitInviteFix(event) {
  event.preventDefault();
  const errorEl = $('invite-fix-error');
  errorEl.textContent = '';
  const email = $('invite-fix-email').value.trim();
  const firstName = $('invite-fix-first-name').value.trim();
  const lastName = $('invite-fix-last-name').value.trim();
  try {
    const result = await callAdminSaasFunction('correctClientInvite', {
      organizationId: orgId(),
      inviteId: $('invite-fix-invite-id').value,
      email,
      firstName,
      lastName,
      idempotencyKey: idem('invite-fix')
    });
    closeInviteFix();
    if (result.inviteUrl) {
      openInviteLinkDialog({ url: result.inviteUrl, firstName, lastName, email, expiresAt: result.expiresAt, title: 'Nuovo link d’invito' });
    }
    await Promise.all([loadUsers(), loadClients()]);
    $('clients-feedback').textContent = clientEmailInviteMessage(result);
  } catch (error) { errorEl.textContent = adminError(error); }
}

// ---- Anagrafica cliente e cambio email ----
function openClientProfile(clientId) {
  const client = adminState.clients.find(item => item.id === clientId);
  if (!client) return;
  $('client-profile-client-id').value = clientId;
  $('client-profile-first-name').value = client.firstName || '';
  $('client-profile-last-name').value = client.lastName || '';
  const currentEmail = client.email || client.emailNormalized || '';
  $('client-profile-email').value = currentEmail;
  $('client-profile-form').dataset.originalEmail = currentEmail;
  $('client-profile-lead').textContent = `Dati anagrafici per ${clientLabel(client)}.`;
  $('client-profile-error').textContent = '';
  $('client-profile-dialog').classList.remove('hidden');
  $('client-profile-first-name').focus();
}

function closeClientProfile() { $('client-profile-dialog').classList.add('hidden'); }

async function submitClientProfile(event) {
  event.preventDefault();
  const errorEl = $('client-profile-error');
  errorEl.textContent = '';
  const clientId = $('client-profile-client-id').value;
  const firstName = $('client-profile-first-name').value.trim();
  const lastName = $('client-profile-last-name').value.trim();
  const email = $('client-profile-email').value.trim();
  const originalEmail = $('client-profile-form').dataset.originalEmail || '';

  if (email && originalEmail && email.toLowerCase() !== originalEmail.toLowerCase()) {
    const ok = window.confirm(`Confermi la modifica dell'indirizzo email da "${originalEmail}" a "${email}"?\n\nIl cliente utilizzerà il nuovo indirizzo per accedere alla piattaforma.`);
    if (!ok) return;
  }

  try {
    await callAdminSaasFunction('updateClientProfileByStaff', {
      organizationId: orgId(),
      clientId,
      firstName,
      lastName,
      email,
      idempotencyKey: idem('client-profile')
    });
    closeClientProfile();
    $('clients-feedback').textContent = 'Anagrafica cliente aggiornata con successo.';
    await loadClients();
  } catch (error) { errorEl.textContent = adminError(error); }
}

async function generateClientNewLink(clientId) {
  const client = adminState.clients.find(item => item.id === clientId);
  if (!client) return;
  const invite = inviteForClient(clientId);
  if (invite?.inviteId) {
    await resendClientInvite(invite.inviteId);
    return;
  }
  const email = client.email || client.emailNormalized;
  if (!email) {
    $('clients-feedback').textContent = 'Indirizzo email mancante: aggiorna l’anagrafica del cliente per creare un link.';
    return;
  }
  $('clients-feedback').textContent = 'Generazione del link in corso…';
  try {
    const result = await callAdminSaasFunction('inviteClientByEmail', {
      organizationId: orgId(),
      email,
      firstName: client.firstName,
      lastName: client.lastName,
      nutritionistUid: adminState.isCreator ? (client.nutritionistUids?.[0] || '') : adminState.user.uid,
      idempotencyKey: idem('invite-new-' + client.id)
    });
    if (result.inviteUrl) {
      openInviteLinkDialog({
        url: result.inviteUrl,
        firstName: client.firstName,
        lastName: client.lastName,
        email,
        expiresAt: result.expiresAt,
        title: 'Nuovo link d’invito'
      });
    }
    await Promise.all([loadUsers(), loadClients()]);
    $('clients-feedback').textContent = clientEmailInviteMessage(result);
  } catch (error) {
    $('clients-feedback').textContent = adminError(error);
  }
}

function openDeleteClientDialog(clientId) {
  const client = adminState.clients.find(item => item.id === clientId);
  if (!client) return;
  $('delete-client-id').value = clientId;
  $('delete-client-lead').textContent = `Stai per eliminare definitivamente ${clientLabel(client)} (${client.email || 'nessuna email'}).`;
  $('delete-client-error').textContent = '';
  $('delete-client-dialog').classList.remove('hidden');
}

function closeDeleteClientDialog() {
  $('delete-client-dialog').classList.add('hidden');
}

async function submitDeleteClientPermanent(event) {
  event.preventDefault();
  const errorEl = $('delete-client-error');
  errorEl.textContent = '';
  const clientId = $('delete-client-id').value;
  try {
    await callAdminSaasFunction('deleteClientPermanently', {
      organizationId: orgId(),
      clientId,
      idempotencyKey: idem('delete-client-' + clientId)
    });
    closeDeleteClientDialog();
    closeClientDetail();
    $('clients-feedback').textContent = 'Cliente eliminato definitivamente dalla piattaforma.';
    await Promise.all([loadClients(), loadUsers()]);
  } catch (error) { errorEl.textContent = adminError(error); }
}

function openEmailChange(clientId) {
  const client = adminState.clients.find(item => item.id === clientId);
  if (!client) return;
  $('email-change-client-id').value = clientId;
  $('email-change-new-email').value = '';
  $('email-change-reason').value = '';
  $('email-change-lead').textContent = `Nuova email per ${clientLabel(client)} (attuale: ${client.email || '—'}). Il cliente deve confermare dall’app; poi dovrà verificare il nuovo indirizzo.`;
  $('email-change-error').textContent = '';
  $('email-change-dialog').classList.remove('hidden');
  $('email-change-new-email').focus();
}

function closeEmailChange() { $('email-change-dialog').classList.add('hidden'); }

async function submitEmailChange(event) {
  event.preventDefault();
  const errorEl = $('email-change-error');
  errorEl.textContent = '';
  try {
    const result = await callAdminSaasFunction('proposeClientEmailChange', {
      organizationId: orgId(),
      clientId: $('email-change-client-id').value,
      newEmail: $('email-change-new-email').value.trim(),
      reason: $('email-change-reason').value.trim(),
      idempotencyKey: idem('email-change')
    });
    closeEmailChange();
    $('clients-feedback').textContent = result.status === 'unchanged'
      ? 'L’indirizzo è già quello del cliente.'
      : 'Proposta inviata: il cliente deve confermare dall’app.';
    await loadClients();
  } catch (error) { errorEl.textContent = adminError(error); }
}

async function changeMemberStatus(userId, status) {
  $('users-feedback').textContent = '';
  try {
    await callAdminSaasFunction('setMemberStatus', { organizationId: orgId(), userId, status, idempotencyKey: idem('member') });
    await loadUsers();
    $('users-feedback').textContent = status === 'suspended' ? 'Membership sospesa.' : 'Membership riattivata.';
  } catch (error) { $('users-feedback').textContent = adminError(error); }
}

async function removeNutritionist(userId) {
  const label = (adminState.users?.members || []).find(member => member.userId === userId)?.username || 'il professionista';
  if (!confirm(`Rimuovere ${label} dall’organizzazione?\n\nLa rimozione è bloccata se restano clienti collegati o in attesa. Le sue strutture dieta restano visibili a te (admin) con il proprietario invariato e non vengono trasferite a nessuno.`)) return;
  $('users-feedback').textContent = '';
  try {
    await callAdminSaasFunction('removeNutritionist', { organizationId: orgId(), userId, idempotencyKey: idem('member-remove') });
    await loadUsers();
    $('users-feedback').textContent = 'Professionista rimosso. Le sue strutture restano consultabili senza trasferimento.';
  } catch (error) { $('users-feedback').textContent = adminError(error); }
}

// Rimozione associazione cliente (conferma forte: spiega gli effetti).
function openUnlink(clientId, displayCode) {
  $('unlink-client-id').value = clientId;
  $('unlink-client').textContent = displayCode ? `Cliente ${displayCode}` : '';
  $('unlink-reason').value = '';
  $('unlink-error').textContent = '';
  $('unlink-dialog').classList.remove('hidden');
  $('unlink-reason').focus();
}

function closeUnlink() { $('unlink-dialog').classList.add('hidden'); }

async function submitUnlink(event) {
  event.preventDefault();
  $('unlink-error').textContent = '';
  try {
    await callAdminSaasFunction('removeClientLink', {
      organizationId: orgId(), clientId: $('unlink-client-id').value,
      reason: $('unlink-reason').value.trim(), idempotencyKey: idem('unlink')
    });
    closeUnlink();
    closeClientDetail();
    await Promise.all([loadUsers(), loadClients()]);
    $('clients-feedback').textContent = 'Cliente rimosso (revoca logica): torna alle dosi originali e perde la Spesa inclusa. Lo storico resta in audit.';
  } catch (error) { $('unlink-error').textContent = adminError(error); }
}

function showView(view) {
  document.querySelectorAll('.console-view').forEach(node => node.classList.toggle('hidden', node.id !== `view-${view}`));
  document.querySelectorAll('.nav-link').forEach(node => node.classList.toggle('active', node.dataset.view === view));
  document.querySelector('.sidebar').classList.remove('open');
  const backdrop = $('sidebar-backdrop');
  if (backdrop) backdrop.hidden = true;
  $('mobile-menu')?.setAttribute('aria-expanded', 'false');
  // La vista Clienti è unica: profili + team si caricano insieme.
  if (view === 'clients') { loadClients(); loadUsers(); }
  else if (view === 'structures') loadStructures();
  else if (view === 'templates') { loadCatalogIndex().catch(() => {}); loadEquivalenceTemplates(); }
  else if (view === 'recipes') { loadProfessionalRecipes(); loadProfessionalShares(); }
  else if (view === 'catalog') loadCatalogStatus();
  else if (view === 'requests') loadCatalogRequests();
}

function bindAdmin() {
  $('admin-login-form').addEventListener('submit', async event => {
    event.preventDefault(); $('admin-login-error').textContent = '';
    try { await adminSignInWithUsername($('admin-username').value, $('admin-password').value); }
    catch (error) { $('admin-login-error').textContent = adminError(error); }
  });
  $('admin-logout').addEventListener('click', () => adminSignOutUser());
  $('refresh-requests').addEventListener('click', loadCatalogRequests);
  $('request-status').addEventListener('change', loadCatalogRequests);
  $('requests-list').addEventListener('click', event => {
    const button = event.target.closest('[data-open-request]');
    if (button) openCatalogRequest(button.dataset.openRequest);
  });
  $('request-form').addEventListener('submit', submitCatalogRequestResolution);
  $('request-reject').addEventListener('click', rejectCatalogRequest);
  document.querySelectorAll('[data-close-request]').forEach(node => node.addEventListener('click', closeCatalogRequest));
  $('refresh-clients').addEventListener('click', () => { loadClients(); loadUsers(); });
  $('invite-nutritionist-open')?.addEventListener('click', openInviteNutritionistDialog);
  document.querySelectorAll('[data-close-invite-nutritionist]').forEach(node => node.addEventListener('click', closeInviteNutritionistDialog));
  $('invite-client-open').addEventListener('click', openInviteClientDialog);
  document.querySelectorAll('[data-close-invite-client]').forEach(node => node.addEventListener('click', closeInviteClientDialog));
  document.querySelectorAll('[data-close-client-detail]').forEach(node => node.addEventListener('click', closeClientDetail));
  $('client-search')?.addEventListener('input', event => {
    adminState.clientSearchQuery = event.target.value.trim().toLowerCase();
    renderClients();
  });
  $('client-filter').addEventListener('click', event => {
    const tab = event.target.closest('[data-client-filter]');
    if (!tab) return;
    adminState.clientFilter = tab.dataset.clientFilter;
    renderClients();
  });
  $('clients-list').addEventListener('click', handleClientActions);
  $('client-detail-body').addEventListener('click', handleClientActions);
  $('client-remove-open').addEventListener('click', () => {
    const client = detailClient();
    if (client) openUnlink(client.id, clientLabel(client));
  });
  $('assignment-form').addEventListener('submit', submitAssignment);
  $('assignment-no-expiry').addEventListener('change', () => { $('assignment-expires').disabled = $('assignment-no-expiry').checked; if ($('assignment-no-expiry').checked) $('assignment-expires').value = ''; });
  document.querySelectorAll('[data-close-assignment]').forEach(node => node.addEventListener('click', closeAssignment));
  document.querySelectorAll('.nav-link').forEach(node => node.addEventListener('click', () => showView(node.dataset.view)));
  $('refresh-structures').addEventListener('click', loadStructures);
  $('new-diet-plan').addEventListener('click', () => openDietPlanDialog());
  $('diet-plan-form').addEventListener('submit', submitDietPlanDialog);
  bindDietPlanEditorEvents();
  $('diet-plan-add-day').addEventListener('click', addDietPlanDay);
  $('diet-plan-load-revision').addEventListener('click', loadDietPlanRevisionFromInput);
  $('diet-plan-preview-toggle').addEventListener('click', () => {
    const box = $('diet-plan-preview');
    renderDietPlanPreview();
    box.classList.toggle('hidden');
    $('diet-plan-preview-toggle').textContent = box.classList.contains('hidden') ? 'Mostra anteprima' : 'Nascondi anteprima';
  });
  // Anteprima viva: mentre si digita, se è visibile si aggiorna.
  let dietPreviewTimer = null;
  $('diet-plan-form').addEventListener('input', () => {
    if ($('diet-plan-preview').classList.contains('hidden')) return;
    clearTimeout(dietPreviewTimer);
    dietPreviewTimer = setTimeout(renderDietPlanPreview, 250);
  });
  document.querySelectorAll('[data-close-diet-plan]').forEach(node => node.addEventListener('click', closeDietPlanDialog));
  $('structures-list').addEventListener('click', event => {
    const edit = event.target.closest('[data-edit-structure]');
    if (edit) { openStructureEditor(edit.dataset.editStructure); return; }
    const archive = event.target.closest('[data-archive-structure]');
    if (archive) toggleStructureArchive(archive.dataset.archiveStructure, archive.dataset.archived !== '1');
  });
  $('structures-list').addEventListener('change', event => {
    const check = event.target.closest('[data-compare-structure]');
    if (!check) return;
    if (check.checked) adminState.compareSelection.add(check.dataset.compareStructure);
    else adminState.compareSelection.delete(check.dataset.compareStructure);
    renderCompareBar();
  });
  $('compare-structures').addEventListener('click', openCompare);
  document.querySelectorAll('[data-close-compare]').forEach(node => node.addEventListener('click', closeCompare));
  $('new-recipe').addEventListener('click', () => openRecipeDialog());
  $('refresh-recipes').addEventListener('click', loadProfessionalRecipes);
  $('refresh-shares').addEventListener('click', loadProfessionalShares);
  $('recipe-form').addEventListener('submit', submitRecipeForm);
  $('recipe-add-ingredient').addEventListener('click', () => addRecipeIngredientRow());
  $('recipe-ingredients').addEventListener('click', event => {
    const remove = event.target.closest('.ing-remove');
    if (remove) remove.closest('.recipe-ingredient-row').remove();
  });
  $('recipe-send-form').addEventListener('submit', submitRecipeSend);
  document.querySelectorAll('[data-close-recipe]').forEach(node => node.addEventListener('click', closeRecipeDialog));
  document.querySelectorAll('[data-close-recipe-send]').forEach(node => node.addEventListener('click', closeRecipeSendDialog));
  $('recipe-filters').addEventListener('click', event => {
    const tab = event.target.closest('[data-recipe-filter]');
    if (!tab) return;
    adminState.recipeFilter = tab.dataset.recipeFilter;
    renderProfessionalRecipes();
  });
  $('recipes-list').addEventListener('click', handleRecipeActions);
  $('shares-list').addEventListener('click', event => {
    const button = event.target.closest('[data-cancel-share]');
    if (button) cancelProfessionalShareUI(button.dataset.cancelShare);
  });
  // Template equivalenze: elenco, editor, archiviazione/riattivazione.
  $('new-template').addEventListener('click', () => { bindTemplateDialogEvents(); openTemplateDialog(); });
  $('refresh-templates').addEventListener('click', loadEquivalenceTemplates);
  $('templates-list').addEventListener('click', event => {
    const edit = event.target.closest('[data-edit-template]');
    if (edit) { bindTemplateDialogEvents(); openTemplateDialog(edit.dataset.editTemplate); return; }
    const archive = event.target.closest('[data-archive-template]');
    if (archive) toggleTemplateArchive(archive.dataset.archiveTemplate, archive.dataset.archived !== '1');
  });
  $('template-form').addEventListener('submit', submitTemplateDialog);
  document.querySelectorAll('[data-close-template]').forEach(node => node.addEventListener('click', closeTemplateDialog));
  $('refresh-catalog').addEventListener('click', loadCatalogStatus);
  $('catalog-dry-run').addEventListener('click', analyzeCatalogFile);
  $('catalog-commit').addEventListener('click', commitCatalogImport);
  $('catalog-file').addEventListener('change', () => { $('catalog-report').innerHTML = ''; $('catalog-commit').disabled = true; adminState.catalogPreview = null; });
  document.querySelectorAll('[data-verify-username]').forEach(node => node.addEventListener('click', () => verifyUsername(node.dataset.verifyUsername, node.dataset.verifyOut)));
  $('invite-nutritionist-form').addEventListener('submit', submitNutritionistInvite);
  $('invite-nutritionist-email-form')?.addEventListener('submit', submitNutritionistEmailInvite);
  $('invite-client-email-form')?.addEventListener('submit', submitClientEmailInvite);
  $('invite-fix-form')?.addEventListener('submit', submitInviteFix);
  $('client-profile-form')?.addEventListener('submit', submitClientProfile);
  $('email-change-form')?.addEventListener('submit', submitEmailChange);
  $('member-profile-form')?.addEventListener('submit', submitMemberProfile);
  $('delete-client-form')?.addEventListener('submit', submitDeleteClientPermanent);
  document.querySelectorAll('[data-close-invite-fix]').forEach(node => node.addEventListener('click', closeInviteFix));
  document.querySelectorAll('[data-close-invite-link]').forEach(node => node.addEventListener('click', closeInviteLinkDialog));
  $('invite-link-copy')?.addEventListener('click', copyInviteLink);
  $('invite-link-share')?.addEventListener('click', shareInviteLink);
  document.querySelectorAll('[data-close-client-profile]').forEach(node => node.addEventListener('click', closeClientProfile));
  document.querySelectorAll('[data-close-email-change]').forEach(node => node.addEventListener('click', closeEmailChange));
  document.querySelectorAll('[data-close-member-profile]').forEach(node => node.addEventListener('click', closeMemberProfile));
  document.querySelectorAll('[data-close-delete-client]').forEach(node => node.addEventListener('click', closeDeleteClientDialog));
  $('members-list').addEventListener('click', event => {
    const statusButton = event.target.closest('[data-member-status]');
    if (statusButton) { changeMemberStatus(statusButton.dataset.memberStatus, statusButton.dataset.status); return; }
    const removeButton = event.target.closest('[data-member-remove]');
    if (removeButton) { removeNutritionist(removeButton.dataset.memberRemove); return; }
    const copyInviteButton = event.target.closest('[data-invite-copy]');
    if (copyInviteButton) { getExistingInviteLink(copyInviteButton.dataset.inviteCopy, 'users-feedback'); return; }
    const resendNutriBtn = event.target.closest('[data-resend-nutri-invite]');
    if (resendNutriBtn) { resendNutritionistInvite(resendNutriBtn.dataset.resendNutriInvite); return; }
    const profileButton = event.target.closest('[data-member-profile]');
    if (profileButton) openMemberProfile(profileButton.dataset.memberProfile);
  });
  $('unlink-form').addEventListener('submit', submitUnlink);
  document.querySelectorAll('[data-close-unlink]').forEach(node => node.addEventListener('click', closeUnlink));
  // Drawer mobile accessibile: backdrop click-to-close, Escape, focus sulla
  // prima voce all'apertura, aria-expanded sul bottone.
  const sidebar = () => document.querySelector('.sidebar');
  const setDrawer = open => {
    sidebar().classList.toggle('open', open);
    $('sidebar-backdrop').hidden = !open;
    $('mobile-menu').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('mobile-menu').setAttribute('aria-label', open ? 'Chiudi menu' : 'Apri menu');
    if (open) document.querySelector('.nav-link')?.focus();
  };
  $('mobile-menu').addEventListener('click', () => setDrawer(!sidebar().classList.contains('open')));
  $('sidebar-backdrop').addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && sidebar().classList.contains('open')) {
      setDrawer(false);
      $('mobile-menu').focus();
    }
  });
}

// Tema chiaro/scuro della console: interruttore nell'intestazione, scelta
// persistita su questo dispositivo, prima paint già nel tema giusto.
const CONSOLE_THEME_KEY = 'pn_admin_theme';

function readConsoleTheme() {
  try {
    const stored = localStorage.getItem(CONSOLE_THEME_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch (_) { /* storage non disponibile */ }
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch (_) { return 'light'; }
}

function applyConsoleTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement?.classList.toggle('dark-mode', dark);
  document.body?.classList.toggle('dark-mode', dark);
  try { localStorage.setItem(CONSOLE_THEME_KEY, dark ? 'dark' : 'light'); } catch (_) { /* solo memoria */ }
  const toggle = $('theme-toggle');
  const icon = $('theme-toggle-icon');
  if (toggle) {
    toggle.setAttribute('aria-pressed', dark ? 'true' : 'false');
    toggle.setAttribute('aria-label', dark ? 'Attiva il tema chiaro' : 'Attiva il tema scuro');
  }
  if (icon) icon.textContent = dark ? '☀' : '☾';
}

function toggleConsoleTheme() {
  applyConsoleTheme(document.documentElement.classList.contains('dark-mode') ? 'light' : 'dark');
}

bindAdmin();
$('theme-toggle')?.addEventListener('click', toggleConsoleTheme);
applyConsoleTheme(readConsoleTheme());
if (!initFirebase()) $('admin-login-error').textContent = 'Firebase non disponibile.';
// Sessione SEPARATA dall'app cliente (Firebase App "admin-console"): questo
// observer ascolta l'Auth della console, quindi una sessione cliente attiva
// nella stessa origine NON apre la dashboard, e i logout restano indipendenti.
observeAdminAuthState(async user => {
  adminState.user = user;
  if (!user) {
    adminState.isCreator = false;
    $('invite-nutritionist-form').classList.add('hidden');
    $('team-panel')?.classList.add('hidden');
    $('invite-nutritionist-open')?.classList.add('hidden');
    const navClientsLabel = $('nav-clients-label');
    if (navClientsLabel) navClientsLabel.textContent = 'Clienti';
    $('nav-catalog').classList.add('hidden');
    $('nav-requests')?.classList.add('hidden');
    const requestsBadge = $('nav-open-count');
    if (requestsBadge) { requestsBadge.textContent = '0'; requestsBadge.classList.add('badge-zero'); }
    $('admin-login').classList.remove('hidden');
    $('admin-app').classList.add('hidden');
    return;
  }
  // Il gate professionale è deciso dal server: l'Auth dice solo CHI è
  // l'utente, le membership vere (getMyMemberships) dicono SE è un
  // professionista. Nessun ruolo viene letto da storage locali: un account
  // cliente autenticato non ottiene mai la dashboard né le operazioni.
  $('admin-login-error').textContent = 'Verifica dell’autorizzazione alla console…';
  try {
    const professional = await callAdminSaasFunction('getMyMemberships', {});
    const allowed = Boolean(professional.platformAdmin) || (professional.memberships || []).length > 0;
    // Solo il creatore (platform admin) può invitare altri professionisti:
    // la UI nasconde il form, il server lo impone comunque via requireCreator.
    adminState.isCreator = Boolean(professional.platformAdmin);
    if (!allowed) {
      $('admin-login-error').textContent = 'Questo account non è abilitato alla console professionale.';
      await adminSignOutUser();
      return;
    }
  } catch (error) {
    $('admin-login-error').textContent = adminError(error);
    await adminSignOutUser();
    return;
  }
  // Se nel frattempo la sessione è stata chiusa (logout su altra scheda),
  // non riaprire la dashboard per un utente che non è più autenticato.
  if (getAdminCurrentUser()?.uid !== user.uid) return;
  $('admin-login-error').textContent = '';
  $('admin-login').classList.add('hidden');
  $('admin-app').classList.remove('hidden');
  $('invite-nutritionist-form').classList.toggle('hidden', !adminState.isCreator);
  $('invite-nutritionist-open')?.classList.toggle('hidden', !adminState.isCreator);
  $('team-panel')?.classList.toggle('hidden', !adminState.isCreator);
  $('nav-catalog').classList.toggle('hidden', !adminState.isCreator);
  $('nav-requests')?.classList.toggle('hidden', !adminState.isCreator);
  const navClientsLabel = $('nav-clients-label');
  if (navClientsLabel) {
    navClientsLabel.textContent = adminState.isCreator ? 'Utenti' : 'Clienti';
  }
  const heroEyebrow = $('clients-hero-eyebrow');
  if (heroEyebrow) {
    heroEyebrow.textContent = adminState.isCreator ? 'GESTIONE UTENTI' : 'I TUOI CLIENTI';
  }
  if (adminState.isCreator) {
    loadCatalogIndex().then(() => loadCatalogRequests()).catch(() => {});
  }
  const name = usernameFromUser(user) || 'Professionista';
  $('admin-name').textContent = name; $('admin-avatar').textContent = name.slice(0, 1).toUpperCase();
  // Landing: la vista Clienti è la porta d'ingresso della console.
  showView('clients');
});
