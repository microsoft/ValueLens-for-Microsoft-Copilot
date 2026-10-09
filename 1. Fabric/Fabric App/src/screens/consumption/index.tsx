//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { CommercialTermsProvider } from "@/components/commercial-terms-provider";
import { stageAnchor } from "@/components/destinations";
import { SourceEmpty, SourceError } from "@/components/source-states";
import { readText } from "@/lib/summary-row";
import {
    azureMode,
    azureSource,
    consumptionNotes,
    consumptionOptions,
    consumptionSources,
    hasConsumptionData,
    readConsumptionOptions,
} from "@/queries/consumption";
import { consumptionConnection } from "@/queries/shared";
import { AzureStage } from "./azure-stage";
import { BudgetRunwayStage } from "./budget-runway-stage";
import { CoworkStage } from "./cowork-stage";
import { OverviewStage } from "./overview-stage";
import { useConsumptionSummary, useConsumptionTable } from "./data";
import { RatesBar } from "./rates-bar";
import { StudioStage } from "./studio-stage";

const SOURCE = { anchor: stageAnchor("consumption-overview"), page: "Consumption", model: "Consumption Central" };

/**
 * Consumption Central's consumption and cost pages: every product side by
 * side, then Cowork / Work IQ, Copilot Studio and Azure in turn. The slicer
 * choices and credit rates are read once here and shared by every stage, and
 * every cost is priced at the rates and pack balance saved in the app.
 */
export function ConsumptionScreen() {
    return (
        <CommercialTermsProvider>
            <ConsumptionPage />
        </CommercialTermsProvider>
    );
}

function ConsumptionPage() {
    const optionsResult = useConsumptionTable(consumptionOptions());
    const options = useMemo(
        () => (optionsResult.table ? readConsumptionOptions(optionsResult.table) : undefined),
        [optionsResult.table],
    );
    const notes = useConsumptionSummary(consumptionNotes());
    const rates = readText(notes.row, "[Rates In Use]");
    const sources = useConsumptionSummary(consumptionSources());
    const azureSourceRow = useConsumptionSummary(azureSource()).row;
    const azure = useMemo(() => azureMode(azureSourceRow), [azureSourceRow]);
    const azureCurrency =
        azure.kind === "solution" ? azure.currencies[0] : azure.kind === "foundry" ? azure.currency : undefined;

    if (optionsResult.error !== undefined) {
        return (
            <SourceError
                {...SOURCE}
                alias={consumptionConnection}
                message={optionsResult.error}
                onRetry={optionsResult.refetch}
            />
        );
    }

    if (sources.row && !hasConsumptionData(sources.row)) {
        return (
            <SourceEmpty
                {...SOURCE}
                title="No consumption yet"
                description="Consumption Central is connected, but its model holds no Cowork, Copilot Studio or Azure usage. Once its lakehouse is loaded and the model refreshes, this page fills in."
            />
        );
    }

    return (
        <div className="flex flex-col gap-800">
            <RatesBar azureCurrency={azureCurrency} />
            <OverviewStage />
            <BudgetRunwayStage options={options} azure={azure} sources={sources.row} />
            <CoworkStage options={options} rates={rates} />
            <StudioStage options={options} rates={rates} />
            <AzureStage options={options} />
        </div>
    );
}
