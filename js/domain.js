/* Piano Nutrizionale — dominio puro (schema 5).
 *
 * Questo file contiene SOLO funzioni pure: nessun DOM, nessuna chiamata
 * Firebase, nessuna ricetta personale. I dati personali arrivano da Firestore
 * e vengono trasformati da questi servizi in modo idempotente.
 *
 * È inoltre la FONTE UNICA delle grammature di riferimento del manuale del
 * dott. Meller (MELLER_GRAMMATURE, frequenze proteiche, massimi per porzione):
 * da qui derivano i vincoli del generatore, il riferimento carboidrati, la
 * guida mostrata nella webapp e il prompt della ricerca ricette online. Sono
 * valori di riferimento del manuale, mai dosaggi di ricette personali.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PianoDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, () => {
  'use strict';

  const VERSION = 5;
  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const SLOTS = ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'];
  const EMPTY_PORTION = '—';

  const DAY_LABELS = {
    monday: 'Lunedì', tuesday: 'Martedì', wednesday: 'Mercoledì', thursday: 'Giovedì',
    friday: 'Venerdì', saturday: 'Sabato', sunday: 'Domenica'
  };
  const DAY_SHORT = { monday: 'Lun', tuesday: 'Mar', wednesday: 'Mer', thursday: 'Gio', friday: 'Ven', saturday: 'Sab', sunday: 'Dom' };
  const SLOT_LABELS = { breakfast: 'Colazione', snack1: 'Spuntino mattina', lunch: 'Pranzo', snack2: 'Merenda', dinner: 'Cena' };
  const SLOT_SHORT = { breakfast: 'COLAZ.', snack1: 'SPUNT.', lunch: 'PRANZO', snack2: 'MERENDA', dinner: 'CENA' };

  // Alias comuni normalizzati verso ingredientId stabili. Estendibile.
  const INGREDIENT_ALIASES = {
    'uovo intero': 'whole-eggs',
    'uova intere': 'whole-eggs',
    'uova intere sode': 'whole-eggs',
    'uova intere barzotte': 'whole-eggs',
    'pomodorini': 'cherry-tomatoes',
    'pomodoro ciliegino': 'cherry-tomatoes',
    'salmone': 'salmon',
    'tonno': 'tuna',
    'tonno al naturale sgocciolato': 'tuna',
    'tonno al naturale': 'tuna',
    'yogurt greco': 'greek-yogurt',
    'yogurt greco 0%': 'greek-yogurt',
    'yogurt greco magro o skyr': 'greek-yogurt',
    'pane': 'bread',
    'pane integrale': 'bread',
    'pane di segale': 'bread',
    'pane integrale o di segale': 'bread',
    'pane tostato': 'bread',
    'limone': 'lemon',
    'zucchina': 'zucchini',
    'zucchine': 'zucchini'
  };

  // Etichette canoniche (solo visualizzazione; `name` resta l'etichetta).
  const CANONICAL_INGREDIENTS = {
    'whole-eggs': 'Uova intere',
    'cherry-tomatoes': 'Pomodorini',
    'salmon': 'Salmone',
    'tuna': 'Tonno',
    'greek-yogurt': 'Yogurt greco',
    'bread': 'Pane',
    'lemon': 'Limone',
    'zucchini': 'Zucchine'
  };

  // =====================================================================
  // Manuale del dott. Meller — FONTE UNICA
  //
  // Tutti i valori alimentari del manuale vivono qui: grammature per pasto e
  // giorno A/R, frequenze proteiche settimanali e massimi per porzione. Da
  // questa tabella derivano i vincoli del generatore (DEFAULT_CONSTRAINTS), il
  // riferimento carboidrati (CARB_REFERENCE), le tabelle di alternative della
  // guida (MELLER_GUIDE) e il prompt del Worker di ricerca ricette.
  // Modifica SOLO qui: gli altri file leggono da PianoDomain.
  //
  // L'ordine delle regole conta: la prima che combacia con il nome
  // dell'ingrediente vince (es. "fiocchi di latte" prima di "formaggi").
  // =====================================================================

  const MELLER_GRAMMATURE = [
    // Carboidrati
    // Cena = floor(pranzo RIPOSO * 2/3 / 10) * 10, uguale in A e R.
    // Verifica Meller: pane 90→60, crackers 60→40, patate 350→230,
    // polenta 340→220, piadina 80→50, pasta/riso 70→40.
    // Questi sono valori cena derivati (gnocchi 120, farro/orzo 40,
    // pseudo 40, couscous 40); le inverse cena→pranzo non si calcolano:
    // si rileggono pranzo A/R dalla tabella, perché il floor non è invertibile
    // (230*2=460, mentre il valore reale è 450).
    { family: 'avena', label: 'Avena', match: /avena|porridge|oatmeal/, slots: { breakfast: { training: 40, rest: 40 } } },
    { family: 'cereali', label: 'Cereali', match: /corn flakes|muesli|granola|cereali|fiocchi(?!\s+di\s+latte)/, slots: { breakfast: { training: 50, rest: 50 } } },
    { family: 'gnocchi', label: 'Gnocchi', match: /gnocch/, slots: { lunch: { training: 250, rest: 190 }, dinner: { training: 120, rest: 120 } } },
    { family: 'polenta', label: 'Polenta', match: /polenta/, slots: { lunch: { training: 430, rest: 340 }, dinner: { training: 220, rest: 220 } } },
    { family: 'piadina', label: 'Piadina', match: /piadina|tortilla/, slots: { lunch: { training: 110, rest: 80 }, dinner: { training: 50, rest: 50 } } },
    { family: 'pseudo', label: 'Quinoa/Grano saraceno/Amaranto', match: /quinoa|grano saraceno|amaranto/, slots: { lunch: { training: 80, rest: 60 }, dinner: { training: 40, rest: 40 } } },
    { family: 'couscous', label: 'Cous cous', match: /cous.?cous/, slots: { lunch: { training: 80, rest: 60 }, dinner: { training: 40, rest: 40 } } },
    { family: 'farroorzo', label: 'Farro/Orzo', match: /\b(farro|orzo)\b/, slots: { lunch: { training: 90, rest: 70 }, dinner: { training: 40, rest: 40 } } },
    { family: 'pasta', label: 'Pasta', match: /pasta|spaghetti|penne|rigatoni|linguine|tagliatelle|lasagne|trofie|fusilli/, slots: { lunch: { training: 90, rest: 70 }, dinner: { training: 40, rest: 40 } } },
    { family: 'riso', label: 'Riso', match: /\briso\b|risotto/, slots: { lunch: { training: 90, rest: 70 }, dinner: { training: 40, rest: 40 } } },
    { family: 'crackers', label: 'Crackers/Grissini/Crostini', match: /cracker|grissin|crostin/, slots: { snack1: { training: 30, rest: 30 }, snack2: { training: 30, rest: 30 }, lunch: { training: 70, rest: 60 }, dinner: { training: 40, rest: 40 } } },
    { family: 'patate', label: 'Patate', match: /patat/, slots: { lunch: { training: 450, rest: 350 }, dinner: { training: 230, rest: 230 } } },
    { family: 'pane', label: 'Pane', match: /\bpane\b|fette biscottate/, slots: { lunch: { training: 120, rest: 90 }, dinner: { training: 60, rest: 60 } } },
    // Proteine e latticini
    { family: 'pollame', label: 'Pollame', match: /pollo|tacchino|faraona|pollame/, slots: { lunch: { training: 200, rest: 200 }, dinner: { training: 200, rest: 200 } } },
    { family: 'manzo', label: 'Manzo/Vitello', match: /manzo|vitello|roastbeef|hamburger/, slots: { lunch: { training: 150, rest: 150 }, dinner: { training: 150, rest: 150 } } },
    { family: 'maiale', label: 'Maiale', match: /maiale|lonza|pork/, slots: { lunch: { training: 100, rest: 100 }, dinner: { training: 100, rest: 100 } } },
    { family: 'salumi', label: 'Affettati/Salumi', match: /affettat|prosciutto|salume|salumi|speck|bresaola|mortadella|salame|wurstel|salsiccia/, slots: { lunch: { training: 100, rest: 100 }, dinner: { training: 100, rest: 100 } } },
    { family: 'pesceOmega', label: 'Pesce azzurro/omega-3', match: /salmone|sgombro|sardine?|aringa|alice|acciug/, slots: { lunch: { training: 100, rest: 100 }, dinner: { training: 100, rest: 100 } } },
    { family: 'molluschi', label: 'Crostacei/Molluschi', match: /gamber|crostace|mollusch|calamar|polpo|seppi|cozze|vongole/, slots: { lunch: { training: 300, rest: 300 }, dinner: { training: 300, rest: 300 } } },
    { family: 'tonno', label: 'Tonno', match: /tonno/, slots: { lunch: { training: 150, rest: 150 }, dinner: { training: 150, rest: 150 } } },
    { family: 'pesceBianco', label: 'Pesce', match: /merluzzo|nasello|sogliola|orata|branzino|spigola|trota|platessa|\bpesce\b/, slots: { lunch: { training: 250, rest: 250 }, dinner: { training: 250, rest: 250 } } },
    // I legumotti hanno una grammatura propria: la regola precede i legumi.
    { family: 'legumotti', label: 'Legumotti', match: /legumott/, slots: { lunch: { training: 80, rest: 80 }, dinner: { training: 80, rest: 80 } } },
    { family: 'legumi', label: 'Legumi', match: /legumi|ceci|lenticch|fagiol|pisell|soia|tofu|tempeh/, slots: { lunch: { training: 240, rest: 240 }, dinner: { training: 240, rest: 240 } } },
    { family: 'uova', label: 'Uova', match: /\buov|albume|tuorlo/, slots: { breakfast: { training: 60, rest: 60 }, lunch: { training: 180, rest: 180 }, dinner: { training: 180, rest: 180 } } },
    // I fiocchi di latte seguono le uova (180 g), non i formaggi stagionati.
    { family: 'fiocchiLatte', label: 'Fiocchi di latte', match: /fiocchi di latte/, slots: { lunch: { training: 180, rest: 180 }, dinner: { training: 180, rest: 180 } } },
    { family: 'formaggi', label: 'Formaggi', match: /formaggi|parmigiano|grana|pecorino|mozzarella|ricotta|stracchino|scamorza|feta|emmental|montasio|caprino|crescenza|robiola/, slots: { lunch: { training: 50, rest: 50 }, dinner: { training: 50, rest: 50 } } },
    { family: 'latte', label: 'Latte', match: /\blatte\b/, slots: { breakfast: { training: 250, rest: 250 } } },
    { family: 'yogurt', label: 'Yogurt/Kefir', match: /yogurt|kefir|skyr/, slots: { breakfast: { training: 100, rest: 100 }, snack2: { training: 150, rest: 150 } } },
    // Condimenti, dolcificanti e frutta
    { family: 'olio', label: 'Olio EVO', match: /olio|extravergine|evo\b/, slots: { lunch: { training: 10, rest: 10 }, dinner: { training: 10, rest: 10 } } },
    { family: 'miele', label: 'Miele/Sciroppo', match: /miele|sciroppo/, slots: { breakfast: { training: 10, rest: 10 }, snack2: { training: 15, rest: 15 } } },
    { family: 'marmellata', label: 'Marmellata', match: /marmellata|confettura|composta/, slots: { breakfast: { training: 15, rest: 15 }, snack2: { training: 20, rest: 20 } } },
    { family: 'fruttasecca', label: 'Frutta secca', match: /frutta secca|mandorle|noci|nocciole|arachidi|anacardi|pistacchi|pinoli|semi di|uvetta|datteri/, slots: { snack2: { training: 20, rest: 20 } } },
    { family: 'frutta', label: 'Frutta fresca', match: /frutta fresca|mela|mele|banana|pera|arancia|kiwi|fragol|pesca|albicocc|uva|mango|ananas|melone|anguria|cachi|cilieg|mirtill|lampon|macedonia|clementin|mandarin|prugn|susin/, slots: { snack1: { training: 250, rest: 250 }, snack2: { training: 250, rest: 250 } } }
  ];

  function mellerGrammatureFor(family) {
    return MELLER_GRAMMATURE.find(rule => rule.family === family) || null;
  }

  // Frequenze settimanali delle fonti proteiche (manuale Meller). `max: 14`
  // significa "almeno min volte"; `min: 0` significa "massimo max volte".
  const MELLER_PROTEIN_FREQUENCIES = [
    { key: 'poultry', label: 'Pollame', min: 1, max: 2 },
    { key: 'beef', label: 'Manzo e maiale', min: 0, max: 1 },
    { key: 'curedMeats', label: 'Affettati e carni miste', min: 0, max: 1 },
    { key: 'omega', label: 'Pesce ricco di omega-3 (salmone, sgombro, sardine, aringhe, alici/acciughe)', min: 2, max: 3 },
    { key: 'otherFish', label: 'Altro pesce e prodotti ittici', min: 1, max: 2 },
    { key: 'dairy', label: 'Latticini e formaggi', min: 1, max: 2 },
    { key: 'eggs', label: 'Uova', min: 1, max: 2 },
    { key: 'legumes', label: 'Legumi e derivati', min: 3, max: 14 }
  ];

  // Massimi per porzione (una persona) usati nel prompt della ricerca ricette.
  const MELLER_RECIPE_MAX_AMOUNTS = [
    { label: 'pollame', amount: '200 g' },
    { label: 'manzo', amount: '150 g' },
    { label: 'maiale', amount: '100 g' },
    { label: 'pesce', amount: '250 g' },
    { label: 'legumi', amount: '240 g' },
    { label: 'uova', amount: '180 g' },
    { label: 'pasta/riso', amount: '90 g' },
    { label: 'gnocchi', amount: '250 g' },
    { label: 'patate', amount: '450 g' },
    { label: 'pane', amount: '120 g' },
    { label: 'olio EVO', amount: '10 g' },
    { label: 'miele', amount: '20 g' },
    { label: 'marmellata', amount: '30 g' },
    { label: 'yogurt', amount: '200 g' },
    { label: 'latte', amount: '250 g' },
    { label: 'formaggi', amount: '60 g' },
    { label: 'crackers', amount: '40 g' },
    { label: 'frutta fresca', amount: '250 g' },
    { label: 'frutta secca', amount: '20 g' }
  ];

  // Massimi Meller in forma testuale per il prompt del Worker.
  function mellerGuidelinesText() {
    return MELLER_RECIPE_MAX_AMOUNTS.map(item => `${item.label} ${item.amount}`).join(', ');
  }

  // Struttura dei pasti in forma testuale per il prompt del Worker.
  function mellerMealStructureText() {
    return [
      'colazione: carboidrati (avena o cereali) + una quota proteica leggera (yogurt, latte o uova) + marmellata o miele',
      'spuntino mattina: frutta fresca con una quota proteica (crackers solo nel giorno di allenamento)',
      'pranzo: un carboidrato + una fonte proteica + verdura + olio EVO a crudo',
      'merenda: yogurt con miele o marmellata, oppure crackers o frutta secca',
      'cena: una fonte proteica + qualsiasi carboidrato in dose ridotta (circa 2/3 della dose del pranzo di riposo) + verdura + olio EVO a crudo'
    ].join('; ');
  }

  // Vincoli di default del generatore: derivano dalle frequenze proteiche.
  function buildDefaultConstraints() {
    const constraints = {};
    MELLER_PROTEIN_FREQUENCIES.forEach(item => {
      constraints[`${item.key}Min`] = item.min;
      constraints[`${item.key}Max`] = item.max;
    });
    return constraints;
  }

  const DEFAULT_CONSTRAINTS = buildDefaultConstraints();

  // Carboidrati riconosciuti per il travaso pranzo <-> cena. Derivano dalle
  // grammature: `match` e `label` possono essere specializzati e `dinner`
  // sovrascritto quando il manuale prevede una dose di cena diversa.
  // L'ordine conta: le voci più specifiche vengono prima (gnocchi di patate
  // prima di patate).
  const CARB_FAMILIES = [
    { key: 'gnocchi', family: 'gnocchi', label: 'Gnocchi di patate' },
    { key: 'polenta', family: 'polenta', label: 'Polenta cotta' },
    { key: 'piadina', family: 'piadina', label: 'Piadina', match: /piadina/ },
    { key: 'pseudo', family: 'pseudo', label: 'Quinoa/Grano saraceno/Amaranto' },
    { key: 'couscous', family: 'couscous', label: 'Cous cous' },
    { key: 'farroorzo', family: 'farroorzo', label: 'Farro/Orzo' },
    { key: 'trofie', family: 'pasta', label: 'Trofie', match: /\btrofie\b/ },
    { key: 'pasta', family: 'pasta', label: 'Pasta', match: /pasta/ },
    { key: 'riso', family: 'riso', label: 'Riso' },
    { key: 'crackers', family: 'crackers', label: 'Crackers/Grissini/Crostini' },
    { key: 'patate', family: 'patate', label: 'Patate' },
    { key: 'pane', family: 'pane', label: 'Pane', match: /\bpane\b/ }
  ];

  function buildCarbReference() {
    return CARB_FAMILIES.map(item => {
      const rule = mellerGrammatureFor(item.family);
      const lunch = rule?.slots?.lunch || null;
      const dinner = rule?.slots?.dinner || null;
      return {
        key: item.key,
        match: item.match || rule?.match,
        label: item.label || rule?.label || item.key,
        pranzo: lunch ? { ...lunch } : null,
        cena: dinner ? { ...dinner } : null
      };
    });
  }

  const CARB_REFERENCE = buildCarbReference();

  // ---------------------------------------------------------------------
  // Guida Meller mostrata nella webapp (js/data.js legge da qui).
  //
  // I testi di struttura, giornata tipo e FAQ sono contenuti narrativi del
  // manuale; le tabelle delle alternative e delle frequenze proteiche sono
  // DERIVATE da MELLER_GRAMMATURE e MELLER_PROTEIN_FREQUENCIES.
  //
  // NOTA: i testi narrativi (structure/trainingDay/restDay/faq) contengono
  // grammature illustrative scritte a mano: se cambi MELLER_GRAMMATURE vanno
  // riallineate manualmente qui sotto.
  // ---------------------------------------------------------------------

  // label = etichetta del manuale; family+day scelgono il valore in tabella.
  const MELLER_CARB_ALTERNATIVES = [
    { label: 'Pasta, Riso', family: 'pasta' },
    { label: 'Gnocchi di patate', family: 'gnocchi' },
    { label: 'Farro, Orzo', family: 'farroorzo' },
    { label: 'Quinoa, Grano Saraceno, Amaranto', family: 'pseudo' },
    { label: 'Cous cous', family: 'couscous' },
    { label: 'Pane', family: 'pane' },
    { label: 'Piadina', family: 'piadina' },
    { label: 'Crackers, Grissini, Crostini', family: 'crackers' },
    { label: 'Polenta cotta', family: 'polenta' },
    { label: 'Patate', family: 'patate' }
  ];

  const MELLER_PROTEIN_ALTERNATIVES = [
    { label: 'Manzo, tagli magri', family: 'manzo' },
    { label: 'Maiale, tagli magri', family: 'maiale' },
    { label: 'Affettati sgrassati / Salumi magri', family: 'salumi' },
    { label: 'Crostacei, Molluschi', family: 'molluschi' },
    { label: 'Merluzzo / Nasello / Sogliola', family: 'pesceBianco' },
    { label: 'Pesce in scatola al naturale', family: 'tonno' },
    { label: "Pesce in scatola sott'olio / Salmone / Sgombro", family: 'pesceOmega' },
    { label: 'Fiocchi di latte / Uova intere', family: 'fiocchiLatte' },
    { label: 'Uova intere', family: 'uova' },
    { label: 'Montasio / Grana', family: 'formaggi' },
    { label: 'Legumi in scatola o bolliti', family: 'legumi' },
    { label: 'Legumotti Barilla', family: 'legumotti' }
  ];

  function alternativeRows(entries, dayType, includeDinner = false) {
    return entries.map(entry => {
      const slots = mellerGrammatureFor(entry.family)?.slots || {};
      const lunch = slots.lunch?.[dayType];
      const dinner = slots.dinner?.rest;
      const row = [entry.label, Number.isFinite(lunch) ? `${lunch}g` : '—'];
      if (includeDinner) row.push(Number.isFinite(dinner) ? `${dinner}g` : '—');
      return row;
    });
  }

  function proteinFrequencyText(item) {
    if (item.max >= 14) return `Almeno ${item.min} volte a settimana`;
    if (item.min === 0) return `Massimo ${item.max} volta${item.max === 1 ? '' : 'e'} a settimana`;
    return `${item.min}-${item.max} volte a settimana`;
  }

  function buildMellerGuide() {
    const pastaRest = mellerGrammatureFor('pasta')?.slots?.lunch?.rest;
    const poultryTraining = mellerGrammatureFor('pollame')?.slots?.lunch?.training;
    return {
      structure: [
        'Giorno di allenamento: dieta bilanciata e più ricca di carboidrati. Crackers nello spuntino mattutino e quota carboidrati maggiore a pranzo.',
        'Giorno di riposo: pasti bilanciati, quota carboidrati ridotta a pranzo e niente crackers nello spuntino mattutino.',
        'Preferire fonti di carboidrati non integrali prima e dopo un allenamento e nel carico; scelta libera negli altri momenti.'
      ],
      trainingDay: {
        title: '1° giorno · Allenamento',
        macro: '1903 kcal · PRO 135g (28%) · FAT 55g (26%) · CHO 213g (44%)',
        meals: [
          { title: 'Colazione', lines: ['Avena 40g, yogurt greco 0% 100g, marmellata 15g', 'Alt. 1: kefir 100g oppure uova intere 60g; miele 10g', 'Alt. 2, pancake albume: albume 120g, yogurt 40g, avena 40g, marmellata 30g', 'Alt. 3: yogurt 200g, cereali 50g, marmellata 10g', 'Alt. 4: latte parzialmente scremato 250g, cereali 50g'] },
          { title: 'Spuntino mattina', lines: ['Frutta fresca 250g, crackers 30g, proteine 30g'] },
          { title: 'Pranzo', lines: ['Pasta/riso 90g (alternative: gnocchi 250g, farro 90g, quinoa 80g, pane 120g, patate 450g)', 'Pollame 200g (alternative: manzo 150g, maiale 100g, merluzzo 250g, uova 180g)', 'Verdura 200g', 'Olio EVO 10g'] },
          { title: 'Merenda', lines: ["Opzione 1: yogurt greco 0% 150g + miele/sciroppo d'acero 15g oppure marmellata 20g", 'Opzione 2: crackers 30g oppure frutta secca oleosa 20g'] },
          { title: 'Cena', lines: ['Pollame 200g (alternative: manzo 150g, pesce 250g, legumi 240g)', 'Pane 60g (alternative: crackers 40g, patate 230g, pasta/riso 40g, gnocchi 120g, farro/orzo 40g, quinoa 40g, cous cous 40g, piadina 50g, polenta 220g)', 'Verdura 200g', 'Olio EVO 10g'] }
        ]
      },
      restDay: {
        title: '2° giorno · Riposo',
        macro: '1719 kcal · PRO 130g (30%) · FAT 52g (27%) · CHO 180g (42%)',
        meals: [
          { title: 'Colazione', lines: ['Avena 40g, yogurt greco 0% 100g, marmellata 15g', 'Per le alternative vedere il giorno di allenamento e il ricettario colazioni.'] },
          { title: 'Spuntino mattina', lines: ['Frutta fresca 250g, proteine 30g; niente crackers'] },
          { title: 'Pranzo', lines: ['Pasta/riso 70g (alternative: gnocchi 190g, farro 70g, quinoa 60g, pane 90g, patate 350g)', 'Pollame 200g', 'Verdura 200g', 'Olio EVO 10g'] },
          { title: 'Merenda', lines: ["Opzione 1: yogurt greco 0% 150g + miele/sciroppo d'acero 15g oppure marmellata 20g", 'Opzione 2: crackers 30g oppure frutta secca oleosa 20g'] },
          { title: 'Cena', lines: ['Pollame 200g', 'Pane 60g (alternative: crackers 40g, patate 230g, pasta/riso 40g, gnocchi 120g, farro/orzo 40g, quinoa 40g, cous cous 40g, piadina 50g, polenta 220g)', 'Verdura 200g', 'Olio EVO 10g'] }
        ]
      },
      alternatives: {
        carbohydrates: {
          title: `Carboidrati · riferimento Pasta/Riso ${pastaRest}g a pranzo, ${mellerGrammatureFor('pasta')?.slots?.dinner?.rest}g a cena`,
          rows: alternativeRows(MELLER_CARB_ALTERNATIVES, 'rest', true)
        },
        proteins: {
          title: `Proteine · riferimento Pollame ${poultryTraining}g`,
          rows: alternativeRows(MELLER_PROTEIN_ALTERNATIVES, 'training')
        }
      },
      proteinFrequencies: MELLER_PROTEIN_FREQUENCIES.map(item => [item.label, proteinFrequencyText(item)]),
      faq: [
        'Punta a un consumo di almeno 2-2,5 litri di acqua al giorno.',
        'Usa solo sale iodato. Spezie, limone e aceto sono liberi.',
        'È disponibile un pasto sociale a settimana.',
        'Puoi combinare due alternative proteiche dimezzandone le quantità.',
        'Non serve pesare la verdura.',
        'Le opzioni sono intercambiabili: non è necessario seguire uno schema rigido.',
        'I pesi si riferiscono agli alimenti a crudo.',
        'Quando mangi fuori scegli carboidrati non conditi, proteine magre e verdure scondite alla griglia o al vapore.'
      ]
    };
  }

  const MELLER_GUIDE = buildMellerGuide();



  function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  // Normalizza un nome in una chiave confrontabile ("Uova intere (sode)" → "uova intere sode").
  function aliasKey(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[()]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function slug(value) {
    return aliasKey(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // ingredientId stabile: preferisce l'ID già presente, poi l'alias, poi lo slug.
  function ingredientIdFor(name, existing) {
    if (existing && typeof existing === 'string' && existing.trim()) return existing.trim();
    return INGREDIENT_ALIASES[aliasKey(name)] || slug(name) || 'ingredient';
  }

  function normalizePortions(p = {}) {
    return {
      ipoTraining: p.ipoTraining ?? p.ipo ?? EMPTY_PORTION,
      ipoRest: p.ipoRest ?? p.ipo ?? EMPTY_PORTION,
      manTraining: p.manTraining ?? p.training ?? EMPTY_PORTION,
      manRest: p.manRest ?? p.rest ?? p.training ?? EMPTY_PORTION
    };
  }

  // Migrazione idempotente di una singola ricetta allo schema corrente (5).
  // Schema 4 → 5: rimuove il campo legacy `frequency` (sostituito dalle
  // frequenze proteiche calcolate dal generatore sui pasti principali).
  function migrateRecipe(recipe) {
    if (!recipe || typeof recipe !== 'object') return recipe;
    const ingredients = (recipe.ingredients || []).map(ingredient => ({
      ...ingredient,
      ingredientId: ingredientIdFor(ingredient.name, ingredient.ingredientId),
      portions: normalizePortions(ingredient.portions)
    }));
    const { frequency, ...rest } = recipe;
    return { ...rest, ingredients };
  }

  // Migrazione idempotente del documento catalogo (schema 3/4 → 5).
  function migrateCatalog(doc = {}) {
    const recipes = (doc.recipes || []).map(migrateRecipe);
    return {
      ...doc,
      schemaVersion: VERSION,
      recipes,
      recipeCount: recipes.length,
      ingredientAliases: { ...INGREDIENT_ALIASES, ...(doc.ingredientAliases || {}) },
      canonicalIngredients: { ...CANONICAL_INGREDIENTS, ...(doc.canonicalIngredients || {}) }
    };
  }

  // Conversione delle vecchie batchRules testuali in batchTemplates strutturati.
  function migrateBatchRules(rules = {}) {
    if (Array.isArray(rules)) return rules;
    const entries = Object.entries(rules || {});
    if (!entries.length) return [];
    return entries.map(([day, rule]) => ({
      id: `legacy-${day}-${rule.dinner || 'dinner'}-${rule.nextLunch || 'lunch'}`,
      anchor: { slot: 'dinner', recipeId: rule.dinner },
      target: { slot: 'lunch', recipeId: rule.nextLunch, lookAheadDays: 1 },
      tasks: (rule.actions || []).map((label, index) => ({
        id: `legacy-${day}-${index}`,
        actionType: 'prepare',
        label: String(label).replace(/^\[.*?\]\s*/, ''),
        storage: {
          method: 'fridge',
          maxDays: 1,
          instructions: 'Durata prudenziale migrata: da validare per la sicurezza alimentare.'
        }
      })),
      legacyDay: day
    }));
  }

  // Migrazione idempotente del piano settimanale (aggiunge batchTemplates strutturati).
  function migratePlan(plan = {}) {
    const days = plan.days || {};
    let templates;
    if (Array.isArray(plan.batchTemplates) && plan.batchTemplates.length) {
      templates = plan.batchTemplates;
    } else if (plan.batchRules && Object.keys(plan.batchRules).length) {
      templates = migrateBatchRules(plan.batchRules);
    } else {
      templates = Array.isArray(plan.batchTemplates) ? plan.batchTemplates : [];
    }
    return {
      ...plan,
      schemaVersion: VERSION,
      days,
      defaultDays: plan.defaultDays || deepClone(days),
      batchRules: plan.batchRules || {},
      batchTemplates: templates
    };
  }

  function emptyDay(type = 'rest') {
    return { type, breakfast: null, snack1: null, lunch: null, snack2: null, dinner: null };
  }

  function emptyDays() {
    const days = {};
    DAYS.forEach(day => { days[day] = emptyDay(); });
    return days;
  }

  function emptyPlan() {
    return { schemaVersion: VERSION, days: emptyDays(), defaultDays: emptyDays(), batchRules: {}, batchTemplates: [] };
  }

  // ----- Batch cooking dinamico -----

  function dayDistance(from, to) {
    const a = DAYS.indexOf(from);
    const b = DAYS.indexOf(to);
    if (a < 0 || b < 0) return null;
    return (b - a + 7) % 7;
  }

  // Ricerca del prossimo giorno (anche domenica → lunedì) in cui il piano
  // contiene la ricetta target in uno slot. Settimana ricorrente.
  function futureTarget(day, plan, targetSlot, recipeId, maxDays = 7) {
    for (let n = 1; n <= maxDays; n++) {
      const d = DAYS[(DAYS.indexOf(day) + n) % 7];
      if (plan?.days?.[d]?.[targetSlot] === recipeId) return { day: d, days: n };
    }
    return null;
  }

  // Stato di una preparazione rispetto alla finestra di conservazione.
  // maxDays 0 = fresco, si prepara al momento; altrimenti "oggi" se la
  // conservazione copre i giorni fino al target, altrimenti "non ancora".
  function batchTaskStatus(task, daysUntilTarget) {
    const maxDays = task?.storage?.maxDays;
    const d = Number.isFinite(maxDays) ? maxDays : 0;
    if (d === 0) return 'fresh';
    if (daysUntilTarget <= d) return 'today';
    return 'later';
  }

