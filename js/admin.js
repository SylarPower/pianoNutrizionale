'use strict';

const adminState = { user: null, reports: [], clients: [], clientInvitations: [], clientRequests: [], clientEmailChanges: [], clientFilter: 'all', detailClientId: null, detailHistory: null, clientDetailReturnFocus: null, ruleSets: [], structures: [], compareSelection: new Set(), users: null, editingStructure: null, editingDietPlan: null, dietPlan: null, dietPlanRules: [], dietPlanGroups: [], dietPlanEditingId: null, cursor: null, selectedReport: null, pickerSelection: new Set(), catalogPreview: null, isCreator: false };
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

async function loadReports({ append = false } = {}) {
  if (!orgId()) { $('report-feedback').textContent = ORG_MISSING_MESSAGE; return; }
  $('report-feedback').textContent = 'Aggiornamento sicuro della coda…';
  try {
    const result = await callAdminSaasFunction('listMappingReports', {
      organizationId: orgId(), status: $('report-status').value || undefined,
      pageSize: 25, cursor: append ? adminState.cursor : undefined
    });
    adminState.reports = append ? adminState.reports.concat(result.reports || []) : (result.reports || []);
    adminState.cursor = result.nextCursor || null;
    renderReports();
    $('report-feedback').textContent = adminState.reports.length ? '' : 'Nessun caso in questa vista. Il catalogo è in ordine.';
  } catch (error) {
    $('report-feedback').textContent = adminError(error);
    adminState.reports = []; renderReports();
  }
}

function statusLabel(status) {
  return ({ open:'Da valutare', triaged:'In analisi', 'needs-review':'Proposta pronta', resolved:'Risolto', rejected:'Rifiutato', duplicate:'Duplicato' })[status] || status;
}

function renderReports() {
  $('reports-list').innerHTML = adminState.reports.map(report => `
    <article class="report-row">
      <div class="report-main"><span class="ingredient-mark">⌁</span><div><strong>${escapeAdmin(report.ingredientText)}</strong><small>Fingerprint ${escapeAdmin(String(report.normalizedFingerprint || '').slice(0, 12))}</small></div></div>
      <div class="report-meta"><small>Contesto</small><strong>${report.context?.slot === 'dinner' ? 'Cena' : 'Pranzo'} · ${report.context?.errorType === 'ambiguous' ? 'Ambiguo' : 'Non riconosciuto'}</strong></div>
      <div class="report-meta"><span class="status status-${escapeAdmin(report.status)}">${escapeAdmin(statusLabel(report.status))}</span><small>${Number(report.occurrenceCount || 1)} occorrenz${Number(report.occurrenceCount || 1) === 1 ? 'a' : 'e'}</small></div>
      <button class="secondary row-action" data-map-report="${escapeAdmin(report.id)}" ${report.status === 'resolved' ? 'disabled' : ''}>Risolvi →</button>
    </article>`).join('');
  $('load-more-reports').classList.toggle('hidden', !adminState.cursor);
  $('metric-open').textContent = adminState.reports.filter(item => item.status === 'open').length;
  $('metric-review').textContent = adminState.reports.filter(item => ['triaged','needs-review'].includes(item.status)).length;
  $('metric-resolved').textContent = adminState.reports.filter(item => item.status === 'resolved').length;
  // Badge coda accessibile: colore rosso se ci sono casi aperti, verde se la
  // coda è vuota; lo stato è leggibile anche senza colore (numero + aria).
  const open = adminState.reports.filter(item => item.status === 'open').length;
  const badge = $('nav-open-count');
  badge.textContent = open;
  badge.classList.toggle('badge-count', open > 0);
  badge.classList.toggle('badge-zero', open === 0);
  badge.setAttribute('aria-label', open > 0 ? `Coda ingredienti: ${open} casi in sospeso` : 'Coda ingredienti: nessun caso in sospeso');
}

function openMapping(reportId) {
  const report = adminState.reports.find(item => item.id === reportId);
  if (!report) return;
  adminState.selectedReport = report;
  $('mapping-report-id').value = report.id;
  $('mapping-context').textContent = `${report.ingredientText} · ${report.context?.slot === 'dinner' ? 'Cena' : 'Pranzo'} · ${report.occurrenceCount || 1} occorrenze`;
  $('mapping-canonical').value = String(report.normalizedIngredient || report.ingredientText).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  $('mapping-aliases').value = report.ingredientText || '';
  $('mapping-rationale').value = '';
  $('mapping-error').textContent = '';
  $('mapping-dialog').classList.remove('hidden');
  $('mapping-canonical').focus();
}

function closeMapping() { $('mapping-dialog').classList.add('hidden'); adminState.selectedReport = null; }

