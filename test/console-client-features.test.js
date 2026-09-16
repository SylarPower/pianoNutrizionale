'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'js/admin.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/admin.css'), 'utf8');

test('ricerca clienti: campo di ricerca presente nel markup, nello stile e nella logica', () => {
  assert.match(html, /id="client-search"/);
  assert.match(html, /placeholder="Cerca nome, cognome o email…"/);
  assert.match(css, /\.client-toolbar/);
  assert.match(css, /\.client-search-wrap/);
  assert.match(js, /clientSearchQuery/);
  assert.match(js, /clientLabel\(client\)\.toLowerCase\(\)/);
});

test('modifica anagrafica cliente: supporta email assieme a nome e cognome', () => {
  assert.match(html, /id="client-profile-email"/);
  assert.match(js, /client-profile-email/);
  assert.match(js, /updateClientProfileByStaff/);
  assert.match(js, /window\.confirm/);
});

test('modifica anagrafica professionista: modale e pulsante dedicati per l’admin', () => {
  assert.match(html, /id="member-profile-dialog"/);
  assert.match(html, /id="member-profile-first-name"/);
  assert.match(html, /id="member-profile-last-name"/);
  assert.match(js, /openMemberProfile/);
  assert.match(js, /submitMemberProfile/);
  assert.match(js, /data-member-profile/);
  // Il vecchio form inline è rimosso
  assert.doesNotMatch(js, /class="member-profile-form"/);
});

test('generazione nuovo link cliente: pulsante dedicato per clienti non attivi', () => {
  assert.match(js, /data-client-new-link/);
  assert.match(js, /function generateClientNewLink/);
});

test('eliminazione definitiva cliente: solo per creatore/admin, con modale di conferma', () => {
  assert.match(html, /id="delete-client-dialog"/);
  assert.match(html, /id="delete-client-id"/);
  assert.match(js, /data-delete-client-permanent/);
  assert.match(js, /openDeleteClientDialog/);
  assert.match(js, /submitDeleteClientPermanent/);
  assert.match(js, /deleteClientPermanently/);
});
