//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { VegaVisual } from "@microsoft/fabric-visuals";
import { stageAnchor } from "@/components/destinations";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { NoteCard, type Note } from "@/components/report-panels";
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { rowChartHeight } from "@/lib/chart-height";
import { formatDateRange } from "@/lib/filters";
import { formatKpi } from "@/lib/format-kpi";
import { readNumber, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { m365Summary, m365WorkloadReach, m365WorkloadTrend, readM365Coverage, type M365Coverage } from "@/queries/work-patterns";
import { CONCEALED_FIX, M365_ACTIVITY_DESCRIPTION, M365_ACTIVITY_TITLE } from "./copy";

const SUMMARY = m365Summary();
const TREND = m365WorkloadTrend();
const REACH = m365WorkloadReach();

const ROW_CHART = { perRow: 40, chrome: 100 };

const NOTES: Note[] = [
    {
        term: "People active",
        text: "Anyone who used at least one workload: Teams, Outlook, SharePoint, OneDrive, Viva Engage or the Office apps. Receiving email alone doesn't count.",
    },
    {
        term: "Per week",
        text: "Each figure is per active person, spread over the weeks that have data. Days with nothing loaded are left out, so a gap doesn't read as a quiet week.",
    },
    {
        term: "Week by week",
        text: "Only full Monday-to-Sunday weeks are plotted, so a part week at either end doesn't pull the line down.",
    },
    {
        term: "Source",
        text: "The Microsoft 365 usage reports, one row per person per day. They run two to three days behind, and recent days are read again as they fill in.",
    },
];

function days(count: number): string {
    return `${formatKpi(count, "whole")} ${count === 1 ? "day" : "days"}`;
}

/** Which days the averages rest on, and which they skip. */
function coverageText({ firstDate, lastDate, daysLoaded, missingDays }: M365Coverage): string {
    const span = `Per person, over ${formatDateRange(firstDate, lastDate)}`;
    const gaps =
        missingDays > 0
            ? `: ${days(daysLoaded)} with data. ${days(missingDays)} in that span ${missingDays === 1 ? "has" : "have"} none, and ${missingDays === 1 ? "is" : "are"} left out of the averages rather than counted as quiet.`
            : ".";
    return `${span}${gaps} The usage reports run two to three days behind, so the latest days fill in later.`;
}

interface M365ActivityStageProps {
    /** The usage reports hide user names, so nothing here can be matched to a person. */
    concealed: boolean;
}

/**
 * The shape of a working week on Microsoft 365, from the usage reports: how
 * many people are active, how often, and which workloads they reach for.
 * These are the reports' own daily counts, so they don't depend on Copilot
 * at all.
 */
export function M365ActivityStage({ concealed }: M365ActivityStageProps) {
    const { theme } = useThemeContext();

    const summary = useFilteredQuery(SUMMARY);
    const trendResult = useFilteredQuery(TREND);
    const reachResult = useFilteredQuery(REACH);

    const summaryRow = useMemo(
        () => (summary.data?.status === "success" ? toSummaryRow(summary.data.table) : undefined),
        [summary.data],
    );
    const trendTable = useMemo(
        () => (trendResult.data?.status === "success" ? toDataTable(trendResult.data.table, TREND.columnMetadata) : undefined),
        [trendResult.data],
    );
    const reachTable = useMemo(
        () => (reachResult.data?.status === "success" ? toDataTable(reachResult.data.table, REACH.columnMetadata) : undefined),
        [reachResult.data],
    );

    const people = readNumber(summaryRow, "[People Active]");
    const coverage = readM365Coverage(summaryRow);
    const reachHeight = reachTable?.rows.length ? rowChartHeight(reachTable.rows.length, ROW_CHART) : undefined;

    return (
        <Section id={stageAnchor("m365-activity")} title={M365_ACTIVITY_TITLE} description={M365_ACTIVITY_DESCRIPTION}>
            {concealed && (
                <p role="status" className={cn(SMALL, "max-w-[90ch] rounded-md bg-secondary px-300 py-200 text-foreground")}>
                    Microsoft 365 hides user names in its usage reports, so this activity can't be matched to people.
                    The figures on this page are right, but filtering by organization and comparing with Copilot use
                    won't work. {CONCEALED_FIX}
                </p>
            )}

            {summary.data?.status === "error" ? (
                <QueryError message={summary.data.error.message} onRetry={summary.refetch} />
            ) : summary.isLoading || !summary.data ? (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                </div>
            ) : !people ? (
                <QueryEmpty
                    title="Nobody active on Microsoft 365"
                    description="No one in the current selection has Microsoft 365 activity. Widen the dates or clear the organization filter."
                />
            ) : (
                <>
                    <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                        <KpiCard
                            label="People active"
                            value={people}
                            emphasis
                            detail={
                                <KpiStat
                                    label="Workloads per active day"
                                    value={readNumber(summaryRow, "[Workloads Per Active Day]")}
                                    format="rate"
                                />
                            }
                        />
                        <KpiCard
                            label="Active days per week"
                            value={readNumber(summaryRow, "[Active Days Per Week]")}
                            format="rate"
                            detail="per person, on any Microsoft 365 workload"
                        />
                        <KpiCard
                            label="Meetings per week"
                            value={readNumber(summaryRow, "[Meetings Per Week]")}
                            format="rate"
                            detail={
                                <KpiStat
                                    label="Hours on calls and meetings"
                                    value={readNumber(summaryRow, "[Call Hours Per Week]")}
                                    format="hours"
                                />
                            }
                        />
                        <KpiCard
                            label="Emails sent per week"
                            value={readNumber(summaryRow, "[Emails Sent Per Week]")}
                            format="rate"
                            detail={
                                <KpiStat
                                    label="Teams chat messages"
                                    value={readNumber(summaryRow, "[Chats Per Week]")}
                                    format="rate"
                                />
                            }
                        />
                    </div>
                    {coverage && (
                        <p className={cn(SMALL, "max-w-[80ch] text-muted-foreground")}>{coverageText(coverage)}</p>
                    )}
                </>
            )}

            <div className="h-[360px]">
                {trendResult.data?.status === "error" ? (
                    <QueryError className="h-full" message={trendResult.data.error.message} onRetry={trendResult.refetch} />
                ) : trendResult.isLoading || !trendTable ? (
                    <QueryLoading className="h-full" />
                ) : trendTable.rows.length === 0 ? (
                    <QueryEmpty
                        className="h-full"
                        title="No complete weeks yet"
                        description="The trend only plots full Monday-to-Sunday weeks, and the selection doesn't cover one."
                    />
                ) : (
                    <VegaVisual
                        spec={TREND.vegaLiteSpec}
                        data={trendTable}
                        theme={theme}
                        header={{
                            title: "Which workloads people use, week by week",
                            subtitle: "Share of the people active on Microsoft 365 that week who used each workload.",
                        }}
                    />
                )}
            </div>

            <div className="grid gap-400 xl:grid-cols-2">
                <div className="h-[340px]" style={reachHeight ? { height: reachHeight } : undefined}>
                    {reachResult.data?.status === "error" ? (
                        <QueryError className="h-full" message={reachResult.data.error.message} onRetry={reachResult.refetch} />
                    ) : reachResult.isLoading || !reachTable ? (
                        <QueryLoading className="h-full" />
                    ) : reachTable.rows.length === 0 ? (
                        <QueryEmpty
                            className="h-full"
                            title="No workload activity"
                            description="Nobody in the current selection used a Microsoft 365 workload."
                        />
                    ) : (
                        <VegaVisual
                            spec={REACH.vegaLiteSpec}
                            data={reachTable}
                            theme={theme}
                            header={{
                                title: "How far each workload reaches",
                                subtitle: "Share of active people, with days per week in the tooltip.",
                            }}
                        />
                    )}
                </div>

                <div className="xl:self-start">
                    <NoteCard title="How these figures are worked out" notes={NOTES} />
                </div>
            </div>
        </Section>
    );
}
