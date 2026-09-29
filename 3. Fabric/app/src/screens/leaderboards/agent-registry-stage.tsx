//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { VegaVisual } from "@microsoft/fabric-visuals";
import { Unlink } from "lucide-react";
import { stageAnchor } from "@/components/destinations";
import { FilterNote } from "@/components/filter-note";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import type { FilterKey } from "@/lib/filters";
import { formatKpi } from "@/lib/format-kpi";
import { columnFormat, columnHeat, heatRenderer } from "@/lib/heat";
import { readNumber, toSummaryRow } from "@/lib/summary-row";
import { toDataTable } from "@/lib/to-data-table";
import {
    agentActivitySummary,
    agentEstateSummary,
    agentLifecycle,
    agentRegistry,
    agentUsage,
    describeRegistryLinkage,
    type RegistryLinkage,
} from "@/queries/agents";

/**
 * The registry is a catalogue, not activity: narrowing it to a window or an
 * organization would drop every agent nobody used there, which is exactly the
 * part of the estate this stage exists to show. Agent type still applies.
 */
const CATALOGUE_IGNORES: FilterKey[] = ["dateRange", "organizations", "licence", "audience"];

/** The one sentence explaining how far usage could be tied back to the registry, if any is needed. */
function linkageMessage(linkage: RegistryLinkage): string | undefined {
    switch (linkage.kind) {
        case "none":
            return (
                `None of the ${formatKpi(linkage.unmatchedSessions, "whole")} agent sessions in the audit log ` +
                `match an agent in the registry, so the registry below carries no usage. The most-used ` +
                `agents chart reads names straight from the audit log instead.`
            );
        case "partial":
            return (
                `${formatKpi(linkage.unmatchedSessions, "whole")} agent sessions match no agent in the registry ` +
                `and are left out of its usage columns; ${formatKpi(linkage.seenInUse, "whole")} of ` +
                `${formatKpi(linkage.registryAgents, "whole")} registered agents are seen in use.`
            );
        default:
            return undefined;
    }
}

/**
 * The agent half of the Leaderboards destination: which agents people use,
 * and what the rest of the registry is doing.
 *
 * The report's Agent Registry page leans on the join between the audit log
 * and the Agent 365 registry for every figure. Here usage is read straight
 * from the audit log, the registry is described on its own terms, and when
 * the two do not line up the screen says so instead of reporting zero use.
 */
