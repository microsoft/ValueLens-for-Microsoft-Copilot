//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";

/** Connection alias declared in `fabric.yaml`. */
export const connection = "vl";

/**
 * The Consumption Central model, bound as a second connection so the
 * Consumption page can read Copilot credits and Azure spend beside the
 * ValueLens activity.
 */
export const consumptionConnection = "cc";

/** Count of people, sessions or items. */
export const FORMAT_WHOLE = "#,0";
/** Share of a population, returned by the model as a fraction. */
export const FORMAT_PERCENT = "0.0%";
/** Rates such as sessions per user per week. */
export const FORMAT_RATE = "0.00";
/** Hours, which are meaningful to one decimal place. */
export const FORMAT_HOURS = "#,0.0";
/** Billed amounts, to the cent. */
export const FORMAT_MONEY = "#,0.00";
/** Credits, which the products report to fractions nobody bills by. */
export const FORMAT_CREDITS = "#,0";

/**
 * The most rows a per-person or per-agent list returns. Large tenants have
 * tens of thousands of people, and Power BI's executeQueries API stops at
 * 100,000 rows or 1,000,000 values. The queries write the number into their
 * `TOPN(1000, …)` calls themselves, so the DAX still runs as it is; a spec
 * keeps the two in step.
 */
export const LIST_LIMIT = 1000;

/** How many rows a capped list would have held, repeated on every row it returns. */
export const TOTAL_COLUMN: ColumnMetadataMap = {
    "[Total]": { name: "Total", displayName: "Total", format: FORMAT_WHOLE },
};

/**
 * The cut rows of a concentration query: how many of the busiest people a
 * cut takes, the sum of their values, and the people with a value and their
 * total, repeated on each row. `readConcentration` in lib/concentration reads
 * them, or `readConcentrationSlices` where a query returns only the top slices.
 */
export const CONCENTRATION_COLUMNS: ColumnMetadataMap = {
    "[Count]": { name: "Count", displayName: "Busiest people", format: FORMAT_WHOLE },
    "[Cumulative]": { name: "Cumulative", displayName: "Their total" },
    "[People]": { name: "People", displayName: "People", format: FORMAT_WHOLE },
    "[Total]": { name: "Total", displayName: "Total" },
};
