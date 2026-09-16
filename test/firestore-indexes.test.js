'use strict';
/* Configurazione indici Firestore: ciò che il deploy accetta davvero.
 *
 * Regressione del deploy fallito con:
 *   HTTP Error: 400, this index is not necessary, configure using single field
 *   index controls   (collectionGroups/invitations/indexes)
 *
 * Firestore mantiene DA SOLO gli indici a campo singolo con scope COLLECTION:
 * dichiararli in `indexes` come indici compositi è un errore (400) e blocca
 * l'intero deploy, functions comprese. Gli indici a campo singolo con scope
 * COLLECTION_GROUP invece NON sono automatici e vanno dichiarati in
 * `fieldOverrides`, ridichiarando anche i default COLLECTION perché un override
 * SOSTITUISCE le impostazioni automatiche del campo (non le aggiunge).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firestore.indexes.json'), 'utf8'));
const indexJs = fs.readFileSync(path.join(__dirname, '..', 'functions', 'src', 'index.js'), 'utf8');

test('nessun indice composito a campo singolo: Firestore lo rifiuta con HTTP 400', () => {
  assert.ok(Array.isArray(spec.indexes), 'il file dichiara la proprietà "indexes"');
  for (const index of spec.indexes) {
    assert.ok(
      index.fields.length >= 2,
      `${index.collectionGroup}: un indice a campo singolo va in fieldOverrides, non in indexes`
    );
    assert.equal(
      index.queryScope, 'COLLECTION',
      `${index.collectionGroup}: un indice composito collection-group ha almeno due campi`
    );
  }
});

test('tokenHash degli inviti: la query collection group è coperta da fieldOverride', () => {
  // findInvitationByTokenHash cerca prima nella collezione dell'organizzazione
  // e poi nella collection group: la seconda non è indicizzata di default.
  assert.match(indexJs, /collectionGroup\('invitations'\)/, 'il fallback usa la collection group');
  assert.match(indexJs, /where\('tokenHash', '==', tokenHash\)/, 'filtro su tokenHash');
  const override = (spec.fieldOverrides || [])
    .find(field => field.collectionGroup === 'invitations' && field.fieldPath === 'tokenHash');
  assert.ok(override, 'manca il fieldOverride su invitations.tokenHash');
  const scopes = override.indexes.map(index => `${index.queryScope}:${index.order || index.arrayConfig}`);
  assert.ok(scopes.includes('COLLECTION_GROUP:ASCENDING'), 'indice collection group per il fallback');
  assert.ok(scopes.includes('COLLECTION:ASCENDING'), 'il default COLLECTION resta dichiarato (query primaria)');
  assert.ok(
    scopes.includes('COLLECTION:DESCENDING') && scopes.includes('COLLECTION:CONTAINS'),
    'l’override non elimina gli altri indici automatici del campo'
  );
});

test('shape del file accettata dalla CLI: indexes + fieldOverrides', () => {
  assert.deepEqual(Object.keys(spec).sort(), ['fieldOverrides', 'indexes']);
  for (const field of spec.fieldOverrides || []) {
    assert.ok(field.collectionGroup && field.fieldPath, 'collectionGroup e fieldPath obbligatori');
    assert.ok(Array.isArray(field.indexes) && field.indexes.length, 'lista indexes obbligatoria');
    for (const index of field.indexes) {
      assert.ok(index.order || index.arrayConfig, 'ogni voce ha order oppure arrayConfig');
      assert.ok(
        ['COLLECTION', 'COLLECTION_GROUP'].includes(index.queryScope),
        `queryScope valido, trovato ${index.queryScope}`
      );
    }
  }
});
