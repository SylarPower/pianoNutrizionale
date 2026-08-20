'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../js/prices.js');

// ---- Chiavi e normalizzazione ----

test('priceKey: minuscole, accenti e spazi collassati', () => {
  assert.equal(p.priceKey('Pasta Integrale'), 'pasta integrale');
  assert.equal(p.priceKey('  Caffè   Orzo '), 'caffe orzo');
  assert.equal(p.priceKey('Puré'), 'pure');
  assert.equal(p.priceKey(''), '');
});

test('normalizeUnit accetta alias e unità estese', () => {
  assert.equal(p.normalizeUnit('GR'), 'gr');
  assert.equal(p.normalizeUnit('g'), 'gr');
  assert.equal(p.normalizeUnit('kilo'), 'kg');
  assert.equal(p.normalizeUnit('litri'), 'l');
  assert.equal(p.normalizeUnit('pz'), 'pz');
  assert.equal(p.normalizeUnit('q.b.'), null);
});

// ---- Prezzo normalizzato ----

test('computeNormPrice: grammi → €/kg', () => {
  const result = p.computeNormPrice(0.89, 500, 'gr');
  assert.equal(result.normPrice, 1.78);
  assert.equal(result.normUnit, 'kg');
});

test('computeNormPrice: kg, ml, l e pz', () => {
  assert.equal(p.computeNormPrice(3, 2, 'kg').normPrice, 1.5);
  assert.equal(p.computeNormPrice(1.5, 750, 'ml').normPrice, 2);
  assert.equal(p.computeNormPrice(1.2, 2, 'l').normPrice, 0.6);
  assert.equal(p.computeNormPrice(3, 6, 'pz').normPrice, 0.5);
  assert.equal(p.computeNormPrice(3, 6, 'pz').normUnit, 'pz');
});

test('computeNormPrice: valori non validi → null', () => {
  assert.equal(p.computeNormPrice(0, 500, 'gr'), null);
  assert.equal(p.computeNormPrice(-1, 500, 'gr'), null);
  assert.equal(p.computeNormPrice(1, 0, 'gr'), null);
  assert.equal(p.computeNormPrice(1, 500, 'etti'), null);
  assert.equal(p.computeNormPrice('abc', 500, 'gr'), null);
});

// ---- Costruzione voce ----

test('buildPriceEntry: campi completi, chiavi e arrotondamento', () => {
  const entry = p.buildPriceEntry(
    { store: ' Conad ', product: 'Pasta Barilla', brand: '', price: 0.89, weight: 500, unit: 'gr', date: '2026-08-20' },
    { uid: 'u1', username: 'mario' }
  );
  assert.equal(entry.store, 'Conad');
  assert.equal(entry.brand, 'Generico');
  assert.equal(entry.storeKey, 'conad');
  assert.equal(entry.productKey, 'pasta barilla');
  assert.equal(entry.normPrice, 1.78);
  assert.equal(entry.normUnit, 'kg');
  assert.equal(entry.createdBy, 'u1');
  assert.equal(entry.createdByUsername, 'mario');
  assert.equal(entry.isWeightEstimated, false);
});

test('buildPriceEntry: errori leggibili per campi mancanti', () => {
  assert.throws(() => p.buildPriceEntry({ product: 'X', price: 1, weight: 1, unit: 'pz' }), /negozio/i);
  assert.throws(() => p.buildPriceEntry({ store: 'S', price: 1, weight: 1, unit: 'pz' }), /prodotto/i);
  assert.throws(() => p.buildPriceEntry({ store: 'S', product: 'X', price: 0, weight: 1, unit: 'pz' }), /maggiori di zero/i);
});

// ---- Storico e confronto tra negozi ----

const entry = (store, normPrice, ts, extra = {}) => ({
  store, product: 'Latte', brand: 'Zymil', normPrice, normUnit: 'l',
  createdAtMs: ts, ...extra
});

test('latestPerStore: solo l’ultimo prezzo per negozio', () => {
  const entries = [
    entry('Conad', 1.9, 100),
    entry('Conad', 1.6, 300),
    entry('Lidl', 1.7, 200)
  ];
  const latest = p.latestPerStore(entries);
  assert.equal(latest.length, 2);
  const conad = latest.find(item => item.store === 'Conad');
  assert.equal(conad.normPrice, 1.6);
});

test('compareStores: vincitore = prezzo più basso, altri ordinati', () => {
  const entries = [
    entry('Conad', 1.9, 100),
    entry('Lidl', 1.5, 200),
    entry('Coop', 1.7, 300),
    entry('Lidl', 1.4, 400) // aggiornamento successivo da Lidl
  ];
  const { best, others } = p.compareStores(entries);
  assert.equal(best.store, 'Lidl');
  assert.equal(best.normPrice, 1.4);
  assert.deepEqual(others.map(item => item.store), ['Coop', 'Conad']);
});

