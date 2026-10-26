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
        expect(formatKpi(412_345.6, "hours")).toBe("412,346");
        expect(formatKpi(0.1234, "percent")).toBe("12.3%");
        expect(formatKpi(1.2, "rate")).toBe("1.20");
    });

    it("keeps cents on billed amounts and four decimals on unit prices", () => {
        expect(formatKpi(0.736, "money", { prefix: "$" })).toBe("$0.74");
        expect(formatKpi(6085.818, "money", { prefix: "$" })).toBe("$6,085.82");
        expect(formatKpi(0.008566567, "price", { prefix: "$" })).toBe("$0.0086");
    });

    it("never shows a real spend under a cent as free", () => {
        expect(formatKpi(0.000575, "money", { prefix: "$" })).toBe("<$0.01");
        expect(formatKpi(0.0049, "money", { prefix: "$" })).toBe("<$0.01");
        expect(formatKpi(0.005, "money", { prefix: "$" })).toBe("$0.01");
        expect(formatKpi(0, "money", { prefix: "$" })).toBe("$0.00");
        expect(formatKpi(0.0003, "currency", { prefix: "$" })).toBe("$0");
    });

    it("shows how many times one figure covers another, to one decimal", () => {
        expect(formatKpi(5.4523, "multiple")).toBe("5.5×");
        expect(formatKpi(0.2, "multiple")).toBe("0.2×");
        expect(formatKpi(31, "multiple")).toBe("31.0×");
        expect(formatKpi(undefined, "multiple")).toBe("—");
    });

    it("never rounds a multiple below one up to break-even", () => {
        expect(formatKpi(42 / 42.91, "multiple")).toBe("0.97×");
        expect(formatKpi(0.999, "multiple")).toBe("0.99×");
        expect(formatKpi(0.94, "multiple")).toBe("0.9×");
        expect(formatKpi(1, "multiple")).toBe("1.0×");
        expect(formatKpi(1.02, "multiple")).toBe("1.0×");
    });

    it("shows a count reported in millions at its own scale", () => {
        // Compact suffixes follow the browser's locale: en-US writes 45K, en-GB 45k.
        const compact = (value: number) => formatKpi(value, "millions").toUpperCase();
        expect(formatKpi(0.000212, "millions")).toBe("212");
        expect(compact(0.045)).toBe("45K");
        expect(compact(1.25)).toBe("1.3M");
        expect(compact(400.27476784)).toBe("400.3M");
        expect(formatKpi(0, "millions")).toBe("0");
        expect(formatKpi(undefined, "millions")).toBe("—");
    });
});

describe("formatKpi compact", () => {
    it("shortens a count or amount of a million or more", () => {
        expect(formatKpi(5_906_850, "whole", { compact: true })).toBe("5.9M");
        expect(formatKpi(59_068_500, "whole", { compact: true })).toBe("59.1M");
        expect(formatKpi(1_480_000_000, "whole", { compact: true })).toBe("1.5B");
        expect(formatKpi(4_812_345, "currency", { compact: true, prefix: "$" })).toBe("$4.8M");
        expect(formatKpi(4_123_456.7, "hours", { compact: true })).toBe("4.1M");
    });

    it("moves up a scale rather than show a thousand millions", () => {
        expect(formatKpi(999_960_000, "whole", { compact: true })).toBe("1B");
        expect(formatKpi(-2_500_000, "currency", { compact: true, prefix: "$" })).toBe("$-2.5M");
    });

    it("leaves every digit of a smaller figure", () => {
        expect(formatKpi(15_447, "whole", { compact: true })).toBe("15,447");
        expect(formatKpi(999_999, "whole", { compact: true })).toBe("999,999");
    });

    it("drops the cents from money in the thousands, and keeps them below", () => {
        expect(formatKpi(845_210.4, "money", { compact: true, prefix: "$" })).toBe("$845,210");
        expect(formatKpi(845_210.4, "money", { prefix: "$" })).toBe("$845,210.40");
        expect(formatKpi(12.5, "money", { compact: true, prefix: "$" })).toBe("$12.50");
    });

    it("never shortens a share, rate, multiple or price", () => {
        expect(formatKpi(0.734, "percent", { compact: true })).toBe("73.4%");
        expect(formatKpi(1_234_567.891, "rate", { compact: true })).toBe("1,234,567.89");
        expect(formatKpi(12.3, "multiple", { compact: true })).toBe("12.3×");
    });

    it("still shows a blank as a dash", () => {
        expect(formatKpi(undefined, "whole", { compact: true })).toBe("—");
    });
});
