# ValueLens and Consumption Central Fabric App

## Platform

A Fabric app, deployed by [`scripts/deploy.mjs`](scripts/deploy.mjs) into the workspace that holds
the semantic models it reads, as one of three variants: ValueLens, Consumption Central, or both. It's designed for desktop first (1280–1600px) and
still works at 390px wide.

## Users

- **Adoption and change leads.** They track Copilot, Copilot Chat and agent use, and see how habits
  form.
- **Value and ROI owners.** They estimate the hours and value Copilot saves, using their own
  assumptions, and report it to leadership.
- **IT, licence and budget owners.** They decide who gets a licence next, and track what Cowork,
  Copilot Studio and Azure AI Foundry credits cost against budget.

## Purpose

The ValueLens and Consumption Central reports as one app, or as one app each, over their live
semantic models. It looks and navigates like the products' CSV apps: a product switcher (in
the joined app), tabs and short sub-views instead of many report pages. Settings that were parameter tables (task times,
prices, rates and budgets) are edited in the app.

## Data

- Every page queries its semantic model live, as the person viewing it, so row-level security
  applies. The app keeps no copy of the data; results are cached in memory for the visit.
- Each view asks for the grain it needs, using the models' own DAX measures. It never pulls raw
  rows: the Execute Queries API caps a query at 100,000 rows.
- Optional pages and products show only when their data or model is there. The joined app works
  with only one product installed.

## Pages

Each tab holds its sections as stages, read top to bottom. A tab whose model isn't installed is
left out.

| Product | Tab | Sections |
| --- | --- | --- |
| ValueLens | Summary | The bottom line · Is it growing? · Where it is landing · What needs attention |
| ValueLens | Adoption | Adoption · Activation · Habit formation · Trend heatmap |
| ValueLens | Value | Task breakdown · Estimated value · Value by habit · Cost vs value |
| ValueLens | Efficiency | Cowork fit · Model fit · How grading works |
| ValueLens | Leaderboards | Leaderboard · Agents |
| ValueLens | Work patterns | Microsoft 365 activity · Apps and devices · Copilot in the flow of work |
| ValueLens | Readiness | License readiness · Heavy users without a licence · Cowork readiness |
| ValueLens | Governance | Estate health · Exposure · Accountability · Review queue · Shadow AI |
| ValueLens | Feedback | Feedback |
| ValueLens | Guide | Glossary · Signal → Impact |
| Consumption Central | Consumption | All products · Budget runway · Cowork / Work IQ · Copilot Studio · Azure |
| Beside the switcher | Ask · Assumptions | Questions to the data agent · Time per task |

Known differences from the products' CSV apps (follow-ups, not dropped on purpose):

- Consumption: no Azure deployment-health or billing-reconciliation views yet, though the model
  has the `AzureDeploymentHealth` and `AzureBillingReconciliation` tables. There is no GitHub
  Copilot view and no separate Consumption guide.
- Cowork task mix and the forecast scenarios are folded into Budget runway.
- ValueLens: the app/surface leaderboard table, the engagement-mode split and the role
  breakdowns are summarised rather than tabled.

## Constraints

- Figures must match the models' measures. How each one is worked out is in each product's
  methodology docs.
- Access is *Run and interact* on the app item plus **Build** on each model it reads.
- No external CDNs, fonts or network calls beyond the Fabric APIs.
- Product-neutral: the folder is copied unchanged between the two products' repos, so it links
  nothing outside itself.
- Accessibility: WCAG AA contrast, all controls reachable by keyboard, and visible focus.

## Brand and tone

Microsoft-adjacent, calm and analytical. A dark-teal header band over a white working surface.
Labels in plain English, and the numbers are the hero. Value estimates are shown as estimates,
with their caveats beside them.

## Anti-goals

- No marketing hero, decorative gradients or illustrations.
- No cards nested inside cards.
- Never drop a figure to simplify. Simplify by grouping and navigation instead.
- Never present estimated value as measured savings.
