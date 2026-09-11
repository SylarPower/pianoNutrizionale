'use strict';

const adminState = { user: null, reports: [], clients: [], ruleSets: [], structures: [], studioRecipes: [], compareSelection: new Set(), users: null, editingStructure: null, cursor: null, selectedReport: null, workspace: null };
let catalogIndexCache = null;
let catalogCategoriesCache = [];
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
  if (code === 'not-found' || code === 'unimplemented') return 'Backend della console non aggiornato: ripubblicare le Cloud Functions.';
  return error?.message || 'Operazione non riuscita. Riprova.';
}

function saveOrg() { localStorage.setItem('piano_admin_org', orgId()); }

async function loadReports({ append = false } = {}) {
  if (!orgId()) { $('report-feedback').textContent = 'Inserisci l’organizzazione per vedere la coda.'; return; }
  $('report-feedback').textContent = 'Aggiornamento sicuro della coda…';
  try {
    const result = await callAdminSaasFunction('listMappingReports', {
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
  if (!orgId()) { $('clients-feedback').textContent = 'Inserisci l’organizzazione.'; return; }
  $('clients-feedback').textContent = 'Caricamento profili autorizzati…';
  try {
    const result = await callAdminSaasFunction('listAuthorizedClients', { organizationId: orgId() });
    adminState.clients = result.clients || []; renderClients(); saveOrg();
    $('clients-feedback').textContent = adminState.clients.length ? '' : 'Nessun cliente autorizzato.';
  } catch (error) { $('clients-feedback').textContent = adminError(error); adminState.clients = []; renderClients(); }
}

function assignmentSummary(client) {
  const active = client.activeAssignment;
  if (!active) return 'Nessun profilo attivo · dosi originali';
  if (active.structureId) return `Struttura ${active.structureName || active.structureId}`;
  return `Profilo ${active.ruleSet?.ruleSetId || 'assegnato'} · v${active.ruleSet?.version || ''}`;
}

function renderClients() {
  $('clients-list').innerHTML = adminState.clients.map(client => `<article class="client-card"><p class="eyebrow">CLIENTE</p><h3>${escapeAdmin(client.displayCode)}</h3><p>${escapeAdmin(assignmentSummary(client))}</p><div class="card-actions"><button class="secondary" data-assign-client="${escapeAdmin(client.id)}">${client.activeAssignment ? 'Cambia profilo' : 'Assegna profilo'} →</button><button class="secondary" data-manage-client="${escapeAdmin(client.id)}">Gestisci →</button>${client.status && client.status !== 'active' ? '' : `<button class="text-button archive-toggle" data-unlink-client="${escapeAdmin(client.id)}" data-display="${escapeAdmin(client.displayCode)}">Rimuovi collegamento</button>`}</div></article>`).join('');
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
  $('assignment-client-id').value = client.id; $('assignment-client').textContent = client.displayCode;
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
  const [ings, cats] = await Promise.all([
    adminGetDocsQuery(adminQueryLimit(adminCollectionAt('globalIngredientCatalog/current/ingredients'), 500)),
    adminGetDocsQuery(adminQueryLimit(adminCollectionAt('globalIngredientCatalog/current/categories'), 100))
  ]);
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

async function loadStructures() {
  if (!orgId()) { $('structures-feedback').textContent = 'Inserisci l’organizzazione.'; return; }
  $('structures-feedback').textContent = 'Caricamento strutture…';
  try {
    const result = await callAdminSaasFunction('listDietStructures', { organizationId: orgId() });
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
      <input class="rule-family" required placeholder="Famiglia (es. riso)" value="${escapeAdmin(rule.mellerFamilyId || '')}" aria-label="Famiglia Meller">
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

function collectStructureRules() {
  const rows = [...$('structure-rules').querySelectorAll('.structure-rule')];
  const dose = (row, cls) => { const raw = row.querySelector(cls).value; return raw === '' ? null : Number(raw); };
  const rules = rows.map((row, index) => {
    const typedFamily = row.querySelector('.rule-family').value;
    const mellerFamilyId = engineFamilyId(typedFamily);
    if (!mellerFamilyId) throw new Error(`Regola ${index + 1}: la famiglia "${typedFamily.trim() || '?'}" non esiste nel motore Meller.`);
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
  if (!rules.length) throw new Error('Aggiungi almeno una famiglia Meller.');
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

async function openStructureDialog(structureId = null) {
  adminState.editingStructure = null;
  $('structure-id').value = ''; $('structure-name').value = ''; $('structure-rules').innerHTML = '';
  $('structure-groups').innerHTML = '';
  $('structure-changelog').value = ''; $('structure-error').textContent = '';
  $('structure-tech-details').classList.add('hidden');
  $('structure-restore-field').classList.add('hidden');
  $('structure-restore-rev').value = '';
  try { await loadCatalogIndex(); } catch (_) { /* autocomplete non disponibile offline */ }
  fillCategorySelects();
  addStructureRuleRow();
  if (structureId) {
    $('structure-title').textContent = 'Modifica struttura';
    $('structure-subtitle').textContent = 'Il salvataggio pubblica una nuova revisione: le precedenti restano intatte e ripristinabili.';
    try {
      const result = await callAdminSaasFunction('getDietStructureRevision', { organizationId: orgId(), structureId });
      adminState.editingStructure = result;
      $('structure-id').value = structureId;
      $('structure-name').value = result.structure.name || '';
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
        rules, alternativeGroups, changelog: $('structure-changelog').value.trim() || null,
        restoredFromRevisionId: restoredFrom ? String(Number(restoredFrom)) : null,
        idempotencyKey: idem('structure')
      });
    } else {
      await callAdminSaasFunction('createDietStructure', {
        organizationId: orgId(), name: $('structure-name').value.trim(), rules, alternativeGroups, idempotencyKey: idem('structure')
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
      <caption>Dosi per famiglia Meller (grammi a crudo, Pranzo/Cena · Allenamento/Riposo)</caption>
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

async function loadUsers() {
  if (!orgId()) { $('users-feedback').textContent = 'Inserisci l’organizzazione.'; return; }
  $('users-feedback').textContent = 'Caricamento utenti autorizzati…';
  try {
    const result = await callAdminSaasFunction('listOrganizationUsers', { organizationId: orgId() });
    adminState.users = result;
    saveOrg();
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

function renderUsers() {
  const data = adminState.users || { members: [], clients: [], invitations: [], requests: [] };
  // Il server omette membri e inviti al nutritionist: la presenza dei membri distingue l'admin.
  const isAdmin = (data.members || []).length > 0;
  $('users-scope').textContent = isAdmin
    ? 'Solo l’admin vede e gestisce i membri.'
    : 'Come professionista vedi solo i tuoi clienti e i tuoi inviti.';
  $('members-list').innerHTML = (data.members || []).map(member => `
    <article class="report-row">
      <div class="report-main"><span class="ingredient-mark">⛉</span><div><strong>${escapeAdmin(member.username || member.userId.slice(0, 8))}</strong><small>${escapeAdmin(member.role === 'admin' ? 'Admin' : 'Professionista')}</small></div></div>
      <div class="report-meta"><small>Stato</small><strong>${escapeAdmin(memberStatusLabel(member.status))}</strong></div>
      <div class="report-meta"><small>Azioni</small><strong class="member-actions">
        ${member.status === 'active'
          ? `<button class="text-button archive-toggle" data-member-status="${escapeAdmin(member.userId)}" data-status="suspended">Sospendi</button>`
          : member.status === 'suspended' ? `<button class="text-button archive-toggle" data-member-status="${escapeAdmin(member.userId)}" data-status="active">Riattiva</button>` : ''}
        ${member.role === 'nutritionist' && member.status !== 'removed' ? `<button class="text-button archive-toggle danger-text" data-member-remove="${escapeAdmin(member.userId)}">Rimuovi</button>` : ''}
      </strong></div>
    </article>`).join('') || '<p class="feedback">Nessun membro visibile al tuo ruolo.</p>';
  // Professionisti destinatari per l'invito cliente (solo admin).
  const nutris = (data.members || []).filter(member => member.role === 'nutritionist' && member.status === 'active');
  $('invite-client-nutritionist').innerHTML = '<option value="">Senza professionista (solo admin)</option>' +
    nutris.map(member => `<option value="${escapeAdmin(member.userId)}">${escapeAdmin(member.username || member.userId.slice(0, 8))}</option>`).join('');
  $('invite-client-nutri-field').style.display = isAdmin ? '' : 'none';
  const pendingLinks = [...(data.requests || []).map(item => ({ ...item, kind: 'request' })),
    ...(data.invitations || []).filter(item => item.type === 'client').map(item => ({ ...item, kind: 'invite' }))];
  $('links-list').innerHTML = pendingLinks.map(item => `
    <article class="report-row">
      <div class="report-main"><span class="ingredient-mark">${item.kind === 'request' ? '✉' : '◈'}</span><div><strong>${escapeAdmin(item.targetUsername || '—')}</strong><small>${item.kind === 'request' ? 'Richiesta da accettare in app' : `Invito monouso${item.expiresAt ? ` · scade ${formatDateOnly(item.expiresAt)}` : ''}`}</small></div></div>
      <div class="report-meta"><small>Stato</small><strong>In attesa</strong></div>
      <div class="report-meta"><small>Cliente</small><strong>${escapeAdmin(item.clientId ? item.clientId.slice(0, 8) : '—')}</strong></div>
    </article>`).join('') || '<p class="feedback">Nessun collegamento in attesa.</p>';
  const nutriInvites = (data.invitations || []).filter(item => item.type === 'nutritionist');
  if (nutriInvites.length) {
    $('links-list').insertAdjacentHTML('beforeend', nutriInvites.map(item => `
    <article class="report-row">
      <div class="report-main"><span class="ingredient-mark">◈</span><div><strong>${escapeAdmin(item.targetUsername || '—')}</strong><small>Invito professionista${item.expiresAt ? ` · scade ${formatDateOnly(item.expiresAt)}` : ''}</small></div></div>
      <div class="report-meta"><small>Stato</small><strong>In attesa di registrazione</strong></div>
      <div class="report-meta"><small>Tipo</small><strong>Nutritionist</strong></div>
    </article>`).join(''));
  }
  // Clienti del professionista: elenco con revoca associazione.
  if (!isAdmin && (data.clients || []).length) {
    $('links-list').insertAdjacentHTML('beforeend', `<p class="feedback">I tuoi clienti si gestiscono dalla vista Clienti (assegnazione e rimozione collegamento).</p>`);
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

async function submitClientInvite(event) {
  event.preventDefault();
  const out = $('invite-client-result');
  out.textContent = 'Invito in corso…';
  try {
    const result = await callAdminSaasFunction('inviteClientLink', {
      organizationId: orgId(), username: $('invite-client-username').value.trim(),
      nutritionistUid: $('invite-client-nutritionist').value || null,
      idempotencyKey: idem('clientlink')
    });
    if (result.status === 'invited') {
      out.textContent = `Account non ancora registrato: invito monouso creato (scade ${new Date(result.expiresAt).toLocaleDateString('it-IT')}). Token da consegnare una sola volta: ${result.token}`;
    } else if (result.status === 'already-invited') {
      out.textContent = 'Invito già esistente: il token non viene rimostrato.';
    } else {
      out.textContent = 'Richiesta inviata: il cliente accetta o rifiuta dall’app.';
    }
    $('invite-client-username').value = '';
    await loadUsers();
  } catch (error) { out.textContent = adminError(error); }
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
    await loadClients();
    $('clients-feedback').textContent = 'Collegamento rimosso: il cliente torna alle dosi originali e perde la Spesa inclusa.';
  } catch (error) { $('unlink-error').textContent = adminError(error); }
}

// ---- Ricette studio + gestione cliente (PASSO 4) ----
// Il catalogo studio è condiviso dall'organizzazione; le copie assegnate
// vivono nel catalogo del cliente con marcatore origin 'org' (sola lettura
// in app, "Duplica come mia"). Le ricette senza marcatore sono personali:
// assegnazione, rimozione e copia non le toccano mai.

const SLOT_LABELS = { lunch: 'Pranzo', dinner: 'Cena', breakfast: 'Colazione', snack1: 'Spuntino', snack2: 'Merenda' };

async function loadStudio() {
  if (!orgId()) { $('studio-feedback').textContent = 'Inserisci l’organizzazione.'; return; }
  $('studio-feedback').textContent = 'Caricamento catalogo studio…';
  try {
    const result = await callAdminSaasFunction('listStudioRecipes', { organizationId: orgId() });
    adminState.studioRecipes = result.recipes || []; saveOrg(); renderStudio();
    $('studio-feedback').textContent = adminState.studioRecipes.length ? '' : 'Catalogo vuoto: crea la prima ricetta.';
  } catch (error) { $('studio-feedback').textContent = adminError(error); adminState.studioRecipes = []; renderStudio(); }
}

function renderStudio() {
  $('studio-list').innerHTML = adminState.studioRecipes.map(item => `
    <article class="client-card ${item.status === 'archived' ? 'structure-archived' : ''}">
      <p class="eyebrow">RICETTA STUDIO${item.status === 'archived' ? ' · ARCHIVIATA' : ''}</p>
      <h3>${escapeAdmin(item.emoji || '🍲')} ${escapeAdmin(item.name)}</h3>
      <p>${escapeAdmin(SLOT_LABELS[item.slot] || item.slot || '')} · ${Number(item.ingredients?.length || 0)} ingredienti</p>
      <div class="card-actions">
        <button class="secondary" data-edit-recipe="${escapeAdmin(item.recipeId)}" ${item.status === 'archived' ? 'disabled' : ''}>Modifica →</button>
        <button class="text-button archive-toggle" data-archive-recipe="${escapeAdmin(item.recipeId)}" data-archived="${item.status === 'archived' ? '1' : '0'}">${item.status === 'archived' ? 'Riattiva' : 'Archivia'}</button>
      </div>
    </article>`).join('') || '<p class="feedback">Nessuna ricetta registrata.</p>';
}

function recipeIngredientRow(ingredient = {}) {
  return `
  <div class="recipe-ingredient">
    <input class="ing-name" required placeholder="Ingrediente (es. Pasta di semola)" value="${escapeAdmin(ingredient.name || '')}" aria-label="Nome ingrediente">
    <input class="ing-man" placeholder="Dose uomo (es. 80 g)" value="${escapeAdmin(ingredient.portions?.man ?? '')}" aria-label="Dose uomo">
    <input class="ing-ipo" placeholder="Dose donna (es. 60 g)" value="${escapeAdmin(ingredient.portions?.ipo ?? '')}" aria-label="Dose donna">
    <button type="button" class="dialog-close ing-remove" aria-label="Rimuovi ingrediente">×</button>
  </div>`;
}

function openRecipeDialog({ mode, recipe = {}, clientId = '', clientCode = '' }) {
  $('recipe-mode').value = mode;
  $('recipe-id').value = mode === 'studio' ? (recipe.recipeId || '') : (recipe.id || '');
  $('recipe-client-id').value = clientId;
  $('recipe-eyebrow').textContent = mode === 'studio' ? 'RICETTA STUDIO' : 'RICETTA PERSONALE';
  $('recipe-title').textContent = mode === 'studio'
    ? (recipe.recipeId ? 'Modifica ricetta studio' : 'Nuova ricetta studio')
    : 'Modifica ricetta personale';
  $('recipe-subtitle').textContent = mode === 'studio'
    ? 'Catalogo condiviso dell’organizzazione.'
    : `Cliente ${clientCode} · id ${recipe.id || ''}`;
  $('recipe-name').value = recipe.name || '';
  $('recipe-emoji').value = recipe.emoji || '';
  $('recipe-slot').value = recipe.slot || 'lunch';
  $('recipe-protein').value = recipe.proteinCategory || '';
  $('recipe-ingredients').innerHTML = (recipe.ingredients?.length ? recipe.ingredients : [{}]).map(recipeIngredientRow).join('');
  $('recipe-steps').value = (recipe.steps || []).join('\n');
  $('recipe-notes').value = (recipe.notes || []).join('\n');
  $('recipe-special').value = recipe.specialNote || '';
  $('recipe-callout').textContent = mode === 'studio'
    ? 'Il salvataggio non modifica le copie già assegnate ai clienti: serve una riassegnazione esplicita.'
    : 'Si aggiorna la ricetta personale del cliente, senza toccare piano né copie studio.';
  $('recipe-submit').textContent = mode === 'studio' ? 'Salva ricetta →' : 'Salva personale →';
  $('recipe-error').textContent = '';
  $('recipe-dialog').classList.remove('hidden');
  $('recipe-name').focus();
}

function closeRecipeDialog() { $('recipe-dialog').classList.add('hidden'); }

function collectRecipeForm() {
  const rows = [...$('recipe-ingredients').querySelectorAll('.recipe-ingredient')];
  const ingredients = rows.map((row, index) => {
    const name = row.querySelector('.ing-name').value.trim();
    const man = row.querySelector('.ing-man').value.trim();
    const ipo = row.querySelector('.ing-ipo').value.trim();
    if (!name) throw new Error(`Ingrediente ${index + 1}: indica il nome.`);
    if (!man && !ipo) throw new Error(`Ingrediente ${index + 1} (${name}): almeno una dose tra uomo e donna.`);
    const portions = {};
    if (man) portions.man = man;
    if (ipo) portions.ipo = ipo;
    return { name, portions };
  });
  if (!ingredients.length) throw new Error('Aggiungi almeno un ingrediente.');
  return {
    name: $('recipe-name').value.trim(),
    emoji: $('recipe-emoji').value.trim(),
    slot: $('recipe-slot').value,
    proteinCategory: $('recipe-protein').value || '',
    ingredients,
    steps: $('recipe-steps').value.split('\n').map(line => line.trim()).filter(Boolean),
    notes: $('recipe-notes').value.split('\n').map(line => line.trim()).filter(Boolean),
    specialNote: $('recipe-special').value.trim()
  };
}

async function submitRecipeForm(event) {
  event.preventDefault();
  $('recipe-error').textContent = '';
  const mode = $('recipe-mode').value;
  let recipe;
  try { recipe = collectRecipeForm(); } catch (error) { $('recipe-error').textContent = error.message; return; }
  if (recipe.name.length < 2) { $('recipe-error').textContent = 'Il nome deve avere almeno 2 caratteri.'; return; }
  try {
    if (mode === 'studio') {
      const recipeId = $('recipe-id').value || undefined;
      const result = await callAdminSaasFunction('saveStudioRecipe', {
        organizationId: orgId(), recipe: { ...recipe, ...(recipeId ? { recipeId } : {}) },
        idempotencyKey: idem('studio-recipe')
      });
      closeRecipeDialog(); await loadStudio();
      $('studio-feedback').textContent = result.created
        ? 'Ricetta creata nel catalogo studio.'
        : 'Ricetta aggiornata. Le copie assegnate restano com’erano: riassegna per propagare.';
    } else {
      await callAdminSaasFunction('saveClientPersonalRecipe', {
        organizationId: orgId(), clientId: $('recipe-client-id').value,
        recipe: { ...recipe, id: $('recipe-id').value },
        idempotencyKey: idem('client-recipe')
      });
      closeRecipeDialog(); await refreshWorkspaceRecipes();
      $('client-feedback').textContent = 'Ricetta personale aggiornata.';
    }
  } catch (error) { $('recipe-error').textContent = adminError(error); }
}

async function toggleStudioArchive(recipeId, archived) {
  try {
    await callAdminSaasFunction('archiveStudioRecipe', { organizationId: orgId(), studioRecipeId: recipeId, archived, idempotencyKey: idem('studio-archive') });
    await loadStudio();
    $('studio-feedback').textContent = archived
      ? 'Ricetta archiviata: le copie assegnate restano, non si può più assegnare.'
      : 'Ricetta riattivata.';
  } catch (error) { $('studio-feedback').textContent = adminError(error); }
}

// ---- Area di lavoro cliente ----

async function openClientWorkspace(clientId) {
  const client = adminState.clients.find(item => item.id === clientId);
  if (!client) return;
  adminState.workspace = { clientId: client.id, displayCode: client.displayCode, recipes: [], grams: null, freq: null };
  $('client-title').textContent = `Gestione · ${client.displayCode}`;
  $('client-subtitle').textContent = 'Ricette, grammature, frequenze e copia dati.';
  $('client-feedback').textContent = 'Caricamento dati cliente…';
  ['client-org-recipes', 'client-assign-list', 'client-personal-recipes', 'client-grams', 'client-freq-proteins', 'client-freq-carbs', 'client-copy-targets'].forEach(id => { $(id).innerHTML = ''; });
  $('client-grams-note').value = '';
  $('client-grams-meta').textContent = '';
  $('client-freq-meta').textContent = '';
  $('client-copy-preview-out').textContent = '';
  $('client-copy-confirm').disabled = true;
  $('client-dialog').classList.remove('hidden');
  try {
    const [catalog, grams, freq, studio] = await Promise.all([
      callAdminSaasFunction('listClientRecipes', { organizationId: orgId(), clientId: client.id }),
      callAdminSaasFunction('getClientGramOverrides', { organizationId: orgId(), clientId: client.id }),
      callAdminSaasFunction('getClientFoodFrequencies', { organizationId: orgId(), clientId: client.id }),
      callAdminSaasFunction('listStudioRecipes', { organizationId: orgId() })
    ]);
    adminState.workspace.recipes = catalog.recipes || [];
    adminState.workspace.grams = grams.overrides || null;
    adminState.workspace.freq = freq.frequencies || null;
    adminState.studioRecipes = studio.recipes || [];
    renderWorkspace();
    $('client-subtitle').textContent = `Catalogo ${catalog.scope === 'household' ? 'condiviso (household)' : 'personale'} · ${catalog.recipes?.length || 0} ricette.`;
    $('client-feedback').textContent = '';
  } catch (error) { $('client-feedback').textContent = adminError(error); }
}

function closeClientWorkspace() { $('client-dialog').classList.add('hidden'); adminState.workspace = null; }

async function refreshWorkspaceRecipes() {
  const workspace = adminState.workspace;
  if (!workspace) return;
  const catalog = await callAdminSaasFunction('listClientRecipes', { organizationId: orgId(), clientId: workspace.clientId });
  workspace.recipes = catalog.recipes || [];
  renderWorkspaceRecipes(); renderWorkspaceAssign();
}

function renderWorkspace() {
  renderWorkspaceRecipes(); renderWorkspaceAssign(); renderWorkspaceGrams(); renderWorkspaceFreq(); renderWorkspaceCopy();
}

function renderWorkspaceRecipes() {
  const recipes = adminState.workspace?.recipes || [];
  const org = recipes.filter(item => item.origin === 'org');
  const personal = recipes.filter(item => item.origin !== 'org');
  $('client-org-recipes').innerHTML = org.length ? org.map(item => `
    <div class="workspace-row"><input type="checkbox" data-unassign-recipe="${escapeAdmin(item.orgRecipeId || '')}" ${item.orgRecipeId ? '' : 'disabled'} aria-label="Seleziona ${escapeAdmin(item.name)} per la rimozione">
    <span><strong>${escapeAdmin(item.emoji || '🍲')} ${escapeAdmin(item.name)}</strong><small>${escapeAdmin(SLOT_LABELS[item.slot] || '')}${item.assignedAt ? ` · assegnata il ${formatDateOnly(item.assignedAt)}` : ''}</small></span>
    ${item.orgRecipeId ? `<button type="button" class="secondary" data-reassign-recipe="${escapeAdmin(item.orgRecipeId)}">Riassegna</button>` : ''}</div>`).join('')
    : '<p class="field-hint">Nessuna ricetta dello studio assegnata.</p>';
  $('client-personal-recipes').innerHTML = personal.length ? personal.map(item => `
    <div class="workspace-row"><span><strong>${escapeAdmin(item.emoji || '🍲')} ${escapeAdmin(item.name)}</strong><small>${escapeAdmin(SLOT_LABELS[item.slot] || '')} · id ${escapeAdmin(item.id || '')}</small></span>
    <button type="button" class="secondary" data-edit-personal="${escapeAdmin(item.id || '')}">Modifica</button></div>`).join('')
    : '<p class="field-hint">Nessuna ricetta personale.</p>';
}

function renderWorkspaceAssign() {
  const assigned = new Set((adminState.workspace?.recipes || []).filter(item => item.origin === 'org').map(item => item.orgRecipeId));
  const available = (adminState.studioRecipes || []).filter(item => item.status !== 'archived' && !assigned.has(item.recipeId));
  $('client-assign-list').innerHTML = available.length ? available.map(item => `
    <label class="workspace-row"><input type="checkbox" data-assign-recipe="${escapeAdmin(item.recipeId)}">
    <span><strong>${escapeAdmin(item.emoji || '🍲')} ${escapeAdmin(item.name)}</strong><small>${escapeAdmin(SLOT_LABELS[item.slot] || '')}</small></span></label>`).join('')
    : '<p class="field-hint">Nessuna ricetta studio da assegnare (catalogo vuoto, tutto archiviato o già assegnato).</p>';
}

async function submitWorkspaceAssign() {
  const ids = [...$('client-assign-list').querySelectorAll('[data-assign-recipe]:checked')].map(input => input.dataset.assignRecipe);
  if (!ids.length) { $('client-feedback').textContent = 'Seleziona almeno una ricetta da assegnare.'; return; }
  try {
    const result = await callAdminSaasFunction('assignStudioRecipes', { organizationId: orgId(), clientId: adminState.workspace.clientId, studioRecipeIds: ids, idempotencyKey: idem('assign') });
    await refreshWorkspaceRecipes();
    $('client-feedback').textContent = `Assegnate ${result.assigned} ricette (${result.added} nuove, ${result.replaced} aggiornate).`;
  } catch (error) { $('client-feedback').textContent = adminError(error); }
}

async function submitWorkspaceUnassign() {
  const ids = [...$('client-org-recipes').querySelectorAll('[data-unassign-recipe]:checked')].map(input => input.dataset.unassignRecipe).filter(Boolean);
  if (!ids.length) { $('client-feedback').textContent = 'Seleziona almeno una ricetta da rimuovere.'; return; }
  if (!confirm(`Rimuovere ${ids.length} ricette dello studio da questo cliente?\n\nLe ricette personali non si toccano. I pasti del piano che usavano queste ricette diventeranno vuoti.`)) return;
  try {
    const result = await callAdminSaasFunction('unassignStudioRecipes', { organizationId: orgId(), clientId: adminState.workspace.clientId, studioRecipeIds: ids, idempotencyKey: idem('unassign') });
    await refreshWorkspaceRecipes();
    $('client-feedback').textContent = `Rimosse ${result.removed} ricette dello studio${result.clearedSlots?.length ? ` (${result.clearedSlots.length} slot del piano svuotati)` : ''}.`;
  } catch (error) { $('client-feedback').textContent = adminError(error); }
}

async function reassignWorkspaceRecipe(studioRecipeId) {
  try {
    await callAdminSaasFunction('assignStudioRecipes', { organizationId: orgId(), clientId: adminState.workspace.clientId, studioRecipeIds: [studioRecipeId], idempotencyKey: idem('reassign') });
    await refreshWorkspaceRecipes();
    $('client-feedback').textContent = 'Copia aggiornata con l’ultima versione dello studio.';
  } catch (error) { $('client-feedback').textContent = adminError(error); }
}

function mellerFamilyOptions() {
  return (window.PianoDomain?.MELLER_GRAMMATURE || []).map(rule => `<option value="${escapeAdmin(rule.family)}">${escapeAdmin(rule.label || rule.family)}</option>`).join('');
}

let gramsRowCounter = 0;

function gramsRow(family = '', quantities = {}) {
  const listId = `grams-family-list-${++gramsRowCounter}`;
  const q = meal => quantities?.[meal] || {};
  return `
  <div class="structure-rule">
    <div class="rule-head grams-head">
      <input class="grams-family" list="${listId}" required placeholder="Famiglia (es. riso)" value="${escapeAdmin(family)}" aria-label="Famiglia Meller">
      <datalist id="${listId}">${mellerFamilyOptions()}</datalist>
      <button type="button" class="dialog-close grams-remove" aria-label="Rimuovi famiglia">×</button>
    </div>
    <div class="rule-doses">
      <label>Pranzo · Allenamento<input class="grams-la" type="number" min="1" max="2000" step="1" placeholder="g" value="${q('lunch').training ?? ''}"></label>
      <label>Pranzo · Riposo<input class="grams-lr" type="number" min="1" max="2000" step="1" placeholder="g" value="${q('lunch').rest ?? ''}"></label>
      <label>Cena · Allenamento<input class="grams-ca" type="number" min="1" max="2000" step="1" placeholder="g" value="${q('dinner').training ?? ''}"></label>
      <label>Cena · Riposo<input class="grams-cr" type="number" min="1" max="2000" step="1" placeholder="g" value="${q('dinner').rest ?? ''}"></label>
    </div>
  </div>`;
}

function renderWorkspaceGrams() {
  const grams = adminState.workspace?.grams;
  const entries = grams ? Object.entries(grams.overrides || {}) : [];
  $('client-grams').innerHTML = entries.length
    ? entries.map(([family, value]) => gramsRow(family, value?.quantityGrams || {})).join('')
    : gramsRow();
  $('client-grams-note').value = grams?.note || '';
  $('client-grams-meta').textContent = grams
    ? `Revisione n. ${grams.revision} · aggiornata il ${formatDateOnly(grams.updatedAt)}`
    : 'Nessuna grammatura personalizzata: si usano le dosi della struttura.';
}

function collectGrams() {
  const known = new Set((window.PianoDomain?.MELLER_GRAMMATURE || []).map(rule => rule.family));
  const rows = [...$('client-grams').querySelectorAll('.structure-rule')];
  const dose = (row, cls) => { const raw = row.querySelector(cls).value; return raw === '' ? null : Number(raw); };
  const overrides = {};
  rows.forEach(row => {
    const family = row.querySelector('.grams-family').value.trim();
    if (!family) return;
    if (!known.has(family)) throw new Error(`Famiglia «${family}» non presente nel motore Meller: sceglila dall’elenco.`);
    if (overrides[family]) throw new Error(`Famiglia duplicata: ${family}`);
    const quantityGrams = {
      lunch: dose(row, '.grams-la') == null && dose(row, '.grams-lr') == null ? null : { training: dose(row, '.grams-la'), rest: dose(row, '.grams-lr') },
      dinner: dose(row, '.grams-ca') == null && dose(row, '.grams-cr') == null ? null : { training: dose(row, '.grams-ca'), rest: dose(row, '.grams-cr') }
    };
    if (!quantityGrams.lunch && !quantityGrams.dinner) throw new Error(`Famiglia ${family}: almeno una dose.`);
    for (const meal of ['lunch', 'dinner']) for (const day of ['training', 'rest']) {
      const value = quantityGrams[meal]?.[day];
      if (value != null && (!Number.isInteger(value) || value < 1 || value > 2000)) throw new Error(`Famiglia ${family}: le dosi devono essere interi tra 1 e 2000.`);
    }
    overrides[family] = { quantityGrams };
  });
  return overrides;
}

async function submitWorkspaceGrams() {
  let overrides;
  try { overrides = collectGrams(); } catch (error) { $('client-feedback').textContent = error.message; return; }
  try {
    const result = await callAdminSaasFunction('saveClientGramOverrides', {
      organizationId: orgId(), clientId: adminState.workspace.clientId,
      overrides, note: $('client-grams-note').value.trim(), idempotencyKey: idem('grams')
    });
    adminState.workspace.grams = { revision: result.revision, overrides, note: $('client-grams-note').value.trim(), updatedAt: new Date().toISOString() };
    renderWorkspaceGrams();
    $('client-feedback').textContent = `Grammature salvate (revisione n. ${result.revision}). Il cliente conferma dall’app: niente cambia in silenzio.`;
  } catch (error) { $('client-feedback').textContent = adminError(error); }
}

function renderWorkspaceFreq() {
  const freq = adminState.workspace?.freq;
  const proteins = freq?.proteins || {};
  const carbs = freq?.carbs || {};
  const proteinKeys = window.PianoDomain?.PROTEIN_CATEGORIES || ['poultry', 'beef', 'curedMeats', 'omega', 'otherFish', 'dairy', 'eggs', 'legumes'];
  const proteinLabels = window.PianoDomain?.PROTEIN_CATEGORY_LABELS || {};
  const carbKeys = window.PianoDomain?.CARB_FREQUENCY_CATEGORIES || ['pastaRice', 'otherCereals', 'bread', 'potatoes'];
  const carbLabels = window.PianoDomain?.CARB_FREQUENCY_LABELS || {};
  const row = (key, label, range) => `
    <div class="frequency-row"><strong>${escapeAdmin(label)}</strong>
      <label>Min<input type="number" min="0" max="14" step="1" data-freq-key="${escapeAdmin(key)}" data-freq-side="min" value="${range?.min ?? ''}" placeholder="—" aria-label="Minimo ${escapeAdmin(label)}"></label>
      <label>Max<input type="number" min="0" max="14" step="1" data-freq-key="${escapeAdmin(key)}" data-freq-side="max" value="${range?.max ?? ''}" placeholder="—" aria-label="Massimo ${escapeAdmin(label)}"></label>
    </div>`;
  $('client-freq-proteins').innerHTML = proteinKeys.map(key => row(key, proteinLabels[key] || key, proteins[key])).join('');
  $('client-freq-carbs').innerHTML = carbKeys.map(key => row(key, carbLabels[key] || key, carbs[key])).join('');
  $('client-freq-meta').textContent = freq
    ? `Revisione n. ${freq.revision} · aggiornata il ${formatDateOnly(freq.updatedAt)}`
    : 'Nessuna frequenza assegnata: si usano gli obiettivi standard.';
}

function collectFreq(sectionId) {
  const section = {};
  $(sectionId).querySelectorAll('[data-freq-key]').forEach(input => {
    const key = input.dataset.freqKey;
    section[key] = section[key] || {};
    section[key][input.dataset.freqSide] = input.value === '' ? null : Number(input.value);
  });
  return section;
}

async function submitWorkspaceFreq() {
  const proteins = collectFreq('client-freq-proteins');
  const carbs = collectFreq('client-freq-carbs');
  try {
    const result = await callAdminSaasFunction('saveClientFoodFrequencies', {
      organizationId: orgId(), clientId: adminState.workspace.clientId, proteins, carbs, idempotencyKey: idem('freq')
    });
    adminState.workspace.freq = { revision: result.revision, proteins, carbs, updatedAt: new Date().toISOString() };
    renderWorkspaceFreq();
    $('client-feedback').textContent = `Frequenze salvate (revisione n. ${result.revision}).`;
  } catch (error) { $('client-feedback').textContent = adminError(error); }
}

function renderWorkspaceCopy() {
  const workspace = adminState.workspace;
  const others = (adminState.clients || []).filter(item => item.id !== workspace.clientId);
  $('client-copy-targets').innerHTML = others.length ? others.map(item => `
    <label class="workspace-row"><input type="checkbox" data-copy-target="${escapeAdmin(item.id)}">
    <span><strong>${escapeAdmin(item.displayCode)}</strong><small>${escapeAdmin(assignmentSummary(item))}</small></span></label>`).join('')
    : '<p class="field-hint">Nessun altro cliente autorizzato.</p>';
}

function copyTargetIds() {
  return [...$('client-copy-targets').querySelectorAll('[data-copy-target]:checked')].map(input => input.dataset.copyTarget);
}

async function previewWorkspaceCopy() {
  const targets = copyTargetIds();
  if (!targets.length) { $('client-copy-preview-out').textContent = 'Seleziona almeno un cliente destinatario.'; return; }
  $('client-copy-preview-out').textContent = 'Calcolo anteprima…';
  $('client-copy-confirm').disabled = true;
  try {
    const preview = await callAdminSaasFunction('previewCopyClientData', { organizationId: orgId(), sourceClientId: adminState.workspace.clientId, targetClientIds: targets });
    const source = preview.sourceSummary;
    $('client-copy-preview-out').innerHTML = `
      <p><strong>Da copiare:</strong> ${source.orgCopies} ricette studio · ${source.gramFamilies} famiglie grammature · ${source.proteinRanges} fasce proteine · ${source.carbRanges} fasce carboidrati.</p>
      ${preview.targets.map(target => `<p><strong>${escapeAdmin(target.displayCode)}:</strong> ${target.personalUntouched} personali intoccate · ${target.orgCopiesToRemove} copie da sostituire con ${target.orgCopiesToAdd} · ${target.planSlotsToClear} slot del piano da svuotare.</p>`).join('')}`;
    $('client-copy-confirm').disabled = false;
  } catch (error) { $('client-copy-preview-out').textContent = adminError(error); }
}

async function confirmWorkspaceCopy() {
  const targets = copyTargetIds();
  if (!targets.length) return;
  if (!confirm(`Copiare ricette studio, grammature e frequenze verso ${targets.length} clienti?\n\nLe ricette personali dei destinatari restano intoccabili. L’operazione è registrata nell’audit.`)) return;
  $('client-copy-confirm').disabled = true;
  try {
    const result = await callAdminSaasFunction('copyClientData', { organizationId: orgId(), sourceClientId: adminState.workspace.clientId, targetClientIds: targets, idempotencyKey: idem('copy') });
    const codeOf = id => (adminState.clients.find(item => item.id === id)?.displayCode) || id;
    $('client-copy-preview-out').innerHTML = result.results.map(item =>
      `<p><strong>${escapeAdmin(codeOf(item.clientId))}:</strong> ${item.added} copie, ${item.personalUntouched} personali intoccate, ${item.clearedSlots} slot svuotati, grammature rev. ${item.gramsRevision}, frequenze rev. ${item.frequenciesRevision}.</p>`).join('');
    $('client-feedback').textContent = 'Copia completata e registrata nell’audit.';
  } catch (error) {
    $('client-copy-preview-out').textContent = adminError(error);
    $('client-copy-confirm').disabled = false;
  }
}

function showView(view) {
  document.querySelectorAll('.console-view').forEach(node => node.classList.toggle('hidden', node.id !== `view-${view}`));
  document.querySelectorAll('.nav-link').forEach(node => node.classList.toggle('active', node.dataset.view === view));
  document.querySelector('.sidebar').classList.remove('open');
  const backdrop = $('sidebar-backdrop');
  if (backdrop) backdrop.hidden = true;
  $('mobile-menu')?.setAttribute('aria-expanded', 'false');
  if (view === 'clients') loadClients();
  else if (view === 'structures') loadStructures();
  else if (view === 'studio') loadStudio();
  else if (view === 'users') loadUsers();
  else loadReports();
}

function bindAdmin() {
  $('admin-login-form').addEventListener('submit', async event => {
    event.preventDefault(); $('admin-login-error').textContent = '';
    try { await adminSignInWithUsername($('admin-username').value, $('admin-password').value); }
    catch (error) { $('admin-login-error').textContent = adminError(error); }
  });
  $('admin-logout').addEventListener('click', () => adminSignOutUser());
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
  $('clients-list').addEventListener('click', event => {
    const manage = event.target.closest('[data-manage-client]');
    if (manage) { openClientWorkspace(manage.dataset.manageClient); return; }
    const button = event.target.closest('[data-assign-client]'); if (button) openAssignment(button.dataset.assignClient);
  });
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
  $('refresh-users').addEventListener('click', loadUsers);
  document.querySelectorAll('[data-verify-username]').forEach(node => node.addEventListener('click', () => verifyUsername(node.dataset.verifyUsername, node.dataset.verifyOut)));
  $('invite-nutritionist-form').addEventListener('submit', submitNutritionistInvite);
  $('invite-client-form').addEventListener('submit', submitClientInvite);
  $('members-list').addEventListener('click', event => {
    const statusButton = event.target.closest('[data-member-status]');
    if (statusButton) { changeMemberStatus(statusButton.dataset.memberStatus, statusButton.dataset.status); return; }
    const removeButton = event.target.closest('[data-member-remove]');
    if (removeButton) removeNutritionist(removeButton.dataset.memberRemove);
  });
  $('clients-list').addEventListener('click', event => {
    const unlink = event.target.closest('[data-unlink-client]');
    if (unlink) openUnlink(unlink.dataset.unlinkClient, unlink.dataset.display);
  });
  $('unlink-form').addEventListener('submit', submitUnlink);
  document.querySelectorAll('[data-close-unlink]').forEach(node => node.addEventListener('click', closeUnlink));
  $('refresh-studio').addEventListener('click', loadStudio);
  $('new-studio-recipe').addEventListener('click', () => openRecipeDialog({ mode: 'studio' }));
  $('studio-list').addEventListener('click', event => {
    const edit = event.target.closest('[data-edit-recipe]');
    if (edit) { const recipe = adminState.studioRecipes.find(item => item.recipeId === edit.dataset.editRecipe); if (recipe) openRecipeDialog({ mode: 'studio', recipe }); return; }
    const archive = event.target.closest('[data-archive-recipe]');
    if (archive) toggleStudioArchive(archive.dataset.archiveRecipe, archive.dataset.archived !== '1');
  });
  $('recipe-form').addEventListener('submit', submitRecipeForm);
  $('recipe-add-ingredient').addEventListener('click', () => $('recipe-ingredients').insertAdjacentHTML('beforeend', recipeIngredientRow()));
  $('recipe-ingredients').addEventListener('click', event => { const remove = event.target.closest('.ing-remove'); if (remove) remove.closest('.recipe-ingredient').remove(); });
  document.querySelectorAll('[data-close-recipe]').forEach(node => node.addEventListener('click', closeRecipeDialog));
  $('client-assign').addEventListener('click', submitWorkspaceAssign);
  $('client-unassign').addEventListener('click', submitWorkspaceUnassign);
  $('client-org-recipes').addEventListener('click', event => { const button = event.target.closest('[data-reassign-recipe]'); if (button) reassignWorkspaceRecipe(button.dataset.reassignRecipe); });
  $('client-personal-recipes').addEventListener('click', event => {
    const button = event.target.closest('[data-edit-personal]');
    if (!button || !adminState.workspace) return;
    const recipe = adminState.workspace.recipes.find(item => item.id === button.dataset.editPersonal);
    if (recipe) openRecipeDialog({ mode: 'personal', recipe, clientId: adminState.workspace.clientId, clientCode: adminState.workspace.displayCode });
  });
  $('client-grams-add').addEventListener('click', () => $('client-grams').insertAdjacentHTML('beforeend', gramsRow()));
  $('client-grams').addEventListener('click', event => { const remove = event.target.closest('.grams-remove'); if (remove) remove.closest('.structure-rule').remove(); });
  $('client-grams-save').addEventListener('click', submitWorkspaceGrams);
  $('client-freq-save').addEventListener('click', submitWorkspaceFreq);
  $('client-copy-preview').addEventListener('click', previewWorkspaceCopy);
  $('client-copy-confirm').addEventListener('click', confirmWorkspaceCopy);
  $('client-copy-targets').addEventListener('change', () => { $('client-copy-confirm').disabled = true; $('client-copy-preview-out').textContent = ''; });
  document.querySelectorAll('[data-close-client]').forEach(node => node.addEventListener('click', closeClientWorkspace));
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

bindAdmin();
if (!initFirebase()) $('admin-login-error').textContent = 'Firebase non disponibile.';
// Sessione SEPARATA dall'app cliente (Firebase App "admin-console"): questo
// observer ascolta l'Auth della console, quindi una sessione cliente attiva
// nella stessa origine NON apre la dashboard, e i logout restano indipendenti.
observeAdminAuthState(async user => {
  adminState.user = user;
  if (!user) {
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
  const name = usernameFromUser(user) || 'Professionista';
  $('admin-name').textContent = name; $('admin-avatar').textContent = name.slice(0, 1).toUpperCase();
  // Landing: la vista Clienti è la porta d'ingresso della console.
  showView('clients');
});
