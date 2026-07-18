// Confirm: the hyphen 0x2D is NOT in the range / (0x2F) to \\ (0x5C)
console.log('- code:', '-'.charCodeAt(0));   // 0x2D = 45
console.log('/ code:', '/'.charCodeAt(0));   // 0x2F = 47  
console.log('. code:', '.'.charCodeAt(0));   // 0x2E = 46
console.log('\\\\ code:', '\\'.charCodeAt(0)); // 0x5C = 92

// So /-\\ range is 47-92, which MISSES hyphen (45) and dot (46)
// Dot is listed separately in the char class, but hyphen is not

// The fix: move - to the end of the char class where it's treated as literal
// [\w./\\-] instead of [\w./-\\]
const path = 'C:\\Users\\guolin\\AppData\\Local\\Temp\\openclaw\\openclaw-2026-07-18.log';

const fixedPattern = new RegExp(`[A-Za-z]:\\\\[\\w./\\\\-]+\\.log\\b`, "gi");
console.log('fixed:', path.match(fixedPattern));

// Also test with the full pattern
const fullFixed = new RegExp(`(?:(?:[A-Za-z]:)?/[^\\s:]+|[A-Za-z]:\\\\[\\w./\\\\-]+)\\.log\\b`, "gi");
console.log('full fixed:', path.match(fullFixed));

// Test all cases with fixed pattern
function extractFilePathsFixed(text) {
  const READABLE_EXTENSIONS = [".log", ".ts", ".js", ".py", ".json", ".yaml", ".yml", ".md"];
  const results = [];
  for (const ext of READABLE_EXTENSIONS) {
    const pattern = new RegExp(`(?:(?:[A-Za-z]:)?/[^\\s:]+|[A-Za-z]:\\\\[\\w./\\\\-]+)\\${ext}\\b`, "gi");
    const matches = text.match(pattern);
    if (matches) {
      for (const m of matches) {
        if (!results.includes(m)) results.push(m);
      }
    }
  }
  return results.slice(0, 5);
}

const tests = [
  "ego.json was not found",
  'C:\\Users\\guolin\\.openclaw\\soul\\ego.json was read',
  'C:\\Users\\guolin\\AppData\\Local\\Temp\\openclaw\\openclaw-2026-07-18.log',
  "src/autonomous-actions.ts has a bug",
  "K:\\test_code\\openclaw-soul\\src\\autonomous-actions.ts",
  "/var/log/openclaw/openclaw-2026-07-18.log has errors",
];

for (const t of tests) {
  console.log(`Input: ${t}`);
  console.log(`  Matches: ${JSON.stringify(extractFilePathsFixed(t))}`);
}
