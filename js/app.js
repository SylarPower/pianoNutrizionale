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

let appState = {
  user: null,
  recipes: [],
  recipesById: {},
  plan: null,
  deviceSettings: null,
  shopping: null,
  household: null
};
let appStarted = false;
let currentModal = null;
let editMode = false;
let shopSettingsVisible = false;
let toastTimeout = null;
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

function getRecipeDisplayName(recipe, dayType = "training") {
  return recipe?.namesByDayType?.[dayType] || recipe?.name || "Ricetta non disponibile";
}

function getSlotMeta(slotId) {
  return MEAL_SLOTS.find(slot => slot.id === slotId) || { id: slotId, label: slotId, shortLabel: slotId, emoji: "🍽️" };
}

function getPortionProfile() {
  return appState.deviceSettings?.portionProfile || "man";
}

function getPortionValue(ingredient, profile, dayType) {
  const portions = ingredient?.portions || {};
  const isTraining = dayType === "training";
  if (profile === "ipo") {
    return portions[isTraining ? "ipoTraining" : "ipoRest"] ?? portions.ipo ?? "—";
  }
  return portions[isTraining ? "manTraining" : "manRest"] ?? portions[dayType] ?? portions.training ?? "—";
}

function isEmptyPortion(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return !normalized || normalized === "—" || normalized === "-";
}

function getIngredientDisplay(ingredient, dayType) {
  const profile = getPortionProfile();
  if (profile === "ipo") return getPortionValue(ingredient, "ipo", dayType);
  if (profile === "couple") {
    const man = getPortionValue(ingredient, "man", dayType);
    const woman = getPortionValue(ingredient, "ipo", dayType);
    if (isEmptyPortion(man) && isEmptyPortion(woman)) return "—";
    return `Uomo: ${man} · Donna IPO: ${woman}`;
  }
  return getPortionValue(ingredient, "man", dayType);
}

function getProfileLabel() {
  const profile = getPortionProfile();
  if (profile === "ipo") return "Donna · regime IPO";
  if (profile === "couple") return "Uomo + donna IPO";
  return "Uomo · dosi A/R";
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

function recipeIsCrossSlot(recipe, assignedSlot) {
  return Boolean(recipe && window.PianoDomain && assignedSlot && PianoDomain.isPranzoCenaCross(recipe.slot, assignedSlot));
}

function normalizeRecipeSchema(recipe) {
  // Schema 4: ingredientId stabile + porzioni normalizzate (supporto legacy).
  return window.PianoDomain ? PianoDomain.migrateRecipe(recipe) : clone(recipe);
}

function setRecipes(recipes) {
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
    getPortionProfile()
  );
  // Batch automatico "doppia porzione": stessa ricetta a cena e al pranzo
  // successivo (anche via cross-slot). Le dosi sono la somma cena + pranzo.
  const dinnerId = appState.plan.days[dayKey]?.dinner;
  const common = PianoDomain.commonRecipeBatch(dayKey, appState.plan, appState.recipesById, getPortionProfile());
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
  toast.textContent = message;
  toast.classList.toggle("toast-error", isError);
  toast.classList.remove("hidden");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.add("hidden"), 2800);
}

function setLoading(message = "Caricamento…") {
  const overlay = document.getElementById("loading-overlay");
  const text = document.getElementById("loading-message");
  if (text) text.textContent = message;
  overlay?.classList.remove("hidden");
}

function clearLoading() {
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

function applyTheme(isDark) {
  document.documentElement.classList.toggle("dark-mode", isDark);
  document.body.classList.toggle("dark-mode", isDark);

  const themeMeta = document.querySelector('meta[name="theme-color"]');

  if (themeMeta) {
    themeMeta.setAttribute(
      "content",
      isDark ? "#000000" : "#245A43"
    );
  }
}

function showLogin() {
  document.body.classList.add("auth-locked");
  document.getElementById("login-screen")?.classList.remove("hidden");
  document.getElementById("app-container")?.classList.add("hidden");
  document.querySelector(".bottom-nav")?.classList.add("hidden");
  document.getElementById("global-header-container")?.remove();
  clearLoading();
  setTimeout(() => document.getElementById("login-username")?.focus(), 50);
}

function showApp() {
  document.body.classList.remove("auth-locked");
  document.getElementById("login-screen")?.classList.add("hidden");
  document.getElementById("app-container")?.classList.remove("hidden");
  document.querySelector(".bottom-nav")?.classList.remove("hidden");
  // Anche l'avvio rapido da cache deve chiudere l'overlay: in quel percorso
  // loadUserData() è silenzioso e il suo finally non chiama clearLoading().
  clearLoading();
}

function mapLoginError(error) {
  if (error?.code === "auth/invalid-username" || error?.code === "auth/missing-password") return error.message;
  if (["auth/invalid-login-credentials", "auth/wrong-password", "auth/user-not-found", "auth/invalid-credential"].includes(error?.code)) {
    return "Username o password non corretti.";
  }
  if (error?.code === "auth/too-many-requests") return "Troppi tentativi. Attendi qualche minuto e riprova.";
  if (error?.code === "auth/network-request-failed") return "Connessione assente. Il primo accesso richiede internet.";
  return "Accesso non riuscito. Riprova tra poco.";
}

function setupLoginForm() {
  const form = document.getElementById("login-form");
  if (!form || form.dataset.ready) return;
  form.dataset.ready = "true";
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const username = document.getElementById("login-username").value;
    const password = document.getElementById("login-password").value;
    const button = document.getElementById("login-submit");
    const errorEl = document.getElementById("login-error");
    errorEl.textContent = "";
    button.disabled = true;
    button.textContent = "Accesso…";
    try {
      await signInWithUsername(username, password);
      document.getElementById("login-password").value = "";
    } catch (error) {
      errorEl.textContent = mapLoginError(error);
    } finally {
      button.disabled = false;
      button.textContent = "Accedi";
    }
  });
}

