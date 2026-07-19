const fs = require('fs');
let c = fs.readFileSync('K:/test_code/openclaw-soul/src/autonomous-actions.ts', 'utf8');

// Replace hasRequiredReportSections to be language-agnostic
// Instead of checking for specific English section names, check for any markdown ## headers
const oldStart = 'function hasRequiredReportSections(result: string): boolean {\n  const text = result.replace(/<think[\\s\\S]*?<\\/think>/gi, "").trim();\n  const requiredSections = ["outcome", "changes", "verification", "metrics", "next"];\n  return requiredSections.every((section) =>\n    new RegExp(`^##\\\\s+${section}\\\\b`, "im").test(text),\n  );\n}';

const newFunc = `function hasRequiredReportSections(result: string): boolean {
  const text = result.replace(/<think[\\s\\S]*?<\\/think>/gi, "").trim();
  // Language-agnostic: check for any markdown ## section headers.
  // The model writes sections in the user's language - we only need 3+ distinct sections.
  const sectionHeaders = text.match(/^##\\s+\\w+/gm);
  if (!sectionHeaders || sectionHeaders.length < 3) return false;
  const unique = new Set(sectionHeaders.map(h => h.toLowerCase()));
  return unique.size >= 3;
}`;

if (c.includes(oldStart)) {
  c = c.replace(oldStart, newFunc);
  fs.writeFileSync('K:/test_code/openclaw-soul/src/autonomous-actions.ts', c);
  console.log('Replaced hasRequiredReportSections');
} else {
  console.log('Exact match not found, trying index search...');
  const idx = c.indexOf('function hasRequiredReportSections');
  if (idx >= 0) {
    // Find the function end
    const endIdx = c.indexOf('\n}', idx) + 2;
    const oldFunc = c.slice(idx, endIdx);
    console.log('Found function, length:', oldFunc.length);
    console.log('Replacing...');
    c = c.slice(0, idx) + newFunc + c.slice(endIdx);
    fs.writeFileSync('K:/test_code/openclaw-soul/src/autonomous-actions.ts', c);
    console.log('Done');
  }
}