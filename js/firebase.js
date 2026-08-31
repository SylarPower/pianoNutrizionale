const firebaseConfig = {
  apiKey: "AIzaSyCuV3KSAWMWRWJR-LhX_FCSJQLlXaJws7M",
  authDomain: "piano-nutrizionale.firebaseapp.com",
  projectId: "piano-nutrizionale",
  storageBucket: "piano-nutrizionale.firebasestorage.app",
  messagingSenderId: "117247692441",
  appId: "1:117247692441:web:909efc3d3e6206fb95f208"
};
const APP_CHECK_SITE_KEY = "6LcFSYctAAAAACJOnCgeWhJFQWWXIwCus-5mtC1N";
const FIREBASE_VERSION = "9.23.0";
const FIREBASE_MODULE_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

const INTERNAL_USERNAME_DOMAIN = "utenti.pianonutrizionale.app";
let db = null;
let auth = null;
let fb = null;
let currentUser = null;
// Metadati dell'ultimo catalogo letto (es. etichette canoniche degli ingredienti).
let catalogMeta = {};
let localDataOwner = null;
// Se valorizzato, catalogo/piano/spesa vengono letti dalla stessa area
// household per tutti i membri. Le preferenze dispositivo restano personali.
let currentHousehold = null;
const SHARED_CACHE_NAMES = new Set(["recipe_catalog", "weekly_plan", "shopping"]);

// SDK modulare caricato in modo asincrono dai CDN ESM di Firebase. La
// vecchia API compat (`firebase.firestore()`, `enablePersistence`,
// `serverTimestamp`...) è deprecata e non consente più di configurare la
// cache multi-scheda: con l'SDK modulare si usa `initializeFirestore` con
// `localCache: persistentLocalCache(...)`, eliminando il warning
// `enableMultiTabIndexedDbPersistence() will be deprecated`.
let firebaseReady = null;
let firebaseReadyResolve = null;
firebaseReady = new Promise(resolve => { firebaseReadyResolve = resolve; });

function hasCompatFirebase() {
  return typeof window !== "undefined"
    && window.firebase
    && typeof window.firebase.apps !== "undefined"
    && typeof window.firebase.firestore === "function";
}

async function loadFirebaseModules() {
  const [appMod, authMod, firestoreMod, appCheckMod] = await Promise.all([
    import(`${FIREBASE_MODULE_BASE}/firebase-app.js`),
    import(`${FIREBASE_MODULE_BASE}/firebase-auth.js`),
    import(`${FIREBASE_MODULE_BASE}/firebase-firestore.js`),
    import(`${FIREBASE_MODULE_BASE}/firebase-app-check.js`)
  ]);
  return { appMod, authMod, firestoreMod, appCheckMod };
}

async function initializeFirebaseAsync() {
  if (fb) return;
  const { appMod, authMod, firestoreMod, appCheckMod } = await loadFirebaseModules();
  fb = {
    ...appMod,
    ...authMod,
    ...firestoreMod,
    ...appCheckMod
  };

  const app = fb.initializeApp(firebaseConfig);

  if (APP_CHECK_SITE_KEY && !APP_CHECK_SITE_KEY.startsWith("REPLACE_")) {
    try {
      // Equivale al vecchio compat `appCheck().activate(siteKey, true)`:
      // il secondo parametro true = auto-refresh del token.
      fb.initializeAppCheck(app, {
        provider: new fb.ReCaptchaV3Provider(APP_CHECK_SITE_KEY),
        isTokenAutoRefreshEnabled: true
      });
    } catch (error) {
      console.warn("Firebase App Check non disponibile", error);
    }
  } else {
    console.warn(
      "Firebase App Check non configurato: inserire APP_CHECK_SITE_KEY in js/firebase.js."
    );
  }

  // Cache offline persistente multi-scheda configurata via settings (API
  // attuale): sostituisce il deprecato db.enablePersistence({synchronizeTabs}).
  try {
    db = fb.initializeFirestore(app, {
      localCache: fb.persistentLocalCache({
        tabManager: fb.persistentMultipleTabManager()
      })
    });
  } catch (error) {
    console.warn("Cache persistente Firestore non disponibile, uso la cache predefinita", error);
    db = fb.getFirestore(app);
  }

  auth = fb.getAuth(app);
  fb.setPersistence(auth, fb.browserLocalPersistence).catch(error => {
    console.warn("Persistenza autenticazione non disponibile", error);
  });
}

async function initializeCompatFirebase() {
  // Percorso legacy per ambienti che espongono ancora l'SDK compat (negli
  // smoke test viene iniettato uno stub). In produzione si usano i moduli ESM.
  const compat = window.firebase;
  if (!compat.apps.length) compat.initializeApp(firebaseConfig);

  if (
    typeof compat.appCheck === "function" &&
    APP_CHECK_SITE_KEY &&
    !APP_CHECK_SITE_KEY.startsWith("REPLACE_")
  ) {
    compat.appCheck().activate(APP_CHECK_SITE_KEY, true);
  } else {
    console.warn(
      "Firebase App Check non configurato: inserire APP_CHECK_SITE_KEY in js/firebase.js."
    );
  }

  db = compat.firestore();
  auth = compat.auth();
  auth.setPersistence(compat.auth.Auth.Persistence.LOCAL).catch(error => {
    console.warn("Persistenza autenticazione non disponibile", error);
  });
  db.enablePersistence({ synchronizeTabs: true }).catch(error => {
    if (error.code !== "failed-precondition" && error.code !== "unimplemented") {
      console.warn("Cache offline Firestore non disponibile", error);
    }
  });
}

function initFirebase() {
  try {
    if (hasCompatFirebase()) {
      initializeCompatFirebase();
      firebaseReadyResolve();
    } else {
      initializeFirebaseAsync()
        .then(() => firebaseReadyResolve())
        .catch(error => {
          console.error("Errore inizializzazione Firebase", error);
          firebaseReadyResolve();
        });
    }
    return true;
  } catch (error) {
    console.error("Errore inizializzazione Firebase", error);
    return false;
  }
}

