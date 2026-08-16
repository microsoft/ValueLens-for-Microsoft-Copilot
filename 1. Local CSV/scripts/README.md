# scripts — manual extract toolchain

What turns a **raw Purview audit export** into the two CSVs the template reads.

| File | Purpose |
|---|---|
| `Purview_CopilotInteraction_Processor_v4.0.0.py` | The processor. Raw audit CSV + users → the two rollup CSVs. |
| `Adapt-OrgFile-To-EntraUsers.py` | Optional. Normalises a custom HR/org export into the shape the processor's `--entra` input expects. |
| `OrgData-Template.csv` | Sample bring-your-own org file — copy it, fill in your users, pass as `--entra`. |

---

## Why this step exists

The template's fact table needs **56 columns**. A raw Purview `CopilotInteraction` export contains
**one** of them (`CreationDate`) — everything else is derived here: the behaviour classification, the
`Human_Baseline_Min` time baseline behind hours saved, the environment split, the agent fields.

```
[Purview audit export]  +  [Entra users]  ->  processor  ->  [*_Interactions_*.csv]
                                                             [*_Users_*.csv]        ->  PBIT
```

Point the template at the raw export and it will fail on missing columns. That is expected — run
this first.

## Usage

```bash
python "Purview_CopilotInteraction_Processor_v4.0.0.py" \
    --purview    "<raw_copilot_interactions.csv>" \   # Purview audit export (CopilotInteraction)
    --entra      "<entra_users_org.csv>" \            # UPN, department, title, manager
    --licensing  "<m365_copilot_licence_list.csv>" \  # omit if --entra has a licence column
    --profile    aibv
```

`--profile aibv` is the ValueLens output (50-column fact superset, all the calculated columns
pre-computed). `--profile aio` produces the leaner AI-in-One shape instead.

`--help` lists everything, including `--out-dir` and `--with-aggregates`.

## Getting the raw export

**Small tenant** — Microsoft Purview → Audit → search `CopilotInteraction` → Export.

**Large tenant** — the UI export caps out well before millions of rows. Use
[microsoft/PAX ↗](https://github.com/microsoft/PAX), which partitions the query and runs unattended.
PAX now embeds this same v4.0.0 rollup, so it can emit the processed CSVs directly — that is exactly
what the scheduled [`../../2. SharePoint/`](../../2.%20SharePoint/) path automates.

So: this Python processor is the **manual** route, PAX is the **automated** one, and both produce the
same two files.

## Column reference

Full expectations for every column, both files:
[`../../3. Fabric/docs/DATA-DICTIONARY.md`](../../3.%20Fabric/docs/DATA-DICTIONARY.md).

---

## `Purview_CopilotInteraction_Processor_v4.0.0.py`

Inputs join on **UPN**: org attributes come from **Entra** (`--entra`), the Copilot **licence** flag
from the **M365 Admin Center** (`--licensing`). Supply them as two files, or pass a single combined
users+licence file as `--entra` and omit `--licensing` (licence column auto-detected).

Outputs, written to `--out-dir` (default = the `--purview` folder):

- `<purview_stem>_Interactions_<ts>.csv` — fact table
- `<entra_stem>_Users_<ts>.csv` — users dim

Requires **Python 3.9+**. `pip install orjson` is optional and speeds up parsing.

`--profile aibv` (default) emits the ValueLens fact superset; `--profile aio` emits the leaner
AI-in-One shape. `--with-aggregates` adds pre-rolled summary files you don't need for this template.

---

## `Adapt-OrgFile-To-EntraUsers.py`

Optional pre-step. The processor's `--entra` input must be in the **EntraUsers** shape (it joins to
the audit log on `userPrincipalName`). If your org/HR export uses different headers, an employee-ID
key, a semicolon delimiter or UTF-16, this adapter maps it into the expected shape — and can flatten
the manager chain into the `Level0..N` hierarchy for org drill-down.

```bash
python "Adapt-OrgFile-To-EntraUsers.py" \
    --in   "<custom_org_export.csv>" \
    --out  "EntraUsers_adapted.csv" \
    --upn-col "<your UPN column>"
# then feed EntraUsers_adapted.csv to the processor's --entra
```

> **Critical:** `--upn-col` must be the **same UPN** that appears in the Purview audit log, or users
> won't join and every interaction shows as unmatched. `--help` lists the full column-mapping
> options.

---

## `OrgData-Template.csv`

Sample bring-your-own org file, same shape as a **Viva Insights** org-data export. Copy it, fill in
your users, pass as `--entra`.

`UserPrincipalName` is required — header aliases `UPN` / `PersonId` are accepted, and values must be
UPNs, not GUIDs. Everything else (DisplayName, Department, Manager, License…) is optional and
alias-aware. If you include a licence column, `HasLicense` must be the literal `TRUE` or `FALSE` —
`Yes/No` and `1/0` are **not** recognised.

The scheduled [`../../2. SharePoint/`](../../2.%20SharePoint/) path accepts the same file via
`-UserInfoFile`.

---

## Keeping the sample data honest

[`../sample-data/Build-SampleData.py`](../sample-data/Build-SampleData.py) mirrors this processor's
behaviour taxonomy and baseline minutes. If you change the taxonomy or the baselines here, update
`BASELINE` in the generator too — otherwise the sample dataset drifts from the real pipeline.