async function loadUserData(user, { silent = false } = {}) {
  appState.user = user;
  if (!silent) setLoading("Sincronizzazione del piano personale…");
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
    applyState(recipes, plan, shopping);
    writeSessionCache({
      uid: user.uid,
      email: user.email,
      householdId: appState.household?.id || null
    });
    ensureUsernameDirectory().catch(error => console.warn("Directory username non disponibile", error));
    if (appStarted) handleRoute();
  } catch (error) {
    console.error(error);
    if (silent) {
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

function applyState(recipes, plan, shopping) {
  // Migrazione schema 4 → 5: se il catalogo caricato contiene ancora il campo
  // legacy `frequency`, il catalogo normalizzato viene salvato una sola volta
  // per rimuoverlo definitivamente dai dati persistiti.
  const needsCatalogMigration = window.PianoDomain && PianoDomain.catalogHasLegacyFrequency(recipes);
  setRecipes(recipes);
  appState.plan = window.PianoDomain ? PianoDomain.migratePlan(plan) : plan;
  appState.shopping = shopping;
  appState.deviceSettings = getLocalDeviceSettings();
  if (needsCatalogMigration) {
    saveRecipeCatalog(appState.recipes).catch(error => console.warn("Migrazione schema 5: salvataggio catalogo non riuscito", error));
  }

  applyTheme(!!appState.deviceSettings.darkMode);
  showApp();
  renderGlobalHeader();
  document.querySelector(".bottom-nav")?.classList.remove("hidden");
  if (!appStarted) {
    setupRouter();
    setupModal();
    setupSwapModal();
    setupMealOperations();
    setupTransferModals();
    setupGeneratorModal();
    setupMellerModal();
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
  setupLoginForm();
  if (!initFirebase()) {
    document.getElementById("login-error").textContent = "Il servizio non è configurato correttamente.";
    showLogin();
    return;
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
    applyState(cachedRecipes, cachedPlan, cachedShopping || getDefaultShoppingList());
  } else {
    setLoading("Verifica accesso…");
  }

  observeAuthState(async user => {
    if (!user) {
      stopAccountRealtimeSync();
      clearDataScope();
      writeSessionCache(null);
      setLocalDataOwner(null);
      appState.user = null;
      appState.household = null;
      showLogin();
      return;
    }
    writeSessionCache({
      uid: user.uid,
      email: user.email,
      householdId: cachedSession?.uid === user.uid ? (cachedSession.householdId || null) : null
    });
    await loadUserData(user, { silent: canBoot });
    startAccountRealtimeSync();
  });
}

function setupRouter() {
  window.addEventListener("hashchange", handleRoute);
  if (!window.location.hash || !["#week", "#recipes", "#shop", "#prices", "#settings"].includes(window.location.hash)) {
    window.location.hash = "#week";
  } else {
    handleRoute();
  }
}

// Ultima vista renderizzata: consente di far scorrere la settimana sul giorno
// corrente solo quando la si apre, non a ogni re-render della stessa vista.
let lastRenderedRoute = null;

function handleRoute() {
  if (!appState.user || !appState.plan) return;
  const hash = window.location.hash || "#week";

  document.querySelectorAll(".view").forEach(view => view.classList.add("hidden"));
  document.querySelectorAll(".nav-item").forEach(item => item.classList.remove("active"));
  document.getElementById(`view-${hash.slice(1)}`)?.classList.remove("hidden");
  document.getElementById(`nav-${hash.slice(1)}`)?.classList.add("active");

  const enteringWeek = hash === "#week" && lastRenderedRoute !== "#week";
  if (hash === "#week") renderWeek();
  if (hash === "#recipes") renderRecipes();
  if (hash === "#shop") renderShop();
  if (hash === "#prices") renderPrices();
  if (hash === "#settings") renderSettings();
  lastRenderedRoute = hash;

  if (enteringWeek) scrollWeekToToday();
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
  header.innerHTML = `
    <div class="header-brand"><span>🥗</span><strong>Piano</strong></div>
    <select aria-label="Profilo porzioni" onchange="changePortionProfile(this.value)">
      <option value="man" ${profile === "man" ? "selected" : ""}>👨 Uomo · A/R</option>
      <option value="ipo" ${profile === "ipo" ? "selected" : ""}>👩 Donna · IPO</option>
      <option value="couple" ${profile === "couple" ? "selected" : ""}>👥 Uomo + Donna IPO</option>
    </select>
    <a href="#settings" class="header-account" title="Impostazioni" aria-label="Impostazioni">⚙️ ${escapeHtml(usernameFromUser(appState.user))}</a>
  `;
}

window.changePortionProfile = function(profile) {
  if (!["man", "ipo", "couple"].includes(profile)) return;
  appState.deviceSettings.portionProfile = profile;
  saveLocalDeviceSettings(appState.deviceSettings);
  renderGlobalHeader();
  handleRoute();
};

// ----- Modale batch cooking (aperta dalla colonna della Settimana) -----

// La dicitura "Batch cooking disponibile" nella colonna del giorno apre una
// modale con le ricette coinvolte (cena anchor + pranzo target) e le dosi da
// preparare: le quantità sono quelle calcolate dal dominio per profilo e tipo
// A/R del giorno target, già sommate nel caso della doppia porzione.

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

  return (recipe.ingredients || []).map(ingredient => {
    const adapted = window.PianoDomain
      ? PianoDomain.adaptIngredientForSlot(ingredient, recipe.slot, slot)
      : null;
    const displayed = adapted ? { ...ingredient, name: adapted.name, portions: adapted.portions } : ingredient;
    return { name: displayed.name, quantityHtml: getIngredientCoupleHtml(displayed, getDayType(dayKey)) };
  });
}

// Nel popup batch la ricetta è già completa: ingredienti, dosi e preparazione
// sono consultabili senza aprire una seconda modale.
function batchRecipeBoxHtml(heading, recipe, dayKey, slot, batch) {
  if (!recipe) return "";
  const ingredients = batchRecipeIngredients(recipe, dayKey, slot, batch);
  return `
    <article class="batch-detail-recipe">
      ${heading ? `<small>${escapeHtml(heading)}</small>` : ""}
      <h4>${escapeHtml(recipe.emoji || "🍲")} ${escapeHtml(getRecipeDisplayName(recipe, getDayType(dayKey)))}</h4>
      <h5>Ingredienti${batch?.commonRecipe ? " · dosi totali" : ""}</h5>
      <ul class="modal-ingredient-list">${ingredients.map(ingredient => `
        <li><span>${escapeHtml(ingredient.name)}</span>${ingredient.quantityHtml || `<strong>${escapeHtml(ingredient.quantity)}</strong>`}</li>`).join("")}</ul>
      <h5>Preparazione</h5>
      <ol class="batch-recipe-steps">${(recipe.steps || []).map((step, index) => `<li><strong>${index + 1}.</strong> ${escapeHtml(step)}</li>`).join("")}</ol>
      ${recipe.specialNote ? `<p class="special-note"><strong>Importante:</strong> ${escapeHtml(recipe.specialNote)}</p>` : ""}
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

function analyzeWeeklyPlan() {
  const counts = {
  poultry: 0,
  beef: 0,
  curedMeats: 0,
  omega: 0,
  otherFish: 0,
  dairy: 0,
  eggs: 0,
  legumes: 0
};
  const doubleFishDays = [];
  DAY_ORDER.forEach(day => {
    const recipes = [getPlannedRecipe(day, "lunch"), getPlannedRecipe(day, "dinner")].filter(Boolean);
    if (recipes.filter(recipeIsFish).length > 1) doubleFishDays.push(DAY_NAMES[day]);
    recipes.forEach(recipe => {
      const category = recipeProteinCategory(recipe);
      if (category && counts[category] !== undefined) {
        counts[category]++;
      }
    });
  });

const checks = [
  { label: "Pollame", value: counts.poultry, target: "1-2", ok: counts.poultry >= 1 && counts.poultry <= 2 },
  { label: "Manzo e maiale", value: counts.beef, target: "0-1", ok: counts.beef >= 0 && counts.beef <= 1 },
  { label: "Affettati e carni miste", value: counts.curedMeats, target: "0-1", ok: counts.curedMeats >= 0 && counts.curedMeats <= 1 },
  { label: "Pesce ricco di omega-3", value: counts.omega, target: "2-3", ok: counts.omega >= 2 && counts.omega <= 3 },
  { label: "Altro pesce e prodotti ittici", value: counts.otherFish, target: "1-2", ok: counts.otherFish >= 1 && counts.otherFish <= 2 },
  { label: "Latticini e formaggi", value: counts.dairy, target: "1-2", ok: counts.dairy >= 1 && counts.dairy <= 2 },
  { label: "Uova", value: counts.eggs, target: "1-2", ok: counts.eggs >= 1 && counts.eggs <= 2 },
  { label: "Legumi e derivati", value: counts.legumes, target: "almeno 3", ok: counts.legumes >= 3 }
];
  return { checks, doubleFishDays, allOk: checks.every(check => check.ok) && !doubleFishDays.length };
}

function renderWeekAnalysis() {
  const analysis = analyzeWeeklyPlan();
  return `
    <section class="plan-check ${analysis.allOk ? "ok" : "warning"}">
      <div class="flex-between"><h3>${analysis.allOk ? "✅ Piano conforme" : "⚠️ Frequenze da controllare"}</h3><span>${analysis.checks.filter(check => check.ok).length}/${analysis.checks.length}</span></div>
      <div class="frequency-grid">
        ${analysis.checks.map(check => `<div class="frequency-item ${check.ok ? "ok" : "warning"}"><span>${escapeHtml(check.label)}</span><strong>${check.value} <small>/ ${escapeHtml(check.target)}</small></strong></div>`).join("")}
      </div>
      ${analysis.doubleFishDays.length ? `<p class="validation-warning">Due pasti di pesce: ${escapeHtml(analysis.doubleFishDays.join(", "))}</p>` : `<p class="validation-ok">Mai due pasti di pesce nello stesso giorno.</p>`}
    </section>`;
}

function renderWeek() {
  const container = document.getElementById("view-week");
  const today = getTodayKey();
  container.innerHTML = `
    <div class="page-heading week-heading"><div><p class="eyebrow">Schema ottimizzato</p><h1>Piano settimanale</h1><p>Sab(R) · Dom(A) · Lun(A) · Mar(R) · Mer(A) · Gio(R) · Ven(A)</p></div><button class="btn btn-outline" onclick="openGeneratorModal()">✨ Genera settimana</button></div>
    ${renderWeekAnalysis()}
    <div class="week-grid">
      ${DAY_ORDER.map(day => {
        const planDay = appState.plan.days[day];
        return `
          <article id="day-${day}" class="day-column ${day === today ? "current-day" : ""}">
            <div class="day-column-head">
              <div>${day === today ? `<span class="today-badge">OGGI</span>` : `<span class="recipe-code">GIORNO</span>`}<h2>${DAY_NAMES[day]}</h2></div>
              <div class="day-type-control">
                <button class="type-option training ${planDay.type === "training" ? "active" : ""}" onclick="changeDayType('${day}', 'training')">A</button>
                <button class="type-option rest ${planDay.type === "rest" ? "active" : ""}" onclick="changeDayType('${day}', 'rest')">R</button>
              </div>
            </div>
            ${MEAL_SLOTS.map(slot => {
              const recipe = getRecipe(planDay[slot.id]);
              return `<div class="week-meal">
                <small>${escapeHtml(slot.shortLabel)}</small>
                <button class="week-meal-name" onclick="openRecipeModal('${escapeAttr(recipe?.id || "")}', '${day}', '${slot.id}')">${escapeHtml(recipe?.emoji || "")} ${escapeHtml(recipe ? getRecipeDisplayName(recipe, planDay.type) : "Non disponibile")}${recipe && recipeIsCrossSlot(recipe, slot.id) ? ` <span class="cross-slot-badge" title="Carboidrati trasformati in percentuale per questo pasto">↻</span>` : ""}</button>
                <button class="btn-icon btn-swap" onclick="openMealActions('${day}', '${slot.id}')" title="Operazioni sul pasto" aria-label="Operazioni sul pasto">⋯</button>
              </div>`;
            }).join("")}
            ${getActiveBatch(day).length ? `<button type="button" class="batch-active-chip batch-chip-btn" onclick="openBatchModal('${day}')" title="Mostra le dosi da batch cooking">🍳 Batch cooking disponibile<span class="batch-chip-arrow">›</span></button>` : ""}
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
        <p class="text-muted">La sostituzione può cambiare frequenze e batch cooking. Le dosi A/R/IPO della ricetta restano invariate.</p>
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
    const crossBadge = recipeIsCrossSlot(batchRecipe, slot) ? ` <span class="swap-cross-badge" title="Carboidrati trasformati in percentuale">↻</span>` : "";
    return `<div class="batch-suggestion">
      <div class="batch-suggestion-title">🍳 Consiglio batch cooking</div>
      <button class="swap-item batch-suggestion-item ${selected ? "selected" : ""}" onclick="confirmSwap('${dayKey}', '${slot}', '${escapeAttr(batchRecipe.id)}')">
        <span class="swap-code">${escapeHtml(batchRecipe.id)}</span>
        <span><strong>${escapeHtml(batchRecipe.emoji || "🍲")} ${escapeHtml(getRecipeDisplayName(batchRecipe, getDayType(dayKey)))}${crossBadge}</strong><small>${escapeHtml(batchNeighbor.label)} · doppia porzione: cucini una volta per due pasti</small></span>
        ${selected ? "<b>✓</b>" : ""}
      </button>
    </div>`;
  })();

  const sameSlotRecipes = appState.recipes.filter(recipe => recipe.slot === slot && recipe.id !== batchRecipe?.id);
  // Pranzo <-> cena: mostra anche le ricette del pasto opposto; i carboidrati
  // verranno trasformati in percentuale (50% / 200%).
  const oppositeSlot = slot === "lunch" ? "dinner" : slot === "dinner" ? "lunch" : null;
  const oppositeSlotRecipes = oppositeSlot ? appState.recipes.filter(recipe => recipe.slot === oppositeSlot && recipe.id !== batchRecipe?.id) : [];
  const oppositeLabel = oppositeSlot ? getSlotMeta(oppositeSlot).label.toLowerCase() : "";
  const resetButton = defaultId && defaultId !== currentId ? `
    <button class="swap-item reset" onclick="confirmSwap('${dayKey}', '${slot}', '${escapeAttr(defaultId)}')">
      <span><strong>↩ Ripristina scelta iniziale</strong><small>${escapeHtml(getRecipe(defaultId) ? getRecipeDisplayName(getRecipe(defaultId), getDayType(dayKey)) : defaultId)}</small></span>
    </button>` : "";

  const swapItemHtml = (recipe, crossSlot = false) => {
    const selected = recipe.id === currentId;
    const hint = crossSlot
      ? `Da ${escapeHtml(oppositeLabel)} · carboidrati trasformati in %`
      : escapeHtml(recipeProteinLabel(recipe));
    const badge = crossSlot ? ` <span class="swap-cross-badge" title="Carboidrati trasformati in percentuale">↻</span>` : "";
    return `<button class="swap-item ${selected ? "selected" : ""}" onclick="confirmSwap('${dayKey}', '${slot}', '${escapeAttr(recipe.id)}')"><span class="swap-code">${escapeHtml(recipe.id)}</span><span><strong>${escapeHtml(recipe.emoji || "🍲")} ${escapeHtml(getRecipeDisplayName(recipe, getDayType(dayKey)))}${badge}</strong><small>${hint}</small></span>${selected ? "<b>✓</b>" : ""}</button>`;
  };

  document.getElementById("swap-options-list").innerHTML = `
    ${batchSuggestionHtml}
    ${resetButton}
    ${sameSlotRecipes.map(recipe => swapItemHtml(recipe, false)).join("")}
    ${oppositeSlotRecipes.length ? `<div class="swap-section-label">Dal pasto opposto (carboidrati trasformati in % al ${escapeHtml(slotMeta.label.toLowerCase())})</div>${oppositeSlotRecipes.map(recipe => swapItemHtml(recipe, true)).join("")}` : ""}
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
  const crossSlot = recipeIsCrossSlot(recipe, slot);
  const baseMsg = "Sostituire questo pasto con la ricetta scelta? Frequenze e batch cooking potrebbero cambiare.";
  const crossMsg = crossSlot ? "\n\nI carboidrati verranno trasformati in percentuale (pranzo → cena 50%, cena → pranzo 200%), arrotondati alla decina per eccesso. Le proteine, le uova e la verdura restano invariate." : "";
  if (!confirm(baseMsg + crossMsg)) return;
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
    ? `Ricetta attuale: ${getRecipeDisplayName(getRecipe(currentId), getDayType(dayKey))}`
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
    options.push(`<button class="swap-item" onclick="${mode === "swap" ? "confirmSwapMeal" : "confirmCopyMeal"}('${sourceDay}', '${slot}', '${day}')"><span class="swap-code">${DAY_NAMES[day].slice(0, 3).toUpperCase()}</span><span><strong>${escapeHtml(recipe ? `${recipe.emoji || "🍲"} ${getRecipeDisplayName(recipe, getDayType(day))}` : "Nessuna ricetta")}</strong><small>${escapeHtml(getSlotMeta(slot).label)} · ${icon} ${mode === "swap" ? "scambia" : "copia"}</small></span></button>`);
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

function renderRecipes() {
  const container = document.getElementById("view-recipes");
  const recipeLibraryState = getRecipeLibraryState();
  container.innerHTML = `
    <div class="page-heading recipes-heading">
      <div><p class="eyebrow">${appState.recipes.length} ricette · sincronizzate nel cloud</p><h1>Ricettario</h1><p>Puoi creare, esportare, importare e condividere le ricette del tuo account.</p></div>
      <div class="recipe-toolbar">
        <button class="btn btn-primary" onclick="window.PianoWebSearch.open()">🌐 Cerca nel web</button>
        <button class="btn btn-outline" onclick="openIncomingShares()">📥 Ricevute</button>
        <label class="btn btn-outline file-import-button">Importa<input type="file" accept="application/json,.json" onchange="prepareRecipeImport(this.files[0]); this.value='' "></label>
        <button class="btn btn-outline" onclick="exportAllRecipes()">Esporta</button>
        <button class="btn btn-outline" onclick="openShareDialog()">Invia tutte</button>
        ${appState.recipes.length ? `<button class="btn btn-danger" onclick="deleteAllRecipes()">🗑 Elimina tutte</button>` : ""}
        <button class="btn btn-primary" onclick="createNewRecipe()">+ Nuova</button>
      </div>
    </div>
    ${appState.recipes.length ? `<label class="search-box"><span>⌕</span><input id="recipe-search" type="search" value="${escapeAttr(recipeLibraryState.searchQuery)}" placeholder="Cerca ricetta, categoria o ingrediente…" oninput="filterRecipeCards(this.value)"><button type="button" id="recipe-search-clear" class="search-clear-btn ${recipeLibraryState.searchQuery ? "" : "hidden"}" onclick="clearRecipeSearch()" aria-label="Cancella ricerca" title="Cancella ricerca">×</button></label><p id="recipe-search-empty" class="text-muted recipe-search-empty hidden">Nessuna ricetta trovata. Prova con un altro nome, ingrediente o categoria.</p>${MEAL_SLOTS.map(slot => recipeSectionHtml(slot.label, appState.recipes.filter(recipe => recipe.slot === slot.id), slot)).join("")}` : `<div class="empty-state recipe-empty-state"><span>🍲</span><h2>Il tuo ricettario è vuoto</h2><p>Puoi creare la prima ricetta manualmente, importare un file JSON o attendere una condivisione da un altro utente.</p><button class="btn btn-primary" onclick="window.PianoWebSearch.open()">🌐 Cerca nel web</button><button class="btn btn-primary" onclick="createNewRecipe()">+ Crea la prima ricetta</button></div>`}
  `;
  if (appState.recipes.length) filterRecipeCards(recipeLibraryState.searchQuery, { persist: false });
}

function recipeSectionHtml(title, recipes, slot) {
  if (!recipes.length) return "";
  const sectionId = `recipe-section-${slot.id}`;
  const isOpen = getRecipeLibraryState().openSections[slot.id];
  return `
    <section class="recipe-library-section" data-slot="${slot.id}">
      <button class="recipe-section-toggle ${isOpen ? "" : "collapsed"}" onclick="toggleRecipeSection('${slot.id}', this)" aria-expanded="${isOpen ? "true" : "false"}">
        <span class="section-title" style="margin:0"><span>${slot.emoji}</span><div><small>${recipes.length} proposte</small><h2>${escapeHtml(title)}</h2></div></span>
        <b class="recipe-section-chevron">⌄</b>
      </button>
      <div id="${sectionId}" class="recipe-section-body ${isOpen ? "" : "hidden"}">
        <div class="recipe-grid">
          ${recipes.map(recipe => {
            const mellerFlag = window.PianoDomain?.checkMellerAdaptation?.(recipe)?.adapted === false
              ? `<span class="meller-card-flag" title="Dosi non adattate alle grammature del dott. Meller">⚠</span>`
              : "";
            return `<button class="recipe-library-card" data-search="${escapeAttr(`${recipe.id} ${recipe.name} ${recipe.namesByDayType?.training || ""} ${recipe.namesByDayType?.rest || ""} ${recipeProteinLabel(recipe)} ${(recipe.ingredients || []).map(i => i.name).join(" ")}`.toLowerCase())}" onclick="openRecipeModal('${escapeAttr(recipe.id)}')"><span class="recipe-code">${escapeHtml(recipe.id)}</span>${mellerFlag}<span class="recipe-card-emoji">${escapeHtml(recipe.emoji || "🍲")}</span><strong>${escapeHtml(recipe.name)}</strong><small>${escapeHtml(recipeProteinLabel(recipe))}</small></button>`;
          }).join("")}
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
    ingredients: [], steps: [], notes: [], specialNote: ""
  };
  currentModal = { recipe, original: null, dayKey: DAY_ORDER.includes(assignDay) ? assignDay : null, dayType: DAY_ORDER.includes(assignDay) ? getDayType(assignDay) : getRecipePreviewDayType(), assignAfterSave: DAY_ORDER.includes(assignDay) ? { day: assignDay, slot: selectedSlot } : null, isNew: true };
  editMode = true;
  renderModalContent();
  document.getElementById("recipe-modal").classList.remove("hidden");
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
    specialNote: normalized.specialNote || "",
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

// Importazione di una ricetta trovata con la ricerca web: si riusa
// il popup ricetta già esistente. Le dosi arrivano così come trovate sul web;
// il banner "non adattata a Meller" e il pulsante "Adatta a Meller" permettono
// di riportarle alle grammature del manuale con un click, poi si salva nel
// cloud con il normale pulsante di salvataggio.
window.importRecipeFromWebSearch = function(data = {}) {
  const source = data && typeof data === "object" ? data : {};
  const slot = MEAL_SLOTS.some(item => item.id === source.slot) ? source.slot : "lunch";
  const quantityFor = quantity => {
    const clean = String(quantity ?? "").trim();
    return clean || "—";
  };
  const ingredients = (Array.isArray(source.ingredients) ? source.ingredients : [])
    .map(item => ({
      name: String(item?.name || "").trim() || "Ingrediente",
      portions: {
        ipoTraining: quantityFor(item?.quantity),
        ipoRest: quantityFor(item?.quantity),
        manTraining: quantityFor(item?.quantity),
        manRest: quantityFor(item?.quantity)
      }
    }));
  const steps = (Array.isArray(source.steps) ? source.steps : []).map(step => String(step || "").trim()).filter(Boolean);
  const notes = (Array.isArray(source.notes) ? source.notes : []).map(note => String(note || "").trim()).filter(Boolean);
  let sourceUrl = "";
  try {
    const parsed = new URL(String(source.sourceUrl || ""));
    if (["http:", "https:"].includes(parsed.protocol)) sourceUrl = parsed.href;
  } catch (_) {}
  if (sourceUrl) notes.push(`Fonte: ${sourceUrl}`);
  const recipe = {
    id: `U${Date.now()}`,
    slot,
    name: String(source.name || "Ricetta").trim() || "Ricetta",
    emoji: String(source.emoji || "").trim() || getSlotMeta(slot).emoji,
    proteinCategory: String(source.proteinCategory || ""),
    ingredients,
    steps,
    notes,
    specialNote: String(source.specialNote || "").trim()
  };
  currentModal = { recipe, original: null, dayKey: null, dayType: getRecipePreviewDayType(), slot: null, isNew: true };
  editMode = true;
  renderModalContent();
  document.getElementById("recipe-modal").classList.remove("hidden");
  showToast("Ricetta trovata sul web: controlla dosi e preparazione, poi salva");
};

function normalizeIngredientName(name) {
  return String(name || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ").trim();
}

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

function shoppingPortionsForIngredient(ingredient, dayType) {
  const profile = getPortionProfile();
  if (profile === "ipo") return [{ role: "Donna IPO", raw: getPortionValue(ingredient, "ipo", dayType) }];
  if (profile === "couple") return [
    { role: "Uomo", raw: getPortionValue(ingredient, "man", dayType) },
    { role: "Donna IPO", raw: getPortionValue(ingredient, "ipo", dayType) }
  ];
  return [{ role: "Uomo", raw: getPortionValue(ingredient, "man", dayType) }];
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
    getCanonicalIngredientLabels()
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
  const items = Object.entries(opaque).map(([label, count]) => {
    const roleMatch = label.match(/^(Uomo|Donna IPO):\s*(.+)$/i);
    return {
      label,
      count,
      role: roleMatch ? roleMatch[1] : null,
      raw: roleMatch ? roleMatch[2] : label
    };
  });
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
    const roleCount = new Set(group.map(item => item.role).filter(Boolean)).size;
    // Valori opachi uguali (es. "1 mazzetto") possono essere sommati senza
    // perdere significato. Per i profili Coppia richiediamo entrambi i ruoli.
    if (counted && (roleCount > 1 || group.every(item => !item.role))) {
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

function renderShop() {
  const container = document.getElementById("view-shop");
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
  const known = labels?.get(id) || getCanonicalIngredientLabels()[id];
  if (known) return known;
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

// ---- A4: Alternative Meller inline (tap ingrediente -> equivalenze) ----
function isMellerCarbIngredient(name) {
  const n = normalizeIngredientName(name);
  return /(pasta|riso|gnocchi|farro|orzo|quinoa|grano saraceno|amaranto|pane|piadina|cracker|grissin|crostin|polenta|patat|avena|cereali|fette biscottate|wasa|cous)/i.test(n);
}
function isMellerProteinIngredient(name) {
  const n = normalizeIngredientName(name);
  return /(pollo|tacchino|manzo|vitello|maiale|affettat|crostace|mollusc|gamber|calamar|polpo|seppia|merluzzo|nasello|sogliola|tonno|salmone|sgombro|pesce|uova|uovo|ricotta|mozzarella|caprino|feta|parmigiano|grana|montasio|fiocchi di latte|yogurt|skyr|kefir|legum|ceci|lenticch|fagiol|edamame|piselli|barilla|tofu)/i.test(n);
}
function getMellerAlternativesForIngredient(ingredientName) {
  const guide = typeof MELLER_GUIDE !== "undefined" ? MELLER_GUIDE.alternatives : null;
  if (!guide) return null;
  const isCarb = isMellerCarbIngredient(ingredientName);
  const isProtein = isMellerProteinIngredient(ingredientName);
  // Solo carboidrati e proteine hanno equivalenze Meller: verdura, frutta,
  // dispensa e spezie non sono tappabili.
  if (!isCarb && !isProtein) return null;
  let groups = [];
  if (isCarb && !isProtein) groups = [guide.carbohydrates];
  else if (!isCarb && isProtein) groups = [guide.proteins];
  else groups = [guide.carbohydrates, guide.proteins];
  return { groups, isCarb, isProtein };
}
function shouldHighlightMellerRow(rowLabel, ingredientName) {
  const rowNorm = normalizeIngredientName(rowLabel);
  const ingNorm = normalizeIngredientName(ingredientName);
  const rowTokens = rowNorm.split(/\W+/).filter(Boolean);
  const ingTokens = ingNorm.split(/\W+/).filter(Boolean);
  // match se un token significativo (lunghezza >=4) coincide
  return ingTokens.some(tok => tok.length >= 4 && rowNorm.includes(tok)) ||
         rowTokens.some(tok => tok.length >= 4 && ingNorm.includes(tok));
}
function mellerTableHtmlWithHighlight(group, ingredientName) {
  const isCarb = group === MELLER_GUIDE.alternatives.carbohydrates;
  const headers = isCarb ? ['Alimento', 'Pranzo', 'Cena'] : ['Alimento', 'Pranzo'];
  const rows = group.rows.map(row => {
    const highlight = shouldHighlightMellerRow(row[0], ingredientName);
    return `<div class="${highlight ? "meller-highlight" : ""}">${row.map((cell, index) => index === 0 ? `<span>${escapeHtml(cell)}</span>` : `<strong>${escapeHtml(cell)}</strong>`).join("")}</div>`;
  }).join("");
  return `<div class="alternative-table${isCarb ? " meller-carbs" : " meller-proteins"}"><h3>${escapeHtml(group.title)}</h3><div class="alternative-head">${headers.map(escapeHtml).map(header => `<strong>${header}</strong>`).join("")}</div>${rows}</div>`;
}
function setupMellerModal() {
  if (document.getElementById("meller-alternatives-modal")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="meller-alternatives-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="meller-modal-title">
      <div class="modal-content meller-modal-content">
        <div class="modal-header"><div><p class="eyebrow">ALTERNATIVE MELLER</p><h2 id="meller-modal-title"></h2><p id="meller-modal-subtitle" class="text-muted"></p></div><button class="btn-icon" onclick="closeMellerAlternatives()" aria-label="Chiudi">&times;</button></div>
        <div id="meller-modal-body"></div>
        <p class="meller-modal-note text-muted">Equivalenze da <strong>Manuale Meller</strong> (pesi a crudo). Verdura sempre libera ~200g, non pesata.</p>
        <div class="modal-footer"><button class="btn btn-primary full-width" onclick="closeMellerAlternatives()">Chiudi</button></div>
      </div>
    </div>`);
  bindModalOutsideClose("meller-alternatives-modal", () => window.closeMellerAlternatives());
}
window.openMellerAlternatives = function(ingredientName) {
  const data = getMellerAlternativesForIngredient(ingredientName);
  if (!data) return;
  const { groups, isCarb, isProtein } = data;
  document.getElementById("meller-modal-title").textContent = ingredientName;
  let subtitle = "";
  if (isCarb && !isProtein) subtitle = "Carboidrati equivalenti · riferimento Pasta/Riso 70g";
  else if (!isCarb && isProtein) subtitle = "Proteine equivalenti · riferimento Pollame 200g";
  else subtitle = "Equivalenze disponibili per questo ingrediente";
  document.getElementById("meller-modal-subtitle").textContent = subtitle;
  const body = document.getElementById("meller-modal-body");
  body.innerHTML = `<div class="meller-tables">${groups.map(g => mellerTableHtmlWithHighlight(g, ingredientName)).join("")}</div>`;
  document.getElementById("meller-alternatives-modal").classList.remove("hidden");
};
window.closeMellerAlternatives = function() {
  document.getElementById("meller-alternatives-modal")?.classList.add("hidden");
};

function guideDayHtml(dayGuide, tone) {
  return `
    <div class="guide-day ${tone}">
      <h3>${escapeHtml(dayGuide.title)}</h3>
      ${dayGuide.meals.map(meal => `<div class="guide-meal"><h4>${escapeHtml(meal.title)}</h4><ul>${meal.lines.map(line => `<li>${escapeHtml(line)}</li>`).join("")}</ul></div>`).join("")}
      <p class="guide-macro"><strong>Macro medie:</strong> ${escapeHtml(dayGuide.macro)}</p>
    </div>`;
}

function alternativesTableHtml(group) {
  const isCarb = group.rows.some(row => row.length === 3);
  const headers = isCarb ? ['Alimento', 'Pranzo', 'Cena'] : ['Alimento', 'Pranzo'];
  const rows = group.rows.map(row => `<div>${row.map((cell, index) => index === 0 ? `<span>${escapeHtml(cell)}</span>` : `<strong>${escapeHtml(cell)}</strong>`).join('')}</div>`).join('');
  return `<div class="alternative-table${isCarb ? ' meller-carbs' : ' meller-proteins'}"><h3>${escapeHtml(group.title)}</h3><div class="alternative-head">${headers.map(header => `<strong>${escapeHtml(header)}</strong>`).join('')}</div>${rows}</div>`;
}

function settingsAccordion(title, content, open = false) {
  const id = `guide-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return `<section class="settings-section guide-accordion"><button class="guide-toggle" aria-controls="${id}" onclick="document.getElementById('${id}').classList.toggle('hidden')"><span>${escapeHtml(title)}</span><b>⌄</b></button><div id="${id}" class="guide-content ${open ? "" : "hidden"}">${content}</div></section>`;
}

function renderLinkedAccountsSection() {
  const ownUsername = usernameFromUser(appState.user);
  const household = appState.household;
  const linkedUsernames = (household?.memberUsernames || []).filter(username => username !== ownUsername);
  return `
    <section class="settings-section linked-accounts-section">
      <div class="flex-between"><div><h2>Account collegati</h2><p class="text-muted">Settimana, ricette, batch cooking e spesa condivisi in tempo reale.</p></div><span class="link-status ${household ? "active" : ""}">${household ? "● Sincronizzato" : "Non collegato"}</span></div>
      ${linkedUsernames.length ? `<div class="linked-member-list">${linkedUsernames.map(username => `<div class="linked-member"><span class="account-avatar small">${escapeHtml(username.slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(username)}</strong><small>Può leggere e modificare tutti i dati condivisi</small></div></div>`).join("")}</div>` : `<p class="linked-empty">Nessun altro account collegato. Il profilo porzioni resta sempre personale e salvato solo su questo dispositivo.</p>`}
      <div class="linked-account-actions">
        <button class="btn btn-primary" onclick="openAccountLinkDialog()">+ Collega account</button>
        <button class="btn btn-outline" onclick="openIncomingShares()">📥 Ricevute</button>
        ${household ? `<button class="btn btn-danger" onclick="disconnectAccount()">Scollega questo account</button>` : ""}
      </div>
    </section>`;
}

function renderSettings() {
  const container = document.getElementById("view-settings");
  const breakfastCount = appState.recipes.filter(recipe => recipe.slot === "breakfast").length;
  container.innerHTML = `
    <div class="page-heading"><div><p class="eyebrow">Preferenze e manuale alimentare</p><h1>Impostazioni</h1></div></div>
    <section class="settings-section account-card">
      <div class="account-avatar">${escapeHtml(usernameFromUser(appState.user).slice(0, 1).toUpperCase())}</div>
      <div><small>Accesso personale</small><h2>${escapeHtml(usernameFromUser(appState.user))}</h2><p>Account personale protetto</p></div>
      <button class="btn btn-outline" onclick="logoutCurrentUser()">Esci</button>
    </section>

    ${renderLinkedAccountsSection()}

    <section class="settings-section">
      <h2>Aspetto</h2>
      <label class="settings-row"><span><strong>Tema scuro</strong><small>Solo su questo dispositivo</small></span><input type="checkbox" ${appState.deviceSettings.darkMode ? "checked" : ""} onchange="toggleDarkMode(this.checked)"></label>
    </section>

    ${window.PianoWebSearch?.settingsSectionHtml?.() || ""}

    <div class="manual-heading"><p class="eyebrow">INDICAZIONI DI MELLER</p><h2>Manuale dieta e alternative</h2><p>Le alternative originali restano sempre consultabili nell'app.</p></div>

    ${settingsAccordion("Struttura della dieta", `<ul class="guide-list">${MELLER_GUIDE.structure.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`)}
    ${settingsAccordion("Giorno di allenamento", guideDayHtml(MELLER_GUIDE.trainingDay, "training"))}
    ${settingsAccordion("Giorno di riposo", guideDayHtml(MELLER_GUIDE.restDay, "rest"))}
    ${settingsAccordion("Alternative alimentari di Meller", `<div class="alternatives-grid">${alternativesTableHtml(MELLER_GUIDE.alternatives.carbohydrates)}${alternativesTableHtml(MELLER_GUIDE.alternatives.proteins)}</div>`)}
    ${settingsAccordion("Frequenze proteiche", `<div class="alternative-table frequency-table">${MELLER_GUIDE.proteinFrequencies.map(row => `<div><span>${escapeHtml(row[0])}</span><strong>${escapeHtml(row[1])}</strong></div>`).join("")}</div>`)}
    ${settingsAccordion("Altre informazioni e FAQ", `<ul class="guide-list">${MELLER_GUIDE.faq.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`)}

    <section class="settings-section cloud-section">
      <div><h2>Dati e sincronizzazione</h2><p class="text-muted">${appState.recipes.length} ricette totali · ${breakfastCount} colazioni</p><p class="cloud-call-info">⚡ Dati sincronizzati tra i tuoi dispositivi.</p></div>
      <label class="btn btn-outline file-import-button">Importa o ripristina ricette<input type="file" accept="application/json,.json" onchange="prepareRecipeImport(this.files[0]); this.value='' "></label>
    </section>

    ${renderBackupSection()}
  `;
}

function renderBackupSection() {
  const meta = readLocalJson("backup_meta", null);
  const hasBackup = Boolean(meta?.operation || meta?.description || meta?.createdAt);
  const protectedOperations = [
    "Importazioni che sostituiscono tutte le ricette",
    "Condivisioni che sovrascrivono ricette o settimana",
    "Applicazione del generatore settimana",
    "Eliminazione di una o più ricette",
    "Collegamento o scollegamento account"
  ];
  return `
    <section class="settings-section backup-section">
      <div class="flex-between"><h2>Backup e annullamento</h2><span class="backup-status ${hasBackup ? "ready" : "idle"}">${hasBackup ? "Backup pronto" : "Nessun backup"}</span></div>
      <p class="text-muted backup-note">Prima delle operazioni più pesanti salviamo automaticamente una copia di <strong>ricette, settimana e lista spesa</strong>. La copia più recente sostituisce quella precedente.</p>
      <ul class="backup-covered-list">${protectedOperations.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      ${hasBackup ? `
        <div class="backup-meta">
          <div><small>Ultima operazione</small><strong>${escapeHtml(meta.operation || "—")}</strong></div>
          <div><small>Descrizione</small><strong>${escapeHtml(meta.description || "—")}</strong></div>
          <div><small>Data backup</small><strong>${escapeHtml(formatBackupDate(meta.createdAt) || "—")}</strong></div>
        </div>
        <button class="btn btn-danger full-width" onclick="undoLastModification()">↩ Annulla ultima modifica</button>
        <p class="text-muted backup-note">Il ripristino è disponibile una sola volta: dopo l'annullamento la copia di sicurezza viene eliminata.</p>
      ` : `
        <p class="text-muted backup-note">Appena esegui una di queste operazioni, qui comparirà l'ultimo punto di ripristino disponibile.</p>
      `}
    </section>
  `;
}

window.toggleDarkMode = function(checked) {
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

// ---- Backup precedente (users/{uid}/backups/previous) ----

async function createBackup(catalog, plan, shopping, operation, description) {
  const snapshot = await saveBackup(catalog, plan, shopping, operation, description);
  writeLocalJson("backup_meta", {
    operation: snapshot.operation,
    description: snapshot.description,
    createdAt: snapshot.createdAt
  });
  return snapshot;
}

function formatBackupDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
}

window.undoLastModification = async function() {
  if (!confirm("Ripristinare l'ultimo stato salvato prima dell'ultima modifica? Il ripristino è disponibile una sola volta.")) return;
  setLoading("Ripristino dell'ultimo backup…");
  try {
    const restored = await restoreBackupAtomic();
    setRecipes(restored.catalog.recipes || []);
    appState.plan = restored.plan;
    appState.shopping = restored.shoppingList || getDefaultShoppingList();
    appState.household = getCurrentHousehold();
    writeLocalJson("backup_meta", null);
    renderGlobalHeader();
    startAccountRealtimeSync();
    handleRoute();
    showToast("Ultima modifica annullata ✅");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Ripristino non riuscito", true);
  } finally {
    clearLoading();
  }
};

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
    pendingRecipeImport = { recipes: imported.recipes.map(cleanRecipeForTransfer), plan: imported.plan, filename: file.name };
    document.getElementById("import-file-name").textContent = file.name;
    document.getElementById("import-recipe-count").textContent = `${imported.recipes.length} ricett${imported.recipes.length === 1 ? "a" : "e"}`;
    document.getElementById("import-plan-note").textContent = imported.plan?.days ? "Il file contiene anche un piano: verrà applicato scegliendo Sostituisci oppure quando il tuo catalogo è vuoto." : "Il piano attuale verrà mantenuto quando possibile.";
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

function setupTransferModals() {
  if (document.getElementById("recipe-import-modal")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="recipe-import-modal" class="modal hidden" role="dialog" aria-modal="true">
      <div class="modal-content transfer-modal-content">
        <div class="modal-header"><div><p class="eyebrow">IMPORTAZIONE</p><h2>Come vuoi importare?</h2></div><button class="btn-icon" onclick="closeRecipeImportModal()">&times;</button></div>
        <div class="transfer-summary"><strong id="import-file-name"></strong><span id="import-recipe-count"></span><p id="import-plan-note"></p></div>
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
    <div id="incoming-shares-modal" class="modal hidden" role="dialog" aria-modal="true">
      <div class="modal-content incoming-modal-content">
        <div class="modal-header"><div><p class="eyebrow">RICHIESTE RICEVUTE</p><h2>Condivisioni e collegamenti</h2></div><button class="btn-icon" onclick="closeIncomingShares()">&times;</button></div>
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
  bindModalOutsideClose("incoming-shares-modal", () => window.closeIncomingShares());
  bindModalOutsideClose("share-conflict-modal", () => window.closeShareConflictModal());
  bindModalOutsideClose("account-link-modal", () => window.closeAccountLinkDialog());
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

window.openIncomingShares = async function() {
  const modal = document.getElementById("incoming-shares-modal");
  const list = document.getElementById("incoming-shares-list");
  list.innerHTML = `<div class="empty-state"><div class="loading-spinner"></div><p>Caricamento richieste…</p></div>`;
  modal.classList.remove("hidden");
  try {
    // Una sola query server: i documenti (che incorporano interi cataloghi
    // ricette) vengono letti una volta e ripartiti tra i due elenchi.
    const { recipeShares, accountLinks } = await getPendingIncomingRequests();
    incomingRecipeShares = recipeShares;
    incomingAccountLinks = accountLinks;
    renderIncomingShares();
  } catch (error) {
    console.error(error);
    list.innerHTML = `<div class="empty-state"><span>⚠️</span><p>${escapeHtml(error.message || "Impossibile caricare le richieste")}</p></div>`;
  }
};

function renderIncomingShares() {
  const list = document.getElementById("incoming-shares-list");
  if (!incomingRecipeShares.length && !incomingAccountLinks.length) {
    list.innerHTML = `<div class="empty-state"><span>📭</span><h3>Nessuna richiesta</h3><p>Le ricette condivise e gli inviti a collegare un account compariranno qui.</p></div>`;
    return;
  }
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
      <div><span class="account-avatar small">${escapeHtml((share.senderUsername || "?").slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(share.senderUsername || "Utente")}</strong><small>${count} ricett${count === 1 ? "a" : "e"}${hasPlan ? " · 📅 include settimana" : ""}</small></div></div>
      <p>${escapeHtml((share.recipes || []).slice(0, 4).map(recipe => recipe.name).join(" · "))}${(share.recipes || []).length > 4 ? "…" : ""}</p>
      <div class="incoming-share-actions">${actions}<button class="btn btn-outline" onclick="rejectSharedRecipes('${share.id}')">Rifiuta</button></div>
    </article>`;
  }).join("");
  list.innerHTML = linkCards + recipeCards;
}

window.closeIncomingShares = function() {
  document.getElementById("incoming-shares-modal")?.classList.add("hidden");
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
    renderIncomingShares();
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
    renderIncomingShares();
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
    renderIncomingShares();
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
  slots: { breakfast: true, snack1: true, lunch: true, snack2: true, dinner: true },
  // Fonte unica delle frequenze proteiche: js/domain.js.
  constraints: window.PianoDomain?.DEFAULT_CONSTRAINTS
    ? { ...window.PianoDomain.DEFAULT_CONSTRAINTS }
    : {
      legumesMin: 3, legumesMax: 14,
      omegaMin: 2, omegaMax: 3,
      poultryMin: 1, poultryMax: 2,
      beefMin: 0, beefMax: 1,
      curedMeatsMin: 0, curedMeatsMax: 1,
      dairyMin: 1, dairyMax: 2,
      eggsMin: 1, eggsMax: 2,
      otherFishMin: 1, otherFishMax: 2
    }
};

// Versione della struttura delle preferenze del generatore: serve per
// migrare una sola volta i valori salvati in locale (es. legumesMax da 4 a 14,
// aggiunta delle nuove chiavi beef/curedMeats) senza sovrascrivere ogni volta
// le personalizzazioni dell'utente.
const GENERATOR_PREFS_VERSION = 2;

let generatorState = { seed: null, blocks: {}, proposal: null, panels: { advanced: false, locks: false } };

function migrateGeneratorPrefs(saved) {
  if (!saved || typeof saved !== 'object') return null;
  const version = Number(saved.version) || 0;
  if (version >= GENERATOR_PREFS_VERSION) return null;
  const next = {
    ...GENERATOR_PREFS_DEFAULTS,
    ...saved,
    slots: { ...GENERATOR_PREFS_DEFAULTS.slots, ...(saved.slots || {}) },
    constraints: { ...GENERATOR_PREFS_DEFAULTS.constraints, ...(saved.constraints || {}) },
    version: GENERATOR_PREFS_VERSION
  };
  // Migrazione v0 → v1/v2: il vecchio default legumesMax (4 o simile) viene
  // riconosciuto e aggiornato al nuovo default 14. Valori chiaramente
  // personalizzati (> 4 e <= 14) vengono preservati.
  const savedConstraints = saved.constraints || {};
  const oldLegumesMax = savedConstraints.legumesMax;
  if (version < 2 && Number.isFinite(Number(oldLegumesMax)) && Number(oldLegumesMax) >= 3 && Number(oldLegumesMax) <= 7) {
    next.constraints.legumesMax = GENERATOR_PREFS_DEFAULTS.constraints.legumesMax;
  }
  return next;
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
    constraints: { ...GENERATOR_PREFS_DEFAULTS.constraints, ...(source.constraints || {}) },
    version: GENERATOR_PREFS_VERSION
  };
}

function getGeneratorPanelState() {
  return {
    advanced: document.getElementById("generator-advanced")?.open ?? Boolean(generatorState.panels?.advanced),
    locks: document.getElementById("generator-locks")?.open ?? Boolean(generatorState.panels?.locks)
  };
}

function restoreGeneratorPanelState(state) {
  generatorState.panels = { ...state };
  const advanced = document.getElementById("generator-advanced");
  const locks = document.getElementById("generator-locks");
  if (advanced) advanced.open = Boolean(state.advanced);
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

window.generatorConstraintChanged = function(key, value) {
  if (!(key in GENERATOR_PREFS_DEFAULTS.constraints)) return;
  const num = Math.max(0, Math.min(14, Math.floor(Number(value) || 0)));
  saveGeneratorPrefs(prefs => {
    const constraints = { ...prefs.constraints, [key]: num };
    // Il minimo non deve mai superare il massimo della stessa categoria.
    const pair = [key.replace(/Min$/, "Max"), key.replace(/Max$/, "Min")];
    if (/Min$/.test(key) && constraints[pair[0]] !== undefined && num > constraints[pair[0]]) constraints[pair[0]] = num;
    if (/Max$/.test(key) && constraints[pair[1]] !== undefined && num < constraints[pair[1]]) constraints[pair[1]] = num;
    return { ...prefs, constraints };
  });
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
  const constraintRows = Object.entries(PianoDomain.PROTEIN_CONSTRAINT_KEYS || {}).map(([category, keys]) => {
    const label = PianoDomain.PROTEIN_CATEGORY_LABELS?.[category] || GENERATOR_COUNT_LABELS[category] || category;
    const minInput = keys.min
      ? `<input type="number" min="0" max="14" inputmode="numeric" aria-label="Minimo ${escapeAttr(label)}" value="${prefs.constraints[keys.min] ?? 0}" onchange="generatorConstraintChanged('${keys.min}', this.value)">`
      : `<span class="generator-constraint-na">—</span>`;
    return `<div class="generator-constraint-row">
      <strong>${escapeHtml(label)}</strong>
      ${minInput}
      <span class="generator-constraint-sep">–</span>
      <input type="number" min="0" max="14" inputmode="numeric" aria-label="Massimo ${escapeAttr(label)}" value="${prefs.constraints[keys.max] ?? 0}" onchange="generatorConstraintChanged('${keys.max}', this.value)">
    </div>`;
  }).join("");
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
    <details id="generator-advanced" class="generator-advanced">
      <summary>Proteine della settimana <small>(avanzate)</small></summary>
      <p class="text-muted">Se vuoi, puoi decidere quante volte inserire carne, pesce, uova, latticini e legumi. Se non tocchi nulla, usiamo le impostazioni consigliate.</p>
      <div class="generator-constraints-grid">${constraintRows}</div>
    </details>`;
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

window.computeGeneratorProposal = function(newSeed) {
  if (newSeed) generatorState.seed = Math.floor(Math.random() * 1000000);
  const prefs = getGeneratorPrefs();
  const result = window.PianoDomain
    ? PianoDomain.generateWeek(appState.recipes, {
        plan: appState.plan,
        seed: generatorState.seed ?? Date.now(),
        blocks: generatorState.blocks,
        templates: appState.plan.batchTemplates || [],
        constraints: prefs.constraints,
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

// Verde quando il conteggio rientra nell'intervallo scelto, rosso altrimenti.
function generatorCountStatus(key, value) {
  const constraints = getGeneratorPrefs().constraints;
  const ranges = {
    poultry: [constraints.poultryMin, constraints.poultryMax],
    beef: [constraints.beefMin, constraints.beefMax],
    curedMeats: [constraints.curedMeatsMin, constraints.curedMeatsMax],
    omega: [constraints.omegaMin, constraints.omegaMax],
    otherFish: [constraints.otherFishMin, constraints.otherFishMax],
    dairy: [constraints.dairyMin, constraints.dairyMax],
    eggs: [constraints.eggsMin, constraints.eggsMax],
    legumes: [constraints.legumesMin, constraints.legumesMax]
  };
  const [min, max] = ranges[key] || [0, Infinity];
  return value >= min && value <= max ? "ok" : "warning";
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
    <div class="generator-counts">${Object.entries(result.counts).map(([key, value]) => `<span class="${generatorCountStatus(key, value)}" title="Intervallo scelto nel pannello avanzate">${escapeHtml(GENERATOR_COUNT_LABELS[key] || key)}: ${value}</span>`).join("")}</div>
    ${pairsHtml}
    <div class="generator-diff">
      ${DAY_ORDER.map(day => {
        const dayChanges = changesByDay[day] || [];
        return `<div class="generator-diff-day"><strong>${DAY_NAMES[day]} ${result.plan.days[day].type === "training" ? "(A)" : "(R)"}</strong>
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
    editMode = true;
    currentModal.recipe = clone(currentModal.recipe);
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

function getIngredientCoupleHtml(ingredient, dayType) {
  const profile = getPortionProfile();
  if (profile !== "couple") return `<strong>${escapeHtml(getIngredientDisplay(ingredient, dayType))}</strong>`;
  const man = getPortionValue(ingredient, "man", dayType);
  const woman = getPortionValue(ingredient, "ipo", dayType);
  const manP = parseSimpleAmount(man);
  const womanP = parseSimpleAmount(woman);
  if (!manP.skip && !womanP.skip && !manP.free && !womanP.free && !manP.opaque && !womanP.opaque
      && manP.unit === womanP.unit && manP.value > 0 && womanP.value > 0) {
    const total = manP.value + womanP.value;
    const unit = manP.unit === "pz" ? " pz" : manP.unit;
    return `<span class="portion-sum"><strong>${formatNumber(total)}${unit}</strong> <small class="portion-detail">(Uomo: ${escapeHtml(man)} · Donna IPO: ${escapeHtml(woman)})</small></span>`;
  }
  return `<strong>${escapeHtml(getIngredientDisplay(ingredient, dayType))}</strong>`;
}

window.openRecipeModal = function(recipeId, dayKey = null, slot = null) {
  const recipe = getRecipe(recipeId);
  if (!recipe) return;
  currentModal = {
    recipe: clone(recipe),
    original: clone(recipe),
    dayKey: DAY_ORDER.includes(dayKey) ? dayKey : null,
    dayType: DAY_ORDER.includes(dayKey) ? getDayType(dayKey) : getRecipePreviewDayType(),
    slot: ["lunch", "dinner"].includes(slot) ? slot : null,
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

function renderModalContent() {
  const recipe = currentModal.recipe;
  const dayType = currentModal.dayType;
  const batches = modalBatchRule();
  const batchTab = document.querySelector('.tab-btn[data-target="tab-batch"]');
  const tabsBar = document.querySelector('.tabs');
  // Consultazione = schermata unica: ingredienti e preparazione restano
  // contemporaneamente visibili, come nella sezione DA CUCINARE.
  // Le tab restano disponibili solo in modalità modifica.
  tabsBar?.classList.toggle("hidden", !editMode);
  document.getElementById("tab-ingredients")?.classList.remove("hidden");
  document.getElementById("tab-prep")?.classList.toggle("hidden", editMode);
  // In modifica la visibilità delle tab è gestita dai click; in consultazione
  // (schermata unica) il blocco batch è visibile solo se pertinente.
  if (!editMode) document.getElementById("tab-batch")?.classList.toggle("hidden", !batches);
  batchTab.classList.toggle("hidden", !batches && !editMode);
  if (!editMode && document.querySelector('.tab-btn[data-target="tab-batch"]').classList.contains("active") && !batches) setModalTab("tab-ingredients");

  document.getElementById("modal-title").innerHTML = editMode
    ? `<input id="edit-recipe-name" class="modal-title-input" value="${escapeAttr(recipe.name)}">`
    : `<span class="recipe-code">${escapeHtml(recipe.id)}</span> ${escapeHtml(recipe.emoji || "🍲")} ${escapeHtml(getRecipeDisplayName(recipe, dayType))}`;
  const dayTypeLabel = currentModal.dayKey
    ? `${DAY_NAMES[currentModal.dayKey]} (${dayType === "training" ? "A" : "R"})`
    : "anteprima";
  const canToggle = !currentModal.dayKey && getPortionProfile() !== "ipo";
  const toggleHtml = canToggle ? `
    <span class="modal-daytype-toggle day-type-control" style="margin-left:8px">
      <button class="type-option training ${dayType === "training" ? "active" : ""}" onclick="setModalDayType('training')" title="Allenamento">A</button>
      <button class="type-option rest ${dayType === "rest" ? "active" : ""}" onclick="setModalDayType('rest')" title="Riposo">R</button>
    </span>` : "";
  document.getElementById("modal-time").innerHTML = editMode
    ? `<div class="edit-meta-grid"><label>Emoji<input id="edit-recipe-emoji" value="${escapeAttr(recipe.emoji || "🍲")}"></label><label>Tipo<select id="edit-recipe-slot">${MEAL_SLOTS.map(slot => `<option value="${slot.id}" ${recipe.slot === slot.id ? "selected" : ""}>${escapeHtml(slot.label)}</option>`).join("")}</select></label><label>
  Categoria proteica
<select
  id="edit-recipe-category"
  title="Opzionale: il generatore riconosce prima la proteina dagli ingredienti. Questa scelta viene usata solo se nessun ingrediente è riconoscibile."
>
  ${recipe.proteinCategory && !Object.prototype.hasOwnProperty.call(window.PianoDomain?.PROTEIN_CATEGORY_LABELS || {}, recipe.proteinCategory) ? `
    <option value="${escapeAttr(recipe.proteinCategory)}" selected>
      Valore precedente: ${escapeHtml(recipe.proteinCategory)}
    </option>
  ` : ""}
  <option value="">Automatica dagli ingredienti</option>
  ${Object.entries(window.PianoDomain?.PROTEIN_CATEGORY_LABELS || {}).map(([key, label]) => `
    <option value="${escapeAttr(key)}" ${recipe.proteinCategory === key ? "selected" : ""}>
      ${escapeHtml(label)}
    </option>
  `).join("")}
</select>
  <small>
    Opzionale: serve solo come fallback per ricette con ingredienti non riconoscibili.
  </small>
</label></div>`
    : `${escapeHtml(getSlotMeta(currentModal.slot || recipe.slot).label)} · ${dayTypeLabel} · ${escapeHtml(getProfileLabel())}${toggleHtml}${recipeIsCrossSlot(recipe, currentModal.slot) ? `<div class="modal-adapted-note">↻ Carboidrati trasformati in percentuale per il ${escapeHtml(getSlotMeta(currentModal.slot).label.toLowerCase())}</div>` : ""}`;

  const ingredientList = document.getElementById("modal-ingredients-list");
  if (editMode) {
    ingredientList.innerHTML = recipe.ingredients.map((ingredient, index) => `
      <li class="edit-ingredient" data-index="${index}">
        <input id="edit-ing-name-${index}" aria-label="Ingrediente" value="${escapeAttr(ingredient.name)}">
        <div class="portion-edit-grid"><label>IPO A<input id="edit-ing-ipo-training-${index}" value="${escapeAttr(getPortionValue(ingredient, "ipo", "training"))}"></label><label>IPO R<input id="edit-ing-ipo-rest-${index}" value="${escapeAttr(getPortionValue(ingredient, "ipo", "rest"))}"></label><label>Uomo A<input id="edit-ing-man-training-${index}" value="${escapeAttr(getPortionValue(ingredient, "man", "training"))}"></label><label>Uomo R<input id="edit-ing-man-rest-${index}" value="${escapeAttr(getPortionValue(ingredient, "man", "rest"))}"></label><button class="btn-icon remove-edit-item" onclick="removeIngredient(${index})">×</button></div>
      </li>`).join("") + `<li><button class="btn btn-outline full-width" onclick="addIngredient()">+ Aggiungi ingrediente</button></li>`;
  } else {
    const items = recipe.ingredients.map(ingredient => {
      const adapted = (currentModal.slot && window.PianoDomain)
        ? PianoDomain.adaptIngredientForSlot(ingredient, recipe.slot, currentModal.slot)
        : null;
      const ing = adapted ? { ...ingredient, name: adapted.name, portions: adapted.portions } : ingredient;
      return { ing, adapted: Boolean(adapted) };
    });
    const hasMeller = items.some(({ ing }) => !!getMellerAlternativesForIngredient(ing.name));
    ingredientList.innerHTML = items.map(({ ing, adapted }) => {
      const adaptedMark = adapted ? ` <small class="adapted-mark" title="Dose trasformata in percentuale per questo pasto">↻</small>` : "";
      if (getMellerAlternativesForIngredient(ing.name)) {
        return `<li class="meller-ingredient" onclick="openMellerAlternatives('${escapeAttr(ing.name)}')" title="Tocca per alternative Meller"><span>${escapeHtml(ing.name)} <small class="meller-hint">⇄</small></span>${getIngredientCoupleHtml(ing, dayType)}</li>`;
      }
      return `<li><span>${escapeHtml(ing.name)}${adaptedMark}</span>${getIngredientCoupleHtml(ing, dayType)}</li>`;
    }).join("") + (hasMeller ? `<li class="meller-footnote"><small>↑ Tocca carboidrati o proteine per le equivalenze Meller</small></li>` : "");
  }

  const prepList = document.getElementById("modal-prep-list");
  if (editMode) {
    prepList.innerHTML = recipe.steps.map((step, index) => `<li class="edit-step"><textarea id="edit-step-${index}">${escapeHtml(step)}</textarea><div><button class="btn-icon" onclick="moveStep(${index}, -1)">↑</button><button class="btn-icon" onclick="moveStep(${index}, 1)">↓</button><button class="btn-icon remove-edit-item" onclick="removeStep(${index})">×</button></div></li>`).join("") + `<li><button class="btn btn-outline full-width" onclick="addStep()">+ Aggiungi passaggio</button></li>`;
  } else {
    prepList.innerHTML = recipe.steps.map((step, index) => `<li class="step-item" onclick="this.classList.toggle('done')"><strong>${index + 1}.</strong> ${escapeHtml(step)}</li>`).join("");
    if (recipe.specialNote) prepList.innerHTML += `<li class="special-note"><strong>Importante:</strong> ${escapeHtml(recipe.specialNote)}</li>`;
    if (recipe.notes?.length) prepList.innerHTML += `<li class="recipe-notes"><strong>Note</strong><ul>${recipe.notes.map(note => `<li>${escapeHtml(note)}</li>`).join("")}</ul></li>`;
  }

  const batchContent = document.getElementById("modal-batch-text");
  if (editMode) {
    batchContent.innerHTML = `<label class="full-field">Nota speciale<textarea id="edit-recipe-special">${escapeHtml(recipe.specialNote || "")}</textarea></label><label class="full-field">Note (una per riga)<textarea id="edit-recipe-notes">${escapeHtml((recipe.notes || []).join("\n"))}</textarea></label>`;
  } else if (batches && batches.length) {
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
  document.getElementById("modal-duplicate-btn").classList.toggle("hidden", editMode || currentModal.isNew);
  document.getElementById("modal-save-btn").classList.toggle("hidden", !editMode);
  document.getElementById("modal-export-btn").classList.toggle("hidden", editMode || currentModal.isNew);
  document.getElementById("modal-share-btn").classList.toggle("hidden", editMode || currentModal.isNew);
  document.getElementById("modal-revert-btn").classList.toggle("hidden", editMode || !recipe._original);
  document.getElementById("modal-delete-btn").classList.toggle("hidden", editMode || currentModal.isNew);
  document.getElementById("modal-cancel-edit-btn").classList.toggle("hidden", !editMode);
  // "Altro" ha senso solo se nel foglio resta almeno un'azione disponibile.
  document.getElementById("modal-more-btn").classList.toggle(
    "hidden",
    editMode || (currentModal.isNew && !recipe._original)
  );
  setRecipeActionsOpen(false);
  document.getElementById("modal-edit-btn").textContent = "Modifica ricetta";
  document.getElementById("modal-save-btn").textContent = "Salva nel cloud";

  const mellerNotice = document.getElementById("modal-meller-notice");
  if (mellerNotice) mellerNotice.innerHTML = mellerNoticeHtml();
}

// Banner "dosi non adattate alle grammature del dott. Meller": elenca le dosi
// che superano il riferimento del pasto e offre l'adattamento con un click.
function mellerNoticeHtml() {
  if (!currentModal || !window.PianoDomain?.checkMellerAdaptation) return "";
  const check = PianoDomain.checkMellerAdaptation(currentModal.recipe);
  if (check.adapted) return "";
  const items = check.summary.slice(0, 4).map(item =>
    `<li><span>${escapeHtml(item.ingredient)}</span><strong>${formatNumber(item.actual)}${item.unit === "ml" ? " ml" : " g"} → ${item.expected}${item.unit === "ml" ? " ml" : " g"}</strong></li>`
  ).join("");
  const more = check.summary.length > 4
    ? `<li class="meller-notice-more">…e altre ${check.summary.length - 4} dosi fuori riferimento</li>`
    : "";
  return `
    <div class="meller-notice" role="note">
      <div class="meller-notice-head"><span aria-hidden="true">⚠️</span><div><strong>Dosi non adattate alle grammature del dott. Meller</strong><small>Riferimento per ${escapeHtml(getSlotMeta(currentModal.recipe.slot || "lunch").label.toLowerCase())} · pesi a crudo</small></div></div>
      <ul class="meller-notice-list">${items}${more}</ul>
      <button class="btn btn-outline meller-adapt-btn" type="button" onclick="adaptCurrentRecipeToMeller()">Adatta a Meller</button>
    </div>`;
}

// Adatta con un click le dosi ai riferimenti del dott. Meller. In lettura
// passa prima alla modifica (senza salvare nulla finché l'utente non conferma).
window.adaptCurrentRecipeToMeller = function() {
  if (!currentModal || !window.PianoDomain?.adaptRecipeToMeller) return;
  if (!editMode) {
    editMode = true;
    currentModal.recipe = clone(currentModal.recipe);
  }
  captureEditState();
  const result = PianoDomain.adaptRecipeToMeller(currentModal.recipe);
  if (!result.changed) {
    showToast("Le dosi rispettano già le grammature Meller");
    renderModalContent();
    return;
  }
  currentModal.recipe = result.recipe;
  renderModalContent();
  showToast("Dosi adattate a Meller ✅ Rivedi e salva");
};

function captureEditState() {
  if (!editMode || !currentModal) return;
  const recipe = currentModal.recipe;
  recipe.name = document.getElementById("edit-recipe-name")?.value.trim() || "Ricetta senza nome";
  recipe.emoji = document.getElementById("edit-recipe-emoji")?.value.trim() || "🍲";
  recipe.slot = document.getElementById("edit-recipe-slot")?.value || "lunch";
  recipe.proteinCategory = document.getElementById("edit-recipe-category")?.value.trim() || "";
  recipe.ingredients.forEach((ingredient, index) => {
    ingredient.name = document.getElementById(`edit-ing-name-${index}`)?.value.trim() || "Ingrediente";
    ingredient.portions = {
      ipoTraining: document.getElementById(`edit-ing-ipo-training-${index}`)?.value.trim() || "—",
      ipoRest: document.getElementById(`edit-ing-ipo-rest-${index}`)?.value.trim() || "—",
      manTraining: document.getElementById(`edit-ing-man-training-${index}`)?.value.trim() || "—",
      manRest: document.getElementById(`edit-ing-man-rest-${index}`)?.value.trim() || "—"
    };
  });
  recipe.steps = recipe.steps.map((_, index) => document.getElementById(`edit-step-${index}`)?.value.trim() || "");
  recipe.specialNote = document.getElementById("edit-recipe-special")?.value.trim() || "";
  recipe.notes = (document.getElementById("edit-recipe-notes")?.value || "").split("\n").map(note => note.trim()).filter(Boolean);
}

window.addIngredient = function() {
  captureEditState();
  currentModal.recipe.ingredients.push({ name: "Nuovo ingrediente", portions: { ipoTraining: "—", ipoRest: "—", manTraining: "—", manRest: "—" } });
  renderModalContent();
};

window.removeIngredient = function(index) {
  captureEditState();
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
  if (!recipe.ingredients.length || !recipe.steps.length) {
    showToast("Aggiungi almeno un ingrediente e un passaggio", true);
    return;
  }
  const mellerCheck = window.PianoDomain?.checkMellerAdaptation?.(recipe);
  if (mellerCheck && !mellerCheck.adapted) {
    showToast("⚠ Dosi non adattate a Meller: tocca “Adatta a Meller” per correggerle", true);
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
