'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalJson, checksum, normalizeIngredient, aliasKey, searchTokensFor, normalizeUsername, hashToken,
  MELLER_FAMILY_IDS, STRUCTURE_REVISION_SCHEMA_VERSION,
  reportKey, validateReport,
  validateMapping, validateRuleSetRules, validateAssignment, validateStructureAssignment, validateDietStructureRules,
  validateAlternativeGroups, structureRevisionChecksum, verifyStructureRevision, effectiveAssignment,
  parseCatalogPayload, validateCatalogImport, catalogImportPreviewId,
  validateInviteOrganizationUser, validateInviteClientLink, validateRespondClientLink,
  validateRemoveClientLink, validateMemberStatus, validateRemoveNutritionist,
  validateTransferStructureOwnership
} = require('../src/domain');

const ClientDomain = require('../../js/domain');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('canonicalJson e checksum sono indipendenti dall’ordine delle chiavi', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(checksum({ b: 2, a: 1 }), checksum({ a: 1, b: 2 }));
});

test('normalizzazione ingrediente è deterministica e minimizza il fingerprint', () => {
  assert.equal(normalizeIngredient('  Rìso   Venere! '), 'riso venere');
});

test('reportKey deduplica lo stesso caso e separa versioni diverse', () => {
  const base = { organizationId: 'org-1', fingerprint: 'abc', ruleSetId: 'meller', ruleSetVersion: '3', errorType: 'unknown' };
  assert.equal(reportKey(base), reportKey({ ...base }));
  assert.notEqual(reportKey(base), reportKey({ ...base, ruleSetVersion: '4' }));
});

test('validateReport rifiuta campi extra e slot non clinici', () => {
  const valid = { clientProfileId: 'c1', fingerprint: 'fp', ingredientText: 'Riso', slot: 'lunch', errorType: 'unknown', ruleSetId: 'rs', ruleSetVersion: '3' };
  assert.equal(validateReport(valid).normalizedIngredient, 'riso');
  assert.throws(() => validateReport({ ...valid, authUid: 'leak' }), /campi non ammessi/);
  assert.throws(() => validateReport({ ...valid, slot: 'breakfast' }), /slot non valido/);
});

test('mapping guidato richiede tutte le dosi; libero non accetta dosi cliniche', () => {
  const guided = validateMapping({ kind: 'guided', canonicalIngredientId: 'riso', aliases: ['Riso'], family: 'riso', group: 'carb', doses: { lunch: { training: 90, rest: 70 }, dinner: { training: 40, rest: 40 } } });
  assert.equal(guided.aliases[0], 'riso');
  assert.throws(() => validateMapping({ ...guided, doses: { lunch: { training: 90, rest: 70 } } }), /mapping.doses/);
  const free = validateMapping({ kind: 'free', canonicalIngredientId: 'basilico', aliases: ['Basilico'], family: null, group: null, doses: null });
  assert.equal(free.group, 'free');
  assert.equal(free.doses, null);
});

test('rule set rifiuta famiglie duplicate e normalizza gli alias', () => {
  const rule = { family: 'pasta', group: 'carb', label: 'Pasta', aliases: ['Pàsta'], slots: { lunch: { training: 90, rest: 70 }, dinner: { training: 40, rest: 40 } } };
  assert.equal(validateRuleSetRules([rule])[0].aliases[0], 'pasta');
  assert.throws(() => validateRuleSetRules([rule, rule]), /duplicata/);
});

test('assignment valida checksum e intervallo temporale', () => {
  const input = {
    organizationId: 'org-1', clientId: 'client-1',
    ruleSet: { scope: 'tenant', ruleSetId: 'rs', version: '3', checksum: 'a'.repeat(64) },
    effectiveAt: '2026-09-09T10:00:00.000Z', expiresAt: '2026-10-09T10:00:00.000Z',
    strategy: 'migrate-on-confirmation', reason: 'Nuovo piano concordato', idempotencyKey: 'idem-1'
  };
  assert.equal(validateAssignment(input).ruleSet.version, '3');
  assert.throws(() => validateAssignment({ ...input, expiresAt: '2026-08-01T00:00:00Z' }), /successiva/);
  assert.throws(() => validateAssignment({ ...input, ruleSet: { ...input.ruleSet, checksum: 'bad' } }), /checksum/);
});

