//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useId, useMemo, type ComponentProps, type ReactNode } from "react";
import { DataGrid, type GridColumnDef, type Row } from "@microsoft/fabric-datagrid";
import { VegaVisual, type VisualizationSpec } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { TreeFrame } from "@/components/tree-frame";
import { useThemeContext } from "@/hooks/theme.context";
import { useRowToggles } from "@/hooks/use-row-toggles";
import { gridHeight } from "@/lib/chart-height";
import { heatDomain, heatRenderer, type HeatDomain } from "@/lib/heat";
import { isGroupRow, visibleRowCount, type RollupTree } from "@/lib/rollup-tree";
import { textCell, totalsRow, TREE_GRID, withExpansion } from "@/lib/tree-grid";
import type { SummaryResult, TableResult } from "@/hooks/use-table-query";
import { SMALL } from "@/lib/type-scale";

/** Stands in for a row of KPI cards while the summary loads or fails. */
export function KpiRowState({
    summary,
    count,
    className,
    emptyTitle,
    emptyDescription,
    children,
}: {
    summary: SummaryResult;
    count: number;
    className: string;
    emptyTitle: string;
    emptyDescription: string;
    children: ReactNode;
}) {
    if (summary.error !== undefined) return <QueryError message={summary.error} onRetry={summary.refetch} />;
    if (!summary.loaded) {
        return (
            <div className={className}>
                {Array.from({ length: count }, (_, index) => (
                    <QueryLoading key={index} />
                ))}
            </div>
        );
    }
    if (!summary.row) return <QueryEmpty title={emptyTitle} description={emptyDescription} />;
    return <div className={className}>{children}</div>;
}

interface PanelProps {
    result: TableResult;
    /** A slice of the result to show instead of all of it. */
    table?: DataTable;
    height: number;
    emptyTitle: string;
    emptyDescription: string;
    children: (table: DataTable) => ReactNode;
}

/** Sizes a chart or grid, standing in for it while its query loads, fails or comes back empty. */
export function Panel({ result, table = result.table, height, emptyTitle, emptyDescription, children }: PanelProps) {
    return (
        <div className="flex flex-col" style={{ height }}>
            {result.error !== undefined ? (
                <QueryError className="h-full" message={result.error} onRetry={result.refetch} />
            ) : result.isLoading || !table ? (
                <QueryLoading className="h-full" />
            ) : table.rows.length === 0 ? (
                <QueryEmpty className="h-full" title={emptyTitle} description={emptyDescription} />
            ) : (
                children(table)
            )}
        </div>
    );
}

interface ChartPanelProps extends Omit<PanelProps, "children"> {
    spec: VisualizationSpec;
    title: string;
    subtitle: string;
    capabilities?: ComponentProps<typeof VegaVisual>["capabilities"];
}

export function ChartPanel({ spec, title, subtitle, capabilities, ...panel }: ChartPanelProps) {
    const { theme } = useThemeContext();
    return (
        <Panel {...panel}>
            {(table) => (
                <VegaVisual spec={spec} data={table} theme={theme} capabilities={capabilities} header={{ title, subtitle }} />
            )}
        </Panel>
    );
}

export interface Note {
    term: string;
    text: string | undefined;
}

/** The report's side cards — rates, dates, caveats — gathered into one card in the model's own words. */
export function NoteCard({ title, notes, children }: { title: string; notes: readonly Note[]; children?: ReactNode }) {
    const headingId = useId();
    const shown = notes.filter((note): note is { term: string; text: string } => Boolean(note.text));
    if (shown.length === 0 && !children) return null;
    return (
        <article aria-labelledby={headingId} className="flex flex-col rounded-xl border border-border bg-card">
            <h3
                id={headingId}
                className="border-b border-border px-500 py-300 text-[length:var(--text-300)] leading-300 font-semibold text-foreground"
            >
                {title}
            </h3>
            <dl className="flex flex-col divide-y divide-border px-500">
                {shown.map((note) => (
                    <div key={note.term} className="flex flex-col gap-100 py-300">
                        <dt className={`${SMALL} font-semibold text-foreground`}>{note.term}</dt>
                        <dd className={`${SMALL} max-w-[68ch] whitespace-pre-line text-muted-foreground`}>{note.text}</dd>
                    </div>
                ))}
            </dl>
            {children}
        </article>
    );
}

