'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

global.PIANO_SAAS_CONFIG = { enabled: true, shoppingRewardedAds: { enabled: false, unlockHours: 24 } };
const Saas = require('../js/saas.js');

function plan() {
  return { mellerModes: { monday: { lunch: 'meller', dinner: 'meller' } }, days: {} };
}
const profile = { clientProfileId: 'client-a', assignmentId: 'asg-1', ruleSetId: 'base', ruleSetVersion: '3', ruleSetChecksum: 'a'.repeat(64) };

test('SaaS senza assegnazione forza original-only senza mutare il piano sorgente', () => {
  const source = plan();
  const result = Saas.applyPolicy(source, { state: 'unassigned' });
  assert.equal(result.mode, 'original-only');
  assert.equal(result.plan.mellerModes.monday.lunch, 'original');
  assert.equal(source.mellerModes.monday.lunch, 'meller');
});

test('assegnazione nuova richiede conferma e non ricalcola silenziosamente', () => {
  const result = Saas.applyPolicy(plan(), { state: 'assigned', profile });
  assert.equal(result.migrationRequired, true);
  assert.equal(result.plan.mellerModes.monday.dinner, 'original');
});

test('snapshot esatto conserva la modalità del piano', () => {
  const source = plan();
  source.nutritionSnapshot = Saas.snapshotFor(profile, new Date('2026-09-09T12:00:00Z'));
  assert.equal(Saas.snapshotMatches(source, profile), true);
  const result = Saas.applyPolicy(source, { state: 'assigned', profile });
  assert.equal(result.mode, 'assigned');
  assert.equal(result.plan.mellerModes.monday.lunch, 'meller');
});

test('nuovo catalogo mapping richiede conferma e non altera lo snapshot', () => {
  const withCatalog = { ...profile, mappingCatalogChecksum: 'c'.repeat(64) };
  const source = plan();
  source.nutritionSnapshot = Saas.snapshotFor(withCatalog);
  assert.equal(Saas.snapshotMatches(source, { ...withCatalog, mappingCatalogChecksum: 'd'.repeat(64) }), false);
});

test('versione 4 non modifica retroattivamente snapshot versione 3', () => {
  const source = plan();
  source.nutritionSnapshot = Saas.snapshotFor(profile);
  const v4 = { ...profile, assignmentId: 'asg-2', ruleSetVersion: '4', ruleSetChecksum: 'b'.repeat(64) };
  assert.equal(Saas.snapshotMatches(source, v4), false);
  const result = Saas.applyPolicy(source, { state: 'assigned', profile: v4 });
  assert.equal(result.migrationRequired, true);
  assert.equal(source.nutritionSnapshot.ruleSetVersion, '3');
});

test('spesa: cliente con assegnazione attiva accede sempre, senza pubblicità', () => {
  const previousConfig = globalThis.PIANO_SAAS_CONFIG;
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.PIANO_SAAS_CONFIG = { enabled: true, shoppingRewardedAds: { enabled: false, provider: null } };
  try {
    const assigned = Saas.shoppingAccess(Date.now(), { state: 'assigned' });
    assert.equal(assigned.allowed, true);
    assert.equal(assigned.reason, 'assignment');
    // Non associato: il gate rewarded resta dietro flag provider disattivato.
    const guest = Saas.shoppingAccess(Date.now(), { state: 'unassigned' });
    assert.equal(guest.allowed, false);
    assert.equal(guest.reason, 'provider-unavailable');
    // Contesto omesso: comportamento invariato (fallback legacy dei guest).
    assert.equal(Saas.shoppingAccess(Date.now()).allowed, false);
    // Con la feature SaaS disattivata l'accesso resta libero (legacy).
    globalThis.PIANO_SAAS_CONFIG = { enabled: false };
    const legacy = Saas.shoppingAccess(Date.now(), { state: 'unassigned' });
    assert.equal(legacy.allowed, true);
    assert.equal(legacy.reason, 'feature-disabled');
  } finally {
    globalThis.PIANO_SAAS_CONFIG = previousConfig;
    globalThis.localStorage = previousStorage;
  }
});
