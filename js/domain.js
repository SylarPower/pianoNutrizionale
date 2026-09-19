/* Piano Nutrizionale — dominio puro (schema 7).
 *
 * Questo file contiene SOLO funzioni pure: nessun DOM, nessuna chiamata
 * Firebase, nessuna ricetta personale. I dati personali arrivano da Firestore
 * e vengono trasformati da questi servizi in modo idempotente.
 *
 * Il catalogo globale ingredienti (identità, alias, famiglie, categorie e
 * classificazione vegetarian/vegan) è un dato esterno versionato: qui vivono
 * solo i servizi che lo consumano (indice, autocomplete, riconoscimento) e il
 * motore di lettura della dieta assegnata. NESSUNA quantità clinica è definita
 * in questo file: grammature, equivalenze e proporzioni vivono esclusivamente
 * nelle strutture dieta e nei template equivalenze del singolo professionista.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PianoDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, () => {
  'use strict';

  // Schema 7: catalogo globale v2 (famiglie + dietaryFlags), strutture dieta
  // a blocchi con equivalenze, riconoscimento ingredienti a stati espliciti.
  const VERSION = 7;
  const SINGLE_ORGANIZATION_ID = 'pianoNutrizionale';
  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const SLOTS = ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'];
  const EMPTY_PORTION = '—';
  const PROFILE_SINGLE = 'single';
  const PROFILE_COUPLE = 'couple';

  // Corrispondenza tra gli slot del piano settimanale (breakfast/snack1/lunch/
  // snack2/dinner) e i pasti delle strutture dieta. «evening-snack» esiste solo
  // nelle strutture: il piano non ha uno slot corrispondente.
  const MEAL_ID_BY_SLOT = {
    breakfast: 'breakfast',
    snack1: 'morning-snack',
    lunch: 'lunch',
    snack2: 'afternoon-snack',
    dinner: 'dinner'
  };
  const SLOT_BY_MEAL_ID = {
    breakfast: 'breakfast',
    'morning-snack': 'snack1',
    lunch: 'lunch',
    'afternoon-snack': 'snack2',
    dinner: 'dinner',
    'evening-snack': null
  };

  const DAY_LABELS = {
    monday: 'Lunedì', tuesday: 'Martedì', wednesday: 'Mercoledì', thursday: 'Giovedì',
    friday: 'Venerdì', saturday: 'Sabato', sunday: 'Domenica'
  };
  const DAY_SHORT = { monday: 'Lun', tuesday: 'Mar', wednesday: 'Mer', thursday: 'Gio', friday: 'Ven', saturday: 'Sab', sunday: 'Dom' };
  const SLOT_LABELS = { breakfast: 'Colazione', snack1: 'Spuntino mattina', lunch: 'Pranzo', snack2: 'Merenda', dinner: 'Cena' };
  const SLOT_SHORT = { breakfast: 'COLAZ.', snack1: 'SPUNT.', lunch: 'PRANZO', snack2: 'MERENDA', dinner: 'CENA' };




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

  // ingredientId stabile: preferisce l'ID già presente, poi lo slug del nome.
  // La risoluzione verso il catalogo globale passa da recognizeIngredient:
  // qui non esistono tabelle di alias locali.
  function ingredientIdFor(name, existing) {
    if (existing && typeof existing === 'string' && existing.trim()) return existing.trim();
    return slug(name) || 'ingredient';
  }

  // Porzioni v2 (schema 6): una sola quantità originale per ingrediente.
  // Il formato supportato è esclusivamente `portions.single`; Allenamento/
  // Riposo resta una derivazione delle linee guida del piano.
  function normalizePortions(p = {}) {
    return {
      single: p?.single ?? EMPTY_PORTION
    };
  }

  function normalizePortionProfileKey(profile) {
    return profile === PROFILE_COUPLE ? PROFILE_COUPLE : PROFILE_SINGLE;
  }

  function portionMultiplierForProfile(profile, rawMultiplier) {
    if (normalizePortionProfileKey(profile) !== PROFILE_COUPLE) return 1;
    const value = Number(rawMultiplier);
    if (!Number.isFinite(value) || value <= 0) return 2;
    return value;
  }

  // Schema 6: il campo storico `specialNote` (stringa singola, "Nota
  // speciale") viene unificato in `notes` (array, una nota per riga). La nota
  // speciale diventa la prima riga, senza prefisso: il rendering resta unico
  // e non esistono più due blocchi concorrenti nella scheda ricetta.
  // Idempotente: dopo la prima passata `specialNote` non c'è più, quindi le
  // chiamate successive restituiscono lo stesso array; la deduplica protegge
  // anche dal caso in cui la stessa frase fosse già presente in `notes`.
  function mergeRecipeNotes(specialNote, notes) {
    const list = (Array.isArray(notes) ? notes : [])
      .map(note => String(note ?? '').trim())
      .filter(Boolean);
    const special = String(specialNote ?? '').trim();
    if (!special) return list;
    return list.includes(special) ? list : [special, ...list];
  }

  // Migrazione idempotente di una singola ricetta allo schema corrente (6).
  // Schema 4 → 5: rimuove il campo legacy `frequency` (sostituito dalle
  // frequenze proteiche calcolate dal generatore sui pasti principali).
  // Schema 5 → 6: porzioni ridotte a una quantità originale unica per
  // ingrediente (vedi normalizePortions).
  // Note unificate: `specialNote` confluisce in `notes` (vedi mergeRecipeNotes).
  function migrateRecipe(recipe) {
    if (!recipe || typeof recipe !== 'object') return recipe;
    const ingredients = (recipe.ingredients || []).map(ingredient => ({
      ...ingredient,
      ingredientId: ingredientIdFor(ingredient.name, ingredient.ingredientId),
      portions: normalizePortions(ingredient.portions)
    }));
    const { frequency, specialNote, notes, ...rest } = recipe;
    return { ...rest, ingredients, notes: mergeRecipeNotes(specialNote, notes) };
  }

  // Migrazione idempotente del documento catalogo ricette.
  function migrateCatalog(doc = {}) {
    const recipes = (doc.recipes || []).map(migrateRecipe);
    return {
      ...doc,
      schemaVersion: VERSION,
      recipes,
      recipeCount: recipes.length
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
      batchTemplates: templates,
      // Scelta unica del cliente: dosi originali delle ricette oppure dosi
      // allineate alla dieta assegnata dal nutrizionista. È una preferenza di
      // visualizzazione (Settimana, Ricettario, Spesa): le ricette originali
      // non vengono mai riscritte. Il flag non esiste più come mappa per pasto.
      alignedDosesEnabled: plan.alignedDosesEnabled !== false
    };
  }

  // Vero di default: il flag è false solo se il piano lo dichiara apertamente.
  function planAlignedDosesEnabled(plan) {
    return (plan && typeof plan === 'object') ? plan.alignedDosesEnabled !== false : true;
  }

  // Imposta la preferenza «dosi allineate» del piano (scelta unica globale).
  function setPlanAlignedDosesEnabled(plan, enabled) {
    const next = { ...(plan || {}) };
    next.alignedDosesEnabled = Boolean(enabled);
    return next;
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
    return {
      schemaVersion: VERSION,
      days: emptyDays(),
      defaultDays: emptyDays(),
      batchRules: {},
      batchTemplates: [],
      alignedDosesEnabled: true
    };
  }

  // ----- Batch cooking dinamico -----

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

  // Quantità originale dell'ingrediente: un solo valore per ricetta, uguale in
  // ogni contesto. Le dosi allineate alla dieta assegnata sono una vista
  // calcolata dal motore della struttura (alignRecipeToDiet), mai una porzione
  // persistita: la ricetta originale resta sempre intatta.
  function portionFor(ingredient) {
    return normalizePortions(ingredient?.portions || {}).single;
  }

  function formatPortion(portion) {
    const value = portion ?? EMPTY_PORTION;
    return value === '' ? EMPTY_PORTION : value;
  }

  // Quantità di una preparazione batch. La vista «dosi allineate» è decisa
  // dall'app (motore della dieta assegnata): qui arriva già risolta tramite
  // options.resolveRecipe(recipe, slot, dayType) → ricetta effettiva, così il
  // dominio resta puro e non conosce SaaS né strutture.
  function quantityForTask(task, plan, recipesById, profile, targetDay, targetSlot = 'lunch', options = {}) {
    const src = task?.quantitySource;
    if (!src?.ingredientId) return '';
    const recipe = recipesById?.[src.recipeId];
    if (!recipe) return '';
    const dayType = plan?.days?.[targetDay]?.type || 'rest';
    const effectiveRecipe = typeof options.resolveRecipe === 'function'
      ? (options.resolveRecipe(recipe, targetSlot, dayType) || recipe)
      : recipe;
    const ingredient = (effectiveRecipe?.ingredients || []).find(item =>
      (item.ingredientId || ingredientIdFor(item.name)) === src.ingredientId
    );
    if (!ingredient) return '';
    const amount = portionFor(ingredient);
    const multiplier = portionMultiplierForProfile(profile, options.quantityMultiplier);
    const scaled = multiplier !== 1 ? scalePortionText(String(amount ?? ''), multiplier) : amount;
    return formatPortion(scaled);
  }

  // Batch attivi per il giorno: almeno una preparazione deve essere valida
  // (fresca o preparabile oggi). Il tipo A/R del giorno corrente non conta:
  // conta solo il tipo A/R del giorno target per le quantità.
  function activeBatch(anchorDay, plan, templates, recipesById = {}, profile = PROFILE_SINGLE, options = {}) {
    if (!plan?.days?.[anchorDay]) return [];
    const dinner = plan.days[anchorDay].dinner;
    const result = [];
    (templates || []).forEach(template => {
      if (!template?.anchor || template.anchor.recipeId !== dinner) return;
      const target = futureTarget(
        anchorDay, plan,
        template.target?.slot || 'lunch',
        template.target?.recipeId,
        template.target?.lookAheadDays || options.maxLookAhead || 7
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
          quantity: quantityForTask(
            task,
            plan,
            recipesById,
            profile,
            target.day,
            template.target?.slot || 'lunch',
            options
          )
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

  // Somma due stringhe-dose (es. "200g" + "200g" = "400g"). Per valori non
  // numerici (q.b., dosi opache) mostra entrambi separati da "+".
  function sumPortionStrings(a, b) {
    const pa = parseSimpleAmount(a);
    const pb = parseSimpleAmount(b);
    if (pa.skip && pb.skip) return EMPTY_PORTION;
    if (pa.free || pb.free) return 'q.b.';
    const fmt = (value, unit) => formatAmount(value, unit);
    if (!pa.skip && !pb.skip && pa.value !== undefined && pb.value !== undefined) {
      if (pa.unit === pb.unit) return fmt(pa.value + pb.value, pa.unit);
      return `${fmt(pa.value, pa.unit)} + ${fmt(pb.value, pb.unit)}`;
    }
    if (pa.skip) return String(b ?? EMPTY_PORTION);
    if (pb.skip) return String(a ?? EMPTY_PORTION);
    const left = pa.opaque ?? (pa.value !== undefined ? fmt(pa.value, pa.unit) : EMPTY_PORTION);
    const right = pb.opaque ?? (pb.value !== undefined ? fmt(pb.value, pb.unit) : EMPTY_PORTION);
    return `${left} + ${right}`;
  }

  // Combina le dosi di cena e pranzo per un ingrediente mantenendo il formato
  // testuale originale quando non è possibile sommare numericamente.
  function combineTaskQuantities(cenaPortion, pranzoPortion) {
    return sumPortionStrings(cenaPortion, pranzoPortion);
  }

  // Batch automatico "doppia porzione": quando la stessa ricetta è a cena oggi e
  // a pranzo in un giorno successivo (ora possibile anche col cross-slot), le
  // dosi da preparare sono la somma della porzione di cena + quella del pranzo
  // (carboidrati trasformati in percentuale). Attivo solo se il pranzo è al massimo a 1
  // giorno (conservazione in frigo); oltre non è sicuro e non viene suggerito.
  function commonRecipeBatch(anchorDay, plan, recipesById = {}, profile = PROFILE_SINGLE, options = {}) {
    const dinnerId = plan?.days?.[anchorDay]?.dinner;
    if (!dinnerId) return null;
    const recipe = recipesById?.[dinnerId];
    if (!recipe) return null;
    const target = futureTarget(anchorDay, plan, 'lunch', dinnerId, options.maxLookAhead || 3);
    if (!target) return null;
    const dinnerDayType = plan?.days?.[anchorDay]?.type || 'rest';
    const lunchDayType = plan?.days?.[target.day]?.type || 'rest';
    const storageMaxDays = 1;
    // Vista «dosi allineate» iniettata dall'app (motore della dieta assegnata):
    // la stessa ricetta viene risolta nel contesto cena e nel contesto pranzo.
    const resolve = typeof options.resolveRecipe === 'function' ? options.resolveRecipe : null;
    const dinnerRecipe = resolve ? (resolve(recipe, 'dinner', dinnerDayType) || recipe) : recipe;
    const lunchRecipe = resolve ? (resolve(recipe, 'lunch', lunchDayType) || recipe) : recipe;
    const ingredientById = (source, id) => (source?.ingredients || []).find(item =>
      (item.ingredientId || ingredientIdFor(item.name)) === id
    );
    const tasks = (recipe.ingredients || []).map(ingredient => {
      const baseId = ingredient.ingredientId || ingredientIdFor(ingredient.name);
      const dinnerEffective = ingredientById(dinnerRecipe, baseId) || ingredient;
      const lunchEffective = ingredientById(lunchRecipe, baseId) || ingredient;
      const cenaName = dinnerEffective.name || ingredient.name;
      const pranzoName = lunchEffective.name || ingredient.name;
      const cenaId = dinnerEffective.ingredientId || baseId;
      const pranzoId = lunchEffective.ingredientId || baseId;
      const cenaPortion = portionFor(dinnerEffective);
      const pranzoPortion = portionFor(lunchEffective);
      // L'ingrediente resta lo stesso nei due contesti (es. pasta a cena e a
      // pranzo): le dosi dei due pasti si sommano senza creare voci parallele.
      // Se la dieta assegnata sostituisce l'ingrediente in uno dei due pasti,
      // le due dosi viaggiano affiancate.
      const sameIngredient = cenaId === pranzoId;
      const multiplier = portionMultiplierForProfile(profile, options.quantityMultiplier);
      let quantityStr;
      if (sameIngredient) {
        const combined = combineTaskQuantities(cenaPortion, pranzoPortion);
        quantityStr = formatPortion(multiplier !== 1 ? scalePortionText(String(combined ?? ''), multiplier) : combined);
      } else {
        const left = multiplier !== 1 ? scalePortionText(String(cenaPortion ?? ''), multiplier) : cenaPortion;
        const right = multiplier !== 1 ? scalePortionText(String(pranzoPortion ?? ''), multiplier) : pranzoPortion;
        quantityStr = `${formatPortion(left)} + ${formatPortion(right)}`;
      }
      return {
        id: `common-${baseId}`,
        actionType: 'cook',
        label: sameIngredient ? cenaName : `${cenaName} + ${pranzoName}`,
        storage: { method: 'fridge', maxDays: storageMaxDays, instructions: 'Conserva in frigo la porzione per il pranzo.' },
        status: batchTaskStatus({ storage: { maxDays: storageMaxDays } }, target.days),
        quantity: quantityStr
      };
    }).filter(task => {
      const value = String(task.quantity ?? '').trim();
      return value && value !== EMPTY_PORTION;
    });
    const validCount = tasks.filter(task => task.status === 'today' || task.status === 'fresh').length;
    if (!validCount) return null;
    return {
      template: {
        id: `common-recipe-${dinnerId}`,
        title: `Doppia porzione · ${recipe.name}`,
        anchor: { slot: 'dinner', recipeId: dinnerId },
        target: { slot: 'lunch', recipeId: dinnerId }
      },
      targetDay: target.day,
      daysUntilTarget: target.days,
      tasks,
      validCount,
      active: true,
      commonRecipe: true
    };
  }

  // ----- Lista della spesa -----

  const CATEGORY_RULES = [
    { category: '🥩 Carne', terms: ['pollo', 'tacchino', 'vitello', 'manzo'] },
    { category: '🐟 Pesce', terms: ['salmone', 'sgombro', 'merluzzo', 'tonno', 'gamber', 'calamar', 'polpo'] },
    { category: '🥚 Uova e latticini', terms: ['uov', 'album', 'ricotta', 'mozzarella', 'caprino', 'feta', 'parmigiano', 'fiocchi di latte', 'yogurt', 'skyr', 'kefir', 'latte'] },
    // Prima di Legumi e Carboidrati: "farina…" (es. farina d'avena, farina di
    // ceci) e la passata di pomodoro sono prodotti di dispensa, non legumi,
    // carboidrati o verdura.
    { category: '🥫 Dispensa', terms: ['passata di pomodoro', 'passata', 'farina'] },
    { category: '🫘 Legumi', terms: ['ceci', 'lenticch', 'fagiol', 'edamame', 'piselli'] },
    { category: '🍚 Carboidrati', terms: ['pasta', 'riso', 'orzo', 'farro', 'quinoa', 'cous cous', 'pane', 'patate', 'polenta', 'cracker', 'trofie', 'avena', 'cereali', 'fette biscottate', 'wasa', 'granola'] },
    { category: '🍑 Frutta', terms: ['mela', 'banana', 'pera', 'arancia', 'mandarin', 'clementin', 'kiwi', 'uva', 'fragol', 'pesca', 'mango', 'anguria', 'melone', 'avocado', 'lampon', 'limone', 'lime', 'albicocc', 'cilieg', 'mirtill', 'ananas', 'papaya', 'pompelmo', 'prugn', 'susin', 'fico', 'cachi', 'ribes', 'mora', 'more', 'frutta fresca', 'frutti di bosco', 'macedonia'] },
    { category: '🥬 Verdura', terms: ['zucchin', 'pomodor', 'friggitell', 'peperon', 'melanzan', 'rucola', 'cetriolo', 'carota', 'fagiolini', 'spinacin', 'lattuga', 'songino', 'sedano', 'verdura', 'cipolla'] },
    { category: '🥫 Dispensa', terms: ['olio', 'olive', 'mandorle', 'noci', 'pistacchi', 'semi', 'pesto', 'capperi', 'brodo', 'salsa di soia', 'aceto', 'cacao', 'cioccolato', 'marmellata', 'confettura', 'miele', 'sciroppo', 'dolcificante', 'cocco', 'proteine whey'] }
  ];
  const FALLBACK_CATEGORY = '🌿 Spezie e aromi';

  function uniqueStrings(values = []) {
    const seen = new Set();
    return (Array.isArray(values) ? values : []).filter(value => {
      const clean = typeof value === 'string' ? value.trim() : '';
      if (!clean || seen.has(clean)) return false;
      seen.add(clean);
      return true;
    });
  }

  // Ordine configurabile delle categorie spesa: usa l'ordine salvato per le
  // categorie note, completa le eventuali mancanti col default e mette in coda
  // le categorie extra trovate nei dati (per robustezza futura).
  function resolveShopCategoryOrder(savedOrder = [], defaultOrder = [], extraCategories = []) {
    const defaults = uniqueStrings(defaultOrder);
    const defaultSet = new Set(defaults);
    const saved = uniqueStrings(savedOrder).filter(category => defaultSet.has(category));
    const resolved = saved.concat(defaults.filter(category => !saved.includes(category)));
    return resolved.concat(uniqueStrings(extraCategories).filter(category => !resolved.includes(category)));
  }

  // Ordine configurabile degli alimenti DENTRO una categoria della spesa:
  // usa l'ordine salvato (array di ingredientId) per gli id ancora presenti e
  // accoda in coda tutti gli id correnti non salvati, così un ingrediente
  // nuovo compare in coda senza rompere l'ordine esistente e nessun alimento
  // sparisce mai dalla lista. Gli id salvati non più presenti vengono ignorati.
  // Idempotente: risolvere di nuovo il risultato non cambia l'ordine.
  function resolveShopItemOrder(savedOrder = [], currentIds = []) {
    const current = uniqueStrings(currentIds);
    const currentSet = new Set(current);
    const saved = uniqueStrings(savedOrder).filter(id => currentSet.has(id));
    const savedSet = new Set(saved);
    return saved.concat(current.filter(id => !savedSet.has(id)));
  }

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
    const match = original.match(/^(\d+(?:[.,]\d+)?|[½¼¾])(?:\s*[-–—]\s*(\d+(?:[.,]\d+)?|[½¼¾]))?\s*(g|ml|pz|cucchiaio|cucchiai|cucchiaino|cucchiaini)?$/i);
    if (!match) return { opaque: original };
    const numberValue = token => fractionMap[token] ?? Number(token.replace(',', '.'));
    // Per la spesa un intervallo usa prudenzialmente il valore massimo.
    const value = match[2] ? Math.max(numberValue(match[1]), numberValue(match[2])) : numberValue(match[1]);
    const unitRaw = (match[3] || 'pz').toLowerCase();
    // Le misure da cucina restano misure da cucina: i cucchiai non vengono
    // più reinterpretati come grammi (la vecchia conversione inventava dosi
    // nelle somme). Canonicalizzazione al singolare.
    let unit = unitRaw;
    if (unit === 'cucchiai') unit = 'cucchiaio';
    else if (unit === 'cucchiaini') unit = 'cucchiaino';
    return { value, unit };
  }

  // Parser stretto delle quantità, usato dall'allineamento delle dosi e
  // dall'editor ricette. A differenza di parseSimpleAmount (pensato per la
  // spesa, con intervalli→max e numeri nudi→pz), qui ogni forma non
  // rappresentabile resta esplicita e non viene mai reinterpretata:
  // - { kind: 'empty' } — stringa vuota, "—", "-", zeri ("0", "0 g", "0 ml").
  // - { kind: 'free' } — "q.b." e varianti ("qb", "libera", "a piacere").
  // - { kind: 'amount', value, unit } — numero (intero, decimale con punto o
  //   virgola, frazioni ½/¼/¾) + unità riconosciuta ('g', 'ml', 'pz',
  //   'cucchiaio', 'cucchiaino') oppure unit: null quando l'unità manca ("2").
  // - { kind: 'opaque', text } — tutto il resto: intervalli ("8-10 g",
  //   "1-2 cucchiai"), misure non censite ("1 mazzetto"), note ("a fette").
  function parseQuantity(raw) {
    const original = String(raw ?? '').trim();
    if (isEmptyPortion(original) || /^0(?:[.,]0+)?\s*(g|ml)?$/i.test(original)) return { kind: 'empty' };
    if (/^(q\.?b\.?|liber[oaie]|a piacere)$/i.test(original)) return { kind: 'free', text: original };
    const fractionMap = { '½': 0.5, '¼': 0.25, '¾': 0.75 };
    const match = original.match(/^(\d+(?:[.,]\d+)?|[½¼¾])\s*(g|ml|pz|cucchiaio|cucchiai|cucchiaino|cucchiaini)?$/i);
    if (!match) return { kind: 'opaque', text: original };
    const value = fractionMap[match[1]] ?? Number(match[1].replace(',', '.'));
    if (!Number.isFinite(value)) return { kind: 'opaque', text: original };
    let unit = match[2] ? match[2].toLowerCase() : null;
    if (unit === 'cucchiai') unit = 'cucchiaio';
    else if (unit === 'cucchiaini') unit = 'cucchiaino';
    return { kind: 'amount', value, unit };
  }

  // Formatta una quantità numerica con unità: grammi e millilitri restano
  // compatti ("120g") come nelle somme storiche, le altre unità prendono
  // spazio e plurale italiano ("2 pz", "2 cucchiai", "1 cucchiaino").
  function formatAmount(value, unit) {
    const rounded = Math.round(Number(value) * 100) / 100;
    const num = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', ',');
    if (unit === 'pz') return `${num} pz`;
    if (unit === 'cucchiaio') return `${num} ${rounded === 1 ? 'cucchiaio' : 'cucchiai'}`;
    if (unit === 'cucchiaino') return `${num} ${rounded === 1 ? 'cucchiaino' : 'cucchiaini'}`;
    return `${num}${unit || ''}`;
  }

  // Aggrega la lista della spesa per ingredientId. Le dosi "—" vengono saltate.
  // La vista «dosi allineate» è decisa dall'app tramite options.resolveRecipe
  // (recipe, slot, dayType) → ricetta effettiva: senza risolutore si aggregano
  // le quantità originali delle ricette.
  function aggregateShopping(plan, recipesById, selectedMeals, profile = PROFILE_SINGLE, canonicalLabels = {}, options = {}) {
    const out = {};
    // Moltiplicatore porzioni (app clienti, profilo coppia): scala le dosi
    // prima dell'aggregazione. Senza valore esplicito usa ×2, coerente con il
    // profilo "2 persone" dell'app clienti.
    const multiplierValue = portionMultiplierForProfile(profile, options.quantityMultiplier);
    const multiplier = normalizePortionProfileKey(profile) === PROFILE_COUPLE && multiplierValue !== 1 ? multiplierValue : null;
    const resolve = typeof options.resolveRecipe === 'function' ? options.resolveRecipe : null;
    DAYS.forEach(day => {
      const dayType = plan?.days?.[day]?.type || 'rest';
      (selectedMeals?.[day] || []).forEach(slot => {
        const recipe = recipesById?.[plan?.days?.[day]?.[slot]];
        if (!recipe) return;
        const effectiveRecipe = resolve ? (resolve(recipe, slot, dayType) || recipe) : recipe;
        (effectiveRecipe.ingredients || []).forEach(ingredient => {
          const effective = ingredient;
          const amount = portionFor(effective);
          const scaledAmount = multiplier && typeof amount === 'string' ? scalePortionText(amount, multiplier) : amount;
          const id = ingredientIdFor(effective.name, effective.ingredientId);
          const entry = out[id] || (out[id] = {
            ingredientId: id,
            name: canonicalLabels[id] || effective.name,
            category: categoryForIngredient(effective.name),
            totals: {},
            opaque: {},
            free: false,
            tags: []
          });
          const tag = `${DAY_SHORT[day]} · ${SLOT_SHORT[slot]}`;
          if (!entry.tags.includes(tag)) entry.tags.push(tag);
          const parsed = parseSimpleAmount(scaledAmount);
          if (parsed.skip) return;
          if (parsed.free) {
            entry.free = true;
            return;
          }
          if (parsed.opaque) {
            entry.opaque[parsed.opaque] = (entry.opaque[parsed.opaque] || 0) + 1;
            return;
          }
          entry.totals[parsed.unit] = (entry.totals[parsed.unit] || 0) + parsed.value;
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
    next.alignedDosesEnabled = planAlignedDosesEnabled(next);
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

  // Accettazione di una condivisione professionale (ADR 0006): il catalogo
  // corrente è PRESERVATO e ogni ricetta ricevuta sostituisce quella con lo
  // STESSO id, marcata con fromProfessional (provenienza + sola lettura).
  // Pura e deterministica: receivedAt arriva dal chiamante.
  function applyProfessionalRecipes(currentRecipes, incomingRecipes, provenance = {}) {
    const result = deepClone(currentRecipes || []);
    const indexById = new Map(result.map((recipe, index) => [recipe.id, index]));
    const { senderUid = null, senderUsername = null, organizationId = null, receivedAt = null } = provenance || {};
    (incomingRecipes || []).forEach(source => {
      const recipe = migrateRecipe(source);
      if (!recipe || !recipe.id) return;
      const flagged = {
        ...recipe,
        fromProfessional: { senderUid, senderUsername, organizationId, receivedAt }
      };
      if (indexById.has(recipe.id)) result[indexById.get(recipe.id)] = flagged;
      else { indexById.set(recipe.id, result.length); result.push(flagged); }
    });
    return result.sort((a, b) => String(a.id).localeCompare(String(b.id), 'it', { numeric: true }));
  }

  function isProfessionalRecipe(recipe) {
    return Boolean(recipe && recipe.fromProfessional);
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

  // Categorie proteiche riconosciute dal generatore. Non esistono più range
  // di frequenza minimi/massimi globali (erano dati clinici del vecchio
  // manuale): il generatore lavora sui soli vincoli strutturali (ripetizioni,
  // pesce giornaliero, distanza omega-3, accoppiate batch, blocchi).
  const PROTEIN_CATEGORIES = ['legumes', 'omega', 'otherFish', 'poultry', 'beef', 'curedMeats', 'dairy', 'eggs'];
const PROTEIN_CATEGORY_LABELS = {
  legumes: 'Legumi e derivati',
  omega: 'Pesce ricco di omega-3',
  otherFish: 'Altro pesce e prodotti ittici',
  poultry: 'Pollame',
  beef: 'Manzo e maiale',
  curedMeats: 'Affettati e carni miste',
  dairy: 'Latticini e formaggi',
  eggs: 'Uova'
};

  // Le frequenze del generatore si basano prima sugli alimenti effettivi
  // della ricetta, nell'ordine in cui compaiono. `proteinCategory` resta un
  // fallback per ricette legacy o senza ingredienti riconoscibili.
  const PROTEIN_INGREDIENT_HINTS = [
    { category: 'omega', match: /salmone|sgombro|sardine?|aringa|alice|acciug/ },
    { category: 'otherFish', match: /merluzzo|nasello|sogliola|orata|branzino|spigola|tonno|calamar|polpo|seppi|spada|trota|platessa|cozze|vongole|gamber|crostace|mollusch|pesce|stoccafisso|baccala/ },
    { category: 'poultry', match: /pollo|tacchin|faraona/ },
    { category: 'curedMeats', match: /affettat|prosciutto|bresaola|speck|salame|mortadella|wurstel|salsic|carne mista|carni miste|macinato misto/ },
    { category: 'beef', match: /manzo|vitello|maiale|suino|pork|lonza|scamone|girello|roastbeef/ },
    { category: 'legumes', match: /ceci|lenticch|fagiol|edamame|pisell|tofu|tempeh|legumott|soia|lupin|seitan|burger vegetale|veggie burger/ },
    { category: 'dairy', match: /ricotta|mozzarella|caprino|crescenza|robiola|feta|montasio|parmigiano|grana|fiocchi di latte|yogurt|skyr|formagg|stracchino|scamorza|emmenthal|provolone|pecorino|asiago/ },
    { category: 'eggs', match: /\buov|albume|tuorlo/ }
  ];

  function inferProteinCategoryFromIngredients(recipe) {
    const ingredients = recipe?.ingredients || [];
    for (const ingredient of ingredients) {
      const name = aliasKey(ingredient?.name);
      if (!name) continue;
      const hit = PROTEIN_INGREDIENT_HINTS.find(hint => hint.match.test(name));
      if (hit) return hit.category;
    }
    return null;
  }

  function classifyProtein(recipe) {
    const inferred = inferProteinCategoryFromIngredients(recipe);
    if (inferred) return inferred;
    const raw = recipe?.proteinCategory;
    if (!raw) return null;
    const category = String(raw).trim();
    // Chiave tecnica diretta (poultry, beef, curedMeats, omega, ecc.): usata
    // così com'è quando appartiene all'insieme delle categorie riconosciute.
    if (PROTEIN_CATEGORIES.includes(category)) return category;
    const normalized = category.toLowerCase();
    if (/pollame/i.test(normalized)) return 'poultry';
    if (/affettati|affettato|prosciutto|bresaola|speck|salame|mortadella|wurstel|salsic|carni miste|carne mista/i.test(normalized)) return 'curedMeats';
    if (/manzo|vitello|maiale|suino|pork/i.test(normalized)) return 'beef';
    if (/omega-3/i.test(normalized)) return 'omega';
    if (/pesce|salmone|sgombro|tonno|merluzzo|mollusch|crostace/i.test(normalized)) return 'otherFish';
    if (/latticini|formaggi/i.test(normalized)) return 'dairy';
    if (/uova/i.test(normalized)) return 'eggs';
    if (/legumi/i.test(normalized)) return 'legumes';
    return null;
  }

  // Rileva se un catalogo contiene ricette con il campo legacy `frequency`
  // (schema < 5). Usato dall'app per decidere se salvare il catalogo migrato
  // una sola volta al caricamento.
  function catalogHasLegacyFrequency(recipes) {
    return Array.isArray(recipes) && recipes.some(recipe => recipe && Object.prototype.hasOwnProperty.call(recipe, 'frequency'));
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

  // Genera una proposta di settimana "solida e ottimizzata": rispetta i tipi
  // A/R e i blocchi, limita le ripetizioni della stessa ricetta, distanzia gli
  // omega-3 (mai in giorni consecutivi, salvo le accoppiate cena → pranzo
  // richieste con batchPairs, dove l'adiacenza è intrinseca) e può programmare
  // accoppiate cena → pranzo per il batch cooking "doppia porzione". Non
  // modifica mai i dosaggi. Il risultato è riproducibile con lo stesso seed.
  //
  // Opzioni (tutte facoltative):
  //   plan            piano attuale (tipi A/R, blocchi batch, pasti mantenuti)
  //   seed            numero/stringa per la riproducibilità
  //   blocks          come prima: blocco singolo pasto o intera giornata
  //   templates       batchTemplates strutturali (bonus accoppiata anchor/target)
  //   batchPairs      n. di accoppiate cena → pranzo del giorno dopo (0-7)
  //   maxRepeats      apparizioni massime della stessa ricetta (default 2)
  //   allowCrossSlot  le ricette di pranzo/cena possono finire nell'altro pasto
  //                   (carboidrati trasformati in percentuale dal resto dell'app)
  //   slots           quali slot rigenerare: { breakfast, snack1, lunch, snack2, dinner }
  function generateWeek(catalog = [], options = {}) {
    const seedUsed = options.seed ?? Date.now();
    const rand = seededRandom(seedUsed);
    const currentPlan = options.plan && options.plan.days ? options.plan : emptyPlan();
    const blocks = options.blocks || {};
    const warnings = [];
    const recipes = (catalog || []).map(migrateRecipe);
    const recipesById = Object.fromEntries(recipes.map(recipe => [recipe.id, recipe]));

    const slotsEnabled = {
      breakfast: true, snack1: true, lunch: true, snack2: true, dinner: true,
      ...(options.slots || {})
    };
    const batchPairsWanted = Math.max(0, Math.min(7, Math.floor(Number(options.batchPairs) || 0)));
    const maxRepeats = Math.max(1, Math.min(7, Math.floor(Number(options.maxRepeats) || 2)));
    const allowCrossSlot = Boolean(options.allowCrossSlot);

    if (!recipes.length) warnings.push('Catalogo vuoto: nessuna settimana generabile.');
    else if (recipes.length < 14) warnings.push(`Catalogo ridotto (${recipes.length} ricette): la settimana potrebbe ripetersi più del previsto.`);

    const bySlot = {};
    SLOTS.forEach(slot => { bySlot[slot] = recipes.filter(recipe => recipe.slot === slot); });
    // Col cross-slot pranzo e cena pescano da entrambe le fonti: nel resto
    // dell'app i carboidrati vengono trasformati in percentuale.
    const poolFor = slot => {
      const base = bySlot[slot] || [];
      if (!allowCrossSlot || (slot !== 'lunch' && slot !== 'dinner')) return base;
      const opposite = bySlot[slot === 'lunch' ? 'dinner' : 'lunch'] || [];
      return base.concat(opposite);
    };

    const counts = { poultry: 0, beef: 0, curedMeats: 0, omega: 0, otherFish: 0, dairy: 0, eggs: 0, legumes: 0 };
    const fishToday = {};
    const omegaToday = {};
    const usage = {};
    const chosen = {};
    const pairs = [];

    const fishCountOn = day => (fishToday[day] || 0);
    const isFishy = recipe => {
      const category = classifyProtein(recipe);
      return category === 'omega' || category === 'otherFish';
    };
    const nextDayOf = day => DAYS[(DAYS.indexOf(day) + 1) % 7];
    const prevDayOf = day => DAYS[(DAYS.indexOf(day) + 6) % 7];

    // Registra un pasto confermato: conta nel totale settimanale della sua
    // categoria, nel limite "massimo un pesce al giorno" e nelle ripetizioni.
    const registerMeal = (day, slot, recipe) => {
      if (!recipe) return;
      usage[recipe.id] = (usage[recipe.id] || 0) + 1;
      if (slot !== 'lunch' && slot !== 'dinner') return;
      const category = classifyProtein(recipe);
      if (category && counts[category] !== undefined) counts[category] += 1;
      if (isFishy(recipe)) fishToday[day] = fishCountOn(day) + 1;
      if (category === 'omega') omegaToday[day] = (omegaToday[day] || 0) + 1;
    };
    const unregisterMeal = (day, slot, recipe) => {
      if (!recipe) return;
      usage[recipe.id] = Math.max(0, (usage[recipe.id] || 0) - 1);
      if (slot !== 'lunch' && slot !== 'dinner') return;
      const category = classifyProtein(recipe);
      if (category && counts[category] !== undefined) counts[category] = Math.max(0, counts[category] - 1);
      if (isFishy(recipe)) fishToday[day] = Math.max(0, fishCountOn(day) - 1);
      if (category === 'omega') omegaToday[day] = Math.max(0, (omegaToday[day] || 0) - 1);
    };

    const isBlocked = (day, slot) => {
      const block = blocks[day];
      if (!block) return false;
      if (block === 'all' || block.all) return true;
      return Boolean(block[slot]);
    };

    // Stato iniziale: pasti bloccati e slot esclusi dalla generazione restano
    // come sono e — fondamentale — entrano nei conteggi. Così il totale
    // settimanale (pesce/giorno compreso) riflette il piano finale completo.
    DAYS.forEach(day => {
      chosen[day] = {};
      SLOTS.forEach(slot => {
        if (isBlocked(day, slot)) {
          const block = blocks[day];
          const explicit = block === 'all' || block.all ? null : block[slot];
          const value = typeof explicit === 'string' && explicit ? explicit : (currentPlan.days?.[day]?.[slot] ?? null);
          chosen[day][slot] = value;
          if (recipesById[value]) registerMeal(day, slot, recipesById[value]);
        } else if (!slotsEnabled[slot]) {
          const value = currentPlan.days?.[day]?.[slot] ?? null;
          chosen[day][slot] = value;
          if (recipesById[value]) registerMeal(day, slot, recipesById[value]);
        }
      });
    });

    const freeSlot = (day, slot) => chosen[day][slot] === undefined;
    // Il pasto del giorno prima nello stesso slot (contro le ripetizioni
    // ravvicinate): preferisce le scelte già decise, ripiega sul piano attuale.
    const previousSlotValue = (day, slot) => {
      const prev = prevDayOf(day);
      return chosen[prev]?.[slot] ?? currentPlan.days?.[prev]?.[slot] ?? null;
    };

    const relaxedSlots = new Set();
    const warnRelaxed = (day, slot) => {
      const key = `${day}-${slot}`;
      if (relaxedSlots.has(key)) return;
      relaxedSlots.add(key);
      warnings.push(`Vincoli rilassati per ${DAY_LABELS[day]} ${SLOT_LABELS[slot]}: alcune frequenze o ripetizioni potrebbero non essere rispettate.`);
    };

    // Bonus accoppiate dei batchTemplates strutturali (cena anchor, pranzo
    // target entro lookAheadDays): premia chiudere la combinazione con un
    // pasto già deciso, in entrambe le direzioni temporali.
    const templates = (options.templates && Array.isArray(options.templates) ? options.templates : currentPlan.batchTemplates || []).slice();
    const anchorTemplates = {};
    const targetTemplates = {};
    templates.forEach(template => {
      const anchorId = template?.anchor?.recipeId;
      const targetId = template?.target?.recipeId;
      if (anchorId) (anchorTemplates[anchorId] ||= []).push(template);
      if (targetId) (targetTemplates[targetId] ||= []).push(template);
    });
    const templatePairBonus = (candidate, day, slot) => {
      if (slot === 'dinner' && anchorTemplates[candidate.id]) {
        for (const template of anchorTemplates[candidate.id]) {
          const look = template.target?.lookAheadDays || 3;
          for (let n = 1; n <= look; n++) {
            const futureDay = DAYS[(DAYS.indexOf(day) + n) % 7];
            if ((chosen[futureDay]?.lunch ?? currentPlan.days?.[futureDay]?.lunch) === template.target?.recipeId) return 1;
          }
        }
      }
      if (slot === 'lunch' && targetTemplates[candidate.id]) {
        for (const template of targetTemplates[candidate.id]) {
          const look = template.target?.lookAheadDays || 3;
          for (let n = 1; n <= look; n++) {
            const anchorDay = DAYS[(DAYS.indexOf(day) - n + 7) % 7];
            if ((chosen[anchorDay]?.dinner ?? currentPlan.days?.[anchorDay]?.dinner) === template.anchor?.recipeId) return 1;
          }
        }
      }
      return 0;
    };

    // --- Passo 1: batch "doppia porzione" (cena di oggi = pranzo di domani) ---
    // Le accoppiate vengono pianificate PER PRIME: occupano posti nel piano e
    // contano per intero nelle frequenze (il pasto si consuma due volte).
    const pairPool = () => {
      const pool = allowCrossSlot
        ? recipes.filter(recipe => recipe.slot === 'lunch' || recipe.slot === 'dinner')
        : (bySlot.dinner || []);
      // Nessuna cena nativa disponibile: ripiega sulle ricette di pranzo
      // (col cross-slot i carboidrati vengono comunque trasformati in percentuale).
      return pool.length ? pool : recipes.filter(recipe => recipe.slot === 'lunch' || recipe.slot === 'dinner');
    };
    const pairCandidateOk = (recipe, anchorDay, targetDay) => {
      const category = classifyProtein(recipe);
      // La stessa ricetta occupa due posti: deve starci nei suoi tetti.
      if ((usage[recipe.id] || 0) + 2 > maxRepeats) return false;
      if (isFishy(recipe) && (fishCountOn(anchorDay) >= 1 || fishCountOn(targetDay) >= 1)) return false;
      // Un'accoppiata omega cena → pranzo è adiacente a se stessa per
      // costruzione (è ciò che l'utente ha chiesto), ma non deve mai toccare
      // ALTRI giorni omega: niente catene di omega-3 consecutivi.
      if (category === 'omega' && (omegaToday[prevDayOf(anchorDay)] || omegaToday[nextDayOf(targetDay)])) return false;
      // Niente stessa ricetta già affiancata (pranzo/cena dello stesso giorno o il giorno prima).
      if (chosen[anchorDay]?.lunch === recipe.id || previousSlotValue(anchorDay, 'dinner') === recipe.id) return false;
      if (chosen[targetDay]?.dinner === recipe.id || previousSlotValue(targetDay, 'lunch') === recipe.id) return false;
      return true;
    };
    const pairScore = (recipe) => {
      let score = rand() * 2;
      if (!classifyProtein(recipe)) score -= 1;
      score -= (usage[recipe.id] || 0) * 3;
      return score;
    };
    const pairDays = shuffle(
      DAYS.filter(day => freeSlot(day, 'dinner') && freeSlot(nextDayOf(day), 'lunch')),
      rand
    );
    pairDays.forEach(anchorDay => {
      if (pairs.length >= batchPairsWanted) return;
      const targetDay = nextDayOf(anchorDay);
      const candidates = pairPool().filter(recipe => pairCandidateOk(recipe, anchorDay, targetDay));
      if (!candidates.length) return;
      const best = candidates
        .map(recipe => ({ recipe, score: pairScore(recipe, anchorDay, targetDay) }))
        .sort((a, b) => b.score - a.score)[0].recipe;
      chosen[anchorDay].dinner = best.id;
      chosen[targetDay].lunch = best.id;
      registerMeal(anchorDay, 'dinner', best);
      registerMeal(targetDay, 'lunch', best);
      pairs.push({ anchorDay, targetDay, recipeId: best.id });
    });
    // Avvisa solo se gli slot necessari alle coppie erano effettivamente
    // generabili (pranzo e cena abilitati): altrimenti l'utente li ha esclusi
    // volontariamente e la mancanza non è un problema.
    if (batchPairsWanted > pairs.length && slotsEnabled.lunch && slotsEnabled.dinner) {
      warnings.push(`Batch cena → pranzo: programmate ${pairs.length} accoppiate su ${batchPairsWanted} richieste (giorni liberi o ricette adatte insufficienti).`);
    }

    // --- Passo 2: riempimento principale di pranzi e cene ---
    // Vincoli duri: tetto settimanale per categoria, massimo un pesce al
    // giorno, tetto ripetizioni, omega-3 mai in giorni consecutivi. Se il pool
    // si svuota si rilassano a gradini (con un unico avviso per pasto) anziché
    // lasciare il pasto vuoto.
    const candidateHardOk = (recipe, day, { relaxRepeats = false, relaxFish = false, relaxOmegaSpacing = false } = {}) => {
      if (!classifyProtein(recipe)) return true;
      if (isFishy(recipe) && !relaxFish && fishCountOn(day) >= 1) return false;
      if (!relaxRepeats && (usage[recipe.id] || 0) >= maxRepeats) return false;
      // Omega-3 distanziati: l'unica adiacenza ammessa è quella costruita
      // dall'utente con un'accoppiata batch (stessa ricetta a cena e a pranzo
      // del giorno dopo), che però viene piazzata al passo 1 e qui non passa
      // mai da questo filtro perché i suoi slot sono già occupati.
      if (!relaxOmegaSpacing && classifyProtein(recipe) === 'omega' && (omegaToday[prevDayOf(day)] || omegaToday[nextDayOf(day)])) return false;
      return true;
    };
    const candidateScore = (recipe, day, slot) => {
      let score = rand() * 2;
      score += templatePairBonus(recipe, day, slot) * 4;
      if (!classifyProtein(recipe)) score -= 1;
      score -= 3 * (usage[recipe.id] || 0);
      if (previousSlotValue(day, slot) === recipe.id) score -= 5;
      // La penalità guida la scelta anche quando il vincolo è rilassato
      // (ultimo gradino): a parità di condizioni resta preferita la distanza.
      if (classifyProtein(recipe) === 'omega') {
        if (omegaToday[prevDayOf(day)]) score -= 6;
        if (omegaToday[nextDayOf(day)]) score -= 6;
      }
      return score;
    };
    const pickProtein = (day, slot) => {
      const pool = poolFor(slot);
      if (!pool.length) return null;
      const levels = [
        {}, // tutti i vincoli duri
        { relaxRepeats: true },
        { relaxRepeats: true, relaxFish: true },
        // Ultima spiaggia (catalogi irrisolvibili): si accetta anche un
        // omega-3 adiacente pur di non lasciare il pasto vuoto; l'adiacenza
        // residua viene poi segnalata tra i warning finali.
        { relaxRepeats: true, relaxFish: true, relaxOmegaSpacing: true }
      ];
      for (let index = 0; index < levels.length; index++) {
        const candidates = pool.filter(recipe => candidateHardOk(recipe, day, levels[index]));
        if (!candidates.length) continue;
        if (index > 0) warnRelaxed(day, slot);
        return candidates
          .map(recipe => ({ recipe, score: candidateScore(recipe, day, slot) }))
          .sort((a, b) => b.score - a.score)[0].recipe;
      }
      return null;
    };

    DAYS.forEach(day => {
      ['lunch', 'dinner'].forEach(slot => {
        if (!freeSlot(day, slot)) return;
        const pick = pickProtein(day, slot);
        chosen[day][slot] = pick ? pick.id : null;
        if (pick) registerMeal(day, slot, pick);
      });
    });

    // --- Passo 3: colazione e spuntini (rotazione varia) ---
    // --- Passo 4: colazione e spuntini (rotazione varia; le frequenze
    // proteiche sono definite su pranzo/cena, qui non si conteggiano) ---
    const pickSimple = (day, slot) => {
      const pool = poolFor(slot);
      if (!pool.length) return null;
      return pool
        .map(recipe => ({
          recipe,
          score: rand() * 2
            - 2 * (usage[recipe.id] || 0)
            - (previousSlotValue(day, slot) === recipe.id ? 5 : 0)
        }))
        .sort((a, b) => b.score - a.score)[0].recipe;
    };
    DAYS.forEach(day => {
      ['breakfast', 'snack1', 'snack2'].forEach(slot => {
        if (!freeSlot(day, slot)) return;
        const pick = pickSimple(day, slot);
        chosen[day][slot] = pick ? pick.id : null;
        if (pick) usage[pick.id] = (usage[pick.id] || 0) + 1;
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

    // Blocchi di giorni omega consecutivi, mostrati come intervalli completi
    // ("Mercoledì–Giovedì") anziché come solo primo giorno di ogni coppia.
    // La settimana è circolare: domenica e lunedì sono adiacenti.
    const omegaDaySet = new Set(DAYS.filter(day => (omegaToday[day] || 0) > 0));
    const omegaSegments = [];
    let omegaRun = [];
    DAYS.forEach(day => {
      if (!omegaDaySet.has(day)) {
        if (omegaRun.length) omegaSegments.push(omegaRun);
        omegaRun = [];
      } else {
        omegaRun.push(day);
      }
    });
    if (omegaRun.length) omegaSegments.push(omegaRun);
    if (omegaSegments.length > 1 && omegaDaySet.has('sunday') && omegaDaySet.has('monday')) {
      // Il blocco che finisce di domenica continua in quello che inizia di lunedì.
      const tail = omegaSegments.pop();
      omegaSegments[0] = tail.concat(omegaSegments[0]);
    }
    // Un'accoppiata batch omega richiesta dall'utente (cena → pranzo del
    // giorno dopo, stessa ricetta) occupa due giorni consecutivi per
    // costruzione: quell'adiacenza è voluta, non va segnalata. Si avvisano
    // solo le adiacenze rimaste per altre strade (rilassamenti dei vincoli,
    // pasti bloccati o mantenuti dall'utente).
    const omegaPairSpans = new Set(pairs
      .filter(pair => recipesById[pair.recipeId] && classifyProtein(recipesById[pair.recipeId]) === 'omega')
      .map(pair => `${pair.anchorDay}|${pair.targetDay}`));
    const adjacentOmegaRuns = omegaSegments.filter(segment => segment.length > 1);
    const unexplainedOmegaRuns = adjacentOmegaRuns.filter(segment =>
      !(segment.length === 2 && omegaPairSpans.has(`${segment[0]}|${segment[1]}`)));
    if (unexplainedOmegaRuns.length) {
      warnings.push(`Omega-3 in giorni consecutivi: ${unexplainedOmegaRuns.map(segment => `${DAY_LABELS[segment[0]]}–${DAY_LABELS[segment[segment.length - 1]]}`).join(', ')}.`);
    }
    const doubleFishDays = DAYS.filter(day => fishCountOn(day) > 1);
    if (doubleFishDays.length) warnings.push(`Due pasti di pesce nello stesso giorno: ${doubleFishDays.map(day => DAY_LABELS[day]).join(', ')}.`);

    return { plan: nextPlan, counts, warnings, seed: seedUsed, pairs };
  }

  // =====================================================================
  // Catalogo globale ingredienti (v2)
  //
  // FONTE UNICA di identità: ingredienti canonici, alias, search tokens,
  // categoria, famiglia globale e classificazione vegetarian/vegan. Nessuna
  // quantità, frequenza o regola clinica vive qui. È un dato esterno
  // versionato: queste funzioni lavorano su qualunque copia pubblicata
  // (indice in memoria per autocomplete, riconoscimento e persistenza
  // dell'ingredientId).
  // =====================================================================

  // Token di ricerca normalizzati. Il server è autorevole nella loro
  // generazione; il client li ricalcola solo per filtrare localmente una
  // copia del catalogo pubblicato (cache/offline).
  function searchTokensFor(displayName, aliases = []) {
    const tokens = new Set();
    [displayName, ...(Array.isArray(aliases) ? aliases : [])].forEach(value => {
      const key = aliasKey(value);
      if (!key) return;
      key.split(' ').forEach(word => { if (word) tokens.add(word); });
    });
    return [...tokens].slice(0, 200);
  }

  // Indice in memoria del catalogo pubblicato: fonte unica per autocomplete,
  // riconoscimento ingredienti e metadati (famiglia, categoria, flag
  // dietetici). Nessuna quantità clinica passa da qui.
  function buildCatalogIndex(catalogDoc = {}) {
    const categories = Array.isArray(catalogDoc.categories) ? catalogDoc.categories : [];
    const families = Array.isArray(catalogDoc.families) ? catalogDoc.families : [];
    const ingredients = Array.isArray(catalogDoc.ingredients) ? catalogDoc.ingredients : [];
    const categoriesById = new Map(categories.filter(item => item?.categoryId).map(item => [item.categoryId, item]));
    const familiesById = new Map(families.filter(item => item?.familyId).map(item => [item.familyId, item]));
    const items = ingredients
      .filter(item => item && item.ingredientId && item.status !== 'archived')
      .map(item => {
        const tokens = (Array.isArray(item.searchTokens) && item.searchTokens.length
          ? item.searchTokens
          : searchTokensFor(item.displayName, item.aliases)).map(token => aliasKey(token)).filter(Boolean);
        const family = familiesById.get(item.familyId) || null;
        return {
          ingredient: item,
          category: categoriesById.get(item.categoryId) || null,
          family,
          key: aliasKey(item.displayName),
          aliasKeys: (Array.isArray(item.aliases) ? item.aliases : []).map(aliasKey).filter(Boolean),
          tokens
        };
      });
    const byId = new Map(items.map(entry => [entry.ingredient.ingredientId, entry]));
    // Chiave normalizzata (nome o alias) → voci: serve al riconoscimento
    // esatto. Più voci con la stessa chiave restano distinte: nessuna scelta
    // silenziosa, il chiamante decide come disambiguare.
    const byAlias = new Map();
    items.forEach(entry => {
      [entry.key, ...entry.aliasKeys].forEach(key => {
        if (!byAlias.has(key)) byAlias.set(key, []);
        if (!byAlias.get(key).some(item => item.ingredient.ingredientId === entry.ingredient.ingredientId)) {
          byAlias.get(key).push(entry);
        }
      });
    });
    const familiesByKey = new Map(
      families
        .filter(item => item.status !== 'archived')
        .map(item => [aliasKey(item.displayName), item])
    );
    return { items, byId, byAlias, familiesByKey, categoriesById, familiesById };
  }

  // Autocomplete tollerante a maiuscole, accenti e alias. La categoria e la
  // famiglia vengono restituite per disambiguare risultati omonimi.
  // Ordinamento deterministico: corrispondenza esatta (nome/alias) > prefisso
  // token > substring; a parità di punteggio, ordine alfabetico italiano.
  // Mai una scelta silenziosa: i risultati multipli restano elencati e il
  // testo non riconosciuto produce zero risultati, non un'ipotesi.
  function searchCatalog(index, query, { limit = 12 } = {}) {
    const q = aliasKey(query);
    if (!index || !q || q.length < 2) return [];
    const queryWords = q.split(' ');
    const scored = [];
    for (const entry of index.items) {
      let score = 0;
      let matchedAlias = null;
      if (entry.key === q) {
        score = 100;
      } else {
        const aliasIndex = entry.aliasKeys.indexOf(q);
        if (aliasIndex >= 0) {
          score = 95;
          matchedAlias = entry.ingredient.aliases[aliasIndex] || null;
        } else if (entry.tokens.some(token => token.startsWith(q) || q.split(' ').every(word => token.startsWith(word)))) {
          score = 80;
        } else if (queryWords.every(word => entry.tokens.some(token => token.startsWith(word)))) {
          score = 70;
        } else if (entry.key.includes(q)) {
          score = 60;
        } else if (entry.aliasKeys.some(alias => alias.includes(q))) {
          score = 55;
        }
      }
      if (score > 0) {
        scored.push({
          ingredientId: entry.ingredient.ingredientId,
          displayName: entry.ingredient.displayName,
          categoryId: entry.ingredient.categoryId || null,
          categoryLabel: entry.category?.displayName || null,
          familyId: entry.ingredient.familyId || null,
          familyLabel: entry.family?.displayName || null,
          dietaryFlags: entry.ingredient.dietaryFlags || null,
          matchedAlias,
          score
        });
      }
    }
    scored.sort((a, b) => b.score - a.score || String(a.displayName).localeCompare(String(b.displayName), 'it'));
    return scored.slice(0, Math.max(1, Math.min(limit, 50)));
  }

  // ---------------------------------------------------------------------
  // Riconoscimento ingredienti — pipeline a stati espliciti.
  //
  //   resolved            → termine noto, un solo ingrediente canonico
  //   recognized-generic  → termine noto a livello di famiglia (es. un
  //                         generico che copre più ingredienti della STESSA
  //                         famiglia): famiglia certa, nessun ingredientId
  //   ambiguous           → termine noto ma ambiguo tra più famiglie
  //                         (es. «tonno»): candidati elencati, mai un
  //                         ingredientId auto-canonizzato
  //   unknown             → termine assente dal catalogo
  //
  // Mai auto-mappature aggressive: un termine noto non risulta mai
  // «unknown» e un termine ambiguo non viene forzato su un ID.
  // ---------------------------------------------------------------------
  function recognitionCandidates(index, key) {
    const lower = [];
    for (const entry of index.items) {
      const name = entry.key;
      const alias = entry.aliasKeys.find(value => value.includes(key) || key.includes(value));
      const token = entry.tokens.find(value => value.startsWith(key) || key.startsWith(value));
      if (alias || token || name.includes(key) || key.includes(name)) lower.push(entry);
    }
    return lower.slice(0, 8);
  }

  function recognizeIngredient(index, text) {
    const key = aliasKey(text);
    const none = { status: 'unknown', ingredientId: null, familyId: null, categoryId: null, candidates: [] };
    if (!index || !key) return none;
    const exact = index.byAlias.get(key) || [];
    const toCandidate = entry => ({
      ingredientId: entry.ingredient.ingredientId,
      displayName: entry.ingredient.displayName,
      categoryId: entry.ingredient.categoryId || null,
      familyId: entry.ingredient.familyId || null
    });
    if (exact.length === 1) {
      const entry = exact[0];
      return {
        status: 'resolved',
        ingredientId: entry.ingredient.ingredientId,
        familyId: entry.ingredient.familyId || null,
        categoryId: entry.ingredient.categoryId || null,
        candidates: [toCandidate(entry)]
      };
    }
    if (exact.length > 1) {
      const familyIds = [...new Set(exact.map(entry => entry.ingredient.familyId || null))];
      if (familyIds.length === 1 && familyIds[0]) {
        return {
          status: 'recognized-generic',
          ingredientId: null,
          familyId: familyIds[0],
          categoryId: exact[0].ingredient.categoryId || null,
          candidates: exact.map(toCandidate)
        };
      }
      return {
        status: 'ambiguous',
        ingredientId: null,
        familyId: null,
        categoryId: null,
        candidates: exact.map(toCandidate)
      };
    }
    const family = index.familiesByKey.get(key) || null;
    if (family) {
      return {
        status: 'recognized-generic',
        ingredientId: null,
        familyId: family.familyId,
        categoryId: family.categoryId || null,
        candidates: []
      };
    }
    const approx = recognitionCandidates(index, key);
    if (approx.length) {
      const familyIds = [...new Set(approx.map(entry => entry.ingredient.familyId || null).filter(Boolean))];
      if (familyIds.length === 1) {
        return {
          status: 'recognized-generic',
          ingredientId: null,
          familyId: familyIds[0],
          categoryId: approx[0].ingredient.categoryId || null,
          candidates: approx.map(toCandidate)
        };
      }
      return {
        status: 'ambiguous',
        ingredientId: null,
        familyId: null,
        categoryId: null,
        candidates: approx.map(toCandidate)
      };
    }
    return none;
  }

  // Regola di conservazione dell'ingredientId durante la modifica del testo:
  // un ID valido già persistito NON si perde per una semplice editatura del
  // testo. Si aggiorna solo quando il nuovo testo si risolve in un ingrediente
  // certo; negli stati generic/ambiguo l'ID resta se il testo è ancora
  // compatibile con quell'ingrediente (condivisione di parole/alias), altrimenti
  // si azzera. L'autocomplete aiuta a canonicalizzare senza corrompere il dato.
  function ingredientIdAfterEdit(index, text, currentId) {
    const recognition = recognizeIngredient(index, text);
    if (recognition.status === 'resolved') return recognition.ingredientId;
    if (!currentId || !index?.byId?.has(currentId)) return null;
    const key = aliasKey(text);
    if (!key) return null;
    const entry = index.byId.get(currentId);
    const relatable = [entry.key, ...entry.aliasKeys, ...entry.tokens]
      .some(value => value === key || key.includes(value) || value.includes(key));
    return relatable ? currentId : null;
  }

  // ---------------------------------------------------------------------
  // Motore della dieta assegnata (vista cliente).
  //
  // Costruito dal profilo assegnato (revisione struttura + snapshot catalogo):
  // le quantità arrivano SOLO dai blocchi della struttura del nutrizionista.
  // Nessun fallback globale: senza assegnazione non esiste allineamento.
  // ---------------------------------------------------------------------
  function dietOptionCoverage(option, recipeIngredients) {
    if (!option || option.type === 'recipe') return 0;
    if (option.type === 'ingredients') {
      const ids = new Set((option.items || []).map(item => item?.ingredientId).filter(Boolean));
      return recipeIngredients.filter(item => ids.has(item.ingredientId)).length;
    }
    const blocks = option.blocks || [];
    return recipeIngredients.filter(item => blocks.some(block =>
      block?.referenceFamilyId && block.referenceFamilyId === item.familyId
    )).length;
  }

  function buildDietEngine(profile) {
    if (!profile || !profile.structureRevision?.dietPlan) return null;
    const index = buildCatalogIndex(profile.catalog || {});
    const plan = profile.structureRevision.dietPlan;
    const meals = new Map();
    (Array.isArray(plan.days) ? plan.days : []).forEach(day => {
      const dayType = DIET_PLAN_DAY_TYPES.includes(day?.dayType) ? day.dayType : 'other';
      (Array.isArray(day?.meals) ? day.meals : []).forEach(meal => {
        if (!meal || !Array.isArray(meal.options) || !meal.options.length) return;
        if (!DIET_PLAN_MEALS.some(item => item.id === meal.mealId)) return;
        if (!meals.has(meal.mealId)) meals.set(meal.mealId, { byDayType: new Map(), first: meal.options });
        const record = meals.get(meal.mealId);
        if (!record.byDayType.has(dayType)) record.byDayType.set(dayType, meal.options);
      });
    });
    if (!meals.size) return null;
    return {
      index,
      structureId: profile.structureId || null,
      structureRevisionId: profile.structureRevisionId ?? profile.structureRevision.revisionId ?? null,
      structureName: profile.structureName || null,
      plan,
      familiesById: index.familiesById,
      mealIds: [...meals.keys()],
      optionsFor(mealId, dayType) {
        const record = meals.get(mealId);
        if (!record) return null;
        return record.byDayType.get(dayType) || record.byDayType.get('other') || record.first;
      }
    };
  }

  // Equivalenti di un blocco: gli import del template sono scalati alla
  // quantità di riferimento del blocco (proporzionalità) e gli override
  // espliciti della struttura prevalgono. Il template è fissato nella
  // revisione pubblicata (snapshot): mai retroattività silenziosa.
  function dietBlockEquivalents(block) {
    const snapshot = block?.templateSnapshot;
    if (!snapshot || !Array.isArray(snapshot.equivalents)) return [];
    const baseValue = Number(snapshot.referenceAmount?.value);
    const blockValue = Number(block?.referenceAmount?.value);
    const factor = Number.isFinite(baseValue) && baseValue > 0 && Number.isFinite(blockValue) && blockValue > 0
      ? blockValue / baseValue
      : 1;
    const overrides = new Map((Array.isArray(block.overrides) ? block.overrides : [])
      .map(override => [`${override.familyId}|${override.ingredientId || ''}`, override.amount]));
    return snapshot.equivalents
      .filter(equivalent => equivalent && equivalent.familyId)
      .map(equivalent => {
        const key = `${equivalent.familyId}|${equivalent.ingredientId || ''}`;
        const overridden = overrides.get(key) || null;
        const source = overridden || equivalent.amount;
        const value = Number(source?.value);
        const scaled = !overridden && factor !== 1 && Number.isFinite(value)
          ? { value: Math.round(value * factor * 10) / 10, unit: source?.unit || 'g' }
          : source;
        return {
          familyId: equivalent.familyId,
          ingredientId: equivalent.ingredientId || null,
          amount: scaled,
          overridden: Boolean(overridden)
        };
      });
  }

  // Vista «dosi allineate» di una ricetta personale nel contesto di un pasto
  // della dieta assegnata. NON modifica la ricetta: restituisce una vista con
  // dosi aumentate/diminuite, ingredienti aggiunti (blocchi della dieta non
  // presenti nella ricetta) e ingredienti omessi (non previsti dalla dieta per
  // quel pasto). I soli alimenti delle categorie libere (spezie, erbe,
  // condimenti, bevande) restano sempre con le dosi originali.
  function alignRecipeToDiet(recipe, engine, mealId, dayType) {
    if (!engine || !recipe) return null;
    const options = (engine.optionsFor(mealId, dayType) || []).filter(option => option && option.type !== 'recipe');
    if (!options.length) return null;
    const recipeIngredients = (recipe.ingredients || []).map(ingredient => {
      const ingredientId = ingredient.ingredientId && engine.index.byId.has(ingredient.ingredientId)
        ? ingredient.ingredientId
        : null;
      const entry = ingredientId
        ? engine.index.byId.get(ingredientId)
        : recognizeIngredient(engine.index, ingredient.name).ingredientId
          ? engine.index.byId.get(recognizeIngredient(engine.index, ingredient.name).ingredientId)
          : null;
      return {
        name: ingredient.name,
        ingredientId: entry ? entry.ingredient.ingredientId : null,
        familyId: entry ? (entry.ingredient.familyId || null) : null,
        categoryId: entry ? (entry.ingredient.categoryId || null) : null,
        original: portionFor(ingredient)
      };
    });
    // Opzione con la miglior copertura degli ingredienti della ricetta; a
    // parità vince la prima (deterministico).
    let chosen = options[0];
    let bestScore = -1;
    options.forEach(option => {
      const score = dietOptionCoverage(option, recipeIngredients);
      if (score > bestScore) {
        bestScore = score;
        chosen = option;
      }
    });
    const freeCategory = ingredient => ingredient.categoryId === 'free'
      || ['spezie', 'erbe-aromatiche', 'condimenti', 'bevande'].includes(ingredient.familyId);
    const ingredients = [];
    const added = [];
    const omitted = [];
    const used = new Set();
    const amountText = amount => (amount && Number.isFinite(Number(amount.value))
      ? formatAmount(Number(amount.value), amount.unit)
      : EMPTY_PORTION);
    if (chosen.type === 'ingredients') {
      (chosen.items || []).forEach(item => {
        const entry = item?.ingredientId ? engine.index.byId.get(item.ingredientId) : null;
        const match = recipeIngredients.find(candidate =>
          !used.has(candidate) && candidate.ingredientId && candidate.ingredientId === item.ingredientId
        );
        if (match) {
          used.add(match);
          ingredients.push({
            name: match.name,
            ingredientId: match.ingredientId,
            amountText: amountText(item.amount),
            original: match.original,
            aligned: true
          });
        } else {
          added.push({
            name: entry ? entry.ingredient.displayName : item.ingredientId,
            ingredientId: item.ingredientId,
            amountText: amountText(item.amount)
          });
        }
      });
    } else {
      (chosen.blocks || []).forEach(block => {
        if (!block || !block.referenceFamilyId) return;
        const match = recipeIngredients.find(candidate =>
          !used.has(candidate) && (
            (block.referenceIngredientId && candidate.ingredientId === block.referenceIngredientId)
            || candidate.familyId === block.referenceFamilyId
          )
        );
        if (match) {
          used.add(match);
          ingredients.push({
            name: match.name,
            ingredientId: match.ingredientId,
            amountText: amountText(block.referenceAmount),
            original: match.original,
            aligned: true
          });
        } else {
          const entry = block.referenceIngredientId ? engine.index.byId.get(block.referenceIngredientId) : null;
          const family = engine.familiesById.get(block.referenceFamilyId);
          added.push({
            name: entry ? entry.ingredient.displayName : (family?.displayName || block.referenceFamilyId),
            ingredientId: block.referenceIngredientId || null,
            familyId: block.referenceFamilyId,
            amountText: amountText(block.referenceAmount)
          });
        }
      });
    }
    recipeIngredients.forEach(candidate => {
      if (used.has(candidate)) return;
      if (freeCategory(candidate)) {
        ingredients.push({
          name: candidate.name,
          ingredientId: candidate.ingredientId,
          amountText: candidate.original,
          original: candidate.original,
          aligned: false
        });
      } else {
        omitted.push({ name: candidate.name, ingredientId: candidate.ingredientId });
      }
    });
    const changed = added.length > 0
      || omitted.length > 0
      || ingredients.some(item => item.aligned && String(item.amountText) !== String(item.original ?? ''));
    return { optionId: chosen.optionId || null, type: chosen.type, ingredients, added, omitted, changed };
  }

  // Console professionisti — stati operativi dei clienti (vista unificata)
  //
  // La vista «Clienti» mostra tre stati operativi (Attivo, Inattivo,
  // In attesa) calcolati dallo stato del profilo e dal collegamento. Gli
  // stati di storico (rifiutato, revocato, scaduto, sostituito) restano
  // visibili solo dentro la scheda cliente. Funzioni pure: la console le
  // usa per filtrare e per i titoli, senza mai mostrare UID o ID tecnici.
  // =====================================================================

  const CLIENT_OPERATIONAL_STATUSES = ['active', 'inactive', 'pending'];
  const CLIENT_STATUS_LABELS = { active: 'Attivo', inactive: 'Inattivo', pending: 'In attesa' };
  const CLIENT_HISTORY_STATUS_LABELS = {
    rejected: 'Rifiutato', revoked: 'Revocato', expired: 'Scaduto',
    superseded: 'Sostituito', cancelled: 'Annullato', accepted: 'Accettato',
    consumed: 'Utilizzato', suspended: 'Sospeso', unlinked: 'Scollegato'
  };

  // Stato operativo di un cliente: 'active' | 'inactive' | 'pending'.
  // - pending: profilo in attesa (invito email o richiesta di collegamento
  //   da confermare) oppure invito/richiesta pendente collegati al profilo;
  // - active: profilo attivo con collegamento attivo;
  // - inactive: tutto il resto (scollegato, sospeso, rimosso, sconosciuto).
  function clientOperationalStatus(client, context) {
    const status = String(client?.status || '').toLowerCase();
    if (status === 'pending') return 'pending';
    const scopes = context || {};
    const hasPendingInvite = Array.isArray(scopes.invitations)
      && scopes.invitations.some(item => item && item.clientId === client?.id && item.status === 'pending');
    const hasPendingRequest = Array.isArray(scopes.requests)
      && scopes.requests.some(item => item && item.clientId === client?.id && (!item.status || item.status === 'pending'));
    if (hasPendingInvite || hasPendingRequest) return 'pending';
    if (status === 'active') return 'active';
    return 'inactive';
  }

  function clientStatusLabel(status) {
    return CLIENT_STATUS_LABELS[status] || CLIENT_HISTORY_STATUS_LABELS[status] || 'Sconosciuto';
  }

  function maskEmailClient(value) {
    const clean = String(value || '').trim().toLowerCase();
    const at = clean.indexOf('@');
    if (at <= 0 || at === clean.length - 1) return '—';
    const local = clean.slice(0, at);
    const domain = clean.slice(at + 1);
    const head = local.slice(0, 1);
    return `${head}${'•'.repeat(Math.min(Math.max(local.length - 1, 1), 4))}@${domain}`;
  }

  // Titolo del cliente: mai UID o ID tecnici. Ordine di fallback:
  // «Nome Cognome» → email mascherata → displayCode.
  // Lo username legacy resta solo un'informazione secondaria in scheda.
  function clientDisplayTitle(client) {
    const first = String(client?.firstName || '').trim();
    const last = String(client?.lastName || '').trim();
    const full = `${first} ${last}`.trim();
    if (full) return full;
    const email = String(client?.email || client?.emailNormalized || '').trim();
    if (email) return maskEmailClient(email);
    return String(client?.displayCode || 'Cliente');
  }

  function clientInitials(client) {
    const title = clientDisplayTitle(client);
    const parts = title.split(/[\s.]+/).filter(Boolean);
    const head = (parts[0] || 'C').slice(0, 1);
    const tail = parts.length > 1 ? (parts[parts.length - 1] || '').slice(0, 1) : '';
    return (head + tail).toUpperCase() || 'C';
  }

  // =====================================================================
  // Strutture dieta — piano a blocchi (dietPlan schema 2)
  //
  // Il piano descrive la dieta come la deve leggere il cliente: giornate
  // (allenamento/riposo/altra), pasti e opzioni. Non esegue alcun calcolo
  // clinico. Tre tipi di opzione, mutuamente esclusivi:
  //   - «family-block»: blocchi con famiglia di riferimento, ingrediente di
  //     riferimento facoltativo, quantità di riferimento e template equivalenze
  //     collegato (con snapshot non retroattivo + override espliciti);
  //   - «ingredients»: elenco di ingredienti del catalogo con quantità;
  //   - «recipe»: ricetta del ricettario professionale con moltiplicatore.
  // I dati restano sempre `options: [...]`; con una sola opzione la UI non
  // mostra etichette A/B/C (l'etichetta è derivata, mai persistita).
  // Le quantità sono quantificate {value, unit}; i testi descrittivi restano
  // tali (note, integrazione, idratazione).
  // =====================================================================

  const DIET_PLAN_SCHEMA_VERSION = 2;
  const DIET_PLAN_DAY_TYPES = ['training', 'rest', 'other'];
  const DIET_PLAN_DAY_TYPE_LABELS = {
    training: 'Giornata di allenamento',
    rest: 'Giornata di riposo',
    other: 'Altra giornata'
  };
  const DIET_PLAN_MEALS = [
    { id: 'breakfast', label: 'Colazione' },
    { id: 'morning-snack', label: 'Spuntino di metà mattina' },
    { id: 'lunch', label: 'Pranzo' },
    { id: 'afternoon-snack', label: 'Merenda' },
    { id: 'dinner', label: 'Cena' },
    { id: 'evening-snack', label: 'Spuntino serale' }
  ];
  const DIET_PLAN_UNITS = [
    { id: 'g', label: 'g' }, { id: 'kg', label: 'kg' },
    { id: 'ml', label: 'ml' }, { id: 'l', label: 'l' },
    { id: 'pz', label: 'pz' }, { id: 'fette', label: 'fette' },
    { id: 'cucchiai', label: 'cucchiai' }, { id: 'cucchiaini', label: 'cucchiaini' },
    { id: 'tazze', label: 'tazze' }, { id: 'bicchieri', label: 'bicchieri' },
    { id: 'porzioni', label: 'porzioni' }, { id: 'scatolette', label: 'scatolette' },
    { id: 'misurini', label: 'misurini' }, { id: 'qb', label: 'q.b.' }
  ];
  const DIET_PLAN_OPTION_TYPES = [
    { id: 'family-block', label: 'Famiglia di riferimento' },
    { id: 'ingredients', label: 'Ingredienti' },
    { id: 'recipe', label: 'Ricetta' }
  ];
  // Etichette di visualizzazione SOLO quando ci sono più opzioni: con una
  // sola opzione non esiste rumore A/B/C (decisione di prodotto).
  const DIET_PLAN_OPTION_LABELS = ['A', 'B', 'C', 'D'];
  const DIET_PLAN_LIMITS = {
    days: 14, mealsPerDay: 10, optionsPerMeal: 4, itemsPerOption: 20,
    blocksPerOption: 8, equivalentsPerTemplate: 30,
    recipeMultiplierMin: 0.1, recipeMultiplierMax: 10,
    label: 80, note: 1000, quantity: 5000, title: 200
  };

  function dietPlanDayLabel(dayType) {
    return DIET_PLAN_DAY_TYPE_LABELS[dayType] || 'Giornata';
  }

  function dietPlanMealLabel(mealId) {
    const found = DIET_PLAN_MEALS.find(item => item.id === mealId);
    return found ? found.label : (mealId || 'Pasto');
  }

  function dietPlanUnitLabel(unitId) {
    const found = DIET_PLAN_UNITS.find(item => item.id === unitId);
    return found ? found.label : (unitId || '');
  }

  // Quantità strutturata {value, unit}: numero 0–5000 + unità del catalogo
  // chiuso. Restituisce null quando il dato non è una quantità valida.
  function normalizeDietAmount(source) {
    if (!source || typeof source !== 'object') return null;
    const value = Number(source.value);
    const unit = String(source.unit || '');
    if (!Number.isFinite(value) || value < 0 || value > DIET_PLAN_LIMITS.quantity) return null;
    if (!DIET_PLAN_UNITS.some(item => item.id === unit)) return null;
    return { value, unit };
  }

  function createDietAmount(source) {
    return normalizeDietAmount(source) || { value: null, unit: 'g' };
  }

  // Blocco famiglia: la categoria NON è duplicata (deriva dalla famiglia nel
  // catalogo al momento del rendering/validazione).
  function createDietPlanBlock(detail) {
    const source = detail || {};
    return {
      blockId: String(source.blockId || `block-${Math.random().toString(36).slice(2, 8)}`),
      referenceFamilyId: String(source.referenceFamilyId || ''),
      referenceIngredientId: source.referenceIngredientId || null,
      referenceAmount: createDietAmount(source.referenceAmount),
      templateId: source.templateId || null,
      templateSnapshot: source.templateSnapshot || null,
      overrides: Array.isArray(source.overrides)
        ? source.overrides
            .filter(override => override && override.familyId && normalizeDietAmount(override.amount))
            .map(override => ({
              familyId: String(override.familyId),
              ingredientId: override.ingredientId || null,
              amount: normalizeDietAmount(override.amount)
            }))
        : []
    };
  }

  function createDietPlanItem(detail) {
    const source = detail || {};
    return {
      itemId: String(source.itemId || `item-${Math.random().toString(36).slice(2, 8)}`),
      ingredientId: String(source.ingredientId || ''),
      amount: createDietAmount(source.amount)
    };
  }

  function dietPlanOptionType(source) {
    if (!source || typeof source !== 'object') return 'family-block';
    if (DIET_PLAN_OPTION_TYPES.some(item => item.id === source.type)) return source.type;
    return 'family-block';
  }

  function createDietPlanOption(detail) {
    const source = detail || {};
    const type = dietPlanOptionType(source);
    const option = {
      optionId: String(source.optionId || `opt-${Math.random().toString(36).slice(2, 8)}`),
      type,
      note: typeof source.note === 'string' ? source.note : ''
    };
    if (type === 'recipe') {
      option.recipeId = source.recipeId || null;
      option.recipeMultiplier = (() => {
        const multiplier = Number(source.recipeMultiplier);
        if (!Number.isFinite(multiplier)) return 1;
        return Math.min(DIET_PLAN_LIMITS.recipeMultiplierMax, Math.max(DIET_PLAN_LIMITS.recipeMultiplierMin, multiplier));
      })();
      return option;
    }
    if (type === 'ingredients') {
      option.items = (Array.isArray(source.items) ? source.items : [])
        .filter(item => item && item.ingredientId)
        .map(item => createDietPlanItem(item));
      return option;
    }
    option.blocks = (Array.isArray(source.blocks) ? source.blocks : [])
      .filter(block => block && block.referenceFamilyId)
      .map(block => createDietPlanBlock(block));
    return option;
  }

  function createDietPlanMeal(mealId, detail) {
    const source = detail || {};
    const known = DIET_PLAN_MEALS.some(item => item.id === mealId);
    return {
      mealId: known ? mealId : 'lunch',
      time: typeof source.time === 'string' ? source.time : '',
      options: (Array.isArray(source.options) && source.options.length
        ? source.options
        : [{}]).map(option => createDietPlanOption(option)),
      note: typeof source.note === 'string' ? source.note : ''
    };
  }

  function mealSortIndex(mealId) {
    const index = DIET_PLAN_MEALS.findIndex(item => item.id === mealId);
    return index >= 0 ? index : DIET_PLAN_MEALS.length;
  }

  function sortDietPlanMeals(meals) {
    return (Array.isArray(meals) ? meals : [])
      .slice()
      .sort((a, b) => mealSortIndex(a.mealId) - mealSortIndex(b.mealId));
  }

  function createDietPlanDay(dayType, detail) {
    const source = detail || {};
    return {
      dayId: String(source.dayId || `day-${Math.random().toString(36).slice(2, 8)}`),
      label: typeof source.label === 'string' ? source.label : '',
      dayType: DIET_PLAN_DAY_TYPES.includes(dayType) ? dayType : 'training',
      meals: sortDietPlanMeals(Array.isArray(source.meals) && source.meals.length
        ? source.meals.map(meal => createDietPlanMeal(meal.mealId, meal))
        : []),
      supplements: typeof source.supplements === 'string' ? source.supplements : '',
      hydration: typeof source.hydration === 'string' ? source.hydration : '',
      note: typeof source.note === 'string' ? source.note : ''
    };
  }

  function createEmptyDietPlan(detail) {
    const source = detail || {};
    return {
      schemaVersion: DIET_PLAN_SCHEMA_VERSION,
      days: Array.isArray(source.days) && source.days.length
        ? source.days.map(day => createDietPlanDay(day?.dayType, day))
        : [createDietPlanDay('training'), createDietPlanDay('rest')],
      generalNotes: typeof source.generalNotes === 'string' ? source.generalNotes : ''
    };
  }

  // Pre-validazione lato console: raccoglie gli errori in italiano senza mai
  // lanciare. Il server rivalida comunque ogni campo (catalogo incluso).
  // `catalogIndex` è facoltativo: quando presente verifica che ingredienti e
  // famiglie esistano nel catalogo pubblicato.
  function validateDietPlanSoft(plan, catalogIndex = null) {
    const errors = [];
    const limits = DIET_PLAN_LIMITS;
    if (!plan || typeof plan !== 'object') return { valid: false, errors: ['Piano dieta non valido.'] };
    if (Number(plan.schemaVersion) !== DIET_PLAN_SCHEMA_VERSION) {
      errors.push('Versione del piano non supportata da questa console.');
    }
    const familyExists = familyId => (catalogIndex ? catalogIndex.familiesById?.has(familyId) : true);
    const ingredientExists = ingredientId => (catalogIndex ? catalogIndex.byId?.has(ingredientId) : true);
    const ingredientInFamily = (ingredientId, familyId) => {
      if (!catalogIndex || !ingredientId) return true;
      const entry = catalogIndex.byId.get(ingredientId);
      return Boolean(entry && entry.ingredient.familyId === familyId);
    };
    const days = Array.isArray(plan.days) ? plan.days : [];
    if (!days.length || days.length > limits.days) {
      errors.push(`Il piano deve contenere da 1 a ${limits.days} giornate.`);
    }
    const seenDayIds = new Set();
    days.forEach((day, dayIndex) => {
      const where = `Giornata ${dayIndex + 1}`;
      if (!day || typeof day !== 'object') { errors.push(`${where}: dati mancanti.`); return; }
      if (day.dayId) {
        if (seenDayIds.has(day.dayId)) errors.push(`${where}: identificativo duplicato.`);
        seenDayIds.add(day.dayId);
      }
      if (!DIET_PLAN_DAY_TYPES.includes(day.dayType)) errors.push(`${where}: tipo giornata non valido.`);
      if (String(day.label || '').length > limits.label) errors.push(`${where}: titolo troppo lungo.`);
      const meals = Array.isArray(day.meals) ? day.meals : [];
      if (!meals.length || meals.length > limits.mealsPerDay) {
        errors.push(`${where}: servono da 1 a ${limits.mealsPerDay} pasti.`);
      }
      const seenMealIds = new Set();
      meals.forEach((meal, mealIndex) => {
        const mealWhere = `${where}, pasto ${mealIndex + 1}`;
        if (!meal || typeof meal !== 'object') { errors.push(`${mealWhere}: dati mancanti.`); return; }
        if (!DIET_PLAN_MEALS.some(item => item.id === meal.mealId)) errors.push(`${mealWhere}: tipo di pasto non valido.`);
        if (seenMealIds.has(meal.mealId)) errors.push(`${mealWhere}: pasto duplicato.`);
        seenMealIds.add(meal.mealId);
        if (String(meal.time || '').length > 10) errors.push(`${mealWhere}: orario non valido.`);
        if (String(meal.note || '').length > limits.note) errors.push(`${mealWhere}: nota troppo lunga.`);
        const options = Array.isArray(meal.options) ? meal.options : [];
        if (!options.length || options.length > limits.optionsPerMeal) {
          errors.push(`${mealWhere}: servono da 1 a ${limits.optionsPerMeal} opzioni.`);
        }
        options.forEach((option, optionIndex) => {
          const optionWhere = `${mealWhere}, opzione ${options.length > 1 ? (DIET_PLAN_OPTION_LABELS[optionIndex] || optionIndex + 1) : 'unica'}`;
          if (!option || typeof option !== 'object') { errors.push(`${optionWhere}: dati mancanti.`); return; }
          if (!DIET_PLAN_OPTION_TYPES.some(item => item.id === option.type)) {
            errors.push(`${optionWhere}: tipo opzione non valido.`);
            return;
          }
          if (String(option.note || '').length > limits.note) errors.push(`${optionWhere}: nota troppo lunga.`);
          if (option.type === 'recipe') {
            if (!String(option.recipeId || '').trim()) errors.push(`${optionWhere}: seleziona la ricetta.`);
            const multiplier = Number(option.recipeMultiplier);
            if (option.recipeMultiplier != null && option.recipeMultiplier !== '' && (!Number.isFinite(multiplier) || multiplier < limits.recipeMultiplierMin || multiplier > limits.recipeMultiplierMax)) {
              errors.push(`${optionWhere}: moltiplicatore ricetta non valido (tra ${String(limits.recipeMultiplierMin).replace('.', ',')} e ${String(limits.recipeMultiplierMax).replace('.', ',')}).`);
            }
            return;
          }
          if (option.type === 'ingredients') {
            const items = Array.isArray(option.items) ? option.items : [];
            if (!items.length) errors.push(`${optionWhere}: aggiungi almeno un ingrediente.`);
            if (items.length > limits.itemsPerOption) errors.push(`${optionWhere}: massimo ${limits.itemsPerOption} ingredienti per opzione.`);
            items.forEach((item, itemIndex) => {
              const itemWhere = `${optionWhere}, ingrediente ${itemIndex + 1}`;
              if (!item?.ingredientId) { errors.push(`${itemWhere}: seleziona l'alimento dal catalogo.`); return; }
              if (!ingredientExists(item.ingredientId)) errors.push(`${itemWhere}: alimento non presente nel catalogo.`);
              if (!normalizeDietAmount(item.amount)) errors.push(`${itemWhere}: quantità non valida (numero + unità).`);
            });
            return;
          }
          const blocks = Array.isArray(option.blocks) ? option.blocks : [];
          if (!blocks.length) errors.push(`${optionWhere}: aggiungi almeno un blocco con famiglia di riferimento.`);
          if (blocks.length > limits.blocksPerOption) errors.push(`${optionWhere}: massimo ${limits.blocksPerOption} blocchi per opzione.`);
          blocks.forEach((block, blockIndex) => {
            const blockWhere = `${optionWhere}, blocco ${blockIndex + 1}`;
            if (!block?.referenceFamilyId) { errors.push(`${blockWhere}: seleziona la famiglia di riferimento.`); return; }
            if (!familyExists(block.referenceFamilyId)) errors.push(`${blockWhere}: famiglia non presente nel catalogo.`);
            if (block.referenceIngredientId && !ingredientExists(block.referenceIngredientId)) {
              errors.push(`${blockWhere}: ingrediente di riferimento non presente nel catalogo.`);
            } else if (block.referenceIngredientId && !ingredientInFamily(block.referenceIngredientId, block.referenceFamilyId)) {
              errors.push(`${blockWhere}: l'ingrediente di riferimento non appartiene alla famiglia.`);
            }
            if (!normalizeDietAmount(block.referenceAmount)) errors.push(`${blockWhere}: quantità di riferimento non valida (numero + unità).`);
          });
        });
      });
      if (String(day.supplements || '').length > limits.note) errors.push(`${where}: integrazione troppo lunga.`);
      if (String(day.hydration || '').length > limits.note) errors.push(`${where}: idratazione troppo lunga.`);
      if (String(day.note || '').length > limits.note) errors.push(`${where}: nota troppo lunga.`);
    });
    if (String(plan.generalNotes || '').length > 2000) errors.push('Note generali troppo lunghe.');
    return { valid: errors.length === 0, errors };
  }

  function dietPlanSummary(plan) {
    const days = Array.isArray(plan?.days) ? plan.days : [];
    let meals = 0;
    let options = 0;
    let blocks = 0;
    let items = 0;
    let recipes = 0;
    days.forEach(day => {
      (Array.isArray(day?.meals) ? day.meals : []).forEach(meal => {
        meals += 1;
        (Array.isArray(meal?.options) ? meal.options : []).forEach(option => {
          options += 1;
          if (option?.type === 'recipe') recipes += 1;
          blocks += Array.isArray(option?.blocks) ? option.blocks.length : 0;
          items += Array.isArray(option?.items) ? option.items.length : 0;
        });
      });
    });
    return { dayCount: days.length, mealCount: meals, optionCount: options, blockCount: blocks, itemCount: items, recipeOptionCount: recipes };
  }

  // Moltiplica i numeri presenti in un testo di dose ("80 g", "1/2 panino",
  // "q.b.") per il moltiplicatore ricetta. I numeri interi restano tali, le
  // frazioni decimali si arrotondano a una cifra con virgola; i testi senza
  // numeri (q.b., quanto basta) non cambiano.
  function scalePortionText(text, multiplier) {
    const source = String(text || '');
    const factor = Number(multiplier);
    if (!Number.isFinite(factor) || factor === 1 || factor <= 0) return source;
    if (!/\d/.test(source)) return source;
    const format = value => {
      const rounded = Math.round(value * 100) / 100;
      return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', ',');
    };
    // Numeri semplici ("80 g") e frazioni ("1/2 panino") si moltiplicano per
    // il fattore come valore: 1/2 × 2 = 1, non "2/4".
    return source.replace(/\d+(?:[.,]\d+)?(?:\/\d+(?:[.,]\d+)?)?/g, raw => {
      if (raw.includes('/')) {
        const [numRaw, denRaw] = raw.split('/');
        const num = Number(numRaw.replace(',', '.'));
        const den = Number(denRaw.replace(',', '.'));
        if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return raw;
        return format((num / den) * factor);
      }
      const value = Number(raw.replace(',', '.')) * factor;
      return Number.isFinite(value) ? format(value) : raw;
    });
  }

  // ---------------------------------------------------------------------
  // Template equivalenze (organization-scoped) — funzioni pure di supporto.
  // Il template vive in organizations/{orgId}/equivalenceTemplates con
  // revisioni immutabili: famiglia di riferimento, eventuale ingrediente di
  // riferimento, quantità di riferimento ed equivalenti proporzionali.
  // ---------------------------------------------------------------------
  const EQUIVALENCE_TEMPLATE_SCHEMA_VERSION = 1;

  // Quantità proporzionali del template per una nuova quantità di riferimento:
  // base del calcolo riutilizzabile in console e in anteprima cliente.
  function equivalenceTemplateScaled(template, referenceValue) {
    const base = Number(template?.referenceAmount?.value);
    const target = Number(referenceValue);
    if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(target) || target <= 0) return [];
    const factor = target / base;
    return (Array.isArray(template?.equivalents) ? template.equivalents : [])
      .filter(equivalent => equivalent && equivalent.familyId)
      .map(equivalent => {
        const value = Number(equivalent.amount?.value);
        return {
          familyId: equivalent.familyId,
          ingredientId: equivalent.ingredientId || null,
          amount: Number.isFinite(value)
            ? { value: Math.round(value * factor * 10) / 10, unit: equivalent.amount?.unit || 'g' }
            : equivalent.amount
        };
      });
  }

  return {
    VERSION,
    DAYS,
    SLOTS,
    MEAL_ID_BY_SLOT,
    SLOT_BY_MEAL_ID,
    DAY_LABELS,
    DAY_SHORT,
    SLOT_LABELS,
    SLOT_SHORT,
    EMPTY_PORTION,
    SINGLE_ORGANIZATION_ID,
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
    planAlignedDosesEnabled,
    setPlanAlignedDosesEnabled,
    emptyPlan,
    futureTarget,
    batchTaskStatus,
    portionFor,
    formatPortion,
    quantityForTask,
    activeBatch,
    sumPortionStrings,
    combineTaskQuantities,
    commonRecipeBatch,
    categoryForIngredient,
    resolveShopCategoryOrder,
    resolveShopItemOrder,
    isEmptyPortion,
    parseSimpleAmount,
    parseQuantity,
    formatAmount,
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
    applyProfessionalRecipes,
    isProfessionalRecipe,
    planSlotsForRecipeRemoval,
    diffPlans,
    buildBackup,
    PROTEIN_CATEGORIES,
    PROTEIN_CATEGORY_LABELS,
    classifyProtein,
    inferProteinCategoryFromIngredients,
    catalogHasLegacyFrequency,
    mulberry32,
    hashString,
    generateWeek,
    // Catalogo globale (v2): fonte unica di identità ingredienti
    searchTokensFor,
    buildCatalogIndex,
    searchCatalog,
    recognizeIngredient,
    ingredientIdAfterEdit,
    // Motore della dieta assegnata (vista «dosi allineate»)
    buildDietEngine,
    dietBlockEquivalents,
    alignRecipeToDiet,
    // Console professionisti — stati operativi dei clienti
    CLIENT_OPERATIONAL_STATUSES,
    CLIENT_STATUS_LABELS,
    CLIENT_HISTORY_STATUS_LABELS,
    clientOperationalStatus,
    clientStatusLabel,
    maskEmailClient,
    clientDisplayTitle,
    clientInitials,
    // Strutture dieta — piano a blocchi (dietPlan schema 2)
    DIET_PLAN_SCHEMA_VERSION,
    DIET_PLAN_DAY_TYPES,
    DIET_PLAN_DAY_TYPE_LABELS,
    DIET_PLAN_MEALS,
    DIET_PLAN_UNITS,
    DIET_PLAN_OPTION_TYPES,
    DIET_PLAN_OPTION_LABELS,
    DIET_PLAN_LIMITS,
    dietPlanDayLabel,
    dietPlanMealLabel,
    dietPlanUnitLabel,
    mealSortIndex,
    sortDietPlanMeals,
    normalizeDietAmount,
    createDietAmount,
    createDietPlanBlock,
    createDietPlanItem,
    createDietPlanOption,
    createDietPlanMeal,
    createDietPlanDay,
    createEmptyDietPlan,
    validateDietPlanSoft,
    dietPlanSummary,
    scalePortionText,
    // Template equivalenze (organization-scoped)
    EQUIVALENCE_TEMPLATE_SCHEMA_VERSION,
    equivalenceTemplateScaled
  };
});