test('assenza, sospensione, programmazione e scadenza producono original-only', () => {
  const now = new Date('2026-09-09T12:00:00Z');
  assert.equal(effectiveAssignment(null, now).reason, 'missing');
  assert.equal(effectiveAssignment({ status: 'suspended', effectiveAt: '2026-09-01' }, now).valid, false);
  assert.equal(effectiveAssignment({ status: 'active', effectiveAt: '2026-09-10' }, now).reason, 'scheduled');
  assert.equal(effectiveAssignment({ status: 'active', effectiveAt: '2026-09-01', expiresAt: '2026-09-09T11:00:00Z' }, now).reason, 'expired');
  assert.equal(effectiveAssignment({ status: 'active', effectiveAt: '2026-09-01', expiresAt: null }, now).valid, true);
});

test('validateStructureAssignment (v2): risolve solo il contratto della modale', () => {
  const base = {
    organizationId: 'org-1', clientId: 'c1', ruleSetId: 'struttura-base',
    effectiveAt: '2026-09-12T09:00:00Z', expiresAt: '2026-12-31T00:00:00Z',
    withoutExpiration: false, notes: 'Percorso iniziale', idempotencyKey: 'k1'
  };
  const parsed = validateStructureAssignment(base);
  assert.equal(parsed.ruleSetId, 'struttura-base');
  assert.equal(parsed.notes, 'Percorso iniziale');
  assert.equal(parsed.withoutExpiration, false);
  // Il contratto rifiuta revisione/checksum/strategia inviati dal client.
  assert.throws(() => validateStructureAssignment({ ...base, checksum: 'a'.repeat(64) }), /campi non ammessi/);
  assert.throws(() => validateStructureAssignment({ ...base, strategy: 'freeze' }), /campi non ammessi/);
});

test('validateStructureAssignment: scadenza obbligatoria o flag esplicito', () => {
  const base = {
    organizationId: 'org-1', clientId: 'c1', ruleSetId: 'rs',
    effectiveAt: '2026-09-12T09:00:00Z', expiresAt: null,
    withoutExpiration: false, notes: '', idempotencyKey: 'k1'
  };
  // Senza scadenza E senza flag → rifiutato.
  assert.throws(() => validateStructureAssignment(base), /Senza scadenza/);
  // Con flag esplicito → accettato, expiresAt svuotato.
  const open = validateStructureAssignment({ ...base, withoutExpiration: true });
  assert.equal(open.expiresAt, null);
  assert.equal(open.withoutExpiration, true);
  // Flag attivo + data di scadenza → inconsistente.
  assert.throws(() => validateStructureAssignment({ ...base, withoutExpiration: true, expiresAt: '2026-12-31T00:00:00Z' }), /Senza scadenza/);
  // Note omessa → stringa vuota (nessun dato sanitario obbligatorio).
  assert.equal(validateStructureAssignment({ ...base, expiresAt: '2026-12-31T00:00:00Z' }).notes, '');
});

