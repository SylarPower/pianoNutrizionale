/* Piano Nutrizionale — dominio puro (schema 4).
 *
 * Questo file contiene SOLO funzioni pure: nessun DOM, nessuna chiamata
 * Firebase, nessuna ricetta, nessun dosaggio. I dati personali arrivano da
 * Firestore e vengono trasformati da questi servizi in modo idempotente.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PianoDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, () => {
  'use strict';

  const VERSION = 4;
  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const SLOTS = ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'];
  const EMPTY_PORTION = '—';

  const DAY_LABELS = {
    monday: 'Lunedì', tuesday: 'Martedì', wednesday: 'Mercoledì', thursday: 'Giovedì',
    friday: 'Venerdì', saturday: 'Sabato', sunday: 'Domenica'
  };
  const DAY_SHORT = { monday: 'Lun', tuesday: 'Mar', wednesday: 'Mer', thursday: 'Gio', friday: 'Ven', saturday: 'Sab', sunday: 'Dom' };
  const SLOT_LABELS = { breakfast: 'Colazione', snack1: 'Spuntino mattina', lunch: 'Pranzo', snack2: 'Merenda', dinner: 'Cena' };
  const SLOT_SHORT = { breakfast: 'COLAZ.', snack1: 'SPUNT.', lunch: 'PRANZO', snack2: 'MERENDA', dinner: 'CENA' };

  // Alias comuni normalizzati verso ingredientId stabili. Estendibile.
  const INGREDIENT_ALIASES = {
    'uovo intero': 'whole-eggs',
    'uova intere': 'whole-eggs',
    'uova intere sode': 'whole-eggs',
    'uova intere barzotte': 'whole-eggs',
    'pomodorini': 'cherry-tomatoes',
    'pomodoro ciliegino': 'cherry-tomatoes',
    'salmone': 'salmon',
    'tonno': 'tuna',
    'tonno al naturale sgocciolato': 'tuna',
    'tonno al naturale': 'tuna',
    'yogurt greco': 'greek-yogurt',
    'yogurt greco 0%': 'greek-yogurt',
    'yogurt greco magro o skyr': 'greek-yogurt',
    'pane': 'bread',
    'pane integrale': 'bread',
    'pane di segale': 'bread',
    'pane integrale o di segale': 'bread',
    'pane tostato': 'bread',
    'limone': 'lemon',
    'zucchina': 'zucchini',
    'zucchine': 'zucchini'
  };

  // Etichette canoniche (solo visualizzazione; `name` resta l'etichetta).
  const CANONICAL_INGREDIENTS = {
    'whole-eggs': 'Uova intere',
    'cherry-tomatoes': 'Pomodorini',
    'salmon': 'Salmone',
    'tuna': 'Tonno',
    'greek-yogurt': 'Yogurt greco',
    'bread': 'Pane',
    'lemon': 'Limone',
    'zucchini': 'Zucchine'
  };

  const DEFAULT_CONSTRAINTS = {
    legumesMin: 3, legumesMax: 4,
    omegaMin: 2, omegaMax: 3,
    poultryMin: 1, poultryMax: 2,
    beefMax: 1,
    dairyMin: 1, dairyMax: 2,
    eggsMin: 1, eggsMax: 2,
    otherFishMin: 1, otherFishMax: 2
  };

  function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  // Normalizza un nome in una chiave confrontabile ("Uova intere (sode)" → "uova intere sode").
  function aliasKey(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[()]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function slug(value) {
    return aliasKey(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // ingredientId stabile: preferisce l'ID già presente, poi l'alias, poi lo slug.
  function ingredientIdFor(name, existing) {
    if (existing && typeof existing === 'string' && existing.trim()) return existing.trim();
    return INGREDIENT_ALIASES[aliasKey(name)] || slug(name) || 'ingredient';
  }

  function normalizePortions(p = {}) {
    return {
      ipoTraining: p.ipoTraining ?? p.ipo ?? EMPTY_PORTION,
      ipoRest: p.ipoRest ?? p.ipo ?? EMPTY_PORTION,
      manTraining: p.manTraining ?? p.training ?? EMPTY_PORTION,
      manRest: p.manRest ?? p.rest ?? p.training ?? EMPTY_PORTION
    };
  }

  // Migrazione idempotente di una singola ricetta allo schema 4.
  function migrateRecipe(recipe) {
    if (!recipe || typeof recipe !== 'object') return recipe;
    const ingredients = (recipe.ingredients || []).map(ingredient => ({
      ...ingredient,
      ingredientId: ingredientIdFor(ingredient.name, ingredient.ingredientId),
      portions: normalizePortions(ingredient.portions)
    }));
    return { ...recipe, ingredients };
  }

  // Migrazione idempotente del documento catalogo (schema 3 → 4).
  function migrateCatalog(doc = {}) {
    const recipes = (doc.recipes || []).map(migrateRecipe);
    return {
      ...doc,
      schemaVersion: VERSION,
      recipes,
      recipeCount: recipes.length,
      ingredientAliases: { ...INGREDIENT_ALIASES, ...(doc.ingredientAliases || {}) },
      canonicalIngredients: { ...CANONICAL_INGREDIENTS, ...(doc.canonicalIngredients || {}) }
    };
  }

  // Conversione delle vecchie batchRules testuali in batchTemplates strutturati.
  function migrateBatchRules(rules = {}) {
    if (Array.isArray(rules)) return rules;
    const entries = Object.entries(rules || {});
    if (!entries.length) return [];
    return entries.map(([day, rule]) => ({
      id: `legacy-${day}-${rule.dinner || 'dinner'}-${rule.nextLunch || 'lunch'}`,
      anchor: { slot: 'dinner', recipeId: rule.dinner },
      target: { slot: 'lunch', recipeId: rule.nextLunch, lookAheadDays: 1 },
      tasks: (rule.actions || []).map((label, index) => ({
        id: `legacy-${day}-${index}`,
        actionType: 'prepare',
        label: String(label).replace(/^\[.*?\]\s*/, ''),
        storage: {
          method: 'fridge',
          maxDays: 1,
          instructions: 'Durata prudenziale migrata: da validare per la sicurezza alimentare.'
        }
      })),
      legacyDay: day
    }));
  }

  // Migrazione idempotente del piano settimanale (aggiunge batchTemplates strutturati).
  function migratePlan(plan = {}) {
    const days = plan.days || {};
    let templates;
    if (Array.isArray(plan.batchTemplates) && plan.batchTemplates.length) {
      templates = plan.batchTemplates;
    } else if (plan.batchRules && Object.keys(plan.batchRules).length) {
      templates = migrateBatchRules(plan.batchRules);
    } else {
      templates = Array.isArray(plan.batchTemplates) ? plan.batchTemplates : [];
    }
    return {
      ...plan,
      schemaVersion: VERSION,
      days,
      defaultDays: plan.defaultDays || deepClone(days),
      batchRules: plan.batchRules || {},
      batchTemplates: templates
    };
  }

  function emptyDay(type = 'rest') {
    return { type, breakfast: null, snack1: null, lunch: null, snack2: null, dinner: null };
  }

  function emptyDays() {
    const days = {};
    DAYS.forEach(day => { days[day] = emptyDay(); });
    return days;
  }

  function emptyPlan() {
    return { schemaVersion: VERSION, days: emptyDays(), defaultDays: emptyDays(), batchRules: {}, batchTemplates: [] };
  }

  // ----- Batch cooking dinamico -----

  function dayDistance(from, to) {
    const a = DAYS.indexOf(from);
    const b = DAYS.indexOf(to);
    if (a < 0 || b < 0) return null;
    return (b - a + 7) % 7;
  }

  // Ricerca del prossimo giorno (anche domenica → lunedì) in cui il piano
  // contiene la ricetta target in uno slot. Settimana ricorrente.
  function futureTarget(day, plan, targetSlot, recipeId, maxDays = 7) {
    for (let n = 1; n <= maxDays; n++) {
      const d = DAYS[(DAYS.indexOf(day) + n) % 7];
      if (plan?.days?.[d]?.[targetSlot] === recipeId) return { day: d, days: n };
    }
    return null;
  }

  // Stato di una preparazione rispetto alla finestra di conservazione.
  // maxDays 0 = fresco, si prepara al momento; altrimenti "oggi" se la
  // conservazione copre i giorni fino al target, altrimenti "non ancora".
  function batchTaskStatus(task, daysUntilTarget) {
    const maxDays = task?.storage?.maxDays;
    const d = Number.isFinite(maxDays) ? maxDays : 0;
    if (d === 0) return 'fresh';
    if (daysUntilTarget <= d) return 'today';
    return 'later';
  }

  function portionFor(ingredient, profile, dayType) {
    const p = normalizePortions(ingredient?.portions || {});
    const training = dayType === 'training';
    if (profile === 'ipo') return training ? p.ipoTraining : p.ipoRest;
    if (profile === 'couple') {
      return {
        man: training ? p.manTraining : p.manRest,
        ipo: training ? p.ipoTraining : p.ipoRest
      };
    }
    return training ? p.manTraining : p.manRest;
  }

  function formatPortion(portion, profile) {
    if (profile === 'couple' && portion && typeof portion === 'object') {
      const man = portion.man === undefined || portion.man === null || portion.man === '' ? EMPTY_PORTION : portion.man;
      const ipo = portion.ipo === undefined || portion.ipo === null || portion.ipo === '' ? EMPTY_PORTION : portion.ipo;
      return `Uomo: ${man} · Donna IPO: ${ipo}`;
    }
    const value = portion ?? EMPTY_PORTION;
    return value === '' ? EMPTY_PORTION : value;
  }

  function quantityForTask(task, plan, recipesById, profile, targetDay) {
    const src = task?.quantitySource;
    if (!src?.ingredientId) return '';
    const recipe = recipesById?.[src.recipeId];
    const ingredient = (recipe?.ingredients || []).find(item =>
      (item.ingredientId || ingredientIdFor(item.name)) === src.ingredientId
    );
    if (!ingredient) return '';
    const dayType = plan?.days?.[targetDay]?.type || 'rest';
    return formatPortion(portionFor(ingredient, profile, dayType), profile);
  }

  // Batch attivi per il giorno: almeno una preparazione deve essere valida
  // (fresca o preparabile oggi). Il tipo A/R del giorno corrente non conta:
  // conta solo il tipo A/R del giorno target per le quantità.
  function activeBatch(anchorDay, plan, templates, recipesById = {}, profile = 'man', maxLookAhead = 7) {
    if (!plan?.days?.[anchorDay]) return [];
    const dinner = plan.days[anchorDay].dinner;
    const result = [];
    (templates || []).forEach(template => {
      if (!template?.anchor || template.anchor.recipeId !== dinner) return;
      const target = futureTarget(
        anchorDay, plan,
        template.target?.slot || 'lunch',
        template.target?.recipeId,
        template.target?.lookAheadDays || maxLookAhead
      );
      if (!target) return;
      const tasks = [];
      const seen = new Set();
      (template.tasks || []).forEach(task => {
        if (!task?.id || seen.has(task.id)) return;
        seen.add(task.id);
        tasks.push({
          ...task,
          status: batchTaskStatus(task, target.days),
          quantity: quantityForTask(task, plan, recipesById, profile, target.day)
        });
      });
      const validCount = tasks.filter(task => task.status === 'today' || task.status === 'fresh').length;
      result.push({
        template,
        targetDay: target.day,
        daysUntilTarget: target.days,
        tasks,
        validCount,
        active: validCount > 0
      });
    });
    return result.filter(batch => batch.active);
  }

  // ----- Lista della spesa -----

  const CATEGORY_RULES = [
    { category: '🥩 Carne', terms: ['pollo', 'tacchino', 'vitello', 'manzo'] },
    { category: '🐟 Pesce', terms: ['salmone', 'sgombro', 'merluzzo', 'tonno', 'gamber', 'calamar', 'polpo'] },
    { category: '🥚 Uova e latticini', terms: ['uov', 'ricotta', 'mozzarella', 'caprino', 'feta', 'parmigiano', 'fiocchi di latte', 'yogurt', 'skyr', 'kefir', 'latte'] },
    { category: '🫘 Legumi', terms: ['ceci', 'lenticch', 'fagiol', 'edamame', 'piselli'] },
    { category: '🍚 Carboidrati', terms: ['pasta', 'riso', 'orzo', 'farro', 'quinoa', 'cous cous', 'pane', 'patate', 'farina di ceci', 'polenta', 'cracker', 'trofie', 'avena', 'cereali', 'fette biscottate', 'wasa', 'granola'] },
    { category: '🍑 Frutta', terms: ['pesca', 'mango', 'anguria', 'melone', 'avocado', 'lampon', 'limone', 'lime', 'albicocc', 'cilieg', 'mirtill', 'ananas', 'frutta fresca', 'frutti di bosco'] },
    { category: '🥬 Verdura', terms: ['zucchin', 'pomodor', 'friggitell', 'peperon', 'melanzan', 'rucola', 'cetriolo', 'carota', 'fagiolini', 'spinacin', 'lattuga', 'songino', 'sedano', 'verdura', 'cipolla'] },
    { category: '🥫 Dispensa', terms: ['olio', 'olive', 'mandorle', 'noci', 'pistacchi', 'semi', 'pesto', 'capperi', 'brodo', 'salsa di soia', 'aceto', 'cacao', 'cioccolato', 'marmellata', 'confettura', 'miele', 'sciroppo', 'dolcificante', 'cocco', 'proteine whey'] }
  ];
  const FALLBACK_CATEGORY = '🌿 Spezie e aromi';

  function categoryForIngredient(name) {
    const value = aliasKey(name);
    const hit = CATEGORY_RULES.find(rule => rule.terms.some(term => value.includes(term)));
    return hit ? hit.category : FALLBACK_CATEGORY;
  }

  function isEmptyPortion(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return !normalized || normalized === '—' || normalized === '-';
  }

  function parseSimpleAmount(raw) {
    const original = String(raw ?? '').trim();
    if (isEmptyPortion(original) || /^0(?:[.,]0+)?\s*(g|ml)?$/i.test(original)) return { skip: true };
    if (/^(q\.?b\.?|liber[oaie]|a piacere)$/i.test(original)) return { free: true, label: original };
    const fractionMap = { '½': 0.5, '¼': 0.25, '¾': 0.75 };
    const match = original.match(/^(\d+(?:[.,]\d+)?|[½¼¾])\s*(g|ml|pz)?$/i);
    if (!match) return { opaque: original };
    const value = fractionMap[match[1]] ?? Number(match[1].replace(',', '.'));
    return { value, unit: (match[2] || 'pz').toLowerCase() };
  }

  // Aggrega la lista della spesa per ingredientId. Le dosi "—" vengono saltate.
  function aggregateShopping(plan, recipesById, selectedMeals, profile = 'man', canonicalLabels = {}) {
    const out = {};
    DAYS.forEach(day => {
      const dayType = plan?.days?.[day]?.type || 'rest';
      (selectedMeals?.[day] || []).forEach(slot => {
        const recipe = recipesById?.[plan?.days?.[day]?.[slot]];
        if (!recipe) return;
        (recipe.ingredients || []).forEach(ingredient => {
          const amount = portionFor(ingredient, profile, dayType);
          const entries = profile === 'couple' && amount && typeof amount === 'object'
            ? [{ role: 'Uomo', raw: amount.man }, { role: 'Donna IPO', raw: amount.ipo }]
            : [{ role: profile === 'ipo' ? 'Donna IPO' : 'Uomo', raw: amount }];
          const id = ingredientIdFor(ingredient.name, ingredient.ingredientId);
          const entry = out[id] || (out[id] = {
            ingredientId: id,
            name: canonicalLabels[id] || ingredient.name,
            category: categoryForIngredient(ingredient.name),
            totals: {},
            opaque: {},
            free: false,
            tags: []
          });
          const tag = `${DAY_SHORT[day]} · ${SLOT_SHORT[slot]}`;
          if (!entry.tags.includes(tag)) entry.tags.push(tag);
          entries.forEach(({ role, raw }) => {
            const parsed = parseSimpleAmount(raw);
            if (parsed.skip) return;
            if (parsed.free) { entry.free = true; return; }
            if (parsed.opaque) {
              const label = profile === 'couple' ? `${role}: ${parsed.opaque}` : parsed.opaque;
              entry.opaque[label] = (entry.opaque[label] || 0) + 1;
              return;
            }
            entry.totals[parsed.unit] = (entry.totals[parsed.unit] || 0) + parsed.value;
          });
        });
      });
    });
    return Object.values(out);
  }

  // ----- Copia e scambio pasti -----

  function swapMeals(plan, dayA, slotA, dayB, slotB) {
    if (slotA !== slotB) throw new Error('Slot non compatibili: lo scambio è consentito solo tra pasti dello stesso tipo');
    if (!plan?.days?.[dayA] || !plan?.days?.[dayB]) throw new Error('Giorno non valido');
    const next = deepClone(plan);
    [next.days[dayA][slotA], next.days[dayB][slotB]] = [next.days[dayB][slotB], next.days[dayA][slotA]];
    return next;
  }

  function copyMeal(plan, fromDay, slot, toDay) {
    if (!plan?.days?.[fromDay] || !plan?.days?.[toDay]) throw new Error('Giorno non valido');
    const next = deepClone(plan);
    next.days[toDay][slot] = next.days[fromDay][slot];
    return next;
  }

  function restoreMeal(plan, day, slot) {
    if (!plan?.days?.[day]) throw new Error('Giorno non valido');
    const next = deepClone(plan);
    next.days[day][slot] = next.defaultDays?.[day]?.[slot] ?? null;
    return next;
  }

  // ----- Import / merge -----

  function mergeRecipeCatalogs(current, incoming, rename = true) {
    const result = deepClone(current);
    const usedIds = new Set(result.map(recipe => recipe.id));
    let counter = 0;
    (incoming || []).forEach(source => {
      let recipe = migrateRecipe(source);
      if (usedIds.has(recipe.id)) {
        if (!rename) return;
        let nextId;
        do {
          counter += 1;
          nextId = `I${Date.now().toString(36)}${counter}`;
        } while (usedIds.has(nextId));
        recipe = { ...recipe, id: nextId, name: `${recipe.name} (importata)` };
      }
      usedIds.add(recipe.id);
      result.push(recipe);
    });
    return result.sort((a, b) => String(a.id).localeCompare(String(b.id), 'it', { numeric: true }));
  }

  function sanitizePlanForCatalog(plan, recipes) {
    const ids = new Set((recipes || []).map(recipe => recipe.id));
    const source = plan?.days ? plan : emptyPlan();
    const next = deepClone(source);
    DAYS.forEach(day => {
      if (!next.days?.[day]) next.days[day] = emptyDay();
      if (!next.defaultDays?.[day]) next.defaultDays[day] = emptyDay();
      SLOTS.forEach(slot => {
        if (!ids.has(next.days[day][slot])) next.days[day][slot] = null;
        if (!ids.has(next.defaultDays[day][slot])) next.defaultDays[day][slot] = null;
      });
    });
    next.schemaVersion = VERSION;
    return next;
  }

  function importedPlanIsUsable(plan, recipes) {
    if (!plan?.days) return false;
    const ids = new Set((recipes || []).map(recipe => recipe.id));
    // Gli slot vuoti (null) sono ammessi: solo i riferimenti presenti devono
    // puntare a ricette esistenti nel catalogo risultante.
    return DAYS.every(day => plan.days[day] && SLOTS.every(slot => {
      const recipeId = plan.days[day][slot];
      return !recipeId || ids.has(recipeId);
    }));
  }

  // ----- Condivisioni: analisi conflitti -----

  function recipeEquals(a, b) {
    const strip = recipe => ({
      id: recipe.id,
      name: recipe.name,
      slot: recipe.slot,
      ingredients: (recipe.ingredients || []).map(ingredient => ({
        name: ingredient.name,
        ingredientId: ingredient.ingredientId || ingredientIdFor(ingredient.name),
        portions: normalizePortions(ingredient.portions)
      })),
      steps: recipe.steps || []
    });
    return JSON.stringify(strip(migrateRecipe(a))) === JSON.stringify(strip(migrateRecipe(b)));
  }

  function analyzeShare(currentRecipes, incomingRecipes) {
    const currentById = Object.fromEntries((currentRecipes || []).map(recipe => [recipe.id, recipe]));
    const rawIncoming = incomingRecipes || [];
    const normalizedIncoming = rawIncoming.map(migrateRecipe);
    const analysis = {
      newRecipes: [],
      identical: [],
      conflicts: [],
      invalid: [],
      migratedIngredients: 0,
      missingIngredientIds: [],
      incoming: normalizedIncoming
    };
    normalizedIncoming.forEach((incoming, index) => {
      if (!incoming?.id || !incoming?.name) { analysis.invalid.push(incoming); return; }
      // Gli ingredienti senza ingredientId vengono rilevati sul dato originale
      // (prima della normalizzazione) e contati come "migrati".
      (rawIncoming[index]?.ingredients || []).forEach(ingredient => {
        if (!ingredient.ingredientId) {
          analysis.missingIngredientIds.push({ recipeId: incoming.id, name: ingredient.name });
          analysis.migratedIngredients += 1;
        }
      });
      const existing = currentById[incoming.id];
      if (!existing) { analysis.newRecipes.push(incoming); return; }
      if (recipeEquals(existing, incoming)) { analysis.identical.push(incoming); return; }
      analysis.conflicts.push({ existing: migrateRecipe(existing), incoming });
    });
    return analysis;
  }

  // Risolve i conflitti con la modalità scelta dall'utente:
  // 'mine' | 'theirs' | 'both' (quest'ultima salva entrambe con nuovo ID).
  function resolveRecipeConflicts(currentRecipes, incomingRecipes, conflictModes = {}) {
    const currentById = new Map((currentRecipes || []).map(recipe => [recipe.id, recipe]));
    const out = [];
    const usedIds = new Set(out.map(recipe => recipe.id));
    let counter = 0;
    const bumpId = () => {
      let nextId;
      do {
        counter += 1;
        nextId = `I${Date.now().toString(36)}${counter}`;
      } while (usedIds.has(nextId) || currentById.has(nextId));
      usedIds.add(nextId);
      return nextId;
    };
    const push = recipe => { usedIds.add(recipe.id); out.push(recipe); };
    (incomingRecipes || []).forEach(source => {
      const incoming = migrateRecipe(source);
      const mode = conflictModes[incoming.id] || 'theirs';
      const existing = currentById.get(incoming.id);
      if (existing && mode === 'mine') { push(existing); return; }
      if (existing && mode === 'both') {
        push(existing);
        push({ ...incoming, id: bumpId(), name: `${incoming.name} (ricevuta)` });
        return;
      }
      push(existing && mode === 'theirs' ? incoming : incoming);
    });
    return out.sort((a, b) => String(a.id).localeCompare(String(b.id), 'it', { numeric: true }));
  }

  // Slot del piano che diventerebbero vuoti rimuovendo le ricette indicate.
  function planSlotsForRecipeRemoval(plan, recipeIds) {
    const ids = new Set(recipeIds);
    const affected = [];
    DAYS.forEach(day => {
      SLOTS.forEach(slot => {
        const recipeId = plan?.days?.[day]?.[slot];
        if (ids.has(recipeId)) affected.push({ day, slot, recipeId });
      });
    });
    return affected;
  }

  function diffPlans(current, proposed) {
    const changes = [];
    DAYS.forEach(day => {
      const fromDay = current?.days?.[day];
      const toDay = proposed?.days?.[day];
      if (!toDay) return;
      if ((fromDay?.type || 'rest') !== (toDay.type || 'rest')) {
        changes.push({ day, field: 'type', from: fromDay?.type || 'rest', to: toDay.type || 'rest' });
      }
      SLOTS.forEach(slot => {
        const from = fromDay?.[slot];
        const to = toDay[slot];
        if (from !== to) changes.push({ day, slot, from, to });
      });
    });
    return changes;
  }

  // ----- Backup -----

  function buildBackup(catalog, plan, shopping, operation, description) {
    return {
      schemaVersion: VERSION,
      catalog: deepClone(catalog),
      plan: deepClone(plan),
      shoppingList: deepClone(shopping),
      operation,
      description,
      createdAt: new Date().toISOString()
    };
  }

  // ----- Generatore settimanale (funzioni pure, nessun DOM) -----

  function classifyProtein(recipe) {
    const category = String(recipe?.proteinCategory || '').toLowerCase();
    if (/pollame/i.test(category)) return 'poultry';
    if (/manzo|vitello/i.test(category)) return 'beef';
    if (/omega-3/i.test(category)) return 'omega';
    if (/pesce|salmone|sgombro|tonno|merluzzo|mollusch|crostace/i.test(category)) return 'otherFish';
    if (/latticini|formaggi/i.test(category)) return 'dairy';
    if (/uova/i.test(category)) return 'eggs';
    if (/legumi/i.test(category)) return 'legumes';
    return null;
  }

  function isFishRecipe(recipe) {
    const category = classifyProtein(recipe);
    return category === 'omega' || category === 'otherFish';
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function seededRandom(seed) {
    if (typeof seed === 'number' && Number.isFinite(seed)) return mulberry32(Math.floor(seed));
    return mulberry32(hashString(String(seed ?? Date.now())));
  }

  function shuffle(items, rand) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function countViolates(category, counts, constraints) {
    if (category === 'poultry') return counts.poultry >= constraints.poultryMax;
    if (category === 'beef') return counts.beef >= constraints.beefMax;
    if (category === 'omega') return counts.omega >= constraints.omegaMax;
    if (category === 'otherFish') return counts.otherFish >= constraints.otherFishMax;
    if (category === 'dairy') return counts.dairy >= constraints.dairyMax;
    if (category === 'eggs') return counts.eggs >= constraints.eggsMax;
    if (category === 'legumes') return counts.legumes >= constraints.legumesMax;
    return false;
  }

  // Genera una proposta di settimana rispettando A/R, frequenze proteiche e blocchi.
  // Non modifica mai i dosaggi. Il risultato è riproducibile con lo stesso seed.
  function generateWeek(catalog = [], options = {}) {
    const rand = seededRandom(options.seed ?? Date.now());
    const currentPlan = options.plan && options.plan.days ? options.plan : emptyPlan();
    const blocks = options.blocks || {};
    const constraints = { ...DEFAULT_CONSTRAINTS, ...(options.constraints || {}) };
    const warnings = [];
    const recipes = (catalog || []).map(migrateRecipe);

    if (!recipes.length) warnings.push('Catalogo vuoto: nessuna settimana generabile.');
    else if (recipes.length < 14) warnings.push(`Catalogo ridotto (${recipes.length} ricette): potrebbe non essere possibile rispettare tutte le frequenze.`);

    const bySlot = {};
    SLOTS.forEach(slot => { bySlot[slot] = recipes.filter(recipe => recipe.slot === slot); });

    const counts = { poultry: 0, beef: 0, omega: 0, otherFish: 0, dairy: 0, eggs: 0, legumes: 0 };
    const fishToday = {};
    const lastUsed = {};

    const templates = (options.templates && Array.isArray(options.templates) ? options.templates : currentPlan.batchTemplates || []).slice();
    const anchorTemplates = {};
    const targetTemplates = {};
    templates.forEach(template => {
      const anchorId = template?.anchor?.recipeId;
      const targetId = template?.target?.recipeId;
      if (anchorId) (anchorTemplates[anchorId] ||= []).push(template);
      if (targetId) (targetTemplates[targetId] ||= []).push(template);
    });

    const batchScore = (candidate, day, slot, chosen) => {
      if (slot === 'dinner' && anchorTemplates[candidate.id]) {
        for (const template of anchorTemplates[candidate.id]) {
          const look = template.target?.lookAheadDays || 3;
          for (let n = 1; n <= look; n++) {
            const futureDay = DAYS[(DAYS.indexOf(day) + n) % 7];
            if ((chosen[futureDay]?.lunch || currentPlan.days?.[futureDay]?.lunch) === template.target?.recipeId) return 1;
          }
        }
      }
      if (slot === 'lunch' && targetTemplates[candidate.id]) {
        for (const template of targetTemplates[candidate.id]) {
          const look = template.target?.lookAheadDays || 3;
          for (let n = 1; n <= look; n++) {
            const anchorDay = DAYS[(DAYS.indexOf(day) - n + 7) % 7];
            if ((chosen[anchorDay]?.dinner || currentPlan.days?.[anchorDay]?.dinner) === template.anchor?.recipeId) return 1;
          }
        }
      }
      return 0;
    };

    const isProteinSlot = slot => slot === 'lunch' || slot === 'dinner';

    const pickFor = (day, slot, candidates, chosen) => {
      const available = candidates.filter(candidate => {
        if (lastUsed[slot] === candidate.id) return false;
        const category = classifyProtein(candidate);
        if (isProteinSlot(slot)) {
          if (countViolates(category, counts, constraints)) return false;
          if ((category === 'omega' || category === 'otherFish') && (fishToday[day] || 0) >= 1) return false;
        }
        return true;
      });
      if (!available.length) {
        const fallback = candidates.filter(candidate => {
          if (!isProteinSlot(slot)) return true;
          const category = classifyProtein(candidate);
          return !((category === 'omega' || category === 'otherFish') && (fishToday[day] || 0) >= 1);
        });
        if (fallback.length) {
          warnings.push(`Vincoli rilassati per ${DAY_LABELS[day]} ${SLOT_LABELS[slot]}: alcune frequenze potrebbero non essere rispettate.`);
          return shuffle(fallback, rand)[0];
        }
        return null;
      }
      const shuffled = shuffle(available, rand);
      const scored = shuffled
        .map(candidate => ({ candidate, score: batchScore(candidate, day, slot, chosen) }))
        .sort((a, b) => b.score - a.score);
      return scored[0].candidate;
    };

    const isBlocked = (day, slot) => {
      const block = blocks[day];
      if (!block) return false;
      if (block === 'all' || block.all) return true;
      return Boolean(block[slot]);
    };

    const chosen = {};
    DAYS.forEach(day => {
      chosen[day] = {};
      SLOTS.forEach(slot => {
        if (isBlocked(day, slot)) {
          chosen[day][slot] = blocks[day] === 'all' || blocks[day]?.all
            ? (currentPlan.days?.[day]?.[slot] ?? null)
            : (blocks[day][slot] ?? currentPlan.days?.[day]?.[slot] ?? null);
        }
      });
    });

    DAYS.forEach(day => {
      ['lunch', 'dinner'].forEach(slot => {
        if (chosen[day][slot] !== undefined) return;
        const pick = pickFor(day, slot, bySlot[slot] || [], chosen);
        chosen[day][slot] = pick?.id ?? null;
        if (pick) {
          const category = classifyProtein(pick);
          if (category && counts[category] !== undefined) counts[category] += 1;
          if (category === 'omega' || category === 'otherFish') fishToday[day] = (fishToday[day] || 0) + 1;
          lastUsed[slot] = pick.id;
        }
      });
      ['breakfast', 'snack1', 'snack2'].forEach(slot => {
        if (chosen[day][slot] !== undefined) return;
        const pick = pickFor(day, slot, bySlot[slot] || [], chosen);
        chosen[day][slot] = pick?.id ?? null;
        if (pick) lastUsed[slot] = pick.id;
      });
    });

    const nextDays = {};
    DAYS.forEach(day => {
      nextDays[day] = {
        type: currentPlan.days?.[day]?.type || (['monday', 'wednesday', 'friday', 'sunday'].includes(day) ? 'training' : 'rest'),
        breakfast: chosen[day].breakfast ?? null,
        snack1: chosen[day].snack1 ?? null,
        lunch: chosen[day].lunch ?? null,
        snack2: chosen[day].snack2 ?? null,
        dinner: chosen[day].dinner ?? null
      };
    });

    const nextPlan = {
      ...deepClone(currentPlan),
      schemaVersion: VERSION,
      days: nextDays,
      batchRules: deepClone(currentPlan.batchRules || {}),
      batchTemplates: templates
    };

    // Avvisi sulle frequenze dopo la generazione.
    if (counts.legumes < constraints.legumesMin) warnings.push(`Legumi: ${counts.legumes} pasti (obiettivo ${constraints.legumesMin}-${constraints.legumesMax}).`);
    if (counts.omega < constraints.omegaMin) warnings.push(`Pesce omega-3: ${counts.omega} pasti (obiettivo ${constraints.omegaMin}-${constraints.omegaMax}).`);
    if (counts.omega > constraints.omegaMax) warnings.push(`Pesce omega-3: ${counts.omega} pasti (massimo ${constraints.omegaMax}).`);
    if (counts.poultry > constraints.poultryMax) warnings.push(`Pollame: ${counts.poultry} pasti (massimo ${constraints.poultryMax}).`);
    if (counts.beef > constraints.beefMax) warnings.push(`Manzo/Vitello: ${counts.beef} pasti (massimo ${constraints.beefMax}).`);
    if (counts.dairy < constraints.dairyMin || counts.dairy > constraints.dairyMax) warnings.push(`Latticini/Formaggi: ${counts.dairy} pasti (obiettivo ${constraints.dairyMin}-${constraints.dairyMax}).`);
    if (counts.eggs < constraints.eggsMin || counts.eggs > constraints.eggsMax) warnings.push(`Uova: ${counts.eggs} pasti (obiettivo ${constraints.eggsMin}-${constraints.eggsMax}).`);
    if (counts.otherFish < constraints.otherFishMin || counts.otherFish > constraints.otherFishMax) warnings.push(`Altro pesce/molluschi: ${counts.otherFish} pasti (obiettivo ${constraints.otherFishMin}-${constraints.otherFishMax}).`);
    const doubleFishDays = DAYS.filter(day => (fishToday[day] || 0) > 1);
    if (doubleFishDays.length) warnings.push(`Due pasti di pesce nello stesso giorno: ${doubleFishDays.map(day => DAY_LABELS[day]).join(', ')}.`);

    return { plan: nextPlan, counts, warnings, seed: options.seed ?? null };
  }

  return {
    VERSION,
    DAYS,
    SLOTS,
    DAY_LABELS,
    DAY_SHORT,
    SLOT_LABELS,
    SLOT_SHORT,
    EMPTY_PORTION,
    INGREDIENT_ALIASES,
    CANONICAL_INGREDIENTS,
    DEFAULT_CONSTRAINTS,
    deepClone,
    aliasKey,
    slug,
    ingredientIdFor,
    normalizePortions,
    migrateRecipe,
    migrateCatalog,
    migrateBatchRules,
    migratePlan,
    emptyDay,
    emptyDays,
    emptyPlan,
    dayDistance,
    futureTarget,
    batchTaskStatus,
    portionFor,
    formatPortion,
    quantityForTask,
    activeBatch,
    categoryForIngredient,
    isEmptyPortion,
    parseSimpleAmount,
    aggregateShopping,
    swapMeals,
    copyMeal,
    restoreMeal,
    mergeRecipeCatalogs,
    sanitizePlanForCatalog,
    importedPlanIsUsable,
    recipeEquals,
    analyzeShare,
    resolveRecipeConflicts,
    planSlotsForRecipeRemoval,
    diffPlans,
    buildBackup,
    classifyProtein,
    isFishRecipe,
    mulberry32,
    hashString,
    generateWeek
  };
});