async function ensureFirebaseReady() {
  await firebaseReady;
  if (!db || !auth) throw new Error("Servizio dati non disponibile");
}

function serverTimestamp() {
  if (hasCompatFirebase()) return window.firebase.firestore.FieldValue.serverTimestamp();
  return fb ? fb.serverTimestamp() : null;
}

function arrayUnion(...values) {
  if (hasCompatFirebase()) return window.firebase.firestore.FieldValue.arrayUnion(...values);
  return fb.arrayUnion(...values);
}

function arrayRemove(...values) {
  if (hasCompatFirebase()) return window.firebase.firestore.FieldValue.arrayRemove(...values);
  return fb.arrayRemove(...values);
}

function setLocalDataOwner(uid) { localDataOwner = uid || null; }
function getCurrentHousehold() { return currentHousehold; }
function clearDataScope() { currentHousehold = null; }

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
  if (hasCompatFirebase()) {
    return auth.signInWithEmailAndPassword(usernameToInternalEmail(normalized), password);
  }
  await ensureFirebaseReady();
  return fb.signInWithEmailAndPassword(auth, usernameToInternalEmail(normalized), password);
}

async function signOutUser() {
  if (!auth) return;
  if (hasCompatFirebase()) {
    await auth.signOut();
  } else {
    await ensureFirebaseReady();
    await fb.signOut(auth);
  }
}

function observeAuthState(callback) {
  if (hasCompatFirebase()) {
    return auth.onAuthStateChanged(user => {
      currentUser = user || null;
      callback(currentUser);
    });
  }
  let unsubscribe = () => {};
  firebaseReady.then(async () => {
    if (!auth) return;
    unsubscribe = fb.onAuthStateChanged(auth, user => {
      currentUser = user || null;
      callback(currentUser);
    });
  }).catch(() => {});
  return () => unsubscribe && unsubscribe();
}

function requireUser() {
  if (!currentUser) throw new Error("Autenticazione richiesta");
  return currentUser;
}

// ----- Riferimenti Firestore (API modulare a documenti/collezioni) -----

function userRoot() {
  return docAt(`users/${requireUser().uid}`);
}

function householdRoot(householdId = currentHousehold?.id) {
  if (!householdId) throw new Error("Account condiviso non disponibile");
  return docAt(`households/${householdId}`);
}

function personalContentDoc(name) {
  return docAt(`users/${requireUser().uid}/content/${name}`);
}

function personalConfigDoc(name) {
  return docAt(`users/${requireUser().uid}/config/${name}`);
}

function householdContentDoc(householdId, name) {
  return docAt(`households/${householdId}/content/${name}`);
}

function householdConfigDoc(householdId, name) {
  return docAt(`households/${householdId}/config/${name}`);
}

function personalRecipeCatalogRef() {
  return personalContentDoc("recipeCatalog");
}

function personalWeeklyPlanRef() {
  return personalConfigDoc("weeklyPlan");
}

function personalShoppingListRef() {
  return personalConfigDoc("shoppingList");
}

function recipeCatalogRef() {
  return currentHousehold
    ? householdContentDoc(currentHousehold.id, "recipeCatalog")
    : personalRecipeCatalogRef();
}

function weeklyPlanRef() {
  return currentHousehold
    ? householdConfigDoc(currentHousehold.id, "weeklyPlan")
    : personalWeeklyPlanRef();
}

function shoppingListRef() {
  return currentHousehold
    ? householdConfigDoc(currentHousehold.id, "shoppingList")
    : personalShoppingListRef();
}

function backupsRef() {
  // Il backup è sempre personale: in questo modo ogni membro può tornare al
  // proprio stato precedente senza condividere anche la cronologia di undo.
  return docAt(`users/${requireUser().uid}/backups/previous`);
}

