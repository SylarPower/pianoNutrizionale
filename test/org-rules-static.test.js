'use strict';
/* Invarianti statiche delle regole Firestore per l'area organizzazioni:
 *  - nessuna scrittura diretta (solo callable server-side);
 *  - strutture/revisioni mai leggibili direttamente (privacy ownerUid);
 *  - clienti e sotto-collezioni leggibili solo dallo staff autorizzato.
 * La suite con emulatore (npm run test:rules) resta la verifica semantica. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');

test('organizzazioni e clienti: letture staff, scritture solo via callable', () => {
  const orgSection = rules.slice(rules.indexOf('match /organizations/{organizationId} {'));
  assert.match(orgSection, /match \/organizations\/\{organizationId\} \{\s+allow read: if activeTenantMember\(organizationId\);\s+allow write: if false;/);
  assert.match(orgSection, /match \/organizations\/\{organizationId\}\/clients\/\{clientId\} \{\s+allow read: if tenantAdmin\(organizationId\) \|\| authorizedNutritionist\(organizationId, clientId\);\s+allow write: if false;/);
  assert.match(orgSection, /match \/organizations\/\{organizationId\}\/clients\/\{clientId\}\/\{document=\*\*\} \{\s+allow read: if tenantAdmin\(organizationId\) \|\| authorizedNutritionist\(organizationId, clientId\);\s+allow write: if false;/);
  assert.doesNotMatch(orgSection, /allow write: if activeTenantMember/, 'nessuna scrittura diretta dei membri');
});

test('strutture, revisioni e code: nessun accesso diretto', () => {
  assert.match(rules, /match \/organizations\/\{organizationId\}\/dietStructures\/\{structureId\} \{\s+allow read, write: if false;/);
  assert.match(rules, /match \/organizations\/\{organizationId\}\/dietStructures\/\{structureId\}\/revisions\/\{revisionId\} \{\s+allow read, write: if false;/);
  assert.match(rules, /match \/organizations\/\{organizationId\}\/\{document=\*\*\} \{\s+allow read, write: if false;/);
});
