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

  // Snapshot v2: le assegnazioni a Struttura dieta registrano structureId,
  // revisione e versione del catalogo ingredienti al momento della conferma.
  // Un cambio di catalogo richiede conferma (nudge sui nuovi pasti) senza
  // mai ricalcolare retroattivamente quelli già pianificati.
  function snapshotFor(profile, now = new Date()) {
    const base = {
      schemaVersion: 1,
      clientProfileId: profile.clientProfileId,
      assignmentId: profile.assignmentId,
      resolvedAt: now.toISOString(),
      migrationDecision: 'confirmed'
    };
    if (profile.structureId) {
      return {
        ...base,
        structureId: profile.structureId,
        structureRevisionId: String(profile.structureRevisionId),
        structureChecksum: profile.structureChecksum,
        ingredientCatalogVersion: profile.ingredientCatalogVersion ?? null,
        gramOverridesRevision: profile.gramOverrides?.revision ?? null
      };
    }
    return {
      ...base,
      ruleSetId: profile.ruleSetId,
      ruleSetVersion: profile.ruleSetVersion,
      ruleSetChecksum: profile.ruleSetChecksum,
      mappingCatalogChecksum: profile.mappingCatalogChecksum || null
    };
  }

  function snapshotMatches(plan, profile) {
    const snap = plan?.nutritionSnapshot;
    if (!snap || !profile) return false;
    if (snap.clientProfileId !== profile.clientProfileId || snap.assignmentId !== profile.assignmentId) return false;
    if (profile.structureId || snap.structureId) {
      return snap.structureId === profile.structureId &&
        String(snap.structureRevisionId) === String(profile.structureRevisionId) &&
        snap.structureChecksum === profile.structureChecksum &&
        (snap.ingredientCatalogVersion ?? null) === (profile.ingredientCatalogVersion ?? null) &&
        (snap.gramOverridesRevision ?? null) === (profile.gramOverrides?.revision ?? null);
    }
    return Boolean(
      snap.ruleSetId === profile.ruleSetId &&
      String(snap.ruleSetVersion) === String(profile.ruleSetVersion) &&
      snap.ruleSetChecksum === profile.ruleSetChecksum &&
      (snap.mappingCatalogChecksum || null) === (profile.mappingCatalogChecksum || null));
  }

  // Regole motore per il profilo assegnato. V1: già in formato motore. V2: la
  // revisione struttura viene convertita nel client con il catalogo incorporato
  // nel profilo (stesso motore, nessun fork server-side delle dosi) e poi unita
  // alle grammature personalizzate eventualmente confermate. Ritorna null se la
  // conversione è impossibile o produrrebbe un profilo vuoto: mai attivare in
  // silenzio un profilo senza dosi.
  function engineRulesFor(profile) {
    if (!profile) return null;
    if (profile.schemaVersion !== 2) {
      return Array.isArray(profile.rules) && profile.rules.length
        ? { rules: profile.rules, freeAliases: profile.freeAliases || [] }
        : null;
    }
    const Domain = root.PianoDomain;
    if (!Domain?.buildCatalogIndex || !Domain?.structureRevisionToMellerRules) return null;
    const converted = Domain.structureRevisionToMellerRules(
      profile.structureRevision || {}, Domain.buildCatalogIndex(profile.catalog || {}));
    let rules = converted.rules || [];
    const overrides = profile.gramOverrides?.overrides;
    if (overrides && typeof Domain.applyGramOverridesToRules === 'function') {
      rules = Domain.applyGramOverridesToRules(rules, overrides);
    }
    if (!rules.length) return null;
    return { rules, freeAliases: converted.freeAliases || [] };
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
        const engine = engineRulesFor(value.profile);
        if (!engine) throw new Error('Profilo assegnato non compatibile');
        if (!root.PianoDomain?.activateMellerRuleSet?.(engine.rules, engine.freeAliases)) {
          throw new Error('Rule set non compatibile');
        }
        localStorage.setItem(cacheKey(uid), JSON.stringify({ ...value, cachedAt: new Date().toISOString() }));
      }
      return value;
    } catch (error) {
      // Offline: usa solo l'ultima versione verificata, non una regola nuova.
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey(uid)) || 'null');
        const expires = cached?.profile?.expiresAt ? new Date(cached.profile.expiresAt) : null;
        if (cached?.state === 'assigned' && (!expires || expires > new Date())) {
          const engine = engineRulesFor(cached.profile);
          if (!engine) throw new Error('Profilo in cache non compatibile');
          root.PianoDomain?.activateMellerRuleSet?.(engine.rules, engine.freeAliases);
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
    // Il provider restituisce una ricevuta opaca; la concessione definitiva è
    // verificata server-side da `requestShoppingReward` (con assignment attivo
    // non serve alcun reward; senza assignment e provider OFF → errore).
    // Non inviare ricette o dati sanitari.
    const receipt = await root.PianoRewardedAds.show({ placement: 'shopping-access' });
    const grant = await root.callSaasFunction('requestShoppingReward', { receipt, placement: 'shopping-access' });
    if (grant?.expiresAt) {
      localStorage.setItem('pn_shopping_reward_until', String(new Date(grant.expiresAt).getTime()));
    }
    return grant;
  }

  return { config, originalOnlyPlan, snapshotFor, snapshotMatches, engineRulesFor, applyPolicy, loadContext, shoppingAccess, requestShoppingReward };
});
