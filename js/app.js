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

function getNextDay(dayKey) {
  return DAY_ORDER[(DAY_ORDER.indexOf(dayKey) + 1) % DAY_ORDER.length];
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
  return PianoDomain.activeBatch(
    dayKey,
    appState.plan,
    appState.plan.batchTemplates || [],
    appState.recipesById,
    getPortionProfile()
  );
}

// Retrocompatibilità: primo batch attivo (usato dal vecchio flusso).
function getActiveBatchRule(dayKey) {
  const batches = getActiveBatch(dayKey);
  return batches.length ? batches[0] : null;
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
    const [recipes, plan, shopping] = await Promise.all([
      getRecipeCatalog(), getWeeklyPlan(), getShoppingListCloud()
    ]);
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
      const container = document.getElementById("view-chef");
      container.classList.remove("hidden");
      container.innerHTML = `<div class="empty-state"><h2>Sincronizzazione non riuscita</h2><p>${escapeHtml(error.message || "Controlla la connessione e riprova.")}</p><button class="btn btn-primary" onclick="window.location.reload()">Riprova</button></div>`;
    }
  } finally {
    if (!silent) clearLoading();
  }
}

function applyState(recipes, plan, shopping) {
  setRecipes(recipes);
  appState.plan = window.PianoDomain ? PianoDomain.migratePlan(plan) : plan;
  appState.shopping = shopping;
  appState.deviceSettings = getLocalDeviceSettings();

  const today = getTodayKey();
  const dateKey = new Date().toLocaleDateString("sv-SE");
  if (appState.deviceSettings.lastOpenDate !== dateKey) {
    appState.deviceSettings.chefSelectedDay = today;
    appState.deviceSettings.lastOpenDate = dateKey;
    saveLocalDeviceSettings(appState.deviceSettings);
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
  if (!window.location.hash || !["#chef", "#week", "#recipes", "#shop", "#settings"].includes(window.location.hash)) {
    window.location.hash = "#chef";
  } else {
    handleRoute();
  }
}

// Ultima vista renderizzata: consente di far scorrere la settimana sul giorno
// corrente solo quando la si apre, non a ogni re-render della stessa vista.
let lastRenderedRoute = null;

function handleRoute() {
  if (!appState.user || !appState.plan) return;
  const hash = window.location.hash || "#chef";
  document.querySelectorAll(".view").forEach(view => view.classList.add("hidden"));
  document.querySelectorAll(".nav-item").forEach(item => item.classList.remove("active"));
  document.getElementById(`view-${hash.slice(1)}`)?.classList.remove("hidden");
  document.getElementById(`nav-${hash.slice(1)}`)?.classList.add("active");

  const enteringWeek = hash === "#week" && lastRenderedRoute !== "#week";
  if (hash === "#chef") renderChef();
  if (hash === "#week") renderWeek();
  if (hash === "#recipes") renderRecipes();
  if (hash === "#shop") renderShop();
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

function ingredientListHtml(recipe, dayType, compact = false) {
  if (!recipe) return "";
  return `<ul class="ingredient-list ${compact ? "compact" : ""}">${recipe.ingredients.map(ingredient => `
    <li class="step-item" onclick="this.classList.toggle('done')">
      <span>${escapeHtml(ingredient.name)}</span>
      <strong>${escapeHtml(getIngredientDisplay(ingredient, dayType))}</strong>
    </li>`).join("")}</ul>`;
}

function stepsHtml(recipe, compact = false) {
  if (!recipe) return "";
  return `<ol class="steps-list ${compact ? "compact" : ""}">${recipe.steps.map(step => `<li class="step-item" onclick="this.classList.toggle('done')">${escapeHtml(step)}</li>`).join("")}</ol>`;
}

function mealCardHtml(recipe, dayKey, slot, options = {}) {
  if (!recipe) {
    const meta = getSlotMeta(slot);
    return `<div class="card empty-meal-card"><span>${meta.emoji}</span><div><strong>Nessuna ${escapeHtml(meta.label.toLowerCase())} assegnata</strong><p>Crea una ricetta oppure scegline una dal ricettario.</p></div><button class="btn btn-outline" onclick="createNewRecipe('${slot}', '${dayKey}')">+ Crea</button></div>`;
  }
  const dayType = getDayType(dayKey);
  const typeLabel = dayType === "training" ? "A · Allenamento" : "R · Riposo";
  const context = `${DAY_NAMES[dayKey]} · ${typeLabel}`;
  return `
    <article class="card meal-card ${dayType}">
      <div class="meal-card-head">
        <div>
          <span class="recipe-code">${escapeHtml(recipe.id)}</span>
          <h3>${escapeHtml(recipe.emoji || "🍲")} ${escapeHtml(getRecipeDisplayName(recipe, dayType))}</h3>
          <p class="text-muted">${escapeHtml(context)} · ${escapeHtml(getProfileLabel())}</p>
        </div>
        ${options.swap ? `<button class="btn-icon btn-swap" title="Sostituisci ricetta" onclick="openSwapModal('${dayKey}', '${slot}')">🔄</button>` : ""}
      </div>
      ${options.open ? `<div class="meal-preview">${ingredientListHtml(recipe, dayType, true)}${stepsHtml(recipe, true)}</div>` : ""}
      <button class="btn ${options.primary ? "btn-primary" : "btn-outline"} meal-open-btn" onclick="openRecipeModal('${escapeAttr(recipe.id)}', '${dayKey}')">Vedi ricetta completa</button>
    </article>`;
}

window.changeChefDay = function(dayKey) {
  if (!DAY_ORDER.includes(dayKey)) return;
  appState.deviceSettings.chefSelectedDay = dayKey;
  saveLocalDeviceSettings(appState.deviceSettings);
  renderChef();
};

const BATCH_STATUS_LABELS = {
  today: { label: "Prepara oggi", className: "today" },
  fresh: { label: "Prepara al momento", className: "fresh" },
  later: { label: "Non ancora preparabile", className: "later" }
};

// Raccolta dei task dei batch attivi per il giorno, senza duplicati per ID.
function collectBatchTasks(dayKey) {
  const batches = getActiveBatch(dayKey);
  const byId = new Map();
  batches.forEach(batch => {
    (batch.tasks || []).forEach(task => {
      if (byId.has(task.id)) return;
      byId.set(task.id, {
        ...task,
        targetDay: batch.targetDay,
        daysUntilTarget: batch.daysUntilTarget,
        templateTitle: batch.template.title || "Preparazioni in anticipo"
      });
    });
  });
  return [...byId.values()];
}

function renderBatchCard(dayKey) {
  const tasks = collectBatchTasks(dayKey);
  if (!tasks.length) return "";
  const targetInfo = [...new Set(tasks.map(task =>
    `pranzo di ${DAY_NAMES[task.targetDay]} · tra ${task.daysUntilTarget} ${task.daysUntilTarget === 1 ? "giorno" : "giorni"}`
  ))];
  const title = tasks[0].templateTitle || "Preparazioni in anticipo";
  return `
    <section class="batch-card">
      <div class="batch-title"><span>🍳</span><div><small>Batch cooking attivo</small><h3>${escapeHtml(title)}</h3></div></div>
      <p class="batch-next"><strong>🎯 ${escapeHtml(targetInfo.join(" · "))}</strong></p>
      <ol>${tasks.map(task => {
        const status = BATCH_STATUS_LABELS[task.status] || BATCH_STATUS_LABELS.later;
        const method = task.storage?.method === "fridge" ? "frigo" : (task.storage?.method || "frigo");
        const maxDays = task.storage?.maxDays;
        const storageNote = maxDays === 0
          ? "Fresco: da preparare al momento"
          : `Conservazione: ${escapeHtml(method)} · max ${maxDays} ${maxDays === 1 ? "giorno" : "giorni"}`;
        return `<li class="step-item batch-task">
          <span class="batch-task-label">${escapeHtml(task.label)}</span>
          <span class="batch-task-status ${status.className}">${status.label}</span>
          ${task.quantity ? `<span class="batch-task-quantity">${escapeHtml(task.quantity)}</span>` : ""}
          <small class="batch-task-storage">${storageNote}${task.storage?.instructions ? ` · ${escapeHtml(task.storage.instructions)}` : ""}</small>
        </li>`;
      }).join("")}</ol>
    </section>`;
}

function renderChef() {
  const container = document.getElementById("view-chef");
  const selectedDay = appState.deviceSettings.chefSelectedDay || getTodayKey();
  const nextDay = getNextDay(selectedDay);
  const dinner = getPlannedRecipe(selectedDay, "dinner");
  const nextLunch = getPlannedRecipe(nextDay, "lunch");
  const activeBatch = getActiveBatch(selectedDay);
  const daytimeSlots = ["breakfast", "snack1", "lunch", "snack2"];

  container.innerHTML = `
    <div class="page-heading chef-heading">
      <div><p class="eyebrow">Il tuo piano completo</p><h1>Pasti di oggi</h1></div>
      <select aria-label="Giorno da visualizzare" onchange="changeChefDay(this.value)">
        ${DAY_ORDER.map(day => `<option value="${day}" ${selectedDay === day ? "selected" : ""}>${DAY_NAMES[day]}</option>`).join("")}
      </select>
    </div>
    <div class="day-summary ${getDayType(selectedDay)}">
      <span class="day-type-badge">${getDayType(selectedDay) === "training" ? "A" : "R"}</span>
      <div><strong>${DAY_NAMES[selectedDay]}</strong><small>${getDayType(selectedDay) === "training" ? "Allenamento" : "Riposo"}</small></div>
    </div>

    <section class="chef-section">
      <div class="section-title"><span>🌅</span><div><small>Colazione, spuntini e pranzo</small><h2>Durante la giornata</h2></div></div>
      <div class="daily-meals-grid">
        ${daytimeSlots.map(slot => {
          const meta = getSlotMeta(slot);
          return `<div class="daily-meal-wrap"><div class="daily-slot-label">${meta.emoji} ${escapeHtml(meta.label)}</div>${mealCardHtml(getPlannedRecipe(selectedDay, slot), selectedDay, slot)}</div>`;
        }).join("")}
      </div>
    </section>

    <section class="chef-section">
      <div class="section-title"><span>🌙</span><div><small>Da cucinare</small><h2>Cena di stasera</h2></div></div>
      ${mealCardHtml(dinner, selectedDay, "dinner", { open: true, primary: true })}
    </section>

    ${renderBatchCard(selectedDay)}

    <section class="chef-section tomorrow-section">
      <div class="section-title"><span>🍱</span><div><small>${activeBatch.length ? "Incluso nel batch cooking" : "Prossimo pranzo"}</small><h2>Pranzo di ${DAY_NAMES[nextDay]}</h2></div></div>
      ${mealCardHtml(nextLunch, nextDay, "lunch")}
    </section>
  `;
}

function recipeIsFish(recipe) {
  return /(pesce|salmone|sgombro|mollusch|crostace|tonno|merluzzo)/i.test(recipe?.proteinCategory || "");
}

function analyzeWeeklyPlan() {
  const counts = { poultry: 0, beef: 0, omega: 0, otherFish: 0, dairy: 0, eggs: 0, legumes: 0 };
  const doubleFishDays = [];
  DAY_ORDER.forEach(day => {
    const recipes = [getPlannedRecipe(day, "lunch"), getPlannedRecipe(day, "dinner")].filter(Boolean);
    if (recipes.filter(recipeIsFish).length > 1) doubleFishDays.push(DAY_NAMES[day]);
    recipes.forEach(recipe => {
      const category = recipe.proteinCategory || "";
      if (/pollame/i.test(category)) counts.poultry++;
      if (/manzo|vitello/i.test(category)) counts.beef++;
      if (/omega-3/i.test(category)) counts.omega++;
      else if (recipeIsFish(recipe)) counts.otherFish++;
      if (/latticini/i.test(category)) counts.dairy++;
      if (/uova/i.test(category)) counts.eggs++;
      if (/legumi/i.test(category)) counts.legumes++;
    });
  });

  const checks = [
    { label: "Pollame", value: counts.poultry, target: "1-2", ok: counts.poultry >= 1 && counts.poultry <= 2 },
    { label: "Manzo/Vitello", value: counts.beef, target: "max 1", ok: counts.beef <= 1 },
    { label: "Pesce omega-3", value: counts.omega, target: "2-3", ok: counts.omega >= 2 && counts.omega <= 3 },
    { label: "Altro pesce/molluschi", value: counts.otherFish, target: "1-2", ok: counts.otherFish >= 1 && counts.otherFish <= 2 },
    { label: "Latticini/Formaggi", value: counts.dairy, target: "1-2", ok: counts.dairy >= 1 && counts.dairy <= 2 },
    { label: "Uova", value: counts.eggs, target: "1-2", ok: counts.eggs >= 1 && counts.eggs <= 2 },
    { label: "Legumi", value: counts.legumes, target: "almeno 3", ok: counts.legumes >= 3 }
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
                <button class="week-meal-name" onclick="openRecipeModal('${escapeAttr(recipe?.id || "")}', '${day}')">${escapeHtml(recipe?.emoji || "")} ${escapeHtml(recipe ? getRecipeDisplayName(recipe, planDay.type) : "Non disponibile")}</button>
                <button class="btn-icon btn-swap" onclick="openMealActions('${day}', '${slot.id}')" title="Operazioni sul pasto" aria-label="Operazioni sul pasto">⋯</button>
              </div>`;
            }).join("")}
            ${getActiveBatch(day).length ? `<div class="batch-active-chip">🍳 Batch cooking disponibile</div>` : ""}
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
}

window.openSwapModal = function(dayKey, slot) {
  const modal = document.getElementById("swap-modal");
  const slotMeta = getSlotMeta(slot);
  document.getElementById("swap-title").textContent = `${DAY_NAMES[dayKey]} · ${slotMeta.label}`;
  const currentId = appState.plan.days[dayKey][slot];
  const defaultId = appState.plan.defaultDays?.[dayKey]?.[slot];
  const recipes = appState.recipes.filter(recipe => recipe.slot === slot);
  const resetButton = defaultId && defaultId !== currentId ? `
    <button class="swap-item reset" onclick="confirmSwap('${dayKey}', '${slot}', '${escapeAttr(defaultId)}')">
      <span><strong>↩ Ripristina scelta iniziale</strong><small>${escapeHtml(getRecipe(defaultId) ? getRecipeDisplayName(getRecipe(defaultId), getDayType(dayKey)) : defaultId)}</small></span>
    </button>` : "";
  document.getElementById("swap-options-list").innerHTML = `
    ${resetButton}
    ${recipes.map(recipe => `<button class="swap-item ${recipe.id === currentId ? "selected" : ""}" onclick="confirmSwap('${dayKey}', '${slot}', '${escapeAttr(recipe.id)}')"><span class="swap-code">${escapeHtml(recipe.id)}</span><span><strong>${escapeHtml(recipe.emoji || "🍲")} ${escapeHtml(getRecipeDisplayName(recipe, getDayType(dayKey)))}</strong><small>${escapeHtml(recipe.proteinCategory || "")}</small></span>${recipe.id === currentId ? "<b>✓</b>" : ""}</button>`).join("")}`;
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
  container.innerHTML = `
    <div class="page-heading recipes-heading">
      <div><p class="eyebrow">${appState.recipes.length} ricette · sincronizzate nel cloud</p><h1>Ricettario</h1><p>Puoi creare, esportare, importare e condividere le ricette del tuo account.</p></div>
      <div class="recipe-toolbar">
        <button class="btn btn-outline" onclick="openIncomingShares()">📥 Ricevute</button>
        <label class="btn btn-outline file-import-button">Importa<input type="file" accept="application/json,.json" onchange="prepareRecipeImport(this.files[0]); this.value='' "></label>
        <button class="btn btn-outline" onclick="exportAllRecipes()">Esporta</button>
        <button class="btn btn-outline" onclick="openShareDialog()">Invia tutte</button>
        ${appState.recipes.length ? `<button class="btn btn-danger" onclick="deleteAllRecipes()">🗑 Elimina tutte</button>` : ""}
        <button class="btn btn-primary" onclick="createNewRecipe()">+ Nuova</button>
      </div>
    </div>
    ${appState.recipes.length ? `<label class="search-box"><span>⌕</span><input id="recipe-search" type="search" placeholder="Cerca ricetta, categoria o ingrediente…" oninput="filterRecipeCards(this.value)"></label>${MEAL_SLOTS.map(slot => recipeSectionHtml(slot.label, appState.recipes.filter(recipe => recipe.slot === slot.id), slot)).join("")}` : `<div class="empty-state recipe-empty-state"><span>🍲</span><h2>Il tuo ricettario è vuoto</h2><p>Puoi creare la prima ricetta manualmente, importare un file JSON o attendere una condivisione da un altro utente.</p><button class="btn btn-primary" onclick="createNewRecipe()">+ Crea la prima ricetta</button></div>`}
  `;
}

function recipeSectionHtml(title, recipes, slot) {
  if (!recipes.length) return "";
  const sectionId = `recipe-section-${slot.id}`;
  return `
    <section class="recipe-library-section">
      <button class="recipe-section-toggle collapsed" onclick="toggleRecipeSection('${slot.id}', this)" aria-expanded="false">
        <span class="section-title" style="margin:0"><span>${slot.emoji}</span><div><small>${recipes.length} proposte</small><h2>${escapeHtml(title)}</h2></div></span>
        <b class="recipe-section-chevron">⌄</b>
      </button>
      <div id="${sectionId}" class="recipe-section-body hidden">
        <div class="recipe-grid">
          ${recipes.map(recipe => `<button class="recipe-library-card" data-search="${escapeAttr(`${recipe.id} ${recipe.name} ${recipe.namesByDayType?.training || ""} ${recipe.namesByDayType?.rest || ""} ${recipe.proteinCategory} ${(recipe.ingredients || []).map(i => i.name).join(" ")}`.toLowerCase())}" onclick="openRecipeModal('${escapeAttr(recipe.id)}')"><span class="recipe-code">${escapeHtml(recipe.id)}</span><span class="recipe-card-emoji">${escapeHtml(recipe.emoji || "🍲")}</span><strong>${escapeHtml(recipe.name)}</strong><small>${escapeHtml(recipe.proteinCategory || "")}</small><span class="frequency-chip">${escapeHtml(recipe.frequency || "")}</span></button>`).join("")}
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
};

window.filterRecipeCards = function(query) {
  const normalized = String(query || "").trim().toLowerCase();
  document.querySelectorAll(".recipe-library-section").forEach(section => {
    const cards = [...section.querySelectorAll(".recipe-library-card")];
    let matchingCards = 0;
    cards.forEach(card => {
      const matches = !normalized || card.dataset.search.includes(normalized);
      card.classList.toggle("hidden", !matches);
      if (matches) matchingCards += 1;
    });

    const toggle = section.querySelector(".recipe-section-toggle");
    const body = section.querySelector(".recipe-section-body");
    if (!normalized) {
      section.classList.remove("hidden");
      body?.classList.add("hidden");
      toggle?.classList.add("collapsed");
      toggle?.setAttribute("aria-expanded", "false");
      return;
    }

    section.classList.toggle("hidden", matchingCards === 0);
    body?.classList.toggle("hidden", matchingCards === 0);
    toggle?.classList.toggle("collapsed", matchingCards === 0);
    toggle?.setAttribute("aria-expanded", String(matchingCards > 0));
  });
};

window.createNewRecipe = function(slot = "lunch", assignDay = null) {
  const selectedSlot = MEAL_SLOTS.some(item => item.id === slot) ? slot : "lunch";
  const id = `U${Date.now()}`;
  const recipe = {
    id, slot: selectedSlot, name: "Nuova ricetta", emoji: getSlotMeta(selectedSlot).emoji, proteinCategory: "", frequency: "",
    ingredients: [], steps: [], notes: [], specialNote: ""
  };
  currentModal = { recipe, original: null, dayKey: DAY_ORDER.includes(assignDay) ? assignDay : null, dayType: DAY_ORDER.includes(assignDay) ? getDayType(assignDay) : "training", assignAfterSave: DAY_ORDER.includes(assignDay) ? { day: assignDay, slot: selectedSlot } : null, isNew: true };
  editMode = true;
  renderModalContent();
  document.getElementById("recipe-modal").classList.remove("hidden");
};

function normalizeIngredientName(name) {
  return String(name || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ").trim();
}

function getCategoryForIngredient(name) {
  const value = normalizeIngredientName(name);
  const has = (...terms) => terms.some(term => value.includes(term));
  if (has("pollo", "tacchino", "vitello", "manzo")) return "🥩 Carne";
  if (has("salmone", "sgombro", "merluzzo", "tonno", "gamber", "calamar", "polpo")) return "🐟 Pesce";
  if (has("uov", "ricotta", "mozzarella", "caprino", "feta", "parmigiano", "fiocchi di latte", "yogurt", "skyr", "kefir", "latte")) return "🥚 Uova e latticini";
  if (has("ceci", "lenticch", "fagiol", "edamame", "piselli")) return "🫘 Legumi";
  if (has("pasta", "riso", "orzo", "farro", "quinoa", "cous cous", "pane", "patate", "farina di ceci", "polenta", "cracker", "trofie", "avena", "cereali", "fette biscottate", "wasa", "granola")) return "🍚 Carboidrati";
  if (has("pesca", "mango", "anguria", "melone", "avocado", "lampon", "limone", "lime", "albicocc", "cilieg", "mirtill", "ananas", "frutta fresca", "frutti di bosco")) return "🍑 Frutta";
  if (has("zucchin", "pomodor", "friggitell", "peperon", "melanzan", "rucola", "cetriolo", "carota", "fagiolini", "spinacin", "lattuga", "songino", "sedano", "verdura", "cipolla")) return "🥬 Verdura";
  if (has("olio", "olive", "mandorle", "noci", "pistacchi", "semi", "pesto", "capperi", "brodo", "salsa di soia", "aceto", "cacao", "cioccolato", "marmellata", "confettura", "miele", "sciroppo", "dolcificante", "cocco", "proteine whey")) return "🥫 Dispensa";
  return "🌿 Spezie e aromi";
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

function renderShop() {
  const container = document.getElementById("view-shop");
  const entries = getVisibleShoppingEntries();
  const grouped = Object.fromEntries(SHOP_CATEGORY_ORDER.map(category => [category, entries.filter(entry => entry.category === category)]));
  const allSelected = DAY_ORDER.every(day => MEAL_SLOTS.every(slot => (appState.shopping.selectedMeals[day] || []).includes(slot.id)));
  container.innerHTML = `
    <div class="page-heading shop-heading"><div><p class="eyebrow">Dosi esatte · ${escapeHtml(getProfileLabel())}</p><h1>Lista della spesa</h1><p>Le quantità derivano solo dai pasti selezionati, senza fattori percentuali.</p></div><button class="btn btn-outline" onclick="toggleShopSettings()">${shopSettingsVisible ? "Chiudi" : "Seleziona"}</button></div>
    ${shopSettingsVisible ? renderShopSettings(allSelected) : ""}
    <div class="shopping-summary"><strong>${entries.length} alimenti</strong><span>${DAY_ORDER.reduce((sum, day) => sum + (appState.shopping.selectedMeals[day] || []).length, 0)} pasti selezionati</span></div>
    ${SHOP_CATEGORY_ORDER.map(category => grouped[category].length ? `
      <section class="shop-category">
        <h2 class="shop-category-title">${category}</h2>
        ${grouped[category].map(entry => `<div class="shop-item"><div class="shop-item-details"><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.tags.join(" · "))}</small></div><input class="shop-amount-input" aria-label="Quantità ${escapeAttr(entry.name)}" value="${escapeAttr(shoppingAmountText(entry))}" onchange="updateShopItemQty('${escapeAttr(entry.id)}', this.value)"><button class="btn-icon remove-shop-item" title="Escludi" onclick="excludeShopItem('${escapeAttr(entry.id)}')">×</button></div>`).join("")}
      </section>` : "").join("")}
    ${entries.length ? `<div class="shop-actions"><button class="btn btn-outline" onclick="copyShopList()">📋 Copia</button><button class="btn btn-primary whatsapp-btn" onclick="shareShopWhatsApp()">Condividi</button></div>` : `<div class="empty-state"><span>🛒</span><h3>Lista vuota</h3><p>Apri “Seleziona” e scegli almeno un pasto.</p></div>`}
  `;
}

function renderShopSettings(allSelected) {
  const excludedCount = (appState.shopping.excludedItems || []).length;
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
      ${excludedCount ? `<div class="excluded-list"><h3>Esclusi (${excludedCount})</h3>${appState.shopping.excludedItems.map(id => `<button class="frequency-chip" onclick="includeShopItem('${escapeAttr(id)}')">${escapeHtml(id.replaceAll("-", " "))} ×</button>`).join(" ")}</div>` : ""}
    </section>`;
}

window.toggleShopSettings = function() {
  shopSettingsVisible = !shopSettingsVisible;
  renderShop();
};

window.toggleShopAllWeek = async function(select) {
  DAY_ORDER.forEach(day => { appState.shopping.selectedMeals[day] = select ? MEAL_SLOTS.map(slot => slot.id) : []; });
  await saveShoppingListCloud(appState.shopping);
  renderShop();
};

window.toggleShopDay = async function(day) {
  if (!DAY_ORDER.includes(day)) return;
  const selected = appState.shopping.selectedMeals[day] || [];
  const allSelected = MEAL_SLOTS.every(slot => selected.includes(slot.id));
  appState.shopping.selectedMeals[day] = allSelected ? [] : MEAL_SLOTS.map(slot => slot.id);
  await saveShoppingListCloud(appState.shopping);
  renderShop();
};

window.toggleShopMeal = async function(day, slot, checked) {
  const selected = new Set(appState.shopping.selectedMeals[day] || []);
  checked ? selected.add(slot) : selected.delete(slot);
  appState.shopping.selectedMeals[day] = [...selected];
  await saveShoppingListCloud(appState.shopping);
  renderShop();
};

window.toggleShopPantry = async function(checked) {
  appState.shopping.includePantry = checked;
  await saveShoppingListCloud(appState.shopping);
  renderShop();
};

window.updateShopItemQty = async function(id, value) {
  appState.shopping.customQuantities[id] = value;
  await saveShoppingListCloud(appState.shopping);
};

window.excludeShopItem = async function(id) {
  if (!appState.shopping.excludedItems.includes(id)) appState.shopping.excludedItems.push(id);
  await saveShoppingListCloud(appState.shopping);
  renderShop();
};

window.includeShopItem = async function(id) {
  appState.shopping.excludedItems = appState.shopping.excludedItems.filter(value => value !== id);
  await saveShoppingListCloud(appState.shopping);
  renderShop();
};

function shoppingText() {
  const entries = getVisibleShoppingEntries();
  const blocks = SHOP_CATEGORY_ORDER.map(category => {
    const items = entries.filter(entry => entry.category === category);
    if (!items.length) return "";
    return `----- ${category}\n${items.map(entry => `${entry.name} - ${shoppingAmountText(entry)}`).join("\n")}`;
  }).filter(Boolean);
  return `🛒 Lista della spesa · ${getProfileLabel()}\n\n${blocks.join("\n\n")}`;
}

window.copyShopList = async function() {
  const text = shoppingText();
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

function guideDayHtml(dayGuide, tone) {
  return `
    <div class="guide-day ${tone}">
      <h3>${escapeHtml(dayGuide.title)}</h3>
      ${dayGuide.meals.map(meal => `<div class="guide-meal"><h4>${escapeHtml(meal.title)}</h4><ul>${meal.lines.map(line => `<li>${escapeHtml(line)}</li>`).join("")}</ul></div>`).join("")}
      <p class="guide-macro"><strong>Macro medie:</strong> ${escapeHtml(dayGuide.macro)}</p>
    </div>`;
}

function alternativesTableHtml(group) {
  return `<div class="alternative-table"><h3>${escapeHtml(group.title)}</h3>${group.rows.map(row => `<div><span>${escapeHtml(row[0])}</span><strong>${escapeHtml(row[1])}</strong></div>`).join("")}</div>`;
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

    <div class="manual-heading"><p class="eyebrow">INDICAZIONI DI MELLER</p><h2>Manuale dieta e alternative</h2><p>Le alternative originali restano sempre consultabili nell'app.</p></div>

    ${settingsAccordion("Struttura della dieta", `<ul class="guide-list">${MELLER_GUIDE.structure.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`)}
    ${settingsAccordion("Giorno di allenamento", guideDayHtml(MELLER_GUIDE.trainingDay, "training"))}
    ${settingsAccordion("Giorno di riposo", guideDayHtml(MELLER_GUIDE.restDay, "rest"))}
    ${settingsAccordion("Alternative alimentari di Meller", `<div class="alternatives-grid">${alternativesTableHtml(MELLER_GUIDE.alternatives.carbohydrates)}${alternativesTableHtml(MELLER_GUIDE.alternatives.proteins)}</div>`)}
    ${settingsAccordion("Frequenze proteiche", `<div class="alternative-table frequency-table">${MELLER_GUIDE.proteinFrequencies.map(row => `<div><span>${escapeHtml(row[0])}</span><strong>${escapeHtml(row[1])}</strong></div>`).join("")}</div>`)}
    ${settingsAccordion("Integrazione Syform", `<ul class="guide-list">${MELLER_GUIDE.integration.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`)}
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
  return `
    <section class="settings-section backup-section">
      <div class="flex-between"><h2>Backup e annullamento</h2><span class="recipe-code">Copia di sicurezza automatica</span></div>
      ${hasBackup ? `
        <div class="backup-meta">
          <div><small>Ultima operazione</small><strong>${escapeHtml(meta.operation || "—")}</strong></div>
          <div><small>Descrizione</small><strong>${escapeHtml(meta.description || "—")}</strong></div>
          <div><small>Data backup</small><strong>${escapeHtml(formatBackupDate(meta.createdAt) || "—")}</strong></div>
        </div>
        <button class="btn btn-danger full-width" onclick="undoLastModification()">↩ Annulla ultima modifica</button>
        <p class="text-muted backup-note">Il ripristino è disponibile una sola volta: dopo il ripristino la copia di sicurezza viene eliminata.</p>
      ` : `
        <p class="text-muted backup-note">Nessun backup disponibile. Prima delle operazioni distruttive (importazione “Sostituisci tutte”, accettazione di una condivisione con sostituzione, applicazione del generatore settimana) viene salvata una copia di catalogo, piano e lista spesa.</p>
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
    writeLocalJson("backup_meta", null);
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
        <label class="share-username-field">Username destinatario<input id="share-recipient-username" autocomplete="off" autocapitalize="none" placeholder="es. mario"></label>
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
        <label class="share-username-field">Username da collegare<input id="account-link-username" autocomplete="off" autocapitalize="none" placeholder="es. anna"></label>
        <p class="text-muted transfer-privacy-note">Prima dell'invio verrà creato un backup del tuo stato corrente.</p>
        <button id="account-link-send-button" class="btn btn-primary full-width" onclick="submitAccountLink()">Invia richiesta di collegamento</button>
      </div>
    </div>`);
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
    [incomingRecipeShares, incomingAccountLinks] = await Promise.all([
      getPendingRecipeShares(),
      getPendingAccountLinks()
    ]);
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
  beef: "Manzo/Vitello",
  omega: "Pesce omega-3",
  otherFish: "Altro pesce",
  dairy: "Latticini",
  eggs: "Uova",
  legumes: "Legumi"
};

let generatorState = { seed: null, blocks: {}, proposal: null };

function setupGeneratorModal() {
  if (document.getElementById("generator-modal")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="generator-modal" class="modal hidden" role="dialog" aria-modal="true">
      <div class="modal-content generator-modal-content">
        <div class="modal-header"><div><p class="eyebrow">GENERATORE</p><h2>Genera settimana</h2></div><button class="btn-icon" onclick="closeGeneratorModal()">&times;</button></div>
        <p class="text-muted">Proposta rispettosa di A/R e frequenze proteiche. Non modifica mai i dosaggi. Prima dell'applicazione viene creato un backup.</p>
        <div class="generator-controls">
          <label class="share-username-field">Seed (risultato riproducibile)<input id="generator-seed" type="text" inputmode="numeric" placeholder="es. 42" onchange="generatorSeedChanged(this.value)"></label>
          <button class="btn btn-outline" onclick="computeGeneratorProposal(true)">Rigenera (nuovo seed)</button>
          <button class="btn btn-primary" onclick="computeGeneratorProposal(false)">Anteprima</button>
        </div>
        <div id="generator-blocks" class="generator-blocks"></div>
        <div id="generator-preview" class="generator-preview"></div>
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="closeGeneratorModal()">Annulla</button>
          <button class="btn btn-primary" id="generator-apply-btn" onclick="applyGenerator()">Applica</button>
        </div>
      </div>
    </div>`);
}

window.openGeneratorModal = function() {
  generatorState = { seed: Math.floor(Math.random() * 1000000), blocks: {}, proposal: null };
  renderGeneratorModal();
  document.getElementById("generator-modal").classList.remove("hidden");
};

window.closeGeneratorModal = function() {
  document.getElementById("generator-modal")?.classList.add("hidden");
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

function renderGeneratorBlocks() {
  return `<div class="generator-blocks-title"><strong>Blocca / sblocca pasto</strong><small>Gli elementi bloccati non vengono sovrascritti dalla generazione.</small></div>
    <div class="generator-block-table">
      ${DAY_ORDER.map(day => {
        const block = generatorState.blocks[day];
        const dayLocked = Boolean(block?.all);
        return `<div class="generator-block-row">
          <label class="generator-day-lock"><input type="checkbox" ${dayLocked ? "checked" : ""} onchange="toggleGeneratorDayLock('${day}', this.checked)"> ${DAY_NAMES[day]}</label>
          <div class="generator-slot-locks">${MEAL_SLOTS.map(slot => `<label class="${dayLocked ? "locked" : ""}"><input type="checkbox" ${dayLocked || block?.[slot.id] ? "checked" : ""} ${dayLocked ? "disabled" : ""} onchange="toggleGeneratorSlotLock('${day}', '${slot.id}', this.checked)"> ${escapeHtml(slot.shortLabel)}</label>`).join("")}</div>
        </div>`;
      }).join("")}
    </div>`;
}

window.computeGeneratorProposal = function(newSeed) {
  if (newSeed) generatorState.seed = Math.floor(Math.random() * 1000000);
  const result = window.PianoDomain
    ? PianoDomain.generateWeek(appState.recipes, {
        plan: appState.plan,
        seed: generatorState.seed ?? Date.now(),
        blocks: generatorState.blocks,
        templates: appState.plan.batchTemplates || []
      })
    : null;
  if (!result) {
    showToast("Generatore non disponibile", true);
    return;
  }
  generatorState.proposal = result;
  document.getElementById("generator-seed").value = String(result.seed ?? generatorState.seed ?? "");
  renderGeneratorPreview();
};

function generatorRecipeName(recipeId) {
  const recipe = getRecipe(recipeId);
  return recipe ? `${recipe.emoji || "🍲"} ${recipe.name}` : (recipeId || "—");
}

function renderGeneratorPreview() {
  const preview = document.getElementById("generator-preview");
  const result = generatorState.proposal;
  if (!result) {
    preview.innerHTML = "";
    return;
  }
  const changes = window.PianoDomain ? PianoDomain.diffPlans(appState.plan, result.plan) : [];
  const changesByDay = {};
  changes.forEach(change => {
    if (!changesByDay[change.day]) changesByDay[change.day] = [];
    changesByDay[change.day].push(change);
  });
  preview.innerHTML = `
    <div class="generator-preview-head"><strong>Anteprima proposta</strong><span>${changes.length} modifiche</span></div>
    ${result.warnings.length ? `<div class="generator-warnings">${result.warnings.map(warning => `<p>⚠️ ${escapeHtml(warning)}</p>`).join("")}</div>` : ""}
    <div class="generator-counts">${Object.entries(result.counts).map(([key, value]) => `<span>${escapeHtml(GENERATOR_COUNT_LABELS[key] || key)}: ${value}</span>`).join("")}</div>
    <div class="generator-diff">
      ${DAY_ORDER.map(day => {
        const dayChanges = changesByDay[day] || [];
        return `<div class="generator-diff-day"><strong>${DAY_NAMES[day]} ${result.plan.days[day].type === "training" ? "(A)" : "(R)"}</strong>
          ${MEAL_SLOTS.map(slot => {
            const change = dayChanges.find(item => item.slot === slot.id);
            const from = change?.from ?? appState.plan.days[day][slot.id];
            const to = change?.to ?? result.plan.days[day][slot.id];
            return `<div class="generator-diff-slot ${change ? "changed" : ""}"><small>${escapeHtml(slot.shortLabel)}</small><span>${change ? `↻ ${escapeHtml(generatorRecipeName(from))} → ${escapeHtml(generatorRecipeName(to))}` : escapeHtml(generatorRecipeName(to))}</span></div>`;
          }).join("")}
        </div>`;
      }).join("")}
    </div>`;
}

function renderGeneratorModal() {
  document.getElementById("generator-seed").value = generatorState.seed ?? "";
  document.getElementById("generator-blocks").innerHTML = renderGeneratorBlocks();
  renderGeneratorPreview();
}

window.applyGenerator = async function() {
  if (!generatorState.proposal) {
    showToast("Genera prima un'anteprima", true);
    return;
  }
  const changes = window.PianoDomain ? PianoDomain.diffPlans(appState.plan, generatorState.proposal.plan).length : 0;
  if (!confirm(`Applicare la settimana generata (${changes} modifiche)? Verrà creato un backup prima dell'applicazione.`)) return;
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
  document.getElementById("recipe-modal").addEventListener("click", event => {
    if (event.target.id === "recipe-modal") closeRecipeModal();
  });
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
  document.getElementById("modal-save-btn").addEventListener("click", saveRecipeEdit);
  document.getElementById("modal-revert-btn").addEventListener("click", revertRecipe);
  document.getElementById("modal-export-btn").addEventListener("click", exportCurrentRecipe);
  document.getElementById("modal-share-btn").addEventListener("click", () => openShareDialog(currentModal?.recipe?.id));
  document.getElementById("modal-delete-btn").addEventListener("click", deleteCurrentRecipe);
}

window.setModalDayType = function(type) {
  if (!currentModal || currentModal.dayKey) return;
  if (!["training", "rest"].includes(type)) return;
  currentModal.dayType = type;
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

window.openRecipeModal = function(recipeId, dayKey = null) {
  const recipe = getRecipe(recipeId);
  if (!recipe) return;
  currentModal = {
    recipe: clone(recipe),
    original: clone(recipe),
    dayKey: DAY_ORDER.includes(dayKey) ? dayKey : null,
    dayType: DAY_ORDER.includes(dayKey) ? getDayType(dayKey) : "training",
    isNew: false
  };
  editMode = false;
  renderModalContent();
  document.getElementById("recipe-modal").classList.remove("hidden");
};

function closeRecipeModal() {
  document.getElementById("recipe-modal").classList.add("hidden");
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
    ? `<div class="edit-meta-grid"><label>Emoji<input id="edit-recipe-emoji" value="${escapeAttr(recipe.emoji || "🍲")}"></label><label>Tipo<select id="edit-recipe-slot">${MEAL_SLOTS.map(slot => `<option value="${slot.id}" ${recipe.slot === slot.id ? "selected" : ""}>${escapeHtml(slot.label)}</option>`).join("")}</select></label><label>Categoria<input id="edit-recipe-category" value="${escapeAttr(recipe.proteinCategory || "")}"></label><label>Frequenza<input id="edit-recipe-frequency" value="${escapeAttr(recipe.frequency || "")}"></label></div>`
    : `${escapeHtml(getSlotMeta(recipe.slot).label)} · ${dayTypeLabel} · ${escapeHtml(getProfileLabel())}${toggleHtml}`;

  const ingredientList = document.getElementById("modal-ingredients-list");
  if (editMode) {
    ingredientList.innerHTML = recipe.ingredients.map((ingredient, index) => `
      <li class="edit-ingredient" data-index="${index}">
        <input id="edit-ing-name-${index}" aria-label="Ingrediente" value="${escapeAttr(ingredient.name)}">
        <div class="portion-edit-grid"><label>IPO A<input id="edit-ing-ipo-training-${index}" value="${escapeAttr(getPortionValue(ingredient, "ipo", "training"))}"></label><label>IPO R<input id="edit-ing-ipo-rest-${index}" value="${escapeAttr(getPortionValue(ingredient, "ipo", "rest"))}"></label><label>Uomo A<input id="edit-ing-man-training-${index}" value="${escapeAttr(getPortionValue(ingredient, "man", "training"))}"></label><label>Uomo R<input id="edit-ing-man-rest-${index}" value="${escapeAttr(getPortionValue(ingredient, "man", "rest"))}"></label><button class="btn-icon remove-edit-item" onclick="removeIngredient(${index})">×</button></div>
      </li>`).join("") + `<li><button class="btn btn-outline full-width" onclick="addIngredient()">+ Aggiungi ingrediente</button></li>`;
  } else {
    ingredientList.innerHTML = recipe.ingredients.map(ingredient => `<li><span>${escapeHtml(ingredient.name)}</span>${getIngredientCoupleHtml(ingredient, dayType)}</li>`).join("");
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
          const status = BATCH_STATUS_LABELS[task.status] || BATCH_STATUS_LABELS.later;
          return `<li><span>${escapeHtml(task.label)}</span> <span class="batch-task-status ${status.className}">${status.label}</span>${task.quantity ? ` <strong>${escapeHtml(task.quantity)}</strong>` : ""}</li>`;
        }).join("")}</ol>
      </div>`).join("");
  } else {
    batchContent.textContent = "";
  }

  document.getElementById("modal-edit-btn").classList.toggle("hidden", editMode);
  document.getElementById("modal-save-btn").classList.toggle("hidden", !editMode);
  document.getElementById("modal-export-btn").classList.toggle("hidden", editMode || currentModal.isNew);
  document.getElementById("modal-share-btn").classList.toggle("hidden", editMode || currentModal.isNew);
  document.getElementById("modal-revert-btn").classList.toggle("hidden", editMode || !recipe._original);
  document.getElementById("modal-delete-btn").classList.toggle("hidden", editMode || currentModal.isNew);
  document.getElementById("modal-edit-btn").textContent = "Modifica ricetta";
  document.getElementById("modal-save-btn").textContent = "Salva nel cloud";
}

function captureEditState() {
  if (!editMode || !currentModal) return;
  const recipe = currentModal.recipe;
  recipe.name = document.getElementById("edit-recipe-name")?.value.trim() || "Ricetta senza nome";
  recipe.emoji = document.getElementById("edit-recipe-emoji")?.value.trim() || "🍲";
  recipe.slot = document.getElementById("edit-recipe-slot")?.value || "lunch";
  recipe.proteinCategory = document.getElementById("edit-recipe-category")?.value.trim() || "";
  recipe.frequency = document.getElementById("edit-recipe-frequency")?.value.trim() || "";
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

document.addEventListener("DOMContentLoaded", initApp);
