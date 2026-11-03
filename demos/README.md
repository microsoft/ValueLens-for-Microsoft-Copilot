# ValueLens browser demos

These are static, synthetic-data-only browser demos prepared for the demo site. Each bundle is
self-contained under `demo/` and can be served at its `/demo/<slug>/` path without an account,
sign-in, external data connection or live request.

## Provenance

- **Source repository:** `microsoft/ValueLens-for-Microsoft-Copilot`
- **Source/base revision before the demo changes:** `8ea817cc7129d46eaf0d230abbf448ea1f39c22c`
- **Repository license:** MIT (`LICENSE`)
- **App source:** `app/`
- **Report source:** `5. Local CSV/ValueLens - Local CSV.pbit`
- **Report-port source:** `demos/valuelens-report/`
- **Calculation sources:** unchanged pure functions in `app/src/metrics/` and `app/src/data/load.ts`, explicitly bound to source measures by `demos/valuelens-report/engine.ts`.
- **Sample data:** the checked-in fabricated CSV fixture in `5. Local CSV/sample-data/`. The report build replaces person, organisation, creator, agent, message and thread identities with generic synthetic labels. It replaces free-form feedback, agent descriptions and other identifying metadata rather than redistributing them.

The report port reads page order, page geometry, visual positions, field references, bookmark
views and visibility, glossary definitions, human-time estimates and measure expressions from the
local CSV PBIT. User and organisation labels are replaced with generic values, and agent names use
numbered labels. It does not copy the report's custom-visual code or assets. The browser evaluates
148 explicitly named source measures, including visual-filter and tooltip measures; unsupported
measure or field names throw an error instead of returning a guessed row count. The evaluator
preserves the source prompt/usage/observed-session distinctions, behavior-map scope and per-resource
normalization, Cowork thread/category effort, last-complete-month habit bands, model and Cowork fit,
readiness and dense ranking scopes, inventory dormancy window, and feedback date relationships.
All bound card measures, chart series and matrix columns are retained. Information buttons expose
the complete selected values, tooltip fields and original DAX.

`python demos\valuelens-report\validate.py` independently computes reference results from the
sanitized raw records in Python, then compares them to the compiled JavaScript engine. Its
4,218 numerical/category assertions cover all 16 pages: activation inventory; adoption behaviors;
habit stages; registry lifecycle; task-category shares; effort and cost scenarios; model-fit splits;
within-category Cowork grades; Cowork eligibility and dense user ranks; licence priority and ranks;
feedback trends; leaderboards; weekly heatmap cells; glossary descriptions; source impact baselines;
and licence allocation/dormancy. It also evaluates 1,380 complete visual projections over ten
selections: overall, licensed, unlicensed, each licence in Group 01, June only, Agents, Cowork,
one active agent, and an empty audit window. The generated `fidelity-evidence.json` records filter
states, numerical results, source visual IDs and asserted category values, plus source-expression
SHA-256 mappings. `bundle-manifest.json` hashes every distribution
file and the source PBIT.

Browser verification rendered all 16 pages without invalid numeric text or interaction errors.
Changing to Unlicensed produced 1,616 AI tasks and exposed its source-hidden activation group;
adding Group 01 produced 287 tasks and 8 active users. An organisation chart selection produced
782 tasks for Group 13 and cleared on a second click. At hourly value 100, estimated value was
268,961.66666666674; Conservative effort produced 1,217.4833333333336 hours. The Time Saved /
Value Table bookmark, source action navigation, complete-values dialog and reversed date-range
handling were exercised. Runtime assets were the four local CSS/data/engine/app files, with no
upload inputs. A 390px constrained-container check retained the 1280px scrollable report canvas;
this was not mobile-device emulation. The rebuilt app exposes its demo-site backlink and its
Organisation select has a matching accessible label association.

Native charts recreate the source treemap, tornado, column, stacked, line, dual-axis feedback
combo, scatter, word cloud and weekly heatmap families; custom visual binaries are not included.
Source parent-group offsets and explicit bookmark visibility overrides are honored. In particular,
the Unlicensed activation group is visible even though its base group is hidden. Visibility is not
guessed from a visual's title.

