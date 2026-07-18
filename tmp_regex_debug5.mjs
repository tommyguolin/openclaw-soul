// Final fix: combine Unix and Windows path patterns properly
// Requirements:
// 1. Must have at least one path separator (/ or \\)
// 2. Must NOT match bare filenames like "ego.json"
// 3. Must match: src/autonomous-actions.ts, /var/log/x.log, C:\Users\...\ego.json, K:\test_code\...\autonomous-actions.ts

function extractFilePathsFixed(text) {
  const READABLE_EXTENSIONS = [".log", ".ts", ".js", ".py", ".json", ".yaml", ".yml", ".md"];
  const results = [];
  for (const ext of READABLE_EXTENSIONS) {
    // Match paths containing at least one separator (/ or \)
    // Two alternatives:
    //   1. Unix/relative: contains at least one / → [\w./-]+/[\w./-]+ (and then more path segments)
    //   2. Windows: [A-Za-z]:\\[\w./\\-]+ 
    const pattern = new RegExp(`(?:[\\w.]+(?:/[\\w.]+)+|[A-Za-z]:\\\\[\\w.\\\\/-]+)\\${ext}\\b`, "gi");
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
  // Should NOT match
  "ego.json was not found",
  "read ego.json and activation-state.json",
  // Should match - relative Unix
  "src/autonomous-actions.ts has a bug",
  // Should match - absolute Unix
  "/var/log/openclaw/openclaw-2026-07-18.log has errors",
  "/home/user/ego.json was read",
  // Should match - Windows
  'C:\\Users\\guolin\\.openclaw\\soul\\ego.json was read',
  'C:\\Users\\guolin\\AppData\\Local\\Temp\\openclaw\\openclaw-2026-07-18.log',
  "K:\\test_code\\openclaw-soul\\src\\autonomous-actions.ts",
];

for (const t of tests) {
  console.log(`Input: ${t}`);
  console.log(`  Matches: ${JSON.stringify(extractFilePathsFixed(t))}`);
}
