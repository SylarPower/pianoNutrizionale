/* Stato di caricamento condiviso tra app cliente e console.
 * Un contatore evita che due richieste parallele nascondano l'overlay mentre
 * l'altra è ancora in corso. L'overlay vive nel markup della pagina e resta
 * sempre al centro, con il contenuto sottostante sfocato.
 */
(function installPianoLoading(global) {
  let pending = 0;
  let lastMessage = "Caricamento…";

  function overlay() {
    return global.document?.getElementById("loading-overlay") || null;
  }

  function paint() {
    const node = overlay();
    if (!node) return;
    const message = node.querySelector?.("#loading-message") || global.document?.getElementById("loading-message");
    if (message) message.textContent = lastMessage;
    node.classList.toggle("hidden", pending === 0);
    node.setAttribute("aria-busy", pending > 0 ? "true" : "false");
  }

  global.PianoLoading = Object.freeze({
    start(message = "Caricamento…") {
      pending += 1;
      lastMessage = message;
      paint();
    },
    stop() {
      pending = Math.max(0, pending - 1);
      paint();
    },
    reset() {
      pending = 0;
      paint();
    },
    get pending() {
      return pending;
    }
  });
})(typeof window !== "undefined" ? window : globalThis);
