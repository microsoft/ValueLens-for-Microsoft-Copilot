//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { VegaVisual } from "@microsoft/fabric-visuals";
import { stageAnchor } from "@/components/destinations";
import { FilterNote } from "@/components/filter-note";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { useFilterContext } from "@/hooks/filter.context";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { LADDER_VARS, useLadderColors } from "@/hooks/use-palette-theme";
import type { FilterKey } from "@/lib/filters";
import { formatKpi } from "@/lib/format-kpi";
import { readNumber, readText, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { habitStages, habitSummary, habitThresholds, habitTrend, habitTrendMonths, inactiveNotMeasuredFor } from "@/queries/adoption";

/** Stages place every licensed person, so narrowing to one agent would call everyone else inactive. */
const AGENT_FILTERS: FilterKey[] = ["agentTypes", "agentNames"];

/** Whether the monthly mix is plotted as a share of users or as a headcount. */
const habitScales = [
    { id: "share", label: "Share" },
    { id: "count", label: "Count" },
] as const;

const monthFormat = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** "June 2026" from the model's `2026-06-01T00:00:00`. */
function formatMonth(value: string | undefined): string | undefined {
    if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined;
    return monthFormat.format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

/**
 * Stage three of the funnel: whether use has become a habit.
 *
 * The five stage cards are one query, and the monthly mix is a second. In the
 * report these are twenty-seven visuals.
 */
export function HabitStage() {
    const [scale, setScale] = useState<"share" | "count">("share");
    const { theme } = useThemeContext();
    const { filters, applicable } = useFilterContext();
    const ladderColors = useLadderColors();

    const summary = useFilteredQuery(habitSummary(), { ignore: AGENT_FILTERS });
    const trend = useMemo(() => habitTrend({ scale, colors: ladderColors }), [scale, ladderColors]);
    const trendResult = useFilteredQuery({ connection: trend.connection, query: trend.query }, { ignore: AGENT_FILTERS });

    const summaryRow = useMemo(
        () => (summary.data?.status === "success" ? toSummaryRow(summary.data.table) : undefined),
        [summary.data],
    );

    const trendTable = useMemo(
        () =>
            trendResult.data?.status === "success"
                ? toDataTable(trendResult.data.table, trend.columnMetadata)
                : undefined,
        [trendResult.data, trend.columnMetadata],
    );

    const month = formatMonth(readText(summaryRow, "[Month]"));
    const notMeasuredFor = inactiveNotMeasuredFor(filters, applicable);

    return (
        <Section
            id={stageAnchor("habit-formation")}
            title="Habit formation"
            description="Where people sit on the ladder from licensed but idle to relying on Copilot nearly every day, judged by how many days they used it in a month."
            actions={<SegmentedControl label="Trend scale" options={habitScales} value={scale} onChange={setScale} />}
        >
            <FilterNote
                ignored={AGENT_FILTERS}
                reason="habit stages place every licensed person, so narrowing to one agent would count everyone else as inactive."
            />
            {summary.data?.status === "error" ? (
                <QueryError message={summary.data.error.message} onRetry={summary.refetch} />
            ) : summary.isLoading || !summary.data ? (
                <QueryLoading />
            ) : !summaryRow || !month ? (
                <QueryEmpty
                    title="No complete month"
                    description="Habit stages are placed on a complete month. The selected dates don't reach one yet."
                />
            ) : (
                <div className="flex flex-col gap-200">
                    <p className="max-w-[80ch] text-[length:var(--text-200)] leading-200 text-muted-foreground">
                        Placed on {month}, the most recent complete month in the selected dates. An active day is
                        any day with at least one Copilot or agent interaction.
                    </p>
                    <ol className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                        {habitStages.map((stage, index) => {
                            const share = readNumber(summaryRow, `[${stage} Pct]`);
                            const count = readNumber(summaryRow, `[${stage}]`);
                            const threshold = habitThresholds[stage];
                            const unmeasured = stage === "Inactive" ? notMeasuredFor : undefined;
                            return (
                                <li key={stage} className="relative flex items-center gap-400 px-400 py-300">
                                    <span
                                        aria-hidden="true"
                                        className="absolute inset-y-0 left-0 bg-accent"
                                        style={{ width: `${(share ?? 0) * 100}%` }}
                                    />
                                    <span
                                        aria-hidden="true"
                                        className="relative size-300 shrink-0 rounded-sm"
                                        style={{ backgroundColor: `var(${LADDER_VARS[index]})` }}
                                    />
                                    <span className="relative flex min-w-0 flex-1 flex-col">
                                        <span className="flex flex-wrap items-baseline gap-x-200">
                                            <span className="text-[length:var(--text-300)] leading-300 font-semibold text-card-foreground">
                                                {stage}
                                            </span>
                                            <span className="font-numeric text-[length:var(--text-200)] leading-200 text-card-foreground">
                                                {threshold.rule}
                                            </span>
                                        </span>
                                        <span className="text-[length:var(--text-200)] leading-200 text-muted-foreground">
                                            {unmeasured ? `Not measured for ${unmeasured}` : threshold.meaning}
                                        </span>
                                    </span>
                                    <span className="relative font-numeric tabular-nums text-[length:var(--text-300)] text-muted-foreground">
                                        {formatKpi(count, "whole")} users
                                    </span>
                                    <span className="relative w-[5ch] text-right font-numeric font-semibold tabular-nums text-[length:var(--text-500)] leading-500 text-card-foreground">
                                        {formatKpi(share, "percent")}
                                    </span>
                                </li>
                            );
                        })}
                    </ol>
                </div>
            )}

            <div className="h-[380px]">
                {trendResult.data?.status === "error" ? (
                    <QueryError
                        className="h-full"
                        message={trendResult.data.error.message}
                        onRetry={trendResult.refetch}
                    />
                ) : trendResult.isLoading || !trendTable ? (
                    <QueryLoading className="h-full" />
                ) : habitTrendMonths(trendTable.rows) < 2 ? (
                    <QueryEmpty
                        className="h-full"
                        title="Not enough months"
                        description="At least two complete months in the selected dates are needed before the habit mix can be trended."
                    />
                ) : (
                    <VegaVisual
                        spec={trend.vegaLiteSpec}
                        data={trendTable}
                        theme={theme}
                        header={{
                            title: "How the mix is moving",
                            subtitle:
                                scale === "share"
                                    ? "Share of users in each stage by complete month, Power on top"
                                    : "Users in each stage by complete month, Power on top",
                        }}
                    />
                )}
            </div>
        </Section>
    );
}