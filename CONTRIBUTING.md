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

The full command above also runs known pre-existing Dataverse template-contract
failures and a registry test with stale notebook-cell indexes. CI temporarily
deselects only those exact cases, with reasons in
[the tests workflow](.github/workflows/tests.yml). Use that workflow's pytest
command to reproduce its gated subset; do not treat exclusions as passing tests.
Remove an exclusion when a separate, validated template fix resolves it.

## Repository conventions

- Keep the four numbered deployment paths stable. Put setup details in the relevant
  path README and shared column contracts in the
  [data dictionary](docs/DATA-DICTIONARY.md).
- Preserve existing names, formatting and README tone. Separate measured signals
  from estimates, and document optional sources, toggles and blank-data behaviour.
- Use fabricated fixtures only. Never commit tenant exports, user identities,
  prompts, credentials, private solution packages or populated report files.
  Review notebook outputs and screenshots before attaching them.
- Edit shared Fabric notebooks in `3. Fabric/notebooks/`, then run
  `pwsh -NoProfile -File scripts/sync-shared.ps1` and
  `pwsh -NoProfile -File scripts/sync-shared.ps1 -Check`.
  The archived add-on's `_core/` folder is generated; do not edit it directly or
  recreate the retired `_shared/notebooks/` duplicate.
- **`.pbit` templates are binary packages.** Source/helper changes do not update
  shipped templates automatically: rebuild with the relevant repository generator
  or Power BI Desktop workflow. Describe the rebuild, preserve unrelated report /
  model content, and check refresh and visuals in Desktop with fabricated data.
  Do not claim a binary diff alone proves report correctness.
- Keep pull requests scoped and check every Markdown link you change. Record the
  exact test command, results and any skipped live validation.

Contributions are provided under the repository's [MIT license](LICENSE).
