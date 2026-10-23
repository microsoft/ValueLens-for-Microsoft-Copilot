//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useId, useMemo, type ReactNode } from "react";
import { Headlined } from "@/components/headlined";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { ChartPanel } from "@/components/report-panels";
import type { TableResult } from "@/hooks/use-table-query";
import {
    concentrationHeadline,
    concentrationIncomplete,
    paretoSpec,
    paretoTable,
    sliceLabel,
    TOP_SLICES,
    type Concentration,
    type ConcentrationSlices,
} from "@/lib/concentration";
import { formatKpi } from "@/lib/format-kpi";
import { MIN_PEOPLE, shareText } from "@/lib/headline";
import { SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

interface ConcentrationPanelProps {
    /** The query the figures come from, for its loading and error states. */
    result: TableResult;
    /** The figures read from the result's table, undefined when nobody has a value. */
    summary: Concentration | undefined;
    /** What the values are, mid-sentence: "sessions", "credits". */
    noun: string;
    title: string;
    subtitle: string;
    emptyTitle: string;
    emptyDescription: ReactNode;
    height?: number;
}

/** The result, failed when its rows came back but couldn't be read as whole figures. */
function checkedResult(result: TableResult, summary: ConcentrationSlices | undefined): TableResult {
    return !result.isLoading && result.error === undefined && concentrationIncomplete(result.table, summary)
        ? { ...result, error: "The concentration totals are incomplete. Retry to load the full result." }
        : result;
}

function SliceFigures({ result }: { result: ConcentrationSlices }) {
    return (
        <dl className="grid grid-cols-3 gap-300">
            {TOP_SLICES.map((pct) => {
                const slice = result.slices.find((candidate) => candidate.pct === pct);
                return (
                    <div key={pct} className="flex flex-col gap-100 border-t border-border pt-200">
                        <dt className={cn(SMALL, "text-muted-foreground")}>Top {sliceLabel(pct)} of people</dt>
                        <dd className="text-[length:var(--text-500)] leading-500 font-numeric font-semibold tabular-nums text-foreground">
                            {slice ? shareText(slice.share, 1) : "—"}
                        </dd>
                        <dd className={cn(SMALL, "text-muted-foreground")}>
                            {slice
                                ? `${formatKpi(slice.people, "whole")} ${slice.people === 1 ? "person" : "people"}`
                                : `Under ${MIN_PEOPLE} people`}
                        </dd>
                    </div>
                );
            })}
        </dl>
    );
}

/**
 * How much of a total the busiest people account for: the share taken by the
 * top 1%, 5% and 25%, and the Pareto curve behind them. A slice of fewer than
 * five people shows a dash rather than a share.
 */
export function ConcentrationPanel({
    result,
    summary,
    noun,
    title,
    subtitle,
    emptyTitle,
    emptyDescription,
    height = 320,
}: ConcentrationPanelProps) {
    const table = useMemo(() => (result.table ? paretoTable(summary) : undefined), [result.table, summary]);
    const spec = useMemo(() => paretoSpec(noun), [noun]);
    const headline = useCallback(() => concentrationHeadline(summary, noun), [summary, noun]);
    const checked = checkedResult(result, summary);

    return (
        <div className="flex flex-col gap-300">
            <ChartPanel
                result={checked}
                table={table}
                height={height}
                spec={spec}
                title={title}
                subtitle={subtitle}
                headline={headline}
                emptyTitle={emptyTitle}
                emptyDescription={emptyDescription}
            />
            {!result.isLoading && result.error === undefined && summary && <SliceFigures result={summary} />}
        </div>
    );
}

type ConcentrationCalloutsProps = Omit<ConcentrationPanelProps, "summary" | "height"> & {
    /** The slices read from the result's table, undefined when nobody has a value. */
    summary: ConcentrationSlices | undefined;
};

/**
 * The share taken by the top 1%, 5% and 25% on their own, for a query that
 * returns only their cuts, so there is no curve. It reads as one card, with
 * the same headline, figures and states as {@link ConcentrationPanel}.
 */
export function ConcentrationCallouts({
    result,
    summary,
    noun,
    title,
    subtitle,
    emptyTitle,
    emptyDescription,
}: ConcentrationCalloutsProps) {
    const headingId = useId();
    const checked = checkedResult(result, summary);

    if (checked.error !== undefined) return <QueryError message={checked.error} onRetry={checked.refetch} />;
    if (checked.isLoading || !checked.table) return <QueryLoading />;
    if (!summary) return <QueryEmpty title={emptyTitle} description={emptyDescription} />;
    return (
        <Headlined text={concentrationHeadline(summary, noun)}>
            <article
                aria-labelledby={headingId}
                className="flex flex-col gap-400 rounded-xl border border-border bg-card p-500"
                data-export=""
                data-export-title={title}
            >
                <header className="flex flex-col gap-100">
                    <h3 id={headingId} className="text-[length:var(--text-300)] leading-300 font-semibold text-foreground">
                        {title}
                    </h3>
                    <p className={cn(SMALL, "text-muted-foreground")}>{subtitle}</p>
                </header>
                <SliceFigures result={summary} />
            </article>
        </Headlined>
    );
}
