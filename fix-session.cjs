const fs = require('fs');
let content = fs.readFileSync('src/autonomous-actions.ts', 'utf-8');

// Remove the isSubagentSessionRecentlyActive block that was added in uncommitted changes
const oldBlock = `      // Final fallback: stale timeout — but first check if the subagent
      // session is still actively running (written to within last 5 min).
      // If it is, extend the updatedAt to delay the stale classification
      // and let the subagent finish its work.
      if (Date.now() - task.updatedAt > STALE_MS) {
        const sessionActive = isSubagentSessionRecentlyActive(task);
        if (sessionActive) {
          task.updatedAt = Date.now();
          continue; // give it more time
        }
        const detail = task.result ?? `;

const newBlock = `      // Final fallback: stale timeout.
      if (Date.now() - task.updatedAt > STALE_MS) {
        const detail = task.result ?? `;

if (content.includes(oldBlock)) {
  content = content.replace(oldBlock, newBlock);
  fs.writeFileSync('src/autonomous-actions.ts', content, 'utf-8');
  console.log('Removed isSubagentSessionRecentlyActive block');
} else {
  console.log('Block not found - trying CRLF');
  const oldBlockCRLF = oldBlock.replace(/\n/g, '\r\n');
  const newBlockCRLF = newBlock.replace(/\n/g, '\r\n');
  if (content.includes(oldBlockCRLF)) {
    content = content.replace(oldBlockCRLF, newBlockCRLF);
    fs.writeFileSync('src/autonomous-actions.ts', content, 'utf-8');
    console.log('Removed (CRLF)');
  } else {
    console.log('Block not found with either line ending');
    // Try to find the marker
    const idx = content.indexOf('isSubagentSessionRecentlyActive');
    if (idx !== -1) {
      console.log('Found marker at', idx);
      console.log('Context:', content.substring(idx - 100, idx + 100));
    }
  }
}
