const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MEAL_SLOTS = [
  { id: 'breakfast', label: 'Colazione' },
  { id: 'snack1', label: 'Spunt. Mattina' },
  { id: 'lunch', label: 'Pranzo' },
  { id: 'snack2', label: 'Merenda' },
  { id: 'dinner', label: 'Cena' }
];

let appState = {
  settings: null,
  weekPlan: null,
  swappedMeals: null,
  shoppingListCloud: null,
  deviceSettings: null,
  customRecipes: {}
};

let currentModalMeal = null;

// --- Helpers for ingredient normalization and categories ---
function normalizeIngredientName(name) {
  if (!name) return name;
  const low = name.toLowerCase();
  if (low.includes("petto di pollo")) return "Petto di pollo";
  if (low.includes("peperoni")) return "Peperoni";
  if (low.includes("marmellata")) return "Marmellata";
  if (low.includes("whey")) return "Proteine Whey";
  // Additional normalizations for shopping list merging
  if (low.includes("ceci bolliti")) return "Ceci bolliti scolati";
  if (low.includes("pomodorini ciliegino")) return "Pomodorini";
  if (low.includes("pomodorini")) return "Pomodorini";
  if (low.includes("yogurt greco")) return "Yogurt greco 0%";
  if (low.includes("farina d'avena")) return "Farina d'avena";
  if (low.includes("miele") || low.includes("sciroppo acero") || low.includes("sciroppo d'acero") || low.includes("acero")) return "Miele / Sciroppo Acero";
  if (low.includes("olio evo")) return "Olio EVO";
  return name;
}

function getCategoryForIngredient(rawName) {
  if (!rawName) return "🌿 Spezie e Aromi";
  const low = rawName.toLowerCase();
  const norm = normalizeIngredientName(rawName).toLowerCase();
  // Use normalized for matching where possible
  const check = (substr) => low.includes(substr) || norm.includes(substr);

  // Carne
  if (check("manzo") || check("petto di pollo") || check("pollo") && !check("pollo già")) {
    // careful pollo already covered, but keep
    if (check("petto di pollo") || check("manzo")) return "🥩 Carne";
  }
  if (check("petto di pollo")) return "🥩 Carne";
  if (check("manzo magro")) return "🥩 Carne";

  // Pesce
  if (check("merluzzo") || check("sgombro") || check("salmone") || check("polpo") || check("nasello") || check("gamberetti")) return "🐟 Pesce";

  // Uova e Latticini
  if (check("yogurt greco") || check("albumi") || check("uova intere") || check("fiocchi di latte") || check("fiocchi di latte")) return "🥚 Uova e Latticini";

  // Legumi
  if (check("ceci") || check("lenticchie") || check("fagioli borlotti") || check("fagioli") || check("legumotti")) return "🫘 Legumi";

  // Carboidrati
  if (check("farina d'avena") || check("riso bianco") || check("riso") && !check("riso e") || check("pasta bianca") || check("patate") || check("gnocchi") || check("pane bianco") || check("farro") || check("quinoa") || check("cereali") || check("crackers")) {
    // avoid overlapping with verdura, but keep priority
    if (check("crackers") || check("pane bianco") || check("patate") || check("avena") || check("riso bianco") || check("pasta") || check("farro") || check("quinoa") || check("gnocchi") || check("legumotti")) return "🍚 Carboidrati";
  }

  // Verdura - explicit list including required ones
  if (check("insalata mista") || check("pomodori pelati") || check("pomodorini") || check("melanzane") || check("peperoni") || check("zucchine") || check("spinacini") || check("sedano") || check("rucola") || check("cetriolo")) return "🥬 Verdura";

  // Frutta
  if (check("frutta fresca") || check("melone") || check("avocado")) return "🍑 Frutta";
  // Limone and others go to dispensa or spezie? Keep limone as frutta? Original had limone as pz but not categorized; we map to frutta for simplicity but actually could be dispensa. Keep as 🍑 Frutta for limone, else spezie fallback.
  if (check("limone")) return "🍑 Frutta";

  // Dispensa
  if (check("proteine whey") || check("marmellata") || check("miele") || check("sciroppo") || check("olio evo") || check("latte parz") || check("cioccolato fondente") || check("cacao amaro") || check("vanillina") || check("cannella") || check("cereali")) return "🥫 Dispensa";

  // Spezie e Aromi - explicit for pepe etc.
  if (check("pepe") && !check("peperoni") && !check("peperoncino")) return "🌿 Spezie e Aromi";
  if (check("sale") || check("aglio") || check("origano") || check("basilico") || check("prezzemolo") || check("rosmarino") || check("paprika") || check("curcuma") || check("cumino") || check("peperoncino") || check("erba cipollina") || check("zenzero")) return "🌿 Spezie e Aromi";

  // Fallback based on normalized categories map
  // Default to spezie
  return "🌿 Spezie e Aromi";
}

const CARB_REST_MAP = {
  "riso bianco": 70,
  "pasta bianca": 70,
  "farro perlato": 70,
  "quinoa": 60,
  "gnocchi di patate": 190,
  "gnocchi": 190,
  "patate": 350,
  "pane bianco": 90,
  "legumotti barilla": 60,
  "legumotti": 60
};
const CARB_TRAINING_MAP = {
  "riso bianco": 90,
  "pasta bianca": 90,
  "farro perlato": 90,
  "quinoa": 80,
  "gnocchi di patate": 250,
  "gnocchi": 250,
  "patate": 450,
  "pane bianco": 120,
  "legumotti barilla": 80,
  "legumotti": 80
};

function isCarbForScaling(ingName) {
  const low = ingName.toLowerCase();
  return Object.keys(CARB_REST_MAP).some(c => low.includes(c));
}
function getCarbExactQty(ingName, type) {
  const low = ingName.toLowerCase();
  const map = type === 'rest' ? CARB_REST_MAP : CARB_TRAINING_MAP;
  for (const key of Object.keys(map)) {
    if (low.includes(key)) return map[key];
  }
  return null;
}

function adjustMealForType(meal, originalType, requestedType) {
  if (!meal) return meal;
  if (originalType === requestedType) return meal;
  let clone = JSON.parse(JSON.stringify(meal));
  if (requestedType === 'rest' && originalType === 'training') {
    if (clone.slot === 'snack1') {
      clone.ingredients = clone.ingredients.filter(ing => !ing.name.toLowerCase().includes('crackers'));
    }
    if (clone.slot === 'lunch') {
      clone.ingredients = clone.ingredients.map(ing => {
        if (isCarbForScaling(ing.name) && typeof ing.quantity === 'number') {
          const exact = getCarbExactQty(ing.name, 'rest');
          ing.quantity = exact !== null ? exact : ing.quantity * (70/90);
        }
        return ing;
      });
    }
  } else if (requestedType === 'training' && originalType === 'rest') {
    if (clone.slot === 'snack1') {
      const hasCrackers = clone.ingredients.some(ing => ing.name.toLowerCase().includes('crackers'));
      const hasFrutta = clone.ingredients.some(ing => ing.name.toLowerCase().includes('frutta'));
      if (!hasCrackers && hasFrutta) {
        clone.ingredients.push({ name: "Crackers", quantity: 30, unit: "g" });
      }
    }
    if (clone.slot === 'lunch') {
      clone.ingredients = clone.ingredients.map(ing => {
        if (isCarbForScaling(ing.name) && typeof ing.quantity === 'number') {
          const exact = getCarbExactQty(ing.name, 'training');
          ing.quantity = exact !== null ? exact : ing.quantity * (90/70);
        }
        return ing;
      });
    }
  }
  return clone;
}

function getISODateStringLocal() {
  // YYYY-MM-DD in local timezone
  const d = new Date();
  const tzOffset = d.getTimezoneOffset() * 60000;
  const local = new Date(d.getTime() - tzOffset);
  return local.toISOString().split('T')[0];
}

function getMealFromPlan(dayKey, type, slotId) {
  if (!MEAL_PLAN[dayKey] || !MEAL_PLAN[dayKey].meals[type]) return null;
  return MEAL_PLAN[dayKey].meals[type].find(m => m.slot === slotId) || null;
}

function findMealById(mealId) {
  const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  for (const d of weekDays) {
    for (const t of ['training', 'rest']) {
      if (MEAL_PLAN[d].meals[t]) {
        const m = MEAL_PLAN[d].meals[t].find(x => x.id === mealId);
        if (m) return { meal: m, type: t, dayKey: d };
      }
    }
  }
  if (appState.customRecipes && appState.customRecipes[mealId]) {
    // custom recipes don't have a fixed type, assume training to avoid scaling down, but we treat as its own
    return { meal: appState.customRecipes[mealId], type: 'training', dayKey: 'custom' };
  }
  return null;
}


let editMode = false;
let shopSettingsVisible = false;

function repairMissingDays() {
  // Lascia i tipi mancanti come null per permettere la trasformazione dinamica
  // (es. lunedì solo training, giovedì solo rest). getDynamicMeal farà fallback e adatterà cracker e carboidrati.
  // Nessun clone necessario per evitare pasti identici tra training/rest.
}


