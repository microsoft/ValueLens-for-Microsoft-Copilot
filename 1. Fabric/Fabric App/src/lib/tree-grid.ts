//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { Row } from "@microsoft/fabric-datagrid";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { formatKpi, type KpiFormat } from "./format-kpi";
import type { RollupTree } from "./rollup-tree";

/** Grid sizing with room for the sideways scrollbar wide tree tables need on narrow screens. */
export const TREE_GRID = { chrome: 148, max: 640 };

const ONE_DECIMAL = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A blank stays blank in a tree grid; the em dash of a KPI card would be noise on every other row. */
export function formatCell(format: KpiFormat | "decimal"): (value: unknown) => string | null {
    return (value) => {
        const n = asNumber(value);
        if (n === undefined) return null;
        return format === "decimal" ? ONE_DECIMAL.format(n) : formatKpi(n, format);
    };
}

export function textCell(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** Expands (or collapses) every group row on first render. */
export function withExpansion(tree: RollupTree | undefined, expanded: boolean): Row[] | undefined {
    return tree?.rows.map((row) => (row._children ? { ...row, _expanded: expanded } : row));
}

/** A supplied totals row is rendered as given, so each value arrives already formatted. */
export function totalsRow(
    total: Row | undefined,
    columns: readonly { id: string; format?: (value: unknown) => string | null }[],
): DataTable | undefined {
    if (!total) return undefined;
    return {
        columns: columns.map((column) => ({ name: column.id })),
        rows: [columns.map((column) => (column.format ? column.format(total[column.id]) ?? "" : textCell(total[column.id])))],
    };
}
