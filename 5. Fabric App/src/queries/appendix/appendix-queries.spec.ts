//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { glossary, signalImpact } from "./index";
import { liveColumns } from "./live-columns.fixture";
import glossaryRows from "./__fixtures__/glossary.rows.json";
import signalRows from "./__fixtures__/signal-impact.rows.json";

const modules = [
    { name: "glossary", factory: glossary, columns: liveColumns.glossary, rows: glossaryRows },
    { name: "signalImpact", factory: signalImpact, columns: liveColumns.signalImpact, rows: signalRows },
];

/** Characters `ColumnDef.name` strips from the original DAX column name. */
function cleanColumnName(original: string): string {
    return original.replace(/[.[\]\\"']/g, "");
}

describe("appendix query contract", () => {
    it.each(modules)("$name covers exactly the columns the model returns", ({ factory, columns }) => {
        expect(Object.keys(factory().columnMetadata).sort()).toEqual([...columns].sort());
    });

    it.each(modules)("$name fixture rows carry exactly those columns", ({ columns, rows }) => {
        for (const row of rows as Record<string, unknown>[]) {
            expect(Object.keys(row).sort()).toEqual([...columns].sort());
        }
    });

    it.each(modules)("$name derives ColumnDef names by the documented rule", ({ factory }) => {
        for (const [original, def] of Object.entries(factory().columnMetadata)) {
            expect(def.name).toBe(cleanColumnName(original));
        }
    });

    it.each(modules)("$name targets the bound connection", ({ factory }) => {
        expect(factory().connection).toBe("vl");
    });

    it.each(modules)("$name ships a DAX query without a byte-order mark", ({ factory }) => {
        const raw = factory().query;
        expect(raw.charCodeAt(0)).not.toBe(0xfeff);
        expect(raw.trim()).toMatch(/^(EVALUATE|DEFINE)\b/);
    });

    it("reads the glossary from the model's own table, emoji name included", () => {
        expect(glossary().query).toContain("'📖 Metric Glossary'[PageOrder]");
    });

    it("joins the human estimates on Behavior without relying on relationship direction", () => {
        const query = signalImpact().query;
        expect(query.match(/LOOKUPVALUE\(/g)).toHaveLength(5);
        expect(query).toContain("'Human Time Estimates'[Behavior], 'Behavior Value Map'[Behavior]");
    });
});

describe("signal impact fixture", () => {
    const rows = signalRows as Record<string, unknown>[];

    it("gives every signal a positive human estimate", () => {
        for (const row of rows) {
            expect(row["[Human Equivalent (Minutes)]"]).toBeGreaterThan(0);
        }
    });

    it("links every estimate to an https source", () => {
        for (const row of rows) {
            expect(String(row["[Source URL]"])).toMatch(/^https:\/\//);
        }
    });
});
