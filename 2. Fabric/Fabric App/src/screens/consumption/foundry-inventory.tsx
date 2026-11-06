//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { KpiCard, KpiStat } from "@/components/kpi-card";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Panel } from "@/components/report-panels";
import { useSourceAvailability } from "@/hooks/source-availability.context";
import { useThemeContext } from "@/hooks/theme.context";
import { gridHeight } from "@/lib/chart-height";
import { columnHeat, heatRenderer } from "@/lib/heat";
import { isMissingFromModelError } from "@/lib/model-errors";
import { formatCell } from "@/lib/tree-grid";
import {
    FOUNDRY_INVENTORY_NOT_SET_UP,
    foundryResourceSpend,
    summariseFoundryInventory,
    uncoveredNote,
} from "@/queries/consumption";
import { moneyCell, SMALL, useConsumptionTable, type TableResult } from "./data";

const SPEND = foundryResourceSpend();
const SKIPPED = { ...SPEND, query: "" };

/**
 * Foundry accounts from Azure Resource Graph against the whole-solution cost
 * export: what each costs, which are open to the public network, and which
 * sit in subscriptions the export misses. Its own query, so a model without
 * the inventory leaves the rest of the page alone.
 */
export function FoundryInventory({ filters, prefix }: { filters: readonly string[]; prefix: string }) {
    const off = useSourceAvailability().resourceGraph === "notConfigured";
    const result = useConsumptionTable(off ? SKIPPED : SPEND, filters);
    if (off || (result.error !== undefined && isMissingFromModelError(result.error))) {
        return <QueryEmpty {...FOUNDRY_INVENTORY_NOT_SET_UP} />;
    }
    return <FoundryInventoryView result={result} prefix={prefix} />;
}

export function FoundryInventoryView({ result, prefix }: { result: TableResult; prefix: string }) {
    const { theme } = useThemeContext();
    const inventory = useMemo(() => summariseFoundryInventory(result.table), [result.table]);
    const columns = useMemo<GridColumnDef[]>(
        () => [
            { id: "Resource", header: "Foundry resource", width: 200 },
            { id: "Kind", header: "Kind", width: 140 },
            { id: "Resource Group", header: "Resource group", width: 180 },
            { id: "Projects", header: "Projects", width: 96, numericStyling: true, cellRenderer: formatCell("whole") },
            { id: "Network", header: "Network", width: 96 },
            { id: "Cost Export", header: "Cost export", width: 120 },
            {
                id: "Cost",
                header: "Cost",
                width: 128,
                numericStyling: true,
                cellRenderer: heatRenderer({ domain: columnHeat(result.table, "Cost"), format: moneyCell(prefix) }),
            },
        ],
        [prefix, result.table],
    );

    if (result.error !== undefined) return <QueryError message={result.error} onRetry={result.refetch} />;
    if (!result.table) return <QueryLoading />;
    if (!inventory) {
        return (
            <QueryEmpty
                title="No Foundry resources listed"
                description="Azure Resource Graph found no Foundry accounts or projects on its latest load. Check that its identity has Reader at the management group that holds your subscriptions."
            />
        );
    }

    const note = uncoveredNote(inventory.uncoveredSubscriptions, inventory.uncoveredAccounts);
    return (
        <>
            <div className="grid gap-300 md:grid-cols-3">
                <KpiCard
                    label="Foundry accounts"
                    value={inventory.accounts}
                    detail={<KpiStat label="Projects" value={inventory.projects} />}
                />
                <KpiCard label="Cost of those accounts" value={inventory.cost} format="money" prefix={prefix} emphasis />
                <KpiCard
                    label="Open to the public network"
                    value={inventory.publicNetwork}
                    detail={<KpiStat label="Outside the cost export" value={inventory.uncoveredAccounts} />}
                />
            </div>
            {note && <p className={`${SMALL} max-w-[80ch] text-muted-foreground`}>{note}</p>}
            <Panel
                result={result}
                height={gridHeight(result.table.rows.length)}
                emptyTitle="No Foundry resources listed"
                emptyDescription="Azure Resource Graph found no Foundry accounts on its latest load."
            >
                {(table) => (
                    <DataGrid
                        columns={columns}
                        data={table}
                        theme={theme}
                        header={{
                            title: "Foundry accounts",
                            subtitle: "From Azure Resource Graph: each account's cost, including its projects, at this cost basis",
                        }}
                    />
                )}
            </Panel>
        </>
    );
}
