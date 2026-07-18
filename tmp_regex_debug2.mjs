// Find the exact issue in the regex character class
// The pattern from code: [A-Za-z]:\\[\w./-\\]
// Let's test each variant of the char class

const path = 'C:\\Users\\guolin\\AppData\\Local\\Temp\\openclaw\\openclaw-2026-07-18.log';

// Pattern as written in code (\\ inside char class at end)
const p1 = new RegExp(`[A-Za-z]:\\\\[\\w./-\\\\]+\\.log\\b`, "gi");
console.log('p1 (code pattern):', path.match(p1));

// The issue: in the char class [\w./-\\], the \\ at the end is an escaped backslash
// BUT the - before \\ creates a range from / to \\ if not positioned correctly
// Actually in char classes, - is literal if at start/end or after a range
// Let's check: [\w./-\\] - here - is between / and \\ which are both single chars
// / is 0x2F and \\ is 0x5C, so /-\\ is a valid range from 0x2F to 0x5C
// That range includes: / 0 1 2 3 4 5 6 7 8 9 : ; < = > ? @ A B C D E F G H I J K L M N O P Q R S T U V W X Y Z [ \\ ] ^ _ 
// Wait, but \w includes a-z, A-Z, 0-9, _ — so the range /-\\ would actually be fine
// It includes /, 0-9, :;<=>?@A-Z[,\\,],^,_ which is a lot of chars but includes \\

// Actually wait. The problem might be the . inside the char class
// [\w./-\\] = \w, ., /, range(- to \\)? No, - between two chars makes a range
// /-\\ means chars from / (0x2F) to \\ (0x5C) which is a valid range

// Let me try without the range issue
const p2 = new RegExp(`[A-Za-z]:\\\\[\\w./\\\\-]+\\.log\\b`, "gi");
console.log('p2 (dash at end):', path.match(p2));

// Or with escaped dash
const p3 = new RegExp(`[A-Za-z]:\\\\[\\w.\\\\/-]+`, "gi");
console.log('p3 (no dash range):', path.match(p3));

// The actual issue: let me test the EXACT pattern from the code
// Code: `(?:(?:[A-Za-z]:)?/[^\\s:]+|[A-Za-z]:\\\\[\\w./-\\\\]+)\\${ext}\\b`
// For ext=.log: (?:(?:[A-Za-z]:)?/[^\s:]+|[A-Za-z]:\\[\w./-\\]+)\.log\b

// Let's debug step by step
const step1 = new RegExp(`[A-Za-z]:\\\\`, "gi"); // Match drive + backslash
console.log('step1:', path.match(step1));

const step2 = new RegExp(`[A-Za-z]:\\\\[\\w]+`, "gi"); // Match drive + backslash + word chars
console.log('step2:', path.match(step2));

const step3 = new RegExp(`[A-Za-z]:\\\\[\\w./-\\\\]+`, "gi"); // Add ., /, -, \\
console.log('step3:', path.match(step3));

const step4 = new RegExp(`[A-Za-z]:\\\\[\\w./-\\\\]+\\.log`, "gi"); // Add .log
console.log('step4:', path.match(step4));

const step5 = new RegExp(`[A-Za-z]:\\\\[\\w./-\\\\]+\\.log\\b`, "gi"); // Add \b
console.log('step5:', path.match(step5));
