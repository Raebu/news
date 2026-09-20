import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const roots = ["apps","packages","scripts","tests","db","docs",".github"];
const rootFiles = ["package.json","package-lock.json","tsconfig.json","README.md","SECURITY.md",".env.example",".gitignore",".nvmrc"];
const extensions = new Set([".ts",".mjs",".json",".md",".sql",".yml",".yaml"]);
const failures = [];

function walk(path) {
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const stat = statSync(child);
    if (stat.isDirectory()) walk(child);
    else {
      const dot = name.lastIndexOf(".");
      const ext = dot >= 0 ? name.slice(dot) : "";
      if (!extensions.has(ext)) continue;
      const text = readFileSync(child, "utf8");
      const rel = relative(process.cwd(), child);
      if (text.includes("\r\n")) failures.push(`${rel}: CRLF line endings are not allowed`);
      text.split("\n").forEach((line, index) => {
        if (/\s+$/.test(line)) failures.push(`${rel}:${index + 1}: trailing whitespace`);
      });
    }
  }
}
for (const root of roots) walk(root);
for (const file of rootFiles) {
  const text = readFileSync(file, "utf8");
  if (text.includes("\r\n")) failures.push(`${file}: CRLF line endings are not allowed`);
  text.split("\n").forEach((line, index) => { if (/\s+$/.test(line)) failures.push(`${file}:${index + 1}: trailing whitespace`); });
}
if (failures.length) throw new Error(failures.join("\n"));
process.stdout.write("Repository hygiene checks passed.\n");
