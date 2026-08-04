const firebaseConfig = {
  apiKey: "AIzaSyCuV3KSAWMWRWJR-LhX_FCSJQLlXaJws7M",
  authDomain: "piano-nutrizionale.firebaseapp.com",
  projectId: "piano-nutrizionale",
  storageBucket: "piano-nutrizionale.firebasestorage.app",
  messagingSenderId: "117247692441",
  appId: "1:117247692441:web:909efc3d3e6206fb95f208"
};

let db;

function initFirebase() {
  if (firebaseConfig.apiKey === "REPLACE_API_KEY") {
    console.warn("Firebase not configured. Running in offline/mock mode.");
    return false;
  }
  
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    
    // Enable offline persistence caching correctly for v9 compat
    try {
      db.settings({
        cacheSizeBytes: firebase.firestore.CACHE_SIZE_UNLIMITED,
        merge: true 
      });
    } catch(err) {
      console.warn("Firestore settings error", err);
    }
      
    return true;
  } catch (e) {
    console.error("Firebase init error", e);
    return false;
  }
}

// ------------------------------------
// MOCK FALLBACKS FOR OFFLINE DEVELOPMENT
// ------------------------------------
const mockStore = {
  settings: {
    trainingDays: ['monday', 'tuesday', 'wednesday', 'friday'],
    notificationTimes: {
      breakfast: "08:30",
      snack1: "10:00",
      lunch: "13:30",
      snack2: "16:00",
      dinner: "20:00"
    },
    persons: 2,
    twoPersonsType: 'mf',
    notificationsEnabled: false
  },
  weekPlans: {},
  recipes: {},
  shoppingList: { selectedDays: [], persons: 2, twoPersonsType: 'mf', checkedItems: [] },
  swappedMeals: {},
  shoppingListCloud: null
};