test('validateDietStructureRules: contratto revisione struttura (schema v2)', () => {
  const base = {
    mellerFamilyId: 'pane', ingredientIds: ['pane'],
    quantityGrams: { lunch: { training: 120, rest: 90 }, dinner: { training: 60, rest: 60 } },
    enabled: true, categoryId: 'pane'
  };
  const parsed = validateDietStructureRules([base])[0];
  assert.equal(parsed.mellerFamilyId, 'pane');
  assert.equal(parsed.quantityGrams.lunch.training, 120);
  // Un pasto può essere null (non gestito dalla struttura), mai entrambi.
  const onlyLunch = validateDietStructureRules([{ ...base, quantityGrams: { lunch: base.quantityGrams.lunch, dinner: null } }])[0];
  assert.equal(onlyLunch.quantityGrams.dinner, null);
  assert.throws(() => validateDietStructureRules([{ ...base, quantityGrams: { lunch: null, dinner: null } }]), /almeno una dose/);
  // Dosi fuori range o non intere → bloccanti, mai quantità inventate.
  assert.throws(() => validateDietStructureRules([{ ...base, quantityGrams: { ...base.quantityGrams, lunch: { training: 2001, rest: 10 } } }]), /1 e 2000/);
  assert.throws(() => validateDietStructureRules([{ ...base, quantityGrams: { ...base.quantityGrams, lunch: { training: 12.5, rest: 10 } } }]), /1 e 2000/);
  // enabled default true; enabled non booleano → errore.
  assert.equal(validateDietStructureRules([{ mellerFamilyId: 'uova', quantityGrams: { lunch: { training: 10, rest: 10 }, dinner: null } }])[0].enabled, true);
  assert.throws(() => validateDietStructureRules([{ ...base, enabled: 'sì' }]), /booleano/);
  // Fase 2: la famiglia deve esistere nel motore (niente regole orfane).
  assert.throws(() => validateDietStructureRules([{ ...base, mellerFamilyId: 'famiglia-inesistente' }]), /non esiste nel motore/);
});

test('validateDietStructureRules: niente famiglie duplicate né campi extra', () => {
  const rule = id => ({ mellerFamilyId: id, quantityGrams: { lunch: { training: 50, rest: 40 }, dinner: null } });
  assert.throws(() => validateDietStructureRules([rule('pane'), rule('pane')]), /duplicata/);
  assert.throws(() => validateDietStructureRules([{ ...rule('riso'), version: '3' }]), /campi non ammessi/);
  assert.throws(() => validateDietStructureRules([]), /tra 1 e 40/);
});

test('validateStructureAssignment (Fase 2): structureId operativo, ruleSetId solo legacy', () => {
  const base = {
    organizationId: 'org-1', clientId: 'c1',
    effectiveAt: '2026-09-12T09:00:00Z', expiresAt: '2026-12-31T00:00:00Z',
    withoutExpiration: false, notes: 'Percorso iniziale', idempotencyKey: 'k1'
  };
  const modern = validateStructureAssignment({ ...base, structureId: 'struttura-1' });
  assert.equal(modern.structureId, 'struttura-1');
  assert.equal(modern.ruleSetId, null);
  // Percorso legacy ancora accettato per i client già rilasciati.
  const legacy = validateStructureAssignment({ ...base, ruleSetId: 'vecchia-1' });
  assert.equal(legacy.ruleSetId, 'vecchia-1');
  assert.equal(legacy.structureId, null);
  // Esattamente uno dei due: nessuno o entrambi → rifiuto.
  assert.throws(() => validateStructureAssignment(base), /structureId/);
  assert.throws(() => validateStructureAssignment({ ...base, structureId: 'a', ruleSetId: 'b' }), /structureId/);
  // Regole scadenza/flag invariate sul nuovo contratto.
  assert.throws(() => validateStructureAssignment({ ...base, structureId: 'a', expiresAt: null }), /Senza scadenza/);
});

test('MELLER_FAMILY_IDS: parità esatta con il motore client (solo ID, mai dosi)', () => {
  const engine = ClientDomain.MELLER_GRAMMATURE.map(rule => rule.family);
  assert.equal(MELLER_FAMILY_IDS.size, 25);
  assert.deepEqual([...MELLER_FAMILY_IDS].sort(), [...engine].sort());
});

test('aliasKey server-side: parità esatta con js/domain.js (accenti, alias, punteggiatura)', () => {
  const cases = ['  Rìso   Venere! ', 'Uova intere (sode)', 'Quinoa/Grano saraceno', 'Cous cous', 'Farro/Orzo', 'pepe nero', ''];
  cases.forEach(value => assert.equal(aliasKey(value), ClientDomain.aliasKey(value), JSON.stringify(value)));
  assert.equal(searchTokensFor('Riso Venere', ['riso nero']).join(','), ClientDomain.searchTokensFor('Riso Venere', ['riso nero']).join(','));
});

