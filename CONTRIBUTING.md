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
processor's documented 3.9+ baseline and the 3.10+ prerequisites of the SharePoint
path and the archived Power Automate + Dataverse path; those path-specific minimums
are not a whole-repository test matrix.

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

CI runs the full suite with no exclusions. The directory-refresh checks for the
archived Power Automate + Dataverse path launch PowerShell 7 (`pwsh`); on a machine with only
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
release with the exe, its SHA-256 and the release notes from `packaging/finish-exe.js`. The same
tag makes [`azure-images`](.github/workflows/azure-images.yml) push
`ghcr.io/microsoft/valuelens-jobs` and `valuelens-web` with that version, which Azure installs pull.
Run by hand, it pushes only when run on an `installer-v*` tag; on a branch it just builds.

Signing happens in CI, never on your computer. Run the ESRP pipeline
([`packaging/sign-installer.azure-pipelines.yml`](1.%20Fabric/installer/packaging/sign-installer.azure-pipelines.yml))
with the tag. It signs the draft's exe with the Microsoft Corporation certificate and replaces its
exe, hash and notes. Then review the draft and publish it. Publishing checks the exe against its
hash. With the repo variable `REQUIRE_SIGNED_INSTALLER` set to `true`, it also requires the
signature. A release that fails goes back to being a draft.

## Repository conventions

- Keep the numbered folder names stable: installers, tests and links depend on them.
  Put setup details in the relevant README and shared column contracts in the
  [data dictionary](docs/DATA-DICTIONARY.md).
- Make each report or app change in every active variant: [the app](app/), `1. Fabric`
  (including the Fabric App), `2. Azure`, `4. SharePoint` and `5. Local CSV`. Leave
  [`archive/`](archive/) alone. The Power Automate + Dataverse path has been frozen since
  23 October 2026: the patch scripts in [`scripts/`](scripts/) and the template tests skip
  its templates, but tests still cover its scripts.
- Preserve existing names, formatting and README tone. Separate measured signals
  from estimates, and document optional sources, toggles and blank-data behaviour.
- Use fabricated fixtures only. Never commit tenant exports, user identities,
  prompts, credentials, private solution packages or populated report files.
  Review notebook outputs and screenshots before attaching them.
- Edit Fabric notebooks in `1. Fabric/Manual setup/notebooks/`. There are no mirrored copies to keep in sync.
- Old templates live, flat, in [`archive/`](archive/). A retired path keeps its folder name
  there, such as `archive/3. Power Automate + Dataverse/`, and a stub README stays at its old
  path so links keep working. Nothing in `archive/` is maintained.
- **`.pbit` templates are binary packages.** Source/helper changes do not update
  shipped templates automatically: rebuild with the relevant repository generator
  or Power BI Desktop workflow. Describe the rebuild, preserve unrelated report /
  model content, and check refresh and visuals in Desktop with fabricated data.
  Do not claim a binary diff alone proves report correctness.
- Keep pull requests scoped and check every Markdown link you change. Record the
  exact test command, results and any skipped live validation.

Contributions are provided under the repository's [MIT license](LICENSE).
