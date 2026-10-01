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
import { useOrgAttribute } from "@/hooks/filter.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import type { FilterKey } from "@/lib/filters";
import { rowChartHeight } from "@/lib/chart-height";
import { withOrgAttribute } from "@/lib/org-attribute";
import { readNumber, readText, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { activationByOrg, activationSummary, type ActivationCohort } from "@/queries/adoption";

/** The cohort cards already split licensed, unlicensed and agent use, so those filters would only blank cards out. */
const COHORT_FILTERS: FilterKey[] = ["licence", "audience"];
/** Activation counts people who haven't used anything yet, so narrowing to an agent would call everyone else inactive. */
const AGENT_FILTERS: FilterKey[] = ["agentTypes", "agentNames"];
const IGNORED: FilterKey[] = [...COHORT_FILTERS, ...AGENT_FILTERS];

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
    const org = useOrgAttribute();

    const summary = useFilteredQuery(activationSummary(), { ignore: IGNORED });
    const byOrg = useMemo(() => withOrgAttribute(activationByOrg({ cohort }), org), [cohort, org]);
    const orgResult = useFilteredQuery({ connection: byOrg.connection, query: byOrg.query }, { ignore: IGNORED });

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
            id={stageAnchor("activation")}
            title="Activation"
            description="How much of the population has picked Copilot up at all — before asking how often or how deeply."
            actions={
                <SegmentedControl label="Cohort" options={cohorts} value={cohort} onChange={setCohort} />
            }
        >
            <FilterNote
                ignored={COHORT_FILTERS}
                reason="activation is shown for each cohort side by side — pick one with the cohort switch."
            />
            <FilterNote
                ignored={AGENT_FILTERS}
                reason="activation counts everyone, including people who haven't used an agent yet."
            />
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

            <div className="h-[420px]" style={orgTable ? { height: rowChartHeight(orgTable.rows.length, { chrome: 156 }) } : undefined}>
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
                        title={`No ${org.plural} to compare`}
                        description={`No rows carry a ${org.noun} value. Populate that column in the org data in the lakehouse to break activation down by team.`}
                    />
                ) : (
                    <VegaVisual
                        spec={byOrg.vegaLiteSpec}
                        data={orgTable}
                        theme={theme}
                        header={{
                            title: `${selected.label} activation by ${org.noun}`,
                            subtitle: "Active and inactive users, sharing a baseline",
                        }}
                    />
                )}
            </div>
        </Section>
    );
}
