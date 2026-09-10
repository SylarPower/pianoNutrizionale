/* Piano SaaS client bridge — feature flag, snapshot e fallback offline. */
(function(root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PianoSaas = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, root => {
  'use strict';

  const defaults = {
    enabled: false,
    shoppingRewardedAds: { enabled: false, provider: null, unlockHours: 24, consentVersion: null }
  };

  function config() {
    const external = root.PIANO_SAAS_CONFIG || {};
    return {
      ...defaults, ...external,
      shoppingRewardedAds: { ...defaults.shoppingRewardedAds, ...(external.shoppingRewardedAds || {}) }
    };
  }

  function originalOnlyPlan(plan) {
    const next = JSON.parse(JSON.stringify(plan || {}));
    if (!next.mellerModes) next.mellerModes = {};
    const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    days.forEach(day => {
      next.mellerModes[day] = { ...(next.mellerModes[day] || {}), lunch: 'original', dinner: 'original' };
    });
    return next;
  }

  function snapshotFor(profile, now = new Date()) {
    return {
      schemaVersion: 1,
      clientProfileId: profile.clientProfileId,
      assignmentId: profile.assignmentId,
      ruleSetId: profile.ruleSetId,
      ruleSetVersion: profile.ruleSetVersion,
      ruleSetChecksum: profile.ruleSetChecksum,
      mappingCatalogChecksum: profile.mappingCatalogChecksum || null,
      resolvedAt: now.toISOString(),
      migrationDecision: 'confirmed'
    };
  }

  function snapshotMatches(plan, profile) {
    const snap = plan?.nutritionSnapshot;
    return Boolean(snap && profile &&
      snap.clientProfileId === profile.clientProfileId &&
      snap.assignmentId === profile.assignmentId &&
      snap.ruleSetId === profile.ruleSetId &&
      String(snap.ruleSetVersion) === String(profile.ruleSetVersion) &&
      snap.ruleSetChecksum === profile.ruleSetChecksum &&
      (snap.mappingCatalogChecksum || null) === (profile.mappingCatalogChecksum || null));
  }

  function applyPolicy(plan, context) {
    if (!config().enabled) return { plan, mode: 'legacy-disabled', migrationRequired: false };
    if (context?.state !== 'assigned' || !context.profile) {
      return { plan: originalOnlyPlan(plan), mode: 'original-only', migrationRequired: false };
    }
    if (!snapshotMatches(plan, context.profile)) {
      return { plan: originalOnlyPlan(plan), mode: 'pending-confirmation', migrationRequired: true };
    }
    return { plan, mode: 'assigned', migrationRequired: false };
  }

  function cacheKey(uid) { return `pn_saas_profile_${uid}`; }

  async function loadContext(uid, call = root.callSaasFunction) {
    if (!config().enabled) return { state: 'feature-disabled', fallback: 'legacy' };
    try {
      const value = await call('getMyAssignedProfile', {});
      if (value?.state === 'assigned' && value.profile) {
        if (!root.PianoDomain?.activateMellerRuleSet?.(value.profile.rules, value.profile.freeAliases)) throw new Error('Rule set non compatibile');
        localStorage.setItem(cacheKey(uid), JSON.stringify({ ...value, cachedAt: new Date().toISOString() }));
      }
      return value;
    } catch (error) {
      // Offline: usa solo l'ultima versione verificata, non una regola nuova.
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey(uid)) || 'null');
        const expires = cached?.profile?.expiresAt ? new Date(cached.profile.expiresAt) : null;
        if (cached?.state === 'assigned' && (!expires || expires > new Date())) {
          root.PianoDomain?.activateMellerRuleSet?.(cached.profile.rules, cached.profile.freeAliases);
          return { ...cached, offline: true };
        }
      } catch (_) {}
      return { state: 'unavailable', fallback: 'original-only', error: error?.message || 'offline' };
    }
  }

  // Lista spesa per il cliente finale: con un'assegnazione attiva e confermata
  // l'accesso è SEMPRE libero (nessuna pubblicità). Solo l'utente non
  // associato passa dal gate rewarded (dietro flag provider, disattivato).
  function shoppingAccess(now = Date.now(), context = null) {
    const ads = config().shoppingRewardedAds;
    if (!config().enabled) return { allowed: true, reason: 'feature-disabled' };
    const state = context?.state ?? null;
    if (state === 'assigned') return { allowed: true, reason: 'assignment' };
    const until = Number(localStorage.getItem('pn_shopping_reward_until') || 0);
    if (until > now) return { allowed: true, reason: 'reward', until };
    return { allowed: false, reason: ads.enabled && ads.provider ? 'reward-available' : 'provider-unavailable' };
  }

  async function requestShoppingReward() {
    const ads = config().shoppingRewardedAds;
    if (!ads.enabled || !ads.provider || typeof root.PianoRewardedAds?.show !== 'function') {
      throw new Error('La pubblicità rewarded non è ancora disponibile');
    }
    if (!ads.consentVersion || localStorage.getItem('pn_ads_consent') !== ads.consentVersion) {
      throw new Error('Consenso pubblicitario richiesto');
    }
    // Il provider restituisce una ricevuta opaca; la concessione definitiva
    // dovrà essere verificata server-side. Non inviare ricette o dati sanitari.
    const receipt = await root.PianoRewardedAds.show({ placement: 'shopping-access' });
    const grant = await root.callSaasFunction('grantShoppingReward', { receipt, placement: 'shopping-access' });
    localStorage.setItem('pn_shopping_reward_until', String(new Date(grant.expiresAt).getTime()));
    return grant;
  }

  return { config, originalOnlyPlan, snapshotFor, snapshotMatches, applyPolicy, loadContext, shoppingAccess, requestShoppingReward };
});
