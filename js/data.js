// Configurazione dell'interfaccia. Le ricette, gli ingredienti e il piano
// settimanale NON sono presenti nel codice: vengono caricati da Firebase.
// Versione allineata a js/domain.js VERSION 7 (catalogo v2 + dosi allineate).
const CATALOG_SCHEMA_VERSION = 7;
const DOMAIN_SCHEMA_VERSION = 7;

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
    // Scelta unica del cliente: dosi originali delle ricette o dosi allineate
    // alla struttura dieta assegnata (solo visualizzazione, mai riscritture).
    alignedDosesEnabled: true
  };
}
