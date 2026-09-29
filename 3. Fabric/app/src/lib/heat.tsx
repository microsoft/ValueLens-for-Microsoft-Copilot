//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { CSSProperties, ReactNode } from "react";
import type { CellValue, Row } from "@microsoft/fabric-datagrid";
import { formatValue, type DataTable } from "@microsoft/fabric-visuals-core";

/**
 * Quiet heat shading for the one or two grid columns that carry what a table
 * measures, the app's version of the report's white-to-tint conditional
 * formatting.
 *
 * The tint is mixed from the destination's brand colour (or a colour the
 * caller passes) at 4–26 %, so the number stays the thing you read and the
 * shading only hints at where the weight sits.
 */

/** The faintest and strongest share of the heat colour mixed into a cell. */
export const HEAT_MIX_MIN = 4;
export const HEAT_MIX_MAX = 26;

export interface HeatDomain {
    min: number;
    max: number;
    /** Low values heat most, for ranks where 1 is best. */
    reverse?: boolean;
}

function asFinite(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The span of the numbers in `values`, or undefined when there are none. */
export function heatDomain(values: Iterable<unknown>, options: { reverse?: boolean } = {}): HeatDomain | undefined {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of values) {
        const n = asFinite(value);
        if (n === undefined) continue;
        if (n < min) min = n;
        if (n > max) max = n;
    }
    return max === Number.NEGATIVE_INFINITY ? undefined : { min, max, reverse: options.reverse };
}

/** Every value in one column of a DataTable, by column name. */
export function columnValues(table: DataTable | undefined, columnName: string): unknown[] {
    if (!table) return [];
    const index = table.columns.findIndex((column) => column.name === columnName);
    return index < 0 ? [] : table.rows.map((row) => row[index]);
}

/** The heat domain of one DataTable column. */
export function columnHeat(
    table: DataTable | undefined,
    columnName: string,
    options: { reverse?: boolean } = {},
): HeatDomain | undefined {
    return heatDomain(columnValues(table, columnName), options);
}

/**
 * The share of heat colour for one value, or undefined for blanks and values
 * outside a usable domain. A column of identical values sits mid-scale.
 */
export function heatMix(value: unknown, domain: HeatDomain | undefined): number | undefined {
    const n = asFinite(value);
    if (n === undefined || !domain) return undefined;
    const span = domain.max - domain.min;
    const raw = span === 0 ? 0.5 : (n - domain.min) / span;
    const t = Math.min(1, Math.max(0, domain.reverse ? 1 - raw : raw));
    return Math.round(HEAT_MIX_MIN + t * (HEAT_MIX_MAX - HEAT_MIX_MIN));
}

export interface HeatCellProps {
    mix: number | undefined;
    /** Any CSS colour; defaults to the destination brand colour. */
    color?: string;
    children: ReactNode;
}

/** A cell body whose tint fills the grid cell (see `.vl-heat` in global.css). */
export function HeatCell({ mix, color, children }: HeatCellProps) {
    if (mix === undefined) return <>{children}</>;
    const style = { "--heat-mix": `${mix}%`, ...(color ? { "--heat-color": color } : {}) } as CSSProperties;
    return (
        <span className="vl-heat" data-heat={mix} style={style}>
            {children}
        </span>
    );
}

type HeatFormat = string | ((value: unknown, row: Row) => ReactNode);

export interface HeatRendererOptions {
    /** A fixed domain, or one chosen per row — tree grids heat groups and leaves separately. */
    domain: HeatDomain | undefined | ((row: Row) => HeatDomain | undefined);
    /** A VBA format string (as in column metadata) or a formatter. */
    format?: HeatFormat;
    color?: string;
}

function render(format: HeatFormat | undefined, value: unknown, row: Row): ReactNode {
    if (typeof format === "function") return format(value, row);
    if (value === null || value === undefined) return null;
    const formatted = format ? formatValue(value, format) : value;
    return typeof formatted === "string" || typeof formatted === "number" ? formatted : String(formatted ?? "");
}

/** A DataGrid `cellRenderer` that formats the value and shades the cell by it. */
export function heatRenderer(options: HeatRendererOptions): (value: CellValue, row: Row) => ReactNode {
    return (value, row) => {
        const domain = typeof options.domain === "function" ? options.domain(row) : options.domain;
        return (
            <HeatCell mix={heatMix(value, domain)} color={options.color}>
                {render(options.format, value, row)}
            </HeatCell>
        );
    };
}

/** The VBA format string a DataTable column carries, if any. */
export function columnFormat(table: DataTable | undefined, columnName: string): string | undefined {
    return table?.columns.find((column) => column.name === columnName)?.format;
}
