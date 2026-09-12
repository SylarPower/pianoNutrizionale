'use strict';
/* Obiettivo A — invarianti singola organizzazione 'piano' e ruoli */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const domain = require('../functions/src/domain');
const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const adminCss = fs.readFileSync(path.join(__dirname, '..', 'css', 'admin.css'), 'utf8');
const adminJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin.js'), 'utf8');
const saasConfig = fs.readFileSync(path.join(__dirname, '..', 'js/saas-config.js'), 'utf8');
const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');

test('domain: SINGLE_ORGANIZATION_ID = piano e ROLES solo nutritionist', () => {
  assert.equal(domain.SINGLE_ORGANIZATION_ID, 'piano');
  assert.equal(domain.ROLES.has('nutritionist'), true);
  assert.equal(domain.ROLES.has('admin'), false, 'admin org rimosso');
  assert.equal(domain.ROLES.size, 1);
});

test('saas-config espone single org id', () => {
  assert.match(saasConfig, /PIANO_SINGLE_ORG_ID.*piano/);
  assert.match(saasConfig, /singleOrganizationId.*piano/);
});

test('admin console non ha alcun riferimento all’organizzazione in header', () => {
  assert.doesNotMatch(adminHtml, /id="organization-id"/, 'input org nascosto rimosso');
  assert.doesNotMatch(adminHtml, /id="org-badge"/, 'badge org rimosso');
  assert.doesNotMatch(adminHtml, /tenant-field/, 'campo tenant rimosso dalla topbar');
  assert.doesNotMatch(adminHtml, /<span>Organizzazione<\/span>/, 'etichetta Organizzazione rimossa');
  assert.doesNotMatch(adminCss, /\.org-badge|\.tenant-field/, 'stili badge org rimossi');
  assert.match(adminCss, /margin-left:auto/, 'topbar utente allineata a destra senza campo org');
});

test('admin.js usa costante SINGLE_ORG_ID senza UI org', () => {
  assert.match(adminJs, /SINGLE_ORG_ID/);
  assert.doesNotMatch(adminJs, /saveOrg/, 'helper saveOrg rimosso');
  assert.doesNotMatch(adminJs, /org-badge|organization-id/, 'nessun accesso a badge o input org');
});

test('rules: solo org piano, creator = platformMembers admin', () => {
  assert.match(rules, /isSingleOrg/);
  assert.match(rules, /'piano'/);
  assert.match(rules, /function isCreator\(\)/);
  assert.match(rules, /platformMembers/);
  assert.match(rules, /role == 'nutritionist'/);
  assert.doesNotMatch(rules, /role in \['admin', 'nutritionist'\]/);
});

test('migrazione script esiste e non cancella', () => {
  const mig = fs.readFileSync(path.join(__dirname, '..', 'functions/scripts/migrate-to-single-org.js'), 'utf8');
  assert.match(mig, /SINGLE_ORG_ID.*piano/);
  assert.match(mig, /Zero cancellazioni/);
  assert.doesNotMatch(mig, /delete\(\)/);
  assert.match(mig, /archivia/i);
});
