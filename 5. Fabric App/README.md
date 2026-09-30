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
| **Value** | What the work was, and what it was worth: task breakdown and estimated value |
| **Efficiency** | Whether the right tool is doing the job: Cowork fit, Model fit, and how grading works |
| **Feedback** | What people say about Copilot |
| **Appendix** | Glossary, plus Signal → Impact value assumptions |

Filters (date, organisation, licence, activity, agent) apply across pages. The app opens in dark
mode, and a toggle switches it to light.

## Prerequisites

- A workspace on **Fabric capacity** (F2 or above, or a trial) to host the app. *My workspace*
  can't host it.
- A **published ValueLens semantic model**, with **Build** permission on it for everyone who'll use the app.
- The Power BI tenant setting **Dataset Execute Queries REST API** turned on (Admin portal →
  Integration settings).
- [Node.js 22](https://nodejs.org/) on the machine you deploy from.

## Set up

Run these commands from this folder (`5. Fabric App`).

1. **Install.**
   ```powershell
   npm install
   ```
2. **Point it at your model.** In [`fabric.yaml`](fabric.yaml), set `workspaceId` and `itemId` to
   your semantic model. Both IDs are in the model's URL:
   `app.powerbi.com/groups/<workspaceId>/datasets/<itemId>/…`
3. **Deploy.** Sign in when prompted. If your account spans tenants, add `--tenant <tenant-id>`.
   ```powershell
   npx rayfin up --workspace-uri "https://app.fabric.microsoft.com/groups/<workspace-id>"
   ```
   It builds the app, creates a **ValueLens** item in the workspace, and prints the link.
4. **Share.** Anyone with access to the workspace and Build permission on the model can open the app.

To ship changes, run `npx rayfin up` again. It updates the same item.

## Change it

| Task | How |
|---|---|
| Preview edits live | `npm run dev`, then open the app item in Fabric with `&devUri=http://localhost:5173` appended to its URL |
| Test | `npm test` · `npm run lint` |
| Edit a query | `src/queries/<page>/`, where each visual has a `.dax` query plus a `.ts` definition |
| Edit a page | `src/screens/<page>/` |

`rayfin up` writes local deploy state to `.env.local`, `rayfin/.env` and `rayfin/.deployments.json`.
All three are gitignored, because every customer deploys their own copy.

Built on the [Fabric apps analytics template](https://learn.microsoft.com/fabric/apps/data-apps-template)
(React, TypeScript, Vite). [`AGENTS.md`](AGENTS.md) has the build conventions for coding agents.