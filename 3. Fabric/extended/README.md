# extended — optional Copilot Studio add-on

> **You almost certainly don't need this folder.**
> [`1. Local CSV`](../../1.%20Local%20CSV/), [`2. SharePoint`](../../2.%20SharePoint/) and
> [`3. Fabric`](../) each run the **full core dashboard** on their own. This is an extra layer for
> one specific case.

Add this **only if** you run **Copilot Studio agents** and want the deeper agent pages. It is a
*superset* of the base Fabric build: stand up [`3. Fabric`](../) first, get it producing data, then
come back here.

| Add-on | Status | Adds |
|---|---|---|
| **[Fabric + Copilot Studio](Fabric%20+%20Copilot%20Studio/)** | 🧪 Experimental | Deeper **Copilot Studio agent** pages — transcript analysis (topics, resolution, containment), agent evaluation, and the Agent 365 registry detail. Includes the PPAC credit-consumption view. |

Each add-on is **self-contained**: the core ingesters from `3. Fabric/notebooks/` are mirrored into
the add-on's `notebooks/_core/` folder (kept byte-identical by
[`sync-shared.ps1`](../../scripts/sync-shared.ps1), with CI enforcement). Download the add-on folder
and everything you need runs from inside it — no cross-folder path fiddling.

> Follow the add-on's README and reuse the same Lakehouse parameters as your base
> [`3. Fabric`](../) build.

## Maintaining the mirrored core notebooks

The `_core/` folders inside each add-on and `_shared/notebooks/` in this folder are **copies** of the
canonical notebooks in [`../notebooks/`](../notebooks/). Do not edit them directly — edit the source,
then run [`sync-shared.ps1`](../../scripts/sync-shared.ps1). See
[`_shared/README.md`](_shared/README.md) for the full rationale.

