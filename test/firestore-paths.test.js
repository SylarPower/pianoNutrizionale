'use strict';
/* Lint statico dei percorsi Firestore (regressione import catalogo).
 *
 * In Firestore un documento ha un numero PARI di segmenti
 * (collezione/documento/…), una collezione un numero DISPARI. Il client
 * (firebase-admin / @google-cloud/firestore) rifiuta i percorsi invalidi
 * PRIMA di qualunque scrittura, con un errore senza `code`: lato server il
 * wrapper apiError lo classifica come internal → 500 "Operazione non
 * disponibile". È esattamente il bug dello snapshot di versione scritto su
 * `globalIngredientCatalog/versions/<n>` (3 segmenti = collezione, non
 * documento), corretto in `globalIngredientCatalog/versions/snapshots/<n>`.
 *
 * Questo test scansiona tutti i .js in js/, functions/src/,
 * functions/scripts/, test/ e functions/test/ e valuta i literal (stringhe e
 * template, commenti esclusi) passati ai costruttori di riferimenti:
 * db.doc/db.collection, docAt/collectionAt, adminGetDoc/adminCollectionAt,
 * fb.doc(db, …)/fb.collection(db, …) e qualunque <ricevitore>.doc/.collection.
 * Regole:
 *  - literal con almeno una '/' usato come documento → segmenti PARI;
 *  - literal con almeno una '/' usato come collezione → segmenti DISPARI;
 *  - nessun segmento vuoto;
 *  - ogni ${…} di un template vale esattamente un segmento;
 *  - i literal di un solo segmento (es. collectionRef.doc('x')) sono
 *    riferimenti relativi legittimi e non vengono valutati.
 * Nota: questo stesso file è escluso dalla scansione perché contiene i
 * pattern di ricerca e, nei commenti, esempi di percorsi non validi. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['js', 'functions/src', 'functions/scripts', 'test', 'functions/test'];
const SELF = `test${path.sep}firestore-paths.test.js`;
// Marcatore di un segmento ${…} nei template: non contiene '/'.
const SEG = '\u0000';
// Parole chiave dopo le quali una '/' apre una regex (non una divisione).
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'yield', 'await', 'do', 'else', 'instanceof']);

function listJsFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

function filesToScan() {
  const files = SCAN_DIRS.flatMap(dir => listJsFiles(path.join(ROOT, dir)));
  return files.filter(file => path.relative(ROOT, file) !== SELF).sort();
}

/* Sostituisce i commenti con spazi (preservando newlines e offset, così i
 * numeri di riga restano quelli del file originale) e lascia intatti
 * stringhe, template e literal regex: i pattern di ricerca devono vedere
 * solo codice reale. Macchina a stati con stack per i ${…} dei template. */
function stripComments(code) {
  const out = [];
  const stack = [{ mode: 'code', braces: 0 }];
  let prev = '';
  let prevWord = '';
  let i = 0;
  const regexAllowed = () => prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev) || REGEX_KEYWORDS.has(prevWord);
  while (i < code.length) {
    const frame = stack[stack.length - 1];
    const c = code[i];
    const next = code[i + 1];
    if (frame.mode === 'template') {
      if (c === '\\') { out.push(c, next === undefined ? '' : next); i += 2; continue; }
      if (c === '`') { stack.pop(); out.push(c); i++; prev = '`'; prevWord = ''; continue; }
      if (c === '$' && next === '{') { out.push('${'); i += 2; stack.push({ mode: 'code', braces: 0 }); continue; }
      out.push(c); i++; continue;
    }
    // mode 'code'
    if (stack.length > 1) {
      if (c === '{') { frame.braces++; }
      else if (c === '}') {
        if (frame.braces === 0) { stack.pop(); out.push(c); i++; continue; } // chiude ${…}: si torna nel template
        frame.braces--;
      }
    }
    if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') { out.push(' '); i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      out.push(' ', ' '); i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) { out.push(code[i] === '\n' ? '\n' : ' '); i++; }
      out.push(' ', ' '); i += 2;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      // Literal regex: copiato tale e quale (apici interni non aprono stringhe).
      out.push(c); i++;
      let inClass = false;
      while (i < code.length) {
        const r = code[i];
        if (r === '\n') break; // difensivo: regex non terminata
        out.push(r); i++;
        if (r === '\\') { if (i < code.length) { out.push(code[i]); i++; } continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
      }
      while (i < code.length && /[a-z]/.test(code[i])) { out.push(code[i]); i++; } // flag
      prev = '/'; prevWord = '';
      continue;
    }
    if (c === "'" || c === '"') {
      out.push(c); i++;
      while (i < code.length) {
        const s = code[i];
        if (s === '\\') { out.push(s, code[i + 1] === undefined ? '' : code[i + 1]); i += 2; continue; }
        out.push(s); i++;
        if (s === c || s === '\n') break;
      }
      prev = c; prevWord = '';
      continue;
    }
    if (c === '`') { out.push(c); i++; stack.push({ mode: 'template' }); continue; }
    out.push(c);
    if (!/\s/.test(c)) {
      prev = c;
      prevWord = /[a-zA-Z_$]/.test(c) ? prevWord + c : '';
    }
    i++;
  }
  return out.join('');
}

