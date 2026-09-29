//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { columnHeat, HEAT_MIX_MAX, HEAT_MIX_MIN, heatDomain, heatMix } from "./heat";

describe("heat", () => {
    it("spans only the finite numbers in a column", () => {
        expect(heatDomain([3, null, "x", 9, Number.NaN, 1])).toEqual({ min: 1, max: 9, reverse: undefined });
        expect(heatDomain([null, "x"])).toBeUndefined();
    });

    it("mixes the faintest tint at the low end and the strongest at the high end", () => {
        const domain = { min: 0, max: 100 };
        expect(heatMix(0, domain)).toBe(HEAT_MIX_MIN);
        expect(heatMix(100, domain)).toBe(HEAT_MIX_MAX);
        expect(heatMix(50, domain)).toBe(Math.round((HEAT_MIX_MIN + HEAT_MIX_MAX) / 2));
    });

    it("heats low values most when reversed, for ranks where 1 is best", () => {
        const domain = { min: 1, max: 10, reverse: true };
        expect(heatMix(1, domain)).toBe(HEAT_MIX_MAX);
        expect(heatMix(10, domain)).toBe(HEAT_MIX_MIN);
    });

    it("leaves blanks unshaded and sits a flat column mid-scale", () => {
        expect(heatMix(null, { min: 0, max: 1 })).toBeUndefined();
        expect(heatMix(5, undefined)).toBeUndefined();
        expect(heatMix(5, { min: 5, max: 5 })).toBe(Math.round((HEAT_MIX_MIN + HEAT_MIX_MAX) / 2));
    });

    it("reads a domain from a DataTable column by name", () => {
        const table = { columns: [{ name: "Team" }, { name: "Sessions" }], rows: [["A", 4], ["B", 12]] };
        expect(columnHeat(table, "Sessions")).toEqual({ min: 4, max: 12, reverse: undefined });
        expect(columnHeat(table, "Missing")).toBeUndefined();
    });
});
