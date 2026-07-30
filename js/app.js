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
let shopSettingsVisible = false;

function repairMissingDays() {
  if (!MEAL_PLAN.thursday.meals.training) MEAL_PLAN.thursday.meals.training = MEAL_PLAN.thursday.meals.rest;
  if (!MEAL_PLAN.saturday.meals.training) MEAL_PLAN.saturday.meals.training = MEAL_PLAN.saturday.meals.rest;
  if (!MEAL_PLAN.sunday.meals.training) MEAL_PLAN.sunday.meals.training = MEAL_PLAN.sunday.meals.rest;
  if (!MEAL_PLAN.monday.meals.rest) MEAL_PLAN.monday.meals.rest = MEAL_PLAN.monday.meals.training;
  if (!MEAL_PLAN.tuesday.meals.rest) MEAL_PLAN.tuesday.meals.rest = MEAL_PLAN.tuesday.meals.training;
  if (!MEAL_PLAN.wednesday.meals.rest) MEAL_PLAN.wednesday.meals.rest = MEAL_PLAN.wednesday.meals.training;
}

// ------------------------------------
// INITIALIZATION
// ------------------------------------
async function initApp() {
  initFirebase();
  repairMissingDays();
  
  appState.settings = await getGlobalSettings();
  appState.weekPlan = await getWeekPlan();
  appState.shoppingList = await getShoppingList();
  
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
  
  setupRouter();
  setupModal();
  
  window.addEventListener('midnight-refresh', () => {
    renderToday();
    scheduleDailyNotifications();
  });
  
  scheduleDailyNotifications();
}

