//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { VegaVisual } from "@microsoft/fabric-visuals";
import { stageAnchor } from "@/components/destinations";
import { KpiCard } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { formatKpi } from "@/lib/format-kpi";
import { readNumber, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import {
    coworkCandidates,
    coworkReadinessByOrg,
    coworkReadinessSummary,
    isDepthUniform,
} from "@/queries/agents";

const candidateColumns: GridColumnDef[] = [
    { id: "Rank", header: "Rank", width: 88, numericStyling: true },
    { id: "User", header: "User", minWidth: 240 },
    { id: "Organization", header: "Organization", minWidth: 160 },
    { id: "Surfaces Per Day", header: "Apps per active day", numericStyling: true },
    { id: "Prompts Per Session", header: "Prompts per session", numericStyling: true },
    { id: "Uses Agents", header: "Uses agents" },
];

/**
 * The Cowork half of the Readiness destination: who could be offered Cowork
 * next, among everyone who uses Copilot but has not tried it.
 *
 * The model's readiness score weighs breadth of everyday use most, then
 * depth, then whether someone already uses agents. The report plots breadth
 * against depth as a scatter; here breadth takes the chart and the ranked
 * list does the rest.
 */
export function CoworkReadinessStage() {
    const { theme } = useThemeContext();

    const summary = useFilteredQuery(coworkReadinessSummary());
    const byOrg = coworkReadinessByOrg();
    const byOrgResult = useFilteredQuery({ connection: byOrg.connection, query: byOrg.query });
    const candidates = coworkCandidates();
    const candidatesResult = useFilteredQuery({ connection: candidates.connection, query: candidates.query });

    const summaryRow = useMemo(
        () => (summary.data?.status === "success" ? toSummaryRow(summary.data.table) : undefined),
        [summary.data],
    );
    const byOrgTable = useMemo(
        () =>
            byOrgResult.data?.status === "success"
                ? toDataTable(byOrgResult.data.table, byOrg.columnMetadata)
                : undefined,
        [byOrgResult.data, byOrg.columnMetadata],
    );
    const candidatesTable = useMemo(
        () =>
            candidatesResult.data?.status === "success"
                ? toDataTable(candidatesResult.data.table, candidates.columnMetadata)
                : undefined,
        [candidatesResult.data, candidates.columnMetadata],
    );

    const depthUniform = candidatesTable ? isDepthUniform(candidatesTable) : false;

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

            {depthUniform && (
                <p className="max-w-[80ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">
                    Every candidate averages the same number of prompts per session, so depth does not separate
                    anyone yet. Breadth of everyday use and agent use decide the ranking.
                </p>
            )}

            <div className="h-[340px]">
                {byOrgResult.data?.status === "error" ? (
                    <QueryError
                        className="h-full"
                        message={byOrgResult.data.error.message}
                        onRetry={byOrgResult.refetch}
                    />
                ) : byOrgResult.isLoading || !byOrgTable ? (
                    <QueryLoading className="h-full" />
                ) : byOrgTable.rows.length === 0 ? (
                    <QueryEmpty
                        className="h-full"
                        title="No organizations to compare"
                        description="Nobody without Cowork has recorded Copilot use in this period."
                    />
                ) : (
                    <VegaVisual
                        spec={byOrg.vegaLiteSpec}
                        data={byOrgTable}
                        theme={theme}
                        header={{
                            title: "Breadth of use by organization",
                            subtitle: "Apps used per active day, among people who have not tried Cowork",
                        }}
                    />
                )}
            </div>

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
                        columns={candidateColumns}
                        data={candidatesTable}
                        defaultSort={[{ columnId: "Rank", direction: "asc" }]}
                        theme={theme}
                        header={{
                            title: "Who to offer Cowork next",
                            subtitle: `${formatKpi(candidatesTable.rows.length, "whole")} people, readiest first`,
                        }}
                    />
                )}
            </div>
        </Section>
    );
}