async function submitMapping(event) {
  event.preventDefault();
  const button = $('mapping-submit'); button.disabled = true; $('mapping-error').textContent = '';
  const kind = $('mapping-kind').value;
  const mapping = {
    kind, canonicalIngredientId: $('mapping-canonical').value.trim(),
    aliases: $('mapping-aliases').value.split(',').map(x => x.trim()).filter(Boolean),
    family: kind === 'guided' ? $('mapping-family').value.trim() : null,
    group: kind === 'guided' ? $('mapping-group').value : null,
    doses: kind === 'guided' ? {
      lunch: { training: Number($('dose-la').value), rest: Number($('dose-lr').value) },
      dinner: { training: Number($('dose-da').value), rest: Number($('dose-dr').value) }
    } : null
  };
  try {
    const proposal = await callAdminSaasFunction('proposeMapping', {
      organizationId: orgId(), reportId: $('mapping-report-id').value, mapping,
      rationale: $('mapping-rationale').value, idempotencyKey: idem('proposal')
    });
    await callAdminSaasFunction('publishMapping', {
      organizationId: orgId(), proposalId: proposal.proposalId,
      targetScope: $('mapping-global').checked ? 'global' : 'tenant', idempotencyKey: idem('publish')
    });
    closeMapping(); await loadReports();
    $('report-feedback').textContent = 'Mapping pubblicato. La ricetta originale dei clienti non è stata modificata.';
  } catch (error) { $('mapping-error').textContent = adminError(error); }
  finally { button.disabled = false; }
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
  try {
    if (window.PianoDomain?.clientDisplayTitle) return PianoDomain.clientDisplayTitle(client);
  } catch (_) { /* dominio non caricato: fallback locale */ }
  const full = `${client?.firstName || ''} ${client?.lastName || ''}`.trim();
  if (full) return full;
  try {
    if (window.PianoDomain?.maskEmailClient) {
      const email = String(client?.email || client?.emailNormalized || '').trim();
      if (email) return window.PianoDomain.maskEmailClient(email);
    }
  } catch (_) {}
  return client?.displayCode || 'Cliente';
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
  if (!active) return 'Nessun profilo attivo · dosi originali';
  if (active.structureId) return `Struttura ${active.structureName || active.structureId}`;
  return `Profilo ${active.ruleSet?.ruleSetId || 'assegnato'} · v${active.ruleSet?.version || ''}`;
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
    return `<p><small>Invito · ${escapeAdmin(inviteStatusLabelOf(invite.status))} · link da consegnare a mano</small></p>
      <div class="card-actions">
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
  const visible = withStatus.filter(({ status }) => adminState.clientFilter === 'all' || status === adminState.clientFilter);
  const emptyHints = {
    all: 'Nessun cliente autorizzato. Usa “Invita nuovo cliente” per iniziare.',
    active: 'Nessun cliente attivo in questo momento.',
    pending: 'Nessun cliente in attesa: inviti e richieste sono tutti risolti.',
    inactive: 'Nessun cliente inattivo.'
  };
  $('clients-list').innerHTML = visible.map(({ client, status }) => {
    const invite = inviteForClient(client.id);
    const request = requestForClient(client.id);
    const emailChange = adminState.clientEmailChanges.find(item => item.clientId === client.id) || null;
    // La scheda mostra tutto il resto (anagrafica, collegamento, struttura,
    // storico, rimozione): dalla card si apre la scheda o si assegna il profilo.
    return `<article class="client-card"><p class="eyebrow">CLIENTE</p><h3>${escapeAdmin(clientLabel(client))}</h3><p><span class="status status-client-${escapeAdmin(status)}">${escapeAdmin(clientStatusLabelOf(status))}</span></p>${emailChip(client)}<p>${escapeAdmin(assignmentSummary(client))}</p><p><small>Aggiornato il ${escapeAdmin(formatDateOnly(client.updatedAt))}</small></p>${request ? '<p><small>Richiesta di collegamento · in attesa del cliente</small></p>' : ''}${emailChange ? `<p><small>Cambio email proposto: ${escapeAdmin(emailChange.newEmail || '—')} · in attesa del cliente</small></p>` : ''}${inviteChip(invite)}<div class="card-actions"><button class="secondary" data-client-detail="${escapeAdmin(client.id)}">Apri scheda →</button><button class="secondary" data-assign-client="${escapeAdmin(client.id)}">${client.activeAssignment ? 'Cambia profilo' : 'Assegna profilo'}</button></div></article>`;
  }).join('') || `<p class="feedback">${escapeAdmin(emptyHints[adminState.clientFilter] || emptyHints.all)}</p>`;
  refreshOpenDetail();
}

// ---- Scheda cliente ----
// Un solo posto per anagrafica, collegamento, struttura dieta e dati tecnici.
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
  const who = item.targetEmail || item.targetUsername || '—';
  return `<div class="history-row"><div><strong>${escapeAdmin(label)}</strong><small>${escapeAdmin(who)}${item.createdAt ? ` · ${escapeAdmin(formatDateOnly(item.createdAt))}` : ''}</small></div><span class="status status-history">${escapeAdmin(inviteStatusLabelOf(item.status))}</span></div>`;
}

function renderClientDetail() {
  const client = detailClient();
  if (!client) return;
  const status = clientStatusOf(client);
  $('client-detail-title').textContent = clientLabel(client);
  $('client-detail-subtitle').textContent = `${clientStatusLabelOf(status)} · aggiornato il ${formatDateOnly(client.updatedAt)}`;
  const invite = inviteForClient(client.id);
  const request = requestForClient(client.id);
  const emailChange = adminState.clientEmailChanges.find(item => item.clientId === client.id) || null;
  const fullName = `${client.firstName || ''} ${client.lastName || ''}`.trim();
  const history = adminState.detailHistory;
  const historyHtml = !history
    ? '<p class="feedback">Caricamento storico…</p>'
    : ([...(history.invitations || []).map(item => historyRowHtml('invite', item)), ...(history.requests || []).map(item => historyRowHtml('request', item))].join('')
      || '<p class="feedback">Nessun movimento precedente: solo attività in corso.</p>');
  $('client-detail-body').innerHTML = `
    <section class="detail-section"><h3>Dati anagrafici</h3>
      <dl class="detail-grid">
        <div><dt>Nome e cognome</dt><dd>${escapeAdmin(fullName || '—')}</dd></div>
        <div><dt>Email</dt><dd>${escapeAdmin(client.email || '—')}${client.email ? ` · ${client.emailVerified ? 'verificata' : 'da verificare'}` : ''}</dd></div>
        ${client.username ? `<div><dt>Account di test</dt><dd>${escapeAdmin(client.username)} (legacy)</dd></div>` : ''}
      </dl>
      <div class="card-actions">
        <button class="secondary" data-client-profile="${escapeAdmin(client.id)}">Correggi anagrafica</button>
        ${client.email ? `<button class="text-button" data-client-email-change="${escapeAdmin(client.id)}">Proponi cambio email</button>` : ''}
      </div>
      ${emailChange ? `<p class="callout">Cambio email proposto: ${escapeAdmin(emailChange.newEmail || '—')} · in attesa di conferma del cliente.</p>` : ''}
    </section>
    <section class="detail-section"><h3>Collegamento</h3>
      <dl class="detail-grid">
        <div><dt>Stato</dt><dd><span class="status status-client-${escapeAdmin(status)}">${escapeAdmin(clientStatusLabelOf(status))}</span></dd></div>
        ${invite ? `<div><dt>Invito</dt><dd>${escapeAdmin(inviteStatusLabelOf(invite.status))} · link da consegnare a mano${invite.expiresAt ? ` · scade ${escapeAdmin(formatDateOnly(invite.expiresAt))}` : ''}</dd></div>` : ''}
        ${request ? '<div><dt>Richiesta</dt><dd>In attesa di accettazione dal cliente, in app.</dd></div>' : ''}
        ${!invite && !request ? '<div><dt>Inviti e richieste</dt><dd>Nessuna attività in corso.</dd></div>' : ''}
      </dl>
      ${invite ? `<div class="card-actions">
        <button class="text-button" data-invite-resend="${escapeAdmin(invite.inviteId)}">Nuovo link</button>
        <button class="text-button" data-invite-fix="${escapeAdmin(invite.inviteId)}">Correggi dati invito</button>
        <button class="text-button danger-text" data-invite-cancel="${escapeAdmin(invite.inviteId)}">Annulla invito</button>
      </div>` : ''}
    </section>
    <section class="detail-section"><h3>Struttura dieta</h3>
      <dl class="detail-grid"><div><dt>Assegnazione</dt><dd>${escapeAdmin(assignmentSummary(client))}</dd></div></dl>
      <div class="card-actions">
        <button class="secondary" data-assign-client="${escapeAdmin(client.id)}">${client.activeAssignment ? 'Cambia profilo' : 'Assegna profilo'}</button>
        ${client.activeAssignment ? `<button class="text-button" data-goto-doses="${escapeAdmin(client.id)}">Vai alle dosi</button>` : ''}
      </div>
    </section>
    <section class="detail-section"><h3>Dati tecnici</h3>
      <dl class="detail-grid">
        <div><dt>Codice cliente</dt><dd class="mono">${escapeAdmin(client.displayCode)}</dd></div>
        <div><dt>Identificativo</dt><dd class="mono">${escapeAdmin(client.id)}</dd></div>
        <div><dt>Censito il</dt><dd>${escapeAdmin(formatDateOnly(client.createdAt))}</dd></div>
        <div><dt>Professionisti collegati</dt><dd>${Array.isArray(client.nutritionistUids) ? client.nutritionistUids.length : '—'}</dd></div>
      </dl>
    </section>
    <section class="detail-section"><h3>Storico collegamenti</h3>${historyHtml}</section>`;
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
  const emailChange = event.target.closest('[data-client-email-change]');
  if (emailChange) { openEmailChange(emailChange.dataset.clientEmailChange); return; }
  const doses = event.target.closest('[data-goto-doses]');
  if (doses) { gotoDosesForClient(doses.dataset.gotoDoses); return; }
  const resend = event.target.closest('[data-invite-resend]');
  if (resend) { resendClientInvite(resend.dataset.inviteResend); return; }
  const fix = event.target.closest('[data-invite-fix]');
  if (fix) { openInviteFix(fix.dataset.inviteFix); return; }
  const cancel = event.target.closest('[data-invite-cancel]');
  if (cancel) cancelClientInvite(cancel.dataset.inviteCancel);
}

// Dalla scheda alle dosi: apre la vista Dosi con il cliente già selezionato.
async function gotoDosesForClient(clientId) {
  closeClientDetail();
  showView('doses');
  await loadDoseClients();
  if ($('dose-client').querySelector(`option[value="${clientId}"]`)) {
    $('dose-client').value = clientId;
    await loadClientDoseEditor();
  }
}

async function loadStructuresList() {
  if (!orgId()) { adminState.ruleSets = []; return; }
  try {
    const result = await callAdminSaasFunction('listDietStructures', { organizationId: orgId() });
    // Solo strutture attive assegnabili; le archiviate restano consultabili
    // nella sezione Strutture ma non si possono assegnare.
    adminState.ruleSets = (result.structures || []).filter(item => item.status !== 'archived');
  } catch (error) { adminState.ruleSets = []; $('assignment-error').textContent = adminError(error); }
  renderStructureOptions();
}

function renderStructureOptions() {
  const format = iso => iso ? new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  const mine = adminState.user?.uid || null;
  $('assignment-structure-list').innerHTML = adminState.ruleSets
    .map(item => {
      const other = mine && item.ownerUid && item.ownerUid !== mine ? ' · di un altro professionista' : '';
      return `<option value="${escapeAdmin(item.name)}" data-id="${escapeAdmin(item.id)}">${item.updatedAt ? `ultima modifica ${format(item.updatedAt)}` : 'nessuna modifica nota'}${other}</option>`;
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
  const candidates = adminState.ruleSets.filter(item => item.name === structureName);
  const chosen = adminState.ruleSets.find(item => item.id === structureName)
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

// ---- Sezione Dosi clienti ----
// Override personali sopra la struttura assegnata: celle vuote = studio.
// Ogni salvataggio crea una revisione; il cliente conferma dall'app.

async function loadDoseClients() {
  if (!orgId()) { $('doses-feedback').textContent = ORG_MISSING_MESSAGE; return; }
  $('doses-feedback').textContent = 'Caricamento clienti…';
  try {
    const result = await callAdminSaasFunction('listAuthorizedClients', { organizationId: orgId() });
    adminState.clients = result.clients || [];
    const options = '<option value="">— Seleziona —</option>' + adminState.clients.map(client => `<option value="${escapeAdmin(client.id)}">${escapeAdmin(clientLabel(client))}</option>`).join('');
    ['dose-client', 'copy-from', 'copy-to'].forEach(id => { $(id).innerHTML = options; });
    $('doses-feedback').textContent = adminState.clients.length ? '' : 'Nessun cliente autorizzato.';
  } catch (error) { $('doses-feedback').textContent = adminError(error); }
}

const doseStudioCell = (studio, meal, dayType) => {
  const value = studio?.[meal]?.[dayType];
  return Number.isFinite(Number(value)) ? `${value} g` : '—';
};
const doseStudioValue = (studio, meal, dayType) => {
  const value = studio?.[meal]?.[dayType];
  return Number.isFinite(Number(value)) ? String(value) : '';
};

async function loadClientDoseEditor() {
  const clientId = $('dose-client').value;
  $('dose-assignment').innerHTML = '';
  $('dose-tables').innerHTML = '';
  $('save-doses').disabled = true;
  adminState.doseData = null;
  if (!clientId) { $('doses-feedback').textContent = ''; return; }
  $('doses-feedback').textContent = 'Caricamento dosi…';
  try {
    const data = await callAdminSaasFunction('getClientDoses', { organizationId: orgId(), clientId });
    adminState.doseData = data;
    renderDoseEditor(data);
    $('doses-feedback').textContent = '';
  } catch (error) { $('doses-feedback').textContent = adminError(error); }
}

function renderDoseEditor(data) {
  const assignment = data.assignment;
  if (!assignment) {
    $('dose-assignment').innerHTML = '<p class="callout">Il cliente non ha un’assegnazione attiva: assegna prima un profilo dalla sezione Clienti.</p>';
    return;
  }
  const format = iso => iso ? new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  // Strutture solo-guidate (descrittive): nessuna famiglia di dosi, solo frequenze.
  const noFamilies = !(data.families || []).length
    ? '<p class="callout">La struttura assegnata è una dieta guidata descrittiva, senza famiglie di dosi: si personalizzano solo le frequenze.</p>'
    : '';
  $('dose-assignment').innerHTML = `<p class="callout"><strong>${escapeAdmin(data.displayCode)}</strong> · ${escapeAdmin(assignment.structureName || 'Profilo')} · ${escapeAdmin(assignment.status)} · dal ${format(assignment.effectiveAt)}${assignment.expiresAt ? ` al ${format(assignment.expiresAt)}` : ''} · revisione dosi n. ${assignment.overridesRevision}</p>${noFamilies}`;
  const overrides = data.overrides || { doses: {}, frequencies: {} };
  const familyRows = data.families.map(item => {
    const patch = overrides.doses?.[item.family] || {};
    const cell = (meal, dayType, label) => {
      const current = patch[meal]?.[dayType];
      return `<td><label class="dose-cell"><span class="dose-studio" title="Dose della struttura">${doseStudioCell(item.studio, meal, dayType)}</span><input type="number" min="1" max="2000" inputmode="numeric" placeholder="${doseStudioValue(item.studio, meal, dayType)}" value="${current ?? ''}" data-dose-family="${escapeAdmin(item.family)}" data-dose-meal="${meal}" data-dose-day="${dayType}" aria-label="${escapeAdmin(item.label)} ${label}"></label></td>`;
    };
    const ingredients = item.ingredients?.length ? `<small>${escapeAdmin(item.ingredients.slice(0, 4).join(', '))}${item.ingredients.length > 4 ? '…' : ''}</small>` : '';
    return `<tr><th scope="row">${escapeAdmin(item.label)}${ingredients}</th>${cell('lunch', 'training', 'Pranzo allenamento')}${cell('lunch', 'rest', 'Pranzo riposo')}${cell('dinner', 'training', 'Cena allenamento')}${cell('dinner', 'rest', 'Cena riposo')}</tr>`;
  }).join('');
  const freqRows = data.frequencyDefaults.map(item => {
    const patch = overrides.frequencies?.[item.key] || {};
    return `<tr><th scope="row">${escapeAdmin(item.label)}</th><td><span class="dose-studio" title="Default studio">${item.min}–${item.max}/sett</span></td><td><input type="number" min="0" max="14" inputmode="numeric" placeholder="${item.min}" value="${patch.min ?? ''}" data-freq-key="${escapeAdmin(item.key)}" data-freq-bound="min" aria-label="${escapeAdmin(item.label)} minimo"></td><td><input type="number" min="0" max="14" inputmode="numeric" placeholder="${item.max}" value="${patch.max ?? ''}" data-freq-key="${escapeAdmin(item.key)}" data-freq-bound="max" aria-label="${escapeAdmin(item.label)} massimo"></td></tr>`;
  }).join('');
  $('dose-tables').innerHTML = `
    <div class="dose-table-wrap"><table class="dose-table"><caption>Dosi in grammi a crudo (vuoto = struttura)</caption><thead><tr><th scope="col">Famiglia</th><th scope="col">Pranzo A</th><th scope="col">Pranzo R</th><th scope="col">Cena A</th><th scope="col">Cena R</th></tr></thead><tbody>${familyRows}</tbody></table></div>
    <div class="dose-table-wrap"><table class="dose-table"><caption>Frequenze proteiche settimanali (vuoto = default)</caption><thead><tr><th scope="col">Fonte proteica</th><th scope="col">Studio</th><th scope="col">Min</th><th scope="col">Max</th></tr></thead><tbody>${freqRows}</tbody></table></div>`;
  $('save-doses').disabled = false;
}

function collectDoseOverrides() {
  const doses = {};
  const frequencies = {};
  const bad = [];
  document.querySelectorAll('#dose-tables [data-dose-family]').forEach(input => {
    const raw = input.value.trim();
    if (!raw) return;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 2000) { bad.push(input.getAttribute('aria-label')); return; }
    const family = input.dataset.doseFamily;
    doses[family] = doses[family] || {};
    doses[family][input.dataset.doseMeal] = doses[family][input.dataset.doseMeal] || {};
    doses[family][input.dataset.doseMeal][input.dataset.doseDay] = value;
  });
  document.querySelectorAll('#dose-tables [data-freq-key]').forEach(input => {
    const raw = input.value.trim();
    if (!raw) return;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 14) { bad.push(input.getAttribute('aria-label')); return; }
    const key = input.dataset.freqKey;
    frequencies[key] = frequencies[key] || {};
    frequencies[key][input.dataset.freqBound] = value;
  });
  Object.entries(frequencies).forEach(([key, patch]) => {
    if (patch.min != null && patch.max != null && patch.min > patch.max) bad.push(`Frequenza ${key}: min oltre max`);
  });
  return { doses, frequencies, bad };
}

async function submitDoseOverrides() {
  const data = adminState.doseData;
  if (!data?.assignment) return;
  const { doses, frequencies, bad } = collectDoseOverrides();
  if (bad.length) { $('doses-feedback').textContent = `Valori non validi: ${bad.slice(0, 3).join('; ')}${bad.length > 3 ? '…' : ''}. Dosi 1–2000 g, frequenze 0–14.`; return; }
  $('doses-feedback').textContent = 'Salvataggio revisione…';
  try {
    const result = await callAdminSaasFunction('updateClientDoseOverrides', {
      organizationId: orgId(), clientId: $('dose-client').value, doses, frequencies,
      expectedRevision: data.assignment.overridesRevision
    });
    $('doses-feedback').textContent = `Revisione n. ${result.revision} salvata. Il cliente dovrà confermare dall’app.`;
    await loadClientDoseEditor();
  } catch (error) { $('doses-feedback').textContent = adminError(error); }
}

// ---- Copia dosi tra clienti ----

async function previewDoseCopy() {
  const fromId = $('copy-from').value;
  const toId = $('copy-to').value;
  $('copy-preview').innerHTML = '';
  $('confirm-copy').disabled = true;
  adminState.copyPreview = null;
  if (!fromId || !toId) { $('copy-feedback').textContent = 'Seleziona entrambi i clienti.'; return; }
  if (fromId === toId) { $('copy-feedback').textContent = 'Cliente origine e destinazione devono essere diversi.'; return; }
  $('copy-feedback').textContent = 'Calcolo differenze…';
  try {
    const [from, to] = await Promise.all([
      callAdminSaasFunction('getClientDoses', { organizationId: orgId(), clientId: fromId }),
      callAdminSaasFunction('getClientDoses', { organizationId: orgId(), clientId: toId })
    ]);
    if (!from.assignment || !to.assignment) { $('copy-feedback').textContent = 'Entrambi i clienti devono avere un’assegnazione attiva.'; return; }
    const toFamilies = new Map(to.families.map(item => [item.family, item]));
    const toDoses = to.overrides?.doses || {};
    const rows = [];
    const skipped = [];
    Object.entries(from.overrides?.doses || {}).forEach(([family, patch]) => {
      const target = toFamilies.get(family);
      if (!target) { skipped.push(family); return; }
      ['lunch', 'dinner'].forEach(meal => {
        ['training', 'rest'].forEach(dayType => {
          const value = patch[meal]?.[dayType];
          if (value == null) return;
          const current = toDoses[family]?.[meal]?.[dayType];
          const base = current != null ? `${current} g (personale)` : doseStudioCell(target.studio, meal, dayType);
          rows.push(`<tr><td>${escapeAdmin(target.label)}</td><td>${meal === 'lunch' ? 'Pranzo' : 'Cena'} ${dayType === 'training' ? 'A' : 'R'}</td><td>${escapeAdmin(base)}</td><td><strong>${value} g</strong></td></tr>`);
        });
      });
    });
    const toFreq = to.overrides?.frequencies || {};
    Object.entries(from.overrides?.frequencies || {}).forEach(([key, patch]) => {
      const label = (to.frequencyDefaults.find(item => item.key === key) || {}).label || key;
      ['min', 'max'].forEach(bound => {
        if (patch[bound] == null) return;
        const current = toFreq[key]?.[bound];
        const base = current != null ? String(current) : 'default studio';
        rows.push(`<tr><td>${escapeAdmin(label)}</td><td>Frequenza ${bound}</td><td>${escapeAdmin(base)}</td><td><strong>${patch[bound]}</strong></td></tr>`);
      });
    });
    adminState.copyPreview = { fromId, toId, toRevision: to.assignment.overridesRevision };
    $('copy-preview').innerHTML = `
      ${rows.length ? `<div class="dose-table-wrap"><table class="dose-table"><caption>Copia ${escapeAdmin(from.displayCode)} → ${escapeAdmin(to.displayCode)}</caption><thead><tr><th scope="col">Voce</th><th scope="col">Cella</th><th scope="col">Valore attuale</th><th scope="col">Nuovo valore</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p class="callout">Nessuna differenza: l’origine non ha personalizzazioni da copiare.</p>'}
      ${skipped.length ? `<p class="callout">Famiglie non copiate (assenti nella struttura di destinazione): ${skipped.map(family => escapeAdmin(family)).join(', ')}.</p>` : ''}`;
    $('copy-feedback').textContent = rows.length ? `${rows.length} celle da aggiornare.` : '';
    $('confirm-copy').disabled = !rows.length;
  } catch (error) { $('copy-feedback').textContent = adminError(error); }
}

