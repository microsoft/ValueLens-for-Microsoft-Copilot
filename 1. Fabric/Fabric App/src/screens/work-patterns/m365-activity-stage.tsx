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
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { rowChartHeight } from "@/lib/chart-height";
import { formatDateRange } from "@/lib/filters";
import { readNumber, readText, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { m365Apps, m365Summary, m365WorkloadReach, m365WorkloadTrend } from "@/queries/work-patterns";
import { CONCEALED_FIX, M365_ACTIVITY_DESCRIPTION, M365_ACTIVITY_TITLE } from "./copy";

const SUMMARY = m365Summary();
const TREND = m365WorkloadTrend();
const REACH = m365WorkloadReach();
const APPS = m365Apps();

const ROW_CHART = { perRow: 40, chrome: 100 };

interface M365ActivityStageProps {
    /** The usage reports hide user names, so nothing here can be matched to a person. */
    concealed: boolean;
}

/**
 * The shape of a working week on Microsoft 365, from the usage reports: how
 * many people are active, how often, and which workloads and apps they reach
 * for. These are the reports' own daily counts, so they don't depend on
 * Copilot at all.
 */
export function M365ActivityStage({ concealed }: M365ActivityStageProps) {
    const { theme } = useThemeContext();

    const summary = useFilteredQuery(SUMMARY);
    const trendResult = useFilteredQuery(TREND);
    const reachResult = useFilteredQuery(REACH);
    const appsResult = useFilteredQuery(APPS);

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
    const appsTable = useMemo(
        () => (appsResult.data?.status === "success" ? toDataTable(appsResult.data.table, APPS.columnMetadata) : undefined),
        [appsResult.data],
    );

    const people = readNumber(summaryRow, "[People Active]");
    const firstDate = readText(summaryRow, "[First Date]");
    const lastDate = readText(summaryRow, "[Last Date]");
    // Both bar charts list a handful of fixed rows, so they share one height and line up side by side.
    const barRows = Math.max(reachTable?.rows.length ?? 0, appsTable?.rows.length ?? 0);
    const barHeight = barRows > 0 ? rowChartHeight(barRows, ROW_CHART) : undefined;

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
                    {firstDate && lastDate && (
                        <p className={cn(SMALL, "max-w-[80ch] text-muted-foreground")}>
                            Per person, over {formatDateRange(firstDate, lastDate)}. The usage reports run two to three
                            days behind, so the latest days fill in later.
                        </p>
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
                <div className="h-[340px]" style={barHeight ? { height: barHeight } : undefined}>
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

                <div className="h-[340px]" style={barHeight ? { height: barHeight } : undefined}>
                    {appsResult.data?.status === "error" ? (
                        <QueryError className="h-full" message={appsResult.data.error.message} onRetry={appsResult.refetch} />
                    ) : appsResult.isLoading || !appsTable ? (
                        <QueryLoading className="h-full" />
                    ) : appsTable.rows.length === 0 ? (
                        <QueryEmpty
                            className="h-full"
                            title="No app activity"
                            description="Nobody in the current selection opened a Microsoft 365 app."
                        />
                    ) : (
                        <VegaVisual
                            spec={APPS.vegaLiteSpec}
                            data={appsTable}
                            theme={theme}
                            header={{
                                title: "Which apps people open",
                                subtitle: "Share of active people, on desktop, web or mobile.",
                            }}
                        />
                    )}
                </div>
            </div>
        </Section>
    );
}
