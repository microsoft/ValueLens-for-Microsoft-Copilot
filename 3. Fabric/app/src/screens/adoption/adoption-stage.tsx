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
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import type { FilterKey } from "@/lib/filters";
import { readNumber, readText, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { adoptionSummary, adoptionTrend, type AdoptionTrendMeasure } from "@/queries/adoption";

/** The four surfaces usage is reported across. */
const surfaces = [
    { id: "overall", label: "Overall", usersColumn: "[Overall Users]", rateColumn: "[Overall SPUW]" },
    { id: "licensed", label: "Licensed chat", usersColumn: "[Licensed Users]", rateColumn: "[Licensed SPUW]" },
    { id: "unlicensed", label: "Unlicensed chat", usersColumn: "[Unlicensed Users]", rateColumn: "[Unlicensed SPUW]" },
    { id: "agents", label: "Agents", usersColumn: "[Agent Users]", rateColumn: "[Agent SPUW]" },
] as const;

/** Every card and trend line here is already one surface, so these filters would only blank some out. */
const SURFACE_FILTERS: FilterKey[] = ["licence", "audience"];

const trendMeasures: { id: AdoptionTrendMeasure; label: string }[] = [
    { id: "sessionsPerUser", label: "Per user" },
    { id: "sessions", label: "Sessions" },
    { id: "hours", label: "Hours" },
];

/**
 * Stage two of the funnel: how much the people who activated actually use it.
 *
 * Sessions per user per week is the spine of this stage — it is the one figure
 * that is comparable across licensed chat, unlicensed chat and agents.
 */
export function AdoptionStage() {
    const [measure, setMeasure] = useState<AdoptionTrendMeasure>("sessionsPerUser");
    const { theme } = useThemeContext();

    const summary = useFilteredQuery(adoptionSummary(), { ignore: SURFACE_FILTERS });
    const trend = useMemo(() => adoptionTrend({ measure }), [measure]);
    const trendResult = useFilteredQuery({ connection: trend.connection, query: trend.query }, { ignore: SURFACE_FILTERS });

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

    const topOutcome = readText(summaryRow, "[Overall Top Outcome]");
    const coworkUsers = readNumber(summaryRow, "[Cowork Users]");

    return (
        <Section
            id={stageAnchor("adoption")}
            title="Adoption"
            description="How often the activated population comes back, measured the same way across every surface."
            actions={
                <SegmentedControl
                    label="Trend measure"
                    options={trendMeasures}
                    value={measure}
                    onChange={setMeasure}
                />
            }
        >
            <FilterNote
                ignored={SURFACE_FILTERS}
                reason="licensed chat, unlicensed chat and agents are each shown in their own card and line."
            />
            {summary.data?.status === "error" ? (
                <QueryError message={summary.data.error.message} onRetry={summary.refetch} />
            ) : summary.isLoading || !summary.data ? (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    {surfaces.map((surface) => (
                        <QueryLoading key={surface.id} />
                    ))}
                </div>
            ) : !summaryRow ? (
                <QueryEmpty
                    title="No adoption data"
                    description="The semantic model returned no rows for the current selection."
                />
            ) : (
                <>
                    <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                        {surfaces.map((surface) => (
                            <KpiCard
                                key={surface.id}
                                label={surface.label}
                                value={readNumber(summaryRow, surface.rateColumn)}
                                format="rate"
                                emphasis={surface.id === "overall"}
                                detail={
                                    <div className="flex flex-col gap-100">
                                        <span className="block pb-100">sessions per user per week</span>
                                        <KpiStat
                                            label="Active users"
                                            value={readNumber(summaryRow, surface.usersColumn)}
                                        />
                                        {surface.id === "overall" && (
                                            <KpiStat
                                                label="Sessions"
                                                value={readNumber(summaryRow, "[Overall Sessions]")}
                                            />
                                        )}
                                        {surface.id === "agents" && (
                                            <KpiStat
                                                label="Return rate"
                                                value={readNumber(summaryRow, "[Agent Return Rate]")}
                                                format="percent"
                                            />
                                        )}
                                    </div>
                                }
                            />
                        ))}
                    </div>

                    <div className="grid gap-300 md:grid-cols-3">
                        <KpiCard
                            label="Hours per week"
                            value={readNumber(summaryRow, "[Overall Hours Wk]")}
                            format="hours"
                            detail="Expert-equivalent time returned across the whole population"
                        />
                        <div className="flex flex-col gap-200 rounded-xl border border-border bg-card p-500 md:col-span-2">
                            <span className="text-[length:var(--text-200)] leading-200 text-muted-foreground">
                                Top value outcome
                            </span>
                            <span className="text-[length:var(--text-500)] leading-500 font-semibold text-card-foreground">
                                {topOutcome ?? "Not yet established"}
                            </span>
                            <p className="border-t border-border pt-200 text-[length:var(--text-200)] leading-300 text-muted-foreground">
                                {coworkUsers === undefined
                                    ? "Cowork is not reporting any activity in this tenant, so outcomes reflect chat and agents only."
                                    : "The outcome category contributing the most expert-equivalent hours."}
                            </p>
                        </div>
                    </div>
                </>
            )}

            <div className="h-[420px]">
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
                        title="No weekly history"
                        description="There are no dated interactions in the current selection, so there is nothing to trend."
                    />
                ) : (
                    <VegaVisual
                        spec={trend.vegaLiteSpec}
                        data={trendTable}
                        theme={theme}
                        header={{
                            title: "Weekly adoption trend",
                            subtitle: "Each point is a calendar week",
                        }}
                    />
                )}
            </div>
        </Section>
    );
}
