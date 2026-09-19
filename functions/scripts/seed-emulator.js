'use strict';
/**
 * Seed dell'emulator Firebase per il piano SaaS: popola utenti di demo,
 * organizzazione, catalogo globale ingredienti (identità, nessuna dose),
 * un template equivalenze e una struttura dieta a blocchi con revisione
 * pubblicata e snapshot template non retroattivo.
 *
 * Uso (dopo `firebase emulators:start`):
 *   node functions/scripts/seed-emulator.js
 *
 * Le dosi vivono SOLO nel template equivalenze e nella struttura dieta
 * (perimetro organizzazione); il catalogo resta identità pura. I dati
 * costruiti sono esportati da `buildSeedData()` così i test possono
 * validarli senza emulator.
 */
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateDietPlan,
  validateEquivalenceTemplateRevision,
  equivalenceTemplateRevisionChecksum,
  structureRevisionChecksum,
  STRUCTURE_REVISION_SCHEMA_VERSION
} = require('../src/domain');

const orgId = 'pianoNutrizionale';
const password = 'Demo-sicura-2026';
const catalogVersion = 1;
const templateId = 'tpl-amidi-cereali';

// Canonicalizzazione identica a `importGlobalIngredientCatalog` (commit):
// alias ordinati con sort() plain, flag dietetici booleani, status attivo.
function canonicalCategory(entry) {
  return {
    categoryId: entry.categoryId, displayName: entry.displayName,
    description: entry.description ?? null,
    sortOrder: Number(entry.sortOrder || 0), status: entry.status || 'active'
  };
}
function canonicalFamily(entry) {
  return {
    familyId: entry.familyId, displayName: entry.displayName,
    categoryId: entry.categoryId, sortOrder: Number(entry.sortOrder || 0),
    status: entry.status || 'active'
  };
}
function canonicalIngredient(entry) {
  return {
    ingredientId: entry.ingredientId, displayName: entry.displayName,
    aliases: [...(entry.aliases || [])].sort(),
    categoryId: entry.categoryId, familyId: entry.familyId || null,
    dietaryFlags: {
      vegetarian: entry.dietaryFlags?.vegetarian === true,
      vegan: entry.dietaryFlags?.vegan === true
    },
    status: entry.status || 'active'
  };
}
function catalogContentChecksum(ingredients, categories, families, version) {
  const byId = key => (a, b) => String(a[key]).localeCompare(String(b[key]));
  return checksumOf({
    schemaVersion: 1, catalogVersion: version,
    ingredients: ingredients.map(item => canonicalIngredient(item)).sort(byId('ingredientId')),
    categories: categories.map(item => canonicalCategory(item)).sort(byId('categoryId')),
    families: families.map(item => canonicalFamily(item)).sort(byId('familyId'))
  });
}
function checksumOf(value) {
  // `checksum` è deterministica e uguale lato server: la si richiede a runtime
  // per non duplicarla qui (il modulo è già importato per le validazioni).
  return require('../src/domain').checksum(value);
}

// Sommario contatori della struttura, stesso contratto di `dietPlanSummaryData`.
function dietPlanSummaryOf(dietPlan) {
  let meals = 0;
  let options = 0;
  let blocks = 0;
  let items = 0;
  let recipes = 0;
  (dietPlan?.days || []).forEach(day => (day?.meals || []).forEach(meal => {
    meals += 1;
    (meal?.options || []).forEach(option => {
      options += 1;
      if (option?.type === 'recipe') recipes += 1;
      blocks += Array.isArray(option?.blocks) ? option.blocks.length : 0;
      items += Array.isArray(option?.items) ? option.items.length : 0;
    });
  }));
  return { dayCount: (dietPlan?.days || []).length, mealCount: meals, optionCount: options, blockCount: blocks, itemCount: items, recipeOptionCount: recipes };
}

// ---- Template equivalenze (perimetro organizzazione) ----
// Riferimento famiglia cereali (riso 80g) con equivalenti proporzionali.
const SEED_TEMPLATE = {
  name: 'Amidi — porzione standard',
  referenceFamilyId: 'cereali',
  referenceIngredientId: 'riso',
  referenceAmount: { value: 80, unit: 'g' },
  equivalents: [
    { familyId: 'patate', ingredientId: 'patate', amount: { value: 250, unit: 'g' } },
    { familyId: 'pane-e-affini', ingredientId: 'pane', amount: { value: 70, unit: 'g' } },
    { familyId: 'gnocchi', ingredientId: null, amount: { value: 120, unit: 'g' } },
    { familyId: 'polenta', ingredientId: null, amount: { value: 200, unit: 'g' } }
  ]
};

