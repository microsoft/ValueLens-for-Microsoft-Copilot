//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { VegaVisual } from "@microsoft/fabric-visuals";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { useThemeContext } from "@/hooks/theme.context";
import { useSemanticModelQuery } from "@/hooks/use-semantic-model-query";
import { readNumber, readText, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { taskBreakdown, taskDimensions, workSummary, type TaskDimension } from "@/queries/work";

/** Which summary columns each cohort card reads. */
const cards = [
    { id: "all", label: "Everyone", tasks: "[All Tasks]", users: "[All Users]", rate: "[All Rate]" },
    { id: "licensed", label: "Licensed", tasks: "[Licensed Tasks]", users: "[Licensed Users]", rate: "[Licensed Rate]" },
    {
        id: "unlicensed",
        label: "Unlicensed",
        tasks: "[Unlicensed Tasks]",
        users: "[Unlicensed Users]",
        rate: "[Unlicensed Rate]",
    },
    { id: "agents", label: "Agents", tasks: "[Agent Tasks]", users: "[Agent Users]", rate: "[Agent Rate]" },
] as const;

/**
 * Stage one of the Work destination: how much got done, and what kind of work
 * it was.
 *
 * Power BI spends thirty-nine visuals across the Activity page on this. Here
 * it is two queries — one row of headline figures covering all four cohorts,
 * and one breakdown carrying all three lenses at once.
 */
export function TasksStage() {
    const [dimension, setDimension] = useState<TaskDimension>("behaviour");
    const { theme } = useThemeContext();

    const summary = useSemanticModelQuery(workSummary());
    const breakdown = useMemo(() => taskBreakdown({ dimension }), [dimension]);
    const breakdownResult = useSemanticModelQuery({
        connection: breakdown.connection,
        query: breakdown.query,
    });

    const summaryRow = useMemo(
        () => (summary.data?.status === "success" ? toSummaryRow(summary.data.table) : undefined),
        [summary.data],
    );

    const breakdownTable = useMemo(
        () =>
            breakdownResult.data?.status === "success"
                ? toDataTable(breakdownResult.data.table, breakdown.columnMetadata)
                : undefined,
        [breakdownResult.data, breakdown.columnMetadata],
    );

    const topOutcome = readText(summaryRow, "[Top Value Outcome]");

    return (
        <Section
            eyebrow="Stage 1"
            title="Tasks"
            description="How much work Copilot was asked to do, by whom, and what kind of work it was."
        >
            {summary.data?.status === "error" ? (
                <QueryError message={summary.data.error.message} onRetry={summary.refetch} />
            ) : summary.isLoading || !summary.data ? (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    {cards.map((card) => (
                        <QueryLoading key={card.id} />
                    ))}
                </div>
            ) : !summaryRow ? (
                <QueryEmpty
                    title="No activity recorded"
                    description="The semantic model returned no rows. Check that the model has been refreshed since the last data load."
                />
            ) : (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    {cards.map((card) => (
                        <KpiCard
                            key={card.id}
                            label={card.label}
                            value={readNumber(summaryRow, card.tasks)}
                            emphasis={card.id === "all"}
                            detail={
                                <div className="flex flex-col gap-100">
                                    <KpiStat label="Active users" value={readNumber(summaryRow, card.users)} />
                                    <KpiStat
                                        label="Tasks per user"
                                        value={readNumber(summaryRow, card.rate)}
                                        format="rate"
                                    />
                                </div>
                            }
                        />
                    ))}
                </div>
            )}

            {topOutcome && (
                <p className="border-l-2 border-primary pl-400 text-[length:var(--text-400)] leading-400 text-foreground">
                    The benefit people report most often is {topOutcome.toLowerCase()}.
                </p>
            )}

            <div className="flex flex-col gap-300">
                <div className="flex flex-wrap items-center justify-between gap-300">
                    <p className="max-w-[68ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">
                        {breakdown.subtitle}.
                    </p>
                    <SegmentedControl
                        label="Breakdown"
                        options={taskDimensions}
                        value={dimension}
                        onChange={setDimension}
                    />
                </div>

                <div className="h-[460px]">
                    {breakdownResult.data?.status === "error" ? (
                        <QueryError
                            className="h-full"
                            message={breakdownResult.data.error.message}
                            onRetry={breakdownResult.refetch}
                        />
                    ) : breakdownResult.isLoading || !breakdownTable ? (
                        <QueryLoading className="h-full" />
                    ) : breakdownTable.rows.length === 0 ? (
                        <QueryEmpty
                            className="h-full"
                            title="Nothing to break down"
                            description="No rows carry a classification. Enrichment has to run before tasks can be grouped this way."
                        />
                    ) : (
                        <VegaVisual
                            spec={breakdown.vegaLiteSpec}
                            data={breakdownTable}
                            theme={theme}
                            header={{
                                title: `Tasks by ${breakdown.label.toLowerCase()}`,
                                subtitle: breakdown.subtitle,
                            }}
                        />
                    )}
                </div>
            </div>
        </Section>
    );
}
