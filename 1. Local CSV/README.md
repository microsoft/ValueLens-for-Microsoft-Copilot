# 1. Local CSV — start here

Run **ValueLens** from CSV files on your own machine. No tenant access, no scripts, no
Fabric capacity, no SharePoint.

Two ways to use this path:

| | You get | Time |
|---|---|---|
| **A — Sample data** 🧪 | The whole dashboard populated with a **fabricated dataset**. Nothing from your tenant. | ~2 min |
| **B — Your own data** | *Your* numbers, from a one-off export. | ~20 min |

Start with **A**. It shows you exactly what the dashboard measures and how the value model
lands — *before* you spend any effort on exports or automation.

---

## A — Sample data (no tenant needed)

1. Open **`ValueLens - Local CSV.pbit`** in Power BI Desktop.
2. When it prompts for parameters, point each at the matching file in
   [`sample-data/`](sample-data/) — use **full local paths**:

   | Parameter | File |
   |---|---|
   | Copilot Interactions File | `sample-data/copilot_interactions_sample.csv` |
   | Org Data File | `sample-data/copilot_users_sample.csv` |
   | Agent 365 *(optional)* | `sample-data/agents_365_sample.csv` |

3. **Load**.

That's it. Every page fills in.

The data models a ~260-person company over roughly two months — uneven adoption, a power-user
tail, some dormant licences, eight Copilot Studio agents. It is **generated, not anonymised**:
see [`sample-data/README.md`](sample-data/README.md) for how, and why that distinction matters.

> The figures are fictional, but the **arithmetic is the shipping value model** — the same
> behaviour taxonomy and time baselines as the production classifier. Don't read the totals as a
> benchmark; do read them as a faithful demonstration of the method.

---

## B — Your own data

Same template, your export. Three steps.

<details open>
<summary><strong>Step by step</strong></summary>

**You need:** any shell, **Python 3.9+**, and read access to the admin exports below.

### 1. Export the source files

The processor takes the raw audit log plus **users** and **licence** info. Org attributes come
from **Entra**; the Copilot **licence** flag comes from the **M365 Admin Center** — different
exports, joined on **UPN**. Supply them as two files (recommended) or pre-merged as one:

| Export | Where | Becomes |
|---|---|---|
| Raw **Copilot interactions** (audit log CSV) | Microsoft **Purview** → Audit → search `CopilotInteraction` → Export | `--purview` |
| **Org / users** (UPN, department, job title, manager) | Microsoft **Entra** → Users → Export, **or your own org/HR file** ([sample template](scripts/OrgData-Template.csv)) | `--entra` |
| **Licensing** (UPN + a `Has License` flag) | **M365 Admin Center** → Copilot user export | `--licensing` |

> **One combined file instead?** If your users export already contains a licence column, pass it
> as `--entra` and **omit** `--licensing` — the licence column is auto-detected.
>
> **Bring your own org data (instead of Entra)?** Copy the
> [sample template](scripts/OrgData-Template.csv) — the same shape a **Viva Insights** org-data
> file uses — fill in your users, and pass it as `--entra`. Messy HR export with different headers?
> Run it through [`scripts/Adapt-OrgFile-To-EntraUsers.py`](scripts/Adapt-OrgFile-To-EntraUsers.py) first.
>
> **Big tenant?** The Purview UI export caps out well before millions of rows. Use
> [microsoft/PAX ↗](https://github.com/microsoft/PAX) to pull the raw audit data instead — it
> partitions the query and runs unattended. PAX now embeds this same v4.0.0 rollup, so it can
> produce the processed CSVs directly; see [`../2. SharePoint/`](../2.%20SharePoint/) for the
> scheduled version of that.

### 2. Run the processor

[`scripts/Purview_CopilotInteraction_Processor_v4.0.0.py`](scripts/Purview_CopilotInteraction_Processor_v4.0.0.py)
turns the raw export into the two files the template reads:

```bash
python "scripts/Purview_CopilotInteraction_Processor_v4.0.0.py" \
    --purview    "<raw_copilot_interactions.csv>" \
    --entra      "<entra_users_org.csv>" \
    --licensing  "<m365_copilot_licence_list.csv>" \   # omit if --entra already has a licence column
    --profile    aibv
```

It writes two rollup CSVs next to your inputs (`*_Interactions_*.csv`, `*_Users_*.csv`). Run with
`--help` for all options (`--out-dir`, `--with-aggregates`, …). Full column expectations are in
[`../3. Fabric/docs/DATA-DICTIONARY.md`](../3.%20Fabric/docs/DATA-DICTIONARY.md).

### 3. Connect the template

Open **`ValueLens - Local CSV.pbit`** and point the parameters at the rollup CSVs from step 2:

| Parameter | Value |
|---|---|
| Copilot Interactions File | local path to `*_Interactions_*.csv` |
| Org Data File | local path to `*_Users_*.csv` |
| Agent 365 *(optional)* | blank, or a local Agents 365 CSV |

**Load** — done. To refresh: re-export, re-run the processor, **Refresh** in Desktop.

</details>

---

## When to move on

This path is manual by design — every refresh means re-exporting and re-running the processor.
When you want it hands-off:

| Next | Gives you |
|---|---|
| **[2. SharePoint](../2.%20SharePoint/)** | Scheduled extract → SharePoint → automatic Power BI refresh, on Power BI Pro |
| **[3. Fabric](../3.%20Fabric/)** | Lakehouse ingestion at scale, plus the optional billing and feedback pages |

Both read the **same two rollup CSVs** this path produces, so nothing you learn here is wasted.

---

## What's in this folder

| Item | Purpose |
|---|---|
| `ValueLens - Local CSV.pbit` | The dashboard template. Parameters take **local file paths**. |
| [`sample-data/`](sample-data/) | Fabricated dataset + the generator that produced it. |
| [`scripts/`](scripts/) | The processor that turns a raw Purview export into what the template reads, plus org-data helpers. |

> **The template reads *processed* CSVs, not a raw Purview export.** 55 of the 56 columns it needs
> don't exist in the raw audit log — they're produced by the processor in
> [`scripts/`](scripts/). The sample data is already processed, which is why path A works with no
> extra step.

> Using the **SharePoint** template by mistake is the most common trip-up — that one deliberately
> accepts SharePoint URLs only. For local paths, use the template in this folder.

---

<details>
<summary><strong>Troubleshooting</strong></summary>

| Symptom | Fix |
|---|---|
| Parameters reject a local path | You've opened `ValueLens - SharePoint.pbit`. Use `ValueLens - Local CSV.pbit` from this folder. |
| `python: command not found` | Install Python 3.9+ and retry. |
| `0 records returned` from the export | `AuditLogsQuery.Read.All` consent missing — re-grant in Entra. |
| Masked UPNs (32-char hex) | M365 Admin → Org settings → Reports → untick "Display concealed names". |
| Agent Health visuals blank | Expected without an Agent 365 observability export — see [`../3. Fabric/docs/DATA-DICTIONARY.md`](../3.%20Fabric/docs/DATA-DICTIONARY.md#4-agents_365). |
| Refresh is slow or hits limits | Volume is too high for a local file path — move to [`../3. Fabric/`](../3.%20Fabric/). |

</details>
