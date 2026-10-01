# 5. Fabric App — ValueLens as a web app in your Fabric workspace

**Preview.** The ValueLens dashboard rebuilt as a fast web app. It's hosted as an item in your
Fabric workspace, and it reads the ValueLens semantic model you've already published. The app
stores no data: every page queries the model live, as the person viewing it, so row-level
security applies.

> **You need a published ValueLens model first.** Set up any path, 1 to 4, and publish its
> template to a Power BI workspace. All five templates share the fields this app queries.

## What's in it

| Page | Answers |
|---|---|
| **Adoption** | Who started, who stayed, who stuck: activation, adoption, habit formation, trend heatmap |
| **Leaderboards** | The people and agents doing the most, plus the agent registry with descriptions |
| **Readiness** | Who to license next, and who's ready for Cowork |
| **Consumption** | Credits used and what they cost across Cowork / Work IQ, Copilot Studio and Azure, from Consumption Central |
| **Value** | What the work was, and what it was worth: task breakdown and estimated value |
| **Efficiency** | Whether the right tool is doing the job: Cowork fit, Model fit, and how grading works |
| **Feedback** | What people say about Copilot |
| **Appendix** | Glossary, plus Signal → Impact value assumptions |

Filters (date, organisation, licence, activity, agent) apply across the ValueLens pages. The
Consumption page has its own period, service, group and cost-basis choices, taken from the
Consumption Central report. The app opens in light mode, and a toggle switches it to dark.

## Prerequisites

- A workspace on **Fabric capacity** (F2 or above, or a trial) to host the app. *My workspace*
  can't host it.
- A **published ValueLens semantic model**, with **Build** permission on it for everyone who'll use the app.
- *Optional, for the Consumption page:* a **published Consumption Central semantic model**, with
  the same Build permission.
- The Fabric tenant setting **Fabric Apps (preview)** turned on (Admin portal → Tenant settings).
- The Power BI tenant setting **Dataset Execute Queries REST API** turned on (Admin portal →
  Integration settings).
- [Node.js 22](https://nodejs.org/) on the machine you deploy from.

## Set up

Run these commands from this folder (`5. Fabric App`).

1. **Install.**
   ```powershell
   npm install
   ```
2. **Point it at your models.** [`fabric.yaml`](fabric.yaml) ships with placeholders. Replace
   `workspaceId` and `itemId` under `vl` with your ValueLens semantic model's, and under `cc`
   with your Consumption Central model's.
   Both IDs are in each model's URL: `app.powerbi.com/groups/<workspaceId>/datasets/<itemId>/…`
   Without Consumption Central, delete the `cc` block; the Consumption page then explains what
   it needs.
3. **Deploy.** Sign in when prompted. If your account spans tenants, add `--tenant <tenant-id>`.
   ```powershell
   npx rayfin up --workspace-uri "https://app.fabric.microsoft.com/groups/<workspace-id>"
   ```
   It builds the app, creates a **ValueLens** item in the workspace, and prints two links. Use
   the **Fabric portal** link, or open the item from the workspace. The app loads its data
   through Fabric, so the `…fabricapps.net` hosting URL on its own shows *Not running inside a
   Fabric iframe*.
4. **Share.** Each viewer needs two things:
   - **The app:** add them to the workspace (Viewer is enough), or share the **ValueLens** item
     with *Run and interact* permission. Then send them the Fabric portal link.
   - **The data:** Build permission on the ValueLens model, and on Consumption Central if you use
     it. Without it the app opens, but its pages can't load.

   People from another tenant must first be invited as guests in yours, and guest access to
   Fabric must be allowed in your tenant settings.

To ship changes, run `npx rayfin up` again. It updates the same item.

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