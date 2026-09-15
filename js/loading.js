// Loading globale: un solo overlay per app cliente e console, con contatore
// di operazioni in volo (le chiamate annidate non si "rubano" la chiusura).
//
// Percezione di velocità: l'overlay compare solo se l'operazione supera una
// breve soglia (grace period). Le letture istantanee non fanno più lampeggiare
// lo schermo; le operazioni lente mostrano comunque logo, spinner e messaggio.
(function () {
  'use strict';
  const GRACE_MS = 220;
  let pending = 0;
  let showTimer = null;

  function overlay() { return document.getElementById('loading-overlay'); }
  function setMessage(message) {
    const text = document.getElementById('loading-message');
    if (text && message) text.textContent = message;
  }
  function isVisible() {
    const node = overlay();
    return Boolean(node && !node.classList.contains('hidden'));
  }
  function show() {
    const node = overlay();
    if (!node) return;
    node.classList.remove('hidden');
    node.setAttribute('aria-busy', 'true');
  }
  function hide() {
    const node = overlay();
    if (!node) return;
    node.classList.add('hidden');
    node.setAttribute('aria-busy', 'false');
  }
  function cancelScheduledShow() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
  }
  function scheduleShow() {
    if (showTimer || isVisible()) return;
    showTimer = setTimeout(() => {
      showTimer = null;
      if (pending > 0) show();
    }, GRACE_MS);
  }

  const PianoLoading = {
    start(message) {
      pending += 1;
      setMessage(message);
      // Overlay già visibile (boot dell'app o operazione lunga in corso):
      // resta com'è. Altrimenti si mostra solo oltre la soglia.
      if (pending > 1 || isVisible()) return;
      scheduleShow();
    },
    stop() {
      pending = Math.max(0, pending - 1);
      if (pending > 0) return;
      cancelScheduledShow();
      hide();
    },
    reset() {
      pending = 0;
      cancelScheduledShow();
      hide();
    },
    pendingCount() { return pending; }
  };

  // Boot dell'app cliente: l'overlay parte visibile dal markup senza start().
  // Il primo stop() (anche a contatore zero) lo chiude, come prima.
  window.PianoLoading = PianoLoading;
})();
