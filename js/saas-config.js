// Configurazione pubblica, senza segreti. Attivare il SaaS solo dopo deploy di
// Functions, Rules, indici e provisioning dei profili cliente.
window.PIANO_SAAS_CONFIG = {
  enabled: false,
  shoppingRewardedAds: {
    enabled: true,
    provider: null,
    unlockHours: 24,
    consentVersion: null
  }
};
