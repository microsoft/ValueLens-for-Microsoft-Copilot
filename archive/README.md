# Archive

Older deployment paths kept here for reference / continuity for anyone still
running them. Not maintained.

| Folder | What it is | Why it was replaced |
|---|---|---|
| `2. SharePoint (v1-flatten)/` | The original SharePoint path — 4 sequential PowerShell extractors + a 30-min wait + Power Query that flattens 15 columns at refresh. Also contained an Azure Automation bicep that scheduled the same scripts. | Replaced by the [`2. SharePoint/`](../2.%20SharePoint/) rollup flow: one `Run-PAX-AIBV.ps1` wrapper that drives [microsoft/PAX](https://github.com/microsoft/PAX) in parallel partitions, then a Python processor that pre-classifies 50 AIBV columns. Typical 7-day extract: ~5–10 min vs. ~45–60 min. |

If you need the old README it's in
[`2. SharePoint (v1-flatten)/README.md`](2.%20SharePoint%20(v1-flatten)/README.md).
