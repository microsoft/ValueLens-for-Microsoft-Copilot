//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import { isGroupRow, toRollupTree, visibleRowCount } from "./rollup-tree";

const options = {
    group: "Grade",
    leaf: "Shape",
    grandTotalFlag: "Is Grand Total",
    groupTotalFlag: "Is Group Total",
    label: "Label",
    fields: ["Sessions"],
};

function table(rows: unknown[][]): DataTable {
    return {
        columns: ["Grade", "Grade Sort", "Shape", "Is Grand Total", "Is Group Total", "Sessions"].map((name) => ({ name })),
        rows,
    };
}

describe("toRollupTree", () => {
    it("nests leaves under their group and lifts the grand total out", () => {
        const tree = toRollupTree(
            table([
                [null, null, null, true, true, 30],
                ["Strong fit", 0, null, false, true, 20],
                ["Strong fit", 0, "Cross-app chain", false, false, 12],
                ["Strong fit", 0, "Builds an artifact", false, false, 8],
                ["Fair fit", 1, null, false, true, 10],
                ["Fair fit", 1, "Read messages", false, false, 10],
            ]),
            options,
        );

        expect(tree.total).toEqual({ _id: "total", Label: "Total", Sessions: 30 });
        expect(tree.rows.map((row) => row.Label)).toEqual(["Strong fit", "Fair fit"]);
        expect(tree.rows.every(isGroupRow)).toBe(true);
        expect((tree.rows[0]._children as { Label: string }[]).map((row) => row.Label)).toEqual([
            "Cross-app chain",
            "Builds an artifact",
        ]);
        expect(tree.rows[0].Sessions).toBe(20);
    });

    it("keeps a group's place when its subtotal follows its leaves", () => {
        const tree = toRollupTree(
            table([
                ["Fair fit", 1, "Read messages", false, false, 4],
                ["Strong fit", 0, null, false, true, 9],
                ["Fair fit", 1, null, false, true, 4],
            ]),
            options,
        );
        expect(tree.rows.map((row) => [row.Label, row.Sessions])).toEqual([
            ["Fair fit", 4],
            ["Strong fit", 9],
        ]);
    });

    it("renames groups and labels blanks", () => {
        const tree = toRollupTree(
            table([
                ["Low fit", 2, null, false, true, 3],
                ["Low fit", 2, "", false, false, 3],
                [null, 3, null, false, true, 1],
            ]),
            {
                ...options,
                blankLabel: "Unassigned",
                groupLabel: (value, cell) => (value === "Low fit" && cell("Grade Sort") === 2 ? "Worth a look" : undefined),
            },
        );
        expect(tree.rows.map((row) => row.Label)).toEqual(["Worth a look", "Unassigned"]);
        expect((tree.rows[0]._children as { Label: string }[])[0].Label).toBe("Unassigned");
        expect(tree.rows[1]._children).toBeUndefined();
    });
});

describe("visibleRowCount", () => {
    it("counts the leaves of open groups only", () => {
        const rows = [
            { _id: "group:a", _children: [{ _id: "leaf:a/1" }, { _id: "leaf:a/2" }] },
            { _id: "group:b", _children: [{ _id: "leaf:b/1" }] },
            { _id: "group:c" },
        ];
        expect(visibleRowCount(rows, () => false)).toBe(3);
        expect(visibleRowCount(rows, (row) => row._id === "group:a")).toBe(5);
        expect(visibleRowCount(rows, () => true)).toBe(6);
    });
});