// ------------------------------------
// INITIALIZATION
// ------------------------------------
async function initApp() {
  initFirebase();
  repairMissingDays();
  
  appState.settings = await getGlobalSettings();
  appState.weekPlan = await getWeekPlan();
  appState.swappedMeals = await getSwappedMeals();
  appState.shoppingListCloud = await getShoppingListCloud();
  appState.deviceSettings = getLocalDeviceSettings();
  
  // Fix: if date changed since last login, reset Oggi view to current day
  try {
    const todayISO = (typeof getISODateString === 'function' ? getISODateString() : getISODateStringLocal());
    const lastLogin = appState.deviceSettings.lastLoginDate;
    const todayKey = getTodayKey();
    if (lastLogin !== todayISO) {
      appState.deviceSettings.prepSelectedDay = todayKey;
      appState.deviceSettings.lastLoginDate = todayISO;
      saveLocalDeviceSettings(appState.deviceSettings);
    }
  } catch(e) {
    console.warn("lastLogin check failed", e);
  }

  
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  if (!isMobile && ("Notification" in window)) {
    if (Notification.permission === "default") {
      Notification.requestPermission().then(async perm => {
        if(perm === "granted") {
          appState.settings.notificationsEnabled = true;
          await saveGlobalSettings({notificationsEnabled: true});
          scheduleDailyNotifications();
        }
      });
    } else if (Notification.permission === "granted") {
      appState.settings.notificationsEnabled = true;
    }
  } else {
    appState.settings.notificationsEnabled = false;
  }
  
  if (appState.deviceSettings.darkMode) document.body.classList.add('dark-mode');
  
  if (db) {
    try {
      const snap = await db.collection('recipes').get();
      snap.forEach(doc => { appState.customRecipes[doc.id] = doc.data(); });
    } catch(e) {}
  }
  
  setupRouter();
  setupModal();
  
  if(!document.getElementById('swap-modal')) {
    const swapHtml = `
      <div id="swap-modal" class="modal hidden">
        <div class="modal-content" style="max-height:80vh;">
          <div class="modal-header">
            <h2>Sostituisci Pasto</h2>
            <button class="btn-icon" onclick="document.getElementById('swap-modal').classList.add('hidden')">&times;</button>
          </div>
          <p class="text-muted" style="margin-bottom:1rem;">Seleziona con quale pasto scambiarlo. Le quantità si adatteranno al giorno corrente.</p>
          <div id="swap-options-list" style="overflow-y:auto; padding-bottom:1rem;"></div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', swapHtml);
  }

  window.addEventListener('midnight-refresh', () => {
    if (window.location.hash === '#chef') renderChef();
    scheduleDailyNotifications();
  });
  
  scheduleDailyNotifications();
  renderGlobalHeader();
}

// ------------------------------------
// UTILS & DATA FETCHERS
// ------------------------------------
function getTodayKey() { return DAYS[new Date().getDay()]; }

function getDayType(dayKey) {
  if (appState.weekPlan && appState.weekPlan[dayKey]) return appState.weekPlan[dayKey];
  return MEAL_PLAN[dayKey].defaultType;
}

function getDynamicMeal(dayKey, dayType, slotId) {
  const swapKey = `${dayKey}_${slotId}`;
  
  if (appState.swappedMeals && appState.swappedMeals[swapKey]) {
    const targetId = appState.swappedMeals[swapKey];
    const found = findMealById(targetId);
    if (found && found.meal) {
      let clone = JSON.parse(JSON.stringify(found.meal));
      clone.slot = slotId;
      // Adjust quantities if swapped meal original type differs from requested day type
      if (found.type && found.type !== dayType) {
        clone = adjustMealForType(clone, found.type, dayType);
      }
      return clone;
    }
  }

  // Try to get meal for requested dayType
  let direct = getMealFromPlan(dayKey, dayType, slotId);
  if (direct) {
    return JSON.parse(JSON.stringify(direct));
  }
  // Fallback to other type and adjust
  const otherType = dayType === 'training' ? 'rest' : 'training';
  let fallback = getMealFromPlan(dayKey, otherType, slotId);
  if (fallback) {
    let clone = JSON.parse(JSON.stringify(fallback));
    return adjustMealForType(clone, otherType, dayType);
  }
  return null;
}

function getDynamicMealsForDay(dayKey, dayType) {
  const meals = [];
  MEAL_SLOTS.forEach(slot => {
    const m = getDynamicMeal(dayKey, dayType, slot.id);
    if(m) meals.push(m);
  });
  return meals;
}

function scheduleDailyNotifications() {
  if (!appState.settings || !appState.settings.notificationsEnabled) return;
  const todayKey = getTodayKey();
  const dayType = getDayType(todayKey);
  const meals = getDynamicMealsForDay(todayKey, dayType);
  const batch = MEAL_PLAN[todayKey].batchCooking.evening;
  scheduleNotifications(appState.settings, meals, batch);
}

function formatQty(qty) {
  if (qty > 10) return Math.round(qty / 5) * 5;
  return Math.round(qty * 10) / 10;
}

function setupRouter() {
  window.addEventListener('hashchange', handleRoute);
  if (!window.location.hash || window.location.hash === '#today' || window.location.hash === '#prep') window.location.hash = '#chef';
  else handleRoute();
}

function handleRoute() {
  const hash = window.location.hash || '#chef';
  document.querySelectorAll('.view').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  
  const viewId = `view-${hash.substring(1)}`;
  const navId = `nav-${hash.substring(1)}`;
  
  if (document.getElementById(viewId)) document.getElementById(viewId).classList.remove('hidden');
  if (document.getElementById(navId)) document.getElementById(navId).classList.add('active');
  
  if (hash === '#chef') renderChef();
  else if (hash === '#week') renderWeek();
  else if (hash === '#recipes') renderRecipes();
  else if (hash === '#shop') renderShop();
  else if (hash === '#settings') renderSettings();
}

function renderGlobalHeader() {
  const s = appState.deviceSettings;
  const singleType = s.singlePersonType || 'm';
  let html = `
    <div style="display:flex; align-items:center; gap:0.5rem;">
      <select onchange="updateGlobalPersons(parseInt(this.value))">
        <option value="1" ${s.persons === 1 ? 'selected' : ''}>👤 1 Persona</option>
        <option value="2" ${s.persons === 2 ? 'selected' : ''}>👥 2 Persone</option>
      </select>
  `;
  if (s.persons === 1) {
    html += `
      <select onchange="updateGlobalSingleType(this.value)">
        <option value="m" ${singleType === 'm' ? 'selected' : ''}>👨 Uomo</option>
        <option value="f" ${singleType === 'f' ? 'selected' : ''}>👩 Donna</option>
      </select>
    `;
  } else {
    html += `
      <select onchange="updateGlobalTwoType(this.value)">
        <option value="mf" ${s.twoPersonsType === 'mf' ? 'selected' : ''}>👨+👩 Uomo,Donna</option>
        <option value="fm" ${s.twoPersonsType === 'fm' ? 'selected' : ''}>👩+👨 Donna,Uomo</option>
        <option value="same" ${s.twoPersonsType === 'same' ? 'selected' : ''}>👬 Uguali</option>
      </select>
    `;
  }
  html += `</div>`;
  if(!document.getElementById('global-header-container')) {
    const el = document.createElement('div');
    el.id = 'global-header-container';
    el.className = 'global-header';
    document.body.prepend(el);
  }
  document.getElementById('global-header-container').innerHTML = html;
}

function getMultiplier() {
  const s = appState.deviceSettings;
  const singleType = s.singlePersonType || 'm';
  if (s.persons === 2) {
    if (s.twoPersonsType === 'mf') return 1.75;
    else if (s.twoPersonsType === 'fm') return 2.25;
    else return 2;
  } else {
    if (singleType === 'f') return 0.75;
    else return 1;
  }
}

function getPerPersonSplit(baseQty, unit) {
  const s = appState.deviceSettings;
  const persons = s.persons || 2;
  const twoType = s.twoPersonsType || 'mf';
  if (persons !== 2) return "";
  if (unit === 'q.b.') return "";
  let u1, u2, label1, label2;
  if (twoType === 'mf') { u1 = baseQty*1; u2 = baseQty*0.75; label1="Uomo"; label2="Donna"; }
  else if (twoType === 'fm') { u1 = baseQty*1; u2 = baseQty*1.25; label1="Donna"; label2="Uomo"; }
  else { u1 = baseQty*1; return `(Ciascuno: ${formatQty(u1)}${unit})`; }
  return `(${label1}: ${formatQty(u1)}${unit}, ${label2}: ${formatQty(u2)}${unit})`;
}

window.updateGlobalPersons = function(val) { appState.deviceSettings.persons = val; saveLocalDeviceSettings(appState.deviceSettings); renderGlobalHeader(); handleRoute(); }
window.updateGlobalSingleType = function(val) { appState.deviceSettings.singlePersonType = val; saveLocalDeviceSettings(appState.deviceSettings); renderGlobalHeader(); handleRoute(); }
window.updateGlobalTwoType = function(val) { appState.deviceSettings.twoPersonsType = val; saveLocalDeviceSettings(appState.deviceSettings); renderGlobalHeader(); handleRoute(); }

// ------------------------------------
// MODAL DI SCAMBIO PASTI (SWAP) - VISIBILE SOLO IN SETTIMANA
// ------------------------------------
window.openSwapModal = function(dayKey, slotId) {
  const container = document.getElementById('swap-options-list');
  container.innerHTML = '';
  
  let options = [];
  const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  
  weekDays.forEach(d => {
    ['training', 'rest'].forEach(t => {
      if(MEAL_PLAN[d].meals[t]) {
        const m = MEAL_PLAN[d].meals[t].find(x => x.slot === slotId);
        if (m && !options.find(o => o.name === m.name)) {
          options.push({ id: m.id, name: m.name, emoji: m.emoji });
        }
      }
    });
  });
  Object.values(appState.customRecipes).forEach(m => {
    if (m.slot === slotId && !options.find(o => o.name === m.name)) {
      options.push({ id: m.id, name: m.name, emoji: m.emoji });
    }
  });

  const defaultMeal = getDynamicMeal(dayKey, getDayType(dayKey), slotId);
  const defaultMealName = defaultMeal ? defaultMeal.name : null;
  
  container.innerHTML += `
    <div class="swap-item" onclick="confirmSwap('${dayKey}', '${slotId}', null)" style="border-left:4px solid var(--danger);">
      <div><strong>Ripristina Originale</strong><br><span style="font-size:0.8rem; color:var(--text-muted);">Usa il pasto previsto dal piano base</span></div>
    </div>
  `;

  options.forEach(opt => {
    const isCurrentDef = (opt.name === defaultMealName);
    container.innerHTML += `
      <div class="swap-item" onclick="confirmSwap('${dayKey}', '${slotId}', '${opt.id}')">
        <div><strong>${opt.emoji} ${opt.name}</strong> ${isCurrentDef ? '<span style="font-size:0.7rem; color:var(--primary);">(Default)</span>' : ''}</div>
      </div>
    `;
  });
  
  document.getElementById('swap-modal').classList.remove('hidden');
}

window.confirmSwap = async function(dayKey, slotId, newMealId) {
  if (!appState.swappedMeals) appState.swappedMeals = {};
  const swapKey = `${dayKey}_${slotId}`;
  
  if (newMealId === null) delete appState.swappedMeals[swapKey];
  else appState.swappedMeals[swapKey] = newMealId;
  
  await saveSwappedMeals(appState.swappedMeals);
  document.getElementById('swap-modal').classList.add('hidden');
  scheduleDailyNotifications();
  handleRoute(); 
}

// ------------------------------------
// RENDER CHEF MODE
// ------------------------------------
window.changeChefDay = function(val) {
  appState.deviceSettings.prepSelectedDay = val;
  saveLocalDeviceSettings(appState.deviceSettings);
  renderChef();
}
window.toggleChefAccordion = function(id) {
  document.getElementById(id).classList.toggle('hidden');
}

function formatBatchNote(text, multiplier) {
  if (!text) return "";
  return text.replace(/\{([a-zA-Z_]+)\*([\d.]+)\}/g, (match, ingId, mult) => {
    return formatQty(parseFloat(mult) * multiplier * 100) + "g";
  });
}

async function renderChef() {
  const container = document.getElementById('view-chef');
  const todayKey = getTodayKey();
  const selectedDay = appState.deviceSettings.prepSelectedDay || todayKey;
  const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const nextDayKey = weekDays[(weekDays.indexOf(selectedDay) + 1) % 7];
  const multiplier = getMultiplier();

  const todayPlan = MEAL_PLAN[selectedDay];
  const todayType = getDayType(selectedDay);
  const nextPlan = MEAL_PLAN[nextDayKey];
  const nextType = getDayType(nextDayKey);
  
  const dinnerMeals = getDynamicMealsForDay(selectedDay, todayType);
  const dinnerMealBase = dinnerMeals.find(m => m.slot === 'dinner');
  const dinner = appState.customRecipes[dinnerMealBase.id] || dinnerMealBase;

  let html = `
    <div class="flex-between" style="margin-bottom:1rem; margin-top:0.5rem;">
      <h2 style="margin:0;">In Cucina Oggi</h2>
      <select onchange="changeChefDay(this.value)" style="padding:0.3rem; border-radius:6px; border:1px solid rgba(0,0,0,0.1); background:var(--surface);">
        <option value="monday" ${selectedDay === 'monday' ? 'selected' : ''}>Lunedì</option>
        <option value="tuesday" ${selectedDay === 'tuesday' ? 'selected' : ''}>Martedì</option>
        <option value="wednesday" ${selectedDay === 'wednesday' ? 'selected' : ''}>Mercoledì</option>
        <option value="thursday" ${selectedDay === 'thursday' ? 'selected' : ''}>Giovedì</option>
        <option value="friday" ${selectedDay === 'friday' ? 'selected' : ''}>Venerdì</option>
        <option value="saturday" ${selectedDay === 'saturday' ? 'selected' : ''}>Sabato</option>
        <option value="sunday" ${selectedDay === 'sunday' ? 'selected' : ''}>Domenica</option>
      </select>
    </div>
  `;

  // 1. I PASTI DI OGGI (Mattina, Pranzo, Spuntini) CHIUSI
  html += `<h3 style="color:var(--primary); margin-top:1.5rem; margin-bottom:0.5rem;">☀️ I Pasti di Oggi</h3>`;
  const todayMealsToPrep = getDynamicMealsForDay(selectedDay, todayType).filter(m => m.slot !== 'dinner');
  
  for (const tMealBase of todayMealsToPrep) {
    const tMeal = appState.customRecipes[tMealBase.id] || tMealBase;
    const uniqueAccId = `chef-acc-${tMeal.id}-today`;
    const slotLabel = MEAL_SLOTS.find(s=>s.id===tMeal.slot).label;
    
    html += `
      <div class="settings-section" style="margin-bottom:0.5rem; padding:0.5rem 1rem;">
        <div class="flex-between" style="cursor:pointer;" onclick="toggleChefAccordion('${uniqueAccId}')">
          <span style="font-weight:600;">${slotLabel}</span>
          <span style="color:var(--text-muted);">${tMeal.emoji} ${tMeal.name} ▼</span>
        </div>
        <div id="${uniqueAccId}" class="hidden" style="margin-top:1rem; border-top:1px solid rgba(0,0,0,0.05); padding-top:0.5rem;">
    `;
    
    if(tMeal.prepNote || tMeal.batchNote || tMeal.supplement) {
      let msg = tMeal.supplement ? `💡 Integrazione: ${tMeal.supplement}` : `⚠️ Attenzione: ${formatBatchNote(tMeal.prepNote || tMeal.batchNote, multiplier)}`;
      html += `
        <div style="background-color:rgba(244, 162, 97, 0.1); border-left:4px solid var(--accent); padding:0.5rem; margin-bottom:1rem; border-radius:4px;">
          <p style="font-size:0.85rem; color:var(--accent); font-weight:bold; margin:0;">${msg}</p>
        </div>
      `;
    }

    html += `<div style="display:flex; gap:1rem; flex-wrap:wrap;">`;
    html += `<div style="flex:1; min-width:140px;">`;
    html += `<h5 style="color:var(--text-muted); margin-bottom:0.5rem;">Ingredienti:</h5>`;
    html += `<ul style="list-style:none; padding:0; font-size:0.85rem;">`;
    tMeal.ingredients.forEach(ing => {
      let baseQty = ing.quantity;
      let fQty = baseQty;
      if (typeof fQty === 'number' && ing.unit !== 'q.b.') fQty = formatQty(fQty * multiplier);
      let split = "";
      if (typeof baseQty === 'number' && ing.unit !== 'q.b.') {
        split = getPerPersonSplit(baseQty, ing.unit);
      }
      html += `<li class="step-item" style="padding:0.2rem 0; border-bottom:1px solid rgba(0,0,0,0.05);" onclick="this.classList.toggle('done')"><strong>${fQty} ${ing.unit==='q.b.'||ing.unit==='pz'?'':ing.unit}</strong> ${ing.name} ${split ? `<span style="font-size:0.75rem; color:var(--text-muted);">${split}</span>` : ''}</li>`;
    });
    html += `</ul></div>`;
    
    html += `<div style="flex:1.5; min-width:200px;">`;
    html += `<h5 style="color:var(--text-muted); margin-bottom:0.5rem;">Cosa fare:</h5>`;
    html += `<ul style="list-style:none; padding:0; font-size:0.85rem;">`;
    tMeal.steps.forEach((step, i) => {
      html += `<li class="step-item" style="padding:0.3rem 0; border-bottom:1px solid rgba(0,0,0,0.05);" onclick="this.classList.toggle('done')"><strong>${i+1}.</strong> ${step}</li>`;
    });
    html += `</ul></div></div>`;
    html += `<div style="display:flex; gap:0.5rem; margin-top:1rem;">
               <button class="btn btn-outline" style="flex:1; font-size:0.8rem; padding:0.3rem;" onclick="openRecipeModal('${tMeal.id}', '${selectedDay}', '${todayType}', '${tMeal.slot}')">Modifica Ricetta Base</button>
             </div>`;
    html += `</div></div>`;
  }

  // 2. CENA DI STASERA E BATCH COOKING (Aperta di Default)
  html += `<h3 style="color:var(--accent); margin-top:2rem; margin-bottom:0.5rem;">🍳 La Cena di Stasera (${todayPlan.dayName})</h3>`;
  html += `<div class="settings-section" style="border-left: 4px solid var(--accent); padding-bottom: 0.5rem;">`;
  
  if (todayPlan.batchCooking.evening) {
    html += `
      <div style="background-color:rgba(244, 162, 97, 0.1); padding:0.75rem; border-radius:6px; margin-bottom:1rem;">
        <p style="font-weight:bold; font-size:1.05rem; color:var(--accent); margin:0;">${formatBatchNote(todayPlan.batchCooking.evening, multiplier)}</p>
      </div>
    `;
  }

  // Niente tasto swap per lo Chef Mode
  html += `<h4 style="margin-bottom:1rem;">${dinner.emoji} ${dinner.name}</h4>`;
  html += `<div style="display:flex; gap:1rem; flex-wrap:wrap;">`;
  
  html += `<div style="flex:1; min-width:140px;">`;
  html += `<h5 style="color:var(--text-muted); margin-bottom:0.5rem;">Ingredienti:</h5>`;
  html += `<ul style="list-style:none; padding:0; font-size:0.85rem;">`;
  dinner.ingredients.forEach(ing => {
    let baseQty = ing.quantity;
    let fQty = baseQty;
    if (typeof fQty === 'number' && ing.unit !== 'q.b.') fQty = formatQty(fQty * multiplier);
    let split = "";
    if (typeof baseQty === 'number' && ing.unit !== 'q.b.') {
      split = getPerPersonSplit(baseQty, ing.unit);
    }
    html += `<li class="step-item" style="padding:0.2rem 0; border-bottom:1px solid rgba(0,0,0,0.05);" onclick="this.classList.toggle('done')"><strong>${fQty} ${ing.unit==='q.b.'||ing.unit==='pz'?'':ing.unit}</strong> ${ing.name} ${split ? `<span style="font-size:0.75rem; color:var(--text-muted);">${split}</span>` : ''}</li>`;
  });
  html += `</ul></div>`;
  
  html += `<div style="flex:1.5; min-width:200px;">`;
  html += `<h5 style="color:var(--text-muted); margin-bottom:0.5rem;">Passaggi:</h5>`;
  html += `<ul style="list-style:none; padding:0; font-size:0.85rem;">`;
  dinner.steps.forEach((step, i) => {
    html += `<li class="step-item" style="padding:0.3rem 0; border-bottom:1px solid rgba(0,0,0,0.05);" onclick="this.classList.toggle('done')"><strong>${i+1}.</strong> ${step}</li>`;
  });
  html += `</ul></div></div>`;
  html += `<button class="btn btn-outline" style="width:100%; margin-top:1rem; font-size:0.8rem; padding:0.3rem;" onclick="openRecipeModal('${dinner.id}', '${selectedDay}', '${todayType}', '${dinner.slot}')">Modifica Ricetta Base</button>`;
  html += `</div>`;

  // 3. SCHISCETTE DI DOMANI (Accordion Chiuso)
  html += `<h3 style="color:var(--rest); margin-top:2rem; margin-bottom:0.5rem;">🍱 Box per Domani (${nextPlan.dayName})</h3>`;
  html += `<p class="text-muted" style="font-size:0.85rem; margin-bottom:1rem;">Apri i menu per preparare la borsa frigo di domani (esclusa la cena).</p>`;
  
  const tomorrowMeals = getDynamicMealsForDay(nextDayKey, nextType);
  
  for (const tMealBase of tomorrowMeals) {
    const tMeal = appState.customRecipes[tMealBase.id] || tMealBase;
    const uniqueAccId = `chef-acc-${tMeal.id}-tomorrow`;
    const slotLabel = MEAL_SLOTS.find(s=>s.id===tMeal.slot).label;
    
    html += `
      <div class="settings-section" style="margin-bottom:0.5rem; padding:0.5rem 1rem;">
        <div class="flex-between" style="cursor:pointer;" onclick="toggleChefAccordion('${uniqueAccId}')">
          <span style="font-weight:600;">${slotLabel}</span>
          <span style="color:var(--text-muted);">${tMeal.emoji} ${tMeal.name} ▼</span>
        </div>
        <div id="${uniqueAccId}" class="hidden" style="margin-top:1rem; border-top:1px solid rgba(0,0,0,0.05); padding-top:0.5rem;">
    `;
    
    if(tMeal.prepNote || tMeal.batchNote || tMeal.supplement) {
      let msg = tMeal.supplement ? `💡 Integrazione: ${tMeal.supplement}` : `⚠️ Attenzione: ${formatBatchNote(tMeal.prepNote || tMeal.batchNote, multiplier)}`;
      html += `
        <div style="background-color:rgba(244, 162, 97, 0.1); border-left:4px solid var(--accent); padding:0.5rem; margin-bottom:1rem; border-radius:4px;">
          <p style="font-size:0.85rem; color:var(--accent); font-weight:bold; margin:0;">${msg}</p>
        </div>
      `;
    }

    html += `<div style="display:flex; gap:1rem; flex-wrap:wrap;">`;
    
    html += `<div style="flex:1; min-width:140px;">`;
    html += `<h5 style="color:var(--text-muted); margin-bottom:0.5rem;">Ingredienti:</h5>`;
    html += `<ul style="list-style:none; padding:0; font-size:0.85rem;">`;
    tMeal.ingredients.forEach(ing => {
      let baseQty = ing.quantity;
      let fQty = baseQty;
      if (typeof fQty === 'number' && ing.unit !== 'q.b.') fQty = formatQty(fQty * multiplier);
      let split = "";
      if (typeof baseQty === 'number' && ing.unit !== 'q.b.') {
        split = getPerPersonSplit(baseQty, ing.unit);
      }
      html += `<li class="step-item" style="padding:0.2rem 0; border-bottom:1px solid rgba(0,0,0,0.05);" onclick="this.classList.toggle('done')"><strong>${fQty} ${ing.unit==='q.b.'||ing.unit==='pz'?'':ing.unit}</strong> ${ing.name} ${split ? `<span style="font-size:0.75rem; color:var(--text-muted);">${split}</span>` : ''}</li>`;
    });
    html += `</ul></div>`;
    
    html += `<div style="flex:1.5; min-width:200px;">`;
    html += `<h5 style="color:var(--text-muted); margin-bottom:0.5rem;">Cosa fare:</h5>`;
    html += `<ul style="list-style:none; padding:0; font-size:0.85rem;">`;
    tMeal.steps.forEach((step, i) => {
      html += `<li class="step-item" style="padding:0.3rem 0; border-bottom:1px solid rgba(0,0,0,0.05);" onclick="this.classList.toggle('done')"><strong>${i+1}.</strong> ${step}</li>`;
    });
    html += `</ul></div></div>`;
    
    html += `<div style="display:flex; gap:0.5rem; margin-top:1rem;">
               <button class="btn btn-outline" style="flex:1; font-size:0.8rem; padding:0.3rem;" onclick="openRecipeModal('${tMeal.id}', '${nextDayKey}', '${nextType}', '${tMeal.slot}')">Modifica Ricetta Base</button>
             </div>`;
    
    html += `</div></div>`;
  }
  container.innerHTML = html;
}

// ------------------------------------
// RENDER WEEK
// ------------------------------------
function renderWeek() {
  const container = document.getElementById('view-week');
  const todayKey = getTodayKey();
  
  let html = `<h2 style="margin-top:0.5rem;">Piano Settimanale</h2><p class="text-muted" style="margin-bottom:1rem;">Imposta i giorni di allenamento. Le quantità in tutto il sistema si adatteranno istantaneamente.</p><div class="week-grid">`;
  const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  
  weekDays.forEach(dayKey => {
    const plan = MEAL_PLAN[dayKey];
    const dayType = getDayType(dayKey);
    const meals = getDynamicMealsForDay(dayKey, dayType);
    const isToday = dayKey === todayKey;
    
    html += `
      <div class="day-column ${isToday ? 'current-day' : ''}">
        <div class="flex-between">
          <h3>${plan.dayName}</h3>
          ${isToday ? '<span style="font-size:1.2rem;" title="Oggi">⭐</span>' : ''}
        </div>
        <div class="pill-toggle" style="transform: scale(0.8); transform-origin: left; margin: 0.25rem 0;">
          <button class="pill-btn ${dayType === 'training' ? 'active training' : ''}" onclick="toggleDayType('${dayKey}', 'training')">🏋️</button>
          <button class="pill-btn ${dayType === 'rest' ? 'active rest' : ''}" onclick="toggleDayType('${dayKey}', 'rest')">😴</button>
        </div>
        <div>
    `;
    meals.forEach(meal => { 
      html += `
        <div class="day-meal-item flex-between">
          <div onclick="openRecipeModal('${meal.id}', '${dayKey}', '${dayType}', '${meal.slot}')" style="flex:1; cursor:pointer;">${meal.emoji} ${meal.name}</div>
          <button class="btn-icon btn-swap" onclick="openSwapModal('${dayKey}', '${meal.slot}')">🔄</button>
        </div>`; 
    });
    html += `</div></div>`;
  });
  html += `</div>`;
  container.innerHTML = html;
}

window.toggleDayType = async function(dayKey, type) {
  if (!appState.weekPlan) appState.weekPlan = {};
  appState.weekPlan[dayKey] = type;
  await saveWeekPlan(appState.weekPlan);
  scheduleDailyNotifications();
  setTimeout(handleRoute, 50);
};

// ------------------------------------
// RENDER RECIPES (Ricettario Globale)
// ------------------------------------
window.createNewRecipe = function() {
  const tempId = 'custom_' + Date.now();
  currentModalMeal = { 
    id: tempId, dayKey: 'sunday', dayType: 'rest', 
    data: { id: tempId, slot: 'lunch', name: "Nuova Ricetta", emoji: "🍲", prepTime: "10 min", ingredients: [], steps: [], batchNote: null, supplement: null },
    isCustom: false 
  };
  editMode = true;
  renderModalContent();
  document.getElementById('recipe-modal').classList.remove('hidden');
}

function renderRecipes() {
  const container = document.getElementById('view-recipes');
  let html = `<div class="flex-between" style="margin-top:0.5rem; margin-bottom:1rem;"><h2 style="margin:0;">Ricettario</h2><button class="btn btn-primary" style="padding:0.2rem 0.5rem; font-size:0.85rem;" onclick="createNewRecipe()">+ Nuova</button></div>`;
  html += `<p class="text-muted" style="margin-bottom:1rem;">Sfoglia tutte le ricette. Pranzi, cene e spuntini sono intercambiabili tra loro dalla vista "Settimana".</p>`;
  
  let dictionary = { breakfast:[], snack1:[], lunch:[], snack2:[], dinner:[] };
  
  const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  for (const day of weekDays) {
    for (const type of ['training', 'rest']) {
      if(MEAL_PLAN[day].meals[type]) {
        for (const m of MEAL_PLAN[day].meals[type]) {
          const finalM = appState.customRecipes[m.id] || m;
          if(!dictionary[m.slot].find(x => x.name === finalM.name)) {
            dictionary[m.slot].push({ name: finalM.name, emoji: finalM.emoji, id: m.id, day: day, type: type, originalSlot: m.slot });
          }
        }
      }
    }
  }

  Object.values(appState.customRecipes).forEach(cust => {
    if (cust.id && cust.id.startsWith('custom_') && !dictionary[cust.slot].find(x => x.name === cust.name)) {
      dictionary[cust.slot].push({ name: cust.name, emoji: cust.emoji || "🍲", id: cust.id, day: 'sunday', type: 'rest', originalSlot: cust.slot });
    }
  });

  MEAL_SLOTS.forEach(slot => {
    if(dictionary[slot.id].length > 0) {
      html += `<h3 style="margin-top:1.5rem; margin-bottom:0.5rem; color:var(--primary); border-bottom:2px solid var(--primary-light); padding-bottom:0.25rem;">${slot.label}</h3>`;
      html += `<div class="settings-section" style="padding:0.5rem;">`;
      dictionary[slot.id].forEach(item => {
        html += `<div class="day-meal-item" onclick="openRecipeModal('${item.id}', '${item.day}', '${item.type}', '${item.originalSlot}')">${item.emoji} ${item.name}</div>`;
      });
      html += `</div>`;
    }
  });

  container.innerHTML = html;
}

// ------------------------------------
// RENDER SHOP
// ------------------------------------
window.toggleShopSettings = function() {
  shopSettingsVisible = !shopSettingsVisible;
  renderShop();
}

window.toggleShopAllWeek = async function(selectAll) {
  const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  if (!appState.shoppingListCloud.selectedMeals) appState.shoppingListCloud.selectedMeals = {};
  weekDays.forEach(day => {
    if (selectAll) appState.shoppingListCloud.selectedMeals[day] = ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'];
    else appState.shoppingListCloud.selectedMeals[day] = [];
  });
  await saveShoppingListCloud(appState.shoppingListCloud);
  renderShop();
}

function renderShop() {
  const container = document.getElementById('view-shop');
  
  let shopCloud = appState.shoppingListCloud;
  if (!shopCloud.selectedMeals) shopCloud.selectedMeals = { monday:[], tuesday:[], wednesday:[], thursday:[], friday:[], saturday:[], sunday:[] };
  if (!shopCloud.customDays) shopCloud.customDays = { monday:'training', tuesday:'training', wednesday:'training', thursday:'rest', friday:'training', saturday:'rest', sunday:'rest' };
  
  let hasSelection = false;
  Object.values(shopCloud.selectedMeals).forEach(arr => { if (arr.length > 0) hasSelection = true; });
  if (!hasSelection) shopSettingsVisible = true;
  
  const mode = shopCloud.mode || 'current';
  const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  
  let html = `<h2 style="margin-top:0.5rem; margin-bottom:1rem;">Lista Spesa</h2>`;
  
  html += `
    <div class="flex-between" style="margin-bottom:1rem;">
      <h3 style="margin:0;">Impostazioni Giorni</h3>
      <button class="btn btn-outline" style="min-height:30px; padding:0.25rem 0.5rem; font-size:0.85rem;" onclick="toggleShopSettings()">
        ${shopSettingsVisible ? 'Nascondi ▲' : 'Modifica ▼'}
      </button>
    </div>
  `;
  if (shopSettingsVisible) {
    html += `
      <div class="settings-section" style="margin-bottom:1rem;">
        <label style="display:block; margin-bottom:0.5rem;"><input type="radio" name="shopMode" value="current" ${mode==='current'?'checked':''} onchange="setShopMode('current')"> Usa piano settimana corrente</label>
        <label style="display:block;"><input type="radio" name="shopMode" value="custom" ${mode==='custom'?'checked':''} onchange="setShopMode('custom')"> Personalizza (Scegli tu i giorni)</label>
    `;
    if (mode === 'custom') {
      html += `<div style="display:grid; grid-template-columns: 1fr 1fr; gap:0.5rem; margin-top:1rem;">`;
      weekDays.forEach(day => {
        const type = shopCloud.customDays[day];
        html += `
          <div style="background:rgba(0,0,0,0.03); padding:0.5rem; border-radius:6px; font-size:0.85rem;">
            <strong>${MEAL_PLAN[day].dayName.substring(0,3)}</strong>: 
            <select onchange="setCustomShopDayType('${day}', this.value)" style="margin-left:0.5rem; padding:0.1rem;">
              <option value="training" ${type==='training'?'selected':''}>🏋️</option>
              <option value="rest" ${type==='rest'?'selected':''}>😴</option>
            </select>
          </div>
        `;
      });
      html += `</div>`;
    }
    html += `</div>`;
  }

  html += `
    <div class="settings-section" style="margin-bottom:1.5rem;">
      <h3>Seleziona cosa comprare</h3>
      <div style="display:flex; gap:0.5rem; margin-bottom:1rem;">
        <button class="btn btn-outline" style="flex:1; padding:0.25rem; font-size:0.8rem;" onclick="toggleShopAllWeek(true)">Seleziona Tutto</button>
        <button class="btn btn-outline" style="flex:1; padding:0.25rem; font-size:0.8rem;" onclick="toggleShopAllWeek(false)">Deseleziona Tutto</button>
      </div>
  `;
  weekDays.forEach(day => {
    const selMeals = shopCloud.selectedMeals[day] || [];
    const isWholeDay = selMeals.length === 5;
    html += `
      <div style="margin-bottom: 0.5rem; border: 1px solid rgba(0,0,0,0.05); border-radius: 8px; padding: 0.5rem;">
        <div class="flex-between">
          <label style="font-weight:bold;"><input type="checkbox" id="shop-day-${day}" onchange="toggleShopWholeDay('${day}', this.checked)" ${isWholeDay?'checked':''}> ${MEAL_PLAN[day].dayName}</label>
          <button class="btn btn-icon" style="min-height:30px; font-size:0.8rem; background:rgba(0,0,0,0.03);" onclick="document.getElementById('shop-det-${day}').classList.toggle('hidden')">▼</button>
        </div>
        <div id="shop-det-${day}" class="hidden" style="margin-top:0.5rem; padding-left: 1.5rem; display:flex; flex-wrap:wrap; gap:0.5rem; font-size:0.85rem;">
    `;
    MEAL_SLOTS.forEach(slot => {
      const isChecked = selMeals.includes(slot.id);
      html += `<label><input type="checkbox" onchange="toggleShopMeal('${day}', '${slot.id}', this.checked)" ${isChecked?'checked':''}> ${slot.label}</label>`;
    });
    html += `</div></div>`;
  });
  html += `</div>`;

  let multiplier = getMultiplier();
  let categoriesMap = {};
  let totalItemsCount = 0;

    // --- Nuova logica categorie e merging ---
  // Mappa per categorie non più basata su substring ambiguo
  // Usa getCategoryForIngredient e normalizeIngredientName

  let aggList = {};


  weekDays.forEach(day => {
    const type = (mode === 'custom') ? shopCloud.customDays[day] : getDayType(day);
    const mealsForDay = shopCloud.selectedMeals[day] || [];
    const planMeals = getDynamicMealsForDay(day, type);
    
    mealsForDay.forEach(slot => {
      const meal = planMeals.find(m => m.slot === slot);
      if(meal) {
        meal.ingredients.forEach(ing => {
          let canonicalName = normalizeIngredientName(ing.name);
          let catName = getCategoryForIngredient(ing.name);
          let u = ing.unit;
          let q = ing.quantity;
          // Hash basato su nome canonicalizzato per mergiare varianti
          let hashId = canonicalName.toLowerCase().replace(/[^a-z0-9]/g, '');
          // Fallback per unità diverse con stesso nome: includi unità nel hash se diversa (es. g vs pz) ma per uova ora è pz
          // Per evitare collisioni tra g e pz diversi, usa solo nome canonical ma conserva unità prevalente
          
          if (!aggList[hashId]) {
            aggList[hashId] = { id: hashId, name: canonicalName, category: catName, unit: u, qty: 0, mealsTags: [] };
          }
          // Se unità differisce ma nome stesso, mantieni quella del primo incontro (es. g) - per uova è pz ormai
          if (typeof q === 'number') aggList[hashId].qty += q;
          
          let slotLabelForTag = MEAL_SLOTS.find(s=>s.id===slot).label;
          let tag = `${MEAL_PLAN[day].dayName.substring(0,3)} (${slotLabelForTag})`;
          if (!aggList[hashId].mealsTags.includes(tag)) {
            aggList[hashId].mealsTags.push(tag);
          }
        });
      }
    });
  });

  const s = appState.deviceSettings;
  const persons = s.persons || 2;
  const twoType = s.twoPersonsType || 'mf';

  Object.values(aggList).forEach(item => {
    if (item.qty > 0 || item.unit === 'q.b.' || item.unit === 'pz') {
      let finalQty = item.unit === 'q.b.' ? item.qty : item.qty * multiplier;
      finalQty = formatQty(finalQty);
      
      let splitText = "";
      if (persons === 2 && item.unit !== 'pz' && item.unit !== 'q.b.') {
          let user1, user2;
          if (twoType === 'mf') { user1 = formatQty(item.qty * 1); user2 = formatQty(item.qty * 0.75); splitText = `(Uomo: ${user1}${item.unit}, Donna: ${user2}${item.unit})`; }
          else if (twoType === 'fm') { user1 = formatQty(item.qty * 1); user2 = formatQty(item.qty * 1.25); splitText = `(Donna: ${user1}${item.unit}, Uomo: ${user2}${item.unit})`; }
          else { user1 = formatQty(item.qty * 1); splitText = `(Ciascuno: ${user1}${item.unit})`; }
      }

      if (shopCloud.customQtys && shopCloud.customQtys[item.id] !== undefined) finalQty = shopCloud.customQtys[item.id];
      
      if (!categoriesMap[item.category]) categoriesMap[item.category] = [];
      categoriesMap[item.category].push({
        id: item.id, name: item.name, qty: finalQty, unit: item.unit,
        days: item.mealsTags.join(' • '), checked: (shopCloud.checkedItems || []).includes(item.id),
        splitText: splitText
      });
      totalItemsCount++;
    }
  });

  const orderedCategories = ["🥩 Carne", "🐟 Pesce", "🥚 Uova e Latticini", "🫘 Legumi", "🍚 Carboidrati", "🥬 Verdura", "🍑 Frutta", "🥫 Dispensa", "🌿 Spezie e Aromi"];
  window.currentCategoriesMap = categoriesMap; 
  
  orderedCategories.forEach(cat => {
    if (categoriesMap[cat] && categoriesMap[cat].length > 0) {
      html += `<div class="shop-category"><div class="shop-category-title">${cat}</div>`;
      categoriesMap[cat].sort((a,b) => (a.checked === b.checked) ? 0 : a.checked ? 1 : -1);
      categoriesMap[cat].forEach(item => {
        html += `
          <div class="shop-item ${item.checked ? 'checked' : ''}" onclick="toggleShopItem('${item.id}', event)">
            <input type="checkbox" ${item.checked ? 'checked' : ''} style="pointer-events:none;">
            <div class="shop-item-details">
              <div>${item.name}</div>
              <div class="shop-item-tags" style="color:var(--primary); font-weight:500;">${item.days}</div>
              ${item.splitText ? `<div class="text-muted" style="font-size:0.7rem; margin-top:2px;">${item.splitText}</div>` : ''}
            </div>
            <div class="shop-item-qty">
              <input type="text" inputmode="decimal" class="editable-qty" value="${item.qty}" onclick="event.stopPropagation()" onchange="updateShopItemQty('${item.id}', this.value)">
              ${item.unit === 'q.b.' || item.unit === 'pz' ? '' : `<span style="font-size:0.8rem; margin-left:2px;">${item.unit}</span>`}
            </div>
          </div>
        `;
      });
      html += `</div>`;
    }
  });
  
  if (totalItemsCount === 0) html += `<p class="text-muted" style="text-align:center; padding:2rem 0;">Nessun pasto selezionato per la spesa.</p>`;
  html += `
    <div style="display:flex; flex-direction:column; gap:0.5rem; margin-top:2rem;">
      <button class="btn btn-primary" style="width:100%; background-color:#25D366; color:white; border:none;" onclick="shareShopWhatsApp()">Invia su WhatsApp</button>
      <div style="display:flex; gap:0.5rem;">
        <button class="btn btn-outline" style="flex:1;" onclick="resetShopChecks()">Reset spunte</button>
        <button class="btn btn-danger" style="flex:1;" onclick="resetShopList()">Svuota lista</button>
      </div>
    </div>
  `;
  container.innerHTML = html;
  // Checkbox "giorno" in stato indeterminato (—) se selezionati solo alcuni pasti
weekDays.forEach(day => {
  const cb = document.getElementById('shop-day-' + day);
  if (cb) {
    const arr = shopCloud.selectedMeals[day] || [];
    cb.indeterminate = arr.length > 0 && arr.length < 5;
  }
});
}

window.shareShopWhatsApp = function() {
  let text = "🛒 *Lista della Spesa*\n\n";
  const orderedCategories = ["🥩 Carne", "🐟 Pesce", "🥚 Uova e Latticini", "🫘 Legumi", "🍚 Carboidrati", "🥬 Verdura", "🍑 Frutta", "🥫 Dispensa", "🌿 Spezie e Aromi"];
  
  orderedCategories.forEach(cat => {
    if (window.currentCategoriesMap[cat] && window.currentCategoriesMap[cat].length > 0) {
      const uncheckedItems = window.currentCategoriesMap[cat].filter(i => !i.checked);
      if (uncheckedItems.length > 0) {
        text += `*${cat}*\n`;
        uncheckedItems.forEach(item => {
          text += `- ${item.name}: ${item.qty}${item.unit === 'q.b.' || item.unit === 'pz' ? '' : item.unit}\n`;
        });
        text += `\n`;
      }
    }
  });

  if (navigator.share) {
    navigator.share({ title: 'Lista della Spesa', text: text }).catch((error) => console.log('Errore condivisione', error));
  } else {
    const url = `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  }
}

