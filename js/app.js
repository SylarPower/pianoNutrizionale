const DAY_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_NAMES = {
  monday: "Lunedì", tuesday: "Martedì", wednesday: "Mercoledì", thursday: "Giovedì",
  friday: "Venerdì", saturday: "Sabato", sunday: "Domenica"
};
const DAY_BY_JS_INDEX = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MEAL_SLOTS = [
  { id: "breakfast", label: "Colazione", shortLabel: "COLAZ.", emoji: "🌅" },
  { id: "snack1", label: "Spuntino mattina", shortLabel: "SPUNT.", emoji: "🍎" },
  { id: "lunch", label: "Pranzo", shortLabel: "PRANZO", emoji: "☀️" },
  { id: "snack2", label: "Merenda", shortLabel: "MERENDA", emoji: "🥄" },
  { id: "dinner", label: "Cena", shortLabel: "CENA", emoji: "🌙" }
];
const SHOP_CATEGORY_ORDER = ["🥩 Carne", "🐟 Pesce", "🥚 Uova e latticini", "🫘 Legumi", "🍚 Carboidrati", "🥬 Verdura", "🍑 Frutta", "🥫 Dispensa", "🌿 Spezie e aromi"];
const RECIPE_LIBRARY_SECTION_DEFAULTS = Object.fromEntries(MEAL_SLOTS.map(slot => [slot.id, false]));
// Feature flag Sezione Prezzi (momentaneamente DISATTIVATA): la vista, logica
// e dati NON vengono cancellati, soltanto il menu e la rotta vengono nascosti.
// Riattivazione globale: PRICES_FEATURE_ENABLED = true.
// Riattivazione mirata per account: pricesEnabledForUids in js/saas-config.js.
const PRICES_FEATURE_ENABLED = false;

// ---- Catalogo globale ingredienti (fonte unica: identità e solo identità) ----
// Il catalogo vive in Firestore (globalIngredientCatalog/current) ed è leggibile
// da ogni utente autenticato. In memoria resta solo identità: nomi, alias,
// token di ricerca, categoria, famiglia, flag vegetariani/vegani. Le dosi non
// esistono qui: arrivano dalla struttura dieta assegnata dal professionista.
let ingredientCatalogCache = null;
let ingredientCatalogLoadPromise = null;

function catalogFromProfile() {
  const profile = appState?.saasContext?.profile;
  return profile?.catalog || null;
}

// Carica il catalogo globale: prima quello incorporato nel profilo assegnato
// (già verificato dal server), poi Firestore, infine la cache locale per uid.
async function loadGlobalIngredientCatalogIndex() {
  if (ingredientCatalogCache) return ingredientCatalogCache;
  const fromProfile = catalogFromProfile();
  if (fromProfile?.ingredients?.length && window.PianoDomain?.buildCatalogIndex) {
    ingredientCatalogCache = PianoDomain.buildCatalogIndex(fromProfile);
    return ingredientCatalogCache;
  }
  if (ingredientCatalogLoadPromise) return ingredientCatalogLoadPromise;
  ingredientCatalogLoadPromise = (async () => {
    let catalog = null;
    try {
      if (typeof window.getGlobalIngredientCatalog === "function") {
        catalog = await window.getGlobalIngredientCatalog();
      }
    } catch (_) { /* offline: si usa la cache locale */ }
    if (!catalog?.ingredients?.length && appState.user?.uid) {
      catalog = readLocalJsonFor(appState.user.uid, "ingredient_catalog", null);
    }
    const index = window.PianoDomain?.buildCatalogIndex && catalog?.ingredients?.length
      ? PianoDomain.buildCatalogIndex(catalog)
      : { items: [], byId: new Map(), byAlias: new Map(), familiesById: new Map(), categoriesById: new Map(), familiesByKey: new Map() };
    if (catalog?.ingredients?.length && appState.user?.uid) {
      writeLocalJsonFor(appState.user.uid, "ingredient_catalog", catalog);
    }
    ingredientCatalogCache = index;
    return index;
  })();
  return ingredientCatalogLoadPromise;
}

function invalidateIngredientCatalogCache() {
  ingredientCatalogCache = null;
  ingredientCatalogLoadPromise = null;
}

function buildLocalCatalogIndex() {
  // Accesso sincrono al catalogo già caricato (o a quello del profilo): chi
  // chiama prima dell'init riceve un indice vuoto, nessun catalogo sintetico.
  if (ingredientCatalogCache) return ingredientCatalogCache;
  const fromProfile = catalogFromProfile();
  if (fromProfile?.ingredients?.length && window.PianoDomain?.buildCatalogIndex) {
    ingredientCatalogCache = PianoDomain.buildCatalogIndex(fromProfile);
    return ingredientCatalogCache;
  }
  return { items: [], byId: new Map(), byAlias: new Map(), familiesById: new Map(), categoriesById: new Map(), familiesByKey: new Map() };
}

function ingredientCatalogMatches(query) {
  const index = buildLocalCatalogIndex();
  return window.PianoDomain?.searchCatalog ? PianoDomain.searchCatalog(index, query, { limit: 8 }) : [];
}

// Riconoscimento con stati distinti: resolved / recognized-generic / ambiguous
// / unknown. Un testo noto ma ambiguo (es. «tonno») NON viene mai mappato a un
// ingredientId a caso; un ingredientId valido non si perde finché il testo
// resta compatibile con l'ingrediente scelto.
function recognizeIngredientText(text) {
  if (!window.PianoDomain?.recognizeIngredient) return { status: "unknown", candidates: [] };
  return PianoDomain.recognizeIngredient(buildLocalCatalogIndex(), String(text || ""));
}

// Meta per riga ingrediente dell'editor: ingredientId persistito + stato di
// riconoscimento. unknown → il cliente può proporre categoria e famiglia.
function editorIngredientMeta(recipe) {
  if (!Array.isArray(recipe._ingredientMeta) || recipe._ingredientMeta.length !== recipe.ingredients.length) {
    recipe._ingredientMeta = recipe.ingredients.map(ingredient => {
      const name = String(ingredient.name || "").trim();
      const recognition = name ? recognizeIngredientText(name) : { status: "unknown", candidates: [] };
      return {
        ingredientId: ingredient.ingredientId || (recognition.status === "resolved" ? recognition.ingredientId : ""),
        recognitionStatus: recognition.status,
        recognizedFamilyId: recognition.familyId || null
      };
    });
  }
  return recipe._ingredientMeta;
}

let editorSuggestActiveIndex = -1;
function editorSuggestBox(index) {
  return document.getElementById(`ing-suggest-${index}`);
}
function hideEditorSuggest(index) {
  editorSuggestActiveIndex = -1;
  const box = editorSuggestBox(index);
  if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
  document.getElementById(`edit-ing-name-${index}`)?.setAttribute("aria-expanded", "false");
}
function hideOtherEditorSuggests(index) {
  (currentModal?.recipe?.ingredients || []).forEach((_, i) => { if (i !== index) hideEditorSuggest(i); });
}
function renderEditorSuggestions(index) {
  const recipe = currentModal?.recipe;
  const box = editorSuggestBox(index);
  const input = document.getElementById(`edit-ing-name-${index}`);
  if (!recipe || !box || !input) return;
  const raw = input.value || "";
  const meta = editorIngredientMeta(recipe)[index];
  if (!raw.trim()) {
    hideEditorSuggest(index);
    return;
  }
  const matches = ingredientCatalogMatches(raw);
  // Riconoscimento con stati distinti: solo «resolved» fissa l'ingredientId;
  // gli stati intermedi mantengono l'id già scelto se compatibile.
  const recognition = recognizeIngredientText(raw);
  if (recognition.status === "resolved") {
    meta.ingredientId = recognition.ingredientId;
    meta.recognitionStatus = "resolved";
    meta.recognizedFamilyId = recognition.familyId || null;
  } else if (meta.ingredientId && !ingredientIdStillMatches(raw, meta.ingredientId)) {
    meta.ingredientId = "";
    meta.recognitionStatus = recognition.status;
    meta.recognizedFamilyId = recognition.familyId || null;
  } else {
    meta.recognitionStatus = recognition.status;
    meta.recognizedFamilyId = recognition.familyId || null;
  }
  editorSuggestActiveIndex = -1;
  const missingHtml = recognition.status === "unknown"
    ? `<div class="ing-suggest-missing" role="note">ⓘ «${escapeHtml(raw)}» non è nel catalogo: puoi segnalarlo per farlo aggiungere.</div>`
    : recognition.status === "ambiguous"
      ? `<div class="ing-suggest-missing" role="note">ⓘ «${escapeHtml(raw)}» è ambiguo: scegli la voce corretta dall'elenco.</div>`
      : "";
  box.innerHTML = `${matches.map((item, i) => `
    <button type="button" class="ing-suggest-item" role="option" aria-selected="false" data-idx="${i}" data-id="${escapeAttr(item.ingredientId)}" data-name="${escapeAttr(item.displayName)}" data-family-id="${escapeAttr(item.familyId || "")}" onmousedown="event.preventDefault()" onclick="selectEditorSuggestion(${index}, ${i})"><span>${escapeHtml(item.displayName)}</span><small>${escapeHtml(item.categoryLabel || item.categoryId || "")}${item.matchedAlias ? ` · alias: ${escapeHtml(item.matchedAlias)}` : ""}</small></button>`).join("")}${missingHtml}`;
  box.classList.remove("hidden");
  input.setAttribute("aria-expanded", "true");
}
function updateEditorSuggestionSelection(index) {
  const box = editorSuggestBox(index);
  if (!box) return;
  box.querySelectorAll(".ing-suggest-item").forEach(item => {
    item.classList.toggle("active", Number(item.dataset.idx) === editorSuggestActiveIndex);
    item.setAttribute("aria-selected", String(Number(item.dataset.idx) === editorSuggestActiveIndex));
  });
}
window.selectEditorSuggestion = function(index, i) {
  const box = editorSuggestBox(index);
  const item = box?.querySelector(`.ing-suggest-item[data-idx="${i}"]`);
  if (!item) return;
  const input = document.getElementById(`edit-ing-name-${index}`);
  if (input) input.value = item.dataset.name;
  const meta = editorIngredientMeta(currentModal.recipe)[index];
  meta.ingredientId = item.dataset.id;
  meta.recognitionStatus = "resolved";
  meta.recognizedFamilyId = item.dataset.familyId || null;
  hideEditorSuggest(index);
  input?.focus();
};
window.editorIngredientInput = function(index, input) {
  hideOtherEditorSuggests(index);
  const recipe = currentModal?.recipe;
  if (!recipe) return;
  const meta = editorIngredientMeta(recipe)[index];
  if (!input.value.trim()) {
    meta.ingredientId = "";
    meta.recognitionStatus = "unknown";
    meta.recognizedFamilyId = null;
  }
  renderEditorSuggestions(index);
};

// Un ingredientId scelto resta valido finché il testo resta compatibile con
// l'ingrediente (nome, alias o token condivisi): l'id non si perde per una
// modifica leggera della dicitura.
function ingredientIdStillMatches(text, ingredientId) {
  if (!window.PianoDomain?.ingredientIdAfterEdit) return Boolean(ingredientId);
  return Boolean(PianoDomain.ingredientIdAfterEdit(buildLocalCatalogIndex(), text, ingredientId));
}
window.editorIngredientBlur = function(index) {
  setTimeout(() => hideEditorSuggest(index), 180);
};
window.editorIngredientKeydown = function(index, event) {
  const box = editorSuggestBox(index);
  const items = box ? [...box.querySelectorAll(".ing-suggest-item")] : [];
  const boxOpen = Boolean(items.length && !box.classList.contains("hidden"));
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!boxOpen) return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    editorSuggestActiveIndex = (editorSuggestActiveIndex + delta + items.length) % items.length;
    updateEditorSuggestionSelection(index);
    return;
  }
  if (event.key === "Enter" && boxOpen) {
    event.preventDefault();
    const target = editorSuggestActiveIndex >= 0 ? editorSuggestActiveIndex : 0;
    window.selectEditorSuggestion(index, target);
    return;
  }
  if (event.key === "Escape") hideEditorSuggest(index);
};

let appState = {
  user: null,
  recipes: [],
  recipesById: {},
  plan: null,
  deviceSettings: null,
  shopping: null,
  household: null,
  saasContext: { state: "feature-disabled" },
  saasPolicy: { mode: "legacy-disabled", migrationRequired: false },
  clientLink: null
};
let appStarted = false;
let currentModal = null;
let editMode = false;
let shopSettingsVisible = false;
let toastTimeout = null;
let toastRemoveTimeout = null;
let stopHouseholdObserver = null;
let stopSharedDataObserver = null;
let activeHouseholdId = null;
const modalOutsideCloseState = new Map();

// ---- Session cache per avvio veloce ----
function readSessionCache() {
  try { return JSON.parse(localStorage.getItem("pn_session") || "null"); } catch (_) { return null; }
}
function writeSessionCache(session) {
  try {
    if (session) localStorage.setItem("pn_session", JSON.stringify(session));
    else localStorage.removeItem("pn_session");
  } catch (_) {}
}
function writeLocalJsonFor(uid, name, value) {
  try { localStorage.setItem(`pn_${uid}_${name}`, JSON.stringify(value)); } catch (_) {}
}

function readLocalJsonFor(uid, name, fallback) {
  try {
    const value = localStorage.getItem(`pn_${uid}_${name}`);
    return value ? JSON.parse(value) : JSON.parse(JSON.stringify(fallback));
  } catch (_) { return JSON.parse(JSON.stringify(fallback)); }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getTodayKey() {
  return DAY_BY_JS_INDEX[new Date().getDay()];
}

function getDayType(dayKey) {
  return appState.plan?.days?.[dayKey]?.type || "rest";
}

function getRecipe(recipeId) {
  return appState.recipesById[recipeId] || null;
}

function getPlannedRecipe(dayKey, slot) {
  const recipeId = appState.plan?.days?.[dayKey]?.[slot];
  return getRecipe(recipeId);
}

// ---- Vista «dosi allineate alla mia dieta» ----
// Il cliente sceglie una sola preferenza (piano.alignedDosesEnabled): vedere
// ovunque le dosi originali delle ricette oppure quelle allineate a quanto
// indicato dal nutrizionista nella struttura assegnata. È una scelta di
// VISUALIZZAZIONE: settimana, ricettario, modale e spesa mostrano dosi
// allineate, ma la ricetta originale non viene mai riscritta.

let dietEngineCache = null;
let dietEngineProfileKey = null;

function mealIdForSlot(slot) {
  return window.PianoDomain?.MEAL_ID_BY_SLOT?.[slot] || null;
}

// Motore della dieta assegnata (revisione confermata). Null se non c'è un
// profilo valido: in quel caso esistono solo le dosi originali.
function getDietEngine() {
  if (!window.PianoDomain?.buildDietEngine) return null;
  const profile = appState.saasContext?.profile || null;
  const key = profile ? `${profile.assignmentId}:${profile.structureRevisionId}` : "none";
  if (dietEngineCache && dietEngineProfileKey === key) return dietEngineCache;
  dietEngineCache = profile ? PianoDomain.buildDietEngine(profile) : null;
  dietEngineProfileKey = key;
  return dietEngineCache;
}

function invalidateDietEngine() {
  dietEngineCache = null;
  dietEngineProfileKey = null;
}

// Le dosi allineate valgono SOLO con profilo assegnato e confermato, in
// ambito personale (mai nei piani famiglia condivisi) e con l'interruttore
// del piano acceso.
function planAlignedDosesEffective() {
  if (!window.PianoDomain) return false;
  if (appState.household) return false;
  if (appState.saasPolicy?.mode !== "assigned") return false;
  return PianoDomain.planAlignedDosesEnabled(appState.plan) !== false;
}

// Ricetta effettiva per la visualizzazione: con dosi allineate attive usa
// alignRecipeToDiet (per pasto e tipo giornata), altrimenti l'originale.
// Risultato: { recipe, aligned, optionId, added, omitted, changed }.
function resolvePlannedRecipe(recipe, dayKey, slot) {
  const base = { recipe, aligned: false, optionId: null, added: [], omitted: [], changed: false };
  if (!recipe || !window.PianoDomain?.alignRecipeToDiet) return base;
  if (!planAlignedDosesEffective()) return base;
  const engine = getDietEngine();
  if (!engine) return base;
  const dayType = dayKey ? getDayType(dayKey) : (currentModal?.dayType || getRecipePreviewDayType());
  const mealId = mealIdForSlot(slot || recipe.slot);
  if (!mealId) return base;
  const aligned = PianoDomain.alignRecipeToDiet(recipe, engine, mealId, dayType);
  if (!aligned) return base;
  return {
    recipe: alignedRecipeForView(recipe, aligned),
    aligned: true,
    optionId: aligned.optionId,
    added: aligned.added || [],
    omitted: aligned.omitted || [],
    changed: Boolean(aligned.changed)
  };
}

// Il risultato dell'allineamento diventa una ricetta «per la vista»: stesse
// proprietà, porzioni riscritte solo in memoria (mai salvate).
function alignedRecipeForView(recipe, aligned) {
  return {
    ...recipe,
    ingredients: (aligned.ingredients || []).map(item => ({
      ...item,
      portions: { single: item.amountText || (item.portions?.single ?? "") }
    }))
  };
}

// Risolutore per la spesa aggregata (domain.aggregateShopping): passa le dosi
// della vista allineata quando l'interruttore è attivo.
function shoppingResolveRecipe(recipe, slot, dayType) {
  if (!planAlignedDosesEffective()) return null;
  const engine = getDietEngine();
  if (!engine) return null;
  const mealId = mealIdForSlot(slot);
  if (!mealId) return null;
  const aligned = PianoDomain.alignRecipeToDiet(recipe, engine, mealId, dayType);
  return aligned ? alignedRecipeForView(recipe, aligned) : null;
}

function getRecipeDisplayName(recipe) {
  return recipe?.name || "Ricetta non disponibile";
}

function getSlotMeta(slotId) {
  return MEAL_SLOTS.find(slot => slot.id === slotId) || { id: slotId, label: slotId, shortLabel: slotId, emoji: "🍽️" };
}

function normalizePortionProfile(profile) {
  return profile === "couple" ? "couple" : "single";
}

function getPortionProfile() {
  return normalizePortionProfile(appState.deviceSettings?.portionProfile);
}

function getPortionValue(ingredient, profile) {
  const portions = ingredient?.portions || {};
  // Una sola quantità originale per ingrediente: la UI legge solo `single`.
  return portions.single ?? "—";
}

function isEmptyPortion(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return !normalized || normalized === "—" || normalized === "-";
}

function getIngredientDisplay(ingredient) {
  const amount = getPortionValue(ingredient, getPortionProfile());
  return getPortionProfile() === "couple"
    ? applyCoupleMultiplier(amount)
    : amount;
}

// Moltiplicatore porzioni: vive solo nell'app clienti e solo con il profilo
// coppia selezionato. Scala la dose singola mostrata e i totali derivati; il
// valore di default è ×2, coerente con il profilo "2 persone".
function getCoupleMultiplier() {
  const raw = Number(appState.deviceSettings?.coupleMultiplier);
  if (!Number.isFinite(raw) || raw <= 0) return 2;
  return Math.min(3, Math.max(0.5, Math.round(raw * 100) / 100));
}

function formatMultiplier(value) {
  const num = Math.round(Number(value) * 100) / 100;
  return `×${String(num).replace(".", ",")}`;
}

function applyCoupleMultiplier(value) {
  if (getPortionProfile() !== "couple") return value;
  const multiplier = getCoupleMultiplier();
  if (multiplier === 1 || isEmptyPortion(value)) return value;
  return window.PianoDomain?.scalePortionText
    ? PianoDomain.scalePortionText(String(value), multiplier)
    : value;
}

window.changeCoupleMultiplier = function (delta) {
  const raw = (getCoupleMultiplier() + Number(delta || 0));
  const stepped = Math.round(raw * 20) / 20;
  const next = Math.min(3, Math.max(0.5, Math.round(stepped * 100) / 100));
  appState.deviceSettings = appState.deviceSettings || getLocalDeviceSettings();
  appState.deviceSettings.coupleMultiplier = next;
  saveLocalDeviceSettings(appState.deviceSettings);
  renderGlobalHeader();
  handleRoute();
};

function getPortionProfileLabel(profile = getPortionProfile()) {
  return profile === "couple" ? "2 persone" : "1 persona";
}

function getProfileLabel() {
  const profile = getPortionProfile();
  if (profile === "couple") {
    const multiplier = getCoupleMultiplier();
    return multiplier !== 2 ? `${getPortionProfileLabel(profile)} ${formatMultiplier(multiplier)}` : getPortionProfileLabel(profile);
  }
  return getPortionProfileLabel(profile);
}

function normalizeRecipeLibraryState(state = {}) {
  const openSections = { ...RECIPE_LIBRARY_SECTION_DEFAULTS };
  const savedSections = state?.openSections && typeof state.openSections === "object" ? state.openSections : {};
  Object.keys(openSections).forEach(slotId => {
    openSections[slotId] = Boolean(savedSections[slotId]);
  });
  return {
    searchQuery: String(state?.searchQuery || "").trim(),
    openSections
  };
}

function getRecipeLibraryState() {
  return normalizeRecipeLibraryState(appState.deviceSettings?.recipeLibraryState || {});
}

function saveRecipeLibraryState(nextState) {
  const normalized = normalizeRecipeLibraryState(nextState);
  appState.deviceSettings = appState.deviceSettings || getLocalDeviceSettings();
  appState.deviceSettings.recipeLibraryState = normalized;
  saveLocalDeviceSettings(appState.deviceSettings);
  return normalized;
}

function updateRecipeLibraryState(updater) {
  const current = getRecipeLibraryState();
  const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
  return saveRecipeLibraryState(next);
}

function resolveShopCategoryOrder(extraCategories = [], savedOrder = appState.deviceSettings?.shopCategoryOrder) {
  if (window.PianoDomain?.resolveShopCategoryOrder) {
    return PianoDomain.resolveShopCategoryOrder(savedOrder, SHOP_CATEGORY_ORDER, extraCategories);
  }
  const unique = values => [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
  const saved = unique(savedOrder).filter(category => SHOP_CATEGORY_ORDER.includes(category));
  const resolved = saved.concat(SHOP_CATEGORY_ORDER.filter(category => !saved.includes(category)));
  return resolved.concat(unique(extraCategories).filter(category => !resolved.includes(category)));
}

function saveShopCategoryOrder(order) {
  appState.deviceSettings = appState.deviceSettings || getLocalDeviceSettings();
  appState.deviceSettings.shopCategoryOrder = resolveShopCategoryOrder([], order);
  saveLocalDeviceSettings(appState.deviceSettings);
  return appState.deviceSettings.shopCategoryOrder;
}

// Il pasto pianificato usa la vista allineata? (badge e dosi in riga)
function recipeUsesAlignedDoses(recipe, dayKey, slot) {
  return resolvePlannedRecipe(recipe, dayKey, slot).aligned;
}

function normalizeRecipeSchema(recipe) {
  // Normalizza la ricetta allo schema corrente: ingredientId stabile, porzione
  // singola e note unificate.
  return window.PianoDomain ? PianoDomain.migrateRecipe(recipe) : clone(recipe);
}

// Raw JSON dell'ultimo stato applicato (applyState, snapshot realtime,
// salvataggi): i refresh di avvio e gli snapshot lo confrontano per saltare
// riapplicazioni e re-render quando il contenuto non è cambiato.
const lastAppliedRaw = { recipes: null, plan: null, shopping: null };

function setRecipes(recipes) {
  lastAppliedRaw.recipes = JSON.stringify(recipes);
  const normalizedRecipes = recipes.map(normalizeRecipeSchema);

  appState.recipes = normalizedRecipes;
  appState.recipesById = Object.fromEntries(
    normalizedRecipes.map(recipe => [recipe.id, recipe])
  );
}

// Batch cooking dinamico basato su batchTemplates strutturati:
// cena del giorno corrente (anchor) + pranzo futuro (target).
// Il tipo A/R del giorno corrente non disattiva mai il batch: conta solo
// il tipo A/R del giorno target per le quantità.
function getActiveBatch(dayKey) {
  if (!window.PianoDomain || !appState.plan?.days?.[dayKey]) return [];
  const templates = appState.plan.batchTemplates || [];
  const batches = PianoDomain.activeBatch(
    dayKey,
    appState.plan,
    templates,
    appState.recipesById,
    getPortionProfile(),
    {
      resolveRecipe: shoppingResolveRecipe,
      quantityMultiplier: getPortionProfile() === "couple" ? getCoupleMultiplier() : 1
    }
  );
  // Batch automatico "doppia porzione": stessa ricetta a cena e al pranzo
  // successivo (anche via cross-slot). Le dosi sono la somma cena + pranzo.
  const dinnerId = appState.plan.days[dayKey]?.dinner;
  const common = PianoDomain.commonRecipeBatch(dayKey, appState.plan, appState.recipesById, getPortionProfile(), {
    resolveRecipe: shoppingResolveRecipe,
    quantityMultiplier: getPortionProfile() === "couple" ? getCoupleMultiplier() : 1
  });
  if (common && dinnerId) {
    const alreadyCovered = batches.some(batch => batch.targetDay === common.targetDay && batch.template?.target?.recipeId === dinnerId);
    if (!alreadyCovered) batches.push(common);
  }
  return batches;
}

function showToast(message, isError = false) {
  let toast = document.getElementById("app-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-toast";
    toast.className = "app-toast hidden";
    document.body.appendChild(toast);
  }
  clearTimeout(toastTimeout);
  clearTimeout(toastRemoveTimeout);
  toast.textContent = message;
  toast.classList.toggle("toast-error", isError);
  toast.classList.remove("hidden", "toast-exit");
  toastTimeout = setTimeout(() => {
    toast.classList.add("toast-exit");
    toastRemoveTimeout = setTimeout(() => toast.remove(), 250);
  }, 2800);
}

function setLoading(message = "Caricamento…") {
  if (window.PianoLoading) {
    window.PianoLoading.start(message);
    return;
  }
  const overlay = document.getElementById("loading-overlay");
  const text = document.getElementById("loading-message");
  if (text) text.textContent = message;
  overlay?.classList.remove("hidden");
}

function clearLoading() {
  if (window.PianoLoading) {
    window.PianoLoading.stop();
    return;
  }
  document.getElementById("loading-overlay")?.classList.add("hidden");
}

function modalOverlayTarget(target, modalId, modal) {
  return target === modal || target?.id === modalId;
}

function bindModalOutsideClose(modalId, onClose) {
  const modal = document.getElementById(modalId);
  if (!modal || modal.dataset.outsideCloseBound === "true") return;
  modal.dataset.outsideCloseBound = "true";
  modalOutsideCloseState.set(modalId, false);
  const armClose = event => {
    modalOutsideCloseState.set(modalId, modalOverlayTarget(event.target, modalId, modal));
  };
  const resetClose = () => {
    modalOutsideCloseState.set(modalId, false);
  };
  modal.addEventListener("mousedown", armClose);
  modal.addEventListener("touchstart", armClose);
  modal.addEventListener("click", event => {
    if (modalOverlayTarget(event.target, modalId, modal) && modalOutsideCloseState.get(modalId)) onClose();
    resetClose();
  });
  modal.addEventListener("touchcancel", resetClose);
}

// Chiave locale NON legata all'account: replica la scelta del tema fatta
// dall'intestazione così la schermata di accesso, l'overlay di caricamento
// e il primo paint dopo un refresh partono già nel tema giusto, prima che
// Firebase risolva la sessione e carichi le preferenze dell'utente.
const THEME_BOOT_KEY = "pn_theme";

function readBootTheme() {
  try { return localStorage.getItem(THEME_BOOT_KEY) === "dark"; } catch (_) { return false; }
}

function writeBootTheme(isDark) {
  try { localStorage.setItem(THEME_BOOT_KEY, isDark ? "dark" : "light"); } catch (_) {}
}

// Tema chiaro (default) oppure AMOLED (nero puro). Le variabili colore vivono
// in css/style.css sotto `html.dark-mode`: qui si commuta solo la classe, su
// <html> e su <body>, così anche login e overlay seguono il tema.
function applyTheme(isDark) {
  const dark = Boolean(isDark);
  document.documentElement?.classList.toggle("dark-mode", dark);
  document.body?.classList.toggle("dark-mode", dark);
  writeBootTheme(dark);

  const themeMeta = document.querySelector('meta[name="theme-color"]');

  if (themeMeta) {
    themeMeta.setAttribute(
      "content",
      dark ? "#000000" : "#3D9970"
    );
  }
}

// Applicato subito al caricamento dello script (prima di DOMContentLoaded e
// molto prima dell'auth): evita il lampo di tema chiaro al riavvio della PWA.
applyTheme(readBootTheme());

// --- Invito con EMAIL REALE: link `#/invito/<token>` (ADR 0001) ---
// L'email, il nome e il cognome arrivano dal nutrizionista e non si modificano
// qui; il cliente sceglie solo la password. Il collegamento si attiva dopo la
// verifica email. I vecchi account vengono mantenuti solo lato server per la
// migrazione, ma non hanno più un percorso pubblico nella piattaforma.
const PENDING_EMAIL_INVITE_STORAGE = "pn_pending_email_invite_token";
let pendingEmailInviteToken = null;
let emailInvitePreview = null;
let inviteFlowActive = false;

function readEmailInviteTokenFromHash() {
  const match = window.location.hash.match(/^#\/invito\/([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

function loadPendingEmailInviteToken() {
  const fromHash = readEmailInviteTokenFromHash();
  if (fromHash) {
    try { sessionStorage.setItem(PENDING_EMAIL_INVITE_STORAGE, fromHash); } catch (_) {}
    return fromHash;
  }
  try { return sessionStorage.getItem(PENDING_EMAIL_INVITE_STORAGE) || null; } catch (_) { return null; }
}

function clearPendingEmailInviteToken() {
  pendingEmailInviteToken = null;
  try { sessionStorage.removeItem(PENDING_EMAIL_INVITE_STORAGE); } catch (_) {}
  // Il link d'invito si toglie dalla barra degli indirizzi solo se è ancora lì:
  // l'invito può essere riscattato dopo l'avvio dell'app, quando la rotta
  // corrente (#week, #settings…) non va toccata.
  if (readEmailInviteTokenFromHash()) {
    try { history.replaceState(history.state, document.title, window.location.pathname + window.location.search); } catch (_) {}
  }
}

// Invito già usato per la registrazione e in ATTESA DI ATTIVAZIONE.
// Il server non consuma il token finché l'email non è verificata (ADR 0001):
// il token dell'invito NON si cancella, resta in sessione finché il riscatto
// non risponde `link-active`. Qui si ricorda solo che quel token non è più un
// link da aprire: non deve riportare alla schermata di registrazione (l'account
// esiste già) e non deve più far credere che ci sia un invito da riscattare.
const EMAIL_INVITE_AWAITING_LINK_STORAGE = "pn_email_invite_awaiting_link";

function normalizeInviteToken(token) {
  const clean = String(token || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(clean) ? clean : null;
}

function readEmailInviteAwaitingLink() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(EMAIL_INVITE_AWAITING_LINK_STORAGE) || "null");
    return raw && normalizeInviteToken(raw.token) ? raw : null;
  } catch (_) {
    return null;
  }
}

function markEmailInviteAwaitingLink(token, email) {
  const clean = normalizeInviteToken(token);
  if (!clean) return null;
  const value = { token: clean, email: normalizeEmailAddress(email) };
  try { sessionStorage.setItem(EMAIL_INVITE_AWAITING_LINK_STORAGE, JSON.stringify(value)); } catch (_) {}
  return value;
}

function clearEmailInviteAwaitingLink() {
  try { sessionStorage.removeItem(EMAIL_INVITE_AWAITING_LINK_STORAGE); } catch (_) {}
}

function isEmailInviteAwaitingLink(token) {
  const clean = normalizeInviteToken(token);
  const awaiting = readEmailInviteAwaitingLink();
  return Boolean(clean && awaiting && awaiting.token === clean);
}

// Il token in attesa di attivazione vale solo per l'account a cui è intestato:
// mai riusato per un altro utente o un altro indirizzo.
function awaitingLinkInviteTokenFor(email) {
  const awaiting = readEmailInviteAwaitingLink();
  if (!awaiting?.token) return null;
  const target = normalizeEmailAddress(email);
  return target && awaiting.email === target ? awaiting.token : null;
}

function showEmailInviteScreen({ clear = true } = {}) {
  document.body.classList.add("auth-locked");
  document.getElementById("login-screen")?.classList.add("hidden");
  document.getElementById("email-invite-screen")?.classList.remove("hidden");
  document.getElementById("app-container")?.classList.add("hidden");
  document.querySelector(".bottom-nav")?.classList.add("hidden");
  document.getElementById("global-header-container")?.remove();
  if (clear) clearLoading();
  setTimeout(() => document.getElementById("email-invite-password")?.focus(), 50);
}

// I dati mostrati vengono SEMPRE dal server (anteprima dell'invito): il client
// non li deduce dal link e non li rende modificabili.
function renderEmailInvitePreview() {
  const preview = emailInvitePreview;
  const stateEl = document.getElementById("email-invite-state");
  const form = document.getElementById("email-invite-form");
  if (!preview || preview.status !== "valid") {
    form?.classList.add("hidden");
    const messaggi = {
      expired: "Questo invito è scaduto: chiedi un nuovo link al tuo nutrizionista.",
      used: "Questo invito è già stato utilizzato: accedi con la tua email oppure chiedi un nuovo invito.",
      revoked: "Questo invito è stato annullato: chiedi un nuovo link al tuo nutrizionista.",
      superseded: "Questo link è stato sostituito da uno più recente: usa l'ultimo link ricevuto.",
      "not-found": "Link invito non valido: chiedi un nuovo link al tuo nutrizionista.",
      "preview-error": "Non riusciamo a caricare i dati dell’invito. Controlla la connessione e riapri il link tra poco."
    };
    if (stateEl) {
      stateEl.textContent = messaggi[preview?.status] || messaggi["not-found"];
      stateEl.classList.remove("hidden");
    }
    return;
  }
  form?.classList.remove("hidden");
  stateEl?.classList.add("hidden");
  const emailEl = document.getElementById("email-invite-email");
  const nameEl = document.getElementById("email-invite-name");
  const nutritionistEl = document.getElementById("email-invite-nutritionist");
  if (emailEl) emailEl.textContent = preview.email || "—";
  if (nameEl) nameEl.textContent = [preview.firstName, preview.lastName].filter(Boolean).join(" ") || "—";
  if (nutritionistEl) {
    nutritionistEl.textContent = [preview.nutritionistName, preview.organizationName].filter(Boolean).join(" · ") || "—";
  }
}

function mapEmailInviteError(error) {
  const code = String(error?.code || "");
  if (code === "auth/email-already-in-use") return "Esiste già un account con questa email: accedi con la tua password oppure usa “Password dimenticata?”.";
  if (code === "auth/invalid-email") return error.message;
  if (code === "auth/weak-password") return "La password deve avere almeno 8 caratteri.";
  if (code === "auth/network-request-failed" || code.endsWith("unavailable")) return "Connessione assente: la registrazione richiede internet.";
  if (code.endsWith("not-found")) return "Invito non valido o già utilizzato: chiedi un nuovo link al tuo nutrizionista.";
  if (code.endsWith("failed-precondition") && error?.message) return error.message;
  if (code.endsWith("permission-denied") && error?.message) return error.message;
  return "Registrazione non riuscita. Riprova tra poco o chiedi un nuovo link al tuo nutrizionista.";
}

function setupEmailInviteForm() {
  const form = document.getElementById("email-invite-form");
  if (!form || form.dataset.ready) return;
  form.dataset.ready = "true";
  const toggle = document.getElementById("email-invite-toggle");
  toggle?.addEventListener("click", () => {
    const input = document.getElementById("email-invite-password");
    if (!input) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    toggle.setAttribute("aria-label", show ? "Nascondi password" : "Mostra password");
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const password = document.getElementById("email-invite-password")?.value || "";
    const button = document.getElementById("email-invite-submit");
    const errorEl = document.getElementById("email-invite-error");
    errorEl.textContent = "";
    if (!emailInvitePreview || emailInvitePreview.status !== "valid") {
      errorEl.textContent = "Link invito non più valido: chiedi un nuovo link al tuo nutrizionista.";
      return;
    }
    if (String(password).length < 8) {
      errorEl.textContent = "La password deve avere almeno 8 caratteri.";
      return;
    }
    button.disabled = true;
    button.textContent = "Creazione account…";
    inviteFlowActive = true;
    try {
      await signUpWithRealEmail(emailInvitePreview.email, password);
      const inviteToken = pendingEmailInviteToken || emailInvitePreview.token;
      const result = await redeemClientInvite(inviteToken, `invito-email-${Date.now()}`);
      document.getElementById("email-invite-screen")?.classList.add("hidden");
      if (isClientLinkActiveStatus(result?.status)) {
        // Collegamento attivo: solo ora il token dell'invito non serve più.
        clearPendingEmailInviteToken();
        clearEmailInviteAwaitingLink();
        showToast("Account creato e collegato al tuo nutrizionista ✅");
      } else if (result?.status === "email-verification-required") {
        // Account creato: il collegamento si attiva alla verifica dell'email.
        // Il token NON si cancella (il riscatto non è ancora `link-active`):
        // resta in attesa di attivazione e l'app lo riusa solo se l'utente
        // chiede esplicitamente di riprovare.
        markEmailInviteAwaitingLink(inviteToken, emailInvitePreview.email);
        try { await sendVerificationEmailToCurrentUser(); } catch (_) {}
        showToast("Account creato ✅ Controlla la tua email e verifica l'indirizzo per attivare il collegamento");
      } else {
        showToast("Account creato: chiedi al tuo nutrizionista di attivare il collegamento");
      }
    } catch (error) {
      const message = mapEmailInviteError(error);
      errorEl.textContent = /esiste già un account/i.test(message)
        ? message
        : `${message} Se l'account è stato creato, accedi con la tua email e la password appena scelta.`;
      // L'account può esistere anche se il riscatto non è andato a buon fine:
      // resta disconnesso per non mostrare dati mentre il link è da rifare.
      try { await signOutUser(); } catch (_) {}
    } finally {
      inviteFlowActive = false;
      button.disabled = false;
      button.textContent = "Crea l’account";
    }
  });
}

function showLogin() {
  document.body.classList.add("auth-locked");
  document.getElementById("email-invite-screen")?.classList.add("hidden");
  document.getElementById("login-screen")?.classList.remove("hidden");
  document.getElementById("app-container")?.classList.add("hidden");
  document.querySelector(".bottom-nav")?.classList.add("hidden");
  document.getElementById("global-header-container")?.remove();
  clearLoading();
  setTimeout(() => document.getElementById("login-username")?.focus(), 50);
}

// ---- Verifica dell'email (clienti reali) ----
// Il collegamento con il professionista resta inattivo finché l'email non è
// verificata (ADR 0001). L'account tecnico di test non ha una casella reale:
// per lui il banner non compare.
const VERIFICATION_RESEND_KEY = "pn_email_verification_last_sent";
const VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;

function isRealEmailAccount(user) {
  if (!user?.email || typeof isLegacyTestEmailAddress !== "function") return false;
  return !isLegacyTestEmailAddress(user.email);
}

function renderEmailVerificationBanner(user = appState.user) {
  const banner = document.getElementById("email-verification-banner");
  const text = document.getElementById("email-verification-text");
  if (!banner || !text) return;
  const needsVerification = Boolean(isRealEmailAccount(user) && user.emailVerified !== true);
  banner.classList.toggle("hidden", !needsVerification);
  const linked = Boolean(appState.clientLink?.link);
  // Il pulsante di attivazione serve solo a chi non è ancora collegato:
  // con collegamento attivo basta la verifica dell'indirizzo.
  const confirmButton = document.getElementById("email-verification-confirm");
  if (confirmButton) confirmButton.classList.toggle("hidden", !needsVerification || linked);
  if (!needsVerification) return;
  text.textContent = linked
    ? `Verifica il tuo indirizzo email (${user.email}) per proteggere l'accesso al tuo piano.`
    : `Verifica il tuo indirizzo email (${user.email}): il collegamento con il tuo nutrizionista si attiva appena confermi l'indirizzo.`;
}

async function refreshVerificationState() {
  try {
    const user = await reloadCurrentUser();
    if (user && appState.user) appState.user = { ...appState.user, emailVerified: user.emailVerified === true };
  } catch (_) {}
  renderEmailVerificationBanner(appState.user);
}

function setupVerificationBanner() {
  const button = document.getElementById("email-verification-resend");
  if (button && !button.dataset.ready) {
    button.dataset.ready = "true";
    button.addEventListener("click", async () => {
      const now = Date.now();
      let last = 0;
      try { last = Number(localStorage.getItem(VERIFICATION_RESEND_KEY) || 0); } catch (_) {}
      if (now - last < VERIFICATION_RESEND_COOLDOWN_MS) {
        showToast("Email già richiesta da poco: attendi un minuto prima di riprovare", true);
        return;
      }
      button.disabled = true;
      try {
        const result = await sendVerificationEmailToCurrentUser();
        if (result.ok && !result.alreadyVerified) {
          try { localStorage.setItem(VERIFICATION_RESEND_KEY, String(now)); } catch (_) {}
        }
        showToast(result.message, result.ok ? false : true);
        await refreshVerificationState();
      } catch (error) {
        showToast(error?.message || "Invio non riuscito: riprova tra poco", true);
      } finally {
        button.disabled = false;
      }
    });
  }

  // "Ho verificato: attiva il collegamento": rilegge la verifica dal server e,
  // se l'email risulta verificata, forza il rinnovo dell'ID token e richiama
  // il riscatto dell'invito. È la via manuale per chi ha appena confermato
  // l'indirizzo e non vuole attendere il prossimo avvio dell'app.
  const confirmButton = document.getElementById("email-verification-confirm");
  if (!confirmButton || confirmButton.dataset.ready) return;
  confirmButton.dataset.ready = "true";
  confirmButton.addEventListener("click", async () => {
    const label = confirmButton.textContent;
    confirmButton.disabled = true;
    confirmButton.textContent = "Attivazione…";
    try {
      const outcome = await activateClientLinkAfterVerification({
        useAwaitingInvite: true,
        feedback: "always"
      });
      if (outcome?.activated) await reloadSaasAfterLink();
      else await refreshVerificationState();
    } catch (error) {
      showToast(error?.message || "Attivazione non riuscita: riprova tra poco", true);
    } finally {
      confirmButton.disabled = false;
      confirmButton.textContent = label;
    }
  });
}

// ---- Attivazione del collegamento dopo la verifica email (ADR 0001) ----
// Alla registrazione il riscatto risponde `email-verification-required` e il
// backend NON consuma il token: finché l'email non è verificata il collegamento
// resta inattivo. La verifica avviene fuori dall'app (link nella casella di
// posta), quindi il riscatto va ritentato a ogni accesso e a ogni ricarica:
// appena l'account è un cliente con email reale, non ha ancora un collegamento
// attivo e l'email risulta verificata, si forza il rinnovo dell'ID token
// (`getIdToken(true)`: il claim `email_verified` in cache può essere vecchio) e
// si richiama il riscatto SENZA token — il server riconosce l'invito pendente
// dall'email autenticata e risponde `link-active` oppure `no-pending-invite`.
const LINK_ACTIVATION_MESSAGES = Object.freeze({
  "link-active": "Email verificata: collegamento con il tuo nutrizionista attivato ✅",
  "already-linked": "Collegamento con il tuo nutrizionista già attivo ✅",
  "no-pending-invite": "Nessun invito in attesa per questo indirizzo: chiedi un nuovo link al tuo nutrizionista.",
  "not-verified": "Email non ancora verificata: apri il link di verifica che ti abbiamo inviato e riprova.",
  error: "Attivazione del collegamento non riuscita: riprova tra poco."
});

let linkActivationInFlight = false;

async function activateClientLinkAfterVerification({
  user = appState.user,
  useAwaitingInvite = false,
  feedback = "success"
} = {}) {
  if (!window.PianoSaas?.config().enabled || typeof redeemClientInvite !== "function") return null;
  // Solo i clienti con email reale hanno un invito da riscattare: per l'account
  // tecnico di test il banner di verifica non compare nemmeno.
  if (!isRealEmailAccount(user)) return null;
  // Collegamento già attivo: non c'è nulla da attivare.
  if (appState.clientLink?.link) return null;
  if (linkActivationInFlight) return null;
  linkActivationInFlight = true;
  let outcome = { status: "error", activated: false };
  try {
    // `emailVerified` è il valore dell'ultimo token noto: si rilegge il profilo
    // dal server prima di decidere (la conferma arriva da fuori dall'app).
    try {
      const fresh = await reloadCurrentUser();
      if (fresh && appState.user) {
        appState.user = { ...appState.user, emailVerified: fresh.emailVerified === true };
      }
    } catch (_) {}
    if (appState.user?.emailVerified !== true) {
      outcome = { status: "not-verified", activated: false };
    } else {
      const idempotencyKey = `attivazione-collegamento-${appState.user.uid || "utente"}-${Date.now()}`;
      // Richiesta esplicita dell'utente: se l'invito è ancora in attesa in
      // questa scheda si ripresenta il token, che resta valido finché il
      // collegamento non è attivo. Percorso automatico (accesso/ricarica):
      // SENZA token, come previsto dal contratto del server.
      const awaitingToken = useAwaitingInvite
        ? awaitingLinkInviteTokenFor(appState.user.email)
        : null;
      let result;
      if (awaitingToken) {
        // Il claim `email_verified` in cache può essere vecchio: il rinnovo
        // forzato dell'ID token precede SEMPRE il riscatto, anche con il token.
        await forceIdTokenRefresh();
        result = await redeemClientInvite(awaitingToken, idempotencyKey);
      } else {
        result = await redeemClientInviteForVerifiedEmail(idempotencyKey);
      }
      const status = String(result?.status || "");
      const activated = isClientLinkActiveStatus(status);
      if (activated) {
        // Riscatto `link-active`: solo adesso il token dell'invito non serve più.
        clearPendingEmailInviteToken();
        clearEmailInviteAwaitingLink();
        await refreshClientLinkState();
        renderEmailVerificationBanner(appState.user);
      }
      outcome = { status, activated };
    }
  } catch (error) {
    // Un tentativo automatico non deve disturbare: resta il pulsante nel banner.
    console.warn("Attivazione del collegamento non riuscita", error?.code || error?.message);
    outcome = { status: "error", activated: false };
  } finally {
    linkActivationInFlight = false;
  }
  outcome.message = LINK_ACTIVATION_MESSAGES[outcome.status] || LINK_ACTIVATION_MESSAGES.error;
  if (feedback === "always" || (feedback === "success" && outcome.activated)) {
    showToast(outcome.message, !outcome.activated);
  }
  return outcome;
}

function showApp() {
  document.body.classList.remove("auth-locked");
  document.getElementById("login-screen")?.classList.add("hidden");
  document.getElementById("email-invite-screen")?.classList.add("hidden");
  document.getElementById("app-container")?.classList.remove("hidden");
  renderEmailVerificationBanner(appState.user);
  document.querySelector(".bottom-nav")?.classList.remove("hidden");
  // Anche l'avvio rapido da cache deve chiudere l'overlay: in quel percorso
  // loadUserData() è silenzioso e il suo finally non chiama clearLoading().
  clearLoading();
}

function mapLoginError(error) {
  if (error?.code === "auth/invalid-username" || error?.code === "auth/missing-password" || error?.code === "auth/invalid-email") return error.message;
  if (["auth/invalid-login-credentials", "auth/wrong-password", "auth/user-not-found", "auth/invalid-credential"].includes(error?.code)) {
    return "Credenziali non corrette. Se hai dimenticato la password usa “Password dimenticata?”.";
  }
  if (error?.code === "auth/too-many-requests") return "Troppi tentativi. Attendi qualche minuto e riprova.";
  if (error?.code === "auth/network-request-failed") return "Connessione assente. Il primo accesso richiede internet.";
  return "Accesso non riuscito. Riprova tra poco.";
}

// L'email reale è l'unica credenziale mostrata nel percorso live. Gli account
// tecnici già presenti restano gestibili solo dagli strumenti di migrazione
// lato server e non hanno più un percorso pubblico nella piattaforma.
async function performLogin(identifier, password) {
  return signInWithEmailAddress(String(identifier || "").trim(), password);
}

function setupLoginForm() {
  const form = document.getElementById("login-form");
  if (!form || form.dataset.ready) return;
  form.dataset.ready = "true";
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const identifier = document.getElementById("login-username").value;
    const password = document.getElementById("login-password").value;
    const button = document.getElementById("login-submit");
    const errorEl = document.getElementById("login-error");
    errorEl.textContent = "";
    button.disabled = true;
    button.textContent = "Accesso…";
    try {
      await performLogin(identifier, password);
      document.getElementById("login-password").value = "";
    } catch (error) {
      errorEl.textContent = mapLoginError(error);
    } finally {
      button.disabled = false;
      button.textContent = "Accedi";
    }
  });
}

// Recupero password ("Password dimenticata?"): messaggio SEMPRE uniforme, così
// non si può capire dall'esterno se un indirizzo è registrato. Il reset non
// viene proposto per gli indirizzi tecnici legacy (non hanno una casella).
function setResetFormVisible(visible) {
  document.getElementById("reset-form")?.classList.toggle("hidden", !visible);
  document.getElementById("login-form")?.classList.toggle("hidden", visible);
  document.getElementById("login-reset-password")?.classList.toggle("hidden", visible);
  if (visible) {
    const note = document.getElementById("reset-message");
    if (note) note.textContent = "";
    setTimeout(() => document.getElementById("reset-email")?.focus(), 50);
  }
}

function setupResetPasswordForm() {
  const toggle = document.getElementById("login-reset-password");
  const form = document.getElementById("reset-form");
  if (!toggle || !form || form.dataset.ready) return;
  form.dataset.ready = "true";
  toggle.addEventListener("click", () => {
    const identifier = document.getElementById("login-username")?.value || "";
    const emailInput = document.getElementById("reset-email");
    if (emailInput && identifier.includes("@")) emailInput.value = identifier.trim();
    setResetFormVisible(true);
  });
  document.getElementById("reset-cancel")?.addEventListener("click", () => setResetFormVisible(false));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const email = document.getElementById("reset-email")?.value || "";
    const message = document.getElementById("reset-message");
    const button = document.getElementById("reset-submit");
    message.textContent = "";
    button.disabled = true;
    button.textContent = "Invio…";
    try {
      const result = await sendPasswordResetForEmail(email);
      message.textContent = result.message;
      if (!result.ok) form.dataset.invalid = "true";
    } finally {
      button.disabled = false;
      button.textContent = "Invia il link di recupero";
    }
  });
}

async function loadUserData(user, { silent = false } = {}) {
  appState.user = user;
  renderEmailVerificationBanner(user);
  if (!silent) setLoading("Sincronizzazione del piano personale…");
  if (appStarted && window.location.hash === "#recipes") renderRecipes({ loading: true });
  try {
    // Prima individua l'eventuale household, poi le tre letture puntano in modo
    // trasparente ai documenti personali oppure a quelli condivisi.
    try {
      await prepareDataScope();
    } catch (scopeError) {
      clearDataScope();
      console.warn("Area condivisa non disponibile: uso i dati personali", scopeError);
    }
    appState.household = getCurrentHousehold();
    // In modalità household i tre documenti hanno listener onSnapshot attivi
    // (startAccountRealtimeSync parte subito dopo questa funzione): eseguire
    // anche le .get() iniziali rileggerebbe gli stessi documenti, ~3 letture
    // duplicate a ogni avvio. Con una cache locale valida lo stato parte da lì
    // e il primo snapshot dei listener lo allinea. Senza cache utilizzabile
    // (primo accesso dal dispositivo, household appena creata) restano le
    // letture dirette come fallback, così la schermata non rimane mai vuota.
    // In modalità personale non ci sono listener: le .get() restano sempre.
    let recipes = null;
    let plan = null;
    let shopping = null;
    if (appState.household) {
      const cachedRecipes = readLocalJson("recipe_catalog", []);
      const cachedPlan = readLocalJson("weekly_plan", null);
      if (cachedRecipes.length && cachedPlan?.days) {
        recipes = cachedRecipes;
        plan = cachedPlan;
        shopping = shoppingValueFromData(readLocalJson("shopping", {}));
      }
    }
    if (!plan) {
      [recipes, plan, shopping] = await Promise.all([
        getRecipeCatalog(), getWeeklyPlan(), getShoppingListCloud()
      ]);
    }
    // Letture SaaS di avvio: silent e PARALLELE. Sull'avvio rapido (dati già
    // in cache, overlay chiusa) il refresh non deve mostrare "Aggiornamento in
    // corso…" né far sommare in sequenza le due chiamate cloud: l'app resta
    // interattiva e il refresh la allinea in sottofondo. Sul primo avvio
    // l'overlay è comunque gestita dal caricamento dei dati (qui sopra).
    const silentSaasCall = (name, data) => callSaasFunction(name, data, { silent: true });
    const saasContextPromise = window.PianoSaas
      ? PianoSaas.loadContext(user.uid, silentSaasCall)
      : Promise.resolve({ state: "feature-disabled", fallback: "legacy" });
    // Lo stato del collegamento decide anche se tentare l'attivazione dopo la
    // verifica email (sotto): qui va atteso, non solo avviato.
    const clientLinkPromise = refreshClientLinkState({ silent: true });
    const previousContext = appState.saasContext;
    appState.saasContext = await saasContextPromise;
    invalidateDietEngine();
    await clientLinkPromise;
    renderEmailVerificationBanner(appState.user);
    // Accesso o ricarica con email appena verificata: il collegamento rimasto
    // in attesa viene attivato adesso (riscatto senza token, ID token forzato).
    // Se si attiva, il contesto professionale va riletto prima di applicare il
    // piano: il collegamento attivo può sbloccare un profilo assegnato.
    const linkActivation = await activateClientLinkAfterVerification({ user });
    if (linkActivation?.activated && window.PianoSaas) {
      appState.saasContext = await PianoSaas.loadContext(user.uid, silentSaasCall);
    }
    // Avvio rapido: se l'app è già mostrata E dati E contesto sono identici a
    // quelli già applicati dalla cache locale, non riapplicare: niente
    // cambiamento di stato, niente re-render, niente doppio passaggio per le
    // migrazioni. Il listener realtime (household) e il prossimo avvio
    // riprenderanno da qui. `appStarted` è la guardia d'obbligo: senza l'app
    // mostrata, applyState resta l'unico modo per eseguirne showApp/setup.
    const dataUnchanged = JSON.stringify(recipes) === lastAppliedRaw.recipes
      && JSON.stringify(plan) === lastAppliedRaw.plan
      && JSON.stringify(shopping) === lastAppliedRaw.shopping;
    const contextUnchanged = saasContextFingerprint(previousContext) === saasContextFingerprint(appState.saasContext);
    const skipReapply = appStarted && dataUnchanged && contextUnchanged;
    if (!skipReapply) applyState(recipes, plan, shopping);
    else showApp();
    writeSessionCache({
      uid: user.uid,
      email: user.email,
      householdId: appState.household?.id || null
    });
    // La directory username è compatibilità per dati storici; gli account live
    // usano esclusivamente l'email e non la scrivono più.
    if (typeof isLegacyTestEmailAddress === "function" && isLegacyTestEmailAddress(user.email)) {
      ensureUsernameDirectory().catch(error => console.warn("Directory storica non disponibile", error));
    }
    if (appStarted && !skipReapply) handleRoute();
    else if (appStarted && window.location.hash === "#recipes") {
      // Skippato il re-apply con il Ricettario aperto: si era mostrato lo
      // scheletro "sincronizzazione" in apertura — lo si richiude subito.
      renderRecipes();
    }
  } catch (error) {
    console.error(error);
    if (silent) {
      if (appStarted && window.location.hash === "#recipes") renderRecipes();
      showToast("Connessione assente: stai vedendo i dati salvati sul dispositivo.", true);
    } else {
      showApp();
      const container = document.getElementById("view-week");
      container.classList.remove("hidden");
      container.innerHTML = `<div class="empty-state"><h2>Sincronizzazione non riuscita</h2><p>${escapeHtml(error.message || "Controlla la connessione e riprova.")}</p><button class="btn btn-primary" onclick="window.location.reload()">Riprova</button></div>`;
    }
  } finally {
    if (!silent) clearLoading();
  }
}

// Impronta del contesto SaaS per il confronto "è cambiato?": contano stato e
// profilo (decidono policy, dosi e nudge), non i campi solo-clienti del
// cache (cachedAt, offline).
function saasContextFingerprint(context) {
  return JSON.stringify({ state: context?.state, profile: context?.profile, fallback: context?.fallback });
}

function applyState(recipes, plan, shopping) {
  lastAppliedRaw.plan = JSON.stringify(plan);
  lastAppliedRaw.shopping = JSON.stringify(shopping);
  // Migrazione schema 4 → 5: se il catalogo caricato contiene ancora il campo
  // legacy `frequency`, il catalogo normalizzato viene salvato una sola volta
  // per rimuoverlo definitivamente dai dati persistiti.
  const needsCatalogMigration = window.PianoDomain && PianoDomain.catalogHasLegacyFrequency(recipes);
  setRecipes(recipes);
  const migratedPlan = window.PianoDomain ? PianoDomain.migratePlan(plan) : plan;
  // Migrazione del piano: si salva una sola volta, solo se lo schema è
  // effettivamente cambiato (confronto con l'input, niente stato globale).
  const needsPlanMigration = window.PianoDomain && JSON.stringify(migratedPlan) !== JSON.stringify(plan);
  appState.saasPolicy = window.PianoSaas
    ? PianoSaas.applyPolicy(migratedPlan, appState.saasContext)
    : { plan: migratedPlan, mode: "legacy-disabled", migrationRequired: false };
  appState.plan = appState.saasPolicy.plan;
  appState.shopping = shopping;
  appState.deviceSettings = getLocalDeviceSettings();
  if (needsCatalogMigration) {
    saveRecipeCatalog(appState.recipes).catch(error => console.warn("Migrazione schema 5: salvataggio catalogo non riuscito", error));
  }
  if (needsPlanMigration) {
    saveWeeklyPlan(appState.plan).catch(error => console.warn("Migrazione del piano non riuscita", error));
  }

  applyTheme(!!appState.deviceSettings.darkMode);
  showApp();
  renderGlobalHeader();
  maybePromptProfileUpdate();
  document.querySelector(".bottom-nav")?.classList.remove("hidden");
  if (!appStarted) {
    setupRouter();
    setupModal();
    setupSwapModal();
    setupMealOperations();
    setupTransferModals();
    setupGeneratorModal();
    setupPriceModals();
    appStarted = true;
  }
}

function stopAccountRealtimeSync() {
  stopHouseholdObserver?.();
  stopSharedDataObserver?.();
  stopHouseholdObserver = null;
  stopSharedDataObserver = null;
  activeHouseholdId = null;
}

function bindSharedDataObserver() {
  stopSharedDataObserver?.();
  stopSharedDataObserver = observeSharedDataChanges((kind, value) => {
    if (!appState.user) return;
    // Snapshot con contenuto già applicato (il primo all'avvio, o l'eco di
    // uno write locale appena fatto): niente cambiamento di stato e niente
    // re-render — è da qui che nasceva lo sfarfallio a ogni avvio.
    const raw = JSON.stringify(value);
    if (lastAppliedRaw[kind] === raw) return;
    lastAppliedRaw[kind] = raw;
    if (kind === "recipes") setRecipes(value);
    if (kind === "plan") appState.plan = window.PianoDomain ? PianoDomain.migratePlan(value) : value;
    if (kind === "shopping") appState.shopping = value;
    if (appStarted) handleRoute();
  });
}

function startAccountRealtimeSync() {
  stopAccountRealtimeSync();
  activeHouseholdId = getCurrentHousehold()?.id || null;
  appState.household = getCurrentHousehold();
  if (activeHouseholdId) bindSharedDataObserver();
  stopHouseholdObserver = observeHouseholdChanges(async household => {
    const nextId = household?.id || null;
    appState.household = household;
    if (nextId === activeHouseholdId) {
      if (window.location.hash === "#settings") renderSettings();
      return;
    }

    activeHouseholdId = nextId;
    stopSharedDataObserver?.();
    stopSharedDataObserver = null;
    try {
      await loadUserData(appState.user, { silent: true });
      activeHouseholdId = getCurrentHousehold()?.id || null;
      appState.household = getCurrentHousehold();
      if (activeHouseholdId) bindSharedDataObserver();
      showToast(activeHouseholdId ? "Account collegato: dati condivisi sincronizzati ✅" : "Account scollegato: copia indipendente attiva");
    } catch (error) {
      console.error(error);
    }
  });
}

async function initApp() {
  pendingEmailInviteToken = loadPendingEmailInviteToken();
  setupLoginForm();
  setupResetPasswordForm();
  setupEmailInviteForm();
  setupVerificationBanner();
  // Firebase deve essere pronto PRIMA dell'anteprima pubblica dell'invito. In
  // precedenza l'anteprima veniva richiesta mentre `firebaseReady` era ancora
  // in attesa dell'inizializzazione: email, nome e cognome restavano quindi
  // sui trattini e il form della password non diventava mai disponibile.
  if (!initFirebase()) {
    document.getElementById("login-error").textContent = "Il servizio non è configurato correttamente.";
    showLogin();
    return;
  }
  // Invito con email reale: l'anteprima arriva dal server e il form resta
  // nascosto finché i dati non sono disponibili (email/nome non modificabili).
  // Un invito già usato per registrarsi (in attesa di attivazione) NON è più un
  // link da aprire: il token resta in sessione, ma la schermata non ricompare.
  if (pendingEmailInviteToken && !isEmailInviteAwaitingLink(pendingEmailInviteToken)) {
    showEmailInviteScreen({ clear: false });
    try {
      emailInvitePreview = await previewClientInvite(pendingEmailInviteToken);
    } catch (error) {
      console.warn("Anteprima invito non disponibile", error);
      emailInvitePreview = { status: "preview-error" };
    }
    renderEmailInvitePreview();
    clearLoading();
  }

  // Avvio veloce: se la sessione è in cache locale, mostra subito l'app
  // con i dati già scaricati, poi rinfresca in background.
  const cachedSession = readSessionCache();
  const cachedDataOwner = cachedSession?.householdId ? `household-${cachedSession.householdId}` : cachedSession?.uid;
  const cachedRecipes = cachedDataOwner ? readLocalJsonFor(cachedDataOwner, "recipe_catalog", []) : [];
  const cachedPlan = cachedDataOwner ? readLocalJsonFor(cachedDataOwner, "weekly_plan", null) : null;
  const cachedShopping = cachedDataOwner ? readLocalJsonFor(cachedDataOwner, "shopping", null) : null;
  const canBoot = Boolean(cachedSession?.uid && cachedRecipes.length && cachedPlan?.days);
  if (canBoot) {
    appState.user = { uid: cachedSession.uid, email: cachedSession.email || "" };
    setLocalDataOwner(cachedSession.uid);
    // Contesto SaaS cache-first: il profilo verificato nell'ultima sessione
    // vale già al primo paint (dosi adattate corrette subito, niente balzo
    // original→guide); loadUserData lo conferma o lo corregge in sottofondo.
    if (window.PianoSaas?.config?.().enabled) {
      appState.saasContext = window.PianoSaas.cachedContext(cachedSession.uid) || { state: "unassigned" };
    }
    applyState(cachedRecipes, cachedPlan, cachedShopping || getDefaultShoppingList());
  } else {
    setLoading("Verifica accesso…");
  }

  observeAuthState(async user => {
    if (!user) {
      stopAccountRealtimeSync();
      stopNotificationsSync();
      clearDataScope();
      writeSessionCache(null);
      // Pulizia dello stato notifiche prima di azzerare il proprietario dati:
      // la chiave locale del conteggio è ancora prefissata con il suo uid.
      incomingRecipeShares = [];
      incomingAccountLinks = [];
      notificationsLoadError = false;
      writeLocalJson(NOTIF_COUNT_CACHE, 0);
      appState.clientLink = null;
      setLocalDataOwner(null);
      appState.user = null;
      appState.household = null;
      // Un invito già registrato e in attesa di attivazione non è più un link
      // da aprire: si va all'accesso standard.
      if (pendingEmailInviteToken && !isEmailInviteAwaitingLink(pendingEmailInviteToken)) showEmailInviteScreen();
      else showLogin();
      return;
    }
    if (pendingEmailInviteToken && !isEmailInviteAwaitingLink(pendingEmailInviteToken) && !inviteFlowActive) {
      // Account già autenticato che apre un link invito: il token resta
      // parcheggiato finché non esce e riapre il link.
      showToast("Per usare un invito cliente esci dall'account attuale e riapri il link");
    }
    writeSessionCache({
      uid: user.uid,
      email: user.email,
      householdId: cachedSession?.uid === user.uid ? (cachedSession.householdId || null) : null
    });
    await loadUserData(user, { silent: canBoot });
    startAccountRealtimeSync();
    startNotificationsSync();
  });
}

function setupRouter() {
  window.addEventListener("hashchange", handleRoute);
  // Nav "Prezzi" nascosta quando la feature è disattivata (elemento conservato).
  if (!pricesFeatureEnabled()) {
    document.getElementById("nav-prices")?.classList.add("hidden");
    document.getElementById("nav-prices")?.setAttribute("aria-hidden", "true");
  }
  const allowed = pricesFeatureEnabled()
    ? ["#week", "#recipes", "#shop", "#prices", "#settings"]
    : ["#week", "#recipes", "#shop", "#settings"];
  if (!window.location.hash || !allowed.includes(window.location.hash)) {
    window.location.hash = "#week";
  } else {
    handleRoute();
  }
}

// Ultima vista renderizzata: consente di far scorrere la settimana sul giorno
// corrente solo quando la si apre, non a ogni re-render della stessa vista.
let lastRenderedRoute = null;
let routeTransitionTimer = null;
let routeTransitionToken = 0;

function revealRouteView(view, transitionToken, enteringWeek) {
  view.classList.remove("view-exit");
  view.classList.add("view-enter");
  view.classList.remove("hidden");
  const startEntrance = () => {
    if (transitionToken !== routeTransitionToken) return;
    view.classList.remove("view-enter");
    if (enteringWeek) scrollWeekToToday();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(startEntrance);
  else startEntrance();
}

function handleRoute() {
  if (!appState.user || !appState.plan) return;
  const hash = window.location.hash || "#week";
  const routeName = hash.slice(1);
  // Sezione Prezzi sospesa dietro feature flag: la rotta viene riportata alla
  // Settimana senza cancellare view, logica né dati.
  if (routeName === "prices" && !pricesFeatureEnabled()) {
    window.location.hash = "#week";
    return;
  }
  const targetView = document.getElementById(`view-${routeName}`);
  if (!targetView) return;

  const views = [...document.querySelectorAll(".view")];
  const outgoingView = views.find(view => view !== targetView && !view.classList.contains("hidden"));
  const targetAlreadyVisible = !targetView.classList.contains("hidden");
  const enteringWeek = hash === "#week" && lastRenderedRoute !== "#week";
  const transitionToken = ++routeTransitionToken;

  clearTimeout(routeTransitionTimer);
  document.querySelectorAll(".nav-item").forEach(item => item.classList.remove("active"));
  document.getElementById(`nav-${routeName}`)?.classList.add("active");

  // «La mia dieta» esiste solo con una struttura assegnata e confermata:
  // senza profilo la voce sparisce e la rotta torna alla Settimana.
  const dietAssigned = Boolean(myDietProfile());
  document.getElementById("nav-diet")?.classList.toggle("hidden", !dietAssigned);
  if (routeName === "diet" && !dietAssigned) {
    window.location.hash = "#week";
    return;
  }
  if (hash === "#week") renderWeek();
  if (hash === "#recipes") renderRecipes();
  if (hash === "#shop") renderShop();
  if (hash === "#prices") renderPrices();
  if (hash === "#diet") renderMyDietView();
  if (hash === "#settings") renderSettings();
  // La campanella resta sincronizzata anche sui cambi pagina, senza richiedere
  // l'apertura manuale del pannello notifiche.
  updateNotificationBadge();
  lastRenderedRoute = hash;

  if (!outgoingView) {
    views.forEach(view => {
      if (view !== targetView) view.classList.add("hidden");
      view.classList.remove("view-exit");
    });
    if (targetAlreadyVisible) {
      targetView.classList.remove("hidden", "view-enter", "view-exit");
      if (enteringWeek) scrollWeekToToday();
    } else {
      revealRouteView(targetView, transitionToken, enteringWeek);
    }
    return;
  }

  outgoingView.classList.remove("view-enter");
  outgoingView.classList.add("view-exit");
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  routeTransitionTimer = setTimeout(() => {
    if (transitionToken !== routeTransitionToken) return;
    views.forEach(view => {
      view.classList.add("hidden");
      view.classList.remove("view-exit", "view-enter");
    });
    revealRouteView(targetView, transitionToken, enteringWeek);
  }, reducedMotion ? 0 : 160);
}

function scrollWeekToToday() {
  const target = document.getElementById(`day-${getTodayKey()}`);
  if (!target || typeof target.scrollIntoView !== "function") return;
  const scroll = () => target.scrollIntoView({ behavior: "smooth", block: "start" });
  // Attende il layout del nuovo markup; scroll-margin-top compensa l'header fisso.
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(scroll);
  else scroll();
}

function renderGlobalHeader() {
  let header = document.getElementById("global-header-container");
  if (!header) {
    header = document.createElement("header");
    header.id = "global-header-container";
    header.className = "global-header";
    document.body.prepend(header);
  }
  const profile = getPortionProfile();
  const pending = pendingNotificationCount();
  const multiplier = getCoupleMultiplier();
  header.innerHTML = `
    <div class="header-brand"><span class="header-brand-icon" aria-hidden="true"><img src="assets/loghi/logo-app.svg" alt=""></span><strong>Piano</strong></div>
    <div class="header-profile">
      <select aria-label="Profilo porzioni" onchange="changePortionProfile(this.value)">
        <option value="single" ${profile === "single" ? "selected" : ""}>👤 ${getPortionProfileLabel("single")}</option>
        <option value="couple" ${profile === "couple" ? "selected" : ""}>👥 ${getPortionProfileLabel("couple")}</option>
      </select>
      ${profile === "couple" ? `
      <div class="couple-mult" role="group" aria-label="Moltiplicatore porzioni della coppia">
        <button type="button" class="couple-mult-btn" onclick="changeCoupleMultiplier(-0.05)" aria-label="Riduci il moltiplicatore porzioni" ${multiplier <= 0.5 ? "disabled" : ""}>−</button>
        <span class="couple-mult-value" title="Moltiplicatore porzioni">${formatMultiplier(multiplier)}</span>
        <button type="button" class="couple-mult-btn" onclick="changeCoupleMultiplier(0.05)" aria-label="Aumenta il moltiplicatore porzioni" ${multiplier >= 3 ? "disabled" : ""}>＋</button>
      </div>` : ""}
    </div>
    <div class="header-actions">
      <button type="button" id="notification-bell" class="notification-bell ${pending ? "has-pending" : ""}" onclick="openIncomingShares()" aria-label="${notificationBellLabel(pending)}" aria-haspopup="dialog" aria-expanded="false" aria-controls="incoming-shares-modal">
        <span aria-hidden="true">🔔</span>
        <span id="notification-badge" class="notification-badge ${pending ? "" : "hidden"}" aria-hidden="true">${pending > 9 ? "9+" : pending}</span>
      </button>
    </div>
  `;
}

window.changePortionProfile = function(profile) {
  const normalized = normalizePortionProfile(profile);
  if (!["single", "couple"].includes(normalized)) return;
  appState.deviceSettings.portionProfile = normalized;
  saveLocalDeviceSettings(appState.deviceSettings);
  renderGlobalHeader();
  handleRoute();
};

// ----- Modale batch cooking (aperta dalla colonna della Settimana) -----

// La dicitura "Cena + pranzo di {giorno successivo}" nella colonna del giorno
// apre una modale con le ricette coinvolte (cena anchor + pranzo target) e le
// dosi da preparare: le quantità sono quelle calcolate dal dominio per profilo
// e tipo A/R del giorno target, già sommate nel caso della doppia porzione.

const BATCH_STATUS_LABELS = {
  // Quando la preparazione è disponibile oggi non serve un'etichetta: è già
  // implicito dal punto di accesso nella giornata corrente.
  today: null,
  fresh: { label: "Prepara al momento", className: "fresh" },
  later: { label: "Non ancora preparabile", className: "later" }
};

function batchRecipeIngredients(recipe, dayKey, slot, batch) {
  if (batch?.commonRecipe) {
    const tasksById = new Map((batch.tasks || []).map(task => [task.id, task]));
    return (recipe.ingredients || []).map(ingredient => {
      const fallbackId = String(ingredient.name || "").toLowerCase().normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const id = `common-${ingredient.ingredientId || fallbackId}`;
      const task = tasksById.get(id);
      return task ? { name: task.label, quantity: task.quantity } : null;
    }).filter(Boolean);
  }

  const effectiveRecipe = resolvePlannedRecipe(recipe, dayKey, slot).recipe || recipe;
  return (effectiveRecipe.ingredients || []).map(ingredient => ({
    name: ingredient.name,
    quantityHtml: getIngredientQuantityHtml(ingredient)
  }));
}

// Nel popup batch la ricetta è già completa: ingredienti, dosi e preparazione
// sono consultabili senza aprire una seconda modale.
function batchRecipeBoxHtml(heading, recipe, dayKey, slot, batch) {
  if (!recipe) return "";
  const ingredients = batchRecipeIngredients(recipe, dayKey, slot, batch);
  return `
    <article class="batch-detail-recipe">
      ${heading ? `<small>${escapeHtml(heading)}</small>` : ""}
      <h4>${escapeHtml(recipe.emoji || "🍲")} ${escapeHtml(getRecipeDisplayName(recipe))}</h4>
      <h5>Ingredienti${batch?.commonRecipe ? " · dosi totali" : ""}</h5>
      <ul class="modal-ingredient-list">${ingredients.map(ingredient => `
        <li><span>${escapeHtml(ingredient.name)}</span>${ingredient.quantityHtml || `<strong>${escapeHtml(ingredient.quantity)}</strong>`}</li>`).join("")}</ul>
      <h5>Preparazione</h5>
      <ol class="batch-recipe-steps">${(recipe.steps || []).map((step, index) => `<li><strong>${index + 1}.</strong> ${escapeHtml(step)}</li>`).join("")}</ol>
      ${recipe.notes?.length ? `<div class="recipe-notes"><strong>Note</strong><ul>${recipe.notes.map(note => `<li>${escapeHtml(note)}</li>`).join("")}</ul></div>` : ""}
    </article>`;
}

function batchDetailSectionHtml(batch, dayKey) {
  const template = batch.template || {};
  const targetDay = batch.targetDay;
  const anchorRecipe = getRecipe(template.anchor?.recipeId);
  const targetRecipe = getRecipe(template.target?.recipeId);
  // Se cena e pranzo usano la stessa ricetta evitiamo le informazioni
  // ridondanti su doppia porzione e giorno target: bastano ricetta e dosi totali.
  const recipesHtml = batch.commonRecipe
    ? batchRecipeBoxHtml("", anchorRecipe, dayKey, "dinner", batch)
    : batchRecipeBoxHtml(`Cena di ${DAY_NAMES[dayKey]}`, anchorRecipe, dayKey, "dinner", batch)
      + batchRecipeBoxHtml(`Pranzo di ${DAY_NAMES[targetDay]}`, targetRecipe, targetDay, "lunch", batch);
  const targetInfo = `🎯 Pranzo di ${DAY_NAMES[targetDay]} · tra ${batch.daysUntilTarget} ${batch.daysUntilTarget === 1 ? "giorno" : "giorni"}`;
  return `
    <section class="batch-modal batch-detail">
      ${batch.commonRecipe ? "" : `<h3>${escapeHtml(template.title || "Preparazioni in anticipo")}</h3><p class="batch-detail-target"><strong>${escapeHtml(targetInfo)}</strong></p>`}
      <div class="batch-detail-recipes">${recipesHtml}</div>
      ${batch.commonRecipe ? "" : `<ol>${(batch.tasks || []).map(task => {
        const status = BATCH_STATUS_LABELS[task.status] || null;
        return `<li class="batch-task">
          <span class="batch-task-label">${escapeHtml(task.label)}</span>
          ${status ? `<span class="batch-task-status ${status.className}">${status.label}</span>` : ""}
          ${task.quantity ? `<strong class="batch-task-quantity">${escapeHtml(task.quantity)}</strong>` : ""}
        </li>`;
      }).join("")}</ol>`}
    </section>`;
}

function setupBatchModal() {
  if (document.getElementById("batch-modal")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="batch-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="batch-modal-title">
      <div class="modal-content batch-modal-content">
        <div class="modal-header"><div><p class="eyebrow">Batch cooking</p><h2 id="batch-modal-title"></h2></div><button class="btn-icon" onclick="closeBatchModal()">&times;</button></div>
        <p class="text-muted" id="batch-modal-subtitle"></p>
        <div id="batch-modal-list"></div>
      </div>
    </div>`);
  bindModalOutsideClose("batch-modal", () => window.closeBatchModal());
}

// Etichetta del chip batch: "Cena + pranzo di {giorno successivo}" (la logica
// resta cena del giorno + pranzo del giorno dopo; domenica indica lunedì).
// Con più batch verso giorni diversi i destinatari sono elencati.
function batchChipLabel(dayKey, batches) {
  // Nomi dei giorni in minuscolo (uso italiano a metà frase).
  const lower = target => String(DAY_NAMES[target] || "").toLowerCase();
  const targets = [...new Set((batches || []).map(batch => batch.targetDay).filter(target => DAY_NAMES[target]))];
  if (!targets.length) {
    const fallback = DAY_ORDER[(DAY_ORDER.indexOf(dayKey) + 1 + DAY_ORDER.length) % DAY_ORDER.length];
    return `Cena + pranzo di ${lower(fallback)}`.trim();
  }
  return `Cena + pranzo di ${targets.map(lower).join(", ")}`;
}

function batchChipHtml(dayKey) {
  const batches = getActiveBatch(dayKey);
  if (!batches.length) return "";
  return `<button type="button" class="batch-active-chip batch-chip-btn" onclick="openBatchModal('${dayKey}')" title="Mostra le dosi da batch cooking">${escapeHtml(batchChipLabel(dayKey, batches))}<span class="batch-chip-arrow">›</span></button>`;
}

window.openBatchModal = function(dayKey) {
  if (!DAY_ORDER.includes(dayKey)) return;
  const batches = getActiveBatch(dayKey);
  if (!batches.length) return;
  setupBatchModal();
  document.getElementById("batch-modal-title").textContent = `Batch cooking · ${DAY_NAMES[dayKey]}`;
  document.getElementById("batch-modal-subtitle").textContent = `Dosi calcolate per: ${getProfileLabel()}`;
  document.getElementById("batch-modal-list").innerHTML = batches.map(batch => batchDetailSectionHtml(batch, dayKey)).join("");
  document.getElementById("batch-modal").classList.remove("hidden");
};

window.closeBatchModal = function() {
  document.getElementById("batch-modal")?.classList.add("hidden");
};


function recipeProteinCategory(recipe) {
  return window.PianoDomain?.classifyProtein(recipe) || null;
}

// Etichetta leggibile per la categoria proteica di una ricetta: prima il
// dominio (ingredienti → fallback proteinCategory), poi l'eventuale valore
// testuale legacy come estrema ratio. Usata dalla libreria ricette e dalle
// modali di sostituzione per non mostrare chiavi tecniche ("curedMeats").
function recipeProteinLabel(recipe) {
  if (!recipe) return "";
  const key = window.PianoDomain?.classifyProtein(recipe);
  if (key && window.PianoDomain?.PROTEIN_CATEGORY_LABELS?.[key]) {
    return PianoDomain.PROTEIN_CATEGORY_LABELS[key];
  }
  const raw = recipe.proteinCategory;
  return raw ? String(raw) : "";
}

function recipeIsFish(recipe) {
  const category = recipeProteinCategory(recipe);
  return category === "omega" || category === "otherFish";
}

// La ricetta del suggerimento batch viene spesso usata nel pasto opposto al
// suo slot naturale (cena → pranzo del giorno dopo): le dosi allineate si
// calcolano sul pasto di destinazione e il badge ↻ lo rende visibile.
function recipeIsCrossSlot(recipe, slot) {
  return Boolean(recipe?.slot && slot && recipe.slot !== slot);
}

// Riepilogo proteico della settimana: SOLO conteggi descrittivi (quante
// ricette di ogni categoria finiscono nei pasti principali). Nessun target
// o giudizio clinico: le indicazioni nutrizionali arrivano esclusivamente
// dalla struttura dieta assegnata dal professionista.
function analyzeWeeklyPlan() {
  const counts = {
    poultry: 0, beef: 0, curedMeats: 0, omega: 0, otherFish: 0, dairy: 0, eggs: 0, legumes: 0
  };
  DAY_ORDER.forEach(day => {
    [getPlannedRecipe(day, "lunch"), getPlannedRecipe(day, "dinner")].filter(Boolean).forEach(recipe => {
      const category = recipeProteinCategory(recipe);
      if (category && counts[category] !== undefined) counts[category] += 1;
    });
  });
  return { counts };
}

function renderWeekAnalysis() {
  const analysis = analyzeWeeklyPlan();
  return `
    <section class="plan-check" aria-label="Riepilogo proteine della settimana">
      <div class="flex-between"><h3>Riepilogo proteine della settimana</h3><small class="text-muted">Pranzo e cena</small></div>
      <div class="frequency-grid">
        ${Object.entries(analysis.counts).map(([key, value]) => {
          const label = window.PianoDomain?.PROTEIN_CATEGORY_LABELS?.[key] || GENERATOR_COUNT_LABELS[key] || key;
          return `<div class="frequency-item"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`;
        }).join("")}
      </div>
    </section>`;
}

// Il toggle "quantità adattate" persiste la MODALITÀ del piano (nessuna dose
// derivata viene memorizzata). Con SaaS attivo, senza una struttura assegnata
// e confermata la vista resta comunque sulle quantità originali.
function pricesFeatureEnabled() {
  if (PRICES_FEATURE_ENABLED) return true;
  // Attivazione mirata: la sezione resta chiusa a tutti tranne gli UID
  // elencati in js/saas-config.js (flag di visibilità, non sicurezza).
  const uid = appState.user?.uid || null;
  if (!uid) return false;
  const enabledFor = window.PIANO_SAAS_CONFIG?.pricesEnabledForUids || [];
  return Array.isArray(enabledFor) && enabledFor.includes(uid);
}
window.toggleWeekAlignedDoses = async function(enabled) {
  if (!window.PianoDomain?.setPlanAlignedDosesEnabled || !appState.plan) return;
  appState.plan = PianoDomain.setPlanAlignedDosesEnabled(appState.plan, enabled);
  try {
    await saveWeeklyPlan(appState.plan);
    renderWeek();
    showToast(enabled
      ? "Dosi allineate alla tua dieta attive ✅"
      : "Vista impostata sulle dosi originali delle ricette");
  } catch (error) {
    showToast("Impossibile salvare la scelta", true);
  }
};

// Dosi effettivamente applicate al pasto, in riga compatta: compaiono nella
// Settimana solo quando l'interruttore «Dosi allineate alla mia dieta» è attivo
// e la struttura del nutrizionista prevede dosi per questo pasto. Cambiano con
// la giornata Allenamento o Riposo.
function weekMealDosesHtml(planned, dayType) {
  if (!planned?.aligned || !planned?.recipe) return "";
  const rows = (planned.recipe.ingredients || []).map(ingredient => {
    const amount = getIngredientDisplay(ingredient);
    if (isEmptyPortion(amount)) return null;
    return `${ingredient.name} ${amount}`;
  }).filter(Boolean);
  if (!rows.length) return "";
  const shown = rows.slice(0, 4);
  const extra = rows.length - shown.length;
  const label = dayType === "rest" ? "riposo" : "allenamento";
  return `<small class="week-meal-doses" title="Dosi previste dalla tua dieta per una giornata di ${label}">${escapeHtml(shown.join(" · "))}${extra > 0 ? escapeHtml(` · +${extra}`) : ""}</small>`;
}

function renderWeek() {
  const container = document.getElementById("view-week");
  const today = getTodayKey();
  const alignedEnabled = window.PianoDomain ? PianoDomain.planAlignedDosesEnabled(appState.plan) !== false : false;
  const alignedEffective = planAlignedDosesEffective();
  const alignedBlocked = alignedEnabled && !alignedEffective;
  container.innerHTML = `
    <div class="page-heading week-heading">
      <div class="week-heading-copy">
        <p class="eyebrow">Schema ottimizzato</p>
        <h1>Piano settimanale</h1>
        <p>Scegli Allenamento o Riposo in ogni giornata per adattare le dosi.</p>
        <div class="week-heading-meta">
          <label class="week-adapted-row" for="week-aligned-toggle">
            <span class="switch">
              <input type="checkbox" role="switch" id="week-aligned-toggle" aria-label="Dosi allineate alla mia dieta" ${alignedEnabled ? "checked" : ""} onchange="toggleWeekAlignedDoses(this.checked)">
              <span class="switch-track" aria-hidden="true"></span>
            </span>
            <span class="week-adapted-copy"><strong>Dosi allineate alla mia dieta</strong>${alignedBlocked ? `<small>Stai vedendo le dosi originali: conferma il nuovo profilo nelle Impostazioni per attivare l'allineamento.</small>` : ""}</span>
          </label>
        </div>
      </div>
      <button class="btn btn-outline week-generate-btn" onclick="openGeneratorModal()">✨ Genera settimana</button>
    </div>
    ${renderWeekAnalysis()}
    <div class="week-grid">
      ${DAY_ORDER.map(day => {
        const planDay = appState.plan.days[day];
        return `
          <article id="day-${day}" class="day-column ${day === today ? "current-day" : ""}">
            <div class="day-column-head">
              <div>${day === today ? `<span class="today-badge">OGGI</span>` : `<span class="recipe-code">GIORNO</span>`}<h2>${DAY_NAMES[day]}</h2></div>
              <div class="day-type-control" aria-label="Tipo di giornata">
                <button class="type-option training ${planDay.type === "training" ? "active" : ""}" onclick="changeDayType('${day}', 'training')" aria-pressed="${planDay.type === "training"}" title="Giornata di allenamento">Allenamento</button>
                <button class="type-option rest ${planDay.type === "rest" ? "active" : ""}" onclick="changeDayType('${day}', 'rest')" aria-pressed="${planDay.type === "rest"}" title="Giornata di riposo">Riposo</button>
              </div>
            </div>
            ${MEAL_SLOTS.map(slot => {
              const recipe = getRecipe(planDay[slot.id]);
              const planned = recipe ? resolvePlannedRecipe(recipe, day, slot.id) : null;
              const alignedBadge = planned?.aligned
                ? `<span class="diet-plan-badge" title="Dosi allineate alla tua dieta per questo pasto">↻</span>`
                : "";
              const dosesLine = weekMealDosesHtml(planned, planDay.type);
              return `<div class="week-meal">
                <small>${escapeHtml(slot.shortLabel)}</small>
                <div class="week-meal-main">
                  <button class="week-meal-name" onclick="openRecipeModal('${escapeAttr(recipe?.id || "")}', '${day}', '${slot.id}')">${escapeHtml(recipe?.emoji || "")} ${escapeHtml(recipe ? getRecipeDisplayName(recipe) : "Non disponibile")} ${alignedBadge}</button>
                  ${dosesLine}
                </div>
                <button class="btn-icon btn-swap" onclick="openMealActions('${day}', '${slot.id}')" title="Operazioni sul pasto" aria-label="Operazioni sul pasto">⋯</button>
              </div>`;
            }).join("")}
            ${batchChipHtml(day)}
          </article>`;
      }).join("")}
    </div>`;
}

window.changeDayType = async function(dayKey, type) {
  if (!["training", "rest"].includes(type)) return;
  appState.plan.days[dayKey].type = type;
  try {
    await saveWeeklyPlan(appState.plan);
    renderWeek();
  } catch (error) {
    showToast("Impossibile salvare il tipo di giornata", true);
  }
};

function setupSwapModal() {
  if (document.getElementById("swap-modal")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="swap-modal" class="modal hidden" role="dialog" aria-modal="true">
      <div class="modal-content swap-modal-content">
        <div class="modal-header"><div><p class="eyebrow">Piano personale</p><h2 id="swap-title">Sostituisci ricetta</h2></div><button class="btn-icon" onclick="closeSwapModal()">&times;</button></div>
        <p class="text-muted">La sostituzione può cambiare frequenze e batch cooking. Le dosi continuano a seguire il contesto Allenamento/Riposo e l’eventuale moltiplicatore di 2 persone.</p>
        <div id="swap-options-list" class="swap-options"></div>
      </div>
    </div>`);
  bindModalOutsideClose("swap-modal", () => window.closeSwapModal());
}

window.openSwapModal = function(dayKey, slot) {
  const modal = document.getElementById("swap-modal");
  const slotMeta = getSlotMeta(slot);
  document.getElementById("swap-title").textContent = `${DAY_NAMES[dayKey]} · ${slotMeta.label}`;
  const currentId = appState.plan.days[dayKey][slot];
  const defaultId = appState.plan.defaultDays?.[dayKey]?.[slot];

  // Suggerimento batch cooking "doppia porzione": sostituendo un pranzo con
  // la cena del giorno prima (o una cena con il pranzo del giorno dopo) si
  // accende il batch automatico dell'app — si cucina una volta per due pasti.
  // La ricorrenza settimanale vale anche domenica cena → lunedì pranzo.
  const dayIndex = DAY_ORDER.indexOf(dayKey);
  const batchNeighbor = (() => {
    if (slot === "lunch") {
      const prevDay = DAY_ORDER[(dayIndex + DAY_ORDER.length - 1) % DAY_ORDER.length];
      return { recipeId: appState.plan.days?.[prevDay]?.dinner, day: prevDay, label: `Come la cena di ${DAY_NAMES[prevDay]}` };
    }
    if (slot === "dinner") {
      const nextDay = DAY_ORDER[(dayIndex + 1) % DAY_ORDER.length];
      return { recipeId: appState.plan.days?.[nextDay]?.lunch, day: nextDay, label: `Come il pranzo di ${DAY_NAMES[nextDay]}` };
    }
    return null;
  })();
  const batchRecipe = batchNeighbor?.recipeId ? getRecipe(batchNeighbor.recipeId) : null;
  const batchSuggestionHtml = (() => {
    if (!batchRecipe) return "";
    const selected = batchRecipe.id === currentId;
    const crossBadge = recipeIsCrossSlot(batchRecipe, slot) ? ` <span class="swap-cross-badge" title="Carboidrati adattati alla dose prevista per questo pasto">↻</span>` : "";
    return `<div class="batch-suggestion">
      <div class="batch-suggestion-title">🍳 Consiglio batch cooking</div>
      <button class="swap-item batch-suggestion-item ${selected ? "selected" : ""}" onclick="confirmSwap('${dayKey}', '${slot}', '${escapeAttr(batchRecipe.id)}')">
        <span class="swap-code">${escapeHtml(batchRecipe.id)}</span>
        <span><strong>${escapeHtml(batchRecipe.emoji || "🍲")} ${escapeHtml(getRecipeDisplayName(batchRecipe))}${crossBadge}</strong><small>${escapeHtml(batchNeighbor.label)} · doppia porzione: cucini una volta per due pasti</small></span>
        ${selected ? "<b>✓</b>" : ""}
      </button>
    </div>`;
  })();

  const sameSlotRecipes = appState.recipes.filter(recipe => recipe.slot === slot && recipe.id !== batchRecipe?.id);
  // Pranzo <-> cena: mostra anche le ricette del pasto opposto; i carboidrati
  // verranno adattati alle dosi previste per il pasto di destinazione.
  const oppositeSlot = slot === "lunch" ? "dinner" : slot === "dinner" ? "lunch" : null;
  const oppositeSlotRecipes = oppositeSlot ? appState.recipes.filter(recipe => recipe.slot === oppositeSlot && recipe.id !== batchRecipe?.id) : [];
  const oppositeLabel = oppositeSlot ? getSlotMeta(oppositeSlot).label.toLowerCase() : "";
  const resetButton = defaultId && defaultId !== currentId ? `
    <button class="swap-item reset" onclick="confirmSwap('${dayKey}', '${slot}', '${escapeAttr(defaultId)}')">
      <span><strong>↩ Ripristina scelta iniziale</strong><small>${escapeHtml(getRecipe(defaultId) ? getRecipeDisplayName(getRecipe(defaultId)) : defaultId)}</small></span>
    </button>` : "";

  const swapItemHtml = recipe => {
    const selected = recipe.id === currentId;
    return `<button class="swap-item ${selected ? "selected" : ""}" onclick="confirmSwap('${dayKey}', '${slot}', '${escapeAttr(recipe.id)}')"><span class="swap-code">${escapeHtml(recipe.id)}</span><span><strong>${escapeHtml(recipe.emoji || "🍲")} ${escapeHtml(getRecipeDisplayName(recipe))}</strong><small>${escapeHtml(recipeProteinLabel(recipe))}</small></span>${selected ? "<b>✓</b>" : ""}</button>`;
  };

  document.getElementById("swap-options-list").innerHTML = `
    ${batchSuggestionHtml}
    ${resetButton}
    ${sameSlotRecipes.map(recipe => swapItemHtml(recipe)).join("")}
    ${oppositeSlotRecipes.length ? `<div class="swap-section-label">Dal pasto opposto</div>${oppositeSlotRecipes.map(recipe => swapItemHtml(recipe)).join("")}` : ""}
  `;
  modal.classList.remove("hidden");
};

window.closeSwapModal = function() {
  document.getElementById("swap-modal")?.classList.add("hidden");
};

window.confirmSwap = async function(dayKey, slot, recipeId) {
  if (appState.plan.days[dayKey][slot] === recipeId) {
    closeSwapModal();
    return;
  }
  const recipe = getRecipe(recipeId);
  if (!confirm("Sostituire questo pasto con la ricetta scelta? Frequenze e batch cooking potrebbero cambiare.")) return;
  appState.plan.days[dayKey][slot] = recipeId;
  try {
    await saveWeeklyPlan(appState.plan);
    closeSwapModal();
    handleRoute();
    showToast("Piano aggiornato");
  } catch (error) {
    showToast("Salvataggio non riuscito", true);
  }
};

// ---- Operazioni sui pasti: scambia, copia, ripristina ----

let mealActionsTarget = null;

function setupMealOperations() {
  if (document.getElementById("meal-actions-modal")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="meal-actions-modal" class="modal hidden" role="dialog" aria-modal="true">
      <div class="modal-content meal-actions-content">
        <div class="modal-header"><div><p class="eyebrow">PIANO SETTIMANALE</p><h2 id="meal-actions-title">Operazioni sul pasto</h2></div><button class="btn-icon" onclick="closeMealActions()">&times;</button></div>
        <p class="text-muted" id="meal-actions-subtitle"></p>
        <div class="meal-actions-list">
          <button class="swap-item" onclick="closeMealActions(); openSwapModal(mealActionsTarget.day, mealActionsTarget.slot)"><span>🔁</span><span><strong>Sostituisci con una ricetta</strong><small>Scegli dal ricettario dello stesso tipo pasto</small></span></button>
          <button class="swap-item" onclick="renderMealSwapList()"><span>⇄</span><span><strong>Scambia con altro pasto</strong><small>Scambio bidirezionale tra giorni dello stesso tipo</small></span></button>
          <button class="swap-item" onclick="renderMealCopyList()"><span>📋</span><span><strong>Copia in altro giorno</strong><small>Il pasto sorgente resta invariato</small></span></button>
          <button class="swap-item" id="meal-restore-item" onclick="confirmRestoreMeal()"><span>↩</span><span><strong>Ripristina scelta iniziale</strong><small>Torna alla ricetta del piano di partenza</small></span></button>
        </div>
        <div id="meal-target-list" class="meal-target-list hidden"></div>
      </div>
    </div>`);
  bindModalOutsideClose("meal-actions-modal", () => window.closeMealActions());
}

window.openMealActions = function(dayKey, slot) {
  if (!mealActionsTarget) mealActionsTarget = { day: dayKey, slot };
  mealActionsTarget.day = dayKey;
  mealActionsTarget.slot = slot;
  const modal = document.getElementById("meal-actions-modal");
  document.getElementById("meal-actions-title").textContent = `${DAY_NAMES[dayKey]} · ${getSlotMeta(slot).label}`;
  const currentId = appState.plan.days[dayKey][slot];
  const defaultId = appState.plan.defaultDays?.[dayKey]?.[slot];
  document.getElementById("meal-actions-subtitle").textContent = currentId
    ? `Ricetta attuale: ${getRecipeDisplayName(getRecipe(currentId))}`
    : "Nessuna ricetta assegnata a questo pasto.";
  document.getElementById("meal-restore-item").style.display = (defaultId && defaultId !== currentId) ? "" : "none";
  document.getElementById("meal-target-list").classList.add("hidden");
  modal.classList.remove("hidden");
};

window.closeMealActions = function() {
  document.getElementById("meal-actions-modal")?.classList.add("hidden");
};

function mealTargetRows(mode) {
  const { day: sourceDay, slot } = mealActionsTarget;
  const options = [];
  DAY_ORDER.forEach(day => {
    if (day === sourceDay) return;
    const recipe = getRecipe(appState.plan.days[day][slot]);
    const icon = mode === "swap" ? "⇄" : "→";
    options.push(`<button class="swap-item" onclick="${mode === "swap" ? "confirmSwapMeal" : "confirmCopyMeal"}('${sourceDay}', '${slot}', '${day}')"><span class="swap-code">${DAY_NAMES[day].slice(0, 3).toUpperCase()}</span><span><strong>${escapeHtml(recipe ? `${recipe.emoji || "🍲"} ${getRecipeDisplayName(recipe)}` : "Nessuna ricetta")}</strong><small>${escapeHtml(getSlotMeta(slot).label)} · ${icon} ${mode === "swap" ? "scambia" : "copia"}</small></span></button>`);
  });
  return options.join("");
}

window.renderMealSwapList = function() {
  document.getElementById("meal-target-list").classList.remove("hidden");
  document.getElementById("meal-target-list").innerHTML = `<h3>Scambia con un altro giorno (stesso tipo pasto)</h3>${mealTargetRows("swap")}`;
};

window.renderMealCopyList = function() {
  document.getElementById("meal-target-list").classList.remove("hidden");
  document.getElementById("meal-target-list").innerHTML = `<h3>Copia in un altro giorno</h3>${mealTargetRows("copy")}`;
};

window.confirmSwapMeal = async function(dayA, slot, dayB) {
  if (!confirm(`Scambiare i pasti tra ${DAY_NAMES[dayA]} e ${DAY_NAMES[dayB]}? Lo scambio è bidirezionale e salva il piano una sola volta.`)) return;
  try {
    appState.plan = window.PianoDomain ? PianoDomain.swapMeals(appState.plan, dayA, slot, dayB, slot) : appState.plan;
    await saveWeeklyPlan(appState.plan);
    closeMealActions();
    handleRoute();
    showToast("Pasti scambiati ✅");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Scambio non riuscito", true);
  }
};

window.confirmCopyMeal = async function(fromDay, slot, toDay) {
  if (!confirm(`Copiare il pasto da ${DAY_NAMES[fromDay]} a ${DAY_NAMES[toDay]}? Il pasto sorgente resta invariato.`)) return;
  try {
    appState.plan = window.PianoDomain ? PianoDomain.copyMeal(appState.plan, fromDay, slot, toDay) : appState.plan;
    await saveWeeklyPlan(appState.plan);
    closeMealActions();
    handleRoute();
    showToast("Pasto copiato ✅");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Copia non riuscita", true);
  }
};

window.confirmRestoreMeal = async function() {
  if (!mealActionsTarget) return;
  const { day, slot } = mealActionsTarget;
  if (!confirm(`Ripristinare la scelta iniziale per ${DAY_NAMES[day]} ${getSlotMeta(slot).label}?`)) return;
  try {
    appState.plan = window.PianoDomain ? PianoDomain.restoreMeal(appState.plan, day, slot) : appState.plan;
    await saveWeeklyPlan(appState.plan);
    closeMealActions();
    handleRoute();
    showToast("Scelta iniziale ripristinata ✅");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Ripristino non riuscito", true);
  }
};

function renderRecipes({ loading = false } = {}) {
  const container = document.getElementById("view-recipes");
  if (!container) return;
  if (loading) {
    const skeletonCards = Array.from({ length: 6 }, () => `
      <div class="recipe-skeleton" aria-hidden="true">
        <div class="skeleton-line short"></div>
        <div class="skeleton-line title"></div>
        <div class="skeleton-line medium"></div>
        <div class="skeleton-line chip"></div>
      </div>`).join("");
    container.setAttribute("aria-busy", "true");
    container.innerHTML = `
      <div class="page-heading recipes-heading">
        <div><p class="eyebrow">Sincronizzazione in corso</p><h1>Ricettario</h1><p>Stiamo aggiornando le tue ricette.</p></div>
      </div>
      <div class="recipe-grid recipe-skeleton-grid">${skeletonCards}</div>
    `;
    return;
  }

  container.setAttribute("aria-busy", "false");
  const recipeLibraryState = getRecipeLibraryState();
  container.innerHTML = `
    <div class="page-heading recipes-heading">
      <div><p class="eyebrow">${appState.recipes.length} ricette · sincronizzate nel cloud</p><h1>Ricettario</h1><p>Puoi creare, esportare, importare e condividere le ricette del tuo account.</p></div>
      <div class="recipe-toolbar">
        <button class="btn btn-outline" onclick="openTransferModal()">Importa/Esporta</button>
        <button class="btn btn-outline" onclick="openShareDialog()">Invia a un utente</button>
        <button class="btn btn-primary" onclick="createNewRecipe()">+ Nuova</button>
        <button class="btn btn-danger" onclick="deleteAllRecipes()"${appState.recipes.length ? "" : " disabled"}>🗑 Elimina tutte</button>
      </div>
    </div>
    ${appState.recipes.length ? `<label class="search-box"><span>⌕</span><input id="recipe-search" type="search" value="${escapeAttr(recipeLibraryState.searchQuery)}" placeholder="Cerca ricetta, categoria o ingrediente…" oninput="filterRecipeCards(this.value)"><button type="button" id="recipe-search-clear" class="search-clear-btn ${recipeLibraryState.searchQuery ? "" : "hidden"}" onclick="clearRecipeSearch()" aria-label="Cancella ricerca" title="Cancella ricerca">×</button></label><p id="recipe-search-empty" class="text-muted recipe-search-empty hidden">Nessuna ricetta trovata. Prova con un altro nome, ingrediente o categoria.</p>${MEAL_SLOTS.map(slot => recipeSectionHtml(slot.label, appState.recipes.filter(recipe => recipe.slot === slot.id), slot)).join("")}` : `<div class="empty-state recipe-empty-state"><span>🍲</span><h2>Il tuo ricettario è vuoto</h2><p>Puoi creare la prima ricetta manualmente, importare un file JSON o attendere una condivisione da un altro utente.</p><button class="btn btn-primary" onclick="createNewRecipe()">+ Crea la prima ricetta</button></div>`}
  `;
  if (appState.recipes.length) filterRecipeCards(recipeLibraryState.searchQuery, { persist: false });
}

function recipeSectionHtml(title, recipes, slot) {
  if (!recipes.length) return "";
  const sectionId = `recipe-section-${slot.id}`;
  const isOpen = getRecipeLibraryState().openSections[slot.id];
  return `
    <section class="recipe-library-section" data-slot="${slot.id}">
      <button class="recipe-section-toggle ${isOpen ? "" : "collapsed"}" onclick="toggleRecipeSection('${slot.id}', this)" aria-expanded="${isOpen ? "true" : "false"}" aria-controls="${sectionId}">
        <span class="recipe-section-icon" aria-hidden="true">${slot.emoji}</span>
        <span class="recipe-section-name" role="heading" aria-level="2">${escapeHtml(title)}</span>
        <small class="recipe-section-count" aria-label="${recipes.length} ${recipes.length === 1 ? "ricetta" : "ricette"}">
          <span class="recipe-count-full">${recipes.length} ${recipes.length === 1 ? "ricetta" : "ricette"}</span>
          <span class="recipe-count-compact" aria-hidden="true">${recipes.length}</span>
        </small>
        <b class="recipe-section-chevron" aria-hidden="true">⌄</b>
      </button>
      <div id="${sectionId}" class="recipe-section-body ${isOpen ? "" : "hidden"}">
        <div class="recipe-grid">
          ${recipes.map(recipe => `<button class="recipe-library-card" data-search="${escapeAttr(`${recipe.id} ${recipe.name} ${recipe.namesByDayType?.training || ""} ${recipe.namesByDayType?.rest || ""} ${recipeProteinLabel(recipe)} ${(recipe.ingredients || []).map(i => i.name).join(" ")}`.toLowerCase())}" onclick="openRecipeModal('${escapeAttr(recipe.id)}')"><span class="recipe-code">${escapeHtml(recipe.id)}</span>${recipe.fromProfessional ? '<span class="pro-badge">🩺 Professionista</span>' : ''}<span class="recipe-card-emoji">${escapeHtml(recipe.emoji || "🍲")}</span><strong>${escapeHtml(recipe.name)}</strong><small>${escapeHtml(recipeProteinLabel(recipe))}</small></button>`).join("")}
        </div>
      </div>
    </section>`;
}

window.toggleRecipeSection = function(slotId, button) {
  const body = document.getElementById(`recipe-section-${slotId}`);
  if (!body) return;
  const closed = body.classList.toggle("hidden");
  button.classList.toggle("collapsed", closed);
  button.setAttribute("aria-expanded", String(!closed));
  updateRecipeLibraryState(state => ({
    ...state,
    openSections: { ...state.openSections, [slotId]: !closed }
  }));
};

window.filterRecipeCards = function(query, options = {}) {
  const rawQuery = String(query || "").trim();
  const normalized = rawQuery.toLowerCase();
  const persist = options.persist !== false;
  const state = persist
    ? updateRecipeLibraryState(current => ({ ...current, searchQuery: rawQuery }))
    : getRecipeLibraryState();
  let totalMatches = 0;
  document.querySelectorAll(".recipe-library-section").forEach(section => {
    const cards = [...section.querySelectorAll(".recipe-library-card")];
    const slotId = section.dataset.slot;
    let matchingCards = 0;
    cards.forEach(card => {
      const matches = !normalized || card.dataset.search.includes(normalized);
      card.classList.toggle("hidden", !matches);
      if (matches) matchingCards += 1;
    });
    totalMatches += matchingCards;

    const toggle = section.querySelector(".recipe-section-toggle");
    const body = section.querySelector(".recipe-section-body");
    if (!normalized) {
      const isOpen = Boolean(state.openSections[slotId]);
      section.classList.remove("hidden");
      body?.classList.toggle("hidden", !isOpen);
      toggle?.classList.toggle("collapsed", !isOpen);
      toggle?.setAttribute("aria-expanded", String(isOpen));
      return;
    }

    const hasMatches = matchingCards > 0;
    section.classList.toggle("hidden", !hasMatches);
    body?.classList.toggle("hidden", !hasMatches);
    toggle?.classList.toggle("collapsed", !hasMatches);
    toggle?.setAttribute("aria-expanded", String(hasMatches));
  });
  const clearButton = document.getElementById("recipe-search-clear");
  if (clearButton) clearButton.classList.toggle("hidden", !rawQuery);
  const emptyState = document.getElementById("recipe-search-empty");
  if (emptyState) emptyState.classList.toggle("hidden", !rawQuery || totalMatches > 0);
};

window.clearRecipeSearch = function() {
  const input = document.getElementById("recipe-search");
  if (input) {
    input.value = "";
    input.focus();
  }
  filterRecipeCards("");
};

window.createNewRecipe = function(slot = "lunch", assignDay = null) {
  const selectedSlot = MEAL_SLOTS.some(item => item.id === slot) ? slot : "lunch";
  const id = `U${Date.now()}`;
  const recipe = {
    id, slot: selectedSlot, name: "Nuova ricetta", emoji: getSlotMeta(selectedSlot).emoji, proteinCategory: "",
    ingredients: [], steps: [], notes: []
  };
  currentModal = { recipe, original: null, dayKey: DAY_ORDER.includes(assignDay) ? assignDay : null, dayType: DAY_ORDER.includes(assignDay) ? getDayType(assignDay) : getRecipePreviewDayType(), assignAfterSave: DAY_ORDER.includes(assignDay) ? { day: assignDay, slot: selectedSlot } : null, isNew: true };
  editMode = true;
  setModalTab("tab-ingredients");
  renderModalContent();
  document.getElementById("recipe-modal").classList.remove("hidden");
  // Solo in creazione: il titolo "Nuova ricetta" viene autofocusato e
  // selezionato per intero, pronto alla sostituzione con la prima battitura.
  setTimeout(() => {
    const titleInput = document.getElementById("edit-recipe-name");
    titleInput?.focus();
    try { titleInput?.select?.(); } catch (_) {}
  }, 60);
};

function duplicatedRecipeFrom(sourceRecipe) {
  const normalized = normalizeRecipeSchema(sourceRecipe);
  const slot = normalized.slot || "lunch";
  return {
    id: `U${Date.now()}`,
    slot,
    name: `${normalized.name || "Ricetta"} (copia)`,
    emoji: normalized.emoji || getSlotMeta(slot).emoji,
    proteinCategory: normalized.proteinCategory || "",
    ingredients: clone(normalized.ingredients || []),
    steps: clone(normalized.steps || []),
    notes: clone(normalized.notes || []),
    ...(normalized.namesByDayType ? { namesByDayType: clone(normalized.namesByDayType) } : {})
  };
}

window.duplicateRecipe = function(recipeId = currentModal?.recipe?.id) {
  const sourceRecipe = recipeId ? getRecipe(recipeId) : null;
  if (!sourceRecipe) return;
  currentModal = {
    recipe: duplicatedRecipeFrom(sourceRecipe),
    original: null,
    dayKey: null,
    dayType: getRecipePreviewDayType(),
    slot: null,
    isNew: true
  };
  editMode = true;
  renderModalContent();
  document.getElementById("recipe-modal").classList.remove("hidden");
};

function parseSimpleAmount(raw) {
  // Mantiene il fallback locale per il rendering del modale, ma usa la stessa
  // normalizzazione della lista spesa quando il dominio è disponibile.
  if (window.PianoDomain?.parseSimpleAmount) return PianoDomain.parseSimpleAmount(raw);
  const original = String(raw ?? "").trim();
  if (isEmptyPortion(original) || /^0(?:[.,]0+)?\s*(g|ml)?$/i.test(original)) return { skip: true };
  if (/^(q\.?b\.?|liber[oaie]|a piacere)$/i.test(original)) return { free: true, label: original };
  const fractionMap = { "½": 0.5, "¼": 0.25, "¾": 0.75 };
  const match = original.match(/^(\d+(?:[.,]\d+)?|[½¼¾])\s*(g|ml|pz|cucchiaio|cucchiai|cucchiaino|cucchiaini)?$/i);
  if (!match) return { opaque: original };
  let value = fractionMap[match[1]] ?? Number(match[1].replace(",", "."));
  let unit = (match[2] || "pz").toLowerCase();
  if (unit === "cucchiaio" || unit === "cucchiai") { value *= 10; unit = "g"; }
  if (unit === "cucchiaino" || unit === "cucchiaini") { value *= 5; unit = "g"; }
  return { value, unit };
}

function aggregateShoppingList() {
  if (!window.PianoDomain || !appState.plan) return [];
  // Aggregazione per ingredientId (schema 4): le quantità vengono sommate
  // solo quando condividono lo stesso ingredientId stabile.
  const entries = PianoDomain.aggregateShopping(
    appState.plan,
    appState.recipesById,
    appState.shopping.selectedMeals,
    getPortionProfile(),
    {},
    // Stesso interruttore della Settimana: con lo switch spento la spesa elenca
    // le dosi originali delle ricette, non quelle allineate alla dieta. Il
    // moltiplicatore porzioni vale solo per il profilo coppia.
    {
      resolveRecipe: shoppingResolveRecipe,
      quantityMultiplier: getPortionProfile() === "couple" ? getCoupleMultiplier() : 1
    }
  );
  return entries.map(entry => ({
    ...entry,
    id: entry.ingredientId,
    legacyId: PianoDomain.slug(entry.name)
  }));
}

function entryMatchesId(entry, id) {
  return entry.id === id || entry.legacyId === id;
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100).replace(".", ",");
}

function pluralizeOpaqueUnit(unit, amount) {
  const value = String(unit || "").trim();
  if (amount === 1 || !value) return value;
  const [first, ...rest] = value.split(/\s+/);
  const known = {
    mazzetto: "mazzetti", fetta: "fette", spicchio: "spicchi", ciuffo: "ciuffi",
    rametto: "rametti", foglia: "foglie", vasetto: "vasetti", confezione: "confezioni"
  };
  let plural = known[first.toLowerCase()];
  if (!plural && /o$/i.test(first)) plural = first.slice(0, -1) + "i";
  if (!plural && /a$/i.test(first)) plural = first.slice(0, -1) + "e";
  if (!plural && /e$/i.test(first)) plural = first.slice(0, -1) + "i";
  return [plural || first, ...rest].join(" ");
}

function formatOpaqueShoppingParts(opaque = {}) {
  const items = Object.entries(opaque).map(([label, count]) => ({
    label,
    count,
    raw: label
  }));
  const groups = new Map();
  items.forEach(item => {
    const key = item.raw.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });

  const primary = [];
  const details = [];
  groups.forEach(group => {
    const counted = group[0].raw.match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/);
    // Valori opachi uguali (es. "1 mazzetto") possono essere sommati senza
    // perdere significato.
    if (counted) {
      const perOccurrence = Number(counted[1].replace(",", "."));
      const total = group.reduce((sum, item) => sum + perOccurrence * item.count, 0);
      primary.push(`${formatNumber(total)} ${pluralizeOpaqueUnit(counted[2], total)}`);
      return;
    }
    // Se non è possibile sommare, conserviamo l'etichetta originale come
    // ripiego leggibile. Sarà ignorata quando esiste un valore primario.
    group.forEach(item => details.push(item.label));
  });
  return { primary, details };
}

function shoppingAmountText(entry) {
  const custom = appState.shopping.customQuantities?.[entry.id] ?? appState.shopping.customQuantities?.[entry.legacyId];
  if (custom !== undefined && String(custom).trim()) return custom;
  const numeric = Object.entries(entry.totals).map(([unit, total]) => `${formatNumber(total)}${unit === "pz" ? " pz" : unit}`);
  const opaque = formatOpaqueShoppingParts(entry.opaque);
  const primary = [...numeric, ...opaque.primary];
  if (primary.length) return primary.join(" + ");
  if (entry.free && !opaque.details.length) return "q.b. / libera";
  return opaque.details.join(" · ") || "—";
}

function getVisibleShoppingEntries() {
  const excluded = new Set(appState.shopping.excludedItems || []);
  return aggregateShoppingList().filter(entry => {
    // Compatibilità con esclusioni salvate con il vecchio id (slug del nome).
    if (excluded.has(entry.id) || excluded.has(entry.legacyId)) return false;
    if (!appState.shopping.includePantry && ["🥫 Dispensa", "🌿 Spezie e aromi"].includes(entry.category)) return false;
    return true;
  });
}

// Ordina gli alimenti di una categoria con l'ordine salvato nel documento
// spesa condiviso (itemOrder, chiavi = ingredientId, mai i nomi visibili):
// prima gli id salvati ancora presenti, poi tutti gli altri in coda, così un
// ingrediente nuovo non rompe l'ordine scelto. Robustezza finale: se un id
// non venisse risolto, la voce resta comunque visibile in coda.
function sortShopCategoryItems(category, entries) {
  if (!entries || entries.length < 2) return entries || [];
  const savedOrder = appState.shopping?.itemOrder?.[category];
  const resolvedIds = window.PianoDomain?.resolveShopItemOrder
    ? PianoDomain.resolveShopItemOrder(savedOrder, entries.map(entry => entry.id))
    : entries.map(entry => entry.id);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const ordered = [];
  const used = new Set();
  resolvedIds.forEach(id => {
    if (!used.has(id) && byId.has(id)) {
      ordered.push(byId.get(id));
      used.add(id);
    }
  });
  entries.forEach(entry => {
    if (!used.has(entry.id)) ordered.push(entry);
  });
  return ordered;
}

// Raggruppa le voci per categoria nell'ordine configurabile delle categorie e
// con gli alimenti ordinati dentro ogni categoria secondo itemOrder. Unica
// fonte dell'ordine sia per la vista Spesa sia per Copia/Condividi: testo e
// schermata non possono divergere.
function groupShoppingEntries(entries) {
  const categoryOrder = resolveShopCategoryOrder(entries.map(entry => entry.category));
  const grouped = Object.fromEntries(categoryOrder.map(category => [category, []]));
  entries.forEach(entry => {
    if (!grouped[entry.category]) grouped[entry.category] = [];
    grouped[entry.category].push(entry);
  });
  Object.keys(grouped).forEach(category => {
    grouped[category] = sortShopCategoryItems(category, grouped[category] || []);
  });
  return { categoryOrder, grouped };
}

function renderShoppingAccessGate(container) {
  const access = window.PianoSaas?.shoppingAccess?.(Date.now(), appState.saasContext);
  if (!access || access.allowed) return false;
  const available = access.reason === "reward-available";
  container.innerHTML = `<section class="shopping-access-gate">
    <div class="shopping-gate-mark" aria-hidden="true">🛒</div>
    <p class="eyebrow">LISTA DELLA SPESA</p>
    <h1>Porta il piano con te,<br>senza pensare a cosa manca.</h1>
    <p>${available ? "Guarda un breve contenuto dello sponsor e usa la lista completa per 24 ore." : "L’accesso tramite sponsor sarà disponibile a breve. Il tuo piano e le tue ricette restano sempre accessibili."}</p>
    <button class="btn btn-primary" onclick="unlockShoppingWithAd()" ${available ? "" : "disabled"}>${available ? "Guarda e sblocca per 24 ore" : "In arrivo"}</button>
    <small>La pubblicità non riceve ricette, ingredienti o informazioni sul tuo profilo nutrizionale.</small>
  </section>`;
  return true;
}

window.unlockShoppingWithAd = async function() {
  try {
    await PianoSaas.requestShoppingReward();
    renderShop();
  } catch (error) {
    showToast(error.message || "Sblocco non disponibile", true);
  }
};

function renderShop() {
  const container = document.getElementById("view-shop");
  if (renderShoppingAccessGate(container)) return;
  const entries = getVisibleShoppingEntries();
  const { categoryOrder, grouped } = groupShoppingEntries(entries);
  const allSelected = DAY_ORDER.every(day => MEAL_SLOTS.every(slot => (appState.shopping.selectedMeals[day] || []).includes(slot.id)));
  container.innerHTML = `
    <div class="page-heading shop-heading"><div><p class="eyebrow">Dosi esatte · ${escapeHtml(getProfileLabel())}</p><h1>Lista della spesa</h1><p>Le quantità derivano solo dai pasti selezionati, senza fattori percentuali.</p></div><button class="btn btn-outline" onclick="toggleShopSettings()">${shopSettingsVisible ? "Chiudi" : "Seleziona"}</button></div>
    ${shopSettingsVisible ? renderShopSettings(allSelected, grouped) : ""}
    <div class="shopping-summary"><strong>${entries.length} alimenti</strong><span>${DAY_ORDER.reduce((sum, day) => sum + (appState.shopping.selectedMeals[day] || []).length, 0)} pasti selezionati</span></div>
    ${categoryOrder.map(category => grouped[category]?.length ? `
      <section class="shop-category">
        <h2 class="shop-category-title">${category}</h2>
        ${grouped[category].map(entry => `<div class="shop-item"><div class="shop-item-details"><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.tags.join(" · "))}</small></div><input class="shop-amount-input" aria-label="Quantità ${escapeAttr(entry.name)}" value="${escapeAttr(shoppingAmountText(entry))}" onchange="updateShopItemQty('${escapeAttr(entry.id)}', this.value)"><button class="btn-icon remove-shop-item" title="Escludi" onclick="excludeShopItem('${escapeAttr(entry.id)}')">×</button></div>`).join("")}
      </section>` : "").join("")}
    ${entries.length ? `<div class="shop-actions"><button class="btn btn-outline" onclick="copyShopList()">📋 Copia</button><button class="btn btn-primary whatsapp-btn" onclick="shareShopWhatsApp()">Condividi</button></div>` : `<div class="empty-state"><span>🛒</span><h3>Lista vuota</h3><p>Apri “Seleziona” e scegli almeno un pasto.</p></div>`}
  `;
}

// Etichette leggibili degli alimenti: la lista spesa salva gli id ingrediente
// (es. "whole-eggs") e, per le esclusioni più vecchie, lo slug del nome. La
// mappa viene costruita dall'aggregazione corrente (che include anche gli
// alimenti già esclusi) usando sia l'id sia il legacy id come chiave.
function shoppingItemLabels() {
  const labels = new Map();
  aggregateShoppingList().forEach(entry => {
    if (entry.id && !labels.has(entry.id)) labels.set(entry.id, entry.name);
    if (entry.legacyId && !labels.has(entry.legacyId)) labels.set(entry.legacyId, entry.name);
  });
  return labels;
}

// Nome in italiano di un alimento escluso: prima la lista corrente, poi le
// etichette canoniche del catalogo, infine l'id reso leggibile come extrema ratio.
function excludedItemLabel(id, labels) {
  const known = labels?.get(id);
  if (known) return known;
  // Ultima risorsa: il catalogo globale caricato in memoria.
  const catalog = buildLocalCatalogIndex();
  const ingredient = catalog.byId?.get(id)?.ingredient;
  if (ingredient?.displayName) return ingredient.displayName;
  const family = catalog.familiesById?.get(id);
  if (family?.displayName) return family.displayName;
  const text = String(id).replaceAll("-", " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : String(id);
}

function renderShopSettings(allSelected, groupedEntries = null) {
  const excludedItems = appState.shopping.excludedItems || [];
  const categoryOrder = resolveShopCategoryOrder();
  const labels = shoppingItemLabels();
  // Categorie con almeno un alimento in lista, nell'ordine mostrato in Spesa.
  const grouped = groupedEntries || groupShoppingEntries(getVisibleShoppingEntries()).grouped;
  const itemCategories = Object.keys(grouped).filter(category => grouped[category]?.length);
  return `
    <section class="shop-settings card">
      <div class="flex-between"><h2>Pasti da includere</h2><button class="btn btn-small btn-outline" onclick="toggleShopAllWeek(${!allSelected})">${allSelected ? "Deseleziona tutto" : "Seleziona tutto"}</button></div>
      <div class="shop-day-grid">
        ${DAY_ORDER.map(day => {
          const selected = appState.shopping.selectedMeals[day] || [];
          const dayIsSelected = MEAL_SLOTS.every(slot => selected.includes(slot.id));
          return `<div class="shop-day-row"><div class="shop-day-head"><strong>${DAY_NAMES[day]}</strong><button class="btn btn-small btn-outline" onclick="toggleShopDay('${day}')">${dayIsSelected ? "Annulla" : "Tutto"}</button></div><div class="shop-meal-checks">${MEAL_SLOTS.map(slot => `<label><input type="checkbox" ${selected.includes(slot.id) ? "checked" : ""} onchange="toggleShopMeal('${day}', '${slot.id}', this.checked)"> ${escapeHtml(slot.label)}</label>`).join("")}</div></div>`;
        }).join("")}
      </div>
      <label class="settings-row"><span><strong>Dispensa e spezie</strong><small>Olio, frutta secca, aromi e condimenti</small></span><input type="checkbox" ${appState.shopping.includePantry ? "checked" : ""} onchange="toggleShopPantry(this.checked)"></label>
      ${excludedItems.length ? `<div class="excluded-list">
        <h3>Esclusi (${excludedItems.length})</h3>
        <p class="excluded-hint">Tocca un alimento per rimetterlo in lista.</p>
        ${excludedItems.map(id => `<button class="frequency-chip" aria-label="Rimetti in lista ${escapeAttr(excludedItemLabel(id, labels))}" onclick="includeShopItem('${escapeAttr(id)}')">${escapeHtml(excludedItemLabel(id, labels))} ×</button>`).join(" ")}
      </div>` : ""}
      <div class="shop-order-settings">
        <div class="flex-between"><h2>Ordine categorie</h2><button class="btn btn-small btn-outline" onclick="resetShopCategoryOrder()">Ripristina ordine predefinito</button></div>
        <p class="text-muted">Questo ordine viene usato sia nella vista Spesa sia nella copia/condivisione testuale.</p>
        <div class="shop-category-order-list">
          ${categoryOrder.map((category, index) => `<div class="shop-category-order-row"><strong>${escapeHtml(category)}</strong><div class="shop-category-order-actions"><button class="btn btn-small btn-outline" aria-label="Sposta in alto ${escapeAttr(category)}" ${index === 0 ? "disabled" : ""} onclick="moveShopCategory(${index}, -1)">↑</button><button class="btn btn-small btn-outline" aria-label="Sposta in basso ${escapeAttr(category)}" ${index === categoryOrder.length - 1 ? "disabled" : ""} onclick="moveShopCategory(${index}, 1)">↓</button></div></div>`).join("")}
        </div>
        ${itemCategories.length ? `
        <div class="shop-item-order-settings">
          <h2>Ordine alimenti</h2>
          <p class="text-muted">Sposta gli alimenti dentro ogni categoria nell’ordine in cui li trovi al supermercato. L’ordine è condiviso con gli account collegati, vale anche per Copia e Condividi e gli alimenti nuovi compaiono in coda.</p>
          ${itemCategories.map((category, categoryIndex) => `
          <div class="shop-item-order-category">
            <div class="shop-item-order-head"><strong>${escapeHtml(category)}</strong><div class="shop-category-order-actions"><button class="btn btn-small btn-outline" aria-label="Ordina alfabeticamente ${escapeAttr(category)}" onclick="sortShopItemsAZ(${categoryIndex})">A→Z</button><button class="btn btn-small btn-outline" aria-label="Ripristina l’ordine automatico di ${escapeAttr(category)}" onclick="resetShopItemOrder(${categoryIndex})">Ripristina</button></div></div>
            <div class="shop-category-order-list">
              ${grouped[category].map((entry, index) => `<div class="shop-category-order-row"><strong>${escapeHtml(entry.name)}</strong><div class="shop-category-order-actions"><button class="btn btn-small btn-outline" aria-label="Sposta in alto ${escapeAttr(entry.name)}" ${index === 0 ? "disabled" : ""} onclick="moveShopItem(${categoryIndex}, ${index}, -1)">↑</button><button class="btn btn-small btn-outline" aria-label="Sposta in basso ${escapeAttr(entry.name)}" ${index === grouped[category].length - 1 ? "disabled" : ""} onclick="moveShopItem(${categoryIndex}, ${index}, 1)">↓</button></div></div>`).join("")}
            </div>
          </div>`).join("")}
        </div>` : ""}
      </div>
    </section>`;
}

window.toggleShopSettings = function() {
  shopSettingsVisible = !shopSettingsVisible;
  renderShop();
};

window.moveShopCategory = function(index, delta) {
  const order = resolveShopCategoryOrder();
  const target = index + delta;
  if (target < 0 || target >= order.length) return;
  [order[index], order[target]] = [order[target], order[index]];
  saveShopCategoryOrder(order);
  renderShop();
};

window.resetShopCategoryOrder = function() {
  saveShopCategoryOrder(SHOP_CATEGORY_ORDER);
  renderShop();
};

// ---- Ordine alimenti dentro le categorie ----
// A differenza dell'ordine delle categorie (preferenza locale del dispositivo),
// l'ordine degli alimenti vive nel documento Firestore della spesa ed è quindi
// condiviso: l'altro account collegato alla household lo riceve in tempo reale
// grazie al listener già attivo sul documento.

// Categorie con almeno un alimento in lista, nell'ordine del pannello.
function shopItemOrderCategories() {
  const { categoryOrder, grouped } = groupShoppingEntries(getVisibleShoppingEntries());
  return categoryOrder.filter(category => (grouped[category] || []).length);
}

// Id correnti di una categoria nell'ordine effettivamente mostrato.
function shopItemOrderIdsFor(category) {
  return sortShopCategoryItems(category, getVisibleShoppingEntries().filter(entry => entry.category === category))
    .map(entry => entry.id);
}

function saveShopItemOrder(category, orderedIds) {
  const itemOrder = { ...(appState.shopping.itemOrder || {}) };
  itemOrder[category] = [...new Set((orderedIds || []).filter(Boolean))];
  appState.shopping.itemOrder = itemOrder;
  // Stesso pattern delle altre interazioni della spesa: stato aggiornato subito,
  // scrittura remota accorpata dal debounce, rendering immediato.
  queueShoppingSave();
  renderShop();
}

window.moveShopItem = function(categoryIndex, itemIndex, delta) {
  const category = shopItemOrderCategories()[categoryIndex];
  if (!category) return;
  const ids = shopItemOrderIdsFor(category);
  const target = itemIndex + delta;
  if (target < 0 || target >= ids.length) return;
  [ids[itemIndex], ids[target]] = [ids[target], ids[itemIndex]];
  saveShopItemOrder(category, ids);
};

window.sortShopItemsAZ = function(categoryIndex) {
  const category = shopItemOrderCategories()[categoryIndex];
  if (!category) return;
  const items = getVisibleShoppingEntries()
    .filter(entry => entry.category === category)
    .sort((left, right) => left.name.localeCompare(right.name, "it", { sensitivity: "base" }));
  saveShopItemOrder(category, items.map(entry => entry.id));
};

// "Ripristina" per categoria: rimuove l'ordine salvato e torna all'ordine
// automatico di primo incontro scorrendo la settimana.
window.resetShopItemOrder = function(categoryIndex) {
  const category = shopItemOrderCategories()[categoryIndex];
  if (!category) return;
  const itemOrder = { ...(appState.shopping.itemOrder || {}) };
  delete itemOrder[category];
  appState.shopping.itemOrder = itemOrder;
  queueShoppingSave();
  renderShop();
};

// ---- Salvataggio lista spesa con debounce ----
// Ogni interazione aggiorna SUBITO interfaccia e cache locale (localStorage),
// così un refresh immediato non perde le spunte. La scrittura del documento
// Firestore viene invece accorpata: configurare la settimana spuntando le
// caselle una a una produce UNA sola scrittura remota invece di 50-100.
const SHOPPING_SAVE_DEBOUNCE_MS = 800;
let shoppingSaveTimer = null;
let shoppingSavePending = false;

function queueShoppingSave() {
  saveShoppingListLocal(appState.shopping);
  shoppingSavePending = true;
  clearTimeout(shoppingSaveTimer);
  shoppingSaveTimer = setTimeout(flushShoppingSave, SHOPPING_SAVE_DEBOUNCE_MS);
}

async function flushShoppingSave() {
  if (!shoppingSavePending) return;
  shoppingSavePending = false;
  clearTimeout(shoppingSaveTimer);
  shoppingSaveTimer = null;
  try {
    await saveShoppingListCloud(appState.shopping);
  } catch (error) {
    // Nessun errore bloccante: i dati restano in localStorage e nella coda
    // offline di Firestore; la prossima scrittura riallinea il documento.
    console.warn("Scrittura lista spesa rimandata", error);
  }
}

// Chiudendo la scheda o passando in background la scrittura pendente parte subito.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushShoppingSave();
});
if (typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", () => { flushShoppingSave(); });
}

window.toggleShopAllWeek = function(select) {
  DAY_ORDER.forEach(day => { appState.shopping.selectedMeals[day] = select ? MEAL_SLOTS.map(slot => slot.id) : []; });
  queueShoppingSave();
  renderShop();
};

window.toggleShopDay = function(day) {
  if (!DAY_ORDER.includes(day)) return;
  const selected = appState.shopping.selectedMeals[day] || [];
  const allSelected = MEAL_SLOTS.every(slot => selected.includes(slot.id));
  appState.shopping.selectedMeals[day] = allSelected ? [] : MEAL_SLOTS.map(slot => slot.id);
  queueShoppingSave();
  renderShop();
};

window.toggleShopMeal = function(day, slot, checked) {
  const selected = new Set(appState.shopping.selectedMeals[day] || []);
  checked ? selected.add(slot) : selected.delete(slot);
  appState.shopping.selectedMeals[day] = [...selected];
  queueShoppingSave();
  renderShop();
};

window.toggleShopPantry = function(checked) {
  appState.shopping.includePantry = checked;
  queueShoppingSave();
  renderShop();
};

window.updateShopItemQty = function(id, value) {
  appState.shopping.customQuantities[id] = value;
  queueShoppingSave();
};

window.excludeShopItem = function(id) {
  if (!appState.shopping.excludedItems.includes(id)) appState.shopping.excludedItems.push(id);
  queueShoppingSave();
  renderShop();
};

window.includeShopItem = function(id) {
  appState.shopping.excludedItems = appState.shopping.excludedItems.filter(value => value !== id);
  queueShoppingSave();
  renderShop();
};

function shoppingText() {
  const entries = getVisibleShoppingEntries();
  // Stesso raggruppamento/ordine del rendering: Copia e Condividi producono
  // testo coerente con la schermata (categorie E alimenti dentro le categorie).
  const { categoryOrder, grouped } = groupShoppingEntries(entries);
  const blocks = categoryOrder.map(category => {
    const items = grouped[category] || [];
    if (!items.length) return "";
    return `----- ${category}\n${items.map(entry => `${entry.name} - ${shoppingAmountText(entry)}`).join("\n")}`;
  }).filter(Boolean);
  return `🛒 Lista della spesa · ${getProfileLabel()}\n\n${blocks.join("\n\n")}`;
}

// Testo usato solo dal pulsante Copia: compatta la stessa lista senza
// intestazione "🛒 Lista della spesa..." e senza righe vuote tra le sezioni.
function shoppingTextCompact() {
  const entries = getVisibleShoppingEntries();
  const { categoryOrder, grouped } = groupShoppingEntries(entries);
  const lines = [];
  categoryOrder.forEach(category => {
    const items = grouped[category] || [];
    if (!items.length) return;
    lines.push(`----- ${category}`);
    items.forEach(entry => lines.push(`${entry.name} - ${shoppingAmountText(entry)}`));
  });
  return lines.join("\n");
}

window.copyShopList = async function() {
  const text = shoppingTextCompact();
  try {
    await navigator.clipboard.writeText(text);
    showToast("Lista copiata ✅");
  } catch (_) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    showToast("Lista copiata ✅");
  }
};

window.shareShopWhatsApp = async function() {
  const text = shoppingText();
  if (navigator.share) {
    try { await navigator.share({ title: "Lista della spesa", text }); } catch (_) {}
  } else {
    window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  }
};

// ---- Equivalenze della dieta assegnata (tap ingrediente → alternativa) ----
// Le equivalenze arrivano SOLO dai template collegati ai blocchi della
// struttura assegnata dal nutrizionista (snapshot non retroattivo + override
// della struttura): niente tabelle globali, niente grammature hardcoded.
// Il tap è disponibile solo quando la vista «dosi allineate» è attiva e
// l'ingrediente appartiene a un blocco con template o override.
function dietEquivalentsForIngredient(ingredientName, dayKey, slot) {
  if (!planAlignedDosesEffective()) return null;
  const engine = getDietEngine();
  if (!engine || !window.PianoDomain) return null;
  const recipe = currentModal?.recipe;
  if (!recipe) return null;
  const dayType = dayKey ? getDayType(dayKey) : (currentModal?.dayType || "training");
  const mealId = mealIdForSlot(slot || currentModal?.slot || recipe.slot);
  if (!mealId) return null;
  const options = engine.optionsFor(mealId, dayType) || [];
  const recognition = recognizeIngredientText(ingredientName);
  const targetFamilyId = recognition.familyId || null;
  const targetIngredientId = recognition.status === "resolved" ? recognition.ingredientId : null;
  for (const option of options) {
    for (const block of option.blocks || []) {
      const familyMatch = targetFamilyId && (
        block.referenceFamilyId === targetFamilyId
        || (block.templateSnapshot?.equivalents || []).some(equivalent => equivalent.familyId === targetFamilyId)
        || (block.overrides || []).some(override => override.familyId === targetFamilyId)
      );
      const ingredientMatch = targetIngredientId && (
        block.referenceIngredientId === targetIngredientId
        || (block.templateSnapshot?.equivalents || []).some(equivalent => equivalent.ingredientId === targetIngredientId)
        || (block.overrides || []).some(override => override.ingredientId === targetIngredientId)
      );
      if (!familyMatch && !ingredientMatch) continue;
      const equivalents = window.PianoDomain.dietBlockEquivalents ? PianoDomain.dietBlockEquivalents(block) : [];
      if (!equivalents.length) continue;
      const catalogIndex = buildLocalCatalogIndex();
      const labelFor = equivalent => {
        const ingredient = equivalent.ingredientId && catalogIndex.byId?.get(equivalent.ingredientId)?.ingredient;
        if (ingredient) return ingredient.displayName;
        return catalogIndex.familiesById?.get(equivalent.familyId)?.displayName || equivalent.familyId;
      };
      return {
        referenceFamilyLabel: catalogIndex.familiesById?.get(block.referenceFamilyId)?.displayName || block.referenceFamilyId,
        referenceAmount: block.referenceAmount,
        rows: equivalents.map(equivalent => ({
          label: labelFor(equivalent),
          amount: window.PianoDomain.formatAmount ? PianoDomain.formatAmount(equivalent.amount?.value, equivalent.amount?.unit) : "",
          overridden: Boolean(equivalent.overridden)
        }))
      };
    }
  }
  return null;
}

function setupDietEquivalentsModal() {
  if (document.getElementById("diet-equivalents-modal")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="diet-equivalents-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="diet-modal-title">
      <div class="modal-content diet-modal-content">
        <div class="modal-header"><div><p class="eyebrow">EQUIVALENZE</p><h2 id="diet-modal-title"></h2><p id="diet-modal-subtitle" class="text-muted"></p></div><button class="btn-icon" onclick="closeDietEquivalents()" aria-label="Chiudi">&times;</button></div>
        <div id="diet-modal-body"></div>
        <p class="diet-modal-note text-muted">Equivalenze dal template del tuo nutrizionista (pesi a crudo). La quantità è proporzionale alla dose prevista per questo pasto.</p>
        <div class="modal-footer"><button class="btn btn-primary full-width" onclick="closeDietEquivalents()">Chiudi</button></div>
      </div>
    </div>`);
  bindModalOutsideClose("diet-equivalents-modal", () => window.closeDietEquivalents());
}
window.openDietEquivalents = function(ingredientName) {
  setupDietEquivalentsModal();
  const data = dietEquivalentsForIngredient(ingredientName, currentModal?.dayKey, currentModal?.planSlot);
  if (!data) return;
  document.getElementById("diet-modal-title").textContent = ingredientName;
  document.getElementById("diet-modal-subtitle").textContent = `Blocco ${data.referenceFamilyLabel} · dose di riferimento ${window.PianoDomain?.formatAmount ? PianoDomain.formatAmount(data.referenceAmount?.value, data.referenceAmount?.unit) : ""}`;
  const body = document.getElementById("diet-modal-body");
  body.innerHTML = `<div class="alternative-table diet-equivalents"><div class="alternative-head"><strong>Alimento</strong><strong>Quantità equivalente</strong></div>${data.rows.map(row => `<div class="${row.overridden ? "diet-highlight" : ""}" title="${row.overridden ? "Quantità personalizzata dalla tua struttura dieta" : ""}"><span>${escapeHtml(row.label)}</span><strong>${escapeHtml(row.amount)}</strong></div>`).join("")}</div>`;
  document.getElementById("diet-equivalents-modal").classList.remove("hidden");
};
window.closeDietEquivalents = function() {
  document.getElementById("diet-equivalents-modal")?.classList.add("hidden");
};

function renderLinkedAccountsSection() {
  const ownUsername = usernameFromUser(appState.user);
  const household = appState.household;
  const linkedUsernames = (household?.memberUsernames || []).filter(username => username !== ownUsername);
  return `
    <section class="settings-section linked-accounts-section">
      <p class="eyebrow">ACCOUNT COLLEGATI</p>
      <div class="flex-between"><div><h2>Account collegati</h2><p class="text-muted">Settimana, ricette, batch cooking e spesa condivisi in tempo reale.</p></div><span class="link-status ${household ? "active" : ""}">${household ? "● Sincronizzato" : "Non collegato"}</span></div>
      ${linkedUsernames.length ? `<div class="linked-member-list">${linkedUsernames.map(username => `<div class="linked-member"><span class="account-avatar small">${escapeHtml(username.slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(username)}</strong><small>Può leggere e modificare tutti i dati condivisi</small></div></div>`).join("")}</div>` : `<p class="linked-empty">Nessun altro account collegato. Il profilo porzioni resta sempre personale e salvato solo su questo dispositivo.</p>`}
      <div class="linked-account-actions">
        <button class="btn btn-primary" onclick="openAccountLinkDialog()">+ Collega account</button>
        ${household ? `<button class="btn btn-danger" onclick="disconnectAccount()">Scollega questo account</button>` : ""}
      </div>
    </section>`;
}

function renderSaasProfileSection() {
  if (!window.PianoSaas?.config().enabled) return "";
  // La sezione "Profilo nutrizionale" esiste SOLO con un collegamento
  // professionale ATTIVO (appState.clientLink.link, restituito dal server).
  // Niente sezione quando: non c'è collegamento, la richiesta è solo
  // pendente, il collegamento è stato rifiutato/rimosso, oppure lo stato è
  // sconosciuto (caricamento o errore di rete): in tutti questi casi la UI
  // non deve mostrare un profilo che non esiste (niente lampo iniziale).
  if (!appState.clientLink || appState.clientLink.error || !appState.clientLink.link) return "";
  const context = appState.saasContext || {};
  if (context.state !== "assigned" || !context.profile) {
    // Collegamento attivo ma nessun profilo assegnato: sezione informativa.
    return `<section class="settings-section"><p class="eyebrow">PROFILO NUTRIZIONALE</p><h2>Dosi originali attive</h2><p class="text-muted">Non hai una struttura dieta assegnata. Le tue ricette restano con le dosi originali.</p></section>`;
  }
  const profile = context.profile;
  const pending = appState.saasPolicy?.migrationRequired;
  const profileLabel = `${profile.structureName || "Struttura dieta"} · revisione n. ${profile.structureRevisionId}`;
  return `<section class="settings-section saas-profile-card">
    <div><p class="eyebrow">PROFILO NUTRIZIONALE</p><h2>${pending ? "Nuovo profilo da confermare" : "Profilo verificato"}</h2><p class="text-muted">${escapeHtml(profileLabel)}</p></div>
    <span class="link-status ${pending ? "" : "active"}">${pending ? "In attesa" : "● Attivo"}</span>
    <p>${pending ? "Per proteggere il piano esistente stai ancora usando le dosi originali. Controlla il cambiamento prima di applicarlo." : "La tua dieta segue la revisione indicata: puoi sempre chiedere al tuo nutrizionista di aggiornarla."}</p>
    <a class="btn btn-outline" href="#diet">Apri «La mia dieta»</a>
    ${pending ? `<button class="btn btn-primary" onclick="openProfileUpdateModal()">Rivedi e applica il profilo</button>` : ""}
  </section>`;
}

// ---- «La mia dieta» (vista cliente della struttura assegnata+confermata) ----
// Rende giornate, pasti e opzioni della revisione assegnata: blocchi con
// grammature, equivalenti dai template collegati, opzioni ingredienti e
// opzioni ricetta con moltiplicatore. Con una sola opzione nessuna etichetta
// A/B/C: i dati restano options[], l'etichetta è solo visualizzazione.
function myDietProfile() {
  if (appState.saasPolicy?.mode !== "assigned") return null;
  return appState.saasContext?.profile || null;
}

function renderMyDietSettingsSection() {
  const profile = myDietProfile();
  if (!profile) return "";
  const plan = profile.structureRevision?.dietPlan;
  if (!plan) return "";
  const summary = window.PianoDomain?.dietPlanSummary ? PianoDomain.dietPlanSummary(plan) : {};
  return `<section class="settings-section">
    <div class="flex-between"><div><p class="eyebrow">LA MIA DIETA</p><h2>${escapeHtml(profile.structureName || "Struttura dieta")}</h2><p class="text-muted">Revisione n. ${escapeHtml(String(profile.structureRevisionId))} · ${summary.dayCount || 0} giornate</p></div><span class="link-status active">● Attiva</span></div>
    <p>Segui le dosi e le alternative indicate dal tuo nutrizionista in settimana, ricettario e spesa con l'interruttore «Dosi allineate alla mia dieta».</p>
    <a class="btn btn-outline" href="#diet">Apri «La mia dieta»</a>
  </section>`;
}

function dietAmountText(amount) {
  if (!amount || !Number.isFinite(Number(amount.value))) return "—";
  return window.PianoDomain?.formatAmount ? PianoDomain.formatAmount(Number(amount.value), amount.unit) : `${amount.value} ${amount.unit}`;
}

function myDietOptionHtml(option, optionIndex, optionCount) {
  const label = optionCount > 1 && window.PianoDomain?.DIET_PLAN_OPTION_LABELS
    ? `<span class="recipe-code">OPZIONE ${PianoDomain.DIET_PLAN_OPTION_LABELS[optionIndex] || optionIndex + 1}</span> `
    : "";
  let body = "";
  if (option.type === "recipe") {
    const recipe = getRecipe(option.recipeId);
    const multiplier = Number(option.recipeMultiplier || 1);
    body = recipe
      ? `<div class="diet-option-recipe"><strong>${escapeHtml(recipe.emoji || "🍲")} ${escapeHtml(recipe.name)}</strong><small>Ricetta del tuo ricettario${multiplier !== 1 ? ` · dosi ×${String(multiplier).replace(".", ",")}` : ""}</small></div>`
      : `<div class="diet-option-recipe"><strong>Ricetta non disponibile</strong><small>Chiedi al tuo nutrizionista di condividere la ricetta «${escapeHtml(option.recipeId || "")}»</small></div>`;
  } else if (option.type === "ingredients") {
    const catalogIndex = buildLocalCatalogIndex();
    body = `<ul class="diet-items">${(option.items || []).map(item => {
      const ingredient = catalogIndex.byId?.get(item.ingredientId)?.ingredient;
      return `<li><span>${escapeHtml(ingredient?.displayName || item.ingredientId)}</span><strong>${escapeHtml(dietAmountText(item.amount))}</strong></li>`;
    }).join("")}</ul>`;
  } else {
    const catalogIndex = buildLocalCatalogIndex();
    body = `<ul class="diet-blocks">${(option.blocks || []).map(block => {
      const family = catalogIndex.familiesById?.get(block.referenceFamilyId);
      const ingredient = block.referenceIngredientId && catalogIndex.byId?.get(block.referenceIngredientId)?.ingredient;
      const equivalents = window.PianoDomain?.dietBlockEquivalents ? PianoDomain.dietBlockEquivalents(block) : [];
      const equivalentsHtml = equivalents.length
        ? `<ul class="diet-equivalents">${equivalents.map(equivalent => {
            const equivalentIngredient = equivalent.ingredientId && catalogIndex.byId?.get(equivalent.ingredientId)?.ingredient;
            const equivalentFamily = catalogIndex.familiesById?.get(equivalent.familyId);
            return `<li><span>${escapeHtml(equivalentIngredient?.displayName || equivalentFamily?.displayName || equivalent.familyId)}</span><strong>${escapeHtml(dietAmountText(equivalent.amount))}</strong></li>`;
          }).join("")}</ul>`
        : "";
      return `<li><span>${escapeHtml(ingredient ? `${ingredient.displayName} (${family?.displayName || block.referenceFamilyId})` : family?.displayName || block.referenceFamilyId)}</span><strong>${escapeHtml(dietAmountText(block.referenceAmount))}</strong>${equivalentsHtml}</li>`;
    }).join("")}</ul>`;
  }
  return `<div class="diet-option">${label}${body}${option.note ? `<p class="diet-option-note">${escapeHtml(option.note)}</p>` : ""}</div>`;
}

function renderMyDietView() {
  const container = document.getElementById("view-diet");
  if (!container) return;
  const profile = myDietProfile();
  if (!profile) {
    container.innerHTML = `
      <div class="page-heading"><div><p class="eyebrow">PIANO ALIMENTARE</p><h1>La mia dieta</h1></div></div>
      <section class="settings-section"><p class="text-muted">Non hai ancora una dieta assegnata. Quando il tuo nutrizionista ti collega e assegna una struttura dieta, la trovi qui.</p></section>`;
    return;
  }
  const plan = profile.structureRevision?.dietPlan;
  if (!plan) {
    container.innerHTML = `
      <div class="page-heading"><div><p class="eyebrow">PIANO ALIMENTARE</p><h1>La mia dieta</h1></div></div>
      <section class="settings-section"><p class="text-muted">La struttura assegnata non contiene ancora un piano dieta. Contatta il tuo nutrizionista.</p></section>`;
    return;
  }
  const dayTypeLabel = { training: "Allenamento", rest: "Riposo", other: "Altra giornata" };
  const dayHtml = day => `
    <section class="settings-section diet-day">
      <div class="flex-between"><div><p class="eyebrow">${escapeHtml(String(day.dayType || "").toUpperCase())}</p><h2>${escapeHtml(day.label || dayTypeLabel[day.dayType] || "Giornata")}</h2></div></div>
      ${(day.meals || []).map(meal => `
        <div class="diet-meal">
          <h3>${escapeHtml(window.PianoDomain?.dietPlanMealLabel ? PianoDomain.dietPlanMealLabel(meal.mealId) : meal.mealId)}${meal.time ? ` <small>· ${escapeHtml(meal.time)}</small>` : ""}</h3>
          ${(meal.options || []).map((option, index) => myDietOptionHtml(option, index, (meal.options || []).length)).join("")}
          ${meal.note ? `<p class="diet-option-note">${escapeHtml(meal.note)}</p>` : ""}
        </div>`).join("")}
      ${day.supplements ? `<p class="diet-day-note"><strong>Integrazione:</strong> ${escapeHtml(day.supplements)}</p>` : ""}
      ${day.hydration ? `<p class="diet-day-note"><strong>Idratazione:</strong> ${escapeHtml(day.hydration)}</p>` : ""}
      ${day.note ? `<p class="diet-day-note">${escapeHtml(day.note)}</p>` : ""}
    </section>`;
  container.innerHTML = `
    <div class="page-heading"><div><p class="eyebrow">PIANO ALIMENTARE</p><h1>La mia dieta</h1><p>${escapeHtml(profile.structureName || "Struttura dieta")} · revisione n. ${escapeHtml(String(profile.structureRevisionId))}</p></div></div>
    ${(plan.days || []).map(dayHtml).join("")}
    ${plan.generalNotes ? `<section class="settings-section"><h2>Note del nutrizionista</h2><p>${escapeHtml(plan.generalNotes)}</p></section>` : ""}
    <section class="settings-section"><h2>Come leggerla</h2><p class="text-muted">I blocchi indicano la famiglia di riferimento e la dose prevista; le voci sotto ciascun blocco sono le equivalenze proporzionali del tuo nutrizionista. Le dosi si applicano a crudo. In settimana, ricettario e spesa puoi scegliere se vedere le dosi originali delle ricette o quelle allineate a questo piano.</p></section>`;
}

// ---- Collegamento professionista (SaaS, app cliente) ----
// Richieste in attesa (accetta/rifiuta) e scollegamento volontario con
// finestra di conferma. Lo scollegamento revoca solo l'associazione
// professionale: account, ricette, settimana e backup restano intatti.

// Ultimo stato VERIFICATO del collegamento, in cache locale per utente
// (chiave `pn_<uid>_client_link`, coerente con writeLocalJson di firebase.js):
// all'avvio badge e sezione Impostazioni partono subito dallo stato della
// sessione precedente invece di aspettare il server. È un'anteprima, non lo
// stato del server: il refresh di background la corregge, e un refresh
// fallito torna a segnare l'errore (mai maschera i pendenti con cache stantia).
const CLIENT_LINK_CACHE = "client_link";

async function refreshClientLinkState({ silent = false } = {}) {
  if (!window.PianoSaas?.config().enabled || typeof callSaasFunction !== "function") {
    appState.clientLink = null;
    return;
  }
  // Idratazione istantanea: primo refresh dell'avvio senza stato in memoria
  // parte dall'ultimo valore noto, così il badge non parte mai a zero.
  if (!appState.clientLink && appState.user?.uid) {
    const cached = readLocalJsonFor(appState.user.uid, CLIENT_LINK_CACHE, null);
    if (cached && !cached.error) appState.clientLink = cached;
  }
  try {
    appState.clientLink = await callSaasFunction("listMyClientLinkRequests", {}, { silent });
    writeLocalJson(CLIENT_LINK_CACHE, appState.clientLink);
  } catch (_) {
    appState.clientLink = { requests: [], link: null, error: true };
  }
  updateNotificationBadge();
  const modal = document.getElementById("incoming-shares-modal");
  if (modal && !modal.classList.contains("hidden")) renderIncomingShares();
  if (window.location.hash === "#settings") renderSettings();
}

function renderClientLinkSection() {
  if (!window.PianoSaas?.config().enabled) return "";
  const state = appState.clientLink;
  if (!state) {
    return `<section class="settings-section"><p class="eyebrow">PROFESSIONISTA</p><h2>Collegamento professionista</h2><p class="text-muted">Verifica del collegamento…</p></section>`;
  }
  if (state.error) {
    return `<section class="settings-section"><p class="eyebrow">PROFESSIONISTA</p><h2>Collegamento professionista</h2><p class="text-muted">Stato del collegamento non disponibile. Riprova; se il problema persiste, contatta il professionista.</p><button class="btn btn-outline" onclick="refreshClientLinkState()">Riprova</button></section>`;
  }
  const requests = Array.isArray(state.requests) ? state.requests : [];
  const link = state.link || null;
  const requestsHtml = requests.length ? `<div class="linked-member-list">${requests.map(item => `
    <div class="linked-member"><span class="account-avatar small"><img src="assets/loghi/logo-app.svg" alt=""></span><div><strong>${escapeHtml(item.nutritionistDisplayName || item.nutritionistUsername || item.organizationName || "Studio professionale")}</strong><small>Ti ha invitato a collegare il tuo piano · ${escapeHtml(item.organizationName || "Studio professionale")}</small></div>
    <div class="link-request-actions"><button class="btn btn-primary" onclick="respondClientLinkRequest('${escapeHtml(item.requestId)}','accept')">Accetta</button><button class="btn btn-outline" onclick="respondClientLinkRequest('${escapeHtml(item.requestId)}','reject')">Rifiuta</button></div></div>`).join("")}</div>` : "";
  // Dati identificativi inseriti dal nutrizionista: visibili al cliente, ma
  // modificabili solo dal professionista (email, nome e cognome). Il cliente
  // può cambiare solo il nome mostrato.
  const identityHtml = link
    ? `<dl class="linked-identity">
        <dt>Email</dt><dd>${escapeHtml(link.email || "—")} ${link.email ? `<span class="link-status ${link.emailVerified ? "active" : ""}">${link.emailVerified ? "● Verificata" : "Da verificare"}</span>` : ""}</dd>
        <dt>Nome e cognome</dt><dd>${escapeHtml([link.firstName, link.lastName].filter(Boolean).join(" ") || "Non indicati")}</dd>
       </dl>
       ${link.emailVerified ? "" : `<p class="linked-empty">Verifica l'indirizzo email dal banner in alto: finché non è verificato il collegamento resta inattivo.</p>`}
       ${link.emailChange ? `<div class="link-request-actions"><p>Il tuo professionista propone di cambiare l'email dell'account in <strong>${escapeHtml(link.emailChange.newEmail || "—")}</strong>. Confermi?</p>
        <button class="btn btn-primary" onclick="respondMyEmailChangeRequest('${escapeHtml(link.emailChange.requestId)}','accept')">Conferma cambio email</button>
        <button class="btn btn-outline" onclick="respondMyEmailChangeRequest('${escapeHtml(link.emailChange.requestId)}','reject')">Rifiuta</button></div>` : ""}`
    : "";
  const linkHtml = link
    ? `<div class="linked-member"><span class="account-avatar small">●</span><div><strong>${escapeHtml(link.nutritionistDisplayName || link.nutritionistUsername || link.organizationName || "Studio professionale")}</strong><small>Collegamento attivo · ${escapeHtml(link.organizationName || "Studio professionale")}</small></div></div>
       ${identityHtml}
       <div class="linked-account-actions"><button class="btn btn-outline" onclick="openUnlinkModal()">Scollegati</button></div>
       <p class="linked-empty">Nome, cognome ed email dell'account li aggiorna il tuo nutrizionista: chiedi a lui se c'è qualcosa da correggere.</p>`
    : (requests.length ? "" : `<p class="linked-empty">Nessun professionista collegato. Quando il tuo nutrizionista ti invita con la tua email, la richiesta appare qui.</p>`);
  return `<section class="settings-section linked-accounts-section"><div class="flex-between"><div><p class="eyebrow">PROFESSIONISTA</p><h2>Collegamento professionista</h2></div><span class="link-status ${link ? "active" : ""}">${link ? "● Collegato" : "Non collegato"}</span></div>${requestsHtml}${linkHtml}</section>`;
}

// Anagrafica cliente: nome mostrato rimosso (Sessione 1)

// Conferma o rifiuto della proposta di cambio email del professionista: il
// cliente è l'unico che può accettare, e solo dopo la conferma l'email cambia
// in Firebase Auth (con nuova verifica).
window.respondMyEmailChangeRequest = async function(requestId, decision) {
  try {
    const result = await callSaasFunction("respondMyEmailChange", {
      requestId, decision, idempotencyKey: `email-change-${decision}-${requestId}`
    });
    if (result.status === "email-changed") {
      showToast("Email aggiornata: accedi con il nuovo indirizzo e verificalo", false);
      await signOutUser();
      return;
    }
    showToast(result.status === "rejected" ? "Proposta rifiutata: l'email resta invariata" : "Richiesta aggiornata");
    await refreshClientLinkState();
    renderSettings();
  } catch (error) {
    showToast(error?.message || "Operazione non riuscita", true);
  }
};

window.respondClientLinkRequest = async function(requestId, decision) {
  try {
    const result = await callSaasFunction("respondClientLink", { requestId, decision });
    showToast(result.status === "link-active" ? "Collegamento attivato ✅" : result.status === "already-accepted" ? "Collegamento già attivo" : "Richiesta rifiutata");
    await reloadSaasAfterLink();
  } catch (error) {
    showToast(error?.message || "Operazione non riuscita", true);
  }
};

async function reloadSaasAfterLink() {
  if (!appState.user || !window.PianoSaas) return;
  appState.saasContext = await PianoSaas.loadContext(appState.user.uid);
  invalidateDietEngine();
  invalidateIngredientCatalogCache();
  appState.saasPolicy = PianoSaas.applyPolicy(appState.plan, appState.saasContext);
  appState.plan = appState.saasPolicy.plan;
  await refreshClientLinkState();
  maybePromptProfileUpdate();
  handleRoute();
}

function setupUnlinkModal() {
  if (document.getElementById("client-unlink-modal")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="client-unlink-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="client-unlink-title" aria-describedby="client-unlink-copy">
      <div class="modal-content profile-update-content">
        <div class="modal-header"><div><p class="eyebrow">SCOLLEGAMENTO</p><h2 id="client-unlink-title">Vuoi scollegarti dal tuo professionista?</h2></div></div>
        <div id="client-unlink-copy" class="profile-update-copy">
          <ul class="profile-update-points">
            <li><strong>Il tuo account resta attivo:</strong> non cancelliamo account, ricette, settimana né backup.</li>
            <li><strong>Torni alle dosi originali:</strong> i profili assegnati vengono sospesi subito.</li>
            <li><strong>Perdi la Lista spesa inclusa:</strong> resta disponibile solo con un collegamento attivo.</li>
          </ul>
        </div>
        <div class="modal-footer profile-update-actions">
          <button class="btn btn-outline" onclick="closeUnlinkModal()">Torna indietro</button>
          <button class="btn btn-danger" onclick="confirmClientUnlink()">Scollegati</button>
        </div>
      </div>
    </div>`);
  bindModalOutsideClose("client-unlink-modal", () => window.closeUnlinkModal());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") window.closeUnlinkModal();
  });
}

window.openUnlinkModal = function() {
  setupUnlinkModal();
  document.getElementById("client-unlink-modal").classList.remove("hidden");
  setTimeout(() => document.querySelector("#client-unlink-modal .btn-outline")?.focus(), 60);
};

window.closeUnlinkModal = function() {
  document.getElementById("client-unlink-modal")?.classList.add("hidden");
};

window.confirmClientUnlink = async function() {
  try {
    await callSaasFunction("requestClientUnlink", {});
    window.closeUnlinkModal();
    showToast("Scollegamento completato. Stai usando le dosi originali.");
    await reloadSaasAfterLink();
  } catch (error) {
    showToast(error?.message || "Scollegamento non riuscito", true);
  }
};

window.confirmAssignedNutritionProfile = async function() {
  const profile = appState.saasContext?.profile;
  if (!profile || !window.PianoSaas) return;
  // La conferma è la modale "Aggiornamento disponibile": niente apply silenzioso.
  appState.plan.nutritionSnapshot = PianoSaas.snapshotFor(profile);
  appState.plan.alignedDosesEnabled = true;
  try {
    await saveWeeklyPlan(appState.plan);
    appState.saasPolicy = { plan: appState.plan, mode: "assigned", migrationRequired: false };
    closeProfileUpdateModal();
    renderSettings();
    handleRoute();
    showToast("Profilo applicato. Le ricette originali sono al sicuro ✅");
  } catch (error) {
    showToast("Impossibile applicare il profilo", true);
  }
};

function renderThemeSettingsSection() {
  const dark = document.documentElement?.classList.contains("dark-mode") === true;
  return `<section class="settings-section"><p class="eyebrow">ASPETTO</p><h2>Tema</h2><label class="settings-row settings-toggle-row" for="settings-dark-mode-toggle"><span><strong>Tema scuro</strong><small>Attiva la modalità scura in tutta l'app.</small></span><span class="switch"><input type="checkbox" role="switch" id="settings-dark-mode-toggle" aria-label="Tema scuro" ${dark ? "checked" : ""} onchange="toggleDarkMode(this.checked)"><span class="switch-track" aria-hidden="true"></span></span></label></section>`;
}

function renderSettings() {
  const container = document.getElementById("view-settings");
  // Impostazioni: prima le sezioni informative e le guide, poi Aspetto e,
  // solo alla fine di tutto, l'uscita dall'account. In questo modo il footer
  // ospita l'accesso alle Impostazioni e l'header resta pulito e coerente.
  container.innerHTML = `
    <div class="page-heading"><div><p class="eyebrow">Preferenze</p><h1>Impostazioni</h1></div></div>

    ${renderSaasProfileSection()}

    ${renderClientLinkSection()}

    ${renderLinkedAccountsSection()}

    ${renderMyDietSettingsSection()}

    ${renderThemeSettingsSection()}

    <section class="settings-section"><p class="eyebrow">USCITA</p><h2>Uscita dall'account</h2><p class="text-muted">Esci in sicurezza. I tuoi dati restano salvati nel cloud.</p><button class="btn btn-outline" onclick="logoutCurrentUser()">Esci</button></section>
  `;
}

window.toggleDarkMode = function(checked) {
  appState.deviceSettings = appState.deviceSettings || getLocalDeviceSettings();
  appState.deviceSettings.darkMode = checked;
  saveLocalDeviceSettings(appState.deviceSettings);
  applyTheme(checked);
};

window.logoutCurrentUser = async function() {
  if (!confirm("Vuoi uscire dall'account personale?")) return;
  await signOutUser();
};

let pendingRecipeImport = null;
let pendingShareRecipeIds = [];
let incomingRecipeShares = [];
let incomingAccountLinks = [];

// ---- Centro notifiche (campanella) ----
// Source of truth = documenti Firestore `recipeShares` pendenti: il badge e
// il pannello si aggiornano da un listener realtime e l'inserimento avviene
// solo quando il server conferma (accettazione, rifiuto o completamento).
// Una copia del CONTEGGIO resta in cache locale per non azzerare il badge
// quando la connessione cade: non sostituisce mai lo stato del server.
const NOTIF_COUNT_CACHE = "notif_count";
let stopNotificationsObserver = null;
let notificationsLoadError = false;
let notificationsReturnFocus = null;

function readCachedNotificationCount() {
  const value = Number(readLocalJson(NOTIF_COUNT_CACHE, 0));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// Conteggio mostrato dalla campanella. Se l'ultimo caricamento è fallito
// (offline) e non ho dati live, si usa l'ultimo conteggio noto: le notifiche
// pendenti non devono sparire visivamente per un errore di rete.
function pendingNotificationCount() {
  const saas = window.PianoSaas?.config().enabled && !appState.clientLink?.error
    ? (appState.clientLink?.requests?.length || 0) : 0;
  const live = incomingAccountLinks.length + incomingRecipeShares.length + saas;
  if (live || !notificationsLoadError) return live;
  return readCachedNotificationCount();
}

function notificationBellLabel(count) {
  if (count <= 0) return "Notifiche: nessuna richiesta in attesa";
  return count === 1 ? "Notifiche: 1 richiesta in attesa" : `Notifiche: ${count} richieste in attesa`;
}

function updateNotificationBadge() {
  const count = pendingNotificationCount();
  const bell = document.getElementById("notification-bell");
  const badge = document.getElementById("notification-badge");
  if (bell) {
    bell.setAttribute("aria-label", notificationBellLabel(count));
    // Campanella "suona" solo con pendenti: rossa con scuotimento periodico.
    bell.classList.toggle("has-pending", count > 0);
  }
  if (badge) {
    badge.classList.toggle("hidden", count === 0);
    badge.textContent = count > 9 ? "9+" : String(count);
  }
}

// Punto unico di applicazione dello stato: aggiorna elenchi, badge e cache
// del conteggio, e ridisegna il pannello SOLO se è aperto. Le richieste
// pendenti restano tali finché il server non le considera gestite.
function applyIncomingRequests(recipeShares, accountLinks) {
  notificationsLoadError = false;
  incomingRecipeShares = Array.isArray(recipeShares) ? recipeShares : [];
  incomingAccountLinks = Array.isArray(accountLinks) ? accountLinks : [];
  const saas = window.PianoSaas?.config().enabled && !appState.clientLink?.error
    ? (appState.clientLink?.requests?.length || 0) : 0;
  writeLocalJson(NOTIF_COUNT_CACHE, incomingRecipeShares.length + incomingAccountLinks.length + saas);
  updateNotificationBadge();
  const modal = document.getElementById("incoming-shares-modal");
  if (modal && !modal.classList.contains("hidden")) renderIncomingShares();
}

// Alias breve per i punti che hanno appena modificato gli elenchi in locale
// (accetta/rifiuta): la notifica sparisce SOLO dopo il successo dell'operazione.
function syncIncomingRequests() {
  applyIncomingRequests(incomingRecipeShares, incomingAccountLinks);
}

function markNotificationsLoadFailed() {
  notificationsLoadError = true;
  updateNotificationBadge();
}

function startNotificationsSync() {
  stopNotificationsSync();
  if (!appState.user?.uid || typeof observeIncomingRequests !== "function") return;
  stopNotificationsObserver = observeIncomingRequests(snapshot => {
    const { recipeShares, accountLinks } = pendingRequestsFromSnapshot(snapshot);
    applyIncomingRequests(recipeShares, accountLinks);
  }, () => {
    // Offline/errore listener: NON azzerare elenchi né badge: i pendenti
    // noti restano visibili finché un caricamento riuscito non li aggiorna.
    markNotificationsLoadFailed();
  });
}

function stopNotificationsSync() {
  stopNotificationsObserver?.();
  stopNotificationsObserver = null;
}

// ---- Backup precedente (users/{uid}/backups/previous) ----
// Meccanismo INTERNO di sicurezza senza UI: i backup automatici proteggono le
// operazioni distruttive (importazioni sostitutive, condivisioni,
// collegamento account, generatore settimana, eliminazioni). La funzione di
// annullamento esposta (undoLastModification) è stata rimossa insieme alla
// sezione Impostazioni; il ripristino atomico resta disponibile a livello di
// dati (restoreBackupAtomic, coperto dai test) ma non è più richiamabile
// dall'interfaccia.

async function createBackup(catalog, plan, shopping, operation, description) {
  return saveBackup(catalog, plan, shopping, operation, description);
}

function cleanRecipeForTransfer(recipe) {
  const clean = normalizeRecipeSchema(recipe);
  delete clean._original;
  return clean;
}

function buildRecipeExport(recipes, includePlan = false) {
  const payload = {
    format: "piano-nutrizionale-recipes",
    schemaVersion: CATALOG_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: usernameFromUser(appState.user),
    recipes: recipes.map(cleanRecipeForTransfer)
  };

  if (includePlan && appState.plan) {
    payload.plan = window.PianoDomain ? PianoDomain.migratePlan(clone(appState.plan)) : clone(appState.plan);
  }

  return payload;
}

function downloadJsonFile(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

window.exportAllRecipes = function() {
  if (!appState.recipes.length) {
    showToast("Non ci sono ricette da esportare", true);
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  downloadJsonFile(`ricette-${usernameFromUser(appState.user)}-${date}.json`, buildRecipeExport(appState.recipes, true));
  showToast(`${appState.recipes.length} ricette esportate`);
};

function exportCurrentRecipe() {
  if (!currentModal?.recipe) return;
  const safeName = currentModal.recipe.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  downloadJsonFile(`${currentModal.recipe.id}-${safeName || "ricetta"}.json`, buildRecipeExport([currentModal.recipe], false));
  showToast("Ricetta esportata");
}

function recipesFromImportedJson(data) {
  if (Array.isArray(data)) return { recipes: data, plan: null };
  if (Array.isArray(data?.recipes)) return { recipes: data.recipes, plan: data.plan || null };
  if (data?.id && Array.isArray(data.ingredients)) return { recipes: [data], plan: null };
  throw new Error("Il file non contiene ricette riconoscibili");
}

window.prepareRecipeImport = async function(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const imported = recipesFromImportedJson(parsed);
    validateRecipeCatalog(imported.recipes);
    if (!imported.recipes.length) throw new Error("Il file non contiene ricette");
    const normalizedImported = imported.recipes.map(cleanRecipeForTransfer);
    pendingRecipeImport = { recipes: normalizedImported, plan: imported.plan, filename: file.name };
    document.getElementById("import-file-name").textContent = file.name;
    document.getElementById("import-recipe-count").textContent = `${imported.recipes.length} ricett${imported.recipes.length === 1 ? "a" : "e"}`;
    document.getElementById("import-plan-note").textContent = imported.plan?.days ? "Il file contiene anche un piano: verrà applicato scegliendo Sostituisci oppure quando il tuo catalogo è vuoto." : "Il piano attuale verrà mantenuto quando possibile.";
    const importNote = document.getElementById("import-doses-note");
    if (importNote) {
      importNote.innerHTML = `<strong class="import-ok">✓ Le ricette verranno importate fedelmente</strong><br><small>Nessuna dose viene modificata in importazione: la vista «dosi allineate» si applica solo in visualizzazione.</small>`;
    }
    document.getElementById("recipe-import-modal").classList.remove("hidden");
  } catch (error) {
    console.error(error);
    showToast(error.message || "File JSON non valido", true);
  }
};

function mergeRecipeCatalogs(current, incoming) {
  const result = current.map(recipe => clone(recipe));
  const usedIds = new Set(result.map(recipe => recipe.id));
  let counter = 0;
  incoming.forEach(source => {
    const recipe = cleanRecipeForTransfer(source);
    if (usedIds.has(recipe.id)) {
      do {
        counter += 1;
        recipe.id = `I${Date.now().toString(36)}${counter}`;
      } while (usedIds.has(recipe.id));
      recipe.name = `${recipe.name} (importata)`;
    }
    usedIds.add(recipe.id);
    result.push(recipe);
  });
  return result.sort((a, b) => a.id.localeCompare(b.id, "it", { numeric: true }));
}

function sanitizePlanForCatalog(plan, recipes) {
  const nextPlan = clone(plan || createEmptyWeeklyPlan());
  const ids = new Set(recipes.map(recipe => recipe.id));
  DAY_ORDER.forEach(day => {
    if (!nextPlan.days?.[day]) nextPlan.days[day] = createEmptyWeeklyPlan().days[day];
    MEAL_SLOTS.forEach(slot => {
      if (!ids.has(nextPlan.days[day][slot.id])) nextPlan.days[day][slot.id] = null;
      if (nextPlan.defaultDays?.[day] && !ids.has(nextPlan.defaultDays[day][slot.id])) nextPlan.defaultDays[day][slot.id] = null;
    });
  });
  return nextPlan;
}

function importedPlanIsUsable(plan, recipes) {
  if (!plan?.days) return false;
  const ids = new Set(recipes.map(recipe => recipe.id));
  return DAY_ORDER.every(day => plan.days[day] && MEAL_SLOTS.every(slot => ids.has(plan.days[day][slot.id])));
}

window.closeRecipeImportModal = function() {
  pendingRecipeImport = null;
  document.getElementById("recipe-import-modal")?.classList.add("hidden");
};

window.applyRecipeImport = async function(mode) {
  if (!pendingRecipeImport || !["add", "replace"].includes(mode)) return;
  const incoming = pendingRecipeImport.recipes.map(cleanRecipeForTransfer);
  if (mode === "replace") {
    const removed = appState.recipes.filter(recipe => !incoming.some(item => item.id === recipe.id));
    const affectedSlots = window.PianoDomain
      ? PianoDomain.planSlotsForRecipeRemoval(appState.plan, removed.map(recipe => recipe.id))
      : [];
    const slotText = affectedSlots.length
      ? `\n\n${affectedSlots.length} slot del piano diventeranno vuoti:\n${affectedSlots.slice(0, 8).map(slot => `· ${DAY_NAMES[slot.day]} ${getSlotMeta(slot.slot).shortLabel}`).join("\n")}${affectedSlots.length > 8 ? `\n· e altri ${affectedSlots.length - 8}…` : ""}`
      : "";
    if (!confirm(`Sostituire tutte le ricette attuali con quelle del file?\n\nVerrano rimosse ${removed.length} ricett${removed.length === 1 ? "a" : "e"} attuali.${slotText}`)) return;
    try {
      await createBackup(appState.recipes, appState.plan, appState.shopping, "import-replace", `Sostituzione del catalogo con ${pendingRecipeImport.filename}`);
    } catch (error) {
      console.error(error);
      showToast("Backup non creato: importazione annullata", true);
      return;
    }
  }
  setLoading("Importazione ricette in corso…");
  try {
    const nextRecipes = mode === "add" ? PianoDomain.mergeRecipeCatalogs(appState.recipes, incoming) : incoming;
    let nextPlan;
    const canApplyImportedPlan = importedPlanIsUsable(pendingRecipeImport.plan, nextRecipes);
    if ((mode === "replace" || appState.recipes.length === 0) && canApplyImportedPlan) nextPlan = PianoDomain.migratePlan(clone(pendingRecipeImport.plan));
    else nextPlan = sanitizePlanForCatalog(appState.plan, nextRecipes);
    await Promise.all([saveRecipeCatalog(nextRecipes), saveWeeklyPlan(nextPlan)]);
    setRecipes(nextRecipes);
    appState.plan = nextPlan;
    closeRecipeImportModal();
    handleRoute();
    showToast(`${incoming.length} ricett${incoming.length === 1 ? "a importata" : "e importate"} ✅`);
  } catch (error) {
    console.error(error);
    showToast(error.message || "Importazione non riuscita", true);
  } finally {
    clearLoading();
  }
};

// ---- Modale aggiornamento profilo nutrizionale (SaaS) ----
// Popup evidente quando arriva una nuova struttura/revisione: copy non
// tecnico, accessibile (dialog, Escape), nessuna modifica senza conferma.
function setupProfileUpdateModal() {
  if (document.getElementById("profile-update-modal")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="profile-update-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="profile-update-title" aria-describedby="profile-update-copy">
      <div class="modal-content profile-update-content">
        <div class="modal-header"><div><p class="eyebrow">AGGIORNAMENTO DISPONIBILE</p><h2 id="profile-update-title">Il tuo piano è stato aggiornato dal tuo nutrizionista</h2></div></div>
        <div id="profile-update-copy" class="profile-update-copy">
          <p>È arrivata una nuova revisione della tua dieta dal tuo nutrizionista.</p>
          <ul class="profile-update-points">
            <li><strong>Niente cambia senza la tua conferma:</strong> finché non applichi l'aggiornamento, continui a vedere le dosi originali delle tue ricette.</li>
            <li><strong>Le tue ricette sono al sicuro:</strong> non vengono modificate né cancellate dall'aggiornamento.</li>
            <li>Le dosi allineate si vedono dove il tuo nutrizionista le ha indicate: settimana, ricettario e spesa restano tuoi, sempre con la possibilità di tornare alle dosi originali.</li>
          </ul>
        </div>
        <div class="modal-footer profile-update-actions">
          <button class="btn btn-outline" onclick="closeProfileUpdateModal()">Più tardi</button>
          <button class="btn btn-primary" onclick="confirmAssignedNutritionProfile()">Applica aggiornamento</button>
        </div>
      </div>
    </div>`);
  bindModalOutsideClose("profile-update-modal", () => window.closeProfileUpdateModal());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeProfileUpdateModal();
  });
}

window.closeProfileUpdateModal = function() {
  document.getElementById("profile-update-modal")?.classList.add("hidden");
};

window.openProfileUpdateModal = function() {
  setupProfileUpdateModal();
  document.getElementById("profile-update-modal").classList.remove("hidden");
  setTimeout(() => document.querySelector("#profile-update-modal .btn-primary")?.focus(), 60);
};

// Mostrato una sola volta per versione profilo e solo quando serve conferma.
// La chiave include la versione catalogo: un catalogo aggiornato genera un
// nudge anche a revisione invariata (solo nuovi pasti, mai ricalcoli passati).
function maybePromptProfileUpdate() {
  if (!appState.saasPolicy?.migrationRequired) return;
  const profile = appState.saasContext?.profile || {};
  const version = profile.structureRevisionId ?? null;
  const catalog = profile.ingredientCatalogVersion ?? null;
  const key = `pn_profile_update_shown_${appState.user?.uid || "user"}`;
  let seen;
  try { seen = JSON.parse(localStorage.getItem(key) || "null"); } catch (_) { seen = null; }
  const seenKey = seen && typeof seen === "object" ? `${seen.v}::${seen.c}` : String(seen);
  if (seenKey === `${version}::${catalog}`) return;
  try { localStorage.setItem(key, JSON.stringify({ v: version, c: catalog })); } catch (_) {}
  window.openProfileUpdateModal();
}

function setupTransferModals() {
  if (document.getElementById("recipe-import-modal")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="recipe-import-modal" class="modal hidden" role="dialog" aria-modal="true">
      <div class="modal-content transfer-modal-content">
        <div class="modal-header"><div><p class="eyebrow">IMPORTAZIONE</p><h2>Come vuoi importare?</h2></div><button class="btn-icon" onclick="closeRecipeImportModal()">&times;</button></div>
        <div class="transfer-summary"><strong id="import-file-name"></strong><span id="import-recipe-count"></span><p id="import-plan-note"></p><div id="import-doses-note" class="import-note"></div></div>
        <div class="transfer-choice-grid">
          <button class="transfer-choice" onclick="applyRecipeImport('add')"><span>＋</span><strong>Aggiungi</strong><small>Mantiene le ricette esistenti. Gli ID duplicati vengono rinominati.</small></button>
          <button class="transfer-choice danger" onclick="applyRecipeImport('replace')"><span>↻</span><strong>Sostituisci tutte</strong><small>Rimuove il catalogo attuale e mantiene solo le ricette importate.</small></button>
        </div>
      </div>
    </div>
    <div id="share-send-modal" class="modal hidden" role="dialog" aria-modal="true">
      <div class="modal-content transfer-modal-content">
        <div class="modal-header"><div><p class="eyebrow">CONDIVISIONE</p><h2>Invia ricette a un utente</h2></div><button class="btn-icon" onclick="closeShareDialog()">&times;</button></div>
        <p id="share-send-summary" class="text-muted"></p>
        <label class="share-username-field">Username destinatario<input id="share-recipient-username" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="es. mario"></label>
        <label class="share-plan-option"><input id="share-include-plan" type="checkbox"> Invia anche la struttura della settimana</label>
        <p class="text-muted transfer-privacy-note">Il destinatario riceverà una richiesta e potrà importare solo le ricette, solo la settimana o tutto.</p>
        <button id="share-send-button" class="btn btn-primary full-width" onclick="submitRecipeShare()">Invia richiesta</button>
      </div>
    </div>
    <div id="recipe-transfer-modal" class="modal hidden" role="dialog" aria-modal="true">
      <div class="modal-content transfer-modal-content">
        <div class="modal-header"><div><p class="eyebrow">FILE JSON</p><h2>Importa o esporta</h2></div><button class="btn-icon" onclick="closeTransferModal()">&times;</button></div>
        <p class="text-muted">Trasferisci le ricette del tuo account con un file JSON: utile per backup e passaggio ad altri account.</p>
        <div class="transfer-choice-grid">
          <label class="transfer-choice file-import-button"><span>⬆️</span><strong>Importa</strong><small>Legge un file JSON esportato dall'app e ti lascia scegliere se aggiungere o sostituire il catalogo.</small><input type="file" accept="application/json,.json" onchange="prepareRecipeImport(this.files[0]); this.value=''" style="display:none"></label>
          <button class="transfer-choice" onclick="closeTransferModal(); exportAllRecipes()"><span>⬇️</span><strong>Esporta</strong><small>Scarica tutte le ricette del catalogo in un unico file JSON.</small></button>
        </div>
      </div>
    </div>
    <div id="incoming-shares-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="incoming-shares-title">
      <div class="modal-content incoming-modal-content">
        <div class="modal-header"><div><p class="eyebrow">NOTIFICHE</p><h2 id="incoming-shares-title">Richieste in attesa</h2></div><button class="btn-icon" onclick="closeIncomingShares()" aria-label="Chiudi notifiche">&times;</button></div>
        <div id="incoming-shares-list"></div>
      </div>
    </div>
    <div id="share-conflict-modal" class="modal hidden" role="dialog" aria-modal="true">
      <div class="modal-content incoming-modal-content">
        <div class="modal-header"><div><p class="eyebrow">ANTEPRIMA CONDIVISIONE</p><h2 id="share-conflict-title">Conflitti e riepilogo</h2></div><button class="btn-icon" onclick="closeShareConflictModal()">&times;</button></div>
        <div id="share-conflict-body" class="share-conflict-body"></div>
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="closeShareConflictModal()">Annulla</button>
          <button class="btn btn-primary" onclick="applyShareAccept()">Conferma e importa</button>
        </div>
      </div>
    </div>
    <div id="account-link-modal" class="modal hidden" role="dialog" aria-modal="true">
      <div class="modal-content transfer-modal-content">
        <div class="modal-header"><div><p class="eyebrow">ACCOUNT COLLEGATI</p><h2>Collega un altro account</h2></div><button class="btn-icon" onclick="closeAccountLinkDialog()">&times;</button></div>
        <p class="text-muted">Invia una richiesta tramite username. Dopo l'accettazione condividerete piano, ricette, batch cooking e lista della spesa; ciascuno manterrà il proprio profilo porzioni locale.</p>
        <label class="share-username-field">Username da collegare<input id="account-link-username" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="es. anna"></label>
        <p class="text-muted transfer-privacy-note">Prima dell'invio verrà creato un backup del tuo stato corrente.</p>
        <button id="account-link-send-button" class="btn btn-primary full-width" onclick="submitAccountLink()">Invia richiesta di collegamento</button>
      </div>
    </div>`);
  bindModalOutsideClose("recipe-import-modal", () => window.closeRecipeImportModal());
  bindModalOutsideClose("share-send-modal", () => window.closeShareDialog());
  bindModalOutsideClose("recipe-transfer-modal", () => window.closeTransferModal());
  bindModalOutsideClose("incoming-shares-modal", () => window.closeIncomingShares());
  bindModalOutsideClose("share-conflict-modal", () => window.closeShareConflictModal());
  bindModalOutsideClose("account-link-modal", () => window.closeAccountLinkDialog());
  bindTransferEscapeKeys();
}

// Escape chiude prima la modale più in cima (anteprima conflitti), poi il
// centro notifiche: lo stato pendente non cambia mai alla semplice chiusura.
// Separato da setupTransferModals e idempotente: può essere riattivato in
// qualunque contesto senza doppie registrazioni.
let transferEscapeBound = false;
function bindTransferEscapeKeys() {
  if (transferEscapeBound) return;
  transferEscapeBound = true;
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    const conflictModal = document.getElementById("share-conflict-modal");
    const sharesModal = document.getElementById("incoming-shares-modal");
    const conflictOpen = Boolean(conflictModal) && !conflictModal.classList.contains("hidden");
    const sharesOpen = Boolean(sharesModal) && !sharesModal.classList.contains("hidden");
    if (conflictOpen) window.closeShareConflictModal();
    else if (sharesOpen) window.closeIncomingShares();
  });
}

window.openAccountLinkDialog = function() {
  const input = document.getElementById("account-link-username");
  if (input) input.value = "";
  document.getElementById("account-link-modal")?.classList.remove("hidden");
  setTimeout(() => input?.focus(), 50);
};

window.closeAccountLinkDialog = function() {
  document.getElementById("account-link-modal")?.classList.add("hidden");
};

window.submitAccountLink = async function() {
  const username = document.getElementById("account-link-username")?.value || "";
  const button = document.getElementById("account-link-send-button");
  if (!username.trim()) {
    showToast("Inserisci lo username da collegare", true);
    return;
  }
  button.disabled = true;
  button.textContent = "Creazione backup…";
  try {
    await createBackup(
      appState.recipes,
      appState.plan,
      appState.shopping,
      "account-link-invite",
      `Stato prima dell'invito di collegamento a ${normalizeUsername(username)}`
    );
    button.textContent = "Invio richiesta…";
    await sendAccountLink(username, appState.recipes, appState.plan, appState.shopping);
    closeAccountLinkDialog();
    if (window.location.hash === "#settings") renderSettings();
    showToast("Richiesta di collegamento inviata ✅");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Invio del collegamento non riuscito", true);
  } finally {
    button.disabled = false;
    button.textContent = "Invia richiesta di collegamento";
  }
};

window.disconnectAccount = async function() {
  if (!appState.household) return;
  if (!confirm("Scollegare questo account? Verrà creato un backup e conserverai una copia indipendente di settimana, ricette, batch cooking e spesa correnti.")) return;
  setLoading("Creazione backup e scollegamento…");
  try {
    await createBackup(
      appState.recipes,
      appState.plan,
      appState.shopping,
      "account-unlink",
      "Stato condiviso prima dello scollegamento account"
    );
    await unlinkCurrentAccount(appState.recipes, appState.plan, appState.shopping);
    appState.household = null;
    await loadUserData(appState.user, { silent: true });
    startAccountRealtimeSync();
    handleRoute();
    showToast("Account scollegato: ora usi una copia indipendente ✅");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Scollegamento non riuscito", true);
  } finally {
    clearLoading();
  }
};

window.openTransferModal = function() {
  document.getElementById("recipe-transfer-modal").classList.remove("hidden");
  setTimeout(() => document.querySelector("#recipe-transfer-modal .btn-icon")?.focus(), 50);
};

window.closeTransferModal = function() {
  document.getElementById("recipe-transfer-modal")?.classList.add("hidden");
};

window.openShareDialog = function(recipeId = null) {
  const recipes = recipeId ? [getRecipe(recipeId)].filter(Boolean) : appState.recipes;
  if (!recipes.length) {
    showToast("Non ci sono ricette da inviare", true);
    return;
  }
  pendingShareRecipeIds = recipes.map(recipe => recipe.id);
  document.getElementById("share-send-summary").textContent = recipeId ? `Invierai: ${getRecipe(recipeId).name}` : `Invierai tutte le ${recipes.length} ricette del catalogo.`;
  document.getElementById("share-recipient-username").value = "";
  const includePlan = document.getElementById("share-include-plan");
  if (includePlan) {
    includePlan.checked = !recipeId;
    includePlan.disabled = Boolean(recipeId);
  }
  document.getElementById("share-send-modal").classList.remove("hidden");
  setTimeout(() => document.getElementById("share-recipient-username").focus(), 50);
};

window.closeShareDialog = function() {
  pendingShareRecipeIds = [];
  document.getElementById("share-send-modal")?.classList.add("hidden");
};

window.submitRecipeShare = async function() {
  const username = document.getElementById("share-recipient-username").value;
  const recipes = pendingShareRecipeIds.map(getRecipe).filter(Boolean).map(cleanRecipeForTransfer);
  const includePlan = document.getElementById("share-include-plan")?.checked;
  const sharedPlan = includePlan ? clone(appState.plan) : null;
  const button = document.getElementById("share-send-button");
  button.disabled = true;
  button.textContent = "Invio…";
  try {
    await sendRecipeShare(username, recipes, sharedPlan);
    closeShareDialog();
    showToast("Richiesta di condivisione inviata ✅");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Invio non riuscito", true);
  } finally {
    button.disabled = false;
    button.textContent = "Invia richiesta";
  }
};

// Apertura del centro notifiche dalla campanella: apre il pannello accessibile
// e ricarica le richieste dal server. Aprire il pannello NON segna nulla come
// letto: le notifiche restano finché non vengono gestite davvero.
window.openIncomingShares = async function() {
  const modal = document.getElementById("incoming-shares-modal");
  const list = document.getElementById("incoming-shares-list");
  const active = typeof HTMLElement !== "undefined" && document.activeElement instanceof HTMLElement
    ? document.activeElement : null;
  notificationsReturnFocus = active || document.getElementById("notification-bell") || null;
  list.innerHTML = `<div class="empty-state"><div class="loading-spinner"></div><p>Caricamento richieste…</p></div>`;
  modal.classList.remove("hidden");
  document.getElementById("notification-bell")?.setAttribute("aria-expanded", "true");
  try {
    // Una sola query server: i documenti (che incorporano interi cataloghi
    // ricette) vengono letti una volta e ripartiti tra i due elenchi.
    const { recipeShares, accountLinks } = await getPendingIncomingRequests();
    applyIncomingRequests(recipeShares, accountLinks);
  } catch (error) {
    console.error(error);
    // Il caricamento fallito non deve azzerare notifiche già pendenti.
    markNotificationsLoadFailed();
    const saasRequests = window.PianoSaas?.config().enabled && !appState.clientLink?.error ? (appState.clientLink?.requests || []) : [];
  if (!incomingRecipeShares.length && !incomingAccountLinks.length && !saasRequests.length) {
      list.innerHTML = `<div class="empty-state"><span>⚠️</span><p>${escapeHtml(error.message || "Impossibile caricare le richieste")}</p></div>`;
    } else {
      renderIncomingShares();
    }
  }
  setTimeout(() => modal.querySelector(".btn-icon")?.focus(), 50);
};

function renderIncomingShares() {
  const saasRequests = window.PianoSaas?.config().enabled && !appState.clientLink?.error ? (appState.clientLink?.requests || []) : [];
  const list = document.getElementById("incoming-shares-list");
  if (!incomingRecipeShares.length && !incomingAccountLinks.length && !saasRequests.length) {
    // Offline dopo un caricamento fallito con pendenti noti: il messaggio non
    // deve dichiarare "nessuna richiesta" finché il server non è consultabile.
    list.innerHTML = notificationsLoadError && readCachedNotificationCount() > 0
      ? `<div class="empty-state"><span>📡</span><h3>Connessione assente</h3><p>Hai richieste in attesa: appariranno appena torni online. Finché non le gestisci restano salvate.</p></div>`
      : `<div class="empty-state"><span>📭</span><h3>Nessuna richiesta</h3><p>Le ricette condivise e gli inviti a collegare un account compariranno qui.</p></div>`;
    return;
  }
  const saasCards = saasRequests.map(request => `<article class="incoming-share-card saas-link-request"><div><span class="account-avatar small">${escapeHtml((request.nutritionistDisplayName || request.nutritionistUsername || "?").slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(request.nutritionistDisplayName || request.nutritionistUsername || request.organizationName || "Studio professionale")}</strong><small>Richiesta del professionista · ${escapeHtml(request.organizationName || "Studio professionale")}</small></div></div><p>Ti ha invitato a collegare il tuo piano nutrizionale.</p><div class="incoming-share-actions"><button class="btn btn-primary" onclick="respondClientLinkRequest('${escapeHtml(request.requestId)}','accept')">Accetta</button><button class="btn btn-outline" onclick="respondClientLinkRequest('${escapeHtml(request.requestId)}','reject')">Rifiuta</button></div></article>`).join("");
  const linkCards = incomingAccountLinks.map(request => `
    <article class="incoming-share-card account-link-request">
      <div><span class="account-avatar small">${escapeHtml((request.senderUsername || "?").slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(request.senderUsername || "Utente")}</strong><small>🔗 Invito a collegare gli account</small></div></div>
      <p>Dopo il collegamento condividerete settimana, catalogo ricette, batch cooking e spesa. Scegli ora quale stato completo usare come base; l'altro verrà salvato in backup.</p>
      <div class="account-base-choices">
        <button class="btn btn-primary" onclick="acceptPendingAccountLink('${request.id}', 'sender')">Usa la settimana di ${escapeHtml(request.senderUsername || "chi invita")}</button>
        <button class="btn btn-outline" onclick="acceptPendingAccountLink('${request.id}', 'recipient')">Usa la mia settimana</button>
        <button class="btn btn-danger" onclick="rejectPendingAccountLink('${request.id}')">Rifiuta</button>
      </div>
    </article>`).join("");
  const recipeCards = incomingRecipeShares.map(share => {
    const hasPlan = Boolean(share.includesPlan && share.plan?.days);
    const count = share.recipeCount || share.recipes?.length || 0;
    const actions = hasPlan
      ? `<button class="btn btn-outline" onclick="acceptSharedRecipes('${share.id}', 'recipes')">Solo ricette</button>
         <button class="btn btn-outline" onclick="acceptSharedRecipes('${share.id}', 'plan')">Solo settimana</button>
         <button class="btn btn-primary" onclick="acceptSharedRecipes('${share.id}', 'all')">Importa tutto</button>
         <button class="btn btn-danger" onclick="acceptSharedRecipes('${share.id}', 'replace')">Sostituisci ricette</button>`
      : `<button class="btn btn-outline" onclick="acceptSharedRecipes('${share.id}', 'recipes')">Aggiungi</button>
         <button class="btn btn-danger" onclick="acceptSharedRecipes('${share.id}', 'replace')">Sostituisci tutte</button>`;
    return `
    <article class="incoming-share-card">
      <div><span class="account-avatar small">${escapeHtml((share.senderUsername || "?").slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(share.senderUsername || "Utente")}</strong><small>${count} ricett${count === 1 ? "a" : "e"}${hasPlan ? " · 📅 include settimana" : ""}${share.senderRole === 'professional' ? " · 🩺 Dal tuo professionista" : ""}</small></div></div>
      <p>${escapeHtml((share.recipes || []).slice(0, 4).map(recipe => recipe.name).join(" · "))}${(share.recipes || []).length > 4 ? "…" : ""}</p>
      <div class="incoming-share-actions">${actions}<button class="btn btn-outline" onclick="rejectSharedRecipes('${share.id}')">Rifiuta</button></div>
    </article>`;
  }).join("");
  list.innerHTML = saasCards + linkCards + recipeCards;
}

window.closeIncomingShares = function() {
  document.getElementById("incoming-shares-modal")?.classList.add("hidden");
  document.getElementById("notification-bell")?.setAttribute("aria-expanded", "false");
  // Focus restituito al punto di apertura (tipicamente la campanella).
  const target = notificationsReturnFocus && typeof notificationsReturnFocus.focus === "function"
    ? notificationsReturnFocus
    : document.getElementById("notification-bell");
  notificationsReturnFocus = null;
  target?.focus?.();
};

window.acceptPendingAccountLink = async function(shareId, base) {
  const request = incomingAccountLinks.find(item => item.id === shareId);
  if (!request) return;
  const baseLabel = base === "sender" ? `quella di ${request.senderUsername}` : "la tua";
  if (!confirm(`Collegare gli account usando come base ${baseLabel}? Catalogo, settimana, batch cooking e spesa dell'altra base verranno sostituiti dopo aver creato un backup.`)) return;
  setLoading("Backup e collegamento account…");
  try {
    await createBackup(
      appState.recipes,
      appState.plan,
      appState.shopping,
      "account-link-accept",
      `Stato prima del collegamento con ${request.senderUsername}; base scelta: ${base}`
    );
    await acceptAccountLink(shareId, base, appState.recipes, appState.plan, appState.shopping);
    incomingAccountLinks = incomingAccountLinks.filter(item => item.id !== shareId);
    syncIncomingRequests();
    closeIncomingShares();
    await loadUserData(appState.user, { silent: true });
    startAccountRealtimeSync();
    handleRoute();
    showToast("Account collegati e sincronizzazione realtime attiva ✅");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Collegamento non riuscito", true);
  } finally {
    clearLoading();
  }
};

window.rejectPendingAccountLink = async function(shareId) {
  if (!confirm("Rifiutare questa richiesta di collegamento?")) return;
  try {
    await rejectAccountLink(shareId);
    incomingAccountLinks = incomingAccountLinks.filter(item => item.id !== shareId);
    syncIncomingRequests();
    showToast("Richiesta di collegamento rifiutata");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Impossibile rifiutare la richiesta", true);
  }
};

// ---- Anteprima conflitti e accettazione condivisione ----

let pendingShareAccept = null;

function shareRecipeName(recipe) {
  return recipe?.name || recipe?.id || "Ricetta sconosciuta";
}

function openShareConflictPreview(share, mode) {
  const incoming = (share.recipes || []).map(cleanRecipeForTransfer);
  const analysis = window.PianoDomain ? PianoDomain.analyzeShare(appState.recipes, incoming) : { newRecipes: incoming, identical: [], conflicts: [], invalid: [], migratedIngredients: 0, missingIngredientIds: [], incoming };
  pendingShareAccept = { shareId: share.id, mode, resolution: {}, analysis };
  const isProfessionalShare = share.senderRole === 'professional';
  if (isProfessionalShare) analysis.conflicts.forEach(conflict => { pendingShareAccept.resolution[conflict.incoming.id] = 'theirs'; });
  const body = document.getElementById("share-conflict-body");
  const hasPlan = Boolean(share.includesPlan && share.plan?.days);
  let html = `
    <div class="share-analysis-grid">
      <div><small>Mittente</small><strong>${escapeHtml(share.senderUsername || "Utente")}</strong></div>
      <div><small>Ricette nel messaggio</small><strong>${analysis.incoming.length}</strong></div>
      <div><small>Ricette nuove</small><strong>${analysis.newRecipes.length}</strong></div>
      <div><small>Già presenti identiche</small><strong>${analysis.identical.length}</strong></div>
      <div><small>Conflitti</small><strong>${analysis.conflicts.length}</strong></div>
      <div><small>Non valide</small><strong>${analysis.invalid.length}</strong></div>
      <div><small>Ingredienti migrati (senza ingredientId)</small><strong>${analysis.migratedIngredients}</strong></div>
    </div>`;
  if (analysis.newRecipes.length) {
    html += `<h3 class="share-preview-heading">Nuove ricette (${analysis.newRecipes.length})</h3><p class="share-preview-names">${escapeHtml(analysis.newRecipes.map(shareRecipeName).join(" · "))}</p>`;
  }
  if (analysis.identical.length) {
    html += `<h3 class="share-preview-heading">Identiche alle tue (${analysis.identical.length})</h3><p class="share-preview-names">${escapeHtml(analysis.identical.map(shareRecipeName).join(" · "))}</p>`;
  }
  if (analysis.conflicts.length) {
    if (isProfessionalShare) {
      html += `<h3 class="share-preview-heading">Aggiornamenti dal professionista (${analysis.conflicts.length})</h3><p class="share-preview-names">${escapeHtml(analysis.conflicts.map(conflict => conflict.incoming.name).join(" · "))}</p><div class="share-replace-note">🩺 Le ricette del professionista sostituiscono quelle con lo stesso codice e restano in sola lettura.</div>`;
    } else {
    html += `<h3 class="share-preview-heading">Conflitti: scegli per ogni ricetta</h3>`;
    html += analysis.conflicts.map((conflict, index) => `
      <div class="share-conflict-row">
        <div class="share-conflict-recipe"><strong>${escapeHtml(conflict.incoming.name)}</strong><small>${escapeHtml(conflict.incoming.id)} · tua: ${escapeHtml(conflict.existing.name)}</small></div>
        <select data-conflict-index="${index}" onchange="setShareConflictMode(${index}, this.value)">
          <option value="theirs">Usa quella ricevuta</option>
          <option value="mine">Mantieni la mia</option>
          <option value="both">Salva entrambe con nuovo ID</option>
        </select>
      </div>`).join("");
    }
  }
  if (analysis.invalid.length) {
    html += `<h3 class="share-preview-heading">Non valide (${analysis.invalid.length})</h3><p class="share-preview-warning">Verranno ignorate: ${escapeHtml(analysis.invalid.map(item => item?.id || "?").join(", "))}</p>`;
  }
  if (analysis.missingIngredientIds.length) {
    html += `<h3 class="share-preview-heading">Ingredienti senza ingredientId</h3><p class="share-preview-warning">Verranno normalizzati automaticamente: ${escapeHtml(analysis.missingIngredientIds.map(item => item.name).join(", "))}</p>`;
  }
  if (mode === "replace") {
    const removed = appState.recipes.filter(recipe => !incoming.some(item => item.id === recipe.id));
    const affectedSlots = window.PianoDomain ? PianoDomain.planSlotsForRecipeRemoval(appState.plan, removed.map(recipe => recipe.id)) : [];
    html += `<div class="share-replace-note">⚠️ Sostituzione: verrano rimosse <strong>${removed.length}</strong> ricett${removed.length === 1 ? "a" : "e"} attuali${affectedSlots.length ? ` e <strong>${affectedSlots.length}</strong> slot del piano diventeranno vuoti (${escapeHtml(affectedSlots.slice(0, 8).map(slot => `${DAY_NAMES[slot.day]} ${getSlotMeta(slot.slot).shortLabel}`).join(", "))}${affectedSlots.length > 8 ? ", …" : ""})` : ""}. Un backup verrà creato prima dell'applicazione.</div>`;
  } else if (hasPlan && mode === "plan") {
    html += `<div class="share-plan-note">📅 Verrà importata solo la settimana: il catalogo attuale resta invariato e i riferimenti a ricette non presenti verranno rimossi.</div>`;
  } else if (hasPlan && mode === "all") {
    html += `<div class="share-plan-note">📅 Verranno importate ricette e settimana: il piano verrà normalizzato per non contenere riferimenti mancanti.</div>`;
  }
  document.getElementById("share-conflict-title").textContent = hasPlan ? "Ricette e settimana ricevute" : "Ricette ricevute";
  body.innerHTML = html;
  document.getElementById("share-conflict-modal").classList.remove("hidden");
}

window.setShareConflictMode = function(index, mode) {
  if (pendingShareAccept) pendingShareAccept.resolution[pendingShareAccept.analysis.conflicts[index].incoming.id] = mode;
};

window.closeShareConflictModal = function() {
  pendingShareAccept = null;
  document.getElementById("share-conflict-modal")?.classList.add("hidden");
};

window.acceptSharedRecipes = async function(shareId, mode) {
  const share = incomingRecipeShares.find(item => item.id === shareId);
  if (!share) return;
  if (mode === "plan" && !share.plan?.days) {
    showToast("Questa condivisione non contiene una settimana", true);
    return;
  }
  if (mode === "replace" && !confirm(`Sostituire tutte le tue ricette con le ${(share.recipes || []).length} ricevute da ${share.senderUsername}? Verrà creato un backup prima dell'applicazione.`)) return;
  openShareConflictPreview(share, mode);
};

window.applyShareAccept = async function() {
  if (!pendingShareAccept) return;
  const { shareId, mode, resolution } = pendingShareAccept;
  const share = incomingRecipeShares.find(item => item.id === shareId);
  if (!share) return;
  const destructive = mode === "replace" || mode === "all";
  if (destructive) {
    try {
      await createBackup(appState.recipes, appState.plan, appState.shopping, mode === "replace" ? "share-replace" : "share-import-all", `Condivisione accettata da ${share.senderUsername} (${mode})`);
    } catch (error) {
      console.error(error);
      showToast("Backup non creato: operazione annullata", true);
      return;
    }
  }
  setLoading("Salvataggio condivisione…");
  try {
    const incoming = (share.recipes || []).map(cleanRecipeForTransfer);
    let nextRecipes;
    let nextPlan;
    let planSaved = true;
    if (mode === "plan") {
      nextRecipes = appState.recipes;
      nextPlan = window.PianoDomain
        ? PianoDomain.sanitizePlanForCatalog(PianoDomain.migratePlan(share.plan), nextRecipes)
        : sanitizePlanForCatalog(appState.plan, nextRecipes);
    } else if (share.senderRole === 'professional' && window.PianoDomain) {
      const provenance = {
        senderUid: share.senderUid || null,
        senderUsername: share.senderUsername || null,
        organizationId: share.organizationId || null,
        receivedAt: new Date().toISOString()
      };
      // Sostituzione mirata per stesso id (catalogo intero solo con 'replace').
      nextRecipes = mode === 'replace'
        ? PianoDomain.applyProfessionalRecipes([], incoming, provenance)
        : PianoDomain.applyProfessionalRecipes(appState.recipes, incoming, provenance);
    } else {
      nextRecipes = window.PianoDomain
        ? PianoDomain.resolveRecipeConflicts(appState.recipes, incoming, resolution)
        : mergeRecipeCatalogs(appState.recipes, incoming);
      if (mode === "all") {
        nextPlan = window.PianoDomain
          ? (PianoDomain.importedPlanIsUsable(share.plan, nextRecipes)
              ? PianoDomain.sanitizePlanForCatalog(PianoDomain.migratePlan(share.plan), nextRecipes)
              : PianoDomain.sanitizePlanForCatalog(appState.plan, nextRecipes))
          : sanitizePlanForCatalog(appState.plan, nextRecipes);
      } else {
        // Solo ricette: mantiene il piano attuale, aggiorna solo i riferimenti.
        nextPlan = sanitizePlanForCatalog(appState.plan, nextRecipes);
        planSaved = JSON.stringify(nextPlan) !== JSON.stringify(appState.plan);
        if (!planSaved) nextPlan = appState.plan;
      }
    }
    const nulledRefs = window.PianoDomain
      ? PianoDomain.diffPlans(appState.plan, nextPlan).filter(change => change.to === null).length
      : 0;
    await acceptRecipeShare(shareId, nextRecipes, planSaved ? nextPlan : null);
    setRecipes(nextRecipes);
    if (nextPlan) appState.plan = nextPlan;
    incomingRecipeShares = incomingRecipeShares.filter(item => item.id !== shareId);
    closeShareConflictModal();
    syncIncomingRequests();
    handleRoute();
    const toast = mode === "plan"
      ? (nulledRefs ? `Settimana importata: rimossi ${nulledRefs} riferimenti a ricette mancanti ⚠️` : "Settimana importata e salvata ✅")
      : mode === "all" ? "Ricette e settimana importate ✅" : "Ricette accettate e salvate ✅";
    showToast(toast);
  } catch (error) {
    console.error(error);
    showToast(error.message || "Accettazione non riuscita", true);
  } finally {
    clearLoading();
  }
};

window.rejectSharedRecipes = async function(shareId) {
  if (!confirm("Rifiutare questa richiesta di condivisione?")) return;
  try {
    await rejectRecipeShare(shareId);
    incomingRecipeShares = incomingRecipeShares.filter(item => item.id !== shareId);
    syncIncomingRequests();
    showToast("Richiesta rifiutata");
  } catch (error) {
    console.error(error);
    showToast("Impossibile rifiutare la richiesta", true);
  }
};

// ---- Generatore automatico della settimana ----

const GENERATOR_COUNT_LABELS = {
  poultry: "Pollame",
  beef: "Manzo e maiale",
  curedMeats: "Affettati e carni miste",
  omega: "Pesce ricco di omega-3",
  otherFish: "Altro pesce e prodotti ittici",
  dairy: "Latticini e formaggi",
  eggs: "Uova",
  legumes: "Legumi e derivati"
};

// Parametri strutturali del generatore: i valori predefiniti sono coerenti con
// le "Frequenze proteiche" del manuale. L'utente li regola nel pannello della
// modale e restano salvati per dispositivo (mai su Firestore).
const GENERATOR_PREFS_DEFAULTS = {
  batchPairs: 2,
  maxRepeats: 2,
  allowCrossSlot: false,
  slots: { breakfast: true, snack1: true, lunch: true, snack2: true, dinner: true }
};

// Versione della struttura delle preferenze del generatore: serve per
// migrare una sola volta i valori salvati in locale (es. legumesMax da 4 a 14,
// aggiunta delle nuove chiavi beef/curedMeats) senza sovrascrivere ogni volta
// le personalizzazioni dell'utente.
// v3: i vincoli di frequenza proteica (min/max per categoria) non esistono
// più — il motore lavora sui soli vincoli strutturali — quindi la migrazione
// li scarta insieme alle chiavi non riconosciute.
const GENERATOR_PREFS_VERSION = 3;

let generatorState = { seed: null, blocks: {}, proposal: null, panels: { advanced: false, locks: false } };

function migrateGeneratorPrefs(saved) {
  if (!saved || typeof saved !== 'object') return null;
  if ((Number(saved.version) || 0) >= GENERATOR_PREFS_VERSION) return null;
  return {
    ...GENERATOR_PREFS_DEFAULTS,
    batchPairs: saved.batchPairs,
    maxRepeats: saved.maxRepeats,
    allowCrossSlot: saved.allowCrossSlot,
    slots: { ...GENERATOR_PREFS_DEFAULTS.slots, ...(saved.slots || {}) },
    version: GENERATOR_PREFS_VERSION
  };
}

function getGeneratorPrefs() {
  const saved = appState.deviceSettings?.generatorPrefs || {};
  const migrated = migrateGeneratorPrefs(saved);
  if (migrated) {
    appState.deviceSettings = appState.deviceSettings || {};
    appState.deviceSettings.generatorPrefs = migrated;
    saveLocalDeviceSettings(appState.deviceSettings);
  }
  const source = migrated || saved;
  const number = (value, fallback, min, max) =>
    Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback;
  return {
    batchPairs: number(source.batchPairs, GENERATOR_PREFS_DEFAULTS.batchPairs, 0, 7),
    maxRepeats: number(source.maxRepeats, GENERATOR_PREFS_DEFAULTS.maxRepeats, 1, 7),
    allowCrossSlot: Boolean(source.allowCrossSlot ?? GENERATOR_PREFS_DEFAULTS.allowCrossSlot),
    slots: { ...GENERATOR_PREFS_DEFAULTS.slots, ...(source.slots || {}) },
    version: GENERATOR_PREFS_VERSION
  };
}

function getGeneratorPanelState() {
  return {
    locks: document.getElementById("generator-locks")?.open ?? Boolean(generatorState.panels?.locks)
  };
}

function restoreGeneratorPanelState(state) {
  generatorState.panels = { ...state };
  const locks = document.getElementById("generator-locks");
  if (locks) locks.open = Boolean(state.locks);
}

function scrollGeneratorPreviewIntoView() {
  const preview = document.getElementById("generator-preview");
  if (!preview || typeof preview.scrollIntoView !== "function") return;
  const scroll = () => preview.scrollIntoView({ behavior: "smooth", block: "start" });
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(scroll);
  else setTimeout(scroll, 0);
}

function saveGeneratorPrefs(updater) {
  const current = getGeneratorPrefs();
  const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
  next.version = GENERATOR_PREFS_VERSION;
  appState.deviceSettings = appState.deviceSettings || {};
  appState.deviceSettings.generatorPrefs = next;
  saveLocalDeviceSettings(appState.deviceSettings);
  generatorState.proposal = null;
  renderGeneratorModal();
}

function setupGeneratorModal() {
  if (document.getElementById("generator-modal")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="generator-modal" class="modal hidden" role="dialog" aria-modal="true">
      <div class="modal-content generator-modal-content">
        <div class="modal-header"><div><p class="eyebrow">GENERATORE</p><h2>Genera settimana</h2></div><button class="btn-icon" onclick="closeGeneratorModal()">&times;</button></div>
        <div id="generator-params" class="generator-params"></div>
        <div id="generator-blocks" class="generator-blocks"></div>
        <div class="generator-controls">
          <label class="share-username-field">Numero prova (facoltativo)<input id="generator-seed" type="text" inputmode="numeric" placeholder="Lascia vuoto oppure scrivi un numero" onchange="generatorSeedChanged(this.value)"></label>
          <button class="btn btn-outline" onclick="generatorPrefsReset()">Ripristina impostazioni</button>
          <button class="btn btn-outline" onclick="computeGeneratorProposal(true)">Nuova proposta</button>
          <button class="btn btn-primary" onclick="computeGeneratorProposal(false)">Anteprima</button>
        </div>
        <div id="generator-preview" class="generator-preview"></div>
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="closeGeneratorModal()">Annulla</button>
          <button class="btn btn-primary" id="generator-apply-btn" onclick="applyGenerator()">Applica</button>
        </div>
      </div>
    </div>`);
  bindModalOutsideClose("generator-modal", () => window.closeGeneratorModal());
}

window.openGeneratorModal = function() {
  generatorState = {
    seed: Math.floor(Math.random() * 1000000),
    blocks: {},
    proposal: null,
    panels: { advanced: false, locks: false }
  };
  renderGeneratorModal();
  document.getElementById("generator-modal").classList.remove("hidden");
};

window.closeGeneratorModal = function() {
  document.getElementById("generator-modal")?.classList.add("hidden");
  modalOutsideCloseState.set("generator-modal", false);
  generatorState.proposal = null;
};

window.generatorSeedChanged = function(value) {
  const trimmed = String(value || "").trim();
  generatorState.seed = trimmed === "" ? null : (Number.isFinite(Number(trimmed)) ? Number(trimmed) : trimmed);
};

window.toggleGeneratorDayLock = function(day, checked) {
  if (checked) generatorState.blocks[day] = { all: true };
  else delete generatorState.blocks[day];
  generatorState.proposal = null;
  renderGeneratorModal();
};

window.toggleGeneratorSlotLock = function(day, slot, checked) {
  const block = generatorState.blocks[day];
  if (block?.all) return;
  if (checked) {
    if (!generatorState.blocks[day]) generatorState.blocks[day] = {};
    generatorState.blocks[day][slot] = true;
  } else {
    if (generatorState.blocks[day]) delete generatorState.blocks[day][slot];
    if (generatorState.blocks[day] && !Object.keys(generatorState.blocks[day]).length) delete generatorState.blocks[day];
  }
  generatorState.proposal = null;
  renderGeneratorModal();
};

window.generatorSlotToggled = function(slot, checked) {
  if (!MEAL_SLOTS.some(item => item.id === slot)) return;
  saveGeneratorPrefs(prefs => ({ ...prefs, slots: { ...prefs.slots, [slot]: Boolean(checked) } }));
};

window.generatorParamChanged = function(key, value) {
  if (key === "batchPairs") saveGeneratorPrefs(prefs => ({ ...prefs, batchPairs: Math.max(0, Math.min(7, Math.floor(Number(value) || 0))) }));
  else if (key === "maxRepeats") saveGeneratorPrefs(prefs => ({ ...prefs, maxRepeats: Math.max(1, Math.min(7, Math.floor(Number(value) || 2))) }));
  else if (key === "allowCrossSlot") saveGeneratorPrefs(prefs => ({ ...prefs, allowCrossSlot: Boolean(value) }));
};

window.generatorPrefsReset = function() {
  appState.deviceSettings = appState.deviceSettings || {};
  delete appState.deviceSettings.generatorPrefs;
  saveLocalDeviceSettings(appState.deviceSettings);
  generatorState.proposal = null;
  renderGeneratorModal();
  showToast("Parametri del generatore ripristinati");
};

function renderGeneratorParams() {
  if (!window.PianoDomain) return "";
  const prefs = getGeneratorPrefs();
  const slotToggles = MEAL_SLOTS.map(slot => `
    <label class="generator-slot-toggle"><input type="checkbox" ${prefs.slots[slot.id] ? "checked" : ""} onchange="generatorSlotToggled('${slot.id}', this.checked)"> ${escapeHtml(slot.emoji)} ${escapeHtml(slot.label)}</label>`).join("");
  return `
    <div class="generator-params-block">
      <strong>Quali pasti vuoi aggiornare?</strong>
      <small>Togli la spunta ai pasti che vuoi lasciare così come sono.</small>
      <div class="generator-slot-toggles">${slotToggles}</div>
    </div>
    <div class="generator-param-grid">
      <label><span>🍳 Cucinare una volta e mangiare due volte</span><small>La cena diventa anche il pranzo del giorno dopo.</small>
        <select onchange="generatorParamChanged('batchPairs', Number(this.value))">
          ${[0, 1, 2, 3, 4, 5, 6, 7].map(n => `<option value="${n}" ${prefs.batchPairs === n ? "selected" : ""}>${n === 0 ? "Mai" : `${n} ${n === 1 ? "volta" : "volte"}`}</option>`).join("")}
        </select>
      </label>
      <label><span>🔁 Quante volte può tornare la stessa ricetta?</span><small>1 = mai ripetuta. 2 = al massimo due volte nella settimana.</small>
        <select onchange="generatorParamChanged('maxRepeats', Number(this.value))">
          ${[1, 2, 3, 4].map(n => `<option value="${n}" ${prefs.maxRepeats === n ? "selected" : ""}>${n} ${n === 1 ? "volta" : "volte"}</option>`).join("")}
        </select>
      </label>
      <label><span>↔ Vuoi più scelta tra pranzo e cena?</span><small>Se attivi questa opzione, il generatore può usare anche ricette di pranzo a cena e viceversa.</small>
        <select onchange="generatorParamChanged('allowCrossSlot', this.value === '1')">
          <option value="0" ${!prefs.allowCrossSlot ? "selected" : ""}>No</option>
          <option value="1" ${prefs.allowCrossSlot ? "selected" : ""}>Sì</option>
        </select>
      </label>
    </div>
  `;
}

function renderGeneratorBlocks() {
  return `<details id="generator-locks" class="generator-advanced generator-locks-panel">
      <summary>Lascia fissi alcuni pasti <small>(facoltativo)</small></summary>
      <p class="text-muted">Spunta i giorni o i pasti che non vuoi far cambiare.</p>
      <div class="generator-block-table">
        ${DAY_ORDER.map(day => {
          const block = generatorState.blocks[day];
          const dayLocked = Boolean(block?.all);
          return `<div class="generator-block-row">
            <label class="generator-day-lock"><input type="checkbox" title="Lascia tutto il giorno uguale" ${dayLocked ? "checked" : ""} onchange="toggleGeneratorDayLock('${day}', this.checked)"> ${DAY_NAMES[day]}${dayLocked ? ' <span class="generator-lock-pill">Giorno fisso</span>' : ""}</label>
            <div class="generator-slot-locks">${MEAL_SLOTS.map(slot => {
              const slotLocked = Boolean(block?.[slot.id]);
              return `<label class="${dayLocked ? "locked" : ""}"><input type="checkbox" title="Lascia questo pasto uguale" ${dayLocked || slotLocked ? "checked" : ""} ${dayLocked ? "disabled" : ""} onchange="toggleGeneratorSlotLock('${day}', '${slot.id}', this.checked)"> ${escapeHtml(slot.shortLabel)}${slotLocked && !dayLocked ? ' <span class="generator-slot-lock-badge">Fisso</span>' : ""}</label>`;
            }).join("")}</div>
          </div>`;
        }).join("")}
      </div>
    </details>`;
}

// Proposta del generatore: vincoli puramente strutturali (slot da aggiornare,
// ripetizioni, accoppiate batch, blocchi fissi). Nessuna frequenza clinica:
// le indicazioni del nutrizionista vivono nella struttura dieta assegnata.
window.computeGeneratorProposal = function(newSeed) {
  if (newSeed) generatorState.seed = Math.floor(Math.random() * 1000000);
  const prefs = getGeneratorPrefs();
  const result = window.PianoDomain
    ? PianoDomain.generateWeek(appState.recipes, {
        plan: appState.plan,
        seed: generatorState.seed ?? Date.now(),
        blocks: generatorState.blocks,
        templates: appState.plan.batchTemplates || [],
        batchPairs: prefs.batchPairs,
        maxRepeats: prefs.maxRepeats,
        allowCrossSlot: prefs.allowCrossSlot,
        slots: prefs.slots
      })
    : null;
  if (!result) {
    showToast("Generatore non disponibile", true);
    return;
  }
  generatorState.proposal = result;
  document.getElementById("generator-seed").value = String(result.seed ?? generatorState.seed ?? "");
  renderGeneratorPreview();
  scrollGeneratorPreviewIntoView();
};

function generatorRecipeName(recipeId) {
  const recipe = getRecipe(recipeId);
  return recipe ? `${recipe.emoji || "🍲"} ${recipe.name}` : (recipeId || "—");
}

function renderGeneratorPreview() {
  const preview = document.getElementById("generator-preview");
  const result = generatorState.proposal;
  if (!result) {
    preview.innerHTML = `<div class="generator-empty"><span>✨</span><strong>Anteprima non ancora generata</strong><p>Tocca “Anteprima” per vedere la proposta prima di applicarla.</p></div>`;
    return;
  }
  const changes = window.PianoDomain ? PianoDomain.diffPlans(appState.plan, result.plan) : [];
  const changesByDay = {};
  changes.forEach(change => {
    if (!changesByDay[change.day]) changesByDay[change.day] = [];
    changesByDay[change.day].push(change);
  });
  const pairs = result.pairs || [];
  const pairsHtml = pairs.length
    ? `<div class="generator-pairs">${pairs.map(pair => {
        const targetDay = DAY_ORDER[(DAY_ORDER.indexOf(pair.anchorDay) + 1) % DAY_ORDER.length];
        return `<span class="generator-pair-chip" title="Cena del ${DAY_NAMES[pair.anchorDay]} usata anche per il pranzo del giorno dopo">🍳 ${DAY_NAMES[pair.anchorDay].slice(0, 3)} cena + ${DAY_NAMES[targetDay].slice(0, 3)} pranzo</span>`;
      }).join("")}</div>`
    : "";
  preview.innerHTML = `
    <div class="generator-preview-head"><strong>Anteprima</strong><span>${changes.length} cambi${pairs.length ? ` · ${pairs.length} doppi pasti` : ""}</span></div>

    ${result.warnings.length ? `<div class="generator-warnings">${result.warnings.map(warning => `<p>⚠️ ${escapeHtml(warning)}</p>`).join("")}</div>` : ""}
    <div class="generator-counts" aria-label="Riepilogo proteine della settimana">${Object.entries(result.counts).map(([key, value]) => `<span title="Quante ricette di questa categoria finiscono nei pasti principali">${escapeHtml(GENERATOR_COUNT_LABELS[key] || key)}: ${value}</span>`).join("")}</div>
    ${pairsHtml}
    <div class="generator-diff">
      ${DAY_ORDER.map(day => {
        const dayChanges = changesByDay[day] || [];
        return `<div class="generator-diff-day"><strong>${DAY_NAMES[day]} · ${result.plan.days[day].type === "training" ? "Allenamento" : "Riposo"}</strong>
          ${MEAL_SLOTS.map(slot => {
            const change = dayChanges.find(item => item.slot === slot.id);
            const to = change?.to ?? result.plan.days[day][slot.id];
            return `<div class="generator-diff-slot ${change ? "changed" : ""}"><small>${escapeHtml(slot.shortLabel)}</small><span>${escapeHtml(generatorRecipeName(to))}</span></div>`;
          }).join("")}
        </div>`;
      }).join("")}
    </div>`;
}

function renderGeneratorModal() {
  const panels = getGeneratorPanelState();
  document.getElementById("generator-seed").value = generatorState.seed ?? "";
  const params = document.getElementById("generator-params");
  if (params) params.innerHTML = renderGeneratorParams();
  document.getElementById("generator-blocks").innerHTML = renderGeneratorBlocks();
  restoreGeneratorPanelState(panels);
  renderGeneratorPreview();
}

window.applyGenerator = async function() {
  if (!generatorState.proposal) {
    showToast("Genera prima un'anteprima", true);
    return;
  }
  const changes = window.PianoDomain ? PianoDomain.diffPlans(appState.plan, generatorState.proposal.plan).length : 0;
  const pairsCount = generatorState.proposal.pairs?.length || 0;
  const pairsNote = pairsCount ? `, ${pairsCount} accoppiate cena → pranzo` : "";
  if (!confirm(`Applicare la settimana generata (${changes} modifiche${pairsNote})? Verrà creato un backup prima dell'applicazione.`)) return;
  try {
    await createBackup(appState.recipes, appState.plan, appState.shopping, "week-generator", `Generatore settimana (seed ${generatorState.proposal.seed ?? "—"})`);
  } catch (error) {
    console.error(error);
    showToast("Backup non creato: operazione annullata", true);
    return;
  }
  setLoading("Applicazione della settimana generata…");
  try {
    const nextPlan = generatorState.proposal.plan;
    await saveWeeklyPlan(nextPlan);
    appState.plan = nextPlan;
    closeGeneratorModal();
    handleRoute();
    showToast("Settimana generata e salvata ✅");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Applicazione non riuscita", true);
  } finally {
    clearLoading();
  }
};

function setupModal() {
  document.getElementById("modal-close").addEventListener("click", closeRecipeModal);
  bindModalOutsideClose("recipe-modal", () => closeRecipeModal());
  document.querySelectorAll(".tab-btn").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(item => item.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(item => item.classList.add("hidden"));
      button.classList.add("active");
      document.getElementById(button.dataset.target).classList.remove("hidden");
    });
  });
  document.getElementById("modal-edit-btn").addEventListener("click", () => {
    if (currentModal?.recipe?.fromProfessional) { showToast("Ricetta del professionista: sola lettura", true); return; }
    editMode = true;
    currentModal.recipe = clone(currentModal.recipe);
    // Primo render della modifica: gli ingredienti sono la tab di partenza
    // (fix storico del tab Preparazione vuoto al primo ingresso per ricette
    // senza passaggi o note).
    setModalTab("tab-ingredients");
    renderModalContent();
  });
  document.getElementById("modal-cancel-edit-btn").addEventListener("click", cancelRecipeEdit);
  // Azioni secondarie: su mobile stanno nel foglio "Altre azioni", così la
  // modale non apre con sei pulsanti impilati che mangiano metà schermo.
  const moreToggle = document.getElementById("modal-more-btn");
  const morePanel = document.getElementById("modal-more-actions");
  moreToggle?.addEventListener("click", () => setRecipeActionsOpen(!morePanel.classList.contains("open")));
  morePanel?.querySelector(".modal-more-backdrop")?.addEventListener("click", () => setRecipeActionsOpen(false));
  morePanel?.querySelector(".modal-more-sheet")?.addEventListener("click", event => {
    if (event.target.closest("button")) setRecipeActionsOpen(false);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && morePanel?.classList.contains("open")) setRecipeActionsOpen(false);
  });
  document.getElementById("modal-duplicate-btn").addEventListener("click", () => duplicateRecipe(currentModal?.recipe?.id));
  document.getElementById("modal-save-btn").addEventListener("click", saveRecipeEdit);
  document.getElementById("modal-revert-btn").addEventListener("click", revertRecipe);
  document.getElementById("modal-export-btn").addEventListener("click", exportCurrentRecipe);
  document.getElementById("modal-share-btn").addEventListener("click", () => openShareDialog(currentModal?.recipe?.id));
  document.getElementById("modal-delete-btn").addEventListener("click", deleteCurrentRecipe);
  // Operazioni sul pasto direttamente dal dettaglio ricetta: evitano di
  // chiudere la ricetta e ricercare la casella nella griglia della settimana.
  document.getElementById("modal-plan-replace-btn")?.addEventListener("click", () => runPlanActionFromRecipe(target => {
    openSwapModal(target.day, target.slot);
  }));
  document.getElementById("modal-plan-swap-btn")?.addEventListener("click", () => runPlanActionFromRecipe(target => {
    openMealActions(target.day, target.slot);
    renderMealSwapList();
  }));
  document.getElementById("modal-plan-copy-btn")?.addEventListener("click", () => runPlanActionFromRecipe(target => {
    openMealActions(target.day, target.slot);
    renderMealCopyList();
  }));
}

// Le operazioni sul pasto vivono nella Settimana e ragionano su giorno + slot:
// dal dettaglio ricetta si chiude la modale e si riusa lo stesso flusso, senza
// duplicare la logica di scambio/copia.
function runPlanActionFromRecipe(action) {
  const day = currentModal?.dayKey;
  const slot = currentModal?.planSlot;
  if (!day || !slot) return;
  setRecipeActionsOpen(false);
  closeRecipeModal();
  action({ day, slot });
}

function setRecipeActionsOpen(open) {
  const panel = document.getElementById("modal-more-actions");
  const toggle = document.getElementById("modal-more-btn");
  if (!panel) return;
  panel.classList.toggle("open", open);
  toggle?.classList.toggle("active", open);
  toggle?.setAttribute("aria-expanded", open ? "true" : "false");
}

// Uscita esplicita dalla modifica: senza questa l'unico modo di annullare era
// la X o un tocco fuori, che scartavano le modifiche senza chiedere conferma.
function cancelRecipeEdit() {
  if (editMode && !window.confirm("Annullare le modifiche non salvate?")) return;
  closeRecipeModal();
}

// Preferenza A/R dell'anteprima ricette: persistita nelle impostazioni
// dispositivo, così riaprendo una ricetta dal ricettario resta l'ultima
// scelta manuale (finché non viene cambiata di nuovo).
function getRecipePreviewDayType() {
  const saved = appState.deviceSettings?.recipePreviewDayType;
  return ["training", "rest"].includes(saved) ? saved : "training";
}

window.setModalDayType = function(type) {
  if (!currentModal || currentModal.dayKey) return;
  if (!["training", "rest"].includes(type)) return;
  currentModal.dayType = type;
  appState.deviceSettings.recipePreviewDayType = type;
  saveLocalDeviceSettings(appState.deviceSettings);
  renderModalContent();
};

function getIngredientQuantityHtml(ingredient) {
  return `<strong>${escapeHtml(getIngredientDisplay(ingredient))}</strong>`;
}

window.openRecipeModal = function(recipeId, dayKey = null, slot = null) {
  const recipe = getRecipe(recipeId);
  if (!recipe) return;
  currentModal = {
    recipe: clone(recipe),
    original: clone(recipe),
    dayKey: DAY_ORDER.includes(dayKey) ? dayKey : null,
    dayType: DAY_ORDER.includes(dayKey) ? getDayType(dayKey) : getRecipePreviewDayType(),
    // `slot` guida l'adattamento cross-slot delle dosi ed esiste solo per
    // pranzo e cena; `planSlot` è la casella reale del piano (anche colazione
    // e spuntini) e serve alle operazioni sul pasto.
    slot: ["lunch", "dinner"].includes(slot) ? slot : null,
    planSlot: MEAL_SLOTS.some(item => item.id === slot) ? slot : null,
    isNew: false
  };
  editMode = false;
  renderModalContent();
  document.getElementById("recipe-modal").classList.remove("hidden");
};

function closeRecipeModal() {
  document.getElementById("recipe-modal").classList.add("hidden");
  modalOutsideCloseState.set("recipe-modal", false);
  setRecipeActionsOpen(false);
  currentModal = null;
  editMode = false;
}

function setModalTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach(button => button.classList.toggle("active", button.dataset.target === tabId));
  document.querySelectorAll(".tab-content").forEach(content => content.classList.toggle("hidden", content.id !== tabId));
}

function modalBatchRule() {
  if (!currentModal?.dayKey) return null;
  const batches = getActiveBatch(currentModal.dayKey);
  if (!batches.length) return null;
  const plannedDinner = appState.plan.days[currentModal.dayKey].dinner;
  return currentModal.recipe.id === plannedDinner ? batches : null;
}

// Nota compatta sulle differenze introdotte dalla vista allineata: serve a
// capire cosa è stato aggiunto o tolto rispetto alla ricetta originale.
function alignedChangesNote(aligned) {
  const parts = [];
  if (aligned?.added?.length) parts.push(`aggiunti: ${aligned.added.map(item => item.name).join(", ")}`);
  if (aligned?.omitted?.length) parts.push(`non previsti: ${aligned.omitted.map(item => item.name).join(", ")}`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function renderModalContent() {
  const recipe = currentModal.recipe;
  const dayType = currentModal.dayType;
  const batches = modalBatchRule();
  const plannedResolution = (!editMode && currentModal.dayKey && currentModal.planSlot)
    ? resolvePlannedRecipe(recipe, currentModal.dayKey, currentModal.planSlot)
    : null;
  const displayRecipe = plannedResolution?.recipe || recipe;
  const batchTab = document.querySelector('.tab-btn[data-target="tab-batch"]');
  const tabsBar = document.querySelector('.tabs');
  // Consultazione = schermata unica: ingredienti e preparazione restano
  // contemporaneamente visibili, come nella sezione DA CUCINARE.
  // Le tab restano disponibili solo in modalità modifica. La tab "Batch
  // cooking" è stata rimossa dall'editor (dati batch solo in consultazione):
  // in modifica note/nota speciale vivono nella tab Preparazione.
  tabsBar?.classList.toggle("hidden", !editMode);
  if (editMode && !document.querySelector(".tab-btn.active")) setModalTab("tab-ingredients");
  document.getElementById("tab-ingredients")?.classList.toggle("hidden", editMode && !document.querySelector('.tab-btn[data-target="tab-ingredients"]')?.classList.contains("active"));
  document.getElementById("tab-prep")?.classList.toggle("hidden", editMode && !document.querySelector('.tab-btn[data-target="tab-prep"]')?.classList.contains("active"));
  // In modifica la visibilità delle tab è gestita dai click; in consultazione
  // (schermata unica) il blocco batch è visibile solo se pertinente.
  if (!editMode) document.getElementById("tab-batch")?.classList.toggle("hidden", !batches);
  batchTab.classList.toggle("hidden", !batches || editMode);
  const batchButtonActive = document.querySelector('.tab-btn[data-target="tab-batch"]')?.classList.contains("active");
  if (batchButtonActive && (editMode || !batches)) setModalTab("tab-ingredients");

  document.getElementById("modal-title").innerHTML = editMode
    ? `<input id="edit-recipe-name" class="modal-title-input" value="${escapeAttr(recipe.name)}">`
    : `<span class="recipe-code">${escapeHtml(recipe.id)}</span> ${escapeHtml(recipe.emoji || "🍲")} ${escapeHtml(getRecipeDisplayName(recipe))}`;
  const dayTypeLabel = currentModal.dayKey
    ? `${DAY_NAMES[currentModal.dayKey]} · ${dayType === "training" ? "Allenamento" : "Riposo"}`
    : "Anteprima";
  const canToggle = !currentModal.dayKey;
  const toggleHtml = canToggle ? `
    <span class="modal-daytype-toggle day-type-control" aria-label="Dosi per tipo di giornata">
      <button class="type-option training ${dayType === "training" ? "active" : ""}" onclick="setModalDayType('training')" aria-pressed="${dayType === "training"}">Allenamento</button>
      <button class="type-option rest ${dayType === "rest" ? "active" : ""}" onclick="setModalDayType('rest')" aria-pressed="${dayType === "rest"}">Riposo</button>
    </span>` : "";
  const guidePlanControl = "";
  const professionalBadge = recipe.fromProfessional
    ? `<span class="pro-badge" title="Inviata da ${escapeAttr(recipe.fromProfessional.senderUsername || "professionista")}">🩺 Dal tuo professionista · sola lettura</span>`
    : "";
  document.getElementById("modal-time").innerHTML = editMode
    // Il campo "Categoria proteica" non è più mostrato né modificabile:
    // la categoria deriva automaticamente dagli ingredienti tramite
    // PianoDomain.classifyProtein, con il valore salvato come fallback.
    ? `<div class="edit-meta-grid"><label>Emoji<input id="edit-recipe-emoji" value="${escapeAttr(recipe.emoji || "🍲")}"></label><label>Pasto<select id="edit-recipe-slot">${MEAL_SLOTS.map(slot => `<option value="${slot.id}" ${recipe.slot === slot.id ? "selected" : ""}>${escapeHtml(slot.label)}</option>`).join("")}</select></label></div>`
    : `<div class="modal-context-row">${professionalBadge}<span>${escapeHtml(getSlotMeta(currentModal.slot || recipe.slot).label)} · ${escapeHtml(dayTypeLabel)} · ${escapeHtml(getProfileLabel())}</span>${toggleHtml}${guidePlanControl}</div>${plannedResolution?.aligned ? `<div class="modal-adapted-note">↻ Dosi allineate alla tua dieta per ${escapeHtml(getSlotMeta(currentModal.planSlot || recipe.slot).label.toLowerCase())}${alignedChangesNote(plannedResolution)}</div>` : ""}`;

  const ingredientList = document.getElementById("modal-ingredients-list");
  if (editMode) {
    const ingredientMeta = editorIngredientMeta(recipe);
    ingredientList.innerHTML = recipe.ingredients.map((ingredient, index) => {
      const meta = ingredientMeta[index];
      return `
      <li class="edit-ingredient ${meta.recognitionStatus === "unknown" ? "mapping-missing" : ""}" data-index="${index}">
        <div class="ing-combobox">
          <input id="edit-ing-name-${index}" aria-label="Ingrediente" value="${escapeAttr(ingredient.name)}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ing-suggest-${index}" autocomplete="off" spellcheck="false"
            oninput="editorIngredientInput(${index}, this)" onkeydown="editorIngredientKeydown(${index}, event)" onfocus="editorIngredientInput(${index}, this)" onblur="editorIngredientBlur(${index})">
          <div id="ing-suggest-${index}" class="ing-suggest hidden" role="listbox" aria-label="Suggerimenti dal catalogo ingredienti"></div>
          ${meta.recognitionStatus === "unknown" && ingredient.name?.trim() ? `<small class="ing-mapping-flag" title="Non presente nel catalogo globale: puoi proporre categoria e famiglia per farlo aggiungere">⚠ non nel catalogo</small><button type="button" class="btn btn-small btn-outline" onclick="openCatalogRequestModal(${index})">Segnala</button>` : meta.recognitionStatus === "ambiguous" ? `<small class="ing-mapping-flag" title="Nome ambiguo: scegli la voce corretta dall'elenco per non perdere il collegamento">⇄ ambiguo</small>` : ""}
        </div>
        <div class="portion-edit-grid portion-edit-grid-single">${quantityEditorField(`edit-ing-single-${index}`, "Quantità", getPortionValue(ingredient, "single"))}<button class="btn-icon remove-edit-item" aria-label="Rimuovi ingrediente" onclick="removeIngredient(${index})">×</button><small class="portion-shared-hint">Scegli numero e unità di misura (es. 60 g, 2 pz, 1 cucchiaio, q.b.). I valori particolari già salvati restano com'erano finché non li modifichi.</small></div>
      </li>`;
    }).join("") + `<li><button class="btn btn-outline full-width" onclick="addIngredient()">+ Aggiungi ingrediente</button></li>`;
  } else {
    const items = displayRecipe.ingredients.map(ingredient => ({ ing: ingredient, adapted: Boolean(plannedResolution?.aligned) }));
    const hasEquivalents = items.some(({ ing }) => !!dietEquivalentsForIngredient(ing.name, currentModal?.dayKey, currentModal?.planSlot));
    ingredientList.innerHTML = items.map(({ ing, adapted }) => {
      const adaptedMark = adapted ? ` <small class="adapted-mark" title="Dose allineata alla tua dieta per questo pasto">↻</small>` : "";
      if (dietEquivalentsForIngredient(ing.name, currentModal?.dayKey, currentModal?.planSlot)) {
        return `<li class="diet-ingredient" onclick="openDietEquivalents('${escapeAttr(ing.name)}')" title="Tocca per le equivalenze"><span>${escapeHtml(ing.name)}${adaptedMark} <small class="diet-hint">⇄</small></span>${getIngredientQuantityHtml(ing)}</li>`;
      }
      return `<li><span>${escapeHtml(ing.name)}${adaptedMark}</span>${getIngredientQuantityHtml(ing)}</li>`;
    }).join("") + (hasEquivalents ? `<li class="diet-footnote"><small>↑ Tocca un alimento con ⇄ per le equivalenze previste dalla tua dieta</small></li>` : "");
  }

  const prepList = document.getElementById("modal-prep-list");
  if (editMode) {
    prepList.innerHTML = recipe.steps.map((step, index) => `<li class="edit-step"><textarea id="edit-step-${index}">${escapeHtml(step)}</textarea><div><button class="btn-icon" onclick="moveStep(${index}, -1)">↑</button><button class="btn-icon" onclick="moveStep(${index}, 1)">↓</button><button class="btn-icon remove-edit-item" onclick="removeStep(${index})">×</button></div></li>`).join("") + `<li><button class="btn btn-outline full-width" onclick="addStep()">+ Aggiungi passaggio</button></li>`;
  } else {
    prepList.innerHTML = recipe.steps.map((step, index) => `<li class="step-item" onclick="this.classList.toggle('done')"><strong>${index + 1}.</strong> ${escapeHtml(step)}</li>`).join("");
    if (recipe.notes?.length) prepList.innerHTML += `<li class="recipe-notes"><strong>Note</strong><ul>${recipe.notes.map(note => `<li>${escapeHtml(note)}</li>`).join("")}</ul></li>`;
  }

  // In modifica le note vivono nella tab Preparazione
  // (la tab Batch cooking non è più presente nell'editor).
  const editNotesContent = document.getElementById("modal-edit-notes");
  const batchContent = document.getElementById("modal-batch-text");
  if (editMode) {
    document.getElementById("tab-prep")?.classList.toggle("hidden", !document.querySelector('.tab-btn[data-target="tab-prep"]')?.classList.contains("active"));
    if (editNotesContent) editNotesContent.innerHTML = `<label class="full-field">Note (una per riga)<textarea id="edit-recipe-notes" placeholder="Una nota per riga">${escapeHtml((recipe.notes || []).join("\n"))}</textarea></label>`;
    batchContent.textContent = "";
  } else if (batches && batches.length) {
    if (editNotesContent) editNotesContent.innerHTML = "";
    batchContent.innerHTML = batches.map(batch => `
      <div class="batch-modal">
        <h3>${escapeHtml(batch.template.title || "Preparazioni in anticipo")}</h3>
        <p><strong>🎯 Pranzo di ${DAY_NAMES[batch.targetDay]} · tra ${batch.daysUntilTarget} ${batch.daysUntilTarget === 1 ? "giorno" : "giorni"}</strong></p>
        <ol>${batch.tasks.map(task => {
          const status = BATCH_STATUS_LABELS[task.status] || null;
          return `<li><span>${escapeHtml(task.label)}</span>${status ? ` <span class="batch-task-status ${status.className}">${status.label}</span>` : ""}${task.quantity ? ` <strong>${escapeHtml(task.quantity)}</strong>` : ""}</li>`;
        }).join("")}</ol>
      </div>`).join("");
  } else {
    batchContent.textContent = "";
  }

  document.getElementById("modal-edit-btn").classList.toggle("hidden", editMode);
  const recipeReadOnly = Boolean(recipe.fromProfessional);
  document.getElementById("modal-edit-btn").disabled = recipeReadOnly;
  document.getElementById("modal-edit-btn").title = recipeReadOnly ? "Ricetta del professionista: sola lettura" : "";
  document.getElementById("modal-duplicate-btn").classList.toggle("hidden", editMode || currentModal.isNew);
  document.getElementById("modal-save-btn").classList.toggle("hidden", !editMode);
  document.getElementById("modal-export-btn").classList.toggle("hidden", editMode || currentModal.isNew);
  document.getElementById("modal-share-btn").classList.toggle("hidden", editMode || currentModal.isNew);
  document.getElementById("modal-revert-btn").classList.toggle("hidden", editMode || !recipe._original);
  document.getElementById("modal-delete-btn").classList.toggle("hidden", editMode || currentModal.isNew);
  document.getElementById("modal-cancel-edit-btn").classList.toggle("hidden", !editMode);
  // Operazioni sul pasto: solo quando la ricetta è aperta da una casella del
  // piano (dalla Settimana), non dal Ricettario né su una ricetta nuova.
  const planActions = document.getElementById("modal-plan-actions");
  const hasPlanTarget = Boolean(currentModal.dayKey && currentModal.planSlot && !currentModal.isNew);
  planActions?.classList.toggle("hidden", editMode || !hasPlanTarget);
  // "Altro" ha senso solo se nel foglio resta almeno un'azione disponibile.
  document.getElementById("modal-more-btn").classList.toggle(
    "hidden",
    editMode || (currentModal.isNew && !recipe._original && !hasPlanTarget)
  );
  setRecipeActionsOpen(false);
  document.getElementById("modal-edit-btn").textContent = "Modifica ricetta";
  document.getElementById("modal-save-btn").textContent = "Salva nel cloud";

}

// Hook post-salvataggio settimana: nessun report automatico (le richieste
// catalogo nascono dall'editor, su azione esplicita del cliente).
// ---- Richieste catalogo (ingrediente non riconosciuto → admin) ----
// Quando il riconoscimento restituisce «unknown» il cliente propone categoria
// e famiglia globale; la richiesta viene valutata SOLO dall'amministratore.
function setupCatalogRequestModal() {
  if (document.getElementById("catalog-request-modal")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="catalog-request-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="catalog-request-title">
      <div class="modal-content">
        <div class="modal-header"><div><p class="eyebrow">CATALOGO INGREDIENTI</p><h2 id="catalog-request-title">Ingrediente non riconosciuto</h2><p class="text-muted" id="catalog-request-subtitle"></p></div><button class="btn-icon" onclick="closeCatalogRequestModal()" aria-label="Chiudi">&times;</button></div>
        <div class="modal-body">
          <p>«<strong id="catalog-request-ingredient"></strong>» non è nel catalogo globale. Aiuta l'amministratore ad aggiungerlo: indica a quale categoria e famiglia dovrebbe appartenere.</p>
          <label class="full-field">Categoria
            <select id="catalog-request-category"></select>
          </label>
          <label class="full-field">Famiglia
            <select id="catalog-request-family"></select>
          </label>
          <p class="text-muted"><small>Verrà inviata una richiesta all'amministratore del catalogo: potrà accettarla, correggerla o rifiutarla.</small></p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" type="button" onclick="closeCatalogRequestModal()">Annulla</button>
          <button class="btn btn-primary" type="button" onclick="submitCatalogRequestFromModal()">Invia richiesta</button>
        </div>
      </div>
    </div>`);
  bindModalOutsideClose("catalog-request-modal", () => window.closeCatalogRequestModal());
  const categorySelect = document.getElementById("catalog-request-category");
  const familySelect = document.getElementById("catalog-request-family");
  categorySelect.addEventListener("change", () => renderCatalogRequestFamilyOptions(categorySelect.value));
}

function renderCatalogRequestCategoryOptions() {
  const index = buildLocalCatalogIndex();
  const categories = [...(index.categoriesById?.values() || [])].sort((a, b) => a.categoryId.localeCompare(b.categoryId));
  const select = document.getElementById("catalog-request-category");
  if (!select) return;
  select.innerHTML = categories.map(category =>
    `<option value="${escapeAttr(category.categoryId)}">${escapeHtml(category.displayName || category.categoryId)}</option>`
  ).join("");
}

function renderCatalogRequestFamilyOptions(categoryId) {
  const index = buildLocalCatalogIndex();
  const families = [...(index.familiesById?.values() || [])]
    .filter(family => !categoryId || !family.categoryId || family.categoryId === categoryId)
    .sort((a, b) => String(a.displayName || a.familyId).localeCompare(String(b.displayName || b.familyId), "it"));
  const select = document.getElementById("catalog-request-family");
  if (!select) return;
  select.innerHTML = families.map(family =>
    `<option value="${escapeAttr(family.familyId)}">${escapeHtml(family.displayName || family.familyId)}</option>`
  ).join("");
}

let catalogRequestIngredientText = null;

window.openCatalogRequestModal = async function(ingredientIndex) {
  const recipe = currentModal?.recipe;
  const ingredient = recipe?.ingredients?.[ingredientIndex];
  if (!ingredient?.name?.trim()) return;
  setupCatalogRequestModal();
  catalogRequestIngredientText = String(ingredient.name).trim();
  document.getElementById("catalog-request-ingredient").textContent = catalogRequestIngredientText;
  document.getElementById("catalog-request-subtitle").textContent = "Proposta di inserimento nel catalogo globale";
  await loadGlobalIngredientCatalogIndex();
  renderCatalogRequestCategoryOptions();
  renderCatalogRequestFamilyOptions(document.getElementById("catalog-request-category")?.value || "");
  document.getElementById("catalog-request-modal").classList.remove("hidden");
};

window.closeCatalogRequestModal = function() {
  document.getElementById("catalog-request-modal")?.classList.add("hidden");
  catalogRequestIngredientText = null;
};

window.submitCatalogRequestFromModal = async function() {
  if (!catalogRequestIngredientText) return;
  const proposedCategoryId = document.getElementById("catalog-request-category")?.value;
  const proposedFamilyId = document.getElementById("catalog-request-family")?.value;
  if (!proposedCategoryId || !proposedFamilyId) {
    showToast("Scegli categoria e famiglia", true);
    return;
  }
  try {
    await callSaasFunction("submitCatalogRequest", {
      ingredientText: catalogRequestIngredientText,
      proposedCategoryId,
      proposedFamilyId,
      idempotencyKey: `catalog-request-${Date.now()}`
    });
    window.closeCatalogRequestModal();
    showToast("Richiesta inviata ✅ L'amministratore la valuterà");
  } catch (error) {
    showToast(error?.message || "Invio non riuscito", true);
  }
};

// Unità di misura dell'editor quantità. Le stringhe canoniche salvate sono
// "60 g", "2 pz", "1 cucchiaio", "1 cucchiaino", "250 ml", "q.b.", "—".
const QUANTITY_UNIT_OPTIONS = [
  { value: "g", label: "g" },
  { value: "pz", label: "pz" },
  { value: "cucchiaio", label: "cucchiaio/i" },
  { value: "cucchiaino", label: "cucchiaino/i" },
  { value: "ml", label: "ml" },
  { value: "q.b.", label: "q.b." }
];

// Stato iniziale dei controlli numero+unità per un valore storico. Solo i
// valori rappresentabili (numero con unità nota, q.b., vuoto) precompilano
// i controlli; numeri senza unità ("2"), intervalli ("8-10 g") e note
// ("1 mazzetto") mostrano il segnaposto "—" e restano verbatim finché
// l'utente non modifica esplicitamente la riga (mai grammi attribuiti).
function quantityEditorState(raw) {
  const parsed = window.PianoDomain?.parseQuantity ? PianoDomain.parseQuantity(raw) : null;
  if (!parsed) return { num: "", unit: "g", qb: false };
  if (parsed.kind === "amount") {
    if (parsed.unit === null) return { num: String(parsed.value), unit: "", qb: false };
    if (QUANTITY_UNIT_OPTIONS.some(option => option.value === parsed.unit)) {
      return { num: String(parsed.value), unit: parsed.unit, qb: false };
    }
    return { num: "", unit: "", qb: false };
  }
  if (parsed.kind === "free") return { num: "", unit: "q.b.", qb: true };
  if (parsed.kind === "empty") return { num: "", unit: "g", qb: false };
  return { num: "", unit: "", qb: false };
}

function quantityEditorField(baseId, label, raw) {
  const state = quantityEditorState(raw);
  const options = (state.unit === "" ? `<option value="" selected disabled>—</option>` : "")
    + QUANTITY_UNIT_OPTIONS.map(option => `<option value="${option.value}"${option.value === state.unit ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
  return `<label>${escapeHtml(label)}<span class="qty-input-row">`
    + `<input id="${baseId}" type="number" min="0" step="any" inputmode="decimal" placeholder="0" value="${escapeAttr(state.num)}" data-num="${escapeAttr(state.num)}" data-unit="${escapeAttr(state.unit)}" aria-label="${escapeAttr(label)}: quantità numerica"${state.qb ? " disabled hidden" : ""}>`
    + `<select id="${baseId}-unit" aria-label="${escapeAttr(label)}: unità di misura" onchange="onQuantityUnitChange('${baseId}')">${options}</select>`
    + `</span></label>`;
}

// Con "q.b." il numero non serve: viene nascosto e disabilitato (quindi
// ignorato anche dalle tecnologie assistive); tornando a un'unità numerica
// il campo ricompare vuoto, pronto per una dose esplicita.
window.onQuantityUnitChange = function(baseId) {
  const numEl = document.getElementById(baseId);
  const unitEl = document.getElementById(`${baseId}-unit`);
  if (!numEl || !unitEl) return;
  const isFree = unitEl.value === "q.b.";
  numEl.disabled = isFree;
  numEl.hidden = isFree;
  if (isFree) numEl.value = "";
  else if (!numEl.value) numEl.focus();
};

// Legge una riga numero+unità. Riga intatta → originale verbatim (nessuna
// normalizzazione o attribuzione silenziosa, nemmeno "60g" → "60 g").
// Riga modificata → stringa canonica ("60 g", "2 pz", "q.b.", "—").
function readQuantityInput(baseId, original) {
  const fallback = original ?? "—";
  const numEl = document.getElementById(baseId);
  const unitEl = document.getElementById(`${baseId}-unit`);
  if (!numEl || !unitEl) return fallback;
  const num = String(numEl.value ?? "");
  const unit = String(unitEl.value ?? "");
  const initialNum = String(numEl.dataset?.num ?? "");
  const initialUnit = String(numEl.dataset?.unit ?? "");
  if (num === initialNum && unit === initialUnit) return fallback;
  if (unit === "q.b.") return "q.b.";
  if (!num.trim()) return "—";
  return `${num.trim()} ${unit}`;
}

function captureEditState() {
  if (!editMode || !currentModal) return;
  const recipe = currentModal.recipe;
  recipe.name = document.getElementById("edit-recipe-name")?.value.trim() || "Ricetta senza nome";
  recipe.emoji = document.getElementById("edit-recipe-emoji")?.value.trim() || "🍲";
  recipe.slot = document.getElementById("edit-recipe-slot")?.value || "lunch";
  // Categoria proteica: nessun controllo editabile nell'editor. Il valore
  // salvato resta invariato (fallback per classifyProtein) e non viene mai
  // azzerato dal salvataggio.
  // Schema 6: una sola quantità originale per profilo (le dosi di riposo sono
  // derivate dal piano). Il mapping al catalogo vive su ingredientId.
  const ingredientMeta = editorIngredientMeta(recipe);
  recipe.ingredients.forEach((ingredient, index) => {
    ingredient.name = document.getElementById(`edit-ing-name-${index}`)?.value.trim() || "Ingrediente";
    ingredient.portions = {
      single: readQuantityInput(`edit-ing-single-${index}`, getPortionValue(ingredient, "single"))
    };
    const metaId = ingredientMeta[index]?.ingredientId || "";
    if (metaId) ingredient.ingredientId = metaId;
    else delete ingredient.ingredientId;
  });
  recipe.steps = recipe.steps.map((_, index) => document.getElementById(`edit-step-${index}`)?.value.trim() || "");
  recipe.notes = (document.getElementById("edit-recipe-notes")?.value || "").split("\n").map(note => note.trim()).filter(Boolean);
  // Qualunque modifica manuale invalida le dosi contestuali precedenti; il
  // comando “Adatta e salva” le rigenera esplicitamente.
  delete recipe.guideAdaptations;
}

window.addIngredient = function() {
  captureEditState();
  currentModal.recipe.ingredients.push({ name: "", portions: { single: "—" } });
  renderModalContent();
  // Focus sulla riga appena creata per accelerare l'inserimento.
  const index = currentModal.recipe.ingredients.length - 1;
  setTimeout(() => document.getElementById(`edit-ing-name-${index}`)?.focus(), 40);
};

window.removeIngredient = function(index) {
  captureEditState();
  hideEditorSuggest(index);
  currentModal.recipe.ingredients.splice(index, 1);
  renderModalContent();
};

window.addStep = function() {
  captureEditState();
  currentModal.recipe.steps.push("");
  renderModalContent();
};

window.removeStep = function(index) {
  captureEditState();
  currentModal.recipe.steps.splice(index, 1);
  renderModalContent();
};

window.moveStep = function(index, direction) {
  captureEditState();
  const target = index + direction;
  if (target < 0 || target >= currentModal.recipe.steps.length) return;
  [currentModal.recipe.steps[index], currentModal.recipe.steps[target]] = [currentModal.recipe.steps[target], currentModal.recipe.steps[index]];
  renderModalContent();
};

async function saveRecipeEdit() {
  captureEditState();
  const recipe = currentModal.recipe;
  // Lo scratch dell'editor (suggerimenti catalogo) non viene mai persistito.
  delete recipe._ingredientMeta;
  // Preparazione opzionale: una ricetta può essere salvata anche senza
  // passaggi (utile per cibi già pronti o schede in lavorazione).
  if (!recipe.ingredients.length) {
    showToast("Aggiungi almeno un ingrediente", true);
    return;
  }
  if (!currentModal.isNew && !recipe._original && currentModal.original) {
    const baseline = clone(currentModal.original);
    delete baseline._original;
    recipe._original = baseline;
  }
  setLoading("Salvataggio delle ricette…");
  const previousRecipes = clone(appState.recipes);
  try {
    const existingIndex = appState.recipes.findIndex(item => item.id === recipe.id);
    if (existingIndex >= 0) appState.recipes[existingIndex] = clone(recipe);
    else appState.recipes.push(clone(recipe));
    appState.recipes.sort((a, b) => a.id.localeCompare(b.id, "it", { numeric: true }));
    await saveRecipeCatalog(appState.recipes);
    setRecipes(appState.recipes);
    if (currentModal.assignAfterSave) {
      const { day, slot } = currentModal.assignAfterSave;
      appState.plan.days[day][slot] = recipe.id;
      await saveWeeklyPlan(appState.plan);
      currentModal.assignAfterSave = null;
    }
    currentModal.isNew = false;
    currentModal.original = clone(recipe);
    editMode = false;
    renderModalContent();
    showToast("Ricetta salvata nel cloud ✅");
    if (window.location.hash === "#recipes") renderRecipes();
  } catch (error) {
    setRecipes(previousRecipes);
    console.error(error);
    showToast("Salvataggio non riuscito", true);
  } finally {
    clearLoading();
  }
}

async function revertRecipe() {
  if (!currentModal.recipe._original || !confirm("Ripristinare dosi, ingredienti e procedimento precedenti alla prima modifica?")) return;
  setLoading("Ripristino della ricetta…");
  const previousRecipes = clone(appState.recipes);
  try {
    const original = clone(currentModal.recipe._original);
    delete original._original;
    const index = appState.recipes.findIndex(recipe => recipe.id === original.id);
    appState.recipes[index] = original;
    await saveRecipeCatalog(appState.recipes);
    setRecipes(appState.recipes);
    currentModal.recipe = clone(original);
    currentModal.original = clone(original);
    editMode = false;
    renderModalContent();
    showToast("Ricetta ripristinata");
  } catch (error) {
    setRecipes(previousRecipes);
    console.error(error);
    showToast("Ripristino non riuscito", true);
  } finally {
    clearLoading();
  }
}

async function deleteRecipes(recipesToDelete, description) {
  const ids = new Set(recipesToDelete.map(recipe => recipe.id));
  const affectedSlots = window.PianoDomain
    ? PianoDomain.planSlotsForRecipeRemoval(appState.plan, [...ids])
    : [];
  const slotText = affectedSlots.length
    ? `\n\n${affectedSlots.length} slot del piano diventeranno vuoti:\n${affectedSlots.slice(0, 8).map(slot => `· ${DAY_NAMES[slot.day]} ${getSlotMeta(slot.slot).shortLabel}`).join("\n")}${affectedSlots.length > 8 ? `\n· e altri ${affectedSlots.length - 8}…` : ""}`
    : "";
  const label = recipesToDelete.length === 1
    ? `Eliminare la ricetta “${recipesToDelete[0].name}”?`
    : `Eliminare tutte le ${recipesToDelete.length} ricette del catalogo?`;
  if (!confirm(`${label}${slotText}\n\nVerrà creato un backup prima dell'eliminazione.`)) return false;
  try {
    await createBackup(appState.recipes, appState.plan, appState.shopping, "delete-recipes", description);
  } catch (error) {
    console.error(error);
    showToast("Backup non creato: eliminazione annullata", true);
    return false;
  }
  setLoading("Eliminazione ricette…");
  const previousRecipes = clone(appState.recipes);
  const previousPlan = clone(appState.plan);
  try {
    const nextRecipes = appState.recipes.filter(recipe => !ids.has(recipe.id));
    const nextPlan = sanitizePlanForCatalog(appState.plan, nextRecipes);
    await Promise.all([saveRecipeCatalog(nextRecipes), saveWeeklyPlan(nextPlan)]);
    setRecipes(nextRecipes);
    appState.plan = nextPlan;
    return true;
  } catch (error) {
    setRecipes(previousRecipes);
    appState.plan = previousPlan;
    console.error(error);
    showToast("Eliminazione non riuscita", true);
    return false;
  } finally {
    clearLoading();
  }
}

async function deleteCurrentRecipe() {
  if (!currentModal?.recipe) return;
  const deleted = await deleteRecipes([currentModal.recipe], `Eliminazione della ricetta “${currentModal.recipe.name}”`);
  if (!deleted) return;
  closeRecipeModal();
  handleRoute();
  showToast("Ricetta eliminata");
}

window.deleteAllRecipes = async function() {
  if (!appState.recipes.length) return;
  const deleted = await deleteRecipes(appState.recipes, "Eliminazione di tutte le ricette del catalogo");
  if (!deleted) return;
  handleRoute();
  showToast("Ricettario svuotato");
};

// ---- Prezzi condivisi (Spesa Smart) ----
// Un unico database (priceEntries) condiviso tra TUTTI gli utenti: ognuno
// registra i prezzi che trova e tutti vedono dove conviene comprare.

const PRICE_UNIT_OPTIONS = [
  { id: "gr", label: "GR" }, { id: "kg", label: "KG" }, { id: "ml", label: "ML" },
  { id: "l", label: "L" }, { id: "pz", label: "PZ" }
];
const PRICE_ARCHIVE_LIMIT = 150;
// L'archivio non viene riscaricato se è fresco di questo tempo; l'elenco in
// cache viene comunque mostrato subito a ogni ingresso nella scheda.
const PRICE_ARCHIVE_TTL_MS = 60000;

let priceState = {
  loaded: false,
  meta: { stores: [], products: [], brands: [] },
  tab: "log",
  unit: "gr",
  editingId: null,
  editingDate: null,
  draft: { store: "", product: "", brand: "", price: "", weight: "1000" },
  history: { key: null, entries: [], loading: false },
  compare: { query: "", productKey: null, productName: null, brandKey: null, entries: [], candidates: [], brandChips: [], quickPicks: [], loading: false },
  stores: { view: "list", storeKey: null, storeName: "", loading: false, rows: [], summary: null },
  archive: { entries: [], storeFilter: null, storeChips: [], loading: false, loadedAt: 0, error: false }
};
let priceHistoryTimer = null;
let priceCompareTimer = null;
let priceScanner = null;

// Cache delle query Firestore (condivisa da confronto, badge, pagina negozio
// e lista spesa): lo stesso prodotto o negozio viene letto UNA volta a
// sessione. Le chiavi negozio usano il prefisso "store:" per non collidere
// con le chiavi prodotto normalizzate.
const PRICE_STORE_CACHE_PREFIX = "store:";
const priceEntriesCache = new Map();

async function getCachedPriceEntries(productKey) {
  if (priceEntriesCache.has(productKey)) return priceEntriesCache.get(productKey);
  const entries = await getPriceEntriesForProduct(productKey);
  priceEntriesCache.set(productKey, entries);
  return entries;
}

async function getCachedPriceEntriesForStore(storeKey) {
  const cacheKey = PRICE_STORE_CACHE_PREFIX + storeKey;
  if (priceEntriesCache.has(cacheKey)) return priceEntriesCache.get(cacheKey);
  const entries = await getPriceEntriesForStore(storeKey);
  priceEntriesCache.set(cacheKey, entries);
  return entries;
}

function invalidatePriceEntriesCache() {
  priceEntriesCache.clear();
}

// Invalidazione mirata dopo una scrittura: si ripulisce SOLO il prodotto e il
// negozio toccati, tutte le altre voci in cache restano valide (meno letture
// Firestore a ogni registrazione).
function invalidatePriceCachesForEntry(entry) {
  if (!entry) return;
  if (entry.productKey) priceEntriesCache.delete(entry.productKey);
  if (entry.storeKey) priceEntriesCache.delete(PRICE_STORE_CACHE_PREFIX + entry.storeKey);
}

// Aggiorna in memoria la rubrica negozi/prodotti/marche dopo un salvataggio:
// i datalist e i suggerimenti vedono subito i nomi nuovi senza rileggere il
// documento priceMeta/global da Firestore.
function mergePriceMetaInMemory(entry) {
  if (!entry) return;
  const mergeList = (listName, value) => {
    const clean = String(value || "").trim();
    if (!clean) return;
    const list = priceState.meta[listName];
    const exists = list.some(name => PriceDomain.priceKey(name) === PriceDomain.priceKey(clean));
    if (!exists) {
      list.push(clean);
      list.sort((a, b) => a.localeCompare(b, "it"));
    }
  };
  mergeList("stores", entry.store);
  mergeList("products", entry.product);
  mergeList("brands", entry.brand);
}


function priceUserMeta() {
  return { uid: appState.user?.uid || null, username: usernameFromUser(appState.user) };
}

async function ensurePriceData(force = false) {
  if (priceState.loaded && !force) return;
  priceState.loaded = true;
  try {
    priceState.meta = await getPriceMeta();
  } catch (error) {
    console.warn("Rubrica prezzi non caricata", error);
  }
  if (window.location?.hash === "#prices") renderPrices();
}

window.refreshPricesData = async function() {
  priceState.archive.loadedAt = 0;
  priceState.archive.error = false;
  priceState.history = { key: null, entries: [], loading: false };
  invalidatePriceEntriesCache();
  await ensurePriceData(true);
  if (priceState.tab === "archive") loadPriceArchive(true);
  else if (priceState.tab === "compare" && priceState.compare.productKey) loadPriceComparison(priceState.compare.productKey);
  else if (priceState.tab === "stores" && priceState.stores.view === "detail") openStoreDetail(priceState.stores.storeKey, priceState.stores.storeName);
  else renderPrices();
  showToast("Prezzi aggiornati ✅");
};

window.switchPriceTab = function(tab) {
  if (!["log", "compare", "stores", "archive"].includes(tab)) return;
  capturePriceDraft();
  priceState.tab = tab;
  renderPrices();
};

function capturePriceDraft() {
  const fields = ["store", "product", "brand", "price", "weight"];
  fields.forEach(field => {
    const element = document.getElementById(`price-${field}`);
    if (element) priceState.draft[field] = element.value;
  });
  const unit = document.querySelector(".price-unit-btn.active")?.dataset?.unit;
  if (unit) priceState.unit = unit;
}

// ---- Rendering della sezione ----

function renderPrices() {
  const container = document.getElementById("view-prices");
  if (!container) return;
  ensurePriceData();
  const tab = priceState.tab;
  container.innerHTML = `
    <div class="page-heading prices-heading">
      <div><p class="eyebrow">Database condiviso tra tutti gli utenti</p><h1>Prezzi</h1><p>Registra i prezzi che trovi e scopri dove conviene comprare.</p></div>
      <button class="btn btn-outline" onclick="refreshPricesData()">↻ Aggiorna</button>
    </div>
    <div class="prices-tabs" role="tablist">
      <button class="prices-tab ${tab === "log" ? "active" : ""}" onclick="switchPriceTab('log')">🧾 Registra</button>
      <button class="prices-tab ${tab === "compare" ? "active" : ""}" onclick="switchPriceTab('compare')">🔍 Confronta</button>
      <button class="prices-tab ${tab === "stores" ? "active" : ""}" onclick="switchPriceTab('stores')">🏪 Negozi</button>
      <button class="prices-tab ${tab === "archive" ? "active" : ""}" onclick="switchPriceTab('archive')">🗂 Archivio</button>
    </div>
    ${tab === "log" ? renderPriceLogTab() : tab === "compare" ? renderPriceCompareTab() : tab === "stores" ? renderPriceStoresTab() : renderPriceArchiveTab()}
  `;
  if (tab === "log") restorePriceDraft();
  // Il contenitore delle altre schede viene ricreato vuoto a ogni render:
  // si ripristina subito il contenuto già in stato (elenco archivio in cache,
  // esito del confronto precedente) senza rilanciare query per forza.
  if (tab === "compare") renderPriceCompareResults();
  if (tab === "archive") {
    renderPriceArchiveList();
    loadPriceArchive();
  }
}

function renderPriceLogTab() {
  const draft = priceState.draft;
  const editing = Boolean(priceState.editingId);
  return `
    <div class="prices-actions-row prices-actions-row-single">
      <button class="btn btn-outline price-action-btn" onclick="openPriceScanModal()">📷 Scansiona barcode</button>
    </div>

    <section class="prices-card">
      <label class="prices-label" for="price-store">Negozio</label>
      <div class="price-field-wrap">
        <input id="price-store" placeholder="Dove ti trovi? Es. Conad, Lidl…" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="next"
          oninput="priceFieldInput('store', this)" onkeydown="priceFieldKeydown('store', event)"
          onfocus="priceFieldFocus('store', this)" onblur="priceFieldBlur('store')">
        <div id="price-store-suggest" class="price-compare-suggest hidden" role="listbox" aria-label="Suggerimenti negozio"></div>
      </div>

      <label class="prices-label" for="price-product">Prodotto</label>
      <div class="price-field-wrap">
        <input id="price-product" placeholder="Cosa compri? Es. latte, pasta…" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="next"
          oninput="priceFieldInput('product', this)" onkeydown="priceFieldKeydown('product', event)"
          onfocus="priceFieldFocus('product', this)" onblur="priceFieldBlur('product')">
        <div id="price-product-suggest" class="price-compare-suggest hidden" role="listbox" aria-label="Suggerimenti prodotto"></div>
      </div>

      <label class="prices-label" for="price-brand">Marca</label>
      <div class="price-field-wrap">
        <input id="price-brand" placeholder="Quale marca? Es. Barilla…" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="next"
          oninput="priceFieldInput('brand', this)" onkeydown="priceFieldKeydown('brand', event)"
          onfocus="priceFieldFocus('brand', this)" onblur="priceFieldBlur('brand')">
        <div id="price-brand-suggest" class="price-compare-suggest hidden" role="listbox" aria-label="Suggerimenti marca"></div>
      </div>

      <div class="prices-grid-2">
        <div>
          <label class="prices-label" for="price-price">Prezzo (€)</label>
          <input id="price-price" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0,00"
            value="${escapeAttr(draft.price)}" enterkeyhint="next" onkeydown="priceEnterNext(event, 'price-weight')" oninput="schedulePricePreview()" onclick="priceSelectValue(this)">
        </div>
        <div>
          <label class="prices-label" for="price-weight">Peso / Quantità</label>
          <input id="price-weight" type="number" step="any" min="0" inputmode="decimal" placeholder="1000"
            value="${escapeAttr(draft.weight)}" enterkeyhint="done" onkeydown="priceEnterNext(event, 'price-save-btn')" oninput="schedulePricePreview()" onclick="priceSelectValue(this)">
        </div>
      </div>

      <label class="prices-label">Unità</label>
      <div class="price-unit-control">
        ${PRICE_UNIT_OPTIONS.map(unit => `<button type="button" class="price-unit-btn ${priceState.unit === unit.id ? "active" : ""}" data-unit="${unit.id}" onclick="setPriceUnit('${unit.id}')">${unit.label}</button>`).join("")}
      </div>

      <div class="price-preview-box">
        <span id="price-badge" class="price-badge hidden"></span>
        <div id="price-preview" class="price-preview-value"></div>
        <div id="price-history-hint" class="text-muted price-history-hint"></div>
      </div>

      <button class="btn btn-primary full-width" id="price-save-btn" onclick="savePriceForm()">${editing ? "Aggiorna prezzo" : "Registra prezzo"}</button>
      ${editing ? `<button class="btn btn-outline full-width" onclick="cancelPriceEdit()">Annulla modifica</button>` : ""}
      <p class="text-muted price-save-note">Ogni registrazione resta nello storico condiviso: il confronto usa sempre l'ultimo prezzo per negozio.</p>
    </section>
  `;
}

function restorePriceDraft() {
  const draft = priceState.draft;
  const values = { "price-store": draft.store, "price-product": draft.product, "price-brand": draft.brand };
  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element && value) element.value = value;
  });
  schedulePricePreview(0);
}

// ---- Registra: suggerimenti live per negozio / prodotto / marca ----
// Stesso componente già usato in Confronta (le datalist native e il
// completamento inline sono inaffidabili su tastiera mobile). Tutto locale:
// la rubrica è già in memoria, nessuna lettura Firebase.

const PRICE_FIELD_SUGGESTS = {
  store: { inputId: "price-store", boxId: "price-store-suggest", listName: "stores", label: "Negozi", next: "price-product" },
  product: { inputId: "price-product", boxId: "price-product-suggest", listName: "products", label: "Prodotti", next: "price-brand" },
  brand: { inputId: "price-brand", boxId: "price-brand-suggest", listName: "brands", label: "Marche", next: "price-price" }
};
const priceFieldSuggestNames = { store: [], product: [], brand: [] };
let priceFieldSuggestActive = -1;

// Campo vuoto → i primi 8 nomi della rubrica (scelta a un tocco); testo →
// match esatto + (per i prodotti) nomi simili + sottostringhe.
function priceFieldSuggestList(field, query, options = {}) {
  const config = PRICE_FIELD_SUGGESTS[field];
  if (!config || !window.PriceDomain) return [];
  const names = priceState.meta[config.listName] || [];
  if (!names.length) return [];
  const trimmed = String(query || "").trim();
  if (!trimmed) return [...new Set(names)].slice(0, 8);
  const { exact, candidates } = PriceDomain.matchProducts(trimmed, names);
  const similar = field === "product" ? PriceDomain.similarProducts(trimmed, names, 5) : [];
  const merged = [];
  const seen = new Set();
  [exact, ...similar, ...candidates].forEach(name => {
    if (!name) return;
    const key = PriceDomain.priceKey(name);
    if (seen.has(key)) return;
    if (options.skipExact && exact && key === PriceDomain.priceKey(exact)) return;
    seen.add(key);
    merged.push(name);
  });
  return merged.slice(0, 8);
}

function renderPriceFieldSuggestions(field, query, options = {}) {
  const config = PRICE_FIELD_SUGGESTS[field];
  const box = config ? document.getElementById(config.boxId) : null;
  if (!box) return;
  const list = priceFieldSuggestList(field, query, options);
  priceFieldSuggestNames[field] = list;
  priceFieldSuggestActive = -1;
  if (!list.length) {
    hidePriceFieldSuggestions(field);
    return;
  }
  box.innerHTML = `
    <div class="price-compare-suggest-label">${config.label}</div>
    ${list.map((name, index) => `<button type="button" class="price-compare-suggest-item" role="option" data-field="${field}" data-idx="${index}" onmousedown="event.preventDefault()" onclick="selectPriceFieldSuggestion('${field}', ${index})">${escapeHtml(name)}</button>`).join("")}`;
  box.classList.remove("hidden");
}

function hidePriceFieldSuggestions(field) {
  const config = PRICE_FIELD_SUGGESTS[field];
  priceFieldSuggestActive = -1;
  if (!config) return;
  const box = document.getElementById(config.boxId);
  if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
}

function hideOtherPriceFieldSuggestions(field) {
  Object.keys(PRICE_FIELD_SUGGESTS).forEach(name => { if (name !== field) hidePriceFieldSuggestions(name); });
}

function updatePriceFieldSuggestActive(field) {
  document.querySelectorAll(`.price-compare-suggest-item[data-field="${field}"]`).forEach(item => {
    const active = Number(item.dataset?.idx) === priceFieldSuggestActive;
    item.classList.toggle("active", active);
    if (active && typeof item.scrollIntoView === "function") item.scrollIntoView({ block: "nearest" });
  });
}

window.priceFieldInput = function(field, input) {
  priceState.draft[field] = input?.value || "";
  renderPriceFieldSuggestions(field, input?.value || "");
  if (field === "product") schedulePricePreview();
};

window.priceFieldFocus = function(field, input) {
  hideOtherPriceFieldSuggestions(field);
  renderPriceFieldSuggestions(field, input?.value || "");
};

window.priceFieldBlur = function(field) {
  setTimeout(() => hidePriceFieldSuggestions(field), 180);
};

window.priceFieldKeydown = function(field, event) {
  const names = priceFieldSuggestNames[field] || [];
  const config = PRICE_FIELD_SUGGESTS[field];
  const box = config ? document.getElementById(config.boxId) : null;
  const boxOpen = Boolean(names.length && box && !box.classList.contains("hidden"));
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!boxOpen) return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    priceFieldSuggestActive = (priceFieldSuggestActive + delta + names.length) % names.length;
    updatePriceFieldSuggestActive(field);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (boxOpen) selectPriceFieldSuggestion(field, priceFieldSuggestActive >= 0 ? priceFieldSuggestActive : 0);
    if (config?.next) focusPriceElement(config.next);
    return;
  }
  if (event.key === "Escape") hidePriceFieldSuggestions(field);
};

window.selectPriceFieldSuggestion = function(field, index) {
  const name = priceFieldSuggestNames[field]?.[index];
  if (!name) return;
  hidePriceFieldSuggestions(field);
  const input = document.getElementById(PRICE_FIELD_SUGGESTS[field].inputId);
  if (input) input.value = name;
  priceState.draft[field] = name;
  if (field === "product") schedulePricePreview(0);
};

// Invio sui campi numerici: salta al campo successivo (o al pulsante di
// salvataggio) senza costringere a tappare ogni campo su mobile.
window.priceEnterNext = function(event, nextId) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  focusPriceElement(nextId);
};

function focusPriceElement(id) {
  const element = document.getElementById(id);
  if (!element) return;
  try { element.focus(); } catch (_) {}
  priceSelectValue(element);
}

// Seleziona il contenuto quando l'elemento lo consente: su iOS Safari
// select() sui campi number è un no-op silenzioso, per questo il try/catch.
window.priceSelectValue = function(input) {
  try {
    if (input && typeof input.select === "function") input.select();
  } catch (_) {}
};

window.setPriceUnit = function(unit) {
  if (!PRICE_UNIT_OPTIONS.some(option => option.id === unit)) return;
  priceState.unit = unit;
  document.querySelectorAll(".price-unit-btn").forEach(button => button.classList.toggle("active", button.dataset.unit === unit));
  renderPricePreviewNow();
};

// ---- Anteprima prezzo normalizzato + giudizio rispetto allo storico ----

window.schedulePricePreview = function(delay = 350) {
  renderPricePreviewNow();
  clearTimeout(priceHistoryTimer);
  priceHistoryTimer = setTimeout(loadPriceHistoryForDraft, delay);
};

function draftProductKey() {
  return window.PriceDomain ? PriceDomain.priceKey(document.getElementById("price-product")?.value || "") : "";
}

async function loadPriceHistoryForDraft() {
  const key = draftProductKey();
  if (!key) return;
  if (priceState.history.key === key && !priceState.history.loading) {
    renderPricePreviewNow();
    return;
  }
  priceState.history.loading = true;
  try {
    const entries = await getCachedPriceEntries(key);
    priceState.history = { key, entries, loading: false };
  } catch (error) {
    console.warn("Storico prezzi non disponibile", error);
    priceState.history.loading = false;
    return;
  }
  if (draftProductKey() === key) renderPricePreviewNow();
}

function renderPricePreviewNow() {
  const preview = document.getElementById("price-preview");
  const badge = document.getElementById("price-badge");
  const hint = document.getElementById("price-history-hint");
  if (!preview || !window.PriceDomain) return;
  const priceValue = parseFloat(document.getElementById("price-price")?.value);
  const weightValue = parseFloat(document.getElementById("price-weight")?.value);
  const computed = Number.isFinite(priceValue) && Number.isFinite(weightValue)
    ? PriceDomain.computeNormPrice(priceValue, weightValue, priceState.unit)
    : null;
  if (!computed) {
    preview.textContent = "";
    badge?.classList.add("hidden");
    if (hint) hint.textContent = "";
    return;
  }
  preview.textContent = `${PriceDomain.formatEuro(computed.normPrice)}/${computed.normUnit}`;

  const key = draftProductKey();
  const history = key && priceState.history.key === key ? priceState.history.entries : [];
  const deal = history.length ? PriceDomain.dealBadge(computed.normPrice, history.map(entry => entry.normPrice)) : null;
  if (badge) {
    if (deal) {
      badge.textContent = deal.label;
      badge.className = `price-badge ${deal.type}`;
    } else {
      badge.classList.add("hidden");
    }
  }
  if (hint) {
    if (!key) hint.textContent = "";
    else if (priceState.history.key === key && history.length) {
      const stats = PriceDomain.priceStats(history);
      hint.textContent = `Storico condiviso (${stats.count} registr.): min ${PriceDomain.formatEuro(stats.min)} · media ${PriceDomain.formatEuro(stats.avg)} · max ${PriceDomain.formatEuro(stats.max)}`;
    } else if (priceState.history.loading) hint.textContent = "Caricamento storico…";
    else hint.textContent = "";
  }
}

// ---- Salvataggio / modifica voce ----

function readPriceFormInput() {
  return {
    store: document.getElementById("price-store")?.value || "",
    product: document.getElementById("price-product")?.value || "",
    brand: document.getElementById("price-brand")?.value || "",
    price: parseFloat(document.getElementById("price-price")?.value),
    weight: parseFloat(document.getElementById("price-weight")?.value),
    unit: priceState.unit,
    date: priceState.editingId ? (priceState.editingDate || undefined) : undefined
  };
}

function resetPriceForm(keepStore = true) {
  const store = keepStore ? (document.getElementById("price-store")?.value || priceState.draft.store) : "";
  priceState.draft = { store, product: "", brand: "", price: "", weight: "1000" };
  priceState.history = { key: null, entries: [], loading: false };
}

window.savePriceForm = async function() {
  if (!window.PriceDomain) return;
  let entry;
  try {
    entry = PriceDomain.buildPriceEntry(readPriceFormInput(), priceUserMeta());
  } catch (error) {
    showToast(`⚠️ ${error.message}`, true);
    return;
  }
  const editingId = priceState.editingId;
  setLoading(editingId ? "Aggiornamento del prezzo…" : "Registrazione del prezzo…");
  try {
    let savedId = editingId;
    if (editingId) {
      await updatePriceEntry(editingId, entry);
      showToast("Prezzo aggiornato ✅");
    } else {
      savedId = await savePriceEntry(entry);
      showToast("Prezzo registrato ✅");
    }
    const store = document.getElementById("price-store")?.value || "";
    priceState.editingId = null;
    priceState.editingDate = null;
    // Aggiornamento locale, senza nuove letture Firestore: si ripulisce solo
    // la cache del prodotto/negozio toccato, la voce entra in cima all'archivio
    // e la rubrica dei nomi viene aggiornata in memoria.
    invalidatePriceCachesForEntry(entry);
    mergePriceMetaInMemory(entry);
    const savedEntry = { ...entry, ...(savedId ? { id: savedId } : {}), createdAtMs: Date.now() };
    if (editingId) {
      const index = priceState.archive.entries.findIndex(item => item.id === editingId);
      if (index >= 0) priceState.archive.entries[index] = { ...priceState.archive.entries[index], ...savedEntry };
    } else {
      priceState.archive.entries.unshift(savedEntry);
      priceState.archive.entries = priceState.archive.entries.slice(0, PRICE_ARCHIVE_LIMIT);
    }
    priceState.archive.loadedAt = Date.now();
    priceState.archive.error = false;
    priceState.history = { key: null, entries: [], loading: false };
    resetPriceForm(true);
    priceState.draft.store = store;
    renderPrices();
    // Se il prodotto appena registrato è quello aperto in Confronta, il
    // confronto viene ricaricato con i dati freschi; altrimenti il contesto
    // di ricerca dell'utente resta indisturbato.
    if (priceState.compare.productKey === entry.productKey) loadPriceComparison(entry.productKey);
  } catch (error) {
    console.error(error);
    showToast("Salvataggio non riuscito: controlla la connessione", true);
  } finally {
    clearLoading();
  }
};

window.startPriceEdit = function(entryId) {
  const entry = priceState.archive.entries.find(item => item.id === entryId);
  if (!entry) return;
  if (entry.createdBy && entry.createdBy !== appState.user?.uid) {
    showToast("Puoi modificare solo i prezzi registrati da te", true);
    return;
  }
  capturePriceDraft();
  priceState.editingId = entryId;
  priceState.editingDate = entry.date;
  priceState.draft = { store: entry.store, product: entry.product, brand: entry.brand, price: String(entry.price), weight: String(entry.weight) };
  priceState.unit = entry.unit || "gr";
  priceState.tab = "log";
  // key: null forza il ricaricamento dello storico per il prodotto in edit
  // (con la chiave già impostata loadPriceHistoryForDraft salterebbe la query).
  priceState.history = { key: null, entries: [], loading: false };
  renderPrices();
  loadPriceHistoryForDraft();
  showToast("✏️ Modifica in corso");
};

window.cancelPriceEdit = function() {
  priceState.editingId = null;
  priceState.editingDate = null;
  resetPriceForm(true);
  renderPrices();
};

window.deletePriceEntryClick = async function(entryId) {
  const entry = priceState.archive.entries.find(item => item.id === entryId);
  if (!entry) return;
  if (!confirm(`Eliminare “${entry.product}” (${entry.brand}) registrato da ${entry.createdByUsername || "te"}?`)) return;
  try {
    await deletePriceEntry(entryId);
    priceState.archive.entries = priceState.archive.entries.filter(item => item.id !== entryId);
    invalidatePriceCachesForEntry(entry);
    priceState.history = { key: null, entries: [], loading: false };
    renderPrices();
    showToast("Voce eliminata");
  } catch (error) {
    console.error(error);
    showToast("Eliminazione non riuscita", true);
  }
};

// ---- Confronto tra negozi ----

window.priceCompareInput = function(value) {
  priceState.compare.query = value;
  // Suggerimenti immediati (calcolo locale, nessuna query) e ricerca con un
  // piccolo debounce per il caricamento automatico del match esatto.
  renderPriceCompareSuggestions(value);
  clearTimeout(priceCompareTimer);
  priceCompareTimer = setTimeout(() => runPriceCompareSearch(value), 250);
};

async function runPriceCompareSearch(query) {
  if (!window.PriceDomain) return;
  const trimmed = String(query || "").trim();
  if (!trimmed) {
    priceState.compare.productKey = null;
    priceState.compare.productName = null;
    priceState.compare.brandKey = null;
    priceState.compare.entries = [];
    priceState.compare.candidates = [];
    renderPriceCompareResults();
    return;
  }
  const { exact, candidates } = PriceDomain.matchProducts(trimmed, priceState.meta.products);
  if (exact) {
    rememberCompareProduct(exact);
    priceState.compare.candidates = [];
    await loadPriceComparison(PriceDomain.priceKey(exact), exact);
    return;
  }
  // Candidati più ricchi: oltre alle corrispondenze per sottostringa
  // ("latte" → "Latte fresco") anche i prodotti con parole significative in
  // comune, così errori di battitura o nomi parziali trovano comunque algo.
  const similar = PriceDomain.similarProducts(trimmed, priceState.meta.products, 5);
  const merged = [...similar];
  candidates.forEach(name => { if (!merged.includes(name)) merged.push(name); });
  priceState.compare.productKey = null;
  priceState.compare.productName = null;
  priceState.compare.brandKey = null;
  priceState.compare.entries = [];
  priceState.compare.candidates = merged.slice(0, 8);
  renderPriceCompareResults();
}

window.selectPriceCompareCandidate = function(index) {
  const productName = priceState.compare.candidates[index];
  if (!productName) return;
  hidePriceCompareSuggestions();
  const input = document.getElementById("price-compare-search");
  if (input) input.value = productName;
  priceState.compare.query = productName;
  rememberCompareProduct(productName);
  runPriceCompareSearch(productName);
};

async function loadPriceComparison(productKey, productName = null) {
  priceState.compare.loading = true;
  priceState.compare.productKey = productKey;
  if (productName) priceState.compare.productName = productName;
  // Il filtro marca del prodotto precedente non ha senso per quello nuovo.
  priceState.compare.brandKey = null;
  renderPriceCompareResults();
  try {
    const entries = await getCachedPriceEntries(productKey);
    // Una nuova ricerca può essere partita mentre la query era in volo: il
    // risultato va applicato solo se è ancora il prodotto corrente.
    if (priceState.compare.productKey !== productKey) return;
    priceState.compare.entries = entries;
  } catch (error) {
    if (priceState.compare.productKey !== productKey) return;
    console.error(error);
    showToast("Impossibile caricare i prezzi del prodotto", true);
  }
  priceState.compare.loading = false;
  renderPriceCompareResults();
}

// Indice nella lista marche del prodotto corrente, oppure "all".
window.selectPriceBrand = function(selection) {
  if (selection === "all") {
    priceState.compare.brandKey = null;
  } else {
    const brand = priceState.compare.brandChips[Number(selection)];
    if (!brand) return;
    priceState.compare.brandKey = brand[0];
  }
  renderPriceCompareResults();
};

function priceCompareFilteredEntries() {
  const { entries, brandKey } = priceState.compare;
  return brandKey ? entries.filter(entry => entry.brandKey === brandKey) : entries;
}

function renderPriceCompareResults() {
  const results = document.getElementById("price-compare-results");
  if (!results || !window.PriceDomain) return;
  const { productKey, entries, candidates, loading } = priceState.compare;

  if (!productKey) {
    if (candidates.length) {
      results.innerHTML = `<div class="prices-card"><label class="prices-label">Prodotti simili</label><div class="price-filter-pills">${candidates.map((candidate, index) => `<button class="price-filter-pill" onclick="selectPriceCompareCandidate(${index})">${escapeHtml(candidate)}</button>`).join("")}</div></div>`;
      return;
    }
    const typed = String(priceState.compare.query || "").trim();
    const quickPicks = getCompareQuickPicks();
    priceState.compare.quickPicks = quickPicks;
    results.innerHTML = `
      <div class="empty-state">
        <span>${typed ? "🤔" : "🔍"}</span>
        <h3>${typed ? "Nessun prodotto trovato" : "Cerca un prodotto"}</h3>
        <p>${typed
          ? `Nessuna corrispondenza per «${escapeHtml(typed)}»: prova con una parte del nome (es. «latte»).`
          : "Scrivi il nome di un prodotto registrato per scoprire in quale negozio conviene acquistarlo."}</p>
      </div>
      ${quickPicks.length ? `
        <section class="prices-card price-quick-card">
          <label class="prices-label">Un tocco e via</label>
          <div class="price-filter-pills">${quickPicks.map((name, index) => `<button class="price-filter-pill" onclick="selectPriceQuickPick(${index})">${escapeHtml(name)}</button>`).join("")}</div>
        </section>` : ""}`;
    return;
  }
  if (loading) {
    results.innerHTML = `<div class="empty-state"><div class="loading-spinner"></div><p>Caricamento prezzi…</p></div>`;
    return;
  }
  if (!entries.length) {
    results.innerHTML = `<div class="empty-state"><span>📭</span><h3>Nessun prezzo registrato</h3><p>Questo prodotto non è ancora presente nel database condiviso.</p></div>`;
    return;
  }

  const brands = [...new Map(entries.map(entry => [entry.brandKey, entry.brand])).entries()];
  priceState.compare.brandChips = brands;
  if (priceState.compare.brandKey && !brands.some(([key]) => key === priceState.compare.brandKey)) {
    priceState.compare.brandKey = null;
  }
  const filtered = priceCompareFilteredEntries();
  const { best, others } = PriceDomain.compareStores(filtered);
  const stats = PriceDomain.priceStats(filtered);
  if (!best) {
    results.innerHTML = `<div class="empty-state"><span>📭</span><p>Nessun prezzo confrontabile per questa marca.</p></div>`;
    return;
  }

  const brandChips = brands.length > 1
    ? `<div class="price-filter-pills">
        <button class="price-filter-pill ${!priceState.compare.brandKey ? "active" : ""}" onclick="selectPriceBrand('all')">Tutte le marche</button>
        ${brands.map(([key, name], index) => `<button class="price-filter-pill ${priceState.compare.brandKey === key ? "active" : ""}" onclick="selectPriceBrand(${index})">${escapeHtml(name)}</button>`).join("")}
      </div>`
    : "";

  const optionRow = (item, isBest) => {
    const delta = best.normPrice > 0 ? Math.round(((item.normPrice - best.normPrice) / best.normPrice) * 100) : 0;
    return `
      <div class="price-compare-row ${isBest ? "best" : ""}">
        <div class="price-compare-store">
          <strong>${escapeHtml(item.store)}</strong>
          <small>${escapeHtml(item.brand)} · ${escapeHtml(PriceDomain.formatItalianDate(item.date))}${item.createdByUsername ? ` · di ${escapeHtml(item.createdByUsername)}` : ""}</small>
        </div>
        <div class="price-compare-values">
          <strong>${escapeHtml(PriceDomain.formatNormPrice(item))}</strong>
          <small>${escapeHtml(PriceDomain.formatEuro(item.price))} × ${escapeHtml(String(item.weight))} ${escapeHtml(item.unit)}${!isBest && delta > 0 ? ` · +${delta}%` : ""}</small>
        </div>
      </div>`;
  };

  results.innerHTML = `
    ${brandChips}
    <div class="price-winner-card">
      <small>Conviene da</small>
      <h2>${escapeHtml(best.store)}</h2>
      <div class="price-winner-value">${escapeHtml(PriceDomain.formatNormPrice(best))}</div>
      <small>${escapeHtml(PriceDomain.formatEuro(best.price))} per ${escapeHtml(String(best.weight))} ${escapeHtml(best.unit)} · ${escapeHtml(PriceDomain.formatItalianDate(best.date))}</small>
    </div>
    ${others.length ? `<section class="prices-card"><label class="prices-label">Altri negozi (ultimo prezzo)</label>${others.map(item => optionRow(item, false)).join("")}</section>` : ""}
    ${stats ? `<p class="text-muted price-history-hint">Storico condiviso: ${stats.count} registr. · min ${escapeHtml(PriceDomain.formatEuro(stats.min))} · media ${escapeHtml(PriceDomain.formatEuro(stats.avg))} · max ${escapeHtml(PriceDomain.formatEuro(stats.max))}</p>` : ""}
    <details class="prices-card price-history-details">
      <summary>Storico completo (${entries.length})</summary>
      ${PriceDomain.sortEntriesDesc(filtered).slice(0, 30).map(item => `
        <div class="price-compare-row">
          <div class="price-compare-store"><strong>${escapeHtml(item.store)}</strong><small>${escapeHtml(item.brand)} · ${escapeHtml(PriceDomain.formatItalianDate(item.date))}${item.isWeightEstimated ? " · qtà stimata" : ""}</small></div>
          <div class="price-compare-values"><strong>${escapeHtml(PriceDomain.formatNormPrice(item))}</strong><small>${escapeHtml(PriceDomain.formatEuro(item.price))} × ${escapeHtml(String(item.weight))} ${escapeHtml(item.unit)}</small></div>
        </div>`).join("")}
    </details>
  `;
}

function renderPriceCompareTab() {
  const query = priceState.compare.query;
  const clearVisible = Boolean(String(query || "").trim() || priceState.compare.productKey);
  return `
    <section class="prices-card">
      <label class="prices-label" for="price-compare-search">Prodotto</label>
      <div class="price-compare-input-wrap">
        <input id="price-compare-search" placeholder="Es. latte, pasta, uova…" autocomplete="off" enterkeyhint="search"
          value="${escapeAttr(query)}"
          oninput="priceCompareInput(this.value)"
          onkeydown="priceCompareKeydown(event)"
          onfocus="priceCompareFocus(this)"
          onblur="priceCompareBlur()">
        <button type="button" id="price-compare-clear" class="price-compare-clear ${clearVisible ? "" : "hidden"}"
          aria-label="Cancella ricerca" title="Cancella ricerca" onclick="clearPriceCompareSearch()">×</button>
        <div id="price-compare-suggest" class="price-compare-suggest hidden" role="listbox" aria-label="Suggerimenti prodotto"></div>
      </div>
      <p class="text-muted price-save-note">Digita il nome: i suggerimenti compaiono mentre scrivi. Tocca un prodotto per confrontare i negozi.</p>
    </section>
    <div id="price-compare-results"></div>
  `;
}

// ---- Selezione prodotto: suggerimenti live + prodotti recenti ----
// Campo di ricerca con menu a discesa proprio (le datalist native si
// comportano in modo diverso su ogni browser mobile). Nessuna chiamata
// Firebase: i suggerimenti nascono dalla rubrica già in memoria e i "recenti"
// da localStorage + archivio già caricato.

const PRICE_COMPARE_RECENTS_KEY = "pn_price_compare_recent";
let priceCompareSuggestionNames = [];
let priceCompareSuggestActive = -1;

function readCompareRecents() {
  try {
    const list = JSON.parse(localStorage.getItem(PRICE_COMPARE_RECENTS_KEY) || "[]");
    return Array.isArray(list) ? list.filter(name => typeof name === "string" && name.trim()) : [];
  } catch (_) { return []; }
}

function rememberCompareProduct(name) {
  const clean = String(name || "").trim();
  if (!clean || !window.PriceDomain) return;
  const list = readCompareRecents().filter(item => PriceDomain.priceKey(item) !== PriceDomain.priceKey(clean));
  list.unshift(clean);
  try { localStorage.setItem(PRICE_COMPARE_RECENTS_KEY, JSON.stringify(list.slice(0, 8))); } catch (_) {}
}

// Prodotti a un tocco: i recenti (confrontati di recente) e gli ultimi
// registrati in archivio, deduplicati e ancora presenti nella rubrica.
function getCompareQuickPicks() {
  if (!window.PriceDomain) return [];
  const picks = [];
  const seen = new Set();
  const known = priceState.meta.products.length
    ? new Set(priceState.meta.products.map(name => PriceDomain.priceKey(name)))
    : null;
  [...readCompareRecents(), ...priceState.archive.entries.map(entry => entry.product)].forEach(name => {
    const clean = String(name || "").trim();
    const key = PriceDomain.priceKey(clean);
    if (!key || seen.has(key)) return;
    if (known && !known.has(key)) return;
    seen.add(key);
    picks.push(clean);
  });
  return picks.slice(0, 8);
}

// Corrispondenze per il menu: prima il match esatto, poi i prodotti con
// parole in comune (simili), poi quelli che contengono il testo digitato.
function priceCompareSuggestionList(query) {
  if (!window.PriceDomain) return [];
  const trimmed = String(query || "").trim();
  if (!trimmed) return getCompareQuickPicks();
  const { exact, candidates } = PriceDomain.matchProducts(trimmed, priceState.meta.products);
  const similar = PriceDomain.similarProducts(trimmed, priceState.meta.products, 5);
  const merged = [];
  const seen = new Set();
  [exact, ...similar, ...candidates].forEach(name => {
    if (!name) return;
    const key = PriceDomain.priceKey(name);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(name);
  });
  return merged.slice(0, 8);
}

function renderPriceCompareSuggestions(query) {
  const box = document.getElementById("price-compare-suggest");
  if (!box) return;
  const list = priceCompareSuggestionList(query);
  priceCompareSuggestionNames = list;
  priceCompareSuggestActive = -1;
  const trimmed = String(query || "").trim();
  if (!trimmed && !list.length) {
    hidePriceCompareSuggestions();
    return;
  }
  if (trimmed && !list.length) {
    box.innerHTML = `<div class="price-compare-suggest-empty">Nessun prodotto per «${escapeHtml(trimmed)}»</div>`;
    box.classList.remove("hidden");
    return;
  }
  box.innerHTML = `
    <div class="price-compare-suggest-label">${trimmed ? "Prodotti" : "Recenti"}</div>
    ${list.map((name, index) => `<button type="button" class="price-compare-suggest-item" role="option" data-idx="${index}" onmousedown="event.preventDefault()" onclick="selectPriceSuggestion(${index})">${escapeHtml(name)}</button>`).join("")}`;
  box.classList.remove("hidden");
}

function hidePriceCompareSuggestions() {
  const box = document.getElementById("price-compare-suggest");
  priceCompareSuggestActive = -1;
  if (!box) return;
  box.classList.add("hidden");
  box.innerHTML = "";
}

function updatePriceSuggestActive() {
  document.querySelectorAll(".price-compare-suggest-item").forEach(item => {
    const active = Number(item.dataset?.idx) === priceCompareSuggestActive;
    item.classList.toggle("active", active);
    if (active && typeof item.scrollIntoView === "function") item.scrollIntoView({ block: "nearest" });
  });
}

window.priceCompareFocus = function(input) {
  renderPriceCompareSuggestions(input?.value || "");
};

window.priceCompareBlur = function() {
  // Un attimo di ritardo: il click su un suggerimento deve fare in tempo a
  // partire prima che il menu scompaia insieme al focus.
  setTimeout(hidePriceCompareSuggestions, 180);
};

window.priceCompareKeydown = function(event) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!priceCompareSuggestionNames.length) return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    priceCompareSuggestActive = (priceCompareSuggestActive + delta + priceCompareSuggestionNames.length) % priceCompareSuggestionNames.length;
    updatePriceSuggestActive();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const index = priceCompareSuggestActive >= 0 ? priceCompareSuggestActive : 0;
    if (priceCompareSuggestionNames.length) {
      selectPriceSuggestion(index);
    } else {
      runPriceCompareSearch(event.target?.value || priceState.compare.query);
    }
    return;
  }
  if (event.key === "Escape") hidePriceCompareSuggestions();
};

window.selectPriceSuggestion = function(index) {
  const name = priceCompareSuggestionNames[index];
  if (!name) return;
  hidePriceCompareSuggestions();
  const input = document.getElementById("price-compare-search");
  if (input) input.value = name;
  priceState.compare.query = name;
  rememberCompareProduct(name);
  runPriceCompareSearch(name);
};

window.selectPriceQuickPick = function(index) {
  const name = priceState.compare.quickPicks[index];
  if (!name) return;
  const input = document.getElementById("price-compare-search");
  if (input) input.value = name;
  priceState.compare.query = name;
  rememberCompareProduct(name);
  runPriceCompareSearch(name);
};

window.clearPriceCompareSearch = function() {
  const input = document.getElementById("price-compare-search");
  if (input) { input.value = ""; input.focus(); }
  priceState.compare.query = "";
  priceState.compare.productKey = null;
  priceState.compare.productName = null;
  priceState.compare.brandKey = null;
  priceState.compare.entries = [];
  priceState.compare.candidates = [];
  renderPriceCompareResults();
  renderPriceCompareSuggestions("");
};

// ---- Pagina negozio ----

function renderPriceStoresTab() {
  const state = priceState.stores;
  if (state.view === "detail") return renderStoreDetail();
  const stores = priceState.meta.stores;
  if (!stores.length) {
    return `<div class="empty-state"><span>🏪</span><h3>Nessun negozio registrato</h3><p>Quando qualcuno registra un prezzo, il negozio compare qui con tutti i suoi prodotti.</p></div>`;
  }
  return `
    <div class="store-list">
      ${stores.map((store, index) => `
        <button class="store-card" onclick="openStoreDetail(${index})">
          <span class="store-card-icon">🏪</span>
          <span class="store-card-info"><strong>${escapeHtml(store)}</strong><small>Prezzi registrati e confronto con gli altri negozi</small></span>
          <b class="store-card-arrow">›</b>
        </button>`).join("")}
    </div>
    <p class="text-muted price-save-note">La pagina negozio mostra l'ultimo prezzo registrato per ogni prodotto e indica dove quel prodotto costa meno.</p>
  `;
}

window.closeStoreDetail = function() {
  priceState.stores = { view: "list", storeKey: null, storeName: "", loading: false, rows: [], summary: null };
  renderPrices();
};

window.openStoreDetail = async function(indexOrKey, optionalName) {
  if (!window.PriceDomain) return;
  // Accetta l'indice nell'elenco negozi (click utente) oppure la coppia
  // chiave+nome usata internamente dal refresh manuale.
  let storeKey = optionalName !== undefined ? indexOrKey : null;
  let storeName = optionalName !== undefined ? optionalName : null;
  if (storeKey === null) {
    const store = priceState.meta.stores[Number(indexOrKey)];
    if (!store) return;
    storeKey = PriceDomain.priceKey(store);
    storeName = store;
  }
  priceState.stores = { view: "detail", storeKey, storeName, loading: true, rows: [], summary: null };
  renderPrices();
  // Se l'utente torna indietro mentre i dati sono in volo, i risultati non
  // devono riaprire la pagina negozio chiusa.
  const stillActive = () => priceState.stores.view === "detail" && priceState.stores.storeKey === storeKey;
  let storeEntries;
  try {
    storeEntries = await getCachedPriceEntriesForStore(storeKey);
  } catch (error) {
    console.error(error);
    if (!stillActive()) return;
    showToast("Prezzi del negozio non disponibili", true);
    closeStoreDetail();
    return;
  }
  if (!stillActive()) return;
  // Ultimo prezzo registrato per ogni prodotto del negozio.
  const latestByProduct = new Map();
  PriceDomain.sortEntriesDesc(storeEntries).forEach(entry => {
    if (!latestByProduct.has(entry.productKey)) latestByProduct.set(entry.productKey, entry);
  });
  const rows = [...latestByProduct.values()].map(entry => ({ entry, status: "loading", best: null, deltaPct: null, options: 0 }));
  priceState.stores.rows = rows;
  priceState.stores.loading = false;
  renderPrices();
  if (!rows.length) return;

  // Per ogni prodotto, una query (in cache se già usata) posiziona il
  // negozio rispetto agli altri: migliore, peggiore o unico venditore.
  await Promise.all(rows.map(async row => {
    try {
      const productEntries = await getCachedPriceEntries(row.entry.productKey);
      const { best, others } = PriceDomain.compareStores(productEntries);
      row.options = (best ? 1 : 0) + others.length;
      row.best = best;
      const storeIsBest = best && best.storeKey === storeKey;
      row.status = row.options <= 1 ? "only" : storeIsBest ? "best" : "worse";
      row.deltaPct = !storeIsBest && best && best.normPrice > 0
        ? Math.round(((row.entry.normPrice - best.normPrice) / best.normPrice) * 100)
        : null;
    } catch (error) {
      console.warn("Confronto prodotto non disponibile", error);
      row.status = "unknown";
    }
  }));
  if (!stillActive()) return;
  const compared = rows.filter(row => row.options > 1).length;
  priceState.stores.summary = {
    total: rows.length,
    compared,
    bestCount: rows.filter(row => row.status === "best").length
  };
  renderPrices();
};

function storeDetailBadgeHtml(row) {
  const { status, best, deltaPct } = row;
  if (status === "best") return `<span class="store-status-badge best">🏆 Miglior prezzo</span>`;
  if (status === "worse") return `<span class="store-status-badge worse">+${deltaPct ?? "?"}% vs ${escapeHtml(best?.store || "migliore")}</span>`;
  if (status === "only") return `<span class="store-status-badge only">Solo qui</span>`;
  if (status === "loading") return `<span class="store-status-badge">…</span>`;
  return "";
}

function renderStoreDetail() {
  const { storeName, loading, rows, summary } = priceState.stores;
  return `
    <div class="store-detail-title-row">
      <button class="btn-icon store-back-btn" onclick="closeStoreDetail()" title="Torna ai negozi" aria-label="Torna ai negozi">←</button>
      <div><p class="eyebrow">Pagina negozio</p><h1>${escapeHtml(storeName)}</h1><p class="text-muted">Ultimo prezzo registrato per prodotto, con il confronto con gli altri negozi.</p></div>
    </div>
    ${summary ? `<div class="shopping-summary"><strong>🏆 Miglior prezzo per ${summary.bestCount} prodott${summary.bestCount === 1 ? "o" : "i"}</strong><span>${summary.compared} confrontabili su ${summary.total}</span></div>` : ""}
    ${loading ? `<div class="empty-state"><div class="loading-spinner"></div><p>Caricamento prezzi del negozio…</p></div>` : ""}
    ${rows.length ? rows.map(row => `
      <div class="store-detail-row">
        <div class="price-archive-info"><strong>${escapeHtml(row.entry.product)}</strong><small>${escapeHtml(row.entry.brand)} · ${escapeHtml(PriceDomain.formatItalianDate(row.entry.date))}${row.entry.isWeightEstimated ? " · qtà stimata" : ""}</small></div>
        <div class="price-archive-values"><strong>${escapeHtml(PriceDomain.formatNormPrice(row.entry))}</strong><small>${escapeHtml(PriceDomain.formatEuro(row.entry.price))} × ${escapeHtml(String(row.entry.weight))} ${escapeHtml(row.entry.unit)}</small></div>
        <div class="store-detail-badge">${storeDetailBadgeHtml(row)}</div>
      </div>`).join("") : (!loading ? `<div class="empty-state"><span>🏪</span><p>Nessun prezzo registrato in questo negozio.</p></div>` : "")}
  `;
}

// ---- Archivio condiviso ----

// L'elenco già caricato viene mostrato SUBITO a ogni ingresso nella scheda (il
// contenitore viene ricreato vuoto a ogni render). Se i dati sono freschi non
// si rilancia nessuna query; se sono stantii si fa un aggiornamento in fondo
// senza mai svuotare l'elenco (stale-while-revalidate).
async function loadPriceArchive(force = false) {
  const now = Date.now();
  if (!force && priceState.archive.loadedAt && now - priceState.archive.loadedAt < PRICE_ARCHIVE_TTL_MS) {
    renderPriceArchiveList();
    return;
  }
  if (priceState.archive.loading) return; // un aggiornamento è già in volo
  priceState.archive.loading = true;
  priceState.archive.error = false;
  renderPriceArchiveList();
  try {
    priceState.archive.entries = await getRecentPriceEntries(PRICE_ARCHIVE_LIMIT);
    priceState.archive.loadedAt = Date.now();
  } catch (error) {
    console.error(error);
    priceState.archive.error = true;
    showToast(priceState.archive.entries.length
      ? "Archivio non aggiornato: mostro l'ultima versione caricata"
      : "Archivio non caricato: controlla la connessione", true);
  }
  priceState.archive.loading = false;
  renderPriceArchiveList();
}

// Indice nell'elenco negozi presenti in archivio, oppure "all".
window.filterPriceArchive = function(selection) {
  if (selection === "all") {
    priceState.archive.storeFilter = null;
  } else {
    const store = priceState.archive.storeChips[Number(selection)];
    if (!store) return;
    priceState.archive.storeFilter = store[0];
  }
  renderPriceArchiveList();
};

function renderPriceArchiveTab() {
  return `
    <div class="prices-actions-row">
      <label class="btn btn-outline price-action-btn file-import-button">⬆️ Importa backup<input type="file" accept="application/json,.json" style="display:none" onchange="preparePriceBackupImport(this)"></label>
      <button class="btn btn-outline price-action-btn" onclick="exportPriceBackup()">⬇️ Esporta</button>
    </div>
    <div id="price-archive-content"></div>
    <p class="text-muted price-save-note">L'archivio mostra le ultime ${PRICE_ARCHIVE_LIMIT} registrazioni di tutti gli utenti. Puoi modificare o eliminare solo le tue voci.</p>
  `;
}

function renderPriceArchiveList() {
  const container = document.getElementById("price-archive-content");
  if (!container || !window.PriceDomain) return;
  const { entries, storeFilter, loading } = priceState.archive;

  if (loading && !entries.length) {
    container.innerHTML = `<div class="empty-state"><div class="loading-spinner"></div><p>Caricamento archivio…</p></div>`;
    return;
  }
  if (!entries.length) {
    container.innerHTML = priceState.archive.error
      ? `<div class="empty-state"><span>📡</span><h3>Archivio non raggiungibile</h3><p>Controlla la connessione e riprova con il pulsante Aggiorna.</p></div>`
      : `<div class="empty-state"><span>🛒</span><h3>Archivio vuoto</h3><p>Nessuno ha ancora registrato prezzi: inizia tu dalla scheda Registra.</p></div>`;
    return;
  }

  const stores = [...new Map(entries.map(entry => [entry.storeKey, entry.store])).entries()];
  priceState.archive.storeChips = stores;
  if (storeFilter && !stores.some(([key]) => key === storeFilter)) {
    priceState.archive.storeFilter = null;
  }
  const filtered = priceState.archive.storeFilter ? entries.filter(entry => entry.storeKey === priceState.archive.storeFilter) : entries;
  const ownUid = appState.user?.uid;

  container.innerHTML = `
    <div class="price-filter-pills">
      <button class="price-filter-pill ${!priceState.archive.storeFilter ? "active" : ""}" onclick="filterPriceArchive('all')">Tutti i negozi</button>
      ${stores.map(([key, name], index) => `<button class="price-filter-pill ${priceState.archive.storeFilter === key ? "active" : ""}" onclick="filterPriceArchive(${index})">${escapeHtml(name)}</button>`).join("")}
    </div>
    ${loading ? `<p class="text-muted price-history-hint">Aggiornamento archivio…</p>` : ""}
    ${filtered.map(entry => {
      const own = entry.createdBy && entry.createdBy === ownUid;
      return `
        <div class="price-archive-row">
          <div class="price-archive-info">
            <strong>${escapeHtml(entry.product)}</strong>
            <small>${escapeHtml(entry.brand)} · ${escapeHtml(entry.store)} · ${escapeHtml(PriceDomain.formatItalianDate(entry.date))}${entry.createdByUsername ? ` · di ${escapeHtml(entry.createdByUsername)}` : ""}${entry.isWeightEstimated ? " · qtà stimata" : ""}</small>
          </div>
          <div class="price-archive-values">
            <strong>${escapeHtml(PriceDomain.formatEuro(entry.price))}</strong>
            <small>${escapeHtml(String(entry.weight))} ${escapeHtml(entry.unit)} → ${escapeHtml(PriceDomain.formatNormPrice(entry))}</small>
          </div>
          ${own ? `<div class="price-archive-actions"><button class="btn-icon" title="Modifica" aria-label="Modifica" onclick="startPriceEdit('${escapeAttr(entry.id)}')">✎</button><button class="btn-icon price-delete-icon" title="Elimina" aria-label="Elimina" onclick="deletePriceEntryClick('${escapeAttr(entry.id)}')">×</button></div>` : ""}
        </div>`;
    }).join("")}
  `;
}

// ---- Backup prezzi: importazione e esportazione ----

let pendingPriceImport = null;

window.preparePriceBackupImport = async function(input) {
  const file = input?.files?.[0];
  if (input) input.value = "";
  if (!file || !window.PriceDomain) return;
  try {
    const parsed = JSON.parse(await file.text());
    const { entries, skipped } = PriceDomain.preparePriceImport(parsed);
    if (!entries.length) throw new Error("Il file non contiene prezzi validi");
    pendingPriceImport = { entries, skipped, filename: file.name };
    const stores = [...new Set(entries.map(entry => entry.store))];
    const dates = entries.map(entry => entry.date).sort();
    document.getElementById("price-import-file-name").textContent = file.name;
    document.getElementById("price-import-count").textContent = `${entries.length} prezzi pronti`;
    document.getElementById("price-import-summary").textContent =
      `Negozi: ${stores.join(", ")} · dal ${PriceDomain.formatItalianDate(dates[0])} al ${PriceDomain.formatItalianDate(dates[dates.length - 1])}.` +
      (skipped ? ` ${skipped} righe scartate perché non valide o duplicate.` : "") +
      " Le voci già importate in precedenza verranno riconosciute e saltate.";
    document.getElementById("price-import-modal").classList.remove("hidden");
  } catch (error) {
    console.error(error);
    showToast(error.message || "File di backup non valido", true);
  }
};

window.closePriceImportModal = function() {
  pendingPriceImport = null;
  document.getElementById("price-import-modal")?.classList.add("hidden");
};

window.applyPriceBackupImport = async function() {
  if (!pendingPriceImport) return;
  const { entries } = pendingPriceImport;
  setLoading(`Importazione di ${entries.length} prezzi…`);
  try {
    const result = await savePriceImport(entries, priceUserMeta());
    closePriceImportModal();
    invalidatePriceEntriesCache();
    priceState.archive.loadedAt = 0;
    priceState.archive.error = false;
    priceState.history = { key: null, entries: [], loading: false };
    priceState.compare.productKey = null;
    priceState.compare.entries = [];
    priceState.compare.candidates = [];
    priceState.compare.brandKey = null;
    renderPrices();
    showToast(`✅ Importati ${result.imported} prezzi${result.skippedDuplicates ? ` (${result.skippedDuplicates} già presenti)` : ""}`);
  } catch (error) {
    console.error(error);
    showToast("Importazione non riuscita: controlla la connessione", true);
  } finally {
    clearLoading();
  }
};

window.exportPriceBackup = async function() {
  await loadPriceArchive(true);
  const entries = priceState.archive.entries;
  if (!entries.length) {
    showToast("Nessun prezzo da esportare", true);
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  downloadJsonFile(`prezzi-backup-${date}.json`, {
    format: "piano-nutrizionale-prices",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: usernameFromUser(appState.user),
    note: `Ultime ${entries.length} registrazioni del database condiviso`,
    entries
  });
  showToast(`${entries.length} prezzi esportati`);
};

// ---- Barcode: fotocamera, foto o digitazione manuale ----
// Il lettore è caricato in lazy: non al boot, ma al primo bisogno (apertura
// della modale di scansione). Con la sezione Prezzi nascosta nessuno dovrebbe
// spendere ~110 KB di libreria CDN all'avvio; sw.js precarica comunque
// l'URL versionato in cache per chi usa lo scanner anche offline.

let html5QrcodePromise = null;
function loadHtml5Qrcode() {
  if (typeof Html5Qrcode !== "undefined") return Promise.resolve();
  if (!html5QrcodePromise) {
    html5QrcodePromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        html5QrcodePromise = null;
        reject(new Error("Lettore barcode non disponibile"));
      };
      document.head.appendChild(script);
    });
  }
  return html5QrcodePromise;
}

function setupPriceModals() {
  if (document.getElementById("price-scan-modal")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="price-scan-modal" class="modal hidden" role="dialog" aria-modal="true">
      <div class="modal-content price-scan-content">
        <div class="modal-header"><div><p class="eyebrow">BARCODE</p><h2>Scansiona un prodotto</h2></div><button class="btn-icon" onclick="closePriceScanModal()">&times;</button></div>
        <div id="price-scan-region" class="price-scan-region"></div>
        <div class="price-scan-actions">
          <button class="btn btn-primary" onclick="startPriceCameraScan()">📷 Fotocamera</button>
          <label class="btn btn-outline file-import-button">🖼 Da foto<input type="file" accept="image/*" capture="environment" style="display:none" onchange="scanPriceFromPhoto(this); this.value=''"></label>
        </div>
        <label class="prices-label" for="price-barcode-manual">Oppure digita il codice a barre</label>
        <div class="price-barcode-manual-row">
          <input id="price-barcode-manual" inputmode="numeric" enterkeyhint="search" placeholder="es. 8000500310403"
            onkeydown="priceBarcodeKeydown(event)">
          <button class="btn btn-outline" onclick="lookupPriceBarcodeManual()">Cerca</button>
        </div>
        <p class="text-muted price-save-note">Nome e marca arrivano da Open Food Facts / Beauty Facts / Products Facts.</p>
      </div>
    </div>
    <div id="price-import-modal" class="modal hidden" role="dialog" aria-modal="true">
      <div class="modal-content transfer-modal-content">
        <div class="modal-header"><div><p class="eyebrow">IMPORTAZIONE PREZZI</p><h2>Backup da caricare</h2></div><button class="btn-icon" onclick="closePriceImportModal()">&times;</button></div>
        <div class="transfer-summary"><strong id="price-import-file-name"></strong><span id="price-import-count"></span><p id="price-import-summary"></p></div>
        <p class="text-muted transfer-privacy-note">Le voci entrano nel database condiviso visibile a tutti gli utenti. L'autore risulti tu: potrai modificarle o eliminarle.</p>
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="closePriceImportModal()">Annulla</button>
          <button class="btn btn-primary" onclick="applyPriceBackupImport()">Conferma e importa</button>
        </div>
      </div>
    </div>`);
  bindModalOutsideClose("price-scan-modal", () => window.closePriceScanModal());
  bindModalOutsideClose("price-import-modal", () => window.closePriceImportModal());
}

window.openPriceScanModal = function() {
  document.getElementById("price-scan-modal")?.classList.remove("hidden");
  // Precarica il lettore in background: al momento del tasto Fotocamera
  // (o dell'analisi di una foto) sarà già disponibile nella maggior parte
  // dei casi; se fallisce, la ricerca manuale resta utilizzabile.
  loadHtml5Qrcode().catch(() => {});
};

async function stopPriceScanner() {
  if (!priceScanner) return;
  try { await priceScanner.stop(); } catch (_) {}
  try { priceScanner.clear(); } catch (_) {}
  priceScanner = null;
}

window.closePriceScanModal = async function() {
  await stopPriceScanner();
  document.getElementById("price-scan-modal")?.classList.add("hidden");
};

function priceScannerAvailable() {
  if (typeof Html5Qrcode === "undefined") {
    showToast("Lettore barcode non caricato: usa la ricerca manuale o riprova online", true);
    return false;
  }
  return true;
}

window.startPriceCameraScan = async function() {
  await loadHtml5Qrcode().catch(() => {});
  if (!priceScannerAvailable()) return;
  await stopPriceScanner();
  const region = document.getElementById("price-scan-region");
  region.innerHTML = "";
  // Il riquadro di scansione non deve superare la larghezza del video: su
  // schermi stretti un qrbox fisso di 260px rende la lettura impossibile.
  const scanWidth = Math.max(180, Math.min(260, Math.floor((region.clientWidth || 300) * 0.85)));
  const scanHeight = Math.round(scanWidth * 0.62);
  priceScanner = new Html5Qrcode("price-scan-region");
  try {
    await priceScanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: scanWidth, height: scanHeight } },
      async code => {
        await stopPriceScanner();
        closePriceScanModal();
        handlePriceBarcode(code);
      },
      () => {}
    );
  } catch (error) {
    console.warn("Fotocamera non disponibile", error);
    showToast("Fotocamera non disponibile: scatta una foto o digita il codice", true);
  }
};

window.scanPriceFromPhoto = async function(input) {
  const file = input?.files?.[0];
  if (!file) return;
  await loadHtml5Qrcode().catch(() => {});
  if (!priceScannerAvailable()) return;
  await stopPriceScanner();
  showToast("Analisi della foto…");
  try {
    const scanner = new Html5Qrcode("price-scan-region");
    const code = await scanner.scanFile(file, false);
    closePriceScanModal();
    handlePriceBarcode(code);
  } catch (_) {
    showToast("Barcode non riconosciuto nella foto", true);
  }
};

window.lookupPriceBarcodeManual = function() {
  const code = (document.getElementById("price-barcode-manual")?.value || "").trim();
  if (!code) {
    showToast("Inserisci il codice a barre", true);
    return;
  }
  closePriceScanModal();
  handlePriceBarcode(code);
};

// Invio nel campo barcode manuale = Cerca (il tasto "vai" della tastiera
// mobile non deve costringere a un tap in più sul pulsante).
window.priceBarcodeKeydown = function(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  lookupPriceBarcodeManual();
};

async function lookupOpenFacts(barcode) {
  const databases = ["food", "beauty", "products"];
  for (const name of databases) {
    try {
      // Timeout esplicito: su rete lenta tre fetch appese bloccerebbero la
      // ricerca del prodotto per decine di secondi.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(`https://world.open${name}facts.org/api/v2/product/${encodeURIComponent(barcode)}.json`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) continue;
      const data = await response.json();
      if (data?.status === 1 && data.product) return data.product;
    } catch (_) { /* prova il database successivo */ }
  }
  return null;
}

async function handlePriceBarcode(barcode) {
  setLoading("Ricerca del prodotto…");
  try {
    const product = await lookupOpenFacts(barcode);
    if (!product) {
      showToast("Prodotto non trovato nei database aperti", true);
      return;
    }
    const name = product.product_name_it || product.product_name || "";
    const brand = String(product.brands || "").split(",")[0].trim();
    if (name) document.getElementById("price-product").value = name;
    if (brand) document.getElementById("price-brand").value = brand;
    // Se Open Food Facts restituisce un nome lungo ma in archivio esiste già
    // il nome semplice ("Cereali di grano duro" → "Cereali"), il menu dei
    // suggerimenti si apre da solo: mantenere un unico nome per prodotto è
    // ciò che fa funzionare i confronti.
    if (name) renderPriceFieldSuggestions("product", name, { skipExact: true });
    // Se Open Food Facts indica la confezione (es. "500 g"), precostruisce la quantità.
    const quantity = window.PriceDomain ? PriceDomain.parseWeightToken(product.quantity || "") : null;
    if (quantity) {
      const weightInput = document.getElementById("price-weight");
      if (weightInput) weightInput.value = String(quantity.weight);
      const unitButton = document.querySelector(`.price-unit-btn[data-unit="${quantity.unit}"]`);
      if (unitButton) setPriceUnit(quantity.unit);
    }
    priceState.draft.product = name;
    priceState.draft.brand = brand;
    showToast("✅ Prodotto trovato");
    schedulePricePreview(0);
  } catch (error) {
    console.error(error);
    showToast("Ricerca non riuscita", true);
  } finally {
    clearLoading();
  }
}

document.addEventListener("DOMContentLoaded", initApp);
