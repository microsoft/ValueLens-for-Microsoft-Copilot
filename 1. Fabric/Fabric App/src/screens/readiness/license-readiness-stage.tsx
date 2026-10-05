//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { VegaVisual } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { stageAnchor } from "@/components/destinations";
import { FilterNote } from "@/components/filter-note";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { useM365Activity } from "@/hooks/use-m365-activity";
import { rowChartHeight } from "@/lib/chart-height";
import type { FilterKey } from "@/lib/filters";
import { formatKpi } from "@/lib/format-kpi";
import { columnFormat, columnHeat, heatRenderer } from "@/lib/heat";
import { withOrgAttribute } from "@/lib/org-attribute";
import { readNumber, readText, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import { SMALL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import {
    licenseCandidates,
    licenseCandidatesM365,
    licenseDemandSummary,
    licenseDormancy,
    licenseEstateSummary,
    licensePriorityByOrg,
} from "@/queries/licensing";

const LICENSE_ESTATE_IGNORES: FilterKey[] = ["dateRange", "organizations"];

function candidateColumns(orgLabel: string, table: DataTable | undefined, withBreadth: boolean): GridColumnDef[] {
    const columns: GridColumnDef[] = [
        { id: "Rank", header: "Rank", width: 88, numericStyling: true },
        { id: "User", header: "User", minWidth: 240 },
        { id: "Organization", header: orgLabel, minWidth: 160 },
        // Short headers, each wide enough for its sort arrow; the subtitle says sessions and active days are per week.
        // The user and organization share the rest.
        {
            id: "Priority Score",
            header: "Priority score",
            width: 124,
            numericStyling: true,
            cellRenderer: heatRenderer({
                domain: columnHeat(table, "Priority Score"),
                format: columnFormat(table, "Priority Score"),
            }),
        },
        { id: "Sessions Per Week", header: "Sessions", width: 96, numericStyling: true },
        { id: "Active Days Per Week", header: "Active days", width: 116, numericStyling: true },
    ];
    if (withBreadth) {
        columns.push({ id: "Workloads Per Day", header: "Workloads per day", width: 156, numericStyling: true });
    }
    return columns;
}

/**
 * The license half of the Readiness destination: demand from people already
 * using Copilot without a license, folded together with the idle licensed
 * estate the report kept on License Allocation.
 */
export function LicenseReadinessStage() {
    const { theme } = useThemeContext();
    const org = useOrgAttribute();

    const demand = useFilteredQuery(licenseDemandSummary());
    const estate = useFilteredQuery(licenseEstateSummary(), { ignore: LICENSE_ESTATE_IGNORES });
    const byOrg = useMemo(() => withOrgAttribute(licensePriorityByOrg(), org), [org]);
    const byOrgResult = useFilteredQuery({ connection: byOrg.connection, query: byOrg.query });
    // With Microsoft 365 activity matched to people, the score also weighs how widely they work across it.
    const m365 = useM365Activity();
    const withBreadth = m365.state === "ready" && !m365.concealed;
    const candidates = useMemo(
        () => withOrgAttribute(withBreadth ? licenseCandidatesM365() : licenseCandidates(), org),
        [withBreadth, org],
    );
    const candidatesResult = useFilteredQuery({
        connection: candidates.connection,
        query: m365.state === "loading" ? "" : candidates.query,
    });
    const dormancy = licenseDormancy();
    const dormancyResult = useFilteredQuery(
        { connection: dormancy.connection, query: dormancy.query },
        { ignore: LICENSE_ESTATE_IGNORES },
    );

    const demandRow = useMemo(
        () => (demand.data?.status === "success" ? toSummaryRow(demand.data.table) : undefined),
        [demand.data],
    );
    const estateRow = useMemo(
        () => (estate.data?.status === "success" ? toSummaryRow(estate.data.table) : undefined),
        [estate.data],
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
    const columns = useMemo(
        () => candidateColumns(org.label, candidatesTable, withBreadth),
        [org.label, candidatesTable, withBreadth],
    );
    const dormancyTable = useMemo(
        () =>
            dormancyResult.data?.status === "success"
                ? toDataTable(dormancyResult.data.table, dormancy.columnMetadata)
                : undefined,
        [dormancyResult.data, dormancy.columnMetadata],
    );

    const summaryError =
        demand.data?.status === "error"
            ? { message: demand.data.error.message, retry: demand.refetch }
            : estate.data?.status === "error"
              ? { message: estate.data.error.message, retry: estate.refetch }
              : undefined;
    const summaryLoading = demand.isLoading || !demand.data || estate.isLoading || !estate.data;
    const evidenceNotice = readText(estateRow, "[License Evidence Notice]");
    const reclaimNotice = readText(estateRow, "[Reclaim Cost Notice]");
    // The roster doesn't join to the people using Copilot, so everyone reads as unlicensed.
    const unreconciled = readNumber(estateRow, "[License Inventory Usable]") === 0;

    return (
        <Section
            id={stageAnchor("license-readiness")}
            title="License readiness"
            description="Who is already reaching for Copilot without a license, and which licenses are sitting idle."
        >
            {unreconciled && (
                <p role="status" className={cn(SMALL, "max-w-[90ch] rounded-md bg-secondary px-300 py-200 text-foreground")}>
                    Licenses don't match the people using Copilot, so everyone here counts as unlicensed and the list
                    below may include people who already have a license. This is usually because Microsoft 365 reports
                    hide user names: in the Microsoft 365 admin center, go to Settings &gt; Org settings &gt; Reports,
                    untick "Display concealed user, group, and site names in all reports", then run the pipeline again.
                </p>
            )}

            {summaryError ? (
                <QueryError message={summaryError.message} onRetry={summaryError.retry} />
            ) : summaryLoading ? (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-3">
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                </div>
            ) : !demandRow && !estateRow ? (
                <QueryEmpty
                    title="No license readiness data"
                    description="The semantic model returned no rows for the current selection."
                />
            ) : (
                <div className="grid gap-300 md:grid-cols-2 xl:grid-cols-3">
                    <KpiCard
                        label="Active unlicensed users"
                        value={readNumber(demandRow, "[Active Unlicensed Users]")}
                        emphasis
                        detail={
                            <div className="flex flex-col gap-100">
                                <KpiStat
                                    label="Share of active users"
                                    value={readNumber(demandRow, "[Unlicensed Share]")}
                                    format="percent"
                                />
                                <KpiStat
                                    label="Median sessions/user/week"
                                    value={readNumber(demandRow, "[Median Sessions Per User Per Week]")}
                                    format="rate"
                                />
                            </div>
                        }
                    />
                    <KpiCard
                        label="Observed unlicensed use"
                        value={readNumber(demandRow, "[Observed Sessions Per User Per Week]")}
                        format="rate"
                        detail="sessions per user per week, averaged across the active unlicensed population"
                    />
                    <KpiCard
                        label="License estate"
                        value={readNumber(estateRow, "[Total Licensed Users]")}
                        detail={
                            <KpiStat
                                label="Avg days since last active"
                                value={readNumber(estateRow, "[Avg Days Since Last Active]")}
                                format="hours"
                            />
                        }
                    />
                </div>
            )}

            <FilterNote
                ignored={LICENSE_ESTATE_IGNORES}
                reason="the estate card, dormancy chart and notices read the license roster, which is not dated and has no independent organization dimension."
            />

            <div
                className="h-[340px]"
                style={byOrgTable ? { height: rowChartHeight(byOrgTable.rows.length, { perRow: 40, chrome: 100 }) } : undefined}
            >
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
                        title={`No unlicensed demand by ${org.noun}`}
                        description={`No ${org.noun} has active unlicensed Copilot use in the current selection.`}
                    />
                ) : (
                    <VegaVisual
                        spec={byOrg.vegaLiteSpec}
                        data={byOrgTable}
                        theme={theme}
                        header={{
                            title: `Priority by ${org.noun}`,
                            subtitle: "Sessions per user per week among active unlicensed users",
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
                        title="Nobody to license next"
                        description="No active unlicensed users have enough observed activity to rank in the current selection."
                    />
                ) : (
                    <DataGrid
                        columns={columns}
                        data={candidatesTable}
                        defaultSort={[{ columnId: "Rank", direction: "asc" }]}
                        theme={theme}
                        header={{
                            title: "Who to license next",
                            subtitle: `${formatKpi(candidatesTable.rows.length, "whole")} unlicensed users, ranked by priority score${
                                withBreadth
                                    ? ": how much they use Copilot, and how many Microsoft 365 workloads they use a day"
                                    : ""
                            }. Sessions and active days are per week.${unreconciled ? " Some may already have a license: see the note above." : ""}`,
                        }}
                    />
                )}
            </div>

            <div
                className="h-[340px]"
                style={dormancyTable ? { height: rowChartHeight(dormancyTable.rows.length, { perRow: 40, chrome: 100 }) } : undefined}
            >
                {dormancyResult.data?.status === "error" ? (
                    <QueryError
                        className="h-full"
                        message={dormancyResult.data.error.message}
                        onRetry={dormancyResult.refetch}
                    />
                ) : dormancyResult.isLoading || !dormancyTable ? (
                    <QueryLoading className="h-full" />
                ) : dormancyTable.rows.length === 0 ? (
                    <QueryEmpty
                        className="h-full"
                        title={unreconciled ? "Dormancy can't be measured yet" : "No license roster"}
                        description={
                            unreconciled
                                ? "Licenses don't match the people using Copilot, so there's no way to tell which seats are idle. See the note at the top of this section."
                                : "The license inventory returned no dormancy buckets to show."
                        }
                    />
                ) : (
                    <VegaVisual
                        spec={dormancy.vegaLiteSpec}
                        data={dormancyTable}
                        theme={theme}
                        header={{
                            title: "Dormancy of the license estate",
                            subtitle: "Licensed users by last activity bucket",
                        }}
                    />
                )}
            </div>

            {(evidenceNotice || reclaimNotice) && (
                <div className="flex flex-col gap-200">
                    {evidenceNotice && (
                        <p className="max-w-[90ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">
                            {evidenceNotice}
                        </p>
                    )}
                    {reclaimNotice && (
                        <p className="max-w-[90ch] text-[length:var(--text-300)] leading-300 text-muted-foreground">
                            {reclaimNotice}
                        </p>
                    )}
                </div>
            )}
        </Section>
    );
}