async function confirmDoseCopy() {
  const preview = adminState.copyPreview;
  if (!preview) return;
  $('copy-feedback').textContent = 'Copia in corso…';
  try {
    const result = await callAdminSaasFunction('copyClientDoses', {
      organizationId: orgId(), fromClientId: preview.fromId, toClientId: preview.toId,
      expectedRevision: preview.toRevision
    });
    adminState.copyPreview = null;
    $('confirm-copy').disabled = true;
    $('copy-feedback').textContent = `Copiate ${result.copiedFamilies.length} famiglie (revisione n. ${result.revision})${result.skippedFamilies?.length ? `; saltate: ${result.skippedFamilies.join(', ')}` : ''}. Il cliente dovrà confermare dall’app.`;
    $('copy-preview').innerHTML = '';
  } catch (error) { $('copy-feedback').textContent = adminError(error); }
}

// ---- Sezione Strutture dieta ----
// Il nutritionist vede solo le proprie strutture (filtro server-side); l'admin
// org le vede tutte. Ogni salvataggio pubblica una nuova revisione immutabile:
// nessun campo "Versione" esiste in UI, le date sono di sola lettura.

const canonicalId = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function loadCatalogIndex() {
  if (catalogIndexCache) return catalogIndexCache;
  // Letture fatte con il Firestore della console (Auth nominata): l'identità
  // valutata dalle Security Rules è quella dell'account professionale.
  // Stesso tetto del server (functions/src/index.js, loadGlobalCatalog):
  // con un catalogo più grande l'elenco sarebbe incompleto, quindi lo diciamo.
  const ingredientLimit = 2000;
  const [ings, cats] = await Promise.all([
    adminGetDocsQuery(adminQueryLimit(adminCollectionAt('globalIngredientCatalog/current/ingredients'), ingredientLimit)),
    adminGetDocsQuery(adminQueryLimit(adminCollectionAt('globalIngredientCatalog/current/categories'), 500))
  ]);
  catalogTruncated = (ings?.size ?? ings?.docs?.length ?? 0) >= ingredientLimit;
  const ingredients = [];
  const categories = [];
  snapForEach(ings, doc => ingredients.push({ ingredientId: doc.id, ...doc.data() }));
  snapForEach(cats, doc => categories.push({ categoryId: doc.id, ...doc.data() }));
  catalogCategoriesCache = categories.filter(item => item.status !== 'archived');
  catalogIndexCache = window.PianoDomain?.buildCatalogIndex
    ? PianoDomain.buildCatalogIndex({ ingredients, categories })
    : { items: [], byId: new Map() };
  return catalogIndexCache;
}

function catalogSearch(query, limit = 8) {
  if (!catalogIndexCache || !window.PianoDomain?.searchCatalog) return [];
  return PianoDomain.searchCatalog(catalogIndexCache, query, { limit });
}

// Famiglia motore dal testo libero: confronto case-insensitive tollerante a
// spazi/trattini, ma ID restituito con il casing canonico del motore
// (es. "pesce omega" → "pesceOmega"). Il server rivalida comunque.
function engineFamilyId(typed) {
  const normalized = canonicalId(typed).replace(/-/g, '');
  const found = (window.PianoDomain?.MELLER_GRAMMATURE || [])
    .find(rule => String(rule.family).toLowerCase() === normalized);
  return found ? found.family : null;
}

function fillCategorySelects() {
  const options = `<option value="">—</option><option value="free">Alimenti liberi</option>` +
    catalogCategoriesCache.map(item => `<option value="${escapeAdmin(item.categoryId)}">${escapeAdmin(item.displayName || item.categoryId)}</option>`).join('');
  document.querySelectorAll('.rule-cat').forEach(select => {
    const current = select.dataset.value || select.value || '';
    select.innerHTML = options;
    select.value = current;
  });
}

// --- Picker catalogo: selezione multipla per raggruppare alimenti con dosi comuni. ---

function renderCatalogPicker(filter = '') {
  const list = $('catalog-picker-list');
  if (!list) return;
  if (!catalogIndexCache?.items?.length) {
    list.innerHTML = '<p class="picker-empty">Catalogo non disponibile: riprova quando sei online.</p>';
    updatePickerCount();
    return;
  }
  const query = window.PianoDomain?.aliasKey ? PianoDomain.aliasKey(filter || '') : String(filter || '').toLowerCase().trim();
  const items = catalogIndexCache.items.filter(entry => !query
    || entry.key.includes(query)
    || (entry.aliasKeys || []).some(alias => alias.includes(query))
    || (entry.tokens || []).some(token => token.startsWith(query)));
  const byCategory = new Map();
  items.forEach(entry => {
    const categoryId = entry.ingredient?.categoryId || '';
    if (!byCategory.has(categoryId)) byCategory.set(categoryId, []);
    byCategory.get(categoryId).push(entry);
  });
  byCategory.forEach(entries => entries.sort((a, b) => String(a.ingredient?.displayName || '').localeCompare(String(b.ingredient?.displayName || ''), 'it')));
  const categoryLabel = categoryId => {
    if (!categoryId) return 'Senza categoria';
    // 'free' è la categoria riservata (verdura, spezie, alimenti senza dosi):
    // non esiste come documento e va etichettata come nel resto della console.
    if (categoryId === 'free') return 'Alimenti liberi';
    const found = catalogCategoriesCache.find(item => item.categoryId === categoryId);
    return found?.displayName || categoryId;
  };
  const order = catalogCategoriesCache
    .slice()
    .sort((a, b) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || String(a.displayName || a.categoryId).localeCompare(String(b.displayName || b.categoryId), 'it'))
    .map(item => item.categoryId)
    .filter(id => id !== 'free' && byCategory.has(id));
  [...byCategory.keys()].forEach(id => { if (!order.includes(id) && id !== 'free' && id !== '') order.push(id); });
  if (byCategory.has('')) order.push('');
  if (byCategory.has('free')) order.push('free');
  const truncatedNote = catalogTruncated
    ? '<p class="picker-empty">Catalogo molto grande: l’elenco mostra i primi 2000 alimenti. Usa il filtro per cercare gli altri.</p>'
    : '';
  list.innerHTML = order.map(categoryId => `
    <div class="picker-category" role="group" aria-label="${escapeAdmin(categoryLabel(categoryId))}">
      <strong>${escapeAdmin(categoryLabel(categoryId))}</strong>
      <div class="picker-category-items">${byCategory.get(categoryId).map(entry => {
        const ingredientId = entry.ingredient?.ingredientId || entry.ingredientId || '';
        const name = entry.ingredient?.displayName || ingredientId;
        return `<label class="picker-item"><input type="checkbox" data-picker-ing="${escapeAdmin(ingredientId)}" ${adminState.pickerSelection.has(ingredientId) ? 'checked' : ''} aria-label="Seleziona ${escapeAdmin(name)}">${escapeAdmin(name)}</label>`;
      }).join('')}</div>
    </div>`).join('') || '<p class="picker-empty">Nessun alimento corrisponde al filtro.</p>';
  if (truncatedNote) list.innerHTML = truncatedNote + list.innerHTML;
}

function updatePickerCount() {
  const countEl = $('picker-count');
  const groupButton = $('picker-group');
  if (!countEl || !groupButton) return;
  const count = adminState.pickerSelection.size;
  countEl.textContent = count === 0 ? 'Nessun alimento selezionato' : (count === 1 ? '1 alimento selezionato' : `${count} alimenti selezionati`);
  groupButton.disabled = count < 2;
}

