# Manual setup

The main way to set up the Fabric path. The [installer](../installer/) (work in progress) automates
the same steps with these same files.

## Steps

1. **[Notebooks](notebooks/README.md).** Register an app, create a Lakehouse, load the data and
   publish the report.
2. **[Pipeline](pipelines/README.md).** Run the notebooks on a schedule and refresh the report.

## Optional extras

| Folder | What it adds |
|---|---|
| [Add Credit Consumption](Add%20Credit%20Consumption/) | The Consumption Central report: credits and cost across Copilot Studio, Copilot Cowork and Azure AI. |
| [Add Agent Evaluator](Add%20Agent%20Evaluator/) | The Agent Evaluator report: how well your Copilot Studio agents work. |
| [flows](flows/) | A Power Automate flow that saves the emailed product feedback export to your Lakehouse. |

## What's here

| Item | What it is |
|---|---|
| `ValueLens - Fabric.pbit` | The report, reading the Lakehouse SQL analytics endpoint. |
| `ValueLens - Fabric OneLake.pbit` | The same report, reading OneLake directly. |
| [`notebooks/`](notebooks/) | The core notebooks. The extras' notebooks are in `credit-consumption/` and `agent-evaluator/`; `workday-org-data/` adds HR columns. |
| [`pipelines/`](pipelines/) | The pipeline that runs the notebooks. |
