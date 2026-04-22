// Build APP_HTML from renderer files and inject into index.ts
const fs = require("fs");
const path = require("path");

const base = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(base, "app/renderer/index.html"), "utf-8");
const js = fs.readFileSync(path.join(base, "app/renderer/app.js"), "utf-8");

// Combine: inject JS into HTML before </body>
const combined = html.replace("</body>", `<script>\n${js}\n</script>\n</body>`)
  // Remove the local app.js script tag since we're inlining
  .replace('<script src="app.js"></script>', '');

// Escape backticks and ${} for template literal
const escaped = combined.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

// Read index.ts
const tsPath = path.join(base, "server/src/index.ts");
const ts = fs.readFileSync(tsPath, "utf-8");

// Find and replace APP_HTML
const startMarker = "const APP_HTML = `";
const startIdx = ts.indexOf(startMarker);
if (startIdx === -1) { console.error("APP_HTML not found"); process.exit(1); }

// Find the closing backtick+semicolon
let depth = 0;
let endIdx = startIdx + startMarker.length;
while (endIdx < ts.length) {
  if (ts[endIdx] === '`' && ts[endIdx - 1] !== '\\') break;
  endIdx++;
}
endIdx++; // include the backtick

const newTs = ts.substring(0, startIdx) + `const APP_HTML = \`${escaped}\`` + ts.substring(endIdx);
fs.writeFileSync(tsPath, newTs);
console.log(`Updated APP_HTML: ${combined.length} chars`);
