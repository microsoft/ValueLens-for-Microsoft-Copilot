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
import { activationByOrg, activationSummary, type ActivationCohort } from "@/queries/adoption";

/** The four cohorts the Activation page reports on, in reading order. */
const cohorts: {
    id: ActivationCohort;
    label: string;
    activeColumn: string;
    inactiveColumn: string;
    totalColumn?: string;
    percentColumn: string;
    headlineColumn: string;
    activeLabel: string;
    inactiveLabel: string;
}[] = [
    {
        id: "all",
        label: "Everyone",
        activeColumn: "[All Active]",
        inactiveColumn: "[All Inactive]",
        totalColumn: "[All Total]",
        percentColumn: "[All Active Pct]",
        headlineColumn: "[Headline Overall]",
        activeLabel: "Active",
        inactiveLabel: "Inactive",
    },
    {
        id: "licensed",
        label: "Licensed",
        activeColumn: "[Licensed Active]",
        inactiveColumn: "[Licensed Inactive]",
        totalColumn: "[Licensed Total]",
        percentColumn: "[Licensed Active Pct]",
        headlineColumn: "[Headline Licensed]",
        activeLabel: "Active",
        inactiveLabel: "Inactive",
    },
    {
        id: "unlicensed",
        label: "Unlicensed",
        activeColumn: "[Unlicensed Active]",
        inactiveColumn: "[Unlicensed Inactive]",
        totalColumn: "[Unlicensed Total]",
        percentColumn: "[Unlicensed Active Pct]",
        headlineColumn: "[Headline Unlicensed]",
        activeLabel: "Observed",
        inactiveLabel: "Not observed",
    },
    {
        id: "agents",
        label: "Agents",
        activeColumn: "[Agent Active]",
        inactiveColumn: "[Agent NotUsing]",
        percentColumn: "[Agent Active Pct]",
        headlineColumn: "[Headline Agents]",
        activeLabel: "Using agents",
        inactiveLabel: "Not using agents",
    },
];

/**
 * Stage one of the funnel: who has ever picked Copilot up.
 *
 * Power BI spends thirty-one visuals on this page. Here it is two queries —
 * one for every headline figure across all four cohorts, one for the
 * per-organization split that all four cohorts share.
 */
export function ActivationStage() {
    const [cohort, setCohort] = useState<ActivationCohort>("all");
    const { theme } = useThemeContext();

    const summary = useSemanticModelQuery(activationSummary());
    const byOrg = useMemo(() => activationByOrg({ cohort }), [cohort]);
    const orgResult = useSemanticModelQuery({ connection: byOrg.connection, query: byOrg.query });

    const summaryRow = useMemo(
        () => (summary.data?.status === "success" ? toSummaryRow(summary.data.table) : undefined),
        [summary.data],
    );

    const orgTable = useMemo(
        () =>
            orgResult.data?.status === "success"
                ? toDataTable(orgResult.data.table, byOrg.columnMetadata)
                : undefined,
        [orgResult.data, byOrg.columnMetadata],
    );

    const selected = cohorts.find((entry) => entry.id === cohort) ?? cohorts[0];
    const headline = readText(summaryRow, selected.headlineColumn);

    return (
        <Section
            eyebrow="Stage 1"
            title="Activation"
            description="How much of the population has picked Copilot up at all — before asking how often or how deeply."
            actions={
                <SegmentedControl label="Cohort" options={cohorts} value={cohort} onChange={setCohort} />
            }
        >
            {summary.data?.status === "error" ? (
                <QueryError message={summary.data.error.message} onRetry={summary.refetch} />
            ) : summary.isLoading || !summary.data ? (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    {cohorts.map((entry) => (
                        <QueryLoading key={entry.id} />
                    ))}
                </div>
            ) : !summaryRow ? (
                <QueryEmpty
                    title="No activation data"
                    description="The semantic model returned no rows. Check that the model has been refreshed since the last data load."
                />
            ) : (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    {cohorts.map((entry) => (
                        <KpiCard
                            key={entry.id}
                            label={entry.label}
                            value={readNumber(summaryRow, entry.percentColumn)}
                            format="percent"
                            emphasis={entry.id === cohort}
                            detail={
                                <div className="flex flex-col gap-100">
                                    <KpiStat
                                        label={entry.activeLabel}
                                        value={readNumber(summaryRow, entry.activeColumn)}
                                    />
                                    <KpiStat
                                        label={entry.inactiveLabel}
                                        value={readNumber(summaryRow, entry.inactiveColumn)}
                                    />
                                    {entry.totalColumn && (
                                        <KpiStat
                                            label="Population"
                                            value={readNumber(summaryRow, entry.totalColumn)}
                                        />
                                    )}
                                </div>
                            }
                        />
                    ))}
                </div>
            )}

            {headline && (
                <p className="border-l-2 border-primary pl-400 text-[length:var(--text-400)] leading-400 text-foreground">
                    {headline}
                </p>
            )}

            <div className="h-[420px]">
                {orgResult.data?.status === "error" ? (
                    <QueryError
                        className="h-full"
                        message={orgResult.data.error.message}
                        onRetry={orgResult.refetch}
                    />
                ) : orgResult.isLoading || !orgTable ? (
                    <QueryLoading className="h-full" />
                ) : orgTable.rows.length === 0 ? (
                    <QueryEmpty
                        className="h-full"
                        title="No organizations to compare"
                        description="No rows carry an organization value. Populate the organization mapping in the lakehouse to break activation down by team."
                    />
                ) : (
                    <VegaVisual
                        spec={byOrg.vegaLiteSpec}
                        data={orgTable}
                        theme={theme}
                        header={{
                            title: `${selected.label} activation by organization`,
                            subtitle: "Active and inactive users, sharing a baseline",
                        }}
                    />
                )}
            </div>
        </Section>
    );
}
