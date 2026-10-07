# 5. Local CSV

Power BI Desktop only: no tenant setup is needed to try it, and it ships with a fabricated sample dataset.

## 1. Try it with sample data

1. Open [`ValueLens - Local CSV.pbit`](ValueLens%20-%20Local%20CSV.pbit) in Power BI Desktop.
2. When Power BI asks for parameters, use full local paths to these files:

   | Parameter | File |
   |---|---|
   | Copilot Interactions File | `sample-data\copilot_interactions_sample.csv` |
   | Org Data File | `sample-data\copilot_users_sample.csv` |
   | Agent 365 | `sample-data\agents_365_sample.csv` |
   | Feedback File | `sample-data\product_feedback_sample.csv` |

3. Select **Load**.

See [`sample-data/README.md`](sample-data/README.md) for what the sample contains.

## 2. Use your own data

### You need

- Power BI Desktop.
- Python 3.9+.
- Access to the Purview audit export, the Microsoft Entra users export, and the Microsoft 365 Admin Center Copilot user export.
- Roles and permissions listed in [`../docs/PERMISSIONS.md`](../docs/PERMISSIONS.md).
- Optional access for Agent 365 registry data or product feedback.

### Steps

1. Export Copilot interactions from Microsoft Purview > Audit: search `CopilotInteraction`, export CSV, and save it as `raw_copilot_interactions.csv`.
2. Export licensed users from the Microsoft 365 Admin Center Copilot user export: include UPN and `Has License`, and save it as `m365_copilot_licence_list.csv`.
3. Export org data from Microsoft Entra users with UPN, department, job title, and manager, or copy [`scripts/OrgData-Template.csv`](scripts/OrgData-Template.csv) and fill it in. Save it as `entra_users_org.csv`.

4. If your org or HR file has different headers, convert it first:

   ```powershell
   python "scripts\Adapt-OrgFile-To-EntraUsers.py" `
       --in "<custom_org_export.csv>" `
       --out "EntraUsers_adapted.csv" `
       --upn-col "<your UPN column>"
   ```

   Use `EntraUsers_adapted.csv` as the `--entra` file.

5. Optional: export Agent 365 data. With an Agent 365 licence, run this from `4. SharePoint\scripts`:

   ```powershell
   .\Get-Agents365Registry.ps1 -OutputCsv .\Agents365Registry.csv `
       [-Auth Auto|AppRegistration|Interactive] [-TenantId <id>] [-ClientId <id>] [-ClientSecret <secret>]
   ```

   Without an Agent 365 licence, use the Microsoft 365 Admin Center **Agents** export and save it as `agents_365.csv`. See [`../4.%20SharePoint/scripts/README.md#get-agents365registryps1-on-its-own`](../4.%20SharePoint/scripts/README.md#get-agents365registryps1-on-its-own) for details.

6. Optional: export product feedback from Microsoft 365 Admin Center > Health > Product feedback > Export, and save it as `product_feedback.csv`.

7. Run the processor:

   ```powershell
   python "scripts\Purview_CopilotInteraction_Processor_v4.0.0.py" `
       --purview "<raw_copilot_interactions.csv>" `
       --entra "<entra_users_org.csv>" `
       --licensing "<m365_copilot_licence_list.csv>" `
       --profile aibv
   ```

   If the `--entra` file already includes the licence column, omit `--licensing`. The processor writes `*_Interactions_*.csv` and `*_Users_*.csv` next to the input files. See [`scripts/README.md`](scripts/README.md) for all options.

8. Open [`ValueLens - Local CSV.pbit`](ValueLens%20-%20Local%20CSV.pbit) and set these parameters:

   | Parameter | Value |
   |---|---|
   | Copilot Interactions File | Full path to `*_Interactions_*.csv` |
   | Org Data File | Full path to `*_Users_*.csv` |
   | Agent 365 | Blank, or full path to `Agents365Registry.csv` or `agents_365.csv` |
   | Feedback File | Blank, or full path to `product_feedback.csv` |

9. Select **Load**.

## How to update

1. Re-export the Purview audit CSV, licensed users CSV, org data CSV, and any optional Agent 365 or product feedback CSV.
2. Re-run `scripts\Adapt-OrgFile-To-EntraUsers.py` if you used it.
3. Re-run `scripts\Purview_CopilotInteraction_Processor_v4.0.0.py`.
4. In Power BI Desktop, update parameter paths if the file names changed, then select **Refresh**.

## Troubleshooting

| Issue | Fix |
|---|---|
| Power BI asks for SharePoint URLs or rejects a local path | Open `ValueLens - Local CSV.pbit`, not the SharePoint template. |
| The template says columns are missing | Do not point it at the raw Purview export. Run the processor and use `*_Interactions_*.csv` and `*_Users_*.csv`. |
| `python` is not found | Install Python 3.9+ and run the command from `5. Local CSV`. |
| Users do not match org data | Make sure the UPN in Purview matches the UPN in `--entra`; use `Adapt-OrgFile-To-EntraUsers.py` if needed. |
| UPNs are masked | In the Microsoft 365 admin center, go to **Settings** > **Org settings** > **Services** > **Reports**, turn off concealed user names, then export again. |
| Agent Registry or feedback pages are blank | Set the optional `Agent 365` or `Feedback File` parameter, or leave it blank if you skipped that source. |

Optional: add credit and cost reporting with [`Add Credit Consumption`](Add%20Credit%20Consumption/README.md).