export interface TreeColumn {
    id: string;
    header: string;
    width: number;
    /** Numeric columns format their value; text columns show it as it is. */
    format?: (value: unknown) => string | null;
    /** Shades the cell, groups against groups and people against people. */
    heat?: boolean;
    /** The heat colour, when the column measures something bad rather than volume. */
    heatColor?: string;
    /** A person row would only repeat 1. */
    groupOnly?: boolean;
}

interface RollupGridProps {
    result: TableResult;
    toTree: (table: DataTable) => RollupTree;
    labelColumn: string;
    labelHeader: string;
    labelWidth?: number;
    columns: readonly TreeColumn[];
    /** Distinguishes lenses, so a switch resets the grid's own expansion state. */
    variant: string;
    title: string;
    subtitle: string;
    emptyTitle: string;
    emptyDescription: string;
}

type LevelHeat = Record<string, { group: HeatDomain | undefined; leaf: HeatDomain | undefined }>;

/**
 * The report's group-then-person pivots. A single group (All users) opens
 * straight away; several groups start closed so they can be compared first.
 */
export function RollupGrid({
    result,
    toTree,
    labelColumn,
    labelHeader,
    labelWidth = 260,
    columns,
    variant,
    title,
    subtitle,
    emptyTitle,
    emptyDescription,
}: RollupGridProps) {
    const { theme } = useThemeContext();
    const tree = useMemo(() => (result.table ? toTree(result.table) : undefined), [result.table, toTree]);
    const open = (tree?.rows.length ?? 0) === 1;
    const gridKey = `${variant}|${tree?.rows.map((row) => row._id).join("|") ?? ""}`;
    const rows = useMemo(() => withExpansion(tree, open), [tree, open]);
    const { ids, onRowToggle } = useRowToggles(gridKey);

    const heat = useMemo(() => {
        const groups = tree?.rows ?? [];
        const leaves = groups.flatMap((row) => (row._children as Row[] | undefined) ?? []);
        const domains: LevelHeat = {};
        for (const column of columns.filter((candidate) => candidate.heat)) {
            domains[column.id] = {
                group: heatDomain(groups.map((row) => row[column.id])),
                leaf: heatDomain(leaves.map((row) => row[column.id])),
            };
        }
        return domains;
    }, [tree, columns]);

    const gridColumns: GridColumnDef[] = useMemo(
        () => [
            {
                id: labelColumn,
                header: labelHeader,
                width: labelWidth,
                cellRenderer: (value, row): ReactNode =>
                    isGroupRow(row) ? <span className="font-semibold">{textCell(value)}</span> : textCell(value),
            },
            ...columns.map((column): GridColumnDef => {
                const format = column.format;
                if (!format) return { id: column.id, header: column.header, width: column.width };
                const levelFormat = (value: unknown, row: Row) =>
                    column.groupOnly && !isGroupRow(row) ? null : format(value);
                return {
                    id: column.id,
                    header: column.header,
                    width: column.width,
                    numericStyling: true,
                    cellRenderer: column.heat
                        ? heatRenderer({
                              domain: (row) => (isGroupRow(row) ? heat[column.id]?.group : heat[column.id]?.leaf),
                              format: levelFormat,
                              color: column.heatColor,
                          })
                        : (value, row) => levelFormat(value, row),
                };
            }),
        ],
        [columns, heat, labelColumn, labelHeader, labelWidth],
    );

    // With one group, its subtotal already is the total.
    const total = useMemo(
        () =>
            (tree?.rows.length ?? 0) > 1
                ? totalsRow(tree?.total, [{ id: labelColumn }, ...columns.map((column) => ({ id: column.id, format: column.format }))])
                : undefined,
        [tree, columns, labelColumn],
    );
    const visible = visibleRowCount(rows ?? [], (row) => (open ? !ids.has(row._id as string) : ids.has(row._id as string)));

    return (
        <TreeFrame
            tree={tree}
            error={result.error}
            onRetry={result.refetch}
            isLoading={result.isLoading}
            height={tree ? gridHeight(visible + (total ? 1 : 0), TREE_GRID) : undefined}
            emptyTitle={emptyTitle}
            emptyDescription={emptyDescription}
        >
            <DataGrid
                key={gridKey}
                columns={gridColumns}
                data={rows}
                grandTotals={total ? { position: "bottom", data: total } : undefined}
                onRowToggle={onRowToggle}
                theme={theme}
                header={{ title, subtitle }}
            />
        </TreeFrame>
    );
}