window.setShopMode = async function(mode) { appState.shoppingListCloud.mode = mode; await saveShoppingListCloud(appState.shoppingListCloud); renderShop(); }
window.setCustomShopDayType = async function(day, type) { appState.shoppingListCloud.customDays[day] = type; await saveShoppingListCloud(appState.shoppingListCloud); renderShop(); }
window.toggleShopWholeDay = async function(day, isChecked) {
  if (isChecked) appState.shoppingListCloud.selectedMeals[day] = ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'];
  else appState.shoppingListCloud.selectedMeals[day] = [];
  await saveShoppingListCloud(appState.shoppingListCloud); renderShop();
}
window.toggleShopMeal = async function(day, slot, isChecked) {
  if (isChecked && !appState.shoppingListCloud.selectedMeals[day].includes(slot)) appState.shoppingListCloud.selectedMeals[day].push(slot);
  else if (!isChecked) appState.shoppingListCloud.selectedMeals[day] = appState.shoppingListCloud.selectedMeals[day].filter(s => s !== slot);
  await saveShoppingListCloud(appState.shoppingListCloud); renderShop();
}

window.toggleShopItem = async function(id, event) {
  if (event.target.tagName.toLowerCase() === 'input' && event.target.type === 'text') return;
  let list = appState.shoppingListCloud.checkedItems || [];
  if (list.includes(id)) list = list.filter(i => i !== id); else list.push(id);
  appState.shoppingListCloud.checkedItems = list;
  await saveShoppingListCloud(appState.shoppingListCloud); renderShop();
}
window.updateShopItemQty = async function(id, val) {
  if (!appState.shoppingListCloud.customQtys) appState.shoppingListCloud.customQtys = {};
  appState.shoppingListCloud.customQtys[id] = val;
  await saveShoppingListCloud(appState.shoppingListCloud); renderShop();
}
window.resetShopChecks = async function() {
  if (confirm("Rimuovere le spunte?")) { appState.shoppingListCloud.checkedItems = []; await saveShoppingListCloud(appState.shoppingListCloud); renderShop(); }
}
window.resetShopList = async function() {
  if (confirm("Azzerare le selezioni?")) {
    appState.shoppingListCloud.selectedMeals = { monday:[], tuesday:[], wednesday:[], thursday:[], friday:[], saturday:[], sunday:[] };
    appState.shoppingListCloud.checkedItems = []; appState.shoppingListCloud.customQtys = {}; shopSettingsVisible = true;
    await saveShoppingListCloud(appState.shoppingListCloud); renderShop();
  }
}

