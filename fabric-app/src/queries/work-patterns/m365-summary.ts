//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { readNumber, readText, type SummaryRow } from "@/lib/summary-row";
import { connection, FORMAT_HOURS, FORMAT_RATE, FORMAT_WHOLE } from "../shared";
import query from "./m365-summary.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[People Active]": { name: "People Active", displayName: "People active", format: FORMAT_WHOLE },
    "[Days Loaded]": { name: "Days Loaded", displayName: "Days loaded", format: FORMAT_WHOLE },
    "[First Date]": { name: "First Date", displayName: "First date" },
    "[Last Date]": { name: "Last Date", displayName: "Last date" },
    "[Active Days Per Week]": { name: "Active Days Per Week", displayName: "Active days per week", format: FORMAT_RATE },
    "[Workloads Per Active Day]": {
        name: "Workloads Per Active Day",
        displayName: "Workloads per active day",
        format: FORMAT_RATE,
    },
    "[Meetings Per Week]": { name: "Meetings Per Week", displayName: "Meetings per week", format: FORMAT_RATE },
    "[Call Hours Per Week]": { name: "Call Hours Per Week", displayName: "Call and meeting hours per week", format: FORMAT_HOURS },
    "[Emails Sent Per Week]": { name: "Emails Sent Per Week", displayName: "Emails sent per week", format: FORMAT_RATE },
    "[Chats Per Week]": { name: "Chats Per Week", displayName: "Chat messages per week", format: FORMAT_RATE },
};

/**
 * The shape of an average working week on Microsoft 365. Weekly figures are
 * per active person, over the days loaded in the selection, so a short date
 * range doesn't read as a quiet one.
 */
export function m365Summary() {
    return { connection, query, columnMetadata };
}

export interface M365Coverage {
    /** ISO `yyyy-mm-dd`. */
    firstDate: string;
    /** ISO `yyyy-mm-dd`. */
    lastDate: string;
    /** Days between the first and last date, both included. */
    spanDays: number;
    /** Days in that span with any activity loaded. */
    daysLoaded: number;
    /** Days in that span with nothing loaded: not published, or nobody active. */
    missingDays: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Which days the summary's averages rest on. The ingester writes nothing for
 * a day with no activity rows, so a gap can't be told apart from a day the
 * reports haven't published; either way it's left out of the averages rather
 * than counted as a quiet day.
 */
export function readM365Coverage(row: SummaryRow | undefined): M365Coverage | undefined {
    const firstDate = readText(row, "[First Date]");
    const lastDate = readText(row, "[Last Date]");
    const daysLoaded = readNumber(row, "[Days Loaded]");
    if (!firstDate || !lastDate || daysLoaded === undefined) return undefined;
    if (!ISO_DATE.test(firstDate) || !ISO_DATE.test(lastDate)) return undefined;

    const spanDays = Math.round((Date.parse(`${lastDate}T00:00:00Z`) - Date.parse(`${firstDate}T00:00:00Z`)) / 86_400_000) + 1;
    if (!(spanDays > 0)) return undefined;

    return { firstDate, lastDate, spanDays, daysLoaded, missingDays: Math.max(0, spanDays - daysLoaded) };
}