function scheduleDailyNotifications() {
  if (!appState.settings || !appState.settings.notificationsEnabled) return;
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
function getTodayKey() { return DAYS[new Date().getDay()]; }

function getDayType(dayKey) {
  if (appState.weekPlan && appState.weekPlan[dayKey]) return appState.weekPlan[dayKey];
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

function formatQty(qty) {
  if (qty > 10) return Math.round(qty / 5) * 5;
  return Math.round(qty * 10) / 10;
}

// ------------------------------------
// ROUTING
// ------------------------------------
function setupRouter() {
  window.addEventListener('hashchange', handleRoute);
  if (!window.location.hash) window.location.hash = '#today';
  else handleRoute();
}

function handleRoute() {
  const hash = window.location.hash || '#today';
  document.querySelectorAll('.view').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  
  const viewId = `view-${hash.substring(1)}`;
  const navId = `nav-${hash.substring(1)}`;
  
  if (document.getElementById(viewId)) document.getElementById(viewId).classList.remove('hidden');
  if (document.getElementById(navId)) document.getElementById(navId).classList.add('active');
  
  if (hash === '#today') renderToday();
  else if (hash === '#week') renderWeek();
  else if (hash === '#shop') renderShop();
  else if (hash === '#guide') renderGuide();
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
    <p class="text-muted" style="text-transform: capitalize; margin-bottom:0.5rem;">${dateStr}</p>
    
    <div class="pill-toggle" style="opacity:0.9; pointer-events:none;">
      <button class="pill-btn ${dayType === 'training' ? 'active training' : ''}">🏋️ Allenamento</button>
      <button class="pill-btn ${dayType === 'rest' ? 'active rest' : ''}">😴 Riposo</button>
    </div>
    <p class="text-muted" style="font-size:0.8rem; margin-top:-0.5rem; margin-bottom:1.5rem;">(Modificabile dalla vista Settimana)</p>
    
    <div class="meal-timeline">
  `;
  
  const meals = plan.meals[dayType];
  const now = new Date();
  let nextMealId = null;
  for (const meal of meals) {
    const timeStr = appState.settings.notificationTimes[meal.slot];
    if (timeStr) {
      const [h, m] = timeStr.split(':').map(Number);
      const d = new Date(); d.setHours(h, m, 0, 0);
      if (d > now) { nextMealId = meal.id; break; }
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
    html += `<div class="batch-banner"><strong>🍳 Stasera:</strong><br>${plan.batchCooking.evening}</div>`;
  }
  container.innerHTML = html;
}

// ------------------------------------
// RENDER WEEK
// ------------------------------------
function renderWeek() {
  const container = document.getElementById('view-week');
  const todayKey = getTodayKey();
  let html = `<h2>Piano Settimanale</h2><p class="text-muted" style="margin-bottom:1rem;">Qui puoi variare i giorni di allenamento. Le quantità si adatteranno istantaneamente.</p><div class="week-grid">`;
  const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  
  weekDays.forEach(dayKey => {
    const plan = MEAL_PLAN[dayKey];
    const dayType = getDayType(dayKey);
    const meals = plan.meals[dayType];
    const isToday = dayKey === todayKey;
    
    html += `
      <div class="day-column ${isToday ? 'current-day' : ''}">
        <div class="flex-between"><h3>${plan.dayName}</h3></div>
        <div class="pill-toggle" style="transform: scale(0.8); transform-origin: left; margin: 0.25rem 0;">
          <button class="pill-btn ${dayType === 'training' ? 'active training' : ''}" onclick="toggleDayType('${dayKey}', 'training')">🏋️</button>
          <button class="pill-btn ${dayType === 'rest' ? 'active rest' : ''}" onclick="toggleDayType('${dayKey}', 'rest')">😴</button>
        </div>
        <div>
    `;
    meals.forEach(meal => { html += `<div class="day-meal-item" onclick="openRecipeModal('${meal.id}', '${dayKey}', '${dayType}')">${meal.emoji} ${meal.name}</div>`; });
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
  if (window.location.hash === '#today') renderToday();
  if (window.location.hash === '#week') renderWeek();
  if (window.location.hash === '#shop') renderShop();
};

// ------------------------------------
// RENDER SHOP
// ------------------------------------
window.toggleShopSettings = function() {
  shopSettingsVisible = !shopSettingsVisible;
  renderShop();
}

window.toggleShopAllWeek = async function(selectAll) {
  const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  weekDays.forEach(day => {
    if (selectAll) appState.shoppingList.selectedMeals[day] = ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'];
    else appState.shoppingList.selectedMeals[day] = [];
  });
  await saveShoppingList(appState.shoppingList);
  renderShop();
}

function renderShop() {
  const container = document.getElementById('view-shop');
  
  let shopData = appState.shoppingList;
  if (!shopData.selectedMeals) shopData.selectedMeals = { monday:[], tuesday:[], wednesday:[], thursday:[], friday:[], saturday:[], sunday:[] };
  if (!shopData.customDays) shopData.customDays = { monday:'training', tuesday:'training', wednesday:'training', thursday:'rest', friday:'training', saturday:'rest', sunday:'rest' };
  
  let hasSelection = false;
  Object.values(shopData.selectedMeals).forEach(arr => { if (arr.length > 0) hasSelection = true; });
  if (!hasSelection) shopSettingsVisible = true;
  
  const mode = shopData.mode || 'current';
  const persons = shopData.persons || 2;
  const twoType = shopData.twoPersonsType || 'mf';
  const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  
  let html = `
    <div class="flex-between" style="margin-bottom:1rem; flex-wrap:wrap; gap:0.5rem;">
      <h2 style="margin:0;">Lista Spesa</h2>
      <button class="btn btn-outline" style="min-height:30px; padding:0.25rem 0.5rem; font-size:0.85rem;" onclick="toggleShopSettings()">
        ${shopSettingsVisible ? 'Nascondi Impostazioni ▲' : 'Mostra Impostazioni ▼'}
      </button>
    </div>
  `;
  
  if (shopSettingsVisible) {
    html += `
      <div class="settings-section" style="padding:1rem; margin-bottom:1rem;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-weight:600;">Calcola per:</span>
          <select onchange="updateShopPersons(this.value)" style="padding:0.3rem;">
            <option value="1" ${persons == 1 ? 'selected' : ''}>1 persona</option>
            <option value="2" ${persons == 2 ? 'selected' : ''}>2 persone</option>
          </select>
        </div>
        <div class="${persons == 1 ? 'hidden' : ''}" style="margin-top:0.5rem; font-size:0.9rem;">
          <label style="margin-right:1rem;"><input type="radio" name="shopTwoType" value="mf" onchange="updateShopTwoType('mf')" ${twoType === 'mf' ? 'checked' : ''}> Uomo+Donna (×1.75)</label><br>
          <label style="margin-right:1rem;"><input type="radio" name="shopTwoType" value="fm" onchange="updateShopTwoType('fm')" ${twoType === 'fm' ? 'checked' : ''}> Donna+Uomo (×2.25)</label><br>
          <label><input type="radio" name="shopTwoType" value="same" onchange="updateShopTwoType('same')" ${twoType === 'same' ? 'checked' : ''}> Stesso sesso (×2)</label>
        </div>
      </div>
    `;

    html += `
      <div class="settings-section" style="margin-bottom:1rem;">
        <h3 style="margin-bottom:0.5rem;">Impostazioni Giorni</h3>
        <label style="display:block; margin-bottom:0.5rem;"><input type="radio" name="shopMode" value="current" ${mode==='current'?'checked':''} onchange="setShopMode('current')"> Usa piano settimana corrente</label>
        <label style="display:block;"><input type="radio" name="shopMode" value="custom" ${mode==='custom'?'checked':''} onchange="setShopMode('custom')"> Personalizza (Scegli tu i giorni)</label>
    `;
    if (mode === 'custom') {
      html += `<div style="display:grid; grid-template-columns: 1fr 1fr; gap:0.5rem; margin-top:1rem;">`;
      weekDays.forEach(day => {
        const type = shopData.customDays[day];
        html += `
          <div style="background:#f9f9f9; padding:0.5rem; border-radius:6px; font-size:0.85rem;">
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

    html += `
      <div class="settings-section" style="margin-bottom:1.5rem;">
        <h3>Seleziona cosa comprare</h3>
        <div style="display:flex; gap:0.5rem; margin-bottom:1rem;">
          <button class="btn btn-outline" style="flex:1; padding:0.25rem; font-size:0.8rem;" onclick="toggleShopAllWeek(true)">Seleziona Tutto</button>
          <button class="btn btn-outline" style="flex:1; padding:0.25rem; font-size:0.8rem;" onclick="toggleShopAllWeek(false)">Deseleziona Tutto</button>
        </div>
    `;
    weekDays.forEach(day => {
      const selMeals = shopData.selectedMeals[day] || [];
      const isWholeDay = selMeals.length === 5;
      html += `
        <div style="margin-bottom: 0.5rem; border: 1px solid #eee; border-radius: 8px; padding: 0.5rem;">
          <div class="flex-between">
            <label style="font-weight:bold;"><input type="checkbox" onchange="toggleShopWholeDay('${day}', this.checked)" ${isWholeDay?'checked':''}> ${MEAL_PLAN[day].dayName}</label>
            <button class="btn btn-icon" style="min-height:30px; font-size:0.8rem; background:#eee;" onclick="document.getElementById('shop-det-${day}').classList.toggle('hidden')">Dettagli ▼</button>
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
  }

  let multiplier = 1;
  if (persons == 2) {
    if (twoType === 'mf') multiplier = 1.75;
    else if (twoType === 'fm') multiplier = 2.25;
    else multiplier = 2;
  }
  
  let categoriesMap = {};
  let totalItemsCount = 0;

  SHOPPING_CATEGORIES.forEach(item => {
    let total = 0;
    let includedInDays = [];
    
    weekDays.forEach(day => {
      const type = (mode === 'custom') ? shopData.customDays[day] : getDayType(day);
      const mealsForDay = shopData.selectedMeals[day] || [];
      mealsForDay.forEach(slot => {
        if (item.days[day] && item.days[day][slot]) {
          const qtyObj = item.days[day][slot];
          const qty = qtyObj[type] !== undefined ? qtyObj[type] : qtyObj.training;
          if (qty > 0) {
            total += qty;
            if (!includedInDays.includes(MEAL_PLAN[day].dayName.substring(0,3))) includedInDays.push(MEAL_PLAN[day].dayName.substring(0,3));
          }
        }
      });
    });
    
    if (total > 0) {
      let finalQty = item.unit === 'pz' ? 1 : total * multiplier;
      finalQty = formatQty(finalQty);
      
      let splitText = "";
      if (persons == 2 && item.unit !== 'pz') {
          let user1, user2;
          if (twoType === 'mf') { user1 = formatQty(total * 1); user2 = formatQty(total * 0.75); splitText = `(Uomo: ${user1}${item.unit==='q.b.'?'':item.unit}, Donna: ${user2}${item.unit==='q.b.'?'':item.unit})`; }
          else if (twoType === 'fm') { user1 = formatQty(total * 1); user2 = formatQty(total * 1.25); splitText = `(Donna: ${user1}${item.unit==='q.b.'?'':item.unit}, Uomo: ${user2}${item.unit==='q.b.'?'':item.unit})`; }
          else { user1 = formatQty(total * 1); splitText = `(Ciascuno: ${user1}${item.unit==='q.b.'?'':item.unit})`; }
      }

      if (shopData.customQtys && shopData.customQtys[item.id] !== undefined) finalQty = shopData.customQtys[item.id];
      
      if (!categoriesMap[item.category]) categoriesMap[item.category] = [];
      categoriesMap[item.category].push({
        id: item.id, name: item.name, qty: finalQty, unit: item.unit,
        days: includedInDays.join(', '), checked: (shopData.checkedItems || []).includes(item.id),
        splitText: splitText
      });
      totalItemsCount++;
    }
  });

  const orderedCategories = ["🥩 Carne", "🐟 Pesce e Frutti di Mare", "🥚 Uova e Latticini", "🫘 Legumi", "🍚 Carboidrati / Cereali", "🥬 Verdura Fresca", "🍑 Frutta Fresca", "🥫 Dispensa / Condimenti", "🌿 Spezie e Aromi"];
  
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
              <div class="shop-item-tags">${item.days}</div>
              ${item.splitText ? `<div class="text-muted" style="font-size:0.7rem; margin-top:2px;">${item.splitText}</div>` : ''}
            </div>
            <div class="shop-item-qty">
              <input type="text" inputmode="decimal" class="editable-qty" value="${item.qty}" onclick="event.stopPropagation()" onchange="updateShopItemQty('${item.id}', this.value)">
              ${item.unit === 'q.b.' ? '' : `<span style="font-size:0.8rem; margin-left:2px;">${item.unit}</span>`}
            </div>
          </div>
        `;
      });
      html += `</div>`;
    }
  });
  
  if (totalItemsCount === 0) html += `<p class="text-muted" style="text-align:center; padding:2rem 0;">Nessun pasto selezionato.</p>`;
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
}

