/* Ricerca ricette online (Piano Nutrizionale).
 *
 * L'AI serve SOLO a trovare NUOVE ricette dal web: nessuna chat, nessuna
 * risposta generalista. Dal Ricettario il pulsante "Cerca nel web" apre una
 * modale in cui si indicano gli ingredienti essenziali (obbligatori), il tipo
 * di pasto (obbligatorio) e le eventuali preferenze. Il Worker Cloudflare
 * (endpoint /recipes) interroga Gemini con Google Search grounding e
 * restituisce fino a 10 ricette aderenti alle grammature del dott. Meller.
 * Ogni scheda apre il popup ricetta esistente per l'importazione; il pulsante
 * "Altre 10 ricette" ripete la ricerca escludendo le ricette già mostrate.
 */
(function (root) {
  'use strict';

  const SLOTS = [
    { id: 'breakfast', label: 'Colazione' },
    { id: 'snack1', label: 'Spuntino mattina' },
    { id: 'lunch', label: 'Pranzo' },
    { id: 'snack2', label: 'Spuntino pomeriggio' },
    { id: 'dinner', label: 'Cena' }
  ];

  const state = {
    open: false,
    busy: false,
    criteria: { ingredients: '', slot: 'lunch', note: '' },
    seenNames: [],
    recipes: [],
    sources: [],
    error: ''
  };

  const ui = {};

  function getConfig() {
    return root.PIANO_WEB_SEARCH_CONFIG || {};
  }

  function recipesEndpoint() {
    return String(getConfig().recipesEndpoint || '').trim();
  }

  function hasEndpoint() {
    const endpoint = recipesEndpoint();
    return Boolean(endpoint && !/^https?:\/\/YOUR[-_A-Z0-9.]+/i.test(endpoint) && /^https?:\/\//i.test(endpoint));
  }

  function escape(value) {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
    return String(value ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function toast(message, isError) {
    try {
      if (typeof showToast === 'function') showToast(message, Boolean(isError));
    } catch (_) {}
  }

  function slotLabel(id) {
    return (SLOTS.find(slot => slot.id === id) || SLOTS[2]).label;
  }

  function safeUrl(value) {
    try {
      const parsed = new URL(String(value || ''));
      if (['http:', 'https:'].includes(parsed.protocol)) return parsed.href;
    } catch (_) {}
    return '';
  }

  async function getIdToken() {
    try {
      const firebaseUser = root.firebase?.auth?.()?.currentUser;
      if (firebaseUser?.getIdToken) return firebaseUser.getIdToken();
    } catch (_) {}
    try {
      if (typeof currentUser !== 'undefined' && currentUser?.getIdToken) return currentUser.getIdToken();
    } catch (_) {}
    throw new Error('Sessione Firebase non disponibile. Accedi di nuovo alla webapp.');
  }

  // -----------------------------------------------------------------------
  // Rete
  // -----------------------------------------------------------------------

  async function searchRecipes({ ingredients, slot, note, excludeNames } = {}) {
    const cleanIngredients = String(ingredients || '').trim();
    const cleanSlot = SLOTS.some(item => item.id === slot) ? slot : 'lunch';
    const cleanNote = String(note || '').trim();
    if (!hasEndpoint()) {
      return { error: 'Per cercare ricette dal web serve il Worker Cloudflare: inserisci l’URL /recipes in js/web-search-config.js e pubblica il Worker.' };
    }
    let idToken;
    try {
      idToken = await getIdToken();
    } catch (error) {
      return { error: error?.message || 'Sessione non disponibile: accedi di nuovo alla webapp.' };
    }
    const query = `ricetta con ${cleanIngredients} per ${slotLabel(cleanSlot).toLowerCase()}${cleanNote ? ` — ${cleanNote}` : ''}`;
    try {
      const response = await fetch(recipesEndpoint(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        credentials: 'omit',
        // Nessuna grammatura Meller viene inviata al modello: la ricerca
        // riguarda solo i criteri dell'utente (ingredienti, pasto, preferenze).
        // Il confronto con il manuale avviene nell'app sulle ricette ricevute.
        body: JSON.stringify({
          query,
          slot: cleanSlot,
          language: getConfig().language || 'it-IT',
          maxRecipes: Number(getConfig().maxRecipes) || 10,
          excludeNames: (Array.isArray(excludeNames) ? excludeNames : []).slice(0, 30)
        })
      });
      let body = null;
      try { body = await response.json(); } catch (_) {}
      if (response.status === 429) {
        return { error: 'Troppe ricerche in poco tempo: attendi qualche minuto e riprova.' };
      }
      if (!response.ok) {
        return { error: body?.error || `Ricerca delle ricette non riuscita (${response.status}).` };
      }
      const recipes = Array.isArray(body?.recipes) ? body.recipes : [];
      if (!recipes.length) return { error: 'Non ho trovato ricette corrispondenti. Prova con altri ingredienti o preferenze.' };
      return {
        recipes: recipes.slice(0, Number(getConfig().maxRecipes) || 10),
        sources: Array.isArray(body?.sources) ? body.sources : []
      };
    } catch (error) {
      return { error: error?.message || 'Ricerca delle ricette non riuscita. Controlla la connessione e riprova.' };
    }
  }

  // -----------------------------------------------------------------------
  // Interfaccia
  // -----------------------------------------------------------------------

  function ensureUi() {
    if (ui.modal && root.document.body.contains(ui.modal)) return ui;
    const modal = root.document.createElement('div');
    modal.id = 'web-search-modal';
    modal.className = 'modal hidden web-search-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'websearch-title');
    modal.innerHTML = `
      <div class="modal-content web-search-content">
        <div class="modal-header">
          <div>
            <p class="eyebrow">RICERCA ONLINE</p>
            <h2 id="websearch-title">Cerca ricette nel web</h2>
          </div>
          <button type="button" id="websearch-close" class="btn-icon" aria-label="Chiudi">&times;</button>
        </div>
        <p class="text-muted websearch-intro">Indica gli ingredienti essenziali e il pasto: troverò fino a 10 ricette aderenti alle grammature del dott. Meller, pronte da aprire e importare.</p>
        <form id="websearch-form" class="websearch-form" novalidate>
          <label class="websearch-field">
            <span>Ingredienti essenziali *</span>
            <input id="websearch-ingredients" type="text" required placeholder="es. pollo, riso, zucchine" autocomplete="off">
          </label>
          <label class="websearch-field">
            <span>Tipo di pasto *</span>
            <select id="websearch-slot" required>
              ${SLOTS.map(slot => `<option value="${slot.id}"${slot.id === 'lunch' ? ' selected' : ''}>${escape(slot.label)}</option>`).join('')}
            </select>
          </label>
          <label class="websearch-field">
            <span>Preferenze (facoltative)</span>
            <input id="websearch-note" type="text" placeholder="es. veloce, senza glutine, al forno" autocomplete="off">
          </label>
          <button type="submit" class="btn btn-primary websearch-submit">🔎 Cerca</button>
        </form>
        <div id="websearch-status" class="websearch-status hidden"></div>
        <div id="websearch-error" class="websearch-error hidden"></div>
        <div id="websearch-results" class="websearch-results"></div>
      </div>`;
    root.document.body.appendChild(modal);

    ui.modal = modal;
    ui.form = modal.querySelector('#websearch-form');
    ui.ingredients = modal.querySelector('#websearch-ingredients');
    ui.slot = modal.querySelector('#websearch-slot');
    ui.note = modal.querySelector('#websearch-note');
    ui.status = modal.querySelector('#websearch-status');
    ui.error = modal.querySelector('#websearch-error');
    ui.results = modal.querySelector('#websearch-results');

    modal.querySelector('#websearch-close').addEventListener('click', closeModal);
    modal.addEventListener('click', event => {
      if (event.target === modal) closeModal();
    });
    ui.form.addEventListener('submit', event => {
      event.preventDefault();
      submitSearch();
    });
    return ui;
  }

  function openModal() {
    ensureUi();
    state.open = true;
    ui.modal.classList.remove('hidden');
    try { ui.ingredients.focus(); } catch (_) {}
  }

  function closeModal() {
    if (!ui.modal) return;
    state.open = false;
    ui.modal.classList.add('hidden');
  }

  function setStatus(text) {
    if (!ui.status) return;
    if (!text) {
      ui.status.classList.add('hidden');
      ui.status.innerHTML = '';
      return;
    }
    ui.status.classList.remove('hidden');
    ui.status.innerHTML = `<span class="websearch-spinner" aria-hidden="true"></span><span>${escape(text)}</span>`;
  }

  function setError(text) {
    state.error = text || '';
    if (!ui.error) return;
    if (!text) {
      ui.error.classList.add('hidden');
      ui.error.textContent = '';
      return;
    }
    ui.error.classList.remove('hidden');
    ui.error.textContent = text;
  }

  async function submitSearch() {
    ensureUi();
    const ingredients = String(ui.ingredients.value || '').trim();
    if (!ingredients) {
      setError('Scrivi almeno un ingrediente essenziale.');
      try { ui.ingredients.focus(); } catch (_) {}
      return;
    }
    state.criteria = {
      ingredients,
      slot: SLOTS.some(item => item.id === ui.slot.value) ? ui.slot.value : 'lunch',
      note: String(ui.note.value || '').trim()
    };
    state.seenNames = [];
    state.recipes = [];
    state.sources = [];
    await runSearch({ excludeNames: [] });
  }

  async function runSearch({ excludeNames } = {}) {
    if (state.busy) return;
    ensureUi();
    state.busy = true;
    setError('');
    setStatus('Cerco…');
    const result = await searchRecipes({
      ingredients: state.criteria.ingredients,
      slot: state.criteria.slot,
      note: state.criteria.note,
      excludeNames: Array.isArray(excludeNames) ? excludeNames : []
    });
    setStatus('');
    state.busy = false;
    if (result.error) {
      state.recipes = [];
      setError(result.error);
      renderResults();
      return;
    }
    const seen = new Set(state.seenNames.map(name => String(name || '').toLowerCase()));
    const fresh = result.recipes.filter(recipe => {
      const name = String(recipe?.name || '').trim();
      if (!name) return false;
      return !seen.has(name.toLowerCase());
    });
    if (!fresh.length) {
      state.recipes = [];
      setError('Non ho trovato altre ricette diverse da quelle già mostrate.');
      renderResults();
      return;
    }
    state.seenNames = state.seenNames.concat(fresh.map(recipe => String(recipe.name).trim()));
    state.recipes = fresh;
    state.sources = result.sources || [];
    renderResults();
  }

  // -----------------------------------------------------------------------
  // Confronto con le grammature Meller (lato app, non lato modello)
  // -----------------------------------------------------------------------

  // La ricetta arriva dal web con `ingredients: [{ name, quantity }]`; il
  // dominio ragiona su `portions` A/R per profilo. Qui si costruisce la forma
  // attesa da checkMellerAdaptation/adaptRecipeToMeller: la dose della fonte
  // vale per tutte e quattro le combinazioni profilo × giorno.
  function toDomainRecipe(recipe) {
    const quantity = value => {
      const clean = String(value ?? '').trim();
      return clean || '—';
    };
    return {
      id: 'websearch',
      slot: SLOTS.some(item => item.id === recipe?.slot) ? recipe.slot : 'lunch',
      name: String(recipe?.name || 'Ricetta'),
      ingredients: (Array.isArray(recipe?.ingredients) ? recipe.ingredients : []).map(item => ({
        name: String(item?.name || '').trim() || 'Ingrediente',
        portions: {
          ipoTraining: quantity(item?.quantity),
          ipoRest: quantity(item?.quantity),
          manTraining: quantity(item?.quantity),
          manRest: quantity(item?.quantity)
        }
      })),
      steps: (Array.isArray(recipe?.steps) ? recipe.steps : []).map(step => String(step || ''))
    };
  }

  // Scostamenti rispetto al manuale Meller per il pasto della ricetta.
  // La ricetta trovata sul web ha UNA sola dose per ingrediente, mentre il
  // manuale distingue allenamento e riposo: si mostra (e si applica) il
  // riferimento più restrittivo, così la dose va bene in entrambe le giornate.
  // Restituisce null quando non c'è nulla da segnalare: le schede restano pulite.
  function mellerCheckFor(recipe) {
    const check = root.PianoDomain?.checkMellerAdaptation?.(toDomainRecipe(recipe));
    if (!check || check.adapted || !check.issues?.length) return null;
    const rows = [];
    check.issues.forEach(issue => {
      const row = rows.find(item => item.ingredient === issue.ingredient);
      if (!row) {
        rows.push({ ingredient: issue.ingredient, actual: issue.actual, expected: issue.expected, unit: issue.unit });
        return;
      }
      row.actual = Math.max(row.actual, issue.actual);
      row.expected = Math.min(row.expected, issue.expected);
    });
    return { rows };
  }

  // Applica le correzioni Meller alla ricetta MOSTRATA (formato web:
  // `quantity` per ingrediente), riusando l'adattamento del dominio: un solo
  // algoritmo per popup, ricettario e ricerca online.
  function adaptRecipeQuantities(recipe) {
    const check = mellerCheckFor(recipe);
    if (!check) return null;
    const byIngredient = new Map(check.rows.map(row => [row.ingredient, row]));
    return {
      ...recipe,
      ingredients: (Array.isArray(recipe.ingredients) ? recipe.ingredients : []).map(item => {
        const row = byIngredient.get(String(item?.name || '').trim() || 'Ingrediente');
        return row ? { ...item, quantity: `${row.expected}${row.unit === 'ml' ? ' ml' : ' g'}` } : item;
      })
    };
  }

  function mellerNoticeHtml(check) {
    if (!check) return '';
    const items = check.rows.slice(0, 3).map(row => {
      const unit = row.unit === 'ml' ? ' ml' : ' g';
      return `<li><span>${escape(row.ingredient)}</span><strong>${row.actual}${unit} → ${row.expected}${unit}</strong></li>`;
    }).join('');
    const more = check.rows.length > 3
      ? `<li class="websearch-meller-more">…e altre ${check.rows.length - 3} dosi fuori riferimento</li>`
      : '';
    return `
      <div class="websearch-meller">
        <p class="websearch-meller-head"><span aria-hidden="true">⚠️</span> ${check.rows.length} dos${check.rows.length === 1 ? 'e non aderente' : 'i non aderenti'} alle grammature del dott. Meller</p>
        <ul class="websearch-meller-list">${items}${more}</ul>
        <button type="button" class="btn btn-outline websearch-meller-fix" data-action="adapt">Correggi dosi Meller</button>
      </div>`;
  }

  function recipeCardHtml(recipe, index) {
    const emoji = String(recipe?.emoji || '').trim() || '🍽️';
    const ingredients = Array.isArray(recipe?.ingredients) ? recipe.ingredients : [];
    const steps = Array.isArray(recipe?.steps) ? recipe.steps : [];
    const preview = ingredients.slice(0, 3)
      .map(item => `${String(item?.name || '').trim()}${item?.quantity ? ` ${String(item.quantity).trim()}` : ''}`.trim())
      .filter(Boolean).join(' · ');
    const url = safeUrl(recipe?.sourceUrl);
    const sourceTitle = String(recipe?.sourceTitle || '').trim() || 'Fonte';
    const check = mellerCheckFor(recipe);
    const badge = recipe?._mellerAdapted
      ? `<span class="websearch-meller-ok" title="Dosi riportate alle grammature del dott. Meller">✓ Meller</span>`
      : (check ? `<span class="websearch-meller-flag" title="Dosi non aderenti alle grammature del dott. Meller">⚠</span>` : '');
    return `
      <article class="websearch-card${check ? ' has-meller-notice' : ''}" data-index="${index}">
        <div class="websearch-card-open" role="button" tabindex="0" data-action="open">
          <div class="websearch-card-head">
            <span class="websearch-card-emoji">${escape(emoji)}</span>
            <div>
              <strong>${escape(recipe?.name || 'Ricetta')}${badge}</strong>
              <small>${escape(slotLabel(recipe?.slot))} · ${ingredients.length} ingredienti · ${steps.length} passaggi</small>
            </div>
          </div>
          ${preview ? `<p>${escape(preview)}</p>` : ''}
        </div>
        ${mellerNoticeHtml(check)}
        <div class="websearch-card-foot">
          <span class="websearch-open-hint" data-action="open">Apri e importa →</span>
          ${url ? `<a class="websearch-card-source" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(sourceTitle)}</a>` : ''}
        </div>
      </article>`;
  }

  function renderResults() {
    ensureUi();
    if (!state.recipes.length) {
      ui.results.innerHTML = '';
      return;
    }
    const withIssues = state.recipes.filter(recipe => mellerCheckFor(recipe)).length;
    ui.results.innerHTML = `
      ${state.recipes.map(recipeCardHtml).join('')}
      <p class="websearch-count">${state.recipes.length} ricette trovate: tocca una scheda per aprirla e importarla.${withIssues ? ` <strong>${withIssues}</strong> hanno dosi fuori dalle grammature Meller.` : ''}</p>
      <div class="websearch-actions">
        ${withIssues ? `<button type="button" class="btn btn-outline" data-action="adapt-all">✓ Correggi tutte (Meller)</button>` : ''}
        <button type="button" class="btn btn-primary" data-action="import-all">⤓ Importa tutte (${state.recipes.length})</button>
      </div>
      <div class="websearch-actions">
        <button type="button" class="btn btn-outline" data-action="more">↻ Altre 10 ricette</button>
        <button type="button" class="btn btn-outline" data-action="edit">← Modifica ricerca</button>
      </div>`;

    ui.results.querySelectorAll('.websearch-card').forEach(card => {
      const index = Number(card.getAttribute('data-index'));
      const activate = () => openRecipe(state.recipes[index]);
      card.querySelectorAll('[data-action="open"]').forEach(target => {
        target.addEventListener('click', activate);
        target.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            activate();
          }
        });
      });
      // Correzione con un click della singola ricetta: la scheda si aggiorna
      // sul posto, senza aprire il popup e senza rifare la ricerca.
      const fix = card.querySelector('[data-action="adapt"]');
      if (fix) fix.addEventListener('click', event => {
        event.stopPropagation();
        adaptRecipeAt(index);
      });
    });
    ui.results.querySelectorAll('.websearch-card-source').forEach(link => {
      link.addEventListener('click', event => event.stopPropagation());
    });
    const adaptAll = ui.results.querySelector('[data-action="adapt-all"]');
    if (adaptAll) adaptAll.addEventListener('click', adaptAllRecipes);
    const importAll = ui.results.querySelector('[data-action="import-all"]');
    if (importAll) importAll.addEventListener('click', importAllRecipes);
    const more = ui.results.querySelector('[data-action="more"]');
    if (more) more.addEventListener('click', () => runSearch({ excludeNames: state.seenNames.slice() }));
    const edit = ui.results.querySelector('[data-action="edit"]');
    if (edit) edit.addEventListener('click', () => {
      state.recipes = [];
      renderResults();
      try { ui.ingredients.focus(); } catch (_) {}
    });
  }

  // -----------------------------------------------------------------------
  // Correzione Meller e importazione
  // -----------------------------------------------------------------------

  function adaptRecipeAt(index) {
    const recipe = state.recipes[index];
    if (!recipe) return;
    const adapted = adaptRecipeQuantities(recipe);
    if (!adapted) {
      toast('Le dosi rispettano già le grammature Meller');
      return;
    }
    state.recipes[index] = { ...adapted, _mellerAdapted: true };
    renderResults();
    toast('Dosi adattate alle grammature Meller ✅');
  }

  function adaptAllRecipes() {
    let changed = 0;
    state.recipes = state.recipes.map(recipe => {
      const adapted = adaptRecipeQuantities(recipe);
      if (!adapted) return recipe;
      changed += 1;
      return { ...adapted, _mellerAdapted: true };
    });
    renderResults();
    toast(changed
      ? `${changed} ricett${changed === 1 ? 'a adattata' : 'e adattate'} alle grammature Meller ✅`
      : 'Nessuna dose da correggere');
  }

  // Importazione in blocco: salva tutte le ricette mostrate nel ricettario in
  // una sola scrittura, senza passare dal popup una per una.
  async function importAllRecipes() {
    const recipes = state.recipes.slice();
    if (!recipes.length) return;
    if (typeof root.importRecipesFromWebSearchBulk !== 'function') {
      toast('Importazione in blocco non disponibile in questa schermata.', true);
      return;
    }
    const button = ui.results?.querySelector('[data-action="import-all"]');
    if (button) {
      button.disabled = true;
      button.textContent = 'Importazione…';
    }
    try {
      const imported = await root.importRecipesFromWebSearchBulk(recipes);
      if (imported) closeModal();
    } catch (error) {
      toast(error?.message || 'Importazione non riuscita', true);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = `⤓ Importa tutte (${recipes.length})`;
      }
    }
  }

  function openRecipe(recipe) {
    if (!recipe) return;
    closeModal();
    if (typeof root.importRecipeFromWebSearch === 'function') {
      root.importRecipeFromWebSearch(recipe);
      return;
    }
    toast('Popup ricetta non disponibile in questa schermata.', true);
  }

  // La ricerca ricette vive SOLO nel Ricettario ("🌐 Cerca nel web"): nelle
  // Impostazioni non esiste più alcuna sezione AI.

  root.PianoWebSearch = {
    init: ensureUi,
    open: openModal,
    close: closeModal,
    isOpen: () => state.open,
    _state: state,
    _search: searchRecipes
  };

  document.addEventListener('DOMContentLoaded', ensureUi);
})(typeof globalThis !== 'undefined' ? globalThis : window);
