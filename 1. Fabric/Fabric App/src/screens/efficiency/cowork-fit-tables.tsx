//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useMemo, type ReactNode } from "react";
import { Flag } from "lucide-react";
import { DataGrid, type CellValue, type GridColumnDef, type Row } from "@microsoft/fabric-datagrid";
import { GradeMark, GradeMix } from "@/components/grade-mark";
import { TreeFrame } from "@/components/tree-frame";
import { useOrgAttribute } from "@/hooks/filter.context";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { useOutcomeColors } from "@/hooks/use-palette-theme";
import { useRowToggles } from "@/hooks/use-row-toggles";
import { gridHeight } from "@/lib/chart-height";
import { formatKpi } from "@/lib/format-kpi";
import type { FilterKey } from "@/lib/filters";
import { workWeightGrade } from "@/lib/grading-method";
import { heatDomain, heatRenderer, type HeatDomain } from "@/lib/heat";
import { isGroupRow, visibleRowCount } from "@/lib/rollup-tree";
import { toDataTable } from "@/lib/to-data-table";
import { asNumber, formatCell, textCell, totalsRow, TREE_GRID, withExpansion } from "@/lib/tree-grid";
import {
    coworkFitPeople,
    coworkWorkShape,
    PEOPLE_LABEL_COLUMN,
    toPeopleTree,
    toWorkShapeTree,
    WORK_LABEL_COLUMN,
} from "@/queries/efficiency";

/** Shares of graded sessions shade on one absolute scale, so 50% reads the same on every row. */
const SHARE_HEAT: HeatDomain = { min: 0, max: 1 };

interface CoworkTableProps {
    /** Filters Cowork fit never applies. */
    ignore: FilterKey[];
}

const SHAPE_TOTAL_COLUMNS = [
    { id: WORK_LABEL_COLUMN },
    { id: "Sessions", format: formatCell("whole") },
    { id: "Decided By" },
    { id: "Could Have Used" },
    { id: "Share Of Work", format: formatCell("percent") },
    { id: "Source Items", format: formatCell("decimal") },
    { id: "Source Types", format: formatCell("decimal") },
] as const;

/**
 * The report's "what is being done today" table: each grade, opened to show
 * the shapes of work inside it, with why it was graded that way, the
 * everyday tool that could have done Worth-a-look work, its share of all
 * graded work and the median sources a session touched.
 */
export function WorkShapeTable({ ignore }: CoworkTableProps) {
    const { theme } = useThemeContext();
    const source = coworkWorkShape();
    const result = useFilteredQuery({ connection: source.connection, query: source.query }, { ignore });
    const tree = useMemo(
        () =>
            result.data?.status === "success"
                ? toWorkShapeTree(toDataTable(result.data.table, source.columnMetadata))
                : undefined,
        [result.data, source.columnMetadata],
    );

    const gridKey = tree?.rows.map((row) => row._id).join("|") ?? "";
    const rows = useMemo(() => withExpansion(tree, true), [tree]);
    const { ids, onRowToggle } = useRowToggles(gridKey);

    const shareHeat = useMemo(() => {
        const groups = tree?.rows ?? [];
        const leaves = groups.flatMap((row) => (row._children as Row[] | undefined) ?? []);
        return {
            group: heatDomain(groups.map((row) => row["Share Of Work"])),
            leaf: heatDomain(leaves.map((row) => row["Share Of Work"])),
        };
    }, [tree]);

    const columns: GridColumnDef[] = useMemo(
        () => [
            {
                id: WORK_LABEL_COLUMN,
                header: "Grade / how it was done",
                // Each width fits its header beside the sort arrow; Decided by takes the rest, so the table fits a laptop screen.
                width: 184,
                cellRenderer: (value, row): ReactNode => {
                    if (!isGroupRow(row)) return textCell(value);
                    const grade = workWeightGrade(value);
                    return (
                        <span className="inline-flex items-center gap-200 font-semibold">
                            {grade && <GradeMark tone={grade.tone} />}
                            {textCell(value)}
                        </span>
                    );
                },
            },
            { id: "Sessions", header: "Sessions", width: 96, numericStyling: true, cellRenderer: formatCell("whole") },
            { id: "Decided By", header: "Decided by", minWidth: 240 },
            { id: "Could Have Used", header: "Could have used", width: 168 },
            {
                id: "Share Of Work",
                header: "% of work",
                width: 108,
                numericStyling: true,
                cellRenderer: heatRenderer({
                    // Grades and the shapes inside them sit on different scales, so each level heats against its peers.
                    domain: (row) => (isGroupRow(row) ? shareHeat.group : shareHeat.leaf),
                    format: formatCell("percent"),
                }),
            },
            { id: "Source Items", header: "Source items", width: 120, numericStyling: true, cellRenderer: formatCell("decimal") },
            { id: "Source Types", header: "Source types", width: 120, numericStyling: true, cellRenderer: formatCell("decimal") },
        ],
        [shareHeat],
    );

    const total = useMemo(() => totalsRow(tree?.total, SHAPE_TOTAL_COLUMNS), [tree]);
    const visible = visibleRowCount(rows ?? [], (row) => !ids.has(row._id as string));

    return (
        <TreeFrame
            tree={tree}
            error={result.data?.status === "error" ? result.data.error.message : undefined}
            onRetry={result.refetch}
            isLoading={result.isLoading}
            height={tree ? gridHeight(visible + (total ? 1 : 0), TREE_GRID) : undefined}
            emptyTitle="No graded Cowork work"
            emptyDescription="No Cowork session in this selection carries enough detail to say how the work was done."
        >
            <DataGrid
                key={gridKey}
                columns={columns}
                data={rows}
                grandTotals={total ? { position: "bottom", data: total } : undefined}
                onRowToggle={onRowToggle}
                theme={theme}
                header={{
                    title: "How the work was done",
                    subtitle: "Each grade, then the shapes of work inside it. Sources are the median per session.",
                }}
            />
        </TreeFrame>
    );
}