function getISOWeekString() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getFullYear()}-W${weekNo.toString().padStart(2, '0')}`;
}

function getISODateString() {
  return new Date().toISOString().split('T')[0];
}

// --- Device Settings (local only) ---
function getLocalDeviceSettings() {
  const defaults = {
    persons: 2,
    twoPersonsType: 'mf',
    singlePersonType: 'm',
    darkMode: false,
    prepSelectedDay: null,
    lastLoginDate: null
  };
  try {
    const raw = localStorage.getItem('pn_device_settings');
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch (e) {
    return { ...defaults };
  }
}

function saveLocalDeviceSettings(settings) {
  try {
    const current = getLocalDeviceSettings();
    const merged = { ...current, ...settings };
    localStorage.setItem('pn_device_settings', JSON.stringify(merged));
  } catch (e) {
    console.warn("saveLocalDeviceSettings error", e);
  }
}

// --- Global Settings (cloud + device merge) ---
async function getGlobalSettings() {
  let deviceSettings = getLocalDeviceSettings();
  if (!db) return { ...mockStore.settings, ...deviceSettings };
  try {
    const doc = await db.collection('settings').doc('global').get();
    let cloudSettings = doc.exists ? doc.data() : {};
    return { ...mockStore.settings, ...cloudSettings, ...deviceSettings };
  } catch(e) {
    console.warn("getGlobalSettings fallback", e);
    return { ...mockStore.settings, ...deviceSettings };
  }
}

async function saveGlobalSettings(settings) {
  // Device specific keys stay local
  const deviceKeys = ['persons', 'twoPersonsType', 'singlePersonType', 'darkMode', 'lastLoginDate', 'prepSelectedDay'];
  let localSettings = {};
  try {
    localSettings = JSON.parse(localStorage.getItem('pn_device_settings') || '{}');
  } catch(e) {}
  let cloudSettings = {};
  
  for (let key in settings) {
    if (deviceKeys.includes(key)) localSettings[key] = settings[key];
    else cloudSettings[key] = settings[key];
  }
  
  try {
    localStorage.setItem('pn_device_settings', JSON.stringify(localSettings));
  } catch(e) {}
  
  if (!db) {
    mockStore.settings = { ...mockStore.settings, ...settings };
    return;
  }
  if (Object.keys(cloudSettings).length > 0) {
    try {
      await db.collection('settings').doc('global').set(cloudSettings, { merge: true });
    } catch(e) {
      console.warn("saveGlobalSettings cloud error", e);
    }
  }
}

async function getWeekPlan() {
  const weekId = getISOWeekString();
  if (!db) return mockStore.weekPlans[weekId] || {};
  try {
    const doc = await db.collection('weekPlans').doc(weekId).get();
    return doc.exists ? doc.data() : {};
  } catch(e) {
    return mockStore.weekPlans[weekId] || {};
  }
}

async function saveWeekPlan(plan) {
  const weekId = getISOWeekString();
  if (!db) {
    mockStore.weekPlans[weekId] = plan;
    return;
  }
  try {
    await db.collection('weekPlans').doc(weekId).set(plan, { merge: true });
  } catch(e) {
    console.warn("saveWeekPlan error", e);
    mockStore.weekPlans[weekId] = plan;
  }
}

// --- Swapped Meals ---
async function getSwappedMeals() {
  const weekId = getISOWeekString();
  if (!db) return mockStore.swappedMeals[weekId] || {};
  try {
    const doc = await db.collection('swappedMeals').doc(weekId).get();
    return doc.exists ? doc.data() : {};
  } catch(e) {
    console.warn("getSwappedMeals fallback", e);
    return mockStore.swappedMeals[weekId] || {};
  }
}

async function saveSwappedMeals(map) {
  const weekId = getISOWeekString();
  if (!db) {
    mockStore.swappedMeals[weekId] = { ...(map || {}) };
    return;
  }
  try {
    await db.collection('swappedMeals').doc(weekId).set(map || {}, { merge: false });
  } catch(e) {
    console.warn("saveSwappedMeals error", e);
    mockStore.swappedMeals[weekId] = { ...(map || {}) };
  }
}

// --- Shopping List Cloud (new structure) ---
function getDefaultShoppingListCloud() {
  return {
    selectedMeals: { monday:[], tuesday:[], wednesday:[], thursday:[], friday:[], saturday:[], sunday:[] },
    customDays: { monday:'training', tuesday:'training', wednesday:'training', thursday:'rest', friday:'training', saturday:'rest', sunday:'rest' },
    mode: 'current',
    checkedItems: [],
    customQtys: {}
  };
}

async function getShoppingListCloud() {
  const def = getDefaultShoppingListCloud();
  if (!db) {
    if (mockStore.shoppingListCloud) {
      return { ...def, ...mockStore.shoppingListCloud, selectedMeals: { ...def.selectedMeals, ...(mockStore.shoppingListCloud.selectedMeals||{}) }, customDays: { ...def.customDays, ...(mockStore.shoppingListCloud.customDays||{}) } };
    }
    return def;
  }
  try {
    const doc = await db.collection('shoppingList').doc('current').get();
    if (!doc.exists) return def;
    const data = doc.data();
    // Merge with defaults to handle old docs
    return {
      ...def,
      ...data,
      selectedMeals: { ...def.selectedMeals, ...(data.selectedMeals||{}) },
      customDays: { ...def.customDays, ...(data.customDays||{}) },
      checkedItems: data.checkedItems || [],
      customQtys: data.customQtys || {}
    };
  } catch(e) {
    console.warn("getShoppingListCloud fallback", e);
    return mockStore.shoppingListCloud || def;
  }
}

async function saveShoppingListCloud(listData) {
  if (!db) {
    mockStore.shoppingListCloud = { ...(listData||{}) };
    return;
  }
  try {
    await db.collection('shoppingList').doc('current').set(listData, { merge: true });
  } catch(e) {
    console.warn("saveShoppingListCloud error", e);
    mockStore.shoppingListCloud = { ...(listData||{}) };
  }
}

// --- Legacy shopping list (kept for compatibility) ---
async function getShoppingList() {
  // alias to new
  return getShoppingListCloud();
}

async function saveShoppingList(listData) {
  return saveShoppingListCloud(listData);
}

async function getCustomRecipe(mealId) {
  if (!db) return mockStore.recipes[mealId];
  try {
    const doc = await db.collection('recipes').doc(mealId).get();
    return doc.exists ? doc.data() : null;
  } catch(e) {
    return mockStore.recipes[mealId];
  }
}

async function saveCustomRecipe(mealId, recipeData) {
  if (!db) {
    mockStore.recipes[mealId] = recipeData;
    return;
  }
  try {
    await db.collection('recipes').doc(mealId).set(recipeData);
  } catch(e) {
    mockStore.recipes[mealId] = recipeData;
  }
}

async function deleteCustomRecipe(mealId) {
  if (!db) {
    delete mockStore.recipes[mealId];
    return;
  }
  try {
    await db.collection('recipes').doc(mealId).delete();
  } catch(e) {
    delete mockStore.recipes[mealId];
  }
}
