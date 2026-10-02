# 5. Fabric App — ValueLens as a web app in your Fabric workspace

**Preview.** The ValueLens dashboard rebuilt as a fast web app. It's hosted as an item in your
Fabric workspace, and it reads the ValueLens semantic model you've already published. The app
keeps no copy of your data: every page queries the model live, as the person viewing it, so
row-level security applies. The only things it saves are the [rates and pack](#rates--packs)
and the [prices](#prices) you type in.

> **You need a published ValueLens model first.** Set up any path, 1 to 4, and publish its
> template to a Power BI workspace. All five templates share the fields this app queries.

## What's in it

| Page | Answers |
|---|---|
| **Adoption** | Who started, who stayed, who stuck: activation, adoption, habit formation, trend heatmap |
| **Leaderboards** | The people and agents doing the most, plus the agent registry with descriptions |
| **Agent Evaluation** | How well Copilot Studio agents answer: how conversations ended, errors, topic health, knowledge sources and feedback comments, from Agent Evaluator. It never shows the conversations themselves |
| **Readiness** | Who to license next, and who's ready for Cowork |
| **Consumption** | Credits used and what they cost across Cowork / Work IQ, Copilot Studio and Azure, from Consumption Central, at rates you can set in the app |
| **Value** | What the work was, and what it was worth: task breakdown, estimated value, and cost vs value, which sets licence and credit costs against that value |
| **Efficiency** | Whether the right tool is doing the job: Cowork fit, Model fit, and how grading works |
| **Feedback** | What people say about Copilot |
| **Appendix** | Glossary, plus Signal → Impact value assumptions |

Filters (date, organisation, licence, activity, agent) apply across the ValueLens pages. The
Consumption page has its own period, service, group and cost-basis choices, taken from the
Consumption Central report. The Agent Evaluation page has its own date, department and agent
slicers, and a Group by choice. The app opens in light mode, and a toggle switches it to dark.

How each figure is worked out, page by page, is in the [methodology](../docs/METHODOLOGY.md).

## Prerequisites

- A workspace on **Fabric capacity** (F2 or above, or a trial) to host the app. *My workspace*
  can't host it. The app adds a small **SQL database** under its item to hold the rates and
  prices; it uses that capacity too.
- A **published ValueLens semantic model**, with **Build** permission on it for everyone who'll use the app.
- *Optional, for the Consumption page:* a **published Consumption Central semantic model**, with
  the same Build permission.
- *Optional, for the Agent Evaluation page:* a **published Agent Evaluator semantic model**, with
  the same Build permission.
- The Fabric tenant setting **Fabric Apps (preview)** turned on (Admin portal → Tenant settings).
- The Power BI tenant setting **Dataset Execute Queries REST API** turned on (Admin portal →
  Integration settings).
- [Node.js 22.13 or later](https://nodejs.org/) on the machine you deploy from.

## Set up

Run these commands from this folder (`5. Fabric App`).

1. **Install.**
   ```powershell
   npm install
   ```
2. **Point it at your models.** [`fabric.yaml`](fabric.yaml) ships with placeholders. Replace
   `workspaceId` and `itemId` under `vl` with your ValueLens semantic model's, under `cc` with
   your Consumption Central model's, and under `ae` with your Agent Evaluator model's.
   Both IDs are in each model's URL: `app.powerbi.com/groups/<workspaceId>/datasets/<itemId>/…`
   Without Consumption Central or Agent Evaluator, leave its placeholders or delete its block
   (`cc` or `ae`). The app then leaves that page out of the sidebar. If a model is set up but holds
   no data yet, its page says so instead of showing blanks.
3. **Deploy.** Sign in when prompted. If your account spans tenants, add `--tenant <tenant-id>`.
   ```powershell
   npx rayfin up --workspace-uri "https://app.fabric.microsoft.com/groups/<workspace-id>"
   ```
   It builds the app, creates a **ValueLens App** item in the workspace, and prints two links. Use
   the **Fabric portal** link, or open the item from the workspace. The app loads its data
   through Fabric, so the `…fabricapps.net` hosting URL on its own shows *Not running inside a
   Fabric iframe*.
4. **Share.** Each viewer needs two things:
   - **The app:** add them to the workspace (Viewer is enough), or share the **ValueLens App** item
     with *Run and interact* permission. Then send them the Fabric portal link.
   - **The data:** Build permission on the ValueLens model, and on Consumption Central and Agent
     Evaluator if you use them. Without it the app opens, but its pages can't load.

   People from another tenant must first be invited as guests in yours, and guest access to
   Fabric must be allowed in your tenant settings.

To ship changes, run `npx rayfin up` again. It updates the same item.

## Rates & packs

The Consumption page prices credits at your commercial terms. Open **Rates & packs** at the top
of the page to set them:

| Field | What it changes |
|---|---|
| **Pay-as-you-go rate** | $ per credit for Cowork / Work IQ and Copilot Studio beyond any prepaid pack |
| **Prepaid rate** | $ per credit drawn from a Capacity Pack |
| **Capacity Pack balance** | Credits Cowork uses before it pays as it goes. Leave it at 0 with no pack |

Leave a box empty to keep the model's value. That comes from the `commercial_terms` table in
[Add Credit Consumption](../3.%20Fabric/Add%20Credit%20Consumption/), or from the model's
parameters if there's no such table. **Save for everyone** stores the values in the app's SQL
database, so everyone who opens the app sees the same costs. **Use model values** clears them.

- Anyone who can open the app can change the rates. Share the item only with people who should.
- Azure AI Foundry cost comes straight from your Azure cost export, so these rates don't change it.
- The Power BI report keeps the model's rates. Change `commercial_terms` to update both.

## Prices

The **Cost vs value** stage, at the end of the Value page, sets what Copilot cost against the
estimated value of the work it did. Open **Prices** at the top of the stage to set:

| Field | What it changes |
|---|---|
| **Microsoft 365 Copilot licence** | $ per user per month. Leave it empty to use the $30 US list price |
| **Exchange rate** | How much of your value's currency $1 buys, for example 0.75 for £. It only appears when the model's currency symbol isn't $. Licences and credits are billed in dollars, so the stage asks for this before it compares |

They're saved with the rates and pack, for everyone, and used only on this stage. Credit costs
come from the Consumption page at its rates, so they need Consumption Central. Without it, the
stage sets licences alone against value. How each figure is worked out is in the
[methodology](../docs/METHODOLOGY.md#83-cost-vs-value).

## Change it

| Task | How |
|---|---|
| Preview edits live | `npm run dev`, then open the app item in Fabric with `&devUri=http://localhost:5173` appended to its URL |
| Test | `npm test` · `npm run lint` |
| Edit a query | `src/queries/<page>/`, where each visual has a `.dax` query plus a `.ts` definition |
| Edit a page | `src/screens/<page>/` |

`rayfin up` writes local deploy state to `.env.local`, `rayfin/.env` and `rayfin/.deployments.json`.
All three are gitignored, because every customer deploys their own copy. It also adds your app's
URL to `allowedRedirectUris` in `rayfin/rayfin.yml`. Keep that edit, and your IDs in
`fabric.yaml`, out of any pull request to this repo.

Built on the [Fabric apps analytics template](https://learn.microsoft.com/fabric/apps/data-apps-template)
(React, TypeScript, Vite). [`AGENTS.md`](AGENTS.md) has the build conventions for coding agents.