window.shareShopWhatsApp = function() {
  let text = "🛒 *Lista della Spesa*\n\n";
  const orderedCategories = ["🥩 Carne", "🐟 Pesce e Frutti di Mare", "🥚 Uova e Latticini", "🫘 Legumi", "🍚 Carboidrati / Cereali", "🥬 Verdura Fresca", "🍑 Frutta Fresca", "🥫 Dispensa / Condimenti", "🌿 Spezie e Aromi"];
  
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

window.setShopMode = async function(mode) { appState.shoppingList.mode = mode; await saveShoppingList(appState.shoppingList); renderShop(); }
window.setCustomShopDayType = async function(day, type) { appState.shoppingList.customDays[day] = type; await saveShoppingList(appState.shoppingList); renderShop(); }
window.toggleShopWholeDay = async function(day, isChecked) {
  if (isChecked) appState.shoppingList.selectedMeals[day] = ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'];
  else appState.shoppingList.selectedMeals[day] = [];
  await saveShoppingList(appState.shoppingList); renderShop();
}
window.toggleShopMeal = async function(day, slot, isChecked) {
  if (isChecked && !appState.shoppingList.selectedMeals[day].includes(slot)) appState.shoppingList.selectedMeals[day].push(slot);
  else if (!isChecked) appState.shoppingList.selectedMeals[day] = appState.shoppingList.selectedMeals[day].filter(s => s !== slot);
  await saveShoppingList(appState.shoppingList); renderShop();
}
window.updateShopPersons = async function(val) { appState.shoppingList.persons = parseInt(val); await saveShoppingList(appState.shoppingList); renderShop(); }
window.updateShopTwoType = async function(val) { appState.shoppingList.twoPersonsType = val; await saveShoppingList(appState.shoppingList); renderShop(); }
window.toggleShopItem = async function(id, event) {
  if (event.target.tagName.toLowerCase() === 'input' && event.target.type === 'text') return;
  let list = appState.shoppingList.checkedItems || [];
  if (list.includes(id)) list = list.filter(i => i !== id); else list.push(id);
  appState.shoppingList.checkedItems = list;
  await saveShoppingList(appState.shoppingList); renderShop();
}
window.updateShopItemQty = async function(id, val) {
  if (!appState.shoppingList.customQtys) appState.shoppingList.customQtys = {};
  appState.shoppingList.customQtys[id] = val;
  await saveShoppingList(appState.shoppingList); renderShop();
}
window.resetShopChecks = async function() {
  if (confirm("Rimuovere le spunte?")) { appState.shoppingList.checkedItems = []; await saveShoppingList(appState.shoppingList); renderShop(); }
}
window.resetShopList = async function() {
  if (confirm("Azzerare le selezioni?")) {
    appState.shoppingList.selectedMeals = { monday:[], tuesday:[], wednesday:[], thursday:[], friday:[], saturday:[], sunday:[] };
    appState.shoppingList.checkedItems = []; appState.shoppingList.customQtys = {}; shopSettingsVisible = true;
    await saveShoppingList(appState.shoppingList); renderShop();
  }
}

// ------------------------------------
// RENDER GUIDE
// ------------------------------------
function renderGuide() {
  const container = document.getElementById('view-guide');
  container.innerHTML = `
    <h2>Linee Guida di Meller</h2>
    
    <div class="settings-section" style="margin-bottom:1rem;">
      <h3 style="color:var(--primary); margin-bottom:0.5rem; border-bottom:1px solid #eee; padding-bottom:0.5rem;" onclick="this.nextElementSibling.classList.toggle('hidden')" style="cursor:pointer;">
        Struttura Dieta ▼
      </h3>
      <div style="line-height:1.6; padding-top:0.5rem;">
        <ul style="padding-left:1.2rem; margin-top:0.5rem; margin-bottom:1rem;">
          <li style="margin-bottom:0.5rem;"><strong>1° giorno: allenamento.</strong> Bilanciata, ricca di carboidrati. Crackers nello spuntino mattutino. Quote carboidrati e proteine aumentate a pranzo.</li>
          <li style="margin-bottom:0.5rem;"><strong>2° giorno: riposo.</strong> Pasti bilanciati. Quota carboidrati e proteine leggermente ridotta. Niente crackers.</li>
        </ul>
        <p class="text-muted"><em>NB: preferisci fonti di carboidrati non integrali prima e dopo un allenamento e nel carico. Libera negli altri momenti.</em></p>
      </div>
    </div>

    <div class="settings-section" style="margin-bottom:1rem;">
      <h3 style="color:var(--primary); margin-bottom:0.5rem; border-bottom:1px solid #eee; padding-bottom:0.5rem;" onclick="this.nextElementSibling.classList.toggle('hidden')" style="cursor:pointer;">
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
        
        <h4 style="color:var(--accent);">SPUNTINO</h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li>Frutta fresca <strong>250g</strong>, Crackers <strong>30g</strong>, Proteine Whey <strong>30g</strong></li>
        </ul>

        <h4 style="color:var(--accent);">PRANZO</h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li>Pasta/Riso <strong>90g</strong> (<em>Alt:</em> Gnocchi 250g, Farro 90g, Quinoa 80g, Pane 120g, Patate 450g)</li>
          <li>Pollame <strong>200g</strong> (<em>Alt:</em> Manzo 150g, Maiale 100g, Merluzzo 250g, Uova 180g)</li>
          <li>Verdura <strong>200g</strong></li>
          <li>Olio EVO <strong>10g</strong></li>
        </ul>

        <h4 style="color:var(--accent);">MERENDA</h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li>Yogurt greco 0% <strong>150g</strong>, Miele <strong>15g</strong></li>
          <li><em>Alt:</em> Crackers 30g o Frutta secca 20g</li>
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
      <h3 style="color:var(--rest); margin-bottom:0.5rem; border-bottom:1px solid #eee; padding-bottom:0.5rem;" onclick="this.nextElementSibling.classList.toggle('hidden')" style="cursor:pointer;">
        2° Giorno (Riposo) ▼
      </h3>
      <div class="hidden" style="line-height:1.6; padding-top:0.5rem; font-size:0.9rem;">
        <h4 style="color:var(--rest);">COLAZIONE</h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li>Avena <strong>40g</strong>, Yogurt greco 0% <strong>100g</strong>, Marmellata <strong>15g</strong></li>
          <li><em>Alt:</em> Vedi alternative allenamento.</li>
        </ul>
        
        <h4 style="color:var(--rest);">SPUNTINO</h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li>Frutta fresca <strong>250g</strong>, Proteine Whey <strong>30g</strong></li>
          <li style="color:var(--danger);"><em>Niente Crackers!</em></li>
        </ul>

        <h4 style="color:var(--rest);">PRANZO</h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li>Pasta/Riso <strong>70g</strong> (<em>Alt:</em> Gnocchi 190g, Farro 70g, Quinoa 60g, Pane 90g, Patate 350g)</li>
          <li>Pollame <strong>200g</strong></li>
          <li>Verdura <strong>200g</strong></li>
          <li>Olio EVO <strong>10g</strong></li>
        </ul>

        <h4 style="color:var(--rest);">MERENDA</h4>
        <ul style="padding-left:1rem; margin-bottom:1rem;">
          <li>Yogurt greco 0% <strong>150g</strong>, Miele <strong>15g</strong></li>
          <li><em>Alt:</em> Crackers 30g o Frutta secca 20g</li>
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
      <h3 style="color:var(--primary); margin-bottom:0.5rem; border-bottom:1px solid #eee; padding-bottom:0.5rem;" onclick="this.nextElementSibling.classList.toggle('hidden')" style="cursor:pointer;">
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
      <h3 style="color:var(--primary); margin-bottom:0.5rem; border-bottom:1px solid #eee; padding-bottom:0.5rem;" onclick="this.nextElementSibling.classList.toggle('hidden')" style="cursor:pointer;">
        Frequenze (Proteine) ▼
      </h3>
      <div class="hidden" style="line-height:1.6; padding-top:0.5rem;">
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse: collapse; margin-top:0.5rem; font-size:0.95rem;">
            <tr style="border-bottom:1px solid #ddd;"><td style="padding:0.5rem; font-weight:600;">Pollame</td><td style="text-align:right; padding:0.5rem;">1-2 volte a settimana</td></tr>
            <tr style="border-bottom:1px solid #ddd;"><td style="padding:0.5rem; font-weight:600;">Manzo, maiale, affettati</td><td style="text-align:right; padding:0.5rem;">Max 1 volta a settimana</td></tr>
            <tr style="border-bottom:1px solid #ddd;"><td style="padding:0.5rem; font-weight:600;">Pesce ricco di omega-3</td><td style="text-align:right; padding:0.5rem;">Almeno 2-3 volte a settimana</td></tr>
            <tr style="border-bottom:1px solid #ddd;"><td style="padding:0.5rem; font-weight:600;">Altro pesce e prodotti ittici</td><td style="text-align:right; padding:0.5rem;">1-2 volte a settimana</td></tr>
            <tr style="border-bottom:1px solid #ddd;"><td style="padding:0.5rem; font-weight:600;">Latticini e Uova (a pranzo/cena)</td><td style="text-align:right; padding:0.5rem;">1-2 volte a settimana</td></tr>
            <tr style="border-bottom:1px solid #ddd;"><td style="padding:0.5rem; font-weight:600;">Legumi e derivati</td><td style="text-align:right; padding:0.5rem;">Almeno 3-4 volte a settimana</td></tr>
          </table>
        </div>
      </div>
    </div>

    <div class="settings-section" style="margin-bottom:1rem;">
      <h3 style="color:var(--primary); margin-bottom:0.5rem; border-bottom:1px solid #eee; padding-bottom:0.5rem;" onclick="this.nextElementSibling.classList.toggle('hidden')" style="cursor:pointer;">
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
  container.innerHTML = html;
}

window.updateNotificationTime = async function(slotId, value) {
  appState.settings.notificationTimes[slotId] = value;
  await saveGlobalSettings({notificationTimes: appState.settings.notificationTimes});
  scheduleDailyNotifications();
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
  const meal = customRecipe || JSON.parse(JSON.stringify(baseMeal));
  
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
  
  const selectorDiv = document.getElementById('modal-persons-selector');
  const s = appState.shoppingList;
  selectorDiv.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <span style="font-weight:600; font-size:0.9rem;">Calcola per:</span>
      <select style="padding:0.2rem; font-size:0.9rem; border-radius:4px; border:1px solid #ccc;" onchange="updateModalPersons(parseInt(this.value))">
        <option value="1" ${s.persons === 1 ? 'selected' : ''}>1 persona</option>
        <option value="2" ${s.persons === 2 ? 'selected' : ''}>2 persone</option>
      </select>
    </div>
    <div class="${s.persons === 1 ? 'hidden' : ''}" style="margin-top:0.5rem; font-size:0.85rem;">
      <label style="display:block; margin-bottom:0.2rem;"><input type="radio" name="modalTwoType" value="mf" onchange="updateModalTwoType('mf')" ${s.twoPersonsType === 'mf' ? 'checked' : ''}> Uomo+Donna (×1.75)</label>
      <label style="display:block; margin-bottom:0.2rem;"><input type="radio" name="modalTwoType" value="fm" onchange="updateModalTwoType('fm')" ${s.twoPersonsType === 'fm' ? 'checked' : ''}> Donna+Uomo (×2.25)</label>
      <label style="display:block;"><input type="radio" name="modalTwoType" value="same" onchange="updateModalTwoType('same')" ${s.twoPersonsType === 'same' ? 'checked' : ''}> Stesso sesso (×2)</label>
    </div>
  `;

  const ingUl = document.getElementById('modal-ingredients-list');
  ingUl.innerHTML = '';
  
  let multiplier = 1;
  if (s.persons === 2) {
    if (s.twoPersonsType === 'mf') multiplier = 1.75;
    else if (s.twoPersonsType === 'fm') multiplier = 2.25;
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
      let splitText = "";
      if (typeof finalQty === 'number') {
        if (s.persons === 2 && ing.unit !== 'pz') {
          let user1, user2;
          if (s.twoPersonsType === 'mf') { user1 = formatQty(finalQty * 1); user2 = formatQty(finalQty * 0.75); splitText = `(Uomo: ${user1}${ing.unit==='q.b.'?'':ing.unit}, Donna: ${user2}${ing.unit==='q.b.'?'':ing.unit})`; }
          else if (s.twoPersonsType === 'fm') { user1 = formatQty(finalQty * 1); user2 = formatQty(finalQty * 1.25); splitText = `(Donna: ${user1}${ing.unit==='q.b.'?'':ing.unit}, Uomo: ${user2}${ing.unit==='q.b.'?'':ing.unit})`; }
          else { user1 = formatQty(finalQty * 1); splitText = `(Ciascuno: ${user1}${ing.unit==='q.b.'?'':ing.unit})`; }
        }
        if(ing.unit !== 'pz') { finalQty = finalQty * multiplier; }
        finalQty = formatQty(finalQty);
      }
      ingUl.innerHTML += `
        <li style="display:flex; flex-direction:column; padding:0.5rem 0; border-bottom:1px solid #eee;">
          <div class="flex-between"><span>${ing.name}</span><strong>${finalQty} ${ing.unit === 'q.b.' || ing.unit === 'pz' ? '' : ing.unit}</strong></div>
          ${splitText ? `<div class="text-muted" style="font-size:0.75rem; text-align:right;">${splitText}</div>` : ''}
        </li>
      `;
    });
  }

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
  
  const batchEl = document.getElementById('modal-batch-text');
  if (meal.batchNote) batchEl.innerHTML = `<strong>💡 Nota:</strong><br>${meal.batchNote}`;
  else if (MEAL_PLAN[currentModalMeal.dayKey].batchCooking.evening) batchEl.innerHTML = `<strong>🍳 Preparazione anticipata:</strong><br>${MEAL_PLAN[currentModalMeal.dayKey].batchCooking.evening}`;
  else batchEl.innerHTML = "Nessuna preparazione anticipata per questo pasto.";
  
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
window.updateModalPersons = async function(val) { appState.shoppingList.persons = val; await saveShoppingList(appState.shoppingList); renderModalContent(); renderShop(); }
window.updateModalTwoType = async function(val) { appState.shoppingList.twoPersonsType = val; await saveShoppingList(appState.shoppingList); renderModalContent(); renderShop(); }
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

document.addEventListener('DOMContentLoaded', initApp);