// ---- Struttura dieta a blocchi (dietPlan schema 1) ----
// Il blocco cereali del pranzo è agganciato alla revisione 1 del template:
// lo snapshot è fissato nella revisione pubblicata e non cambia se il
// template evolve (non retroattività silenziosa). Un override puntuale
// personalizza gli gnocchi rispetto al template.
const SEED_DIET_PLAN = {
  schemaVersion: 1,
  days: [
    {
      dayId: 'giorno-allenamento', label: 'Giorno di allenamento', dayType: 'training',
      meals: [
        {
          mealId: 'breakfast', time: '07:30',
          options: [{
            optionId: 'colazione-standard', type: 'ingredients',
            items: [
              { itemId: 'avena', ingredientId: 'avena', amount: { value: 60, unit: 'g' } },
              { itemId: 'latte', ingredientId: 'latte', amount: { value: 200, unit: 'ml' } },
              { itemId: 'mela', ingredientId: 'mela', amount: { value: 1, unit: 'pz' } }
            ]
          }],
          note: 'Colazione pre-allenamento.'
        },
        {
          mealId: 'lunch', time: '12:30',
          options: [
            {
              optionId: 'pranzo-riso-pesce', type: 'family-block',
              blocks: [
                {
                  blockId: 'amidi-riso', referenceFamilyId: 'cereali', referenceIngredientId: 'riso',
                  referenceAmount: { value: 80, unit: 'g' },
                  templateId,
                  templateSnapshot: {
                    revisionId: '1',
                    referenceAmount: { value: 80, unit: 'g' },
                    equivalents: SEED_TEMPLATE.equivalents
                  },
                  overrides: [{ familyId: 'gnocchi', ingredientId: null, amount: { value: 150, unit: 'g' } }]
                },
                { blockId: 'proteine-merluzzo', referenceFamilyId: 'pesce-bianco-magro', referenceIngredientId: 'merluzzo', referenceAmount: { value: 150, unit: 'g' }, templateId: null, templateSnapshot: null, overrides: [] },
                { blockId: 'verdura-cotta', referenceFamilyId: 'verdura', referenceIngredientId: 'zucchine', referenceAmount: { value: 200, unit: 'g' }, templateId: null, templateSnapshot: null, overrides: [] }
              ]
            },
            {
              optionId: 'pranzo-pane-tonno', type: 'family-block',
              blocks: [
                { blockId: 'amidi-pane', referenceFamilyId: 'pane-e-affini', referenceIngredientId: 'pane', referenceAmount: { value: 70, unit: 'g' }, templateId: null, templateSnapshot: null, overrides: [] },
                { blockId: 'proteine-tonno', referenceFamilyId: 'pesce-azzurro', referenceIngredientId: 'tonno-fresco', referenceAmount: { value: 150, unit: 'g' }, templateId: null, templateSnapshot: null, overrides: [] },
                { blockId: 'verdura-cruda', referenceFamilyId: 'verdura', referenceIngredientId: 'pomodori', referenceAmount: { value: 150, unit: 'g' }, templateId: null, templateSnapshot: null, overrides: [] }
              ],
              note: 'Alternativa veloce senza cottura lunga.'
            }
          ]
        },
        {
          mealId: 'afternoon-snack', time: '16:30',
          options: [{
            optionId: 'snack-yogurt', type: 'ingredients',
            items: [
              { itemId: 'yogurt-greco', ingredientId: 'yogurt-greco', amount: { value: 125, unit: 'g' } },
              { itemId: 'mandorle', ingredientId: 'mandorle', amount: { value: 15, unit: 'g' } }
            ]
          }]
        },
        {
          mealId: 'dinner', time: '20:00',
          options: [{
            optionId: 'cena-pollo-patate', type: 'family-block',
            blocks: [
              { blockId: 'proteine-pollo', referenceFamilyId: 'pollo-tacchino', referenceIngredientId: 'pollo', referenceAmount: { value: 150, unit: 'g' }, templateId: null, templateSnapshot: null, overrides: [] },
              { blockId: 'amidi-patate', referenceFamilyId: 'patate', referenceIngredientId: 'patate', referenceAmount: { value: 200, unit: 'g' }, templateId: null, templateSnapshot: null, overrides: [] },
              { blockId: 'verdura-broccoli', referenceFamilyId: 'verdura', referenceIngredientId: 'broccoli', referenceAmount: { value: 250, unit: 'g' }, templateId: null, templateSnapshot: null, overrides: [] }
            ]
          }]
        }
      ],
      hydration: 'Almeno 2,5 litri di acqua.',
      note: 'Giornata con seduta di allenamento pomeridiana.'
    },
    {
      dayId: 'giorno-riposo', label: 'Giorno di riposo', dayType: 'rest',
      meals: [
        {
          mealId: 'breakfast', time: '08:00',
          options: [{
            optionId: 'colazione-uova', type: 'ingredients',
            items: [
              { itemId: 'uova', ingredientId: 'uova', amount: { value: 2, unit: 'pz' } },
              { itemId: 'pane-2', ingredientId: 'pane', amount: { value: 60, unit: 'g' } }
            ]
          }]
        },
        {
          mealId: 'lunch', time: '13:00',
          options: [{
            optionId: 'pranzo-legumi', type: 'family-block',
            blocks: [
              { blockId: 'legumi-lenticchie', referenceFamilyId: 'legumi', referenceIngredientId: 'lenticchie', referenceAmount: { value: 90, unit: 'g' }, templateId: null, templateSnapshot: null, overrides: [] },
              { blockId: 'amidi-riso-riposo', referenceFamilyId: 'cereali', referenceIngredientId: 'riso', referenceAmount: { value: 60, unit: 'g' }, templateId: null, templateSnapshot: null, overrides: [] },
              { blockId: 'verdura-insalata', referenceFamilyId: 'verdura', referenceIngredientId: 'insalata', referenceAmount: { value: 100, unit: 'g' }, templateId: null, templateSnapshot: null, overrides: [] }
            ]
          }]
        },
        {
          mealId: 'afternoon-snack', time: '17:00',
          options: [{
            optionId: 'snack-frutta', type: 'ingredients',
            items: [
              { itemId: 'banana', ingredientId: 'banana', amount: { value: 1, unit: 'pz' } }
            ]
          }]
        },
        {
          mealId: 'dinner', time: '20:30',
          options: [{
            optionId: 'cena-pesce', type: 'family-block',
            blocks: [
              { blockId: 'proteine-orata', referenceFamilyId: 'pesce-bianco-magro', referenceIngredientId: 'orata', referenceAmount: { value: 200, unit: 'g' }, templateId: null, templateSnapshot: null, overrides: [] },
              { blockId: 'verdura-zucchine', referenceFamilyId: 'verdura', referenceIngredientId: 'zucchine', referenceAmount: { value: 250, unit: 'g' }, templateId: null, templateSnapshot: null, overrides: [] }
            ]
          }]
        }
      ],
      hydration: 'Almeno 2 litri di acqua.',
      note: 'Giornata senza allenamento: porzioni di amidi ridotte.'
    }
  ],
  generalNotes: 'Struttura di esempio generata dal seed: blocchi famiglia con template equivalenze e override puntuali.'
};

