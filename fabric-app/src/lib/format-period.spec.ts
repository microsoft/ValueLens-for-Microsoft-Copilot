//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { formatPeriod, readableDates } from "./format-period";

describe("formatPeriod", () => {
    it("reads a model date as its month", () => {
        expect(formatPeriod("2026-05-01T00:00:00")).toBe("May 2026");
        expect(formatPeriod("2026-10-01")).toBe("Oct 2026");
    });

    it("leaves named periods alone", () => {
        expect(formatPeriod("All days")).toBe("All days");
    });
});

describe("readableDates", () => {
    it("reads a model date as a day", () => {
        expect(readableDates("2026-10-17T00:00:00")).toBe("17 Oct 2026");
    });

    it("rewrites dates inside text", () => {
        expect(readableDates("Actual cost to 2026-10-17T00:00:00")).toBe("Actual cost to 17 Oct 2026");
    });

    it("keeps undefined and plain text", () => {
        expect(readableDates(undefined)).toBeUndefined();
        expect(readableDates("1 Oct to 25 Oct")).toBe("1 Oct to 25 Oct");
    });
});