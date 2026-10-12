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
Local tests do not certify tenant permissions or Desktop / Service refresh.

CI runs the full suite with no exclusions. The Dataverse directory-refresh
checks launch PowerShell 7 (`pwsh`); on a machine with only
Windows PowerShell 5.1 or a restrictive execution policy they fail at setup
rather than on template content. Don't bypass the execution policy to run them;
rely on CI or install PowerShell 7.

### Parity with Analytics Hub

Analytics Hub (paths 1 and 2: the Fabric notebooks, the installer, the Azure jobs and the app)
lives in [microsoft/AnalyticsHub-Dashboard](https://github.com/microsoft/AnalyticsHub-Dashboard).
Its notebooks own the rules that the Local CSV processor copies, and its Fabric templates share
the report and measures with the templates here. Tests that compare against it read a checkout from
`ANALYTICS_HUB_ROOT` and skip when it isn't set:

```text
git clone https://github.com/microsoft/AnalyticsHub-Dashboard ../AnalyticsHub-Dashboard
$env:ANALYTICS_HUB_ROOT = "../AnalyticsHub-Dashboard"
python -B -m pytest tests -q
```

CI checks out the Analytics Hub release pinned in [`tests.yml`](.github/workflows/tests.yml) and
runs them every time. When a rule or a shared measure changes, change it in Analytics Hub first,
then bring the copy here in line and move the pin to the release that has it, in the same PR.

## Repository conventions

- Keep the numbered deployment paths stable. `1. Fabric` and `2. Azure` only point to Analytics
  Hub now; keep them so old links still land somewhere. Put setup details in the relevant
  path README and shared column contracts in the
  [data dictionary](docs/DATA-DICTIONARY.md).
- Preserve existing names, formatting and README tone. Separate measured signals
  from estimates, and document optional sources, toggles and blank-data behaviour.
- Use fabricated fixtures only. Never commit tenant exports, user identities,
  prompts, credentials, private solution packages or populated report files.
  Review notebook outputs and screenshots before attaching them.
- Fabric notebooks, the installer and the Azure code are edited in Analytics Hub, not here.
- Old templates live, flat, in [`archive/`](archive/). They aren't maintained.
- **`.pbit` templates are binary packages.** Source/helper changes do not update
  shipped templates automatically: rebuild with the relevant repository generator
  or Power BI Desktop workflow. Describe the rebuild, preserve unrelated report /
  model content, and check refresh and visuals in Desktop with fabricated data.
  Do not claim a binary diff alone proves report correctness.
- Keep pull requests scoped and check every Markdown link you change. Record the
  exact test command, results and any skipped live validation.

Contributions are provided under the repository's [MIT license](LICENSE).
