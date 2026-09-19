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

  // Piano con dosi originali forzate: l'interruttore dosi allineate si
  // spegne (scelta unica del cliente, a livello piano). Nessuna matrice
  // per-pasto: la vista allineata si riattiva con un tap.
  function originalOnlyPlan(plan) {
    const next = JSON.parse(JSON.stringify(plan || {}));
    next.alignedDosesEnabled = false;
    return next;
  }

  // Snapshot della conferma cliente: la revisione della struttura assegnata
  // si applica solo dopo l'ok esplicito (mai retroattività silenziosa). Un
  // cambio di revisione o di catalogo richiede una nuova conferma.
  function snapshotFor(profile, now = new Date()) {
    return {
      schemaVersion: 1,
      clientProfileId: profile.clientProfileId,
      assignmentId: profile.assignmentId,
      resolvedAt: now.toISOString(),
      migrationDecision: 'confirmed',
      structureId: profile.structureId,
      structureRevisionId: String(profile.structureRevisionId),
      structureChecksum: profile.structureChecksum,
      ingredientCatalogVersion: profile.ingredientCatalogVersion ?? null
    };
  }

  function snapshotMatches(plan, profile) {
    const snap = plan?.nutritionSnapshot;
    if (!snap || !profile) return false;
    if (snap.clientProfileId !== profile.clientProfileId || snap.assignmentId !== profile.assignmentId) return false;
    return snap.structureId === profile.structureId
      && String(snap.structureRevisionId) === String(profile.structureRevisionId)
      && snap.structureChecksum === profile.structureChecksum
      && (snap.ingredientCatalogVersion ?? null) === (profile.ingredientCatalogVersion ?? null);
  }

  // Ambito personale: nei piani famiglia condivisi valgono sempre le dosi
  // originali delle ricette (mai la dieta personale di un membro).
  function saasPersonalScope() {
    try {
      return !root.getCurrentHousehold || !root.getCurrentHousehold();
    } catch (_) {
      return true;
    }
  }

  function applyPolicy(plan, context) {
    if (!config().enabled) return { plan, mode: 'legacy-disabled', migrationRequired: false };
    if (context?.state !== 'assigned' || !context.profile) {
      return { plan, mode: 'original-only', migrationRequired: false };
    }
    // La conferma del nuovo profilo serve solo in ambito personale: nei
    // piani famiglia condivisi le dosi allineate non si applicano comunque.
    if (!saasPersonalScope()) return { plan, mode: 'original-only', migrationRequired: false };
    if (!snapshotMatches(plan, context.profile)) {
      return { plan: originalOnlyPlan(plan), mode: 'pending-confirmation', migrationRequired: true };
    }
    return { plan, mode: 'assigned', migrationRequired: false };
  }

  function cacheKey(uid) { return `pn_saas_profile_${uid}`; }

  // Ultimo profilo VERIFICATO, letto in sincrono dalla cache: l'avvio rapido
  // lo applica PRIMA della risposta delle funzioni cloud, così le dosi
  // adattate sono corrette già al primo paint (niente balzo original→guide).
  // Il refresh di background di loadContext lo conferma o lo corregge.
  // Stesse validazioni del fallback offline: assegnazione attiva, non scaduta,
  // motore compatibile; in caso contrario null (l'app resta su originale).
  function cachedContext(uid) {
    if (!config().enabled) return null;
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey(uid)) || 'null');
      const expires = cached?.profile?.expiresAt ? new Date(cached.profile.expiresAt) : null;
      if (cached?.state === 'assigned' && (!expires || expires > new Date())) {
        // Un profilo in cache è utilizzabile solo se produce un motore dieta
        // valido (revisione con piano dieta a blocchi).
        const engine = root.PianoDomain?.buildDietEngine ? root.PianoDomain.buildDietEngine(cached.profile) : null;
        if (!engine) return null;
        return { ...cached, offline: true };
      }
    } catch (_) {}
    return null;
  }

  async function loadContext(uid, call = root.callSaasFunction) {
    if (!config().enabled) return { state: 'feature-disabled', fallback: 'legacy' };
    try {
      const value = await call('getMyAssignedProfile', {});
      if (value?.state === 'assigned' && value.profile) {
        // Il profilo deve produrre un motore dieta valido: senza piano a
        // blocchi non si attiva nulla (mai dosi silenziose).
        const engine = root.PianoDomain?.buildDietEngine ? root.PianoDomain.buildDietEngine(value.profile) : null;
        if (!engine) throw new Error('Struttura dieta non compatibile');
        localStorage.setItem(cacheKey(uid), JSON.stringify({ ...value, cachedAt: new Date().toISOString() }));
      }
      return value;
    } catch (error) {
      // Offline: usa solo l'ultima versione verificata, non una struttura nuova.
      const cached = cachedContext(uid);
      if (cached) return cached;
      return { state: 'unavailable', fallback: 'original-only', error: error?.message || 'offline' };
    }
  }

  // Lista spesa per il cliente finale: con un'assegnazione attiva e confermata
  // l'accesso è SEMPRE libero (nessuna pubblicità). L'utente non associato
  // passa dal gate rewarded SOLO quando il provider ads è configurato
  // (ads.enabled && ads.provider). Finché il provider non è scelto, la lista
  // resta accessibile a tutti: è la fase iniziale pre-ads, e il gate non deve
  // mai bloccare la spesa con un bottone "In arrivo" disattivato.
  function shoppingAccess(now = Date.now(), context = null) {
    const ads = config().shoppingRewardedAds;
    if (!config().enabled) return { allowed: true, reason: 'feature-disabled' };
    const state = context?.state ?? null;
    if (state === 'assigned') return { allowed: true, reason: 'assignment' };
    if (!ads.enabled || !ads.provider) return { allowed: true, reason: 'ads-not-configured' };
    const until = Number(localStorage.getItem('pn_shopping_reward_until') || 0);
    if (until > now) return { allowed: true, reason: 'reward', until };
    return { allowed: false, reason: 'reward-available' };
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

  return { config, originalOnlyPlan, snapshotFor, snapshotMatches, saasPersonalScope, applyPolicy, loadContext, cachedContext, shoppingAccess, requestShoppingReward };
});
