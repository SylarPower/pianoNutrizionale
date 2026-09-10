'use strict';

const adminState = { user: null, reports: [], clients: [], ruleSets: [], structures: [], editingStructure: null, cursor: null, selectedReport: null };
const $ = id => document.getElementById(id);
const escapeAdmin = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
const orgId = () => $('organization-id').value.trim();
const isoFromLocal = value => value ? new Date(value).toISOString() : null;
const idem = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

function adminError(error) {
  const code = String(error?.code || '').replace('functions/', '');
  if (code === 'permission-denied') return 'Non hai i permessi per questa operazione.';
  if (code === 'failed-precondition') return error.message || 'Controlla versione e checksum.';
  if (code === 'resource-exhausted') return 'Troppe richieste. Attendi qualche minuto.';
  return error?.message || 'Operazione non riuscita. Riprova.';
}

function saveOrg() { localStorage.setItem('piano_admin_org', orgId()); }

async function loadReports({ append = false } = {}) {
  if (!orgId()) { $('report-feedback').textContent = 'Inserisci l’organizzazione per vedere la coda.'; return; }
  $('report-feedback').textContent = 'Aggiornamento sicuro della coda…';
  try {
    const result = await callSaasFunction('listMappingReports', {
      organizationId: orgId(), status: $('report-status').value || undefined,
      pageSize: 25, cursor: append ? adminState.cursor : undefined
    });
    adminState.reports = append ? adminState.reports.concat(result.reports || []) : (result.reports || []);
    adminState.cursor = result.nextCursor || null;
    renderReports(); saveOrg();
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
    const proposal = await callSaasFunction('proposeMapping', {
      organizationId: orgId(), reportId: $('mapping-report-id').value, mapping,
      rationale: $('mapping-rationale').value, idempotencyKey: idem('proposal')
    });
    await callSaasFunction('publishMapping', {
      organizationId: orgId(), proposalId: proposal.proposalId,
      targetScope: $('mapping-global').checked ? 'global' : 'tenant', idempotencyKey: idem('publish')
    });
    closeMapping(); await loadReports();
    $('report-feedback').textContent = 'Mapping pubblicato. La ricetta originale dei clienti non è stata modificata.';
  } catch (error) { $('mapping-error').textContent = adminError(error); }
  finally { button.disabled = false; }
}

async function loadClients() {
  if (!orgId()) { $('clients-feedback').textContent = 'Inserisci l’organizzazione.'; return; }
  $('clients-feedback').textContent = 'Caricamento profili autorizzati…';
  try {
    const result = await callSaasFunction('listAuthorizedClients', { organizationId: orgId() });
    adminState.clients = result.clients || []; renderClients(); saveOrg();
    $('clients-feedback').textContent = adminState.clients.length ? '' : 'Nessun cliente autorizzato.';
  } catch (error) { $('clients-feedback').textContent = adminError(error); adminState.clients = []; renderClients(); }
}

function renderClients() {
  $('clients-list').innerHTML = adminState.clients.map(client => `<article class="client-card"><p class="eyebrow">CLIENTE</p><h3>${escapeAdmin(client.displayCode)}</h3><p>${client.activeAssignment ? `Profilo ${escapeAdmin(client.activeAssignment.ruleSet?.ruleSetId || 'assegnato')} · v${escapeAdmin(client.activeAssignment.ruleSet?.version || '')}` : 'Nessun profilo attivo · dosi originali'}</p><button class="secondary" data-assign-client="${escapeAdmin(client.id)}">${client.activeAssignment ? 'Cambia profilo' : 'Assegna profilo'} →</button></article>`).join('');
}

async function loadRuleSetsList() {
  if (!orgId()) { adminState.ruleSets = []; return; }
  try {
    const result = await callSaasFunction('listRuleSets', { organizationId: orgId() });
    adminState.ruleSets = result.ruleSets || [];
  } catch (error) { adminState.ruleSets = []; $('assignment-error').textContent = adminError(error); }
  renderRuleSetOptions();
}

function renderRuleSetOptions() {
  const format = iso => iso ? new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  $('assignment-structure-list').innerHTML = adminState.ruleSets
    .map(item => `<option value="${escapeAdmin(item.ruleSetId)}">${item.updatedAt ? `ultima modifica ${format(item.updatedAt)}` : 'nessuna modifica nota'}</option>`)
    .join('');
}

