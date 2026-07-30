const MEAL_PLAN = {
  monday: {
    dayName: "Lunedì", dayKey: "monday", defaultType: "training",
    meals: {
      training: [
        {
          id: "monday_breakfast", slot: "breakfast", name: "Frozen Porridge \"Sacher\"", emoji: "🥣", prepTime: "5 min", prepNote: "Preparare domenica sera",
          ingredients: [
            { name: "Farina d'avena", quantity: 40, unit: "g" }, { name: "Yogurt greco 0%", quantity: 100, unit: "g" },
            { name: "Cacao amaro", quantity: 1, unit: "cucchiaio" }, { name: "Marmellata albicocche", quantity: 15, unit: "g" },
            { name: "Cioccolato fondente", quantity: 10, unit: "g" }, { name: "Sale", quantity: 1, unit: "pizzico" }
          ],
          steps: ["Mescola yogurt + cacao + sale", "Aggiungi avena", "Marmellata sopra senza mescolare", "Cioccolato sciolto a filo", "Chiudi e frigo. Mattino: tira fuori 5 min prima, mescola e consuma."],
          batchNote: "Prepara domenica sera; apri e scola lattine ceci + lenticchie, tieni in frigo", supplement: "7g creatina in acqua dopo colazione"
        },
        {
          id: "monday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Crackers", quantity: 30, unit: "g" }, { name: "Proteine whey Syform", quantity: 30, unit: "g" }],
          steps: ["Consuma la frutta e i crackers.", "Sciogli le whey in acqua e bevi."], batchNote: null, supplement: null
        },
        {
          id: "monday_lunch", slot: "lunch", name: "Riso e Ceci alla Curcuma con Spinaci", emoji: "🍛", prepTime: "20 min",
          ingredients: [
            { name: "Riso bianco", quantity: 90, unit: "g" }, { name: "Ceci bolliti scolati", quantity: 240, unit: "g" },
            { name: "Spinacini freschi", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Curcuma in polvere", quantity: 1, unit: "q.b." },
            { name: "Pepe", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }
          ],
          steps: ["Cuoci riso ~10min, scola;", "Scalda olio+aglio 1min fuoco basso;", "Aggiungi curcuma+pepe 30sec;", "Aggiungi ceci 3-4min;", "Aggiungi spinacini +1cucchiaio acqua, copri 2min;", "Unisci riso, aggiusta sale;", "Servi con succo limone"],
          batchNote: "Apri anche lattina lenticchie → scola e tieni in frigo per giovedì pranzo", supplement: null
        },
        {
          id: "monday_snack2", slot: "snack2", name: "Merenda", emoji: "🥄", prepTime: "1 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 150, unit: "g" }, { name: "Marmellata qualsiasi gusto", quantity: 20, unit: "g" }],
          steps: ["Mescola yogurt e marmellata."], batchNote: null, supplement: null
        },
        {
          id: "monday_dinner", slot: "dinner", name: "Tagliata di Manzo al Rosmarino con Patate e Insalata", emoji: "🥩", prepTime: "30 min",
          ingredients: [
            { name: "Manzo magro (controfiletto o fesa)", quantity: 150, unit: "g" }, { name: "Patate", quantity: 230, unit: "g" },
            { name: "Insalata mista", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." },
            { name: "Rosmarino fresco", quantity: 1, unit: "q.b." }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }
          ],
          steps: ["Lessa patate con buccia in acqua salata 20-25min → sbuccia, taglia, condisci con 5g olio+sale+prezzemolo;", "Tira carne fuori frigo 15min prima;", "Scalda padella rigata a fuoco molto alto finché fuma;", "Cuoci carne 2-3min per lato;", "Sala solo a fine cottura con sale grosso;", "Riposa su tagliere 3min poi affetta in diagonale controfibra;", "Insalata con 5g olio+limone+sale"],
          batchNote: "BATCH cuoci 460g patate totali → 230g stasera + 230g in frigo (giovedì cena). Prepara anche batter pancake per martedì colazione: 60g albumi+40g yogurt greco+40g avena+1g vanillina → mescola, copri, in frigo per notte.", supplement: null
        }
      ]
    },
    batchCooking: { evening: "Cuoci 460g patate (metà in frigo per giovedì). Prepara batter pancake per domani mattina (60g albumi+40g yogurt+40g avena+vanillina in frigo)." }
  },
  tuesday: {
    dayName: "Martedì", dayKey: "tuesday", defaultType: "training",
    meals: {
      training: [
        {
          id: "tuesday_breakfast", slot: "breakfast", name: "Pancake Proteici agli Albumi", emoji: "🥞", prepTime: "10 min",
          ingredients: [{ name: "Albumi", quantity: 120, unit: "g" }, { name: "Yogurt greco 0%", quantity: 40, unit: "g" }, { name: "Farina d'avena", quantity: 40, unit: "g" }, { name: "Vanillina", quantity: 1, unit: "g" }, { name: "Marmellata frutti di bosco", quantity: 30, unit: "g" }],
          steps: ["Batter già pronto → scalda padella antiaderente fuoco medio-basso senza olio;", "Versa formando 3-4 dischetti 8cm;", "Cuoci 2-3min per lato finché bollicine in superficie poi gira;", "Servi con marmellata sopra"],
          batchNote: null, supplement: "7g creatina dopo colazione"
        },
        {
          id: "tuesday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Crackers", quantity: 30, unit: "g" }, { name: "Proteine whey Syform", quantity: 30, unit: "g" }],
          steps: ["Consuma la frutta e i crackers.", "Sciogli le whey in acqua e bevi."], batchNote: null, supplement: null
        },
        {
          id: "tuesday_lunch", slot: "lunch", name: "Gnocchi al Merluzzo, Pomodorini e Melanzane", emoji: "🍝", prepTime: "20 min",
          ingredients: [
            { name: "Gnocchi di patate", quantity: 250, unit: "g" }, { name: "Merluzzo surgelato", quantity: 250, unit: "g" },
            { name: "Pomodorini ciliegino", quantity: 200, unit: "g" }, { name: "Melanzane", quantity: 150, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Origano", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }, { name: "Basilico fresco", quantity: 1, unit: "q.b." }
          ],
          steps: ["Taglia melanzana a cubetti, cuoci in padella senza olio con 3cucchiai acqua+origano 8-10min coperta;", "Stessa padella: scalda olio+aglio 1min;", "Aggiungi pomodorini interi fuoco vivo 3-4min finché scoppiano, schiaccia;", "Aggiungi merluzzo surgelato a bocconi, sala, pepa, cuoci 4-5min;", "Unisci melanzane 2min;", "Cuoci gnocchi in acqua salata finché vengono a galla (1-2min);", "Scola e salta nel sugo 1min;", "Servi con basilico fresco"],
          batchNote: null, supplement: null
        },
        {
          id: "tuesday_snack2", slot: "snack2", name: "Merenda", emoji: "🍘", prepTime: "1 min",
          ingredients: [{ name: "Crackers", quantity: 30, unit: "g" }],
          steps: ["Consuma i crackers."], batchNote: null, supplement: null
        },
        {
          id: "tuesday_dinner", slot: "dinner", name: "Petto di Pollo alla Paprika con Peperoni", emoji: "🍗", prepTime: "25 min",
          ingredients: [
            { name: "Petto di pollo", quantity: 200, unit: "g" }, { name: "Peperoni", quantity: 200, unit: "g" },
            { name: "Pane bianco", quantity: 60, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Paprika (affumicata/dolce)", quantity: 1, unit: "q.b." }, { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Batti i petti (cuocine 400g totali) per uniformare spessore;", "Marina tutti i 400g: paprika affumicata+aglio polvere+limone+sale+pepe almeno 10min;", "Cuoci su padella rigata fuoco medio-alto 5-6min per lato;", "Metti 200g in contenitore con olio+limone → frigo per domani;", "Taglia peperoni a striscioline (cuocine 400g) → salta con 5g olio 8-10min fuoco vivo, sfuma con aceto balsamico;", "Metti 200g peperoni in contenitore → frigo per domani;", "Servi 200g pollo + 200g peperoni + pane"],
          batchNote: "BATCH 200g pollo in frigo per mercoledì pranzo. 200g peperoni in frigo per mercoledì cena.", supplement: null
        }
      ]
    },
    batchCooking: { evening: "BATCH cuoci doppio petto di pollo (400g) e doppio peperoni (400g). Conserva metà in frigo per domani." }
  },
  wednesday: {
    dayName: "Mercoledì", dayKey: "wednesday", defaultType: "training",
    meals: {
      training: [
        {
          id: "wednesday_breakfast", slot: "breakfast", name: "Yogurt Greco, Cereali e Marmellata", emoji: "🥣", prepTime: "2 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 200, unit: "g" }, { name: "Cereali integrali / Fitness", quantity: 50, unit: "g" }, { name: "Marmellata", quantity: 10, unit: "g" }],
          steps: ["Versa yogurt in ciotola;", "Aggiungi marmellata, mescola per effetto swirl;", "Aggiungi cereali al momento di mangiare per mantenerli croccanti"],
          batchNote: null, supplement: "7g creatina dopo colazione"
        },
        {
          id: "wednesday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Crackers", quantity: 30, unit: "g" }, { name: "Proteine whey Syform", quantity: 30, unit: "g" }],
          steps: ["Consuma frutta, crackers e bevi whey in acqua."], batchNote: null, supplement: null
        },
        {
          id: "wednesday_lunch", slot: "lunch", name: "Pasta al Limone con Pollo e Zucchine", emoji: "🍝", prepTime: "15 min",
          ingredients: [
            { name: "Pasta bianca", quantity: 90, unit: "g" }, { name: "Petto di pollo già cotto", quantity: 200, unit: "g" },
            { name: "Zucchine", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Limone", quantity: 1, unit: "pz" }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Taglia pollo a striscioline → scalda in padella con metà olio 2min;", "Stessa padella: olio rimasto+zucchine a rondelle sottili fuoco vivo 5min;", "Cuoci pasta, conserva 1 mestolo acqua cottura prima di scolare;", "Unisci pasta+pollo+zucchine in padella, manteca con acqua cottura+scorza limone+succo;", "Aggiungi prezzemolo abbondante, aggiusta sale"],
          batchNote: null, supplement: null
        },
        {
          id: "wednesday_snack2", slot: "snack2", name: "Merenda", emoji: "🍯", prepTime: "1 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 150, unit: "g" }, { name: "Miele / Sciroppo Acero", quantity: 15, unit: "g" }],
          steps: ["Mescola yogurt e miele."], batchNote: null, supplement: null
        },
        {
          id: "wednesday_dinner", slot: "dinner", name: "Frittata ai Peperoni, Basilico e Spinaci con Pane", emoji: "🍳", prepTime: "15 min",
          ingredients: [
            { name: "Uova intere", quantity: 180, unit: "g" }, { name: "Peperoni saltati dal frigo ieri", quantity: 200, unit: "g" },
            { name: "Spinacini freschi", quantity: 100, unit: "g" }, { name: "Pane bianco", quantity: 60, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Basilico fresco", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Scalda metà olio → aggiungi peperoni avanzati 2min;", "Aggiungi spinacini, appassisci 1min;", "Sbatti uova con sale+pepe+basilico spezzettato;", "Olio rimasto in padella, versa uova sulle verdure, distribuisci;", "Copri con coperchio, fuoco basso 8-10min finché superficie rappresa; non girare;", "Servi con pane"],
          batchNote: "Mentre la frittata cuoce (mani libere), metti a lessare 230g patate per giovedì cena — faranno da sole", supplement: null
        }
      ]
    },
    batchCooking: { evening: "Mentre la frittata cuoce, metti a lessare 230g patate per domani cena." }
  },
  thursday: {
    dayName: "Giovedì", dayKey: "thursday", defaultType: "rest",
    meals: {
      rest: [
        {
          id: "thursday_breakfast", slot: "breakfast", name: "Latte e Cereali", emoji: "🥛", prepTime: "2 min",
          ingredients: [{ name: "Latte parz. scremato", quantity: 250, unit: "g" }, { name: "Cereali integrali / Fitness", quantity: 50, unit: "g" }],
          steps: ["Scalda latte a piacere (o freddo d'estate);", "Versa i cereali al momento di mangiare"],
          batchNote: null, supplement: "7g creatina dopo colazione"
        },
        {
          id: "thursday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Proteine Whey", quantity: 30, unit: "g" }],
          steps: ["Consuma la frutta e le proteine in acqua. Niente crackers in giorno di riposo."], batchNote: null, supplement: null
        },
        {
          id: "thursday_lunch", slot: "lunch", name: "Insalata Drenante Farro, Lenticchie", emoji: "🥗", prepTime: "35 min",
          ingredients: [
            { name: "Farro perlato", quantity: 70, unit: "g" }, { name: "Lenticchie in lattina", quantity: 240, unit: "g" },
            { name: "Avocado", quantity: 0.5, unit: "pz" }, { name: "Pomodorini", quantity: 150, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Cumino in polvere", quantity: 1, unit: "q.b." }, { name: "Zenzero fresco", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Cuoci farro in acqua salata 25-30min → scola e raffredda sotto acqua fredda;", "Taglia avocado a cubetti + pomodorini a metà;", "In ciotola: farro+lenticchie+avocado+pomodorini+prezzemolo;", "Dressing: olio+succo limone+cumino+zenzero grattugiato (1cm)+pepe → emulsiona;", "Condisci, mescola delicatamente, aggiusta sale; servire tiepido o freddo"],
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
          steps: ["Taglia patate a tocchetti → scalda 2min in padella senza olio o 1min microonde;", "Condisci patate con 5g olio+limone+paprika+sale;", "Insalata con 5g olio rimanente+limone+sale;", "Impiatta: insalata nel piatto, fiocchi di latte al centro, patate a lato con erba cipollina e pepe"],
          batchNote: null, supplement: null
        }
      ]
    },
    batchCooking: { evening: "Nessuna preparazione anticipata." }
  },
  friday: {
    dayName: "Venerdì", dayKey: "friday", defaultType: "training",
    meals: {
      training: [
        {
          id: "friday_breakfast_t", slot: "breakfast", name: "Pancake Avena con Miele", emoji: "🥞", prepTime: "10 min",
          ingredients: [{ name: "Farina d'avena", quantity: 40, unit: "g" }, { name: "Uova intere", quantity: 60, unit: "g" }, { name: "Yogurt greco 0%", quantity: 100, unit: "g" }, { name: "Miele / Sciroppo Acero", quantity: 10, unit: "g" }, { name: "Cannella", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }],
          steps: ["Sbatti uovo con yogurt fino a composto omogeneo;", "Aggiungi avena+cannella+sale+lievito, mescola eliminando grumi;", "Scalda padella antiaderente fuoco medio-basso senza olio;", "Versa a cucchiaiate formando 3-4 dischetti 8-10cm;", "Cuoci 2-3min per lato (gira quando compaiono bollicine);", "Servi con miele caldo sopra"],
          batchNote: null, supplement: "7g creatina dopo colazione"
        },
        {
          id: "friday_snack1_t", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Crackers", quantity: 30, unit: "g" }, { name: "Proteine Whey", quantity: 30, unit: "g" }],
          steps: ["Consuma frutta, crackers e bevi whey in acqua."], batchNote: null, supplement: null
        },
        {
          id: "friday_lunch_t", slot: "lunch", name: "Riso con Sgombro al Naturale, Pomodorini", emoji: "🐟", prepTime: "15 min",
          ingredients: [
            { name: "Riso bianco", quantity: 90, unit: "g" }, { name: "Sgombro al naturale", quantity: 100, unit: "g" },
            { name: "Pomodorini", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Capperi", quantity: 1, unit: "q.b." }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Origano", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }
          ],
          steps: ["Cuoci riso in acqua salata → scola e intiepidisci;", "Taglia pomodorini a metà, condisci con origano+sale, lascia insaporire;", "Sgocciola e sbriciola sgombro in lattina;", "In ciotola: riso+sgombro+pomodorini+capperi+prezzemolo abbondante;", "Condisci con olio+succo limone, mescola delicatamente; servire tiepido o a temperatura ambiente"],
          batchNote: null, supplement: null
        },
        {
          id: "friday_snack2_t", slot: "snack2", name: "Merenda", emoji: "🍘", prepTime: "1 min",
          ingredients: [{ name: "Crackers", quantity: 30, unit: "g" }],
          steps: ["Consuma i crackers."], batchNote: null, supplement: null
        },
        {
          id: "friday_dinner_t", slot: "dinner", name: "Salmone in Padella con Spinaci e Patate", emoji: "🍣", prepTime: "30 min",
          ingredients: [
            { name: "Salmone fresco", quantity: 100, unit: "g" }, { name: "Spinacini freschi", quantity: 200, unit: "g" },
            { name: "Patate", quantity: 230, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Lessa patate con buccia (cuocine 460g totali) 20-25min → sbuccia, taglia, condisci con aceto+prezzemolo+sale;", "Scalda 5g olio fuoco medio-alto; asciuga salmone con carta;", "Cuoci salmone 3min per lato senza muoverlo; sfuma con succo limone a fine cottura, sala e aggiungi aneto;", "Spinaci in altra padella con aglio+1cucchiaio acqua+5g olio 3-4min, spremi limone sopra;", "Impiatta: salmone al centro, spinaci e patate ai lati"],
          batchNote: "BATCH cuoci 460g patate → 230g stasera + 230g in frigo per prossima settimana", supplement: null
        }
      ],
      rest: [
        {
          id: "friday_breakfast_r", slot: "breakfast", name: "Pancake Avena con Miele", emoji: "🥞", prepTime: "10 min",
          ingredients: [{ name: "Farina d'avena", quantity: 40, unit: "g" }, { name: "Uova intere", quantity: 60, unit: "g" }, { name: "Yogurt greco 0%", quantity: 100, unit: "g" }, { name: "Miele / Sciroppo Acero", quantity: 10, unit: "g" }, { name: "Cannella", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }],
          steps: ["Sbatti uovo con yogurt fino a composto omogeneo;", "Aggiungi avena+cannella+sale+lievito, mescola eliminando grumi;", "Scalda padella antiaderente fuoco medio-basso senza olio;", "Versa a cucchiaiate formando 3-4 dischetti 8-10cm;", "Cuoci 2-3min per lato (gira quando compaiono bollicine);", "Servi con miele caldo sopra"],
          batchNote: null, supplement: "7g creatina dopo colazione"
        },
        {
          id: "friday_snack1_r", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Proteine Whey", quantity: 30, unit: "g" }],
          steps: ["Consuma frutta e whey. Niente crackers (giorno di riposo)."], batchNote: null, supplement: null
        },
        {
          id: "friday_lunch_r", slot: "lunch", name: "Riso con Sgombro al Naturale, Pomodorini", emoji: "🐟", prepTime: "15 min",
          ingredients: [
            { name: "Riso bianco", quantity: 70, unit: "g" }, { name: "Sgombro al naturale", quantity: 100, unit: "g" },
            { name: "Pomodorini", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Capperi", quantity: 1, unit: "q.b." }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Origano", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }
          ],
          steps: ["Cuoci riso in acqua salata → scola e intiepidisci;", "Taglia pomodorini a metà, condisci con origano+sale, lascia insaporire;", "Sgocciola e sbriciola sgombro in lattina;", "In ciotola: riso+sgombro+pomodorini+capperi+prezzemolo abbondante;", "Condisci con olio+succo limone, mescola delicatamente; servire tiepido o a temperatura ambiente"],
          batchNote: null, supplement: null
        },
        {
          id: "friday_snack2_r", slot: "snack2", name: "Merenda", emoji: "🍘", prepTime: "1 min",
          ingredients: [{ name: "Crackers", quantity: 30, unit: "g" }],
          steps: ["Consuma i crackers."], batchNote: null, supplement: null
        },
        {
          id: "friday_dinner_r", slot: "dinner", name: "Salmone in Padella con Spinaci e Patate", emoji: "🍣", prepTime: "30 min",
          ingredients: [
            { name: "Salmone fresco", quantity: 100, unit: "g" }, { name: "Spinacini freschi", quantity: 200, unit: "g" },
            { name: "Patate", quantity: 230, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Lessa patate con buccia (cuocine 460g totali) 20-25min → sbuccia, taglia, condisci con aceto+prezzemolo+sale;", "Scalda 5g olio fuoco medio-alto; asciuga salmone con carta;", "Cuoci salmone 3min per lato senza muoverlo; sfuma con succo limone a fine cottura, sala e aggiungi aneto;", "Spinaci in altra padella con aglio+1cucchiaio acqua+5g olio 3-4min, spremi limone sopra;", "Impiatta: salmone al centro, spinaci e patate ai lati"],
          batchNote: "BATCH cuoci 460g patate → 230g stasera + 230g in frigo per prossima settimana", supplement: null
        }
      ]
    },
    batchCooking: { evening: "BATCH cuoci 460g patate. 230g per stasera, 230g conservate in frigo." }
  },
  saturday: {
    dayName: "Sabato", dayKey: "saturday", defaultType: "rest",
    meals: {
      rest: [
        {
          id: "saturday_breakfast", slot: "breakfast", name: "Pancake Proteici con Sciroppo d'Acero", emoji: "🥞", prepTime: "10 min",
          ingredients: [{ name: "Albumi", quantity: 120, unit: "g" }, { name: "Yogurt greco 0%", quantity: 40, unit: "g" }, { name: "Farina d'avena", quantity: 40, unit: "g" }, { name: "Miele / Sciroppo Acero", quantity: 20, unit: "g" }],
          steps: ["Monta leggermente albumi con forchetta (solo schiumosi);", "Aggiungi yogurt+avena+vanillina, mescola fino a pastella liscia;", "Cuoci in padella antiaderente fuoco basso 2min per lato;", "Versa sciroppo d'acero sopra caldo"],
          batchNote: null, supplement: "7g creatina dopo colazione"
        },
        {
          id: "saturday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Proteine Whey", quantity: 30, unit: "g" }],
          steps: ["Consuma frutta e bevi whey in acqua."], batchNote: null, supplement: null
        },
        {
          id: "saturday_lunch", slot: "lunch", name: "Quinoa ai Fagioli Borlotti e Finocchi", emoji: "🥗", prepTime: "20 min",
          ingredients: [
            { name: "Quinoa", quantity: 60, unit: "g" }, { name: "Fagioli borlotti", quantity: 240, unit: "g" },
            { name: "Finocchi", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Origano", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Sciacqua quinoa in colino 1min;", "Cuoci in 120ml acqua salata fuoco basso coperta 12-15min → riposa 5min → sgrana con forchetta;", "Taglia finocchi a fettine sottili → salta in padella con 3cucchiai acqua+origano 8-10min fuoco medio senza olio;", "In ciotola: quinoa+fagioli+finocchi+prezzemolo abbondante;", "Dressing: olio+limone+sale+pepe → condisci e mescola"],
          batchNote: null, supplement: null
        },
        {
          id: "saturday_snack2", slot: "snack2", name: "Merenda", emoji: "🥄", prepTime: "1 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 150, unit: "g" }, { name: "Marmellata", quantity: 20, unit: "g" }],
          steps: ["Mescola yogurt e marmellata."], batchNote: null, supplement: null
        },
        {
          id: "saturday_dinner", slot: "dinner", name: "Uova in Purgatorio con Zucchine e Pane", emoji: "🍳", prepTime: "20 min",
          ingredients: [
            { name: "Uova intere", quantity: 180, unit: "g" }, { name: "Pomodori pelati", quantity: 200, unit: "g" },
            { name: "Zucchine", quantity: 200, unit: "g" }, { name: "Pane bianco", quantity: 60, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Peperoncino", quantity: 1, unit: "q.b." }, { name: "Basilico fresco", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Scalda olio con aglio+peperoncino 1min fuoco basso;", "Aggiungi pelati schiacciati con mani+basilico abbondante → sobbolli 8-10min mescolando;", "Salta zucchine a rondelle in padella separata senza olio con sale 5min;", "Nel sugo: crea 3 incavi con cucchiaio → rompi 1 uovo in ciascuno;", "Copri con coperchio, fuoco basso: 3-4min tuorlo morbido, 5-6min più sodo;", "Servi direttamente nella padella con zucchine a lato e pane per la scarpetta"],
          batchNote: null, supplement: null
        }
      ]
    },
    batchCooking: { evening: "Nessuna preparazione anticipata." }
  },
  sunday: {
    dayName: "Domenica", dayKey: "sunday", defaultType: "rest",
    meals: {
      rest: [
        {
          id: "sunday_breakfast", slot: "breakfast", name: "Yogurt Greco, Cereali e Marmellata", emoji: "🥣", prepTime: "2 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 200, unit: "g" }, { name: "Cereali integrali / Fitness", quantity: 50, unit: "g" }, { name: "Marmellata", quantity: 10, unit: "g" }],
          steps: ["Versa yogurt in ciotola;", "Aggiungi marmellata, mescola per effetto swirl;", "Aggiungi cereali al momento di mangiare per mantenerli croccanti"],
          batchNote: "DOMENICA SERA prepara Frozen Porridge per lunedì", supplement: "7g creatina dopo colazione"
        },
        {
          id: "sunday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Proteine Whey", quantity: 30, unit: "g" }],
          steps: ["Consuma frutta e bevi whey in acqua."], batchNote: null, supplement: null
        },
        {
          id: "sunday_lunch", slot: "lunch", name: "Legumotti con Nasello e Gamberetti", emoji: "🦐", prepTime: "20 min",
          ingredients: [
            { name: "Legumotti Barilla", quantity: 60, unit: "g" }, { name: "Nasello", quantity: 125, unit: "g" },
            { name: "Gamberetti surgelati", quantity: 150, unit: "g" }, { name: "Zucchine", quantity: 200, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }
          ],
          steps: ["Cuoci Legumotti in acqua salata → conserva 1 mestolo acqua cottura prima di scolare;", "Taglia nasello a bocconi → cuoci in padella con olio+aglio 3-4min per lato;", "Aggiungi gamberetti, cuoci 2-3min finché rosati; sfuma con succo limone;", "In padella separata: cuoci zucchine a rondelle con 2cucchiai acqua+origano 5-6min;", "Salta Legumotti con pesce+gamberetti+zucchine+acqua cottura per mantecare;", "Prezzemolo abbondante, sale, pepe finale"],
          batchNote: null, supplement: null
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
          steps: ["Se polpo surgelato già cotto: scongela in frigo dalla mattina → taglia a pezzetti;", "Taglia sedano a fettine sottili, melone a cubetti, avocado a cubetti;", "In ciotola: polpo+sedano+melone+avocado+basilico spezzettato;", "Emulsiona olio+limone+pepe → condisci;", "Mescola delicatamente, assaggia sale; riposa 5min prima di servire"],
          batchNote: "DOMENICA SERA prepara Frozen Porridge per lunedì e scola lattine legumi", supplement: null
        }
      ]
    },
    batchCooking: { evening: "DOMENICA SERA prepara Frozen Porridge per lunedì. Apri e scola lattine ceci + lenticchie, tieni in frigo." }
  }
};


// Routine generatrice dinamica
const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
weekDays.forEach(day => {
  const plan = MEAL_PLAN[day];
  
  if (plan.meals.training && !plan.meals.rest) {
    plan.meals.rest = JSON.parse(JSON.stringify(plan.meals.training));
    const snack1 = plan.meals.rest.find(m => m.slot === 'snack1');
    if(snack1) snack1.ingredients = snack1.ingredients.filter(i => i.name !== 'Crackers');
    const lunch = plan.meals.rest.find(m => m.slot === 'lunch');
    if (lunch) {
      lunch.ingredients.forEach(i => {
        if (i.name.includes("Riso") || i.name.includes("Pasta") || i.name.includes("Farro") || i.name.includes("Quinoa") || i.name.includes("Legumotti")) {
          if (i.quantity === 90) i.quantity = 70;
        }
      });
    }
  } 
  else if (plan.meals.rest && !plan.meals.training) {
    plan.meals.training = JSON.parse(JSON.stringify(plan.meals.rest));
    const snack1 = plan.meals.training.find(m => m.slot === 'snack1');
    if(snack1 && !snack1.ingredients.find(i=>i.name==='Crackers')) {
      snack1.ingredients.push({ name: "Crackers", quantity: 30, unit: "g" });
    }
    const lunch = plan.meals.training.find(m => m.slot === 'lunch');
    if (lunch) {
      lunch.ingredients.forEach(i => {
        if (i.name.includes("Riso") || i.name.includes("Pasta") || i.name.includes("Farro")) {
          if (i.quantity === 70) i.quantity = 90;
        } else if (i.name.includes("Quinoa") || i.name.includes("Legumotti")) {
          if (i.quantity === 60) i.quantity = 80;
        }
      });
    }
  }
});


const SHOPPING_CATEGORIES = [
  // Latticini / Uova
  { id: "yogurt_greco", name: "Yogurt greco 0%", category: "🥚 Uova e Latticini", unit: "g", days: { monday: { breakfast: {training:100, rest:100}, snack2: {training:150, rest:150} }, tuesday: { breakfast: {training:40, rest:40} }, wednesday: { breakfast: {training:200, rest:200}, snack2: {training:150, rest:150} }, thursday: { }, friday: { breakfast: {training:100, rest:100} }, saturday: { breakfast: {training:40, rest:40}, snack2: {training:150, rest:150} }, sunday: { breakfast: {training:200, rest:200}, snack2: {training:150, rest:150} } } },
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
  { id: "riso", name: "Riso bianco", category: "🍚 Carboidrati / Cereali", unit: "g", days: { monday: { lunch: {training:90, rest:70} }, friday: { lunch: {training:90, rest:70} } } },
  { id: "pasta", name: "Pasta bianca", category: "🍚 Carboidrati / Cereali", unit: "g", days: { wednesday: { lunch: {training:90, rest:70} } } },
  { id: "patate", name: "Patate", category: "🍚 Carboidrati / Cereali", unit: "g", days: { monday: { dinner: {training:230, rest:230} }, thursday: { dinner: {training:230, rest:230} }, friday: { dinner: {training:460, rest:460} } } },
  { id: "crackers", name: "Crackers", category: "🍚 Carboidrati / Cereali", unit: "g", days: { monday: { snack1: {training:30, rest:0} }, tuesday: { snack1: {training:30, rest:0}, snack2: {training:30, rest:30} }, wednesday: { snack1: {training:30, rest:0} }, thursday: { snack1: {training:30, rest:0}, snack2: {training:30, rest:30} }, friday: { snack1: {training:30, rest:0}, snack2: {training:30, rest:30} }, saturday: { snack1: {training:30, rest:0} }, sunday: { snack1: {training:30, rest:0} } } },
  { id: "gnocchi", name: "Gnocchi di patate", category: "🍚 Carboidrati / Cereali", unit: "g", days: { tuesday: { lunch: {training:250, rest:250} } } },
  { id: "pane", name: "Pane bianco", category: "🍚 Carboidrati / Cereali", unit: "g", days: { tuesday: { dinner: {training:60, rest:60} }, wednesday: { dinner: {training:60, rest:60} }, saturday: { dinner: {training:60, rest:60} } } },
  { id: "cereali", name: "Cereali integrali / Fitness", category: "🍚 Carboidrati / Cereali", unit: "g", days: { wednesday: { breakfast: {training:50, rest:50} }, thursday: { breakfast: {training:50, rest:50} }, sunday: { breakfast: {training:50, rest:50} } } },
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
  { id: "sale", name: "Sale / Sale grosso", category: "🌿 Spezie e Aromi", unit: "pz", days: { monday: { breakfast: {training:1, rest:1}, lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, tuesday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, wednesday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, thursday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, friday: { breakfast: {training:1, rest:1}, lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, saturday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, sunday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} } } },
  { id: "pepe", name: "Pepe", category: "🌿 Spezie e Aromi", unit: "pz", days: { monday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, tuesday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, wednesday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, thursday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, friday: { dinner: {training:1, rest:1} }, saturday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, sunday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} } } },
  { id: "aglio", name: "Aglio (fresco o polvere)", category: "🌿 Spezie e Aromi", unit: "pz", days: { monday: { lunch: {training:1, rest:1} }, tuesday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, wednesday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, friday: { dinner: {training:1, rest:1} }, saturday: { dinner: {training:1, rest:1} }, sunday: { lunch: {training:1, rest:1} } } },
  { id: "prezzemolo", name: "Prezzemolo fresco", category: "🌿 Spezie e Aromi", unit: "pz", days: { monday: { dinner: {training:1, rest:1} }, wednesday: { lunch: {training:1, rest:1} }, thursday: { lunch: {training:1, rest:1} }, friday: { lunch: {training:1, rest:1}, dinner: {training:1, rest:1} }, saturday: { lunch: {training:1, rest:1} }, sunday: { lunch: {training:1, rest:1} } } },
  { id: "basilico", name: "Basilico fresco", category: "🌿 Spezie e Aromi", unit: "pz", days: { tuesday: { lunch: {training:1, rest:1} }, wednesday: { dinner: {training:1, rest:1} }, saturday: { dinner: {training:1, rest:1} }, sunday: { dinner: {training:1, rest:1} } } },
  { id: "origano", name: "Origano", category: "🌿 Spezie e Aromi", unit: "pz", days: { tuesday: { lunch: {training:1, rest:1} }, friday: { lunch: {training:1, rest:1} }, saturday: { lunch: {training:1, rest:1} } } },
  { id: "limone", name: "Limone", category: "🌿 Spezie e Aromi", unit: "pz", days: { monday: { lunch: {training:0.5, rest:0.5}, dinner: {training:0.5, rest:0.5} }, tuesday: { dinner: {training:0.5, rest:0.5} }, wednesday: { lunch: {training:1, rest:1} }, thursday: { lunch: {training:0.5, rest:0.5}, dinner: {training:0.5, rest:0.5} }, friday: { lunch: {training:0.5, rest:0.5}, dinner: {training:0.5, rest:0.5} }, saturday: { lunch: {training:0.5, rest:0.5} }, sunday: { lunch: {training:0.5, rest:0.5}, dinner: {training:0.5, rest:0.5} } } },
  { id: "curcuma", name: "Curcuma in polvere", category: "🌿 Spezie e Aromi", unit: "pz", days: { monday: { lunch: {training:1, rest:1} } } },
  { id: "rosmarino", name: "Rosmarino fresco", category: "🌿 Spezie e Aromi", unit: "pz", days: { monday: { dinner: {training:1, rest:1} } } },
  { id: "paprika", name: "Paprika (affumicata/dolce)", category: "🌿 Spezie e Aromi", unit: "pz", days: { tuesday: { dinner: {training:1, rest:1} }, thursday: { dinner: {training:1, rest:1} } } },
  { id: "cumino", name: "Cumino in polvere", category: "🌿 Spezie e Aromi", unit: "pz", days: { thursday: { lunch: {training:1, rest:1} } } },
  { id: "zenzero", name: "Zenzero fresco", category: "🌿 Spezie e Aromi", unit: "pz", days: { thursday: { lunch: {training:1, rest:1} } } },
  { id: "cannella", name: "Cannella", category: "🌿 Spezie e Aromi", unit: "pz", days: { friday: { breakfast: {training:1, rest:1} } } },
  { id: "erbacipollina", name: "Erba cipollina", category: "🌿 Spezie e Aromi", unit: "pz", days: { thursday: { dinner: {training:1, rest:1} } } },
  { id: "capperi", name: "Capperi", category: "🌿 Spezie e Aromi", unit: "pz", days: { friday: { lunch: {training:1, rest:1} } } },
  { id: "peperoncino", name: "Peperoncino", category: "🌿 Spezie e Aromi", unit: "pz", days: { saturday: { dinner: {training:1, rest:1} } } }
];
