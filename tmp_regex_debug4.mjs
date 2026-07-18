// Test relative path matching: "src/autonomous-actions.ts" should match
const pattern = new RegExp(`(?:(?:[A-Za-z]:)?/[^\\s:]+|[A-Za-z]:\\\\[\\w./\\\\-]+)\\.ts\\b`, "gi");
const text = "src/autonomous-actions.ts has a bug";
console.log("match:", text.match(pattern));
// It matches "/autonomous-actions.ts" instead of "src/autonomous-actions.ts"
// because the regex requires a / before the filename
// The old regex [\\w./-]+ matched "src/autonomous-actions.ts" fully

// This is a regression for relative paths without a leading /
// Fix: also allow relative paths with at least one /
const pattern2 = new RegExp(`(?:[\\w./-]+/[\\w./-]+|[A-Za-z]:\\\\[\\w./\\\\-]+)\\.ts\\b`, "gi");
console.log("pattern2 match:", text.match(pattern2));

// Or simpler: require at least one / or \\ in the path
const pattern3 = new RegExp(`(?:(?:[A-Za-z]:)?(?:[\\w.]+/)+[\\w./-]+|[A-Za-z]:\\\\[\\w./\\\\-]+)\\.ts\\b`, "gi");
console.log("pattern3 match:", text.match(pattern3));

// Cleanest approach: match paths that contain at least one separator
const pattern4 = new RegExp(`(?:[\\w./-]*[/\\\\][\\w./\\\\-]+)\\.ts\\b`, "gi");
console.log("pattern4 match:", text.match(pattern4));

// Test all cases
const tests = [
  "ego.json was not found",
  "src/autonomous-actions.ts has a bug",
  "/var/log/openclaw/openclaw-2026-07-18.log has errors",
  'C:\\Users\\guolin\\.openclaw\\soul\\ego.json was read',
  'C:\\Users\\guolin\\AppData\\Local\\Temp\\openclaw\\openclaw-2026-07-18.log',
  "K:\\test_code\\openclaw-soul\\src\\autonomous-actions.ts",
];

console.log("\n=== Pattern4 (at least one separator) ===");
for (const t of tests) {
  const ext = ".ts";
  const p = new RegExp(`(?:[\\w./-]*[/\\\\][\\w./\\\\-]+)\\${ext}\\b`, "gi");
  console.log(`Input: ${t}`);
  console.log(`  Matches: ${JSON.stringify(t.match(p))}`);
}
