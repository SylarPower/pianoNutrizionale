/* Assistente vocale Piano Nutrizionale.
 *
 * Il browser mantiene il microfono e una sessione WebSocket Gemini Live aperti
 * finché l'utente non chiude la modalità. Le quantità, il piano e l'avanzamento
 * della preparazione vengono invece calcolati localmente dai tool deterministici
 * esposti qui: Gemini è la voce conversazionale, non la fonte dei numeri.
 */
(function (root) {
  'use strict';

  const domain = root.PianoAssistantDomain;
  const config = root.PIANO_AI_CONFIG || {};
  const LIVE_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
  const DEFAULT_MODEL = 'gemini-3.1-flash-live-preview';

  const state = {
    available: false,
    open: false,
    connecting: false,
    active: false,
    setupReady: false,
    userClosed: false,
    hiddenSuspension: false,
    ws: null,
    stream: null,
    inputContext: null,
    inputSource: null,
    inputProcessor: null,
    inputSilence: null,
    outputContext: null,
    outputSources: new Set(),
    nextPlaybackTime: 0,
    reconnectTimer: null,
    reconnectAttempts: 0,
    tokenExpiresAt: null,
    // Token effimero Gemini riutilizzabile: dura ~30 minuti, ma un'apertura
    // del pannello non deve chiederne uno nuovo a ogni tentativo/riconnessione,
    // altrimenti si brucia la quota gratuita del Worker (429).
    ephemeralToken: null,
    ephemeralTokenExpiresAt: 0,
    // Dopo un 429 del Worker ci si ferma fino a questo timestamp invece di
    // ritentare subito in loop e restare bloccati.
    rateLimitUntil: 0,
    sessionStartedAt: null,
    cooking: null,
    messages: [],
    pendingSources: [],
    currentInput: '',
    currentOutput: '',
    currentOutputNode: null,
    sessionHandle: null,
    closeRequested: false,
    lastError: ''
  };

  const ui = {};

  const FUNCTION_DECLARATIONS = [
    {
      name: 'get_current_plan',
      description: 'Legge i pasti del piano per un giorno. Usalo prima di rispondere su cosa è previsto oggi o in un altro giorno.',
      parameters: { type: 'OBJECT', properties: { day: { type: 'STRING', description: 'Giorno italiano oppure today/oggi. Se omesso usa oggi.' } } }
    },
    {
      name: 'get_meal_details',
      description: 'Legge ricetta, ingredienti, dosi e preparazione del pasto richiesto dal piano. Non inventare mai quantità al di fuori del risultato.',
      parameters: {
        type: 'OBJECT',
        properties: {
          day: { type: 'STRING', description: 'Giorno italiano oppure oggi. Se omesso usa oggi.' },
          slot: { type: 'STRING', enum: ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'], description: 'Pasto: breakfast, snack1, lunch, snack2 o dinner.' }
        },
        required: ['slot']
      }
    },
    {
      name: 'get_fruit_quantity',
      description: 'Calcola esclusivamente i grammi di frutta presenti nello spuntino richiesto. Rispondi solo con quel dato, non con tutto il pasto.',
      parameters: {
        type: 'OBJECT',
        properties: {
          day: { type: 'STRING', description: 'Giorno italiano oppure oggi. Se omesso usa oggi.' },
          slot: { type: 'STRING', enum: ['snack1', 'snack2'], description: 'Spuntino mattina o merenda. Se omesso usa snack1.' }
        }
      }
    },
    {
      name: 'get_shopping_list',
      description: 'Legge la lista della spesa corrente e le quantità aggregate dal piano.',
      parameters: { type: 'OBJECT', properties: { category: { type: 'STRING', description: 'Categoria opzionale da filtrare.' } } }
    },
    {
      name: 'get_account_context',
      description: 'Legge solo il contesto non sensibile dell’account e della household attiva: profilo porzioni, account collegati e stato di sincronizzazione.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'get_batch_cooking',
      description: 'Legge le preparazioni batch cooking disponibili per un giorno.',
      parameters: { type: 'OBJECT', properties: { day: { type: 'STRING', description: 'Giorno italiano oppure oggi. Se omesso usa oggi.' } } }
    },
    {
      name: 'search_app_content',
      description: 'Cerca nelle ricette, nel catalogo completo e nella guida di Meller. Usalo per domande sull’app e sui suoi contenuti.',
      parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Domanda o parole chiave da cercare.' } }, required: ['query'] }
    },
    {
      name: 'start_cooking_session',
      description: 'Avvia una sessione passo-passo. Per prima cosa propone un solo ingrediente; non elencare tutto insieme.',
      parameters: {
        type: 'OBJECT',
        properties: {
          day: { type: 'STRING', description: 'Giorno italiano oppure oggi. Se omesso usa oggi.' },
          slot: { type: 'STRING', enum: ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'], description: 'Pasto da cucinare.' }
        },
        required: ['slot']
      }
    },
    {
      name: 'next_cooking_item',
      description: 'Passa all’ingrediente o allo step successivo nella sessione di cucina attiva.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'repeat_cooking_item',
      description: 'Ripete l’ingrediente o lo step corrente senza avanzare.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'previous_cooking_item',
      description: 'Torna all’ingrediente o allo step precedente.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'skip_cooking_item',
      description: 'Salta l’ingrediente o lo step corrente e passa al successivo.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'pause_cooking_session',
      description: 'Mette in pausa o riprende la sessione di cucina.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'restart_cooking_session',
      description: 'Ricomincia la sessione di cucina dall’elenco degli ingredienti.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'start_preparation',
      description: 'Dopo che l’utente ha confermato, passa dall’elenco ingredienti al primo step di preparazione.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'get_cooking_status',
      description: 'Dice a che punto è la sessione di cucina attiva.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'close_assistant',
      description: 'Chiude la modalità assistente e spegne il microfono quando l’utente lo chiede.',
      parameters: { type: 'OBJECT', properties: {} }
    }
  ];

  function getConfig() {
    return root.PIANO_AI_CONFIG || config;
  }

  function hasLiveEndpoint() {
    const endpoint = String(getConfig().tokenEndpoint || '').trim();
    return Boolean(endpoint && !/^https?:\/\/YOUR[-_A-Z0-9.]+/i.test(endpoint));
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
      return typeof appState !== 'undefined' ? appState : { plan: null, recipes: [], recipesById: {} };
    } catch (_) {
      return { plan: null, recipes: [], recipesById: {} };
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

  function resultMessage(message, extra = {}) {
    return { ok: true, message: String(message || ''), ...extra };
  }

  function mealFor(day, slot) {
    const data = currentState();
    return domain?.mealDetails
      ? domain.mealDetails(data, day, slot, currentProfile(), root.PianoDomain)
      : { found: false, message: 'Dati del piano non disponibili.' };
  }

  function mealSummary(day) {
    const data = currentState();
    const dayData = data.plan?.days?.[day];
    if (!dayData) return { found: false, message: `Non trovo il giorno ${domain?.DAY_LABELS?.[day] || day}.` };
    const meals = (domain?.SLOTS || []).map(slot => {
      const meal = mealFor(day, slot);
      return meal.found
        ? { slot, label: meal.slotLabel, recipe: meal.recipeName, recipeId: meal.recipeId }
        : { slot, label: meal.slotLabel, recipe: null };
    });
    return resultMessage(`Piano di ${domain?.DAY_LABELS?.[day] || day}.`, {
      day,
      dayLabel: domain?.DAY_LABELS?.[day] || day,
      dayType: dayData.type || 'rest',
      meals
    });
  }

  function amountForSpeech(value) {
    if (typeof value === 'object' && value) {
      return {
        man: domain?.quantityToSpeech ? domain.quantityToSpeech(value.man) : value.man,
        ipo: domain?.quantityToSpeech ? domain.quantityToSpeech(value.ipo) : value.ipo
      };
    }
    return domain?.quantityToSpeech ? domain.quantityToSpeech(value) : value;
  }

  function listMealIngredients(meal) {
    return (meal.ingredients || []).map(item => ({
      name: item.name,
      category: item.category,
      quantity: item.quantity,
      quantitySpeech: amountForSpeech(item.quantity)
    }));
  }

  function getAccountContext() {
    const data = currentState();
    const user = data.user || {};
    const username = String(user.email || '').split('@')[0] || 'account attivo';
    const household = data.household || null;
    const members = Array.isArray(household?.memberUsernames)
      ? household.memberUsernames.filter(name => name && name !== username)
      : [];
    const profileLabels = { man: 'uomo', ipo: 'donna IPO', couple: 'uomo e donna IPO' };
    return resultMessage(
      household
        ? `Account ${username}. Household condivisa attiva con ${members.length ? members.join(', ') : 'gli account collegati'}. Profilo porzioni: ${profileLabels[currentProfile()] || currentProfile()}.`
        : `Account ${username}. Non c’è una household condivisa attiva. Profilo porzioni: ${profileLabels[currentProfile()] || currentProfile()}.`,
      {
        username,
        portionProfile: currentProfile(),
        householdActive: Boolean(household),
        linkedAccounts: members,
        sharedData: household ? ['piano', 'ricette', 'batch cooking', 'lista della spesa'] : []
      }
    );
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

  function formatCurrentCooking() {
    if (!state.cooking || !domain) return null;
    return domain.cookingStatus(state.cooking);
  }

  function executeCooking(name) {
    if (!domain) return resultMessage('Il controllo della preparazione non è disponibile.');
    let result;
    if (name === 'next_cooking_item') result = domain.advanceCooking(state.cooking);
    if (name === 'repeat_cooking_item') result = domain.repeatCooking(state.cooking);
    if (name === 'previous_cooking_item') result = domain.previousCooking(state.cooking);
    if (name === 'skip_cooking_item') result = domain.skipCooking(state.cooking);
    if (name === 'pause_cooking_session') result = domain.togglePause(state.cooking);
    if (name === 'restart_cooking_session') result = domain.restartCooking(state.cooking);
    if (name === 'start_preparation') result = domain.startPreparation(state.cooking);
    if (!result) return resultMessage('Non c’è una sessione di cucina attiva.');
    state.cooking = result.session;
    return resultMessage(result.message, { cooking: result.status, spoken: result.message });
  }

  function executeTool(name, args = {}) {
    const data = currentState();
    const profile = currentProfile();
    if (name === 'get_current_plan') return mealSummary(dayFromArg(args.day));

    if (name === 'get_meal_details') {
      const day = dayFromArg(args.day);
      const slot = slotFromArg(args.slot, 'dinner');
      const meal = mealFor(day, slot);
      if (!meal.found) return resultMessage(meal.message, { found: false, day, slot });
      return resultMessage(`${meal.slotLabel} di ${meal.dayLabel}: ${meal.recipeName}.`, {
        found: true,
        day,
        slot,
        dayLabel: meal.dayLabel,
        slotLabel: meal.slotLabel,
        dayType: meal.dayType,
        recipeId: meal.recipeId,
        recipeName: meal.recipeName,
        ingredients: listMealIngredients(meal),
        steps: meal.steps,
        notes: meal.notes,
        specialNote: meal.specialNote,
        profile
      });
    }

    if (name === 'get_fruit_quantity') {
      const day = dayFromArg(args.day);
      const slot = slotFromArg(args.slot, 'snack1');
      const meal = mealFor(day, slot);
      if (!meal.found) return resultMessage(meal.message, { found: false, day, slot });
      // `mealDetails` è già normalizzato, ma sumFruitQuantity lavora sulla
      // forma ricetta. Rileggi il record del catalogo per mantenere le dosi
      // esatte e non trasformare una quantità vocale in un nuovo dato.
      const originalRecipe = data.recipesById?.[meal.recipeId] || (data.recipes || []).find(item => item.id === meal.recipeId);
      if (!originalRecipe) return resultMessage('Non riesco a leggere la dose della frutta dal catalogo attivo.', { found: false, day, slot });
      const exactFruit = domain.sumFruitQuantity(originalRecipe, slot, meal.dayType, profile, root.PianoDomain);
      return resultMessage(exactFruit.message, {
        found: exactFruit.found,
        complete: exactFruit.complete,
        day,
        slot,
        dayLabel: meal.dayLabel,
        slotLabel: meal.slotLabel,
        grams: exactFruit.grams,
        fruit: exactFruit.items,
        unknown: exactFruit.unknown,
        onlyRequestedValue: true
      });
    }

    if (name === 'get_shopping_list') {
      const category = normalized(args.category || '');
      const items = getShopping().filter(item => !category || normalized(item.category).includes(category) || normalized(item.name).includes(category));
      return resultMessage(items.length ? `Ho trovato ${items.length} elementi nella lista della spesa.` : 'Non trovo elementi corrispondenti nella lista della spesa.', { items });
    }

    if (name === 'get_account_context') return getAccountContext();

    if (name === 'get_batch_cooking') {
      const day = dayFromArg(args.day);
      const batches = getBatch(day);
      return resultMessage(batches.length ? `Ci sono ${batches.length} preparazioni in anticipo.` : 'Non risultano preparazioni batch cooking disponibili per questo giorno.', { day, batches });
    }

    if (name === 'search_app_content') {
      const query = String(args.query || '').trim();
      if (!query) return resultMessage('Dimmi cosa vuoi cercare nell’app.');
      const records = [...recipeRecords(), ...guideRecords()];
      const results = domain?.searchText ? domain.searchText(records, query, 8) : [];
      return resultMessage(results.length ? `Ho trovato ${results.length} risultati nel catalogo o nella guida.` : 'Non trovo questo argomento nei contenuti dell’app.', { query, results });
    }

    if (name === 'start_cooking_session') {
      const day = dayFromArg(args.day);
      const slot = slotFromArg(args.slot, 'dinner');
      const meal = mealFor(day, slot);
      if (!meal.found) return resultMessage(meal.message, { found: false, day, slot });
      state.cooking = domain.createCookingSession(meal);
      const current = domain.currentCookingItem(state.cooking);
      return resultMessage(`Va bene, cuciniamo ${meal.recipeName}. ${current?.text || 'Non ci sono ingredienti da prendere.'}`, {
        cooking: domain.cookingStatus(state.cooking),
        spoken: current?.text || '',
        day,
        slot,
        recipeName: meal.recipeName
      });
    }

    if ([
      'next_cooking_item', 'repeat_cooking_item', 'previous_cooking_item',
      'skip_cooking_item', 'pause_cooking_session', 'restart_cooking_session',
      'start_preparation'
    ].includes(name)) return executeCooking(name);

    if (name === 'get_cooking_status') {
      const cooking = formatCurrentCooking();
      return resultMessage(cooking?.current?.text || (cooking?.awaitingPreparationConfirmation ? 'Abbiamo preso tutti gli ingredienti. Attendo la conferma per iniziare la preparazione.' : 'Non c’è una sessione di cucina attiva.'), { cooking });
    }

    if (name === 'close_assistant') {
      state.closeRequested = true;
      return resultMessage('Chiudo l’assistente e spengo il microfono.', { close: true });
    }

    return resultMessage('Non posso eseguire questa azione.');
  }

  function systemInstruction() {
    const profile = currentProfile();
    return [
      'Sei Piano, l’assistente vocale integrato nella webapp Piano Nutrizionale.',
      'Parla sempre in italiano e dai del tu. Il tono è caldo, elegante, colloquiale e naturale, mai robotico.',
      'La sessione è già stata attivata dal pulsante AI: resta disponibile e ascolta finché l’utente non dice di chiudere oppure preme il pulsante di chiusura.',
      'Non annunciare mai un elenco numerato tipo “ingrediente 1 di 8” se non viene richiesto. Per esempio dì “Prendi 200 grammi di pomodori”.',
      `Il profilo porzioni attivo è ${profile}. Usa solo questo profilo quando dai dosi.`,
      'Per qualunque dato del piano, ricetta, dose, grammo, lista della spesa, batch cooking, preparazione, account o guida devi usare gli strumenti dell’app. Non indovinare e non inventare numeri.',
      'Se l’utente chiede una sola informazione, rispondi solo a quella. Per esempio, per i grammi di frutta nello spuntino dì solo il totale della frutta e non ricapitolare tutto il pasto.',
      'Quando l’utente chiede di cucinare un pasto, usa start_cooking_session e proponi un solo ingrediente alla volta. Dopo l’ultimo ingrediente chiedi se vuole iniziare la preparazione. Solo dopo una conferma usa start_preparation e poi uno step alla volta.',
      'Interpreta “prossimo”, “avanti”, “fatto” come next_cooking_item; “ripeti” come repeat_cooking_item; “indietro” come previous_cooking_item; “salta” come skip_cooking_item; “pausa” come pause_cooking_session; “ricomincia” come restart_cooking_session.',
      'Dopo ogni tool di cucina pronuncia in modo naturale il campo spoken o message restituito dal tool, senza aggiungere passaggi non presenti.',
      'Usa Google Search solo per informazioni aggiornate o non presenti nell’app. Riassumi brevemente e indica le fonti nella risposta testuale della schermata, senza leggere URL lunghi.',
      'Non fare diagnosi e non prescrivere farmaci o terapie. Per problemi clinici rimanda a medico o nutrizionista. Non modificare piano, ricette o lista spesa senza una conferma esplicita.',
      'Se l’utente dice “chiudi assistente”, “smetti di ascoltare”, “basta” o equivalente, usa close_assistant e non continuare la conversazione.'
    ].join('\n');
  }

  function send(payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    state.ws.send(JSON.stringify(payload));
    return true;
  }

  function base64FromBytes(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)));
    }
    return btoa(binary);
  }

  function bytesFromBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function downsample(input, inputRate, outputRate = 16000) {
    if (inputRate === outputRate) return input.slice ? input.slice() : new Float32Array(input);
    const ratio = inputRate / outputRate;
    const outputLength = Math.max(1, Math.round(input.length / ratio));
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i += 1) {
      const sourceIndex = i * ratio;
      const left = Math.floor(sourceIndex);
      const right = Math.min(input.length - 1, left + 1);
      const weight = sourceIndex - left;
      output[i] = input[left] * (1 - weight) + input[right] * weight;
    }
    return output;
  }

  function pcm16Base64(floatData) {
    const bytes = new Uint8Array(floatData.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < floatData.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, floatData[index]));
      view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return base64FromBytes(bytes);
  }

  async function setupAudioContexts() {
    const AudioContextClass = root.AudioContext || root.webkitAudioContext;
    if (!AudioContextClass) throw new Error('Il browser non supporta l’audio necessario per la modalità vocale.');
    if (!state.outputContext) state.outputContext = new AudioContextClass({ sampleRate: 24000 });
    if (state.outputContext.state === 'suspended') await state.outputContext.resume();
  }

  async function ensureMicrophoneStream() {
    if (state.stream) return state.stream;
    if (!root.navigator?.mediaDevices?.getUserMedia) {
      throw new Error('Questo browser non espone il microfono. Prova Chrome, Edge o Safari aggiornato.');
    }
    state.stream = await root.navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    return state.stream;
  }

  async function startCapture() {
    if (state.inputProcessor || !state.stream) return;
    const AudioContextClass = root.AudioContext || root.webkitAudioContext;
    state.inputContext = new AudioContextClass({ sampleRate: 16000 });
    if (state.inputContext.state === 'suspended') await state.inputContext.resume();
    state.inputSource = state.inputContext.createMediaStreamSource(state.stream);
    // ScriptProcessor è mantenuto come fallback universale per Safari/iOS:
    // l’elaborazione resta leggera e il formato inviato è sempre PCM 16 kHz.
    state.inputProcessor = state.inputContext.createScriptProcessor(4096, 1, 1);
    state.inputSilence = state.inputContext.createGain();
    state.inputSilence.gain.value = 0;
    state.inputProcessor.onaudioprocess = event => {
      if (!state.setupReady || !state.ws || state.ws.readyState !== WebSocket.OPEN || state.hiddenSuspension) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm = downsample(input, state.inputContext.sampleRate, 16000);
      send({ realtimeInput: { audio: { data: pcm16Base64(pcm), mimeType: 'audio/pcm;rate=16000' } } });
    };
    state.inputSource.connect(state.inputProcessor);
    state.inputProcessor.connect(state.inputSilence);
    state.inputSilence.connect(state.inputContext.destination);
    renderLiveTranscript('');
  }

  function stopCapture() {
    try { state.inputProcessor?.disconnect(); } catch (_) {}
    try { state.inputSource?.disconnect(); } catch (_) {}
    try { state.inputSilence?.disconnect(); } catch (_) {}
    state.inputProcessor = null;
    state.inputSource = null;
    state.inputSilence = null;
    if (state.inputContext) {
      state.inputContext.close().catch(() => {});
      state.inputContext = null;
    }
    if (state.stream) {
      state.stream.getTracks().forEach(track => track.stop());
      state.stream = null;
    }
  }

  function stopPlayback() {
    state.outputSources.forEach(source => {
      try { source.stop(); } catch (_) {}
      try { source.disconnect(); } catch (_) {}
    });
    state.outputSources.clear();
    if (state.outputContext) state.nextPlaybackTime = state.outputContext.currentTime;
    state.currentOutputNode = null;
  }

  function playAudio(data) {
    if (!state.outputContext || !data) return;
    try {
      const bytes = bytesFromBase64(data);
      const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
      const buffer = state.outputContext.createBuffer(1, samples.length, 24000);
      const channel = buffer.getChannelData(0);
      for (let index = 0; index < samples.length; index += 1) channel[index] = samples[index] / 32768;
      const source = state.outputContext.createBufferSource();
      source.buffer = buffer;
      source.connect(state.outputContext.destination);
      const startAt = Math.max(state.outputContext.currentTime + 0.01, state.nextPlaybackTime);
      source.start(startAt);
      state.nextPlaybackTime = startAt + buffer.duration;
      state.outputSources.add(source);
      state.currentOutputNode = source;
      source.onended = () => {
        state.outputSources.delete(source);
        try { source.disconnect(); } catch (_) {}
        if (!state.outputSources.size && state.active) setStatus('listening', 'Ti ascolto');
      };
      setStatus('speaking', 'Sto parlando');
    } catch (error) {
      console.warn('Audio Gemini non riproducibile', error);
    }
  }

  function safeSourceUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  function renderSources(sources) {
    const links = (Array.isArray(sources) ? sources : []).map(source => {
      const url = safeSourceUrl(source.url);
      if (!url) return '';
      const title = source.title || (() => { try { return new URL(url).hostname; } catch (_) { return 'Fonte web'; } })();
      return `<li><a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(title)}</a></li>`;
    }).filter(Boolean).join('');
    return links ? `<div class="assistant-sources"><span>Fonti</span><ul>${links}</ul></div>` : '';
  }

  function addMessage(role, text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    state.messages.push({ role, text: clean });
  }

  function appendSources(metadata) {
    const chunks = Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks : [];
    const sources = chunks.map(chunk => ({
      title: chunk?.web?.title || '',
      url: chunk?.web?.uri || chunk?.web?.url || ''
    })).filter(source => safeSourceUrl(source.url));
    if (!sources.length) return;
    const unique = [...new Map(sources.map(source => [source.url, source])).values()].slice(0, 6);
    const latest = state.messages[state.messages.length - 1];
    const target = !state.currentInput && latest?.role === 'assistant' ? latest : null;
    if (target) target.sources = [...new Map([...(target.sources || []), ...unique].map(source => [source.url, source])).values()].slice(0, 6);
    else state.pendingSources = [...new Map([...(state.pendingSources || []), ...unique].map(source => [source.url, source])).values()].slice(0, 6);
  }

  function finishOutput() {
    const previous = state.messages[state.messages.length - 1];
    if (previous?.live) delete previous.live;
    state.currentOutput = '';
    state.currentOutputNode = null;
  }

  function renderLiveTranscript(text) {
    if (ui.liveTranscript) {
      ui.liveTranscript.textContent = text ? `“${text}”` : 'Microfono attivo · puoi parlare';
      ui.liveTranscript.classList.toggle('has-text', Boolean(text));
    }
  }

  function setStatus(kind, label) {
    if (ui.status) {
      ui.status.dataset.state = kind;
      ui.status.textContent = label;
    }
    if (ui.fab) {
      ui.fab.dataset.state = kind;
      ui.fab.setAttribute('aria-label', state.active ? 'Assistente vocale attivo: chiudi' : 'Apri assistente vocale');
    }
  }

  function showError(message) {
    state.lastError = String(message || 'Errore non specificato');
    setStatus('error', 'Serve un controllo');
    addMessage('assistant', state.lastError);
    if (ui.error) {
      ui.error.textContent = state.lastError;
      ui.error.classList.remove('hidden');
    }
  }

  function clearError() {
    state.lastError = '';
    ui.error?.classList.add('hidden');
  }

  function mergeTranscript(previous, chunk) {
    const clean = String(chunk || '').trim();
    if (!previous) return clean;
    if (clean === previous || clean.startsWith(`${previous} `)) return clean;
    if (previous.endsWith(clean) || previous.includes(clean)) return previous;
    return `${previous} ${clean}`.trim();
  }

  function handleInputTranscript(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    state.currentInput = mergeTranscript(state.currentInput, clean);
    renderLiveTranscript(state.currentInput);
    if (domain?.isCloseCommand?.(state.currentInput) || domain?.isCloseCommand?.(clean)) {
      // Il tool chiuderà anche la sessione lato modello; qui spegniamo subito
      // il microfono per rispettare l’intenzione esplicita dell’utente.
      setTimeout(() => closeAssistant('voice'), 80);
    }
  }

  async function handleToolCall(toolCall) {
    const calls = Array.isArray(toolCall?.functionCalls) ? toolCall.functionCalls : [];
    const responses = [];
    for (const call of calls) {
      let result;
      try { result = executeTool(call.name, call.args || {}); }
      catch (error) { result = { ok: false, error: error.message || 'Tool non riuscito.' }; }
      responses.push({ name: call.name, id: call.id, response: { result } });
    }
    if (responses.length) send({ toolResponse: { functionResponses: responses } });
    if (state.closeRequested) {
      state.closeRequested = false;
      setTimeout(() => closeAssistant('voice'), 100);
    }
  }

  function handleServerMessage(message) {
    if (!message) return;
    if (message.setupComplete) {
      state.setupReady = true;
      state.active = true;
      state.connecting = false;
      state.sessionStartedAt = Date.now();
      state.reconnectAttempts = 0;
      setStatus('listening', 'Ti ascolto');
      startCapture().catch(error => showError(error.message));
      send({ realtimeInput: { text: 'L’utente ha appena aperto la modalità assistente. Salutalo in una frase breve e chiedigli in cosa può aiutarlo.' } });
      return;
    }

    if (message.toolCall) {
      handleToolCall(message.toolCall).catch(error => showError(error.message));
    }
    if (message.sessionResumptionUpdate?.newHandle) state.sessionHandle = message.sessionResumptionUpdate.newHandle;
    if (message.error) {
      showError(message.error.message || 'Gemini ha restituito un errore.');
      return;
    }

    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) {
      stopPlayback();
      if (state.currentOutput) finishOutput();
    }
    if (content.groundingMetadata) appendSources(content.groundingMetadata);

    if (content.modelTurn?.parts) {
      content.modelTurn.parts.forEach(part => {
        if (part.inlineData?.data) playAudio(part.inlineData.data);
        if (part.text) appendOutput(part.text);
      });
    }
    if (content.turnComplete) {
      state.currentInput = '';
      renderLiveTranscript('');
      finishOutput();
      if (state.active && !state.outputSources.size) setStatus('listening', 'Ti ascolto');
    }
  }

  function setupMessage() {
    const cfg = getConfig();
    const model = String(cfg.model || DEFAULT_MODEL).replace(/^models\//, '');
    const setup = {
      setup: {
        model: `models/${model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          temperature: 0.55,
          maxOutputTokens: 700,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voiceName || 'Aoede' } }
          }
        },
        systemInstruction: { parts: [{ text: systemInstruction() }] },
        sessionResumption: state.sessionHandle ? { handle: state.sessionHandle } : {},
        contextWindowCompression: { slidingWindow: {} },
        tools: [
          ...(cfg.allowGoogleSearch === false ? [] : [{ googleSearch: {} }]),
          { functionDeclarations: FUNCTION_DECLARATIONS }
        ]
      }
    };
    return setup;
  }

  async function getIdToken() {
    try {
      const firebaseUser = root.firebase?.auth?.()?.currentUser;
      if (firebaseUser?.getIdToken) return firebaseUser.getIdToken();
    } catch (_) {}
    try {
      // `currentUser` è una variabile globale del file Firebase legacy;
      // typeof evita errori quando il modulo è provato senza Firebase.
      if (typeof currentUser !== 'undefined' && currentUser?.getIdToken) return currentUser.getIdToken();
    } catch (_) {}
    throw new Error('Sessione Firebase non disponibile. Accedi di nuovo alla webapp.');
  }

  // Il token effimero dura ~30 minuti lato Worker: lo si riusa con margine,
  // così una riconnessione non consuma una nuova emissione (e quindi quota).
  function validEphemeralToken() {
    if (state.ephemeralToken && Date.now() < state.ephemeralTokenExpiresAt) {
      return state.ephemeralToken;
    }
    return null;
  }

  function retryAfterMs(headerValue) {
    if (!headerValue) return 0;
    const seconds = Number(String(headerValue).trim());
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 90 * 60) * 1000;
    const date = Date.parse(headerValue);
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 90 * 60 * 1000));
    return 0;
  }

  function rateLimitedErrorMessage() {
    const waitMs = state.rateLimitUntil - Date.now();
    if (waitMs <= 0) return 'Troppe richieste di attivazione: attendi un minuto e riprova.';
    const minutes = Math.ceil(waitMs / 60000);
    return `Troppe attivazioni dell’assistente in poco tempo. Riprova tra circa ${minutes} minuto${minutes > 1 ? 'i' : ''}.`;
  }

  class RateLimitError extends Error {
    constructor(retryMs) {
      // Si imposta lo stato prima di super(): rateLimitedErrorMessage()
      // legge già la scadenza per calcolare i minuti di attesa.
      state.rateLimitUntil = Date.now() + Math.max(retryMs, 60 * 1000);
      state.ephemeralToken = null;
      super(rateLimitedErrorMessage());
      this.name = 'RateLimitError';
      this.rateLimited = true;
    }
  }

  async function fetchEphemeralToken() {
    // Cooldown da 429 ancora attivo: non si chiama nemmeno il Worker.
    if (state.rateLimitUntil > Date.now()) throw new RateLimitError(0);

    // Token ancora valido: lo si riusa invece di chiederne un altro.
    const cached = validEphemeralToken();
    if (cached) return cached;

    const endpoint = String(getConfig().tokenEndpoint || '').trim();
    if (!endpoint) throw new Error('Assistente non ancora configurato: inserisci l’URL del Worker Cloudflare in js/assistant-config.js.');
    const idToken = await getIdToken();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, Accept: 'application/json' },
      credentials: 'omit'
    });
    let body = null;
    try { body = await response.json(); } catch (_) {}
    if (response.status === 429) {
      // Il Worker comunica anche quanto aspettare via Retry-After.
      throw new RateLimitError(retryAfterMs(response.headers.get('Retry-After')));
    }
    if (!response.ok) throw new Error(body?.error || `Worker AI non raggiungibile (${response.status}).`);
    const token = body?.token || body?.name || body?.accessToken;
    if (!token) throw new Error('Il Worker non ha restituito un token Gemini valido.');
    state.ephemeralToken = token;
    state.tokenExpiresAt = body.expiresAt || null;
    state.rateLimitUntil = 0;
    // Margine di sicurezza di 60s sulla scadenza indicata dal Worker.
    const expiresMs = Date.parse(body.expiresAt || '') || (Date.now() + 29 * 60 * 1000);
    state.ephemeralTokenExpiresAt = Math.max(Date.now() + 60 * 1000, expiresMs - 60 * 1000);
    return token;
  }

  function describeClose(event) {
    const code = event?.code || 0;
    const reason = event?.reason ? String(event.reason) : '';
        if (/quota|billing|rate ?limit|429/i.test(reason)) {
      return 'Quota Gemini esaurita o fatturazione non attiva per la chiave API del Worker. ' +
        'Controlla quota e fatturazione della chiave Gemini su Google AI Studio / Google Cloud, oppure riprova dopo l’azzeramento della quota.';
    }
    if (reason) return `Gemini ha chiuso la connessione (${code}): ${reason}`;
    if (code === 1008 || code === 1003) {
      return 'Gemini ha rifiutato la configurazione della sessione vocale. ' +
        'Verifica che il modello Live e la chiave Gemini nel Worker siano corretti e attivi.';
    }
    if (code === 1000) return 'La connessione vocale è stata chiusa.';
    if (code === 1006) return 'Connessione interrotta durante l’avvio della sessione vocale.';
    return `Connessione Gemini Live chiusa (codice ${code || 'sconosciuto'}).`;
  }

  // Cadute di rete/riavvii server: vale la pena ritentare. Errori di
  // configurazione (token/setup rifiutato, 1003/1008/1000): ritentare non
  // serve e brucerebbe altri token, quindi ci si ferma mostrando il motivo.
  // Solo cadute di rete genuine: un rifiuto per quota/configurazione
  // (1011/1008/1003 o reason con quota/billing) NON va ritentato.
  function isRetryableClose(code, reason) {
    if (/quota|billing|rate ?limit|429/i.test(String(reason || ''))) return false;
    return !code || code === 1006 || code === 1012 || code === 1013;
  }

  async function openSocket(token) {
    const endpoint = `${LIVE_ENDPOINT}?access_token=${encodeURIComponent(token)}`;
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      state.ws = socket;
      let settled = false;
      const settle = fn => arg => {
        if (settled) return;
        settled = true;
        fn(arg);
      };
      const fail = settle(reject);
      const done = settle(resolve);
      socket.onopen = () => {
        socket.send(JSON.stringify(setupMessage()));
      };
      socket.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          // Un frame di errore prima di setupComplete vuol dire che la
          // sessione non si è aperta: lo si riporta subito invece di
          // restare in attesa fino all'onclose.
          if (message?.error && !state.setupReady) {
            fail(new Error(message.error.message || 'Gemini ha rifiutato la configurazione della sessione vocale.'));
          }
          handleServerMessage(message);
          if (message?.setupComplete) done();
        } catch (error) { console.warn('Messaggio Live non valido', error); }
      };
      socket.onerror = () => {
        fail(new Error('Connessione Gemini Live non riuscita (rete o endpoint).'));
      };
      socket.onclose = event => {
                const retryable = isRetryableClose(event?.code, event?.reason);
        if (!state.setupReady) {
          fail(new Error(describeClose(event)));
        }
        if (state.ws === socket) {
          const wasActive = state.active;
          state.ws = null;
          state.setupReady = false;
          state.active = false;
          state.connecting = false;
          stopCapture();
          if (state.userClosed || !state.open) return;
          if (document.hidden) { setStatus('paused', 'In pausa'); return; }
          // Errore definitivo (config/modello/token): niente loop di retry.
          // Si invalida anche il token in cache perché potrebbe essere il
          // responsabile del rifiuto.
          if (!retryable && !wasActive) {
            state.ephemeralToken = null;
            showError(describeClose(event));
            return;
          }
          scheduleReconnect();
        }
      };
    });
  }

  function scheduleReconnect() {
    if (state.reconnectTimer || state.userClosed || !state.open) return;
    // Con un 429 in corso non ha senso riconnettersi: si attende la scadenza.
    if (state.rateLimitUntil > Date.now()) return;
    if (state.reconnectAttempts >= 3) {
      state.ephemeralToken = null;
      showError('La connessione vocale non si è stabilita. Chiudi e riapri l’assistente per riprovare.');
      return;
    }
    state.reconnectAttempts += 1;
    const delay = Math.min(6000, 700 * (2 ** (state.reconnectAttempts - 1)));
    setStatus('connecting', 'Riconnessione…');
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connectLive().catch(error => {
        showError(error.message);
        scheduleReconnect();
      });
    }, delay);
  }

  async function connectLive() {
    if (!state.open || state.userClosed || state.connecting || state.active) return;
    // Cooldown da rate-limit (429 del Worker): niente microfono né nuove
    // richieste finché non scade, altrimenti si riempie la quota in loop.
    if (state.rateLimitUntil > Date.now()) {
      stopCapture();
      setStatus('error', 'Troppe attivazioni');
      showError(rateLimitedErrorMessage());
      return false;
    }
    clearError();
    state.connecting = true;
    setStatus('connecting', 'Mi collego…');
    try {
      await setupAudioContexts();
      await ensureMicrophoneStream();
      const token = await fetchEphemeralToken();
      await openSocket(token);
    } catch (error) {
      state.connecting = false;
      stopCapture();
      state.active = false;
      if (error?.rateLimited) {
        setStatus('error', 'Troppe attivazioni');
      } else {
        setStatus('error', 'Serve un controllo');
      }
      throw error;
    }
    return true;
  }

  function closeSocket() {
    const socket = state.ws;
    state.ws = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch (_) {}
      try { socket.close(1000, 'assistant-closed'); } catch (_) {}
    } else if (socket) {
      try { socket.close(); } catch (_) {}
    }
  }

  function closeAssistant(reason = 'manual') {
    state.userClosed = true;
    state.open = false;
    state.connecting = false;
    state.active = false;
    state.setupReady = false;
    state.hiddenSuspension = false;
    state.closeRequested = false;
    state.cooking = null;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    stopCapture();
    stopPlayback();
    closeSocket();
    if (state.inputContext) state.inputContext.close().catch(() => {});
    if (state.outputContext) {
      state.outputContext.close().catch(() => {});
      state.outputContext = null;
    }
    state.messages = [];
    state.pendingSources = [];
    state.currentInput = '';
    state.currentOutput = '';
    state.sessionHandle = null;
    ui.panel?.classList.add('hidden');
    ui.fab?.classList.remove('is-active');
    ui.fab?.setAttribute('aria-label', 'Apri assistente vocale');
    setStatus('idle', 'Assistente vocale');
    renderLiveTranscript('');
    if (reason === 'voice' && typeof showToast === 'function') showToast('Assistente chiuso e microfono spento.');
  }

  function openAssistant() {
    if (!state.available) return;
    state.open = true;
    state.userClosed = false;
    state.messages = [];
    state.pendingSources = [];
    state.currentInput = '';
    state.currentOutput = '';
    state.sessionHandle = null;
    ui.panel?.classList.remove('hidden');
    ui.fab?.classList.add('is-active');
    clearError();
    if (!hasLiveEndpoint()) {
      setStatus('setup', 'Configura il Worker');
      showError('Per attivare Gemini Live devi inserire l’URL del Worker Cloudflare in js/assistant-config.js. La guida è disponibile in docs/AI_ASSISTANT.md.');
      return;
    }
    if (state.rateLimitUntil > Date.now()) {
      setStatus('error', 'Troppe attivazioni');
      showError(rateLimitedErrorMessage());
      return;
    }
    connectLive().catch(error => showError(error.message));
  }

  function toggleAssistant() {
    if (state.open) closeAssistant('manual');
    else openAssistant();
  }

  function ensureUi() {
    if (ui.fab) return;
    const fab = document.createElement('button');
    fab.id = 'assistant-fab';
    fab.className = 'assistant-fab hidden';
    fab.type = 'button';
    fab.innerHTML = '<span class="assistant-fab-glow"></span><span class="assistant-fab-icon">✦</span><span class="assistant-fab-mic">⌁</span>';
    fab.setAttribute('aria-label', 'Apri assistente vocale');
    fab.title = 'Apri assistente vocale';
    fab.addEventListener('click', toggleAssistant);

    const panel = document.createElement('section');
    panel.id = 'assistant-panel';
    panel.className = 'assistant-panel hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'assistant-title');
    panel.innerHTML = `
      <div class="assistant-panel-header">
        <div class="assistant-title-wrap"><span class="assistant-mini-mark">✦</span><div><p class="eyebrow">ASSISTENTE VOCALE</p><h2 id="assistant-title">Parliamo del tuo piano</h2></div></div>
        <button id="assistant-close" class="btn-icon assistant-close" type="button" aria-label="Chiudi assistente">&times;</button>
      </div>
      <div class="assistant-status-row"><span class="assistant-status-dot"></span><span id="assistant-status">Assistente vocale</span><span class="assistant-session-note">Nessuna cronologia salvata</span></div>
      <div id="assistant-live-transcript" class="assistant-live-transcript">Microfono attivo · puoi parlare</div>
      <div id="assistant-messages" class="assistant-messages" aria-live="polite"></div>
      <p id="assistant-error" class="assistant-error hidden" role="alert"></p>
      <div class="assistant-quick-actions">
        <button type="button" data-assistant-text="Cosa prevede il piano di oggi?">Piano di oggi</button>
        <button type="button" data-assistant-text="Quanta frutta c’è nello spuntino di oggi?">Frutta spuntino</button>
        <button type="button" data-assistant-text="Cuciniamo la cena di stasera">Cuciniamo</button>
      </div>
      <form id="assistant-text-form" class="assistant-text-form">
        <input id="assistant-text-input" type="text" autocomplete="off" placeholder="Scrivi o parla…" aria-label="Scrivi all’assistente">
        <button class="assistant-send" type="submit" aria-label="Invia messaggio">↑</button>
      </form>
      <p class="assistant-mic-hint"><span>●</span> Microfono attivo finché non chiudi · solo con la pagina in primo piano · prova “chiudi assistente”</p>`;
    document.body.append(fab, panel);
    ui.fab = fab;
    ui.panel = panel;
    ui.status = panel.querySelector('#assistant-status');
    ui.liveTranscript = panel.querySelector('#assistant-live-transcript');
    ui.messages = panel.querySelector('#assistant-messages');
    ui.error = panel.querySelector('#assistant-error');
    ui.close = panel.querySelector('#assistant-close');
    ui.form = panel.querySelector('#assistant-text-form');
    ui.input = panel.querySelector('#assistant-text-input');
    ui.close.addEventListener('click', () => closeAssistant('manual'));
    ui.form.addEventListener('submit', event => {
      event.preventDefault();
      const text = ui.input.value.trim();
      ui.input.value = '';
      if (!state.active) {
        showError('Attendi la connessione vocale oppure configura il Worker.');
        return;
      }
      sendText(text);
    });
    panel.querySelectorAll('[data-assistant-text]').forEach(button => button.addEventListener('click', () => {
      if (!state.active) { showError('Attendi la connessione vocale.'); return; }
      sendText(button.dataset.assistantText);
    }));
    setStatus('idle', 'Assistente vocale');
  }

  function settingsSectionHtml() {
    const configured = hasLiveEndpoint();
    return `
      <section class="settings-section assistant-settings-section">
        <div class="assistant-settings-icon">✦</div>
        <div class="assistant-settings-copy"><p class="eyebrow">GEMINI LIVE</p><h2>Assistente vocale</h2><p>${configured ? 'Worker configurato: puoi parlare con il piano, il ricettario e la guida.' : 'Completa la configurazione del Worker gratuito per attivare la conversazione vocale.'}</p><small>Audio e trascrizioni non vengono salvati dalla webapp. Nessun acquisto automatico: usi solo la quota gratuita configurata.</small></div>
        <button class="btn ${configured ? 'btn-primary' : 'btn-outline'}" type="button" onclick="window.PianoAssistant.open()">${configured ? 'Apri assistente' : 'Configura e prova'}</button>
      </section>`;
  }

  function setAvailability(available) {
    ensureUi();
    state.available = Boolean(available);
    ui.fab.classList.toggle('hidden', !state.available);
    if (!state.available && state.open) closeAssistant('logout');
  }

  function handleVisibility() {
    if (!state.open) return;
    if (document.hidden) {
      state.hiddenSuspension = true;
      stopCapture();
      renderLiveTranscript('');
      if (ui.liveTranscript) ui.liveTranscript.textContent = 'Microfono in pausa · torna alla pagina per continuare';
      setStatus('paused', 'Pausa: pagina non visibile');
    } else {
      state.hiddenSuspension = false;
      if (!state.active && !state.userClosed && hasLiveEndpoint() && state.rateLimitUntil <= Date.now()) {
        connectLive().catch(error => showError(error.message));
      } else if (state.active) {
        ensureMicrophoneStream().then(() => startCapture()).catch(error => showError(error.message));
      }
    }
  }

  root.PianoAssistant = {
    init: ensureUi,
    open: openAssistant,
    close: () => closeAssistant('manual'),
    toggle: toggleAssistant,
    setAvailability,
    settingsSectionHtml,
    isActive: () => state.active,
    getCookingStatus: () => formatCurrentCooking(),
    executeTool,
    _state: state,
    // Hook per gli smoke test: permette di simulare token/429 senza rete.
    _fetchEphemeralToken: fetchEphemeralToken,
    _resetRateLimit: () => { state.rateLimitUntil = 0; state.ephemeralToken = null; }
  };

  document.addEventListener('visibilitychange', handleVisibility);
  document.addEventListener('DOMContentLoaded', ensureUi);
})(typeof globalThis !== 'undefined' ? globalThis : window);
