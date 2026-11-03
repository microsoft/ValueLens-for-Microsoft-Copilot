# ValueLens browser demos

These are static, synthetic-data-only browser demos prepared for the demo site. Each bundle is
self-contained under `demo/` and can be served at its `/demo/<slug>/` path without an account,
sign-in, external data connection or live request.

## Provenance

- **Source repository:** `microsoft/ValueLens-for-Microsoft-Copilot`
- **Source/base revision before these uncommitted demo changes:** `8ea817cc7129d46eaf0d230abbf448ea1f39c22c`
- **Repository license:** MIT (`LICENSE`)
- **App source:** `app/`
- **Report source:** `5. Local CSV/ValueLens - Local CSV.pbit`
- **Report-port source:** `demos/valuelens-report/`
- **Sample data:** the checked-in fabricated CSV fixture in `5. Local CSV/sample-data/`. The report build replaces source user, organisation and agent labels with generic synthetic labels and does not include feedback comments or account identifiers.

The report port reads page order, page geometry, visual positions, field references, bookmark
views and visibility, glossary definitions, human-time estimates and measure expressions from the
local CSV PBIT. User and organisation labels are replaced with generic values, and agent names use
numbered labels. It does not copy the report's custom-visual code or assets. Values shown in the
report port are illustrative calculations over the synthetic fixture, not an execution of the Power
BI semantic model; source measure expressions are available from the visual definition buttons.

The app bundle includes its existing React, React DOM and PapaParse runtime dependencies (MIT
licensed); Vite and the existing Vite plugins remain build-time dependencies managed by
`app/package-lock.json`. The report demo uses browser-native HTML, CSS and JavaScript and Python's
standard library for its build; it has no third-party runtime dependency. No custom visual package
implementation or asset is redistributed.

## Build

Run from the repository root in PowerShell:

```powershell
Push-Location app
npm ci
npm run build:demo
Pop-Location
python demos\valuelens-report\build.py
```

The app build is intended for Node.js 24.11 or later and writes `demo/valuelens/index.html`. Its
CSS, JavaScript, sample data and favicon are embedded in that file. This build completed with
Node.js 26.13.0 and npm 11.20.0; npm warned that the existing Rayfin CLI dependency does not
declare Node 26 support. The report build uses Python 3.9 or later (validated with Python 3.12.0)
and writes `index.html`, `styles.css`, `app.js` and the locally generated `report-data.js` under
`demo/valuelens-report/`. Both outputs can be served from the repository root; the report demo's
source assets and data script use relative URLs.

The generated browser bundles contain only the demo code, copied local assets and the explicitly
synthetic fixture. They make no calls to external hosts. Keep these paths distinct from the
production app build and do not deploy the report demo as a live-connected Power BI report.
