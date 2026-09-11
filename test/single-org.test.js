'use strict';
/* Obiettivo A — invarianti singola organizzazione 'piano' e ruoli */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const domain = require('../functions/src/domain');
const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(__dirname, '..', 'js/admin.js'), 'utf8');
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

test('admin console non ha input organizzazione digitabile', () => {
  assert.match(adminHtml, /id="organization-id" type="hidden"/, 'input org nascosto');
  assert.match(adminHtml, /id="org-badge"/, 'badge org visibile');
  assert.match(adminHtml, /unica/, 'etichetta unica');
  assert.doesNotMatch(adminHtml, /<label class="tenant-field"><span>Organizzazione<\/span><input id="organization-id" placeholder=/, 'vecchio campo digitabile rimosso');
});

test('admin.js usa costante SINGLE_ORG_ID', () => {
  assert.match(adminJs, /SINGLE_ORG_ID/);
  assert.match(adminJs, /'piano'|\"piano\"|SINGLE_ORG_ID/);
  assert.match(adminJs, /function saveOrg\(\) \{ \/\* org singola/);
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
