//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { stageAnchor } from "@/components/destinations";
import { OpenDestinationFooter, OpenDestinationLink } from "@/components/open-destination-link";
import { ChartPanel, NoteCard } from "@/components/report-panels";
import { Section } from "@/components/section";
import { formatKpi } from "@/lib/format-kpi";
import { readNumber } from "@/lib/summary-row";
import { CONSUMPTION_CONFIGURED } from "@/screens/value/cost-vs-value-data";
import type { ExecutiveData } from "./use-executive-data";

const CHART_HEIGHT = 340;
const TREND_SUBTITLE = "Six months to the end of the date range; months before it are faded";

/** Whether the work, and what it consumes, is growing month by month. */
export function GrowingStage({ data }: { data: ExecutiveData }) {
    const { months, monthsSource, credits, creditsSource, summary } = data;
    const kinds = readNumber(summary.row, "[Skills Available]");

    return (
        <Section
            id={stageAnchor("is-it-growing")}
            title="Is it growing?"
            description={
                CONSUMPTION_CONFIGURED
                    ? "Expert-equivalent hours and credits consumed each month, on one timeline. Each colour is the same source in both charts."
                    : "Expert-equivalent hours each month, by where the work was done."
            }
            actions={
                <OpenDestinationLink destination="value" stage="task-breakdown">
                    Open Value
                </OpenDestinationLink>
            }
        >
            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <div className="flex min-w-0 flex-col gap-300">
                    <ChartPanel
                        result={months}
                        spec={monthsSource.vegaLiteSpec}
                        height={CHART_HEIGHT}
                        title="Work delivered by month"
                        subtitle={`Expert-equivalent hours. ${TREND_SUBTITLE}`}
                        emptyTitle="No work in these months"
                        emptyDescription="There's no Copilot activity in the six months to the end of the date range."
                    />
                    {CONSUMPTION_CONFIGURED && (
                        <ChartPanel
                            result={credits}
                            spec={creditsSource.vegaLiteSpec}
                            height={CHART_HEIGHT}
                            title="Credits consumed by month"
                            subtitle={`Whole tenant. ${TREND_SUBTITLE}`}
                            emptyTitle="No credits in these months"
                            emptyDescription="Consumption Central has no Copilot Studio or Cowork credits in the six months to the end of the date range."
                        />
                    )}
                </div>
                <div className="xl:self-start">
                    <NoteCard
                        title="How this is worked out"
                        notes={[
                            {
                                term: "Expert-equivalent hours",
                                text: "Each task counts the minutes an expert typically takes to do it without Copilot, from the Signal → Impact table. Typical effort; Conservative and Optimistic give the range.",
                            },
                            {
                                term: "Tasks",
                                text:
                                    kinds === undefined
                                        ? "Copilot interactions, each sorted into a kind of work."
                                        : `Copilot interactions, sorted into ${formatKpi(kinds, "whole")} kinds of work.`,
                            },
                            {
                                term: "Unique skills",
                                text: "How many different kinds of work a person used Copilot for in the date range. General Chat and General Assistance don't count.",
                            },
                            {
                                term: "Credits",
                                text: CONSUMPTION_CONFIGURED
                                    ? "Copilot Studio and Cowork credits from Consumption Central, for the whole tenant."
                                    : undefined,
                            },
                        ]}
                    >
                        <OpenDestinationFooter destination="value" stage="cost-vs-value">
                            Need it in money? Open Cost vs value
                        </OpenDestinationFooter>
                    </NoteCard>
                </div>
            </div>
        </Section>
    );
}
