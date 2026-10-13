//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { ChartPanel, NoteCard } from "@/components/report-panels";
import { studioAzureBilling, studioAzureDaily, type ConsumptionLens } from "@/queries/consumption";
import { billedText, readAzureBilling, subscriptionText } from "./azure-billing";
import { useConsumptionSummary, useConsumptionTable } from "./data";
import { AZURE_BILLED_COST_HEADLINE, AZURE_BILLED_CREDITS_HEADLINE } from "./headlines";

// A label on each daily bar can't fit; the tooltip carries the numbers.
const NO_STACK_LABELS = { disableStackedDataLabels: true };

interface AzureBilledPanelProps {
    lens: ConsumptionLens;
    extra: readonly string[];
}

/**
 * Copilot Studio and Cowork pay-as-you-go as Azure Cost Management billed it
 * to each billing policy's subscription. Left out entirely when the model has
 * no CopilotPaygSpend table or Azure billed nothing in the period.
 */
export function AzureBilledPanel({ lens, extra }: AzureBilledPanelProps) {
    const summary = useConsumptionSummary(studioAzureBilling(), extra);
    const source = studioAzureDaily(lens);
    const daily = useConsumptionTable(source, extra);
    const billing = readAzureBilling(summary);
    if (!billing) return null;

    const cost = lens === "cost";
    // Several currencies are added up as billed, unconverted, so no share of their cost is given.
    const headline = cost ? (billing.currency ? AZURE_BILLED_COST_HEADLINE : undefined) : AZURE_BILLED_CREDITS_HEADLINE;
    const subtitle = [billing.window, subscriptionText(billing.subscriptions), billing.currency ?? billing.currencies]
        .filter(Boolean)
        .join(" · ");

    return (
        <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
            <ChartPanel
                result={daily}
                spec={source.vegaLiteSpec}
                capabilities={NO_STACK_LABELS}
                height={300}
                title={cost ? "Pay-as-you-go billed in Azure" : "Pay-as-you-go credits billed in Azure"}
                headline={headline}
                subtitle={subtitle}
                emptyTitle="Nothing billed in Azure"
                emptyDescription="Azure Cost Management has no Copilot pay-as-you-go charges in this period."
            />
            <NoteCard
                title="What Azure billed"
                notes={[
                    { term: "Copilot Studio", text: billedText(billing, billing.studioCost, billing.studioCredits) },
                    { term: "Cowork", text: billedText(billing, billing.coworkCost, billing.coworkCredits) },
                    { term: "Other Copilot meters", text: billing.otherCost ? billedText(billing, billing.otherCost) : undefined },
                    {
                        term: "Total",
                        text: billing.totalCost === undefined ? undefined : `${billedText(billing, billing.totalCost)} across ${subscriptionText(billing.subscriptions)}`,
                    },
                    {
                        term: "Currencies",
                        text: billing.currency ? undefined : `Billed in ${billing.currencies}. The totals add them as billed, unconverted.`,
                    },
                    {
                        term: "Versus the export",
                        text: "The figures above price the export's credits at the app's rate. These are the charges Azure Cost Management recorded, so timing and rates can differ.",
                    },
                ]}
            />
        </div>
    );
}
