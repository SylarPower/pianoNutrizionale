// Configurazione pubblica, senza segreti. Attivare il SaaS solo dopo deploy di
// Functions, Rules, indici e provisioning dei profili cliente.
// Organizzazione singola condivisa da tutti i professionisti: 'piano'.
window.PIANO_SINGLE_ORG_ID = 'piano';
window.PIANO_SAAS_CONFIG = {
  enabled: true,
  singleOrganizationId: 'piano',
  shoppingRewardedAds: {
    enabled: false,
    provider: null,
    unlockHours: 24,
    consentVersion: null
  }
};
