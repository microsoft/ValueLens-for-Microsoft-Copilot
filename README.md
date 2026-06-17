# 💼 AI Business Value Dashboard

A Power BI template that turns Microsoft **Copilot & agent** activity into a business‑value story —
hours saved, assisted value, and a defensible ROI narrative aligned to Microsoft's Frontier Firm
framework.

![AI Business Value Dashboard preview](Images/ABV-Preview.gif)

<details>
<summary>⚠️ <strong>Usage & compliance disclaimer</strong></summary>

While this tool helps customers understand the business value of their AI usage data, Microsoft has
**no visibility** into the data customers input, nor control over how the template is used. Customers
are solely responsible for ensuring their use complies with all applicable laws and regulations
(including data privacy and security). **Microsoft disclaims all liability** arising from use of this
template.

This is an **experimental** template with Purview audit logs as the primary source. Audit logs
provide visibility into Copilot/agent interactions but are not intended as the sole source of truth
for licensing or full‑fidelity reporting. Not supported through Microsoft support channels — please
open an issue in this repo.
</details>

---

## 🚀 Pick a deployment path

There are **two** ways to run the dashboard. Both use the same data; they differ only in *how* the
data gets in and how it refreshes.

| Path | Best when… | What it gives you |
|---|---|---|
| **[1. Fabric](1.%20Fabric/)** *(recommended)* | You have **Fabric capacity** (or Premium / PPU) — or any Spark + SQL stack. | Notebooks parse the data into a Lakehouse → best performance, sub‑second dashboard, and the optional billing & feedback pages. The same notebooks + template also run on Databricks, Synapse, or Azure SQL. |
| **[2. SharePoint](2.%20SharePoint/)** | Power BI Pro, **no Fabric** / Premium. You want scheduled refresh without a gateway. | [Microsoft PAX](https://github.com/microsoft/PAX) extracts in parallel partitions, a Python processor produces two rollup CSVs, the template refreshes from those SharePoint URLs. The simplest core deployment. |

**Not sure?** **Fabric** is the recommended path — it scales furthest and unlocks the optional
billing/feedback pages. No Fabric or Premium capacity? **SharePoint** runs the core dashboard on just
Power BI Pro.

> Each path folder has its **own README** with the exact, step‑by‑step setup. This page is just the
> map.

---

## 📊 What it measures

- **Quantified value** — hours saved and dollar‑equivalent assisted value, grounded in research‑sourced time baselines.
- **Frontier Firm maturity** — where you sit on the Pattern 1 (human + Copilot) → Pattern 2 (human + agent) → Pattern 3 (agents run workflows) journey.
- **Value by function** — Sales, HR, IT, Legal, Finance, Marketing, Customer Service, with task‑level attribution.
- **User maturity** — Beginner → Developing → Proficient, from behavioural breadth and agent adoption.
- **Business case** — projected annual value, ROI multiple, and licence investment net.

**How:** every interaction → classified into an **AI Task** → mapped to a research‑sourced **time
baseline** → summed to **Hours Saved** → × hourly rate = **Assisted Value**.

---

## 🔌 Data sources

| Source | Required? | Where it comes from |
|---|---|---|
| Copilot interactions (audit logs) | ✅ Core | Microsoft Purview |
| Licensed users | ✅ Core | Microsoft 365 Admin Center |
| Org data (department / function) | ✅ Core | Microsoft Entra |
| Agents 365 | ⬜ Optional | Agent 365 export (Fabric path) |
| Credit consumption (billing) | ⬜ Optional | Power Platform Admin Center export → see [`1. Fabric/CREDIT-CONSUMPTION-SETUP.md`](1.%20Fabric/CREDIT-CONSUMPTION-SETUP.md) |
| Product feedback | ⬜ Optional | M365 Admin Center → Health → Product Feedback export |

Optional sources are gated by `Enable_*` toggles — the dashboard works fine without them. The exact
export + connect steps live in the path README you choose above.

---

## 📚 Dashboard pages

| Page | Purpose |
|---|---|
| **User Activation** | Activation across teams — licensed vs unlicensed, active vs inactive |
| **Adoption & Reach** | User counts, coverage %, licensed vs unlicensed |
| **Activity & Value** | Copilot and agent usage, tasks, hours saved and assisted value |
| **Usage Maturity** | Progression: Asking → Finding → Consuming → Producing → Automating |
| **Leaderboards** | Top users, agents, and functions |
| **Agent Governance** | Deployment patterns, creator insights, sensitivity exposure |
| **User Feedback** | Thumbs up/down sentiment and verbatim feedback themes |
| **License Readiness** | Ranks unlicensed users by upgrade‑priority score |
| **Heatmap Trend** | Activity heatmap across the reporting period |
| **Copilot Studio: Credits Consumed** | Agent credit consumption and billing breakdown |
| **Copilot Studio: Agent Evaluation** | Agent resolution, abandonment, escalation and response time |
| **Copilot Studio: Topic Analysis** | Most‑asked topics, resolution and abandonment by agent |
| **Appendix: Key Concepts** | Methodology and key‑concept explainers |
| **Appendix: Glossary** | Metric definitions and research sources |
| **Appendix: Signal Table** | Trace raw signals through to value (audit trail) |

---

## 🔬 Research sources

Human‑time baselines are drawn from published research — Microsoft Research, MIT/Science (Noy &
Zhang 2023), NBER (Brynjolfsson et al. 2023), BCG/Harvard (Dell'Acqua et al. 2023), McKinsey,
Forrester TEI, IDC, and others. The full per‑task source list is in the **📖 Metric Glossary** page
inside the template.

---

## 🔒 Security

Please see [SECURITY.md](SECURITY.md) for information on reporting security vulnerabilities.

---

## 🙏 Acknowledgements & licence

Built by the Microsoft Copilot Growth & ROI practice, building on the structure of the community
AI‑in‑One Dashboard. Licensed **MIT** — see [LICENSE.md](LICENSE.md).

---

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
