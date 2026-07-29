const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MEAL_SLOTS = [
  { id: 'breakfast', label: 'Colazione' },
  { id: 'snack1', label: 'Spuntino mattina' },
  { id: 'lunch', label: 'Pranzo' },
  { id: 'snack2', label: 'Merenda' },
  { id: 'dinner', label: 'Cena' }
];

let appState = {
  settings: null,
  weekPlan: null,
  shoppingList: null,
  customRecipes: {}
};

let currentModalMeal = null;
let editMode = false;

// ------------------------------------
// INITIALIZATION
// ------------------------------------
async function initApp() {
  initFirebase();
  
  // Load data
  appState.settings = await getGlobalSettings();
  appState.weekPlan = await getWeekPlan();
  appState.shoppingList = await getShoppingList();
  
  setupRouter();
  setupModal();
  
  window.addEventListener('midnight-refresh', () => {
    renderToday();
    scheduleDailyNotifications();
  });
  
  if (appState.settings.notificationsEnabled && Notification.permission === "default") {
    requestNotificationPermission();
  }
  
  scheduleDailyNotifications();
}

function scheduleDailyNotifications() {
  if (!appState.settings) return;
  const todayKey = getTodayKey();
  const dayType = getDayType(todayKey);
  const plan = MEAL_PLAN[todayKey];
  const meals = plan.meals[dayType];
  const batch = plan.batchCooking.evening;
  
  scheduleNotifications(appState.settings, meals, batch);
}

// ------------------------------------
// UTILS
// ------------------------------------
function getTodayKey() {
  const d = new Date();
  return DAYS[d.getDay()];
}

function getDayType(dayKey) {
  // Check week override
  if (appState.weekPlan && appState.weekPlan[dayKey]) {
    return appState.weekPlan[dayKey];
  }
  // Check settings override
  if (appState.settings && appState.settings.trainingDays && appState.settings.trainingDays.includes(dayKey)) {
    return 'training';
  }
  if (appState.settings && appState.settings.restDays && appState.settings.restDays.includes(dayKey)) {
    return 'rest';
  }
  // Fallback to default
  return MEAL_PLAN[dayKey].defaultType;
}

function formatTimeRemaining(timeStr) {
  if (!timeStr) return '';
  const now = new Date();
  const [hours, minutes] = timeStr.split(':').map(Number);
  const target = new Date();
  target.setHours(hours, minutes, 0, 0);
  
  let diffMs = target - now;
  if (diffMs < 0) return 'Passato';
  
  const diffHrs = Math.floor(diffMs / 3600000);
  const diffMins = Math.floor((diffMs % 3600000) / 60000);
  
  if (diffHrs > 0) return `Tra ${diffHrs}h ${diffMins}m`;
  return `Tra ${diffMins}m`;
}

// ------------------------------------
// ROUTING
// ------------------------------------
function setupRouter() {
  window.addEventListener('hashchange', handleRoute);
  // Default route
  if (!window.location.hash) {
    window.location.hash = '#today';
  } else {
    handleRoute();
  }
}

function handleRoute() {
  const hash = window.location.hash || '#today';
  
  // Hide all views
  document.querySelectorAll('.view').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  
  const viewId = `view-${hash.substring(1)}`;
  const navId = `nav-${hash.substring(1)}`;
  
  const viewEl = document.getElementById(viewId);
  const navEl = document.getElementById(navId);
  
  if (viewEl) viewEl.classList.remove('hidden');
  if (navEl) navEl.classList.add('active');
  
  // Render specific view
  if (hash === '#today') renderToday();
  else if (hash === '#week') renderWeek();
  else if (hash === '#shop') renderShop();
  else if (hash === '#settings') renderSettings();
}

