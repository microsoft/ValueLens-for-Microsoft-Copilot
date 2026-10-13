//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import { readNumber, readText, type SummaryRow } from "@/lib/summary-row";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import {
    consumptionConnection as connection,
    FORMAT_HOURS,
    FORMAT_MONEY,
    FORMAT_PERCENT,
    FORMAT_RATE,
    FORMAT_WHOLE,
} from "../shared";
import costByItemSpec from "./azure-cost-by-item.json";
import costTrendSpec from "./azure-cost-trend.json";
import solutionByServiceQuery from "./azure-solution-by-service.dax?raw";
import solutionDailyQuery from "./azure-solution-daily.dax?raw";
import solutionResourcesQuery from "./azure-solution-resources.dax?raw";
import solutionSummaryQuery from "./azure-solution-summary.dax?raw";
import sourceQuery from "./azure-source.dax?raw";
import foundryByModelQuery from "./foundry-by-model.dax?raw";
import foundryDailyQuery from "./foundry-daily.dax?raw";
import foundryResourcesQuery from "./foundry-resources.dax?raw";
import foundrySummaryQuery from "./foundry-summary.dax?raw";

const trendSpec = costTrendSpec as VisualizationSpec;
const byItemSpec = costByItemSpec as VisualizationSpec;

const sourceColumns: ColumnMetadataMap = {
    "[Solution Rows]": { name: "Solution Rows", displayName: "Solution rows", format: FORMAT_WHOLE },
    "[Solution Currencies]": { name: "Solution Currencies", displayName: "Solution currencies" },
    "[Foundry Rows]": { name: "Foundry Rows", displayName: "Foundry rows", format: FORMAT_WHOLE },
    "[Foundry Currency]": { name: "Foundry Currency", displayName: "Foundry currency" },
};

/** Which Azure feeds hold rows, so the page knows which one to read. */
export function azureSource() {
    return { connection, query: sourceQuery, columnMetadata: sourceColumns };
}

/**
 * The report's Azure page reads the whole-solution cost export. It is an
 * optional feed, so when it is empty the page falls back to the Foundry
 * model spend the model always loads.
 */
export type AzureMode =
    | { kind: "solution"; currencies: string[] }
    | { kind: "foundry"; currency: string | undefined }
    | { kind: "none" };

export function azureMode(row: SummaryRow | undefined): AzureMode {
    if ((readNumber(row, "[Solution Rows]") ?? 0) > 0) {
        const currencies = (readText(row, "[Solution Currencies]") ?? "")
            .split("|")
            .map((currency) => currency.trim())
            .filter((currency) => currency !== "");
        return { kind: "solution", currencies };
    }
    if ((readNumber(row, "[Foundry Rows]") ?? 0) > 0) {
        return { kind: "foundry", currency: readText(row, "[Foundry Currency]") };
    }
    return { kind: "none" };
}

export { currencyPrefix } from "@/lib/currency";

const solutionSummaryColumns: ColumnMetadataMap = {
    "[Selected Cost]": { name: "Selected Cost", displayName: "Azure cost", format: FORMAT_MONEY },
    "[Model Share]": { name: "Model Share", displayName: "Model share", format: FORMAT_PERCENT },
    "[Supporting Cost]": { name: "Supporting Cost", displayName: "Supporting cost", format: FORMAT_MONEY },
    "[AI Requests]": { name: "AI Requests", displayName: "AI requests", format: FORMAT_WHOLE },
    "[Tagged Allocation]": { name: "Tagged Allocation", displayName: "Tagged allocation", format: FORMAT_PERCENT },
    "[Tokens M]": { name: "Tokens M", displayName: "Tokens (M)", format: FORMAT_HOURS },
    "[Speech Hours]": { name: "Speech Hours", displayName: "Speech hours", format: FORMAT_HOURS },
    "[Document Pages]": { name: "Document Pages", displayName: "Document pages", format: FORMAT_WHOLE },
    "[Generated Images]": { name: "Generated Images", displayName: "Generated images", format: FORMAT_WHOLE },
    "[Cost Per 1M Tokens]": { name: "Cost Per 1M Tokens", displayName: "Cost per 1M tokens", format: FORMAT_RATE },
    "[Spend Context]": { name: "Spend Context", displayName: "Spend context" },
};

/** The report's Azure headline: whole-solution cost, how much of it is models, and what it bought. */
export function azureSolutionSummary() {
    return { connection, query: solutionSummaryQuery, columnMetadata: solutionSummaryColumns };
}