function buildSeedData() {
  const extract = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/catalogo-ingredienti.json'), 'utf8'));
  if (Number(extract.schemaVersion) !== 2) {
    throw new Error(`schemaVersion inattesa nel catalogo: ${extract.schemaVersion}`);
  }
  const categories = extract.categories.map(canonicalCategory);
  const families = extract.families.map(canonicalFamily);
  const ingredients = extract.ingredients.map(canonicalIngredient);
  const templateRevision = validateEquivalenceTemplateRevision(SEED_TEMPLATE);
  const dietPlan = validateDietPlan(SEED_DIET_PLAN);
  return {
    categories, families, ingredients,
    catalogChecksum: catalogContentChecksum(ingredients, categories, families, catalogVersion),
    templateId, templateRevision,
    templateChecksum: equivalenceTemplateRevisionChecksum(templateRevision),
    dietPlan,
    structureChecksum: structureRevisionChecksum({ schemaVersion: STRUCTURE_REVISION_SCHEMA_VERSION, dietPlan }),
    summary: dietPlanSummaryOf(dietPlan),
    catalogVersion
  };
}

async function user(auth, username) {
  const email = `${username}@utenti.pianonutrizionale.app`;
  try { return await auth.getUserByEmail(email); }
  catch (_) { return auth.createUser({ email, password, displayName: username }); }
}

