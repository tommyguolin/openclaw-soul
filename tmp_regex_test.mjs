// Test the extractFilePaths regex from intelligent-thought.ts
const READABLE_EXTENSIONS = [".log", ".ts", ".js", ".py", ".json", ".yaml", ".yml", ".md"];

function extractFilePathsOld(text) {
  const results = [];
  for (const ext of READABLE_EXTENSIONS) {
    const pattern = new RegExp(`(?:/[^\\s:]+|[\\w./-]+)\\${ext}\\b`, "gi");
    const matches = text.match(pattern);
    if (matches) {
      for (const m of matches) {
        if (!results.includes(m)) results.push(m);
      }
    }
  }
  return results.slice(0, 5);
}

function extractFilePathsNew(text) {
  const results = [];
  for (const ext of READABLE_EXTENSIONS) {
    // Require at least one path separator to avoid extracting bare filenames
    const pattern = new RegExp(`(?:(?:[A-Za-z]:)?/[^\\s:]+|[A-Za-z]:\\\\[\\w./-\\\\]+)\\${ext}\\b`, "gi");
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
  // Should NOT match (bare filenames from log text)
  "ego.json was not found",
  "read ego.json and activation-state.json",
  // Should match (Unix paths)
  "/home/user/ego.json was read",
  "/var/log/openclaw/openclaw-2026-07-18.log has errors",
  // Should match (Windows paths)
  'C:\\Users\\guolin\\.openclaw\\soul\\ego.json was read',
  'C:\\Users\\guolin\\AppData\\Local\\Temp\\openclaw\\openclaw-2026-07-18.log',
  // Should match (relative paths with separators)
  "src/autonomous-actions.ts has a bug",
  "K:\\test_code\\openclaw-soul\\src\\autonomous-actions.ts",
];

console.log("=== OLD regex (before fix) ===");
for (const t of tests) {
  const r = extractFilePathsOld(t);
  console.log(`Input: ${t}`);
  console.log(`  Matches: ${JSON.stringify(r)}`);
}

console.log("\n=== NEW regex (after fix) ===");
for (const t of tests) {
  const r = extractFilePathsNew(t);
  console.log(`Input: ${t}`);
  console.log(`  Matches: ${JSON.stringify(r)}`);
}
