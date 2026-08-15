const firebaseConfig = {
  apiKey: "AIzaSyCuV3KSAWMWRWJR-LhX_FCSJQLlXaJws7M",
  authDomain: "piano-nutrizionale.firebaseapp.com",
  projectId: "piano-nutrizionale",
  storageBucket: "piano-nutrizionale.firebasestorage.app",
  messagingSenderId: "117247692441",
  appId: "1:117247692441:web:909efc3d3e6206fb95f208"
};
const APP_CHECK_SITE_KEY = "6LcFSYctAAAAACJOnCgeWhJFQWWXIwCus-5mtC1N";

const INTERNAL_USERNAME_DOMAIN = "utenti.pianonutrizionale.app";
let db = null;
let auth = null;
let currentUser = null;
// Metadati dell'ultimo catalogo letto (es. etichette canoniche degli ingredienti).
let catalogMeta = {};

function initFirebase() {
  try {
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

if (
  typeof firebase.appCheck === "function" &&
  APP_CHECK_SITE_KEY &&
  !APP_CHECK_SITE_KEY.startsWith("REPLACE_")
) {
  firebase.appCheck().activate(APP_CHECK_SITE_KEY, true);
} else {
  console.warn(
    "Firebase App Check non configurato: inserire APP_CHECK_SITE_KEY in js/firebase.js."
  );
}

db = firebase.firestore();
auth = firebase.auth();
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(error => {
      console.warn("Persistenza autenticazione non disponibile", error);
    });
    db.enablePersistence({ synchronizeTabs: true }).catch(error => {
      if (error.code !== "failed-precondition" && error.code !== "unimplemented") {
        console.warn("Cache offline Firestore non disponibile", error);
      }
    });
    return true;
  } catch (error) {
    console.error("Errore inizializzazione Firebase", error);
    return false;
  }
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function isValidUsername(username) {
  return /^[a-z0-9._-]{3,32}$/.test(normalizeUsername(username));
}

function usernameToInternalEmail(username) {
  return `${normalizeUsername(username)}@${INTERNAL_USERNAME_DOMAIN}`;
}

function usernameFromUser(user) {
  if (!user?.email) return "";
  return user.email.split("@")[0];
}

async function signInWithUsername(username, password) {
  const normalized = normalizeUsername(username);
  if (!isValidUsername(normalized)) {
    const error = new Error("Lo username deve contenere 3-32 caratteri: lettere minuscole, numeri, punto, trattino o underscore.");
    error.code = "auth/invalid-username";
    throw error;
  }
  if (!password) {
    const error = new Error("Inserisci la password.");
    error.code = "auth/missing-password";
    throw error;
  }
  return auth.signInWithEmailAndPassword(usernameToInternalEmail(normalized), password);
}

async function signOutUser() {
  if (auth) await auth.signOut();
}

function observeAuthState(callback) {
  return auth.onAuthStateChanged(user => {
    currentUser = user || null;
    callback(currentUser);
  });
}

function requireUser() {
  if (!currentUser) throw new Error("Autenticazione richiesta");
  return currentUser;
}

function userRoot() {
  return db.collection("users").doc(requireUser().uid);
}

function recipeCatalogRef() {
  return userRoot().collection("content").doc("recipeCatalog");
}

function weeklyPlanRef() {
  return userRoot().collection("config").doc("weeklyPlan");
}

function shoppingListRef() {
  return userRoot().collection("config").doc("shoppingList");
}

function backupsRef() {
  return userRoot().collection("backups").doc("previous");
}

function localKey(name) {
  return `pn_${currentUser ? currentUser.uid : "anonymous"}_${name}`;
}

function cloneData(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function readLocalJson(name, fallback) {
  try {
    const value = localStorage.getItem(localKey(name));
    return value ? JSON.parse(value) : cloneData(fallback);
  } catch (_) {
    return cloneData(fallback);
  }
}

function writeLocalJson(name, value) {
  try { localStorage.setItem(localKey(name), JSON.stringify(value)); } catch (_) {}
}

function getDefaultDeviceSettings() {
  return {
    portionProfile: "man",
    darkMode: false,
    chefSelectedDay: null,
    lastOpenDate: null
  };
}

function getDefaultShoppingList() {
  const allSlots = ["breakfast", "snack1", "lunch", "snack2", "dinner"];
  return {
    selectedMeals: {
      monday: [...allSlots], tuesday: [...allSlots], wednesday: [...allSlots],
      thursday: [...allSlots], friday: [...allSlots], saturday: [...allSlots], sunday: [...allSlots]
    },
    includePantry: true,
    excludedItems: [],
    customQuantities: {}
  };
}

function getLocalDeviceSettings() {
  return { ...getDefaultDeviceSettings(), ...readLocalJson("device", {}) };
}

function saveLocalDeviceSettings(settings) {
  writeLocalJson("device", { ...getLocalDeviceSettings(), ...settings });
}

function validateRecipeCatalog(recipes) {
  if (!Array.isArray(recipes)) throw new Error("Il catalogo ricette non è valido");
  const ids = new Set();
  recipes.forEach(recipe => {
    if (!recipe?.id || !recipe?.name || !Array.isArray(recipe.ingredients) || !Array.isArray(recipe.steps)) {
      throw new Error(`Ricetta non valida: ${recipe?.id || "ID mancante"}`);
    }
    if (!["breakfast", "snack1", "lunch", "snack2", "dinner"].includes(recipe.slot)) {
      throw new Error(`Tipo pasto non valido per ${recipe.id}`);
    }
    if (ids.has(recipe.id)) throw new Error(`ID ricetta duplicato: ${recipe.id}`);
    ids.add(recipe.id);
  });
  const encodedSize = new TextEncoder().encode(JSON.stringify(recipes)).length;
  if (encodedSize > 900000) throw new Error("Il catalogo supera la dimensione sicura per un documento Firestore");
  return ids;
}

function validateImportedDataset(dataset) {
  if (!dataset || typeof dataset !== "object") throw new Error("File JSON non valido");
  const ids = validateRecipeCatalog(dataset.recipes);
  if (!dataset.recipes.length) throw new Error("Il file non contiene ricette");
  if (!dataset.plan?.days) return true;
  const expectedDays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const slots = ["breakfast", "snack1", "lunch", "snack2", "dinner"];
  expectedDays.forEach(day => {
    const planDay = dataset.plan.days[day];
    if (!planDay || !["training", "rest"].includes(planDay.type)) throw new Error(`Giorno non valido: ${day}`);
    slots.forEach(slot => {
      if (!ids.has(planDay[slot])) throw new Error(`Ricetta ${planDay[slot] || "mancante"} non trovata per ${day}/${slot}`);
    });
  });
  return true;
}

async function getRecipeCatalog() {
  try {
    const snapshot = await recipeCatalogRef().get();
    if (snapshot.exists) {
      const data = snapshot.data();
      let recipes = Array.isArray(data.recipes) ? data.recipes : [];
      catalogMeta = data;

      // Migrazione una tantum allo schema 4: avviene solo quando la versione
      // precedente viene rilevata, poi il documento resta a schema 4.
      const needsMigration = Number(data.schemaVersion || 1) < CATALOG_SCHEMA_VERSION;
      if (needsMigration && typeof PianoDomain !== "undefined") {
        const migrated = PianoDomain.migrateCatalog({ ...data, recipes });
        recipes = migrated.recipes;
        catalogMeta = migrated;
        writeLocalJson("recipe_catalog", recipes);
        await saveRecipeCatalog(recipes, {
          migratedFrom: Number(data.schemaVersion || 1),
          migratedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      } else {
        writeLocalJson("recipe_catalog", recipes);
      }
      return recipes;
    }

    // Migrazione una tantum dalla vecchia sottocollezione recipes, se presente.
    // Dopo la migrazione gli avvii costano una sola lettura catalogo.
    const legacySnapshot = await userRoot().collection("recipes").limit(100).get();
    const legacyRecipes = [];
    legacySnapshot.forEach(doc => {
      const data = doc.data();
      if (data?.id && data?.name) legacyRecipes.push(data);
    });
    if (legacyRecipes.length) {
      const migrated = typeof PianoDomain !== "undefined"
        ? PianoDomain.migrateCatalog({ recipes: legacyRecipes })
        : { recipes: legacyRecipes };
      writeLocalJson("recipe_catalog", migrated.recipes);
      await saveRecipeCatalog(migrated.recipes, {
        migratedFrom: "legacy-subcollection",
        migratedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      return migrated.recipes;
    }

    // Primo avvio: catalogo vuoto in un documento unico (una sola lettura
    // per gli avvii successivi).
    await saveRecipeCatalog([], {
      initializedEmpty: true
    });

    return [];
  } catch (error) {
    const cached = readLocalJson("recipe_catalog", []);
    if (cached.length) return cached;
    throw error;
  }
}

function getCanonicalIngredientLabels() {
  if (typeof PianoDomain === "undefined") return {};
  const embedded = catalogMeta?.canonicalIngredients;
  return { ...PianoDomain.CANONICAL_INGREDIENTS, ...(embedded || {}) };
}

async function saveRecipeCatalog(recipes, metadata = {}) {
  validateRecipeCatalog(recipes);
  const clean = cloneData(recipes);
  writeLocalJson("recipe_catalog", clean);
  await recipeCatalogRef().set({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    recipes: clean,
    recipeCount: clean.length,
    ...metadata,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function getWeeklyPlan() {
  try {
    const snapshot = await weeklyPlanRef().get();
    if (!snapshot.exists) return readLocalJson("weekly_plan", createEmptyWeeklyPlan());
    const plan = snapshot.data();

    // Migrazione una tantum del piano: schema 4 + batchTemplates strutturati
    // derivati dalle vecchie batchRules. Salvata una sola volta.
    const hasLegacyRules = plan.batchRules && Object.keys(plan.batchRules).length > 0;
    const needsMigration = Number(plan.schemaVersion || 1) < CATALOG_SCHEMA_VERSION || hasLegacyRules;
    if (needsMigration && typeof PianoDomain !== "undefined") {
      const migrated = PianoDomain.migratePlan(plan);
      writeLocalJson("weekly_plan", migrated);
      await weeklyPlanRef().set(migrated);
      return migrated;
    }

    writeLocalJson("weekly_plan", plan);
    return plan;
  } catch (error) {
    const cached = readLocalJson("weekly_plan", null);
    if (cached) return cached;
    if (currentUser) return createEmptyWeeklyPlan();
    throw error;
  }
}

async function saveWeeklyPlan(plan) {
  const clean = cloneData(plan);
  writeLocalJson("weekly_plan", clean);
  await weeklyPlanRef().set(clean);
}

async function getShoppingListCloud() {
  const defaults = getDefaultShoppingList();
  try {
    const snapshot = await shoppingListRef().get();
    const data = snapshot.exists ? snapshot.data() : {};
    const value = {
      ...defaults,
      ...data,
      selectedMeals: { ...defaults.selectedMeals, ...(data.selectedMeals || {}) },
      excludedItems: data.excludedItems || [],
      customQuantities: data.customQuantities || {}
    };
    writeLocalJson("shopping", value);
    return value;
  } catch (error) {
    const cached = readLocalJson("shopping", defaults);
    return { ...defaults, ...cached, selectedMeals: { ...defaults.selectedMeals, ...(cached.selectedMeals || {}) } };
  }
}

async function saveShoppingListCloud(value) {
  const clean = cloneData(value);
  writeLocalJson("shopping", clean);
  await shoppingListRef().set(clean);
}

// ---- Backup precedente (users/{uid}/backups/previous) ----

async function saveBackup(catalog, plan, shopping, operation, description) {
  requireUser();
  const snapshot = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    catalog: cloneData(catalog),
    plan: cloneData(plan),
    shoppingList: cloneData(shopping),
    operation,
    description,
    createdAt: new Date().toISOString()
  };
  await backupsRef().set({
    ...snapshot,
    createdAtServer: firebase.firestore.FieldValue.serverTimestamp()
  });
  return snapshot;
}

async function getBackup() {
  requireUser();
  const snapshot = await backupsRef().get();
  return snapshot.exists ? snapshot.data() : null;
}

async function deleteBackup() {
  requireUser();
  await backupsRef().delete();
}

// Ripristino atomico: legge il backup, ripristina catalogo/piano/spesa e
// cancella il backup in un'unica transazione. Utilizzabile una sola volta.
async function restoreBackupAtomic() {
  const user = requireUser();
  let restored = null;
  await db.runTransaction(async transaction => {
    const backupDoc = await transaction.get(backupsRef());
    if (!backupDoc.exists) throw new Error("Non esiste un backup da ripristinare");
    const backup = backupDoc.data();
    if (!backup?.catalog?.recipes || !backup?.plan) throw new Error("Il backup non è valido");
    transaction.set(recipeCatalogRef(), {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      recipes: cloneData(backup.catalog.recipes),
      recipeCount: backup.catalog.recipes.length,
      restoredAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    transaction.set(weeklyPlanRef(), cloneData(backup.plan));
    transaction.set(shoppingListRef(), cloneData(backup.shoppingList || getDefaultShoppingList()));
    transaction.delete(backupsRef());
    restored = backup;
  });
  // Aggiorna anche la cache locale e la UI.
  writeLocalJson("recipe_catalog", restored.catalog.recipes);
  writeLocalJson("weekly_plan", restored.plan);
  writeLocalJson("shopping", restored.shoppingList || getDefaultShoppingList());
  catalogMeta = restored.catalogMeta || catalogMeta;
  return restored;
}

async function importUserDataset(dataset) {
  validateImportedDataset(dataset);
  const recipes = cloneData(dataset.recipes);
  const plan = cloneData(dataset.plan);
  const shopping = getDefaultShoppingList();
  const batch = db.batch();
  batch.set(recipeCatalogRef(), {
    schemaVersion: Number(dataset.schemaVersion || CATALOG_SCHEMA_VERSION),
    recipes,
    recipeCount: recipes.length,
    importedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  if (plan) batch.set(weeklyPlanRef(), plan);
  batch.set(shoppingListRef(), shopping);
  await batch.commit();
  writeLocalJson("recipe_catalog", recipes);
  if (plan) writeLocalJson("weekly_plan", plan);
  writeLocalJson("shopping", shopping);
  return { recipes, plan, shopping };
}

function usernameDirectoryRef(username) {
  return db.collection("usernames").doc(normalizeUsername(username));
}

async function ensureUsernameDirectory() {
  const user = requireUser();
  const username = usernameFromUser(user);
  const marker = `pn_username_directory_${user.uid}`;
  try {
    if (localStorage.getItem(marker) === "1") return;
  } catch (_) {}
  await usernameDirectoryRef(username).set({ uid: user.uid, username });
  try { localStorage.setItem(marker, "1"); } catch (_) {}
}

async function findUserByUsername(username) {
  const normalized = normalizeUsername(username);
  if (!isValidUsername(normalized)) throw new Error("Username destinatario non valido");
  const snapshot = await usernameDirectoryRef(normalized).get();
  if (!snapshot.exists) throw new Error("Utente non trovato. Deve aver aperto almeno una volta l'ultima versione dell'app.");
  return snapshot.data();
}

async function sendRecipeShare(recipientUsername, recipes, plan = null) {
  requireUser();
  validateRecipeCatalog(recipes);
  if (!recipes.length) throw new Error("Non ci sono ricette da inviare");
  await ensureUsernameDirectory();
  const recipient = await findUserByUsername(recipientUsername);
  if (recipient.uid === currentUser.uid) throw new Error("Non puoi inviare ricette al tuo stesso account");
  const senderUsername = usernameFromUser(currentUser);
  const shareRef = db.collection("recipeShares").doc();
  const includesPlan = Boolean(plan && plan.days);
  const normalizedPlan = includesPlan && typeof PianoDomain !== "undefined"
    ? PianoDomain.migratePlan(cloneData(plan))
    : null;
  await shareRef.set({
    senderUid: currentUser.uid,
    senderUsername,
    recipientUid: recipient.uid,
    recipientUsername: recipient.username,
    status: "pending",
    recipeCount: recipes.length,
    recipes: cloneData(recipes),
    includesPlan,
    plan: normalizedPlan,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  return shareRef.id;
}

async function getPendingRecipeShares() {
  const user = requireUser();
  await ensureUsernameDirectory();
  const snapshot = await db.collection("recipeShares")
    .where("recipientUid", "==", user.uid)
    .get();
  const shares = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    if (data.status === "pending") shares.push({ id: doc.id, ...data });
  });
  shares.sort((a, b) => {
    const left = a.createdAt?.toMillis?.() || 0;
    const right = b.createdAt?.toMillis?.() || 0;
    return right - left;
  });
  return shares;
}

async function rejectRecipeShare(shareId) {
  await db.collection("recipeShares").doc(shareId).delete();
}

async function acceptRecipeShare(shareId, recipes, plan = null) {
  validateRecipeCatalog(recipes);
  const batch = db.batch();
  batch.set(recipeCatalogRef(), {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    recipes: cloneData(recipes),
    recipeCount: recipes.length,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  if (plan) batch.set(weeklyPlanRef(), cloneData(plan));
  batch.delete(db.collection("recipeShares").doc(shareId));
  await batch.commit();
  writeLocalJson("recipe_catalog", recipes);
  if (plan) writeLocalJson("weekly_plan", plan);
}
