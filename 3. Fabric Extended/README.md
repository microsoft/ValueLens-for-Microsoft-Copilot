# 3. Fabric Extended — advanced add-ons

Optional layers that build **on top of the standard [`2. Fabric`](../2.%20Fabric/) path**. Everything
here is a *superset* of the base dashboard — stand up path 2 first, get it producing data, then add one
of these.

Each add-on is **self-contained**: the core ingesters from `2. Fabric/notebooks/` are mirrored into
each add-on's `notebooks/_core/` folder (kept byte-identical by
[`../scripts/sync-shared.ps1`](../scripts/sync-shared.ps1) with CI enforcement). Download an add-on
folder and everything you need runs from inside it — no cross-folder path fiddling.

New here? You don't need this folder. Start with **[1. SharePoint](../1.%20SharePoint/)** (Power BI Pro)
or **[2. Fabric](../2.%20Fabric/)** (capacity) — both run the full core dashboard on their own.

| Add-on | Status | Adds |
|---|---|---|
| **[Fabric + Copilot Studio](Fabric%20+%20Copilot%20Studio/)** | ✅ Ready | Deeper **Copilot Studio agent** pages — transcript analysis (topics, resolution, containment), agent evaluation, and the Agent 365 registry detail. Includes the PPAC credit-consumption view. |
| **[Fabric + M365](Fabric%20+%20M365/)** | 🧪 Coming soon | **Microsoft 365 work-pattern** signals — how people work across a shared usage-mode spine, personas, and AI-readiness headroom. Not ready yet. |

> Each add-on is self-contained: pick the one you need, follow its README, and reuse the same Lakehouse
> parameters as your base `2. Fabric` build.

## Maintaining the mirrored core notebooks

The `_core/` folders inside each add-on and `_shared/notebooks/` in this folder are **copies** of the
canonical notebooks in `2. Fabric/notebooks/`. Do not edit them directly. Edit the source, then run
[`../scripts/sync-shared.ps1`](../scripts/sync-shared.ps1). See
[`_shared/README.md`](_shared/README.md) for the full rationale.

