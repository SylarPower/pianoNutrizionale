/* Piano Nutrizionale — assistente (dominio puro).
 *
 * Questo file contiene SOLO funzioni pure e testabili per l'assistente
 * integrato e il coach vocale: nessun DOM, nessuna chiamata Firebase, nessuna
 * chiamata di rete. Riceve in ingresso lo stato dell'app (piano, ricette,
 * lista spesa) e restituisce testo italiano pronto per la chat o per la
 * sintesi vocale.
 *
 * Tre responsabilità:
 *  1. buildContext(): un riepilogo strutturato dello stato (giorni, pasti,
 *     ingredienti, frequenze proteiche, spesa, batch cooking) usato sia
 *     dall'engine locale sia dal prompt del modello online;
 *  2. answerLocally(): un motore di risposta locale, privato e offline, per
 *     le domande più comuni sul piano e sull'app;
 *  3. i builder di narrazione (giorno e cucina guidata) per la chat e il
 *     coach vocale (Web Speech API).
 *
 * Le stesse convenzioni di js/domain.js: trasformazioni idempotenti e
 * testabili, UMD per browser e Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PianoAssistant = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, () => {
  'use strict';

  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const DAY_LABELS = {
    monday: 'Lunedì', tuesday: 'Martedì', wednesday: 'Mercoledì', thursday: 'Giovedì',
    friday: 'Venerdì', saturday: 'Sabato', sunday: 'Domenica'
  };
  // Nome del giorno senza accenti, usato per il riconoscimento nelle domande.
  const DAY_NORM = {
    monday: 'lunedi', tuesday: 'martedi', wednesday: 'mercoledi', thursday: 'giovedi',
    friday: 'venerdi', saturday: 'sabato', sunday: 'domenica'
  };
  const SLOTS = ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'];
  const SLOT_LABELS = {
    breakfast: 'Colazione', snack1: 'Spuntino mattina', lunch: 'Pranzo',
    snack2: 'Merenda', dinner: 'Cena'
  };
  const SLOT_KEYWORDS = {
    breakfast: ['colazione'], snack1: ['spuntino'], lunch: ['pranzo'],
    snack2: ['merenda'], dinner: ['cena']
  };

  const CATEGORY_LABELS = {
    poultry: 'Pollame', beef: 'Manzo e maiale', curedMeats: 'Affettati e carni miste',
    omega: 'Pesce ricco di omega-3', otherFish: 'Altro pesce e prodotti ittici',
    dairy: 'Latticini e formaggi', eggs: 'Uova', legumes: 'Legumi e derivati'
  };
  const CATEGORY_ORDER = ['poultry', 'beef', 'curedMeats', 'omega', 'otherFish', 'dairy', 'eggs', 'legumes'];

  const STOPWORDS = new Set([
    'cosa', 'come', 'quale', 'quali', 'quando', 'dove', 'perche', 'perchè', 'chi',
    'del', 'della', 'dello', 'dei', 'degli', 'delle', 'nel', 'nella', 'nello', 'nei', 'negli', 'nelle',
    'con', 'per', 'una', 'uno', 'un', 'oggi', 'domani', 'dopodomani',
    'ricetta', 'ricette', 'preparo', 'preparare', 'prepara', 'fare', 'ingredienti', 'ingrediente',
    'quanto', 'quanti', 'quanta', 'quante', 'cucinare', 'cucino', 'mangio', 'mangiare',
    'posso', 'devo', 'deve', 'volte', 'settimana', 'piano', 'spesa', 'aiuto', 'app',
    'di', 'a', 'da', 'in', 'su', 'il', 'lo', 'la', 'i', 'gli', 'le', 'e', 'o', 'mi', 'ti'
  ]);

  // ---- Piccoli helper puri ----
  function stripAccents(text) {
    return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  function normalizeText(text) {
    return stripAccents(String(text || '').toLowerCase())
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function includesAny(text, words) {
    return words.some(word => text.includes(word));
  }

  function dayTypeLabel(type) {
    return type === 'training' ? 'allenamento' : 'riposo';
  }

  function profileLabelFor(profile) {
    if (profile === 'ipo') return 'Donna · regime IPO';
    if (profile === 'couple') return 'Uomo + donna IPO';
    return 'Uomo · dosi A/R';
  }

  function recipeDisplayName(recipe, dayType) {
    if (!recipe) return 'nessuna ricetta';
    return recipe.namesByDayType?.[dayType] || recipe.name || 'ricetta senza nome';
  }

  function isEmptyPortion(value) {
    const normalized = String(value ?? '').trim();
    return !normalized || normalized === '—' || normalized === '-';
  }

  // Valore della porzione per profilo e tipo giornata (stesse regole di app.js).
  function portionValue(ingredient, profile, dayType) {
    const portions = ingredient?.portions || {};
    const training = dayType === 'training';
    if (profile === 'ipo') {
      return portions[training ? 'ipoTraining' : 'ipoRest'] ?? portions.ipo ?? '';
    }
    if (profile === 'man') {
      return portions[training ? 'manTraining' : 'manRest'] ?? portions[dayType] ?? portions.training ?? '';
    }
    return '';
  }

  // Solo la dose di un ingrediente (senza il nome), per le risposte precise
  // del tipo "quanti grammi di frutta nello spuntino?".
  function quantityText(ingredient, profile, dayType) {
    if (profile === 'couple') {
      const man = portionValue(ingredient, 'man', dayType);
      const woman = portionValue(ingredient, 'ipo', dayType);
      const manOk = !isEmptyPortion(man);
      const womanOk = !isEmptyPortion(woman);
      if (!manOk && !womanOk) return '';
      return `Uomo ${manOk ? man : '—'} · Donna IPO ${womanOk ? woman : '—'}`;
    }
    const quantity = portionValue(ingredient, profile, dayType);
    return isEmptyPortion(quantity) ? '' : quantity;
  }

  // Testo piatto (niente HTML) di un ingrediente con la sua dose, per la chat
  // e per la sintesi vocale.
  function ingredientText(ingredient, profile, dayType) {
    const name = ingredient?.name ? String(ingredient.name).trim() : '';
    if (!name) return '';
    const quantity = quantityText(ingredient, profile, dayType);
    if (!quantity) return name;
    if (profile === 'couple') return `${name} (${quantity})`;
    return `${name} ${quantity}`;
  }

  // ---- Classificazione proteica (fallback locale) ----
  function fallbackClassify(recipe) {
    if (!recipe) return null;
    const rawKey = recipe.proteinCategory ? String(recipe.proteinCategory).trim().toLowerCase() : '';
    const keyMap = {
      poultry: 'poultry', pollame: 'poultry',
      beef: 'beef', beefpork: 'beef', redmeat: 'beef',
      curedmeats: 'curedMeats', affettati: 'curedMeats',
      omega: 'omega', omega3: 'omega', otherfish: 'otherFish',
      dairy: 'dairy', eggs: 'eggs', legumes: 'legumes'
    };
    if (keyMap[rawKey]) return keyMap[rawKey];
    const text = (recipe.ingredients || []).map(ingredient => normalizeText(ingredient?.name)).join(' ');
    if (/pollo|tacchino|faraona|coniglio/.test(text)) return 'poultry';
    if (/salmone|sgombro|sardine|aringhe|alici|acciughe|omega/.test(text)) return 'omega';
    if (/manzo|vitello|maiale|lonza|suino|salsiccia|costine/.test(text)) return 'beef';
    if (/affettat|prosciutto|bresaola|salame|salumi|speck|crudo|cotto/.test(text)) return 'curedMeats';
    if (/merluzzo|nasello|sogliola|tonno|pesce|gamber|crostace|mollusc|calamar|polpo|seppia|orata|branzino|spigola|trota|platessa/.test(text)) return 'otherFish';
    if (/formagg|ricotta|mozzarella|yogurt|fiocchi|parmigiano|grana|skyr|kefir|latte|scamorza|stracchino|feta|caprino|montasio/.test(text)) return 'dairy';
    if (/uov/.test(text)) return 'eggs';
    if (/legum|ceci|lenticch|fagiol|piselli|tofu|soia|edamame|fave/.test(text)) return 'legumes';
    return null;
  }

  function classify(recipe, classifier) {
    if (!recipe) return null;
    if (typeof classifier === 'function') {
      try {
        const category = classifier(recipe);
        if (category) return category;
      } catch (_) { /* fallback locale */ }
    }
    return fallbackClassify(recipe);
  }

  // Frequenze proteiche calcolate SOLO sui pasti principali (pranzo e cena),
  // come nel resto dell'app.
  function proteinCounts(plan, recipesById, classifier) {
    const counts = { poultry: 0, beef: 0, curedMeats: 0, omega: 0, otherFish: 0, dairy: 0, eggs: 0, legumes: 0 };
    DAYS.forEach(day => {
      ['lunch', 'dinner'].forEach(slot => {
        const recipe = recipesById[plan?.days?.[day]?.[slot]] || null;
        const category = classify(recipe, classifier);
        if (category && counts[category] !== undefined) counts[category]++;
      });
    });
    return counts;
  }

  // ---- Costruzione del contesto ----
  function buildDay(plan, recipesById, dayKey, profile) {
    const day = plan?.days?.[dayKey] || {};
    const type = day.type === 'training' ? 'training' : 'rest';
    const meals = SLOTS.map(slot => {
      const recipe = recipesById[day[slot]] || null;
      const ingredients = recipe
        ? (recipe.ingredients || []).map(ingredient => ingredientText(ingredient, profile, type)).filter(Boolean)
        : [];
      const ingredientItems = recipe
        ? (recipe.ingredients || []).map(ingredient => ({
            name: String(ingredient?.name || '').trim(),
            quantity: quantityText(ingredient, profile, type)
          }))
        : [];
      return {
        slot,
        label: SLOT_LABELS[slot],
        recipeId: day[slot] || null,
        recipeName: recipeDisplayName(recipe, type),
        hasRecipe: Boolean(recipe),
        ingredients,
        ingredientItems
      };
    });
    return { key: dayKey, label: DAY_LABELS[dayKey], type, typeLabel: dayTypeLabel(type), meals };
  }

  // Riepilogo in linguaggio naturale del batch cooking attivo per un giorno.
  function buildBatchSummary(batches, dayKey) {
    if (!Array.isArray(batches) || !batches.length) return '';
    const parts = batches.map(batch => {
      const target = DAY_LABELS[batch?.targetDay] || batch?.targetDay || '';
      if (batch?.commonRecipe) {
        return target ? `doppia porzione per il pranzo di ${target}` : 'doppia porzione';
      }
      const tasks = (batch?.tasks || [])
        .map(task => `${task.label}${task.quantity ? ` (${task.quantity})` : ''}`)
        .filter(Boolean);
      const body = tasks.length ? `prepara ${tasks.join('; ')}` : 'preparazione in anticipo';
      return target ? `${body} per il pranzo di ${target}` : body;
    });
    return `batch cooking di ${DAY_LABELS[dayKey] || dayKey}: ${parts.join(' · ')}`;
  }

  // buildContext() riceve lo stato grezzo e produce il riepilogo strutturato.
  // - plan, recipes: come in appState
  // - shoppingEntries: [{ name, amount }] già formattati dall'UI
  // - today: 'monday'…'sunday'
  // - profile: 'man' | 'ipo' | 'couple'
  // - profileLabel: etichetta leggibile (facoltativa)
  // - classifyProtein: funzione (recipe) -> categoria (facoltativa)
  // - batchByDay: { dayKey: [batch, …] } (facoltativo, formato domain.js)
  function buildContext(state = {}) {
    const recipesById = {};
    (state.recipes || []).forEach(recipe => {
      if (recipe && recipe.id) recipesById[recipe.id] = recipe;
    });
    const profile = ['man', 'ipo', 'couple'].includes(state.profile) ? state.profile : 'man';
    const days = DAYS.map(day => buildDay(state.plan, recipesById, day, profile));
    const counts = proteinCounts(state.plan, recipesById, state.classifyProtein);
    const shoppingItems = (state.shoppingEntries || []).map(entry => ({
      name: String(entry?.name || '').trim(),
      amount: String(entry?.amount || '').trim()
    }));
    const batchByDay = {};
    Object.keys(state.batchByDay || {}).forEach(day => {
      const text = buildBatchSummary(state.batchByDay[day], day);
      if (text) batchByDay[day] = text;
    });
    return {
      today: DAYS.includes(state.today) ? state.today : 'monday',
      profile,
      profileLabel: state.profileLabel || profileLabelFor(profile),
      days,
      counts,
      shopping: { count: shoppingItems.length, items: shoppingItems },
      batchByDay,
      recipesById,
      _plan: state.plan || null
    };
  }

  // Trova la ricetta assegnata a un giorno/pasto del piano.
  function plannedRecipe(context, dayKey, slot) {
    const id = context?._plan?.days?.[dayKey]?.[slot] || null;
    return id ? context.recipesById[id] || null : null;
  }

  // ---- Narrazioni per il coach vocale ----
  function buildDayNarration(context, dayKey, options = {}) {
    const day = context?.days?.find(item => item.key === dayKey);
    if (!day) return '';
    const meals = options.slot ? day.meals.filter(meal => meal.slot === options.slot) : day.meals;
    const lines = [`${day.label}, giorno di ${day.typeLabel}.`];
    meals.forEach(meal => {
      if (!meal.hasRecipe) {
        lines.push(`${meal.label}: nessuna ricetta assegnata.`);
        return;
      }
      const ingredients = meal.ingredients.length ? ` con ${meal.ingredients.join(', ')}` : '';
      lines.push(`${meal.label}: ${meal.recipeName}${ingredients}.`);
    });
    if (options.includeBatch !== false && context.batchByDay?.[dayKey]) {
      lines.push(`In anticipo puoi preparare: ${context.batchByDay[dayKey]}.`);
    }
    return lines.join(' ');
  }

  // Punto di partenza della "cucina guidata": il coach introduce la ricetta e
  // comincia con il primo ingrediente. Ritorna '' se non c'è nulla da dire.
  function buildCookingIntro(recipe, profile, dayType) {
    if (!recipe) return '';
    const type = dayType === 'training' ? 'training' : 'rest';
    const name = recipeDisplayName(recipe, type);
    const intro = `Perfetto, cuciniamo ${name}.`;
    const first = buildCookingStep(recipe, profile, type, 'ingredients', 0);
    return first ? `${intro} ${first}` : intro;
  }

  // Singolo passaggio della cucina guidata.
  function buildCookingStep(recipe, profile, dayType, phase, index) {
    if (!recipe) return '';
    const type = dayType === 'training' ? 'training' : 'rest';
    if (phase === 'ingredients') {
      const ingredient = recipe.ingredients?.[index];
      if (!ingredient) return '';
      const name = String(ingredient?.name || '').trim();
      const quantity = quantityText(ingredient, profile, type);
      if (!quantity) return `Prendi ${name}, dose libera.`;
      if (profile === 'couple') return `Prendi ${name}: ${quantity}.`;
      // Dose con unità ("90g", "2 pz", "un mazzetto") → "Prendi 90g di Riso".
      // Dose numerica pura ("2") → "Prendi 2 Uova intere".
      if (/^\d+(?:[.,]\d+)?$/.test(quantity.trim())) return `Prendi ${quantity} ${name}.`;
      return `Prendi ${quantity} di ${name}.`;
    }
    if (phase === 'steps') {
      const step = recipe.steps?.[index];
      if (!step) return '';
      const text = String(step).trim().replace(/[.\s]+$/, '');
      return `Passo ${index + 1} di ${recipe.steps.length}: ${text}.`;
    }
    return '';
  }

  // ---- Ricerca ricetta per nome/ingrediente ----
  function tokenize(question) {
    return normalizeText(question)
      .split(' ')
      .filter(token => token.length >= 3 && !STOPWORDS.has(token));
  }

  function findRecipe(question, recipesById = {}) {
    const normalizedQuestion = normalizeText(question);
    const tokens = tokenize(question);
    let best = null;
    let bestScore = 0;
    Object.values(recipesById).forEach(recipe => {
      if (!recipe) return;
      let score = 0;
      const idNorm = normalizeText(recipe.id || '');
      if (idNorm && normalizedQuestion.includes(idNorm)) score += 4;
      if (tokens.length) {
        const searchable = normalizeText([
          recipe.name,
          ...Object.values(recipe.namesByDayType || {}),
          ...(recipe.ingredients || []).map(ingredient => ingredient?.name || '')
        ].join(' '));
        tokens.forEach(token => { if (searchable.includes(token)) score += 1; });
      }
      if (score > bestScore) {
        bestScore = score;
        best = recipe;
      }
    });
    return bestScore >= 1 ? best : null;
  }

  // ---- Risposte locali (engine privato e offline) ----
  function buildShoppingAnswer(context) {
    if (!context.shopping.count) {
      return 'La tua lista della spesa è vuota: apri la scheda Spesa e seleziona almeno un pasto.';
    }
    return `La lista della spesa per ${context.profileLabel} contiene ${context.shopping.count} alimenti: ${context.shopping.items.map(item => `${item.name} ${item.amount}`.trim()).join(' · ')}.`;
  }

  function buildCountsAnswer(context, guide) {
    const summary = CATEGORY_ORDER.map(key => `${CATEGORY_LABELS[key]}: ${context.counts[key]}`).join(' · ');
    const base = `Questa settimana, contando solo pranzo e cena, le fonti proteiche sono: ${summary}.`;
    const targets = Array.isArray(guide?.proteinFrequencies)
      ? guide.proteinFrequencies.map(row => `${row[0]}: ${row[1]}`).join(' · ')
      : '';
    return targets ? `${base} Secondo il manuale: ${targets}.` : base;
  }

  function buildBatchAnswer(context) {
    const keys = Object.keys(context.batchByDay || {});
    if (keys.length) return keys.map(key => context.batchByDay[key]).join(' ');
    return 'Non ci sono preparazioni in anticipo attive in questo momento. Il batch cooking compare nella vista Settimana quando una cena può diventare anche il pranzo di un giorno successivo (chip "Batch cooking disponibile").';
  }

  function buildAlternativesAnswer(guide, question) {
    if (!guide?.alternatives) return null;
    const wantsCarb = includesAny(question, ['carboidrat', 'pasta', 'riso', 'pane', 'gnocchi', 'farro', 'orzo', 'quinoa', 'patat', 'cereal', 'grano']);
    const wantsProtein = includesAny(question, ['protein', 'pollame', 'manzo', 'maiale', 'pesce', 'uova', 'legum', 'formagg', 'latticin']);
    const groups = [];
    if (wantsCarb || !wantsProtein) groups.push(guide.alternatives.carbohydrates);
    if (wantsProtein || !wantsCarb) groups.push(guide.alternatives.proteins);
    if (!groups.length) return null;
    const text = groups
      .map(group => `${group.title}: ${group.rows.map(row => `${row[0]} = ${row[1]}`).join(' · ')}.`)
      .join(' ');
    return `Alternative del manuale Meller (pesi a crudo). ${text}`;
  }

  function buildFaqAnswer(guide, question) {
    const faq = Array.isArray(guide?.faq) ? guide.faq : [];
    if (!faq.length) return null;
    const keywords = ['acqua', 'sale', 'bere', 'idrat', 'sociale', 'fuori', 'crudo', 'spezie', 'pesare', 'verdura', 'combinare', 'intercambiabili'];
    const matching = faq.filter(item => {
      const normalized = normalizeText(item);
      return keywords.some(keyword => normalized.includes(keyword) && question.includes(keyword));
    });
    if (matching.length) return matching.join(' ');
    if (includesAny(question, ['faq', 'domande', 'dubbi', 'indicazioni'])) return faq.join(' ');
    return null;
  }

  function buildProfileAnswer(context) {
    let detail = '';
    if (context.profile === 'man') detail = 'Le quantità seguono le dosi Uomo con distinzione tra giorno di Allenamento (A) e di Riposo (R).';
    else if (context.profile === 'ipo') detail = 'Le quantità seguono le dosi Donna in regime IPO.';
    else detail = 'Le quantità mostrano entrambe le dosi: Uomo e Donna IPO.';
    return `Il profilo porzioni attivo è "${context.profileLabel}". ${detail} Puoi cambiarlo in qualsiasi momento dal selettore in alto.`;
  }

  function buildWeekAnswer(context) {
    return `Il piano della settimana è: ${context.days.map(day => {
      const meals = day.meals.map(meal => `${meal.label}: ${meal.recipeName}`).join(' · ');
      return `${day.label} (${day.type === 'training' ? 'allenamento' : 'riposo'}): ${meals}`;
    }).join(' — ')}.`;
  }

  function buildRecipeAnswer(recipe, profile) {
    const ingredients = (recipe.ingredients || []).map(ingredient => ingredientText(ingredient, profile, 'training')).filter(Boolean);
    const steps = (recipe.steps || []).map(step => String(step || '').trim()).filter(Boolean);
    return [
      `La ricetta ${recipeDisplayName(recipe, 'training')} prevede:`,
      ingredients.length ? `Ingredienti: ${ingredients.join(', ')}.` : 'Nessun ingrediente elencato.',
      steps.length ? `Preparazione: ${steps.map((step, index) => `${index + 1}) ${step}`).join(' ')}` : ''
    ].filter(Boolean).join(' ');
  }

  const APP_HELP = [
    'Piano Nutrizionale è una PWA privata per il tuo piano alimentare. Puoi:',
    '· vedere la settimana nella scheda Settimana, con i pasti di ogni giorno e il tipo di giornata A (allenamento) o R (riposo);',
    '· consultare e creare ricette nel Ricettario, anche da zero;',
    '· generare una settimana automatica con il pulsante "Genera settimana";',
    '· preparare i pasti in anticipo grazie al batch cooking (chip "Batch cooking disponibile");',
    '· vedere la lista della spesa nella scheda Spesa, con le quantità esatte per il tuo profilo;',
    '· registrare e confrontare i prezzi nella scheda Prezzi;',
    '· condividere ricette e settimana con un altro account e collegare più account;',
    '· trovare il manuale e le alternative alimentari nelle Impostazioni.',
    'Fammi una domanda concreta, ad esempio "cosa mangio oggi?", "cosa devo comprare?" oppure "quante volte mangio pesce?".'
  ].join(' ');

  // Estrae da una domanda il giorno e il pasto a cui si riferisce.
  function resolveQuestion(question, context) {
    const q = normalizeText(question);
    const dayIndex = DAYS.indexOf(context?.today || 'monday');
    let day = null;
    if (q.includes('dopodomani')) day = DAYS[(dayIndex + 2) % DAYS.length];
    else if (q.includes('domani')) day = DAYS[(dayIndex + 1) % DAYS.length];
    else if (q.includes('oggi') || q.includes('stasera') || q.includes('stanotte') || q.includes('adesso')) day = context.today;
    else {
      for (const [key, normalized] of Object.entries(DAY_NORM)) {
        if (q.includes(normalized)) { day = key; break; }
      }
    }
    let slot = null;
    for (const [key, keywords] of Object.entries(SLOT_KEYWORDS)) {
      if (keywords.some(keyword => q.includes(keyword))) { slot = key; break; }
    }
    return { day, slot };
  }

  // Risposta precisa per le domande di quantità ("quanti g di frutta nello
  // spuntino di oggi?"). Ritorna null se non è una domanda di quantità.
  function buildQuantityAnswer(question, context) {
    const q = normalizeText(question);
    const asksAmount = includesAny(q, ['quanto', 'quanti', 'quanta', 'quante', 'grammi', 'quanto pesa', 'g di', 'gr di', 'dose']);
    if (!asksAmount) return null;
    const { day, slot } = resolveQuestion(question, context);
    if (!slot) return null;
    const dayKey = day || context.today;
    const recipe = plannedRecipe(context, dayKey, slot);
    if (!recipe) return { text: `Non c'è nessuna ricetta assegnata a ${SLOT_LABELS[slot]} di ${DAY_LABELS[dayKey]}.` };
    const dayType = context._plan?.days?.[dayKey]?.type === 'training' ? 'training' : 'rest';
    const items = (recipe.ingredients || []).map(ingredient => ({
      name: String(ingredient?.name || '').trim(),
      quantity: quantityText(ingredient, context.profile, dayType)
    }));
    const tokens = tokenize(question);
    let target = null;
    if (tokens.length) {
      let best = null;
      let bestScore = 0;
      items.forEach(item => {
        const searchable = normalizeText(item.name);
        let score = 0;
        tokens.forEach(token => { if (searchable.includes(token)) score += 1; });
        if (score > bestScore) { bestScore = score; best = item; }
      });
      if (best && bestScore >= 1) target = best;
    }
    const prefix = `${SLOT_LABELS[slot]} di ${DAY_LABELS[dayKey]}: ${recipeDisplayName(recipe, dayType)}.`;
    if (target) {
      if (!target.quantity) return { text: `Per ${target.name} la dose è libera, non ci sono grammi fissi.` };
      return { text: `${prefix} Di ${target.name} devi prenderne ${target.quantity}.` };
    }
    if (!items.length) return { text: `La ricetta ${recipeDisplayName(recipe, dayType)} non ha ingredienti elencati.` };
    if (items.length === 1) {
      const single = items[0];
      return single.quantity
        ? { text: `${prefix} C'è un solo ingrediente: ${single.name}, ${single.quantity}.` }
        : { text: `${prefix} C'è un solo ingrediente: ${single.name}, con dose libera.` };
    }
    const listing = items.map(item => item.quantity ? `${item.name} ${item.quantity}` : item.name).join(' · ');
    return { text: `${prefix} Gli ingredienti con le dosi sono: ${listing}. Quale ti interessa?` };
  }

  // Motore locale: restituisce { text, cooking? } oppure null (nessuna corrispondenza).
  function answerLocally(question, context, guide = null) {
    const q = normalizeText(question);
    if (!q || !context) return null;
    const { day, slot } = resolveQuestion(question, context);

    if (includesAny(q, ['come funziona', 'cosa posso fare', 'cosa puoi fare', 'aiuto', 'help', 'funzioni', 'a cosa serve', 'come si usa', 'cosa fa', 'cos e', 'istruzioni', 'tutorial', 'sai fare'])) {
      return { text: APP_HELP };
    }
    if (includesAny(q, ['spesa', 'comprare', 'compro', 'acquist', 'lista', 'supermercato', 'alimenti', 'fare la spesa'])) {
      return { text: buildShoppingAnswer(context) };
    }
    if (includesAny(q, ['pesce', 'frequenz', 'proteine', 'quante volte', 'omega', 'legumi', 'uova', 'latticini', 'formaggi', 'carne rossa', 'manzo'])) {
      return { text: buildCountsAnswer(context, guide) };
    }
    if (includesAny(q, ['batch', 'anticipo', 'in anticipo', 'preparo prima', 'preparare prima', 'prepara prima', 'doppia porzione'])) {
      return { text: buildBatchAnswer(context) };
    }

    // Cucina guidata: "cuciniamo la cena di stasera" → sessione passo-passo.
    if (includesAny(q, ['cuciniamo', 'cucinare', 'cucina', 'prepariamo', 'preparare', 'prepara', 'preparazione', 'come si prepara', 'ricetta di'])) {
      const targetDay = day || context.today;
      const targetSlot = slot;
      let recipe = null;
      let dayType = context._plan?.days?.[targetDay]?.type === 'training' ? 'training' : 'rest';
      if (targetSlot) recipe = plannedRecipe(context, targetDay, targetSlot);
      if (!recipe) {
        recipe = findRecipe(question, context.recipesById);
        dayType = 'training';
      }
      if (recipe) {
        return { text: buildCookingIntro(recipe, context.profile, dayType), cooking: { recipeId: recipe.id, dayType } };
      }
      return { text: 'Quale ricetta vuoi cucinare? Dimmi ad esempio "cuciniamo la cena di stasera" oppure il nome di una ricetta.' };
    }

    const quantityAnswer = buildQuantityAnswer(question, context);
    if (quantityAnswer) return quantityAnswer;

    const alternatives = includesAny(q, ['alternativ', 'equivalen', 'sostitui', 'sostituzion']);
    if (alternatives) {
      const text = buildAlternativesAnswer(guide, q);
      if (text) return { text };
    }
    const faqAnswer = buildFaqAnswer(guide, q);
    if (faqAnswer) return { text: faqAnswer };
    if (includesAny(q, ['profilo', 'porzion', 'dose', 'dieta', 'regime', 'ipo', 'donna', 'uomo', 'coppia'])) {
      return { text: buildProfileAnswer(context) };
    }

    const wantsMeals = includesAny(q, ['cosa mangio', 'che mangio', 'mangio', 'che si mangia', 'mangiare', 'pasti', 'pasto']);
    if (day || wantsMeals) {
      const text = buildDayNarration(context, day || context.today, { slot: slot || null });
      if (text) return { text };
    }

    if (includesAny(q, ['settimana', 'piano', 'schema', 'menu', 'menù'])) {
      return { text: buildWeekAnswer(context) };
    }

    const recipe = findRecipe(question, context.recipesById);
    if (recipe) return { text: buildRecipeAnswer(recipe, context.profile) };

    return null;
  }

  // ---- Prompt per il modello online gratuito ----
  function contextToText(context, guide = null) {
    const lines = [];
    lines.push(`Profilo porzioni: ${context.profileLabel}.`);
    lines.push(`Oggi è ${DAY_LABELS[context.today]}.`);
    lines.push('PIANO SETTIMANALE:');
    context.days.forEach(day => {
      const meals = day.meals.map(meal => `${meal.label}: ${meal.recipeName}`).join(' · ');
      lines.push(`- ${day.label} (${day.type === 'training' ? 'allenamento' : 'riposo'}): ${meals}`);
    });
    lines.push(`LISTA DELLA SPESA (${context.shopping.count} alimenti): ${context.shopping.items.map(item => `${item.name} ${item.amount}`.trim()).join(' · ')}`);
    lines.push(`FREQUENZE PROTEICHE (pranzo e cena): ${CATEGORY_ORDER.map(key => `${CATEGORY_LABELS[key]} ${context.counts[key]}`).join(' · ')}`);
    if (Object.keys(context.batchByDay || {}).length) {
      lines.push(`BATCH COOKING: ${Object.values(context.batchByDay).join(' ')}`);
    }
    if (Array.isArray(guide?.structure)) lines.push(`STRUTTURA DELLA DIETA: ${guide.structure.join(' ')}`);
    if (Array.isArray(guide?.proteinFrequencies)) {
      lines.push(`FREQUENZE CONSIGLIATE: ${guide.proteinFrequencies.map(row => `${row[0]}: ${row[1]}`).join(' · ')}`);
    }
    if (Array.isArray(guide?.faq)) lines.push(`INDICAZIONI DEL MANUALE: ${guide.faq.join(' ')}`);
    return lines.join('\n');
  }

  function buildSystemPrompt(context, guide = null) {
    return [
      'Sei "Coach", l\'assistente integrato dell\'app Piano Nutrizionale, una PWA privata italiana per piani alimentari personali (colazione, spuntino, pranzo, merenda, cena), ricette, batch cooking e lista della spesa.',
      'Rispondi in italiano, in modo breve, pratico e cordiale, con al massimo qualche frase.',
      'Rispondi SOLO in base al contesto fornito; se la risposta non è nel contesto, dillo chiaramente e suggerisci di consultare il nutrizionista.',
      'Non inventare dosi, alimenti o ricette: se mancano informazioni, dillo.',
      'Il contesto attuale dell\'utente è il seguente:\n\n' + contextToText(context, guide)
    ].join('\n');
  }

  return {
    DAYS,
    DAY_LABELS,
    SLOT_LABELS,
    CATEGORY_LABELS,
    CATEGORY_ORDER,
    stripAccents,
    normalizeText,
    dayTypeLabel,
    profileLabelFor,
    recipeDisplayName,
    portionValue,
    isEmptyPortion,
    quantityText,
    ingredientText,
    fallbackClassify,
    classify,
    proteinCounts,
    buildDay,
    buildBatchSummary,
    buildContext,
    plannedRecipe,
    buildDayNarration,
    buildCookingIntro,
    buildCookingStep,
    tokenize,
    findRecipe,
    resolveQuestion,
    buildQuantityAnswer,
    answerLocally,
    contextToText,
    buildSystemPrompt
  };
});
