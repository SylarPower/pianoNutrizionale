'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/admin.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'js/admin.js'), 'utf8');

test('console admin contiene una slice reale mapping e assegnazioni', () => {
  for (const id of ['reports-list','mapping-form','clients-list','assignment-form']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // L'header non espone più alcun riferimento all'organizzazione (singola 'piano').
  assert.doesNotMatch(html, /organization-id|org-badge|tenant-field/);
  assert.doesNotMatch(js, /saveOrg/);
  for (const callable of ['listMappingReports','proposeMapping','publishMapping','listAuthorizedClients']) {
    assert.match(js, new RegExp(`['"]${callable}['"]`));
  }
});

test('modale assegnazione v2: solo Cliente, Struttura, Decorrenza, Scadenza/Senza scadenza, Note e Conferma', () => {
  for (const id of ['assignment-structure','assignment-effective','assignment-expires','assignment-no-expiry','assignment-notes']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // Campi v1 eliminati: niente Ambito/Versione/Strategia/checksum/anteprima.
  for (const legacy of ['assignment-scope','assignment-version','assignment-strategy','assignment-checksum','assignment-preview','assignment-reason']) {
    assert.doesNotMatch(html, new RegExp(`id="${legacy}"`), `il campo v1 ${legacy} non deve più esistere`);
  }
  // Il checksum non viene mai mostrato né richiesto nel flusso di assegnazione.
  assert.doesNotMatch(html, /Checksum SHA-256/i);
  assert.doesNotMatch(js, /previewClientRuleSet/);
  assert.doesNotMatch(js, /listRuleSets/);
  assert.doesNotMatch(js, /assignClientRuleSet/);
  assert.match(js, /assignClientStructure/);
  // Fase 2: il selettore usa le dietStructures (nome + ultima modifica).
  assert.match(js, /listDietStructures/);
  assert.match(js, /structureId: chosen.id/);
  // Landing: la vista Clienti è la porta d'ingresso.
  assert.match(html, /nav-link active" data-view="clients"/);
  assert.match(js, /showView\('clients'\)/);
  // Badge coda accessibile: stato anche senza colore.
  assert.match(html, /id="nav-open-count" class="badge-zero"/);
  assert.match(js, /aria-label.*Coda ingredienti/);
  assert.match(css, /\.nav-link b\.badge-zero/);
  assert.match(css, /\.nav-link b\.badge-count/);
});

test('console admin è responsive, accessibile e non indicizzabile', () => {
  assert.match(html, /name="robots" content="noindex,nofollow"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(css, /@media\(max-width:840px\)/);
  assert.match(css, /@media\(max-width:1100px\) and \(min-width:841px\)/, 'tabella passa a due colonne sui tablet');
  assert.match(css, /\.form-grid>label,[^{]+\{min-width:0\}/, 'i campi tecnici non forzano la griglia');
  assert.match(css, /\.dialog-actions\{flex-direction:column-reverse\}/, 'azioni modale impilate sugli schermi stretti');
  assert.match(css, /prefers-reduced-motion/);
});

test('sezione Strutture dieta: voce di menu dopo Clienti, editor a revisioni nuove, callable v2', () => {
  assert.match(html, /data-view="structures"/);
  assert.ok(html.indexOf('data-view="clients"') < html.indexOf('data-view="structures"'), 'Strutture dieta segue Clienti nel menu');
  assert.match(html, /id="view-structures"/);
  assert.match(html, /id="structure-form"/);
  assert.match(html, /id="structure-rules"/);
  assert.match(html, /id="structure-restore-field"/);
  for (const callable of ['listDietStructures','getDietStructureRevision','createDietStructure','updateDietStructureRevision','archiveDietStructure']) {
    assert.match(js, new RegExp(`['"]${callable}['"]`), `callable ${callable} usata`);
  }
  // Nessun campo "Versione" operativo; date di sola lettura.
  assert.doesNotMatch(html, /<label>Versione/i);
  assert.doesNotMatch(js, /<input[^>]*structure-(created|updated)/);
  assert.match(js, /1 e 2000/);
  assert.match(js, /Famiglia duplicata/);
  // Checksum solo nei "Dettagli tecnici" admin, mai al nutritionist: il
  // markup esiste ma il JS lo mostra solo se il server lo espone (admin).
  assert.match(html, /<details id="structure-tech-details"/);
  assert.match(html, /<summary>Dettagli tecnici<\/summary>/);
  assert.match(js, /if \(result\.structure\.latestChecksum\)/);
});

test('strutture dieta Fase 2: autocomplete catalogo, categorie, gruppi alternativi, confronto', () => {
  // js/domain.js caricato in console per buildCatalogIndex/searchCatalog.
  assert.match(html, /<script src="js\/domain\.js"><\/script>/);
  assert.match(js, /loadCatalogIndex/);
  assert.match(js, /catalogSearch/);
  assert.match(js, /rule-ing-search/);
  assert.match(js, /fillCategorySelects/);
  assert.match(js, /\.rule-cat/);
  // Famiglia validata contro il motore (casing canonico, server rivalida).
  assert.match(js, /engineFamilyId/);
  assert.match(js, /non esiste nel motore/);
  // Gruppi alternativi CRUD salvati nella revisione.
  assert.match(html, /id="structure-groups"/);
  assert.match(html, /id="structure-add-group"/);
  assert.match(js, /collectStructureGroups/);
  assert.match(js, /alternativeGroups/);
  // CONFRONTA: checkbox card + dialog matrice responsive, sola lettura.
  assert.match(html, /id="compare-structures"/);
  assert.match(html, /id="compare-dialog"/);
  assert.match(html, /id="compare-matrix"/);
  assert.match(js, /compareDietStructures/);
  assert.match(js, /data-compare-structure/);
  assert.match(js, /Sola lettura/);
  assert.match(css, /\.compare-table/);
  assert.match(css, /max-width:760px/);
  // Differenze mai solo-colore: simbolo + parola.
  assert.match(js, /≠.*=|diff-word/);
  assert.match(css, /\.diff-mark/);
});

test('sezione Utenti: membri, inviti monouso, rimozione con conferma forte', () => {
  assert.match(html, /data-view="users"/);
  assert.ok(html.indexOf('data-view="structures"') < html.indexOf('data-view="users"'), 'Utenti segue Strutture dieta nel menu');
  assert.match(html, /id="view-users"/);
  assert.match(html, /id="members-list"/);
  assert.match(html, /id="invite-nutritionist-form"/);
  assert.match(html, /id="invite-client-form"/);
  assert.match(html, /id="links-list"/);
  for (const callable of ['listOrganizationUsers', 'searchUserByUsername', 'inviteOrganizationUser', 'inviteClientLink', 'setMemberStatus', 'removeClientLink', 'removeNutritionist']) {
    assert.match(js, new RegExp(`['"]${callable}['"]`), `callable ${callable} usata`);
  }
  // Verifica per username esatto: solo trovato/non trovato, mai PII o liste.
  assert.match(html, /data-verify-username/);
  assert.match(js, /Nessun account con questo username/);
  // Rimozione associazione: dialog dedicato che spiega gli effetti.
  assert.match(html, /id="unlink-dialog"/);
  assert.match(html, /Non cancelliamo l’account/);
  assert.match(html, /torna alle dosi originali/);
  assert.match(js, /removeClientLink/);
  // Mai password/token nei form: solo username esatto + token mostrato una volta.
  assert.doesNotMatch(html, /id="invite-.*password"/);
  assert.match(js, /una sola volta/);
});

test('console Fase 2: font self-hosted e drawer mobile accessibile', () => {
  assert.match(html, /rel="preload" href="assets\/fonts\/inter-latin-400-normal\.woff2"/);
  assert.match(html, /aria-expanded="false" aria-controls="console-sidebar"/);
  assert.match(html, /id="sidebar-backdrop"/);
  assert.match(css, /@font-face\{font-family:"Inter"/);
  assert.match(css, /\.sidebar-backdrop/);
  assert.match(js, /sidebar-backdrop/);
  assert.match(js, /aria-expanded/);
});

test('copy premium comunica valore e sicurezza senza promessa clinica assoluta', () => {
  assert.match(html, /Decisioni più sicure/);
  assert.match(html, /Ogni azione è tracciata/);
  assert.doesNotMatch(html, /garantisce|cura|risultato garantito/i);
});

test('sezione Dosi clienti: vista, editor override e copia con anteprima', () => {
  // Voce di menu dopo Clienti (landing invariata).
  assert.match(html, /data-view="doses"/);
  assert.match(html, /nav-link active" data-view="clients"/);
  // Struttura vista: selettori, pannelli, azioni.
  for (const id of ['view-doses', 'dose-client', 'doses-feedback', 'dose-assignment', 'dose-tables', 'save-doses', 'copy-from', 'copy-to', 'copy-feedback', 'copy-preview', 'preview-copy', 'confirm-copy', 'refresh-doses']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // Callable dedicate (mai scritture dirette Firestore dalla console).
  for (const callable of ['getClientDoses', 'updateClientDoseOverrides', 'copyClientDoses']) {
    assert.match(js, new RegExp(`['"]${callable}['"]`));
  }
  // Concorrenza ottimistica e conferma cliente esplicita nei testi.
  assert.match(js, /expectedRevision/);
  assert.match(js, /dovrà confermare dall’app/);
  // Anteprima copia: differenze prima della conferma, famiglie saltate esplicite.
  assert.match(js, /previewDoseCopy/);
  assert.match(js, /confirmDoseCopy/);
  assert.match(js, /skipped/);
  // Celle vuote = studio: validazione anti-refusi prima dell'invio.
  assert.match(js, /data-dose-family/);
  assert.match(js, /data-freq-key/);
  assert.match(js, /Dosi 1–2000 g, frequenze 0–14/);
  // Accessibilità e responsive della vista.
  assert.match(js, /aria-label="\$\{escapeAdmin\(item\.label\)\}/);
  assert.match(css, /\.dose-table/);
  assert.match(css, /\.copy-grid/);
});

test('strutture dieta: picker catalogo multi-selezione e raggruppamento con dosi comuni', () => {
  // Picker catalogo nel dialog struttura, con filtro, conteggio accessibile e CTA.
  for (const id of ['catalog-picker', 'catalog-picker-search', 'catalog-picker-list', 'picker-count', 'picker-clear', 'picker-group', 'picker-feedback']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Raggruppa selezionati/);
  assert.match(html, /aria-label="Filtra alimenti del catalogo"/);
  assert.match(html, /role="status">Nessun alimento selezionato/);
  // Dialog di raggruppamento: due destinazioni (regola multi-famiglia o gruppo alternativo) e dosi comuni.
  for (const id of ['group-dialog', 'group-form', 'group-dest-rule', 'group-dest-alt', 'group-family', 'group-target', 'group-new-id', 'group-new-name', 'group-la', 'group-lr', 'group-ca', 'group-cr', 'group-error']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /aria-labelledby="group-title"/);
  assert.match(html, /data-close-group/);
  // Logica JS: render raggruppato per categoria, selezione minima 2, validazione dosi come le regole.
  for (const fn of ['renderCatalogPicker', 'updatePickerCount', 'resetCatalogPicker', 'openGroupDialog', 'collectGroupDoses', 'submitGrouping', 'toggleGroupDestination', 'toggleNewGroupFields']) {
    assert.match(js, new RegExp(`function ${fn}\\b`));
  }
  assert.match(js, /pickerSelection/);
  assert.match(js, /count < 2/);
  assert.match(js, /numeri interi tra 1 e 2000/);
  assert.match(js, /almeno una dose per pranzo o cena/);
  // Il raggruppamento crea righe normali riusando i builder esistenti (server-validati al salvataggio).
  assert.match(js, /addStructureRuleRow\(\{ mellerFamilyId, ingredientIds, quantityGrams, enabled: true \}\)/);
  assert.match(js, /groupItemRow\(\{ ingredientId, quantityGrams \}\)/);
  assert.match(js, /resetCatalogPicker\(\)/);
  // Reset del picker a ogni apertura del dialog struttura.
  assert.match(js, /addEventListener\('click', openGroupDialog\)/);
  assert.match(js, /role="group" aria-label=/);
  // Stili e responsive (44px touch, stacking a colonna singola su mobile).
  assert.match(css, /\.catalog-picker/);
  assert.match(css, /\.picker-category-items/);
  assert.match(css, /\.picker-item/);
  assert.match(css, /\.group-doses/);
});
