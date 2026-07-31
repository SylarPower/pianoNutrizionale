const MEAL_PLAN = {
  monday: {
    dayName: "Lunedì", dayKey: "monday", defaultType: "training",
    meals: {
      training: [
        {
          id: "monday_breakfast", slot: "breakfast", name: "Frozen Porridge \"Sacher\"", emoji: "🥣", prepTime: "5 min",
          ingredients: [
            { name: "Farina d'avena", quantity: 40, unit: "g" }, { name: "Yogurt greco 0%", quantity: 100, unit: "g" },
            { name: "Cacao amaro", quantity: 1, unit: "cucchiaio" }, { name: "Marmellata albicocche", quantity: 15, unit: "g" },
            { name: "Cioccolato fondente", quantity: 10, unit: "g" }, { name: "Sale", quantity: 1, unit: "pizzico" }
          ],
          steps: [
            "In una ciotola, mescola l'avena con yogurt, cacao e sale fino a ottenere una consistenza cremosa.",
            "Versa in un bicchiere e aggiungi la marmellata senza mescolare per l'effetto 'swirl'.",
            "Sciogli il cioccolato e versalo a filo sopra il porridge.",
            "Lascia riposare in frigo tutta la notte. Tira fuori 5 min prima di mangiare."
          ],
          batchNote: "PREPARAZIONE: Da fare la domenica sera. Scola già i ceci per il pranzo di oggi e le lenticchie per giovedì.",
          supplement: "7g creatina in acqua dopo colazione"
        },
        {
          id: "monday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Crackers", quantity: 30, unit: "g" }, { name: "Proteine whey Syform", quantity: 30, unit: "g" }],
          steps: ["Consuma la frutta e i crackers.", "Sciogli le whey in acqua e bevi."], batchNote: null, supplement: null
        },
        {
          id: "monday_lunch", slot: "lunch", name: "Riso e Ceci alla Curcuma con Rucola", emoji: "🍛", prepTime: "20 min",
          ingredients: [
            { name: "Riso bianco", quantity: 90, unit: "g" }, { name: "Ceci bolliti", quantity: 240, unit: "g" },
            { name: "Rucola fresca", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Curcuma", quantity: 1, unit: "cucchiaino" }, { name: "Pepe nero", quantity: 1, unit: "q.b." }, { name: "Aglio", quantity: 1, unit: "q.b." }
          ],
          steps: [
            "Cuoci il riso al dente.",
            "In padella scalda l'olio con curcuma e pepe nero (fondamentale per attivare la curcumina).",
            "Salta i ceci 3-4 min con l'aglio, poi unisci il riso.",
            "Spegni il fuoco e aggiungi la rucola fresca: il calore residuo la farà appassire senza distruggere i nutrienti."
          ],
          batchNote: null, 
          supplement: null
        },
        {
          id: "monday_snack2", slot: "snack2", name: "Merenda", emoji: "🥄", prepTime: "1 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 150, unit: "g" }, { name: "Marmellata qualsiasi gusto", quantity: 20, unit: "g" }],
          steps: ["Mescola yogurt e marmellata."], batchNote: null, supplement: null
        },
        {
          id: "monday_dinner", slot: "dinner", name: "Tagliata di Manzo e Patate", emoji: "🥩", prepTime: "30 min",
          ingredients: [
            { name: "Manzo magro", quantity: 150, unit: "g" }, { name: "Patate", quantity: 230, unit: "g" },
            { name: "Insalata mista", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Sale grosso", quantity: 1, unit: "q.b." }, { name: "Rosmarino", quantity: 1, unit: "q.b." }
          ],
          steps: [
            "Lessa le patate con la buccia (20-25 min) per preservare i minerali.",
            "Cuoci la carne su piastra rovente 2-3 min per lato.",
            "IMPORTANTE: Sala solo alla fine con sale grosso per non indurire le fibre della carne.",
            "Condisci le patate sbucciate con 5g di olio e rosmarino."
          ],
          batchNote: "BATCH COOKING: Cuoci 460g di patate totali. 230g per stasera, 230g in frigo per la cena di giovedì.", 
          supplement: null
        }
      ]
    },
    batchCooking: { evening: "Lessa 460g di patate (metà per giovedì). Prepara il batter per i pancake di domani (60g albumi+40g yogurt+40g avena)." }
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
          id: "tuesday_lunch", slot: "lunch", name: "Gnocchi Merluzzo e Melanzane", emoji: "🍝", prepTime: "20 min",
          ingredients: [
            { name: "Gnocchi di patate", quantity: 250, unit: "g" }, { name: "Merluzzo", quantity: 250, unit: "g" },
            { name: "Pomodorini", quantity: 200, unit: "g" }, { name: "Melanzana", quantity: 150, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Basilico", quantity: 1, unit: "q.b." }, { name: "Origano", quantity: 1, unit: "q.b." }
          ],
          steps: [
            "Cuoci la melanzana a cubetti con acqua e origano (senza olio) per 10 min.",
            "Aggiungi l'olio e i pomodorini finché scoppiano, poi il merluzzo a pezzi per 5 min.",
            "Cuoci gli gnocchi, scolali e saltali nel sugo con abbondante basilico fresco strappato a mano."
          ],
          batchNote: null, 
          supplement: null
        },
        {
          id: "tuesday_snack2", slot: "snack2", name: "Merenda", emoji: "🍘", prepTime: "1 min",
          ingredients: [{ name: "Crackers", quantity: 30, unit: "g" }],
          steps: ["Consuma i crackers."], batchNote: null, supplement: null
        },
        {
          id: "tuesday_dinner", slot: "dinner", name: "Pollo alla Paprika e Peperoni", emoji: "🍗", prepTime: "25 min",
          ingredients: [
            { name: "Petto di pollo", quantity: 200, unit: "g" }, { name: "Peperoni", quantity: 200, unit: "g" },
            { name: "Pane bianco", quantity: 60, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Paprika", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }
          ],
          steps: [
            "Marina il pollo con limone, paprika e aglio.",
            "Cuoci su piastra rovente 5-6 min per lato.",
            "Salta i peperoni con olio e sfuma con aceto balsamico a fine cottura."
          ],
          batchNote: "BATCH COOKING: Cuoci 400g di pollo e 400g di peperoni. Conserva la metà in frigo per domani.", 
          supplement: null
        }
      ]
    },
    batchCooking: { evening: "Cuoci dose doppia di pollo (400g) e peperoni (400g) per i pasti di domani." }
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
          id: "wednesday_lunch", slot: "lunch", name: "Pasta Limone e Pollo", emoji: "🍋", prepTime: "15 min",
          ingredients: [
            { name: "Pasta bianca", quantity: 90, unit: "g" }, { name: "Pollo già cotto", quantity: 200, unit: "g" },
            { name: "Zucchine", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Limone (scorza e succo)", quantity: 1, unit: "pz" }
          ],
          steps: [
            "Taglia a strisce il pollo avanzato da ieri.",
            "Salta le zucchine a rondelle in padella con olio per 5 min.",
            "Scola la pasta e manteca in padella con il pollo, acqua di cottura, scorza e succo di limone per un effetto drenante."
          ],
          batchNote: "USO AVANZI: Usa i 200g di pollo cotti martedì sera.", 
          supplement: null
        },
        {
          id: "wednesday_snack2", slot: "snack2", name: "Merenda", emoji: "🍯", prepTime: "1 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 150, unit: "g" }, { name: "Miele / Sciroppo Acero", quantity: 15, unit: "g" }],
          steps: ["Mescola yogurt e miele."], batchNote: null, supplement: null
        },
        {
          id: "wednesday_dinner", slot: "dinner", name: "Frittata Peperoni e Rucola", emoji: "🍳", prepTime: "15 min",
          ingredients: [
            { name: "Uova intere", quantity: 180, unit: "g" }, { name: "Peperoni cotti", quantity: 200, unit: "g" },
            { name: "Rucola fresca", quantity: 100, unit: "g" }, { name: "Pane bianco", quantity: 60, unit: "g" },
            { name: "Olio EVO", quantity: 5, unit: "g" }
          ],
          steps: [
            "Scalda i peperoni di ieri in padella con la rucola per 1 min.",
            "Versa le uova sbattute con sale e pepe.",
            "TECNICA: Copri con coperchio e cuoci a fuoco basso 8-10 min. Non girare la frittata per mantenerla soffice e idratata.",
            "Servi con pane."
          ],
          batchNote: "USO AVANZI: Usa i 200g di peperoni cotti martedì sera.", 
          supplement: null
        }
      ]
    },
    batchCooking: { evening: "Se non hai patate pronte, lessane 230g stasera per domani." }
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
          id: "thursday_lunch", slot: "lunch", name: "Insalata Drenante Farro e Lenticchie", emoji: "🥗", prepTime: "35 min",
          ingredients: [
            { name: "Farro perlato", quantity: 70, unit: "g" }, { name: "Lenticchie", quantity: 240, unit: "g" },
            { name: "Avocado", quantity: 0.5, unit: "pz" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Zenzero fresco", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }, { name: "Pomodorini", quantity: 150, unit: "g" }
          ],
          steps: [
            "Cuoci il farro e raffreddalo subito sotto acqua: l'amido retrogradato abbassa l'indice glicemico.",
            "Prepara un dressing emulsionando olio, limone e zenzero fresco grattugiato.",
            "In una ciotola unisci farro, lenticchie scolate, avocado e pomodorini. Lascia insaporire 10 min."
          ],
          batchNote: "Usa le lenticchie scolate lunedì. Piatto fresco ideale per luglio.", 
          supplement: null
        },
        {
          id: "thursday_snack2", slot: "snack2", name: "Merenda", emoji: "🍘", prepTime: "1 min",
          ingredients: [{ name: "Crackers", quantity: 30, unit: "g" }],
          steps: ["Consuma i crackers."], batchNote: null, supplement: null
        },
        {
          id: "thursday_dinner", slot: "dinner", name: "Fiocchi di Latte e Patate", emoji: "🥣", prepTime: "5 min",
          ingredients: [
            { name: "Fiocchi di latte", quantity: 180, unit: "g" }, { name: "Patate bollite", quantity: 230, unit: "g" },
            { name: "Insalata mista", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Paprika", quantity: 1, unit: "q.b." }, { name: "Erba cipollina", quantity: 1, unit: "q.b." }
          ],
          steps: [
            "Scalda le patate avanzate da lunedì (in padella o microonde) e condiscile con 5g di olio, paprika e sale.",
            "Servi i fiocchi di latte freschi con erba cipollina e pepe.",
            "Accompagna con l'insalata condita con l'olio rimasto e limone."
          ],
          batchNote: null, 
          supplement: null
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
          id: "friday_breakfast", slot: "breakfast", name: "Pancake Avena e Miele", emoji: "🥞", prepTime: "10 min",
          ingredients: [{ name: "Farina d'avena", quantity: 40, unit: "g" }, { name: "Uova intere", quantity: 60, unit: "g" }, { name: "Yogurt greco 0%", quantity: 100, unit: "g" }, { name: "Miele", quantity: 10, unit: "g" }, { name: "Cannella", quantity: 1, unit: "q.b." }],
          steps: ["Sbatti uovo con yogurt, aggiungi avena e cannella;", "Cuoci 3-4 pancake in padella antiaderente;", "Guarnisci con miele."],
          batchNote: null, supplement: "7g creatina dopo colazione"
        },
        {
          id: "friday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Crackers", quantity: 30, unit: "g" }, { name: "Proteine Whey", quantity: 30, unit: "g" }],
          steps: ["Consuma frutta, crackers e bevi whey in acqua."], batchNote: null, supplement: null
        },
        {
          id: "friday_lunch", slot: "lunch", name: "Riso Sgombro e Pomodorini", emoji: "🐟", prepTime: "15 min",
          ingredients: [
            { name: "Riso bianco", quantity: 90, unit: "g" }, { name: "Sgombro naturale", quantity: 100, unit: "g" },
            { name: "Pomodorini", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Capperi", quantity: 1, unit: "q.b." }, { name: "Prezzemolo", quantity: 1, unit: "q.b." }
          ],
          steps: [
            "Unisci al riso cotto lo sgombro sbriciolato e i pomodorini tagliati.",
            "Aggiungi capperi, prezzemolo fresco e origano per dare gusto senza eccedere col sale.",
            "Condisci con olio e limone. Ideale da mangiare tiepido."
          ],
          batchNote: null, 
          supplement: null
        },
        {
          id: "friday_snack2", slot: "snack2", name: "Merenda", emoji: "🍘", prepTime: "1 min",
          ingredients: [{ name: "Crackers", quantity: 30, unit: "g" }],
          steps: ["Consuma i crackers."], batchNote: null, supplement: null
        },
        {
          id: "friday_dinner", slot: "dinner", name: "Salmone e Rucola con Patate", emoji: "🍣", prepTime: "30 min",
          ingredients: [
            { name: "Salmone fresco", quantity: 100, unit: "g" }, { name: "Rucola fresca", quantity: 200, unit: "g" },
            { name: "Patate", quantity: 230, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Limone", quantity: 0.5, unit: "pz" }
          ],
          steps: [
            "Lessa le patate (dose doppia per la prossima settimana).",
            "Asciuga bene il salmone con carta da cucina: è il segreto per la crosticina.",
            "Cuoci 3 min per lato in padella rovente senza muoverlo.",
            "Servi su un letto di rucola fresca con patate condite con olio e limone."
          ],
          batchNote: "BATCH COOKING: Cuoci 460g di patate totali. 230g stasera, 230g in frigo per lunedì.", 
          supplement: null
        }
      ]
    },
    batchCooking: { evening: "Cuoci 460g di patate (metà per lunedì prossimo)." }
  },
  saturday: {
    dayName: "Sabato", dayKey: "saturday", defaultType: "rest",
    meals: {
      rest: [
        {
          id: "saturday_breakfast", slot: "breakfast", name: "Pancake Proteici", emoji: "🥞", prepTime: "10 min",
          ingredients: [{ name: "Albumi", quantity: 120, unit: "g" }, { name: "Yogurt greco 0%", quantity: 40, unit: "g" }, { name: "Farina d'avena", quantity: 40, unit: "g" }, { name: "Sciroppo d'acero", quantity: 20, unit: "g" }],
          steps: ["Mescola ingredienti e cuoci in padella.", "Guarnisci con sciroppo d'acero."], batchNote: null, supplement: "7g creatina dopo colazione"
        },
        {
          id: "saturday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Proteine Whey", quantity: 30, unit: "g" }],
          steps: ["Consuma frutta e whey."], batchNote: null, supplement: null
        },
        {
          id: "saturday_lunch", slot: "lunch", name: "Quinoa, Fagioli e Cetriolo", emoji: "🥗", prepTime: "20 min",
          ingredients: [
            { name: "Quinoa", quantity: 60, unit: "g" }, { name: "Fagioli borlotti", quantity: 240, unit: "g" },
            { name: "Cetriolo", quantity: 200, unit: "g" }, { name: "Olio EVO", quantity: 10, unit: "g" },
            { name: "Menta fresca", quantity: 1, unit: "q.b." }, { name: "Limone", quantity: 0.5, unit: "pz" }
          ],
          steps: [
            "Sciacqua bene la quinoa prima di cuocerla.",
            "Taglia il cetriolo a cubetti: è l'alleato numero uno per l'idratazione estiva.",
            "In una ciotola unisci quinoa cotta, fagioli, cetrioli.",
            "Condisci a freddo con olio, limone e menta fresca per un effetto drenante."
          ],
          batchNote: null, 
          supplement: null
        },
        {
          id: "saturday_snack2", slot: "snack2", name: "Merenda", emoji: "🥄", prepTime: "1 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 150, unit: "g" }, { name: "Marmellata", quantity: 20, unit: "g" }],
          steps: ["Mescola yogurt e marmellata."], batchNote: null, supplement: null
        },
        {
          id: "saturday_dinner", slot: "dinner", name: "Uova in Purgatorio", emoji: "🍳", prepTime: "20 min",
          ingredients: [
            { name: "Uova intere", quantity: 180, unit: "g" }, { name: "Pomodori pelati", quantity: 200, unit: "g" },
            { name: "Zucchine", quantity: 200, unit: "g" }, { name: "Pane bianco", quantity: 60, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Basilico", quantity: 1, unit: "q.b." }
          ],
          steps: [
            "Cuoci i pelati in padella con aglio e basilico per 10 min.",
            "Rompi le uova direttamente nel sugo, copri e cuoci finché il bianco è rappreso ma il tuorlo resta morbido.",
            "Accompagna con zucchine saltate velocemente in padella e il pane per la 'scarpetta'."
          ],
          batchNote: null, 
          supplement: null
        }
      ]
    },
    batchCooking: { evening: "Domani sera ricordati di preparare il Frozen Porridge per lunedì." }
  },
  sunday: {
    dayName: "Domenica", dayKey: "sunday", defaultType: "rest",
    meals: {
      rest: [
        {
          id: "sunday_breakfast", slot: "breakfast", name: "Yogurt Greco e Cereali", emoji: "🥣", prepTime: "2 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 200, unit: "g" }, { name: "Cereali integrali / Fitness", quantity: 50, unit: "g" }, { name: "Marmellata", quantity: 10, unit: "g" }],
          steps: ["Unisci yogurt, marmellata e cereali."], batchNote: null, supplement: "7g creatina dopo colazione"
        },
        {
          id: "sunday_snack1", slot: "snack1", name: "Spuntino Mattina", emoji: "🍎", prepTime: "2 min",
          ingredients: [{ name: "Frutta fresca stagionale", quantity: 250, unit: "g" }, { name: "Proteine Whey", quantity: 30, unit: "g" }],
          steps: ["Consuma frutta e whey."], batchNote: null, supplement: null
        },
        {
          id: "sunday_lunch", slot: "lunch", name: "Legumotti Frutti di Mare e Zucchine", emoji: "🦐", prepTime: "20 min",
          ingredients: [
            { name: "Legumotti Barilla", quantity: 60, unit: "g" }, { name: "Nasello", quantity: 125, unit: "g" },
            { name: "Gamberetti", quantity: 150, unit: "g" }, { name: "Zucchine", quantity: 200, unit: "g" },
            { name: "Olio EVO", quantity: 10, unit: "g" }, { name: "Prezzemolo", quantity: 1, unit: "q.b." }
          ],
          steps: [
            "Salta nasello e gamberetti in padella con aglio, olio e limone.",
            "Cuoci i legumotti e scolali nella padella del pesce.",
            "Manteca con un mestolo di acqua di cottura e aggiungi zucchine a rondelle cotte a parte e prezzemolo fresco.",
            "Mix di proteine nobili e legumi per un indice infiammatorio bassissimo."
          ],
          batchNote: null, 
          supplement: null
        },
        {
          id: "sunday_snack2", slot: "snack2", name: "Merenda", emoji: "🍯", prepTime: "1 min",
          ingredients: [{ name: "Yogurt greco 0%", quantity: 150, unit: "g" }, { name: "Miele", quantity: 15, unit: "g" }],
          steps: ["Mescola yogurt e miele."], batchNote: null, supplement: null
        },
        {
          id: "sunday_dinner", slot: "dinner", name: "Insalata Polpo e Melone", emoji: "🐙", prepTime: "10 min",
          ingredients: [
            { name: "Polpo già cotto", quantity: 250, unit: "g" }, { name: "Melone", quantity: 100, unit: "g" },
            { name: "Avocado", quantity: 0.5, unit: "pz" }, { name: "Olio EVO", quantity: 5, unit: "g" },
            { name: "Limone", quantity: 0.5, unit: "pz" }
          ],
          steps: [
            "Taglia polpo, melone e avocado a cubetti regolari.",
            "Emulsiona olio, limone e pepe e condisci a freddo.",
            "Lascia riposare 5 min: il melone apporta potassio prezioso contro il caldo estivo."
          ],
          batchNote: "Preparazione Frozen Porridge per domani. Scola ceci e lenticchie.", 
          supplement: null
        }
      ]
    },
    batchCooking: { evening: "Preparazione Frozen Porridge per lunedì. Scola lattine legumi (ceci e lenticchie)." }
  }
};