// ------------------------------------
// RENDER SETTINGS & GUIDE
// ------------------------------------
function renderGuide() {} // Mantenuto stub anti-crash per il routing

function renderSettings() {
  const container = document.getElementById('view-settings');
  const s = appState.settings;
  const deviceS = appState.deviceSettings;
  
  let html = `
    <h2 style="margin-top:0.5rem;">Impostazioni e Guida</h2>
    
    <div class="settings-section">
      <h3>Aspetto (Solo questo dispositivo)</h3>
      <div class="settings-row">
        <label>Tema Scuro (AMOLED)</label>
        <input type="checkbox" ${deviceS.darkMode ? 'checked' : ''} onchange="toggleDarkMode(this.checked)">
      </div>
    </div>
    
    <div class="settings-section">
      <h3>Orari Pasti e Notifiche</h3>
      <p class="text-muted" style="margin-bottom:1rem; font-size:0.85rem;">Su PC le notifiche sono attive di default. Su mobile sono disabilitate.</p>
  `;
  
  MEAL_SLOTS.forEach(slot => {
    html += `
      <div class="settings-row">
        <label>${slot.label}</label>
        <input type="time" value="${s.notificationTimes[slot.id]}" onchange="updateNotificationTime('${slot.id}', this.value)">
      </div>
    `;
  });
  html += `</div>`;

  html += `
    <h3 style="margin-top:2rem; margin-bottom:1rem;">Manuale Dieta</h3>
    
    <div class="settings-section" style="margin-bottom:1rem;">
      <h3 style="color:var(--primary); margin-bottom:0.5rem; border-bottom:1px solid rgba(0,0,0,0.05); padding-bottom:0.5rem;" onclick="this.nextElementSibling.classList.toggle('hidden')" style="cursor:pointer;">
        Struttura Dieta ▼
      </h3>
      <div class="hidden" style="line-height:1.6; padding-top:0.5rem;">
        <ul style="padding-left:1.2rem; margin-top:0.5rem; margin-bottom:1rem;">
          <li style="margin-bottom:0.5rem;"><strong>1° giorno: allenamento.</strong> Bilanciata, ricca di carboidrati. Crackers nello spuntino mattutino. Quote carboidrati e proteine aumentate a pranzo.</li>
          <li style="margin-bottom:0.5rem;"><strong>2° giorno: riposo.</strong> Pasti bilanciati. Quota carboidrati e proteine leggermente ridotta. Niente crackers.</li>
        </ul>
        <p class="text-muted"><em>NB: preferisci fonti di carboidrati non integrali prima e dopo un allenamento e nel carico. Libera negli altri momenti.</em></p>
      </div>
    </div>

    <div class="settings-section" style="margin-bottom:1rem;">
      <h3 style="color:var(--primary); margin-bottom:0.5rem; border-bottom:1px solid rgba(0,0,0,0.05); padding-bottom:0.5rem;" onclick="this.nextElementSibling.classList.toggle('hidden')" style="cursor:pointer;">
        1° Giorno (Allenamento) ▼
      </h3>
      <div class="hidden" style="line-height:1.6; padding-top:0.5rem; font-size:0.9rem;">
        <h4 style="color:var(--accent);">COLAZIONE</h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li>Avena <strong>40g</strong>, Yogurt greco 0% <strong>100g</strong>, Marmellata <strong>15g</strong></li>
          <li><em>Alt 1:</em> Kefir 100g o Uova intere 60g / Miele 10g</li>
          <li><em>Alt 2 (Pancake Albume):</em> Albume 120g, Yogurt 40g, Avena 40g, Marmellata 30g</li>
          <li><em>Alt 3:</em> Yogurt 200g, Cereali 50g, Marmellata 10g</li>
          <li><em>Alt 4:</em> Latte parz. scremato 250g, Cereali 50g</li>
        </ul>
        
        <h4 style="color:var(--accent);">SPUNTINO MATTINA <span style="font-weight:normal;">(Giorno Allenamento)</span></h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li>Frutta fresca <strong>250g</strong>, Crackers <strong>30g</strong>, Proteine <strong>30g</strong></li>
        </ul>

        <h4 style="color:var(--accent);">PRANZO</h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li>Pasta/Riso <strong>90g</strong> (<em>Alt:</em> Gnocchi 250g, Farro 90g, Quinoa 80g, Pane 120g, Patate 450g)</li>
          <li>Pollame <strong>200g</strong> (<em>Alt:</em> Manzo 150g, Maiale 100g, Merluzzo 250g, Uova 180g)</li>
          <li>Verdura <strong>200g</strong></li>
          <li>Olio EVO <strong>10g</strong></li>
        </ul>

        <h4 style="color:var(--accent);">MERENDA <span style="font-weight:normal;">(Indifferente: Allenamento o Riposo)</span></h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li><strong>Opzione 1:</strong> Yogurt greco 0% bianco <strong>150g</strong>, Miele/Sciroppo d'acero <strong>15g</strong> (oppure Marmellata 20g)</li>
          <li><strong>Opzione 2:</strong> Crackers <strong>30g</strong> (oppure Frutta secca olosa 20g)</li>
        </ul>

        <h4 style="color:var(--accent);">CENA</h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li>Pollame <strong>200g</strong> (<em>Alt:</em> Manzo 150g, Pesce 250g, Legumi 240g)</li>
          <li>Pane <strong>60g</strong> (<em>Alt:</em> Crackers 40g, Patate 230g)</li>
          <li>Verdura <strong>200g</strong></li>
          <li>Olio EVO <strong>10g</strong></li>
        </ul>
        <p class="text-muted" style="margin-top:0.5rem; font-size:0.8rem;"><strong>Macro medie:</strong> 1903 kcal | PRO 135g (28%) | FAT 55g (26%) | CHO 213g (44%)</p>
      </div>
    </div>

    <div class="settings-section" style="margin-bottom:1rem;">
      <h3 style="color:var(--rest); margin-bottom:0.5rem; border-bottom:1px solid rgba(0,0,0,0.05); padding-bottom:0.5rem;" onclick="this.nextElementSibling.classList.toggle('hidden')" style="cursor:pointer;">
        2° Giorno (Riposo) ▼
      </h3>
      <div class="hidden" style="line-height:1.6; padding-top:0.5rem; font-size:0.9rem;">
        <h4 style="color:var(--rest);">COLAZIONE</h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li>Avena <strong>40g</strong>, Yogurt greco 0% <strong>100g</strong>, Marmellata <strong>15g</strong></li>
          <li><em>Alt:</em> Vedi alternative allenamento.</li>
        </ul>
        
        <h4 style="color:var(--rest);">SPUNTINO MATTINA <span style="font-weight:normal;">(Giorno Riposo)</span></h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li>Frutta fresca <strong>250g</strong>, Proteine <strong>30g</strong></li>
        </ul>

        <h4 style="color:var(--rest);">PRANZO</h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li>Pasta/Riso <strong>70g</strong> (<em>Alt:</em> Gnocchi 190g, Farro 70g, Quinoa 60g, Pane 90g, Patate 350g)</li>
          <li>Pollame <strong>200g</strong></li>
          <li>Verdura <strong>200g</strong></li>
          <li>Olio EVO <strong>10g</strong></li>
        </ul>

        <h4 style="color:var(--rest);">MERENDA <span style="font-weight:normal;">(Indifferente: Allenamento o Riposo)</span></h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li><strong>Opzione 1:</strong> Yogurt greco 0% bianco <strong>150g</strong>, Miele/Sciroppo d'acero <strong>15g</strong> (oppure Marmellata 20g)</li>
          <li><strong>Opzione 2:</strong> Crackers <strong>30g</strong> (oppure Frutta secca olosa 20g)</li>
        </ul>

        <h4 style="color:var(--rest);">CENA</h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li>Pollame <strong>200g</strong></li>
          <li>Pane <strong>60g</strong> (<em>Alt:</em> Crackers 40g, Patate 230g)</li>
          <li>Verdura <strong>200g</strong></li>
          <li>Olio EVO <strong>10g</strong></li>
        </ul>
        <p class="text-muted" style="margin-top:0.5rem; font-size:0.8rem;"><strong>Macro medie:</strong> 1719 kcal | PRO 130g (30%) | FAT 52g (27%) | CHO 180g (42%)</p>
      </div>
    </div>
      
    <div class="settings-section" style="margin-bottom:1rem;">
      <h3 style="color:var(--primary); margin-bottom:0.5rem; border-bottom:1px solid rgba(0,0,0,0.05); padding-bottom:0.5rem;" onclick="this.nextElementSibling.classList.toggle('hidden')" style="cursor:pointer;">
        Integrazione Syform ▼
      </h3>
      <div class="hidden" style="line-height:1.6; padding-top:0.5rem;">
        <ul style="padding-left:1.2rem; margin-top:0.5rem; margin-bottom:1rem;">
          <li style="margin-bottom:0.5rem;"><strong>Creatp Syform:</strong> 7g al giorno con acqua dopo colazione.</li>
          <li style="margin-bottom:0.5rem;"><strong>Optiwhey Syform:</strong> seguendo lo schema della dieta.</li>
        </ul>
        <p>Sconto del 20% sul sito <a href="http://syform.com" target="_blank" style="color:var(--primary-light);">syform.com</a> con codice <strong>AD20MTML</strong>.</p>
      </div>
    </div>
      
    <div class="settings-section" style="margin-bottom:1rem;">
      <h3 style="color:var(--primary); margin-bottom:0.5rem; border-bottom:1px solid rgba(0,0,0,0.05); padding-bottom:0.5rem;" onclick="this.nextElementSibling.classList.toggle('hidden')" style="cursor:pointer;">
        Alternative Alimentari ▼
      </h3>
      <div class="hidden" style="line-height:1.6; padding-top:0.5rem;">
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse: collapse; margin-top:0.5rem; font-size:0.95rem;">
            <tr style="background:rgba(0,0,0,0.03);"><td colspan="2" style="padding:0.5rem; font-weight:bold;">Carboidrati (Rif: Pasta/Riso 70g)</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Gnocchi di patate</td><td style="text-align:right; padding:0.5rem;">190 g</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Farro, Orzo</td><td style="text-align:right; padding:0.5rem;">70 g</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Quinoa, Grano Saraceno, Amaranto</td><td style="text-align:right; padding:0.5rem;">60 g</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Pane</td><td style="text-align:right; padding:0.5rem;">90 g</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Piadina</td><td style="text-align:right; padding:0.5rem;">80 g</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Crackers, Grissini, Crostini</td><td style="text-align:right; padding:0.5rem;">60 g</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Polenta, cotta</td><td style="text-align:right; padding:0.5rem;">340 g</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Patate</td><td style="text-align:right; padding:0.5rem;">350 g</td></tr>
            
            <tr style="background:rgba(0,0,0,0.03);"><td colspan="2" style="padding:0.5rem; font-weight:bold;">Proteine (Rif: Pollame 200g)</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Manzo (tagli magri)</td><td style="text-align:right; padding:0.5rem;">150 g</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Maiale (tagli magri) / Affettati sgrassati</td><td style="text-align:right; padding:0.5rem;">100 g</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Crostacei, Molluschi</td><td style="text-align:right; padding:0.5rem;">300 g</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Merluzzo / Nasello / Sogliola</td><td style="text-align:right; padding:0.5rem;">250 g</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Pesce in scatola al naturale</td><td style="text-align:right; padding:0.5rem;">150 g</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Pesce in scatola sott'olio / Salmone / Sgombro</td><td style="text-align:right; padding:0.5rem;">100 g</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Fiocchi di latte / Uova intere</td><td style="text-align:right; padding:0.5rem;">180 g</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Montasio / Grana</td><td style="text-align:right; padding:0.5rem;">50 g</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Legumi in scatola o bolliti</td><td style="text-align:right; padding:0.5rem;">240 g</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem;">Legumotti - Barilla</td><td style="text-align:right; padding:0.5rem;">80 g</td></tr>
          </table>
        </div>
      </div>
    </div>

    <div class="settings-section" style="margin-bottom:1rem;">
      <h3 style="color:var(--primary); margin-bottom:0.5rem; border-bottom:1px solid rgba(0,0,0,0.05); padding-bottom:0.5rem;" onclick="this.nextElementSibling.classList.toggle('hidden')" style="cursor:pointer;">
        Frequenze (Proteine) ▼
      </h3>
      <div class="hidden" style="line-height:1.6; padding-top:0.5rem;">
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse: collapse; margin-top:0.5rem; font-size:0.95rem;">
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem; font-weight:600;">Pollame</td><td style="text-align:right; padding:0.5rem;">1-2 volte a settimana</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem; font-weight:600;">Manzo, maiale, affettati</td><td style="text-align:right; padding:0.5rem;">Max 1 volta a settimana</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem; font-weight:600;">Pesce ricco di omega-3</td><td style="text-align:right; padding:0.5rem;">Almeno 2-3 volte a settimana</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem; font-weight:600;">Altro pesce e prodotti ittici</td><td style="text-align:right; padding:0.5rem;">1-2 volte a settimana</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem; font-weight:600;">Latticini e Uova (a pranzo/cena)</td><td style="text-align:right; padding:0.5rem;">1-2 volte a settimana</td></tr>
            <tr style="border-bottom:1px solid rgba(0,0,0,0.05);"><td style="padding:0.5rem; font-weight:600;">Legumi e derivati</td><td style="text-align:right; padding:0.5rem;">Almeno 3-4 volte a settimana</td></tr>
          </table>
        </div>
      </div>
    </div>

    <div class="settings-section" style="margin-bottom:1rem;">
      <h3 style="color:var(--primary); margin-bottom:0.5rem; border-bottom:1px solid rgba(0,0,0,0.05); padding-bottom:0.5rem;" onclick="this.nextElementSibling.classList.toggle('hidden')" style="cursor:pointer;">
        Altre info e FAQ ▼
      </h3>
      <div class="hidden" style="line-height:1.6; padding-top:0.5rem;">
        <ul style="padding-left:1.2rem; margin-top:0.5rem; margin-bottom:1rem;">
          <li style="margin-bottom:0.5rem;">Punta a un consumo di almeno 2-2,5 litri di acqua al giorno.</li>
          <li style="margin-bottom:0.5rem;">Usa solo sale iodato. Sfrutta liberamente spezie, limone, aceto.</li>
          <li style="margin-bottom:0.5rem;">Avrai a disposizione un pasto “sociale” a settimana.</li>
          <li style="margin-bottom:0.5rem;">Puoi combinare due alternative di proteine dimezzandone le quantità.</li>
          <li style="margin-bottom:0.5rem;">Non serve pesare la verdura.</li>
        </ul>
        <p style="margin-top:0.5rem;"><strong>Devo seguire lo schema rigido?</strong> No. Le opzioni sono intercambiabili.</p>
        <p style="margin-top:1rem;"><strong>Come mi comporto con le quantità?</strong> I pesi si riferiscono ad alimenti a crudo.</p>
        <p style="margin-top:1rem;"><strong>Cosa faccio se mangio fuori?</strong> Scegli carboidrati non conditi, proteine magre e verdure scondite (griglia/vapore).</p>
      </div>
    </div>
  `;
  container.innerHTML = html;
}

