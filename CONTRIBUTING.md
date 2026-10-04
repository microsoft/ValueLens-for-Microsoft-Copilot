# Contributing to ValueLens

Thanks for helping make ValueLens more useful and reliable.

## Propose a change

For a bug, include the deployment path, Power BI Desktop version, template revision,
whether you used sample or your own data, and reproducible steps. For a feature,
explain the use case, data source and expected result. Discuss substantial changes
in an issue before rebuilding templates or changing source contracts.

Create a focused branch, make the change, update the affected path documentation,
and open a pull request against `main` using the repository's PR template. Explain
compatibility, validation and any limitations. Follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately through the
[security policy](SECURITY.md), not a public issue or pull request.

## Run the tests

Run from the repository root with **Python 3.12** (the CI version) and
**PowerShell 7** (`pwsh` on `PATH`). Python 3.12 satisfies both the Local CSV
processor's documented 3.9+ baseline and the SharePoint / Dataverse paths' 3.10+
prerequisites; those path-specific minimums are not a whole-repository test matrix.

```text
python -m pip install pytest
python -B -m pytest tests -q
```

The offline suite uses the Python standard library plus pytest as the runner;
PowerShell subprocess checks also exercise dry-run helpers. No tenant credentials
are required. Do not provide production credentials or customer data to tests.
The optional Spark check in `test_snapshot_safety.py` skips when local PySpark /
Spark is unavailable; the default CI job does not install Spark. Local tests do
not certify Fabric execution, tenant permissions or Desktop / Service refresh.

CI runs the full suite with no exclusions. The Dataverse directory-refresh
checks launch PowerShell 7 (`pwsh`); on a machine with only
Windows PowerShell 5.1 or a restrictive execution policy they fail at setup
rather than on template content. Don't bypass the execution policy to run them;
rely on CI or install PowerShell 7.

## Work on the installer

From `1. Fabric/installer`:

```text
npm test                       # unit tests with fakes, no sign-in
npm run typecheck              # TypeScript checks over the JSDoc types
npx valuelens-install preview  # writes ./valuelens-preview (ignored by git)
npm run build:exe              # builds dist-exe/AnalyticsHubInstaller.exe (Windows, about 10 minutes)
```

`npm run build:exe` builds the [Analytics Hub app](1.%20Fabric/Fabric%20App/) once, stages it
with the installer and the notebooks, pipeline and templates it deploys, and zips them with a
portable Node.js into a small C# launcher, compiled with the `csc` that comes with the .NET
Framework. Run `npm ci` in the installer and in the app first. `--release` fails rather than warns
when something a published download needs is missing; `--out <dir>` writes the exe somewhere else.

The [`installer-exe`](.github/workflows/installer-exe.yml) workflow builds, tests and smoke-tests
the exe on pull requests that touch `packaging/`. To publish one, set the version in
`1. Fabric/installer/package.json` and push a tag `installer-v<version>`. The workflow drafts a
release with the exe and its SHA-256; review it and publish.

## Repository conventions

- Keep the four numbered deployment paths stable. Put setup details in the relevant
  path README and shared column contracts in the
  [data dictionary](docs/DATA-DICTIONARY.md).
- Preserve existing names, formatting and README tone. Separate measured signals
  from estimates, and document optional sources, toggles and blank-data behaviour.
- Use fabricated fixtures only. Never commit tenant exports, user identities,
  prompts, credentials, private solution packages or populated report files.
  Review notebook outputs and screenshots before attaching them.
- Edit Fabric notebooks in `1. Fabric/notebooks/`. There are no mirrored copies to keep in sync.
- Old templates live, flat, in [`archive/`](archive/). They aren't maintained.
- **`.pbit` templates are binary packages.** Source/helper changes do not update
  shipped templates automatically: rebuild with the relevant repository generator
  or Power BI Desktop workflow. Describe the rebuild, preserve unrelated report /
  model content, and check refresh and visuals in Desktop with fabricated data.
  Do not claim a binary diff alone proves report correctness.
- Keep pull requests scoped and check every Markdown link you change. Record the
  exact test command, results and any skipped live validation.

Contributions are provided under the repository's [MIT license](LICENSE).
