//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { evaluateBody } from "@/lib/dax-filters";
import { CONSUMPTION_REPORTING } from "@/lib/filter-profiles";
import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { reportingDateFilter } from "@/queries/consumption/options";
import { consumptionConnection, FORMAT_CREDITS } from "../shared";
import query from "./executive-credits.dax?raw";
import spec from "./executive-credits.json";
import { shapeMonthlyTrend, type MonthlyTrendParams } from "./monthly-trend";

const columnMetadata: ColumnMetadataMap = {
    "[Month Start]": { name: "Month Start", displayName: "Month", format: "mmm yyyy" },
    "[Studio Credits]": { name: "Studio Credits", displayName: "Copilot Studio agents", format: FORMAT_CREDITS },
    "[Cowork Credits]": { name: "Cowork Credits", displayName: "Cowork", format: FORMAT_CREDITS },
};

/**
 * Copilot Studio and Cowork credits by month from Consumption Central. They
 * cover the whole tenant: the model has no department to narrow them by.
 * The caller limits 'Reporting Date' to the months the hours trend shows.
 */
export function executiveCredits(params?: MonthlyTrendParams) {
    return {
        connection: consumptionConnection,
        filters: CONSUMPTION_REPORTING,
        query,
        columnMetadata,
        vegaLiteSpec: shapeMonthlyTrend(spec, params),
    };
}

/** The tables {@link executiveCreditParts} asks for, as its `[Part]` column names them. */
export const CREDIT_PARTS = ["trend", "range"] as const;
export type CreditPart = (typeof CREDIT_PARTS)[number];

interface Dates {
    /** The first day, `yyyy-mm-dd`. */
    from: string;
    /** The last day, `yyyy-mm-dd`. */
    to: string;
}

/**
 * {@link executiveCredits} for the trend's months and for the date range in
 * one query, so the page asks one query rather than two. Each part is the
 * credits query limited to its dates, as the caller would limit it alone,
 * and its rows say which part they belong to in a `[Part]` column.
 */
export function executiveCreditParts(dates: Record<CreditPart, Dates>, params?: MonthlyTrendParams) {
    const body = evaluateBody(query);
    // The body goes on its own lines, as `applyDaxFilters` puts it, so a trailing line comment can't swallow the dates.
    const part = (name: CreditPart) => `    ADDCOLUMNS(
        CALCULATETABLE(
${body}
,
            ${reportingDateFilter(dates[name].from, dates[name].to)}
        ),
        "Part", "${name}"
    )`;
    return {
        ...executiveCredits(params),
        query: `EVALUATE\nUNION(\n${CREDIT_PARTS.map(part).join(",\n")}\n)\nORDER BY [Part], [Month Start]\n`,
    };
}
