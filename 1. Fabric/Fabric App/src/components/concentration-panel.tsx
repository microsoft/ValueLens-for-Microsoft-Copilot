//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useMemo } from "react";
import { ChartPanel } from "@/components/report-panels";
import type { TableResult } from "@/hooks/use-table-query";
import {
    concentration,
    concentrationHeadline,
    paretoSpec,
    paretoTable,
    sliceLabel,
    TOP_SLICES,
    type Concentration,
} from "@/lib/concentration";
import { formatKpi } from "@/lib/format-kpi";
import { MIN_PEOPLE, shareText } from "@/lib/headline";
import { SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

interface ConcentrationPanelProps {
    /** The query the values come from, for its loading and error states. */
    result: TableResult;
    /** One value per person, read from the result's table. */
    values: readonly number[] | undefined;
    /** What the values are, mid-sentence: "sessions", "credits". */
    noun: string;
    title: string;
    subtitle: string;
    emptyTitle: string;
    emptyDescription: string;
    height?: number;
}

function SliceFigures({ result }: { result: Concentration }) {
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
    values,
    noun,
    title,
    subtitle,
    emptyTitle,
    emptyDescription,
    height = 320,
}: ConcentrationPanelProps) {
    const summary = useMemo(() => (values ? concentration(values) : undefined), [values]);
    const table = useMemo(() => (result.table ? paretoTable(summary) : undefined), [result.table, summary]);
    const spec = useMemo(() => paretoSpec(noun), [noun]);
    const headline = useCallback(() => concentrationHeadline(summary, noun), [summary, noun]);

    return (
        <div className="flex flex-col gap-300">
            <ChartPanel
                result={result}
                table={table}
                height={height}
                spec={spec}
                title={title}
                subtitle={subtitle}
                headline={headline}
                emptyTitle={emptyTitle}
                emptyDescription={emptyDescription}
            />
            {summary && <SliceFigures result={summary} />}
        </div>
    );
}
