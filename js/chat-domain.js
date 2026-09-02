/* Piano Nutrizionale — dominio puro per la chat AI.
 *
 * Nessun DOM, nessuna rete e nessun dato personale hardcoded: queste funzioni
 * interpretano il testo dell'utente e trasformano il piano già caricato
 * dall'app in risposte deterministiche. La chat risponde SOLO a domande sulla
 * webapp; l'unica richiesta che esce verso il web è la ricerca di nuove
 * ricette (gestita in js/chat.js tramite il Worker Cloudflare /recipes).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PianoChatDomain = api;
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
    // "lunedì prossimo", "il prossimo sabato", "questa domenica": i
    // qualificatori non cambiano il giorno della settimana risolto.
    const key = normalizeText(value)
      .replace(/\b(prossim[oa]|prossimi|questo|questa|il|la)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const safeFallback = DAYS.includes(fallback) ? fallback : todayKey();
    const nextDay = DAYS[(DAYS.indexOf(safeFallback) + 1) % DAYS.length];
    const aliases = {
      monday: 'monday', tuesday: 'tuesday', wednesday: 'wednesday',
      thursday: 'thursday', friday: 'friday', saturday: 'saturday', sunday: 'sunday',
      lunedi: 'monday', martedi: 'tuesday', mercoledi: 'wednesday',
      giovedi: 'thursday', venerdi: 'friday', sabato: 'saturday', domenica: 'sunday',
      oggi: safeFallback, stasera: safeFallback, stamattina: safeFallback,
      domani: nextDay, tomorrow: nextDay,
      'fine settimana': 'saturday', finesettimana: 'saturday', weekend: 'saturday'
    };
    return aliases[key] || safeFallback;
  }

  function resolveSlot(value, fallback = 'dinner') {
    const key = normalizeText(value).replace(/\s+/g, '');
    const aliases = {
      breakfast: 'breakfast', colazione: 'breakfast',
      snack1: 'snack1', spuntino: 'snack1', spuntinomattina: 'snack1', mattina: 'snack1',
      snack2: 'snack2', merenda: 'snack2', spuntino2: 'snack2', spuntinopomeriggio: 'snack2', pomeriggio: 'snack2',
      lunch: 'lunch', pranzo: 'lunch', mezzogiorno: 'lunch',
      dinner: 'dinner', cena: 'dinner', stasera: 'dinner', sera: 'dinner'
    };
    return aliases[key] || (SLOTS.includes(fallback) ? fallback : 'dinner');
  }

  function parseNumberToken(value) {
    const map = { '½': 0.5, '¼': 0.25, '¾': 0.75 };
    return map[value] ?? Number(String(value).replace(',', '.'));
  }

  // Quantità italiane espresse a parole ("un etto", "mezzo chilo",
  // "un cucchiaio"): tradotte in grammi per il parser.
  const WORD_NUMBERS = { un: 1, uno: 1, una: 1, mezzo: 0.5, mezza: 0.5, due: 2, tre: 3, quattro: 4, cinque: 5 };
  const WORD_UNITS_GRAMS = {
    etto: 100, etti: 100,
    chilo: 1000, chili: 1000, kilo: 1000, kili: 1000,
    cucchiaio: 10, cucchiai: 10,
    cucchiaino: 5, cucchiaini: 5
  };

  function parseWordAmount(value) {
    const match = normalizeText(value).match(/^(un|uno|una|mezzo|mezza|due|tre|quattro|cinque)\s+(etto|etti|chilo|chili|kilo|kili|cucchiaio|cucchiai|cucchiaino|cucchiaini)$/);
    if (!match) return null;
    return { value: WORD_NUMBERS[match[1]] * WORD_UNITS_GRAMS[match[2]], unit: 'g' };
  }

  // Parser dedicato alle risposte della chat: un numero nudo in una ricetta
  // alimentare è trattato come grammi.
  function parseFoodAmount(raw) {
    const original = String(raw ?? '').trim();
    if (!original || original === '—' || original === '-') return { skip: true };
    if (/^(q\.?b\.?|liber[oaie]|a piacere)$/i.test(original)) {
      return { free: true, label: original };
    }
    const wordAmount = parseWordAmount(original);
    if (wordAmount) return wordAmount;
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
      ingredients: ingredients.map(item => ({ name: item.name, category: item.category, quantity: item.quantity })),
      steps: Array.isArray(recipe.steps) ? recipe.steps.slice() : [],
      notes: Array.isArray(recipe.notes) ? recipe.notes.slice() : [],
      specialNote: recipe.specialNote || ''
    };
  }

  // ---------------------------------------------------------------------
  // Richieste di NUOVE ricette dal web (unica ricerca web ammessa).
  // Restituisce true solo quando l'utente chiede ricette con determinate
  // caratteristiche che NON sono già nel catalogo; NON scatta per le domande
  // sul piano né per il contenuto già presente nell'app.
  // ---------------------------------------------------------------------
  function analyzeRecipeRequest(value) {
    const text = normalizeText(value);
    if (!text) return false;
    const recipe = 'ricett[ae]';

    // Domande su piano o ricette già nel catalogo: non sono ricerche web.
    if (/cosa prevede|cosa c e|cosa c'e|cosa mangio|cosa mangiamo|cosa si mangia|previsto|prevista|qual e la ricetta|la ricetta del|la ricetta di|il menu|menu della|menu di|programma|piano alimentare|piano della settimana|che ricette hai|nel catalogo|nel ricettario|quale ricetta e|quali ricette ci sono/.test(text)) return false;

    // Verbi di ricerca/creazione seguiti da "ricetta/e".
    if (new RegExp(`\\b(trovami|trovare|trova|proponimi|proponi|proposta|proposte|inventa|inventami|suggerisci|suggeriscimi|cerca|cercami|ricerca|crea|creami|dammi|fammi|voglio|vorrei|desidero|desidererei)\\b[^.!?]*\\b${recipe}\\b`).test(text)) return true;

    // "ricetta nuova/diversa/alternativa/dal web".
    if (new RegExp(`\\b${recipe}\\b[^.!?]*\\b(nuova|nuove|diversa|diverse|differente|alternativa|alternativo|extra|dal web|sul web|online|internet)\\b`).test(text)) return true;
    if (new RegExp(`\\b(nuova|nuove|diversa|diverse|alternativa|alternativo)\\b[^.!?]*\\b${recipe}\\b`).test(text)) return true;

    // "una ricetta", "qualche ricetta", "delle ricette", "più ricette".
    if (new RegExp(`\\b(una|un|qualche|delle|altre|piu)\\s+${recipe}\\b`).test(text)) return true;

    // "ricetta con pollo e riso", "ricette con orata", "ricetta a base di…",
    // "ricette vegetariane": richiesta di caratteristiche specifiche.
    if (new RegExp(`\\b${recipe}\\b\\s+(con|senza|a base di|ricca di)\\b`).test(text)) return true;
    if (new RegExp(`\\b${recipe}\\b\\s+(light|leggera|leggere|vegetariana|vegetariane|vegana|vegane|proteica|proteiche|ipocalorica)\\b`).test(text)) return true;
    // "ricetta di orata" (ma non "ricetta di oggi/domani/…").
    if (new RegExp(`\\b${recipe}\\b\\s+di\\s+(?!oggi|domani|stasera|stamattina|ieri|questa sera|questa settimana|mercoledi|giovedi|venerdi|sabato|domenica|lunedi|martedi)\\w+`).test(text)) return true;

    return false;
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

  // ---------------------------------------------------------------------
  // Interpretazione locale gratuita: richieste intra-app risolte senza
  // alcuna chiamata esterna.
  // ---------------------------------------------------------------------

  const OUT_OF_SCOPE_PATTERN = /meteo|tempo fa|previsioni del tempo|notizie|news|politica|elezioni|governo|calcio|partita|champions|serie a|tennis|basket|pallavolo|formula 1|motogp|film|serie tv|attore|attrice|musica|canzone|cantante|concerto|videogioco|videogiochi|barzelletta|traduci|traduzione|inglese|tedesco|francese|spagnolo|programmazione|computer|smartphone|telefono cellulare|auto\b|macchina\b|viaggi|vacanze|oroscopo|lotteria|gioco del lotto|criptovalute|bitcoin|borsa valori|gossip|cronaca nera/;

  function extractDayWord(value) {
    const text = normalizeText(value);
    const words = ['lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato', 'domenica', 'fine settimana', 'weekend', 'oggi', 'domani', 'stasera', 'stamattina'];
    return words.find(word => text.includes(word)) || '';
  }

  function extractSlotWord(value) {
    const text = normalizeText(value);
    return ['colazione', 'pranzo', 'mezzogiorno', 'cena', 'stasera', 'spuntino', 'merenda', 'pomeriggio', 'sera'].find(word => text.includes(word)) || '';
  }

  // Mappa una frase italiana su un tool deterministico dell'app (stesso
  // contratto di executeTool in js/chat.js). Ritorna:
  //   { tool, args }      → richiesta intra-app;
  //   { outOfScope, message } → argomento fuori tema;
  //   { localReply }      → saluto;
  //   null                → la chat mostra il riepilogo delle possibilità
  //                         oppure (se analyzeRecipeRequest è true) avvia la
  //                         ricerca web delle ricette.
  function analyzeLocalIntent(value) {
    const text = normalizeText(value);
    if (!text) return null;

    if (OUT_OF_SCOPE_PATTERN.test(text)) {
      return { outOfScope: true, message: 'Mi occupo solo di piano alimentare, ricette, lista della spesa, batch cooking e linee guida del dott. Meller: questo non è di mia competenza.' };
    }
    if (/^(ciao|salve|buongiorno|buonasera|buonanotte|buon pomeriggio|buondi|ehi|ehila|hey|we)\b/.test(text)) {
      return { localReply: 'Ciao! Posso leggerti il piano, le ricette, la lista della spesa, il batch cooking e la guida di Meller. Per una ricetta nuova dal web scrivi ad esempio “ricetta con pollo e riso”.' };
    }

    // Richiesta di nuove ricette dal web: il motore locale non la sa
    // rispondere, esce verso la ricerca web (mai come ricerca nel catalogo).
    if (analyzeRecipeRequest(text)) return null;

    const day = resolveDay(extractDayWord(text), todayKey());
    const slotWord = extractSlotWord(text);
    const slot = resolveSlot(slotWord, 'dinner');

    if (/frutta/.test(text) && /quanta|quanti|quanto|grammi|peso/.test(text)) {
      const fruitSlot = /merenda|pomeriggio/.test(text) ? 'snack2' : (slotWord ? resolveSlot(slotWord, 'snack1') : 'snack1');
      return { tool: 'get_fruit_quantity', args: { day, slot: ['snack1', 'snack2'].includes(fruitSlot) ? fruitSlot : 'snack1' } };
    }
    if (slotWord && /cosa|che|qual|quale|previsto|prevista|mangi|ricetta|menu/.test(text)) {
      return { tool: 'get_meal_details', args: { day, slot } };
    }
    if (!slotWord && /mangio|mangiare|mangiamo|mangi|si mangia/.test(text) && /cosa|che|qual|quale/.test(text)) {
      return { tool: 'get_current_plan', args: { day } };
    }
    if (/piano|menu|menù|pasti|programma|settimana/.test(text)) return { tool: 'get_current_plan', args: { day } };
    if (/spesa|comprare|compro|acquistare|lista della spesa/.test(text)) return { tool: 'get_shopping_list', args: {} };
    if (/batch|meal prep|in anticipo|preparazioni/.test(text)) return { tool: 'get_batch_cooking', args: { day } };
    if (/meller|guida|linee guida|regole|dottore|consigli|frequenze/.test(text)) return { tool: 'search_app_content', args: { query: 'linee guida dott Meller' } };
    if (/account|collegato|collegati|household|sincronizzazione|chi e collegato/.test(text)) return { tool: 'get_account_context', args: {} };
    if (/cerca|cerco|trova|trovami|come si prepara|ingredienti per|quali ricette|che ricette|elenco ricette|ricette nel catalogo/.test(text)) {
      return { tool: 'search_app_content', args: { query: value } };
    }
    return null;
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
    parseFoodAmount,
    formatNumber,
    portionFor,
    effectiveIngredients,
    isFruit,
    sumFruitQuantity,
    mealDetails,
    searchText,
    analyzeLocalIntent,
    analyzeRecipeRequest
  };
});
