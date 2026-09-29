//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { DataGrid, type GridColumnDef, type Row } from "@microsoft/fabric-datagrid";
import { VegaVisual } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { QueryEmpty, QueryError, QueryLoading } from "@/components/query-states";
import { SegmentedControl } from "@/components/segmented-control";
import { useThemeContext } from "@/hooks/theme.context";
import { useFilteredQuery } from "@/hooks/use-filtered-query";
import { gridHeight, rowChartHeight } from "@/lib/chart-height";
import { formatKpi } from "@/lib/format-kpi";
import { heatDomain, heatRenderer, type HeatDomain } from "@/lib/heat";
import { toDataTable } from "@/lib/to-data-table";
import {
    ACTIVITY_SHARE_COLUMN,
    HOURS_PER_WEEK_COLUMN,
    TASK_LABEL_COLUMN,
    toValueTaskTree,
    VALUE_PER_WEEK_COLUMN,
    valueByTask,
} from "@/queries/value";

type View = "table" | "chart";
type Detail = "categories" | "tasks";

const views: readonly { id: View; label: string }[] = [
    { id: "table", label: "Value table" },
    { id: "chart", label: "Time saved" },
];

const details: readonly { id: Detail; label: string }[] = [
    { id: "categories", label: "Categories" },
    { id: "tasks", label: "All tasks" },
];

const MEASURES = [ACTIVITY_SHARE_COLUMN, HOURS_PER_WEEK_COLUMN, VALUE_PER_WEEK_COLUMN] as const;
type Measure = (typeof MEASURES)[number];

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isGroup(row: Row): boolean {
    return typeof row._id === "string" && row._id.startsWith("group:");
}

function formatter(measure: Measure, currencySymbol: string): (value: unknown) => string {
    switch (measure) {
        case ACTIVITY_SHARE_COLUMN:
            return (value) => formatKpi(asNumber(value), "percent");
        case HOURS_PER_WEEK_COLUMN:
            return (value) => formatKpi(asNumber(value), "hours");
        case VALUE_PER_WEEK_COLUMN:
            return (value) => formatKpi(asNumber(value), "currency", { prefix: currencySymbol });
    }
}

function header(measure: Measure, currencySymbol: string): string {
    switch (measure) {
        case ACTIVITY_SHARE_COLUMN:
            return "Activity share";
        case HOURS_PER_WEEK_COLUMN:
            return "Expert hours per week";
        case VALUE_PER_WEEK_COLUMN:
            return `Value per week${currencySymbol ? ` (${currencySymbol})` : ""}`;
    }
}

interface TaskValueBreakdownProps {
    /** The hourly-rate and effort-scenario filters the rest of the stage uses. */
    extra: readonly string[];
    currencySymbol: string;
    /** "At £50 an hour, typical effort", carried into the subtitles. */
    assumption: string;
}

/**
 * The report's Copilot Value Table and its Time Saved alternative: each task
 * category, drilling down to the tasks inside it, with activity share, weekly
 * expert-equivalent hours and weekly assisted value, shaded lightly by size.
 */
