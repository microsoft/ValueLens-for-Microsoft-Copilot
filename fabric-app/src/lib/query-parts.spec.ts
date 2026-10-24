//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import type { QueryTable } from "@microsoft/fabric-app-data";
import { describe, expect, it } from "vitest";
import { splitQueryParts } from "./query-parts";

const column = (name: string, dataType = "String") => ({ name, dataType });
const PARTS = ["trend", "range"] as const;

describe("splitQueryParts", () => {
    it("gives each part its own rows, in order, without the [Part] column", () => {
        const table: QueryTable = {
            columns: [column("[Month Start]"), column("[Credits]", "Double"), column("[Part]")],
            rows: [
                ["2026-05-01", 10, "range"],
                ["2026-01-01", 1, "trend"],
                ["2026-02-01", 2, "trend"],
                ["2026-06-01", 20, "range"],
            ],
        };

        expect(splitQueryParts(table, PARTS)).toEqual({
            trend: {
                columns: [column("[Month Start]"), column("[Credits]", "Double")],
                rows: [
                    ["2026-01-01", 1],
                    ["2026-02-01", 2],
                ],
            },
            range: {
                columns: [column("[Month Start]"), column("[Credits]", "Double")],
                rows: [
                    ["2026-05-01", 10],
                    ["2026-06-01", 20],
                ],
            },
        });
    });

    it("finds the [Part] column wherever it is", () => {
        const table: QueryTable = {
            columns: [column("[Part]"), column("[Credits]", "Double")],
            rows: [
                ["range", 3],
                ["trend", 4],
            ],
        };

        const { trend, range } = splitQueryParts(table, PARTS);
        expect(trend).toEqual({ columns: [column("[Credits]", "Double")], rows: [[4]] });
        expect(range).toEqual({ columns: [column("[Credits]", "Double")], rows: [[3]] });
    });

    it("gives a part with no rows an empty table with the same columns", () => {
        const table: QueryTable = {
            columns: [column("[Month Start]"), column("[Part]")],
            rows: [["2026-01-01", "trend"]],
        };

        expect(splitQueryParts(table, PARTS).range).toEqual({ columns: [column("[Month Start]")], rows: [] });
    });

    it("gives every part an empty table when the answer has no rows and names no columns", () => {
        expect(splitQueryParts({ columns: [], rows: [] }, PARTS)).toEqual({
            trend: { columns: [], rows: [] },
            range: { columns: [], rows: [] },
        });
    });

    it("leaves out rows of a part it wasn't asked for", () => {
        const table: QueryTable = {
            columns: [column("[Credits]", "Double"), column("[Part]")],
            rows: [
                [1, "trend"],
                [2, "other"],
            ],
        };

        expect(splitQueryParts(table, PARTS)).toEqual({
            trend: { columns: [column("[Credits]", "Double")], rows: [[1]] },
            range: { columns: [column("[Credits]", "Double")], rows: [] },
        });
    });
});
