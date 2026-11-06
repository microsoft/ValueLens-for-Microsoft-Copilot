//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { VisualizationSpec } from "@microsoft/fabric-visuals";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { consumptionConnection as connection, FORMAT_CREDITS, FORMAT_MONEY, FORMAT_WHOLE } from "../shared";
import byProductQuery from "./consumption-by-product.dax?raw";
import datesQuery from "./consumption-dates.dax?raw";
import notesQuery from "./consumption-notes.dax?raw";
import sourcesQuery from "./consumption-sources.dax?raw";
import productCostSpec from "./product-cost.json";

const datesColumns: ColumnMetadataMap = {
    "[First Date]": { name: "First Date", displayName: "First date" },
    "[Last Date]": { name: "Last Date", displayName: "Last date" },
};

/** The span of the report's shared date table, which bounds the date presets. */
export function consumptionDates() {
    return { connection, query: datesQuery, columnMetadata: datesColumns };
}

const byProductColumns: ColumnMetadataMap = {
    "[Product]": { name: "Product", displayName: "Product" },
    "[Product Sort]": { name: "Product Sort", displayName: "Product sort", format: FORMAT_WHOLE },
    "[Credits]": { name: "Credits", displayName: "Credits", format: FORMAT_CREDITS },
    "[Cost]": { name: "Cost", displayName: "Cost", format: FORMAT_MONEY },
    "[Cost Basis]": { name: "Cost Basis", displayName: "Cost basis" },
    "[Coverage]": { name: "Coverage", displayName: "Coverage" },
};

/**
 * The report's Combined page: each product's credits and cost over the same
 * dates, with the basis each cost is worked out on and how much of the
 * window its source covers. GitHub Copilot is left out, as it is on this
 * app's Consumption page.
 */
export function consumptionByProduct() {
    return {
        connection,
        query: byProductQuery,
        columnMetadata: byProductColumns,
        vegaLiteSpec: productCostSpec as VisualizationSpec,
    };
}

const notesColumns: ColumnMetadataMap = {
    "[Reporting Window]": { name: "Reporting Window", displayName: "Selected dates" },
    "[Reporting Caveat]": { name: "Reporting Caveat", displayName: "Caveat" },
    "[Rates In Use]": { name: "Rates In Use", displayName: "Rates in use" },
    "[Azure Currency]": { name: "Azure Currency", displayName: "Azure currency" },
};

/** The report's side cards: the date window, its caveat and the credit rates in use. */
export function consumptionNotes() {
    return { connection, query: notesQuery, columnMetadata: notesColumns };
}

const sourcesColumns: ColumnMetadataMap = {
    "[Cowork Rows]": { name: "Cowork Rows", displayName: "Cowork rows", format: FORMAT_WHOLE },
    "[Studio Rows]": { name: "Studio Rows", displayName: "Copilot Studio rows", format: FORMAT_WHOLE },
    "[Azure Rows]": { name: "Azure Rows", displayName: "Azure rows", format: FORMAT_WHOLE },
};

/** How many rows each product's source holds, before any slicer. */
export function consumptionSources() {
    return { connection, query: sourcesQuery, columnMetadata: sourcesColumns };
}

/** Whether any product's source holds a row; the model answers BLANK for an empty table. */
export function hasConsumptionData(row: Record<string, unknown>): boolean {
    return Object.keys(sourcesColumns).some((column) => {
        const count = row[column];
        return typeof count === "number" && count > 0;
    });
}

export interface Coverage {
    /** "Partial date coverage", "Date span covered" or "No rows in selected dates; …". */
    status: string;
    /** The dates the product's source actually holds, e.g. "2026-05-03 to 2026-07-26". */
    source: string | undefined;
}

/** Splits the model's "status | source a to b" coverage text into its two parts. */
export function splitCoverage(value: unknown): Coverage | undefined {
    if (typeof value !== "string" || value.trim() === "") return undefined;
    const [status, ...rest] = value.split("|").map((part) => part.trim());
    const source = rest.join(" | ").replace(/^source\s+/i, "");
    return { status, source: source === "" ? undefined : source };
}

/** Whether a coverage status says the product had data across the whole window. */
export function isFullCoverage(coverage: Coverage | undefined): boolean {
    return coverage?.status.toLowerCase().startsWith("date span covered") ?? false;
}