test('validateAlternativeGroups: CRUD gruppi con voci ingrediente + dosi proprie', () => {
  const groups = validateAlternativeGroups([{
    alternativeGroupId: 'carboidrati', displayName: 'Alternative carboidrati',
    items: [
      { ingredientId: 'pasta', quantityGrams: { lunch: { training: 90, rest: 70 }, dinner: { training: 40, rest: 40 } } },
      { ingredientId: 'riso', quantityGrams: { lunch: { training: 80, rest: 60 }, dinner: null } }
    ]
  }]);
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[0].items[1].quantityGrams.dinner, null);
  assert.deepEqual(validateAlternativeGroups(undefined), []);
  assert.deepEqual(validateAlternativeGroups(null), []);
  // Gruppi duplicati, voci duplicate, dosi fuori range, pasti entrambi null.
  const item = (ingredientId, lunch = { training: 50, rest: 40 }) => ({ ingredientId, quantityGrams: { lunch, dinner: null } });
  assert.throws(() => validateAlternativeGroups([
    { alternativeGroupId: 'gruppo-a', displayName: 'G', items: [item('a')] },
    { alternativeGroupId: 'gruppo-a', displayName: 'G2', items: [item('b')] }
  ]), /duplicato/);
  assert.throws(() => validateAlternativeGroups([{ alternativeGroupId: 'gruppo-a', displayName: 'G', items: [item('a'), item('a')] }]), /duplicato/);
  assert.throws(() => validateAlternativeGroups([{ alternativeGroupId: 'gruppo-a', displayName: 'G', items: [item('a', { training: 5000, rest: 1 })] }]), /1 e 2000/);
  assert.throws(() => validateAlternativeGroups([{ alternativeGroupId: 'gruppo-a', displayName: 'G', items: [{ ingredientId: 'a', quantityGrams: { lunch: null, dinner: null } }] }]), /almeno una dose/);
  assert.throws(() => validateAlternativeGroups([{ alternativeGroupId: 'G-MAIUSCOLO', displayName: 'G', items: [item('a')] }]), /alternativeGroupId/);
  assert.throws(() => validateAlternativeGroups([{ alternativeGroupId: 'gruppo-a', displayName: 'G', items: [] }]), /tra 1 e 50/);
});

test('revisioni struttura: checksum schema 2 e verifica legacy schema 1', () => {
  assert.equal(STRUCTURE_REVISION_SCHEMA_VERSION, 2);
  const rules = [{ mellerFamilyId: 'pane' }];
  const groups = [{ alternativeGroupId: 'carboidrati' }];
  const sum = structureRevisionChecksum({ schemaVersion: 2, rules, alternativeGroups: groups });
  assert.equal(sum, checksum({ schemaVersion: 2, rules, alternativeGroups: groups }));
  assert.ok(verifyStructureRevision({ status: 'published', schemaVersion: 2, rules, alternativeGroups: groups, checksum: sum }));
  // Le alternative contribuiscono al checksum: manomissione rilevata.
  assert.equal(verifyStructureRevision({ status: 'published', schemaVersion: 2, rules, alternativeGroups: [], checksum: sum }), false);
  // Revisioni pubblicate prima della Fase 2 (schema 1, solo rules) verificabili.
  const legacy = checksum({ schemaVersion: 1, rules });
  assert.ok(verifyStructureRevision({ status: 'published', schemaVersion: 1, rules, checksum: legacy }));
  assert.equal(verifyStructureRevision({ status: 'draft', schemaVersion: 2, rules, alternativeGroups: groups, checksum: sum }), false);
  assert.equal(verifyStructureRevision({ status: 'published', schemaVersion: 2, rules: [], alternativeGroups: groups, checksum: sum }), false);
});

