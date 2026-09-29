//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { VegaVisual } from "@microsoft/fabric-visuals";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useSemanticModelQuery } from "@/hooks/use-semantic-model-query";
import { formatKpi } from "@/lib/format-kpi";
import { readNumber, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { cn } from "@/lib/utils";
import { habitStages, habitSummary, habitTrend } from "@/queries/adoption";

const stageDescriptions: Record<string, string> = {
    Power: "Daily reliance",
    Habitual: "Most working days",
    Developing: "A few times a week",
    Beginner: "Occasional use",
    Inactive: "No recorded use",
};

/**
 * Stage three of the funnel: whether use has become a habit.
 *
 * The five stage cards are one query, and the monthly mix is a second. In the
 * report these are twenty-seven visuals.
 */
export function HabitStage() {
    const [scale, setScale] = useState<"share" | "count">("share");
    const { theme } = useThemeContext();

    const summary = useSemanticModelQuery(habitSummary());
    const trend = useMemo(() => habitTrend({ scale }), [scale]);
    const trendResult = useSemanticModelQuery({ connection: trend.connection, query: trend.query });

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

    return (
        <Section
            eyebrow="Stage 3"
            title="Habit formation"
            description="Where the population sits on the ladder from never using Copilot to relying on it daily."
        >
            {summary.data?.status === "error" ? (
                <QueryError message={summary.data.error.message} onRetry={summary.refetch} />
            ) : summary.isLoading || !summary.data ? (
                <QueryLoading />
            ) : !summaryRow ? (
                <QueryEmpty
                    title="No habit data"
                    description="Habit stages are derived from the most recent complete month. None was found in the current selection."
                />
            ) : (
                <ol className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                    {habitStages.map((stage) => {
                        const share = readNumber(summaryRow, `[${stage} Pct]`);
                        const count = readNumber(summaryRow, `[${stage}]`);
                        return (
                            <li key={stage} className="relative flex items-center gap-400 px-400 py-300">
                                <span
                                    aria-hidden="true"
                                    className="absolute inset-y-0 left-0 bg-accent"
                                    style={{ width: `${(share ?? 0) * 100}%` }}
                                />
                                <span className="relative flex flex-1 flex-col">
                                    <span className="text-[length:var(--text-300)] leading-300 font-semibold text-card-foreground">
                                        {stage}
                                    </span>
                                    <span className="text-[length:var(--text-200)] leading-200 text-muted-foreground">
                                        {stageDescriptions[stage]}
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
                ) : trendTable.rows.length === 0 ? (
                    <QueryEmpty
                        className="h-full"
                        title="No monthly history"
                        description="At least two complete months are needed before the habit mix can be trended."
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
                                    ? "Share of users in each stage, by month"
                                    : "Users in each stage, by month",
                        }}
                    />
                )}
            </div>

            <div role="group" aria-label="Scale" className="flex self-end rounded-md border border-border bg-card p-100-nudge">
                {(["share", "count"] as const).map((option) => (
                    <button
                        key={option}
                        type="button"
                        onClick={() => setScale(option)}
                        aria-pressed={option === scale}
                        className={cn(
                            "rounded-sm px-300 py-100 text-[length:var(--text-200)] capitalize transition-colors",
                            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                            option === scale
                                ? "bg-accent font-semibold text-accent-foreground"
                                : "text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {option}
                    </button>
                ))}
            </div>
        </Section>
    );
}
