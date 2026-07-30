const MEAL_PLAN = {
  monday: {
    dayName: "Lunedì", dayKey: "monday", defaultType: "training",
    meals: {
      training: [
        {
          id: "monday_breakfast", slot: "breakfast", name: "Frozen Porridge \"Sacher\"", emoji: "🥣", prepTime: "2 min", prepNote: "Preparato domenica sera",
          ingredients: [
            { name: "Farina d'avena", quantity: 40, unit: "g" },
            { name: "Yogurt greco 0%", quantity: 100, unit: "g" },
            { name: "Cacao amaro", quantity: 1, unit: "cucchiaio" },
            { name: "Marmellata albicocche", quantity: 15, unit: "g" },
            { name: "Cioccolato fondente", quantity: 10, unit: "g" },
            { name: "Sale", quantity: 1, unit: "pizzico" }
          ],
          steps: ["Tira fuori dal frigo, mescola e consuma."],
          batchNote: "SESSIONE MASTER DOMENICA: 1. Cuoci tutte le patate (1.1kg). 2. Cuoci tutti i pancake (Mar, Ven, Sab). 3. Prepara Porridge. 4. Prepara 'Dressing Universale' (Olio, Limone, Erbe) in un vasetto.", supplement: "7g creatina in acqua dopo colazione"
        },
        {
          id: "monday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Crackers", quantity: 30, unit: "g" }, { name: "Proteine whey Syform", quantity: 30, unit: "g" }],
          steps: ["Consuma la frutta e i crackers.", "Sciogli le whey in acqua e bevi."], batchNote: null, supplement: null
        },
        {
          id: "monday_lunch", slot: "lunch", name: "Riso e Ceci alla Curcuma con Spinaci", emoji: "🍛", prepTime: "12 min",
          ingredients: [
            { name: "Riso bianco", quantity: 90, unit: "g" }, { name: "Ceci bolliti scolati", quantity: 240, unit: "g" },
            { name: "Spinacini freschi", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Curcuma in polvere", quantity: 1, unit: "q.b." },
            { name: "Pepe", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }
          ],
          steps: ["Cuoci tutto il riso della settimana (180g a crudo), scola e tieni metà per venerdì;", "In padella: aglio+olio+curcuma 1min;", "Aggiungi ceci e spinacini con 1 cucchiaio d'acqua, copri 3min;", "Unisci la metà del riso appena cotto e salta 1min.", "Usa il Dressing Universale preparato domenica."],
          batchNote: "BATCH: Cuoci 180g di riso totale (metà frigo per venerdì). Scola anche lenticchie per giovedì.", supplement: null
        },
        {
          id: "monday_snack2", slot: "snack2", name: "Merenda", emoji: "🥄", prepTime: "1 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 150, unit: "g" }, { name: "Marmellata qualsiasi gusto", quantity: 20, unit: "g" }],
          steps: ["Mescola yogurt e marmellata."], batchNote: null, supplement: null
        },
        {
          id: "monday_dinner", slot: "dinner", name: "Tagliata di Manzo al Rosmarino con Patate e Insalata", emoji: "🥩", prepTime: "10 min",
          ingredients: [
            { name: "Manzo magro (controfiletto o fesa)", quantity: 150, unit: "g" }, { name: "Patate", quantity: 230, unit: "g" },
            { name: "Insalata mista", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." },
            { name: "Rosmarino fresco", quantity: 1, unit: "q.b." }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }
          ],
          steps: ["Prendi 230g di patate già bollite domenica, tagliale e scaldale in padella 2min con rosmarino;", "Cuoci carne su piastra rovente 2-3min per lato;", "Affetta la carne e condisci tutto col Dressing Universale (olio/limone) pronto in frigo."],
          batchNote: "Patate già pronte dalla domenica.", supplement: null
        }
      ]
    },
    batchCooking: { evening: "Cuoci 180g riso bianco (90g per oggi, 90g in frigo per venerdì)." }
  },
  tuesday: {
    dayName: "Martedì", dayKey: "tuesday", defaultType: "training",
    meals: {
      training: [
        {
          id: "tuesday_breakfast", slot: "breakfast", name: "Pancake Proteici agli Albumi", emoji: "🥞", prepTime: "2 min",
          ingredients: [{ name: "Albumi", quantity: 120, unit: "g" }, { name: "Yogurt greco 0%", quantity: 40, unit: "g" }, { name: "Farina d'avena", quantity: 40, unit: "g" }, { name: "Vanillina", quantity: 1, unit: "g" }, { name: "Marmellata frutti di bosco", quantity: 30, unit: "g" }],
          steps: ["Prendi i pancake già cotti domenica dal frigo;", "Scalda 30 sec in microonde o tostapane;", "Guarnisci con marmellata"],
          batchNote: "Pancake preparati nella sessione master domenicale.", supplement: "7g creatina dopo colazione"
        },
        {
          id: "tuesday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Crackers", quantity: 30, unit: "g" }, { name: "Proteine whey Syform", quantity: 30, unit: "g" }],
          steps: ["Consuma la frutta e i crackers.", "Sciogli le whey in acqua e bevi."], batchNote: null, supplement: null
        },
        {
          id: "tuesday_lunch", slot: "lunch", name: "Gnocchi al Merluzzo, Pomodorini e Melanzane", emoji: "🍝", prepTime: "15 min",
          ingredients: [
            { name: "Gnocchi di patate", quantity: 250, unit: "g" }, { name: "Merluzzo surgelato", quantity: 250, unit: "g" },
            { name: "Pomodorini ciliegino", quantity: 200, unit: "g" }, { name: "Melanzane", quantity: 150, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Origano", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }, { name: "Basilico fresco", quantity: 1, unit: "q.b." }
          ],
          steps: ["Salta melanzane a cubetti e pomodorini in padella con aglio e origano 8min;", "Aggiungi merluzzo a pezzi, cuoci 5min;", "Lessa gnocchi (2min) e salta nel sugo."],
          batchNote: null, supplement: null
        },
        {
          id: "tuesday_snack2", slot: "snack2", name: "Merenda", emoji: "🍘", prepTime: "1 min",
          ingredients: [{ name: "Crackers", quantity: 30, unit: "g" }],
          steps: ["Consuma i crackers."], batchNote: null, supplement: null
        },
        {
          id: "tuesday_dinner", slot: "dinner", name: "Petto di Pollo alla Paprika con Peperoni", emoji: "🍗", prepTime: "20 min",
          ingredients: [
            { name: "Petto di pollo", quantity: 200, unit: "g" }, { name: "Peperoni", quantity: 200, unit: "g" },
            { name: "Pane bianco", quantity: 60, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Paprika (affumicata/dolce)", quantity: 1, unit: "q.b." }, { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Cuoci 400g di pollo e 400g di peperoni (metà per domani);", "Usa il forno o una piastra grande per fare tutto insieme;", "Condisci con Dressing Universale."],
          batchNote: "BATCH: Cuoci doppio pollo e doppi peperoni per domani.", supplement: null
        }
      ]
    },
    batchCooking: { evening: "Cuoci 400g pollo e 400g peperoni. Metà in frigo per domani." }
  },
  wednesday: {
    dayName: "Mercoledì", dayKey: "wednesday", defaultType: "training",
    meals: {
      training: [
        {
          id: "wednesday_breakfast", slot: "breakfast", name: "Yogurt Greco, Cereali e Marmellata", emoji: "🥣", prepTime: "2 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 200, unit: "g" }, { name: "Cereali integrali / Fitness", quantity: 50, unit: "g" }, { name: "Marmellata", quantity: 10, unit: "g" }],
          steps: ["Assembla yogurt, marmellata e cereali."],
          batchNote: null, supplement: "7g creatina dopo colazione"
        },
        {
          id: "wednesday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Crackers", quantity: 30, unit: "g" }, { name: "Proteine whey Syform", quantity: 30, unit: "g" }],
          steps: ["Consuma frutta, crackers e bevi whey."], batchNote: null, supplement: null
        },
        {
          id: "wednesday_lunch", slot: "lunch", name: "Pasta al Limone con Pollo e Zucchine", emoji: "🍝", prepTime: "12 min",
          ingredients: [
            { name: "Pasta bianca", quantity: 90, unit: "g" }, { name: "Petto di pollo", quantity: 200, unit: "g" },
            { name: "Zucchine", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Limone", quantity: 1, unit: "pz" }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Cuoci la pasta;", "In padella cuoci TUTTE le zucchine della settimana (600g totali);", "Prendi il pollo già cotto ieri e scaldalo con la pasta e 200g di zucchine;", "Usa Dressing Universale e prezzemolo."],
          batchNote: "BATCH: Cuoci 600g di zucchine totali (per oggi, sabato e domenica).", supplement: null
        },
        {
          id: "wednesday_snack2", slot: "snack2", name: "Merenda", emoji: "🍯", prepTime: "1 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 150, unit: "g" }, { name: "Miele / Sciroppo Acero", quantity: 15, unit: "g" }],
          steps: ["Mescola yogurt e miele."], batchNote: null, supplement: null
        },
        {
          id: "wednesday_dinner", slot: "dinner", name: "Frittata ai Peperoni, Basilico e Spinaci con Pane", emoji: "🍳", prepTime: "10 min",
          ingredients: [
            { name: "Uova intere", quantity: 180, unit: "g" }, { name: "Peperoni", quantity: 200, unit: "g" },
            { name: "Spinacini freschi", quantity: 100, unit: "g" }, { name: "Pane bianco", quantity: 60, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Basilico fresco", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Usa i peperoni già cotti martedì;", "Scalda peperoni e spinaci 2min, versa le uova sbattute e cuoci frittata."],
          batchNote: "Verdure già pronte.", supplement: null
        }
      ]
    },
    batchCooking: { evening: "Conserva le zucchine rimaste (400g) per il weekend." }
  },
  thursday: {
    dayName: "Giovedì", dayKey: "thursday", defaultType: "rest",
    meals: {
      rest: [
        {
          id: "thursday_breakfast", slot: "breakfast", name: "Latte e Cereali", emoji: "🥛", prepTime: "2 min",
          ingredients: [{ name: "Latte parz. scremato", quantity: 250, unit: "g" }, { name: "Cereali integrali / Fitness", quantity: 50, unit: "g" }],
          steps: ["Scalda latte e unisci cereali."],
          batchNote: null, supplement: "7g creatina dopo colazione"
        },
        {
          id: "thursday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Proteine Whey", quantity: 30, unit: "g" }],
          steps: ["Consuma frutta e whey."], batchNote: null, supplement: null
        },
        {
          id: "thursday_lunch", slot: "lunch", name: "Insalata Drenante Farro, Lenticchie", emoji: "🥗", prepTime: "5 min",
          ingredients: [
            { name: "Farro perlato", quantity: 70, unit: "g" }, { name: "Lenticchie in lattina", quantity: 240, unit: "g" },
            { name: "Avocado", quantity: 0.5, unit: "pz" }, { name: "Pomodorini", quantity: 150, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Cumino in polvere", quantity: 1, unit: "q.b." }, { name: "Zenzero fresco", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Lenticchie già scolate domenica; usa farro precotto o cuoci velocemente;", "Unisci avocado e pomodorini;", "Condisci con Dressing Universale e zenzero."],
          batchNote: null, supplement: null
        },
        {
          id: "thursday_snack2", slot: "snack2", name: "Merenda", emoji: "🍘", prepTime: "1 min",
          ingredients: [{ name: "Crackers", quantity: 30, unit: "g" }],
          steps: ["Consuma i crackers."], batchNote: null, supplement: null
        },
        {
          id: "thursday_dinner", slot: "dinner", name: "Fiocchi di Latte con Patate Tiepide e Insalata", emoji: "🥗", prepTime: "5 min",
          ingredients: [
            { name: "Fiocchi di latte", quantity: 180, unit: "g" }, { name: "Patate", quantity: 230, unit: "g" },
            { name: "Insalata mista", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Erba cipollina", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Paprika (affumicata/dolce)", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Prendi 230g patate cotte domenica, scalda 1min microonde;", "Impiatta con fiocchi e insalata, usa il Dressing Universale."],
          batchNote: "Patate già pronte.", supplement: null
        }
      ]
    },
    batchCooking: { evening: "Nessuna preparazione." }
  },
  friday: {
    dayName: "Venerdì", dayKey: "friday", defaultType: "training",
    meals: {
      training: [
        {
          id: "friday_breakfast_t", slot: "breakfast", name: "Pancake Avena con Miele", emoji: "🥞", prepTime: "2 min",
          ingredients: [{ name: "Farina d'avena", quantity: 40, unit: "g" }, { name: "Uova intere", quantity: 60, unit: "g" }, { name: "Yogurt greco 0%", quantity: 100, unit: "g" }, { name: "Miele / Sciroppo Acero", quantity: 10, unit: "g" }, { name: "Cannella", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }],
          steps: ["Prendi i pancake (variante uova intere) cotti domenica;", "Scalda e aggiungi miele."],
          batchNote: "Pancake pronti dalla domenica.", supplement: "7g creatina dopo colazione"
        },
        {
          id: "friday_snack1_t", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Crackers", quantity: 30, unit: "g" }, { name: "Proteine Whey", quantity: 30, unit: "g" }],
          steps: ["Consuma frutta, crackers e whey."], batchNote: null, supplement: null
        },
        {
          id: "friday_lunch_t", slot: "lunch", name: "Riso con Sgombro al Naturale, Pomodorini", emoji: "🐟", prepTime: "5 min",
          ingredients: [
            { name: "Riso bianco", quantity: 90, unit: "g" }, { name: "Sgombro al naturale", quantity: 100, unit: "g" },
            { name: "Pomodorini", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Capperi", quantity: 1, unit: "q.b." }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Origano", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }
          ],
          steps: ["Prendi il riso cotto lunedì;", "Unisci sgombro, pomodorini e condisci col Dressing Universale."],
          batchNote: "Riso già pronto.", supplement: null
        },
        {
          id: "friday_snack2_t", slot: "snack2", name: "Merenda", emoji: "🍘", prepTime: "1 min",
          ingredients: [{ name: "Crackers", quantity: 30, unit: "g" }],
          steps: ["Consuma i crackers."], batchNote: null, supplement: null
        },
        {
          id: "friday_dinner_t", slot: "dinner", name: "Salmone in Padella con Spinaci e Patate", emoji: "🍣", prepTime: "10 min",
          ingredients: [
            { name: "Salmone fresco", quantity: 100, unit: "g" }, { name: "Spinacini freschi", quantity: 200, unit: "g" },
            { name: "Patate", quantity: 230, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Cuoci salmone 3min per lato;", "Appassisci spinaci 3min con aglio;", "Prendi le ultime patate cotte domenica e scalda in padella;", "Condisci col Dressing Universale."],
          batchNote: "Patate pronte.", supplement: null
        }
      ]
    },
    batchCooking: { evening: "Nessuna preparazione." }
  },
  saturday: {
    dayName: "Sabato", dayKey: "saturday", defaultType: "rest",
    meals: {
      rest: [
        {
          id: "saturday_breakfast", slot: "breakfast", name: "Pancake Proteici con Sciroppo d'Acero", emoji: "🥞", prepTime: "2 min",
          ingredients: [{ name: "Albumi", quantity: 120, unit: "g" }, { name: "Yogurt greco 0%", quantity: 40, unit: "g" }, { name: "Farina d'avena", quantity: 40, unit: "g" }, { name: "Miele / Sciroppo Acero", quantity: 20, unit: "g" }],
          steps: ["Usa gli ultimi pancake pronti da domenica, scalda e guarnisci."],
          batchNote: null, supplement: "7g creatina dopo colazione"
        },
        {
          id: "saturday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Proteine Whey", quantity: 30, unit: "g" }],
          steps: ["Consuma frutta e whey."], batchNote: null, supplement: null
        },
        {
          id: "saturday_lunch", slot: "lunch", name: "Quinoa ai Fagioli Borlotti e Finocchi", emoji: "🥗", prepTime: "15 min",
          ingredients: [
            { name: "Quinoa", quantity: 60, unit: "g" }, { name: "Fagioli borlotti", quantity: 240, unit: "g" },
            { name: "Finocchi", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Origano", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Cuoci la quinoa;", "Affetta i finocchi sottili e falli saltare con i borlotti (scolati domenica);", "Unisci e condisci col Dressing Universale."],
          batchNote: null, supplement: null
        },
        {
          id: "saturday_snack2", slot: "snack2", name: "Merenda", emoji: "🥄", prepTime: "1 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 150, unit: "g" }, { name: "Marmellata", quantity: 20, unit: "g" }],
          steps: ["Mescola yogurt e marmellata."], batchNote: null, supplement: null
        },
        {
          id: "saturday_dinner", slot: "dinner", name: "Uova in Purgatorio con Zucchine e Pane", emoji: "🍳", prepTime: "12 min",
          ingredients: [
            { name: "Uova intere", quantity: 180, unit: "g" }, { name: "Pomodori pelati", quantity: 200, unit: "g" },
            { name: "Zucchine", quantity: 200, unit: "g" }, { name: "Pane bianco", quantity: 60, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Peperoncino", quantity: 1, unit: "q.b." }, { name: "Basilico fresco", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Fai il sugo coi pelati 8min, rompi le uova dentro;", "Usa le zucchine già cotte mercoledì (scaldale nel sugo o a lato);", "Servi con pane."],
          batchNote: "Zucchine già pronte.", supplement: null
        }
      ]
    },
    batchCooking: { evening: "Nessuna preparazione." }
  },
  sunday: {
    dayName: "Domenica", dayKey: "sunday", defaultType: "rest",
    meals: {
      rest: [
        {
          id: "sunday_breakfast", slot: "breakfast", name: "Yogurt Greco, Cereali e Marmellata", emoji: "🥣", prepTime: "2 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 200, unit: "g" }, { name: "Cereali integrali / Fitness", quantity: 50, unit: "g" }, { name: "Marmellata", quantity: 10, unit: "g" }],
          steps: ["Assembla yogurt e cereali."],
          batchNote: "STASERA: SESSIONE MASTER per la nuova settimana.", supplement: "7g creatina dopo colazione"
        },
        {
          id: "sunday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Proteine Whey", quantity: 30, unit: "g" }],
          steps: ["Consuma frutta e whey."], batchNote: null, supplement: null
        },
        {
          id: "sunday_lunch", slot: "lunch", name: "Legumotti con Nasello e Gamberetti", emoji: "🦐", prepTime: "15 min",
          ingredients: [
            { name: "Legumotti Barilla", quantity: 60, unit: "g" }, { name: "Nasello", quantity: 125, unit: "g" },
            { name: "Gamberetti surgelati", quantity: 150, unit: "g" }, { name: "Zucchine", quantity: 200, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }
          ],
          steps: ["Cuoci legumotti;", "Salta pesce e gamberi in padella 6min;", "Usa le ultime zucchine già cotte mercoledì;", "Mantecane il tutto."],
          batchNote: "Zucchine già pronte.", supplement: null
        },
        {
          id: "sunday_snack2", slot: "snack2", name: "Merenda", emoji: "🍯", prepTime: "1 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 150, unit: "g" }, { name: "Miele / Sciroppo Acero", quantity: 15, unit: "g" }],
          steps: ["Mescola yogurt e miele."], batchNote: null, supplement: null
        },
        {
          id: "sunday_dinner", slot: "dinner", name: "Insalata di Polpo con Sedano, Melone, Avocado", emoji: "🐙", prepTime: "10 min",
          ingredients: [
            { name: "Polpo già cotto", quantity: 250, unit: "g" }, { name: "Sedano", quantity: 1, unit: "pz" },
            { name: "Melone", quantity: 100, unit: "g" }, { name: "Avocado", quantity: 0.5, unit: "pz" },
            { name: "Olio EVO", quantity: 5, unit: "g" }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Basilico fresco", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Taglia polpo e frutta, unisci al sedano;", "Condisci con Dressing Universale."],
          batchNote: "Inizia Sessione Master stasera.", supplement: null
        }
      ]
    },
    batchCooking: { evening: "SESSIONE MASTER: 1. Patate (1.1kg) 2. Pancake (tutti) 3. Porridge 4. Dressing Universale 5. Scola legumi." }
  }
};