test('import catalogo: parsing JSON (array e oggetto) e CSV con intestazione', () => {
  const fromArray = parseCatalogPayload('json', JSON.stringify([{ ingredientId: 'x', displayName: 'X' }]));
  assert.equal(fromArray.ingredients.length, 1);
  assert.deepEqual(fromArray.categories, []);
  const fromObject = parseCatalogPayload('json', fixture('catalog-import-valid.json'));
  assert.equal(fromObject.ingredients.length, 2);
  assert.equal(fromObject.categories.length, 1);
  const fromCsv = parseCatalogPayload('csv', fixture('catalog-import-valid.csv'));
  assert.equal(fromCsv.ingredients.length, 2);
  assert.equal(fromCsv.ingredients[0].mellerFamilyId, 'pseudo');
  assert.equal(fromCsv.ingredients[1].mellerFamilyId, null);
  assert.deepEqual(fromCsv.ingredients[0].aliases, ['sorgo bianco', 'sorgo decorticato']);
  assert.throws(() => parseCatalogPayload('xml', 'x'), /format non valido/);
  assert.throws(() => parseCatalogPayload('json', '{malformato'), /JSON non valido/);
  assert.throws(() => parseCatalogPayload('json', JSON.stringify({ ingredients: [] })), /Import vuoto/);
  assert.throws(() => parseCatalogPayload('csv', 'ingredientId;displayName\nsolo;due'), /intestazione obbligatoria/);
  assert.throws(() => parseCatalogPayload('csv', 'ingredientId;displayName;categoryId;mappingKind\nsorgo;Sorgo'), /invece di/);
});

test('import catalogo: zero quantità — chiavi dose rifiutano l’intero file', () => {
  for (const doseKey of ['quantityGrams', 'grams', 'doses', 'slots', 'quantity']) {
    assert.throws(
      () => parseCatalogPayload('json', JSON.stringify([{ ingredientId: 'x', displayName: 'X', [doseKey]: 10 }])),
      /campo dose vietato/,
      doseKey
    );
  }
  assert.throws(
    () => parseCatalogPayload('csv', 'ingredientId;displayName;categoryId;mappingKind;quantityGrams\nx;X;carb;guided;10'),
    /colonna dose vietata/
  );
});

test('import catalogo: dry-run valido senza scritture (conteggi + diff + previewId)', () => {
  const parsed = parseCatalogPayload('json', fixture('catalog-import-valid.json'));
  const report = validateCatalogImport(parsed, { existingIngredients: {}, existingCategories: ['carb'], denylist: [] });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.counts, { create: 3, identical: 0, update: 0, conflicts: 0, errors: 0 });
  assert.equal(report.normalized.ingredients.length, 2);
  assert.equal(report.normalized.categories.length, 1);
  // searchTokens rigenerati server-side, mai dal file.
  assert.ok(report.normalized.ingredients[0].searchTokens.includes('sorgo'));
  assert.ok(report.normalized.ingredients[0].searchTokens.includes('bianco'));
  assert.equal(report.diffTruncated, false);
  const preview = catalogImportPreviewId(report.normalized, 1);
  assert.equal(preview.length, 64);
  assert.equal(catalogImportPreviewId(report.normalized, 1), preview, 'deterministico');
  assert.notEqual(catalogImportPreviewId(report.normalized, 2), preview, 'legato alla versione base');
});

test('import catalogo: CSV valido produce lo stesso normalizzato del JSON', () => {
  const fromJson = validateCatalogImport(parseCatalogPayload('json', fixture('catalog-import-valid.json')), { existingIngredients: {}, existingCategories: ['carb', 'cereali-minori'], denylist: [] });
  const fromCsv = validateCatalogImport(parseCatalogPayload('csv', fixture('catalog-import-valid.csv')), { existingIngredients: {}, existingCategories: ['carb', 'cereali-minori'], denylist: [] });
  assert.deepEqual(fromCsv.errors, []);
  assert.deepEqual(fromCsv.normalized.ingredients, fromJson.normalized.ingredients);
});