function portionFor(ingredient, profile, dayType, slot, recipeSlot) {
  const p = normalizePortions(ingredient?.portions || {});
  const training = dayType === 'training';
  
  // Se è un carboidrato e la ricetta è di pranzo ma viene usata a cena
  // (o viceversa), applica la trasformazione percentuale
  if (slot && recipeSlot && isPranzoCenaCross(recipeSlot, slot)) {
    const adapted = crossSlotCarbPortions(ingredient, recipeSlot, slot);
    if (adapted) {
      if (profile === 'ipo') return training ? adapted.ipoTraining : adapted.ipoRest;
      if (profile === 'couple') {
        return {
          man: training ? adapted.manTraining : adapted.manRest,
          ipo: training ? adapted.ipoTraining : adapted.ipoRest
        };
      }
      return training ? adapted.manTraining : adapted.manRest;
    }
  }
  
  if (profile === 'ipo') return training ? p.ipoTraining : p.ipoRest;
  if (profile === 'couple') {
    return {
      man: training ? p.manTraining : p.manRest,
      ipo: training ? p.ipoTraining : p.ipoRest
    };
  }
  return training ? p.manTraining : p.manRest;
}

  function formatPortion(portion, profile) {
    if (profile === 'couple' && portion && typeof portion === 'object') {
      const man = portion.man === undefined || portion.man === null || portion.man === '' ? EMPTY_PORTION : portion.man;
      const ipo = portion.ipo === undefined || portion.ipo === null || portion.ipo === '' ? EMPTY_PORTION : portion.ipo;
      return `Uomo: ${man} · Donna IPO: ${ipo}`;
    }
    const value = portion ?? EMPTY_PORTION;
    return value === '' ? EMPTY_PORTION : value;
  }

  function quantityForTask(task, plan, recipesById, profile, targetDay) {
    const src = task?.quantitySource;
    if (!src?.ingredientId) return '';
    const recipe = recipesById?.[src.recipeId];
    const ingredient = (recipe?.ingredients || []).find(item =>
      (item.ingredientId || ingredientIdFor(item.name)) === src.ingredientId
    );
    if (!ingredient) return '';
    const dayType = plan?.days?.[targetDay]?.type || 'rest';
    return formatPortion(portionFor(ingredient, profile, dayType), profile);
  }

  // Batch attivi per il giorno: almeno una preparazione deve essere valida
  // (fresca o preparabile oggi). Il tipo A/R del giorno corrente non conta:
  // conta solo il tipo A/R del giorno target per le quantità.
  function activeBatch(anchorDay, plan, templates, recipesById = {}, profile = 'man', maxLookAhead = 7) {
    if (!plan?.days?.[anchorDay]) return [];
    const dinner = plan.days[anchorDay].dinner;
    const result = [];
    (templates || []).forEach(template => {
      if (!template?.anchor || template.anchor.recipeId !== dinner) return;
      const target = futureTarget(
        anchorDay, plan,
        template.target?.slot || 'lunch',
        template.target?.recipeId,
        template.target?.lookAheadDays || maxLookAhead
      );
      if (!target) return;
      const tasks = [];
      const seen = new Set();
      (template.tasks || []).forEach(task => {
        if (!task?.id || seen.has(task.id)) return;
        seen.add(task.id);
        tasks.push({
          ...task,
          status: batchTaskStatus(task, target.days),
          quantity: quantityForTask(task, plan, recipesById, profile, target.day)
        });
      });
      const validCount = tasks.filter(task => task.status === 'today' || task.status === 'fresh').length;
      result.push({
        template,
        targetDay: target.day,
        daysUntilTarget: target.days,
        tasks,
        validCount,
        active: validCount > 0
      });
    });
    return result.filter(batch => batch.active);
  }

  // Somma due stringhe-dose (es. "200g" + "200g" = "400g"). Per valori non
  // numerici (q.b., dosi opache) mostra entrambi separati da "+".
  function sumPortionStrings(a, b) {
    const pa = parseSimpleAmount(a);
    const pb = parseSimpleAmount(b);
    if (pa.skip && pb.skip) return EMPTY_PORTION;
    if (pa.free || pb.free) return 'q.b.';
    const fmt = (value, unit) => {
      const rounded = Math.round(value * 100) / 100;
      const num = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', ',');
      return unit === 'pz' ? `${num} pz` : `${num}${unit}`;
    };
    if (!pa.skip && !pb.skip && pa.value !== undefined && pb.value !== undefined) {
      if (pa.unit === pb.unit) return fmt(pa.value + pb.value, pa.unit);
      return `${fmt(pa.value, pa.unit)} + ${fmt(pb.value, pb.unit)}`;
    }
    if (pa.skip) return String(b ?? EMPTY_PORTION);
    if (pb.skip) return String(a ?? EMPTY_PORTION);
    const left = pa.opaque ?? (pa.value !== undefined ? fmt(pa.value, pa.unit) : EMPTY_PORTION);
    const right = pb.opaque ?? (pb.value !== undefined ? fmt(pb.value, pb.unit) : EMPTY_PORTION);
    return `${left} + ${right}`;
  }

  // Combina le dosi di cena e pranzo per un ingrediente, gestendo il profilo
  // Coppia (somma separata uomo/donna IPO).
  function combineTaskQuantities(cenaPortion, pranzoPortion, profile) {
    if (profile === 'couple') {
      const c = cenaPortion && typeof cenaPortion === 'object' ? cenaPortion : { man: cenaPortion, ipo: cenaPortion };
      const p = pranzoPortion && typeof pranzoPortion === 'object' ? pranzoPortion : { man: pranzoPortion, ipo: pranzoPortion };
      return { man: sumPortionStrings(c.man, p.man), ipo: sumPortionStrings(c.ipo, p.ipo) };
    }
    return sumPortionStrings(cenaPortion, pranzoPortion);
  }

  // Batch automatico "doppia porzione": quando la stessa ricetta è a cena oggi e
  // a pranzo in un giorno successivo (ora possibile anche col cross-slot), le
  // dosi da preparare sono la somma della porzione di cena + quella del pranzo
  // (carboidrati trasformati in percentuale). Attivo solo se il pranzo è al massimo a 1
  // giorno (conservazione in frigo); oltre non è sicuro e non viene suggerito.
  function commonRecipeBatch(anchorDay, plan, recipesById = {}, profile = 'man', options = {}) {
    const dinnerId = plan?.days?.[anchorDay]?.dinner;
    if (!dinnerId) return null;
    const recipe = recipesById?.[dinnerId];
    if (!recipe) return null;
    const target = futureTarget(anchorDay, plan, 'lunch', dinnerId, options.maxLookAhead || 3);
    if (!target) return null;
    const dinnerDayType = plan?.days?.[anchorDay]?.type || 'rest';
    const lunchDayType = plan?.days?.[target.day]?.type || 'rest';
    const storageMaxDays = 1;
    const tasks = (recipe.ingredients || []).map(ingredient => {
      const cenaAdapted = adaptIngredientForSlot(ingredient, recipe.slot, 'dinner');
      const cenaName = cenaAdapted ? cenaAdapted.name : ingredient.name;
      const cenaId = cenaAdapted ? cenaAdapted.ingredientId : (ingredient.ingredientId || slug(ingredient.name));
      const cenaIng = cenaAdapted ? { ...ingredient, portions: cenaAdapted.portions } : ingredient;
      const cenaPortion = portionFor(cenaIng, profile, dinnerDayType);
      const pranzoAdapted = adaptIngredientForSlot(ingredient, recipe.slot, 'lunch');
      const pranzoName = pranzoAdapted ? pranzoAdapted.name : ingredient.name;
      const pranzoId = pranzoAdapted ? pranzoAdapted.ingredientId : (ingredient.ingredientId || slug(ingredient.name));
      const pranzoIng = pranzoAdapted ? { ...ingredient, portions: pranzoAdapted.portions } : ingredient;
      const pranzoPortion = portionFor(pranzoIng, profile, lunchDayType);
      // Con la trasformazione percentuale il carboidrato resta lo stesso
      // ingrediente (es. pasta a pranzo -> 50% a cena): le dosi di cena e
      // pranzo si sommano senza creare voci parallele.
      const sameIngredient = cenaId === pranzoId;
      let quantityStr;
      if (sameIngredient) {
        quantityStr = formatPortion(combineTaskQuantities(cenaPortion, pranzoPortion, profile), profile);
      } else {
        quantityStr = `${formatPortion(cenaPortion, profile)} + ${formatPortion(pranzoPortion, profile)}`;
      }
      return {
        id: `common-${ingredient.ingredientId || slug(ingredient.name)}`,
        actionType: 'cook',
        label: sameIngredient ? cenaName : `${cenaName} + ${pranzoName}`,
        storage: { method: 'fridge', maxDays: storageMaxDays, instructions: 'Conserva in frigo la porzione per il pranzo.' },
        status: batchTaskStatus({ storage: { maxDays: storageMaxDays } }, target.days),
        quantity: quantityStr
      };
    }).filter(task => {
      const value = String(task.quantity ?? '').trim();
      return value && value !== EMPTY_PORTION;
    });
    const validCount = tasks.filter(task => task.status === 'today' || task.status === 'fresh').length;
    if (!validCount) return null;
    return {
      template: {
        id: `common-recipe-${dinnerId}`,
        title: `Doppia porzione · ${recipe.name}`,
        anchor: { slot: 'dinner', recipeId: dinnerId },
        target: { slot: 'lunch', recipeId: dinnerId }
      },
      targetDay: target.day,
      daysUntilTarget: target.days,
      tasks,
      validCount,
      active: true,
      commonRecipe: true
    };
  }

  // ----- Lista della spesa -----

  const CATEGORY_RULES = [
    { category: '🥩 Carne', terms: ['pollo', 'tacchino', 'vitello', 'manzo'] },
    { category: '🐟 Pesce', terms: ['salmone', 'sgombro', 'merluzzo', 'tonno', 'gamber', 'calamar', 'polpo'] },
    { category: '🥚 Uova e latticini', terms: ['uov', 'album', 'ricotta', 'mozzarella', 'caprino', 'feta', 'parmigiano', 'fiocchi di latte', 'yogurt', 'skyr', 'kefir', 'latte'] },
    // Prima di Legumi e Carboidrati: "farina…" (es. farina d'avena, farina di
    // ceci) e la passata di pomodoro sono prodotti di dispensa, non legumi,
    // carboidrati o verdura.
    { category: '🥫 Dispensa', terms: ['passata di pomodoro', 'passata', 'farina'] },
    { category: '🫘 Legumi', terms: ['ceci', 'lenticch', 'fagiol', 'edamame', 'piselli'] },
    { category: '🍚 Carboidrati', terms: ['pasta', 'riso', 'orzo', 'farro', 'quinoa', 'cous cous', 'pane', 'patate', 'polenta', 'cracker', 'trofie', 'avena', 'cereali', 'fette biscottate', 'wasa', 'granola'] },
    { category: '🍑 Frutta', terms: ['mela', 'banana', 'pera', 'arancia', 'mandarin', 'clementin', 'kiwi', 'uva', 'fragol', 'pesca', 'mango', 'anguria', 'melone', 'avocado', 'lampon', 'limone', 'lime', 'albicocc', 'cilieg', 'mirtill', 'ananas', 'papaya', 'pompelmo', 'prugn', 'susin', 'fico', 'cachi', 'ribes', 'mora', 'more', 'frutta fresca', 'frutti di bosco', 'macedonia'] },
    { category: '🥬 Verdura', terms: ['zucchin', 'pomodor', 'friggitell', 'peperon', 'melanzan', 'rucola', 'cetriolo', 'carota', 'fagiolini', 'spinacin', 'lattuga', 'songino', 'sedano', 'verdura', 'cipolla'] },
    { category: '🥫 Dispensa', terms: ['olio', 'olive', 'mandorle', 'noci', 'pistacchi', 'semi', 'pesto', 'capperi', 'brodo', 'salsa di soia', 'aceto', 'cacao', 'cioccolato', 'marmellata', 'confettura', 'miele', 'sciroppo', 'dolcificante', 'cocco', 'proteine whey'] }
  ];
  const FALLBACK_CATEGORY = '🌿 Spezie e aromi';

  function uniqueStrings(values = []) {
    const seen = new Set();
    return (Array.isArray(values) ? values : []).filter(value => {
      const clean = typeof value === 'string' ? value.trim() : '';
      if (!clean || seen.has(clean)) return false;
      seen.add(clean);
      return true;
    });
  }

  // Ordine configurabile delle categorie spesa: usa l'ordine salvato per le
  // categorie note, completa le eventuali mancanti col default e mette in coda
  // le categorie extra trovate nei dati (per robustezza futura).
  function resolveShopCategoryOrder(savedOrder = [], defaultOrder = [], extraCategories = []) {
    const defaults = uniqueStrings(defaultOrder);
    const defaultSet = new Set(defaults);
    const saved = uniqueStrings(savedOrder).filter(category => defaultSet.has(category));
    const resolved = saved.concat(defaults.filter(category => !saved.includes(category)));
    return resolved.concat(uniqueStrings(extraCategories).filter(category => !resolved.includes(category)));
  }

  // Ordine configurabile degli alimenti DENTRO una categoria della spesa:
  // usa l'ordine salvato (array di ingredientId) per gli id ancora presenti e
  // accoda in coda tutti gli id correnti non salvati, così un ingrediente
  // nuovo compare in coda senza rompere l'ordine esistente e nessun alimento
  // sparisce mai dalla lista. Gli id salvati non più presenti vengono ignorati.
  // Idempotente: risolvere di nuovo il risultato non cambia l'ordine.
  function resolveShopItemOrder(savedOrder = [], currentIds = []) {
    const current = uniqueStrings(currentIds);
    const currentSet = new Set(current);
    const saved = uniqueStrings(savedOrder).filter(id => currentSet.has(id));
    const savedSet = new Set(saved);
    return saved.concat(current.filter(id => !savedSet.has(id)));
  }

  function categoryForIngredient(name) {
    const value = aliasKey(name);
    const hit = CATEGORY_RULES.find(rule => rule.terms.some(term => value.includes(term)));
    return hit ? hit.category : FALLBACK_CATEGORY;
  }

  function isEmptyPortion(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return !normalized || normalized === '—' || normalized === '-';
  }

  function parseSimpleAmount(raw) {
    const original = String(raw ?? '').trim();
    if (isEmptyPortion(original) || /^0(?:[.,]0+)?\s*(g|ml)?$/i.test(original)) return { skip: true };
    if (/^(q\.?b\.?|liber[oaie]|a piacere)$/i.test(original)) return { free: true, label: original };
    const fractionMap = { '½': 0.5, '¼': 0.25, '¾': 0.75 };
    const match = original.match(/^(\d+(?:[.,]\d+)?|[½¼¾])(?:\s*[-–—]\s*(\d+(?:[.,]\d+)?|[½¼¾]))?\s*(g|ml|pz|cucchiaio|cucchiai|cucchiaino|cucchiaini)?$/i);
    if (!match) return { opaque: original };
    const numberValue = token => fractionMap[token] ?? Number(token.replace(',', '.'));
    // Per la spesa un intervallo usa prudenzialmente il valore massimo.
    let value = match[2] ? Math.max(numberValue(match[1]), numberValue(match[2])) : numberValue(match[1]);
    let unit = (match[3] || 'pz').toLowerCase();
    // Le misure da cucina vengono normalizzate in grammi per produrre una
    // quantità acquistabile e aggregabile in tutti i profili porzione.
    if (unit === 'cucchiaio' || unit === 'cucchiai') {
      value *= 10;
      unit = 'g';
    } else if (unit === 'cucchiaino' || unit === 'cucchiaini') {
      value *= 5;
      unit = 'g';
    }
    return { value, unit };
  }

  // ----- Trasformazione percentuale carboidrati pranzo <-> cena -----

  function carbSourceForName(name) {
    const value = aliasKey(name);
    if (!value) return null;
    return CARB_REFERENCE.find(source => source.match.test(value)) || null;
  }

  function isPranzoCenaCross(nativeSlot, assignedSlot) {
    return (nativeSlot === 'lunch' && assignedSlot === 'dinner') ||
      (nativeSlot === 'dinner' && assignedSlot === 'lunch');
  }

  // Arrotonda alla decina per eccesso (235 -> 240, 45 -> 50, 464 -> 470).
  function roundUpToTen(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.ceil(n / 10) * 10;
  }

  function carbAmountText(value, unit) {
    return unit === 'pz' ? `${value} pz` : `${value}${unit === 'ml' ? 'ml' : 'g'}`;
  }

  function parseCarbAmount(raw) {
    if (!raw) return null;
    const rawText = String(raw);
    const parsed = parseSimpleAmount(rawText);
    if (!parsed || parsed.skip || parsed.free || parsed.opaque || !Number.isFinite(parsed.value) || parsed.value <= 0) return null;
    // I carboidrati sono quasi sempre in grammi: un numero nudo (es. "250")
    // viene interpretato come grammi, non come "pz".
    const unit = /\bpz\b/.test(rawText.toLowerCase()) ? 'pz' : 'g';
    return { value: parsed.value, unit };
  }

  // Quantità di partenza dell'uomo in allenamento: prima la dose nativa della
  // ricetta, poi (solo se mancante o non numerica) il riferimento delle linee
  // guida per il pasto di origine.
  function carbBaseAmount(ingredient, source, nativeSlot) {
    const p = normalizePortions(ingredient?.portions || {});
    const native = parseCarbAmount(p.manTraining);
    if (native) return native;
    const amountObj = nativeSlot === 'lunch' ? source.pranzo : (source.cena || source.pranzo);
    if (amountObj && Number(amountObj.training) > 0) {
      return { value: Number(amountObj.training), unit: 'g' };
    }
    return null;
  }

  // Trasforma le porzioni di un carboidrato tra pranzo e cena. La cena usa
  // sempre la dose esplicita in MELLER_GRAMMATURE; il fallback per un alimento
  // non ancora censito conserva le proporzioni storiche (2/3 del pranzo R,
  // oppure 200%/150% per il ritorno), arrotondate alla decina per eccesso.
  function crossSlotCarbPortions(ingredient, nativeSlot, assignedSlot) {
    if (!ingredient || !isPranzoCenaCross(nativeSlot, assignedSlot)) return null;
    const source = carbSourceForName(ingredient.name);
    if (!source) return null;
    const base = carbBaseAmount(ingredient, source || { pranzo: null, cena: null }, nativeSlot);
    if (!base) return null;

    if (assignedSlot === 'dinner') {
      const value = source?.cena?.rest ?? Math.floor((source?.pranzo?.rest ?? base.value) * 2 / 3 / 10) * 10;
      if (!value) return null;
      const amount = carbAmountText(value, base.unit);
      return { ipoTraining: amount, ipoRest: amount, manTraining: amount, manRest: amount };
    }

    const trainingValue = source?.pranzo?.training ?? roundUpToTen(base.value * 2);
    const restValue = source?.pranzo?.rest ?? roundUpToTen(base.value * 1.5);
    if (!trainingValue || !restValue) return null;
    const training = carbAmountText(trainingValue, base.unit);
    const rest = carbAmountText(restValue, base.unit);
    return { ipoTraining: training, ipoRest: rest, manTraining: training, manRest: rest };
  }

  // Adatta un ingrediente carboidrato quando la sua ricetta viene collocata nel
  // pasto opposto (pranzo <-> cena). Restituisce { name, ingredientId, portions }
  // solo per i carboidrati da adattare, altrimenti null (ingrediente invariato).
  // Solo i carboidrati cambiano: proteine, uova, verdura e condimenti restano
  // uguali.
  function adaptIngredientForSlot(ingredient, nativeSlot, assignedSlot) {
    const portions = crossSlotCarbPortions(ingredient, nativeSlot, assignedSlot);
    if (!portions) return null;
    return {
      name: ingredient.name,
      ingredientId: ingredient.ingredientId || ingredientIdFor(ingredient.name),
      portions
    };
  }

  // Aggrega la lista della spesa per ingredientId. Le dosi "—" vengono saltate.
  // Nei pasti incrociati i carboidrati vengono trasformati in percentuale da
  // adaptIngredientForSlot (pranzo -> cena 50%, cena -> pranzo 200%).
  function aggregateShopping(plan, recipesById, selectedMeals, profile = 'man', canonicalLabels = {}, options = {}) {
    const out = {};
    DAYS.forEach(day => {
      const dayType = plan?.days?.[day]?.type || 'rest';
      (selectedMeals?.[day] || []).forEach(slot => {
        const recipe = recipesById?.[plan?.days?.[day]?.[slot]];
        if (!recipe) return;
        (recipe.ingredients || []).forEach(ingredient => {
          const adapted = adaptIngredientForSlot(ingredient, recipe.slot, slot);
          const effective = adapted
            ? { ...ingredient, name: adapted.name, ingredientId: adapted.ingredientId, portions: adapted.portions }
            : ingredient;
          const amount = portionFor(effective, profile, dayType);
          const entries = profile === 'couple' && amount && typeof amount === 'object'
            ? [{ role: 'Uomo', raw: amount.man }, { role: 'Donna IPO', raw: amount.ipo }]
            : [{ role: profile === 'ipo' ? 'Donna IPO' : 'Uomo', raw: amount }];
          const id = ingredientIdFor(effective.name, effective.ingredientId);
          const entry = out[id] || (out[id] = {
            ingredientId: id,
            name: canonicalLabels[id] || effective.name,
            category: categoryForIngredient(effective.name),
            totals: {},
            opaque: {},
            free: false,
            tags: []
          });
          const tag = `${DAY_SHORT[day]} · ${SLOT_SHORT[slot]}`;
          if (!entry.tags.includes(tag)) entry.tags.push(tag);
          entries.forEach(({ role, raw }) => {
            const parsed = parseSimpleAmount(raw);
            if (parsed.skip) return;
            if (parsed.free) { entry.free = true; return; }
            if (parsed.opaque) {
              const label = profile === 'couple' ? `${role}: ${parsed.opaque}` : parsed.opaque;
              entry.opaque[label] = (entry.opaque[label] || 0) + 1;
              return;
            }
            entry.totals[parsed.unit] = (entry.totals[parsed.unit] || 0) + parsed.value;
          });
        });
      });
    });
    return Object.values(out);
  }

  // ----- Copia e scambio pasti -----

  function swapMeals(plan, dayA, slotA, dayB, slotB) {
    if (slotA !== slotB) throw new Error('Slot non compatibili: lo scambio è consentito solo tra pasti dello stesso tipo');
    if (!plan?.days?.[dayA] || !plan?.days?.[dayB]) throw new Error('Giorno non valido');
    const next = deepClone(plan);
    [next.days[dayA][slotA], next.days[dayB][slotB]] = [next.days[dayB][slotB], next.days[dayA][slotA]];
    return next;
  }

  function copyMeal(plan, fromDay, slot, toDay) {
    if (!plan?.days?.[fromDay] || !plan?.days?.[toDay]) throw new Error('Giorno non valido');
    const next = deepClone(plan);
    next.days[toDay][slot] = next.days[fromDay][slot];
    return next;
  }

  function restoreMeal(plan, day, slot) {
    if (!plan?.days?.[day]) throw new Error('Giorno non valido');
    const next = deepClone(plan);
    next.days[day][slot] = next.defaultDays?.[day]?.[slot] ?? null;
    return next;
  }

  // ----- Import / merge -----

  function mergeRecipeCatalogs(current, incoming, rename = true) {
    const result = deepClone(current);
    const usedIds = new Set(result.map(recipe => recipe.id));
    let counter = 0;
    (incoming || []).forEach(source => {
      let recipe = migrateRecipe(source);
      if (usedIds.has(recipe.id)) {
        if (!rename) return;
        let nextId;
        do {
          counter += 1;
          nextId = `I${Date.now().toString(36)}${counter}`;
        } while (usedIds.has(nextId));
        recipe = { ...recipe, id: nextId, name: `${recipe.name} (importata)` };
      }
      usedIds.add(recipe.id);
      result.push(recipe);
    });
    return result.sort((a, b) => String(a.id).localeCompare(String(b.id), 'it', { numeric: true }));
  }

  function sanitizePlanForCatalog(plan, recipes) {
    const ids = new Set((recipes || []).map(recipe => recipe.id));
    const source = plan?.days ? plan : emptyPlan();
    const next = deepClone(source);
    DAYS.forEach(day => {
      if (!next.days?.[day]) next.days[day] = emptyDay();
      if (!next.defaultDays?.[day]) next.defaultDays[day] = emptyDay();
      SLOTS.forEach(slot => {
        if (!ids.has(next.days[day][slot])) next.days[day][slot] = null;
        if (!ids.has(next.defaultDays[day][slot])) next.defaultDays[day][slot] = null;
      });
    });
    next.schemaVersion = VERSION;
    return next;
  }

  function importedPlanIsUsable(plan, recipes) {
    if (!plan?.days) return false;
    const ids = new Set((recipes || []).map(recipe => recipe.id));
    // Gli slot vuoti (null) sono ammessi: solo i riferimenti presenti devono
    // puntare a ricette esistenti nel catalogo risultante.
    return DAYS.every(day => plan.days[day] && SLOTS.every(slot => {
      const recipeId = plan.days[day][slot];
      return !recipeId || ids.has(recipeId);
    }));
  }

  // ----- Condivisioni: analisi conflitti -----

  function recipeEquals(a, b) {
    const strip = recipe => ({
      id: recipe.id,
      name: recipe.name,
      slot: recipe.slot,
      ingredients: (recipe.ingredients || []).map(ingredient => ({
        name: ingredient.name,
        ingredientId: ingredient.ingredientId || ingredientIdFor(ingredient.name),
        portions: normalizePortions(ingredient.portions)
      })),
      steps: recipe.steps || []
    });
    return JSON.stringify(strip(migrateRecipe(a))) === JSON.stringify(strip(migrateRecipe(b)));
  }

  function analyzeShare(currentRecipes, incomingRecipes) {
    const currentById = Object.fromEntries((currentRecipes || []).map(recipe => [recipe.id, recipe]));
    const rawIncoming = incomingRecipes || [];
    const normalizedIncoming = rawIncoming.map(migrateRecipe);
    const analysis = {
      newRecipes: [],
      identical: [],
      conflicts: [],
      invalid: [],
      migratedIngredients: 0,
      missingIngredientIds: [],
      incoming: normalizedIncoming
    };
    normalizedIncoming.forEach((incoming, index) => {
      if (!incoming?.id || !incoming?.name) { analysis.invalid.push(incoming); return; }
      // Gli ingredienti senza ingredientId vengono rilevati sul dato originale
      // (prima della normalizzazione) e contati come "migrati".
      (rawIncoming[index]?.ingredients || []).forEach(ingredient => {
        if (!ingredient.ingredientId) {
          analysis.missingIngredientIds.push({ recipeId: incoming.id, name: ingredient.name });
          analysis.migratedIngredients += 1;
        }
      });
      const existing = currentById[incoming.id];
      if (!existing) { analysis.newRecipes.push(incoming); return; }
      if (recipeEquals(existing, incoming)) { analysis.identical.push(incoming); return; }
      analysis.conflicts.push({ existing: migrateRecipe(existing), incoming });
    });
    return analysis;
  }

  // Risolve i conflitti con la modalità scelta dall'utente:
  // 'mine' | 'theirs' | 'both' (quest'ultima salva entrambe con nuovo ID).
  function resolveRecipeConflicts(currentRecipes, incomingRecipes, conflictModes = {}) {
    const currentById = new Map((currentRecipes || []).map(recipe => [recipe.id, recipe]));
    const out = [];
    const usedIds = new Set(out.map(recipe => recipe.id));
    let counter = 0;
    const bumpId = () => {
      let nextId;
      do {
        counter += 1;
        nextId = `I${Date.now().toString(36)}${counter}`;
      } while (usedIds.has(nextId) || currentById.has(nextId));
      usedIds.add(nextId);
      return nextId;
    };
    const push = recipe => { usedIds.add(recipe.id); out.push(recipe); };
    (incomingRecipes || []).forEach(source => {
      const incoming = migrateRecipe(source);
      const mode = conflictModes[incoming.id] || 'theirs';
      const existing = currentById.get(incoming.id);
      if (existing && mode === 'mine') { push(existing); return; }
      if (existing && mode === 'both') {
        push(existing);
        push({ ...incoming, id: bumpId(), name: `${incoming.name} (ricevuta)` });
        return;
      }
      push(existing && mode === 'theirs' ? incoming : incoming);
    });
    return out.sort((a, b) => String(a.id).localeCompare(String(b.id), 'it', { numeric: true }));
  }

  // Slot del piano che diventerebbero vuoti rimuovendo le ricette indicate.
  function planSlotsForRecipeRemoval(plan, recipeIds) {
    const ids = new Set(recipeIds);
    const affected = [];
    DAYS.forEach(day => {
      SLOTS.forEach(slot => {
        const recipeId = plan?.days?.[day]?.[slot];
        if (ids.has(recipeId)) affected.push({ day, slot, recipeId });
      });
    });
    return affected;
  }

  function diffPlans(current, proposed) {
    const changes = [];
    DAYS.forEach(day => {
      const fromDay = current?.days?.[day];
      const toDay = proposed?.days?.[day];
      if (!toDay) return;
      if ((fromDay?.type || 'rest') !== (toDay.type || 'rest')) {
        changes.push({ day, field: 'type', from: fromDay?.type || 'rest', to: toDay.type || 'rest' });
      }
      SLOTS.forEach(slot => {
        const from = fromDay?.[slot];
        const to = toDay[slot];
        if (from !== to) changes.push({ day, slot, from, to });
      });
    });
    return changes;
  }

  // ----- Backup -----

  function buildBackup(catalog, plan, shopping, operation, description) {
    return {
      schemaVersion: VERSION,
      catalog: deepClone(catalog),
      plan: deepClone(plan),
      shoppingList: deepClone(shopping),
      operation,
      description,
      createdAt: new Date().toISOString()
    };
  }

  // ----- Generatore settimanale (funzioni pure, nessun DOM) -----

  // Categorie proteiche riconosciute dal generatore, con le chiavi min/max
  const PROTEIN_CATEGORIES = ['legumes', 'omega', 'otherFish', 'poultry', 'beef', 'curedMeats', 'dairy', 'eggs'];