test('priceStats: minimo, media e massimo sullo storico', () => {
  const stats = p.priceStats([entry('A', 1.2, 1), entry('B', 1.6, 2), entry('C', 2.0, 3)]);
  assert.deepEqual(stats, { min: 1.2, max: 2, avg: 1.6, count: 3 });
  assert.equal(p.priceStats([]), null);
});

test('dealBadge: minimo storico, affare, caro', () => {
  const history = [1.2, 1.6, 2.0];
  assert.equal(p.dealBadge(1.2, history).type, 'min');
  assert.equal(p.dealBadge(1.4, history).type, 'good');
  assert.equal(p.dealBadge(2.5, history).type, 'high');
  assert.equal(p.dealBadge(1.7, history), null); // tra media e +10%
  assert.equal(p.dealBadge(1.5, []), null);
});

// ---- Importazione da testo ----

test('parseSmartPaste: formato tabellare marca|prodotto|peso|prezzo', () => {
  const { items, skipped } = p.parseSmartPaste(
    'Barilla | Pasta spaghetti | 500 | 0,89\nZymil | Latte scremato | 1000 | 1,50',
    'Conad'
  );
  assert.equal(skipped, 0);
  assert.equal(items.length, 2);
  assert.equal(items[0].brand, 'Barilla');
  assert.equal(items[0].product, 'Pasta spaghetti');
  assert.equal(items[0].weight, 500);
  assert.equal(items[0].unit, 'gr');
  assert.equal(items[0].normPrice, 1.78);
  assert.equal(items[0].store, 'Conad');
  assert.equal(items[1].normPrice, 1.5);
});

test('parseSmartPaste: peso con unità nel formato tabellare', () => {
  const { items } = p.parseSmartPaste('Coca Cola | 1,5 l | 1,80', 'Lidl');
  assert.equal(items.length, 1);
  assert.equal(items[0].product, 'Coca Cola');
  assert.equal(items[0].weight, 1.5);
  assert.equal(items[0].unit, 'l');
  assert.equal(items[0].normPrice, 1.2);
});

test('parseSmartPaste: peso mancante → stimato 1000g con asterisco', () => {
  const { items } = p.parseSmartPaste('Mulino | Biscotti | — | 2,40', 'Coop');
  assert.equal(items.length, 1);
  assert.equal(items[0].weight, 1000);
  assert.equal(items[0].isWeightEstimated, true);
});

test('parseSmartPaste: formato libero con e senza peso', () => {
  const { items, skipped } = p.parseSmartPaste(
    'Pasta Barilla 500g 0,89\nLatte Zymil 1,50\nRiga senza prezzo\n[1] Riso Scotti 1kg 2,10 €',
    'Conad'
  );
  assert.equal(items.length, 3);
  assert.equal(skipped, 1);
  assert.equal(items[0].product, 'Pasta Barilla');
  assert.equal(items[0].weight, 500);
  assert.equal(items[0].unit, 'gr');
  assert.equal(items[1].product, 'Latte Zymil');
  assert.equal(items[1].isWeightEstimated, true);
  assert.equal(items[2].product, 'Riso Scotti');
  assert.equal(items[2].weight, 1);
  assert.equal(items[2].unit, 'kg');
});

test('parseSmartPaste: duplicati interni scartati', () => {
  const { items, skipped } = p.parseSmartPaste('Latte 1,50\nLatte 1,50', 'Conad');
  assert.equal(items.length, 1);
  assert.equal(skipped, 1);
});

// ---- Numeri italiani e token peso ----

test('parseItalianNumber: virgola, punto migliaia e simbolo euro', () => {
  assert.equal(p.parseItalianNumber('0,89'), 0.89);
  assert.equal(p.parseItalianNumber('1.234,56'), 1234.56);
  assert.equal(p.parseItalianNumber('2,10 €'), 2.1);
  assert.equal(p.parseItalianNumber('3'), 3);
  assert.equal(p.parseItalianNumber(''), null);
  assert.equal(p.parseItalianNumber('abc'), null);
});

test('parseWeightToken riconosce unità e decimali', () => {
  assert.deepEqual(p.parseWeightToken('Pasta 500 g'), { weight: 500, unit: 'gr' });
  assert.deepEqual(p.parseWeightToken('Acqua 1,5 litri'), { weight: 1.5, unit: 'l' });
  assert.deepEqual(p.parseWeightToken('Uova 6pz'), { weight: 6, unit: 'pz' });
  assert.deepEqual(p.parseWeightToken('Riso 1 kilo'), { weight: 1, unit: 'kg' });
  assert.equal(p.parseWeightToken('Pane'), null);
});

// ---- Ricerca prodotti ----