function flagCell(value: CellValue, row: Row): ReactNode {
    const count = asNumber(value);
    if (!count) return null;
    const group = isGroupRow(row);
    return (
        <span className="inline-flex items-center gap-100 font-semibold text-caution">
            <Flag className="icon-size-100" strokeWidth={2.5} aria-hidden="true" />
            {group ? (
                <>
                    <span className="tabular-nums">{formatKpi(count, "whole")}</span>
                    <span className="sr-only">{count === 1 ? "person flagged" : "people flagged"}</span>
                </>
            ) : (
                <span className="sr-only">Flagged</span>
            )}
        </span>
    );
}

/**
 * The report's "who is doing it" table: each group of the chosen org
 * attribute, opening to its people, with graded sessions, the grade mix and
 * a flag for anyone with half or more of their sessions at Worth a look.
 */
export function PeopleTable({ ignore }: CoworkTableProps) {
    const { theme } = useThemeContext();
    const org = useOrgAttribute();
    const outcomeColors = useOutcomeColors();
    const source = useMemo(() => coworkFitPeople(org), [org]);
    const result = useFilteredQuery({ connection: source.connection, query: source.query }, { ignore });
    const blankLabel = `Unassigned ${org.noun}`;
    const tree = useMemo(
        () =>
            result.data?.status === "success"
                ? toPeopleTree(toDataTable(result.data.table, source.columnMetadata), blankLabel)
                : undefined,
        [result.data, source.columnMetadata, blankLabel],
    );

    const gridKey = `${org.column}|${tree?.rows.map((row) => row._id).join("|") ?? ""}`;
    const rows = useMemo(() => withExpansion(tree, false), [tree]);
    const { ids, onRowToggle } = useRowToggles(gridKey);

    const columns: GridColumnDef[] = useMemo(
        () => [
            {
                id: PEOPLE_LABEL_COLUMN,
                header: `${org.label} / person`,
                minWidth: 240,
                cellRenderer: (value, row): ReactNode =>
                    isGroupRow(row) ? <span className="font-semibold">{textCell(value)}</span> : textCell(value),
            },
            {
                id: "People",
                header: "People",
                width: 88,
                numericStyling: true,
                // A person row would only ever say 1.
                cellRenderer: (value, row) => (isGroupRow(row) ? formatCell("whole")(value) : null),
            },
            { id: "Sessions", header: "Graded sessions", width: 140, numericStyling: true, cellRenderer: formatCell("whole") },
            {
                id: "Mix",
                header: "Mix",
                width: 104,
                sortable: false,
                cellRenderer: (_value, row) => <GradeMix strong={row.Strong} fair={row.Fair} worth={row["Worth A Look"]} />,
            },
            { id: "Strong", header: "Strong", width: 96, numericStyling: true, cellRenderer: formatCell("percent") },
            { id: "Fair", header: "Fair", width: 96, numericStyling: true, cellRenderer: formatCell("percent") },
            {
                id: "Worth A Look",
                header: "Worth a look",
                width: 124,
                numericStyling: true,
                cellRenderer: heatRenderer({
                    domain: SHARE_HEAT,
                    format: formatCell("percent"),
                    color: outcomeColors?.caution,
                }),
            },
            { id: "Flagged People", header: "Flag", width: 88, cellRenderer: flagCell },
        ],
        [org.label, outcomeColors],
    );

    const total = useMemo(
        () =>
            totalsRow(tree?.total, [
                { id: PEOPLE_LABEL_COLUMN },
                { id: "People", format: formatCell("whole") },
                { id: "Sessions", format: formatCell("whole") },
                { id: "Mix" },
                { id: "Strong", format: formatCell("percent") },
                { id: "Fair", format: formatCell("percent") },
                { id: "Worth A Look", format: formatCell("percent") },
                { id: "Flagged People", format: formatCell("whole") },
            ]),
        [tree],
    );
    const visible = visibleRowCount(rows ?? [], (row) => ids.has(row._id as string));

    return (
        <TreeFrame
            tree={tree}
            error={result.data?.status === "error" ? result.data.error.message : undefined}
            onRetry={result.refetch}
            isLoading={result.isLoading}
            height={tree ? gridHeight(visible + (total ? 1 : 0), TREE_GRID) : undefined}
            emptyTitle="Nobody with enough graded sessions"
            emptyDescription={`A person or ${org.noun} appears here once they have five graded Cowork sessions in this selection.`}
        >
            <DataGrid
                key={gridKey}
                columns={columns}
                data={rows}
                defaultSort={[{ columnId: "Sessions", direction: "desc" }]}
                grandTotals={total ? { position: "bottom", data: total } : undefined}
                onRowToggle={onRowToggle}
                theme={theme}
                header={{
                    title: "Who is doing it",
                    subtitle: `Each ${org.noun}, then its people. Shares are of graded sessions; a flag marks half or more at Worth a look.`,
                }}
            />
        </TreeFrame>
    );
}
