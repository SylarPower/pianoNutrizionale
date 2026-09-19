'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalJson, checksum, normalizeIngredient, aliasKey, searchTokensFor, normalizeUsername, hashToken,
  STRUCTURE_REVISION_SCHEMA_VERSION, EQUIVALENCE_TEMPLATE_SCHEMA_VERSION,
  validateStructureAssignment, structureRevisionChecksum, verifyStructureRevision, effectiveAssignment,
  DIET_PLAN_SCHEMA_VERSION, validateDietPlan, DIET_PLAN_LIMITS,
  validateEquivalenceTemplateRevision, equivalenceTemplateRevisionChecksum, verifyEquivalenceTemplateRevision,
  CATALOG_REQUEST_STATUSES, validateCatalogRequestSubmit, validateCatalogRequestResolve,
  parseCatalogPayload, validateCatalogImport, catalogImportPreviewId,
  validateInviteOrganizationUser, validateInviteClientLink, validateRespondClientLink,
  validateRemoveClientLink, validateMemberStatus, validateRemoveNutritionist,
  validateTransferStructureOwnership,
  RECIPE_SLOTS, PROFESSIONAL_RECIPE_VISIBILITY, PROFESSIONAL_RECIPE_LIMITS,
  validateProfessionalRecipePortions, validateProfessionalRecipeIngredient, validateProfessionalRecipe
} = require('../src/domain');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('canonicalJson e checksum sono indipendenti dall’ordine delle chiavi', () => {
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.equal(checksum({ a: 1, b: 2 }), checksum({ b: 2, a: 1 }));
  assert.notEqual(checksum({ a: 1 }), checksum({ a: 2 }));
});

test('normalizzazione ingrediente è deterministica e minimizza il fingerprint', () => {
  assert.equal(normalizeIngredient('  Pomodorini   ciliegia '), normalizeIngredient('pomodorini ciliegia'));
  assert.equal(normalizeIngredient('Pasta \u00E0lle zucchine'), normalizeIngredient('pasta alle zucchine'));
  assert.equal(aliasKey('Cous\u00E0 Cous'), aliasKey('cousa cous'), 'accenti tollerati');
  assert.deepEqual(searchTokensFor('Yogurt greco magro o Skyr').slice(0, 2), ['yogurt', 'greco']);
});

test('validateStructureAssignment: structureId operativo, niente campi clinici', () => {
  const base = {
    organizationId: 'org-1', clientId: 'c1', structureId: 'struttura-base',
    effectiveAt: '2026-09-12T09:00:00Z', expiresAt: '2026-12-31T00:00:00Z',
    withoutExpiration: false, notes: 'Percorso iniziale', idempotencyKey: 'k1'
  };
  const parsed = validateStructureAssignment(base);
  assert.equal(parsed.structureId, 'struttura-base');
  assert.equal(parsed.notes, 'Percorso iniziale');
  assert.equal(parsed.withoutExpiration, false);
  // Il contratto rifiuta checksum/strategia/revisione inviati dal client.
  assert.throws(() => validateStructureAssignment({ ...base, checksum: 'a'.repeat(64) }), /campi non ammessi/);
  assert.throws(() => validateStructureAssignment({ ...base, strategy: 'freeze' }), /campi non ammessi/);
  // structureId obbligatorio: la struttura si assegna, non si descrive a mano.
  assert.throws(() => validateStructureAssignment({ ...base, structureId: '' }), /structureId/);
});

test('validateStructureAssignment: scadenza obbligatoria o flag esplicito', () => {
  const base = {
    organizationId: 'org-1', clientId: 'c1', structureId: 's1',
    effectiveAt: '2026-09-12T09:00:00Z', expiresAt: null,
    withoutExpiration: false, notes: '', idempotencyKey: 'k1'
  };
  assert.throws(() => validateStructureAssignment(base), /Senza scadenza/);
  const open = validateStructureAssignment({ ...base, withoutExpiration: true });
  assert.equal(open.expiresAt, null);
  assert.equal(open.withoutExpiration, true);
  assert.throws(() => validateStructureAssignment({ ...base, withoutExpiration: true, expiresAt: '2026-12-31T00:00:00Z' }), /non ammessa/);
  assert.throws(() => validateStructureAssignment({ ...base, expiresAt: '2026-01-01T00:00:00Z' }), /successiva/);
  assert.equal(validateStructureAssignment({ ...base, expiresAt: '2026-12-31T00:00:00Z' }).notes, '');
});

