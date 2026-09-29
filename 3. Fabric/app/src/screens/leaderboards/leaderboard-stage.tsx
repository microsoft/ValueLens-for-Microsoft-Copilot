//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { stageAnchor } from "@/components/destinations";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { Section } from "@/components/section";
import { SegmentedControl } from "@/components/segmented-control";
import { useThemeContext } from "@/hooks/theme.context";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { columnFormat, columnHeat, heatRenderer } from "@/lib/heat";
import { withOrgAttribute } from "@/lib/org-attribute";
import { toRollupDataTables } from "@/lib/to-data-table";
import {
    cohortTaskField,
    ORGANIZATION_COLUMN,
    USER_COLUMN,
    userLeaderboard,
    workCohorts,
    type WorkCohort,
} from "@/queries/work";

/** The task columns the grid carries, one per cohort: "All tasks", "Licensed tasks" and so on. */
const taskColumns = workCohorts.map((entry) => {
    const field = cohortTaskField(entry.id);
    return { id: field, header: field.charAt(0) + field.slice(1).toLowerCase() };
});

/**
 * The people half of the Leaderboards destination: who is doing the work.
 *
 * The report repeats the same table four times, once per cohort, on four
 * bookmarks. Here one grid holds every cohort's column and the toggle simply
 * hides the ones you are not asking about — sorting and filtering survive the
 * switch because the rows never change.
 */
export function LeaderboardStage() {
    const [cohort, setCohort] = useState<WorkCohort>("all");
    const { theme } = useThemeContext();
    const org = useOrgAttribute();

    const leaderboard = useMemo(() => withOrgAttribute(userLeaderboard(), org), [org]);
    const result = useFilteredQuery({
        connection: leaderboard.connection,
        query: leaderboard.query,
    });

    const tables = useMemo(() => {
        if (result.data?.status !== "success") return undefined;
        return toRollupDataTables(result.data.table, leaderboard.columnMetadata, {
            rollupFlagColumns: leaderboard.rollupFlagColumns,
        });
    }, [result.data, leaderboard.columnMetadata, leaderboard.rollupFlagColumns]);

    const activeField = cohortTaskField(cohort);
    const body = tables?.bodyTable;

    const columns: GridColumnDef[] = useMemo(
        () => [
            { id: ORGANIZATION_COLUMN, header: org.label },
            { id: USER_COLUMN, header: "User", minWidth: 220 },
            ...taskColumns.map((column) => ({
                ...column,
                numericStyling: true,
                hidden: column.id !== activeField,
                cellRenderer: heatRenderer({
                    domain: columnHeat(body, column.id),
                    format: columnFormat(body, column.id),
                }),
            })),
            { id: "Active Days", header: "Active days", numericStyling: true },
        ],
        [activeField, org.label, body],
    );

    return (
        <Section
            id={stageAnchor("leaderboard")}
            title="Leaderboard"
            description="Every person who used Copilot, ranked. Sort or filter any column; the total row stays pinned to the bottom."
            actions={
                <SegmentedControl label="Cohort" options={workCohorts} value={cohort} onChange={setCohort} />
            }
        >
            <div className="flex h-[560px] flex-col">
                {result.data?.status === "error" ? (
                    <QueryError className="h-full" message={result.data.error.message} onRetry={result.refetch} />
                ) : result.isLoading || !tables ? (
                    <QueryLoading className="h-full" />
                ) : tables.bodyTable.rows.length === 0 ? (
                    <QueryEmpty
                        className="h-full"
                        title="Nobody to rank"
                        description="The semantic model returned no users for this period."
                    />
                ) : (
                    <DataGrid
                        columns={columns}
                        data={tables.bodyTable}
                        grandTotals={{ position: "bottom", data: tables.grandTotalTable }}
                        defaultSort={[{ columnId: activeField, direction: "desc" }]}
                        theme={theme}
                        header={{
                            title: "Tasks by person",
                            subtitle: `${tables.bodyTable.rows.length} people with recorded activity`,
                        }}
                    />
                )}
            </div>
        </Section>
    );
}
