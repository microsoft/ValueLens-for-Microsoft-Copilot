# Archive

Retired Power Automate + Dataverse tooling, kept for reference. Not maintained.

| File | What it was | Why it was retired |
|---|---|---|
| `scripts/Build-PowerAutomateDataverse-Template.py` | Generated `ValueLens - Power Automate + Dataverse.pbit` by patching the SharePoint template: Dataverse parameters and queries, the optional `SharePoint Agents` inventory table and its interaction join, and the pending Power Query copy. | The template is now built from the same Power BI project (PBIP) as every other ValueLens template. The lean model has no `SharePoint Agents` table or pending query copy, so running this generator would rebuild the old model. Paths inside it assume its original `scripts/` location. |
