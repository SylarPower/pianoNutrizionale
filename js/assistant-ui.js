/* Piano Nutrizionale — assistente e coach vocale (collante UI).
 *
 * Contiene solo DOM, Web Speech API (sintesi e riconoscimento vocale) e la
 * chiamata al servizio AI gratuito. Tutta la logica pura vive in
 * js/assistant.js (PianoAssistant). Si carica PRIMA di js/app.js, ma accede a
 * appState e agli helper dell'app solo dentro le funzioni, mai all'avvio.
 *
 * AI online: Google Gemini (chiave gratuita da AI Studio, salvata SOLO sul
 * dispositivo) con Pollinations.AI (senza chiave) come ripiego automatico.
 * Le risposte sul piano (oggi, spesa, frequenze, batch, ricette, manuale)
 * sono calcolate LOCALMENTE e funzionano anche offline, senza inviare nulla.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.PianoAssistantUI) return;

  const API = window.PianoAssistant || {};

  // Servizio AI gratuito — Pollinations (nessuna chiave). Formato OpenAI-compatible.
  const AI_ENDPOINT = 'https://text.pollinations.ai/openai';
  const AI_ENDPOINT_SIMPLE = 'https://text.pollinations.ai/';
  const AI_MODEL = 'openai';
  const AI_TIMEOUT_MS = 45000;

  // Google Gemini (gratuito con chiave da AI Studio, senza carta di credito).
  // La chiave viene salvata SOLO in localStorage su questo dispositivo.
  const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
  const GEMINI_MODEL = 'gemini-2.5-flash';
  const GEMINI_KEY = 'pn_gemini_key';
  function readGeminiKey() {
    try { return (localStorage.getItem(GEMINI_KEY) || '').trim(); } catch (_) { return ''; }
  }
  function writeGeminiKey(value) {
    try {
      const key = String(value || '').trim();
      if (key) localStorage.setItem(GEMINI_KEY, key);
      else localStorage.removeItem(GEMINI_KEY);
    } catch (_) {}
  }

  const CLOUD_KEY = 'pn_assistant_cloud';
  const VOICE_KEY = 'pn_assistant_voice';
  function readCloudPref() {
    try {
      const value = localStorage.getItem(CLOUD_KEY);
      return value === null ? true : value === '1';
    } catch (_) { return true; }
  }
  function writeCloudPref(value) {
    try { localStorage.setItem(CLOUD_KEY, value ? '1' : '0'); } catch (_) {}
  }
  function readVoicePref() {
    try { return localStorage.getItem(VOICE_KEY) === '1'; } catch (_) { return false; }
  }
  function writeVoicePref(value) {
    try { localStorage.setItem(VOICE_KEY, value ? '1' : '0'); } catch (_) {}
  }
  let cloudEnabled = readCloudPref();

  const GUIDE = (typeof MELLER_GUIDE !== 'undefined') ? MELLER_GUIDE : null;

  // ---- Stato della conversazione (chat + cucina guidata) ----
  const Talk = {
    session: null,          // { phase: 'ingredients'|'steps', index }
    listening: false,       // riconoscimento vocale in corso
    cooking: false,         // sessione di cucina guidata attiva
    micOn: false,           // il microfono 🎤 è acceso (resta attivo finché non lo spegni)
    pending: false,         // una risposta è in lavorazione (per non riascoltare prima del tempo)
    recognition: null,

    clearSession() { Talk.session = null; Talk.cooking = false; },

    // Comando di avanzamento: "prossimo", "avanti", "continua", "vai"…
    isNextCommand(text) {
      const normalized = API.normalizeText ? API.normalizeText(text) : String(text || '').toLowerCase().trim();
      return /^(prossim|avanti|continua|continui|vai|vai avanti|successivo|successiva|ok|avvia|parti|altro)$/.test(normalized)
        || ['prossimo', 'avanti', 'continua', 'vai avanti', 'successivo', 'ok', 'si', 'sì', 'altro'].includes(normalized);
    },

    // Comando di ritorno indietro: "indietro", "ripeti", "di nuovo"…
    isBackCommand(text) {
      const normalized = API.normalizeText ? API.normalizeText(text) : String(text || '').toLowerCase().trim();
      return ['indietro', 'ripeti', 'di nuovo', 'ancora', 'ridimmi', 'ricomincia'].includes(normalized);
    },

    // Comando vocale per spegnere il microfono: "spegni il microfono"…
    isMicOffCommand(text) {
      const normalized = API.normalizeText ? API.normalizeText(text) : String(text || '').toLowerCase().trim();
      return ['spegni il microfono', 'spegni microfono', 'smetti di ascoltare', 'smettila di ascoltare',
        'non ascoltare più', 'non ascoltare piu', 'disattiva il microfono', 'chiudi il microfono',
        'basta ascoltare', 'stop microfono'].includes(normalized);
    },

    // Comando (scritto o vocale) per accendere il microfono.
    isMicOnCommand(text) {
      const normalized = API.normalizeText ? API.normalizeText(text) : String(text || '').toLowerCase().trim();
      return ['accendi il microfono', 'attiva il microfono', 'ascoltami', 'ascolta'].includes(normalized);
    }
  };

  // ---- Coach vocale (sintesi vocale Web Speech API, gratuita e offline) ----
  function setMicRecording(active) {
    const mic = document.getElementById('assistant-mic');
    if (!mic) return;
    mic.classList.toggle('recording', Boolean(active));
    mic.classList.toggle('listening', Boolean(active));
    mic.classList.toggle('mic-on', Boolean(Talk.micOn) && !active);
    mic.title = active ? 'In ascolto… tocca per spegnere' : (Talk.micOn ? 'Microfono acceso: resta in ascolto' : 'Attiva il microfono');
    mic.setAttribute('aria-label', active ? 'In ascolto' : (Talk.micOn ? 'Microfono acceso' : 'Attiva il microfono'));
    if (active) {
      const container = document.getElementById('assistant-messages');
      if (container) {
        container.dataset.listening = '1';
      }
    } else {
      const container = document.getElementById('assistant-messages');
      if (container) delete container.dataset.listening;
    }
  }

  const Coach = {
    _initialized: false,
    _voice: null,
    _speakingEl: null,

    // Sintesi vocale: la voce è OPT-IN. Parte solo se l'utente ha attivato
    // l'interruttore 🔊 nella chat.
    voiceEnabled: readVoicePref(),

    init() {
      if (Coach._initialized) return;
      Coach._initialized = true;
      if (!('speechSynthesis' in window)) return;
      const pickVoice = () => {
        const voices = window.speechSynthesis.getVoices();
        Coach._voice = voices.find(voice => /^it/i.test(voice.lang || '')) || null;
      };
      pickVoice();
      window.speechSynthesis.addEventListener('voiceschanged', pickVoice);
    },

    isAvailable() { return 'speechSynthesis' in window; },

    isSpeaking() {
      return Boolean(window.speechSynthesis && window.speechSynthesis.speaking);
    },

    _setSpeaking(el) {
      if (Coach._speakingEl && Coach._speakingEl !== el) Coach._speakingEl.classList.remove('speaking');
      Coach._speakingEl = el || null;
      if (el) el.classList.add('speaking');
    },

    _clearSpeaking() {
      if (Coach._speakingEl) {
        Coach._speakingEl.classList.remove('speaking');
        Coach._speakingEl = null;
      }
    },

    speak(text, el, onEnd) {
      if (!Coach.isAvailable() || !text) { if (typeof onEnd === 'function') onEnd(); return; }
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(String(text));
        utterance.lang = 'it-IT';
        if (Coach._voice) utterance.voice = Coach._voice;
        utterance.rate = 1.02;
        utterance.pitch = 1;
        const done = () => {
          Coach._clearSpeaking();
          if (typeof onEnd === 'function') onEnd();
        };
        utterance.onend = done;
        utterance.onerror = done;
        Coach._setSpeaking(el || null);
        window.speechSynthesis.speak(utterance);
      } catch (_) {
        if (typeof onEnd === 'function') onEnd();
      }
    },

    stop() {
      if (!Coach.isAvailable()) return;
      try { window.speechSynthesis.cancel(); } catch (_) {}
      Coach._clearSpeaking();
    },

    // Avvia il riconoscimento vocale (Web Speech API). onResult riceve la
    // trascrizione; onEnd(reason) viene chiamato alla fine: reason è null per
    // una fine normale, 'error' per un errore generico, 'not-allowed' o
    // 'service-not-allowed' quando manca il permesso del microfono.
    startListening(onResult, onEnd) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) return false;
      if (Talk.recognition) { try { Talk.recognition.abort(); } catch (_) {} }
      const recognition = new SpeechRecognition();
      recognition.lang = 'it-IT';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.continuous = false;
      Talk.recognition = recognition;
      Talk.listening = true;
      let ended = false;
      const finished = reason => {
        if (ended) return;
        ended = true;
        Talk.listening = false;
        Talk.recognition = null;
        setMicRecording(false);
        if (reason === 'not-allowed' || reason === 'service-not-allowed') Talk.micOn = false;
        if (typeof onEnd === 'function') onEnd(reason || null);
      };
      recognition.onresult = event => {
        const transcript = event.results?.[0]?.[0]?.transcript;
        if (typeof onResult === 'function') onResult(transcript);
      };
      recognition.onend = () => finished(null);
      recognition.onerror = event => finished(event?.error || 'error');
      try {
        recognition.start();
        setMicRecording(true);
        return true;
      } catch (_) {
        // Non è partito: non chiamare onEnd (evita riarmi a vuoto).
        ended = true;
        Talk.listening = false;
        Talk.recognition = null;
        setMicRecording(false);
        return false;
      }
    },

    stopListening() {
      if (Talk.recognition) { try { Talk.recognition.abort(); } catch (_) {} }
      Talk.listening = false;
      Talk.recognition = null;
      Talk.micOn = false;
      setMicRecording(false);
    }
  };

  // ---- Costruzione dello stato da passare al dominio puro ----
  function buildState() {
    const profile = typeof getPortionProfile === 'function' ? getPortionProfile() : 'man';
    const today = typeof getTodayKey === 'function' ? getTodayKey() : 'monday';
    let shoppingEntries = [];
    if (typeof getVisibleShoppingEntries === 'function' && typeof shoppingAmountText === 'function') {
      try {
        shoppingEntries = getVisibleShoppingEntries().map(entry => ({
          name: entry.name,
          amount: shoppingAmountText(entry)
        }));
      } catch (_) { /* spesa non disponibile */ }
    }
    const batchByDay = {};
    if (typeof DAY_ORDER !== 'undefined' && typeof getActiveBatch === 'function') {
      DAY_ORDER.forEach(day => {
        const batches = getActiveBatch(day);
        if (batches && batches.length) batchByDay[day] = batches;
      });
    }
    return {
      plan: (typeof appState !== 'undefined' ? appState.plan : null),
      recipes: (typeof appState !== 'undefined' ? appState.recipes : []),
      shoppingEntries,
      today,
      profile,
      profileLabel: typeof getProfileLabel === 'function' ? getProfileLabel() : API.profileLabelFor(profile),
      classifyProtein: recipe => (window.PianoDomain && typeof window.PianoDomain.classifyProtein === 'function')
        ? window.PianoDomain.classifyProtein(recipe)
        : null,
      batchByDay
    };
  }

  function currentContext() {
    return API.buildContext ? API.buildContext(buildState()) : null;
  }

  // ---- Chiamata al servizio AI gratuito (senza chiave) ----
  async function requestCloud(system, user) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    try {
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ];
      let response = await fetch(AI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: AI_MODEL, messages, temperature: 0.5, max_tokens: 600 }),
        signal: controller.signal
      });
      if (response.ok) {
        try {
          const data = await response.json();
          const text = data?.choices?.[0]?.message?.content;
          if (typeof text === 'string' && text.trim()) return text.trim();
        } catch (_) { /* formato inatteso: provo l'endpoint semplice */ }
      }
      response = await fetch(AI_ENDPOINT_SIMPLE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, model: AI_MODEL }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error('AI non disponibile');
      const text = await response.text();
      if (text && text.trim()) return text.trim();
      throw new Error('Risposta vuota');
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Chiamata a Google Gemini (chiave gratuita dell'utente) ----
  async function requestGemini(system, user, key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${GEMINI_ENDPOINT}${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: { temperature: 0.5, maxOutputTokens: 600 }
          }),
          signal: controller.signal
        }
      );
      if (!response.ok) throw new Error('Gemini non disponibile');
      const data = await response.json();
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map(part => part?.text || '')
        .join('')
        .trim();
      if (!text) throw new Error('Risposta vuota');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- UI della chat ----
  const SUGGESTIONS = [
    'Cosa mangio oggi?',
    'Cuciniamo la cena di stasera?',
    'Quanti grammi di frutta nello spuntino di oggi?',
    'Cosa devo comprare?',
    'Quante volte mangio pesce?',
    'Come funziona l\'app?'
  ];

  const AssistantUI = {
    _ready: false,
    _busy: false,

    init() {
      if (AssistantUI._ready) return;
      AssistantUI._ready = true;
      Coach.init();
      injectUi();
      bindEvents();
    },

    open() {
      document.getElementById('assistant-modal')?.classList.remove('hidden');
      if (!document.getElementById('assistant-messages').childElementCount) {
        // Messaggio di benvenuto SOLO testuale: non viene mai letto ad alta voce.
        addMessage('assistant', 'Ciao! Sono Coach, il tuo assistente. Chiedimi ad esempio "cosa mangio oggi?", "cosa devo comprare?" oppure "cuciniamo la cena di stasera?". Attiva il microfono 🎤 per parlarmi e l\'interruttore 🔊 per farmi rispondere a voce.');
      }
      setTimeout(() => document.getElementById('assistant-input')?.focus(), 50);
    },

    close() {
      Coach.stopListening();
      document.getElementById('assistant-modal')?.classList.add('hidden');
    },

    // Invia un messaggio scritto (o dettato).
    send(text) {
      handleTurn(text);
    },

    // Toggle del microfono: se è spento lo accende (e resta acceso), se è
    // acceso lo spegne.
    toggleMic() {
      if (Talk.listening || Talk.micOn) {
        stopMic();
        return;
      }
      AssistantUI.open();
      startRecognition();
    }
  };

  // Accende il riconoscimento vocale: da qui in poi il microfono resta attivo
  // finché l'utente non lo spegne (ri-toccando 🎤 o con un comando vocale).
  function startRecognition() {
    if (Talk.listening) return;
    const started = Coach.startListening(transcript => {
      if (!transcript) return;
      const input = document.getElementById('assistant-input');
      if (input) input.value = transcript;
      handleTurn(transcript);
    }, reason => {
      if (reason === 'not-allowed' || reason === 'service-not-allowed') {
        Talk.micOn = false;
        addMessage('assistant', 'Non posso accedere al microfono: consenti l\'accesso al microfono nelle impostazioni del browser e riprova.');
        return;
      }
      // Fine ascolto: se il microfono è ancora acceso e non c'è una risposta
      // in lavorazione, riascolta (conversazione continua).
      maybeRearm();
    });
    if (started) {
      Talk.micOn = true;
    } else {
      Talk.micOn = false;
      addMessage('assistant', 'Il riconoscimento vocale non è disponibile su questo dispositivo o browser. Puoi comunque scrivere qui sotto (es. "prossimo").');
    }
  }

  // Spegne il microfono (anche via comando vocale).
  function stopMic() {
    Talk.micOn = false;
    Coach.stopListening();
  }

  // Riascolta dopo una risposta: solo se il microfono è acceso, non sta già
  // ascoltando, non c'è una risposta in lavorazione e la voce ha finito di
  // parlare (per non sentire la propria voce).
  function maybeRearm() {
    if (!Talk.micOn || Talk.listening || Talk.pending || AssistantUI._busy) return;
    if (Coach.isSpeaking()) return;
    startRecognition();
  }

  // ---- Flusso della conversazione (stile Alexa, ma con voce opzionale) ----
  // Le risposte vengono lette ad alta voce SOLO se l'interruttore 🔊 è attivo.
  // Se il microfono è acceso, al termine della risposta il coach riascolta da
  // solo (conversazione continua) senza sentire la propria voce.
  function reply(text) {
    if (!text) return;
    Talk.pending = false;
    addMessage('assistant', text);
    if (Coach.isAvailable() && Coach.voiceEnabled) {
      Coach.speak(text, null, () => maybeRearm());
    } else {
      // Nessuna voce: se il microfono è acceso riascolta subito.
      maybeRearm();
    }
  }

  function startCooking(recipeId, dayType, introText) {
    Talk.cooking = true;
    Talk.session = { recipeId, dayType: dayType === 'rest' ? 'rest' : 'training', phase: 'ingredients', index: 0 };
    reply(introText);
  }

  function advanceCooking() {
    const session = Talk.session;
    const recipe = typeof getRecipe === 'function' ? getRecipe(session.recipeId) : null;
    if (!recipe) {
      reply('Non trovo più la ricetta: la sessione di cucina è terminata.');
      Talk.clearSession();
      return;
    }
    const profile = typeof getPortionProfile === 'function' ? getPortionProfile() : 'man';
    if (session.phase === 'ingredients') {
      const next = session.index + 1;
      if (next < recipe.ingredients.length) {
        session.index = next;
        reply(API.buildCookingStep(recipe, profile, session.dayType, 'ingredients', session.index));
      } else {
        session.phase = 'steps';
        session.index = 0;
        const first = API.buildCookingStep(recipe, profile, session.dayType, 'steps', 0);
        if (first) reply('Perfetto, ingredienti finiti. Passiamo alla preparazione. ' + first);
        else { Talk.clearSession(); reply('Fatto! La ricetta non ha passaggi di preparazione da seguire. Buon appetito!'); }
      }
      return;
    }
    const next = session.index + 1;
    if (next < recipe.steps.length) {
      session.index = next;
      reply(API.buildCookingStep(recipe, profile, session.dayType, 'steps', session.index));
    } else {
      Talk.clearSession();
      reply('Fatto! Hai completato la preparazione. Buon appetito!');
    }
  }

  function backCooking() {
    const session = Talk.session;
    const recipe = typeof getRecipe === 'function' ? getRecipe(session.recipeId) : null;
    if (!recipe) {
      reply('Non trovo più la ricetta: la sessione di cucina è terminata.');
      Talk.clearSession();
      return;
    }
    const profile = typeof getPortionProfile === 'function' ? getPortionProfile() : 'man';
    if (session.phase === 'steps' && session.index === 0) {
      session.phase = 'ingredients';
      session.index = Math.max(0, recipe.ingredients.length - 1);
    } else if (session.index > 0) {
      session.index -= 1;
    }
    reply(API.buildCookingStep(recipe, profile, session.dayType, session.phase, session.index));
  }

  async function handleTurn(text) {
    const question = String(text || '').trim();
    if (!question || AssistantUI._busy) return;
    Talk.pending = true;
    const input = document.getElementById('assistant-input');
    if (input) input.value = '';
    addMessage('user', question);

    // Comandi del microfono, validi anche a voce.
    if (Talk.isMicOffCommand(question)) {
      const wasOn = Talk.micOn || Talk.listening;
      if (wasOn) stopMic();
      reply(wasOn
        ? 'Ok, microfono spento. Puoi riattivarlo col pulsante 🎤 o scrivendo "accendi il microfono".'
        : 'Il microfono è già spento.');
      return;
    }
    if (Talk.isMicOnCommand(question)) {
      if (Talk.micOn || Talk.listening) {
        reply('Il microfono è già acceso, ti ascolto.');
      } else {
        // Conferma solo testuale: il riconoscimento parte subito e non deve
        // ascoltare la propria voce.
        Talk.micOn = true;
        startRecognition();
        addMessage('assistant', 'Ok, microfono acceso. Parla pure.');
      }
      return;
    }

    // Comandi di sessione (cucina guidata): prossimo / avanti / indietro / stop.
    if (Talk.cooking) {
      const normalized = API.normalizeText ? API.normalizeText(question) : question.toLowerCase();
      if (['stop', 'ferma', 'basta', 'fine', 'chiudi', 'esci', 'annulla'].includes(normalized)) {
        Talk.clearSession();
        reply('Ok, sessione di cucina terminata. Chiedimi pure altro!');
        return;
      }
      if (Talk.isNextCommand(question)) { advanceCooking(); return; }
      if (Talk.isBackCommand(question)) { backCooking(); return; }
      // Domanda diversa durante la cucina: chiudo la sessione e rispondo.
      Talk.clearSession();
    }

    const context = currentContext();
    if (!context) {
      reply('Non riesco a leggere il tuo piano in questo momento. Riprova tra poco.');
      return;
    }
    const local = API.answerLocally ? API.answerLocally(question, context, GUIDE) : null;
    if (local && local.text) {
      if (local.cooking) startCooking(local.cooking.recipeId, local.cooking.dayType || 'training', local.text);
      else reply(local.text);
      return;
    }
    if (!cloudEnabled) {
      reply('Non conosco una risposta pronta per questa domanda e l\'AI online è disattivata. Posso comunque dirti cosa mangi oggi, cosa comprare, quante volte mangi pesce, cosa preparare in anticipo e come funziona l\'app.');
      return;
    }
    if (!navigator.onLine) {
      reply('Sembra che tu sia offline, quindi non posso usare l\'AI online. Prova con una domanda sul piano (es. "cosa mangio oggi?"): a quelle rispondo anche senza connessione.');
      return;
    }
    AssistantUI._busy = true;
    const typing = addTyping();
    try {
      const system = API.buildSystemPrompt ? API.buildSystemPrompt(context, GUIDE) : '';
      const geminiKey = readGeminiKey();
      let answer = null;
      if (geminiKey) {
        try {
          answer = await requestGemini(system, question, geminiKey);
        } catch (_) {
          // Chiave assente/non valida o quota gratuita esaurita: ripiego su
          // Pollinations così l'assistente continua a funzionare.
          console.warn('Gemini non disponibile, ripiego su Pollinations.');
        }
      }
      if (!answer) answer = await requestCloud(system, question);
      removeTyping(typing);
      reply(answer);
    } catch (_) {
      removeTyping(typing);
      reply('L\'AI online non ha risposto in tempo. Riprova tra poco, oppure fai una domanda sul piano (es. "cosa devo comprare?"): a quelle rispondo anche senza connessione.');
    } finally {
      AssistantUI._busy = false;
    }
  }

  function injectUi() {
    document.body.insertAdjacentHTML('beforeend', `
      <button id="assistant-fab" class="assistant-fab" aria-label="Assistente e coach vocale" title="Assistente e coach vocale">💬</button>
      <div id="assistant-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="assistant-title">
        <div class="modal-content assistant-content">
          <div class="modal-header">
            <div><p class="eyebrow">ASSISTENTE AI · COACH</p><h2 id="assistant-title">Domande sul tuo piano</h2></div>
            <button class="btn-icon" onclick="AssistantUI.close()" aria-label="Chiudi">&times;</button>
          </div>
          <div id="assistant-messages" class="assistant-messages" aria-live="polite"></div>
          <div id="assistant-suggestions" class="assistant-suggestions"></div>
          <div class="assistant-input-row">
            <button id="assistant-mic" class="btn-icon assistant-mic" title="Parla" aria-label="Parla" hidden>🎤</button>
            <input id="assistant-input" type="text" placeholder="Chiedi… es. Cosa mangio oggi?" autocomplete="off" enterkeyhint="send">
            <button id="assistant-send" class="btn btn-primary">Invia</button>
          </div>
          <div class="assistant-footer">
            <label class="assistant-cloud-toggle"><input id="assistant-voice" type="checkbox" ${readVoicePref() ? 'checked' : ''}> 🔊 Risposte ad alta voce</label>
            <label class="assistant-cloud-toggle"><input id="assistant-cloud" type="checkbox" ${cloudEnabled ? 'checked' : ''}> AI online gratuita per le altre domande</label>
            <div class="assistant-gemini">
              <label for="assistant-gemini-key">🔑 Chiave Google Gemini (facoltativa, gratuita)</label>
              <input id="assistant-gemini-key" type="password" placeholder="Incolla qui la chiave AIza…" autocomplete="off" spellcheck="false" value="${readGeminiKey()}">
              <small id="assistant-gemini-status"></small>
            </div>
            <p class="assistant-privacy">Le risposte sul piano (pasti, spesa, frequenze, ricette) sono calcolate sul dispositivo e funzionano anche offline. Quando l'AI online è attiva, la domanda e un riepilogo del piano vengono inviati a Google Gemini (se hai inserito la chiave) oppure a Pollinations.AI. La chiave Gemini resta salvata solo su questo dispositivo e non viene mai caricata nel repository.</p>
          </div>
        </div>
      </div>`);
    const suggestions = document.getElementById('assistant-suggestions');
    if (suggestions) {
      suggestions.innerHTML = SUGGESTIONS.map(text =>
        `<button class="assistant-suggestion" onclick="AssistantUI.send('${text.replace(/'/g, "\\'")}')">${text}</button>`
      ).join('');
    }
  }

  function bindEvents() {
    document.getElementById('assistant-fab')?.addEventListener('click', () => AssistantUI.open());
    document.getElementById('assistant-send')?.addEventListener('click', () => {
      AssistantUI.send(document.getElementById('assistant-input')?.value || '');
    });
    const input = document.getElementById('assistant-input');
    input?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        AssistantUI.send(input.value);
      }
    });
    document.getElementById('assistant-cloud')?.addEventListener('change', event => {
      cloudEnabled = Boolean(event.target.checked);
      writeCloudPref(cloudEnabled);
    });
    document.getElementById('assistant-voice')?.addEventListener('change', event => {
      Coach.voiceEnabled = Boolean(event.target.checked);
      writeVoicePref(Coach.voiceEnabled);
      if (!Coach.voiceEnabled) Coach.stop();
    });
    const geminiKey = document.getElementById('assistant-gemini-key');
    geminiKey?.addEventListener('change', event => {
      writeGeminiKey(event.target.value);
      updateGeminiStatus();
    });
    updateGeminiStatus();
    if (typeof bindModalOutsideClose === 'function') {
      bindModalOutsideClose('assistant-modal', () => AssistantUI.close());
    }
    setupMic();
  }

  function updateGeminiStatus() {
    const status = document.getElementById('assistant-gemini-status');
    if (!status) return;
    if (readGeminiKey()) {
      status.textContent = `✓ Gemini attivo (${GEMINI_MODEL}). Se la quota gratuita finisce, uso Pollinations.`;
      status.className = 'assistant-gemini-ok';
    } else {
      status.textContent = 'Nessuna chiave: uso Pollinations.AI (gratuito, senza chiave).';
      status.className = '';
    }
  }

  function setupMic() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const mic = document.getElementById('assistant-mic');
    if (!mic) return;
    if (SpeechRecognition) mic.hidden = false;
    mic.addEventListener('click', () => {
      if (Talk.listening) {
        Coach.stopListening();
        return;
      }
      AssistantUI.toggleMic();
    });
  }

  function messageNode(role, text) {
    const node = document.createElement('div');
    node.className = `assistant-msg ${role}`;
    if (role === 'assistant') {
      const span = document.createElement('span');
      span.className = 'assistant-msg-text';
      span.textContent = text;
      node.appendChild(span);
    } else {
      node.textContent = text;
    }
    return node;
  }

  function addMessage(role, text) {
    const container = document.getElementById('assistant-messages');
    if (!container) return;
    container.appendChild(messageNode(role, text));
    container.scrollTop = container.scrollHeight;
  }

  function addTyping() {
    const container = document.getElementById('assistant-messages');
    if (!container) return null;
    const node = document.createElement('div');
    node.className = 'assistant-msg assistant assistant-typing';
    node.innerHTML = '<span></span><span></span><span></span>';
    container.appendChild(node);
    container.scrollTop = container.scrollHeight;
    return node;
  }

  function removeTyping(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  window.Coach = Coach;
  window.AssistantUI = AssistantUI;
  window.PianoAssistantUI = { Coach, AssistantUI };
})();
