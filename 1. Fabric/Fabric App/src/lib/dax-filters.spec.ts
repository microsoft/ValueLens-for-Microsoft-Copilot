//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { addQueryDefinitions, applyDaxFilters, dateBetween, daxString, treatAs } from "./dax-filters";

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

describe("applyDaxFilters", () => {
    const filter = `TREATAS({"HR"}, 'Org'[Organization])`;

    it("returns the query untouched when there are no filters", () => {
        const query = "EVALUATE ROW(\"A\", 1)";
        expect(applyDaxFilters(query, [])).toBe(query);
    });

    it("wraps a single EVALUATE body in CALCULATETABLE", () => {
        expect(squash(applyDaxFilters(`EVALUATE ROW("A", [Users])`, [filter]))).toBe(
            squash(`EVALUATE CALCULATETABLE( ROW("A", [Users]) , ${filter} )`),
        );
    });

    it("leaves DEFINE blocks alone and keeps ORDER BY outside the wrap", () => {
        const query = [
            "DEFINE",
            "    MEASURE 'T'[M] = CALCULATE([Users], 'T'[Flag] = \"EVALUATE\")",
            "    VAR Cutoff = 5",
            "EVALUATE",
            "SUMMARIZECOLUMNS('T'[Week], \"M\", [M])",
            "ORDER BY 'T'[Week]",
        ].join("\n");
        const result = applyDaxFilters(query, [filter]);

        expect(result.startsWith(query.slice(0, query.indexOf("EVALUATE\n")))).toBe(true);
        expect(squash(result)).toContain(
            squash(`EVALUATE CALCULATETABLE( SUMMARIZECOLUMNS('T'[Week], "M", [M]) , ${filter} ) ORDER BY 'T'[Week]`),
        );
    });

    it("wraps every EVALUATE in a multi-statement query", () => {
        const query = "EVALUATE ROW(\"A\", 1)\nEVALUATE ROW(\"B\", 2)\nORDER BY [B]";
        const result = applyDaxFilters(query, [filter]);
        expect(result.match(/CALCULATETABLE\(/g)).toHaveLength(2);
        expect(squash(result).endsWith("ORDER BY [B]")).toBe(true);
    });

    it("ignores keywords inside strings, names, comments and nested calls", () => {
        const query = [
            "// EVALUATE in a line comment",
            "-- ORDER BY in a dash comment",
            "/* EVALUATE in a block comment */",
            "EVALUATE",
            "FILTER(",
            "    ADDCOLUMNS(VALUES('Order By'[Evaluate]), \"Label\", \"ORDER BY \"\"quoted\"\"\"),",
            "    [Start At] > 0 // trailing comment",
            ")",
        ].join("\n");
        const result = applyDaxFilters(query, [filter]);

        expect(result.match(/CALCULATETABLE\(/g)).toHaveLength(1);
        // The trailing comment must not swallow the filter argument.
        expect(result).toMatch(/trailing comment\n\)\n,\n {4}TREATAS/);
    });

    it("joins several filters as separate CALCULATETABLE arguments", () => {
        const result = applyDaxFilters("EVALUATE ROW(\"A\", 1)", ["F1", "F2"]);
        expect(squash(result)).toBe(squash(`EVALUATE CALCULATETABLE( ROW("A", 1) , F1, F2 )`));
    });

    it("is case-insensitive about statement keywords", () => {
        const result = applyDaxFilters("evaluate ROW(\"A\", 1) order by [A]", ["F"]);
        expect(squash(result)).toBe(squash(`evaluate CALCULATETABLE( ROW("A", 1) , F ) order by [A]`));
    });
});

describe("filter expressions", () => {
    it("escapes quotes in string literals", () => {
        expect(daxString('Say "hi"')).toBe('"Say ""hi"""');
    });

    it("builds a TREATAS over strings and numbers", () => {
        expect(treatAs("'T'[C]", ["A", "B"])).toBe(`TREATAS({"A", "B"}, 'T'[C])`);
        expect(treatAs("'T'[N]", [50])).toBe("TREATAS({50}, 'T'[N])");
    });

    it("builds an inclusive date range over the whole column", () => {
        expect(dateBetween("'Calendar'[Date]", "2026-05-08", "2026-07-06")).toBe(
            "FILTER(ALL('Calendar'[Date]), 'Calendar'[Date] >= DATE(2026, 5, 8) && 'Calendar'[Date] <= DATE(2026, 7, 6))",
        );
    });
});

describe("addQueryDefinitions", () => {
    const measure = "MEASURE 'T'[Rate] = 0.01";

    it("returns the query untouched when there is nothing to add", () => {
        const query = "EVALUATE ROW(\"A\", 1)";
        expect(addQueryDefinitions(query, [])).toBe(query);
    });

    it("starts a DEFINE ahead of the first statement", () => {
        expect(squash(addQueryDefinitions("// note\nEVALUATE ROW(\"A\", [Rate])", [measure]))).toBe(
            squash(`DEFINE ${measure} // note\nEVALUATE ROW("A", [Rate])`),
        );
    });

    it("joins an existing DEFINE, ignoring the word inside strings and comments", () => {
        const query = [
            "// DEFINE is the first keyword",
            "DEFINE",
            "    MEASURE 'T'[Own] = \"DEFINE\"",
            "EVALUATE ROW(\"A\", [Own])",
        ].join("\n");
        const result = addQueryDefinitions(query, [measure]);
        expect(result.match(/^DEFINE\b/gm)).toHaveLength(1);
        expect(result.indexOf(measure)).toBeGreaterThan(result.indexOf("\nDEFINE"));
        expect(result.indexOf(measure)).toBeLessThan(result.indexOf("MEASURE 'T'[Own]"));
    });

    it("keeps a definition ending in a line comment off the next line", () => {
        const result = addQueryDefinitions("EVALUATE ROW(\"A\", [Rate])", ["MEASURE 'T'[Rate] = 1 // one"]);
        expect(result).toMatch(/\/\/ one\n/);
    });
});
