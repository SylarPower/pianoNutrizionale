// Configurazione dell'interfaccia. Le ricette, gli ingredienti e il piano
// settimanale NON sono presenti nel codice: vengono caricati da Firebase.
const CATALOG_SCHEMA_VERSION = 5;
const DOMAIN_SCHEMA_VERSION = 5;

function createEmptyWeeklyPlan() {
  const types = {
    monday: "training", tuesday: "rest", wednesday: "training", thursday: "rest",
    friday: "training", saturday: "rest", sunday: "training"
  };
  const days = {};
  Object.entries(types).forEach(([day, type]) => {
    days[day] = { type, breakfast: null, snack1: null, lunch: null, snack2: null, dinner: null };
  });
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    days,
    defaultDays: JSON.parse(JSON.stringify(days)),
    batchRules: {},
    batchTemplates: [],
    guideModes: PianoDomain.emptyGuideModes(),
    guideAdaptations: {}
  };
}

// Linee guida e alternative alimentari del nutrizionista. Fonte unica:
// js/domain.js (GUIDE_GRAMMATURE e derivati). Qui c'è solo il riferimento.
const GUIDE_MANUAL = PianoDomain.GUIDE_MANUAL;