test('assenza, sospensione, programmazione e scadenza producono original-only', () => {
  const now = new Date('2026-09-09T12:00:00Z');
  assert.equal(effectiveAssignment(null, now).reason, 'missing');
  assert.equal(effectiveAssignment({ status: 'suspended', effectiveAt: '2026-09-01' }, now).valid, false);
  assert.equal(effectiveAssignment({ status: 'active', effectiveAt: '2026-09-10' }, now).reason, 'scheduled');
  assert.equal(effectiveAssignment({ status: 'active', effectiveAt: '2026-09-01', expiresAt: '2026-09-09T11:00:00Z' }, now).reason, 'expired');
  assert.equal(effectiveAssignment({ status: 'active', effectiveAt: '2026-09-01', expiresAt: null }, now).valid, true);
});

test('revisioni struttura: checksum schema corrente e verifica fail-closed', () => {
  const dietPlan = validateDietPlan({
    schemaVersion: DIET_PLAN_SCHEMA_VERSION,
    days: [{
      dayId: 'giorno-1', label: '', dayType: 'training',
      meals: [{ mealId: 'lunch', time: '', options: [{ optionId: 'o1', type: 'ingredients', items: [{ itemId: 'i1', ingredientId: 'riso', amount: { value: 80, unit: 'g' } }] }] }],
      supplements: '', hydration: '', note: ''
    }],
    generalNotes: ''
  });
  const revision = { schemaVersion: STRUCTURE_REVISION_SCHEMA_VERSION, status: 'published', dietPlan };
  revision.checksum = structureRevisionChecksum({ schemaVersion: STRUCTURE_REVISION_SCHEMA_VERSION, dietPlan });
  assert.equal(verifyStructureRevision(revision), true);
  assert.equal(verifyStructureRevision({ ...revision, dietPlan: { ...dietPlan, generalNotes: 'modificato' } }), false, 'checksum legato al contenuto');
  assert.equal(verifyStructureRevision({ ...revision, schemaVersion: 2 }), false, 'schema obsoleto rifiutato');
  assert.equal(verifyStructureRevision({ ...revision, status: 'draft' }), false, 'solo revisioni pubblicate');
});

test('template equivalenze: validazione, checksum e verifica', () => {
  const template = {
    name: 'Amidi — porzione standard',
    referenceFamilyId: 'cereali',
    referenceIngredientId: 'riso',
    referenceAmount: { value: 80, unit: 'g' },
    equivalents: [
      { familyId: 'patate', ingredientId: 'patate', amount: { value: 250, unit: 'g' } },
      { familyId: 'pane-e-affini', ingredientId: null, amount: { value: 70, unit: 'g' } }
    ]
  };
  const revision = validateEquivalenceTemplateRevision(template);
  assert.equal(revision.schemaVersion, EQUIVALENCE_TEMPLATE_SCHEMA_VERSION);
  // La famiglia di riferimento non è un equivalente di se stessa.
  assert.throws(() => validateEquivalenceTemplateRevision({
    ...template, equivalents: [...template.equivalents, { familyId: 'cereali', ingredientId: null, amount: { value: 80, unit: 'g' } }]
  }), /famiglia di riferimento/);
  // Dosi nulle o negative rifiutate, quantità proporzionali > 0.
  assert.throws(() => validateEquivalenceTemplateRevision({ ...template, referenceAmount: { value: 0, unit: 'g' } }), /maggiore di zero/);
  // Equivalente duplicato rifiutato.
  assert.throws(() => validateEquivalenceTemplateRevision({ ...template, equivalents: [...template.equivalents, template.equivalents[0]] }), /duplicato/);
  // Checksum e verifica.
  const checksummed = { ...revision, status: 'published', checksum: equivalenceTemplateRevisionChecksum(revision) };
  assert.equal(verifyEquivalenceTemplateRevision(checksummed), true);
  assert.equal(verifyEquivalenceTemplateRevision({ ...checksummed, name: 'Altro nome' }), false);
});

