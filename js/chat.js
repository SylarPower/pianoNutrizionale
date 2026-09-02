/* Chat AI Piano Nutrizionale.
 *
 * Pulsante flottante che apre una chat testuale. La chat risponde SOLO a
 * domande sulla webapp (piano, ricette, spesa, batch cooking, guida Meller)
 * usando i dati già caricati dall'app: nessuna chiamata AI esterna. L'unica
 * ricerca web ammessa è quella di NUOVE ricette con determinate
 * caratteristiche, servita dal Worker Cloudflare sull'endpoint /recipes.
 *
 * La dettatura è quella nativa del telefono/browser (microfono della
 * tastiera): non c'è alcun riconoscimento o sintesi vocale in-app.
 */
(function (root) {
  'use strict';

  const domain = root.PianoChatDomain;
  const config = root.PIANO_AI_CONFIG || {};

  const QUICK_ACTIONS = [
    { label: 'Cosa mangio oggi?', text: 'Cosa mangio oggi?' },
    { label: 'Piano della settimana', text: 'Piano della settimana' },
    { label: 'Lista della spesa', text: 'Mostrami la lista della spesa' },
    { label: 'Batch cooking', text: 'Quali preparazioni batch sono disponibili oggi?' },
    { label: 'Ricetta con pollo e riso', text: 'Ricetta con pollo e riso' }
  ];

  const state = {
    available: false,
    open: false,
    busy: false,
    messages: [],
    msgSeq: 0
  };

  const ui = {};

  function getConfig() {
    return root.PIANO_AI_CONFIG || config;
  }

  function hasRecipesEndpoint() {
    const endpoint = String(getConfig().recipesEndpoint || '').trim();
    return Boolean(endpoint && !/^https?:\/\/YOUR[-_A-Z0-9.]+/i.test(endpoint) && /^https?:\/\//i.test(endpoint));
  }

  function currentProfile() {
    try {
      return typeof getPortionProfile === 'function' ? getPortionProfile() : 'man';
    } catch (_) {
      return 'man';
    }
  }

  function currentDay() {
    return domain?.todayKey ? domain.todayKey(new Date()) : 'monday';
  }

  function currentState() {
    try {
      return typeof appState !== 'undefined' ? appState : { plan: null, recipes: [], recipesById: {}, user: null, household: null };
    } catch (_) {
      return { plan: null, recipes: [], recipesById: {}, user: null, household: null };
    }
  }

  function escape(value) {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
    return String(value ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function normalized(value) {
    return domain?.normalizeText ? domain.normalizeText(value) : String(value || '').toLowerCase().trim();
  }

  function dayFromArg(value) {
    return domain?.resolveDay ? domain.resolveDay(value, currentDay()) : currentDay();
  }

  function slotFromArg(value, fallback = 'dinner') {
    return domain?.resolveSlot ? domain.resolveSlot(value, fallback) : fallback;
  }

  function slotLabel(slot) {
    return domain?.SLOT_LABELS?.[slot] || slot;
  }

  function dayLabel(day) {
    return domain?.DAY_LABELS?.[day] || day;
  }

  function mealFor(day, slot) {
    const data = currentState();
    return domain?.mealDetails
      ? domain.mealDetails(data, day, slot, currentProfile(), root.PianoDomain)
      : { found: false, message: 'Dati del piano non disponibili.' };
  }

  function recipeRecords() {
    const data = currentState();
    const recipes = Array.isArray(data.recipes) ? data.recipes : [];
    return recipes.map(recipe => ({
      title: recipe.name || recipe.id || 'Ricetta',
      section: `Ricetta ${recipe.slot || ''}`.trim(),
      text: [
        recipe.id, recipe.name, recipe.namesByDayType?.training, recipe.namesByDayType?.rest,
        recipe.proteinCategory,
        ...(recipe.ingredients || []).flatMap(item => [item.name, JSON.stringify(item.portions || {})]),
        ...(recipe.steps || []), ...(recipe.notes || []), recipe.specialNote
      ].filter(Boolean).join(' · '),
      excerpt: [
        ...(recipe.ingredients || []).map(item => item.name),
        ...(recipe.steps || []).slice(0, 2)
      ].filter(Boolean).join(' · '),
      recipeId: recipe.id
    }));
  }

  function guideRecords() {
    let guide;
    try { guide = typeof MELLER_GUIDE !== 'undefined' ? MELLER_GUIDE : null; } catch (_) { guide = null; }
    if (!guide) return [];
    const records = [];
    const add = (title, value, section = 'Guida di Meller') => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => add(`${title} ${index + 1}`, item, section));
        return;
      }
      if (value && typeof value === 'object') {
        Object.entries(value).forEach(([key, item]) => add(`${title} · ${key}`, item, section));
        return;
      }
      if (value !== undefined && value !== null && String(value).trim()) {
        records.push({ title, section, text: `${title} ${String(value)}`, excerpt: String(value) });
      }
    };
    add('Manuale alimentare', guide);
    return records;
  }

  function getShopping() {
    try {
      if (typeof getVisibleShoppingEntries !== 'function') return [];
      const entries = getVisibleShoppingEntries();
      return entries.map(entry => ({
        name: entry.name,
        category: entry.category,
        quantity: typeof shoppingAmountText === 'function' ? shoppingAmountText(entry) : '',
        tags: entry.tags || []
      }));
    } catch (_) {
      return [];
    }
  }

  function getBatch(day) {
    try {
      if (typeof getActiveBatch !== 'function') return [];
      return getActiveBatch(day).map(batch => ({
        targetDay: batch.targetDay,
        daysUntilTarget: batch.daysUntilTarget,
        title: batch.template?.title || 'Preparazione in anticipo',
        tasks: (batch.tasks || []).map(task => ({ label: task.label, quantity: task.quantity, status: task.status }))
      }));
    } catch (_) {
      return [];
    }
  }

  function formatAmount(quantity) {
    if (quantity && typeof quantity === 'object') {
      return `uomo ${quantity.man || '—'} · donna IPO ${quantity.ipo || '—'}`;
    }
    return String(quantity ?? '—');
  }

  function profileLabel(profile) {
    return { man: 'uomo', ipo: 'donna IPO', couple: 'uomo e donna IPO' }[profile] || profile;
  }

  // ---------------------------------------------------------------------
  // Tool deterministici (sola lettura) sui dati dell'app.
  // ---------------------------------------------------------------------

  function executeTool(name, args = {}) {
    const data = currentState();
    const profile = currentProfile();

    if (name === 'get_current_plan') {
      const day = dayFromArg(args.day);
      const dayData = data.plan?.days?.[day];
      if (!dayData) return { message: `Non trovo il giorno ${dayLabel(day)}.` };
      const lines = (domain?.SLOTS || []).map(slot => {
        const meal = mealFor(day, slot);
        return meal.found ? `• ${meal.slotLabel}: ${meal.recipeName}` : `• ${meal.slotLabel}: non pianificato`;
      });
      return {
        message: `Piano di ${dayLabel(day)} (giorno ${dayData.type === 'training' ? 'A' : 'R'}):`,
        list: lines
      };
    }

    if (name === 'get_meal_details') {
      const day = dayFromArg(args.day);
      const slot = slotFromArg(args.slot, 'dinner');
      const meal = mealFor(day, slot);
      if (!meal.found) return { message: meal.message };
      const ingredients = (meal.ingredients || []).map(item => `• ${item.name}: ${formatAmount(item.quantity)}`);
      return {
        message: `${meal.slotLabel} di ${meal.dayLabel}: ${meal.recipeName}.`,
        list: ingredients,
        openRecipeId: meal.recipeId,
        openLabel: 'Apri la ricetta'
      };
    }

    if (name === 'get_fruit_quantity') {
      const day = dayFromArg(args.day);
      const slot = slotFromArg(args.slot, 'snack1');
      const meal = mealFor(day, slot);
      if (!meal.found) return { message: meal.message };
      const originalRecipe = data.recipesById?.[meal.recipeId] || (data.recipes || []).find(item => item.id === meal.recipeId);
      if (!originalRecipe) return { message: 'Non riesco a leggere la dose della frutta dal catalogo attivo.' };
      const exactFruit = domain.sumFruitQuantity(originalRecipe, slot, meal.dayType, profile, root.PianoDomain);
      return { message: exactFruit.message };
    }

    if (name === 'get_shopping_list') {
      const category = normalized(args.category || '');
      const items = getShopping().filter(item => !category || normalized(item.category).includes(category) || normalized(item.name).includes(category));
      if (!items.length) return { message: 'Non trovo elementi corrispondenti nella lista della spesa.' };
      const grouped = {};
      items.forEach(item => { (grouped[item.category] ||= []).push(item); });
      const lines = Object.entries(grouped).map(([cat, list]) => `\n${cat}\n${list.map(item => `• ${item.name}${item.quantity ? ` — ${item.quantity}` : ''}`).join('\n')}`);
      return { message: `Ho trovato ${items.length} elementi nella lista della spesa.`, list: lines };
    }

    if (name === 'get_account_context') {
      const user = data.user || {};
      const username = String(user.email || '').split('@')[0] || 'account attivo';
      const household = data.household || null;
      const members = Array.isArray(household?.memberUsernames)
        ? household.memberUsernames.filter(name => name && name !== username)
        : [];
      return {
        message: household
          ? `Account ${username}. Household condivisa attiva con ${members.length ? members.join(', ') : 'gli account collegati'}. Profilo porzioni: ${profileLabel(profile)}.`
          : `Account ${username}. Nessuna household attiva. Profilo porzioni: ${profileLabel(profile)}.`
      };
    }

    if (name === 'get_batch_cooking') {
      const day = dayFromArg(args.day);
      const batches = getBatch(day);
      if (!batches.length) return { message: 'Non risultano preparazioni batch cooking disponibili per questo giorno.' };
      const lines = batches.map(batch => {
        const target = domain?.DAY_LABELS?.[batch.targetDay] || batch.targetDay;
        const tasks = batch.tasks.map(task => `• ${task.label}${task.quantity ? ` — ${task.quantity}` : ''}`);
        return `${batch.title}\n🎯 pranzo di ${target}${batch.daysUntilTarget ? ` · tra ${batch.daysUntilTarget} giorni` : ''}\n${tasks.join('\n')}`;
      });
      return { message: `Ci sono ${batches.length} preparazioni in anticipo.`, list: lines };
    }

    if (name === 'search_app_content') {
      const query = String(args.query || '').trim();
      if (!query) return { message: 'Dimmi cosa vuoi cercare nell’app.' };
      const records = [...recipeRecords(), ...guideRecords()];
      const results = domain?.searchText ? domain.searchText(records, query, 8) : [];
      if (!results.length) return { message: 'Non trovo questo argomento nei contenuti dell’app.' };
      const recipeResults = results.filter(item => item.recipeId);
      return {
        message: recipeResults.length ? `Ho trovato ${recipeResults.length} risultati nel catalogo.` : 'Ho trovato queste informazioni nella guida:',
        list: results.filter(item => !item.recipeId).map(item => `• ${item.title}: ${item.excerpt}`),
        recipes: recipeResults.map(item => ({
          recipeId: item.recipeId,
          title: item.title,
          excerpt: item.excerpt
        }))
      };
    }

    return { message: 'Non posso eseguire questa azione.' };
  }

  // ---------------------------------------------------------------------
  // Ricerca web di nuove ricette (Worker Cloudflare /recipes).
  // ---------------------------------------------------------------------

  function recipesEndpoint() {
    return String(getConfig().recipesEndpoint || '').trim();
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

  async function searchRecipes(query) {
    const clean = String(query || '').trim();
    if (!hasRecipesEndpoint()) {
      return { error: 'Per cercare nuove ricette serve il Worker Cloudflare: inserisci l’URL /recipes in js/chat-config.js e pubblica il Worker. Le domande su piano, ricette e spesa funzionano comunque.' };
    }
    let idToken;
    try {
      idToken = await getIdToken();
    } catch (error) {
      return { error: error?.message || 'Sessione non disponibile: accedi di nuovo alla webapp.' };
    }
    try {
      const response = await fetch(recipesEndpoint(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({ query: clean, language: getConfig().language || 'it-IT', maxRecipes: Number(getConfig().maxRecipes) || 10 })
      });
      let body = null;
      try { body = await response.json(); } catch (_) {}
      if (response.status === 429) {
        return { error: 'Troppe ricerche di ricette in poco tempo: attendi qualche minuto e riprova.' };
      }
      if (!response.ok) {
        return { error: body?.error || `Ricerca delle ricette non riuscita (${response.status}).` };
      }
      const recipes = Array.isArray(body?.recipes) ? body.recipes : [];
      if (!recipes.length) return { error: 'Non ho trovato ricette corrispondenti. Riprova con una richiesta diversa.' };
      return { recipes: recipes.slice(0, Number(getConfig().maxRecipes) || 10), sources: Array.isArray(body?.sources) ? body.sources : [] };
    } catch (error) {
      return { error: error?.message || 'Ricerca delle ricette non riuscita. Controlla la connessione e riprova.' };
    }
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function sourcesHtml(sources) {
    const links = (Array.isArray(sources) ? sources : []).map(source => {
      let url = '';
      try { const parsed = new URL(String(source?.url || '')); if (['http:', 'https:'].includes(parsed.protocol)) url = parsed.href; } catch (_) {}
      if (!url) return '';
      const title = source?.title || url;
      return `<li><a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(title)}</a></li>`;
    }).filter(Boolean).join('');
    return links ? `<div class="chat-sources"><span>Fonti</span><ul>${links}</ul></div>` : '';
  }

  function aiRecipeCardHtml(recipe, messageId) {
    const ingredients = (recipe?.ingredients || []).slice(0, 3).map(item => `${item.name}${item.quantity ? ` ${item.quantity}` : ''}`).join(' · ');
    const source = recipe?.sourceUrl ? `<a class="chat-recipe-source" href="${escape(recipe.sourceUrl)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">↗ ${escape(recipe.sourceTitle || 'fonte')}</a>` : '';
    return `
      <div class="chat-recipe-card" data-action="open-ai-recipe" data-msg="${messageId}" data-idx="${escape(recipe._idx)}" role="button" tabindex="0">
        <div class="chat-recipe-card-head"><span class="chat-recipe-emoji">${escape(recipe.emoji || '🍲')}</span><div><strong>${escape(recipe.name || 'Ricetta')}</strong><small>${escape((recipe.ingredients || []).length)} ingredienti · ${escape((recipe.steps || []).length)} passaggi</small></div></div>
        <p>${escape(ingredients)}</p>
        <div class="chat-recipe-card-foot"><span class="chat-open-hint">Apri e importa →</span>${source}</div>
      </div>`;
  }

  function searchRecipeCardHtml(item) {
    return `
      <div class="chat-recipe-card chat-catalog-card" data-action="open-catalog-recipe" data-recipe-id="${escape(item.recipeId)}" role="button" tabindex="0">
        <div class="chat-recipe-card-head"><span class="chat-recipe-emoji">🍲</span><div><strong>${escape(item.title)}</strong><small>${escape(item.excerpt || '')}</small></div></div>
        <div class="chat-recipe-card-foot"><span class="chat-open-hint">Apri →</span></div>
      </div>`;
  }

  function messageHtml(message) {
    if (message.kind === 'recipes') {
      const cards = (message.recipes || []).map((recipe, index) => aiRecipeCardHtml({ ...recipe, _idx: index }, message.id)).join('');
      return `<div class="chat-message from-assistant"><span class="chat-message-author">Piano</span><p class="chat-lead">${escape(message.text)}</p><div class="chat-recipe-list">${cards}</div>${sourcesHtml(message.sources)}</div>`;
    }
    if (message.kind === 'search') {
      const cards = (message.recipes || []).map(searchRecipeCardHtml).join('');
      const list = (message.list || []).map(line => `<p class="chat-guide-line">${escape(line)}</p>`).join('');
      return `<div class="chat-message from-assistant"><span class="chat-message-author">Piano</span><p>${escape(message.text)}</p>${cards}${list}</div>`;
    }
    if (message.kind === 'result') {
      const list = (message.list || []).map(line => `<p class="chat-list-line">${escape(line)}</p>`).join('');
      const open = message.openRecipeId
        ? `<button class="chat-open-recipe" data-action="open-catalog-recipe" data-recipe-id="${escape(message.openRecipeId)}">${escape(message.openLabel || 'Apri la ricetta')}</button>`
        : '';
      return `<div class="chat-message from-assistant${message.error ? ' chat-error' : ''}"><span class="chat-message-author">Piano</span><p>${escape(message.text)}</p>${list}${open}</div>`;
    }
    if (message.kind === 'typing') {
      return `<div class="chat-message from-assistant chat-typing"><span class="chat-message-author">Piano</span><p><span class="dot"></span><span class="dot"></span><span class="dot"></span></p></div>`;
    }
    const role = message.role === 'user' ? 'user' : 'assistant';
    const author = role === 'user' ? 'Tu' : 'Piano';
    return `<div class="chat-message from-${role}${message.error ? ' chat-error' : ''}"><span class="chat-message-author">${author}</span><p>${escape(message.text || '')}</p></div>`;
  }

  function renderMessages() {
    if (!ui.messages) return;
    ui.messages.innerHTML = state.messages.map(messageHtml).join('');
    ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  function nextId() {
    state.msgSeq += 1;
    return state.msgSeq;
  }

  function addAssistant(kind, extra = {}) {
    state.messages.push({ id: nextId(), role: 'assistant', kind, text: '', ...extra });
    renderMessages();
    return state.messages[state.messages.length - 1];
  }

  function addUser(text) {
    state.messages.push({ id: nextId(), role: 'user', kind: 'text', text });
    renderMessages();
  }

  function setTyping(active) {
    const existing = state.messages.findIndex(message => message.kind === 'typing');
    if (active) {
      if (existing < 0) { state.messages.push({ id: nextId(), role: 'assistant', kind: 'typing', text: '' }); renderMessages(); }
    } else if (existing >= 0) {
      state.messages.splice(existing, 1);
    }
  }

  // ---------------------------------------------------------------------
  // Apertura / chiusura
  // ---------------------------------------------------------------------

  function openRecipePopup(recipe) {
    try {
      if (typeof importRecipeFromChat === 'function') {
        importRecipeFromChat(recipe);
        return true;
      }
      if (typeof importRecipeFromAssistant === 'function') {
        importRecipeFromAssistant(recipe);
        return true;
      }
      if (typeof showToast === 'function') showToast('Il popup di importazione ricette non è disponibile.', true);
      return false;
    } catch (error) {
      if (typeof showToast === 'function') showToast(error?.message || 'Apertura della ricetta non riuscita.', true);
      return false;
    }
  }

  function handleMessageAction(target) {
    const action = target?.dataset?.action;
    if (action === 'open-ai-recipe') {
      const message = state.messages.find(item => item.id === Number(target.dataset.msg));
      if (message) {
        const recipe = message.recipes?.[Number(target.dataset.idx)];
        if (recipe) openRecipePopup(recipe);
      }
    } else if (action === 'open-catalog-recipe') {
      const recipeId = target?.dataset?.recipeId;
      if (recipeId && typeof openRecipeModal === 'function') openRecipeModal(recipeId);
    }
  }

  function sendQuickAction(text) {
    if (!state.open || state.busy) return;
    ui.input.value = '';
    processInput(text);
  }

  async function processInput(raw) {
    const clean = String(raw || '').trim();
    if (!clean || state.busy) return;
    state.busy = true;
    addUser(clean);
    setTyping(true);

    const handleRecipeSearch = async () => {
      const result = await searchRecipes(clean);
      setTyping(false);
      if (result.error) {
        addAssistant('result', { text: result.error, error: true });
      } else {
        addAssistant('recipes', { text: `Ecco ${result.recipes.length} ricette trovate per “${clean}”. Tocca una scheda per aprirla e importarla.`, recipes: result.recipes, sources: result.sources });
      }
      state.busy = false;
    };

    if (domain?.analyzeRecipeRequest?.(clean)) {
      await handleRecipeSearch();
      return;
    }

    const intent = domain?.analyzeLocalIntent ? domain.analyzeLocalIntent(clean) : null;

    if (!intent) {
      setTyping(false);
      addAssistant('result', {
        text: 'Posso aiutarti con domande sulla webapp: piano della settimana, cosa mangi in un pasto, lista della spesa, batch cooking, guida e alternative di Meller, o cercare una nuova ricetta dal web (es. “ricetta con pollo e riso”).'
      });
      state.busy = false;
      return;
    }

    if (intent.localReply) {
      setTyping(false);
      addAssistant('result', { text: intent.localReply });
      state.busy = false;
      return;
    }
    if (intent.outOfScope) {
      setTyping(false);
      addAssistant('result', { text: intent.message, error: true });
      state.busy = false;
      return;
    }

    let result;
    try {
      result = executeTool(intent.tool, intent.args || {});
    } catch (error) {
      result = { message: error?.message || 'Non riesco a rispondere adesso.', error: true };
    }
    setTyping(false);
    if (result.error) {
      addAssistant('result', { text: result.message, error: true });
    } else if (result.recipes || result.list || result.openRecipeId) {
      addAssistant('result', {
        text: result.message,
        list: result.list,
        recipes: (result.recipes || []).map(item => ({ recipeId: item.recipeId, title: item.title, excerpt: item.excerpt })),
        openRecipeId: result.openRecipeId,
        openLabel: result.openLabel
      });
    } else {
      addAssistant('result', { text: result.message || 'Fatto.' });
    }
    state.busy = false;
  }

  function welcomeMessage() {
    return {
      id: nextId(),
      role: 'assistant',
      kind: 'result',
      text: 'Ciao! Sono il tuo aiuto per la webapp. Chiedimi del piano, delle ricette, della spesa o del batch cooking; per una ricetta nuova scrivi “ricetta con…”.'
    };
  }

  function openChat() {
    if (!state.available) return;
    state.open = true;
    ui.fab?.classList.add('is-active');
    ui.fab?.setAttribute('aria-label', 'Chiudi chat AI');
    ui.panel?.classList.remove('hidden');
    if (!state.messages.length) {
      state.messages.push(welcomeMessage());
      renderMessages();
    }
    setTimeout(() => ui.input?.focus(), 60);
  }

  function closeChat() {
    state.open = false;
    state.busy = false;
    setTyping(false);
    ui.fab?.classList.remove('is-active');
    ui.fab?.setAttribute('aria-label', 'Apri chat AI');
    ui.panel?.classList.add('hidden');
  }

  function toggleChat() {
    if (state.open) closeChat();
    else openChat();
  }

  function ensureUi() {
    if (ui.fab) return;
    const fab = document.createElement('button');
    fab.id = 'chat-fab';
    fab.className = 'chat-fab hidden';
    fab.type = 'button';
    fab.innerHTML = '<svg class="chat-fab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
    fab.setAttribute('aria-label', 'Apri chat AI');
    fab.title = 'Chat AI';
    fab.addEventListener('click', toggleChat);
    document.body.append(fab);
    ui.fab = fab;

    const panel = document.createElement('section');
    panel.id = 'chat-panel';
    panel.className = 'chat-panel hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', 'Chat AI');
    panel.innerHTML = `
      <header class="chat-header">
        <div class="chat-title-wrap">
          <span class="chat-mark" aria-hidden="true">✦</span>
          <div><p class="eyebrow">AI WEBAPP</p><h2>Piano</h2></div>
        </div>
        <button class="btn-icon chat-close" type="button" aria-label="Chiudi chat">&times;</button>
      </header>
      <div class="chat-status"><span class="chat-status-dot"></span> Risposte basate sui dati della tua app</div>
      <div class="chat-messages" id="chat-messages" aria-live="polite"></div>
      <div class="chat-quick-actions" id="chat-quick-actions"></div>
      <form class="chat-input-form" id="chat-input-form">
        <input id="chat-input" type="text" inputmode="text" enterkeyhint="send" autocomplete="off" placeholder="Chiedi del piano, ricette o spesa…" aria-label="Scrivi un messaggio">
        <button class="chat-send" type="submit" aria-label="Invia">➤</button>
      </form>
      <p class="chat-hint">Solo domande sulla webapp · per una ricetta nuova scrivi “ricetta con…”</p>
    `;
    document.body.append(panel);
    ui.panel = panel;
    ui.messages = panel.querySelector('#chat-messages');
    ui.input = panel.querySelector('#chat-input');
    ui.quick = panel.querySelector('#chat-quick-actions');

    ui.quick.innerHTML = QUICK_ACTIONS.map(action =>
      `<button type="button" data-action="send-quick" data-text="${escape(action.text)}">${escape(action.label)}</button>`
    ).join('');

    panel.querySelector('.chat-close').addEventListener('click', closeChat);
    panel.querySelector('#chat-input-form').addEventListener('submit', event => {
      event.preventDefault();
      const value = ui.input.value;
      ui.input.value = '';
      processInput(value);
    });

    ui.panel.addEventListener('click', event => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      if (target.dataset.action === 'send-quick') {
        sendQuickAction(target.dataset.text);
        return;
      }
      handleMessageAction(target);
    });
    ui.messages.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target.closest('[data-action]');
      if (!target) return;
      event.preventDefault();
      if (target.dataset.action === 'send-quick') sendQuickAction(target.dataset.text);
      else handleMessageAction(target);
    });
  }

  function setAvailability(available) {
    ensureUi();
    state.available = Boolean(available);
    ui.fab.classList.toggle('hidden', !state.available);
    if (!state.available) closeChat();
  }

  function settingsSectionHtml() {
    const configured = hasRecipesEndpoint();
    return `
      <section class="settings-section chat-settings-section">
        <div class="chat-settings-icon">✦</div>
        <div class="chat-settings-copy"><p class="eyebrow">AI · CHAT</p><h2>Assistente testuale</h2><p>${configured ? 'Tocca il pulsante fluttuante e chiedi di piano, ricette, spesa o batch cooking: le risposte arrivano dai dati della tua app. Per le nuove ricette dal web l’AI propone fino a 10 proposte da importare.' : 'Tocca il pulsante fluttuante e chiedi di piano, ricette, spesa o batch cooking: le risposte arrivano dai dati della tua app. Per le nuove ricette dal web completa la configurazione del Worker gratuito.'}</p><small>Nessun riconoscimento vocale in-app: usa la dettatura nativa della tastiera. Le domande sulla webapp restano locali e private.</small></div>
        <button class="btn ${configured ? 'btn-primary' : 'btn-outline'}" type="button" onclick="window.PianoChat.open()">${configured ? 'Apri chat' : 'Configura e prova'}</button>
      </section>`;
  }

  root.PianoChat = {
    init: ensureUi,
    open: openChat,
    close: closeChat,
    toggle: toggleChat,
    setAvailability,
    settingsSectionHtml,
    isOpen: () => state.open,
    executeTool,
    _state: state,
    // Hook per gli smoke test: interpretazione e ricerca senza rete reale.
    _analyzeLocalIntent: value => domain?.analyzeLocalIntent ? domain.analyzeLocalIntent(value) : null,
    _analyzeRecipeRequest: value => domain?.analyzeRecipeRequest ? domain.analyzeRecipeRequest(value) : false,
    _searchRecipes: searchRecipes,
    _send: processInput
  };

  document.addEventListener('DOMContentLoaded', ensureUi);
})(typeof globalThis !== 'undefined' ? globalThis : window);
