//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { stageAnchor } from "@/components/destinations";
import { QueryError } from "@/components/query-states";
import { Section } from "@/components/section";
import { readText } from "@/lib/summary-row";
import { consumptionNotes, consumptionOptions, readConsumptionOptions } from "@/queries/consumption";
import { AzureStage } from "./azure-stage";
import { CoworkStage } from "./cowork-stage";
import { OverviewStage } from "./overview-stage";
import { BODY, useConsumptionSummary, useConsumptionTable } from "./data";
import { StudioStage } from "./studio-stage";

/**
 * Consumption Central's consumption and cost pages: every product side by
 * side, then Cowork / Work IQ, Copilot Studio and Azure in turn. The slicer
 * choices and credit rates are read once here and shared by every stage.
 */
export function ConsumptionScreen() {
    const optionsResult = useConsumptionTable(consumptionOptions());
    const options = useMemo(
        () => (optionsResult.table ? readConsumptionOptions(optionsResult.table) : undefined),
        [optionsResult.table],
    );
    const notes = useConsumptionSummary(consumptionNotes());
    const rates = readText(notes.row, "[Rates In Use]");

    if (optionsResult.error !== undefined) {
        return (
            <Section
                id={stageAnchor("consumption-overview")}
                title="Consumption"
                description="This page reads the Consumption Central semantic model."
            >
                <p className={`${BODY} max-w-[68ch] text-muted-foreground`}>
                    Bind Consumption Central to this app as the <code className="font-mono">cc</code> connection, then
                    reload. Until it is bound, credit and cost figures can't be shown.
                </p>
                <QueryError message={optionsResult.error} onRetry={optionsResult.refetch} />
            </Section>
        );
    }

    return (
        <div className="flex flex-col gap-800">
            <OverviewStage />
            <CoworkStage options={options} rates={rates} />
            <StudioStage options={options} rates={rates} />
            <AzureStage options={options} />
        </div>
    );
}
