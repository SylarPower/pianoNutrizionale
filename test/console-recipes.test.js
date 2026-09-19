'use strict';
/* Parte C (console) — vista Ricettario professionisti (ADR 0006):
 * - voce di menu, vista view-recipes, dialoghi ricetta e invio;
 * - tutte le scritture passano dalle callable (mai Firestore diretto);
 * - permessi UI: modifica/archivia proprietario, condividi creatore. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/admin.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'js/admin.js'), 'utf8');

test('vista Ricette: voce di menu, vista, filtri e pannello invii', () => {
  assert.match(html, /data-view="recipes"/);
  assert.match(html, /id="view-recipes"/);
  assert.match(html, /id="new-recipe"/);
  assert.match(html, /id="refresh-recipes"/);
  for (const filter of ['all', 'mine', 'studio', 'archived']) {
    assert.match(html, new RegExp(`data-recipe-filter="${filter}"`));
  }
  assert.match(html, /id="recipes-list"/);
  assert.match(html, /id="shares-list"/);
  assert.match(html, /id="refresh-shares"/);
  assert.match(js, /view === 'recipes'/);
});

test('dialogo ricetta: stessi campi dell’editor app, categoria preservata', () => {
  for (const id of ['recipe-dialog', 'recipe-form', 'recipe-id', 'recipe-revision', 'recipe-protein', 'recipe-name', 'recipe-emoji', 'recipe-slot', 'recipe-ingredients', 'recipe-add-ingredient', 'recipe-steps', 'recipe-notes', 'recipe-submit', 'recipe-error']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const slot of ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner']) {
    assert.match(html, new RegExp(`<option value="${slot}"[^>]*>`));
  }
  assert.match(html, />Pasto</, 'etichetta Pasto come nell’app');
  // Nessun campo batch sulla ricetta (deriva dal contesto del piano).
  assert.doesNotMatch(html, /recipe-batch/);
  assert.doesNotMatch(js, /recipe-batch/);
});

test('dialogo invio: cliente, hint sola lettura, annullo pendenti', () => {
  for (const id of ['recipe-send-dialog', 'recipe-send-form', 'recipe-send-id', 'recipe-send-client', 'recipe-send-submit', 'recipe-send-error']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /resta in sola lettura/);
  assert.match(js, /data-cancel-share/);
});

test('callable cablate: list/create/update/archive/share/send/cancel/shares', () => {
  for (const callable of ['listProfessionalRecipes', 'createProfessionalRecipe', 'updateProfessionalRecipe', 'archiveProfessionalRecipe', 'shareProfessionalRecipe', 'sendProfessionalRecipe', 'cancelProfessionalShare', 'listProfessionalShares']) {
    assert.match(js, new RegExp(`'${callable}'`), `callable ${callable} usata`);
  }
  // Concorrenza ottimistica: la revisione viaggia con l’update.
  assert.match(js, /revision: Number\(\$\('recipe-revision'\)\.value\)/);
  // Duplica = nuova create dal client, nessuna callable dedicata.
  assert.match(js, /openRecipeDialog\(null, duplicate\.dataset\.duplicateRecipe\)/);
  assert.doesNotMatch(js, /duplicateProfessionalRecipe/);
  // Idempotenza su ogni scrittura.
  assert.equal((js.match(/idem\('recipe-(create|update|archive|share|send|cancel)'\)/g) || []).length, 6);
});

test('permessi UI: proprietario modifica/archivia, creatore condivide', () => {
  assert.match(js, /data-edit-recipe.*disabled.*Solo il proprietario modifica/s);
  assert.match(js, /\$\{isOwner && !archived \? `[^`]*data-archive-recipe/s);
  assert.match(js, /adminState\.isCreator && !archived \? `[^`]*data-visibility-recipe/s);
  assert.match(js, /async function loadProfessionalRecipes\(\{ quiet = false \} = \{\}\)/);
  assert.match(js, /async function submitRecipeForm\(event\)/);
  assert.match(js, /async function submitRecipeSend\(event\)/);
  assert.match(js, /async function cancelProfessionalShareUI\(shareId\)/);
});

test('stili ricette: righe ingrediente in scala, responsive', () => {
  assert.match(css, /\.recipe-ingredient-row\{display:grid;grid-template-columns:2fr 1fr auto;gap: 8px/);
  assert.match(css, /\.recipe-ingredients\{display:grid;gap: 8px\}/);
  assert.match(css, /\.recipe-ingredient-row \.ing-name\{grid-column:auto\}/);
});
