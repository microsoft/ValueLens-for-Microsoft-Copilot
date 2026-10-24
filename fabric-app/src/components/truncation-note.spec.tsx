//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatKpi } from "@/lib/format-kpi";
import { leafCount, listCount, listTotal } from "@/lib/list-total";
import { TruncationNote } from "./truncation-note";

describe("TruncationNote", () => {
    it("says how many rows the list leaves out", () => {
        const { container } = render(<TruncationNote shown={1000} total={12345} noun="people" by="by sessions" />);
        expect(container.textContent).toBe(
            `Showing the top ${formatKpi(1000, "whole")} of ${formatKpi(12345, "whole")} people by sessions.`,
        );
    });

    it("renders nothing for a whole list", () => {
        expect(render(<TruncationNote shown={12} total={12} noun="people" />).container.textContent).toBe("");
        expect(render(<TruncationNote shown={0} total={undefined} noun="people" />).container.textContent).toBe("");
    });

    it.each([undefined, 3, -1, NaN, Infinity])("warns when total %s cannot establish completeness", (total) => {
        const { container } = render(<TruncationNote shown={12} total={total} noun="people" />);
        expect(container.textContent).toContain("The full count is unavailable; this list may be incomplete.");
        expect(container.textContent).not.toContain("top");
    });

    it.each([12345, undefined])("renders the rollup explanation as notice text with total %s", (total) => {
        const { container } = render(<TruncationNote shown={1000} total={total} noun="people" rollup />);
        expect(container.querySelector("p > span")?.textContent).toContain(
            " Group totals include everyone in the selection; a person may appear in more than one group.",
        );
    });
});

describe("listTotal", () => {
    const table = {
        columns: [{ name: "User" }, { name: "Total" }],
        rows: [
            ["a", 3],
            ["b", 3],
        ],
    };

    it("reads the total a capped list repeats on its rows", () => {
        expect(listTotal(table)).toBe(3);
        expect(listCount(table)).toBe(3);
    });

    it("never treats returned rows as a missing full count", () => {
        const bare = { columns: [{ name: "User" }], rows: [["a"], ["b"]] };
        expect(listTotal(bare)).toBeUndefined();
        expect(listCount(bare)).toBeUndefined();
        expect(listCount({ ...bare, rows: [] })).toBe(0);
        expect(listTotal(undefined)).toBeUndefined();
    });

    it.each([null, NaN, Infinity, -1, 1.5, "3", 4])("rejects invalid or inconsistent repeated totals (%s)", (value) => {
        expect(listTotal({ ...table, rows: [["a", 3], ["b", value]] })).toBeUndefined();
    });
});

describe("leafCount", () => {
    it("counts a rollup's people, not its group and grand totals", () => {
        const rollup = {
            columns: [{ name: "Group" }, { name: "Is Group Total" }],
            rows: [
                ["", true],
                ["A", true],
                ["a1", false],
                ["a2", false],
            ],
        };
        expect(leafCount(rollup)).toBe(2);
        expect(leafCount({ columns: [{ name: "Group" }], rows: [["a"], ["b"], ["c"]] })).toBe(3);
    });
});
