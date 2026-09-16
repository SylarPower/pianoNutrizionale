'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const adminHtml = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(root, 'js', 'admin.js'), 'utf8');
const functionsIndexJs = fs.readFileSync(path.join(root, 'functions', 'src', 'index.js'), 'utf8');
const functionsDomainJs = fs.readFileSync(path.join(root, 'functions', 'src', 'domain.js'), 'utf8');

test('admin.html: ordinamento pannelli nella vista view-clients', () => {
  const viewClientsStart = adminHtml.indexOf('id="view-clients"');
  const viewClientsEnd = adminHtml.indexOf('</main>', viewClientsStart);
  assert.ok(viewClientsStart > 0, 'view-clients presente');
  assert.ok(viewClientsEnd > viewClientsStart, 'chiusura view-clients presente');
  const viewClientsMarkup = adminHtml.slice(viewClientsStart, viewClientsEnd);

  const teamPanelIndex = viewClientsMarkup.indexOf('id="team-panel"');
  const clientsListIndex = viewClientsMarkup.indexOf('id="clients-list"');

  assert.ok(teamPanelIndex > 0, '#team-panel presente in view-clients');
  assert.ok(clientsListIndex > 0, '#clients-list presente in view-clients');
  assert.ok(
    teamPanelIndex < clientsListIndex,
    'Il pannello dei nutrizionisti (#team-panel) precede il pannello dei clienti (#clients-list)'
  );
});

test('admin.html & admin.js: etichetta navigazione dinamica Utenti (admin) vs Clienti (nutrizionista)', () => {
  assert.match(adminHtml, /id="nav-clients"[^>]*>[\s\S]*?<span id="nav-clients-label">Clienti<\/span>/);
  assert.match(adminJs, /navClientsLabel\.textContent\s*=\s*adminState\.isCreator\s*\?\s*'Utenti'\s*:\s*'Clienti'/);
});

test('admin.html: dialoghi e form per invito ed anagrafica professionista', () => {
  // Dialog invito professionista
  assert.match(adminHtml, /id="invite-nutritionist-dialog"/);
  assert.match(adminHtml, /id="invite-nutritionist-email"/);
  assert.match(adminHtml, /id="invite-nutritionist-first-name"/);
  assert.match(adminHtml, /id="invite-nutritionist-last-name"/);
  assert.match(adminHtml, /id="invite-nutritionist-open"/);

  // Dialog anagrafica professionista con campo email
  assert.match(adminHtml, /id="member-profile-dialog"/);
  assert.match(adminHtml, /id="member-profile-first-name"/);
  assert.match(adminHtml, /id="member-profile-last-name"/);
  assert.match(adminHtml, /id="member-profile-email"/);
});

test('admin.js: gestione invito, anagrafica e rigenerazione link professionista', () => {
  // Invito professionista con apertura link dialog
  assert.match(adminJs, /function openInviteNutritionistDialog/);
  assert.match(adminJs, /function closeInviteNutritionistDialog/);
  assert.match(adminJs, /async function submitNutritionistEmailInvite/);
  assert.match(adminJs, /callAdminSaasFunction\('inviteOrganizationUser',\s*\{[\s\S]*?email[\s\S]*?role:\s*'nutritionist'/);

  // Anagrafica professionista con email e alert di conferma
  assert.match(adminJs, /async function submitMemberProfile/);
  assert.match(adminJs, /window\.confirm\([\s\S]*?modifica dell'indirizzo email/);
  assert.match(adminJs, /callAdminSaasFunction\('updateMemberProfileByStaff',\s*\{[\s\S]*?email/);

  // Rigenerazione link per invito nutrizionista pendente
  assert.match(adminJs, /async function resendNutritionistInvite/);
  assert.match(adminJs, /data-resend-nutri-invite/);
});

test('backend: domain.js e index.js supportano email e auth sync per i nutrizionisti', () => {
  // Validazione invito con email e nome
  assert.match(functionsDomainJs, /validateInviteOrganizationUser/);
  assert.match(functionsDomainJs, /validateUpdateMemberProfileByStaff/);

  // Callable backend
  assert.match(functionsIndexJs, /exports\.inviteOrganizationUser\s*=\s*callable/);
  assert.match(functionsIndexJs, /exports\.updateMemberProfileByStaff\s*=\s*callable/);
  assert.match(functionsIndexJs, /adminAuth\(\)\.updateUser\(input\.userId,\s*\{\s*email:\s*input\.email\s*\}\)/);
  assert.match(functionsIndexJs, /invite\.type\s*!==\s*CLIENT_EMAIL_INVITE_TYPE\s*&&\s*invite\.type\s*!==\s*'nutritionist'/);
});
