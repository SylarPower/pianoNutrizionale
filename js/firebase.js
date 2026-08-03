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
    console.warn("Firebase non configurato. Offline mode.");
    return false;
  }
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    db.enablePersistence().catch((err) => console.warn("Offline persistence not enabled:", err.code));
    return true;
  } catch (e) {
    console.error("Firebase init error", e);
    return false;
  }
}

const mockStore = {
  settings: {
    notificationTimes: { breakfast: "08:30", snack1: "10:00", lunch: "13:30", snack2: "16:00", dinner: "20:00" },
    notificationsEnabled: false
  },
  weekPlans: {},
  swappedMeals: {},
  recipes: {},
  shoppingListCloud: { 
    mode: 'current',
    customDays: { monday: 'training', tuesday: 'training', wednesday: 'training', thursday: 'rest', friday: 'training', saturday: 'rest', sunday: 'rest' },
    selectedMeals: { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] },
    checkedItems: [],
    customQtys: {}
  }
};

function getLocalDeviceSettings() {
  const defaults = { persons: 2, twoPersonsType: 'mf', singlePersonType: 'm' };
  const stored = localStorage.getItem('pn_device_settings');
  return stored ? { ...defaults, ...JSON.parse(stored) } : defaults;
}

function saveLocalDeviceSettings(settings) {
  localStorage.setItem('pn_device_settings', JSON.stringify(settings));
}

async function getGlobalSettings() {
  if (!db) return mockStore.settings;
  const doc = await db.collection('settings').doc('global').get();
  return doc.exists ? { ...mockStore.settings, ...doc.data() } : mockStore.settings;
}

async function saveGlobalSettings(settings) {
  if (!db) { mockStore.settings = { ...mockStore.settings, ...settings }; return; }
  await db.collection('settings').doc('global').set(settings, { merge: true });
}

function getISOWeekString() {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return `${d.getFullYear()}-W${Math.ceil((((d - yearStart) / 86400000) + 1) / 7).toString().padStart(2, '0')}`;
}

async function getWeekPlan() {
  const weekId = getISOWeekString();
  if (!db) return mockStore.weekPlans[weekId] || {};
  const doc = await db.collection('weekPlans').doc(weekId).get();
  return doc.exists ? doc.data() : {};
}

async function saveWeekPlan(plan) {
  const weekId = getISOWeekString();
  if (!db) { mockStore.weekPlans[weekId] = plan; return; }
  await db.collection('weekPlans').doc(weekId).set(plan, { merge: true });
}

async function getSwappedMeals() {
  const weekId = getISOWeekString();
  if (!db) return mockStore.swappedMeals[weekId] || {};
  const doc = await db.collection('swappedMeals').doc(weekId).get();
  return doc.exists ? doc.data() : {};
}

async function saveSwappedMeals(swaps) {
  const weekId = getISOWeekString();
  if (!db) { mockStore.swappedMeals[weekId] = swaps; return; }
  await db.collection('swappedMeals').doc(weekId).set(swaps, { merge: true });
}

async function getShoppingListCloud() {
  if (!db) return mockStore.shoppingListCloud;
  const doc = await db.collection('shoppingList').doc('shared').get();
  return doc.exists ? doc.data() : mockStore.shoppingListCloud;
}

async function saveShoppingListCloud(listData) {
  if (!db) { mockStore.shoppingListCloud = { ...mockStore.shoppingListCloud, ...listData }; return; }
  await db.collection('shoppingList').doc('shared').set(listData, { merge: true });
}

async function getCustomRecipe(mealId) {
  if (!db) return mockStore.recipes[mealId];
  const doc = await db.collection('recipes').doc(mealId).get();
  return doc.exists ? doc.data() : null;
}

async function saveCustomRecipe(mealId, recipeData) {
  if (!db) { mockStore.recipes[mealId] = recipeData; return; }
  await db.collection('recipes').doc(mealId).set(recipeData);
}

async function deleteCustomRecipe(mealId) {
  if (!db) { delete mockStore.recipes[mealId]; return; }
  await db.collection('recipes').doc(mealId).delete();
}
