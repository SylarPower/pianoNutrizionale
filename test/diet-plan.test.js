'use strict';
/* Dieta guidata — modello descrittivo versionato (dietPlan v1) + editor.
 *
 * Contratto verificato senza rete:
 *  - vocabolario condiviso (giornate, pasti, gruppi, unità, opzioni A–D, tipi opzione);
 *  - opzioni di due tipi mutuamente esclusivi: «free-foods» oppure «recipe»;
 *  - gruppi scelta («Scegli 1 tra:») con alternative a dose editabile;
 *  - pesi sempre al netto degli scarti e a crudo (campi crudo/cotto rimossi);
 *  - ordine pasti fisso e stabile, nessun riordino manuale dei pasti;
 *  - builder puri e pre-validazione console in italiano;
 *  - riepilogo per l'anteprima (conteggi, mai calcoli clinici);
 *  - markup e logica dell'editor nella console (dialog, anteprima, routing).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/admin.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'js/admin.js'), 'utf8');
const domain = require('../js/domain.js');

function validPlan() {
  return {
    schemaVersion: 1,
    generalNotes: 'Bere durante i pasti.',
    days: [
      {
        dayId: null, label: 'Lunedì', dayType: 'training',
        target: { kcal: 2200, proteinG: 140, carbsG: 260, fatG: 70, waterMl: 2000 },
        meals: [
          {
            mealId: 'lunch', time: '12:30', note: '',
            options: [
              {
                label: 'A', type: 'free-foods', recipeId: null, recipeMultiplier: null, note: '',
                items: [
                  { foodGroup: 'cereali', description: 'Riso Venere', quantity: 80, unit: 'g' },
                  { foodGroup: 'verdura', description: 'Zucchine', quantity: 200, unit: 'g' }
                ],
                choiceGroups: [{
                  title: 'Scegli 1 carboidrato tra:', optional: true,
                  alternatives: [
                    { foodGroup: 'cereali', description: 'Riso basmati', quantity: 80, unit: 'g' },
                    { foodGroup: 'cereali', description: 'Pasta integrale', quantity: 80, unit: 'g' }
                  ]
                }]
              },
              {
                label: 'B', type: 'recipe', recipeId: 'ricetta-pollo', recipeMultiplier: 1.5, note: '',
                items: [], choiceGroups: []
              }
            ]
          }
        ],
        supplements: 'Vitamina D', hydration: '2 litri', note: ''
      },
      {
        dayId: null, label: '', dayType: 'rest',
        target: { kcal: null, proteinG: null, carbsG: null, fatG: null, waterMl: null },
        meals: [
          {
            mealId: 'dinner', time: '', note: '',
            options: [
              {
                label: 'A', type: 'free-foods', recipeId: null, recipeMultiplier: null, note: '',
                items: [{ foodGroup: 'pesce', description: 'Salmone', quantity: 150, unit: 'g' }],
                choiceGroups: []
              }
            ]
          }
        ],
        supplements: '', hydration: '', note: ''
      }
    ]
  };
}

// Revisione salvata prima dell'evoluzione del contratto: campi peso rimossi
// e opzioni senza `type`. Deve ancora aprirsi (normalizzarsi) nell'editor.
function legacyPlan() {
  return {
    schemaVersion: 1,
    generalNotes: '',
    days: [{
      dayId: null, label: 'Vecchia', dayType: 'training',
      target: { kcal: null, proteinG: null, carbsG: null, fatG: null, waterMl: null },
      meals: [
        {
          mealId: 'dinner', time: '20:00', note: '',
          options: [{
            label: 'A', note: '',
            items: [{ foodGroup: 'cereali', description: 'Riso', quantity: 80, unit: 'g', quantityState: 'crudo', netOfWaste: true, alternative: 'Pasta 80 g' }]
          }]
        },
        { mealId: 'breakfast', time: '', note: '', options: [{ label: 'A', note: '', items: [{ foodGroup: 'latticini', description: 'Yogurt greco', quantity: 200, unit: 'g', quantityState: null, netOfWaste: false, alternative: '' }] }] }
      ]
    }],
    supplements: '', hydration: '', note: ''
  };
}

test('vocabolario condiviso: versioni, tipi, pasti, gruppi, unità, opzioni', () => {
  assert.equal(domain.DIET_PLAN_SCHEMA_VERSION, 1);
  assert.deepEqual(domain.DIET_PLAN_DAY_TYPES, ['training', 'rest', 'other']);
  assert.equal(domain.dietPlanDayLabel('training'), 'Giornata di allenamento');
  assert.equal(domain.dietPlanDayLabel('rest'), 'Giornata di riposo');
  assert.equal(domain.dietPlanDayLabel('other'), 'Altra giornata');
  assert.ok(domain.DIET_PLAN_MEALS.some(item => item.id === 'lunch' && item.label === 'Pranzo'));
  assert.ok(domain.DIET_PLAN_MEALS.length >= 5, 'colazione, spuntini, pranzo, cena');
  assert.ok(domain.DIET_PLAN_FOOD_GROUPS.length >= 10, 'gruppi alimentari coperti');
  assert.equal(domain.dietPlanFoodGroupLabel('verdura'), 'Verdura e ortaggi');
  assert.ok(domain.DIET_PLAN_UNITS.some(item => item.id === 'g'));
  assert.ok(domain.DIET_PLAN_UNITS.some(item => item.id === 'qb'), 'quanto basta ammesso');
  assert.deepEqual(domain.DIET_PLAN_OPTION_LABELS, ['A', 'B', 'C', 'D']);
  assert.deepEqual(domain.DIET_PLAN_OPTION_TYPES.map(item => item.id), ['free-foods', 'recipe']);
  assert.equal(domain.DIET_PLAN_LIMITS.days, 14);
  assert.equal(domain.DIET_PLAN_LIMITS.mealsPerDay, 10);
  assert.equal(domain.DIET_PLAN_LIMITS.optionsPerMeal, 4);
  assert.equal(domain.DIET_PLAN_LIMITS.itemsPerOption, 20);
  assert.equal(domain.DIET_PLAN_LIMITS.choiceGroupsPerOption, 3);
  assert.equal(domain.DIET_PLAN_LIMITS.alternativesPerChoiceGroup, 30);
  assert.equal(domain.DIET_PLAN_LIMITS.recipeMultiplierMin, 0.1);
  assert.equal(domain.DIET_PLAN_LIMITS.recipeMultiplierMax, 10);
});

test('builder puri: piano vuoto con allenamento + riposo e valori nulli', () => {
  const empty = domain.createEmptyDietPlan();
  assert.equal(empty.schemaVersion, 1);
  assert.equal(empty.days.length, 2);
  assert.equal(empty.days[0].dayType, 'training');
  assert.equal(empty.days[1].dayType, 'rest');
  assert.ok(empty.days[0].meals.length >= 3, 'colazione, pranzo e cena di partenza');
  assert.equal(empty.days[0].target.kcal, null);
  const item = domain.createDietPlanItem();
  assert.equal(item.unit, 'g');
  assert.equal(item.quantity, null);
  // Pesi sempre al netto e a crudo: i campi rimossi non esistono più.
  assert.deepEqual(Object.keys(item).sort(), ['description', 'foodGroup', 'quantity', 'unit']);
});

test('ordine pasti fisso e stabile, nessun riordino manuale', () => {
  const ids = domain.DIET_PLAN_MEALS.map(meal => meal.id);
  assert.deepEqual(ids, ['breakfast', 'morning-snack', 'lunch', 'afternoon-snack', 'dinner', 'evening-snack']);
  // La giornata si normalizza sempre nell'ordine fisso, qualunque sia l'ordine in entrata.
  const day = domain.createDietPlanDay('training', { meals: [
    { mealId: 'dinner', options: [{ label: 'A', items: [{ foodGroup: 'altro', description: 'X', quantity: null, unit: null }] }] },
    { mealId: 'breakfast', options: [{ label: 'A', items: [{ foodGroup: 'altro', description: 'Y', quantity: null, unit: null }] }] },
    { mealId: 'lunch', options: [{ label: 'A', items: [{ foodGroup: 'altro', description: 'Z', quantity: null, unit: null }] }] }
  ] });
  assert.deepEqual(day.meals.map(meal => meal.mealId), ['breakfast', 'lunch', 'dinner']);
  // Sort stabile: tipi ripetuti (solo legacy) restano nell'ordine relativo di arrivo.
  const dup = domain.sortDietPlanMeals([
    { mealId: 'lunch', options: [] },
    { mealId: 'breakfast', options: [] },
    { mealId: 'lunch', options: [] }
  ]);
  assert.deepEqual(dup.map(meal => meal.mealId), ['breakfast', 'lunch', 'lunch']);
  assert.equal(domain.dietPlanMealOrder('lunch'), 2);
  assert.equal(domain.dietPlanMealOrder('tipo-inesistente'), domain.DIET_PLAN_MEALS.length);
});

test('migrazione: revisioni vecchie (crudo/cotto, netto, oppure) si aprono e si normalizzano', () => {
  const normalized = domain.createEmptyDietPlan(legacyPlan());
  assert.equal(normalized.schemaVersion, 1);
  const option = normalized.days[0].meals[0].options[0];
  assert.equal(option.type, 'free-foods', 'opzione senza type diventa alimenti liberi');
  assert.deepEqual(Object.keys(option.items[0]).sort(), ['description', 'foodGroup', 'quantity', 'unit'], 'campi peso rimossi ignorati');
  assert.deepEqual(normalized.days[0].meals.map(meal => meal.mealId), ['breakfast', 'dinner'], 'pasti riportati all\'ordine fisso');
  const check = domain.validateDietPlanSoft(normalized);
  assert.equal(check.valid, true, `piano migrato valido: ${check.errors.join(' | ')}`);
});

test('opzioni: due tipi mutuamente esclusivi con ricetta e moltiplicatore', () => {
  const recipe = domain.createDietPlanOption('A', { type: 'recipe', recipeId: 'ric-1', recipeMultiplier: 2, items: [{ foodGroup: 'carne', description: 'Fantasma', quantity: 1, unit: 'g' }] });
  assert.equal(recipe.type, 'recipe');
  assert.equal(recipe.recipeId, 'ric-1');
  assert.equal(recipe.recipeMultiplier, 2);
  assert.deepEqual(recipe.items, [], 'le opzioni ricetta non hanno lista alimenti');
  assert.deepEqual(recipe.choiceGroups, []);
  const food = domain.createDietPlanOption('B', {});
  assert.equal(food.type, 'free-foods');
  assert.equal(food.recipeId, null);
  assert.equal(food.recipeMultiplier, null);
  assert.equal(food.items.length, 1);
  // Il moltiplicatore rientra sempre nei limiti.
  assert.equal(domain.createDietPlanOption('A', { type: 'recipe', recipeId: 'r', recipeMultiplier: 99 }).recipeMultiplier, 10);
  assert.equal(domain.createDietPlanOption('A', { type: 'recipe', recipeId: 'r', recipeMultiplier: 0 }).recipeMultiplier, 0.1);
  assert.equal(domain.createDietPlanOption('A', { type: 'recipe', recipeId: 'r' }).recipeMultiplier, 1);
});

test('gruppi scelta: titolo, facoltatività e alternative a dose editabile', () => {
  const group = domain.createDietPlanChoiceGroup({ title: 'Scegli 1 tra:', alternatives: [
    { foodGroup: 'cereali', description: 'Riso', quantity: 80, unit: 'g' },
    { foodGroup: 'cereali', description: 'Pane', quantity: 100, unit: 'g' }
  ] });
  assert.equal(group.optional, true, 'la scelta è facoltativa di default (il cliente può saltare)');
  assert.equal(group.alternatives.length, 2);
  assert.deepEqual(Object.keys(group.alternatives[0]).sort(), ['description', 'foodGroup', 'quantity', 'unit']);
  const empty = domain.createDietPlanChoiceGroup();
  assert.equal(empty.title, '');
  assert.equal(empty.alternatives.length, 1);
});

test('pre-validazione console: piano valido e messaggi in italiano', () => {
  assert.deepEqual(domain.validateDietPlanSoft(validPlan()), { valid: true, errors: [] });
  const bad = validPlan();
  bad.days[0].dayType = 'festa';
  bad.days[0].meals[0].options[0].items[0].description = '  ';
  bad.days[0].meals[0].options[1].label = 'A';
  bad.days[1].meals[0].options[0].items[0].quantity = 99999;
  const check = domain.validateDietPlanSoft(bad);
  assert.equal(check.valid, false);
  assert.ok(check.errors.length >= 4, `attesi almeno 4 errori, avuti: ${check.errors.join(' | ')}`);
  assert.ok(check.errors.some(message => message.includes('tipo giornata')), 'tipo giornata non valido');
  assert.ok(check.errors.some(message => message.includes('Descrivi l’alimento') || message.includes('descrivi')), 'alimento senza descrizione');
  assert.ok(check.errors.some(message => message.includes('duplicata')), 'opzione duplicata');
  assert.ok(check.errors.some(message => message.includes('quantità')), 'quantità fuori limite');
});

test('pre-validazione console: opzione ricetta senza ricetta o moltiplicatore assurdo', () => {
  const noRecipe = validPlan();
  noRecipe.days[0].meals[0].options[1].recipeId = null;
  let check = domain.validateDietPlanSoft(noRecipe);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some(message => message.includes('Seleziona la ricetta')), 'ricetta mancante');
  const badMult = validPlan();
  badMult.days[0].meals[0].options[1].recipeMultiplier = 50;
  check = domain.validateDietPlanSoft(badMult);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some(message => message.includes('Moltiplicatore ricetta')), 'moltiplicatore fuori scala');
  const okMult = validPlan();
  okMult.days[0].meals[0].options[1].recipeMultiplier = 0.1;
  assert.deepEqual(domain.validateDietPlanSoft(okMult), { valid: true, errors: [] });
});

test('pre-validazione console: gruppi scelta incompleti segnalati in italiano', () => {
  const noTitle = validPlan();
  noTitle.days[0].meals[0].options[0].choiceGroups[0].title = '   ';
  let check = domain.validateDietPlanSoft(noTitle);
  assert.ok(check.errors.some(message => message.includes('titolo')), 'titolo gruppo obbligatorio');
  const noAlternatives = validPlan();
  noAlternatives.days[0].meals[0].options[0].choiceGroups[0].alternatives = [];
  check = domain.validateDietPlanSoft(noAlternatives);
  assert.ok(check.errors.some(message => message.includes('alternative')), 'alternative obbligatorie');
  const badAlt = validPlan();
  badAlt.days[0].meals[0].options[0].choiceGroups[0].alternatives[0].description = '';
  check = domain.validateDietPlanSoft(badAlt);
  assert.ok(check.errors.some(message => message.includes('alternativa 1')), 'alternativa senza descrizione');
  // Opzione con soli gruppi scelta (nessun alimento): ammessa.
  const onlyGroup = validPlan();
  onlyGroup.days[0].meals[0].options[0].items = [];
  assert.deepEqual(domain.validateDietPlanSoft(onlyGroup), { valid: true, errors: [] });
  // Opzione completamente vuota: rifiutata.
  const emptyOption = validPlan();
  emptyOption.days[0].meals[0].options[0].items = [];
  emptyOption.days[0].meals[0].options[0].choiceGroups = [];
  check = domain.validateDietPlanSoft(emptyOption);
  assert.ok(check.errors.some(message => message.includes('almeno un alimento o un gruppo scelta')));
});

test('riepilogo per l’anteprima: solo conteggi, nessun calcolo clinico', () => {
  const summary = domain.dietPlanSummary(validPlan());
  assert.deepEqual(summary, { dayCount: 2, mealCount: 2, optionCount: 3, itemCount: 3, choiceGroupCount: 1 });
  assert.deepEqual(Object.keys(summary).sort(), ['choiceGroupCount', 'dayCount', 'itemCount', 'mealCount', 'optionCount']);
  assert.deepEqual(domain.dietPlanSummary(null), { dayCount: 0, mealCount: 0, optionCount: 0, itemCount: 0, choiceGroupCount: 0 });
});

test('moltiplicatore ricetta: le dosi di testo scalano per valore (anche le frazioni)', () => {
  assert.equal(domain.scalePortionText('80 g', 1.5), '120 g');
  assert.equal(domain.scalePortionText('55 g', 1.3), '71,5 g');
  assert.equal(domain.scalePortionText('q.b.', 2), 'q.b.', 'testi senza numeri invariati');
  assert.equal(domain.scalePortionText('80 g', 1), '80 g', 'moltiplicatore 1 = testo originale');
  assert.equal(domain.scalePortionText('1/2 panino', 2), '1 panino', 'le frazioni scalano per valore');
  assert.equal(domain.scalePortionText('1 fetta', 0.5), '0,5 fetta');
  assert.equal(domain.scalePortionText('100 ml', 0.25), '25 ml');
});

test('precompilazione gruppi scelta dalla tabella di riferimento', () => {
  const carbs = domain.dietPlanReferenceAlternatives('carb', 'lunch', 'training');
  assert.ok(carbs.length >= 12, 'tutti i carboidrati della tabella');
  assert.ok(carbs.every(item => item.quantity > 0 && item.unit === 'g' && item.description));
  const carbsRest = domain.dietPlanReferenceAlternatives('carb', 'lunch', 'rest');
  const paneTraining = carbs.find(item => item.description === 'Pane');
  const paneRest = carbsRest.find(item => item.description === 'Pane');
  assert.ok(paneTraining.quantity > paneRest.quantity, 'pranzo: colonna A maggiore della colonna R');
  const dinner = domain.dietPlanReferenceAlternatives('carb', 'dinner', 'training');
  const paneDinner = dinner.find(item => item.description === 'Pane');
  assert.equal(paneDinner.quantity, 50, 'cena: dose serale esplicita');
  const proteins = domain.dietPlanReferenceAlternatives('protein', 'dinner', 'rest');
  assert.ok(proteins.length >= 25, 'tutte le fonti proteiche della tabella');
  assert.equal(domain.dietPlanReferenceAlternatives('protein', 'dinner', 'rest')[0].description, 'Pollo e tacchino', 'riga di riferimento in testa');
  assert.equal(domain.dietPlanReferenceGroupTitle('carb'), 'Scegli 1 carboidrato tra:');
  assert.equal(domain.dietPlanReferenceGroupTitle('protein'), 'Scegli 1 fonte proteica tra:');
});

test('editor console: dialog guidato, anteprima, operazioni strutturali', () => {
  for (const id of ['new-diet-plan', 'diet-plan-dialog', 'diet-plan-title', 'diet-plan-form', 'diet-plan-id', 'diet-plan-name', 'diet-plan-days', 'diet-plan-add-day', 'diet-plan-general-notes', 'diet-plan-preview-toggle', 'diet-plan-preview', 'diet-plan-error', 'diet-plan-submit', 'diet-plan-classic-note', 'diet-catalog-options']) {
    assert.match(html, new RegExp(`id="${id}"`), `manca #${id}`);
  }
  assert.match(html, /aria-labelledby="diet-plan-title"/);
  assert.match(html, /dal catalogo/);
  assert.doesNotMatch(html, /Valori della giornata|nessun calcolo automatico/);
  assert.doesNotMatch(js, /Valori della giornata/);
  assert.match(js, /list="diet-catalog-options"/);
  assert.match(js, /data-act="item-del"/);
  assert.match(js, /if \(option && itemIndex >= 0\) option\.items\.splice/);
  for (const fn of ['openDietPlanDialog', 'closeDietPlanDialog', 'collectDietPlan', 'submitDietPlan', 'renderDietPlanDays', 'renderDietPlanPreview', 'handleDietPlanStructure', 'updateDietRecipePreview']) {
    assert.match(js, new RegExp(`function ${fn}\\b`), `manca ${fn}`);
  }
  // Le operazioni strutturali non perdono il digitato: rilettura prima di modificare.
  assert.match(js, /collectDietPlan\(\);\s*adminState\.dietPlan = plan;/);
  // Anteprima viva e riepilogo con conteggi.
  assert.match(js, /dietPlanSummary\(plan\)/);
  assert.match(js, /Opzione \$\{escapeAdmin/);
  // Stili dell'editor e responsive.
  for (const cls of ['diet-days', 'diet-day', 'diet-meal', 'diet-option', 'diet-item', 'diet-preview', 'preview-day', 'diet-choice-group', 'diet-recipe-preview', 'diet-add-chip']) {
    assert.match(css, new RegExp(`\\.${cls}\\b`), `manca .${cls}`);
  }
});

test('editor console: pasti in ordine fisso, aggiunta solo per tipi mancanti', () => {
  // La testa del pasto mostra l'etichetta fissa: nessun menu per cambiare tipo.
  assert.match(js, /diet-meal-name">\$\{escapeAdmin\(domain\.dietPlanMealLabel\(meal\.mealId\)\)\}/);
  assert.doesNotMatch(js, /data-f="meal-id"/, 'il tipo pasto non è più rordinabile dal menu');
  // «＋ Aggiungi pasto» propone solo i tipi assenti, uno per tipo.
  assert.match(js, /function dietMealAddChips/);
  assert.match(js, /data-act="meal-add" data-meal-type="\$\{meal\.id\}"/);
  assert.match(js, /!day\.meals\.some\(item => item\.mealId === mealType\)/);
  // Il collect riporta i pasti all'ordine fisso del modello.
  assert.match(js, /domain\?\.sortDietPlanMeals \? domain\.sortDietPlanMeals\(day\.meals\) : day\.meals/);
});

test('editor console: opzioni ricetta con selettore, moltiplicatore e anteprima dosi', () => {
  assert.match(js, /data-f="option-type"/);
  assert.match(js, /data-act="option-type" data-option-type="recipe"/);
  assert.match(js, /data-f="option-recipe"/);
  assert.match(js, /data-f="option-mult"/);
  assert.match(js, /function dietRecipeOptions/);
  assert.match(js, /scalePortionText/, 'le dosi mostrate scalano col moltiplicatore');
  assert.match(js, /professionalRecipes\.find\(item => item\.id === recipeId\)/);
  // Le opzioni ricetta non mostrano la lista alimenti (tipi esclusivi).
  assert.match(js, /const itemsBlock = isRecipe \? '' :/);
});

test('editor console: gruppi scelta minimizzati con precompilazione dalla tabella', () => {
  assert.match(js, /function dietChoiceGroupHtml/);
  assert.match(js, /data-act="cg-toggle"/);
  assert.match(js, /data-act="cg-prefill"/);
  assert.match(js, /dietPlanReferenceGroupTitle\(kind\)/);
  assert.match(js, /data-f="cg-optional"/, 'la scelta può essere facoltativa (il cliente può saltare)');
  // Il gruppo si minimizza quando è completo: dopo il precompilamento si richiude.
  assert.match(js, /dietChoiceGroupsExpanded\.delete\(`\$\{dayIndex\}:\$\{mealIndex\}:\$\{optionIndex\}:\$\{cgIndex\}`\);\s*\}\s*break;\s*\}\s*default:/);
  assert.match(css, /\.diet-choice-group:not\(\.expanded\) \.diet-choice-body\{display:none\}/);
});

test('editor console: la precompilazione attinge dalla tabella grammature scelta', () => {
  // Il selettore della tabella vive nel dialog della dieta guidata.
  assert.match(html, /id="diet-plan-gram-table"/);
  // L'helper sceglie tra tabella personale e riferimento guida integrato.
  assert.match(js, /function dietPlanPrefillAlternatives/);
  assert.match(js, /dietPlanTableAlternatives\(table, kind, mealId, dayType\)/);
  assert.match(js, /domain\.dietPlanReferenceAlternatives\(kind, mealId, dayType\)/);
  assert.match(js, /function renderDietPlanGramTableSelect/);
  // Il dominio sa leggere le alternative da una tabella del nutrizionista.
  assert.equal(typeof domain.dietPlanTableAlternatives, 'function');
  const table = { rows: [
    { description: 'Riso', group: 'carb', foodGroup: 'cereali', doses: { lunch: { training: 80, rest: 60 }, dinner: { training: 50, rest: 50 } } },
    { description: 'Pollo', group: 'protein', foodGroup: 'carne', doses: { lunch: { training: 200, rest: 200 }, dinner: { training: 200, rest: 200 } } }
  ] };
  const carbLunch = domain.dietPlanTableAlternatives(table, 'carb', 'lunch', 'rest');
  assert.equal(carbLunch.length, 1);
  assert.equal(carbLunch[0].quantity, 60, 'pranzo riposo: colonna R');
  const carbDinner = domain.dietPlanTableAlternatives(table, 'carb', 'dinner', 'training');
  assert.equal(carbDinner[0].quantity, 50, 'cena: dose serale');
  const proteins = domain.dietPlanTableAlternatives(table, 'protein', 'lunch', 'training');
  assert.equal(proteins.length, 1);
  assert.equal(proteins[0].foodGroup, 'carne');
});

test('editor console: i pasti partono minimizzati', () => {
  // Stato dei pasti espansi azzerato all'apertura dell'editor.
  assert.match(js, /dietMealsExpanded\.clear\(\)/);
  assert.match(js, /data-act="meal-toggle"/);
  // Corpo del pasto nascosto finché non è espanso.
  assert.match(css, /\.diet-meal:not\(\.expanded\) \.diet-meal-body\{display:none\}/);
  // Riepilogo compatto visibile solo a pasto ridotto.
  assert.match(js, /function dietMealSummary/);
});

test('editor console: duplicazione giornata con nuova identità', () => {
  // La copia non riusa il dayId dell'originale e il titolo dice «(copia)».
  assert.match(js, /case 'day-dup': \{/);
  assert.match(js, /copy\.dayId = null;/);
  assert.match(js, /copy\.label = day\.label \? `\$\{day\.label\} \(copia\)` : '';/);
  assert.match(js, /plan\.days\.splice\(dayIndex \+ 1, 0, copy\)/);
});

test('compatibilità: classico conserva il piano guidato, routing per flag', () => {
  // L'editor classico non cancella il piano guidato: lo conserva e lo dice.
  assert.match(html, /id="structure-plan-note"/);
  assert.match(js, /adminState\.editingDietPlan/);
  assert.match(js, /dietPlan: adminState\.editingDietPlan \|\| null/);
  assert.match(js, /il salvataggio lo conserva così com’è/);
  // Badge e routing: le guidate si aprono con l'editor guidato.
  assert.match(js, /Dieta guidata/);
  assert.match(js, /function openStructureEditor\(structureId\)/);
  assert.match(js, /item\?\.hasDietPlan/);
  assert.match(css, /\.status-plan/);
  // Creazione classica invariata: niente piano di default.
  assert.match(js, /dietPlan: null, idempotencyKey/);
});
