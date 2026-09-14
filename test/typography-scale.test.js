'use strict';
/* Parte A — tipografia e spaziature unificate (app + console):
 * - ogni font-size fuori da :root usa un token --fs-* (o un em relativo);
 * - ogni margin/padding/gap usa la scala 8pt (0/4/8/12/16/24/32px o rem
 *   equivalenti), anche dentro clamp()/calc()/max(), composti solo da
 *   token var(--space-*), env() o unita' viewport/percentuali;
 * - i token --fs-* e --space-* sono definiti e identici nei due CSS. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILES = ['css/style.css', 'css/admin.css'];
const css = Object.fromEntries(
  FILES.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')])
);

const FS_TOKENS = {
  '--fs-hero': '2.125rem', '--fs-hero-max': '2.5rem', '--fs-h1': '1.75rem',
  '--fs-h2': '1.375rem', '--fs-h3': '1.25rem', '--fs-subtitle': '1.125rem',
  '--fs-body': '1rem', '--fs-secondary': ['.875rem', '0.875rem'],
  '--fs-caption': ['.75rem', '0.75rem'], '--fs-label': ['.625rem', '0.625rem'],
  '--fs-button': '1rem', '--fs-nav': '1.0625rem', '--fs-toolbar': '1.25rem',
  '--fs-tab': ['.875rem', '0.875rem'], '--fs-input': '1rem',
  '--fs-toast': ['.875rem', '0.875rem'], '--fs-badge': ['.625rem', '0.625rem'],
  '--fs-bottom-nav': ['.75rem', '0.75rem'],
};
const SPACE_TOKENS = {
  '--space-1': '4px', '--space-2': '8px', '--space-3': '12px',
  '--space-4': '16px', '--space-5': '24px', '--space-6': '32px',
};
const PX_OK = new Set([0, 4, 8, 12, 16, 24, 32]);
const REM_OK = new Set([0, 0.25, 0.5, 0.75, 1, 1.5, 2]);

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Regole non annidate (dentro @media trova le regole interne, non il guscio).
function eachRule(text, cb) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const selector = m[1].trim();
    if (!selector || selector.startsWith('@')) continue;
    cb(selector, m[2]);
  }
}

function rootVars(file) {
  const vars = {};
  eachRule(stripComments(css[file]), (selector, body) => {
    if (selector !== ':root') return;
    const re = /(--[\w-]+)\s*:\s*([^;{}]+)/g;
    let m;
    while ((m = re.exec(body)) !== null) vars[m[1]] = m[2].trim();
  });
  return vars;
}

test('token --fs-* e --space-* definiti e identici in app e console', () => {
  for (const file of FILES) {
    const vars = rootVars(file);
    for (const [name, expected] of Object.entries({ ...FS_TOKENS, ...SPACE_TOKENS })) {
      assert.ok(name in vars, `${file}: token ${name} mancante in :root`);
      const want = Array.isArray(expected) ? expected : [expected];
      assert.ok(want.includes(vars[name]),
        `${file}: ${name} = ${vars[name]}, atteso ${want.join(' o ')}`);
    }
  }
});

test('nessun font-size fuori scala (solo var(--fs-*) o em relativi)', () => {
  for (const file of FILES) {
    const bad = [];
    eachRule(stripComments(css[file]), (selector, body) => {
      if (selector === ':root') return;
      const re = /font-size\s*:\s*([^;{}]+)/g;
      let m;
      while ((m = re.exec(body)) !== null) {
        const raw = m[1].trim();
        const core = raw.replace(/!important/g, '').trim();
        if (/^var\(--fs-[\w-]+\)$/.test(core)) continue;
        if (/^\d*\.?\d+em$/.test(core)) continue; // relativo, scala col genitore
        bad.push(`${selector} :: font-size: ${raw}`);
      }
    });
    assert.deepEqual(bad, [], `${file}: font-size fuori scala:\n${bad.join('\n')}`);
  }
});

test('nessuno spacing fuori scala 8pt (anche dentro clamp/calc/max)', () => {
  const decl = /((?:scroll-)?(?:margin|padding)(?:-[a-z-]+)?|(?:row-|column-)?gap)\s*:\s*([^;{}]+)/g;
  for (const file of FILES) {
    const bad = [];
    eachRule(stripComments(css[file]), (selector, body) => {
      if (selector === ':root') return;
      let m;
      decl.lastIndex = 0;
      while ((m = decl.exec(body)) !== null) {
        let value = m[2];
        value = value.replace(/var\(--[\w-]+\)/g, '');
        value = value.replace(/env\([^)]*\)/g, '');
        const nums = value.match(/-?\d*\.?\d+(px|r?em|%|vw|vh|vmin|vmax|dvh|svh)/g) || [];
        for (const num of nums) {
          const unit = num.replace(/^-?[\d.]+/, '');
          const n = Math.abs(parseFloat(num));
          if (['%', 'vw', 'vh', 'vmin', 'vmax', 'dvh', 'svh'].includes(unit)) continue;
          if (unit === 'px' && PX_OK.has(n)) continue;
          if (unit === 'rem' && REM_OK.has(n)) continue;
          bad.push(`${selector} :: ${m[1]}: ${m[2].trim()} (fuori scala: ${num})`);
        }
      }
    });
    assert.deepEqual(bad, [], `${file}: spacing fuori scala:\n${bad.join('\n')}`);
  }
});

test('mappature critiche: toast, badge, label, tab, pulsanti, input, titoli', () => {
  const app = stripComments(css['css/style.css']);
  const admin = stripComments(css['css/admin.css']);
  const ruleHas = (text, selectorRe, decl) => {
    const found = [];
    eachRule(text, (selector, body) => {
      if (selectorRe.test(selector)) found.push(body);
    });
    assert.ok(found.length > 0, `selettore ${selectorRe} non trovato`);
    const norm = (s) => s.replace(/\s+/g, '');
    assert.ok(found.some((b) => norm(b).includes(norm(decl))),
      `${selectorRe} deve dichiarare "${decl}"`);
  };
  ruleHas(app, /\.app-toast$/, 'font-size: var(--fs-toast)');
  ruleHas(app, /\.notification-badge$/, 'font-size: var(--fs-badge)');
  ruleHas(app, /\.nav-label$/, 'font-size: var(--fs-bottom-nav)');
  ruleHas(app, /\.eyebrow$/, 'font-size: var(--fs-label)');
  ruleHas(app, /\.tab-btn$/, 'font-size: var(--fs-tab)');
  ruleHas(app, /^\.btn$/, 'font-size: var(--fs-button)');
  ruleHas(app, /^input, select, textarea$/, 'font-size: var(--fs-input)');
  ruleHas(app, /\.recipe-toolbar \.btn$/, 'font-size: var(--fs-tab)');
  ruleHas(app, /\.prices-tab$/, 'font-size: var(--fs-tab)');
  ruleHas(app, /^body$/, 'font-size: var(--fs-body)');
  ruleHas(app, /^h1$/, 'font-size: var(--fs-h1)');
  ruleHas(app, /^h2$/, 'font-size: var(--fs-h2)');
  ruleHas(app, /^h3$/, 'font-size: var(--fs-h3)');
  ruleHas(admin, /\.filter-tab$/, 'font-size: var(--fs-tab)');
  ruleHas(admin, /\.status$/, 'font-size: var(--fs-badge)');
  ruleHas(admin, /\.eyebrow$/, 'font-size: var(--fs-label)');
  ruleHas(admin, /^\.primary,\s*\.secondary$/, 'font-size: var(--fs-button)');
  ruleHas(admin, /^input,select,textarea$/, 'font-size: var(--fs-input)');
  ruleHas(admin, /^\.nav-link$/, 'font-size: var(--fs-nav)');
  // Tetto hero su desktop: resta una variabile, non un valore a mano.
  assert.ok(app.includes('--fs-hero-max'), 'app: --fs-hero-max inutilizzato');
  assert.match(app, /@media\s*\(min-width:\s*1024px\)[\s\S]*?var\(--fs-hero-max\)/);
});
