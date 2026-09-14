const fs = require('fs');
const path = require('path');
const snippetPath = path.join(__dirname, '..', 'docs', 'generated-meller-snippet.js');
const snippet = fs.readFileSync(snippetPath, 'utf8');
const domainPath = path.join(__dirname, '..', 'js', 'domain.js');
let domain = fs.readFileSync(domainPath, 'utf8');

function extractFromSnippet(name) {
  // find start
  const startMarker = `  const ${name} = `;
  const startIdx = snippet.indexOf(startMarker);
  if (startIdx === -1) throw new Error('not found in snippet ' + name);
  // Determine if array or object
  const after = snippet.slice(startIdx);
  // Find end: look for "];\n" or "};\n" but need to capture full const
  // For arrays: ends with "\n  ];\n"
  // For single line object: ends with ";\n"
  let endIdx;
  if (after.startsWith(`  const ${name} = [`)) {
    // find "\n  ];" after start
    const close = "\n  ];";
    endIdx = snippet.indexOf(close, startIdx);
    if (endIdx === -1) throw new Error('close not found for ' + name);
    endIdx += close.length; // include ];
    // include following semicolon already
    // Actually close includes ]; but need to include up to semicolon (already)
    return snippet.slice(startIdx, endIdx + 1).replace(/\n$/, '') + '\n'; // ensure newline
  } else {
    // single line object ending with ";
    const semi = snippet.indexOf(";", startIdx);
    if (semi === -1) throw new Error('semicolon not found ' + name);
    return snippet.slice(startIdx, semi + 1) + "\n";
  }
}

function replaceInDomain(name, newBlock) {
  const startMarker = `  const ${name} = `;
  let startIdx = domain.indexOf(startMarker);
  if (startIdx === -1) throw new Error('not found in domain ' + name);
  let endIdx;
  if (domain.slice(startIdx, startIdx + startMarker.length + 1).includes('[')) {
    // array: find "\n  ];" after start
    const close = "\n  ];";
    endIdx = domain.indexOf(close, startIdx);
    if (endIdx === -1) throw new Error('close not found in domain ' + name);
    endIdx += close.length;
    // include semicolon
    // domain has "  ];" exactly
    const before = domain.slice(0, startIdx);
    const after = domain.slice(endIdx + 1); // +1 for semicolon? Actually close is "\n  ];" includes semicolon? close = "\n  ];" includes semicolon. So endIdx points to last char of close? We added length, so endIdx is after ";"
    // Let's adjust: we searched for "\n  ];" which includes semicolon, so endIdx is start of close + length, which is after semicolon.
    // So slice from startIdx to endIdx
    domain = before + newBlock.trimEnd() + after.slice(0); // after already after semicolon
    // Actually we need to handle correctly: before + newBlock + rest
    // Our before is up to startIdx, after is from endIdx
    // We already sliced before, need to reconstruct
    // Re-do more simply:
  } else {
    const semi = domain.indexOf(";", startIdx);
    if (semi === -1) throw new Error('semicolon not found in domain ' + name);
    const before = domain.slice(0, startIdx);
    const after = domain.slice(semi + 1);
    domain = before + newBlock.trimEnd() + after;
    return;
  }
  // For array case, we need to re-slice properly
  // Re-implement array replacement cleanly
}

// Better: reimplement replace function with manual slicing
function replaceConstSafe(name, newBlock) {
  const startMarker = `  const ${name} = `;
  const startIdx = domain.indexOf(startMarker);
  if (startIdx === -1) throw new Error('not found domain ' + name);
  const afterStart = domain.slice(startIdx);
  let endIdx;
  if (afterStart.startsWith(`  const ${name} = [`)) {
    const closeStr = "\n  ];";
    const closePos = domain.indexOf(closeStr, startIdx);
    if (closePos === -1) throw new Error('close array not found ' + name);
    endIdx = closePos + closeStr.length;
  } else {
    // object or single line
    // find next ";\n" after start
    const semiPos = domain.indexOf(";", startIdx);
    if (semiPos === -1) throw new Error('semi not found ' + name);
    endIdx = semiPos + 1;
  }
  const before = domain.slice(0, startIdx);
  const after = domain.slice(endIdx);
  domain = before + newBlock.trimEnd() + "\n" + after;
}

const names = [
  'MELLER_GRAMMATURE',
  'MELLER_FREE_INGREDIENT_PATTERNS',
  'MELLER_PROTEIN_FREQUENCIES',
  'CARB_FAMILIES',
  'MELLER_CARB_ALTERNATIVES',
  'MELLER_PROTEIN_ALTERNATIVES',
  'MELLER_PROTEIN_REFERENCE'
];

for (const name of names) {
  const newBlock = extractFromSnippet(name);
  replaceConstSafe(name, newBlock);
  console.log(`Replaced ${name}`);
}

// Also replace MELLER_GROUP
const groupSnippet = `  const MELLER_GROUP = {\n    CARB: 'carb',\n    PROTEIN: 'protein',\n    VEGETABLE: 'vegetable',\n    FAT: 'fat',\n    FRUIT: 'fruit',\n    DAIRY: 'dairy',\n    SWEET: 'sweet',\n    FREE: 'free'\n  };`;
const groupStart = domain.indexOf('  const MELLER_GROUP = {');
if (groupStart !== -1) {
  const groupEnd = domain.indexOf('\n  };', groupStart);
  if (groupEnd !== -1) {
    const before = domain.slice(0, groupStart);
    const after = domain.slice(groupEnd + '\n  };'.length);
    domain = before + groupSnippet + after;
    console.log('Replaced MELLER_GROUP');
  }
}

fs.writeFileSync(domainPath, domain, 'utf8');
console.log('Done');
