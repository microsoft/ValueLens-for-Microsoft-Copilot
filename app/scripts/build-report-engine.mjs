import { build } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
await build({
  configFile: false,
  plugins: [{
    name: "report-offline-only",
    resolveId(id) { return id === "virtual:embedded-sample" ? "\0report-no-sample-loader" : null; },
    load(id) { return id === "\0report-no-sample-loader" ? "export default null;" : null; },
  }],
  build: {
    outDir: resolve(root, "demo", "valuelens-report"),
    emptyOutDir: false,
    lib: {
      entry: resolve(root, "demos", "valuelens-report", "engine.ts"),
      name: "ValueLensReportEngine",
      formats: ["iife"],
      fileName: () => "engine.js",
    },
  },
});