export function AgentRegistryStage() {
    const { theme } = useThemeContext();

    const activity = useFilteredQuery(agentActivitySummary());
    const estate = useFilteredQuery(agentEstateSummary(), { ignore: CATALOGUE_IGNORES });

    const usage = agentUsage();
    const usageResult = useFilteredQuery({ connection: usage.connection, query: usage.query });
    const lifecycle = agentLifecycle();
    const lifecycleResult = useFilteredQuery(
        { connection: lifecycle.connection, query: lifecycle.query },
        { ignore: CATALOGUE_IGNORES },
    );
    const registry = agentRegistry();
    const registryResult = useFilteredQuery(
        { connection: registry.connection, query: registry.query },
        { ignore: CATALOGUE_IGNORES },
    );

    const activityRow = useMemo(
        () => (activity.data?.status === "success" ? toSummaryRow(activity.data.table) : undefined),
        [activity.data],
    );
    const estateRow = useMemo(
        () => (estate.data?.status === "success" ? toSummaryRow(estate.data.table) : undefined),
        [estate.data],
    );
    const usageTable = useMemo(
        () =>
            usageResult.data?.status === "success"
                ? toDataTable(usageResult.data.table, usage.columnMetadata)
                : undefined,
        [usageResult.data, usage.columnMetadata],
    );
    const lifecycleTable = useMemo(
        () =>
            lifecycleResult.data?.status === "success"
                ? toDataTable(lifecycleResult.data.table, lifecycle.columnMetadata)
                : undefined,
        [lifecycleResult.data, lifecycle.columnMetadata],
    );
    const registryTable = useMemo(
        () =>
            registryResult.data?.status === "success"
                ? toDataTable(registryResult.data.table, registry.columnMetadata)
                : undefined,
        [registryResult.data, registry.columnMetadata],
    );

    const linkage = describeRegistryLinkage(estateRow);
    const message = linkageMessage(linkage);
    // With nothing joined, the usage columns would be a blank for every agent.
    const hideUsage = linkage.kind === "none";

    const registryColumns: GridColumnDef[] = useMemo(
        () => [
            { id: "Agent", header: "Agent", minWidth: 240 },
            { id: "Type", header: "Type", minWidth: 180 },
            { id: "Creator", header: "Creator" },
            { id: "Lifecycle Order", header: "Lifecycle order", hidden: true },
            { id: "Lifecycle", header: "Lifecycle", minWidth: 200 },
            { id: "Usage Review", header: "Usage review", minWidth: 180 },
            { id: "Users", header: "Users", numericStyling: true, hidden: hideUsage },
            {
                id: "Sessions",
                header: "Sessions",
                numericStyling: true,
                hidden: hideUsage,
                cellRenderer: heatRenderer({
                    domain: columnHeat(registryTable, "Sessions"),
                    format: columnFormat(registryTable, "Sessions"),
                }),
            },
        ],
        [hideUsage, registryTable],
    );

    const summaryError =
        activity.data?.status === "error"
            ? { message: activity.data.error.message, retry: activity.refetch }
            : estate.data?.status === "error"
              ? { message: estate.data.error.message, retry: estate.refetch }
              : undefined;
    const summaryLoading = activity.isLoading || !activity.data || estate.isLoading || !estate.data;

    return (
        <Section
            id={stageAnchor("agent-registry")}
            title="Agent registry"
            description="Which agents people actually use, and where every registered agent sits in its lifecycle."
        >
            {summaryError ? (
                <QueryError message={summaryError.message} onRetry={summaryError.retry} />
            ) : summaryLoading ? (
                <div className="grid gap-300 md:grid-cols-3">
                    <QueryLoading />
                    <QueryLoading />
                    <QueryLoading />
                </div>
            ) : (
                <div className="grid gap-300 md:grid-cols-3">
                    <KpiCard
                        label="Agent users"
                        value={readNumber(activityRow, "[Agent Users]")}
                        emphasis
                        detail={
                            <KpiStat
                                label="Share of active users"
                                value={readNumber(activityRow, "[Agent User Share]")}
                                format="percent"
                            />
                        }
                    />
                    <KpiCard
                        label="Agent sessions"
                        value={readNumber(activityRow, "[Agent Sessions]")}
                        detail={
                            <div className="flex flex-col gap-100">
                                <KpiStat
                                    label="Per agent user"
                                    value={readNumber(activityRow, "[Sessions Per User]")}
                                    format="rate"
                                />
                                <KpiStat
                                    label="Came back for another"
                                    value={readNumber(activityRow, "[Return Rate]")}
                                    format="percent"
                                />
                            </div>
                        }
                    />
                    <KpiCard
                        label="Registered agents"
                        value={readNumber(estateRow, "[Registry Agents]")}
                        detail={
                            <div className="flex flex-col gap-100">
                                <KpiStat label="Built in this tenant" value={readNumber(estateRow, "[Tenant Built]")} />
                                <KpiStat label="Seen in use" value={readNumber(estateRow, "[Seen In Use]")} />
                            </div>
                        }
                    />
                </div>
            )}

            {message && (
                <p className="flex max-w-[80ch] items-start gap-200 text-[length:var(--text-300)] leading-300 text-muted-foreground">
                    <Unlink className="icon-size-200 mt-[2px] shrink-0" aria-hidden="true" />
                    {message}
                </p>
            )}

            <FilterNote
                ignored={CATALOGUE_IGNORES}
                reason="the registry, its lifecycle chart and the registered-agent count always cover every agent, used or not."
            />

            <div className="grid gap-400 xl:grid-cols-2">
                <div className="h-[420px]">
                    {usageResult.data?.status === "error" ? (
                        <QueryError
                            className="h-full"
                            message={usageResult.data.error.message}
                            onRetry={usageResult.refetch}
                        />
                    ) : usageResult.isLoading || !usageTable ? (
                        <QueryLoading className="h-full" />
                    ) : usageTable.rows.length === 0 ? (
                        <QueryEmpty
                            className="h-full"
                            title="No agent sessions"
                            description="The audit log records no agent use in this period."
                        />
                    ) : (
                        <VegaVisual
                            spec={usage.vegaLiteSpec}
                            data={usageTable}
                            theme={theme}
                            header={{
                                title: "Most-used agents",
                                subtitle: "Sessions per agent, as the audit log names them",
                            }}
                        />
                    )}
                </div>

                <div className="h-[420px]">
                    {lifecycleResult.data?.status === "error" ? (
                        <QueryError
                            className="h-full"
                            message={lifecycleResult.data.error.message}
                            onRetry={lifecycleResult.refetch}
                        />
                    ) : lifecycleResult.isLoading || !lifecycleTable ? (
                        <QueryLoading className="h-full" />
                    ) : lifecycleTable.rows.length === 0 ? (
                        <QueryEmpty
                            className="h-full"
                            title="The registry is empty"
                            description="No agents were loaded from the Agent 365 registry. Check that the registry ingestion has run."
                        />
                    ) : (
                        <VegaVisual
                            spec={lifecycle.vegaLiteSpec}
                            data={lifecycleTable}
                            theme={theme}
                            capabilities={lifecycle.capabilities}
                            header={{
                                title: "Registry by lifecycle",
                                subtitle: "Registered agents at each stage, by who built them",
                            }}
                        />
                    )}
                </div>
            </div>

            <div className="flex h-[560px] flex-col">
                {registryResult.data?.status === "error" ? (
                    <QueryError
                        className="h-full"
                        message={registryResult.data.error.message}
                        onRetry={registryResult.refetch}
                    />
                ) : registryResult.isLoading || !registryTable ? (
                    <QueryLoading className="h-full" />
                ) : registryTable.rows.length === 0 ? (
                    <QueryEmpty
                        className="h-full"
                        title="The registry is empty"
                        description="No agents were loaded from the Agent 365 registry. Check that the registry ingestion has run."
                    />
                ) : (
                    <DataGrid
                        columns={registryColumns}
                        data={registryTable}
                        theme={theme}
                        header={{
                            title: "Every registered agent",
                            subtitle: `${formatKpi(registryTable.rows.length, "whole")} agents, in lifecycle order`,
                        }}
                    />
                )}
            </div>
        </Section>
    );
}