async function openAssignment(clientId) {
  const client = adminState.clients.find(item => item.id === clientId); if (!client) return;
  $('assignment-client-id').value = client.id; $('assignment-client').textContent = client.displayCode;
  const inOneHour = new Date(Date.now() + 3600000); inOneHour.setMinutes(0, 0, 0);
  $('assignment-effective').value = inOneHour.toISOString().slice(0, 16);
  $('assignment-structure').value = ''; $('assignment-expires').value = '';
  $('assignment-no-expiry').checked = false; $('assignment-expires').disabled = false;
  $('assignment-notes').value = '';
  $('assignment-error').textContent = ''; $('assignment-dialog').classList.remove('hidden');
  await loadRuleSetsList();
  $('assignment-structure').focus();
}
function closeAssignment() { $('assignment-dialog').classList.add('hidden'); }

async function submitAssignment(event) {
  event.preventDefault(); $('assignment-error').textContent = '';
  const withoutExpiration = $('assignment-no-expiry').checked;
  const expiresRaw = $('assignment-expires').value;
  if (!withoutExpiration && !expiresRaw) { $('assignment-error').textContent = 'Indica una scadenza oppure seleziona "Senza scadenza".'; return; }
  const ruleSetId = $('assignment-structure').value.trim();
  if (!adminState.ruleSets.some(item => item.ruleSetId === ruleSetId)) { $('assignment-error').textContent = 'Scegli una struttura dieta dall’elenco.'; return; }
  try {
    const result = await callSaasFunction('assignClientStructure', {
      organizationId: orgId(), clientId: $('assignment-client-id').value,
      ruleSetId,
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

// ---- Sezione Strutture dieta ----
// Il nutritionist vede solo le proprie strutture (filtro server-side); l'admin
// org le vede tutte. Ogni salvataggio pubblica una nuova revisione immutabile:
// nessun campo "Versione" esiste in UI, le date sono di sola lettura.

const canonicalId = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function loadStructures() {
  if (!orgId()) { $('structures-feedback').textContent = 'Inserisci l’organizzazione.'; return; }
  $('structures-feedback').textContent = 'Caricamento strutture…';
  try {
    const result = await callSaasFunction('listDietStructures', { organizationId: orgId() });
    adminState.structures = result.structures || [];
    saveOrg(); renderStructures();
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
      <p>${Number(item.ruleCount ?? 0)} famiglie · revisione n. ${escapeAdmin(String(item.currentRevisionId || '—'))}</p>
      <p class="structure-dates"><small>Creata il ${formatDateOnly(item.createdAt)} · ultima modifica ${formatDateOnly(item.updatedAt)}</small></p>
      <div class="card-actions">
        <button class="secondary" data-edit-structure="${escapeAdmin(item.id)}" ${item.status === 'archived' ? 'disabled' : ''}>Modifica →</button>
        <button class="text-button archive-toggle" data-archive-structure="${escapeAdmin(item.id)}" data-archived="${item.status === 'archived' ? '1' : '0'}">${item.status === 'archived' ? 'Riattiva' : 'Archivia'}</button>
      </div>
    </article>`).join('') || '<p class="feedback">Nessuna struttura registrata.</p>';
}

function structureRuleRow(rule = {}) {
  const q = meal => rule.quantityGrams?.[meal] || {};
  return `
  <div class="structure-rule">
    <div class="rule-head">
      <input class="rule-family" required placeholder="Famiglia (es. riso)" value="${escapeAdmin(rule.mellerFamilyId || '')}">
      <input class="rule-ings" placeholder="Ingredienti (nomi separati da virgola)" value="${escapeAdmin((rule.ingredientIds || []).join(', '))}">
      <label><input type="checkbox" class="rule-enabled" ${rule.enabled === false ? '' : 'checked'}>Attiva</label>
      <button type="button" class="dialog-close rule-remove" aria-label="Rimuovi regola">×</button>
    </div>
    <div class="rule-doses">
      <label>Pranzo · Allenamento<input class="rule-la" type="number" min="1" max="2000" step="1" placeholder="g" value="${q('lunch').training ?? ''}"></label>
      <label>Pranzo · Riposo<input class="rule-lr" type="number" min="1" max="2000" step="1" placeholder="g" value="${q('lunch').rest ?? ''}"></label>
      <label>Cena · Allenamento<input class="rule-ca" type="number" min="1" max="2000" step="1" placeholder="g" value="${q('dinner').training ?? ''}"></label>
      <label>Cena · Riposo<input class="rule-cr" type="number" min="1" max="2000" step="1" placeholder="g" value="${q('dinner').rest ?? ''}"></label>
    </div>
  </div>`;
}

function addStructureRuleRow(rule) {
  $('structure-rules').insertAdjacentHTML('beforeend', structureRuleRow(rule));
}

function collectStructureRules() {
  const rows = [...$('structure-rules').querySelectorAll('.structure-rule')];
  const dose = (row, cls) => { const raw = row.querySelector(cls).value; return raw === '' ? null : Number(raw); };
  const rules = rows.map((row, index) => {
    const mellerFamilyId = canonicalId(row.querySelector('.rule-family').value);
    if (!mellerFamilyId) throw new Error(`Regola ${index + 1}: indica il nome della famiglia Meller.`);
    const quantityGrams = {
      lunch: dose(row, '.rule-la') == null && dose(row, '.rule-lr') == null ? null : { training: dose(row, '.rule-la'), rest: dose(row, '.rule-lr') },
      dinner: dose(row, '.rule-ca') == null && dose(row, '.rule-cr') == null ? null : { training: dose(row, '.rule-ca'), rest: dose(row, '.rule-cr') }
    };
    if (!quantityGrams.lunch && !quantityGrams.dinner) throw new Error(`Regola ${index + 1} (${mellerFamilyId}): almeno una dose per pranzo o cena.`);
    for (const meal of ['lunch', 'dinner']) for (const day of ['training', 'rest']) {
      const value = quantityGrams[meal]?.[day];
      if (value != null && (!Number.isInteger(value) || value < 1 || value > 2000)) throw new Error(`Regola ${index + 1} (${mellerFamilyId}): le dosi devono essere interi tra 1 e 2000.`);
    }
    const ingredientIds = row.querySelector('.rule-ings').value.split(',').map(part => canonicalId(part)).filter(Boolean);
    return { mellerFamilyId, ingredientIds, quantityGrams, enabled: row.querySelector('.rule-enabled').checked };
  });
  const families = new Set();
  rules.forEach(rule => { if (families.has(rule.mellerFamilyId)) throw new Error(`Famiglia duplicata: ${rule.mellerFamilyId}`); families.add(rule.mellerFamilyId); });
  if (!rules.length) throw new Error('Aggiungi almeno una famiglia Meller.');
  return rules;
}

async function openStructureDialog(structureId = null) {
  adminState.editingStructure = null;
  $('structure-id').value = ''; $('structure-name').value = ''; $('structure-rules').innerHTML = '';
  $('structure-changelog').value = ''; $('structure-error').textContent = '';
  $('structure-restore-field').classList.add('hidden');
  $('structure-restore-rev').value = '';
  addStructureRuleRow();
  if (structureId) {
    $('structure-title').textContent = 'Modifica struttura';
    $('structure-subtitle').textContent = 'Il salvataggio pubblica una nuova revisione: le precedenti restano intatte e ripristinabili.';
    try {
      const result = await callSaasFunction('getDietStructureRevision', { organizationId: orgId(), structureId });
      adminState.editingStructure = result;
      $('structure-id').value = structureId;
      $('structure-name').value = result.structure.name || '';
      $('structure-restore-field').classList.remove('hidden');
      $('structure-rules').innerHTML = '';
      (result.revision.rules || []).forEach(addStructureRuleRow);
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
    const result = await callSaasFunction('getDietStructureRevision', { organizationId: orgId(), structureId, revisionId: String(rev) });
    $('structure-rules').innerHTML = '';
    (result.revision.rules || []).forEach(addStructureRuleRow);
    $('structure-changelog').value = `Ripristino dalla revisione ${rev}`;
    $('structure-error').textContent = '';
  } catch (error) { $('structure-error').textContent = adminError(error); }
}

async function submitStructureForm(event) {
  event.preventDefault(); $('structure-error').textContent = '';
  let rules;
  try { rules = collectStructureRules(); } catch (error) { $('structure-error').textContent = error.message; return; }
  const structureId = $('structure-id').value;
  const restoredFrom = $('structure-restore-rev').value;
  try {
    if (structureId) {
      await callSaasFunction('updateDietStructureRevision', {
        organizationId: orgId(), structureId, name: $('structure-name').value.trim(),
        rules, changelog: $('structure-changelog').value.trim() || null,
        restoredFromRevisionId: restoredFrom ? String(Number(restoredFrom)) : null,
        idempotencyKey: idem('structure')
      });
    } else {
      await callSaasFunction('createDietStructure', {
        organizationId: orgId(), name: $('structure-name').value.trim(), rules, idempotencyKey: idem('structure')
      });
    }
    closeStructureDialog(); await loadStructures();
    $('structures-feedback').textContent = structureId ? 'Nuova revisione pubblicata (la precedente resta disponibile per il ripristino).' : 'Struttura creata e pubblicata.';
  } catch (error) { $('structure-error').textContent = adminError(error); }
}

async function toggleStructureArchive(structureId, archived) {
  $('structures-feedback').textContent = '';
  try {
    await callSaasFunction('archiveDietStructure', { organizationId: orgId(), structureId, archived, idempotencyKey: idem('structure-status') });
    await loadStructures();
    $('structures-feedback').textContent = archived ? 'Struttura archiviata (soft-delete): non è più assegnabile ma resta consultabile.' : 'Struttura riattivata.';
  } catch (error) { $('structures-feedback').textContent = adminError(error); }
}

function showView(view) {
  document.querySelectorAll('.console-view').forEach(node => node.classList.toggle('hidden', node.id !== `view-${view}`));
  document.querySelectorAll('.nav-link').forEach(node => node.classList.toggle('active', node.dataset.view === view));
  document.querySelector('.sidebar').classList.remove('open');
  if (view === 'clients') loadClients(); else if (view === 'structures') loadStructures(); else loadReports();
}

function bindAdmin() {
  $('admin-login-form').addEventListener('submit', async event => {
    event.preventDefault(); $('admin-login-error').textContent = '';
    try { await signInWithUsername($('admin-username').value, $('admin-password').value); }
    catch (error) { $('admin-login-error').textContent = adminError(error); }
  });
  $('admin-logout').addEventListener('click', () => signOutUser());
  $('organization-id').value = localStorage.getItem('piano_admin_org') || '';
  $('organization-id').addEventListener('change', () => { saveOrg(); loadReports(); });
  $('refresh-reports').addEventListener('click', () => loadReports());
  $('report-status').addEventListener('change', () => loadReports());
  $('load-more-reports').addEventListener('click', () => loadReports({ append: true }));
  $('reports-list').addEventListener('click', event => { const button = event.target.closest('[data-map-report]'); if (button) openMapping(button.dataset.mapReport); });
  $('mapping-kind').addEventListener('change', () => $('guided-fields').classList.toggle('hidden', $('mapping-kind').value === 'free'));
  $('mapping-form').addEventListener('submit', submitMapping);
  document.querySelectorAll('[data-close-dialog]').forEach(node => node.addEventListener('click', closeMapping));
  $('refresh-clients').addEventListener('click', loadClients);
  $('clients-list').addEventListener('click', event => { const button = event.target.closest('[data-assign-client]'); if (button) openAssignment(button.dataset.assignClient); });
  $('assignment-form').addEventListener('submit', submitAssignment);
  $('assignment-no-expiry').addEventListener('change', () => { $('assignment-expires').disabled = $('assignment-no-expiry').checked; if ($('assignment-no-expiry').checked) $('assignment-expires').value = ''; });
  document.querySelectorAll('[data-close-assignment]').forEach(node => node.addEventListener('click', closeAssignment));
  document.querySelectorAll('.nav-link').forEach(node => node.addEventListener('click', () => showView(node.dataset.view)));
  $('refresh-structures').addEventListener('click', loadStructures);
  $('new-structure').addEventListener('click', () => openStructureDialog());
  $('structures-list').addEventListener('click', event => {
    const edit = event.target.closest('[data-edit-structure]');
    if (edit) { openStructureDialog(edit.dataset.editStructure); return; }
    const archive = event.target.closest('[data-archive-structure]');
    if (archive) toggleStructureArchive(archive.dataset.archiveStructure, archive.dataset.archived !== '1');
  });
  $('structure-form').addEventListener('submit', submitStructureForm);
  $('structure-add-rule').addEventListener('click', () => addStructureRuleRow());
  $('structure-rules').addEventListener('click', event => {
    const remove = event.target.closest('.rule-remove');
    if (remove) remove.closest('.structure-rule').remove();
  });
  $('structure-load-revision').addEventListener('click', loadStructureRevision);
  document.querySelectorAll('[data-close-structure]').forEach(node => node.addEventListener('click', closeStructureDialog));
  $('mobile-menu').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
}

bindAdmin();
if (!initFirebase()) $('admin-login-error').textContent = 'Firebase non disponibile.';
observeAuthState(user => {
  adminState.user = user;
  $('admin-login').classList.toggle('hidden', Boolean(user));
  $('admin-app').classList.toggle('hidden', !user);
  if (user) {
    const name = usernameFromUser(user) || 'Professionista';
    $('admin-name').textContent = name; $('admin-avatar').textContent = name.slice(0, 1).toUpperCase();
    // Landing: la vista Clienti è la porta d'ingresso della console.
    showView('clients');
  }
});
