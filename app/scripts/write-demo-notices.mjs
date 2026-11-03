import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "..");
const output = resolve(repoRoot, "demo", "valuelens", "THIRD_PARTY_NOTICES.md");
const licenses = [
  ["ValueLens", resolve(repoRoot, "LICENSE")],
  ["React", resolve(appRoot, "node_modules", "react", "LICENSE")],
  ["React DOM", resolve(appRoot, "node_modules", "react-dom", "LICENSE")],
  ["Scheduler", resolve(appRoot, "node_modules", "scheduler", "LICENSE")],
  ["PapaParse", resolve(appRoot, "node_modules", "papaparse", "LICENSE")],
  ["Vite module-preload runtime", resolve(appRoot, "node_modules", "vite", "LICENSE.md")],
];

const sections = licenses.map(([name, path]) => {
  const text = readFileSync(path, "utf8").trim().replace(/[ \t]+$/gm, "");
  return `## ${name}\n\n${text}`;
});

writeFileSync(
  output,
  `# Third-party notices\n\nThe standalone ValueLens demo bundle includes the following MIT-licensed code.\n\n${sections.join("\n\n")}\n`,
  { encoding: "utf8" },
);
console.log(`Wrote ${output}`);