const PROTEIN_CONSTRAINT_KEYS = {
  legumes: { min: 'legumesMin', max: 'legumesMax' },
  omega: { min: 'omegaMin', max: 'omegaMax' },
  otherFish: { min: 'otherFishMin', max: 'otherFishMax' },
  poultry: { min: 'poultryMin', max: 'poultryMax' },
  beef: { min: 'beefMin', max: 'beefMax' },
  curedMeats: { min: 'curedMeatsMin', max: 'curedMeatsMax' },
  dairy: { min: 'dairyMin', max: 'dairyMax' },
  eggs: { min: 'eggsMin', max: 'eggsMax' }
};
const PROTEIN_CATEGORY_LABELS = {
  legumes: 'Legumi e derivati',
  omega: 'Pesce ricco di omega-3',
  otherFish: 'Altro pesce e prodotti ittici',
  poultry: 'Pollame',
  beef: 'Manzo e maiale',
  curedMeats: 'Affettati e carni miste',
  dairy: 'Latticini e formaggi',
  eggs: 'Uova'
};

  // Le frequenze del generatore si basano prima sugli alimenti effettivi
  // della ricetta, nell'ordine in cui compaiono. `proteinCategory` resta un
  // fallback per ricette legacy o senza ingredienti riconoscibili.
  const PROTEIN_INGREDIENT_HINTS = [
    { category: 'omega', match: /salmone|sgombro|sardine?|aringa|alice|acciug/ },
    { category: 'otherFish', match: /merluzzo|nasello|sogliola|orata|branzino|spigola|tonno|calamar|polpo|seppi|spada|trota|platessa|cozze|vongole|gamber|crostace|mollusch|pesce/ },
{ category: 'poultry', match: /pollo|tacchin/ },
{ category: 'curedMeats', match: /affettat|prosciutto|bresaola|speck|salame|mortadella|wurstel|salsic|carne mista|carni miste|macinato misto/ },
{ category: 'beef', match: /manzo|vitello|maiale|suino|pork/ },
    { category: 'legumes', match: /ceci|lenticch|fagiol|edamame|pisell|tofu|tempeh|legumott/ },
    { category: 'dairy', match: /ricotta|mozzarella|caprino|crescenza|robiola|feta|montasio|parmigiano|grana|fiocchi di latte/ },
    { category: 'eggs', match: /\buov|albume/ }
  ];

  function inferProteinCategoryFromIngredients(recipe) {
    const ingredients = recipe?.ingredients || [];
    for (const ingredient of ingredients) {
      const name = aliasKey(ingredient?.name);
      if (!name) continue;
      const hit = PROTEIN_INGREDIENT_HINTS.find(hint => hint.match.test(name));
      if (hit) return hit.category;
    }
    return null;
  }

  function classifyProtein(recipe) {
    const inferred = inferProteinCategoryFromIngredients(recipe);
    if (inferred) return inferred;
    const raw = recipe?.proteinCategory;
    if (!raw) return null;
    const category = String(raw).trim();
    // Chiave tecnica diretta (poultry, beef, curedMeats, omega, ecc.): usata
    // così com'è quando appartiene all'insieme delle categorie riconosciute.
    if (PROTEIN_CATEGORIES.includes(category)) return category;
    const normalized = category.toLowerCase();
    if (/pollame/i.test(normalized)) return 'poultry';
    if (/affettati|affettato|prosciutto|bresaola|speck|salame|mortadella|wurstel|salsic|carni miste|carne mista/i.test(normalized)) return 'curedMeats';
    if (/manzo|vitello|maiale|suino|pork/i.test(normalized)) return 'beef';
    if (/omega-3/i.test(normalized)) return 'omega';
    if (/pesce|salmone|sgombro|tonno|merluzzo|mollusch|crostace/i.test(normalized)) return 'otherFish';
    if (/latticini|formaggi/i.test(normalized)) return 'dairy';
    if (/uova/i.test(normalized)) return 'eggs';
    if (/legumi/i.test(normalized)) return 'legumes';
    return null;
  }

  // Rileva se un catalogo contiene ricette con il campo legacy `frequency`
  // (schema < 5). Usato dall'app per decidere se salvare il catalogo migrato
  // una sola volta al caricamento.
  function catalogHasLegacyFrequency(recipes) {
    return Array.isArray(recipes) && recipes.some(recipe => recipe && Object.prototype.hasOwnProperty.call(recipe, 'frequency'));
  }

  function isFishRecipe(recipe) {
    const category = classifyProtein(recipe);
    return category === 'omega' || category === 'otherFish';
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function seededRandom(seed) {
    if (typeof seed === 'number' && Number.isFinite(seed)) return mulberry32(Math.floor(seed));
    return mulberry32(hashString(String(seed ?? Date.now())));
  }

  function shuffle(items, rand) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  // Genera una proposta di settimana "solida e ottimizzata": rispetta i tipi
  // A/R e i blocchi, insegue min E max delle frequenze proteiche, limita le
  // ripetizioni della stessa ricetta, distanzia gli omega-3 (mai in giorni
  // consecutivi, salvo le accoppiate cena → pranzo richieste con batchPairs,
  // dove l'adiacenza è intrinseca) e può programmare accoppiate cena →
  // pranzo per il batch cooking "doppia porzione". Non modifica mai i dosaggi.
  // Il risultato è riproducibile con lo stesso seed.
  //
  // Opzioni (tutte facoltative):
  //   plan            piano attuale (tipi A/R, blocchi batch, pasti mantenuti)
  //   seed            numero/stringa per la riproducibilità
  //   blocks          come prima: blocco singolo pasto o intera giornata
  //   constraints     min/max per categoria (uniti ai DEFAULT_CONSTRAINTS)
  //   templates       batchTemplates strutturali (bonus accoppiata anchor/target)
  //   batchPairs      n. di accoppiate cena → pranzo del giorno dopo (0-7)
  //   maxRepeats      apparizioni massime della stessa ricetta (default 2)
  //   allowCrossSlot  le ricette di pranzo/cena possono finire nell'altro pasto
  //                   (carboidrati trasformati in percentuale dal resto dell'app)
  //   slots           quali slot rigenerare: { breakfast, snack1, lunch, snack2, dinner }
  function generateWeek(catalog = [], options = {}) {
    const seedUsed = options.seed ?? Date.now();
    const rand = seededRandom(seedUsed);
    const currentPlan = options.plan && options.plan.days ? options.plan : emptyPlan();
    const blocks = options.blocks || {};
    const constraints = { ...DEFAULT_CONSTRAINTS, ...(options.constraints || {}) };
    const warnings = [];
    const recipes = (catalog || []).map(migrateRecipe);
    const recipesById = Object.fromEntries(recipes.map(recipe => [recipe.id, recipe]));

    const slotsEnabled = {
      breakfast: true, snack1: true, lunch: true, snack2: true, dinner: true,
      ...(options.slots || {})
    };
    const batchPairsWanted = Math.max(0, Math.min(7, Math.floor(Number(options.batchPairs) || 0)));
    const maxRepeats = Math.max(1, Math.min(7, Math.floor(Number(options.maxRepeats) || 2)));
    const allowCrossSlot = Boolean(options.allowCrossSlot);

    const minFor = category => {
      const key = PROTEIN_CONSTRAINT_KEYS[category]?.min;
      const value = key ? Number(constraints[key]) : 0;
      return Number.isFinite(value) ? Math.max(0, value) : 0;
    };
    const maxFor = category => {
      const key = PROTEIN_CONSTRAINT_KEYS[category]?.max;
      const value = key ? Number(constraints[key]) : NaN;
      return Number.isFinite(value) ? Math.max(minFor(category), value) : Infinity;
    };

    if (!recipes.length) warnings.push('Catalogo vuoto: nessuna settimana generabile.');
    else if (recipes.length < 14) warnings.push(`Catalogo ridotto (${recipes.length} ricette): potrebbe non essere possibile rispettare tutte le frequenze.`);

    const bySlot = {};
    SLOTS.forEach(slot => { bySlot[slot] = recipes.filter(recipe => recipe.slot === slot); });
    // Col cross-slot pranzo e cena pescano da entrambe le fonti: nel resto
    // dell'app i carboidrati vengono trasformati in percentuale.
    const poolFor = slot => {
      const base = bySlot[slot] || [];
      if (!allowCrossSlot || (slot !== 'lunch' && slot !== 'dinner')) return base;
      const opposite = bySlot[slot === 'lunch' ? 'dinner' : 'lunch'] || [];
      return base.concat(opposite);
    };

    const counts = { poultry: 0, beef: 0, curedMeats: 0, omega: 0, otherFish: 0, dairy: 0, eggs: 0, legumes: 0 };
    const fishToday = {};
    const omegaToday = {};
    const usage = {};
    const chosen = {};
    const pairs = [];

    const fishCountOn = day => (fishToday[day] || 0);
    const isFishy = recipe => {
      const category = classifyProtein(recipe);
      return category === 'omega' || category === 'otherFish';
    };
    const nextDayOf = day => DAYS[(DAYS.indexOf(day) + 1) % 7];
    const prevDayOf = day => DAYS[(DAYS.indexOf(day) + 6) % 7];

    // Registra un pasto confermato: conta nel totale settimanale della sua
    // categoria, nel limite "massimo un pesce al giorno" e nelle ripetizioni.
    const registerMeal = (day, slot, recipe) => {
      if (!recipe) return;
      usage[recipe.id] = (usage[recipe.id] || 0) + 1;
      if (slot !== 'lunch' && slot !== 'dinner') return;
      const category = classifyProtein(recipe);
      if (category && counts[category] !== undefined) counts[category] += 1;
      if (isFishy(recipe)) fishToday[day] = fishCountOn(day) + 1;
      if (category === 'omega') omegaToday[day] = (omegaToday[day] || 0) + 1;
    };
    const unregisterMeal = (day, slot, recipe) => {
      if (!recipe) return;
      usage[recipe.id] = Math.max(0, (usage[recipe.id] || 0) - 1);
      if (slot !== 'lunch' && slot !== 'dinner') return;
      const category = classifyProtein(recipe);
      if (category && counts[category] !== undefined) counts[category] = Math.max(0, counts[category] - 1);
      if (isFishy(recipe)) fishToday[day] = Math.max(0, fishCountOn(day) - 1);
      if (category === 'omega') omegaToday[day] = Math.max(0, (omegaToday[day] || 0) - 1);
    };

    const isBlocked = (day, slot) => {
      const block = blocks[day];
      if (!block) return false;
      if (block === 'all' || block.all) return true;
      return Boolean(block[slot]);
    };

    // Stato iniziale: pasti bloccati e slot esclusi dalla generazione restano
    // come sono e — fondamentale — entrano nei conteggi. Così il totale
    // settimanale (pesce/giorno compreso) riflette il piano finale completo.
    DAYS.forEach(day => {
      chosen[day] = {};
      SLOTS.forEach(slot => {
        if (isBlocked(day, slot)) {
          const block = blocks[day];
          const explicit = block === 'all' || block.all ? null : block[slot];
          const value = typeof explicit === 'string' && explicit ? explicit : (currentPlan.days?.[day]?.[slot] ?? null);
          chosen[day][slot] = value;
          if (recipesById[value]) registerMeal(day, slot, recipesById[value]);
        } else if (!slotsEnabled[slot]) {
          const value = currentPlan.days?.[day]?.[slot] ?? null;
          chosen[day][slot] = value;
          if (recipesById[value]) registerMeal(day, slot, recipesById[value]);
        }
      });
    });

    const freeSlot = (day, slot) => chosen[day][slot] === undefined;
    // Il pasto del giorno prima nello stesso slot (contro le ripetizioni
    // ravvicinate): preferisce le scelte già decise, ripiega sul piano attuale.
    const previousSlotValue = (day, slot) => {
      const prev = prevDayOf(day);
      return chosen[prev]?.[slot] ?? currentPlan.days?.[prev]?.[slot] ?? null;
    };

    const relaxedSlots = new Set();
    const warnRelaxed = (day, slot) => {
      const key = `${day}-${slot}`;
      if (relaxedSlots.has(key)) return;
      relaxedSlots.add(key);
      warnings.push(`Vincoli rilassati per ${DAY_LABELS[day]} ${SLOT_LABELS[slot]}: alcune frequenze o ripetizioni potrebbero non essere rispettate.`);
    };

    // Bonus accoppiate dei batchTemplates strutturali (cena anchor, pranzo
    // target entro lookAheadDays): premia chiudere la combinazione con un
    // pasto già deciso, in entrambe le direzioni temporali.
    const templates = (options.templates && Array.isArray(options.templates) ? options.templates : currentPlan.batchTemplates || []).slice();
    const anchorTemplates = {};
    const targetTemplates = {};
    templates.forEach(template => {
      const anchorId = template?.anchor?.recipeId;
      const targetId = template?.target?.recipeId;
      if (anchorId) (anchorTemplates[anchorId] ||= []).push(template);
      if (targetId) (targetTemplates[targetId] ||= []).push(template);
    });
    const templatePairBonus = (candidate, day, slot) => {
      if (slot === 'dinner' && anchorTemplates[candidate.id]) {
        for (const template of anchorTemplates[candidate.id]) {
          const look = template.target?.lookAheadDays || 3;
          for (let n = 1; n <= look; n++) {
            const futureDay = DAYS[(DAYS.indexOf(day) + n) % 7];
            if ((chosen[futureDay]?.lunch ?? currentPlan.days?.[futureDay]?.lunch) === template.target?.recipeId) return 1;
          }
        }
      }
      if (slot === 'lunch' && targetTemplates[candidate.id]) {
        for (const template of targetTemplates[candidate.id]) {
          const look = template.target?.lookAheadDays || 3;
          for (let n = 1; n <= look; n++) {
            const anchorDay = DAYS[(DAYS.indexOf(day) - n + 7) % 7];
            if ((chosen[anchorDay]?.dinner ?? currentPlan.days?.[anchorDay]?.dinner) === template.anchor?.recipeId) return 1;
          }
        }
      }
      return 0;
    };

    // --- Passo 1: batch "doppia porzione" (cena di oggi = pranzo di domani) ---
    // Le accoppiate vengono pianificate PER PRIME: occupano posti nel piano e
    // contano per intero nelle frequenze (il pasto si consuma due volte).
    const pairPool = () => {
      const pool = allowCrossSlot
        ? recipes.filter(recipe => recipe.slot === 'lunch' || recipe.slot === 'dinner')
        : (bySlot.dinner || []);
      // Nessuna cena nativa disponibile: ripiega sulle ricette di pranzo
      // (col cross-slot i carboidrati vengono comunque trasformati in percentuale).
      return pool.length ? pool : recipes.filter(recipe => recipe.slot === 'lunch' || recipe.slot === 'dinner');
    };
    const pairCandidateOk = (recipe, anchorDay, targetDay) => {
      const category = classifyProtein(recipe);
      // La stessa ricetta occupa due posti: deve starci nei suoi tetti.
      if ((usage[recipe.id] || 0) + 2 > maxRepeats) return false;
      if (category && counts[category] + 2 > maxFor(category)) return false;
      if (isFishy(recipe) && (fishCountOn(anchorDay) >= 1 || fishCountOn(targetDay) >= 1)) return false;
      // Un'accoppiata omega cena → pranzo è adiacente a se stessa per
      // costruzione (è ciò che l'utente ha chiesto), ma non deve mai toccare
      // ALTRI giorni omega: niente catene di omega-3 consecutivi.
      if (category === 'omega' && (omegaToday[prevDayOf(anchorDay)] || omegaToday[nextDayOf(targetDay)])) return false;
      // Niente stessa ricetta già affiancata (pranzo/cena dello stesso giorno o il giorno prima).
      if (chosen[anchorDay]?.lunch === recipe.id || previousSlotValue(anchorDay, 'dinner') === recipe.id) return false;
      if (chosen[targetDay]?.dinner === recipe.id || previousSlotValue(targetDay, 'lunch') === recipe.id) return false;
      return true;
    };
    const pairScore = (recipe, anchorDay, targetDay) => {
      const category = classifyProtein(recipe);
      let score = rand() * 2;
      if (category && counts[category] < minFor(category)) score += 7;
      if (!category) score -= 1;
      score -= (usage[recipe.id] || 0) * 3;
      return score;
    };
    const pairDays = shuffle(
      DAYS.filter(day => freeSlot(day, 'dinner') && freeSlot(nextDayOf(day), 'lunch')),
      rand
    );
    pairDays.forEach(anchorDay => {
      if (pairs.length >= batchPairsWanted) return;
      const targetDay = nextDayOf(anchorDay);
      const candidates = pairPool().filter(recipe => pairCandidateOk(recipe, anchorDay, targetDay));
      if (!candidates.length) return;
      const best = candidates
        .map(recipe => ({ recipe, score: pairScore(recipe, anchorDay, targetDay) }))
        .sort((a, b) => b.score - a.score)[0].recipe;
      chosen[anchorDay].dinner = best.id;
      chosen[targetDay].lunch = best.id;
      registerMeal(anchorDay, 'dinner', best);
      registerMeal(targetDay, 'lunch', best);
      pairs.push({ anchorDay, targetDay, recipeId: best.id });
    });
    // Avvisa solo se gli slot necessari alle coppie erano effettivamente
    // generabili (pranzo e cena abilitati): altrimenti l'utente li ha esclusi
    // volontariamente e la mancanza non è un problema.
    if (batchPairsWanted > pairs.length && slotsEnabled.lunch && slotsEnabled.dinner) {
      warnings.push(`Batch cena → pranzo: programmate ${pairs.length} accoppiate su ${batchPairsWanted} richieste (giorni liberi o ricette adatte insufficienti).`);
    }

    // --- Passo 2: riempimento principale di pranzi e cene ---
    // Vincoli duri: tetto settimanale per categoria, massimo un pesce al
    // giorno, tetto ripetizioni, omega-3 mai in giorni consecutivi. Se il pool
    // si svuota si rilassano a gradini (con un unico avviso per pasto) anziché
    // lasciare il pasto vuoto.
    const candidateHardOk = (recipe, day, { relaxMax = false, relaxRepeats = false, relaxFish = false, relaxOmegaSpacing = false } = {}) => {
      const category = classifyProtein(recipe);
      if (!category) return true;
      if (!relaxMax && counts[category] >= maxFor(category)) return false;
      if (isFishy(recipe) && !relaxFish && fishCountOn(day) >= 1) return false;
      if (!relaxRepeats && (usage[recipe.id] || 0) >= maxRepeats) return false;
      // Omega-3 distanziati: l'unica adiacenza ammessa è quella costruita
      // dall'utente con un'accoppiata batch (stessa ricetta a cena e a pranzo
      // del giorno dopo), che però viene piazzata al passo 1 e qui non passa
      // mai da questo filtro perché i suoi slot sono già occupati.
      if (!relaxOmegaSpacing && category === 'omega' && (omegaToday[prevDayOf(day)] || omegaToday[nextDayOf(day)])) return false;
      return true;
    };
    const candidateScore = (recipe, day, slot) => {
      const category = classifyProtein(recipe);
      let score = rand() * 2;
      if (category && counts[category] < minFor(category)) score += 8;
      score += templatePairBonus(recipe, day, slot) * 4;
      if (!category) score -= 1;
      score -= 3 * (usage[recipe.id] || 0);
      if (previousSlotValue(day, slot) === recipe.id) score -= 5;
      // La penalità guida la scelta anche quando il vincolo è rilassato
      // (ultimo gradino): a parità di condizioni resta preferita la distanza.
      if (category === 'omega') {
        if (omegaToday[prevDayOf(day)]) score -= 6;
        if (omegaToday[nextDayOf(day)]) score -= 6;
      }
      return score;
    };
    const pickProtein = (day, slot) => {
      const pool = poolFor(slot);
      if (!pool.length) return null;
      const levels = [
        {}, // tutti i vincoli duri
        { relaxMax: true },
        { relaxMax: true, relaxRepeats: true },
        { relaxMax: true, relaxRepeats: true, relaxFish: true },
        // Ultima spiaggia (catalogi irrisolvibili): si accetta anche un
        // omega-3 adiacente pur di non lasciare il pasto vuoto; l'adiacenza
        // residua viene poi segnalata tra i warning finali.
        { relaxMax: true, relaxRepeats: true, relaxFish: true, relaxOmegaSpacing: true }
      ];
      for (let index = 0; index < levels.length; index++) {
        const candidates = pool.filter(recipe => candidateHardOk(recipe, day, levels[index]));
        if (!candidates.length) continue;
        if (index > 0) warnRelaxed(day, slot);
        return candidates
          .map(recipe => ({ recipe, score: candidateScore(recipe, day, slot) }))
          .sort((a, b) => b.score - a.score)[0].recipe;
      }
      return null;
    };

    const generatedProteinSlots = [];
    DAYS.forEach(day => {
      ['lunch', 'dinner'].forEach(slot => {
        if (!freeSlot(day, slot)) return;
        const pick = pickProtein(day, slot);
        chosen[day][slot] = pick ? pick.id : null;
        if (pick) {
          registerMeal(day, slot, pick);
          generatedProteinSlots.push({ day, slot });
        }
      });
    });

    // --- Passo 3: riparazione delle frequenze minime non raggiunte ---
    // Scambia un pasto generato (mai bloccato, mai dentro una coppia batch)
    // con una ricetta della categoria mancante, senza violare massimi, limite
    // di pesce giornaliero né spingere l'altra categoria sotto il suo minimo.
    PROTEIN_CATEGORIES.forEach(category => {
      while (counts[category] < minFor(category)) {
        let applied = false;
        const slotsInRandomOrder = shuffle(generatedProteinSlots, rand);
        for (const { day, slot } of slotsInRandomOrder) {
          const currentRecipe = recipesById[chosen[day][slot]];
          const currentCategory = currentRecipe ? classifyProtein(currentRecipe) : null;
          if (!currentRecipe || currentCategory === category) continue;
          if (currentCategory && minFor(currentCategory) > 0 && counts[currentCategory] <= minFor(currentCategory)) continue;
          const pool = poolFor(slot).filter(recipe => classifyProtein(recipe) === category);
          const replacementOk = recipe => {
            if (!recipe || recipe.id === currentRecipe.id) return false;
            if (counts[category] + 1 > maxFor(category)) return false;
            if ((usage[recipe.id] || 0) >= maxRepeats) return false;
            if (isFishy(recipe) && fishCountOn(day) - (isFishy(currentRecipe) ? 1 : 0) + 1 > 1) return false;
            // Anche la riparazione delle frequenze minime rispetta la distanza
            // degli omega-3: se il minimo resta irraggiungibile prevale il
            // warning esplicito sulla frequenza mancante, non l'adiacenza.
            if (category === 'omega' && (omegaToday[prevDayOf(day)] || omegaToday[nextDayOf(day)])) return false;
            return true;
          };
          const replacement = pool.filter(replacementOk)
            .map(recipe => ({ recipe, score: candidateScore(recipe, day, slot) }))
            .sort((a, b) => b.score - a.score)[0]?.recipe;
          if (replacement) {
            unregisterMeal(day, slot, currentRecipe);
            chosen[day][slot] = replacement.id;
            registerMeal(day, slot, replacement);
            applied = true;
            break;
          }
        }
        if (!applied) break;
      }
    });

    // --- Passo 4: colazione e spuntini (rotazione varia; le frequenze
    // proteiche sono definite su pranzo/cena, qui non si conteggiano) ---
    const pickSimple = (day, slot) => {
      const pool = poolFor(slot);
      if (!pool.length) return null;
      return pool
        .map(recipe => ({
          recipe,
          score: rand() * 2
            - 2 * (usage[recipe.id] || 0)
            - (previousSlotValue(day, slot) === recipe.id ? 5 : 0)
        }))
        .sort((a, b) => b.score - a.score)[0].recipe;
    };
    DAYS.forEach(day => {
      ['breakfast', 'snack1', 'snack2'].forEach(slot => {
        if (!freeSlot(day, slot)) return;
        const pick = pickSimple(day, slot);
        chosen[day][slot] = pick ? pick.id : null;
        if (pick) usage[pick.id] = (usage[pick.id] || 0) + 1;
      });
    });

    const nextDays = {};
    DAYS.forEach(day => {
      nextDays[day] = {
        type: currentPlan.days?.[day]?.type || (['monday', 'wednesday', 'friday', 'sunday'].includes(day) ? 'training' : 'rest'),
        breakfast: chosen[day].breakfast ?? null,
        snack1: chosen[day].snack1 ?? null,
        lunch: chosen[day].lunch ?? null,
        snack2: chosen[day].snack2 ?? null,
        dinner: chosen[day].dinner ?? null
      };
    });

    const nextPlan = {
      ...deepClone(currentPlan),
      schemaVersion: VERSION,
      days: nextDays,
      batchRules: deepClone(currentPlan.batchRules || {}),
      batchTemplates: templates
    };

    // Avvisi finali sulle frequenze: calcolati sul piano COMPLETO (generati +
    // bloccati + mantenuti), coerenti col controllo mostrato nella Settimana.
    PROTEIN_CATEGORIES.forEach(category => {
      const count = counts[category];
      const min = minFor(category);
      const max = maxFor(category);
    
      if (count < min || count > max) {
        warnings.push(
          `${PROTEIN_CATEGORY_LABELS[category]}: ${count} pasti (obiettivo ${min}-${max}).`
        );
      }
    });
    // Blocchi di giorni omega consecutivi, mostrati come intervalli completi
    // ("Mercoledì–Giovedì") anziché come solo primo giorno di ogni coppia.
    // La settimana è circolare: domenica e lunedì sono adiacenti.
    const omegaDaySet = new Set(DAYS.filter(day => (omegaToday[day] || 0) > 0));
    const omegaSegments = [];
    let omegaRun = [];
    DAYS.forEach(day => {
      if (!omegaDaySet.has(day)) {
        if (omegaRun.length) omegaSegments.push(omegaRun);
        omegaRun = [];
      } else {
        omegaRun.push(day);
      }
    });
    if (omegaRun.length) omegaSegments.push(omegaRun);
    if (omegaSegments.length > 1 && omegaDaySet.has('sunday') && omegaDaySet.has('monday')) {
      // Il blocco che finisce di domenica continua in quello che inizia di lunedì.
      const tail = omegaSegments.pop();
      omegaSegments[0] = tail.concat(omegaSegments[0]);
    }
    // Un'accoppiata batch omega richiesta dall'utente (cena → pranzo del
    // giorno dopo, stessa ricetta) occupa due giorni consecutivi per
    // costruzione: quell'adiacenza è voluta, non va segnalata. Si avvisano
    // solo le adiacenze rimaste per altre strade (rilassamenti dei vincoli,
    // pasti bloccati o mantenuti dall'utente).
    const omegaPairSpans = new Set(pairs
      .filter(pair => recipesById[pair.recipeId] && classifyProtein(recipesById[pair.recipeId]) === 'omega')
      .map(pair => `${pair.anchorDay}|${pair.targetDay}`));
    const adjacentOmegaRuns = omegaSegments.filter(segment => segment.length > 1);
    const unexplainedOmegaRuns = adjacentOmegaRuns.filter(segment =>
      !(segment.length === 2 && omegaPairSpans.has(`${segment[0]}|${segment[1]}`)));
    if (unexplainedOmegaRuns.length) {
      warnings.push(`Omega-3 in giorni consecutivi: ${unexplainedOmegaRuns.map(segment => `${DAY_LABELS[segment[0]]}–${DAY_LABELS[segment[segment.length - 1]]}`).join(', ')}.`);
    }
    const doubleFishDays = DAYS.filter(day => fishCountOn(day) > 1);
    if (doubleFishDays.length) warnings.push(`Due pasti di pesce nello stesso giorno: ${doubleFishDays.map(day => DAY_LABELS[day]).join(', ')}.`);

    return { plan: nextPlan, counts, warnings, seed: seedUsed, pairs };
  }

  // Riferimento Meller per un ingrediente (prima regola che combacia), oppure
  // null quando l'alimento non ha una grammatura definita (verdura, spezie,
  // q.b., ecc.). Verdura e alimenti liberi non vengono mai segnalati.
  function mellerRuleForIngredient(name) {
    const value = aliasKey(name);
    if (!value) return null;
    return MELLER_GRAMMATURE.find(rule => rule.match.test(value)) || null;
  }

  // Grammatura di riferimento per pasto + giorno A/R (training/rest).
  function mellerReferenceAmount(rule, slot, dayType) {
    const bySlot = rule?.slots?.[slot];
    if (!bySlot) return null;
    const amount = bySlot[dayType];
    return amount != null ? amount : (bySlot.training != null ? bySlot.training : null);
  }

  // Quantità numerica confrontabile: solo grammi/millilitri (o misure da
  // cucina già convertite in grammi da parseSimpleAmount). I pezzi ("2 pz"),
  // il q.b. e i valori opachi vengono ignorati per non creare falsi positivi.
  function mellerComparableAmount(raw) {
    const parsed = parseSimpleAmount(raw);
    if (!parsed || parsed.skip || parsed.free || parsed.opaque) return null;
    if (parsed.unit !== 'g' && parsed.unit !== 'ml') return null;
    if (!Number.isFinite(parsed.value) || parsed.value <= 0) return null;
    return { value: parsed.value, unit: parsed.unit };
  }

  const MELLER_PORTION_KEYS = [
    ['manTraining', 'training'], ['manRest', 'rest'],
    ['ipoTraining', 'training'], ['ipoRest', 'rest']
  ];

  // Verifica se una ricetta rispetta le grammature Meller del proprio pasto.
  // Restituisce { adapted, issues, summary }: `adapted` è true quando nessuna
  // dose supera il riferimento; `summary` aggrega le segnalazioni per
  // ingrediente (pronta per la UI).
  function checkMellerAdaptation(recipe) {
    const slot = recipe?.slot && SLOTS.includes(recipe.slot) ? recipe.slot : 'lunch';
    const issues = [];
    (recipe?.ingredients || []).forEach(ingredient => {
      const rule = mellerRuleForIngredient(ingredient?.name);
      if (!rule) return;
      const portions = normalizePortions(ingredient?.portions || {});
      MELLER_PORTION_KEYS.forEach(([key, dayType]) => {
        const expected = mellerReferenceAmount(rule, slot, dayType);
        if (expected == null) return;
        const amount = mellerComparableAmount(portions[key]);
        if (!amount || amount.value <= expected) return;
        issues.push({
          ingredient: ingredient.name,
          family: rule.family,
          label: rule.label,
          portion: key,
          dayType,
          expected,
          actual: Math.round(amount.value * 100) / 100,
          unit: amount.unit
        });
      });
    });

    const summary = [];
    issues.forEach(issue => {
      let entry = summary.find(item => item.ingredient === issue.ingredient);
      if (!entry) {
        entry = { ingredient: issue.ingredient, label: issue.label, family: issue.family, actual: issue.actual, expected: issue.expected, unit: issue.unit };
        summary.push(entry);
      } else if (issue.actual > entry.actual) {
        entry.actual = issue.actual;
        entry.expected = issue.expected;
        entry.unit = issue.unit;
      }
    });

    return { adapted: issues.length === 0, issues, summary };
  }

  // Adatta con un click: riporta ai riferimenti Meller le dosi che superano
  // il massimo del proprio pasto e giorno A/R. Le dosi già corrette o non
  // numeriche restano invariate. Restituisce una copia della ricetta.
  function adaptRecipeToMeller(recipe) {
    const next = deepClone(recipe);
    const report = [];
    (next.ingredients || []).forEach(ingredient => {
      const rule = mellerRuleForIngredient(ingredient.name);
      if (!rule) return;
      const portions = ingredient.portions || {};
      MELLER_PORTION_KEYS.forEach(([key, dayType]) => {
        const expected = mellerReferenceAmount(rule, next.slot && SLOTS.includes(next.slot) ? next.slot : 'lunch', dayType);
        if (expected == null) return;
        const raw = String(portions[key] ?? '');
        const amount = mellerComparableAmount(raw);
        if (!amount || amount.value <= expected) return;
        const unit = amount.unit === 'ml' ? ' ml' : ' g';
        const nextAmount = `${expected}${unit}`;
        report.push({ ingredient: ingredient.name, portion: key, from: raw, to: nextAmount });
        portions[key] = nextAmount;
      });
    });
    return { recipe: next, report, changed: report.length > 0 };
  }

  return {
    VERSION,
    DAYS,
    SLOTS,
    DAY_LABELS,
    DAY_SHORT,
    SLOT_LABELS,
    SLOT_SHORT,
    EMPTY_PORTION,
    INGREDIENT_ALIASES,
    CANONICAL_INGREDIENTS,
    DEFAULT_CONSTRAINTS,
    deepClone,
    aliasKey,
    slug,
    ingredientIdFor,
    normalizePortions,
    migrateRecipe,
    migrateCatalog,
    migrateBatchRules,
    migratePlan,
    emptyDay,
    emptyDays,
    emptyPlan,
    dayDistance,
    futureTarget,
    batchTaskStatus,
    portionFor,
    formatPortion,
    quantityForTask,
    activeBatch,
    sumPortionStrings,
    combineTaskQuantities,
    commonRecipeBatch,
    categoryForIngredient,
    resolveShopCategoryOrder,
    resolveShopItemOrder,
    isEmptyPortion,
    parseSimpleAmount,
    CARB_REFERENCE,
    carbSourceForName,
    isPranzoCenaCross,
    adaptIngredientForSlot,
    aggregateShopping,
    swapMeals,
    copyMeal,
    restoreMeal,
    mergeRecipeCatalogs,
    sanitizePlanForCatalog,
    importedPlanIsUsable,
    recipeEquals,
    analyzeShare,
    resolveRecipeConflicts,
    planSlotsForRecipeRemoval,
    diffPlans,
    buildBackup,
    PROTEIN_CATEGORIES,
    PROTEIN_CONSTRAINT_KEYS,
    PROTEIN_CATEGORY_LABELS,
    classifyProtein,
    inferProteinCategoryFromIngredients,
    catalogHasLegacyFrequency,
    isFishRecipe,
    MELLER_GRAMMATURE,
    MELLER_GUIDE,
    MELLER_PROTEIN_FREQUENCIES,
    MELLER_RECIPE_MAX_AMOUNTS,
    mellerGuidelinesText,
    mellerMealStructureText,
    mellerRuleForIngredient,
    mellerReferenceAmount,
    checkMellerAdaptation,
    adaptRecipeToMeller,
    mulberry32,
    hashString,
    generateWeek
  };
});