test('richieste catalogo: submit dal cliente e risoluzione admin', () => {
  assert.deepEqual([...CATALOG_REQUEST_STATUSES], ['pending', 'accepted', 'rejected', 'superseded']);
  const submitted = validateCatalogRequestSubmit({ ingredientText: 'Tonno al naturale', proposedCategoryId: 'protein', proposedFamilyId: 'pesce-scatola-naturale', idempotencyKey: 'k1' });
  assert.equal(submitted.ingredientText, 'Tonno al naturale');
  assert.throws(() => validateCatalogRequestSubmit({ ingredientText: '', proposedCategoryId: 'protein', proposedFamilyId: 'pesce', idempotencyKey: 'k1' }), /ingredientText/);
  const accepted = validateCatalogRequestResolve({
    requestId: 'r1', action: 'accept',
    ingredient: { ingredientId: 'tonno-naturale', displayName: 'Tonno al naturale', aliases: ['tonno'], categoryId: 'protein', familyId: 'pesce-scatola-naturale', vegetarian: false, vegan: false },
    idempotencyKey: 'k2'
  });
  assert.equal(accepted.ingredient.ingredientId, 'tonno-naturale');
  assert.equal(accepted.ingredient.dietaryFlags.vegetarian, false);
  // Il rifiuto richiede una motivazione; l'ingrediente non si accompagna al rifiuto.
  assert.throws(() => validateCatalogRequestResolve({ requestId: 'r1', action: 'reject', reason: 'no', idempotencyKey: 'k3' }), /reason/);
  assert.throws(() => validateCatalogRequestResolve({
    requestId: 'r1', action: 'reject', reason: 'Già presente con altro nome',
    ingredient: { ingredientId: 'x', displayName: 'X', categoryId: 'protein', familyId: 'pesce' }, idempotencyKey: 'k4'
  }), /ingredient non ammesso/);
  // Flag dietetici obbligatoriamente booleani nella risoluzione.
  assert.throws(() => validateCatalogRequestResolve({
    requestId: 'r1', action: 'accept',
    ingredient: { ingredientId: 'ingrediente-x', displayName: 'X', categoryId: 'protein', familyId: 'pesce', vegetarian: 'sì', vegan: false },
    idempotencyKey: 'k5'
  }), /booleani/);
});

// ---------------------------------------------------------------------
// Import catalogo globale (identità e solo identità)
// ---------------------------------------------------------------------

test('import catalogo: parsing JSON (array e oggetto) e CSV con intestazione', () => {
  const fromArray = parseCatalogPayload('json', JSON.stringify([{ ingredientId: 'x', displayName: 'X', categoryId: 'carb', familyId: 'f' }]));
  assert.equal(fromArray.ingredients.length, 1);
  assert.deepEqual(fromArray.categories, []);
  assert.deepEqual(fromArray.families, []);
  const fromObject = parseCatalogPayload('json', fixture('catalog-import-valid.json'));
  assert.equal(fromObject.ingredients.length, 2);
  assert.equal(fromObject.categories.length, 1);
  assert.equal(fromObject.families.length, 1);
  const fromCsv = parseCatalogPayload('csv', fixture('catalog-import-valid.csv'));
  assert.equal(fromCsv.ingredients.length, 2);
  assert.equal(fromCsv.ingredients[0].familyId, 'sorgo-e-affini');
  assert.deepEqual(fromCsv.ingredients[0].aliases, ['sorgo bianco', 'sorgo decorticato']);
  assert.deepEqual(fromCsv.ingredients[0].dietaryFlags, { vegetarian: true, vegan: true });
  // Colonne flag vuote restano assenti: il default (false) arriva in validateCatalogImport.
  const sparseCsv = parseCatalogPayload('csv', 'ingredientId;displayName;categoryId;familyId;vegetarian;vegan\nx;X;carb;cereali;;');
  assert.deepEqual(sparseCsv.ingredients[0].dietaryFlags, {});
  assert.throws(() => parseCatalogPayload('xml', 'x'), /format non valido/);
  assert.throws(() => parseCatalogPayload('json', '{malformato'), /JSON non valido/);
  assert.throws(() => parseCatalogPayload('json', JSON.stringify({ ingredients: [] })), /Import vuoto/);
  assert.throws(() => parseCatalogPayload('csv', 'ingredientId;displayName\nsolo;due'), /intestazione obbligatoria/);
  assert.throws(() => parseCatalogPayload('csv', 'ingredientId;displayName;categoryId;quantita\nsorgo;Sorgo;carb;10'), /colonna dose vietata/);
  assert.throws(() => parseCatalogPayload('csv', 'ingredientId;displayName;categoryId;familyId\nsorgo;Sorgo'), /invece di/);
});

