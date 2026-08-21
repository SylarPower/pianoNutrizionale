/* Piano Nutrizionale — dominio puro dei prezzi condivisi.
 *
 * Registro prezzi "Spesa Smart": un UNICO database condiviso tra tutti gli
 * utenti dell'app (collezione Firestore priceEntries). Questo file contiene
 * SOLO funzioni pure: nessun DOM, nessuna chiamata Firebase. Le stesse
 * convenzioni di js/domain.js: trasformazioni idempotenti e testabili.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PriceDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, () => {
  'use strict';

  const UNITS = ['gr', 'kg', 'ml', 'l', 'pz'];
  const UNIT_ALIASES = {
    g: 'gr', gr: 'gr', grammo: 'gr', grammi: 'gr',
    kg: 'kg', kilo: 'kg', chili: 'kg',
    ml: 'ml', millilitro: 'ml', millilitri: 'ml',
    l: 'l', litro: 'l', litri: 'l',
    pz: 'pz', pezzo: 'pz', pezzi: 'pz'
  };

  const DEFAULT_BRAND = 'Generico';

  // Chiave normalizzata per i confronti: minuscole, senza accenti, spazi
  // collassati. "Pasta Integrale" e "pasta integrale" sono lo stesso prodotto.
  function priceKey(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeUnit(unit) {
    const key = String(unit || '').trim().toLowerCase();
    return UNIT_ALIASES[key] || null;
  }

  function normUnitFor(unit) {
    const normalized = normalizeUnit(unit);
    if (normalized === 'gr' || normalized === 'kg') return 'kg';
    if (normalized === 'ml' || normalized === 'l') return 'l';
    return 'pz';
  }

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  // Prezzo normalizzato (€/kg, €/l oppure €/pz). Restituisce null se i
  // valori non sono utilizzabili.
  function computeNormPrice(price, weight, unit) {
    const priceValue = Number(price);
    const weightValue = Number(weight);
    const normalizedUnit = normalizeUnit(unit);
    if (!normalizedUnit) return null;
    if (!Number.isFinite(priceValue) || priceValue <= 0) return null;
    if (!Number.isFinite(weightValue) || weightValue <= 0) return null;
    const perBaseUnit = (normalizedUnit === 'gr' || normalizedUnit === 'ml')
      ? (priceValue / weightValue) * 1000
      : priceValue / weightValue;
    return {
      price: round2(priceValue),
      weight: round2(weightValue),
      unit: normalizedUnit,
      normPrice: round2(perBaseUnit),
      normUnit: normUnitFor(normalizedUnit)
    };
  }

  function todayISODate(now = new Date()) {
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
  }

  // Costruisce una voce pronta per Firestore. Lancia errori con messaggi
  // leggibili dall'utente quando manca qualcosa.
  function buildPriceEntry(input = {}, meta = {}) {
    const store = String(input.store || '').trim();
    const product = String(input.product || '').trim();
    const brand = String(input.brand || '').trim() || DEFAULT_BRAND;
    if (!store) throw new Error('Indica il negozio');
    if (!product) throw new Error('Indica il prodotto');
    if (!priceKey(store)) throw new Error('Nome negozio non valido');
    if (!priceKey(product)) throw new Error('Nome prodotto non valido');
    const computed = computeNormPrice(input.price, input.weight, input.unit);
    if (!computed) throw new Error('Prezzo e quantità devono essere maggiori di zero');
    return {
      store,
      product,
      brand,
      storeKey: priceKey(store),
      productKey: priceKey(product),
      brandKey: priceKey(brand),
      price: computed.price,
      weight: computed.weight,
      unit: computed.unit,
      normPrice: computed.normPrice,
      normUnit: computed.normUnit,
      isWeightEstimated: Boolean(input.isWeightEstimated),
      date: input.date || todayISODate(),
      createdBy: meta.uid || null,
      createdByUsername: meta.username || ''
    };
  }

  // Ordine temporale: createdAtMs (client) prima, poi il Timestamp Firestore.
  function entryTimestamp(entry) {
    if (Number.isFinite(entry?.createdAtMs)) return entry.createdAtMs;
    const toMillis = entry?.createdAt?.toMillis;
    if (typeof toMillis === 'function') {
      try { return toMillis.call(entry.createdAt); } catch (_) { return 0; }
    }
    return 0;
  }

  function sortEntriesDesc(entries) {
    return [...(entries || [])].sort((a, b) => entryTimestamp(b) - entryTimestamp(a));
  }

  // Ultimo prezzo registrato per ogni negozio (base del confronto).
  function latestPerStore(entries) {
    const byStore = new Map();
    sortEntriesDesc(entries).forEach(entry => {
      const key = priceKey(entry.store);
      if (!byStore.has(key)) byStore.set(key, entry);
    });
    return [...byStore.values()];
  }

  function compareStores(entries) {
    const options = latestPerStore(entries)
      .filter(entry => Number.isFinite(entry?.normPrice))
      .sort((a, b) => a.normPrice - b.normPrice || entryTimestamp(b) - entryTimestamp(a));
    return { best: options[0] || null, others: options.slice(1) };
  }

  function priceStats(entries) {
    const values = (entries || []).map(entry => Number(entry?.normPrice)).filter(Number.isFinite);
    if (!values.length) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = round2(values.reduce((sum, value) => sum + value, 0) / values.length);
    return { min: round2(min), max: round2(max), avg, count: values.length };
  }

  // Giudizio sul prezzo corrente rispetto allo storico dello stesso prodotto
  // (stesse soglie del prototipo: minimo, sotto media, sopra media +10%).
  function dealBadge(normPrice, historyNormPrices = []) {
    const values = (historyNormPrices || []).map(Number).filter(Number.isFinite);
    const priceValue = Number(normPrice);
    if (!values.length || !Number.isFinite(priceValue)) return null;
    const min = Math.min(...values);
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    if (priceValue <= min + 1e-9) return { type: 'min', label: '🔥 Minimo storico' };
    if (priceValue < avg) return { type: 'good', label: '🟢 Ottimo affare' };
    if (priceValue > avg * 1.1) return { type: 'high', label: '🔴 Caro (+10%)' };
    return null;
  }

  // ---- Numeri e quantità in formato italiano ----

  function parseItalianNumber(raw) {
    const cleaned = String(raw ?? '').trim().replace(/\s/g, '').replace(/[€]|eur/gi, '');
    if (!cleaned || !/^\d/.test(cleaned)) return null;
    let value = cleaned;
    if (value.includes(',') && value.includes('.')) value = value.replace(/\./g, '').replace(/,/g, '.');
    else if (value.includes(',')) value = value.replace(/,/g, '.');
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const WEIGHT_TOKEN = /(\d+(?:[.,]\d+)?)\s*(grammi|grammo|gr|g|kilo|kg|millilitri|millilitro|ml|litri|litro|l|pezzi|pezzo|pz)\b/i;

  // Interpreta un token tipo "500 g", "1,5 l", "6pz". Peso in grammi/ml
  // senza unità viene trattato come "gr" dal chiamante.
  function parseWeightToken(text) {
    const match = String(text || '').match(WEIGHT_TOKEN);
    if (!match) return null;
    const weight = parseItalianNumber(match[1]);
    if (!weight || weight <= 0) return null;
    const unitToken = match[2].toLowerCase();
    let unit;
    if (unitToken === 'kg' || unitToken === 'kilo') unit = 'kg';
    else if (unitToken === 'ml' || unitToken === 'millilitro' || unitToken === 'millilitri') unit = 'ml';
    else if (unitToken === 'l' || unitToken === 'litro' || unitToken === 'litri') unit = 'l';
    else if (unitToken === 'pz' || unitToken === 'pezzo' || unitToken === 'pezzi') unit = 'pz';
    else unit = 'gr';
    return { weight, unit };
  }

  // ---- Importazione backup (formato legacy "Spesa Smart" e formato nuovo) ----

  // dd/mm/yyyy → yyyy-mm-dd; le date ISO restano invariate.
  function parseLegacyDate(raw) {
    const value = String(raw || '').trim();
    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const italian = value.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (italian) {
      return `${italian[3]}-${italian[2].padStart(2, '0')}-${italian[1].padStart(2, '0')}`;
    }
    return todayISODate();
  }

  // Converte una voce esportata dal vecchio prototipo (id numerico = epoch ms,
  // data dd/mm/yyyy, normPrice stringa) oppure una voce già nel formato nuovo.
  function migrateImportedEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const store = String(raw.store || '').trim();
    const product = String(raw.product || '').trim();
    if (!priceKey(store) || !priceKey(product)) return null;
    const computed = computeNormPrice(raw.price, raw.weight, raw.unit);
    if (!computed) return null;
    const brand = String(raw.brand || '').trim() || DEFAULT_BRAND;
    const legacyId = Number(raw.legacyId ?? (typeof raw.id === 'number' ? raw.id : Number.NaN));
    const rawCreatedAt = Number(raw.createdAtMs);
    const createdAtMs = Number.isFinite(rawCreatedAt)
      ? rawCreatedAt
      : (Number.isFinite(legacyId) ? legacyId : Date.now());
    const entry = {
      store,
      product,
      brand,
      storeKey: priceKey(store),
      productKey: priceKey(product),
      brandKey: priceKey(brand),
      price: computed.price,
      weight: computed.weight,
      unit: computed.unit,
      normPrice: computed.normPrice,
      normUnit: computed.normUnit,
      isWeightEstimated: Boolean(raw.isWeightEstimated),
      date: parseLegacyDate(raw.date),
      createdAtMs
    };
    if (Number.isFinite(legacyId)) entry.legacyId = legacyId;
    return entry;
  }

  // Prepara un file di backup per l'importazione: accetta un array diretto
  // oppure un oggetto wrapper con campo `entries`. Le voci non valide e i
  // duplicati interni al file vengono scartati e contati.
  function preparePriceImport(data) {
    const list = Array.isArray(data) ? data : (Array.isArray(data?.entries) ? data.entries : null);
    if (!list) throw new Error('Il file non contiene un elenco di prezzi');
    const migrated = [];
    let skipped = 0;
    list.forEach(raw => {
      const entry = migrateImportedEntry(raw);
      if (entry) migrated.push(entry);
      else skipped += 1;
    });
    const seen = new Set();
    const entries = [];
    migrated.forEach(entry => {
      const dedupeKey = Number.isFinite(entry.legacyId)
        ? `id:${entry.legacyId}`
        : [entry.storeKey, entry.productKey, entry.brandKey, entry.price, entry.weight, entry.unit, entry.date].join('|');
      if (seen.has(dedupeKey)) {
        skipped += 1;
        return;
      }
      seen.add(dedupeKey);
      entries.push(entry);
    });
    return { entries, skipped };
  }

  // ---- Suggerimenti per nomi simili ----
  // I prodotti scannerizzati da Open Food Facts spesso hanno nomi lunghi
  // ("Cereali di grano duro") mentre in archivio esiste già il nome semplice
  // ("Cereali"): il confronto funziona solo se il prodotto ha sempre la
  // stessa chiave, quindi suggeriamo il nome già in uso.

  // Token puliti: parentesi e punteggiatura non contano ("Uova intere (sode)"
  // → uova intere sode).
  function cleanTokens(value) {
    return priceKey(String(value || '').replace(/[()]/g, ' '))
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  function significantTokensFor(tokens) {
    return tokens.filter(token => token.length >= 4 || /^\d+$/.test(token));
  }

  function significantTokens(value) {
    return significantTokensFor(cleanTokens(value));
  }

  function similarProducts(query, products = [], limit = 5) {
    const queryKey = priceKey(query);
    if (!queryKey) return [];
    const queryWords = queryKey.split(' ');
    const queryTokens = significantTokens(query);
    const scored = [];
    [...new Set((products || []).map(String))].forEach(product => {
      const productKey = priceKey(product);
      if (!productKey || productKey === queryKey) return;
      const productWords = productKey.split(' ');
      let score = 0;
      // Un nome è una parola intera dell'altro ("cereali" in "cereali di grano duro").
      if (queryWords.includes(productKey) || productWords.includes(queryKey)) score += 3;
      // Parole significative in comune.
      const shared = queryTokens.filter(token => productWords.includes(token)).length;
      score += shared * 2;
      if (score >= 3) scored.push({ product, score });
    });
    return scored
      .sort((a, b) => b.score - a.score || a.product.localeCompare(b.product, 'it'))
      .slice(0, limit)
      .map(item => item.product);
  }

  // ---- Ricerca prodotti per il confronto ----

  // Corrispondenza esatta sulla chiave + candidati parziali (per la ricerca
  // libera del confronto e i suggerimenti).
  function matchProducts(query, products = []) {
    const key = priceKey(query);
    const list = [...new Set((products || []).map(String))];
    if (!key) return { exact: null, candidates: [] };
    const exact = list.find(product => priceKey(product) === key) || null;
    const candidates = list
      .filter(product => priceKey(product) !== key && priceKey(product).includes(key))
      .sort((a, b) => a.localeCompare(b, 'it'))
      .slice(0, 8);
    return { exact, candidates };
  }

  // ---- Formattazione ----

  function formatEuro(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '—';
    return `${(Math.round(numeric * 100) / 100).toFixed(2).replace('.', ',')} €`;
  }

  function formatNormPrice(entry) {
    if (!entry || !Number.isFinite(Number(entry.normPrice))) return '—';
    return `${formatEuro(entry.normPrice)}/${entry.normUnit || 'kg'}`;
  }

  function formatItalianDate(isoDate) {
    const match = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return String(isoDate || '');
    return `${match[3]}/${match[2]}/${match[1]}`;
  }

  return {
    UNITS,
    DEFAULT_BRAND,
    priceKey,
    normalizeUnit,
    normUnitFor,
    round2,
    computeNormPrice,
    todayISODate,
    buildPriceEntry,
    entryTimestamp,
    sortEntriesDesc,
    latestPerStore,
    compareStores,
    priceStats,
    dealBadge,
    parseItalianNumber,
    parseWeightToken,
    parseLegacyDate,
    preparePriceImport,
    similarProducts,
    matchProducts,
    formatEuro,
    formatNormPrice,
    formatItalianDate
  };
});
