# Azure Container Apps Job — secretless managed-identity scheduling

> [!IMPORTANT]
> **The schema blocker that held this up is now resolved.** As of
> **PAX v1.11.5** (and **v1.11.6**, the current release) PAX embeds the
> **v4.0.0** CopilotInteraction processor and a new **`-Dashboard AIBV`** switch
> that produces the ValueLens rollup **natively** — the same 50-column
> profile the AIBV PBIT consumes. A custom container layer is **no longer
> needed**: you can run PAX's own container image directly.
>
> What remains is to **commit and test** the deployment, so until the files in
> the table below land here, the supported way to schedule the SharePoint
> refresh is still the **app registration** path documented in the
> [folder README](../README.md#authentication) (via
> [`Register-TaskScheduler.ps1`](../scripts/Register-TaskScheduler.ps1)).
> Managed identity is an **alternative** to that app registration, not an
> addition.

## What changed (PAX v1.11.5 / v1.11.6)

| | Before (PAX ≤ v1.11.4) | Now (PAX ≥ v1.11.5) |
|---|---|---|
| Embedded rollup processor | v3.1.0 (33-column schema) | **v4.0.0** (50-column AIBV schema) |
| AIBV rollup | Not available in PAX — needed this repo's separate [`Purview_CopilotInteraction_Processor_v4.0.0.py`](../scripts/Purview_CopilotInteraction_Processor_v4.0.0.py) | Built in — select with **`-Dashboard AIBV`** (auto-enables `-Rollup`) |
| Container story | Custom image layering the v4.0.0 processor over PAX | **Vanilla PAX image** ([`PAX.Dockerfile`](https://github.com/microsoft/PAX/blob/release/fabric_resources/Dockerfile/PAX.Dockerfile)) — no layer needed |

> [!NOTE]
> PAX's `-Dashboard AIBV` runs the **same** v4.0.0 processor this folder shipped;
> it was upstreamed into PAX. A one-time column/row diff of a PAX
> `-Dashboard AIBV` rollup against this repo's standalone processor output is
> still worth doing as a validation step before cutting over (see the checklist).

## Target design (no custom layer)

Run Microsoft PAX's **own** container as an ACA Job — nothing in this folder needs
to be baked into an image:

1. **Image** — build/push `microsoft/PAX`'s
   [`Dockerfile/PAX.Dockerfile`](https://github.com/microsoft/PAX/blob/release/fabric_resources/Dockerfile/PAX.Dockerfile)
   to your ACR (or pull a published tag).
2. **Job command** — invoke PAX with the AIBV dashboard, managed-identity auth,
   and a SharePoint document-library `-OutputPath`. These go in the deploy
   script's `-ScriptArgs`:

   ```text
   -Auth        ManagedIdentity
   -TenantId    <tenant-guid>
   -Dashboard   AIBV                 # embedded v4.0.0 rollup; auto-enables -Rollup
   -IncludeUserInfo                  # Entra users + MAC licensing (AIBV needs both)
   -StartDate   <yyyy-MM-dd>         # PAX has no -Days; omit both for a 30-day window
   -EndDate     <yyyy-MM-dd>
   -OutputPath  "https://<tenant>.sharepoint.com/sites/<site>/<library>/AIBV"
   ```
3. **Deploy** — use PAX's own
   [`Deploy/Deploy-PAXAcaJob.ps1`](https://github.com/microsoft/PAX/blob/release/fabric_resources/Deploy/Deploy-PAXAcaJob.ps1)
   **directly** — it already supports a SharePoint destination (its own synopsis:
   *"writes outputs to either SharePoint Online or Microsoft Fabric/OneLake"*),
   so no AIBV-specific deploy script is needed. The storage tier is inferred from
   the `-OutputPath` URL form (a `sharepoint.com` path routes to SharePoint
   automatically). Worked example:

   ```powershell
   ./Deploy-PAXAcaJob.ps1 `
       -SubscriptionId 'xxx' -ResourceGroup 'rg-pax' -EnvironmentName 'cae-pax' `
       -JobName 'aibv-sharepoint-daily' -AcrName 'paxacr' -ImageTag '1.11.14' `
       -ManagedIdentityResourceId '/subscriptions/.../userAssignedIdentities/uai-aibv' `
       -ManagedIdentityClientId '<uami-client-id>' `
       -BootstrapLogStorageAccount 'aibvbootstraplogs' `
       -ScriptArgs @('-Dashboard','AIBV','-IncludeUserInfo','-Auth','ManagedIdentity',
                     '-OutputPath','https://<tenant>.sharepoint.com/sites/<site>/<library>/AIBV') `
       -CronExpression '0 2 * * *'   # 02:00 UTC daily
   ```

   > `Deploy-PAXAcaJob.ps1` also **requires** a `-BootstrapLogStorageAccount`
   > (an Azure Files share it provisions for pre-flight logs) — one extra Azure
   > resource to budget for.
4. **Permissions** — grant the managed identity its roles with PAX's
   [`Prereqs/Grant-PAXPermissions.ps1`](https://github.com/microsoft/PAX/blob/release/fabric_resources/Prereqs/Grant-PAXPermissions.ps1).
   See the permissions caveat below — PAX's SharePoint mode needs broader Graph
   scopes than this repo's existing `Sites.Selected` flow.

Because PAX emits AIBV directly, the in-container flow is a **single step**
(PAX → SharePoint) rather than the old two-step (PAX → v4.0.0 processor →
SharePoint).

> **Pin `-ImageTag '1.11.14'` or newer.** Earlier `purview-v1.11.x` container
> builds had a bug where the Agent 365 catalog CSV was generated but not
> uploaded to a SharePoint (or Fabric/OneLake) `-OutputPath`. Fixed in
> [`purview-v1.11.14`](https://github.com/microsoft/PAX/releases/tag/purview-v1.11.14).
> Local-output runs via this repo's [`../scripts/Run-PAX-AIBV.ps1`](../scripts/Run-PAX-AIBV.ps1)
> wrapper were never affected — the bug is remote-output-only.

> [!WARNING]
> **Permissions differ from the app-registration path — decide this before
> deploying.** PAX's container/SharePoint mode requires the managed identity to
> hold the **tenant-wide** Graph application permissions
> **`Sites.ReadWrite.All` + `Files.ReadWrite.All`** (per
> `Deploy-PAXAcaJob.ps1`'s own prerequisites). This repo's
> [`../scripts/ProvisionSiteAccess-SP-AppReg.ps1`](../scripts/ProvisionSiteAccess-SP-AppReg.ps1)
> uses the far more locked-down, **per-library `Sites.Selected`** grant, which
> PAX's output path does **not** currently use. So you cannot simply reuse the
> existing `Sites.Selected` grant for the managed identity. For least-privilege-
> sensitive tenants (e.g. regulated/financial), this tenant-wide scope is a real
> decision point — either accept `Sites.ReadWrite.All`/`Files.ReadWrite.All`, or
> stay on the app-registration + `Sites.Selected` Task Scheduler path until a
> `Sites.Selected`-compatible container path is available.

## Remaining work to ship this

- [ ] **Validate** a PAX `-Dashboard AIBV` rollup matches this repo's standalone
      v4.0.0 output (column set + a row-level spot check).
- [ ] **Confirm filenames (don't rename).** PAX's `-Dashboard AIBV` rollup is
      built to emit the exact filenames the AIBV PBIT reads — PAX's docs say the
      rollup output names *"are the exact files expected by the Copilot Analytics
      Lab Power BI templates — do not rename them."* Just confirm the PBIT's
      default parameter URL matches PAX's emitted rollup name. (The old
      [`../scripts/Upload-Rollups-SharePoint.ps1`](../scripts/Upload-Rollups-SharePoint.ps1)
      rename step belonged to the standalone-processor path and is no longer
      needed.)
- [ ] **Permissions decision** — accept PAX's tenant-wide
      `Sites.ReadWrite.All` / `Files.ReadWrite.All` for the managed identity (see
      the warning above), or hold for a `Sites.Selected`-compatible path. The
      always-required Graph roles (`AuditLogsQuery.Read.All`, `User.Read.All`,
      `Organization.Read.All`) are granted by `Grant-PAXPermissions.ps1`.
- [ ] **Provision** the mandatory `-BootstrapLogStorageAccount` (Azure Files
      share for pre-flight logs).
- [ ] **Test** the ACA Job end-to-end (a 1-day run validates audit read,
      SharePoint write, and managed-identity sign-in in minutes).

## What this folder will contain when shipped

PAX's `Deploy-PAXAcaJob.ps1` can deploy the AIBV job **directly**, so this folder
needs only thin convenience wrappers (optional) and config — not a bespoke
deploy script:

| File | Purpose |
|---|---|
| `Deploy-AcaJob.ps1` _(optional)_ | Thin convenience wrapper that calls PAX's [`Deploy-PAXAcaJob.ps1`](https://github.com/microsoft/PAX/blob/release/fabric_resources/Deploy/Deploy-PAXAcaJob.ps1) pre-set with the AIBV `-ScriptArgs` (`-Dashboard AIBV -IncludeUserInfo`) and a SharePoint `-OutputPath`. |
| `Grant-Permissions.ps1` _(optional)_ | Thin wrapper over PAX's [`Grant-PAXPermissions.ps1`](https://github.com/microsoft/PAX/blob/release/fabric_resources/Prereqs/Grant-PAXPermissions.ps1), defaulting to the SharePoint scopes. |
| `job.env.example` | Example job parameters (subscription, RG, ACA env, ACR, UAMI, site/library path, schedule). |

> No `Dockerfile` or `entrypoint.ps1` is needed — with `-Dashboard AIBV` the
> stock PAX image is used as-is.

## Until this lands

Use one of the scheduling options the [folder README](../README.md#schedule-it)
documents (both authenticate with the app registration):

- **Windows Task Scheduler** — see
  [`../scripts/Register-TaskScheduler.ps1`](../scripts/Register-TaskScheduler.ps1)
- **GitHub Actions** — a `.yml` workflow that runs `Run-PAX-AIBV.ps1` +
  `Upload-Rollups-SharePoint.ps1` on a `schedule:` cron

## Tracking

Open an issue tagged `azure-container` if you'd like to help land this.
