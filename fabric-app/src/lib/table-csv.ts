//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { DataTable } from "@microsoft/fabric-visuals-core";
import { dataToSuffix, downloadBlob, fileNameFor } from "./download";

/** Lets Excel open the file as UTF-8 rather than guessing a code page. */
const BOM = "\uFEFF";

/** Text a spreadsheet would run as a formula, unless it's just a signed number. */
const FORMULA_START = /^[=+\-@\t\r]/;
const SIGNED_NUMBER = /^[+-]?\d[\d,]*(\.\d+)?%?$/;

function cell(value: unknown): string {
    if (value === null || value === undefined) return "";
    let text = value instanceof Date ? value.toISOString() : String(value);
    if (typeof value === "string" && FORMULA_START.test(text) && !SIGNED_NUMBER.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The rows a chart was drawn from, as CSV: column display names on the first
 * line, raw values beneath, CRLF line ends and a byte-order mark for Excel.
 */
export function tableToCsv(table: DataTable): string {
    const header = table.columns.map((column) => cell(column.displayName ?? column.name));
    const rows = table.rows.map((row) => table.columns.map((_, index) => cell(row[index])));
    return BOM + [header, ...rows].map((line) => line.join(",")).join("\r\n") + "\r\n";
}

/**
 * A chart's CSV file name: `<title>.csv`, or `<title>-data-to-<date>.csv` when
 * the date the data runs to is known, so a saved file says how fresh it is.
 */
export function csvFileName(title: string, dataTo?: string): string {
    return fileNameFor(title, "csv").replace(/\.csv$/, `${dataToSuffix(dataTo)}.csv`);
}

/** Downloads a chart's rows; see `csvFileName`. */
export function downloadTableCsv(table: DataTable, title: string, dataTo?: string): void {
    downloadBlob(new Blob([tableToCsv(table)], { type: "text/csv;charset=utf-8" }), csvFileName(title, dataTo));
}
