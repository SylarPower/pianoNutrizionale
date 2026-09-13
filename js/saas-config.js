// Configurazione pubblica, senza segreti.
// `enabled` è l'interruttore della parte professionale dell'app cliente
// (collegamento con il nutrizionista, profilo assegnato, notifiche, inviti):
// resta `true` in produzione. `false` è solo la via di emergenza (l'app torna
// al comportamento legacy senza cancellare nulla): vedi
// docs/configurazione-manuale.md. Non è un controllo di sicurezza.
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
