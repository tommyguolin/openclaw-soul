// Debug regex matching for Windows paths
const p = 'C:\\Users\\guolin\\AppData\\Local\\Temp\\openclaw\\openclaw-2026-07-18.log';
console.log('path:', p);
console.log('chars:', JSON.stringify(p.slice(0, 30)));

// The regex from the code: [A-Za-z]:\\[\w./-\\]+
// In a RegExp string, \\ matches a literal backslash
// But [\w./-\\] should match word chars, dots, slashes, dashes, backslashes
const pattern = new RegExp(`(?:(?:[A-Za-z]:)?/[^\\s:]+|[A-Za-z]:\\\\[\\w./-\\\\]+)\\.log\\b`, "gi");
console.log('pattern:', pattern);
console.log('match:', p.match(pattern));

// Try simpler pattern
const p2 = new RegExp(`[A-Za-z]:\\\\[\\w./-\\\\]+\\.log\\b`, "gi");
console.log('simple pattern:', p2);
console.log('simple match:', p.match(p2));

// Even simpler - just match C:\...\log
const p3 = new RegExp(`[A-Za-z]:\\\\[\\w.\\\\-]+`, "gi");
console.log('p3:', p3);
console.log('p3 match:', p.match(p3));

// The issue: \w doesn't include backslash. We need \\ inside char class
// Let's check what [\w./-\\] actually matches
const test = 'C:\\Users\\guolin';
const p4 = new RegExp(`[A-Za-z]:\\\\[\\w.\\\\/-]+`, "gi");
console.log('p4 match on', test, ':', test.match(p4));

// Full path
const p5 = new RegExp(`[A-Za-z]:\\\\[\\w.\\\\/-]+\\.log\\b`, "gi");
console.log('p5 match:', p.match(p5));