function localKey(name) {
  const personalOwner = currentUser?.uid || localDataOwner || "anonymous";
  const owner = SHARED_CACHE_NAMES.has(name) && currentHousehold?.id
    ? `household-${currentHousehold.id}`
    : personalOwner;
  return `pn_${owner}_${name}`;
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

function snapData(snapshot) {
  return snapshot.data();
}

function snapExists(snapshot) {
  // L'SDK compat espone `exists` come booleano, quello modulare come metodo.
  return typeof snapshot.exists === "function" ? !!snapshot.exists() : !!snapshot.exists;
}

function snapForEach(snapshot, cb) {
  snapshot.forEach(doc => cb(doc));
}

// ----- Builder di riferimenti, funzionanti sia con SDK compat sia modulare -----

function docAt(path) {
  if (hasCompatFirebase()) return db.doc(path);
  return fb.doc(db, path);
}

function collectionAt(path) {
  if (hasCompatFirebase()) return db.collection(path);
  return fb.collection(db, path);
}

// Nuovo documento con id auto-generato dentro una collezione.
function newDocIn(collectionRef) {
  if (hasCompatFirebase()) return collectionRef.doc();
  return fb.doc(collectionRef);
}

function docInCollection(collectionRef, id) {
  if (hasCompatFirebase()) return collectionRef.doc(id);
  return fb.doc(collectionRef, id);
}

async function getDoc(ref) {
  if (hasCompatFirebase()) return ref.get();
  await ensureFirebaseReady();
  return fb.getDoc(ref);
}

function setDoc(ref, data, options = undefined) {
  if (hasCompatFirebase()) return ref.set(data, options);
  // L'SDK modulare usa { merge: true } come opzione di setDoc, stessa forma.
  return ensureFirebaseReady().then(() => fb.setDoc(ref, data, options));
}

function updateDoc(ref, data) {
  if (hasCompatFirebase()) return ref.update(data);
  return ensureFirebaseReady().then(() => fb.updateDoc(ref, data));
}

function deleteDocRef(ref) {
  if (hasCompatFirebase()) return ref.delete();
  return ensureFirebaseReady().then(() => fb.deleteDoc(ref));
}

function addDocRef(collectionRef, data) {
  if (hasCompatFirebase()) return collectionRef.add(data);
  return ensureFirebaseReady().then(() => fb.addDoc(collectionRef, data));
}

function queryWhere(collectionRef, field, op, value) {
  if (hasCompatFirebase()) return collectionRef.where(field, op, value);
  return fb.query(collectionRef, fb.where(field, op, value));
}

function queryWhereIn(collectionRef, field, values) {
  if (hasCompatFirebase()) return collectionRef.where(field, "in", values);
  return fb.query(collectionRef, fb.where(field, "in", values));
}

function queryOrderByLimit(collectionRef, field, direction, limit) {
  if (hasCompatFirebase()) return collectionRef.orderBy(field, direction).limit(limit);
  return fb.query(collectionRef, fb.orderBy(field, direction), fb.limit(limit));
}

function queryLimit(collectionRef, limit) {
  if (hasCompatFirebase()) return collectionRef.limit(limit);
  return fb.query(collectionRef, fb.limit(limit));
}

function legacyRecipesQuery() {
  return queryLimit(collectionAt(`users/${requireUser().uid}/recipes`), 100);
}

async function getDocsQuery(query) {
  if (hasCompatFirebase()) return query.get();
  await ensureFirebaseReady();
  return fb.getDocs(query);
}

function onSnapshotRef(ref, onNext, onError) {
  if (hasCompatFirebase()) return ref.onSnapshot(onNext, onError);
  let unsubscribe = () => {};
  firebaseReady.then(() => {
    unsubscribe = fb.onSnapshot(ref, onNext, onError);
  }).catch(onError || (() => {}));
  return () => unsubscribe && unsubscribe();
}

function writeBatch() {
  if (hasCompatFirebase()) return db.batch();
  const batch = fb.writeBatch(db);
  return {
    set: (ref, data, options) => batch.set(ref, data, options),
    update: (ref, data) => batch.update(ref, data),
    delete: ref => batch.delete(ref),
    commit: async () => { await ensureFirebaseReady(); return batch.commit(); }
  };
}

function householdFromSnapshot(snapshot) {
  const households = [];
  snapForEach(snapshot, doc => households.push({ id: doc.id, ...doc.data() }));
  if (!households.length) return null;
  // In condizioni normali un account appartiene a una sola household. Se una
  // vecchia operazione offline ne lascia più di una, manteniamo quella già in
  // uso oppure la più recente, evitando cambi di area dati non deterministici.
  const active = households.find(item => item.id === currentHousehold?.id);
  if (active) return active;
  return households.sort((a, b) => {
    const left = a.updatedAt?.toMillis?.() || a.createdAt?.toMillis?.() || 0;
    const right = b.updatedAt?.toMillis?.() || b.createdAt?.toMillis?.() || 0;
    return right - left;
  })[0];
}

async function prepareDataScope() {
  const user = requireUser();
  const households = collectionAt("households");
  const snapshot = await getDocsQuery(
    queryWhere(households, "memberUids", "array-contains", user.uid)
  );
  currentHousehold = householdFromSnapshot(snapshot);
  return currentHousehold;
}

function observeHouseholdChanges(callback, onError = null) {
  const user = requireUser();
  const handleError = error => {
    console.warn("Sincronizzazione collegamento account non disponibile", error);
    if (onError) onError(error);
  };
  const onNext = snapshot => {
    currentHousehold = householdFromSnapshot(snapshot);
    callback(currentHousehold);
  };
  let unsubscribe = () => {};
  const attach = () => {
    const households = collectionAt("households");
    const q = queryWhere(households, "memberUids", "array-contains", user.uid);
    if (hasCompatFirebase()) {
      unsubscribe = q.onSnapshot(onNext, handleError);
    } else {
      unsubscribe = fb.onSnapshot(q, onNext, handleError);
    }
  };
  if (hasCompatFirebase()) attach();
  else firebaseReady.then(attach).catch(handleError);
  return () => unsubscribe && unsubscribe();
}

// Normalizza il campo itemOrder del documento spesa: mappa "nome categoria" ->
// elenco di ingredientId. Difensivo verso documenti vecchi o scritti male
// (campo assente, non oggetto, valori non array, id non stringa, duplicati):
// le categorie senza id validi non creano chiavi inutili.
function normalizeShopItemOrder(value) {
  const itemOrder = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return itemOrder;
  Object.keys(value).forEach(category => {
    const ids = [];
    const seen = new Set();
    (Array.isArray(value[category]) ? value[category] : []).forEach(id => {
      const clean = typeof id === "string" ? id.trim() : "";
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      ids.push(clean);
    });
    if (ids.length) itemOrder[category] = ids;
  });
  return itemOrder;
}

function shoppingValueFromData(data = {}) {
  const defaults = getDefaultShoppingList();
  return {
    ...defaults,
    ...data,
    selectedMeals: { ...defaults.selectedMeals, ...(data.selectedMeals || {}) },
    excludedItems: data.excludedItems || [],
    customQuantities: data.customQuantities || {},
    itemOrder: { ...defaults.itemOrder, ...normalizeShopItemOrder(data.itemOrder) }
  };
}

function observeSharedDataChanges(callback, onError = null) {
  if (!currentHousehold) return () => {};
  const reportError = error => {
    console.warn("Sincronizzazione realtime non disponibile", error);
    if (onError) onError(error);
  };
  const unsubscribers = [];
  const setup = () => {
    unsubscribers.push(
      onSnapshotRef(recipeCatalogRef(), snapshot => {
        if (!snapExists(snapshot)) return;
        const data = snapData(snapshot);
        const recipes = Array.isArray(data.recipes) ? data.recipes : [];
        catalogMeta = data;
        writeLocalJson("recipe_catalog", recipes);
        callback("recipes", recipes);
      }, reportError),
      onSnapshotRef(weeklyPlanRef(), snapshot => {
        if (!snapExists(snapshot)) return;
        const plan = snapData(snapshot);
        writeLocalJson("weekly_plan", plan);
        callback("plan", plan);
      }, reportError),
      onSnapshotRef(shoppingListRef(), snapshot => {
        const shopping = shoppingValueFromData(snapExists(snapshot) ? snapData(snapshot) : {});
        writeLocalJson("shopping", shopping);
        callback("shopping", shopping);
      }, reportError)
    );
  };
  if (hasCompatFirebase()) setup();
  else firebaseReady.then(setup).catch(reportError);
  return () => unsubscribers.forEach(unsubscribe => unsubscribe?.());
}

function getDefaultDeviceSettings() {
  return {
    portionProfile: "man",
    darkMode: false,
    lastOpenDate: null,
    // Tipo giornata (A/R) scelto nell'anteprima del ricettario: resta finché
    // l'utente non lo cambia di nuovo manualmente.
    recipePreviewDayType: "training",
    // Preferenze locali del ricettario: ricerca e sezioni aperte restano sul
    // singolo dispositivo e non vengono mai condivise con la household.
    recipeLibraryState: { searchQuery: "", openSections: {} },
    // Ordine locale delle categorie nella lista della spesa.
    shopCategoryOrder: []
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
    customQuantities: {},
    // Ordine degli alimenti DENTRO ogni categoria, condiviso con la household
    // perché vive nel documento spesa: { "<nome categoria>": ["<ingredientId>"] }.
    itemOrder: {}
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
    const snapshot = await getDoc(recipeCatalogRef());
    if (snapExists(snapshot)) {
      const data = snapData(snapshot);
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
          migratedAt: serverTimestamp()
        });
      } else {
        writeLocalJson("recipe_catalog", recipes);
      }
      return recipes;
    }

    // In ambito condiviso il documento può risultare momentaneamente mancante
    // (es. household appena creata o snapshot non ancora propagato). In quel
    // caso NON bisogna mai scrivere un catalogo vuoto: azzererebbe le ricette
    // per tutti i membri. Si restituisce la cache locale senza scrivere nulla;
    // il listener realtime aggiornerà i dati appena il documento è leggibile.
    if (currentHousehold) {
      return readLocalJson("recipe_catalog", []);
    }

    // Migrazione una tantum dalla vecchia sottocollezione recipes, se presente.
    // Dopo la migrazione gli avvii costano una sola lettura catalogo.
    const legacySnapshot = await getDocsQuery(legacyRecipesQuery());
    const legacyRecipes = [];
    snapForEach(legacySnapshot, doc => {
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
        migratedAt: serverTimestamp()
      });
      return migrated.recipes;
    }

    // Primo avvio: catalogo vuoto in un documento unico (una sola lettura
    // per gli avvii successivi). Solo in ambito PERSONALE: l'inizializzazione
    // vuota non deve mai toccare un documento condiviso.
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
  await setDoc(recipeCatalogRef(), {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    recipes: clean,
    recipeCount: clean.length,
    ...metadata,
    updatedAt: serverTimestamp()
  });
}

