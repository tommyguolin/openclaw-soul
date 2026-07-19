const fs = require('fs');
const content = fs.readFileSync('src/autonomous-actions.ts', 'utf-8');

// Find all "Editing tips" blocks and escape backticks within them
let result = content;
let idx = 0;
const replacements = [];

while (true) {
  const tipsIdx = result.indexOf('**Editing tips**:', idx);
  if (tipsIdx === -1) break;
  
  const writeIdx = result.indexOf('Write your final report', tipsIdx);
  if (writeIdx === -1) break;
  
  const block = result.substring(tipsIdx, writeIdx);
  // Replace backticks with escaped backticks in this block
  const escapedBlock = block.replace(/`/g, '\\`');
  if (escapedBlock !== block) {
    replacements.push({ start: tipsIdx, end: writeIdx, old: block, new: escapedBlock });
  }
  idx = writeIdx;
}

// Apply replacements from end to start to preserve indices
for (const r of replacements.reverse()) {
  result = result.substring(0, r.start) + r.new + result.substring(r.end);
}

console.log('Made', replacements.length, 'replacements');
fs.writeFileSync('src/autonomous-actions.ts', result, 'utf-8');
console.log('File written');
