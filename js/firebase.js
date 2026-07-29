// REPLACE WITH YOUR FIREBASE CONFIG
const firebaseConfig = {
  apiKey: "REPLACE_API_KEY",
  authDomain: "REPLACE_AUTH_DOMAIN",
  projectId: "REPLACE_PROJECT_ID",
  storageBucket: "REPLACE_STORAGE_BUCKET",
  messagingSenderId: "REPLACE_MESSAGING_SENDER_ID",
  appId: "REPLACE_APP_ID"
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
    
    // Enable offline persistence
    db.enablePersistence()
      .catch((err) => {
        if (err.code == 'failed-precondition') {
          console.warn("Multiple tabs open, persistence can only be enabled in one tab at a a time.");
        } else if (err.code == 'unimplemented') {
          console.warn("The current browser does not support all of the features required to enable persistence.");
        }
      });
      
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
    persons: 1,
    twoPersonsType: 'same',
    notificationsEnabled: false
  },
  weekPlans: {},
  recipes: {},
  shoppingList: { selectedDays: [], persons: 1, twoPersonsType: 'same', checkedItems: [] }
};

async function getGlobalSettings() {
  if (!db) return mockStore.settings;
  const doc = await db.collection('settings').doc('global').get();
  if (doc.exists) {
    return { ...mockStore.settings, ...doc.data() };
  }
  return mockStore.settings;
}

async function saveGlobalSettings(settings) {
  if (!db) {
    mockStore.settings = { ...mockStore.settings, ...settings };
    return;
  }
  await db.collection('settings').doc('global').set(settings, { merge: true });
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