test('import catalogo: collisione alias con ingrediente esistente diverso → conflitto bloccante', () => {
  const parsed = parseCatalogPayload('json', fixture('catalog-import-alias-collision.json'));
  const existing = { riso: { displayName: 'Riso', aliases: ['riso', 'riso in bianco'], categoryId: 'carb', mappingKind: 'guided', mellerFamilyId: 'riso' } };
  const report = validateCatalogImport(parsed, { existingIngredients: existing, existingCategories: ['carb'], denylist: [] });
  assert.equal(report.counts.conflicts, 1);
  assert.match(report.errors.join('\n'), /collisione alias/);
  assert.match(report.errors.join('\n'), /riso/);
  // Stesso ID = aggiornamento lecito, non collisione.
  const selfUpdate = validateCatalogImport(
    parseCatalogPayload('json', JSON.stringify([{ ingredientId: 'riso', displayName: 'Riso', aliases: ['riso'], categoryId: 'carb', mappingKind: 'guided', mellerFamilyId: 'riso' }])),
    { existingIngredients: existing, existingCategories: ['carb'], denylist: [] }
  );
  assert.deepEqual(selfUpdate.errors, []);
  assert.equal(selfUpdate.counts.update + selfUpdate.counts.identical, 1);
});

test('import catalogo: denylist provvisoria blocca l’ID (meccanismo, ID demo)', () => {
  // NOTA: l'ID nella fixture è un segnaposto dimostrativo. I 58 ID reali del
  // lotto provvisorio non entrano mai nel repository: vivono solo nella
  // configurazione server-side (globalIngredientCatalog/config/denylist).
  const parsed = parseCatalogPayload('json', fixture('catalog-import-provisional-denied.json'));
  const report = validateCatalogImport(parsed, { existingIngredients: {}, existingCategories: ['carb'], denylist: ['provisional-demo-non-importabile'] });
  assert.match(report.errors.join('\n'), /denylist/);
  assert.equal(report.normalized.ingredients.length, 0, 'la voce bloccata non entra nel normalizzato');
  assert.equal(report.diff.filter(row => row.change === 'error').length, 1);
});

test('import catalogo: dedup, riferimenti, guided/free e categorie', () => {
  const dup = parseCatalogPayload('json', JSON.stringify([
    { ingredientId: 'sorgo', displayName: 'Sorgo', aliases: [], categoryId: 'carb', mappingKind: 'guided', mellerFamilyId: 'pseudo' },
    { ingredientId: 'sorgo', displayName: 'Sorgo bis', aliases: [], categoryId: 'carb', mappingKind: 'guided', mellerFamilyId: 'pseudo' }
  ]));
  assert.match(validateCatalogImport(dup, { existingIngredients: {}, existingCategories: ['carb'], denylist: [] }).errors.join('\n'), /duplicato/);
  const badCategory = parseCatalogPayload('json', JSON.stringify([
    { ingredientId: 'sorgo', displayName: 'Sorgo', aliases: [], categoryId: 'inesistente', mappingKind: 'guided', mellerFamilyId: 'pseudo' }
  ]));
  assert.match(validateCatalogImport(badCategory, { existingIngredients: {}, existingCategories: ['carb'], denylist: [] }).errors.join('\n'), /inesistente/);
  // Categoria dichiarata nel file → riferimento valido.
  const withFileCategory = validateCatalogImport(parseCatalogPayload('json', fixture('catalog-import-valid.json')), { existingIngredients: {}, existingCategories: ['carb'], denylist: [] });
  assert.deepEqual(withFileCategory.errors, []);
  const guidedNoFamily = parseCatalogPayload('json', JSON.stringify([
    { ingredientId: 'sorgo', displayName: 'Sorgo', aliases: [], categoryId: 'carb', mappingKind: 'guided', mellerFamilyId: null }
  ]));
  assert.match(validateCatalogImport(guidedNoFamily, { existingIngredients: {}, existingCategories: ['carb'], denylist: [] }).errors.join('\n'), /mellerFamilyId/);
  const freeWithFamily = parseCatalogPayload('json', JSON.stringify([
    { ingredientId: 'free-x', displayName: 'X libera', aliases: [], categoryId: 'free', mappingKind: 'free', mellerFamilyId: 'riso' }
  ]));
  assert.match(validateCatalogImport(freeWithFamily, { existingIngredients: {}, existingCategories: [], denylist: [] }).errors.join('\n'), /non ammette/);
  const unknownFamily = parseCatalogPayload('json', JSON.stringify([
    { ingredientId: 'sorgo', displayName: 'Sorgo', aliases: [], categoryId: 'carb', mappingKind: 'guided', mellerFamilyId: 'famiglia-futura' }
  ]));
  assert.match(validateCatalogImport(unknownFamily, { existingIngredients: {}, existingCategories: ['carb'], denylist: [] }).errors.join('\n'), /inesistente nel motore/);
  // Collisione dentro il file tra ID diversi (stesso alias normalizzato).
  const internal = parseCatalogPayload('json', JSON.stringify([
    { ingredientId: 'a-ok', displayName: 'Sorgo', aliases: [], categoryId: 'carb', mappingKind: 'guided', mellerFamilyId: 'pseudo' },
    { ingredientId: 'b-ok', displayName: 'SORGO', aliases: [], categoryId: 'carb', mappingKind: 'guided', mellerFamilyId: 'pseudo' }
  ]));
  assert.match(validateCatalogImport(internal, { existingIngredients: {}, existingCategories: ['carb'], denylist: [] }).errors.join('\n'), /stesso file/);
});

