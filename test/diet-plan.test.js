'use strict';
/* Dieta guidata — modello descrittivo versionato (dietPlan v1) + editor.
 *
 * Contratto verificato senza rete:
 *  - vocabolario condiviso (giornate, pasti, gruppi, unità, opzioni A–D);
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
                label: 'A', note: '',
                items: [
                  { foodGroup: 'cereali', description: 'Riso Venere', quantity: 80, unit: 'g', quantityState: 'crudo', netOfWaste: false, alternative: 'Pasta integrale 80 g' },
                  { foodGroup: 'verdura', description: 'Zucchine', quantity: 200, unit: 'g', quantityState: null, netOfWaste: true, alternative: '' }
                ]
              },
              {
                label: 'B', note: '',
                items: [{ foodGroup: 'cereali', description: 'Pane integrale', quantity: 100, unit: 'g', quantityState: null, netOfWaste: false, alternative: '' }]
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
                label: 'A', note: '',
                items: [{ foodGroup: 'pesce', description: 'Salmone', quantity: 150, unit: 'g', quantityState: 'crudo', netOfWaste: false, alternative: '' }]
              }
            ]
          }
        ],
        supplements: '', hydration: '', note: ''
      }
    ]
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
  assert.deepEqual(domain.DIET_PLAN_LIMITS, { days: 14, mealsPerDay: 10, optionsPerMeal: 4, itemsPerOption: 20, label: 80, description: 200, note: 1000, quantity: 5000 });
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
  assert.equal(item.netOfWaste, false);
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

test('riepilogo per l’anteprima: solo conteggi, nessun calcolo clinico', () => {
  const summary = domain.dietPlanSummary(validPlan());
  assert.deepEqual(summary, { dayCount: 2, mealCount: 2, optionCount: 3, itemCount: 4 });
  assert.deepEqual(Object.keys(summary).sort(), ['dayCount', 'itemCount', 'mealCount', 'optionCount']);
  assert.deepEqual(domain.dietPlanSummary(null), { dayCount: 0, mealCount: 0, optionCount: 0, itemCount: 0 });
});

test('editor console: dialog guidato, anteprima, operazioni strutturali', () => {
  for (const id of ['new-diet-plan', 'diet-plan-dialog', 'diet-plan-title', 'diet-plan-form', 'diet-plan-id', 'diet-plan-name', 'diet-plan-days', 'diet-plan-add-day', 'diet-plan-general-notes', 'diet-plan-preview-toggle', 'diet-plan-preview', 'diet-plan-error', 'diet-plan-submit', 'diet-plan-classic-note']) {
    assert.match(html, new RegExp(`id="${id}"`), `manca #${id}`);
  }
  assert.match(html, /aria-labelledby="diet-plan-title"/);
  assert.match(html, /nessun calcolo automatico/);
  for (const fn of ['openDietPlanDialog', 'closeDietPlanDialog', 'collectDietPlan', 'submitDietPlan', 'renderDietPlanDays', 'renderDietPlanPreview', 'handleDietPlanStructure']) {
    assert.match(js, new RegExp(`function ${fn}\\b`), `manca ${fn}`);
  }
  // Le operazioni strutturali non perdono il digitato: rilettura prima di modificare.
  assert.match(js, /collectDietPlan\(\);\s*adminState\.dietPlan = plan;/);
  // Anteprima viva e riepilogo con conteggi.
  assert.match(js, /dietPlanSummary\(plan\)/);
  assert.match(js, /Opzione \$\{escapeAdmin/);
  // Stili dell'editor e responsive.
  for (const cls of ['diet-days', 'diet-day', 'diet-meal', 'diet-option', 'diet-item', 'diet-preview', 'preview-day']) {
    assert.match(css, new RegExp(`\\.${cls}\\b`), `manca .${cls}`);
  }
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