test('import catalogo: zero quantità — chiavi dose rifiutano l’intero file', () => {
  for (const doseKey of ['quantityGrams', 'grams', 'doses', 'slots', 'quantity']) {
    assert.throws(
      () => parseCatalogPayload('json', JSON.stringify([{ ingredientId: 'x', displayName: 'X', categoryId: 'carb', familyId: 'f', [doseKey]: 10 }])),
      /campo dose vietato/,
      doseKey
    );
  }
  assert.throws(
    () => parseCatalogPayload('csv', 'ingredientId;displayName;categoryId;familyId;quantityGrams\nx;X;carb;f;10'),
    /colonna dose vietata/
  );
});

test('import catalogo: dry-run valido senza scritture (conteggi + diff + previewId)', () => {
  const parsed = parseCatalogPayload('json', fixture('catalog-import-valid.json'));
  const report = validateCatalogImport(parsed, { existingIngredients: {}, existingCategories: ['carb', 'free'], existingFamilies: { 'erbe-aromatiche': { familyId: 'erbe-aromatiche', displayName: 'Erbe aromatiche', categoryId: 'free', sortOrder: 0 } }, denylist: [] });
  assert.deepEqual(report.errors, []);
  // 2 ingredienti + 1 categoria + 1 famiglia di nuova creazione.
  assert.deepEqual(report.counts, { create: 4, identical: 0, update: 0, conflicts: 0, errors: 0 });
  assert.equal(report.normalized.ingredients.length, 2);
  assert.equal(report.normalized.categories.length, 1);
  assert.equal(report.normalized.families.length, 1);
  // searchTokens rigenerati server-side, mai dal file.
  assert.ok(report.normalized.ingredients[0].searchTokens.includes('sorgo'));
  assert.ok(report.normalized.ingredients[0].searchTokens.includes('bianco'));
  // Flag dietetici canonizzati in booleani.
  assert.deepEqual(report.normalized.ingredients[0].dietaryFlags, { vegetarian: true, vegan: true });
  assert.deepEqual(report.normalized.ingredients[1].dietaryFlags, { vegetarian: true, vegan: true });
  assert.equal(report.diffTruncated, false);
  const preview = catalogImportPreviewId(report.normalized, 1);
  assert.equal(preview.length, 64);
  assert.equal(catalogImportPreviewId(report.normalized, 1), preview, 'deterministico');
  assert.notEqual(catalogImportPreviewId(report.normalized, 2), preview, 'legato alla versione base');
});

test('import catalogo: CSV valido produce lo stesso normalizzato del JSON', () => {
  const options = {
    existingIngredients: {},
    existingCategories: ['carb', 'free', 'cereali-minori'],
    existingFamilies: {
      'erbe-aromatiche': { familyId: 'erbe-aromatiche', displayName: 'Erbe aromatiche', categoryId: 'free', sortOrder: 0 },
      'sorgo-e-affini': { familyId: 'sorgo-e-affini', displayName: 'Sorgo e affini', categoryId: 'cereali-minori', sortOrder: 10 }
    },
    denylist: []
  };
  const fromJson = validateCatalogImport(parseCatalogPayload('json', fixture('catalog-import-valid.json')), options);
  const fromCsv = validateCatalogImport(parseCatalogPayload('csv', fixture('catalog-import-valid.csv')), options);
  assert.deepEqual(fromCsv.errors, []);
  assert.deepEqual(fromCsv.normalized.ingredients, fromJson.normalized.ingredients);
  assert.deepEqual(fromCsv.normalized.categories, fromJson.normalized.categories);
});

