//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { formatKpi } from "./format-kpi";

describe("formatKpi", () => {
    it("keeps BLANK distinct from zero", () => {
        expect(formatKpi(undefined, "currency", { prefix: "£" })).toBe("—");
        expect(formatKpi(0, "currency", { prefix: "£" })).toBe("£0");
    });

    it("formats currency as whole thousands with the caller's symbol", () => {
        expect(formatKpi(77076.666, "currency", { prefix: "£" })).toBe("£77,077");
    });

    it("keeps existing formats available without options", () => {
        expect(formatKpi(154.153, "hours")).toBe("154.2");
        expect(formatKpi(0.1234, "percent")).toBe("12.3%");
        expect(formatKpi(1.2, "rate")).toBe("1.20");
    });

    it("keeps cents on billed amounts and four decimals on unit prices", () => {
        expect(formatKpi(0.736, "money", { prefix: "$" })).toBe("$0.74");
        expect(formatKpi(6085.818, "money", { prefix: "$" })).toBe("$6,085.82");
        expect(formatKpi(0.008566567, "price", { prefix: "$" })).toBe("$0.0086");
    });

    it("shows how many times one figure covers another, to one decimal", () => {
        expect(formatKpi(5.4523, "multiple")).toBe("5.5×");
        expect(formatKpi(0.2, "multiple")).toBe("0.2×");
        expect(formatKpi(31, "multiple")).toBe("31.0×");
        expect(formatKpi(undefined, "multiple")).toBe("—");
    });
});
