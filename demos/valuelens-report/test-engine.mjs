import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const context = { console };
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(resolve(root, "demo", "valuelens-report", "engine.js"), "utf8"), context);
vm.runInContext(fs.readFileSync(resolve(root, "demo", "valuelens-report", "report-data.js"), "utf8"), context);
const payload = context.VALUE_LENS_REPORT_DEMO;
const reference = JSON.parse(fs.readFileSync(0, "utf8"));
let assertions = 0, visualEvaluations = 0;
const close = (actual, expected, label) => {
  if (typeof expected === "number") assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-8 * Math.max(1, Math.abs(expected)), `${label}: expected ${expected}, got ${actual}`);
  else assert.equal(actual, expected, label);
  assertions++;
};
const baseState = { from: 12, to: 14, team: -1, license: -1, tool: -1, agent: -1, dimensions: {}, scenario: "Typical", hourly: 50 };
const measures = [...new Set(payload.report.pages.flatMap(p => p.visuals.flatMap(v => [...v.fields, ...(v.predicates || [])].filter(f => f.kind === "measure").map(f => f.name))))];
const mappings = measures.map(name => ({
  name, table: payload.report.measures[name.toLowerCase()].table,
  sourceExpressionSha256: createHash("sha256").update(payload.report.measures[name.toLowerCase()].expression).digest("hex"),
  implementation: "demos/valuelens-report/engine.ts",
}));
const results = [];
for (const test of reference.cases) {
  const state = { ...baseState, ...test.state };
  const engine = context.ValueLensReportEngine.create(payload, state);
  for (const [name, expected] of Object.entries(test.metrics)) close(engine.measure(name), expected, `${test.name} / ${name}`);
  for (const chart of test.charts || []) {
    const page = payload.report.pages[chart.page];
    const dimensions = chart.dimensions || [chart.dimension];
    const visual = page.visuals.find(v => chart.id ? v.id === chart.id : dimensions.every(d => v.fields.some(f => f.name === d)) && v.fields.some(f => f.name === chart.measure) && !/slicer|table/i.test(v.type));
    assert.ok(visual, `Missing source chart ${chart.page} ${chart.dimension} × ${chart.measure}`);
    const data = engine.visualData({ ...visual, predicates: [...(page.predicates || []), ...(visual.predicates || [])] });
    const indices = dimensions.map(d => data.fields.findIndex(f => f.name === d)), mi = data.fields.findIndex(f => f.name === chart.measure);
    const actual = Object.fromEntries(data.data.map(row => [indices.map(i => String(row[i])).join(" | "), row[mi]]));
    close(Object.keys(actual).length, Object.keys(chart.values).length, `${test.name} / page ${chart.page} ${chart.measure} / chart category count`);
    for (const [category, expected] of Object.entries(chart.values)) close(actual[category], expected, `${test.name} / page ${chart.page} / ${category}`);
  }
  for (const page of payload.report.pages) {
    for (const visual of page.visuals) {
      if (!visual.fields.length || /slicer/i.test(visual.type)) continue;
      const data = engine.visualData({ ...visual, predicates: [...(page.predicates || []), ...(visual.predicates || [])] });
      assert.equal(data.fields.length, data.columns.length, `${page.name} column bindings`);
      for (const row of data.data) {
        assert.equal(row.length, data.columns.length, `${page.name} row shape`);
        assert.ok(row.every(v => typeof v !== "number" || Number.isFinite(v)), `${page.name} contains nonfinite data`);
      }
      visualEvaluations++;
    }
  }
  results.push({ name: test.name, metrics: test.metrics, charts: (test.charts || []).length });
}
const engine = context.ValueLensReportEngine.create(payload, baseState);
for (const name of measures) assert.ok(engine.supported(name), `Unimplemented source measure ${name}`);
assert.throws(() => engine.measure("Not a source measure"), /No source-backed implementation/);
const glossary = payload.report.pages[13].visuals.find(v => v.type === "pivotTable");
close(engine.visualData(glossary).data.length, payload.report.glossary.length, "Complete source glossary");
const impact = payload.report.pages[14].visuals.find(v => v.type === "tableEx");
const impactData = engine.visualData(impact);
for (const row of impactData.data) {
  const behavior = row[impactData.fields.findIndex(f => f.name === "Behavior")];
  const estimate = payload.report.estimates.find(e => e.behavior === behavior);
  if (estimate) close(row[impactData.fields.findIndex(f => f.name === "Human Baseline (min)")], Number(estimate.baseline), `Source impact baseline / ${behavior}`);
}
for (const input of ["Conservative", "Typical", "Optimistic"]) {
  const e = context.ValueLensReportEngine.create(payload, { ...baseState, scenario: input });
  close(e.measure("Expert Equivalent Hours"), reference.scenarios[input], `Source scenario ${input}`);
}
const evidence = { pages: payload.report.pages.length, sourceMeasures: measures.length, numericAssertions: assertions, visualEvaluations, mappings, results };
fs.writeFileSync(resolve(root, "demo", "valuelens-report", "fidelity-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
const files = ["index.html", "styles.css", "app.js", "engine.js", "report-data.js", "THIRD_PARTY_NOTICES.md", "fidelity-evidence.json"];
const manifest = {
  sourceRepository: "microsoft/ValueLens-for-Microsoft-Copilot",
  baseRevision: payload.report.baseRevision,
  sourceReport: payload.report.source,
  sourceReportSha256: createHash("sha256").update(fs.readFileSync(resolve(root, "5. Local CSV", "ValueLens - Local CSV.pbit"))).digest("hex"),
  mountPath: "/demo/valuelens-report/",
  files: files.map(name => ({ name, sha256: createHash("sha256").update(fs.readFileSync(resolve(root, "demo", "valuelens-report", name))).digest("hex") })),
};
fs.writeFileSync(resolve(root, "demo", "valuelens-report", "bundle-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Passed ${assertions} independent numerical/category assertions; ${visualEvaluations} visual evaluations across ${payload.report.pages.length} pages and ${reference.cases.length} filter cases; ${measures.length} explicit source measures.`);