// ------------------------------------
// RENDER TODAY
// ------------------------------------
async function renderToday() {
  const container = document.getElementById('view-today');
  const todayKey = getTodayKey();
  const plan = MEAL_PLAN[todayKey];
  const dayType = getDayType(todayKey);
  
  const dateOptions = { weekday: 'long', month: 'long', day: 'numeric' };
  const dateStr = new Date().toLocaleDateString('it-IT', dateOptions);
  
  let html = `
    <h2>Giornata di oggi</h2>
    <p class="text-muted" style="text-transform: capitalize;">${dateStr}</p>
    
    <div class="pill-toggle">
      <button class="pill-btn ${dayType === 'training' ? 'active training' : ''}" onclick="toggleDayType('${todayKey}', 'training')">🏋️ Allenamento</button>
      <button class="pill-btn ${dayType === 'rest' ? 'active rest' : ''}" onclick="toggleDayType('${todayKey}', 'rest')">😴 Riposo</button>
    </div>
    
    <div class="meal-timeline">
  `;
  
  const meals = plan.meals[dayType];
  
  // Highlight logic: find next upcoming meal
  const now = new Date();
  let nextMealId = null;
  for (const meal of meals) {
    const timeStr = appState.settings.notificationTimes[meal.slot];
    if (timeStr) {
      const [h, m] = timeStr.split(':').map(Number);
      const d = new Date();
      d.setHours(h, m, 0, 0);
      if (d > now) {
        nextMealId = meal.id;
        break;
      }
    }
  }

  for (const meal of meals) {
    const customRecipe = await getCustomRecipe(meal.id);
    const finalMeal = customRecipe || meal;
    const timeStr = appState.settings.notificationTimes[meal.slot];
    const isNext = meal.id === nextMealId;
    
    html += `
      <div class="card ${dayType} ${isNext ? 'highlight' : ''}" onclick="openRecipeModal('${meal.id}', '${todayKey}', '${dayType}')">
        <div class="flex-between">
          <div style="display:flex; align-items:center; gap: 0.5rem;">
            <span style="font-size: 1.5rem;">${finalMeal.emoji || meal.emoji}</span>
            <div>
              <div style="font-weight: 600;">${finalMeal.name}</div>
              <div class="text-muted">${MEAL_SLOTS.find(s=>s.id===meal.slot)?.label} • ${timeStr || ''}</div>
            </div>
          </div>
          <div class="text-muted" style="text-align:right; font-size: 0.8rem;">
            ${formatTimeRemaining(timeStr)}
          </div>
        </div>
        ${meal.slot === 'breakfast' && finalMeal.supplement ? `<div class="text-muted" style="margin-top:0.5rem; font-size:0.8rem;">💡 ${finalMeal.supplement}</div>` : ''}
      </div>
    `;
  }
  
  html += `</div>`;
  
  if (plan.batchCooking.evening) {
    html += `
      <div class="batch-banner">
        <strong>🍳 Stasera:</strong><br>
        ${plan.batchCooking.evening}
      </div>
    `;
  }
  
  container.innerHTML = html;
}

// ------------------------------------
// RENDER WEEK
// ------------------------------------
function renderWeek() {
  const container = document.getElementById('view-week');
  const todayKey = getTodayKey();
  
  let html = `<h2>Piano Settimanale</h2><div class="week-grid">`;
  
  // order: monday to sunday
  const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  
  weekDays.forEach(dayKey => {
    const plan = MEAL_PLAN[dayKey];
    const dayType = getDayType(dayKey);
    const meals = plan.meals[dayType];
    const isToday = dayKey === todayKey;
    
    html += `
      <div class="day-column ${isToday ? 'current-day' : ''}">
        <div class="flex-between">
          <h3>${plan.dayName}</h3>
        </div>
        <div class="pill-toggle" style="transform: scale(0.8); transform-origin: left; margin: 0.25rem 0;">
          <button class="pill-btn ${dayType === 'training' ? 'active training' : ''}" onclick="toggleDayType('${dayKey}', 'training')">🏋️</button>
          <button class="pill-btn ${dayType === 'rest' ? 'active rest' : ''}" onclick="toggleDayType('${dayKey}', 'rest')">😴</button>
        </div>
        <div>
    `;
    
    meals.forEach(meal => {
      html += `
        <div class="day-meal-item" onclick="openRecipeModal('${meal.id}', '${dayKey}', '${dayType}')">
          ${meal.emoji} ${meal.name}
        </div>
      `;
    });
    
    html += `</div></div>`;
  });
  
  html += `</div>`;
  container.innerHTML = html;
}

