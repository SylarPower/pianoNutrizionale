const MEAL_PLAN = {
  monday: {
    dayName: "Lunedì", dayKey: "monday", defaultType: "training",
    meals: {
      training: [
        {
          id: "monday_breakfast", slot: "breakfast", name: "Frozen Porridge \"Sacher\"", emoji: "🥣", prepTime: "5 min", prepNote: "Preparare domenica sera",
          ingredients: [
            { name: "Farina d'avena", quantity: 40, unit: "g" }, { name: "Yogurt greco 0%", quantity: 100, unit: "g" },
            { name: "Cacao amaro", quantity: 1, unit: "cucchiaio" }, { name: "Marmellata", quantity: 15, unit: "g" },
            { name: "Cioccolato fondente", quantity: 10, unit: "g" }, { name: "Sale", quantity: 1, unit: "pizzico" }
          ],
          steps: ["Mescola yogurt + cacao + sale", "Aggiungi avena", "Marmellata sopra senza mescolare", "Cioccolato sciolto a filo", "Chiudi e frigo. Mattino: tira fuori 5 min prima, mescola e consuma."],
          batchNote: "Prepara domenica sera; apri e scola lattine ceci + lenticchie, tieni in frigo", supplement: "7g creatina in acqua dopo colazione"
        },
        {
          id: "monday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Crackers", quantity: 30, unit: "g" }, { name: "Proteine Whey", quantity: 30, unit: "g" }],
          steps: ["Consuma la frutta e i crackers.", "Sciogli le whey in acqua e bevi."], batchNote: null, supplement: null
        },
        {
          id: "monday_lunch", slot: "lunch", name: "Riso e Ceci alla Curcuma con Spinaci", emoji: "🍛", prepTime: "20 min",
          ingredients: [
            { name: "Riso bianco", quantity: 90, unit: "g" }, { name: "Ceci", quantity: 240, unit: "g" },
            { name: "Spinacini", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Curcuma in polvere", quantity: 1, unit: "q.b." },
            { name: "Pepe", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }
          ],
          steps: ["Cuoci riso ~10min, scola;", "Scalda olio+aglio 1min fuoco basso;", "Aggiungi curcuma+pepe 30sec;", "Aggiungi ceci 3-4min;", "Aggiungi spinacini +1cucchiaio acqua, copri 2min;", "Unisci riso, aggiusta sale;", "Servi con succo limone"],
          batchNote: "Apri anche lattina lenticchie → scola e tieni in frigo per giovedì pranzo", supplement: null
        },
        {
          id: "monday_snack2", slot: "snack2", name: "Merenda", emoji: "🥄", prepTime: "1 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 150, unit: "g" }, { name: "Marmellata", quantity: 20, unit: "g" }],
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
          batchNote: "BATCH COOKING: Cuoci dose doppia di patate per giovedì.", supplement: null
        }
      ]
    },
    batchCooking: { evening: "Cuoci {patate*4.6} di patate (metà conservale in frigo per giovedì). Prepara batter pancake per domani mattina ({albumi*1.2} albumi, {yogurt_greco*0.4} yogurt, {avena*0.4} avena, 1g vanillina in frigo)." }
  },
  tuesday: {
    dayName: "Martedì", dayKey: "tuesday", defaultType: "training",
    meals: {
      training: [
        {
          id: "tuesday_breakfast", slot: "breakfast", name: "Pancake Proteici agli Albumi", emoji: "🥞", prepTime: "10 min",
          ingredients: [{ name: "Albumi", quantity: 120, unit: "g" }, { name: "Yogurt greco 0%", quantity: 40, unit: "g" }, { name: "Farina d'avena", quantity: 40, unit: "g" }, { name: "Vanillina", quantity: 1, unit: "g" }, { name: "Marmellata", quantity: 30, unit: "g" }],
          steps: ["Batter già pronto → scalda padella antiaderente fuoco medio-basso senza olio;", "Versa formando 3-4 dischetti 8cm;", "Cuoci 2-3min per lato finché bollicine in superficie poi gira;", "Servi con marmellata sopra"],
          batchNote: null, supplement: "7g creatina dopo colazione"
        },
        {
          id: "tuesday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Crackers", quantity: 30, unit: "g" }, { name: "Proteine Whey", quantity: 30, unit: "g" }],
          steps: ["Consuma la frutta e i crackers.", "Sciogli le whey in acqua e bevi."], batchNote: null, supplement: null
        },
        {
          id: "tuesday_lunch", slot: "lunch", name: "Gnocchi al Merluzzo, Pomodorini e Melanzane", emoji: "🍝", prepTime: "20 min",
          ingredients: [
            { name: "Gnocchi di patate", quantity: 250, unit: "g" }, { name: "Merluzzo", quantity: 250, unit: "g" },
            { name: "Pomodorini ciliegino", quantity: 200, unit: "g" }, { name: "Melanzane", quantity: 150, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Origano", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }, { name: "Basilico fresco", quantity: 1, unit: "q.b." }
          ],
          steps: ["Taglia melanzana a cubetti, cuoci in padella senza olio con 3cucchiai acqua+origano 8-10min coperta;", "Stessa padella: scalda olio+aglio 1min;", "Aggiungi pomodorini interi fuoco vivo 3-4min finché scoppiano, schiaccia;", "Aggiungi merluzzo a bocconi, sala, pepa, cuoci 4-5min;", "Unisci melanzane 2min;", "Cuoci gnocchi in acqua salata finché vengono a galla (1-2min);", "Scola e salta nel sugo 1min;", "Servi con basilico fresco"],
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
          steps: ["Batti i petti (cuoci la dose doppia totali) per uniformare spessore;", "Marina i petti: paprika affumicata+aglio polvere+limone+sale+pepe almeno 10min;", "Cuoci su padella rigata fuoco medio-alto 5-6min per lato;", "Metti metà in contenitore con olio+limone → frigo per domani;", "Taglia peperoni a striscioline (cuoci la dose doppia) → salta con 5g olio 8-10min fuoco vivo, sfuma con aceto balsamico;", "Metti metà peperoni in contenitore → frigo per domani;", "Servi il piatto."],
          batchNote: "BATCH COOKING: Cuoci dose doppia di pollo e peperoni per domani.", supplement: null
        }
      ]
    },
    batchCooking: { evening: "BATCH COOKING: Cuoci {pollo*4} di pollo e {peperoni*4} di peperoni (Quantità doppia pesata). Conserva la metà esatta in frigo per domani." }
  },
  wednesday: {
    dayName: "Mercoledì", dayKey: "wednesday", defaultType: "training",
    meals: {
      training: [
        {
          id: "wednesday_breakfast", slot: "breakfast", name: "Yogurt Greco, Cereali e Marmellata", emoji: "🥣", prepTime: "2 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 200, unit: "g" }, { name: "Cereali", quantity: 50, unit: "g" }, { name: "Marmellata", quantity: 10, unit: "g" }],
          steps: ["Versa yogurt in ciotola;", "Aggiungi marmellata, mescola per effetto swirl;", "Aggiungi cereali al momento di mangiare per mantenerli croccanti"],
          batchNote: null, supplement: "7g creatina dopo colazione"
        },
        {
          id: "wednesday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Crackers", quantity: 30, unit: "g" }, { name: "Proteine Whey", quantity: 30, unit: "g" }],
          steps: ["Consuma frutta, crackers e bevi whey in acqua."], batchNote: null, supplement: null
        },
        {
          id: "wednesday_lunch", slot: "lunch", name: "Pasta al Limone con Pollo e Zucchine", emoji: "🍝", prepTime: "15 min",
          ingredients: [
            { name: "Pasta bianca", quantity: 90, unit: "g" }, { name: "Petto di pollo", quantity: 200, unit: "g" },
            { name: "Zucchine", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Limone", quantity: 1, unit: "pz" }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Taglia pollo a striscioline → scalda in padella con metà olio 2min;", "Stessa padella: olio rimasto+zucchine a rondelle sottili fuoco vivo 5min;", "Cuoci pasta, conserva 1 mestolo acqua cottura prima di scolare;", "Unisci pasta+pollo+zucchine in padella, manteca con acqua cottura+scorza limone+succo;", "Aggiungi prezzemolo abbondante, aggiusta sale"],
          batchNote: "USO AVANZI: Usa pollo cotto martedì sera.", supplement: null
        },
        {
          id: "wednesday_snack2", slot: "snack2", name: "Merenda", emoji: "🍯", prepTime: "1 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 150, unit: "g" }, { name: "Miele / Sciroppo Acero", quantity: 15, unit: "g" }],
          steps: ["Mescola yogurt e miele."], batchNote: null, supplement: null
        },
        {
          id: "wednesday_dinner", slot: "dinner", name: "Frittata ai Peperoni, Basilico e Spinaci con Pane", emoji: "🍳", prepTime: "15 min",
          ingredients: [
            { name: "Uova intere", quantity: 3, unit: "pz" }, { name: "Peperoni", quantity: 200, unit: "g" },
            { name: "Spinacini", quantity: 100, unit: "g" }, { name: "Pane bianco", quantity: 60, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Basilico fresco", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Scalda metà olio → aggiungi peperoni avanzati 2min;", "Aggiungi spinacini, appassisci 1min;", "Sbatti uova con sale+pepe+basilico spezzettato;", "Olio rimasto in padella, versa uova sulle verdure, distribuisci;", "Copri con coperchio, fuoco basso 8-10min finché superficie rappresa; non girare;", "Servi con pane"],
          batchNote: "USO AVANZI: Usa i peperoni di martedì. E intanto metti a lessare le patate per domani.", supplement: null
        }
      ]
    },
    batchCooking: { evening: "Se non l'hai fatto lunedì, lessa {patate*2.3} di patate per domani." }
  },
  thursday: {
    dayName: "Giovedì", dayKey: "thursday", defaultType: "rest",
    meals: {
      rest: [
        {
          id: "thursday_breakfast", slot: "breakfast", name: "Latte e Cereali", emoji: "🥛", prepTime: "2 min",
          ingredients: [{ name: "Latte parz. scremato", quantity: 250, unit: "g" }, { name: "Cereali", quantity: 50, unit: "g" }],
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
            { name: "Farro perlato", quantity: 70, unit: "g" }, { name: "Lenticchie", quantity: 240, unit: "g" },
            { name: "Avocado", quantity: 0.5, unit: "pz" }, { name: "Pomodorini", quantity: 150, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Cumino", quantity: 1, unit: "q.b." }, { name: "Zenzero fresco", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
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
    batchCooking: { evening: null }
  },
  friday: {
    dayName: "Venerdì", dayKey: "friday", defaultType: "training",
    meals: {
      training: [
        {
          id: "friday_breakfast_t", slot: "breakfast", name: "Pancake Avena con Miele", emoji: "🥞", prepTime: "10 min",
          ingredients: [{ name: "Farina d'avena", quantity: 40, unit: "g" }, { name: "Uova intere", quantity: 1, unit: "pz" }, { name: "Yogurt greco 0%", quantity: 100, unit: "g" }, { name: "Miele / Sciroppo Acero", quantity: 10, unit: "g" }, { name: "Cannella", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }],
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
            { name: "Salmone fresco", quantity: 100, unit: "g" }, { name: "Spinacini", quantity: 200, unit: "g" },
            { name: "Patate", quantity: 230, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Lessa patate con buccia (cuocine dose doppia) 20-25min → sbuccia, taglia, condisci con aceto+prezzemolo+sale;", "Scalda 5g olio fuoco medio-alto; asciuga salmone con carta;", "Cuoci salmone 3min per lato senza muoverlo; sfuma con succo limone a fine cottura, sala e aggiungi aneto;", "Spinaci in altra padella con aglio+1cucchiaio acqua+5g olio 3-4min, spremi limone sopra;", "Impiatta: salmone al centro, spinaci e patate ai lati"],
          batchNote: "BATCH COOKING: Cuoci patate doppie per lunedì prossimo", supplement: null
        }
      ],
      rest: [
        {
          id: "friday_breakfast_r", slot: "breakfast", name: "Pancake Avena con Miele", emoji: "🥞", prepTime: "10 min",
          ingredients: [{ name: "Farina d'avena", quantity: 40, unit: "g" }, { name: "Uova intere", quantity: 1, unit: "pz" }, { name: "Yogurt greco 0%", quantity: 100, unit: "g" }, { name: "Miele / Sciroppo Acero", quantity: 10, unit: "g" }, { name: "Cannella", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }],
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
            { name: "Salmone fresco", quantity: 100, unit: "g" }, { name: "Spinacini", quantity: 200, unit: "g" },
            { name: "Patate", quantity: 230, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Lessa patate con buccia (cuocine dose doppia) 20-25min → sbuccia, taglia, condisci con aceto+prezzemolo+sale;", "Scalda 5g olio fuoco medio-alto; asciuga salmone con carta;", "Cuoci salmone 3min per lato senza muoverlo; sfuma con succo limone a fine cottura, sala e aggiungi aneto;", "Spinaci in altra padella con aglio+1cucchiaio acqua+5g olio 3-4min, spremi limone sopra;", "Impiatta: salmone al centro, spinaci e patate ai lati"],
          batchNote: "BATCH COOKING: Cuoci patate doppie per lunedì prossimo", supplement: null
        }
      ]
    },
    batchCooking: { evening: "Cuoci {patate*4.6} di patate stasera (metà conservale in frigo per lunedì)." }
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
          id: "saturday_lunch", slot: "lunch", name: "Quinoa ai Fagioli Borlotti e Cetriolo", emoji: "🥗", prepTime: "20 min",
          ingredients: [
            { name: "Quinoa", quantity: 60, unit: "g" }, { name: "Fagioli borlotti", quantity: 240, unit: "g" },
            { name: "Cetriolo", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Prezzemolo fresco", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Origano", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Sciacqua quinoa in colino 1min;", "Cuoci in 120ml acqua salata fuoco basso coperta 12-15min → riposa 5min → sgrana con forchetta;", "Taglia cetriolo a fettine sottili → salta in padella con 3cucchiai acqua+origano 8-10min fuoco medio senza olio;", "In ciotola: quinoa+fagioli+cetriolo+prezzemolo abbondante;", "Dressing: olio+limone+sale+pepe → condisci e mescola"],
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
            { name: "Uova intere", quantity: 3, unit: "pz" }, { name: "Pomodori pelati", quantity: 200, unit: "g" },
            { name: "Zucchine", quantity: 200, unit: "g" }, { name: "Pane bianco", quantity: 60, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Aglio (fresco o polvere)", quantity: 1, unit: "q.b." }, { name: "Peperoncino", quantity: 1, unit: "q.b." }, { name: "Basilico fresco", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Scalda olio con aglio+peperoncino 1min fuoco basso;", "Aggiungi pelati schiacciati con mani+basilico abbondante → sobbolli 8-10min mescolando;", "Salta zucchine a rondelle in padella separata senza olio con sale 5min;", "Nel sugo: crea 3 incavi con cucchiaio → rompi 1 uovo in ciascuno;", "Copri con coperchio, fuoco basso: 3-4min tuorlo morbido, 5-6min più sodo;", "Servi direttamente nella padella con zucchine a lato e pane per la scarpetta"],
          batchNote: null, supplement: null
        }
      ]
    },
    batchCooking: { evening: "Se vuoi, mescola in un barattolo le polveri ({avena*1.6} avena) per tutti i 4 pancake della settimana successiva." }
  },
  sunday: {
    dayName: "Domenica", dayKey: "sunday", defaultType: "rest",
    meals: {
      rest: [
        {
          id: "sunday_breakfast", slot: "breakfast", name: "Yogurt Greco, Cereali e Marmellata", emoji: "🥣", prepTime: "2 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 200, unit: "g" }, { name: "Cereali", quantity: 50, unit: "g" }, { name: "Marmellata", quantity: 10, unit: "g" }],
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
            { name: "Gamberetti", quantity: 150, unit: "g" }, { name: "Zucchine", quantity: 200, unit: "g" },
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
            { name: "Polpo", quantity: 250, unit: "g" }, { name: "Sedano", quantity: 1, unit: "pz" },
            { name: "Melone", quantity: 100, unit: "g" }, { name: "Avocado", quantity: 0.5, unit: "pz" },
            { name: "Olio EVO", quantity: 5, unit: "g" }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Basilico fresco", quantity: 1, unit: "q.b." }, { name: "Sale / Sale grosso", quantity: 1, unit: "q.b." }, { name: "Pepe", quantity: 1, unit: "q.b." }
          ],
          steps: ["Se polpo surgelato già cotto: scongela in frigo dalla mattina → taglia a pezzetti;", "Taglia sedano a fettine sottili, melone a cubetti, avocado a cubetti;", "In ciotola: polpo+sedano+melone+avocado+basilico spezzettato;", "Emulsiona olio+limone+pepe → condisci;", "Mescola delicatamente, assaggia sale; riposa 5min prima di servire"],
          batchNote: "DOMENICA SERA prepara Frozen Porridge per lunedì e scola lattine legumi", supplement: null
        }
      ]
    },
    batchCooking: { evening: "Preparazione Frozen Porridge per lunedì. Scola lattine legumi. Prepara vinaigrette settimanale: in un barattolo sbatti {olio*1} Olio EVO, limone, senape q.b." }
  }
};

// Nessuna logica qui, tutta spostata in app.js per essere richiamata quando serve!
