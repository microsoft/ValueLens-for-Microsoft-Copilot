//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Headlined, HEADLINE_SPACE } from "@/components/headlined";
import { VegaVisual } from "@/components/vega-visual";
import { stageAnchor } from "@/components/destinations";
import { FilterNote } from "@/components/filter-note";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { useFilterContext } from "@/hooks/filter.context";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { selectedCohort, unshownActivity, type FilterKey } from "@/lib/filters";
import { readNumber, readText, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { taskBreakdown, taskDimensions, topOutcome, workSummary, type TaskDimension } from "@/queries/work";
import { TASK_BREAKDOWN_HEADLINES } from "./headlines";

/** The breakdown chart's plot height; a headline adds its own room above. */
const BREAKDOWN_HEIGHT = 460;

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

/** Each card is already one cohort, so these filters pick the card to highlight instead. */
const COHORT_FILTERS: FilterKey[] = ["licence", "audience"];
const PICKABLE = ["licensed", "unlicensed", "agents"] as const;

/**
 * The Value destination's task breakdown: how much got done, and what kind of
 * work it was.
 *
 * Power BI spends thirty-nine visuals across the Activity page on this. Here
 * it is three queries — one row of headline figures with every cohort side by
 * side, the most common benefit for the selected group, and one breakdown
 * carrying all three lenses at once.
 */
export function TasksStage() {
    const [dimension, setDimension] = useState<TaskDimension>("behaviour");
    const { theme } = useThemeContext();
    const { filters, applicable } = useFilterContext();
    const cohort = selectedCohort(filters, applicable, PICKABLE);
    const highlighted = cards.find((card) => card.id === cohort) ?? cards[0];
    const unshown = unshownActivity(filters, applicable, PICKABLE);
    const cohortReason = unshown
        ? `${unshown} has no card of its own, so ${highlighted.label} is highlighted.`
        : `every group is shown side by side, so ${highlighted.label} is highlighted.`;

    const summary = useFilteredQuery(workSummary(), { ignore: COHORT_FILTERS });
    const outcome = useFilteredQuery(topOutcome());
    const breakdown = useMemo(() => taskBreakdown({ dimension }), [dimension]);
    const breakdownResult = useFilteredQuery({
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

    const benefit = useMemo(
        () => (outcome.data?.status === "success" ? readText(toSummaryRow(outcome.data.table), "[Top Value Outcome]") : undefined),
        [outcome.data],
    );

    // The benefit sentence above already names the leading value outcome, so that lens isn't headlined twice.
    const breakdownHeadline = useMemo(
        () =>
            breakdownTable && !(dimension === "outcome" && benefit)
                ? TASK_BREAKDOWN_HEADLINES[dimension](breakdownTable)
                : undefined,
        [breakdownTable, dimension, benefit],
    );

    return (
        <Section
            id={stageAnchor("task-breakdown")}
            title="Task breakdown"
            description="How much work Copilot was asked to do, by whom, and what kind of work it was."
        >
            <FilterNote ignored={COHORT_FILTERS} scope="to the cards" reason={cohortReason} />
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
                            emphasis={card.id === highlighted.id}
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

            {benefit && (
                <p className="border-l-2 border-primary pl-400 text-[length:var(--text-400)] leading-400 text-foreground">
                    The benefit people report most often is {benefit.toLowerCase()}.
                </p>
            )}

            <div className="flex flex-col gap-300">
                <div className="flex flex-wrap items-center gap-300">
                    <span aria-hidden="true" className="text-[length:var(--text-300)] leading-300 font-semibold text-foreground">
                        Break down by
                    </span>
                    <SegmentedControl
                        label="Break down by"
                        options={taskDimensions}
                        value={dimension}
                        onChange={setDimension}
                    />
                </div>

                <div style={{ height: BREAKDOWN_HEIGHT + (breakdownHeadline ? HEADLINE_SPACE : 0) }}>
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
                        <Headlined text={breakdownHeadline}>
                            <VegaVisual
                                spec={breakdown.vegaLiteSpec}
                                data={breakdownTable}
                                theme={theme}
                                header={{
                                    title: breakdown.title,
                                    subtitle: breakdown.subtitle,
                                }}
                            />
                        </Headlined>
                    )}
                </div>
            </div>
        </Section>
    );
}
