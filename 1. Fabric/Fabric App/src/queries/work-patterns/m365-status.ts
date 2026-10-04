//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { ColumnMetadataMap } from "@/lib/to-data-table";
import { readNumber, readText, type SummaryRow } from "@/lib/summary-row";
import { connection, FORMAT_PERCENT, FORMAT_WHOLE } from "../shared";
import query from "./m365-status.dax?raw";

const columnMetadata: ColumnMetadataMap = {
    "[Rows]": { name: "Rows", displayName: "Rows", format: FORMAT_WHOLE },
    "[People]": { name: "People", displayName: "People", format: FORMAT_WHOLE },
    "[First Date]": { name: "First Date", displayName: "First date" },
    "[Last Date]": { name: "Last Date", displayName: "Last date" },
    "[Concealed Share]": { name: "Concealed Share", displayName: "Concealed names", format: FORMAT_PERCENT },
};

/**
 * Whether the model has Microsoft 365 activity at all, read without any
 * filter. The table only exists once the installer has added the module, and
 * stays empty when the module is switched off or hasn't loaded yet.
 */
export function m365Status() {
    return { connection, query, columnMetadata };
}

/**
 * - `missing`: the model predates the module, so the table isn't there.
 * - `empty`: the table is there with no rows: switched off, or not loaded yet.
 */
export type M365State = "loading" | "missing" | "empty" | "error" | "ready";

export interface M365Status {
    state: M365State;
    people?: number;
    /** ISO `yyyy-mm-dd`. */
    firstDate?: string;
    /** ISO `yyyy-mm-dd`. */
    lastDate?: string;
    /** True when the usage reports hide user names, so nothing can be matched to a person. */
    concealed: boolean;
    error?: string;
}

/** Past this share of hashed names, matching to people, organizations or Copilot use is unreliable. */
export const CONCEALED_THRESHOLD = 0.5;

const MISSING_TABLE = /cannot find table|failed to resolve name|M365 Activity'? (?:was not found|cannot be found|does not exist)/i;

/** Reads the probe's answer into the state the Work patterns page and license scoring act on. */
export function readM365Status(result: { row?: SummaryRow; loaded: boolean; error?: string }): M365Status {
    if (result.error !== undefined) {
        return MISSING_TABLE.test(result.error)
            ? { state: "missing", concealed: false }
            : { state: "error", concealed: false, error: result.error };
    }
    if (!result.loaded) return { state: "loading", concealed: false };

    const rows = readNumber(result.row, "[Rows]") ?? 0;
    if (rows <= 0) return { state: "empty", concealed: false };

    return {
        state: "ready",
        people: readNumber(result.row, "[People]"),
        firstDate: readText(result.row, "[First Date]"),
        lastDate: readText(result.row, "[Last Date]"),
        concealed: (readNumber(result.row, "[Concealed Share]") ?? 0) > CONCEALED_THRESHOLD,
    };
}
