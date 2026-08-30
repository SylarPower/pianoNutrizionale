/* Piano Nutrizionale — dominio puro per l'assistente vocale.
 *
 * Nessun DOM, nessuna rete e nessun dato personale hardcoded: queste funzioni
 * trasformano il piano già caricato dall'app in risposte deterministiche per
 * Gemini Live. Il modello conversa, ma quantità e avanzamento della cucina
 * restano sotto il controllo del codice.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PianoAssistantDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, () => {
  'use strict';

  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const SLOTS = ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'];
  const SLOT_LABELS = {
    breakfast: 'colazione',
    snack1: 'spuntino mattina',
    lunch: 'pranzo',
    snack2: 'merenda',
    dinner: 'cena'
  };
  const DAY_LABELS = {
    monday: 'lunedì', tuesday: 'martedì', wednesday: 'mercoledì',
    thursday: 'giovedì', friday: 'venerdì', saturday: 'sabato', sunday: 'domenica'
  };

  const CLOSE_COMMANDS = [
    'chiudi assistente', 'chiudi l assistente', 'smetti di ascoltare',
    'smettila di ascoltare', 'basta', 'basta assistente', 'stop', 'stop assistente',
    'termina assistente', 'fine assistente', 'chiudi tutto'
  ];

  function normalizeText(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function todayKey(date = new Date()) {
    const jsDay = date instanceof Date ? date.getDay() : new Date(date).getDay();
    return DAYS[(jsDay + 6) % 7];
  }

  function resolveDay(value, fallback = todayKey()) {
    const key = normalizeText(value);
    const safeFallback = DAYS.includes(fallback) ? fallback : todayKey();
    const nextDay = DAYS[(DAYS.indexOf(safeFallback) + 1) % DAYS.length];
    const aliases = {
      monday: 'monday', tuesday: 'tuesday', wednesday: 'wednesday',
      thursday: 'thursday', friday: 'friday', saturday: 'saturday', sunday: 'sunday',
      lunedi: 'monday', martedi: 'tuesday', mercoledi: 'wednesday',
      giovedi: 'thursday', venerdi: 'friday', sabato: 'saturday', domenica: 'sunday',
      oggi: safeFallback, stasera: safeFallback, stamattina: safeFallback,
      domani: nextDay, tomorrow: nextDay
    };
    return aliases[key] || safeFallback;
  }

  function resolveSlot(value, fallback = 'dinner') {
    const key = normalizeText(value).replace(/\s+/g, '');
    const aliases = {
      breakfast: 'breakfast', colazione: 'breakfast',
      snack1: 'snack1', spuntino: 'snack1', spuntinomattina: 'snack1', mattina: 'snack1',
      snack2: 'snack2', merenda: 'snack2', spuntino2: 'snack2', spuntinopomeriggio: 'snack2',
      lunch: 'lunch', pranzo: 'lunch', dinner: 'dinner', cena: 'dinner', stasera: 'dinner'
    };
    return aliases[key] || (SLOTS.includes(fallback) ? fallback : 'dinner');
  }

  function isCloseCommand(value) {
    const text = normalizeText(value);
    return CLOSE_COMMANDS.some(command => text === command || text.endsWith(` ${command}`));
  }

  function isAdvanceCommand(value) {
    return /^(prossimo|prossima|avanti|continua|ok prossimo|vai avanti|fatto|fatta|ho fatto|finito)$/.test(normalizeText(value));
  }

  function isRepeatCommand(value) {
    return /^(ripeti|ripetilo|ripetere|ancora|puoi ripetere)$/.test(normalizeText(value));
  }

  function isPreviousCommand(value) {
    return /^(indietro|precedente|torna indietro|passaggio precedente)$/.test(normalizeText(value));
  }

  function isSkipCommand(value) {
    return /^(salta|saltiamo|passa|passiamo|salta questo)$/.test(normalizeText(value));
  }

  function isPauseCommand(value) {
    return /^(pausa|fermati|ferma|metti in pausa)$/.test(normalizeText(value));
  }

  function isRestartCommand(value) {
    return /^(ricomincia|riparti|da capo|ricominciamo)$/.test(normalizeText(value));
  }

  function isStartPreparationCommand(value) {
    return /^(iniziamo|inizia|prepariamo|preparazione|passiamo alla preparazione|cominciamo a preparare|si prepara)$/.test(normalizeText(value));
  }

  function parseNumberToken(value) {
    const map = { '½': 0.5, '¼': 0.25, '¾': 0.75 };
    return map[value] ?? Number(String(value).replace(',', '.'));
  }

  // Parser dedicato alle risposte vocali: un numero nudo in una ricetta
  // alimentare è trattato come grammi, mentre la lista spesa mantiene la
  // propria semantica storica (numero nudo = pezzi).
  function parseFoodAmount(raw) {
    const original = String(raw ?? '').trim();
    if (!original || original === '—' || original === '-') return { skip: true };
    if (/^(q\.?b\.?|liber[oaie]|a piacere)$/i.test(original)) {
      return { free: true, label: original };
    }
    const match = original.match(/^(\d+(?:[.,]\d+)?|[½¼¾])(?:\s*[-–—]\s*(\d+(?:[.,]\d+)?|[½¼¾]))?\s*(g|gr|grammi?|ml|millilitri?|pz|pezzi?|cucchiai?|cucchiaini?)?$/i);
    if (!match) return { opaque: original };
    const first = parseNumberToken(match[1]);
    const second = match[2] ? parseNumberToken(match[2]) : first;
    let value = match[2] ? Math.max(first, second) : first;
    let unit = String(match[3] || 'g').toLowerCase();
    if (/^gr|gram/.test(unit)) unit = 'g';
    else if (/^mill|^ml/.test(unit)) unit = 'ml';
    else if (/^pez|^pz/.test(unit)) unit = 'pz';
    else if (/^cucchiai/.test(unit)) { unit = 'g'; value *= 10; }
    else if (/^cucchiaini/.test(unit)) { unit = 'g'; value *= 5; }
    return { value, unit };
  }

  function formatNumber(value) {
    const rounded = Math.round(Number(value) * 100) / 100;
    return Number.isInteger(rounded)
      ? String(rounded)
      : String(rounded).replace('.', ',');
  }

  function quantityToSpeech(raw) {
    const text = String(raw ?? '').trim();
    if (!text || text === '—' || text === '-') return '';
    return text
      .replace(/\bq\.?b\.?\b/gi, 'quanto basta')
      .replace(/(\d+(?:[.,]\d+)?)\s*(?:g|gr)\b/gi, '$1 grammi')
      .replace(/(\d+(?:[.,]\d+)?)\s*ml\b/gi, '$1 millilitri')
      .replace(/(\d+(?:[.,]\d+)?)\s*pz\b/gi, '$1 pezzi');
  }

  function portionFor(ingredient, profile, dayType, slot, recipeSlot, domain) {
    if (domain?.portionFor) return domain.portionFor(ingredient, profile, dayType, slot, recipeSlot);
    const portions = ingredient?.portions || {};
    const training = dayType === 'training';
    if (profile === 'ipo') return portions[training ? 'ipoTraining' : 'ipoRest'] ?? '—';
    if (profile === 'couple') return {
      man: portions[training ? 'manTraining' : 'manRest'] ?? '—',
      ipo: portions[training ? 'ipoTraining' : 'ipoRest'] ?? '—'
    };
    return portions[training ? 'manTraining' : 'manRest'] ?? '—';
  }

  function effectiveIngredients(recipe, slot, dayType, profile, domain) {
    return (recipe?.ingredients || []).map(ingredient => {
      const quantity = portionFor(ingredient, profile, dayType, slot, recipe?.slot, domain);
      return {
        name: ingredient.name || 'Ingrediente',
        ingredientId: ingredient.ingredientId || domain?.ingredientIdFor?.(ingredient.name),
        category: domain?.categoryForIngredient?.(ingredient.name) || '',
        quantity,
        quantitySpeech: typeof quantity === 'object'
          ? { man: quantityToSpeech(quantity.man), ipo: quantityToSpeech(quantity.ipo) }
          : quantityToSpeech(quantity),
        raw: ingredient
      };
    }).filter(item => {
      if (item.quantity && typeof item.quantity === 'object') return item.quantity.man !== '—' || item.quantity.ipo !== '—';
      return item.quantity !== '—' && item.quantity !== '' && item.quantity !== undefined;
    });
  }

  function isFruit(ingredient, domain) {
    const category = normalizeText(ingredient?.category || domain?.categoryForIngredient?.(ingredient?.name));
    if (category.includes('frutta')) return true;
    return /mela|banana|pera|arancia|mandarin|clementin|kiwi|uva|fragol|pesca|mango|anguria|melone|avocado|lampon|limone|lime|albicocc|cilieg|mirtill|ananas|papaya|pompelmo|prugn|susin|fico|cachi|ribes|mora|more|frutta fresca|macedonia/.test(normalizeText(ingredient?.name));
  }

  function sumFruitQuantity(recipe, slot, dayType, profile = 'man', domain) {
    const fruit = effectiveIngredients(recipe, slot, dayType, profile, domain).filter(item => isFruit(item, domain));
    if (!fruit.length) {
      return { found: false, complete: true, grams: 0, items: [], message: 'Non risulta frutta in questo spuntino.' };
    }

    const sum = values => values.reduce((total, item) => {
      const parsed = parseFoodAmount(item);
      return parsed.unit === 'g' && Number.isFinite(parsed.value) ? total + parsed.value : total;
    }, 0);
    const unknown = values => values.filter(item => {
      const parsed = parseFoodAmount(item);
      return !parsed.skip && !parsed.free && (parsed.opaque || parsed.unit !== 'g');
    });

    if (profile === 'couple') {
      const manValues = fruit.map(item => item.quantity?.man ?? '—');
      const ipoValues = fruit.map(item => item.quantity?.ipo ?? '—');
      const manUnknown = unknown(manValues);
      const ipoUnknown = unknown(ipoValues);
      const manGrams = sum(manValues);
      const ipoGrams = sum(ipoValues);
      return {
        found: true,
        complete: !manUnknown.length && !ipoUnknown.length,
        grams: { man: manGrams, ipo: ipoGrams },
        items: fruit.map(item => ({ name: item.name, quantity: item.quantity })),
        unknown: { man: manUnknown, ipo: ipoUnknown },
        message: manUnknown.length || ipoUnknown.length
          ? 'Le dosi della frutta non sono tutte esprimibili in grammi.'
          : `Lo spuntino include ${formatNumber(manGrams)} grammi di frutta per l'uomo e ${formatNumber(ipoGrams)} grammi per la donna IPO.`
      };
    }

    const values = fruit.map(item => item.quantity);
    const invalid = unknown(values);
    const grams = sum(values);
    return {
      found: true,
      complete: !invalid.length,
      grams,
      items: fruit.map(item => ({ name: item.name, quantity: item.quantity })),
      unknown: invalid,
      message: invalid.length
        ? 'La dose della frutta non è esprimibile con certezza in grammi.'
        : `Lo spuntino include ${formatNumber(grams)} grammi di frutta.`
    };
  }

  function mealDetails(state, day, slot, profile = 'man', domain) {
    const recipeId = state?.plan?.days?.[day]?.[slot];
    const recipe = state?.recipesById?.[recipeId] || (state?.recipes || []).find(item => item.id === recipeId);
    if (!recipe) {
      return { found: false, day, slot, dayLabel: DAY_LABELS[day] || day, slotLabel: SLOT_LABELS[slot] || slot, message: `Non trovo ${SLOT_LABELS[slot] || slot} per ${DAY_LABELS[day] || day}.` };
    }
    const dayType = state.plan?.days?.[day]?.type || 'rest';
    const ingredients = effectiveIngredients(recipe, slot, dayType, profile, domain);
    return {
      found: true,
      day,
      slot,
      dayLabel: DAY_LABELS[day] || day,
      slotLabel: SLOT_LABELS[slot] || slot,
      dayType,
      recipeId: recipe.id,
      recipeName: recipe.namesByDayType?.[dayType] || recipe.name || 'Ricetta',
      ingredients: ingredients.map(item => ({ name: item.name, category: item.category, quantity: item.quantity, quantitySpeech: item.quantitySpeech })),
      steps: Array.isArray(recipe.steps) ? recipe.steps.slice() : [],
      notes: Array.isArray(recipe.notes) ? recipe.notes.slice() : [],
      specialNote: recipe.specialNote || ''
    };
  }

  function createCookingSession(meal) {
    if (!meal?.found) return null;
    return {
      day: meal.day,
      slot: meal.slot,
      recipeId: meal.recipeId,
      recipeName: meal.recipeName,
      ingredients: meal.ingredients.slice(),
      steps: meal.steps.slice(),
      phase: 'ingredients',
      index: 0,
      paused: false,
      awaitingPreparationConfirmation: false
    };
  }

  function currentCookingItem(session) {
    if (!session) return null;
    const list = session.phase === 'ingredients' ? session.ingredients : session.steps;
    if (!Array.isArray(list) || !list.length || session.index < 0 || session.index >= list.length) return null;
    if (session.phase === 'ingredients') {
      const quantity = session.ingredients[session.index].quantitySpeech;
      const name = session.ingredients[session.index].name;
      const quantityText = quantity && typeof quantity === 'object'
        ? `per l'uomo ${quantity.man || 'quanto basta'} e per la donna IPO ${quantity.ipo || 'quanto basta'}`
        : quantity;
      return { kind: 'ingredient', index: session.index, total: list.length, name, quantity, text: quantityText ? `Prendi ${quantityText} di ${name}.` : `Prendi ${name}.` };
    }
    return {
      kind: 'step',
      index: session.index,
      total: list.length,
      text: String(list[session.index] || '').trim()
    };
  }

  function cookingStatus(session) {
    const item = currentCookingItem(session);
    return {
      active: Boolean(session),
      phase: session?.phase || null,
      recipeName: session?.recipeName || null,
      index: item?.index ?? null,
      total: item?.total ?? 0,
      current: item,
      paused: Boolean(session?.paused),
      awaitingPreparationConfirmation: Boolean(session?.awaitingPreparationConfirmation)
    };
  }

  function advanceCooking(session) {
    if (!session) return { session: null, status: cookingStatus(null), message: 'Non c’è una preparazione attiva.' };
    if (session.paused) return { session, status: cookingStatus(session), message: 'La preparazione è in pausa.' };

    const lastIndex = (session.phase === 'ingredients' ? session.ingredients : session.steps).length - 1;
    if (session.index < lastIndex) {
      session.index += 1;
      return { session, status: cookingStatus(session), message: currentCookingItem(session)?.text || '' };
    }

    if (session.phase === 'ingredients') {
      session.awaitingPreparationConfirmation = true;
      return {
        session,
        status: cookingStatus(session),
        message: 'Abbiamo preso tutto. Vuoi che iniziamo a preparare?'
      };
    }

    return {
      session,
      status: cookingStatus(session),
      message: 'Abbiamo finito la preparazione. Bravissimo, è tutto pronto.'
    };
  }

  function startPreparation(session) {
    if (!session) return { session: null, status: cookingStatus(null), message: 'Prima scegliamo una ricetta da preparare.' };
    session.phase = 'steps';
    session.index = 0;
    session.paused = false;
    session.awaitingPreparationConfirmation = false;
    const current = currentCookingItem(session);
    return {
      session,
      status: cookingStatus(session),
      message: current ? `Perfetto. ${current.text}` : 'La ricetta non contiene passaggi di preparazione.'
    };
  }

  function repeatCooking(session) {
    const current = currentCookingItem(session);
    return { session, status: cookingStatus(session), message: current?.text || 'Non c’è nulla da ripetere.' };
  }

  function previousCooking(session) {
    if (!session) return { session: null, status: cookingStatus(null), message: 'Non c’è una preparazione attiva.' };
    session.index = Math.max(0, session.index - 1);
    session.awaitingPreparationConfirmation = false;
    return { session, status: cookingStatus(session), message: currentCookingItem(session)?.text || '' };
  }

  function skipCooking(session) {
    if (!session) return { session: null, status: cookingStatus(null), message: 'Non c’è una preparazione attiva.' };
    return advanceCooking(session);
  }

  function togglePause(session) {
    if (!session) return { session: null, status: cookingStatus(null), message: 'Non c’è una preparazione attiva.' };
    session.paused = !session.paused;
    return {
      session,
      status: cookingStatus(session),
      message: session.paused ? 'Va bene, metto in pausa.' : `Ripartiamo. ${currentCookingItem(session)?.text || ''}`
    };
  }

  function restartCooking(session) {
    if (!session) return { session: null, status: cookingStatus(null), message: 'Non c’è una preparazione attiva.' };
    session.phase = 'ingredients';
    session.index = 0;
    session.paused = false;
    session.awaitingPreparationConfirmation = false;
    return { session, status: cookingStatus(session), message: currentCookingItem(session)?.text || '' };
  }

  function commandFor(value) {
    if (isCloseCommand(value)) return 'close';
    if (isAdvanceCommand(value)) return 'next';
    if (isRepeatCommand(value)) return 'repeat';
    if (isPreviousCommand(value)) return 'previous';
    if (isSkipCommand(value)) return 'skip';
    if (isPauseCommand(value)) return 'pause';
    if (isRestartCommand(value)) return 'restart';
    if (isStartPreparationCommand(value)) return 'start-preparation';
    return null;
  }

  function tokenizeQuery(value) {
    return normalizeText(value).split(' ').filter(token => token.length > 2);
  }

  function searchText(records, query, limit = 6) {
    const tokens = tokenizeQuery(query);
    if (!tokens.length) return [];
    return records.map(record => {
      const text = normalizeText(record.text);
      const score = tokens.reduce((total, token) => total + (text.includes(token) ? 1 : 0), 0);
      return { ...record, score };
    }).filter(record => record.score > 0)
      .sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title), 'it'))
      .slice(0, limit)
      .map(({ score, ...record }) => record);
  }

  return {
    DAYS,
    SLOTS,
    SLOT_LABELS,
    DAY_LABELS,
    normalizeText,
    todayKey,
    resolveDay,
    resolveSlot,
    isCloseCommand,
    isAdvanceCommand,
    isRepeatCommand,
    isPreviousCommand,
    isSkipCommand,
    isPauseCommand,
    isRestartCommand,
    isStartPreparationCommand,
    commandFor,
    parseFoodAmount,
    quantityToSpeech,
    portionFor,
    effectiveIngredients,
    isFruit,
    sumFruitQuantity,
    mealDetails,
    createCookingSession,
    currentCookingItem,
    cookingStatus,
    advanceCooking,
    startPreparation,
    repeatCooking,
    previousCooking,
    skipCooking,
    togglePause,
    restartCooking,
    searchText
  };
});