window.updateNotificationTime = async function(slotId, value) {
  appState.settings.notificationTimes[slotId] = value;
  await saveGlobalSettings({notificationTimes: appState.settings.notificationTimes});
  scheduleDailyNotifications();
}

window.toggleDarkMode = function(isDark) {
  appState.deviceSettings.darkMode = isDark;
  saveLocalDeviceSettings(appState.deviceSettings);
  if (isDark) document.body.classList.add('dark-mode');
  else document.body.classList.remove('dark-mode');
}

// ------------------------------------
// RECIPE MODAL
// ------------------------------------
function setupModal() {
  const modalEl = document.getElementById('recipe-modal');
  
  document.getElementById('modal-close').addEventListener('click', closeRecipeModal);
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeRecipeModal();
  });
  
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      e.target.classList.add('active');
      document.getElementById(e.target.dataset.target).classList.remove('hidden');
    });
  });
  
  document.getElementById('modal-edit-btn').addEventListener('click', toggleEditMode);
  document.getElementById('modal-save-btn').addEventListener('click', saveRecipeEdit);
  document.getElementById('modal-revert-btn').addEventListener('click', revertRecipe);
}

window.openRecipeModal = async function(mealId, dayKey, dayType, originalSlot) {
  const meal = getDynamicMeal(dayKey, dayType, originalSlot);
  currentModalMeal = { id: meal.id, dayKey, dayType, data: meal, isCustom: !!appState.customRecipes[meal.id] };
  editMode = false;
  renderModalContent();
  document.getElementById('recipe-modal').classList.remove('hidden');
}

