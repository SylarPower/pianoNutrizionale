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
    batchTemplates: []
  };
}

// Manuale e alternative alimentari consegnate da Meller. Fonte unica:
// js/domain.js (MELLER_GRAMMATURE e derivati). Qui c'è solo il riferimento.
const MELLER_GUIDE = PianoDomain.MELLER_GUIDE;
