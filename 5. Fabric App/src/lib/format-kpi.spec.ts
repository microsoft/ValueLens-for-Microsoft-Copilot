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
});