test('matchProducts: esatto e candidati parziali', () => {
  const products = ['Pasta Barilla', 'Pasta integrale', 'Latte Zymil'];
  const exact = p.matchProducts('pasta barilla', products);
  assert.equal(exact.exact, 'Pasta Barilla');
  const partial = p.matchProducts('pasta', products);
  assert.equal(partial.exact, null);
  assert.deepEqual(partial.candidates.sort(), ['Pasta Barilla', 'Pasta integrale']);
  assert.equal(p.matchProducts('', products).exact, null);
});

// ---- Formattazione ----

test('formatEuro e formatNormPrice usano la virgola', () => {
  assert.equal(p.formatEuro(1.5), '1,50 €');
  assert.equal(p.formatNormPrice({ normPrice: 1.78, normUnit: 'kg' }), '1,78 €/kg');
  assert.equal(p.formatItalianDate('2026-08-20'), '20/08/2026');
  assert.equal(p.formatItalianDate('20/08/2026'), '20/08/2026');
});

// ---- Importazione backup legacy ----

test('parseLegacyDate: dd/mm/yyyy e ISO', () => {
  assert.equal(p.parseLegacyDate('27/07/2026'), '2026-07-27');
  assert.equal(p.parseLegacyDate('4/8/2026'), '2026-08-04');
  assert.equal(p.parseLegacyDate('2026-08-20'), '2026-08-20');
});

const LEGACY_BACKUP = [
  { id: 1785167730046, date: '27/07/2026', store: 'Cadoro', product: 'Uova', brand: 'Eurovo, Le Naturelle', price: 2.29, weight: 12, unit: 'pz', isWeightEstimated: false, normPrice: '0.19', normUnit: 'pz' },
  { id: 1785169287841, date: '27/07/2026', store: 'Cadoro', product: 'Gnocchi di patate', brand: 'Cadoro', price: 7.48, weight: 1000, unit: 'gr', isWeightEstimated: false, normPrice: '7.48', normUnit: 'kg' },
  { id: 1786705208251, date: '14/08/2026', store: 'Famila', product: 'Latte', brand: 'Zymi', price: 1.5, weight: 1000, unit: 'ml', isWeightEstimated: false, normPrice: '1.50', normUnit: 'l' }
];

test('preparePriceImport: converte il backup legacy di Spesa Smart', () => {
  const { entries, skipped } = p.preparePriceImport(LEGACY_BACKUP);
  assert.equal(skipped, 0);
  assert.equal(entries.length, 3);
  const uova = entries[0];
  assert.equal(uova.date, '2026-07-27');
  assert.equal(uova.createdAtMs, 1785167730046, 'l\'ordine cronologico arriva dal vecchio id');
  assert.equal(uova.legacyId, 1785167730046);
  assert.equal(uova.productKey, 'uova');
  assert.equal(uova.storeKey, 'cadoro');
  assert.equal(typeof uova.normPrice, 'number');
  assert.equal(uova.normPrice, 0.19);
  assert.equal(entries[2].normUnit, 'l', 'ml normalizzato a litri');
});

test('preparePriceImport: scarta righe non valide e duplicati interni', () => {
  const data = [...LEGACY_BACKUP, LEGACY_BACKUP[0], { id: 9, store: 'X', product: '', price: 1, weight: 1, unit: 'pz' }];
  const { entries, skipped } = p.preparePriceImport(data);
  assert.equal(entries.length, 3);
  assert.equal(skipped, 2);
});

test('preparePriceImport: accetta il wrapper con campo entries', () => {
  const { entries } = p.preparePriceImport({ format: 'piano-nutrizionale-prices', entries: LEGACY_BACKUP });
  assert.equal(entries.length, 3);
  assert.throws(() => p.preparePriceImport({ altro: true }), /elenco di prezzi/i);
});

// ---- Suggerimenti nomi simili ----

test('similarProducts: nome scannerizzato lungo suggerisce il nome semplice in archivio', () => {
  const products = ['Cereali', 'Latte', 'Pasta Barilla', 'Fiocchi di latte'];
  assert.deepEqual(p.similarProducts('Cereali di grano duro', products)[0], 'Cereali');
  assert.equal(p.similarProducts('Latte Zymil scremato UHT', products)[0], 'Latte');
  assert.equal(p.similarProducts('pasta barilla integrale', products)[0], 'Pasta Barilla');
});

test('similarProducts: niente falsi positivi né auto-suggerimenti', () => {
  const products = ['Latte', 'Lattebusche', 'Cereali'];
  assert.ok(!p.similarProducts('Latte', products).includes('Lattebusche'), 'Lattebusche non è un suggerimento per Latte');
  assert.ok(!p.similarProducts('cereali', products).includes('Cereali'), 'il match esatto non viene suggerito');
  assert.deepEqual(p.similarProducts('', products), []);
  assert.deepEqual(p.similarProducts('Sgombro', products), []);
});
