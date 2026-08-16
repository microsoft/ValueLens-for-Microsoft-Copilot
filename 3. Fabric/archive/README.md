# Archive

Older versions kept for reference. **You don't need anything in here for a new deployment** —
use the current files in [`../`](../).

| File | What it is | Why it's archived |
|---|---|---|
| `ValueLens - Fabric (Power Query, pre-2307).pbit` | The previous template. It did all the audit-log JSON parsing, list-explode and joins **inside Power Query**, on every refresh. | Replaced by the **2307 (Spark)** build. That heavy shaping now runs once in the `Copilot_Audit_Log_Processor` notebook, so the current `../ValueLens - Fabric.pbit` reads a ready-made table and refreshes in seconds instead of hours. See [`../README.md`](../README.md). |

The output columns, measures and report pages are identical between the two — only *where the
transformation runs* changed (Power Query → Spark).