const dailyColumns: ColumnMetadataMap = {
    "[Usage Date]": { name: "Usage Date", displayName: "Day" },
    "[Component]": { name: "Component", displayName: "Component" },
    "[Component Sort]": { name: "Component Sort", displayName: "Component sort", format: FORMAT_WHOLE },
    "[Cost]": { name: "Cost", displayName: "Cost", format: FORMAT_MONEY },
};

/** Daily solution cost split into models, AI services and supporting resources. */
export function azureSolutionDaily() {
    return { connection, query: solutionDailyQuery, columnMetadata: dailyColumns, vegaLiteSpec: trendSpec };
}

const byItemColumns: ColumnMetadataMap = {
    "[Item]": { name: "Item", displayName: "Service" },
    "[Cost]": { name: "Cost", displayName: "Cost", format: FORMAT_MONEY },
};

export function azureSolutionByService() {
    return { connection, query: solutionByServiceQuery, columnMetadata: byItemColumns, vegaLiteSpec: byItemSpec };
}

const solutionResourcesColumns: ColumnMetadataMap = {
    "[Resource]": { name: "Resource", displayName: "Resource" },
    "[Application]": { name: "Application", displayName: "Application" },
    "[Service]": { name: "Service", displayName: "Service" },
    "[Department Tag]": { name: "Department Tag", displayName: "Department tag" },
    "[Cost]": { name: "Cost", displayName: "Cost", format: FORMAT_MONEY },
};

/** The report's resource table: each resource's cost and the department its tags allocate it to. */
export function azureSolutionResources() {
    return { connection, query: solutionResourcesQuery, columnMetadata: solutionResourcesColumns };
}

const foundrySummaryColumns: ColumnMetadataMap = {
    "[Cost]": { name: "Cost", displayName: "Foundry cost", format: FORMAT_MONEY },
    "[Input Cost]": { name: "Input Cost", displayName: "Input tokens", format: FORMAT_MONEY },
    "[Output Cost]": { name: "Output Cost", displayName: "Output tokens", format: FORMAT_MONEY },
    "[Output Share]": { name: "Output Share", displayName: "Output share", format: FORMAT_PERCENT },
    "[Tokens M]": { name: "Tokens M", displayName: "Tokens (M)", format: FORMAT_HOURS },
    "[Cost Per 1M Tokens]": { name: "Cost Per 1M Tokens", displayName: "Cost per 1M tokens", format: FORMAT_RATE },
    "[AI Requests]": { name: "AI Requests", displayName: "AI requests", format: FORMAT_WHOLE },
    "[Tokens Per Request]": { name: "Tokens Per Request", displayName: "Tokens per request", format: FORMAT_WHOLE },
    "[Daily Run Rate]": { name: "Daily Run Rate", displayName: "Daily run rate", format: FORMAT_MONEY },
    "[Cost Per Month]": { name: "Cost Per Month", displayName: "Cost per month", format: FORMAT_MONEY },
    "[Days Observed]": { name: "Days Observed", displayName: "Days observed", format: FORMAT_WHOLE },
    "[PTU Verdict]": { name: "PTU Verdict", displayName: "Provisioned capacity" },
};

/** Foundry model spend: what the tokens cost, how many there were, and the run rate. */
export function foundrySummary() {
    return { connection, query: foundrySummaryQuery, columnMetadata: foundrySummaryColumns };
}

/** Daily Foundry cost split into input and output tokens. */
export function foundryDaily() {
    return { connection, query: foundryDailyQuery, columnMetadata: dailyColumns, vegaLiteSpec: trendSpec };
}

const foundryByModelColumns: ColumnMetadataMap = {
    "[Item]": { name: "Item", displayName: "Model" },
    "[Cost]": { name: "Cost", displayName: "Cost", format: FORMAT_MONEY },
    "[Tokens M]": { name: "Tokens M", displayName: "Tokens (M)", format: FORMAT_HOURS },
};

export function foundryByModel() {
    return { connection, query: foundryByModelQuery, columnMetadata: foundryByModelColumns, vegaLiteSpec: byItemSpec };
}

const foundryResourcesColumns: ColumnMetadataMap = {
    "[Resource]": { name: "Resource", displayName: "Resource" },
    "[Resource Group]": { name: "Resource Group", displayName: "Resource group" },
    "[Model]": { name: "Model", displayName: "Model" },
    "[Department Tag]": { name: "Department Tag", displayName: "Department tag" },
    "[Cost]": { name: "Cost", displayName: "Cost", format: FORMAT_MONEY },
    "[Tokens M]": { name: "Tokens M", displayName: "Tokens (M)", format: FORMAT_HOURS },
};

/** Each Foundry resource and model, with its cost and the department its tags allocate it to. */
export function foundryResources() {
    return { connection, query: foundryResourcesQuery, columnMetadata: foundryResourcesColumns };
}
