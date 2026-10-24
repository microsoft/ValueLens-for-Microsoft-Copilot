//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { VegaVisual } from "@/components/vega-visual";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { stageAnchor } from "@/components/destinations";
import { HEADLINE_SPACE, Headlined } from "@/components/headlined";
import { leaderHeadline } from "@/lib/headline";
import { KpiCard } from "@/components/kpi-card";
import { OnDemand } from "@/components/on-demand";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { TruncationNote } from "@/components/truncation-note";
import { useThemeContext } from "@/hooks/theme.context";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { rowChartHeight } from "@/lib/chart-height";
import { formatKpi } from "@/lib/format-kpi";
import { listCount, listTotal } from "@/lib/list-total";
import { columnFormat, columnHeat, heatRenderer } from "@/lib/heat";
import { withOrgAttribute } from "@/lib/org-attribute";
import { readNumber, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { topNote, topRows } from "@/lib/top-n";
import {
    coworkCandidates,
    coworkReadinessByOrg,
    coworkReadinessSummary,
    isDepthUniform,
} from "@/queries/agents";

const BY_ORG_HEADLINE = leaderHeadline({
    label: "Organization",
    value: "Eligible Users",
    of: "people yet to try Cowork",
});

function candidateColumns(orgLabel: string, table: DataTable | undefined): GridColumnDef[] {
    return [
        {
            id: "Rank",
            header: "Rank",
            width: 88,
            numericStyling: true,
            // Rank 1 is the readiest, so the heat runs the other way.
            cellRenderer: heatRenderer({
                domain: columnHeat(table, "Rank", { reverse: true }),
                format: columnFormat(table, "Rank"),
            }),
        },
        { id: "User", header: "User", width: 260 },
        { id: "Organization", header: orgLabel, minWidth: 160 },
        { id: "Surfaces Per Day", header: "Apps per active day", numericStyling: true },
        { id: "Prompts Per Session", header: "Prompts per session", numericStyling: true },
        { id: "Uses Agents", header: "Uses agents" },
    ];
}

/**
 * The Cowork half of the Readiness destination: who could be offered Cowork
 * next, among everyone who uses Copilot but has not tried it.
 *
 * The model's readiness score weighs breadth of everyday use most, then
 * depth, then whether someone already uses agents. The report plots breadth
 * against depth as a scatter; here breadth takes the chart and the ranked
 * list does the rest. Both wait for a click, so the cards load first.
 */
export function CoworkReadinessStage() {
    const org = useOrgAttribute();
    const summary = useFilteredQuery(coworkReadinessSummary());
    const summaryRow = useMemo(
        () => (summary.data?.status === "success" ? toSummaryRow(summary.data.table) : undefined),
        [summary.data],
    );

    return (
        <Section
            id={stageAnchor("cowork-readiness")}
            title="Cowork readiness"
            description="Who to offer Cowork next. Everyone here uses Copilot but has not tried Cowork; the broader and deeper their everyday use, the readier they are."
        >
            {summary.data?.status === "error" ? (
                <QueryError message={summary.data.error.message} onRetry={summary.refetch} />
            ) : summary.isLoading || !summary.data ? (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                </div>
            ) : !summaryRow ? (
                <QueryEmpty
                    title="Nobody to assess"
                    description="The semantic model returned no rows. Check that the model has been refreshed since the last data load."
                />
            ) : (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-4">
                    <KpiCard label="Could be offered Cowork" value={readNumber(summaryRow, "[Eligible Users]")} emphasis />
                    <KpiCard
                        label="Apps used per active day"
                        value={readNumber(summaryRow, "[Surfaces Per Day]")}
                        format="rate"
                    />
                    <KpiCard
                        label="Prompts per session"
                        value={readNumber(summaryRow, "[Prompts Per Session]")}
                        format="rate"
                    />
                    <KpiCard
                        label="Already using agents"
                        value={readNumber(summaryRow, "[Agent User Share]")}
                        format="percent"
                    />
                </div>
            )}

            <OnDemand
                id="cowork-readiness-by-org"
                label={`Show by ${org.noun}`}
                note={`Breadth of everyday use for each ${org.noun}, among people yet to try Cowork.`}
            >
                <CoworkReadinessByOrg />
            </OnDemand>

            <OnDemand
                id="cowork-candidates"
                label="Show the people"
                note="Everyone yet to try Cowork, readiest first."
            >
                <CoworkCandidates />
            </OnDemand>
        </Section>
    );
}

function CoworkReadinessByOrg() {
    const { theme } = useThemeContext();
    const org = useOrgAttribute();
    const byOrg = useMemo(() => withOrgAttribute(coworkReadinessByOrg(), org), [org]);
    const byOrgResult = useFilteredQuery({ connection: byOrg.connection, query: byOrg.query });
    const byOrgTable = useMemo(
        () =>
            byOrgResult.data?.status === "success"
                ? toDataTable(byOrgResult.data.table, byOrg.columnMetadata)
                : undefined,
        [byOrgResult.data, byOrg.columnMetadata],
    );
    // The headline reads every organization; the chart shows the fifteen with the most eligible people.
    const byOrgHeadline = useMemo(() => (byOrgTable ? BY_ORG_HEADLINE(byOrgTable) : undefined), [byOrgTable]);
    const top = useMemo(
        () => (byOrgTable ? topRows(byOrgTable, { label: "Organization", by: "Eligible Users" }) : undefined),
        [byOrgTable],
    );

    return (
        <div className="h-[340px]" style={top ? { height: rowChartHeight(top.table.rows.length, { perRow: 40, chrome: 100 }) + (byOrgHeadline ? HEADLINE_SPACE : 0) } : undefined}>
            {byOrgResult.data?.status === "error" ? (
                <QueryError className="h-full" message={byOrgResult.data.error.message} onRetry={byOrgResult.refetch} />
            ) : byOrgResult.isLoading || !top ? (
                <QueryLoading className="h-full" />
            ) : top.table.rows.length === 0 ? (
                <QueryEmpty
                    className="h-full"
                    title={`No ${org.plural} to compare`}
                    description="Nobody without Cowork has recorded Copilot use in this period."
                />
            ) : (
                <Headlined text={byOrgHeadline}>
                    <VegaVisual
                        spec={byOrg.vegaLiteSpec}
                        data={top.table}
                        theme={theme}
                        header={{
                            title: `Breadth of use by ${org.noun}`,
                            subtitle:
                                topNote(top, org.plural, "eligible users") ??
                                "Apps used per active day, among people who have not tried Cowork",
                        }}
                    />
                </Headlined>
            )}
        </div>
    );
}

function CoworkCandidates() {
    const { theme } = useThemeContext();
    const org = useOrgAttribute();
    const candidates = useMemo(() => withOrgAttribute(coworkCandidates(), org), [org]);
    const candidatesResult = useFilteredQuery({ connection: candidates.connection, query: candidates.query });
    const candidatesTable = useMemo(
        () =>
            candidatesResult.data?.status === "success"
                ? toDataTable(candidatesResult.data.table, candidates.columnMetadata)
                : undefined,
        [candidatesResult.data, candidates.columnMetadata],
    );
    const columns = useMemo(() => candidateColumns(org.label, candidatesTable), [org.label, candidatesTable]);
    const depthUniform = candidatesTable ? isDepthUniform(candidatesTable) : false;

    return (
        <>
            {depthUniform && (
                <p className="max-w-[80ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">
                    Every candidate averages the same number of prompts per session, so depth does not separate
                    anyone yet. Breadth of everyday use and agent use decide the ranking.
                </p>
            )}

            <div className="flex h-[560px] flex-col">
                {candidatesResult.data?.status === "error" ? (
                    <QueryError
                        className="h-full"
                        message={candidatesResult.data.error.message}
                        onRetry={candidatesResult.refetch}
                    />
                ) : candidatesResult.isLoading || !candidatesTable ? (
                    <QueryLoading className="h-full" />
                ) : candidatesTable.rows.length === 0 ? (
                    <QueryEmpty
                        className="h-full"
                        title="Nobody to rank"
                        description="Everyone with recorded Copilot use has already tried Cowork, or nobody has used Copilot in this period."
                    />
                ) : (
                    <DataGrid
                        columns={columns}
                        data={candidatesTable}
                        defaultSort={[{ columnId: "Rank", direction: "asc" }]}
                        theme={theme}
                        header={{
                            title: "Who to offer Cowork next",
                            subtitle: `${formatKpi(listCount(candidatesTable), "whole")} people, readiest first`,
                        }}
                    />
                )}
            </div>
            {candidatesTable && !candidatesResult.isLoading && candidatesResult.data?.status === "success" && (
                <TruncationNote shown={candidatesTable.rows.length} total={listTotal(candidatesTable)} noun="people" by="by readiness" />
            )}
        </>
    );
}