function closeRecipeModal() {
  document.getElementById('recipe-modal').classList.add('hidden');
  currentModalMeal = null;
}

function renderModalContent() {
  const meal = currentModalMeal.data;
  const timeStr = appState.settings.notificationTimes[meal.slot];
  
  if (editMode) {
    document.getElementById('modal-title').innerHTML = `<input type="text" id="edit-meal-name" value="${meal.name}" style="width:100%; font-size:1.2rem; font-weight:bold; padding:0.2rem;">`;
  } else {
    document.getElementById('modal-title').innerHTML = `${meal.emoji || ''} ${meal.name}`;
  }
  
  document.getElementById('modal-time').innerHTML = `${MEAL_SLOTS.find(s=>s.id===meal.slot)?.label} • ${timeStr || ''} • Prep: ${meal.prepTime || '-'}`;

  const ingUl = document.getElementById('modal-ingredients-list');
  ingUl.innerHTML = '';
  const multiplier = getMultiplier();
  
  if (editMode) {
    meal.ingredients.forEach((ing, i) => {
      ingUl.innerHTML += `
        <li style="display:flex; gap:0.5rem; margin-bottom:0.25rem;">
          <input type="text" value="${ing.name}" id="edit-ing-name-${i}" style="flex:2;">
          <input type="number" value="${ing.quantity}" id="edit-ing-qty-${i}" style="flex:1; width:60px;">
          <input type="text" value="${ing.unit}" id="edit-ing-unit-${i}" style="flex:1; width:60px;">
          <button class="btn btn-icon btn-danger" style="min-width:36px; min-height:36px;" onclick="removeIngredient(${i})">&times;</button>
        </li>
      `;
    });
    ingUl.innerHTML += `<li><button class="btn btn-outline" style="width:100%; margin-top:0.5rem;" onclick="addIngredient()">+ Aggiungi ingrediente base</button></li>`;
  } else {
  meal.ingredients.forEach(ing => {
    let baseQty = ing.quantity;
    let finalQty = baseQty;
    if (typeof finalQty === 'number' && ing.unit !== 'q.b.') finalQty = formatQty(finalQty * multiplier);
    let split = (typeof baseQty === 'number' && ing.unit !== 'q.b.') ? getPerPersonSplit(baseQty, ing.unit) : "";
    ingUl.innerHTML += `
      <li style="display:flex; flex-direction:column; padding:0.5rem 0; border-bottom:1px solid rgba(0,0,0,0.05);">
        <div class="flex-between"><span>${ing.name} ${split ? `<span style="font-size:0.7rem; color:var(--text-muted);">${split}</span>` : ''}</span><strong>${finalQty} ${ing.unit === 'q.b.' || ing.unit === 'pz' ? '' : ing.unit}</strong></div>
      </li>
    `;
  });
    ingUl.innerHTML += `<li class="text-muted" style="font-size:0.75rem; text-align:center; padding:1rem 0;">(Mostrato con i moltiplicatori attivi: ${multiplier}x)</li>`;
  }

  const prepUl = document.getElementById('modal-prep-list');
  prepUl.innerHTML = '';
  if (editMode) {
    meal.steps.forEach((step, i) => {
      prepUl.innerHTML += `
        <li style="display:flex; gap:0.5rem; align-items:flex-start; margin-bottom:0.25rem;">
          <textarea id="edit-step-${i}" style="flex:1; min-height:60px; width:100%; padding:0.5rem;">${step}</textarea>
          <div style="display:flex; flex-direction:column; gap:0.25rem;">
            <button class="btn btn-icon" style="background:rgba(0,0,0,0.05); min-height:30px; font-size:1rem;" onclick="moveStep(${i}, -1)">↑</button>
            <button class="btn btn-icon" style="background:rgba(0,0,0,0.05); min-height:30px; font-size:1rem;" onclick="moveStep(${i}, 1)">↓</button>
            <button class="btn btn-icon btn-danger" style="min-height:30px; font-size:1rem;" onclick="removeStep(${i})">&times;</button>
          </div>
        </li>
      `;
    });
    prepUl.innerHTML += `<li><button class="btn btn-outline" style="width:100%; margin-top:0.5rem;" onclick="addStep()">+ Aggiungi passaggio</button></li>`;
  } else {
    meal.steps.forEach((step, i) => {
      prepUl.innerHTML += `<li class="step-item" style="padding:0.5rem 0; border-bottom:1px solid rgba(0,0,0,0.05);" onclick="this.classList.toggle('done')"><strong>${i+1}.</strong> ${step}</li>`;
    });
  }
  
  const batchEl = document.getElementById('modal-batch-text');
  if (editMode) {
    batchEl.innerHTML = `
      <label style="font-size:0.85rem; font-weight:bold;">Sostituisci il pasto associato:</label>
      <select id="edit-meal-slot" style="width:100%; margin-bottom:1rem; padding:0.3rem;">
        <option value="breakfast" ${meal.slot === 'breakfast' ? 'selected' : ''}>Colazione</option>
        <option value="snack1" ${meal.slot === 'snack1' ? 'selected' : ''}>Spuntino Mattina</option>
        <option value="lunch" ${meal.slot === 'lunch' ? 'selected' : ''}>Pranzo</option>
        <option value="snack2" ${meal.slot === 'snack2' ? 'selected' : ''}>Merenda</option>
        <option value="dinner" ${meal.slot === 'dinner' ? 'selected' : ''}>Cena</option>
      </select>
      <label style="font-size:0.85rem; font-weight:bold;">Note di preparazione (Batch):</label>
      <textarea id="edit-prep-note" style="width:100%; min-height:60px; margin-top:0.5rem; margin-bottom:1rem;">${meal.prepNote || meal.batchNote || ''}</textarea>
      <label style="font-size:0.85rem; font-weight:bold;">Note Integrazione:</label>
      <textarea id="edit-supp-note" style="width:100%; min-height:40px; margin-top:0.5rem;">${meal.supplement || ''}</textarea>
    `;
  } else {
    if (meal.batchNote || meal.prepNote) batchEl.innerHTML = `<strong>💡 Nota:</strong><br>${formatBatchNote(meal.batchNote || meal.prepNote, multiplier)}`;
    else if (currentModalMeal.dayKey !== 'sunday' && MEAL_PLAN[currentModalMeal.dayKey] && MEAL_PLAN[currentModalMeal.dayKey].batchCooking.evening) batchEl.innerHTML = `<strong>🍳 Preparazione anticipata:</strong><br>${formatBatchNote(MEAL_PLAN[currentModalMeal.dayKey].batchCooking.evening, multiplier)}`;
    else batchEl.innerHTML = "Nessuna preparazione anticipata per questo pasto.";
  }
  
  const editBtn = document.getElementById('modal-edit-btn');
  const saveBtn = document.getElementById('modal-save-btn');
  const revertBtn = document.getElementById('modal-revert-btn');
  
  if (editMode) {
    editBtn.classList.add('hidden'); saveBtn.classList.remove('hidden'); revertBtn.classList.add('hidden');
  } else {
    editBtn.classList.remove('hidden'); saveBtn.classList.add('hidden');
    if (currentModalMeal.isCustom) revertBtn.classList.remove('hidden'); else revertBtn.classList.add('hidden');
  }
}