test('import catalogo: collisione alias con ingrediente esistente diverso → conflitto bloccante', () => {
  const parsed = parseCatalogPayload('json', fixture('catalog-import-alias-collision.json'));
  const existing = { riso: { displayName: 'Riso', aliases: ['riso', 'riso in bianco'], categoryId: 'carb', familyId: 'cereali', dietaryFlags: { vegetarian: true, vegan: true } } };
  const options = { existingIngredients: existing, existingCategories: ['carb'], existingFamilies: { cereali: { familyId: 'cereali', displayName: 'Cereali', categoryId: 'carb', sortOrder: 0 } }, denylist: [] };
  const report = validateCatalogImport(parsed, options);
  assert.equal(report.counts.conflicts, 1);
  assert.match(report.errors.join('\n'), /collisione alias/);
  assert.match(report.errors.join('\n'), /riso/);
  // Stesso ID = aggiornamento lecito, non collisione.
  const selfUpdate = validateCatalogImport(
    parseCatalogPayload('json', JSON.stringify([{ ingredientId: 'riso', displayName: 'Riso', aliases: ['riso'], categoryId: 'carb', familyId: 'cereali', dietaryFlags: { vegetarian: true, vegan: true } }])),
    options
  );
  assert.deepEqual(selfUpdate.errors, []);
  assert.equal(selfUpdate.counts.update + selfUpdate.counts.identical, 1);
});

test('import catalogo: denylist provvisoria blocca l’ID (meccanismo, ID demo)', () => {
  // NOTA: l'ID nella fixture è un segnaposto dimostrativo. Gli ID reali del
  // lotto provvisorio non entrano mai nel repository: vivono solo nella
  // configurazione server-side (globalIngredientCatalog/config/denylist).
  const parsed = parseCatalogPayload('json', fixture('catalog-import-provisional-denied.json'));
  const report = validateCatalogImport(parsed, { existingIngredients: {}, existingCategories: ['carb'], existingFamilies: { cereali: { familyId: 'cereali', displayName: 'Cereali', categoryId: 'carb', sortOrder: 0 } }, denylist: ['provisional-demo-non-importabile'] });
  assert.match(report.errors.join('\n'), /denylist/);
  assert.equal(report.normalized.ingredients.length, 0, 'la voce bloccata non entra nel normalizzato');
  assert.equal(report.diff.filter(row => row.change === 'error').length, 1);
});

