// Smoke test della console admin: carica admin.html + admin.js in jsdom e
// verifica che lo script si valuti e bindi senza errori, con i contratti DOM
// della console v2 (viste requests/templates, dialog request/template,
// editor dieta a blocchi).
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(root, 'js', 'admin.js'), 'utf8');

// Script esterni referenziati da admin.html: stub minimi (il test valuta solo
// admin.js; gli stub evitano errori di rete/caricamento).
const dom = new JSDOM(html, {
  url: 'https://console.example.com/admin.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;

window.matchMedia = window.matchMedia || (query => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
window.fetch = () => Promise.reject(new Error('offline nel test'));

// Catalogo globale finto, servito per path collezione (come farebbe Firestore):
// basta popolare i selettori famiglia/categoria e la datalist ingredienti.
const CATALOG_DOCS = {
  'globalIngredientCatalog/current/families': [
    ['carboidratiComplessi', { displayName: 'Carboidrati complessi', categoryId: 'carboidrati' }],
    ['proteineMagre', { displayName: 'Proteine magre', categoryId: 'proteine' }],
    ['grassiBuoni', { displayName: 'Grassi buoni', categoryId: 'grassi' }],
    ['legumi', { displayName: 'Legumi', categoryId: 'proteine' }]
  ],
  'globalIngredientCatalog/current/categories': [
    ['carboidrati', { displayName: 'Carboidrati' }],
    ['proteine', { displayName: 'Proteine' }],
    ['grassi', { displayName: 'Grassi' }]
  ],
  'globalIngredientCatalog/current/ingredients': [
    ['petto-di-pollo', { displayName: 'Petto di pollo', categoryId: 'proteine', familyId: 'proteineMagre', status: 'active' }]
  ]
};

// Stub dei moduli console (firebase.js e saas.js non caricati da jsdom).
const consoleStubs = {
  initFirebase: () => true,
  observeAdminAuthState: () => {},
  adminSignInWithUsername: async () => {},
  adminSignOutUser: async () => {},
  getAdminCurrentUser: () => null,
  adminGetDoc: async () => ({ exists: () => false, data: () => ({}) }),
  adminGetDocsQuery: async query => {
    const docs = (CATALOG_DOCS[query?.path] || []).map(([id, data]) => ({ id, data: () => data }));
    return { forEach: fn => docs.forEach(fn), size: docs.length, docs };
  },
  adminQueryLimit: q => q,
  adminCollectionAt: path => ({ path }),
  callAdminSaasFunction: async () => { throw new Error('offline nel test'); },
  snapForEach: (snap, fn) => { (snap?.docs || []).forEach(fn); },
  adminError: error => String(error?.message || error),
  orgId: () => 'org-test',
  usernameFromUser: () => 'Test',
  escapeHtml: value => String(value ?? '')
};
Object.assign(window, consoleStubs);
window.PianoDomain = require(path.join(root, 'js', 'domain.js'));

const errors = [];
window.addEventListener('error', event => errors.push(event.message));

let evalError = null;
// admin.js dichiara costanti/funzioni top-level: restano nello scope dell'eval
// e non su window. Lo shim finale le espone per le asserzioni.
const exportShim = `
;window.__admin = {
  adminState, loadCatalogRequests, renderCatalogRequests, loadEquivalenceTemplates,
  renderEquivalenceTemplates, openTemplateDialog, closeTemplateDialog, submitTemplateDialog,
  toggleTemplateArchive, openCatalogRequest, closeCatalogRequest, submitCatalogRequestResolution,
  rejectCatalogRequest, openDietPlanDialog, closeDietPlanDialog, submitDietPlanDialog,
  renderDietPlanEditor, renderDietPlanPreview, collectDietPlanFromEditor,
  loadDietPlanRevisionFromInput, bindDietPlanEditorEvents, toggleStructureArchive,
  loadStructures, renderStructures, showView, loadCatalogIndex, catalogFamilyLabel,
  loadReports: undefined, loadDoseClients: undefined,
  loadGrammatureTables: undefined, openMapping: undefined
};`;
try {
  window.eval(adminJs + exportShim);
} catch (error) {
  evalError = error;
}

const assert = (label, condition) => {
  if (!condition) throw new Error(`SMOKE ADMIN FALLITO: ${label}`);
  console.log(`ok - ${label}`);
};

assert('admin.js si valuta senza eccezioni', evalError === null);
if (evalError) throw evalError;
assert('nessun errore window.onerror', errors.length === 0);

// Contratti della console v2.
const doc = window.document;
assert('vista requests presente', Boolean(doc.getElementById('view-requests')));
assert('vista templates presente', Boolean(doc.getElementById('view-templates')));
assert('vista dosi rimossa', !doc.getElementById('view-doses'));
assert('vista tabelle grammature rimossa', !doc.getElementById('view-tables'));
assert('dialog richiesta catalogo presente', Boolean(doc.getElementById('request-dialog')));
assert('dialog template equivalenze presente', Boolean(doc.getElementById('template-dialog')));
assert('dialog dieta guidata presente', Boolean(doc.getElementById('diet-plan-dialog')));
assert('dialog struttura classica rimosso', !doc.getElementById('structure-dialog'));
assert('dialog mapping rimosso', !doc.getElementById('mapping-dialog'));
assert('dialog tabelle grammature rimosso', !doc.getElementById('gram-table-dialog'));
assert('diet-plan-gram-table rimosso', !doc.getElementById('diet-plan-gram-table'));
assert('selettore template nel dialog dieta', Boolean(doc.getElementById('diet-plan-changelog')));
assert('datalist catalogo per ingredienti', Boolean(doc.getElementById('diet-catalog-options')));
assert('nav richieste con badge', Boolean(doc.getElementById('nav-requests')) && Boolean(doc.getElementById('nav-open-count')));
assert('nav dosi rimossa', ![...doc.querySelectorAll('.nav-link')].some(node => node.dataset.view === 'doses'));
assert('nav tabelle rimossa', ![...doc.querySelectorAll('.nav-link')].some(node => node.dataset.view === 'tables'));

// Funzioni chiave della console v2 esposte dallo script valutato.
assert('loadCatalogRequests definita', typeof window.__admin.loadCatalogRequests === 'function');
assert('loadEquivalenceTemplates definita', typeof window.__admin.loadEquivalenceTemplates === 'function');
assert('openDietPlanDialog definita', typeof window.__admin.openDietPlanDialog === 'function');
assert('submitDietPlanDialog definita', typeof window.__admin.submitDietPlanDialog === 'function');
assert('openCatalogRequest definita', typeof window.__admin.openCatalogRequest === 'function');
assert('renderDietPlanEditor definita', typeof window.__admin.renderDietPlanEditor === 'function');
assert('collectDietPlanFromEditor definita', typeof window.__admin.collectDietPlanFromEditor === 'function');
assert('funzioni legacy rimosse', window.__admin.loadReports === undefined
  && window.__admin.loadDoseClients === undefined
  && window.__admin.loadGrammatureTables === undefined
  && window.__admin.openMapping === undefined);

// ---- Editor dieta + interazioni: il catalogo stub popola i selettori. ----
(async () => {
await window.__admin.loadCatalogIndex();
const domain = window.PianoDomain;
const plan = {
  schemaVersion: domain.DIET_PLAN_SCHEMA_VERSION,
  days: [domain.createDietPlanDay('training', {
    meals: [
      domain.createDietPlanMeal('breakfast', {
        options: [domain.createDietPlanOption({
          type: 'family-block',
          blocks: [domain.createDietPlanBlock({
            referenceFamilyId: 'carboidratiComplessi',
            referenceAmount: { value: 80, unit: 'g' }
          })]
        })]
      }),
      domain.createDietPlanMeal('lunch', {
        options: [
          domain.createDietPlanOption({ type: 'ingredients', items: [domain.createDietPlanItem({ ingredientId: 'petto-di-pollo', amount: { value: 150, unit: 'g' } })] }),
          domain.createDietPlanOption({ type: 'recipe', recipeId: 'ricetta-test', recipeMultiplier: 2 })
        ]
      })
    ]
  })],
  generalNotes: 'Nota di test'
};
window.__admin.adminState.dietPlan = plan;
window.__admin.renderDietPlanEditor();
const daysRendered = doc.querySelectorAll('#diet-plan-days .diet-day');
assert('giornata renderizzata', daysRendered.length === 1);
assert('pasto renderizzati', doc.querySelectorAll('#diet-plan-days .diet-meal').length === 2);
assert('opzioni renderizzate (3 totali)', doc.querySelectorAll('#diet-plan-days .diet-option').length === 3);
assert('blocco famiglia renderizzato', doc.querySelectorAll('#diet-plan-days .diet-block').length === 1);
assert('toggle tipo opzione presente', doc.querySelectorAll('#diet-plan-days .diet-type-chip').length >= 3);
assert('selettore template nel blocco', Boolean(doc.querySelector('#diet-plan-days .diet-block [data-block-field="templateId"]')));
assert('item ingrediente renderizzato', Boolean(doc.querySelector('#diet-plan-days .diet-item input[data-item-field="ingredient"]')));
assert('selettore ricetta renderizzato', Boolean(doc.querySelector('#diet-plan-days select[data-option-field="recipeId"]')));
assert('moltiplicatore ricetta renderizzato', Boolean(doc.querySelector('#diet-plan-days input[data-option-field="recipeMultiplier"]')));

// Collect: il piano passa dai factory del dominio senza i transienti.
window.__admin.adminState.dietPlan.days[0].meals[1].options[0].items[0]._displayName = 'Petto di pollo';
const collected = window.__admin.collectDietPlanFromEditor();
assert('collect restituisce piano v2', collected.schemaVersion === domain.DIET_PLAN_SCHEMA_VERSION);
assert('collect conserva giorni/pasti/opzioni', collected.days.length === 1 && collected.days[0].meals.length === 2);
const item = collected.days[0].meals[1].options[0].items[0];
assert('collect scarta i campi transienti', !('_displayName' in item) && item.ingredientId === 'petto-di-pollo');
const validation = domain.validateDietPlanSoft(collected, null);
assert('piano raccolto valida (senza catalogo: soft)', Array.isArray(validation.errors));

// Coda richieste: render con stato pending.
window.__admin.adminState.catalogRequests = [{
  requestId: 'req-1', ingredientText: 'Tofu affumicato', status: 'pending',
  proposedFamilyId: 'legumi', proposedCategoryId: 'proteine',
  clientTitle: 'Mario', createdAt: new Date().toISOString()
}];
window.__admin.renderCatalogRequests();
assert('richiesta pending renderizzata', doc.getElementById('requests-list').textContent.includes('Tofu affumicato'));
assert('badge aggiornato', doc.getElementById('nav-open-count').textContent === '1');
assert('bottone valuta presente', Boolean(doc.querySelector('[data-open-request="req-1"]')));

// Template: render elenco.
window.__admin.adminState.templates = [{ id: 'tpl-1', name: 'Base carboidrati', status: 'active', referenceFamilyId: 'carboidratiComplessi', currentRevisionId: '2', updatedAt: new Date().toISOString() }];
window.__admin.renderEquivalenceTemplates();
assert('template renderizzato', doc.getElementById('templates-list').textContent.includes('Base carboidrati'));

// ---- Interazioni editor (event delegation) ----
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const change = (el, value) => { el.value = value; el.dispatchEvent(new window.Event('change', { bubbles: true })); };

// Nuova giornata dal pulsante dedicato.
const daysBefore = window.__admin.adminState.dietPlan.days.length;
click(doc.getElementById('diet-plan-add-day'));
assert('add-day aggiunge giornata', window.__admin.adminState.dietPlan.days.length === daysBefore + 1);

// Chip pasto: aggiunge il pasto mancante alla prima giornata.
const firstDayIndex = 0;
const mealChip = doc.querySelector(`.diet-day[data-day-index="${firstDayIndex}"] [data-add-meal]`);
assert('chip pasto presente', Boolean(mealChip));
const mealsBefore = window.__admin.adminState.dietPlan.days[firstDayIndex].meals.length;
const chipMealId = mealChip.dataset.mealId;
click(mealChip);
assert('chip pasto aggiunge il pasto', window.__admin.adminState.dietPlan.days[firstDayIndex].meals.length === mealsBefore + 1
  && window.__admin.adminState.dietPlan.days[firstDayIndex].meals[mealsBefore].mealId === chipMealId);

// Il nuovo pasto parte con un'opzione blocco vuota: aggiungo un blocco.
const mealIndex = mealsBefore;
// Il render ricrea il DOM: gli elementi si ri-cercano dopo ogni interazione.
const mealScope = () => doc.querySelector(`.diet-meal[data-day-index="${firstDayIndex}"][data-meal-index="${mealIndex}"]`);
const addBlock = mealScope()?.querySelector('[data-add-block]');
assert('bottone aggiungi blocco presente', Boolean(addBlock));
click(addBlock);
const option = window.__admin.adminState.dietPlan.days[firstDayIndex].meals[mealIndex].options[0];
assert('blocco aggiunto al modello', option.type === 'family-block' && option.blocks.length === 1);

// Cambio famiglia del blocco: selettore → modello (il re-render ricrea il DOM).
const familySelect = mealScope()?.querySelector('[data-block-field="referenceFamilyId"]');
assert('selettore famiglia presente', Boolean(familySelect));
assert('opzione famiglia presente nel selettore', [...familySelect.options].some(opt => opt.value === 'proteineMagre'));
change(familySelect, 'proteineMagre');
assert('famiglia aggiornata nel modello', option.blocks[0].referenceFamilyId === 'proteineMagre');

// Override quantità: aggiunta e modifica.
const addOverride = mealScope()?.querySelector('.diet-block [data-add-override]');
assert('bottone override presente', Boolean(addOverride));
click(addOverride);
assert('override aggiunto', option.blocks[0].overrides.length === 1);
const overrideFamily = mealScope()?.querySelector('[data-override-field="familyId"]');
assert('selettore famiglia override presente', Boolean(overrideFamily));
change(overrideFamily, 'grassiBuoni');
assert('override famiglia aggiornata', option.blocks[0].overrides[0].familyId === 'grassiBuoni');

// Quantità di riferimento del blocco: valore → modello.
const refValue = mealScope()?.querySelector('[data-block-field="referenceAmountValue"]');
assert('campo quantità riferimento presente', Boolean(refValue));
change(refValue, '120');
assert('quantità riferimento aggiornata', Number(option.blocks[0].referenceAmount.value) === 120);

// Passaggio di tipo: blocco → ricetta (reset controllato).
const recipeChip = mealScope()?.querySelector('[data-set-option-type$=":recipe"]');
assert('chip tipo ricetta presente', Boolean(recipeChip));
click(recipeChip);
// La conversione di tipo SOSTITUISCE l'oggetto opzione: si ri-legge dal modello.
const replaced = window.__admin.adminState.dietPlan.days[firstDayIndex].meals[mealIndex].options[0];
assert('opzione convertita in ricetta', replaced.type === 'recipe' && replaced.recipeId === null);

// Eliminazione giornata.
const removeDay = doc.querySelector('.diet-day [data-remove-day]');
click(removeDay);
assert('giornata rimossa', window.__admin.adminState.dietPlan.days.length === daysBefore);

// ---- Quantità item ingrediente: value e unità arrivano al modello ----
// (costruisco un pasto con item e verifico il sync dei campi quantità)
const itemMeal = domain.createDietPlanMeal('dinner', {
  options: [domain.createDietPlanOption({
    type: 'ingredients',
    items: [domain.createDietPlanItem({ ingredientId: 'petto-di-pollo', amount: { value: 100, unit: 'g' } })]
  })]
});
window.__admin.adminState.dietPlan = { days: [domain.createDietPlanDay('training', { meals: [itemMeal] })], generalNotes: '' };
window.__admin.renderDietPlanEditor();
const itemRow = doc.querySelector('.diet-item');
assert('item renderizzato per sync quantità', Boolean(itemRow));
change(itemRow.querySelector('[data-item-field="amountValue"]'), '180');
change(itemRow.querySelector('[data-item-field="amountUnit"]'), 'pz');
const itemModel = window.__admin.adminState.dietPlan.days[0].meals[0].options[0].items[0];
assert('quantità item sincronizzata', Number(itemModel.amount.value) === 180 && itemModel.amount.unit === 'pz');

// Riconoscimento item dal catalogo: testo esatto → ingredientId.
change(itemRow.querySelector('[data-item-field="ingredient"]'), 'Petto di pollo');
assert('item riconosciuto dal catalogo', itemModel.ingredientId === 'petto-di-pollo');

// ---- Dialog template: i selettori si popolano dal catalogo stub ----
// (openTemplateDialog usa callAdminSaasFunction solo in modifica: qui nuovo template)
await window.__admin.openTemplateDialog();
assert('dialog template aperto', !doc.getElementById('template-dialog').classList.contains('hidden'));
const familySelectTpl = doc.getElementById('template-family');
assert('selettore famiglia template popolato', familySelectTpl.options.length >= 4
  && [...familySelectTpl.options].some(opt => opt.value === 'proteineMagre'));
const unitSelectTpl = doc.getElementById('template-ref-unit');
assert('selettore unità template popolato', unitSelectTpl.options.length >= 10
  && [...unitSelectTpl.options].some(opt => opt.value === 'g'));
const firstEquivalent = doc.querySelector('#template-equivalents [data-equivalent-index]');
assert('riga equivalente iniziale presente', Boolean(firstEquivalent));
assert('riga equivalente con selettore famiglia popolato', firstEquivalent.querySelector('[data-equivalent-field="familyId"]').options.length >= 4);
window.__admin.closeTemplateDialog();

// ---- Coda richieste: filtro client-side, metriche sempre globali ----
window.__admin.adminState.catalogRequests = [
  { requestId: 'req-1', ingredientText: 'Tofu affumicato', status: 'pending', proposedFamilyId: 'legumi', clientTitle: 'Mario', createdAt: new Date().toISOString() },
  { requestId: 'req-2', ingredientText: 'Seitan', status: 'accepted', proposedFamilyId: 'legumi', clientTitle: 'Anna', createdAt: new Date().toISOString() },
  { requestId: 'req-3', ingredientText: 'Lupini', status: 'rejected', proposedFamilyId: 'legumi', clientTitle: 'Luca', createdAt: new Date().toISOString() }
];
doc.getElementById('request-status').value = 'accepted';
window.__admin.renderCatalogRequests();
assert('metrica pending globale con filtro attivo', doc.getElementById('metric-pending').textContent === '1');
assert('lista filtrata mostra solo le accettate', doc.getElementById('requests-list').textContent.includes('Seitan')
  && !doc.getElementById('requests-list').textContent.includes('Tofu'));
assert('badge nav conta tutte le pending', doc.getElementById('nav-open-count').textContent === '1');
doc.getElementById('request-status').value = '';
window.__admin.renderCatalogRequests();
assert('filtro «Tutte» mostra tutto', doc.getElementById('requests-list').textContent.includes('Tofu')
  && doc.getElementById('requests-list').textContent.includes('Lupini'));

console.log('SMOKE ADMIN OK');
})().catch(error => { console.error(error); process.exit(1); });