test('import catalogo: diff troncato a 200 righe con flag', () => {
  const ingredients = Array.from({ length: 210 }, (_, i) => ({
    ingredientId: `voce-${String(i).padStart(3, '0')}`, displayName: `Voce ${i}`, aliases: [],
    categoryId: 'carb', mappingKind: 'guided', mellerFamilyId: 'riso'
  }));
  const report = validateCatalogImport(parseCatalogPayload('json', JSON.stringify(ingredients)), { existingIngredients: {}, existingCategories: ['carb'], denylist: [] });
  assert.deepEqual(report.errors, []);
  assert.equal(report.diff.length, 200);
  assert.equal(report.diffTruncated, true);
  assert.equal(report.counts.create, 210);
});

test('utenti: validatori inviti, link, stati e username normalizzati', () => {
  assert.equal(normalizeUsername('  Nutri_Maria.1 '), 'nutri_maria.1');
  assert.throws(() => normalizeUsername('ab'), /username non valido/);
  assert.throws(() => normalizeUsername('con spazi'), /username non valido/);
  assert.equal(hashToken('abc').length, 64);
  assert.equal(hashToken('abc'), hashToken('abc'));
  assert.notEqual(hashToken('abc'), hashToken('abd'));
  const invite = validateInviteOrganizationUser({ organizationId: 'org-1', username: 'Nuova.Nutri', role: 'nutritionist', idempotencyKey: 'k1' });
  assert.equal(invite.username, 'nuova.nutri');
  assert.throws(() => validateInviteOrganizationUser({ organizationId: 'org-1', username: 'x-ray-1', role: 'admin', idempotencyKey: 'k1' }), /solo nutritionist/);
  const link = validateInviteClientLink({ organizationId: 'org-1', username: 'Cliente-1', nutritionistUid: '', idempotencyKey: 'k1' });
  assert.equal(link.username, 'cliente-1');
  assert.equal(link.nutritionistUid, null);
  assert.throws(() => validateRespondClientLink({ requestId: 'r1', decision: 'forse' }), /decision/);
  assert.throws(() => validateMemberStatus({ organizationId: 'o', userId: 'u', status: 'removed', idempotencyKey: 'k' }), /active\|suspended/);
  assert.throws(() => validateRemoveClientLink({ organizationId: 'o', clientId: 'c', reason: 'no', idempotencyKey: 'k' }), /reason/);
  const transfer = validateTransferStructureOwnership({ organizationId: 'o', structureId: 's', newOwnerUid: 'uid-2', idempotencyKey: 'k' });
  assert.equal(transfer.newOwnerUid, 'uid-2');
  const remove = validateRemoveNutritionist({ organizationId: 'o', userId: 'uid-2', idempotencyKey: 'k' });
  assert.equal(remove.userId, 'uid-2');
});
