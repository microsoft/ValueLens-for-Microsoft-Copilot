//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { stageAnchor } from "@/components/destinations";
import { Panel } from "@/components/report-panels";
import { Section } from "@/components/section";
import { useThemeContext } from "@/hooks/theme.context";
import { useTableQuery } from "@/hooks/use-table-query";
import { gridHeight } from "@/lib/chart-height";
import { columnHeat, heatRenderer } from "@/lib/heat";
import { formatCell, textCell } from "@/lib/tree-grid";
import { governanceReviewQueue } from "@/queries/governance";

const REVIEW_QUEUE = governanceReviewQueue();

const whole = formatCell("whole");

/**
 * Every tenant-built agent with at least one governance flag, the weightiest
 * flags first, then the most flagged and most used, so the review starts
 * where it matters most.
 */
export function ReviewQueueStage() {
    const { theme } = useThemeContext();
    const queue = useTableQuery(REVIEW_QUEUE);
    const rows = queue.table?.rows.length ?? 0;

    const columns = useMemo<GridColumnDef[]>(
        () => [
            { id: "Agent", header: "Agent", width: 240, cellRenderer: textCell },
            { id: "Flags", header: "Why it's here", width: 300, cellRenderer: textCell },
            { id: "Type", header: "Type", width: 140, cellRenderer: textCell },
            { id: "Creator", header: "Creator", width: 200, cellRenderer: textCell },
            { id: "Owner Account", header: "Owner account", width: 128, cellRenderer: textCell },
            { id: "Sharing Scope", header: "Shared with", width: 180, cellRenderer: textCell },
            { id: "Data Access", header: "Can read", width: 160, cellRenderer: textCell },
            {
                id: "Users",
                header: "Users",
                width: 88,
                numericStyling: true,
                cellRenderer: heatRenderer({ domain: columnHeat(queue.table, "Users"), format: whole }),
            },
        ],
        [queue.table],
    );

    return (
        <Section
            id={stageAnchor("review-queue")}
            title="Review queue"
            description="Every agent built here that needs a look, the most serious flags first, then the most used."
        >
            <Panel
                result={queue}
                height={gridHeight(rows)}
                emptyTitle="Nothing needs a review"
                emptyDescription="No agent built in this tenant carries a governance flag for these filters."
            >
                {(table) => (
                    <DataGrid
                        columns={columns}
                        data={table}
                        theme={theme}
                        header={{ title: "Agents to review", subtitle: `${rows.toLocaleString()} flagged` }}
                    />
                )}
            </Panel>
        </Section>
    );
}
