//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useId, useMemo } from "react";
import { ArrowDown } from "lucide-react";
import { VegaVisual } from "@/components/vega-visual";
import { stageAnchor } from "@/components/destinations";
import { FilterNote } from "@/components/filter-note";
import { GradeMark } from "@/components/grade-mark";
import { KpiCard } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useFilterContext } from "@/hooks/filter.context";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { useOutcomeColors } from "@/hooks/use-palette-theme";
import { rowChartHeight } from "@/lib/chart-height";
import { outcomePalette, withColorScale } from "@/lib/color-scale";
import { type FilterKey, unlicensedOnly } from "@/lib/filters";
import { parseFitNotice } from "@/lib/fit-notice";
import { scrollToAnchor } from "@/lib/scroll-to-anchor";
import { readNumber, readText, toSummaryRow, type SummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { coworkFitSummary } from "@/queries/agents";
import { COWORK_GRADE_DOMAIN, coworkFitByTask, withGradeNames } from "@/queries/efficiency";
import { PeopleTable, WorkShapeTable } from "./cowork-fit-tables";

/** Cowork fit reads Cowork sessions by definition, so activity and agent filters would only blank it. */
const COWORK_ONLY: FilterKey[] = ["audience", "agentTypes", "agentNames"];

/** Room for the VegaVisual header, a top legend and the share axis. */
const LEGEND_CHART = { perRow: 44, chrome: 190 };

/** Automatic segment labels misplace shares once segments are reordered; the tooltip carries them. */
const NO_STACK_LABELS = { disableStackedDataLabels: true };

const SMALL = "text-[length:var(--text-200)] leading-200";
const BODY = "text-[length:var(--text-300)] leading-300";

/**
 * The two grade shares divide by graded sessions, so once either has a value
 * the other is zero rather than unknown.
 */
function gradedShares(row: SummaryRow | undefined) {
    const strong = readNumber(row, "[Strong Fit Share]");
    const worth = readNumber(row, "[Worth A Look Share]");
    const graded = strong !== undefined || worth !== undefined;
    return { strong: strong ?? (graded ? 0 : undefined), worth: worth ?? (graded ? 0 : undefined) };
}

function distinctCount(values: readonly unknown[]): number {
    return new Set(values).size;
}

/** The report's "what goes to Cowork" chart: each Task Breakdown split by grade. */
function FitByTaskChart() {
    const { theme } = useThemeContext();
    const outcomeColors = useOutcomeColors();
    const source = coworkFitByTask();
    const result = useFilteredQuery({ connection: source.connection, query: source.query }, { ignore: COWORK_ONLY });
    const table = useMemo(
        () =>
            result.data?.status === "success"
                ? withGradeNames(toDataTable(result.data.table, source.columnMetadata))
                : undefined,
        [result.data, source.columnMetadata],
    );
    const spec = useMemo(() => {
        const palette = outcomePalette(outcomeColors, theme);
        return withColorScale(source.vegaLiteSpec, COWORK_GRADE_DOMAIN, [palette.positive, palette.neutral, palette.caution]);
    }, [source.vegaLiteSpec, outcomeColors, theme]);

    const taskIndex = table?.columns.findIndex((column) => column.name === "Task") ?? -1;
    const tasks = table && taskIndex >= 0 ? distinctCount(table.rows.map((row) => row[taskIndex])) : 0;

    return (
        <div className="h-[400px]" style={table ? { height: rowChartHeight(tasks, LEGEND_CHART) } : undefined}>
            {result.data?.status === "error" ? (
                <QueryError className="h-full" message={result.data.error.message} onRetry={result.refetch} />
            ) : result.isLoading || !table ? (
                <QueryLoading className="h-full" />
            ) : table.rows.length === 0 ? (
                <QueryEmpty
                    className="h-full"
                    title="No tasks to grade"
                    description="No graded Cowork session in this selection carries a Task Breakdown."
                />
            ) : (
                <VegaVisual
                    spec={spec}
                    data={table}
                    theme={theme}
                    capabilities={NO_STACK_LABELS}
                    header={{
                        title: "What goes to Cowork",
                        subtitle: "Graded sessions for each Task Breakdown, by fit. Busiest first.",
                    }}
                />
            )}
        </div>
    );
}

/** The report's rule card: each grade at the current setting, the caveat and the counts, in the model's words. */
function FitRules({ notice }: { notice: string | undefined }) {
    const headingId = useId();
    const { grades, notes } = useMemo(() => parseFitNotice(notice), [notice]);
    return (
        <article aria-labelledby={headingId} className="flex flex-col rounded-xl border border-border bg-card">
            <h3
                id={headingId}
                className="border-b border-border px-500 py-400 text-[length:var(--text-400)] leading-400 font-semibold text-foreground"
            >
                How sessions are graded
            </h3>
            {grades.length > 0 && (
                <dl className="flex flex-col divide-y divide-border px-500">
                    {grades.map(({ grade, rule }) => (
                        <div key={grade.name} className="flex flex-col gap-100 py-300">
                            <dt className={`flex items-center gap-200 ${BODY} font-semibold text-foreground`}>
                                <GradeMark tone={grade.tone} />
                                {grade.name}
                            </dt>
                            <dd className={`${BODY} text-muted-foreground first-letter:uppercase`}>{rule}</dd>
                        </div>
                    ))}
                </dl>
            )}
            <div className="mt-auto flex flex-col gap-200 border-t border-border px-500 py-300">
                {notes.map((note) => (
                    <p key={note} className={`${SMALL} max-w-[68ch] text-muted-foreground`}>
                        {note}
                    </p>
                ))}
                <button
                    type="button"
                    onClick={() => scrollToAnchor(stageAnchor("grading-method"))}
                    className={`inline-flex w-fit items-center gap-100 ${SMALL} font-semibold text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
                >
                    How grading works, and the research behind it
                    <ArrowDown className="icon-size-100" aria-hidden="true" />
                </button>
            </div>
        </article>
    );
}

/**
 * The Cowork half of the Efficiency destination, laid out as the report's
 * Cowork fit page: six headline figures, what kind of work goes to Cowork,
 * how that work was done, and who is doing it, each graded by the weight of
 * the work.
 *
 * A tenant with no Cowork activity gets one plain statement, the model's own
 * notice, instead of a page of empty figures.
 */
export function CoworkFitStage() {
    const { filters, applicable } = useFilterContext();
    const summary = useFilteredQuery(coworkFitSummary(), { ignore: COWORK_ONLY });
    const unlicensed = unlicensedOnly(filters, applicable);

    const row = useMemo(
        () => (summary.data?.status === "success" ? toSummaryRow(summary.data.table) : undefined),
        [summary.data],
    );

    const sessions = readNumber(row, "[Cowork Sessions]");
    const notice = readText(row, "[Fit Notice]");
    const shares = gradedShares(row);

    return (
        <Section
            id={stageAnchor("cowork-fit")}
            title="Cowork fit"
            description="Whether the work people hand to Cowork suits it. Each session is graded by what it touched: many apps and sources suit Cowork; chat with nothing attached is worth a look."
        >
            <FilterNote ignored={COWORK_ONLY} reason="Cowork fit always reads every Cowork session." />
            {unlicensed ? (
                <QueryEmpty
                    title="No Cowork sessions for unlicensed people"
                    description="Cowork needs a Copilot license, so unlicensed people have no Cowork sessions to grade. Set License to All or Licensed."
                />
            ) : summary.data?.status === "error" ? (
                <QueryError message={summary.data.error.message} onRetry={summary.refetch} />
            ) : summary.isLoading || !summary.data ? (
                <div className="grid gap-300 md:grid-cols-3 xl:grid-cols-6">
                    {Array.from({ length: 6 }, (_, i) => (
                        <QueryLoading key={i} />
                    ))}
                </div>
            ) : sessions === undefined ? (
                <QueryEmpty
                    title="No Cowork activity to grade yet"
                    description={`${notice ? `${notice} ` : ""}Cowork sessions are graded here as soon as the audit log records them.`}
                />
            ) : (
                <>
                    <div className="grid gap-300 md:grid-cols-3 xl:grid-cols-6">
                        <KpiCard label="Cowork sessions" value={sessions} emphasis />
                        <KpiCard label="Tasks completed" value={readNumber(row, "[Tasks Completed]")} />
                        <KpiCard label="Active days per user" value={readNumber(row, "[Active Days Per User]")} format="hours" />
                        <KpiCard label="Expert equivalent hours" value={readNumber(row, "[Expert Hours]")} format="hours" />
                        <KpiCard label="Strong fit" value={shares.strong} format="percent" detail="Share of graded sessions" />
                        <KpiCard label="Worth a look" value={shares.worth} format="percent" detail="Share of graded sessions" />
                    </div>

                    <div className="grid grid-cols-1 items-start gap-500 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
                        <FitByTaskChart />
                        <FitRules notice={notice} />
                    </div>

                    <WorkShapeTable ignore={COWORK_ONLY} />
                    <PeopleTable ignore={COWORK_ONLY} />
                </>
            )}
        </Section>
    );
}
