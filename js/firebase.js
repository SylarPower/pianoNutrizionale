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
  shoppingList: { selectedDays: [], persons: 2, twoPersonsType: 'mf', checkedItems: [] }
};

async function getGlobalSettings() {
  let local = localStorage.getItem('pn_device_settings');
  let localSettings = local ? JSON.parse(local) : {};
  if (!db) return { ...mockStore.settings, ...localSettings };
  const doc = await db.collection('settings').doc('global').get();
  let cloudSettings = doc.exists ? doc.data() : {};
  return { ...mockStore.settings, ...cloudSettings, ...localSettings };
}

async function saveGlobalSettings(settings) {
  // Device specific
  const deviceKeys = ['persons', 'twoPersonsType', 'darkMode', 'lastLoginDate', 'prepSelectedDay'];
  let localSettings = JSON.parse(localStorage.getItem('pn_device_settings') || '{}');
  let cloudSettings = {};
  
  for (let key in settings) {
    if (deviceKeys.includes(key)) localSettings[key] = settings[key];
    else cloudSettings[key] = settings[key];
  }
  
  localStorage.setItem('pn_device_settings', JSON.stringify(localSettings));
  
  if (!db) {
    mockStore.settings = { ...mockStore.settings, ...settings };
    return;
  }
  if (Object.keys(cloudSettings).length > 0) {
    await db.collection('settings').doc('global').set(cloudSettings, { merge: true });
  }
}

function getISOWeekString() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getFullYear()}-W${weekNo.toString().padStart(2, '0')}`;
}

async function getWeekPlan() {
  const weekId = getISOWeekString();
  if (!db) return mockStore.weekPlans[weekId] || {};
  const doc = await db.collection('weekPlans').doc(weekId).get();
  return doc.exists ? doc.data() : {};
}

async function saveWeekPlan(plan) {
  const weekId = getISOWeekString();
  if (!db) {
    mockStore.weekPlans[weekId] = plan;
    return;
  }
  await db.collection('weekPlans').doc(weekId).set(plan, { merge: true });
}

async function getShoppingList() {
  if (!db) return mockStore.shoppingList;
  const doc = await db.collection('shoppingList').doc('current').get();
  return doc.exists ? doc.data() : mockStore.shoppingList;
}

async function saveShoppingList(listData) {
  if (!db) {
    mockStore.shoppingList = { ...mockStore.shoppingList, ...listData };
    return;
  }
  await db.collection('shoppingList').doc('current').set(listData, { merge: true });
}

async function getCustomRecipe(mealId) {
  if (!db) return mockStore.recipes[mealId];
  const doc = await db.collection('recipes').doc(mealId).get();
  return doc.exists ? doc.data() : null;
}

async function saveCustomRecipe(mealId, recipeData) {
  if (!db) {
    mockStore.recipes[mealId] = recipeData;
    return;
  }
  await db.collection('recipes').doc(mealId).set(recipeData);
}

async function deleteCustomRecipe(mealId) {
  if (!db) {
    delete mockStore.recipes[mealId];
    return;
  }
  await db.collection('recipes').doc(mealId).delete();
}