/* Estrae il literal (stringa o template) che inizia a `start`; per i template
 * ogni ${…} diventa un segmento segnaposto. Ritorna null se l'argomento non è
 * un literal puro (identificatore, espressione, concatenazione con '+'). */
function literalArg(code, start) {
  let i = start;
  while (i < code.length && /\s/.test(code[i])) i++;
  const quote = code[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let value = '';
  let display = '';
  i += 1;
  while (i < code.length) {
    const c = code[i];
    if (c === '\\') { value += code[i + 1] === undefined ? '' : code[i + 1]; display += value.slice(-1); i += 2; continue; }
    if (c === quote) { i += 1; break; }
    if (quote === '`' && c === '$' && code[i + 1] === '{') {
      // ${…}: trova la graffa chiusa corrispondente (consapevole di stringhe
      // e template annidati) e conta l'intera espressione come UN segmento.
      let depth = 1;
      let j = i + 2;
      let expr = '';
      while (j < code.length && depth > 0) {
        const e = code[j];
        if (e === '\\') { expr += code[j + 1] === undefined ? '' : code[j + 1]; j += 2; continue; }
        if (e === "'" || e === '"' || e === '`') {
          const inner = e;
          expr += e; j += 1;
          while (j < code.length) {
            if (code[j] === '\\') { expr += code[j + 1] === undefined ? '' : code[j + 1]; j += 2; continue; }
            expr += code[j];
            if (code[j] === inner || code[j] === '\n') { j += 1; break; }
            j += 1;
          }
          continue;
        }
        if (e === '{') depth += 1;
        else if (e === '}') { depth -= 1; if (depth === 0) { j += 1; break; } }
        expr += e; j += 1;
      }
      value += SEG;
      display += `\${${expr}}`;
      i = j;
      continue;
    }
    value += c; display += c; i += 1;
  }
  let k = i;
  while (k < code.length && /\s/.test(code[k])) k++;
  if (code[k] === '+') return null; // concatenazione: non valutabile staticamente
  return { value, display, end: i };
}

// Costruttori di riferimenti a DOCUMENTO (percorso: segmenti pari).
const DOC_PATTERNS = [
  /\bfb\s*\.\s*doc\s*\(\s*[\w$]+\s*,/g,
  /\bdocAt\s*\(/g,
  /\badminGetDoc\s*\(/g,
  /[\w$)\]]+\s*\.\s*doc\s*\(/g
];
// Costruttori di riferimenti a COLLEZIONE (percorso: segmenti dispari).
const COLLECTION_PATTERNS = [
  /\bfb\s*\.\s*collection\s*\(\s*[\w$]+\s*,/g,
  /\bcollectionAt\s*\(/g,
  /\badminCollectionAt\s*\(/g,
  /[\w$)\]]+\s*\.\s*collection\s*\(/g
];

function findProblems(kind) {
  const patterns = kind === 'doc' ? DOC_PATTERNS : COLLECTION_PATTERNS;
  const problems = [];
  for (const file of filesToScan()) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const seen = new Set(); // stesso argomento già valutato da un altro pattern
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(code)) !== null) {
        const arg = literalArg(code, match.index + match[0].length);
        if (!arg) continue;
        const key = `${match.index}:${arg.end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Senza '/' è un riferimento relativo a un solo segmento (es.
        // collectionRef.doc('x')): legittimo, non valutato.
        if (!arg.value.includes('/')) continue;
        const segments = arg.value.split('/');
        const line = code.slice(0, match.index).split('\n').length;
        const call = `${code.slice(match.index, arg.end)})`;
        if (segments.some(segment => segment === '')) {
          problems.push(`${rel}:${line} ${call} → segmento vuoto nel percorso "${arg.display}"`);
        } else if (kind === 'doc' && segments.length % 2 !== 0) {
          problems.push(`${rel}:${line} ${call} → ${segments.length} segmenti: i percorsi documento devono essere PARI (collezione/documento/…) "${arg.display}"`);
        } else if (kind === 'collection' && segments.length % 2 === 0) {
          problems.push(`${rel}:${line} ${call} → ${segments.length} segmenti: i percorsi collezione devono essere DISPARI "${arg.display}"`);
        }
      }
    }
  }
  return problems;
}

test('percorsi Firestore documento: literal con segmenti pari e nessun segmento vuoto', () => {
  const problems = findProblems('doc');
  assert.deepEqual(problems, [],
    `Percorsi documento non validi (un documento ha segmenti PARI; lo snapshot catalogo vive in globalIngredientCatalog/versions/snapshots/<n>):\n${problems.join('\n')}`);
});

test('percorsi Firestore collezione: literal con segmenti dispari e nessun segmento vuoto', () => {
  const problems = findProblems('collection');
  assert.deepEqual(problems, [],
    `Percorsi collezione non validi (una collezione ha segmenti DISPARI):\n${problems.join('\n')}`);
});