window.toggleDayType = async function(dayKey, type) {
  appState.weekPlan[dayKey] = type;
  await saveWeekPlan(appState.weekPlan);
  scheduleDailyNotifications();
  if (window.location.hash === '#today') renderToday();
  if (window.location.hash === '#week') renderWeek();
  if (window.location.hash === '#shop') renderShop(); // update shop quantities
};

// ------------------------------------
// RENDER SHOP
// ------------------------------------
function renderShop() {
  const container = document.getElementById('view-shop');
  
  let selectedDays = appState.shoppingList.selectedDays || [];
  let persons = appState.shoppingList.persons || 1;
  let twoType = appState.shoppingList.twoPersonsType || 'same'; // same, mf, fm
  let checkedItems = appState.shoppingList.checkedItems || [];
  
  const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  
  let html = `
    <h2>Lista della Spesa</h2>
    
    <div class="settings-section">
      <h3>Giorni da includere</h3>
      <div style="display:flex; flex-wrap:wrap; gap:0.5rem; margin-bottom:1rem;">
  `;
  
  weekDays.forEach(day => {
    const isChecked = selectedDays.includes(day) ? 'checked' : '';
    html += `
      <label style="display:flex; align-items:center; background:#eee; padding:0.25rem 0.5rem; border-radius:16px; font-size:0.9rem;">
        <input type="checkbox" onchange="toggleShopDay('${day}')" ${isChecked}> ${MEAL_PLAN[day].dayName.substring(0,3)}
      </label>
    `;
  });
  
  html += `
      </div>
      <div style="display:flex; gap:0.5rem;">
        <button class="btn btn-outline" style="flex:1; min-height:36px; padding:0.25rem;" onclick="setShopDays(['${getTodayKey()}'])">Solo Oggi</button>
        <button class="btn btn-outline" style="flex:1; min-height:36px; padding:0.25rem;" onclick="setShopDays(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'])">Tutta la settimana</button>
      </div>
    </div>
    
    <div class="settings-section">
      <h3>Persone</h3>
      <select onchange="updateShopPersons(this.value)" style="width:100%; margin-bottom:1rem;">
        <option value="1" ${persons == 1 ? 'selected' : ''}>1 persona</option>
        <option value="2" ${persons == 2 ? 'selected' : ''}>2 persone</option>
      </select>
      
      <div id="shop-two-persons-options" class="${persons == 1 ? 'hidden' : ''}">
        <label><input type="radio" name="twoType" value="mf" onchange="updateShopTwoType('mf')" ${twoType === 'mf' ? 'checked' : ''}> Io uomo, lei donna (×1.75)</label><br>
        <label><input type="radio" name="twoType" value="fm" onchange="updateShopTwoType('fm')" ${twoType === 'fm' ? 'checked' : ''}> Io donna, lui uomo (×2.25)</label><br>
        <label><input type="radio" name="twoType" value="same" onchange="updateShopTwoType('same')" ${twoType === 'same' ? 'checked' : ''}> Stesso sesso (×2)</label>
      </div>
    </div>
  `;
  
  // Calculate multiplier
  let multiplier = 1;
  if (persons == 2) {
    if (twoType === 'mf') multiplier = 1.75;
    else if (twoType === 'fm') multiplier = 2.25;
    else multiplier = 2;
  }
  
  // Aggregate items
  let categoriesMap = {};
  SHOPPING_CATEGORIES.forEach(item => {
    let total = 0;
    let includedInDays = [];
    
    selectedDays.forEach(day => {
      const type = getDayType(day);
      if (item.days[day] && item.days[day][type]) {
        total += item.days[day][type];
        includedInDays.push(MEAL_PLAN[day].dayName.substring(0,3));
      }
    });
    
    if (total > 0) {
      let finalQty = total * multiplier;
      if (finalQty > 10) finalQty = Math.round(finalQty / 5) * 5;
      else finalQty = Math.round(finalQty * 10) / 10;
      
      if (appState.shoppingList.customQtys && appState.shoppingList.customQtys[item.id] !== undefined) {
        finalQty = appState.shoppingList.customQtys[item.id];
      }
      
      if (!categoriesMap[item.category]) categoriesMap[item.category] = [];
      categoriesMap[item.category].push({
        id: item.id,
        name: item.name,
        qty: finalQty,
        unit: item.unit,
        days: [...new Set(includedInDays)].join(', '),
        checked: checkedItems.includes(item.id)
      });
    }
  });
  
  const orderedCategories = [
    "🥩 Carne", "🐟 Pesce e Frutti di Mare", "🥚 Uova e Latticini", 
    "🫘 Legumi", "🍚 Carboidrati / Cereali", "🥬 Verdura Fresca", 
    "🍑 Frutta Fresca", "🥫 Dispensa / Condimenti", "🌿 Spezie e Aromi"
  ];
  
  orderedCategories.forEach(cat => {
    if (categoriesMap[cat] && categoriesMap[cat].length > 0) {
      html += `<div class="shop-category"><div class="shop-category-title">${cat}</div>`;
      
      // Sort: unchecked first, checked last
      categoriesMap[cat].sort((a,b) => (a.checked === b.checked) ? 0 : a.checked ? 1 : -1);
      
      categoriesMap[cat].forEach(item => {
        html += `
          <div class="shop-item ${item.checked ? 'checked' : ''}" onclick="toggleShopItem('${item.id}', event)">
            <input type="checkbox" ${item.checked ? 'checked' : ''} style="pointer-events:none;">
            <div class="shop-item-details">
              <div>${item.name}</div>
              <div class="shop-item-tags">${item.days}</div>
            </div>
            <div class="shop-item-qty">
              <input type="text" inputmode="decimal" class="editable-qty" value="${item.qty}" 
                onclick="event.stopPropagation()" 
                onchange="updateShopItemQty('${item.id}', this.value)">
              ${item.unit === 'q.b.' ? '' : `<span style="font-size:0.8rem; margin-left:2px;">${item.unit}</span>`}
            </div>
          </div>
        `;
      });
      html += `</div>`;
    }
  });
  
  if (Object.keys(categoriesMap).length === 0) {
    html += `<p class="text-muted" style="text-align:center; padding:2rem 0;">Seleziona uno o più giorni per vedere la lista.</p>`;
  }
  
  html += `
    <div style="display:flex; gap:1rem; margin-top:2rem;">
      <button class="btn btn-outline" style="flex:1;" onclick="resetShopChecks()">Reset spunta</button>
      <button class="btn btn-danger" style="flex:1;" onclick="resetShopList()">Reset lista</button>
    </div>
  `;
  
  container.innerHTML = html;
}