function toggleEditMode() { editMode = !editMode; renderModalContent(); }
function saveCurrentEditState() {
  const meal = currentModalMeal.data;
  const nameInput = document.getElementById('edit-meal-name');
  if (nameInput) meal.name = nameInput.value;
  
  const slotInput = document.getElementById('edit-meal-slot');
  if (slotInput) meal.slot = slotInput.value;
  
  meal.ingredients.forEach((ing, i) => {
    const nameEl = document.getElementById(`edit-ing-name-${i}`);
    const qtyEl = document.getElementById(`edit-ing-qty-${i}`);
    const unitEl = document.getElementById(`edit-ing-unit-${i}`);
    if (nameEl) ing.name = nameEl.value;
    if (qtyEl) ing.quantity = parseFloat(qtyEl.value);
    if (unitEl) ing.unit = unitEl.value;
  });
  meal.steps.forEach((step, i) => {
    const stepEl = document.getElementById(`edit-step-${i}`);
    if (stepEl) meal.steps[i] = stepEl.value;
  });
  const prepEl = document.getElementById('edit-prep-note');
  if (prepEl) meal.prepNote = prepEl.value;
  const suppEl = document.getElementById('edit-supp-note');
  if (suppEl) meal.supplement = suppEl.value;
}

window.addIngredient = function() { saveCurrentEditState(); currentModalMeal.data.ingredients.push({ name: "", quantity: 0, unit: "g" }); renderModalContent(); }
window.removeIngredient = function(index) { saveCurrentEditState(); currentModalMeal.data.ingredients.splice(index, 1); renderModalContent(); }
window.addStep = function() { saveCurrentEditState(); currentModalMeal.data.steps.push(""); renderModalContent(); }
window.removeStep = function(index) { saveCurrentEditState(); currentModalMeal.data.steps.splice(index, 1); renderModalContent(); }
window.moveStep = function(index, dir) {
  saveCurrentEditState();
  if (index + dir >= 0 && index + dir < currentModalMeal.data.steps.length) {
    const temp = currentModalMeal.data.steps[index];
    currentModalMeal.data.steps[index] = currentModalMeal.data.steps[index + dir];
    currentModalMeal.data.steps[index + dir] = temp;
    renderModalContent();
  }
}