export function TaskValueBreakdown({ extra, currencySymbol, assumption }: TaskValueBreakdownProps) {
    const [view, setView] = useState<View>("table");
    const [detail, setDetail] = useState<Detail>("categories");
    const { theme } = useThemeContext();

    const source = valueByTask();
    const result = useFilteredQuery({ connection: source.connection, query: source.query }, { extra });
    const tree = useMemo(
        () =>
            result.data?.status === "success"
                ? toValueTaskTree(toDataTable(result.data.table, source.columnMetadata))
                : undefined,
        [result.data, source.columnMetadata],
    );

    // The grid owns its expansion state and only reads `_expanded` on mount,
    // so "All tasks" remounts it, and a new result does too.
    const gridKey = `${detail}|${tree?.rows.map((row) => row._id).join("|") ?? ""}`;
    const rows = useMemo(
        () => tree?.rows.map((row) => (row._children ? { ...row, _expanded: detail === "tasks" } : row)),
        [tree, detail],
    );

    // Rows the reader has toggled away from the default, to size the grid.
    const [toggled, setToggled] = useState<{ key: string; ids: ReadonlySet<string> }>({ key: "", ids: new Set() });
    const toggledIds = toggled.key === gridKey ? toggled.ids : undefined;
    const onRowToggle = useCallback(
        (rowId: string) =>
            setToggled((previous) => {
                const ids = new Set(previous.key === gridKey ? previous.ids : []);
                if (ids.has(rowId)) ids.delete(rowId);
                else ids.add(rowId);
                return { key: gridKey, ids };
            }),
        [gridKey],
    );

    const visibleRows = (tree?.rows ?? []).reduce((count, row) => {
        const children = (row._children as Row[] | undefined)?.length ?? 0;
        const open = (detail === "tasks") !== (toggledIds?.has(row._id as string) ?? false);
        return count + 1 + (open ? children : 0);
    }, 0);

    const domains = useMemo(() => {
        const groups = tree?.rows ?? [];
        const tasks = groups.flatMap((row) => (row._children as Row[] | undefined) ?? []);
        return Object.fromEntries(
            MEASURES.map((measure) => [
                measure,
                {
                    group: heatDomain(groups.map((row) => row[measure])),
                    task: heatDomain(tasks.map((row) => row[measure])),
                },
            ]),
        ) as Record<Measure, { group: HeatDomain | undefined; task: HeatDomain | undefined }>;
    }, [tree]);

    const columns: GridColumnDef[] = useMemo(
        () => [
            {
                id: TASK_LABEL_COLUMN,
                header: "Category / task",
                minWidth: 260,
                cellRenderer: (value, row): ReactNode =>
                    isGroup(row) ? <span className="font-semibold">{String(value ?? "")}</span> : String(value ?? ""),
            },
            ...MEASURES.map(
                (measure): GridColumnDef => ({
                    id: measure,
                    header: header(measure, currencySymbol),
                    width: measure === ACTIVITY_SHARE_COLUMN ? 140 : 184,
                    numericStyling: true,
                    cellRenderer: heatRenderer({
                        // Categories and tasks sit on different scales, so each level heats against its peers.
                        domain: (row) => (isGroup(row) ? domains[measure].group : domains[measure].task),
                        format: formatter(measure, currencySymbol),
                    }),
                }),
            ),
        ],
        [currencySymbol, domains],
    );

    // A supplied totals row is formatted with its own column formats, so it
    // arrives as text and carries none.
    const total: DataTable | undefined = useMemo(() => {
        const first = tree?.total?.rows[0];
        if (!first) return undefined;
        return {
            columns: [{ name: TASK_LABEL_COLUMN }, ...MEASURES.map((name) => ({ name }))],
            rows: [["Total", ...MEASURES.map((measure, i) => formatter(measure, currencySymbol)(first[i + 1]))]],
        };
    }, [tree, currencySymbol]);

    const height = !tree
        ? undefined
        : view === "table"
          ? gridHeight(visibleRows + 1, { max: 760 })
          : rowChartHeight(tree.tasks.rows.length, { perRow: 32, chrome: 190 });

    return (
        <div className="flex flex-col gap-200">
            <div className="flex flex-wrap items-end justify-between gap-200">
                <p className="max-w-[60ch] text-[length:var(--text-200)] leading-200 text-muted-foreground">
                    Tasks come from rule-based categories, so they won’t line up with the AI-inferred categories in
                    Copilot Analytics.
                </p>
                <div className="flex flex-wrap items-center gap-200">
                    {view === "table" && (
                        <SegmentedControl label="Rows shown" options={details} value={detail} onChange={setDetail} />
                    )}
                    <SegmentedControl label="Value view" options={views} value={view} onChange={setView} />
                </div>
            </div>

            <div className="flex h-[420px] flex-col" style={height ? { height } : undefined}>
                {result.data?.status === "error" ? (
                    <QueryError className="h-full" message={result.data.error.message} onRetry={result.refetch} />
                ) : result.isLoading || !tree || !rows ? (
                    <QueryLoading className="h-full" />
                ) : rows.length === 0 ? (
                    <QueryEmpty
                        className="h-full"
                        title="No value to break down"
                        description="No recorded work carries both a task category and an estimated value for this slice."
                    />
                ) : view === "table" ? (
                    <DataGrid
                        key={gridKey}
                        columns={columns}
                        data={rows}
                        defaultSort={[{ columnId: VALUE_PER_WEEK_COLUMN, direction: "desc" }]}
                        grandTotals={total ? { position: "bottom", data: total } : undefined}
                        onRowToggle={onRowToggle}
                        theme={theme}
                        header={{
                            title: "Where the value comes from",
                            subtitle: `Each category, then the tasks inside it. ${assumption}.`,
                        }}
                    />
                ) : (
                    <VegaVisual
                        spec={source.vegaLiteSpec}
                        data={tree.tasks}
                        capabilities={source.capabilities}
                        theme={theme}
                        header={{
                            title: "Time saved by task",
                            subtitle: `Expert-equivalent hours per week, coloured by category. ${assumption}.`,
                        }}
                    />
                )}
            </div>
        </div>
    );
}
