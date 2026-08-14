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
  shopping: null
};
let appStarted = false;
let currentModal = null;
let editMode = false;
let shopSettingsVisible = false;
let toastTimeout = null;

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
  return window.PianoDomain
    ? PianoDomain.migrateRecipe(recipe)
    : clone(recipe);
}

function setRecipes(recipes) {
  const normalizedRecipes = recipes.map(normalizeRecipeSchema);

  appState.recipes = normalizedRecipes;
  appState.recipesById = Object.fromEntries(
    normalizedRecipes.map(recipe => [recipe.id, recipe])
  );
}

function getActiveBatchRule(dayKey) {
  const rule = appState.plan?.batchRules?.[dayKey];
  const current = appState.plan?.days?.[dayKey];

  if (!rule || !current) return null;

  const next = appState.plan?.days?.[rule.nextDay];

  if (!next) return null;

  // Il batch dipende esclusivamente dalla combinazione:
  // cena corrente + pranzo del giorno successivo.
  // Il tipo A/R modifica solo i dosaggi e non disattiva il batch.
  const hasRequiredRecipes =
    current.dinner === rule.dinner &&
    next.lunch === rule.nextLunch;

  return hasRequiredRecipes ? rule : null;
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

async function loadUserData(user) {
  setLoading("Sincronizzazione del piano personale…");
  appState.user = user;
  try {
    // Tre sole letture Firestore in parallelo: catalogo, piano e lista spesa.
    const [recipes, plan, shopping] = await Promise.all([
      getRecipeCatalog(), getWeeklyPlan(), getShoppingListCloud()
    ]);
    setRecipes(recipes);
    appState.plan = plan;
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

    // Registrazione username eseguita una sola volta per dispositivo; abilita le condivisioni.
    ensureUsernameDirectory().catch(error => console.warn("Directory username non disponibile", error));
    document.querySelector(".bottom-nav")?.classList.remove("hidden");
    if (!appStarted) {
      setupRouter();
      setupModal();
      setupSwapModal();
      setupTransferModals();
      appStarted = true;
    } else {
      handleRoute();
    }
  } catch (error) {
    console.error(error);
    showApp();
    const container = document.getElementById("view-chef");
    container.classList.remove("hidden");
    container.innerHTML = `<div class="empty-state"><h2>Sincronizzazione non riuscita</h2><p>${escapeHtml(error.message || "Controlla Firestore e le regole di sicurezza.")}</p><button class="btn btn-primary" onclick="window.location.reload()">Riprova</button></div>`;
  } finally {
    clearLoading();
  }
}

async function initApp() {
  setupLoginForm();
  if (!initFirebase()) {
    document.getElementById("login-error").textContent = "Firebase non è configurato correttamente.";
    showLogin();
    return;
  }
  setLoading("Verifica accesso…");
  observeAuthState(async user => {
    if (!user) {
      appState.user = null;
      showLogin();
      return;
    }
    await loadUserData(user);
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

function handleRoute() {
  if (!appState.user || !appState.plan) return;
  const hash = window.location.hash || "#chef";
  document.querySelectorAll(".view").forEach(view => view.classList.add("hidden"));
  document.querySelectorAll(".nav-item").forEach(item => item.classList.remove("active"));
  document.getElementById(`view-${hash.slice(1)}`)?.classList.remove("hidden");
  document.getElementById(`nav-${hash.slice(1)}`)?.classList.add("active");

  if (hash === "#chef") renderChef();
  if (hash === "#week") renderWeek();
  if (hash === "#recipes") renderRecipes();
  if (hash === "#shop") renderShop();
  if (hash === "#settings") renderSettings();
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
    <a href="#settings" class="header-account" title="Account ${escapeAttr(usernameFromUser(appState.user))}">👤 ${escapeHtml(usernameFromUser(appState.user))}</a>
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

function renderBatchCard(dayKey) {
  const rule = getActiveBatchRule(dayKey);
  if (!rule) return "";
  return `
    <section class="batch-card">
      <div class="batch-title"><span>🍳</span><div><small>Batch cooking attivo</small><h3>${escapeHtml(rule.title)}</h3></div></div>
      <ol>${rule.actions.map(action => `<li class="step-item" onclick="this.classList.toggle('done')">${escapeHtml(action)}</li>`).join("")}</ol>
      <p class="batch-next"><strong>⏰ ${escapeHtml(rule.nextLunchNote)}</strong></p>
    </section>`;
}

function renderChef() {
  const container = document.getElementById("view-chef");
  const selectedDay = appState.deviceSettings.chefSelectedDay || getTodayKey();
  const nextDay = getNextDay(selectedDay);
  const dinner = getPlannedRecipe(selectedDay, "dinner");
  const nextLunch = getPlannedRecipe(nextDay, "lunch");
  const activeBatch = getActiveBatchRule(selectedDay);
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
      <div><strong>${DAY_NAMES[selectedDay]}</strong><small>${getDayType(selectedDay) === "training" ? "Allenamento · crackers inclusi nello spuntino mattutino" : "Riposo · niente crackers nello spuntino mattutino"}</small></div>
      <span class="profile-chip">${escapeHtml(getProfileLabel())}</span>
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
      <div class="section-title"><span>🍱</span><div><small>${activeBatch ? "Incluso nel batch cooking" : "Prossimo pranzo"}</small><h2>Pranzo di ${DAY_NAMES[nextDay]}</h2></div></div>
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
    <div class="page-heading"><div><p class="eyebrow">Schema ottimizzato</p><h1>Piano settimanale</h1><p>Sab(R) · Dom(A) · Lun(A) · Mar(R) · Mer(A) · Gio(R) · Ven(A)</p></div></div>
    ${renderWeekAnalysis()}
    <div class="week-grid">
      ${DAY_ORDER.map(day => {
        const planDay = appState.plan.days[day];
        return `
          <article class="day-column ${day === today ? "current-day" : ""}">
            <div class="day-column-head">
              <div><span class="recipe-code">${day === today ? "OGGI" : "GIORNO"}</span><h2>${DAY_NAMES[day]}</h2></div>
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
                <button class="btn-icon btn-swap" onclick="openSwapModal('${day}', '${slot.id}')">🔄</button>
              </div>`;
            }).join("")}
            ${getActiveBatchRule(day) ? `<div class="batch-active-chip">🍳 Batch cooking disponibile</div>` : ""}
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

function renderRecipes() {
  const container = document.getElementById("view-recipes");
  container.innerHTML = `
    <div class="page-heading recipes-heading">
      <div><p class="eyebrow">${appState.recipes.length} ricette · un solo documento Firebase</p><h1>Ricettario</h1><p>Puoi creare, esportare, importare e condividere le ricette del tuo account.</p></div>
      <div class="recipe-toolbar">
        <button class="btn btn-outline" onclick="openIncomingShares()">📥 Ricevute</button>
        <label class="btn btn-outline file-import-button">Importa<input type="file" accept="application/json,.json" onchange="prepareRecipeImport(this.files[0]); this.value='' "></label>
        <button class="btn btn-outline" onclick="exportAllRecipes()">Esporta</button>
        <button class="btn btn-outline" onclick="openShareDialog()">Invia tutte</button>
        <button class="btn btn-primary" onclick="createNewRecipe()">+ Nuova</button>
      </div>
    </div>
    ${appState.recipes.length ? `<label class="search-box"><span>⌕</span><input id="recipe-search" type="search" placeholder="Cerca ricetta o categoria…" oninput="filterRecipeCards(this.value)"></label>${MEAL_SLOTS.map(slot => recipeSectionHtml(slot.label, appState.recipes.filter(recipe => recipe.slot === slot.id), slot)).join("")}` : `<div class="empty-state recipe-empty-state"><span>🍲</span><h2>Il tuo ricettario è vuoto</h2><p>Puoi creare la prima ricetta manualmente, importare un file JSON o attendere una condivisione da un altro utente.</p><button class="btn btn-primary" onclick="createNewRecipe()">+ Crea la prima ricetta</button></div>`}
  `;
}

function recipeSectionHtml(title, recipes, slot) {
  if (!recipes.length) return "";
  return `
    <section class="recipe-library-section">
      <div class="section-title"><span>${slot.emoji}</span><div><small>${recipes.length} proposte</small><h2>${escapeHtml(title)}</h2></div></div>
      <div class="recipe-grid">
        ${recipes.map(recipe => `<button class="recipe-library-card" data-search="${escapeAttr(`${recipe.id} ${recipe.name} ${recipe.namesByDayType?.training || ""} ${recipe.namesByDayType?.rest || ""} ${recipe.proteinCategory}`.toLowerCase())}" onclick="openRecipeModal('${escapeAttr(recipe.id)}')"><span class="recipe-code">${escapeHtml(recipe.id)}</span><span class="recipe-card-emoji">${escapeHtml(recipe.emoji || "🍲")}</span><strong>${escapeHtml(recipe.name)}</strong><small>${escapeHtml(recipe.proteinCategory || "")}</small><span class="frequency-chip">${escapeHtml(recipe.frequency || "")}</span></button>`).join("")}
      </div>
    </section>`;
}

window.filterRecipeCards = function(query) {
  const normalized = String(query || "").trim().toLowerCase();
  document.querySelectorAll(".recipe-library-card").forEach(card => {
    card.classList.toggle("hidden", normalized && !card.dataset.search.includes(normalized));
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
  const original = String(raw ?? "").trim();
  if (isEmptyPortion(original) || /^0(?:[.,]0+)?\s*(g|ml)?$/i.test(original)) return { skip: true };
  if (/^(q\.?b\.?|liber[oaie]|a piacere)$/i.test(original)) return { free: true, label: original };
  const fractionMap = { "½": 0.5, "¼": 0.25, "¾": 0.75 };
  const match = original.match(/^(\d+(?:[.,]\d+)?|[½¼¾])\s*(g|ml|pz)?$/i);
  if (!match) return { opaque: original };
  const value = fractionMap[match[1]] ?? Number(match[1].replace(",", "."));
  return { value, unit: (match[2] || "pz").toLowerCase() };
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
  const aggregate = {};
  DAY_ORDER.forEach(day => {
    const selected = appState.shopping.selectedMeals?.[day] || [];
    selected.forEach(slot => {
      const recipe = getPlannedRecipe(day, slot);
      if (!recipe) return;
      recipe.ingredients.forEach(ingredient => {
        const key = normalizeIngredientName(ingredient.name);
        if (!aggregate[key]) {
          aggregate[key] = {
            id: key.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
            name: ingredient.name,
            category: getCategoryForIngredient(ingredient.name),
            totals: {}, opaque: {}, free: false, tags: []
          };
        }
        const entry = aggregate[key];
        const tag = `${DAY_NAMES[day].slice(0, 3)} · ${getSlotMeta(slot).shortLabel}`;
        if (!entry.tags.includes(tag)) entry.tags.push(tag);
        shoppingPortionsForIngredient(ingredient, getDayType(day)).forEach(portion => {
          const parsed = parseSimpleAmount(portion.raw);
          if (parsed.skip) return;
          if (parsed.free) { entry.free = true; return; }
          if (parsed.opaque) {
            const label = getPortionProfile() === "couple" ? `${portion.role}: ${parsed.opaque}` : parsed.opaque;
            entry.opaque[label] = (entry.opaque[label] || 0) + 1;
            return;
          }
          entry.totals[parsed.unit] = (entry.totals[parsed.unit] || 0) + parsed.value;
        });
      });
    });
  });
  return Object.values(aggregate);
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100).replace(".", ",");
}

function shoppingAmountText(entry) {
  if (appState.shopping.customQuantities?.[entry.id] !== undefined) return appState.shopping.customQuantities[entry.id];
  const pieces = Object.entries(entry.totals).map(([unit, total]) => `${formatNumber(total)}${unit === "pz" ? " pz" : unit}`);
  Object.entries(entry.opaque).forEach(([label, count]) => pieces.push(count > 1 ? `${label} × ${count}` : label));
  if (entry.free && !pieces.length) pieces.push("q.b. / libera");
  return pieces.join(" + ") || "—";
}

function getVisibleShoppingEntries() {
  const excluded = new Set(appState.shopping.excludedItems || []);
  return aggregateShoppingList().filter(entry => {
    if (excluded.has(entry.id)) return false;
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
          return `<div class="shop-day-row"><strong>${DAY_NAMES[day]}</strong><div class="shop-meal-checks">${MEAL_SLOTS.map(slot => `<label><input type="checkbox" ${selected.includes(slot.id) ? "checked" : ""} onchange="toggleShopMeal('${day}', '${slot.id}', this.checked)"> ${escapeHtml(slot.label)}</label>`).join("")}</div></div>`;
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

function renderSettings() {
  const container = document.getElementById("view-settings");
  const profile = getPortionProfile();
  const breakfastCount = appState.recipes.filter(recipe => recipe.slot === "breakfast").length;
  container.innerHTML = `
    <div class="page-heading"><div><p class="eyebrow">Preferenze e manuale alimentare</p><h1>Impostazioni</h1></div></div>
    <section class="settings-section account-card">
      <div class="account-avatar">${escapeHtml(usernameFromUser(appState.user).slice(0, 1).toUpperCase())}</div>
      <div><small>Accesso personale</small><h2>${escapeHtml(usernameFromUser(appState.user))}</h2><p>Account protetto da Firebase Authentication</p></div>
      <button class="btn btn-outline" onclick="logoutCurrentUser()">Esci</button>
    </section>

    <section class="settings-section">
      <h2>Porzioni</h2>
      <p class="text-muted settings-intro">Le dosi sono quelle salvate nel catalogo Firebase: nessun moltiplicatore percentuale.</p>
      <div class="profile-options">
        <label class="profile-option ${profile === "man" ? "selected" : ""}"><input type="radio" name="profile" value="man" ${profile === "man" ? "checked" : ""} onchange="changePortionProfile(this.value)"><span>👨</span><strong>Uomo</strong><small>Dosi normocaloriche A/R</small></label>
        <label class="profile-option ${profile === "ipo" ? "selected" : ""}"><input type="radio" name="profile" value="ipo" ${profile === "ipo" ? "checked" : ""} onchange="changePortionProfile(this.value)"><span>👩</span><strong>Donna IPO</strong><small>Dosi IPO originali</small></label>
        <label class="profile-option ${profile === "couple" ? "selected" : ""}"><input type="radio" name="profile" value="couple" ${profile === "couple" ? "checked" : ""} onchange="changePortionProfile(this.value)"><span>👥</span><strong>Coppia</strong><small>Entrambe le dosi separate</small></label>
      </div>
    </section>

    <section class="settings-section">
      <h2>Aspetto</h2>
      <label class="settings-row"><span><strong>Tema scuro</strong><small>Solo su questo dispositivo</small></span><input type="checkbox" ${appState.deviceSettings.darkMode ? "checked" : ""} onchange="toggleDarkMode(this.checked)"></label>
    </section>

    <div class="manual-heading"><p class="eyebrow">INDICAZIONI DI MELLER</p><h2>Manuale dieta e alternative</h2><p>Le alternative originali restano sempre consultabili nell'app.</p></div>

    ${settingsAccordion("Struttura della dieta", `<ul class="guide-list">${MELLER_GUIDE.structure.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`, true)}
    ${settingsAccordion("Giorno di allenamento", guideDayHtml(MELLER_GUIDE.trainingDay, "training"))}
    ${settingsAccordion("Giorno di riposo", guideDayHtml(MELLER_GUIDE.restDay, "rest"))}
    ${settingsAccordion("Alternative alimentari di Meller", `<div class="alternatives-grid">${alternativesTableHtml(MELLER_GUIDE.alternatives.carbohydrates)}${alternativesTableHtml(MELLER_GUIDE.alternatives.proteins)}</div>`, true)}
    ${settingsAccordion("Frequenze proteiche", `<div class="alternative-table frequency-table">${MELLER_GUIDE.proteinFrequencies.map(row => `<div><span>${escapeHtml(row[0])}</span><strong>${escapeHtml(row[1])}</strong></div>`).join("")}</div>`)}
    ${settingsAccordion("Integrazione Syform", `<ul class="guide-list">${MELLER_GUIDE.integration.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`)}
    ${settingsAccordion("Altre informazioni e FAQ", `<ul class="guide-list">${MELLER_GUIDE.faq.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`)}

    <section class="settings-section cloud-section">
      <div><h2>Dati Firebase</h2><p class="text-muted">${appState.recipes.length} ricette totali · ${breakfastCount} colazioni · catalogo schema v${CATALOG_SCHEMA_VERSION}</p><p class="cloud-call-info">⚡ Avvio ottimizzato: 3 letture documento in parallelo (catalogo completo, piano, spesa).</p></div>
      <label class="btn btn-outline file-import-button">Importa o ripristina JSON<input type="file" accept="application/json,.json" onchange="prepareRecipeImport(this.files[0]); this.value='' "></label>
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
    payload.plan = clone(appState.plan);
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
  if (mode === "replace" && !confirm("Sostituire tutte le ricette attuali con quelle del file?")) return;
  setLoading("Importazione ricette su Firebase…");
  try {
    const incoming = pendingRecipeImport.recipes;
    const nextRecipes = mode === "add" ? mergeRecipeCatalogs(appState.recipes, incoming) : incoming.map(cleanRecipeForTransfer);
    let nextPlan;
    const canApplyImportedPlan = importedPlanIsUsable(pendingRecipeImport.plan, nextRecipes);
    if ((mode === "replace" || appState.recipes.length === 0) && canApplyImportedPlan) nextPlan = clone(pendingRecipeImport.plan);
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
        <p class="text-muted transfer-privacy-note">Il destinatario riceverà una richiesta e potrà aggiungere, sostituire o rifiutare le ricette.</p>
        <button id="share-send-button" class="btn btn-primary full-width" onclick="submitRecipeShare()">Invia richiesta</button>
      </div>
    </div>
    <div id="incoming-shares-modal" class="modal hidden" role="dialog" aria-modal="true">
      <div class="modal-content incoming-modal-content">
        <div class="modal-header"><div><p class="eyebrow">RICHIESTE RICEVUTE</p><h2>Ricette condivise con te</h2></div><button class="btn-icon" onclick="closeIncomingShares()">&times;</button></div>
        <div id="incoming-shares-list"></div>
      </div>
    </div>`);
}

window.openShareDialog = function(recipeId = null) {
  const recipes = recipeId ? [getRecipe(recipeId)].filter(Boolean) : appState.recipes;
  if (!recipes.length) {
    showToast("Non ci sono ricette da inviare", true);
    return;
  }
  pendingShareRecipeIds = recipes.map(recipe => recipe.id);
  document.getElementById("share-send-summary").textContent = recipeId ? `Invierai: ${getRecipe(recipeId).name}` : `Invierai tutte le ${recipes.length} ricette del catalogo.`;
  document.getElementById("share-recipient-username").value = "";
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
  const button = document.getElementById("share-send-button");
  button.disabled = true;
  button.textContent = "Invio…";
  try {
    await sendRecipeShare(username, recipes);
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
    incomingRecipeShares = await getPendingRecipeShares();
    renderIncomingShares();
  } catch (error) {
    console.error(error);
    list.innerHTML = `<div class="empty-state"><span>⚠️</span><p>${escapeHtml(error.message || "Impossibile caricare le richieste")}</p></div>`;
  }
};

function renderIncomingShares() {
  const list = document.getElementById("incoming-shares-list");
  if (!incomingRecipeShares.length) {
    list.innerHTML = `<div class="empty-state"><span>📭</span><h3>Nessuna richiesta</h3><p>Quando un utente ti invierà delle ricette, compariranno qui.</p></div>`;
    return;
  }
  list.innerHTML = incomingRecipeShares.map(share => `
    <article class="incoming-share-card">
      <div><span class="account-avatar small">${escapeHtml((share.senderUsername || "?").slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(share.senderUsername || "Utente")}</strong><small>${share.recipeCount || share.recipes?.length || 0} ricett${(share.recipeCount || share.recipes?.length) === 1 ? "a" : "e"}</small></div></div>
      <p>${escapeHtml((share.recipes || []).slice(0, 4).map(recipe => recipe.name).join(" · "))}${(share.recipes || []).length > 4 ? "…" : ""}</p>
      <div class="incoming-share-actions"><button class="btn btn-outline" onclick="acceptSharedRecipes('${share.id}', 'add')">Aggiungi</button><button class="btn btn-danger" onclick="acceptSharedRecipes('${share.id}', 'replace')">Sostituisci tutte</button><button class="btn btn-outline" onclick="rejectSharedRecipes('${share.id}')">Rifiuta</button></div>
    </article>`).join("");
}

window.closeIncomingShares = function() {
  document.getElementById("incoming-shares-modal")?.classList.add("hidden");
};

window.acceptSharedRecipes = async function(shareId, mode) {
  const share = incomingRecipeShares.find(item => item.id === shareId);
  if (!share) return;
  if (mode === "replace" && !confirm(`Sostituire tutte le tue ricette con le ${share.recipes.length} ricevute da ${share.senderUsername}?`)) return;
  setLoading("Salvataggio ricette condivise…");
  try {
    const incoming = (share.recipes || []).map(cleanRecipeForTransfer);
    validateRecipeCatalog(incoming);
    const nextRecipes = mode === "add" ? mergeRecipeCatalogs(appState.recipes, incoming) : incoming;
    const nextPlan = sanitizePlanForCatalog(appState.plan, nextRecipes);
    await acceptRecipeShare(shareId, nextRecipes, nextPlan);
    setRecipes(nextRecipes);
    appState.plan = nextPlan;
    incomingRecipeShares = incomingRecipeShares.filter(item => item.id !== shareId);
    renderIncomingShares();
    handleRoute();
    showToast("Ricette accettate e salvate ✅");
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
  const rule = getActiveBatchRule(currentModal.dayKey);
  if (!rule) return null;
  const plannedDinner = appState.plan.days[currentModal.dayKey].dinner;
  return currentModal.recipe.id === plannedDinner ? rule : null;
}

function renderModalContent() {
  const recipe = currentModal.recipe;
  const dayType = currentModal.dayType;
  const batchRule = modalBatchRule();
  const batchTab = document.querySelector('.tab-btn[data-target="tab-batch"]');
  const tabs = document.querySelector('.tabs');
  // La consultazione è intenzionalmente una schermata unica: ingredienti e preparazione
  // restano contemporaneamente visibili, come nella sezione DA CUCINARE.
  tabs?.classList.toggle("hidden", !editMode);
  document.getElementById("tab-ingredients")?.classList.remove("hidden");
  document.getElementById("tab-prep")?.classList.toggle("hidden", editMode);
  batchTab.classList.toggle("hidden", !batchRule && !editMode);
  if (!editMode && document.querySelector('.tab-btn[data-target="tab-batch"]').classList.contains("active") && !batchRule) setModalTab("tab-ingredients");

  document.getElementById("modal-title").innerHTML = editMode
    ? `<input id="edit-recipe-name" class="modal-title-input" value="${escapeAttr(recipe.name)}">`
    : `<span class="recipe-code">${escapeHtml(recipe.id)}</span> ${escapeHtml(recipe.emoji || "🍲")} ${escapeHtml(getRecipeDisplayName(recipe, dayType))}`;
  document.getElementById("modal-time").innerHTML = editMode
    ? `<div class="edit-meta-grid"><label>Emoji<input id="edit-recipe-emoji" value="${escapeAttr(recipe.emoji || "🍲")}"></label><label>Tipo<select id="edit-recipe-slot">${MEAL_SLOTS.map(slot => `<option value="${slot.id}" ${recipe.slot === slot.id ? "selected" : ""}>${escapeHtml(slot.label)}</option>`).join("")}</select></label><label>Categoria<input id="edit-recipe-category" value="${escapeAttr(recipe.proteinCategory || "")}"></label><label>Frequenza<input id="edit-recipe-frequency" value="${escapeAttr(recipe.frequency || "")}"></label></div>`
    : `${escapeHtml(getSlotMeta(recipe.slot).label)} · ${currentModal.dayKey ? `${DAY_NAMES[currentModal.dayKey]} (${dayType === "training" ? "A" : "R"})` : "anteprima A"} · ${escapeHtml(getProfileLabel())}`;

  const ingredientList = document.getElementById("modal-ingredients-list");
  if (editMode) {
    ingredientList.innerHTML = recipe.ingredients.map((ingredient, index) => `
      <li class="edit-ingredient" data-index="${index}">
        <input id="edit-ing-name-${index}" aria-label="Ingrediente" value="${escapeAttr(ingredient.name)}">
        <div class="portion-edit-grid"><label>IPO A<input id="edit-ing-ipo-training-${index}" value="${escapeAttr(getPortionValue(ingredient, "ipo", "training"))}"></label><label>IPO R<input id="edit-ing-ipo-rest-${index}" value="${escapeAttr(getPortionValue(ingredient, "ipo", "rest"))}"></label><label>Uomo A<input id="edit-ing-man-training-${index}" value="${escapeAttr(getPortionValue(ingredient, "man", "training"))}"></label><label>Uomo R<input id="edit-ing-man-rest-${index}" value="${escapeAttr(getPortionValue(ingredient, "man", "rest"))}"></label><button class="btn-icon remove-edit-item" onclick="removeIngredient(${index})">×</button></div>
      </li>`).join("") + `<li><button class="btn btn-outline full-width" onclick="addIngredient()">+ Aggiungi ingrediente</button></li>`;
  } else {
    ingredientList.innerHTML = recipe.ingredients.map(ingredient => `<li><span>${escapeHtml(ingredient.name)}</span><strong>${escapeHtml(getIngredientDisplay(ingredient, dayType))}</strong></li>`).join("");
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
  } else if (batchRule) {
    batchContent.innerHTML = `<div class="batch-modal"><h3>${escapeHtml(batchRule.title)}</h3><ol>${batchRule.actions.map(action => `<li>${escapeHtml(action)}</li>`).join("")}</ol><p><strong>${escapeHtml(batchRule.nextLunchNote)}</strong></p></div>`;
  } else {
    batchContent.textContent = "";
  }

  document.getElementById("modal-edit-btn").classList.toggle("hidden", editMode);
  document.getElementById("modal-save-btn").classList.toggle("hidden", !editMode);
  document.getElementById("modal-export-btn").classList.toggle("hidden", editMode || currentModal.isNew);
  document.getElementById("modal-share-btn").classList.toggle("hidden", editMode || currentModal.isNew);
  document.getElementById("modal-revert-btn").classList.toggle("hidden", editMode || !recipe._original);
  document.getElementById("modal-edit-btn").textContent = "Modifica su Firebase";
  document.getElementById("modal-save-btn").textContent = "Salva su Firebase";
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
  setLoading("Salvataggio del catalogo su Firebase…");
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
    showToast("Ricetta salvata su Firebase ✅");
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
  setLoading("Ripristino ricetta su Firebase…");
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

document.addEventListener("DOMContentLoaded", initApp);
