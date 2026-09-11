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
  for (const id of ['reports-list','mapping-form','clients-list','assignment-form','organization-id']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
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

test('console PASSO 4: vista Ricette studio, dialoghi e callable gestione cliente', () => {
  // Vista catalogo studio.
  assert.match(html, /data-view="studio"/);
  assert.match(html, /id="view-studio"/);
  for (const id of ['studio-list', 'studio-feedback', 'new-studio-recipe', 'refresh-studio']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // Dialogo ricetta condiviso (studio + personale).
  for (const id of ['recipe-dialog', 'recipe-form', 'recipe-mode', 'recipe-id', 'recipe-client-id', 'recipe-name', 'recipe-ingredients', 'recipe-steps', 'recipe-error']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // Dialogo gestione cliente: 5 sezioni (assegnate, personali, grammature, frequenze, copia).
  for (const id of ['client-dialog', 'client-org-recipes', 'client-assign-list', 'client-personal-recipes', 'client-grams', 'client-grams-note', 'client-freq-proteins', 'client-freq-carbs', 'client-copy-targets', 'client-copy-preview', 'client-copy-confirm', 'client-copy-preview-out']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // Le 15 callable della gestione clienti sono tutte referenziate.
  for (const callable of ['listStudioRecipes', 'saveStudioRecipe', 'archiveStudioRecipe', 'assignStudioRecipes', 'unassignStudioRecipes', 'listClientRecipes', 'saveClientPersonalRecipe', 'getClientGramOverrides', 'saveClientGramOverrides', 'getClientFoodFrequencies', 'saveClientFoodFrequencies', 'previewCopyClientData', 'copyClientData']) {
    assert.match(js, new RegExp(`['"]${callable}['"]`), `callable ${callable} non referenziata in admin.js`);
  }
  // Pulsante Gestione sulle card clienti + vista agganciata allo showView.
  assert.match(js, /data-manage-client/);
  assert.match(js, /openClientWorkspace/);
  assert.match(js, /loadStudio/);
  // Copy non tecnico: mai "retroattivo silenzioso" verso lo staff, ma avvisi chiari.
  assert.match(html, /serve una riassegnazione esplicita/);
  assert.match(html, /restano intoccabili/);
  // Stili console per workspace, frequenze e ingredienti.
  for (const cls of ['workspace-row', 'frequency-grid', 'frequency-row', 'recipe-ingredient']) {
    assert.match(css, new RegExp(`\\.${cls}`), `classe .${cls} mancante in admin.css`);
  }
  // Stili app cliente per copie studio e frequenze assegnate.
  const clientCss = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
  for (const cls of ['studio-copy-banner', 'studio-copy-flag', 'studio-copy-badge', 'generator-assigned-notice', 'generator-assigned-carbs']) {
    assert.match(clientCss, new RegExp(`\\.${cls}`), `classe .${cls} mancante in style.css`);
  }
});