window.toggleShopDay = async function(day) {
  let list = appState.shoppingList.selectedDays || [];
  if (list.includes(day)) list = list.filter(d => d !== day);
  else list.push(day);
  appState.shoppingList.selectedDays = list;
  await saveShoppingList(appState.shoppingList);
  renderShop();
}

window.setShopDays = async function(days) {
  appState.shoppingList.selectedDays = days;
  await saveShoppingList(appState.shoppingList);
  renderShop();
}

window.updateShopPersons = async function(val) {
  appState.shoppingList.persons = parseInt(val);
  await saveShoppingList(appState.shoppingList);
  renderShop();
}

window.updateShopTwoType = async function(val) {
  appState.shoppingList.twoPersonsType = val;
  await saveShoppingList(appState.shoppingList);
  renderShop();
}

window.toggleShopItem = async function(id, event) {
  if (event.target.tagName.toLowerCase() === 'input' && event.target.type === 'text') return; // Don't toggle on qty edit
  
  let list = appState.shoppingList.checkedItems || [];
  if (list.includes(id)) list = list.filter(i => i !== id);
  else list.push(id);
  appState.shoppingList.checkedItems = list;
  await saveShoppingList(appState.shoppingList);
  renderShop();
}

window.resetShopChecks = async function() {
  if (confirm("Vuoi davvero rimuovere la spunta da tutti gli elementi?")) {
    appState.shoppingList.checkedItems = [];
    await saveShoppingList(appState.shoppingList);
    renderShop();
  }
}