// Routine generatrice dinamica (Mantenuta per gestire i pesi tra rest/training)
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
          if (i.quantity === 80) i.quantity = 60;
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
  { id: "yogurt_greco", name: "Yogurt greco 0%", category: "🥚 Uova e Latticini", unit: "g" },
  { id: "albumi", name: "Albumi", category: "🥚 Uova e Latticini", unit: "g" },
  { id: "uova_intere", name: "Uova intere", category: "🥚 Uova e Latticini", unit: "g" },
  { id: "fiocchi_latte", name: "Fiocchi di latte", category: "🥚 Uova e Latticini", unit: "g" },
  { id: "manzo", name: "Manzo magro", category: "🥩 Carne", unit: "g" },
  { id: "pollo", name: "Petto di pollo", category: "🥩 Carne", unit: "g" },
  { id: "merluzzo", name: "Merluzzo", category: "🐟 Pesce", unit: "g" },
  { id: "sgombro", name: "Sgombro al naturale", category: "🐟 Pesce", unit: "g" },
  { id: "salmone", name: "Salmone fresco", category: "🐟 Pesce", unit: "g" },
  { id: "polpo", name: "Polpo già cotto", category: "🐟 Pesce", unit: "g" },
  { id: "nasello", name: "Nasello", category: "🐟 Pesce", unit: "g" },
  { id: "gamberetti", name: "Gamberetti", category: "🐟 Pesce", unit: "g" },
  { id: "avena", name: "Farina d'avena", category: "🍚 Carboidrati", unit: "g" },
  { id: "riso", name: "Riso bianco", category: "🍚 Carboidrati", unit: "g" },
  { id: "pasta", name: "Pasta bianca", category: "🍚 Carboidrati", unit: "g" },
  { id: "patate", name: "Patate", category: "🍚 Carboidrati", unit: "g" },
  { id: "gnocchi", name: "Gnocchi di patate", category: "🍚 Carboidrati", unit: "g" },
  { id: "pane", name: "Pane bianco", category: "🍚 Carboidrati", unit: "g" },
  { id: "farro", name: "Farro perlato", category: "🍚 Carboidrati", unit: "g" },
  { id: "quinoa", name: "Quinoa", category: "🍚 Carboidrati", unit: "g" },
  { id: "legumotti", name: "Legumotti Barilla", category: "🍚 Carboidrati", unit: "g" },
  { id: "ceci", name: "Ceci in lattina", category: "🫘 Legumi", unit: "g" },
  { id: "lenticchie", name: "Lenticchie in lattina", category: "🫘 Legumi", unit: "g" },
  { id: "borlotti", name: "Fagioli borlotti", category: "🫘 Legumi", unit: "g" },
  { id: "rucola", name: "Rucola fresca", category: "🥬 Verdura", unit: "g" },
  { id: "insalata", name: "Insalata mista", category: "🥬 Verdura", unit: "g" },
  { id: "pomodorini", name: "Pomodorini", category: "🥬 Verdura", unit: "g" },
  { id: "melanzane", name: "Melanzane", category: "🥬 Verdura", unit: "g" },
  { id: "peperoni", name: "Peperoni", category: "🥬 Verdura", unit: "g" },
  { id: "zucchine", name: "Zucchine", category: "🥬 Verdura", unit: "g" },
  { id: "cetriolo", name: "Cetriolo", category: "🥬 Verdura", unit: "g" },
  { id: "melone", name: "Melone", category: "🍑 Frutta", unit: "g" },
  { id: "avocado", name: "Avocado", category: "🍑 Frutta", unit: "pz" },
  { id: "frutta_stagione", name: "Frutta fresca stagionale", category: "🍑 Frutta", unit: "g" },
  { id: "whey", name: "Proteine Whey", category: "🥫 Dispensa", unit: "g" },
  { id: "marmellata", name: "Marmellata", category: "🥫 Dispensa", unit: "g" },
  { id: "miele", name: "Miele", category: "🥫 Dispensa", unit: "g" }
];
