//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { formatCell, totalsRow, withExpansion } from "./tree-grid";

describe("tree grid helpers", () => {
    it("leaves a blank cell blank rather than printing a dash", () => {
        expect(formatCell("whole")(undefined)).toBeNull();
        expect(formatCell("whole")(Number.NaN)).toBeNull();
        expect(formatCell("whole")(6300)).toBe((6300).toLocaleString());
        expect(formatCell("decimal")(2)).toBe((2).toLocaleString(undefined, { minimumFractionDigits: 1 }));
    });

    it("formats the totals row up front, since the grid prints it as given", () => {
        const table = totalsRow({ _id: "total", Who: "Total", Sessions: 6300, Share: undefined }, [
            { id: "Who" },
            { id: "Sessions", format: formatCell("whole") },
            { id: "Share", format: formatCell("percent") },
        ]);
        expect(table?.columns.map((column) => column.name)).toEqual(["Who", "Sessions", "Share"]);
        expect(table?.rows).toEqual([["Total", (6300).toLocaleString(), ""]]);
        expect(totalsRow(undefined, [{ id: "Who" }])).toBeUndefined();
    });

    it("opens or closes only the rows that have children", () => {
        const rows = withExpansion(
            { rows: [{ _id: "group:a", _children: [{ _id: "leaf:a/1" }] }, { _id: "group:b" }], total: undefined },
            true,
        );
        expect(rows?.map((row) => row._expanded)).toEqual([true, undefined]);
    });
});