window.resetShopList = async function() {
  if (confirm("Vuoi azzerare completamente la lista della spesa?")) {
    appState.shoppingList.selectedDays = [];
    appState.shoppingList.checkedItems = [];
    appState.shoppingList.customQtys = {};
    await saveShoppingList(appState.shoppingList);
    renderShop();
  }
}

window.updateShopItemQty = async function(id, val) {
  if (!appState.shoppingList.customQtys) appState.shoppingList.customQtys = {};
  appState.shoppingList.customQtys[id] = val;
  await saveShoppingList(appState.shoppingList);
  // Do not re-render immediately to avoid losing focus, or just re-render.
  // Actually, since it's an onchange event, focus is already lost.
  renderShop();
}

// ------------------------------------
// RENDER SETTINGS
// ------------------------------------
function renderSettings() {
  const container = document.getElementById('view-settings');
  const s = appState.settings;
  
  let html = `
    <h2>Impostazioni</h2>
    
    <div class="settings-section">
      <h3>Notifiche</h3>
      <div class="settings-row">
        <label>Abilita Notifiche</label>
        <input type="checkbox" ${s.notificationsEnabled ? 'checked' : ''} onchange="updateSetting('notificationsEnabled', this.checked)">
      </div>
      <div class="settings-row">
        <button class="btn btn-outline" style="width:100%;" onclick="requestNotificationPermission()">Richiedi permesso notifiche</button>
      </div>
      <h4 style="margin-top:1rem;">Orari Pasti</h4>
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
    <div class="settings-section">
      <h3>Piano Default</h3>
      <p class="text-muted" style="margin-bottom:1rem;">Imposta i tuoi giorni di allenamento predefiniti.</p>
  `;
  
  const dList = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  dList.forEach(day => {
    const isTraining = (s.trainingDays || []).includes(day);
    html += `
      <div class="settings-row">
        <span>${MEAL_PLAN[day].dayName}</span>
        <select onchange="updateDefaultDayType('${day}', this.value)">
          <option value="training" ${isTraining ? 'selected' : ''}>🏋️ Allenamento</option>
          <option value="rest" ${!isTraining ? 'selected' : ''}>😴 Riposo</option>
        </select>
      </div>
    `;
  });
  
  html += `</div>`;
  
  html += `
    <div class="settings-section">
      <h3>Persone Default</h3>
      <div class="settings-row">
        <select onchange="updateSetting('persons', parseInt(this.value)); document.getElementById('settings-two-persons-options').classList.toggle('hidden', this.value === '1');">
          <option value="1" ${s.persons === 1 ? 'selected' : ''}>1 persona</option>
          <option value="2" ${s.persons === 2 ? 'selected' : ''}>2 persone</option>
        </select>
      </div>
      <div id="settings-two-persons-options" class="${s.persons === 1 ? 'hidden' : ''}" style="margin-top:1rem;">
        <label><input type="radio" name="settingsTwoType" value="mf" onchange="updateSetting('twoPersonsType', 'mf')" ${s.twoPersonsType === 'mf' ? 'checked' : ''}> Io uomo, lei donna (×1.75)</label><br>
        <label><input type="radio" name="settingsTwoType" value="fm" onchange="updateSetting('twoPersonsType', 'fm')" ${s.twoPersonsType === 'fm' ? 'checked' : ''}> Io donna, lui uomo (×2.25)</label><br>
        <label><input type="radio" name="settingsTwoType" value="same" onchange="updateSetting('twoPersonsType', 'same')" ${(!s.twoPersonsType || s.twoPersonsType === 'same') ? 'checked' : ''}> Stesso sesso (×2)</label>
      </div>
    </div>
  `;
  
  container.innerHTML = html;
}

window.updateSetting = async function(key, value) {
  appState.settings[key] = value;
  await saveGlobalSettings({[key]: value});
  if (key === 'notificationsEnabled') scheduleDailyNotifications();
}

window.updateNotificationTime = async function(slotId, value) {
  appState.settings.notificationTimes[slotId] = value;
  await saveGlobalSettings({notificationTimes: appState.settings.notificationTimes});
  scheduleDailyNotifications();
}

