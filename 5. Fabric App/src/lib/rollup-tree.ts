//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { Row } from "@microsoft/fabric-datagrid";
import type { DataTable } from "@microsoft/fabric-visuals-core";

/** Reads one cell of the current result row by column name. */
export type CellReader = (column: string) => unknown;

export interface RollupTreeOptions {
    /** The outer grouping column, e.g. the grade. */
    group: string;
    /** The inner grouping column, e.g. the work shape. */
    leaf: string;
    /** The flag ROLLUPADDISSUBTOTAL sets on the grand-total row. */
    grandTotalFlag: string;
    /** The flag it sets on each group's subtotal row. */
    groupTotalFlag: string;
    /** The grid's first column: the group on group rows, the leaf on leaf rows. */
    label: string;
    /** Columns copied onto every row unchanged. */
    fields: readonly string[];
    /** Names a group; return `undefined` to fall back to the raw value. */
    groupLabel?: (value: unknown, cell: CellReader) => string | undefined;
    /** Stands in for a blank group or leaf value. */
    blankLabel?: string;
}

export interface RollupTree {
    /** Group rows, each holding its leaves as `_children`. */
    rows: Row[];
    /** The grand-total row, when the query returned one. */
    total: Row | undefined;
}

const GROUP_PREFIX = "group:";

export function isGroupRow(row: Row): boolean {
    return typeof row._id === "string" && row._id.startsWith(GROUP_PREFIX);
}

function text(value: unknown): string | undefined {
    if (typeof value === "string") return value.trim() === "" ? undefined : value;
    return typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

/**
 * Folds a two-level `ROLLUPADDISSUBTOTAL` result into group rows with their
 * leaves nested inside, keeping the query's order. Subtotals come from the
 * model rather than being summed here, since shares and medians do not add up.
 */
export function toRollupTree(table: DataTable, options: RollupTreeOptions): RollupTree {
    const index = new Map(table.columns.map((column, i) => [column.name, i]));
    const blank = options.blankLabel ?? "(Blank)";
    const reader =
        (row: readonly unknown[]): CellReader =>
        (column) => {
            const i = index.get(column);
            return i === undefined ? undefined : row[i];
        };
    const fields = (cell: CellReader) =>
        Object.fromEntries(options.fields.map((field) => [field, cell(field) as Row[string]]));

    const groups = new Map<string, Row>();
    const leaves = new Map<string, Row[]>();
    let total: Row | undefined;

    for (const raw of table.rows) {
        const cell = reader(raw);
        if (cell(options.grandTotalFlag) === true) {
            total = { _id: "total", [options.label]: "Total", ...fields(cell) };
            continue;
        }
        const value = cell(options.group);
        const group = options.groupLabel?.(value, cell) ?? text(value) ?? blank;
        if (cell(options.groupTotalFlag) === true) {
            // Re-setting an existing key keeps its place, so a subtotal that
            // arrives after its leaves does not move the group.
            groups.set(group, { _id: `${GROUP_PREFIX}${group}`, [options.label]: group, ...fields(cell) });
            continue;
        }
        const leaf = text(cell(options.leaf)) ?? blank;
        const list = leaves.get(group) ?? [];
        list.push({ _id: `leaf:${group}/${leaf}`, [options.label]: leaf, ...fields(cell) });
        leaves.set(group, list);
        if (!groups.has(group)) groups.set(group, { _id: `${GROUP_PREFIX}${group}`, [options.label]: group });
    }

    const rows = [...groups.entries()].map(([name, row]) => {
        const nested = leaves.get(name) ?? [];
        return nested.length > 0 ? { ...row, _children: nested } : row;
    });
    return { rows, total };
}

/** Rows on screen: every group, plus the leaves of the open ones. */
export function visibleRowCount(rows: readonly Row[], isOpen: (row: Row) => boolean): number {
    return rows.reduce((count, row) => {
        const children = (row._children as Row[] | undefined)?.length ?? 0;
        return count + 1 + (children > 0 && isOpen(row) ? children : 0);
    }, 0);
}