test('import catalogo: dedup, riferimenti e campi extra', () => {
  const options = { existingIngredients: {}, existingCategories: ['carb', 'free'], existingFamilies: { cereali: { familyId: 'cereali', displayName: 'Cereali', categoryId: 'carb', sortOrder: 0 } }, denylist: [] };
  const dup = parseCatalogPayload('json', JSON.stringify([
    { ingredientId: 'sorgo', displayName: 'Sorgo', aliases: [], categoryId: 'carb', familyId: 'cereali' },
    { ingredientId: 'sorgo', displayName: 'Sorgo bis', aliases: [], categoryId: 'carb', familyId: 'cereali' }
  ]));
  assert.match(validateCatalogImport(dup, options).errors.join('\n'), /duplicato/);
  const badCategory = parseCatalogPayload('json', JSON.stringify([
    { ingredientId: 'sorgo', displayName: 'Sorgo', aliases: [], categoryId: 'inesistente', familyId: 'cereali' }
  ]));
  assert.match(validateCatalogImport(badCategory, options).errors.join('\n'), /inesistente/);
  const badFamily = parseCatalogPayload('json', JSON.stringify([
    { ingredientId: 'sorgo', displayName: 'Sorgo', aliases: [], categoryId: 'carb', familyId: 'famiglia-futura' }
  ]));
  assert.match(validateCatalogImport(badFamily, options).errors.join('\n'), /inesistente/);
  // Campi extra del vecchio formato (mappingKind/guideFamilyId) rifiutati:
  // il catalogo è identità pura.
  const legacyFields = parseCatalogPayload('json', JSON.stringify([
    { ingredientId: 'sorgo', displayName: 'Sorgo', aliases: [], categoryId: 'carb', familyId: 'cereali', mappingKind: 'guided', guideFamilyId: 'cereali' }
  ]));
  assert.match(validateCatalogImport(legacyFields, options).errors.join('\n'), /non riconosciuto/);
  // vegan implica vegetarian.
  const badFlags = parseCatalogPayload('json', JSON.stringify([
    { ingredientId: 'sorgo', displayName: 'Sorgo', aliases: [], categoryId: 'carb', familyId: 'cereali', dietaryFlags: { vegetarian: false, vegan: true } }
  ]));
  assert.match(validateCatalogImport(badFlags, options).errors.join('\n'), /implica/);
  // Collisione dentro il file tra ID diversi (stesso alias normalizzato).
  const internal = parseCatalogPayload('json', JSON.stringify([
    { ingredientId: 'a-ok', displayName: 'Sorgo', aliases: [], categoryId: 'carb', familyId: 'cereali' },
    { ingredientId: 'b-ok', displayName: 'SORGO', aliases: [], categoryId: 'carb', familyId: 'cereali' }
  ]));
  assert.match(validateCatalogImport(internal, options).errors.join('\n'), /stesso file/);
});

test('import catalogo: diff troncato a 200 righe con flag', () => {
  const ingredients = Array.from({ length: 210 }, (_, i) => ({
    ingredientId: `voce-${String(i).padStart(3, '0')}`, displayName: `Voce ${i}`, aliases: [],
    categoryId: 'carb', familyId: 'cereali'
  }));
  const report = validateCatalogImport(parseCatalogPayload('json', JSON.stringify(ingredients)), { existingIngredients: {}, existingCategories: ['carb'], existingFamilies: { cereali: { familyId: 'cereali', displayName: 'Cereali', categoryId: 'carb', sortOrder: 0 } }, denylist: [] });
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

test('validateProfessionalRecipe: normalizza porzioni, default e trimming', () => {
  const out = validateProfessionalRecipe({
    name: '  Riso  ', slot: 'lunch',
    ingredients: [
      { name: 'Riso', portions: { single: '80 g' } },
      { name: 'Sale', ingredientId: '', portions: null }
    ]
  });
  assert.equal(out.name, 'Riso');
  assert.equal(out.emoji, null);
  assert.deepEqual(out.steps, []);
  assert.deepEqual(out.notes, []);
  assert.deepEqual(out.ingredients[0].portions, { single: '80 g' });
  assert.deepEqual(out.ingredients[1], { name: 'Sale', ingredientId: null, portions: { single: null } });
});

test('validateProfessionalRecipe: rifiuta slot, limiti e campi extra', () => {
  const good = { name: 'R', slot: 'dinner', ingredients: [{ name: 'X' }] };
  assert.throws(() => validateProfessionalRecipe({ ...good, slot: 'brunch' }), /slot/);
  assert.throws(() => validateProfessionalRecipe({ ...good, ingredients: [] }), /ingredients/);
  assert.throws(() => validateProfessionalRecipe({ ...good, id: 'X' }), /non ammessi/);
  assert.throws(() => validateProfessionalRecipe({ ...good, steps: ['ok', 42] }), /steps/);
  assert.throws(() => validateProfessionalRecipePortions({ single: 'x', extra: 1 }), /non ammessi/);
  assert.equal(PROFESSIONAL_RECIPE_VISIBILITY.has('studio'), true);
  assert.equal(PROFESSIONAL_RECIPE_LIMITS.ingredients, 100);
});