### Deliberate browser-port differences

This is not a general DAX engine or a pixel-identical Power BI renderer. Matrices are fully expanded
leaf tables rather than Power BI drill/subtotal controls; source fit images are accessible textual
mixes/verdicts; chart layout and word placement are native browser approximations. The original
page geometry, bindings and calculations remain available. Dates select whole months; hourly value
and effort scenarios are interactive, while penalty, monthly licence price and fit grading use the
source defaults (1, 30 and Balanced). Feedback themes describe newly invented feedback text.
Use horizontal scrolling for the original report canvas on narrow screens, and the values dialog
for legible complete tables. These are explicit presentation/interaction differences, not replacement
metrics or a claim that the original semantic model executes in the browser.

The repository is MIT licensed (`LICENSE`). The app bundle includes React, React DOM, Scheduler,
PapaParse and Vite's inline module-preload runtime; its generated
`demo/valuelens/THIRD_PARTY_NOTICES.md` contains their license texts. The source license texts are
at `app/node_modules/react/LICENSE`, `app/node_modules/react-dom/LICENSE`,
`app/node_modules/scheduler/LICENSE`, `app/node_modules/papaparse/LICENSE` and
`app/node_modules/vite/LICENSE.md`; Vite and the existing Vite plugins otherwise remain build-time
dependencies managed by `app/package-lock.json`. The report demo uses browser-native HTML, CSS and
JavaScript, Python's standard library for source extraction and Vite to compile the existing pure
TypeScript calculations. PapaParse and the app's sample loader are tree-shaken out of this entry;
there is no third-party report runtime dependency. Its generated
`demo/valuelens-report/THIRD_PARTY_NOTICES.md` contains the repository MIT license and it has no
third-party runtime dependency. No custom visual package implementation or asset is redistributed.

## Build

Run from the repository root in PowerShell:

```powershell
Push-Location app
npm ci
npm run build:demo
Pop-Location
python demos\valuelens-report\build.py
node app\scripts\build-report-engine.mjs
python demos\valuelens-report\validate.py
```

The app build is intended for Node.js 24.11 or later and writes `demo/valuelens/index.html`. Its
CSS, JavaScript, sample data and favicon are embedded in that file; the post-build hook writes the
third-party notices beside it. This build completed with
Node.js 26.13.0 and npm 11.20.0; npm warned that the existing Rayfin CLI dependency does not
declare Node 26 support. The report build uses Python 3.9 or later (validated with Python 3.12.0)
and, together with the Node build, writes `index.html`, `styles.css`, `app.js`, `engine.js`,
the locally generated `report-data.js`, MIT notice, numerical evidence and bundle manifest under
`demo/valuelens-report/`. Both outputs can be served from the repository root; the
report demo's source assets and data script use relative URLs.

The generated browser bundles contain only the demo code, copied local assets and the explicitly
synthetic fixture. They make no calls to external hosts. Keep these paths distinct from the
production app build and do not deploy the report demo as a live-connected Power BI report.

## Integration contract

The handoff supplies the exact isolated source worktree path. The app distribution is
`demo\valuelens\` at `/demo/valuelens/`; the report distribution is
`demo\valuelens-report\` at `/demo/valuelens-report/`. Copy only the tracked distribution files
(the report manifest is an explicit allowlist), retaining `THIRD_PARTY_NOTICES.md` in each bundle
and the repository `LICENSE`. Report distribution text is LF-normalized, including on Windows
checkout, so the manifest hashes remain byte-exact. Both demos link back to `/#solutions`; all executable assets are
local relative URLs. No sign-in, uploads, backend configuration, paid resource, access change,
deployment or production integration is required. The branch/commit in the handoff identifies the
committed demo additions separately from the original base revision above. The separate site
session reviews/imports/publishes; this source session does not deploy, open a PR or merge.