async function main() {
  initializeApp({ projectId: 'piano-nutrizionale-test' });
  const auth = getAuth();
  const db = getFirestore();
  const [creator, nutritionist, patientA, patientB] = await Promise.all([
    user(auth, 'admin-demo'), user(auth, 'nutri-demo'), user(auth, 'cliente-a'), user(auth, 'cliente-b')
  ]);
  const { categories, families, ingredients, catalogChecksum, templateRevision, templateChecksum, dietPlan, structureChecksum, summary } = buildSeedData();
  const now = FieldValue.serverTimestamp();

  const batch = db.batch();
  batch.set(db.doc(`organizations/${orgId}`), { schemaVersion: 1, name: 'Piano Nutrizionale', status: 'active', createdAt: now, updatedAt: now, createdBy: creator.uid, updatedBy: creator.uid });
  batch.set(db.doc(`platformMembers/${creator.uid}`), { schemaVersion: 1, role: 'admin', status: 'active', username: 'admin-demo', createdAt: now, updatedAt: now });
  batch.set(db.doc(`organizations/${orgId}/members/${nutritionist.uid}`), { schemaVersion: 1, role: 'nutritionist', status: 'active', username: 'nutri-demo', createdAt: now, updatedAt: now, createdBy: creator.uid, updatedBy: creator.uid });
  batch.set(db.doc(`organizations/${orgId}/clients/client-a`), { schemaVersion: 1, authUid: patientA.uid, displayCode: 'CL-001', status: 'active', nutritionistUids: [nutritionist.uid], createdAt: now, updatedAt: now, createdBy: creator.uid, updatedBy: creator.uid });
  batch.set(db.doc(`organizations/${orgId}/clients/client-b`), { schemaVersion: 1, authUid: patientB.uid, displayCode: 'CL-002', status: 'active', nutritionistUids: [], createdAt: now, updatedAt: now, createdBy: creator.uid, updatedBy: creator.uid });
  batch.set(db.doc(`accountClientLinks/${patientA.uid}`), { schemaVersion: 1, organizationId: orgId, clientId: 'client-a', status: 'active', createdAt: now, updatedAt: now });
  batch.set(db.doc(`accountClientLinks/${patientB.uid}`), { schemaVersion: 1, organizationId: orgId, clientId: 'client-b', status: 'active', createdAt: now, updatedAt: now });

  categories.forEach(category => batch.set(
    db.doc(`globalIngredientCatalog/current/categories/${category.categoryId}`),
    { schemaVersion: 1, ...category, catalogVersion, updatedAt: now }
  ));
  families.forEach(family => batch.set(
    db.doc(`globalIngredientCatalog/current/families/${family.familyId}`),
    { schemaVersion: 1, ...family, catalogVersion, updatedAt: now }
  ));
  ingredients.forEach(ingredient => batch.set(
    db.doc(`globalIngredientCatalog/current/ingredients/${ingredient.ingredientId}`),
    { schemaVersion: 1, ...ingredient, catalogVersion, updatedAt: now }
  ));
  batch.set(db.doc('globalIngredientCatalog/current/meta/summary'), {
    schemaVersion: 1, catalogVersion, checksum: catalogChecksum,
    ingredientCount: ingredients.length, categoryCount: categories.length, familyCount: families.length,
    updatedAt: now
  });

  batch.set(db.doc(`organizations/${orgId}/equivalenceTemplates/${templateId}`), {
    schemaVersion: 1, name: templateRevision.name, status: 'active', ownerUid: nutritionist.uid, createdBy: nutritionist.uid,
    currentRevisionId: '1', latestChecksum: templateChecksum,
    referenceFamilyId: templateRevision.referenceFamilyId,
    ingredientCatalogVersion: catalogVersion, createdAt: now, updatedAt: now, updatedBy: nutritionist.uid
  });
  batch.set(db.doc(`organizations/${orgId}/equivalenceTemplates/${templateId}/revisions/1`), {
    schemaVersion: 1, revisionId: '1', templateId, ...templateRevision,
    status: 'published', checksum: templateChecksum, ingredientCatalogVersion: catalogVersion,
    changelog: 'Prima revisione (seed)', createdAt: now, publishedAt: now, publishedBy: nutritionist.uid
  });

  batch.set(db.doc(`organizations/${orgId}/dietStructures/struttura-base`), {
    schemaVersion: 2, name: 'Settimana tipo — seed', status: 'active', ownerUid: nutritionist.uid, createdBy: nutritionist.uid,
    currentRevisionId: '1', latestChecksum: structureChecksum, summary,
    ingredientCatalogVersion: catalogVersion, createdAt: now, updatedAt: now
  });
  batch.set(db.doc(`organizations/${orgId}/dietStructures/struttura-base/revisions/1`), {
    schemaVersion: STRUCTURE_REVISION_SCHEMA_VERSION, revisionId: '1', structureId: 'struttura-base',
    dietPlan, status: 'published', checksum: structureChecksum, ingredientCatalogVersion: catalogVersion,
    compatibleClientSchema: 7, changelog: 'Seed emulator: blocchi famiglia + template equivalenze',
    createdAt: now, updatedAt: now, createdBy: nutritionist.uid, publishedAt: now, publishedBy: nutritionist.uid
  });
  await batch.commit();

  console.log(JSON.stringify({
    organizationId: orgId,
    usernames: ['admin-demo', 'nutri-demo', 'cliente-a', 'cliente-b'],
    password,
    catalog: { catalogVersion, ingredientCount: ingredients.length, familyCount: families.length, categoryCount: categories.length },
    equivalenceTemplate: { templateId, revisionId: '1', referenceFamilyId: templateRevision.referenceFamilyId },
    dietStructure: { structureId: 'struttura-base', revisionId: '1', summary }
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { buildSeedData, SEED_TEMPLATE, SEED_DIET_PLAN };
