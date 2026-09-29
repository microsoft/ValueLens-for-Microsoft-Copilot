//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { stageAnchor } from "@/components/destinations";
import { FilterNote } from "@/components/filter-note";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import type { FilterKey } from "@/lib/filters";
import { readNumber, readText, toSummaryRow } from "@/lib/summary-row";
import { coworkFitSummary } from "@/queries/agents";

/** Cowork fit reads Cowork sessions by definition, so activity and agent filters would only blank it. */
const COWORK_ONLY: FilterKey[] = ["audience", "agentTypes", "agentNames"];

/**
 * The Cowork half of the Efficiency destination: whether the work people hand
 * to Cowork suits it.
 *
 * The report fills this page with shares and hours that are all blank until
 * Cowork sessions reach the audit log. Here a tenant with no Cowork activity
 * gets one plain statement — the model's own notice — instead of a wall of
 * empty figures.
 */
export function CoworkFitStage() {
    const summary = useFilteredQuery(coworkFitSummary(), { ignore: COWORK_ONLY });

    const row = useMemo(
        () => (summary.data?.status === "success" ? toSummaryRow(summary.data.table) : undefined),
        [summary.data],
    );

    const sessions = readNumber(row, "[Cowork Sessions]");
    const notice = readText(row, "[Fit Notice]");

    return (
        <Section
            id={stageAnchor("cowork-fit")}
            title="Cowork fit"
            description="How well the work people hand to Cowork suits it, graded by the weight of each task. Sessions the classifier could not place are left out of both shares."
        >
            <FilterNote ignored={COWORK_ONLY} reason="Cowork fit always reads every Cowork session." />
            {summary.data?.status === "error" ? (
                <QueryError message={summary.data.error.message} onRetry={summary.refetch} />
            ) : summary.isLoading || !summary.data ? (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                </div>
            ) : sessions === undefined ? (
                <QueryEmpty
                    title="No Cowork activity to grade yet"
                    description={`${notice ? `${notice} ` : ""}Cowork sessions are graded here as soon as the audit log records them.`}
                />
            ) : (
                <>
                    <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                        <KpiCard
                            label="Cowork sessions"
                            value={sessions}
                            emphasis
                            detail={
                                <div className="flex flex-col gap-100">
                                    <KpiStat label="People" value={readNumber(row, "[Cowork Users]")} />
                                    <KpiStat
                                        label="Hours of work"
                                        value={readNumber(row, "[Cowork Hours]")}
                                        format="hours"
                                    />
                                </div>
                            }
                        />
                        <KpiCard label="Graded sessions" value={readNumber(row, "[Graded Sessions]")} />
                        <KpiCard label="Strong fit" value={readNumber(row, "[Strong Fit Share]")} format="percent" />
                        <KpiCard label="Low fit" value={readNumber(row, "[Low Fit Share]")} format="percent" />
                    </div>
                    {notice && (
                        <p className="max-w-[80ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">
                            {notice}
                        </p>
                    )}
                </>
            )}
        </Section>
    );
}
