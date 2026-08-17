// Configurazione dell'interfaccia. Le ricette, gli ingredienti e il piano
// settimanale NON sono presenti nel codice: vengono caricati da Firebase.
const CATALOG_SCHEMA_VERSION = 4;
const DOMAIN_SCHEMA_VERSION = 4;

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

// Manuale e alternative alimentari consegnate da Meller. Sono contenuti
// informativi dell'interfaccia, non ricette.
const MELLER_GUIDE = {
  structure: [
    "Giorno di allenamento: dieta bilanciata e più ricca di carboidrati. Crackers nello spuntino mattutino e quota carboidrati maggiore a pranzo.",
    "Giorno di riposo: pasti bilanciati, quota carboidrati ridotta a pranzo e niente crackers nello spuntino mattutino.",
    "Preferire fonti di carboidrati non integrali prima e dopo un allenamento e nel carico; scelta libera negli altri momenti."
  ],
  trainingDay: {
    title: "1° giorno · Allenamento",
    macro: "1903 kcal · PRO 135g (28%) · FAT 55g (26%) · CHO 213g (44%)",
    meals: [
      { title: "Colazione", lines: ["Avena 40g, yogurt greco 0% 100g, marmellata 15g", "Alt. 1: kefir 100g oppure uova intere 60g; miele 10g", "Alt. 2, pancake albume: albume 120g, yogurt 40g, avena 40g, marmellata 30g", "Alt. 3: yogurt 200g, cereali 50g, marmellata 10g", "Alt. 4: latte parzialmente scremato 250g, cereali 50g"] },
      { title: "Spuntino mattina", lines: ["Frutta fresca 250g, crackers 30g, proteine 30g"] },
      { title: "Pranzo", lines: ["Pasta/riso 90g (alternative: gnocchi 250g, farro 90g, quinoa 80g, pane 120g, patate 450g)", "Pollame 200g (alternative: manzo 150g, maiale 100g, merluzzo 250g, uova 180g)", "Verdura 200g", "Olio EVO 10g"] },
      { title: "Merenda", lines: ["Opzione 1: yogurt greco 0% 150g + miele/sciroppo d'acero 15g oppure marmellata 20g", "Opzione 2: crackers 30g oppure frutta secca oleosa 20g"] },
      { title: "Cena", lines: ["Pollame 200g (alternative: manzo 150g, pesce 250g, legumi 240g)", "Pane 60g (alternative: crackers 40g, patate 230g)", "Verdura 200g", "Olio EVO 10g"] }
    ]
  },
  restDay: {
    title: "2° giorno · Riposo",
    macro: "1719 kcal · PRO 130g (30%) · FAT 52g (27%) · CHO 180g (42%)",
    meals: [
      { title: "Colazione", lines: ["Avena 40g, yogurt greco 0% 100g, marmellata 15g", "Per le alternative vedere il giorno di allenamento e il ricettario colazioni."] },
      { title: "Spuntino mattina", lines: ["Frutta fresca 250g, proteine 30g; niente crackers"] },
      { title: "Pranzo", lines: ["Pasta/riso 70g (alternative: gnocchi 190g, farro 70g, quinoa 60g, pane 90g, patate 350g)", "Pollame 200g", "Verdura 200g", "Olio EVO 10g"] },
      { title: "Merenda", lines: ["Opzione 1: yogurt greco 0% 150g + miele/sciroppo d'acero 15g oppure marmellata 20g", "Opzione 2: crackers 30g oppure frutta secca oleosa 20g"] },
      { title: "Cena", lines: ["Pollame 200g", "Pane 60g (alternative: crackers 40g, patate 230g)", "Verdura 200g", "Olio EVO 10g"] }
    ]
  },
  alternatives: {
    carbohydrates: {
      title: "Carboidrati · riferimento Pasta/Riso 70g",
      rows: [
        ["Gnocchi di patate", "190g"],
        ["Farro, Orzo", "70g"],
        ["Quinoa, Grano Saraceno, Amaranto", "60g"],
        ["Pane", "90g"],
        ["Piadina", "80g"],
        ["Crackers, Grissini, Crostini", "60g"],
        ["Polenta cotta", "340g"],
        ["Patate", "350g"]
      ]
    },
    proteins: {
      title: "Proteine · riferimento Pollame 200g",
      rows: [
        ["Manzo, tagli magri", "150g"],
        ["Maiale, tagli magri / Affettati sgrassati", "100g"],
        ["Crostacei, Molluschi", "300g"],
        ["Merluzzo / Nasello / Sogliola", "250g"],
        ["Pesce in scatola al naturale", "150g"],
        ["Pesce in scatola sott'olio / Salmone / Sgombro", "100g"],
        ["Fiocchi di latte / Uova intere", "180g"],
        ["Montasio / Grana", "50g"],
        ["Legumi in scatola o bolliti", "240g"],
        ["Legumotti Barilla", "80g"]
      ]
    }
  },
  proteinFrequencies: [
    ["Pollame", "1-2 volte a settimana"],
    ["Manzo, maiale, affettati", "Max 1 volta a settimana"],
    ["Pesce ricco di omega-3", "Almeno 2-3 volte a settimana"],
    ["Altro pesce e prodotti ittici", "1-2 volte a settimana"],
    ["Latticini e uova a pranzo/cena", "1-2 volte a settimana"],
    ["Legumi e derivati", "Almeno 3-4 volte a settimana"]
  ],
  integration: [
    "Creatp Syform: 7g al giorno con acqua dopo colazione.",
    "Optiwhey Syform: seguendo lo schema della dieta.",
    "Sconto 20% su syform.com con codice AD20MTML."
  ],
  faq: [
    "Punta a un consumo di almeno 2-2,5 litri di acqua al giorno.",
    "Usa solo sale iodato. Spezie, limone e aceto sono liberi.",
    "È disponibile un pasto sociale a settimana.",
    "Puoi combinare due alternative proteiche dimezzandone le quantità.",
    "Non serve pesare la verdura.",
    "Le opzioni sono intercambiabili: non è necessario seguire uno schema rigido.",
    "I pesi si riferiscono agli alimenti a crudo.",
    "Quando mangi fuori scegli carboidrati non conditi, proteine magre e verdure scondite alla griglia o al vapore."
  ]
};