function resetCatalogPicker() {
  adminState.pickerSelection.clear();
  if ($('catalog-picker-search')) $('catalog-picker-search').value = '';
  renderCatalogPicker('');
  updatePickerCount();
  if ($('picker-feedback')) $('picker-feedback').textContent = '';
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
  $('structures-list').innerHTML = adminState.structures.map(item => `
    <article class="client-card ${item.status === 'archived' ? 'structure-archived' : ''}">
      <p class="eyebrow">STRUTTURA DIETA${item.status === 'archived' ? ' · ARCHIVIATA' : ''}</p>
      <h3>${escapeAdmin(item.name)}</h3>
      ${item.hasDietPlan ? '<p><span class="status status-plan">Dieta guidata</span></p>' : ''}
      <p>${Number(item.ruleCount ?? 0)} famiglie · ${Number(item.alternativeGroupCount ?? 0)} gruppi alternativi</p>
      <p class="structure-dates"><small>Creata il ${formatDateOnly(item.createdAt)} · ultima modifica ${formatDateOnly(item.updatedAt)}</small></p>
      <div class="card-actions">
        <button class="secondary" data-edit-structure="${escapeAdmin(item.id)}" ${item.status === 'archived' ? 'disabled' : ''}>Modifica →</button>
        <button class="text-button archive-toggle" data-archive-structure="${escapeAdmin(item.id)}" data-archived="${item.status === 'archived' ? '1' : '0'}">${item.status === 'archived' ? 'Riattiva' : 'Archivia'}</button>
        <label class="compare-check"><input type="checkbox" data-compare-structure="${escapeAdmin(item.id)}" ${adminState.compareSelection.has(item.id) ? 'checked' : ''} aria-label="Seleziona ${escapeAdmin(item.name)} per il confronto">Confronta</label>
      </div>
    </article>`).join('') || '<p class="feedback">Nessuna struttura registrata.</p>';
  renderCompareBar();
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

let ruleRowCounter = 0;

function structureRuleRow(rule = {}) {
  const q = meal => rule.quantityGrams?.[meal] || {};
  const listId = `rule-ing-list-${++ruleRowCounter}`;
  return `
  <div class="structure-rule">
    <div class="rule-head">
      <input class="rule-family" required placeholder="Famiglia (es. riso)" value="${escapeAdmin(rule.mellerFamilyId || '')}" aria-label="Famiglia">
      <input class="rule-ings" placeholder="ID ingredienti separati da virgola" value="${escapeAdmin((rule.ingredientIds || []).join(', '))}" aria-label="ID ingredienti">
      <select class="rule-cat" data-value="${escapeAdmin(rule.categoryId || '')}" aria-label="Categoria (opzionale)"><option value="">—</option></select>
      <label><input type="checkbox" class="rule-enabled" ${rule.enabled === false ? '' : 'checked'}>Attiva</label>
      <button type="button" class="dialog-close rule-remove" aria-label="Rimuovi regola">×</button>
    </div>
    <div class="rule-catalog">
      <input class="rule-ing-search" list="${listId}" placeholder="Cerca nel catalogo globale e aggiungi…" autocomplete="off" aria-label="Cerca ingrediente nel catalogo">
      <datalist id="${listId}"></datalist>
    </div>
    <div class="rule-doses">
      <label>Pranzo · Allenamento<input class="rule-la" type="number" min="1" max="2000" step="1" placeholder="g" value="${q('lunch').training ?? ''}"></label>
      <label>Pranzo · Riposo<input class="rule-lr" type="number" min="1" max="2000" step="1" placeholder="g" value="${q('lunch').rest ?? ''}"></label>
      <label>Cena · Allenamento<input class="rule-ca" type="number" min="1" max="2000" step="1" placeholder="g" value="${q('dinner').training ?? ''}"></label>
      <label>Cena · Riposo<input class="rule-cr" type="number" min="1" max="2000" step="1" placeholder="g" value="${q('dinner').rest ?? ''}"></label>
    </div>
  </div>`;
}

// Ricerca catalogo → datalist della riga; la scelta accoda l'ID stabile.
function bindCatalogSearch(container, searchSelector, listSelector, targetSelector) {
  container.addEventListener('input', event => {
    const search = event.target.closest(searchSelector);
    if (!search) return;
    const row = search.closest('.structure-rule, .group-item');
    const list = row?.querySelector(listSelector);
    if (!list) return;
    const matches = catalogSearch(search.value, 8);
    list.innerHTML = matches.map(item => `<option value="${escapeAdmin(item.ingredientId)}">${escapeAdmin(item.displayName)}${item.categoryLabel ? ` — ${escapeAdmin(item.categoryLabel)}` : ''}</option>`).join('');
  });
  container.addEventListener('change', event => {
    const search = event.target.closest(searchSelector);
    if (!search || !search.value) return;
    const row = search.closest('.structure-rule, .group-item');
    const target = row?.querySelector(targetSelector);
    if (!target) return;
    const chosen = search.value.trim();
    if (target.matches('.rule-ings')) {
      const current = target.value.split(',').map(part => part.trim()).filter(Boolean);
      if (chosen && !current.includes(chosen)) current.push(chosen);
      target.value = current.join(', ');
    } else {
      target.value = chosen;
    }
    search.value = '';
  });
}

// --- Righe gruppi alternativi: nome + voci (ingrediente da catalogo + dosi). ---
function groupItemRow(item = {}) {
  const q = meal => item.quantityGrams?.[meal] || {};
  const listId = `group-ing-list-${++ruleRowCounter}`;
  return `
  <div class="group-item">
    <input class="group-item-ing" required placeholder="ID ingrediente" value="${escapeAdmin(item.ingredientId || '')}" aria-label="ID ingrediente">
    <input class="group-ing-search" list="${listId}" placeholder="Cerca…" autocomplete="off" aria-label="Cerca ingrediente nel catalogo">
    <datalist id="${listId}"></datalist>
    <div class="rule-doses">
      <label>Pranzo A<input class="rule-la" type="number" min="1" max="2000" step="1" placeholder="g" value="${q('lunch').training ?? ''}"></label>
      <label>Pranzo R<input class="rule-lr" type="number" min="1" max="2000" step="1" placeholder="g" value="${q('lunch').rest ?? ''}"></label>
      <label>Cena A<input class="rule-ca" type="number" min="1" max="2000" step="1" placeholder="g" value="${q('dinner').training ?? ''}"></label>
      <label>Cena R<input class="rule-cr" type="number" min="1" max="2000" step="1" placeholder="g" value="${q('dinner').rest ?? ''}"></label>
    </div>
    <button type="button" class="dialog-close group-item-remove" aria-label="Rimuovi voce">×</button>
  </div>`;
}

function structureGroupRow(group = {}) {
  return `
  <div class="structure-group">
    <div class="rule-head">
      <input class="group-id" required placeholder="ID gruppo (es. carboidrati)" value="${escapeAdmin(group.alternativeGroupId || '')}" aria-label="ID gruppo">
      <input class="group-name" required placeholder="Nome visualizzato" value="${escapeAdmin(group.displayName || '')}" aria-label="Nome gruppo">
      <button type="button" class="dialog-close group-remove" aria-label="Rimuovi gruppo">×</button>
    </div>
    <div class="group-items">${(group.items?.length ? group.items : [{}]).map(groupItemRow).join('')}</div>
    <button type="button" class="secondary group-add-item">＋ Aggiungi voce</button>
  </div>`;
}

function addStructureGroupRow(group) {
  $('structure-groups').insertAdjacentHTML('beforeend', structureGroupRow(group));
}

function addStructureRuleRow(rule) {
  $('structure-rules').insertAdjacentHTML('beforeend', structureRuleRow(rule));
}

// --- Dialog raggruppamento: le dosi comuni diventano regola multi-ingrediente
// oppure voci di un gruppo alternativo (nuovo o esistente). ---

function toggleGroupDestination() {
  const toRule = $('group-dest-rule').checked;
  $('group-rule-fields').classList.toggle('hidden', !toRule);
  $('group-alt-fields').classList.toggle('hidden', toRule);
}

function toggleNewGroupFields() {
  $('group-new-fields').classList.toggle('hidden', $('group-target').value !== '__new__');
}

function openGroupDialog() {
  if (adminState.pickerSelection.size < 2) return;
  $('group-subtitle').textContent = `${adminState.pickerSelection.size} alimenti selezionati: a tutti verranno assegnate le stesse dosi. Potrai modificare le righe create prima di salvare la struttura.`;
  $('group-error').textContent = '';
  ['group-family', 'group-la', 'group-lr', 'group-ca', 'group-cr', 'group-new-id', 'group-new-name'].forEach(id => { $(id).value = ''; });
  const groups = [...$('structure-groups').querySelectorAll('.structure-group')];
  $('group-target').innerHTML = groups.map((row, index) => {
    const label = row.querySelector('.group-name')?.value?.trim() || row.querySelector('.group-id')?.value?.trim() || `Gruppo ${index + 1}`;
    return `<option value="${index}">${escapeAdmin(label)}</option>`;
  }).join('') + '<option value="__new__">＋ Nuovo gruppo…</option>';
  $('group-target').value = groups.length ? '0' : '__new__';
  toggleNewGroupFields();
  $('group-dest-rule').checked = true;
  toggleGroupDestination();
  $('group-dialog').classList.remove('hidden');
  $('group-family').focus();
}

function closeGroupDialog() { $('group-dialog').classList.add('hidden'); }

// Stesse regole di collectStructureRules: dosi intere 1–2000, almeno un pasto.
function collectGroupDoses() {
  const read = id => {
    const raw = $(id).value.trim();
    return raw === '' ? null : Number(raw);
  };
  const quantityGrams = {
    lunch: { training: read('group-la'), rest: read('group-lr') },
    dinner: { training: read('group-ca'), rest: read('group-cr') }
  };
  ['lunch', 'dinner'].forEach(meal => ['training', 'rest'].forEach(day => {
    const value = quantityGrams[meal][day];
    if (value != null && (!Number.isInteger(value) || value < 1 || value > 2000)) {
      throw new Error('Le dosi devono essere numeri interi tra 1 e 2000.');
    }
  }));
  const result = {};
  ['lunch', 'dinner'].forEach(meal => {
    result[meal] = (quantityGrams[meal].training == null && quantityGrams[meal].rest == null) ? null : quantityGrams[meal];
  });
  if (!result.lunch && !result.dinner) throw new Error('Indica almeno una dose per pranzo o cena.');
  return result;
}

function submitGrouping(event) {
  event.preventDefault();
  $('group-error').textContent = '';
  const ingredientIds = [...adminState.pickerSelection].sort((a, b) => a.localeCompare(b, 'it'));
  try {
    const quantityGrams = collectGroupDoses();
    if ($('group-dest-rule').checked) {
      const typed = $('group-family').value;
      const mellerFamilyId = engineFamilyId(typed);
      if (!mellerFamilyId) throw new Error(`La famiglia "${typed.trim() || '?'}" non esiste nel motore delle famiglie.`);
      const existing = [...$('structure-rules').querySelectorAll('.rule-family')]
        .map(input => engineFamilyId(input.value)).filter(Boolean);
      if (existing.includes(mellerFamilyId)) throw new Error(`Famiglia duplicata: ${mellerFamilyId}`);
      addStructureRuleRow({ mellerFamilyId, ingredientIds, quantityGrams, enabled: true });
      fillCategorySelects();
      $('picker-feedback').textContent = `${ingredientIds.length} alimenti raggruppati nella famiglia ${mellerFamilyId}.`;
    } else {
      const target = $('group-target').value;
      if (target === '__new__') {
        const newId = canonicalId($('group-new-id').value);
        const newName = $('group-new-name').value.trim();
        if (!newId) throw new Error('Indica l’ID del nuovo gruppo (es. quasi-cereali).');
        if (!newName) throw new Error('Indica il nome visualizzato del nuovo gruppo.');
        addStructureGroupRow({ alternativeGroupId: newId, displayName: newName, items: ingredientIds.map(ingredientId => ({ ingredientId, quantityGrams })) });
        $('picker-feedback').textContent = `${ingredientIds.length} alimenti raggruppati nel nuovo gruppo «${newName}».`;
      } else {
        const groups = [...$('structure-groups').querySelectorAll('.structure-group')];
        const groupRow = groups[Number(target)];
        if (!groupRow) throw new Error('Gruppo di destinazione non trovato.');
        const itemsContainer = groupRow.querySelector('.group-items');
        [...itemsContainer.querySelectorAll('.group-item')].forEach(row => {
          if (!row.querySelector('.group-item-ing')?.value?.trim()) row.remove();
        });
        ingredientIds.forEach(ingredientId => itemsContainer.insertAdjacentHTML('beforeend', groupItemRow({ ingredientId, quantityGrams })));
        const name = groupRow.querySelector('.group-name')?.value?.trim() || 'gruppo';
        $('picker-feedback').textContent = `${ingredientIds.length} alimenti aggiunti al gruppo «${name}».`;
      }
    }
    adminState.pickerSelection.clear();
    renderCatalogPicker($('catalog-picker-search').value);
    updatePickerCount();
    closeGroupDialog();
  } catch (error) {
    $('group-error').textContent = error.message;
  }
}

function collectStructureRules() {
  const rows = [...$('structure-rules').querySelectorAll('.structure-rule')];
  const dose = (row, cls) => { const raw = row.querySelector(cls).value; return raw === '' ? null : Number(raw); };
  const rules = rows.map((row, index) => {
    const typedFamily = row.querySelector('.rule-family').value;
    const mellerFamilyId = engineFamilyId(typedFamily);
    if (!mellerFamilyId) throw new Error(`Regola ${index + 1}: la famiglia "${typedFamily.trim() || '?'}" non esiste nel motore delle famiglie.`);
    const quantityGrams = {
      lunch: dose(row, '.rule-la') == null && dose(row, '.rule-lr') == null ? null : { training: dose(row, '.rule-la'), rest: dose(row, '.rule-lr') },
      dinner: dose(row, '.rule-ca') == null && dose(row, '.rule-cr') == null ? null : { training: dose(row, '.rule-ca'), rest: dose(row, '.rule-cr') }
    };
    if (!quantityGrams.lunch && !quantityGrams.dinner) throw new Error(`Regola ${index + 1} (${mellerFamilyId}): almeno una dose per pranzo o cena.`);
    for (const meal of ['lunch', 'dinner']) for (const day of ['training', 'rest']) {
      const value = quantityGrams[meal]?.[day];
      if (value != null && (!Number.isInteger(value) || value < 1 || value > 2000)) throw new Error(`Regola ${index + 1} (${mellerFamilyId}): le dosi devono essere interi tra 1 e 2000.`);
    }
    const ingredientIds = [...new Set(row.querySelector('.rule-ings').value.split(',').map(part => canonicalId(part)).filter(Boolean))];
    const categoryId = row.querySelector('.rule-cat')?.value || null;
    return { mellerFamilyId, ingredientIds, quantityGrams, enabled: row.querySelector('.rule-enabled').checked, categoryId };
  });
  const families = new Set();
  rules.forEach(rule => { if (families.has(rule.mellerFamilyId)) throw new Error(`Famiglia duplicata: ${rule.mellerFamilyId}`); families.add(rule.mellerFamilyId); });
  if (!rules.length) throw new Error('Aggiungi almeno una famiglia.');
  return rules;
}

function collectStructureGroups() {
  const groups = [...$('structure-groups').querySelectorAll('.structure-group')];
  const dose = (row, cls) => { const raw = row.querySelector(cls).value; return raw === '' ? null : Number(raw); };
  const parsed = groups.map((group, index) => {
    const alternativeGroupId = canonicalId(group.querySelector('.group-id').value);
    const displayName = group.querySelector('.group-name').value.trim();
    if (!alternativeGroupId) throw new Error(`Gruppo ${index + 1}: indica l'ID del gruppo.`);
    if (!displayName) throw new Error(`Gruppo ${index + 1}: indica il nome visualizzato.`);
    const items = [...group.querySelectorAll('.group-item')].map((row, itemIndex) => {
      const ingredientId = canonicalId(row.querySelector('.group-item-ing').value);
      if (!ingredientId) throw new Error(`Gruppo ${index + 1}, voce ${itemIndex + 1}: indica l'ingrediente dal catalogo.`);
      const quantityGrams = {
        lunch: dose(row, '.rule-la') == null && dose(row, '.rule-lr') == null ? null : { training: dose(row, '.rule-la'), rest: dose(row, '.rule-lr') },
        dinner: dose(row, '.rule-ca') == null && dose(row, '.rule-cr') == null ? null : { training: dose(row, '.rule-ca'), rest: dose(row, '.rule-cr') }
      };
      if (!quantityGrams.lunch && !quantityGrams.dinner) throw new Error(`Gruppo ${index + 1}, voce ${itemIndex + 1}: almeno una dose per pranzo o cena.`);
      for (const meal of ['lunch', 'dinner']) for (const day of ['training', 'rest']) {
        const value = quantityGrams[meal]?.[day];
        if (value != null && (!Number.isInteger(value) || value < 1 || value > 2000)) throw new Error(`Gruppo ${index + 1}, voce ${itemIndex + 1}: le dosi devono essere interi tra 1 e 2000.`);
      }
      return { ingredientId, quantityGrams };
    });
    if (!items.length) throw new Error(`Gruppo ${index + 1}: aggiungi almeno una voce.`);
    return { alternativeGroupId, displayName, items };
  });
  const ids = new Set();
  parsed.forEach(group => { if (ids.has(group.alternativeGroupId)) throw new Error(`Gruppo duplicato: ${group.alternativeGroupId}`); ids.add(group.alternativeGroupId); });
  return parsed;
}

// Le strutture con piano guidato si modificano con l'editor guidato, quelle
// classiche con l'editor classico. La scelta segue il flag del server.
function openStructureEditor(structureId) {
  const item = adminState.structures.find(entry => entry.id === structureId);
  if (item?.hasDietPlan) openDietPlanDialog(structureId);
  else openStructureDialog(structureId);
}

async function openStructureDialog(structureId = null) {
  adminState.editingStructure = null;
  adminState.editingDietPlan = null;
  $('structure-id').value = ''; $('structure-name').value = ''; $('structure-rules').innerHTML = '';
  $('structure-groups').innerHTML = '';
  $('structure-plan-note').classList.add('hidden');
  $('structure-changelog').value = ''; $('structure-error').textContent = '';
  $('structure-tech-details').classList.add('hidden');
  $('structure-restore-field').classList.add('hidden');
  $('structure-restore-rev').value = '';
  try { await loadCatalogIndex(); } catch (_) { /* autocomplete non disponibile offline */ }
  fillCategorySelects();
  resetCatalogPicker();
  addStructureRuleRow();
  if (structureId) {
    $('structure-title').textContent = 'Modifica struttura';
    $('structure-subtitle').textContent = 'Il salvataggio pubblica una nuova revisione: le precedenti restano intatte e ripristinabili.';
    try {
      const result = await callAdminSaasFunction('getDietStructureRevision', { organizationId: orgId(), structureId });
      adminState.editingStructure = result;
      adminState.editingDietPlan = result.revision.dietPlan || null;
      $('structure-id').value = structureId;
      $('structure-name').value = result.structure.name || '';
      const planNote = $('structure-plan-note');
      if (adminState.editingDietPlan) {
        planNote.textContent = 'Questa struttura ha anche un piano guidato: il salvataggio lo conserva così com’è. Per modificarlo, chiudi e riapri la struttura dall’elenco (si aprirà l’editor guidato).';
        planNote.classList.remove('hidden');
      } else planNote.classList.add('hidden');
      $('structure-restore-field').classList.remove('hidden');
      $('structure-rules').innerHTML = '';
      (result.revision.rules || []).forEach(addStructureRuleRow);
      fillCategorySelects();
      $('structure-groups').innerHTML = '';
      (result.revision.alternativeGroups || []).forEach(addStructureGroupRow);
      // Dettagli tecnici: solo se il server li espone (admin). Il
      // nutritionist non riceve checksum né ID revisione dal backend.
      if (result.structure.latestChecksum) {
        $('tech-revision').textContent = `n. ${result.structure.currentRevisionId}`;
        $('tech-checksum').textContent = result.structure.latestChecksum;
        $('tech-catalog').textContent = result.revision.ingredientCatalogVersion != null ? `v${result.revision.ingredientCatalogVersion}` : '—';
        $('structure-tech-details').classList.remove('hidden');
      }
      $('structure-name').focus();
    } catch (error) { $('structure-error').textContent = adminError(error); }
  } else {
    $('structure-title').textContent = 'Nuova struttura';
    $('structure-subtitle').textContent = 'Le dosi sono in grammi; lascia vuoto il pasto non gestito.';
  }
  $('structure-dialog').classList.remove('hidden');
  if (!structureId) $('structure-name').focus();
}
function closeStructureDialog() { $('structure-dialog').classList.add('hidden'); }

async function loadStructureRevision() {
  const structureId = $('structure-id').value;
  const rev = Number($('structure-restore-rev').value);
  if (!structureId || !Number.isInteger(rev) || rev < 1) { $('structure-error').textContent = 'Indica il numero della revisione da caricare.'; return; }
  try {
    const result = await callAdminSaasFunction('getDietStructureRevision', { organizationId: orgId(), structureId, revisionId: String(rev) });
    $('structure-rules').innerHTML = '';
    (result.revision.rules || []).forEach(addStructureRuleRow);
    fillCategorySelects();
    $('structure-groups').innerHTML = '';
    (result.revision.alternativeGroups || []).forEach(addStructureGroupRow);
    // Il ripristino riguarda anche il piano guidato della revisione caricata.
    adminState.editingDietPlan = result.revision.dietPlan || null;
    $('structure-changelog').value = `Ripristino dalla revisione ${rev}`;
    $('structure-error').textContent = '';
  } catch (error) { $('structure-error').textContent = adminError(error); }
}

async function submitStructureForm(event) {
  event.preventDefault(); $('structure-error').textContent = '';
  let rules;
  let alternativeGroups = [];
  try {
    rules = collectStructureRules();
    alternativeGroups = collectStructureGroups();
  } catch (error) { $('structure-error').textContent = error.message; return; }
  const structureId = $('structure-id').value;
  const restoredFrom = $('structure-restore-rev').value;
  try {
    if (structureId) {
      await callAdminSaasFunction('updateDietStructureRevision', {
        organizationId: orgId(), structureId, name: $('structure-name').value.trim(),
        rules, alternativeGroups, dietPlan: adminState.editingDietPlan || null,
        changelog: $('structure-changelog').value.trim() || null,
        restoredFromRevisionId: restoredFrom ? String(Number(restoredFrom)) : null,
        idempotencyKey: idem('structure')
      });
    } else {
      await callAdminSaasFunction('createDietStructure', {
        organizationId: orgId(), name: $('structure-name').value.trim(), rules, alternativeGroups, dietPlan: null, idempotencyKey: idem('structure')
      });
    }
    closeStructureDialog(); await loadStructures();
    $('structures-feedback').textContent = structureId ? 'Nuova revisione pubblicata (la precedente resta disponibile per il ripristino).' : 'Struttura creata e pubblicata.';
  } catch (error) { $('structure-error').textContent = adminError(error); }
}

async function toggleStructureArchive(structureId, archived) {
  $('structures-feedback').textContent = '';
  try {
    await callAdminSaasFunction('archiveDietStructure', { organizationId: orgId(), structureId, archived, idempotencyKey: idem('structure-status') });
    await loadStructures();
    $('structures-feedback').textContent = archived ? 'Struttura archiviata (soft-delete): non è più assegnabile ma resta consultabile.' : 'Struttura riattivata.';
  } catch (error) { $('structures-feedback').textContent = adminError(error); }
}

function doseSummary(cell) {
  if (!cell.present) return '—';
  const q = cell.quantityGrams || {};
  const fmt = meal => (q[meal] ? `${q[meal].training ?? '—'}/${q[meal].rest ?? '—'}` : '—');
  return `P ${fmt('lunch')} · C ${fmt('dinner')}${cell.enabled === false ? ' · disattiva' : ''} · ${cell.ingredientCount} ingr.`;
}

function renderCompareMatrix(result) {
  const structures = result.structures || [];
  const head = structures.map(item => `<th scope="col">${escapeAdmin(item.name)}<small>${escapeAdmin(item.status === 'archived' ? 'archiviata' : `${item.ruleCount ?? 0} famiglie`)}</small></th>`).join('');
  const familyRows = (result.rows || []).map(row => `
    <tr data-differs="${row.differs ? '1' : '0'}" class="${row.differs ? 'differs' : 'same'}">
      <th scope="row"><span class="diff-mark" aria-hidden="true">${row.differs ? '≠' : '='}</span> ${escapeAdmin(row.mellerFamilyId)}<small class="diff-word">${row.differs ? 'diverso' : 'uguale'}</small></th>
      ${structures.map(item => `<td data-label="${escapeAdmin(item.name)}">${escapeAdmin(doseSummary(row.cells?.[item.id] || {}))}</td>`).join('')}
    </tr>`).join('');
  const groupRows = (result.groupRows || []).map(row => `
    <tr data-differs="${row.differs ? '1' : '0'}" class="${row.differs ? 'differs' : 'same'}">
      <th scope="row"><span class="diff-mark" aria-hidden="true">${row.differs ? '≠' : '='}</span> ${escapeAdmin(row.alternativeGroupId)}<small class="diff-word">${row.differs ? 'diverso' : 'uguale'} · gruppo</small></th>
      ${structures.map(item => { const cell = row.cells?.[item.id] || {}; return `<td data-label="${escapeAdmin(item.name)}">${cell.present ? `${escapeAdmin(cell.displayName || '')} · ${cell.itemCount} voci` : '—'}</td>`; }).join('')}
    </tr>`).join('');
  $('compare-matrix').innerHTML = `
    <p class="compare-legend"><span><b>≠ diverso</b></span><span><b>= uguale</b></span><span>Le differenze non si affidano al solo colore.</span></p>
    <div class="compare-scroll"><table class="compare-table">
      <caption>Dosi per famiglia (grammi a crudo, Pranzo/Cena · Allenamento/Riposo)</caption>
      <thead><tr><th scope="col">Famiglia</th>${head}</tr></thead>
      <tbody>${familyRows || '<tr><td colspan="9">Nessuna famiglia da confrontare.</td></tr>'}</tbody>
    </table></div>
    ${groupRows ? `<div class="compare-scroll"><table class="compare-table"><caption>Gruppi alternativi</caption><thead><tr><th scope="col">Gruppo</th>${head}</tr></thead><tbody>${groupRows}</tbody></table></div>` : ''}`;
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

// ---- Editor dieta guidata ----
// Piano descrittivo versionato (dietPlan v1): giornate, pasti, opzioni A/B/C/D,
// quantità con unità. Nessun calcolo clinico: i valori energetici sono appunti
// manuali. Il salvataggio pubblica una revisione struttura (schema 3) e
// conserva le eventuali regole classiche per il calcolo delle dosi.
function dietPlanDomain() { return window.PianoDomain || null; }

async function openDietPlanDialog(structureId = null) {
  const domain = dietPlanDomain();
  if (!domain?.createEmptyDietPlan) {
    $('structures-feedback').textContent = 'Editor non disponibile: ricarica la pagina.';
    return;
  }
  adminState.dietPlanEditingId = structureId || null;
  adminState.dietPlanRules = [];
  adminState.dietPlanGroups = [];
  $('diet-plan-id').value = '';
  $('diet-plan-name').value = '';
  $('diet-plan-general-notes').value = '';
  $('diet-plan-error').textContent = '';
  $('diet-plan-preview').classList.add('hidden');
  $('diet-plan-preview').innerHTML = '';
  $('diet-plan-preview-toggle').textContent = 'Mostra anteprima';
  $('diet-plan-classic-note').classList.add('hidden');
  if (structureId) {
    $('diet-plan-title').textContent = 'Modifica dieta guidata';
    $('diet-plan-subtitle').textContent = 'Il salvataggio pubblica una nuova revisione: le precedenti restano intatte e ripristinabili.';
    try {
      const result = await callAdminSaasFunction('getDietStructureRevision', { organizationId: orgId(), structureId });
      adminState.dietPlanEditingId = structureId;
      $('diet-plan-id').value = structureId;
      $('diet-plan-name').value = result.structure.name || '';
      adminState.dietPlanRules = result.revision.rules || [];
      adminState.dietPlanGroups = result.revision.alternativeGroups || [];
      adminState.dietPlan = domain.createEmptyDietPlan(result.revision.dietPlan || {});
      if (adminState.dietPlanRules.length) {
        const note = $('diet-plan-classic-note');
        note.textContent = `Questa dieta ha anche ${adminState.dietPlanRules.length} famiglie classiche per il calcolo delle dosi: il salvataggio le conserva. Per modificarle usa l’editor classico.`;
        note.classList.remove('hidden');
      }
    } catch (error) {
      $('structures-feedback').textContent = adminError(error);
      return;
    }
  } else {
    $('diet-plan-title').textContent = 'Nuova dieta guidata';
    $('diet-plan-subtitle').textContent = 'Giornate di allenamento e riposo, pasti con opzioni A/B/C/D, quantità con unità di misura. I valori energetici sono appunti manuali: nessun calcolo automatico.';
    adminState.dietPlan = domain.createEmptyDietPlan();
  }
  renderDietPlanDays();
  renderDietPlanPreview();
  $('diet-plan-dialog').classList.remove('hidden');
  $('diet-plan-name').focus();
}

function closeDietPlanDialog() {
  $('diet-plan-dialog').classList.add('hidden');
  adminState.dietPlan = null;
  adminState.dietPlanEditingId = null;
}

function dietPlanNumberOrNull(raw) {
  if (raw == null) return null;
  const clean = String(raw).trim().replace(',', '.');
  if (clean === '') return null;
  const number = Number(clean);
  return Number.isFinite(number) ? number : clean;
}

// Legge il modulo così com'è (senza validare): le operazioni strutturali
// (aggiungi, duplica, sposta, elimina) non devono mai perdere il digitato.
function collectDietPlan() {
  const domain = dietPlanDomain();
  const labels = domain?.DIET_PLAN_OPTION_LABELS || ['A', 'B', 'C', 'D'];
  const plan = { schemaVersion: domain?.DIET_PLAN_SCHEMA_VERSION || 1, days: [], generalNotes: $('diet-plan-general-notes').value };
  document.querySelectorAll('#diet-plan-days .diet-day').forEach(dayNode => {
    const value = selector => dayNode.querySelector(`:scope ${selector}`)?.value ?? '';
    const day = {
      dayId: null,
      label: value('[data-f="day-label"]').trim(),
      dayType: value('[data-f="day-type"]'),
      target: {
        kcal: dietPlanNumberOrNull(value('[data-f="target-kcal"]')),
        proteinG: dietPlanNumberOrNull(value('[data-f="target-protein"]')),
        carbsG: dietPlanNumberOrNull(value('[data-f="target-carbs"]')),
        fatG: dietPlanNumberOrNull(value('[data-f="target-fat"]')),
        waterMl: dietPlanNumberOrNull(value('[data-f="target-water"]'))
      },
      meals: [],
      supplements: value('[data-f="day-supplements"]').trim(),
      hydration: value('[data-f="day-hydration"]').trim(),
      note: value('[data-f="day-note"]').trim()
    };
    dayNode.querySelectorAll(':scope > .diet-meals > .diet-meal').forEach(mealNode => {
      const mealValue = selector => mealNode.querySelector(`:scope ${selector}`)?.value ?? '';
      const meal = {
        mealId: mealValue(':scope > .diet-meal-head [data-f="meal-id"]'),
        time: mealValue(':scope > .diet-meal-head [data-f="meal-time"]').trim(),
        options: [],
        note: mealNode.querySelector(':scope > [data-f="meal-note"]')?.value?.trim() || ''
      };
      mealNode.querySelectorAll(':scope > .diet-options > .diet-option').forEach((optionNode, optionIndex) => {
        const option = {
          label: labels[optionIndex] || 'A',
          items: [],
          note: optionNode.querySelector(':scope > [data-f="option-note"]')?.value?.trim() || ''
        };
        optionNode.querySelectorAll(':scope > .diet-items > .diet-item').forEach(itemNode => {
          const itemValue = selector => itemNode.querySelector(selector)?.value ?? '';
          option.items.push({
            foodGroup: itemValue('[data-f="item-group"]'),
            description: itemValue('[data-f="item-desc"]').trim(),
            quantity: dietPlanNumberOrNull(itemValue('[data-f="item-qty"]')),
            unit: itemValue('[data-f="item-unit"]'),
            quantityState: itemValue('[data-f="item-state"]') || null,
            netOfWaste: itemNode.querySelector('[data-f="item-net"]')?.checked === true,
            alternative: itemValue('[data-f="item-alt"]').trim()
          });
        });
        meal.options.push(option);
      });
      day.meals.push(meal);
    });
    plan.days.push(day);
  });
  return plan;
}

async function submitDietPlan(event) {
  event.preventDefault();
  const domain = dietPlanDomain();
  const errorEl = $('diet-plan-error');
  errorEl.textContent = '';
  const name = $('diet-plan-name').value.trim();
  if (name.length < 3) { errorEl.textContent = 'Dai un nome alla dieta (almeno 3 caratteri).'; return; }
  const plan = collectDietPlan();
  const check = domain.validateDietPlanSoft(plan);
  if (!check.valid) {
    errorEl.textContent = `${check.errors.slice(0, 3).join(' ')}${check.errors.length > 3 ? ` (altri ${check.errors.length - 3} problemi)` : ''}`;
    renderDietPlanPreview();
    return;
  }
  const structureId = $('diet-plan-id').value;
  try {
    if (structureId) {
      await callAdminSaasFunction('updateDietStructureRevision', {
        organizationId: orgId(), structureId, name,
        rules: adminState.dietPlanRules, alternativeGroups: adminState.dietPlanGroups,
        dietPlan: plan, changelog: '', restoredFromRevisionId: null, idempotencyKey: idem('dietplan')
      });
    } else {
      await callAdminSaasFunction('createDietStructure', {
        organizationId: orgId(), name, rules: [], alternativeGroups: [], dietPlan: plan, idempotencyKey: idem('dietplan')
      });
    }
    closeDietPlanDialog();
    await loadStructures();
    $('structures-feedback').textContent = structureId ? 'Nuova revisione della dieta pubblicata (la precedente resta disponibile).' : 'Dieta guidata creata e pubblicata.';
  } catch (error) { errorEl.textContent = adminError(error); }
}

function dietPlanOptions(list, current) {
  return list.map(item => `<option value="${escapeAdmin(item.id)}" ${item.id === current ? 'selected' : ''}>${escapeAdmin(item.label)}</option>`).join('');
}

function dietItemHtml(domain, item, path) {
  return `
  <div class="diet-item" data-day="${path.day}" data-meal="${path.meal}" data-option="${path.option}" data-item="${path.item}">
    <select data-f="item-group" aria-label="Gruppo alimentare">${dietPlanOptions(domain.DIET_PLAN_FOOD_GROUPS, item.foodGroup)}</select>
    <input data-f="item-desc" placeholder="Alimento (es. Riso Venere)" value="${escapeAdmin(item.description || '')}" aria-label="Alimento" maxlength="200">
    <div class="diet-qty">
      <input data-f="item-qty" type="number" min="0" max="5000" step="any" placeholder="Qtà" value="${item.quantity ?? ''}" aria-label="Quantità">
      <select data-f="item-unit" aria-label="Unità di misura">${dietPlanOptions(domain.DIET_PLAN_UNITS, item.unit || 'g')}</select>
      <select data-f="item-state" aria-label="Peso a crudo o a cotto"><option value="">—</option><option value="crudo" ${item.quantityState === 'crudo' ? 'selected' : ''}>Crudo</option><option value="cotto" ${item.quantityState === 'cotto' ? 'selected' : ''}>Cotto</option></select>
    </div>
    <label class="check-inline"><input data-f="item-net" type="checkbox" ${item.netOfWaste ? 'checked' : ''}>Al netto degli scarti</label>
    <input data-f="item-alt" placeholder="Oppure (alternativa, facoltativa)" value="${escapeAdmin(item.alternative || '')}" aria-label="Alternativa (oppure)" maxlength="200">
    <button type="button" class="dialog-close diet-del" data-act="item-del" aria-label="Rimuovi alimento">×</button>
  </div>`;
}

function dietOptionHtml(domain, option, path, label, canDelete) {
  return `
  <div class="diet-option" data-day="${path.day}" data-meal="${path.meal}" data-option="${path.option}">
    <div class="diet-option-head"><strong>Opzione ${escapeAdmin(label)}</strong><span class="diet-option-actions">
      <button type="button" class="text-button" data-act="option-dup">Duplica</button>
      ${canDelete ? '<button type="button" class="text-button danger-text" data-act="option-del">Elimina</button>' : ''}
    </span></div>
    <div class="diet-items">${option.items.map((item, itemIndex) => dietItemHtml(domain, item, { ...path, item: itemIndex })).join('')}</div>
    ${option.items.length < domain.DIET_PLAN_LIMITS.itemsPerOption ? '<button type="button" class="secondary diet-add" data-act="item-add">＋ Aggiungi alimento</button>' : ''}
    <textarea data-f="option-note" placeholder="Nota dell’opzione (facoltativa)" maxlength="1000">${escapeAdmin(option.note || '')}</textarea>
  </div>`;
}

function dietMealHtml(domain, meal, path, canDelete) {
  const labels = domain.DIET_PLAN_OPTION_LABELS;
  return `
  <article class="diet-meal" data-day="${path.day}" data-meal="${path.meal}">
    <div class="diet-meal-head">
      <select data-f="meal-id" aria-label="Pasto">${dietPlanOptions(domain.DIET_PLAN_MEALS, meal.mealId)}</select>
      <input data-f="meal-time" placeholder="Orario (es. 12:30)" value="${escapeAdmin(meal.time || '')}" aria-label="Orario" maxlength="20">
      ${canDelete ? '<button type="button" class="text-button danger-text" data-act="meal-del">Elimina pasto</button>' : ''}
    </div>
    <div class="diet-options">${meal.options.map((option, optionIndex) => dietOptionHtml(domain, option, { ...path, option: optionIndex }, labels[optionIndex] || 'A', meal.options.length > 1)).join('')}</div>
    ${meal.options.length < domain.DIET_PLAN_LIMITS.optionsPerMeal ? '<button type="button" class="secondary diet-add" data-act="option-add">＋ Aggiungi opzione</button>' : ''}
    <textarea data-f="meal-note" placeholder="Nota del pasto (facoltativa)" maxlength="1000">${escapeAdmin(meal.note || '')}</textarea>
  </article>`;
}

function dietDayHtml(domain, day, dayIndex, dayCount) {
  return `
  <article class="diet-day" data-day="${dayIndex}">
    <div class="diet-day-head">
      <strong>Giornata ${dayIndex + 1}</strong>
      <select data-f="day-type" aria-label="Tipo giornata">${domain.DIET_PLAN_DAY_TYPES.map(type => `<option value="${type}" ${day.dayType === type ? 'selected' : ''}>${escapeAdmin(domain.dietPlanDayLabel(type))}</option>`).join('')}</select>
      <input data-f="day-label" placeholder="Titolo (facoltativo)" value="${escapeAdmin(day.label || '')}" aria-label="Titolo giornata" maxlength="80">
      <span class="diet-day-actions">
        <button type="button" class="text-button" data-act="day-up" ${dayIndex === 0 ? 'disabled' : ''} aria-label="Sposta giornata su">↑</button>
        <button type="button" class="text-button" data-act="day-down" ${dayIndex === dayCount - 1 ? 'disabled' : ''} aria-label="Sposta giornata giù">↓</button>
        <button type="button" class="text-button" data-act="day-dup">Duplica</button>
        ${dayCount > 1 ? '<button type="button" class="text-button danger-text" data-act="day-del">Elimina</button>' : ''}
      </span>
    </div>
    <fieldset class="diet-targets"><legend>Valori della giornata (appunti manuali, facoltativi)</legend>
      <label>Energia (kcal)<input data-f="target-kcal" type="number" min="0" max="50000" step="any" value="${day.target?.kcal ?? ''}"></label>
      <label>Proteine (g)<input data-f="target-protein" type="number" min="0" max="50000" step="any" value="${day.target?.proteinG ?? ''}"></label>
      <label>Carboidrati (g)<input data-f="target-carbs" type="number" min="0" max="50000" step="any" value="${day.target?.carbsG ?? ''}"></label>
      <label>Grassi (g)<input data-f="target-fat" type="number" min="0" max="50000" step="any" value="${day.target?.fatG ?? ''}"></label>
      <label>Acqua (ml)<input data-f="target-water" type="number" min="0" max="50000" step="any" value="${day.target?.waterMl ?? ''}"></label>
    </fieldset>
    <div class="diet-meals">${day.meals.map((meal, mealIndex) => dietMealHtml(domain, meal, { day: dayIndex, meal: mealIndex }, day.meals.length > 1)).join('')}</div>
    ${day.meals.length < domain.DIET_PLAN_LIMITS.mealsPerDay ? '<button type="button" class="secondary diet-add" data-act="meal-add">＋ Aggiungi pasto</button>' : ''}
    <div class="form-grid">
      <label>Integrazione<textarea data-f="day-supplements" placeholder="es. Vitamina D al mattino" maxlength="1000">${escapeAdmin(day.supplements || '')}</textarea></label>
      <label>Idratazione<textarea data-f="day-hydration" placeholder="es. Almeno 2 litri d’acqua" maxlength="1000">${escapeAdmin(day.hydration || '')}</textarea></label>
    </div>
    <label>Nota della giornata<textarea data-f="day-note" placeholder="Facoltativa" maxlength="1000">${escapeAdmin(day.note || '')}</textarea></label>
  </article>`;
}

function renderDietPlanDays() {
  const domain = dietPlanDomain();
  const plan = adminState.dietPlan;
  if (!domain || !plan) return;
  $('diet-plan-general-notes').value = plan.generalNotes || '';
  $('diet-plan-days').innerHTML = plan.days.map((day, dayIndex) => dietDayHtml(domain, day, dayIndex, plan.days.length)).join('');
}

function dietPreviewItemHtml(domain, item) {
  const bits = [];
  if (item.quantity != null && item.quantity !== '') {
    bits.push(`${escapeAdmin(String(item.quantity))} ${escapeAdmin(domain.dietPlanUnitLabel(item.unit))}${item.quantityState ? ` (${escapeAdmin(item.quantityState)})` : ''}${item.netOfWaste ? ', al netto degli scarti' : ''}`);
  }
  bits.push(`<strong>${escapeAdmin(item.description || '—')}</strong>`);
  if (item.alternative) bits.push(`<em>oppure: ${escapeAdmin(item.alternative)}</em>`);
  return `<li>${bits.join(' · ')} <small>(${escapeAdmin(domain.dietPlanFoodGroupLabel(item.foodGroup))})</small></li>`;
}

function renderDietPlanPreview() {
  const domain = dietPlanDomain();
  const box = $('diet-plan-preview');
  if (!domain) return;
  const plan = collectDietPlan();
  const check = domain.validateDietPlanSoft(plan);
  const summary = domain.dietPlanSummary(plan);
  const warnings = check.valid
    ? ''
    : `<p class="callout">Bozza non ancora valida: ${check.errors.slice(0, 3).map(escapeAdmin).join(' · ')}${check.errors.length > 3 ? ` (altri ${check.errors.length - 3})` : ''}</p>`;
  box.innerHTML = `
    <p class="preview-meta">${summary.dayCount} giornate · ${summary.mealCount} pasti · ${summary.optionCount} opzioni · ${summary.itemCount} alimenti</p>
    ${warnings}
    ${plan.days.map((day, dayIndex) => {
      const target = day.target || {};
      const targetBits = [
        target.kcal != null && target.kcal !== '' ? `${escapeAdmin(String(target.kcal))} kcal` : null,
        target.proteinG != null && target.proteinG !== '' ? `P ${escapeAdmin(String(target.proteinG))} g` : null,
        target.carbsG != null && target.carbsG !== '' ? `C ${escapeAdmin(String(target.carbsG))} g` : null,
        target.fatG != null && target.fatG !== '' ? `G ${escapeAdmin(String(target.fatG))} g` : null,
        target.waterMl != null && target.waterMl !== '' ? `Acqua ${escapeAdmin(String(target.waterMl))} ml` : null
      ].filter(Boolean);
      return `<section class="preview-day"><h4>Giornata ${dayIndex + 1} — ${escapeAdmin(domain.dietPlanDayLabel(day.dayType))}${day.label ? ` · ${escapeAdmin(day.label)}` : ''}</h4>
        ${targetBits.length ? `<p class="preview-target">${targetBits.join(' · ')}</p>` : ''}
        ${(day.meals || []).map(meal => `
          <div class="preview-meal"><strong>${escapeAdmin(domain.dietPlanMealLabel(meal.mealId))}</strong>${meal.time ? ` <small>(${escapeAdmin(meal.time)})</small>` : ''}
            ${(meal.options || []).map((option, optionIndex) => `
              <div class="preview-option"><span>Opzione ${escapeAdmin(domain.DIET_PLAN_OPTION_LABELS[optionIndex] || 'A')}</span>
                <ul>${(option.items || []).map(item => dietPreviewItemHtml(domain, item)).join('')}</ul>
                ${option.note ? `<p><small>Nota: ${escapeAdmin(option.note)}</small></p>` : ''}
              </div>`).join('')}
            ${meal.note ? `<p><small>Nota pasto: ${escapeAdmin(meal.note)}</small></p>` : ''}
          </div>`).join('')}
        ${day.supplements ? `<p><small><strong>Integrazione:</strong> ${escapeAdmin(day.supplements)}</small></p>` : ''}
        ${day.hydration ? `<p><small><strong>Idratazione:</strong> ${escapeAdmin(day.hydration)}</small></p>` : ''}
        ${day.note ? `<p><small><strong>Nota:</strong> ${escapeAdmin(day.note)}</small></p>` : ''}
      </section>`;
    }).join('')}
    ${plan.generalNotes ? `<p><small><strong>Note generali:</strong> ${escapeAdmin(plan.generalNotes)}</small></p>` : ''}`;
}

// Operazioni strutturali: prima si rilegge il modulo (mai perdere il digitato),
// poi si modifica il piano e si ridisegna.
function handleDietPlanStructure(event) {
  const button = event.target.closest('[data-act]');
  if (!button || button.disabled) return;
  const domain = dietPlanDomain();
  if (!domain) return;
  const plan = collectDietPlan();
  adminState.dietPlan = plan;
  const node = button.closest('.diet-day, .diet-meal, .diet-option, .diet-item');
  const dayIndex = node?.dataset?.day != null ? Number(node.dataset.day) : -1;
  const mealIndex = node?.dataset?.meal != null ? Number(node.dataset.meal) : -1;
  const optionIndex = node?.dataset?.option != null ? Number(node.dataset.option) : -1;
  const itemIndex = node?.dataset?.item != null ? Number(node.dataset.item) : -1;
  const day = dayIndex >= 0 ? plan.days[dayIndex] : null;
  const meal = day && mealIndex >= 0 ? day.meals[mealIndex] : null;
  const option = meal && optionIndex >= 0 ? meal.options[optionIndex] : null;
  const clone = value => JSON.parse(JSON.stringify(value));
  switch (button.dataset.act) {
    case 'day-add':
      if (plan.days.length < domain.DIET_PLAN_LIMITS.days) plan.days.push(domain.createDietPlanDay('training'));
      break;
    case 'day-del':
      if (day && plan.days.length > 1) plan.days.splice(dayIndex, 1);
      break;
    case 'day-dup':
      if (day && plan.days.length < domain.DIET_PLAN_LIMITS.days) plan.days.splice(dayIndex + 1, 0, clone(day));
      break;
    case 'day-up':
      if (day && dayIndex > 0) [plan.days[dayIndex - 1], plan.days[dayIndex]] = [plan.days[dayIndex], plan.days[dayIndex - 1]];
      break;
    case 'day-down':
      if (day && dayIndex < plan.days.length - 1) [plan.days[dayIndex + 1], plan.days[dayIndex]] = [plan.days[dayIndex], plan.days[dayIndex + 1]];
      break;
    case 'meal-add':
      if (day && day.meals.length < domain.DIET_PLAN_LIMITS.mealsPerDay) day.meals.push(domain.createDietPlanMeal('lunch'));
      break;
    case 'meal-del':
      if (day && meal && day.meals.length > 1) day.meals.splice(mealIndex, 1);
      break;
    case 'option-add':
      if (meal && meal.options.length < domain.DIET_PLAN_LIMITS.optionsPerMeal) meal.options.push(domain.createDietPlanOption());
      break;
    case 'option-dup':
      if (meal && option && meal.options.length < domain.DIET_PLAN_LIMITS.optionsPerMeal) meal.options.splice(optionIndex + 1, 0, clone(option));
      break;
    case 'option-del':
      if (meal && option && meal.options.length > 1) meal.options.splice(optionIndex, 1);
      break;
    case 'item-add':
      if (option && option.items.length < domain.DIET_PLAN_LIMITS.itemsPerOption) option.items.push(domain.createDietPlanItem());
      break;
    case 'item-del':
      if (option && itemIndex >= 0 && option.items.length > 1) option.items.splice(itemIndex, 1);
      break;
    default:
      return;
  }
  renderDietPlanDays();
  renderDietPlanPreview();
}

// ---- Sezione Catalogo globale ----
// Il catalogo alimenta l'autocomplete delle Strutture dieta e la validazione
// server-side: senza catalogo il salvataggio di una struttura viene rifiutato
// ("ingrediente inesistente in catalogo"). L'import è riservato al platform
// admin e passa da `importGlobalIngredientCatalog` con due passaggi: dry-run
// (nessuna scrittura) e commit con lo stesso previewId.

function renderCatalogStatus(summary) {
  const version = Number(summary?.catalogVersion || 0);
  if (!version) {
    $('catalog-status').innerHTML = '<article class="client-card"><p class="eyebrow">CATALOGO</p><h3>Non ancora importato</h3><p>Finché il catalogo è vuoto la console non può salvare Strutture dieta: importa <span class="mono">docs/catalogo-import-meller.json</span>.</p></article>';
    return;
  }
  $('catalog-status').innerHTML = `
    <article class="client-card"><p class="eyebrow">VERSIONE</p><h3>v${version}</h3><p>${Number(summary.ingredientCount || 0)} ingredienti · ${Number(summary.categoryCount || 0)} categorie</p></article>
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

// saveMemberDisplayName rimosso: anagrafica professionista gestita solo da admin via updateMemberProfileByStaff (Sessione 1)
async function saveMemberProfileByStaff(event, userId) {
  event.preventDefault();
  const form = event.target;
  const firstName = form.querySelector('[data-member-first-name]')?.value.trim() || '';
  const lastName = form.querySelector('[data-member-last-name]')?.value.trim() || '';
  try {
    await callAdminSaasFunction('updateMemberProfileByStaff', { organizationId: orgId(), userId, firstName, lastName, idempotencyKey: idem('member-profile-' + userId) });
    $('users-feedback').textContent = 'Anagrafica aggiornata.';
    await loadUsers();
  } catch (error) { $('users-feedback').textContent = adminError(error); }
}
window.saveMemberProfileByStaff = saveMemberProfileByStaff;

function renderUsers() {
  const data = adminState.users || { members: [], clients: [], invitations: [], requests: [] };
  // Il server omette membri e inviti al nutritionist: la presenza dei membri distingue l'admin.
  const isAdmin = (data.members || []).length > 0;
  $('users-scope').textContent = isAdmin
    ? 'Solo l’admin vede e gestisce i membri.'
    : 'Come professionista vedi solo i tuoi clienti e i tuoi inviti.';
  const profileBox = document.getElementById('nutritionist-profile-form');
  if (profileBox) profileBox.innerHTML = '';
  // Il professionista non vede l'elenco membri: solo il proprio nome pubblico.
  $('members-list').style.display = isAdmin ? '' : 'none';
  $('members-list').innerHTML = (data.members || []).map(member => `
    <article class="report-row">
      <div class="report-main"><span class="ingredient-mark">⛉</span><div><strong>${escapeAdmin(([member.firstName, member.lastName].filter(Boolean).join(' ') || member.displayName || member.username || member.userId.slice(0, 8)))}</strong><small>${escapeAdmin(member.role === 'admin' ? 'Admin' : 'Professionista')}</small></div></div>
      <div class="report-meta"><small>Stato</small><strong>${escapeAdmin(memberStatusLabel(member.status))}</strong></div>
      <div class="report-meta"><small>Azioni</small><strong class="member-actions">
        ${member.status === 'active'
          ? `<button class="text-button archive-toggle" data-member-status="${escapeAdmin(member.userId)}" data-status="suspended">Sospendi</button>`
          : member.status === 'suspended' ? `<button class="text-button archive-toggle" data-member-status="${escapeAdmin(member.userId)}" data-status="active">Riattiva</button>` : ''}
        ${member.role === 'nutritionist' && member.status !== 'removed' ? `<button class="text-button archive-toggle danger-text" data-member-remove="${escapeAdmin(member.userId)}">Rimuovi</button>` : ''}
      </strong></div>
      ${member.role === 'nutritionist' ? `<form class="member-profile-form" onsubmit="saveMemberProfileByStaff(event, '${escapeAdmin(member.userId)}')"><div class="form-grid"><label>Nome<input data-member-first-name value="${escapeAdmin(member.firstName || '')}" maxlength="80" placeholder="Mario"></label><label>Cognome<input data-member-last-name value="${escapeAdmin(member.lastName || '')}" maxlength="80" placeholder="Rossi"></label></div><button class="secondary" type="submit">Salva anagrafica</button></form>` : ''}
    </article>`).join('') || '<p class="feedback">Nessun membro visibile al tuo ruolo.</p>';
  // Professionisti destinatari per l'invito cliente (solo admin).
  const nutris = (data.members || []).filter(member => member.role === 'nutritionist' && member.status === 'active');
  $('invite-client-nutritionist').innerHTML = '<option value="">Senza professionista (solo admin)</option>' +
    nutris.map(member => `<option value="${escapeAdmin(member.userId)}">${escapeAdmin(([member.firstName, member.lastName].filter(Boolean).join(' ') || member.displayName || member.username || member.userId.slice(0, 8)))}</option>`).join('');
  $('invite-client-nutri-field').style.display = isAdmin ? '' : 'none';
  if ($('invite-client-email-nutritionist')) {
    $('invite-client-email-nutritionist').innerHTML = '<option value="">Senza professionista (solo admin)</option>' +
      nutris.map(member => `<option value="${escapeAdmin(member.userId)}">${escapeAdmin(([member.firstName, member.lastName].filter(Boolean).join(' ') || member.displayName || member.username || member.userId.slice(0, 8)))}</option>`).join('');
  }
  if ($('invite-client-email-nutri-field')) $('invite-client-email-nutri-field').style.display = isAdmin ? '' : 'none';
  // Richieste di collegamento e inviti legacy: gli inviti email reali vivono
  // sulle card dei clienti (con reinvio, correzione e annullamento), qui resta
  // solo ciò che non ha una card. I titoli non mostrano mai ID tecnici.
  const clientNameFor = clientId => {
    const client = adminState.clients.find(item => item.id === clientId);
    return client ? clientLabel(client) : 'Cliente';
  };
  const pendingLinks = [...(data.requests || []).filter(item => !item.status || item.status === 'pending').map(item => ({ ...item, kind: 'request' })),
    ...(data.invitations || []).filter(item => item.type === 'client').map(item => ({ ...item, kind: 'invite' }))];
  const linksHtml = pendingLinks.map(item => `
    <article class="report-row">
      <div class="report-main"><span class="ingredient-mark">${item.kind === 'request' ? '✉' : '◈'}</span><div><strong>${escapeAdmin(item.targetUsername || item.targetEmail || clientNameFor(item.clientId))}</strong><small>${item.kind === 'request' ? `Richiesta da accettare in app · ${escapeAdmin(clientNameFor(item.clientId))}` : `Invito monouso${item.expiresAt ? ` · scade ${formatDateOnly(item.expiresAt)}` : ''} · ${escapeAdmin(clientNameFor(item.clientId))}`}</small></div></div>
      <div class="report-meta"><small>Stato</small><strong>In attesa</strong></div>
      <div class="report-meta"><small>Scheda</small><strong>${item.clientId ? `<button class="text-button" data-client-detail="${escapeAdmin(item.clientId)}">Apri scheda</button>` : '—'}</strong></div>
    </article>`).join('');
  $('links-list').innerHTML = linksHtml || '<p class="feedback">Nessun collegamento in attesa.</p>';
  const nutriInvites = (data.invitations || []).filter(item => item.type === 'nutritionist');
  if (nutriInvites.length) {
    $('links-list').insertAdjacentHTML('beforeend', nutriInvites.map(item => `
    <article class="report-row">
      <div class="report-main"><span class="ingredient-mark">◈</span><div><strong>${escapeAdmin(item.targetUsername || '—')}</strong><small>Invito professionista${item.expiresAt ? ` · scade ${formatDateOnly(item.expiresAt)}` : ''}</small></div></div>
      <div class="report-meta"><small>Stato</small><strong>In attesa di registrazione</strong></div>
      <div class="report-meta"><small>Tipo</small><strong>Nutritionist</strong></div>
    </article>`).join(''));
  }
  // Promemoria per il professionista: tutto si gestisce dalle schede qui sopra.
  if (!isAdmin && (data.clients || []).length) {
    $('links-list').insertAdjacentHTML('beforeend', '<p class="feedback">Apri la scheda di un cliente per anagrafica, collegamento, struttura dieta e rimozione.</p>');
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

// Link di registrazione pubblica: punta all'app dei clienti (index.html),
// che interpreta `#/invite/<token>` mostrando la schermata di registrazione.
function inviteLinkForToken(token) {
  return new URL(`./#/invite/${token}`, new URL('./index.html', location.href)).href;
}

async function submitClientInvite(event) {
  event.preventDefault();
  const out = $('invite-client-result');
  const linkInput = $('invite-client-link');
  linkInput.classList.add('hidden');
  linkInput.value = '';
  out.textContent = 'Invito in corso…';
  try {
    const result = await callAdminSaasFunction('inviteClientLink', {
      organizationId: orgId(), username: $('invite-client-username').value.trim(),
      nutritionistUid: $('invite-client-nutritionist').value || null,
      idempotencyKey: idem('clientlink')
    });
    if (result.status === 'invited') {
      out.textContent = `Invito monouso creato (scade ${new Date(result.expiresAt).toLocaleDateString('it-IT')}). Consegna questo link una sola volta, fuori piattaforma: il cliente registrerà l’account con lo username indicato.`;
      linkInput.value = inviteLinkForToken(result.token);
      linkInput.classList.remove('hidden');
      linkInput.focus();
      linkInput.select();
    } else if (result.status === 'already-invited') {
      out.textContent = 'Invito già esistente: il token non viene rimostrato.';
    } else {
      out.textContent = 'Richiesta inviata: il cliente accetta o rifiuta dall’app.';
    }
    $('invite-client-username').value = '';
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
  $('client-profile-lead').textContent = `${client.email || client.displayCode || 'Cliente'}: nome e cognome sono visibili al cliente e usati nel suo profilo.`;
  $('client-profile-error').textContent = '';
  $('client-profile-dialog').classList.remove('hidden');
  $('client-profile-first-name').focus();
}

function closeClientProfile() { $('client-profile-dialog').classList.add('hidden'); }

async function submitClientProfile(event) {
  event.preventDefault();
  const errorEl = $('client-profile-error');
  errorEl.textContent = '';
  try {
    await callAdminSaasFunction('updateClientProfileByStaff', {
      organizationId: orgId(),
      clientId: $('client-profile-client-id').value,
      firstName: $('client-profile-first-name').value.trim(),
      lastName: $('client-profile-last-name').value.trim(),
      idempotencyKey: idem('client-profile')
    });
    closeClientProfile();
    $('clients-feedback').textContent = 'Anagrafica aggiornata e cliente avvisato in app.';
    await loadClients();
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
  // La vista Clienti è unica: profili + team + richieste si caricano insieme.
  if (view === 'clients') { loadClients(); loadUsers(); }
  else if (view === 'doses') loadDoseClients();
  else if (view === 'structures') loadStructures();
  else if (view === 'catalog') loadCatalogStatus();
  else loadReports();
}

function bindAdmin() {
  $('admin-login-form').addEventListener('submit', async event => {
    event.preventDefault(); $('admin-login-error').textContent = '';
    try { await adminSignInWithUsername($('admin-username').value, $('admin-password').value); }
    catch (error) { $('admin-login-error').textContent = adminError(error); }
  });
  $('admin-logout').addEventListener('click', () => adminSignOutUser());
  $('refresh-reports').addEventListener('click', () => loadReports());
  $('report-status').addEventListener('change', () => loadReports());
  $('load-more-reports').addEventListener('click', () => loadReports({ append: true }));
  $('reports-list').addEventListener('click', event => { const button = event.target.closest('[data-map-report]'); if (button) openMapping(button.dataset.mapReport); });
  $('mapping-kind').addEventListener('change', () => $('guided-fields').classList.toggle('hidden', $('mapping-kind').value === 'free'));
  $('mapping-form').addEventListener('submit', submitMapping);
  document.querySelectorAll('[data-close-dialog]').forEach(node => node.addEventListener('click', closeMapping));
  $('refresh-clients').addEventListener('click', () => { loadClients(); loadUsers(); });
  $('invite-client-open').addEventListener('click', openInviteClientDialog);
  document.querySelectorAll('[data-close-invite-client]').forEach(node => node.addEventListener('click', closeInviteClientDialog));
  document.querySelectorAll('[data-close-client-detail]').forEach(node => node.addEventListener('click', closeClientDetail));
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
  $('refresh-doses').addEventListener('click', loadDoseClients);
  $('dose-client').addEventListener('change', loadClientDoseEditor);
  $('save-doses').addEventListener('click', submitDoseOverrides);
  $('preview-copy').addEventListener('click', previewDoseCopy);
  $('confirm-copy').addEventListener('click', confirmDoseCopy);
  document.querySelectorAll('.nav-link').forEach(node => node.addEventListener('click', () => showView(node.dataset.view)));
  $('refresh-structures').addEventListener('click', loadStructures);
  $('new-structure').addEventListener('click', () => openStructureDialog());
  $('new-diet-plan').addEventListener('click', () => openDietPlanDialog());
  $('diet-plan-form').addEventListener('submit', submitDietPlan);
  $('diet-plan-days').addEventListener('click', handleDietPlanStructure);
  $('diet-plan-add-day').addEventListener('click', () => {
    const domain = dietPlanDomain();
    if (!domain || !adminState.dietPlan) return;
    adminState.dietPlan = collectDietPlan();
    if (adminState.dietPlan.days.length < domain.DIET_PLAN_LIMITS.days) {
      adminState.dietPlan.days.push(domain.createDietPlanDay('training'));
    }
    renderDietPlanDays();
    renderDietPlanPreview();
  });
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
  $('structure-form').addEventListener('submit', submitStructureForm);
  $('structure-add-rule').addEventListener('click', () => { addStructureRuleRow(); fillCategorySelects(); });
  $('structure-add-group').addEventListener('click', () => addStructureGroupRow());
  bindCatalogSearch($('structure-form'), '.rule-ing-search', 'datalist', '.rule-ings, .group-item-ing');
  $('structure-rules').addEventListener('click', event => {
    const remove = event.target.closest('.rule-remove');
    if (remove) remove.closest('.structure-rule').remove();
  });
  $('structure-groups').addEventListener('click', event => {
    const removeGroup = event.target.closest('.group-remove');
    if (removeGroup) { removeGroup.closest('.structure-group').remove(); return; }
    const removeItem = event.target.closest('.group-item-remove');
    if (removeItem) { removeItem.closest('.group-item').remove(); return; }
    const addItem = event.target.closest('.group-add-item');
    if (addItem) addItem.closest('.structure-group').querySelector('.group-items').insertAdjacentHTML('beforeend', groupItemRow());
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
  $('structure-load-revision').addEventListener('click', loadStructureRevision);
  document.querySelectorAll('[data-close-structure]').forEach(node => node.addEventListener('click', closeStructureDialog));
  $('catalog-picker-search').addEventListener('input', event => renderCatalogPicker(event.target.value));
  $('catalog-picker-list').addEventListener('change', event => {
    const box = event.target.closest('[data-picker-ing]');
    if (!box) return;
    if (box.checked) adminState.pickerSelection.add(box.dataset.pickerIng);
    else adminState.pickerSelection.delete(box.dataset.pickerIng);
    updatePickerCount();
  });
  $('picker-clear').addEventListener('click', () => { adminState.pickerSelection.clear(); renderCatalogPicker($('catalog-picker-search').value); updatePickerCount(); });
  $('picker-group').addEventListener('click', openGroupDialog);
  document.querySelectorAll('input[name="group-dest"]').forEach(radio => radio.addEventListener('change', toggleGroupDestination));
  $('group-target').addEventListener('change', toggleNewGroupFields);
  $('group-form').addEventListener('submit', submitGrouping);
  document.querySelectorAll('[data-close-group]').forEach(node => node.addEventListener('click', closeGroupDialog));
  $('refresh-catalog').addEventListener('click', loadCatalogStatus);
  $('catalog-dry-run').addEventListener('click', analyzeCatalogFile);
  $('catalog-commit').addEventListener('click', commitCatalogImport);
  $('catalog-file').addEventListener('change', () => { $('catalog-report').innerHTML = ''; $('catalog-commit').disabled = true; adminState.catalogPreview = null; });
  document.querySelectorAll('[data-verify-username]').forEach(node => node.addEventListener('click', () => verifyUsername(node.dataset.verifyUsername, node.dataset.verifyOut)));
  $('invite-nutritionist-form').addEventListener('submit', submitNutritionistInvite);
  $('invite-client-form').addEventListener('submit', submitClientInvite);
  $('invite-client-email-form')?.addEventListener('submit', submitClientEmailInvite);
  $('invite-fix-form')?.addEventListener('submit', submitInviteFix);
  $('client-profile-form')?.addEventListener('submit', submitClientProfile);
  $('email-change-form')?.addEventListener('submit', submitEmailChange);
  document.querySelectorAll('[data-close-invite-fix]').forEach(node => node.addEventListener('click', closeInviteFix));
  document.querySelectorAll('[data-close-invite-link]').forEach(node => node.addEventListener('click', closeInviteLinkDialog));
  $('invite-link-copy')?.addEventListener('click', copyInviteLink);
  $('invite-link-share')?.addEventListener('click', shareInviteLink);
  document.querySelectorAll('[data-close-client-profile]').forEach(node => node.addEventListener('click', closeClientProfile));
  document.querySelectorAll('[data-close-email-change]').forEach(node => node.addEventListener('click', closeEmailChange));
  $('links-list')?.addEventListener('click', handleClientActions);
  $('members-list').addEventListener('click', event => {
    const statusButton = event.target.closest('[data-member-status]');
    if (statusButton) { changeMemberStatus(statusButton.dataset.memberStatus, statusButton.dataset.status); return; }
    const removeButton = event.target.closest('[data-member-remove]');
    if (removeButton) removeNutritionist(removeButton.dataset.memberRemove);
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
    $('nav-catalog').classList.add('hidden');
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
  $('nav-catalog').classList.toggle('hidden', !adminState.isCreator);
  const name = usernameFromUser(user) || 'Professionista';
  $('admin-name').textContent = name; $('admin-avatar').textContent = name.slice(0, 1).toUpperCase();
  // Landing: la vista Clienti è la porta d'ingresso della console.
  showView('clients');
});
