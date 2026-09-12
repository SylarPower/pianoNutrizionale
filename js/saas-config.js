// Configurazione pubblica, senza segreti. Attivare il SaaS solo dopo deploy di
// Functions, Rules, indici e provisioning dei profili cliente.
// Organizzazione singola condivisa da tutti i professionisti: 'pianoNutrizionale'.
window.PIANO_SINGLE_ORG_ID = 'pianoNutrizionale';
window.PIANO_SAAS_CONFIG = {
  enabled: true,
  singleOrganizationId: 'pianoNutrizionale',
  shoppingRewardedAds: {
    enabled: false,
    provider: null,
    unlockHours: 24,
    consentVersion: null
  }
};
