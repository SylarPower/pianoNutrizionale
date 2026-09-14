const fs = require('fs');
const path = require('path');
const snippetPath = path.join(__dirname, '..', 'docs', 'generated-meller-snippet.js');
const snippet = fs.readFileSync(snippetPath, 'utf8');
const domainPath = path.join(__dirname, '..', 'js', 'domain.js');
let domain = fs.readFileSync(domainPath, 'utf8');

// Helper to extract const block from snippet
function extractConst(snippet, name) {
  // Try multi-line array/object ending with newline + 2 spaces + ];
  let regex = new RegExp(`  const ${name} = \\[[\\s\\S]*?\\n  \\];`);
  let m = snippet.match(regex);
  if (m) return m[0];
  // Single line object or array
  regex = new RegExp(`  const ${name} = .*?;`);
  m = snippet.match(regex);
  if (m) return m[0];
  // Multi-line object
  regex = new RegExp(`  const ${name} = \\{[\\s\\S]*?\\n  \\};`);
  m = snippet.match(regex);
  if (m) return m[0];
  throw new Error('not found ' + name);
}

function replaceConst(domain, name, newBlock) {
  // Try array first
  let regex = new RegExp(`  const ${name} = \\[[\\s\\S]*?\\n  \\];`);
  if (regex.test(domain)) return domain.replace(regex, newBlock);
  regex = new RegExp(`  const ${name} = \\{[\\s\\S]*?\\n  \\};`);
  if (regex.test(domain)) return domain.replace(regex, newBlock);
  regex = new RegExp(`  const ${name} = .*?;`);
  if (regex.test(domain)) return domain.replace(regex, newBlock);
  throw new Error('const not found in domain: ' + name);
}

const blocks = [
  'MELLER_GRAMMATURE',
  'MELLER_FREE_INGREDIENT_PATTERNS',
  'MELLER_PROTEIN_FREQUENCIES',
  'CARB_FAMILIES',
  'MELLER_CARB_ALTERNATIVES',
  'MELLER_PROTEIN_ALTERNATIVES',
  'MELLER_PROTEIN_REFERENCE'
];

for (const name of blocks) {
  const newBlock = extractConst(snippet, name);
  domain = replaceConst(domain, name, newBlock);
  console.log(`Replaced ${name}`);
}

fs.writeFileSync(domainPath, domain, 'utf8');
console.log('Done patching domain.js');
