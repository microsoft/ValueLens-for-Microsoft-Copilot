//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

export type MissingModelObject =
    | { kind: "column"; table?: string; name: string }
    | { kind: "table"; name: string }
    | { kind: "measure"; name: string };

const TABLE_COLUMN = /'([^']+)'\[([^\]]+)\]\s+(?:was not found|cannot be found|does not exist)/i;
const COLUMN_IN_TABLE = /column\s+'([^']+)'\s+in\s+table\s+'([^']+)'\s+(?:was not found|cannot be found|does not exist)/i;
const COLUMN_NAMED = /column\s+'([^']+)'\s+(?:was not found|cannot be found|does not exist)/i;
const TABLE_NAMED =
    /(?:cannot find table|table)\s+'?([^'.]+)'?\s*(?:was not found|cannot be found|does not exist|\.|$)/i;
const MEASURE_NAMED =
    /(?:failed to resolve name|measure)\s+'?([^'.[]+)'?\s*(?:was not found|cannot be found|does not exist|\.|$)/i;

/** What the engine says when a query names a table, column or measure the model doesn't have. */
export const MISSING_FROM_MODEL =
    /cannot find table|failed to resolve name|'[^']+'(?:\[[^\]]+\])? (?:was not found|cannot be found|does not exist)|column\s+'[^']+'\s+(?:in\s+table\s+'[^']+'\s+)?(?:was not found|cannot be found|does not exist)|table\s+'[^']+'\s+(?:was not found|cannot be found|does not exist)|measure\s+'[^']+'\s+(?:was not found|cannot be found|does not exist)/i;

/** Reads the missing model object out of the engine error when it names one. */
export function parseMissingModelObject(message: string): MissingModelObject | undefined {
    const tableColumn = TABLE_COLUMN.exec(message);
    if (tableColumn) return { kind: "column", table: tableColumn[1], name: tableColumn[2] };

    const columnInTable = COLUMN_IN_TABLE.exec(message);
    if (columnInTable) return { kind: "column", name: columnInTable[1], table: columnInTable[2] };

    const column = COLUMN_NAMED.exec(message);
    if (column) return { kind: "column", name: column[1] };

    const table = TABLE_NAMED.exec(message);
    if (table) return { kind: "table", name: table[1] };

    const measure = MEASURE_NAMED.exec(message);
    if (measure) return { kind: "measure", name: measure[1] };

    return undefined;
}

export function isMissingFromModelError(message: string): boolean {
    return MISSING_FROM_MODEL.test(message);
}