MEAL_PLAN.thursday.meals.training = MEAL_PLAN.thursday.meals.rest;
MEAL_PLAN.saturday.meals.training = MEAL_PLAN.saturday.meals.rest;
MEAL_PLAN.sunday.meals.training = MEAL_PLAN.sunday.meals.rest;

const SHOPPING_CATEGORIES = [
  // Latticini / Uova
  { id: "yogurt_greco", name: "Yogurt greco 0%", category: "🥚 Uova e Latticini", unit: "g", days: { monday: { breakfast: {training:100, rest:100}, snack2: {training:150, rest:150} }, tuesday: { breakfast: {training:40, rest:40} }, wednesday: { breakfast: {training:200, rest:200}, snack2: {training:150, rest:150} }, friday: { breakfast: {training:100, rest:100} }, saturday: { breakfast: {training:40, rest:40}, snack2: {training:150, rest:150} }, sunday: { breakfast: {training:200, rest:200}, snack2: {training:150, rest:150} } } },
  { id: "albumi", name: "Albumi", category: "🥚 Uova e Latticini", unit: "g", days: { tuesday: { breakfast: {training:120, rest:120} }, saturday: { breakfast: {training:120, rest:120} } } },
  { id: "uova_intere", name: "Uova intere", category: "🥚 Uova e Latticini", unit: "g", days: { wednesday: { dinner: {training:180, rest:180} }, friday: { breakfast: {training:60, rest:60} }, saturday: { dinner: {training:180, rest:180} } } },
  { id: "fiocchi_latte", name: "Fiocchi di latte", category: "🥚 Uova e Latticini", unit: "g", days: { thursday: { dinner: {training:180, rest:180} } } },
  { id: "latte", name: "Latte parz. scremato", category: "🥚 Uova e Latticini", unit: "g", days: { thursday: { breakfast: {training:250, rest:250} } } },
  
  // Carne
  { id: "manzo", name: "Manzo magro (controfiletto/fesa)", category: "🥩 Carne", unit: "g", days: { monday: { dinner: {training:150, rest:150} } } },
  { id: "pollo", name: "Petto di pollo", category: "🥩 Carne", unit: "g", days: { tuesday: { dinner: {training:200, rest:200} }, wednesday: { lunch: {training:200, rest:200} } } },

  // Pesce
  { id: "merluzzo", name: "Merluzzo surgelato", category: "🐟 Pesce e Frutti di Mare", unit: "g", days: { tuesday: { lunch: {training:250, rest:250} } } },
  { id: "sgombro", name: "Sgombro al naturale", category: "🐟 Pesce e Frutti di Mare", unit: "g", days: { friday: { lunch: {training:100, rest:100} } } },
  { id: "salmone", name: "Salmone fresco", category: "🐟 Pesce e Frutti di Mare", unit: "g", days: { friday: { dinner: {training:100, rest:100} } } },
  { id: "nasello", name: "Nasello", category: "🐟 Pesce e Frutti di Mare", unit: "g", days: { sunday: { lunch: {training:125, rest:125} } } },
  { id: "gamberetti", name: "Gamberetti surgelati", category: "🐟 Pesce e Frutti di Mare", unit: "g", days: { sunday: { lunch: {training:150, rest:150} } } },
  { id: "polpo", name: "Polpo già cotto", category: "🐟 Pesce e Frutti di Mare", unit: "g", days: { sunday: { dinner: {training:250, rest:250} } } },

  // Carboidrati
  { id: "avena", name: "Farina d'avena", category: "🍚 Carboidrati / Cereali", unit: "g", days: { monday: { breakfast: {training:40, rest:40} }, tuesday: { breakfast: {training:40, rest:40} }, friday: { breakfast: {training:40, rest:40} }, saturday: { breakfast: {training:40, rest:40} } } },
  { id: "riso", name: "Riso bianco", category: "🍚 Carboidrati / Cereali", unit: "g", days: { monday: { lunch: {training:90, rest:90} }, friday: { lunch: {training:90, rest:70} } } },
  { id: "patate", name: "Patate", category: "🍚 Carboidrati / Cereali", unit: "g", days: { monday: { dinner: {training:230, rest:230} }, thursday: { dinner: {training:230, rest:230} }, friday: { dinner: {training:460, rest:460} } } },
  { id: "crackers", name: "Crackers", category: "🍚 Carboidrati / Cereali", unit: "g", days: { monday: { snack1: {training:30, rest:30} }, tuesday: { snack1: {training:30, rest:30}, snack2: {training:30, rest:30} }, wednesday: { snack1: {training:30, rest:30} }, thursday: { snack2: {training:30, rest:30} }, friday: { snack1: {training:30, rest:0}, snack2: {training:30, rest:30} } } },
  { id: "gnocchi", name: "Gnocchi di patate", category: "🍚 Carboidrati / Cereali", unit: "g", days: { tuesday: { lunch: {training:250, rest:250} } } },
  { id: "pane", name: "Pane bianco", category: "🍚 Carboidrati / Cereali", unit: "g", days: { tuesday: { dinner: {training:60, rest:60} }, wednesday: { dinner: {training:60, rest:60} }, saturday: { dinner: {training:60, rest:60} } } },
  { id: "cereali", name: "Cereali integrali / Fitness", category: "🍚 Carboidrati / Cereali", unit: "g", days: { wednesday: { breakfast: {training:50, rest:50} }, thursday: { breakfast: {training:50, rest:50} }, sunday: { breakfast: {training:50, rest:50} } } },
  { id: "pasta", name: "Pasta bianca", category: "🍚 Carboidrati / Cereali", unit: "g", days: { wednesday: { lunch: {training:90, rest:90} } } },
  { id: "farro", name: "Farro perlato", category: "🍚 Carboidrati / Cereali", unit: "g", days: { thursday: { lunch: {training:70, rest:70} } } },
  { id: "quinoa", name: "Quinoa", category: "🍚 Carboidrati / Cereali", unit: "g", days: { saturday: { lunch: {training:60, rest:60} } } },
  { id: "legumotti", name: "Legumotti Barilla", category: "🍚 Carboidrati / Cereali", unit: "g", days: { sunday: { lunch: {training:60, rest:60} } } },

  // Legumi
  { id: "ceci", name: "Ceci in lattina", category: "🫘 Legumi", unit: "g", days: { monday: { lunch: {training:240, rest:240} } } },
  { id: "lenticchie", name: "Lenticchie in lattina", category: "🫘 Legumi", unit: "g", days: { thursday: { lunch: {training:240, rest:240} } } },
  { id: "borlotti", name: "Fagioli borlotti", category: "🫘 Legumi", unit: "g", days: { saturday: { lunch: {training:240, rest:240} } } },

  // Verdura
  { id: "spinaci", name: "Spinacini freschi", category: "🥬 Verdura Fresca", unit: "g", days: { monday: { lunch: {training:200, rest:200} }, wednesday: { dinner: {training:100, rest:100} }, friday: { dinner: {training:200, rest:200} } } },
  { id: "insalata", name: "Insalata mista", category: "🥬 Verdura Fresca", unit: "g", days: { monday: { dinner: {training:200, rest:200} }, thursday: { dinner: {training:200, rest:200} } } },
  { id: "pomodorini", name: "Pomodorini", category: "🥬 Verdura Fresca", unit: "g", days: { tuesday: { lunch: {training:200, rest:200} }, thursday: { lunch: {training:150, rest:150} }, friday: { lunch: {training:200, rest:200} } } },
  { id: "melanzane", name: "Melanzane", category: "🥬 Verdura Fresca", unit: "g", days: { tuesday: { lunch: {training:150, rest:150} } } },
  { id: "peperoni", name: "Peperoni", category: "🥬 Verdura Fresca", unit: "g", days: { tuesday: { dinner: {training:200, rest:200} }, wednesday: { dinner: {training:200, rest:200} } } },
  { id: "zucchine", name: "Zucchine", category: "🥬 Verdura Fresca", unit: "g", days: { wednesday: { lunch: {training:200, rest:200} }, saturday: { dinner: {training:200, rest:200} }, sunday: { lunch: {training:200, rest:200} } } },
  { id: "finocchi", name: "Finocchi", category: "🥬 Verdura Fresca", unit: "g", days: { saturday: { lunch: {training:200, rest:200} } } },
  { id: "sedano", name: "Sedano", category: "🥬 Verdura Fresca", unit: "pz", days: { sunday: { dinner: {training:1, rest:1} } } },
  { id: "pelati", name: "Pomodori pelati", category: "🥫 Dispensa / Condimenti", unit: "g", days: { saturday: { dinner: {training:200, rest:200} } } },

  // Frutta
  { id: "frutta_stagione", name: "Frutta fresca stagionale", category: "🍑 Frutta Fresca", unit: "g", days: { monday: { snack1: {training:250, rest:250} }, tuesday: { snack1: {training:250, rest:250} }, wednesday: { snack1: {training:250, rest:250} }, thursday: { snack1: {training:250, rest:250} }, friday: { snack1: {training:250, rest:250} }, saturday: { snack1: {training:250, rest:250} }, sunday: { snack1: {training:250, rest:250} } } },
  { id: "avocado", name: "Avocado", category: "🍑 Frutta Fresca", unit: "pz", days: { thursday: { lunch: {training:0.5, rest:0.5} }, sunday: { dinner: {training:0.5, rest:0.5} } } },
  { id: "melone", name: "Melone", category: "🍑 Frutta Fresca", unit: "g", days: { sunday: { dinner: {training:100, rest:100} } } },
  
  // Dispensa & Integrazione
  { id: "whey", name: "Proteine Whey", category: "🥫 Dispensa / Condimenti", unit: "g", days: { monday: { snack1: {training:30, rest:30} }, tuesday: { snack1: {training:30, rest:30} }, wednesday: { snack1: {training:30, rest:30} }, thursday: { snack1: {training:30, rest:30} }, friday: { snack1: {training:30, rest:30} }, saturday: { snack1: {training:30, rest:30} }, sunday: { snack1: {training:30, rest:30} } } },
  { id: "marmellata", name: "Marmellata", category: "🥫 Dispensa / Condimenti", unit: "g", days: { monday: { breakfast: {training:15, rest:15}, snack2: {training:20, rest:20} }, tuesday: { breakfast: {training:30, rest:30} }, wednesday: { breakfast: {training:10, rest:10} }, saturday: { snack2: {training:20, rest:20} }, sunday: { breakfast: {training:10, rest:10} } } },
  { id: "miele", name: "Miele / Sciroppo Acero", category: "🥫 Dispensa / Condimenti", unit: "g", days: { wednesday: { snack2: {training:15, rest:15} }, friday: { breakfast: {training:10, rest:10} }, saturday: { breakfast: {training:20, rest:20} }, sunday: { snack2: {training:15, rest:15} } } },
  { id: "olio", name: "Olio EVO", category: "🥫 Dispensa / Condimenti", unit: "g", days: { monday: { lunch: {training:10, rest:10}, dinner: {training:10, rest:10} }, tuesday: { lunch: {training:10, rest:10}, dinner: {training:10, rest:10} }, wednesday: { lunch: {training:10, rest:10}, dinner: {training:10, rest:10} }, thursday: { lunch: {training:10, rest:10}, dinner: {training:10, rest:10} }, friday: { lunch: {training:10, rest:10}, dinner: {training:10, rest:10} }, saturday: { lunch: {training:10, rest:10}, dinner: {training:10, rest:10} }, sunday: { lunch: {training:10, rest:10}, dinner: {training:5, rest:5} } } },
  { id: "cacao", name: "Cacao amaro", category: "🥫 Dispensa / Condimenti", unit: "cucchiai", days: { monday: { breakfast: {training:1, rest:1} } } },
  { id: "cioccolato", name: "Cioccolato fondente", category: "🥫 Dispensa / Condimenti", unit: "g", days: { monday: { breakfast: {training:10, rest:10} } } },
  
  // Spezie e Aromi
  { id: "sale", name: "Sale / Sale grosso", category: "🌿 Spezie e Aromi", unit: "q.b.", days: { monday: { breakfast: {training:1, rest:1}, lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, tuesday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, wednesday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, thursday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, friday: { breakfast: {training:1, rest:1}, lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, saturday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, sunday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} } } },
  { id: "pepe", name: "Pepe", category: "🌿 Spezie e Aromi", unit: "q.b.", days: { monday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, tuesday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, wednesday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, thursday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, friday: { dinner: {training:1, rest:1} }, saturday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, sunday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} } } },
  { id: "aglio", name: "Aglio (fresco o polvere)", category: "🌿 Spezie e Aromi", unit: "q.b.", days: { monday: { lunch: {training:1, rest:1} }, tuesday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, wednesday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, friday: { dinner: {training:1, rest:1} }, saturday: { dinner: {training:1, rest:1} }, sunday: { lunch: {training:1, rest:1} } } },
  { id: "prezzemolo", name: "Prezzemolo fresco", category: "🌿 Spezie e Aromi", unit: "q.b.", days: { monday: { dinner: {training:1, rest:1} }, wednesday: { lunch: {training:1, rest:1} }, thursday: { lunch: {training:1, rest:1} }, friday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, saturday: { lunch: {training:1, rest:1} }, sunday: { lunch: {training:1, rest:1} } } },
  { id: "basilico", name: "Basilico fresco", category: "🌿 Spezie e Aromi", unit: "q.b.", days: { tuesday: { lunch: {training:1, rest:1} }, wednesday: { dinner: {training:1, rest:1} }, saturday: { dinner: {training:1, rest:1} }, sunday: { dinner: {training:1, rest:1} } } },
  { id: "origano", name: "Origano", category: "🌿 Spezie e Aromi", unit: "q.b.", days: { tuesday: { lunch: {training:1, rest:1} }, friday: { lunch: {training:1, rest:1} }, saturday: { lunch: {training:1, rest:1} } } },
  { id: "limone", name: "Limone", category: "🌿 Spezie e Aromi", unit: "pz", days: { monday: { lunch: {training:0.5, rest:0.5}, dinner: {training:0.5, rest:0.5} }, tuesday: { dinner: {training:0.5, rest:0.5} }, wednesday: { lunch: {training:1, rest:1} }, thursday: { lunch: {training:0.5, rest:0.5}, dinner: {training:0.5, rest:0.5} }, friday: { lunch: {training:0.5, rest:0.5}, dinner: {training:0.5, rest:0.5} }, saturday: { lunch: {training:0.5, rest:0.5} }, sunday: { lunch: {training:0.5, rest:0.5}, dinner: {training:0.5, rest:0.5} } } },
  { id: "curcuma", name: "Curcuma in polvere", category: "🌿 Spezie e Aromi", unit: "q.b.", days: { monday: { lunch: {training:1, rest:1} } } },
  { id: "rosmarino", name: "Rosmarino fresco", category: "🌿 Spezie e Aromi", unit: "q.b.", days: { monday: { dinner: {training:1, rest:1} } } },
  { id: "paprika", name: "Paprika (affumicata/dolce)", category: "🌿 Spezie e Aromi", unit: "q.b.", days: { tuesday: { dinner: {training:1, rest:1} }, thursday: { dinner: {training:1, rest:1} } } },
  { id: "cumino", name: "Cumino in polvere", category: "🌿 Spezie e Aromi", unit: "q.b.", days: { thursday: { lunch: {training:1, rest:1} } } },
  { id: "zenzero", name: "Zenzero fresco", category: "🌿 Spezie e Aromi", unit: "q.b.", days: { thursday: { lunch: {training:1, rest:1} } } },
  { id: "cannella", name: "Cannella", category: "🌿 Spezie e Aromi", unit: "q.b.", days: { friday: { breakfast: {training:1, rest:1} } } },
  { id: "erbacipollina", name: "Erba cipollina", category: "🌿 Spezie e Aromi", unit: "q.b.", days: { thursday: { dinner: {training:1, rest:1} } } },
  { id: "capperi", name: "Capperi", category: "🌿 Spezie e Aromi", unit: "q.b.", days: { friday: { lunch: {training:1, rest:1} } } },
  { id: "peperoncino", name: "Peperoncino", category: "🌿 Spezie e Aromi", unit: "q.b.", days: { saturday: { dinner: {training:1, rest:1} } } }
];