window.updateDefaultDayType = async function(day, type) {
  let tDays = appState.settings.trainingDays || [];
  let rDays = appState.settings.restDays || [];
  
  if (type === 'training') {
    if (!tDays.includes(day)) tDays.push(day);
    rDays = rDays.filter(d => d !== day);
  } else {
    if (!rDays.includes(day)) rDays.push(day);
    tDays = tDays.filter(d => d !== day);
  }
  
  appState.settings.trainingDays = tDays;
  appState.settings.restDays = rDays;
  await saveGlobalSettings({trainingDays: tDays, restDays: rDays});
}

// ------------------------------------
// RECIPE MODAL
// ------------------------------------
function setupModal() {
  document.getElementById('modal-close').addEventListener('click', closeRecipeModal);
  
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

window.openRecipeModal = async function(mealId, dayKey, dayType) {
  const customRecipe = await getCustomRecipe(mealId);
  const baseMeal = MEAL_PLAN[dayKey].meals[dayType].find(m => m.id === mealId);
  const meal = customRecipe || JSON.parse(JSON.stringify(baseMeal)); // deep copy to avoid mutations
  
  currentModalMeal = { id: mealId, dayKey, dayType, data: meal, isCustom: !!customRecipe };
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
  
  document.getElementById('modal-title').innerHTML = `${meal.emoji || ''} ${meal.name}`;
  document.getElementById('modal-time').innerHTML = `${MEAL_SLOTS.find(s=>s.id===meal.slot)?.label} • ${timeStr || ''} • Prep: ${meal.prepTime || '-'}`;
  
  // Ingredients
  const ingUl = document.getElementById('modal-ingredients-list');
  ingUl.innerHTML = '';
  
  let multiplier = 1;
  if (appState.settings.persons === 2) {
    if (appState.settings.twoPersonsType === 'mf') multiplier = 1.75;
    else if (appState.settings.twoPersonsType === 'fm') multiplier = 2.25;
    else multiplier = 2;
  }
  
  if (editMode) {
    meal.ingredients.forEach((ing, i) => {
      ingUl.innerHTML += `
        <li style="display:flex; gap:0.5rem;">
          <input type="text" value="${ing.name}" id="edit-ing-name-${i}" style="flex:2;">
          <input type="number" value="${ing.quantity}" id="edit-ing-qty-${i}" style="flex:1; width:60px;">
          <input type="text" value="${ing.unit}" id="edit-ing-unit-${i}" style="flex:1; width:60px;">
          <button class="btn btn-icon btn-danger" style="min-width:36px; min-height:36px;" onclick="removeIngredient(${i})">&times;</button>
        </li>
      `;
    });
    ingUl.innerHTML += `<li><button class="btn btn-outline" style="width:100%;" onclick="addIngredient()">+ Aggiungi ingrediente</button></li>`;
  } else {
    meal.ingredients.forEach(ing => {
      let finalQty = ing.quantity;
      if (typeof finalQty === 'number') {
        finalQty = finalQty * multiplier;
        if (finalQty > 10) finalQty = Math.round(finalQty / 5) * 5;
        else finalQty = Math.round(finalQty * 10) / 10;
      }
      ingUl.innerHTML += `<li class="flex-between"><span>${ing.name}</span><strong>${finalQty} ${ing.unit === 'q.b.' ? '' : ing.unit}</strong></li>`;
    });
  }

  // Steps
  const prepUl = document.getElementById('modal-prep-list');
  prepUl.innerHTML = '';
  if (editMode) {
    meal.steps.forEach((step, i) => {
      prepUl.innerHTML += `
        <li style="display:flex; gap:0.5rem; align-items:flex-start;">
          <textarea id="edit-step-${i}" style="flex:1; min-height:60px; width:100%; padding:0.5rem;">${step}</textarea>
          <div style="display:flex; flex-direction:column; gap:0.25rem;">
            <button class="btn btn-icon" style="background:#eee; min-height:30px; font-size:1rem;" onclick="moveStep(${i}, -1)">↑</button>
            <button class="btn btn-icon" style="background:#eee; min-height:30px; font-size:1rem;" onclick="moveStep(${i}, 1)">↓</button>
            <button class="btn btn-icon btn-danger" style="min-height:30px; font-size:1rem;" onclick="removeStep(${i})">&times;</button>
          </div>
        </li>
      `;
    });
    prepUl.innerHTML += `<li><button class="btn btn-outline" style="width:100%;" onclick="addStep()">+ Aggiungi passaggio</button></li>`;
  } else {
    meal.steps.forEach((step, i) => {
      prepUl.innerHTML += `<li class="step-item" onclick="this.classList.toggle('done')"><strong>${i+1}.</strong> ${step}</li>`;
    });
  }
  
  // Batch
  const batchEl = document.getElementById('modal-batch-text');
  if (meal.batchNote) {
    batchEl.innerHTML = `<strong>💡 Nota per questo pasto:</strong><br>${meal.batchNote}`;
  } else if (MEAL_PLAN[currentModalMeal.dayKey].batchCooking.evening) {
    batchEl.innerHTML = `<strong>🍳 Preparazione anticipata serale per tutta la giornata:</strong><br>${MEAL_PLAN[currentModalMeal.dayKey].batchCooking.evening}`;
  } else {
    batchEl.innerHTML = "Nessuna preparazione anticipata per questo pasto.";
  }
  
  // Buttons
  const editBtn = document.getElementById('modal-edit-btn');
  const saveBtn = document.getElementById('modal-save-btn');
  const revertBtn = document.getElementById('modal-revert-btn');
  
  if (editMode) {
    editBtn.classList.add('hidden');
    saveBtn.classList.remove('hidden');
    revertBtn.classList.add('hidden');
  } else {
    editBtn.classList.remove('hidden');
    saveBtn.classList.add('hidden');
    if (currentModalMeal.isCustom) {
      revertBtn.classList.remove('hidden');
    } else {
      revertBtn.classList.add('hidden');
    }
  }
}

function toggleEditMode() {
  editMode = !editMode;
  renderModalContent();
}

window.addIngredient = function() {
  saveCurrentEditState();
  currentModalMeal.data.ingredients.push({ name: "", quantity: 0, unit: "g" });
  renderModalContent();
}

window.removeIngredient = function(index) {
  saveCurrentEditState();
  currentModalMeal.data.ingredients.splice(index, 1);
  renderModalContent();
}

window.addStep = function() {
  saveCurrentEditState();
  currentModalMeal.data.steps.push("");
  renderModalContent();
}

window.removeStep = function(index) {
  saveCurrentEditState();
  currentModalMeal.data.steps.splice(index, 1);
  renderModalContent();
}

window.moveStep = function(index, dir) {
  saveCurrentEditState();
  if (index + dir >= 0 && index + dir < currentModalMeal.data.steps.length) {
    const temp = currentModalMeal.data.steps[index];
    currentModalMeal.data.steps[index] = currentModalMeal.data.steps[index + dir];
    currentModalMeal.data.steps[index + dir] = temp;
    renderModalContent();
  }
}

function saveCurrentEditState() {
  const meal = currentModalMeal.data;
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
}

async function saveRecipeEdit() {
  saveCurrentEditState();
  await saveCustomRecipe(currentModalMeal.id, currentModalMeal.data);
  currentModalMeal.isCustom = true;
  editMode = false;
  renderModalContent();
  if (window.location.hash === '#today') renderToday();
}

async function revertRecipe() {
  if (confirm("Vuoi ripristinare la ricetta originale? Le tue modifiche andranno perse.")) {
    await deleteCustomRecipe(currentModalMeal.id);
    const baseMeal = MEAL_PLAN[currentModalMeal.dayKey].meals[currentModalMeal.dayType].find(m => m.id === currentModalMeal.id);
    currentModalMeal.data = JSON.parse(JSON.stringify(baseMeal));
    currentModalMeal.isCustom = false;
    renderModalContent();
    if (window.location.hash === '#today') renderToday();
  }
}

// ------------------------------------
// BOOTSTRAP
// ------------------------------------
document.addEventListener('DOMContentLoaded', initApp);
