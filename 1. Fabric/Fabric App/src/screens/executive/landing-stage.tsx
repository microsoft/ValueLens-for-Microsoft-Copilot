//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { stageAnchor } from "@/components/destinations";
import { OpenDestinationFooter, OpenDestinationLink } from "@/components/open-destination-link";
import { ChartPanel, NoteCard, Panel } from "@/components/report-panels";
import { Section } from "@/components/section";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useThemeContext } from "@/hooks/theme.context";
import { useTableQuery } from "@/hooks/use-table-query";
import { gridHeight, rowChartHeight } from "@/lib/chart-height";
import { formatKpi } from "@/lib/format-kpi";
import { columnFormat, columnHeat, heatRenderer } from "@/lib/heat";
import { readNumber } from "@/lib/summary-row";
import { DEPARTMENT_COLUMN, executiveWorkKinds, WORK_KINDS_SHOWN } from "@/queries/executive";
import { mostUsedAgent, workRates } from "./executive-data";
import type { ExecutiveData } from "./use-executive-data";

const SORT_COLUMN = "Hours Per Seat Month";

function heatColumn(table: DataTable | undefined, id: string, header: string, width: number): GridColumnDef {
    return {
        id,
        header,
        width,
        numericStyling: true,
        cellRenderer: heatRenderer({ domain: columnHeat(table, id), format: columnFormat(table, id) }),
    };
}

function departmentColumns(orgLabel: string, table: DataTable | undefined): GridColumnDef[] {
    return [
        { id: DEPARTMENT_COLUMN, header: orgLabel, minWidth: 180 },
        { id: "Licensed Seats", header: "Licensed seats", width: 132, numericStyling: true },
        heatColumn(table, "Seats In Use Pct", "Seats in use", 124),
        heatColumn(table, "Habit Pct", "Habit rate", 116),
        heatColumn(table, "Skills Per Person", "Unique skills", 132),
        { id: "Hours", header: "Expert hours", width: 128, numericStyling: true },
        heatColumn(table, SORT_COLUMN, "Hours per seat", 136),
    ];
}

function plural(count: number | undefined, one: string, many: string): string {
    return `${formatKpi(count, "whole")} ${count === 1 ? one : many}`;
}

/**
 * Where the value is landing: which parts of the organization get the most
 * from their seats, what the work is, and how much of it agents do.
 */
export function LandingStage({ data }: { data: ExecutiveData }) {
    const { departments, summary } = data;
    const { theme } = useThemeContext();
    const org = useOrgAttribute();
    const groups = org.plural.charAt(0).toUpperCase() + org.plural.slice(1);

    const workKindsSource = useMemo(() => executiveWorkKinds(), []);
    const workKinds = useTableQuery(workKindsSource);

    const columns = useMemo(() => departmentColumns(org.label, departments.table), [org.label, departments.table]);
    const groupCount = departments.table?.rows.length;

    const row = summary.row;
    const rates = workRates(row);
    const agentHours = readNumber(row, "[Agent Hours]");
    const agentsInUse = readNumber(row, "[Agents In Use]");
    const agentUsers = readNumber(row, "[Agent Users]");

    return (
        <Section
            id={stageAnchor("where-it-is-landing")}
            title="Where it is landing"
            description={`Which ${org.plural} get the most from their seats, and what kind of work Copilot does for people.`}
            actions={
                <OpenDestinationLink destination="work-patterns">
                    Open Work patterns
                </OpenDestinationLink>
            }
        >
            <Panel
                result={departments}
                height={gridHeight(groupCount ?? 6)}
                emptyTitle={`No ${org.plural} to compare`}
                emptyDescription={`Nobody in the current selection has a license or a task with ${org.noun} recorded.`}
            >
                {(table) => (
                    <DataGrid
                        key={org.column}
                        columns={columns}
                        data={table}
                        defaultSort={[{ columnId: SORT_COLUMN, direction: "desc" }]}
                        theme={theme}
                        header={{
                            title: `${groups} by expert hours per seat`,
                            subtitle: `${plural(table.rows.length, org.noun, org.plural)}, most expert-equivalent hours per licensed seat a month first. Shading compares the ${org.plural} with each other.`,
                        }}
                    />
                )}
            </Panel>

            <div className="grid grid-cols-1 gap-500 xl:grid-cols-[minmax(0,1fr)_320px]">
                <div className="min-w-0">
                    <ChartPanel
                        result={workKinds}
                        spec={workKindsSource.vegaLiteSpec}
                        height={rowChartHeight(workKinds.table?.rows.length ?? WORK_KINDS_SHOWN)}
                        title="What the work is"
                        subtitle={`The ${WORK_KINDS_SHOWN} kinds of work with the most expert-equivalent hours`}
                        emptyTitle="No kinds of work to show"
                        emptyDescription="No task in the current selection has a kind of work other than General Chat or General Assistance."
                    />
                </div>
                <div className="xl:self-start">
                    <NoteCard
                        title="Agents"
                        notes={[
                            {
                                term: "Agents in use",
                                text:
                                    agentsInUse === undefined
                                        ? undefined
                                        : `${plural(agentsInUse, "agent", "agents")}, used by ${plural(agentUsers, "person", "people")}`,
                            },
                            {
                                term: "Agent work",
                                text:
                                    agentHours === undefined
                                        ? undefined
                                        : `${formatKpi(agentHours, "whole")} expert-equivalent hours${
                                              rates.agentShare === undefined
                                                  ? ""
                                                  : `, ${formatKpi(Math.round(rates.agentShare * 100) / 100, "percent")} of the total`
                                          }`,
                            },
                            { term: "Most used agent", text: mostUsedAgent(row) },
                        ]}
                    >
                        <OpenDestinationFooter destination="leaderboards" stage="leaderboard">
                            Open Leaderboards
                        </OpenDestinationFooter>
                    </NoteCard>
                </div>
            </div>
        </Section>
    );
}