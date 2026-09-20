import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const roots = ["apps","packages","scripts","tests","db","docs",".github"];
const rootFiles = ["package.json","package-lock.json","tsconfig.json","README.md","SECURITY.md",".env.example",".gitignore",".nvmrc"];
const findings = [];
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["OpenAI-style secret", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/]
];
function walk(path) {
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const stat = statSync(child);
    if (stat.isDirectory()) walk(child);
    else {
      const text = readFileSync(child, "utf8");
      for (const [label, pattern] of patterns) {
        if (pattern.test(text)) findings.push(`${relative(process.cwd(), child)}: possible ${label}`);
      }
    }
  }
}
for (const root of roots) walk(root);
for (const file of rootFiles) {
  const text = readFileSync(file, "utf8");
  for (const [label, pattern] of patterns) { if (pattern.test(text)) findings.push(`${file}: possible ${label}`); }
}
if (findings.length) throw new Error(findings.join("\n"));
process.stdout.write("No high-confidence committed secret patterns detected.\n");