async function saveRecipeEdit() {
  saveCurrentEditState();
  await saveCustomRecipe(currentModalMeal.id, currentModalMeal.data);
  appState.customRecipes[currentModalMeal.id] = currentModalMeal.data;
  currentModalMeal.isCustom = true;
  editMode = false;
  renderModalContent();
  setTimeout(handleRoute, 50);
}

async function revertRecipe() {
  if (confirm("Vuoi ripristinare la ricetta originale? Le tue modifiche andranno perse.")) {
    await deleteCustomRecipe(currentModalMeal.id);
    delete appState.customRecipes[currentModalMeal.id];
    let baseMeal = null;
    if (MEAL_PLAN[currentModalMeal.dayKey] && MEAL_PLAN[currentModalMeal.dayKey].meals[currentModalMeal.dayType]) {
      baseMeal = MEAL_PLAN[currentModalMeal.dayKey].meals[currentModalMeal.dayType].find(m => m.id === currentModalMeal.id);
    }
    
    if (baseMeal) {
      currentModalMeal.data = JSON.parse(JSON.stringify(baseMeal));
      currentModalMeal.isCustom = false;
      renderModalContent();
    } else {
      closeRecipeModal();
    }
    setTimeout(handleRoute, 50);
  }
}

document.addEventListener('DOMContentLoaded', initApp);