async function getWeeklyPlan() {
  try {
    const snapshot = await getDoc(weeklyPlanRef());
    if (!snapExists(snapshot)) return readLocalJson("weekly_plan", createEmptyWeeklyPlan());
    const plan = snapData(snapshot);

    // Migrazione una tantum del piano: schema 4 + batchTemplates strutturati
    // derivati dalle vecchie batchRules. Salvata una sola volta.
    const hasLegacyRules = plan.batchRules && Object.keys(plan.batchRules).length > 0;
    const needsMigration = Number(plan.schemaVersion || 1) < CATALOG_SCHEMA_VERSION || hasLegacyRules;
    if (needsMigration && typeof PianoDomain !== "undefined") {
      const migrated = PianoDomain.migratePlan(plan);
      writeLocalJson("weekly_plan", migrated);
      await setDoc(weeklyPlanRef(), migrated);
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
  await setDoc(weeklyPlanRef(), clean);
}

async function getShoppingListCloud() {
  const defaults = getDefaultShoppingList();
  try {
    const snapshot = await getDoc(shoppingListRef());
    const value = shoppingValueFromData(snapExists(snapshot) ? snapData(snapshot) : {});
    writeLocalJson("shopping", value);
    return value;
  } catch (error) {
    return shoppingValueFromData(readLocalJson("shopping", defaults));
  }
}

// Aggiorna SOLO la cache locale: usata dalle interazioni rapide della lista
// spesa, dove la scrittura remota viene accorpata con un debounce in app.js.
function saveShoppingListLocal(value) {
  const clean = cloneData(value);
  writeLocalJson("shopping", clean);
  return clean;
}

async function saveShoppingListCloud(value) {
  const clean = saveShoppingListLocal(value);
  await setDoc(shoppingListRef(), clean);
}

// ---- Backup precedente (users/{uid}/backups/previous) ----

async function saveBackup(catalog, plan, shopping, operation, description) {
  const user = requireUser();
  const recipes = Array.isArray(catalog) ? catalog : (catalog?.recipes || []);
  const snapshot = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    catalog: {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      recipes: cloneData(recipes)
    },
    plan: cloneData(plan),
    shoppingList: cloneData(shopping),
    operation,
    description,
    scope: currentHousehold ? "household" : "personal",
    householdId: currentHousehold?.id || null,
    createdByUid: user.uid,
    createdAt: new Date().toISOString()
  };
  await setDoc(backupsRef(), {
    ...snapshot,
    createdAtServer: serverTimestamp()
  });
  return snapshot;
}

async function getBackup() {
  requireUser();
  const snapshot = await getDoc(backupsRef());
  return snapExists(snapshot) ? snapData(snapshot) : null;
}

async function deleteBackup() {
  requireUser();
  await deleteDocRef(backupsRef());
}

// Ripristino atomico: legge il backup, ripristina catalogo/piano/spesa e
// cancella il backup nello stesso batch. Se il backup era stato creato quando
// l'utente era ancora in ambito personale ma ora si trova in una household,
// il ripristino lo riporta prima alla copia personale per non sovrascrivere i
// dati condivisi degli altri membri.
async function restoreBackupAtomic() {
  const user = requireUser();
  const backupDoc = await getDoc(backupsRef());
  if (!snapExists(backupDoc)) throw new Error("Non esiste un backup da ripristinare");
  const backup = snapData(backupDoc);
  const recipes = Array.isArray(backup?.catalog) ? backup.catalog : backup?.catalog?.recipes;
  if (!Array.isArray(recipes) || !backup?.plan) throw new Error("Il backup non è valido");
  backup.catalog = { schemaVersion: CATALOG_SCHEMA_VERSION, recipes };

  const restorePersonalState = backup.scope === "personal";
  const leaveHousehold = restorePersonalState && Boolean(currentHousehold);
  const targetCatalogRef = restorePersonalState || !currentHousehold
    ? personalRecipeCatalogRef()
    : recipeCatalogRef();
  const targetPlanRef = restorePersonalState || !currentHousehold
    ? personalWeeklyPlanRef()
    : weeklyPlanRef();
  const targetShoppingRef = restorePersonalState || !currentHousehold
    ? personalShoppingListRef()
    : shoppingListRef();

  const batch = writeBatch();
  batch.set(targetCatalogRef, {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    recipes: cloneData(recipes),
    recipeCount: recipes.length,
    restoredAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  batch.set(targetPlanRef, cloneData(backup.plan));
  batch.set(targetShoppingRef, cloneData(backup.shoppingList || getDefaultShoppingList()));
  if (leaveHousehold) {
    batch.update(householdRoot(currentHousehold.id), {
      memberUids: arrayRemove(user.uid),
      memberUsernames: arrayRemove(usernameFromUser(user)),
      updatedAt: serverTimestamp()
    });
  }
  batch.delete(backupsRef());
  await batch.commit();

  if (leaveHousehold) currentHousehold = null;
  // Aggiorna anche la cache locale e la UI.
  writeLocalJson("recipe_catalog", backup.catalog.recipes);
  writeLocalJson("weekly_plan", backup.plan);
  writeLocalJson("shopping", backup.shoppingList || getDefaultShoppingList());
  catalogMeta = backup.catalogMeta || catalogMeta;
  return backup;
}

async function importUserDataset(dataset) {
  validateImportedDataset(dataset);
  const recipes = cloneData(dataset.recipes);
  const plan = cloneData(dataset.plan);
  const shopping = getDefaultShoppingList();
  const batch = writeBatch();
  batch.set(recipeCatalogRef(), {
    schemaVersion: Number(dataset.schemaVersion || CATALOG_SCHEMA_VERSION),
    recipes,
    recipeCount: recipes.length,
    importedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
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
  return docAt(`usernames/${normalizeUsername(username)}`);
}

async function ensureUsernameDirectory() {
  const user = requireUser();
  const username = usernameFromUser(user);
  const marker = `pn_username_directory_${user.uid}`;
  try {
    if (localStorage.getItem(marker) === "1") return;
  } catch (_) {}
  await setDoc(usernameDirectoryRef(username), { uid: user.uid, username });
  try { localStorage.setItem(marker, "1"); } catch (_) {}
}

async function findUserByUsername(username) {
  const normalized = normalizeUsername(username);
  if (!isValidUsername(normalized)) throw new Error("Username destinatario non valido");
  const snapshot = await getDoc(usernameDirectoryRef(normalized));
  if (!snapExists(snapshot)) throw new Error("Utente non trovato. Deve aver aperto almeno una volta l'ultima versione dell'app.");
  return snapData(snapshot);
}

async function sendRecipeShare(recipientUsername, recipes, plan = null) {
  requireUser();
  validateRecipeCatalog(recipes);
  if (!recipes.length) throw new Error("Non ci sono ricette da inviare");
  await ensureUsernameDirectory();
  const recipient = await findUserByUsername(recipientUsername);
  if (recipient.uid === currentUser.uid) throw new Error("Non puoi inviare ricette al tuo stesso account");
  const senderUsername = usernameFromUser(currentUser);
  if (!hasCompatFirebase()) await ensureFirebaseReady();
  const shareRef = newDocIn(collectionAt("recipeShares"));
  const includesPlan = Boolean(plan && plan.days);
  const normalizedPlan = includesPlan && typeof PianoDomain !== "undefined"
    ? PianoDomain.migratePlan(cloneData(plan))
    : null;
  await setDoc(shareRef, {
    senderUid: currentUser.uid,
    senderUsername,
    recipientUid: recipient.uid,
    recipientUsername: recipient.username,
    status: "pending",
    recipeCount: recipes.length,
    recipes: cloneData(recipes),
    includesPlan,
    plan: normalizedPlan,
    createdAt: serverTimestamp()
  });
  return shareRef.id;
}

async function getIncomingRequestsSnapshot() {
  const user = requireUser();
  await ensureUsernameDirectory();
  const shares = collectionAt("recipeShares");
  return getDocsQuery(queryWhere(shares, "recipientUid", "==", user.uid));
}

// Query unica sulla casella delle richieste in arrivo: i documenti vengono
// letti UNA volta e ripartiti lato client tra condivisioni ricette e inviti
// accountLink. Le vecchie condivisioni possono NON avere il campo `type`
// (le regole lo consentono), quindi la discriminante è `type === "accountLink"`
// per i collegamenti e tutto il resto per le ricette. Il filtro su status/type
// resta in JavaScript: un secondo `where` richiederebbe un indice composito.
async function getPendingIncomingRequests() {
  const snapshot = await getIncomingRequestsSnapshot();
  const recipeShares = [];
  const accountLinks = [];
  snapForEach(snapshot, doc => {
    const data = doc.data();
    if (data.status !== "pending") return;
    (data.type === "accountLink" ? accountLinks : recipeShares).push({ id: doc.id, ...data });
  });
  const byCreatedAtDesc = (a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0);
  recipeShares.sort(byCreatedAtDesc);
  accountLinks.sort(byCreatedAtDesc);
  return { recipeShares, accountLinks };
}

async function getPendingRecipeShares() {
  const { recipeShares } = await getPendingIncomingRequests();
  return recipeShares;
}

async function rejectRecipeShare(shareId) {
  await deleteDocRef(docAt(`recipeShares/${shareId}`));
}

async function acceptRecipeShare(shareId, recipes, plan = null) {
  validateRecipeCatalog(recipes);
  const batch = writeBatch();
  batch.set(recipeCatalogRef(), {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    recipes: cloneData(recipes),
    recipeCount: recipes.length,
    updatedAt: serverTimestamp()
  });
  if (plan) batch.set(weeklyPlanRef(), cloneData(plan));
  if (!hasCompatFirebase()) await ensureFirebaseReady();
  batch.delete(docAt(`recipeShares/${shareId}`));
  await batch.commit();
  writeLocalJson("recipe_catalog", recipes);
  if (plan) writeLocalJson("weekly_plan", plan);
}

// ---- Collegamento account / household condivisa ----

function accountLinkDataset(recipes, plan, shoppingList) {
  validateRecipeCatalog(recipes || []);
  if (!plan?.days) throw new Error("Il piano settimanale non è valido");
  return {
    recipes: cloneData(recipes || []),
    plan: cloneData(plan),
    shoppingList: cloneData(shoppingList || getDefaultShoppingList())
  };
}

async function sendAccountLink(recipientUsername, recipes, plan, shoppingList) {
  const user = requireUser();
  const dataset = accountLinkDataset(recipes, plan, shoppingList);
  await ensureUsernameDirectory();
  const recipient = await findUserByUsername(recipientUsername);
  if (recipient.uid === user.uid) throw new Error("Non puoi collegare il tuo stesso account");

  const senderUsername = usernameFromUser(user);
  const sourceMemberUids = currentHousehold?.memberUids?.length
    ? [...currentHousehold.memberUids]
    : [user.uid];
  const sourceMemberUsernames = currentHousehold?.memberUsernames?.length
    ? [...currentHousehold.memberUsernames]
    : [senderUsername];
  if (!hasCompatFirebase()) await ensureFirebaseReady();
  const shareRef = newDocIn(collectionAt("recipeShares"));
  await setDoc(shareRef, {
    type: "accountLink",
    senderUid: user.uid,
    senderUsername,
    recipientUid: recipient.uid,
    recipientUsername: recipient.username,
    status: "pending",
    sourceHouseholdId: currentHousehold?.id || null,
    sourceMemberUids,
    sourceMemberUsernames,
    recipeCount: dataset.recipes.length,
    recipes: dataset.recipes,
    includesPlan: true,
    plan: dataset.plan,
    shoppingList: dataset.shoppingList,
    createdAt: serverTimestamp()
  });
  return shareRef.id;
}

async function getPendingAccountLinks() {
  const { accountLinks } = await getPendingIncomingRequests();
  return accountLinks;
}

async function acceptAccountLink(shareId, base, recipientRecipes, recipientPlan, recipientShopping) {
  const user = requireUser();
  if (!["sender", "recipient"].includes(base)) throw new Error("Scegli quale settimana usare come base");
  const recipientDataset = accountLinkDataset(recipientRecipes, recipientPlan, recipientShopping);
  if (!hasCompatFirebase()) await ensureFirebaseReady();
  const shareRef = docAt(`recipeShares/${shareId}`);
  const shareSnapshot = await getDoc(shareRef);
  if (!snapExists(shareSnapshot)) throw new Error("La richiesta non è più disponibile");
  const share = snapData(shareSnapshot);
  if (share.type !== "accountLink" || share.status !== "pending" || share.recipientUid !== user.uid) {
    throw new Error("Richiesta di collegamento non valida");
  }

  const senderDataset = accountLinkDataset(share.recipes || [], share.plan, share.shoppingList);
  const chosen = base === "recipient" ? recipientDataset : senderDataset;
  const other = base === "recipient" ? senderDataset : recipientDataset;
  // Protezione anti-svuotamento: se la base scelta ha 0 ricette mentre
  // l'altra parte ne ha, procedere significherebbe far "sparire" le ricette
  // per entrambi senza alcun errore. Meglio bloccare e spiegare.
  if (!chosen.recipes.length && other.recipes.length) {
    const chosenLabel = base === "sender"
      ? `la settimana di ${share.senderUsername || "chi invita"}`
      : "la tua settimana";
    throw new Error(
      `Non puoi usare come base ${chosenLabel}: non contiene ricette, mentre l'altra ne ha ${other.recipes.length}. ` +
      "Scegli l'altra settimana come base per non perdere i dati."
    );
  }
  const oldHousehold = currentHousehold;
  const targetId = share.sourceHouseholdId || shareId;
  if (oldHousehold?.id === targetId) throw new Error("L'account risulta già collegato");
  if (oldHousehold?.memberUids?.length > 1) {
    throw new Error("Scollega prima il tuo account dal gruppo attuale");
  }

  const hhRoot = householdRoot(targetId);
  const hhContentRef = name => householdContentDoc(targetId, name);
  const hhConfigRef = name => householdConfigDoc(targetId, name);

  const batch = writeBatch();
  if (share.sourceHouseholdId) {
    // Il destinatario non può leggere la household prima dell'accettazione;
    // arrayUnion consente un'aggiunta atomica verificata dalle Security Rules.
    batch.update(hhRoot, {
      memberUids: arrayUnion(user.uid),
      memberUsernames: arrayUnion(usernameFromUser(user)),
      lastLinkRequestId: shareId,
      updatedAt: serverTimestamp()
    });
  } else {
    batch.set(hhRoot, {
      ownerUid: share.senderUid,
      memberUids: [share.senderUid, user.uid],
      memberUsernames: [share.senderUsername, usernameFromUser(user)],
      createdFromLinkRequest: shareId,
      lastLinkRequestId: shareId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }

  // Un eventuale gruppo residuo composto dal solo destinatario viene lasciato
  // nello stesso batch prima di entrare nel nuovo gruppo.
  if (oldHousehold && oldHousehold.id !== targetId) {
    batch.update(householdRoot(oldHousehold.id), {
      memberUids: arrayRemove(user.uid),
      memberUsernames: arrayRemove(usernameFromUser(user)),
      updatedAt: serverTimestamp()
    });
  }

  // I dati della base scelta vengono scritti SEMPRE nel documento condiviso,
  // nello stesso batch atomico dell'ingresso in household (consentito dalle
  // Security Rules tramite getAfter). In passato, con base "sender" e una
  // household già esistente, ci si fidava del contenuto corrente: se il
  // documento condiviso era vuoto o mancante, entrambi i membri finivano a
  // leggere un catalogo vuoto e le ricette "sparivano" senza errori.
  batch.set(hhContentRef("recipeCatalog"), {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    recipes: chosen.recipes,
    recipeCount: chosen.recipes.length,
    updatedAt: serverTimestamp()
  });
  batch.set(hhConfigRef("weeklyPlan"), chosen.plan);
  batch.set(hhConfigRef("shoppingList"), chosen.shoppingList);
  batch.delete(shareRef);
  await batch.commit();

  currentHousehold = {
    id: targetId,
    ownerUid: share.senderUid,
    memberUids: [...new Set([...(share.sourceMemberUids || [share.senderUid]), user.uid])],
    memberUsernames: [...new Set([...(share.sourceMemberUsernames || [share.senderUsername]), usernameFromUser(user)])]
  };
  writeLocalJson("recipe_catalog", chosen.recipes);
  writeLocalJson("weekly_plan", chosen.plan);
  writeLocalJson("shopping", chosen.shoppingList);
  return currentHousehold;
}

async function rejectAccountLink(shareId) {
  return rejectRecipeShare(shareId);
}

async function unlinkCurrentAccount(recipes, plan, shoppingList) {
  const user = requireUser();
  if (!currentHousehold) throw new Error("Nessun account collegato");
  const dataset = accountLinkDataset(recipes, plan, shoppingList);
  const household = currentHousehold;
  const batch = writeBatch();

  // Ogni persona riparte da una copia completa dello stato condiviso corrente.
  batch.set(personalRecipeCatalogRef(), {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    recipes: dataset.recipes,
    recipeCount: dataset.recipes.length,
    detachedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  batch.set(personalWeeklyPlanRef(), dataset.plan);
  batch.set(personalShoppingListRef(), dataset.shoppingList);
  batch.update(householdRoot(household.id), {
    memberUids: arrayRemove(user.uid),
    memberUsernames: arrayRemove(usernameFromUser(user)),
    updatedAt: serverTimestamp()
  });
  await batch.commit();

  currentHousehold = null;
  writeLocalJson("recipe_catalog", dataset.recipes);
  writeLocalJson("weekly_plan", dataset.plan);
  writeLocalJson("shopping", dataset.shoppingList);
  return dataset;
}

// ---- Prezzi condivisi (Spesa Smart): UNICO database per tutti gli utenti ----
// priceEntries: un documento per ogni prezzo registrato, leggibile da tutti
// gli account; modifica ed eliminazione restano riservate all'autore.
// priceMeta/global: rubrica dei nomi di negozi, prodotti e marche usati, per
// i suggerimenti condivisi. Aggiornata con arrayUnion solo quando serve.

function priceEntriesRef() {
  return collectionAt("priceEntries");
}

function priceMetaRef() {
  return docAt("priceMeta/global");
}

function defaultPriceMeta() {
  return { stores: [], products: [], brands: [] };
}

function sanitizePriceMeta(data = {}) {
  const cleanList = value => (Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()) : []);
  return {
    stores: cleanList(data.stores),
    products: cleanList(data.products),
    brands: cleanList(data.brands)
  };
}

async function getPriceMeta() {
  const fallback = defaultPriceMeta();
  try {
    const snapshot = await getDoc(priceMetaRef());
    const meta = sanitizePriceMeta(snapExists(snapshot) ? snapData(snapshot) : fallback);
    writeLocalJson("price_meta", meta);
    return meta;
  } catch (error) {
    console.warn("Rubrica prezzi non disponibile, uso la cache locale", error);
    return sanitizePriceMeta(readLocalJson("price_meta", fallback));
  }
}

// Aggiunge alla rubrica condivisa solo i nomi davvero nuovi (confronto senza
// distinguere maiuscole/accenti): quando non c'è nulla di nuovo la scrittura
// viene saltata del tutto. Restituisce true se il documento è stato scritto.
async function mergePriceMetaFromEntries(entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  if (!list.length) return false;
  const meta = sanitizePriceMeta(readLocalJson("price_meta", defaultPriceMeta()));
  const additions = { stores: [], products: [], brands: [] };
  const known = {
    stores: new Set(meta.stores.map(name => PriceDomain.priceKey(name))),
    products: new Set(meta.products.map(name => PriceDomain.priceKey(name))),
    brands: new Set(meta.brands.map(name => PriceDomain.priceKey(name)))
  };
  list.forEach(entry => {
    [["stores", entry.store], ["products", entry.product], ["brands", entry.brand]].forEach(([field, name]) => {
      const clean = String(name || "").trim();
      if (!clean) return;
      const key = PriceDomain.priceKey(clean);
      if (known[field].has(key)) return;
      known[field].add(key);
      additions[field].push(clean);
      meta[field].push(clean);
    });
  });
  meta.stores.sort((a, b) => a.localeCompare(b, "it"));
  meta.products.sort((a, b) => a.localeCompare(b, "it"));
  meta.brands.sort((a, b) => a.localeCompare(b, "it"));
  writeLocalJson("price_meta", meta);
  if (!additions.stores.length && !additions.products.length && !additions.brands.length) return false;
  await setDoc(priceMetaRef(), {
    stores: arrayUnion(...additions.stores),
    products: arrayUnion(...additions.products),
    brands: arrayUnion(...additions.brands),
    updatedAt: serverTimestamp()
  }, { merge: true });
  return true;
}

function priceEntryPayload(entry) {
  return {
    ...cloneData(entry),
    createdAtMs: entry.createdAtMs || Date.now(),
    createdAt: serverTimestamp()
  };
}

function priceEntryFromDoc(doc) {
  return { id: doc.id, ...doc.data() };
}

async function savePriceEntry(entry) {
  requireUser();
  const ref = await addDocRef(priceEntriesRef(), priceEntryPayload(entry));
  await mergePriceMetaFromEntries(entry).catch(error => console.warn("Rubrica prezzi non aggiornata", error));
  return ref.id;
}

// Importazione multipla (backup JSON): UNA scrittura in batch per tutte le
// voci + al massimo una scrittura della rubrica (vedi savePriceImport).
async function updatePriceEntry(entryId, entry) {
  requireUser();
  await updateDoc(docInCollection(priceEntriesRef(), entryId), {
    ...cloneData(entry),
    updatedAt: serverTimestamp()
  });
  await mergePriceMetaFromEntries(entry).catch(error => console.warn("Rubrica prezzi non aggiornata", error));
}

async function deletePriceEntry(entryId) {
  requireUser();
  await deleteDocRef(docInCollection(priceEntriesRef(), entryId));
}

// Tutte le voci registrate per un prodotto (chiave normalizzata): una sola
// query senza indici compositi, l'ordinamento avviene lato client.
async function getPriceEntriesForProduct(productKey) {
  requireUser();
  const snapshot = await getDocsQuery(
    queryWhere(priceEntriesRef(), "productKey", "==", productKey)
  );
  const entries = [];
  snapForEach(snapshot, doc => entries.push(priceEntryFromDoc(doc)));
  return PriceDomain.sortEntriesDesc(entries);
}

// Ultime voci del database condiviso (archivio): orderBy su un solo campo,
// coperto dagli indici automatici di Firestore.
async function getRecentPriceEntries(limit = 150) {
  requireUser();
  const snapshot = await getDocsQuery(
    queryOrderByLimit(priceEntriesRef(), "createdAt", "desc", limit)
  );
  const entries = [];
  snapForEach(snapshot, doc => entries.push(priceEntryFromDoc(doc)));
  return PriceDomain.sortEntriesDesc(entries);
}

// Importazione di un backup prezzi (vecchio formato "Spesa Smart" o formato
// nuovo). Idempotente: le voci che hanno lo stesso legacyId di una voce già
// importata in precedenza vengono saltate (query `in` a gruppi di 30, coperte
// dagli indici automatici). Le scritture avvengono in batch da massimo 450.
async function savePriceImport(entries, meta = {}) {
  requireUser();
  if (!Array.isArray(entries) || !entries.length) return { imported: 0, skippedDuplicates: 0 };
  const legacyIds = [...new Set(entries.map(entry => entry.legacyId).filter(Number.isFinite))];
  const known = new Set();
  for (let start = 0; start < legacyIds.length; start += 30) {
    const chunk = legacyIds.slice(start, start + 30);
    const snapshot = await getDocsQuery(queryWhereIn(priceEntriesRef(), "legacyId", chunk));
    snapForEach(snapshot, doc => {
      const data = doc.data();
      if (Number.isFinite(Number(data?.legacyId))) known.add(`${data.legacyId}|${data.productKey || ""}`);
    });
  }
  const fresh = entries.filter(entry =>
    !Number.isFinite(entry.legacyId) || !known.has(`${entry.legacyId}|${entry.productKey}`));
  const author = {
    createdBy: meta.uid || requireUser().uid,
    createdByUsername: meta.username || usernameFromUser(currentUser)
  };
  const compat = hasCompatFirebase();
  if (!compat) await ensureFirebaseReady();
  const CHUNK_SIZE = 450;
  for (let start = 0; start < fresh.length; start += CHUNK_SIZE) {
    const batch = writeBatch();
    fresh.slice(start, start + CHUNK_SIZE).forEach(entry => {
      // Un nuovo riferimento documento con id auto-generato: con l'API
      // modulare `doc(collection)` senza id crea l'id client-side.
      batch.set(newDocIn(priceEntriesRef()), priceEntryPayload({ ...entry, ...author }));
    });
    await batch.commit();
  }
  if (fresh.length) {
    await mergePriceMetaFromEntries(fresh).catch(error => console.warn("Rubrica prezzi non aggiornata", error));
  }
  return { imported: fresh.length, skippedDuplicates: entries.length - fresh.length };
}

// Tutte le voci registrate in un negozio (pagina negozio): una sola query
// sul campo storeKey, coperta dagli indici automatici.
async function getPriceEntriesForStore(storeKey) {
  requireUser();
  const snapshot = await getDocsQuery(
    queryWhere(priceEntriesRef(), "storeKey", "==", storeKey)
  );
  const entries = [];
  snapForEach(snapshot, doc => entries.push(priceEntryFromDoc(doc)));
  return PriceDomain.sortEntriesDesc(entries);
}
