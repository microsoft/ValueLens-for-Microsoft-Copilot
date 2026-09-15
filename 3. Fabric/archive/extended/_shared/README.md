# ARCHIVED — shared core notebook location

> **ARCHIVED / reference only — not a recommended active add-on.** The core notebooks
> remain active in [`3. Fabric/notebooks/`](../../../notebooks/); these mirrors are **not frozen**.

The redundant `notebooks/` copy formerly here has been removed. Use the eight
**byte-identical mirrors** (seven ingesters/landers plus `ValueLens_Data_Check.ipynb`) in
[`Fabric + Copilot Studio/notebooks/_core/`](../Fabric%20+%20Copilot%20Studio/notebooks/_core/).
That folder is used by the archived add-on's historical setup; this second copy had
no separate setup or runtime consumer. The canonical sources remain in
[`3. Fabric/notebooks/`](../../../notebooks/).

## Do not edit here

The **source of truth is `3. Fabric/notebooks/`**. Edit there, then run:

```powershell
.\scripts\sync-shared.ps1
```

from the repo root. [`scripts/sync-shared.ps1`](../../../../scripts/sync-shared.ps1)
continues to synchronize all eight notebooks into
`3. Fabric/archive/extended/Fabric + Copilot Studio/notebooks/_core/`.
CI runs the same script in check mode on matching pushes and pull requests and fails if drift is detected.
The downstream [`Copilot_Audit_Log_Processor.ipynb`](../../../notebooks/Copilot_Audit_Log_Processor.ipynb)
is deliberately not mirrored; it remains in the active base Fabric build.
