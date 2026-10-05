//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { modelDisplayName, withModelNames } from "./model-name";

describe("modelDisplayName", () => {
    it.each([
        ["Gpt 4O", "GPT-4o"],
        ["O4 Mini", "o4-mini"],
        ["5.4", "GPT-5.4"],
        ["Gpt 4.1", "GPT-4.1"],
        ["Gpt 5", "GPT-5"],
        ["Gpt 5 Mini", "GPT-5-mini"],
        ["gpt-4o-mini", "GPT-4o-mini"],
    ])("spells %s as %s", (name, expected) => {
        expect(modelDisplayName(name)).toBe(expected);
    });

    it.each(["GPT-4o", "o4-mini", "GPT-5.4", "Pay As You Go Copilot Credit", "Text Embedding 3 Small", "Not recorded", ""])(
        "leaves %j alone",
        (name) => {
            expect(modelDisplayName(name)).toBe(name);
        },
    );
});

describe("withModelNames", () => {
    const table = {
        columns: [{ name: "Item" }, { name: "Cost" }],
        rows: [
            ["Gpt 4O", 10],
            [null, 2],
        ],
    };

    it("renames only the named column's text values", () => {
        expect(withModelNames(table, "Item")?.rows).toEqual([
            ["GPT-4o", 10],
            [null, 2],
        ]);
    });

    it("returns the table untouched when the column is missing", () => {
        expect(withModelNames(table, "Model")).toBe(table);
        expect(withModelNames(undefined, "Item")).toBeUndefined();
    });
});
