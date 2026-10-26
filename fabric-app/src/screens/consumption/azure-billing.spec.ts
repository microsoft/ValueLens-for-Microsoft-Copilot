//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { SummaryResult } from "@/hooks/use-table-query";
import { billedText, readAzureBilling, subscriptionText } from "./azure-billing";

function summary(row: Record<string, unknown> | undefined, error?: string): SummaryResult {
    return { row, loaded: true, error, refetch: () => undefined };
}

const BILLED = {
    "[Studio Cost]": 61.65,
    "[Studio Credits]": 6165,
    "[Cowork Cost]": 16.21,
    "[Cowork Credits]": 1621,
    "[Other Cost]": null,
    "[Total Cost]": 77.86,
    "[Currency]": "GBP",
    "[Currencies]": "GBP",
    "[Subscriptions]": 2,
    "[First Date]": "2026-04-14T00:00:00",
    "[Last Date]": "2026-04-18T00:00:00",
    "[Rows]": 8,
};

describe("Azure-billed pay-as-you-go", () => {
    it("leaves the panel out when the model has no CopilotPaygSpend or Azure billed nothing", () => {
        expect(readAzureBilling(summary(undefined, "Table 'CopilotPaygSpend' cannot be found"))).toBeUndefined();
        expect(readAzureBilling(summary(undefined))).toBeUndefined();
        expect(readAzureBilling(summary({ ...BILLED, "[Rows]": 0 }))).toBeUndefined();
    });

    it("reads each product's charge in the billed currency, with its window", () => {
        const billing = readAzureBilling(summary(BILLED))!;
        expect(billing.window).toBe("14 Apr – 18 Apr 2026");
        expect(billing.subscriptions).toBe(2);
        expect(billedText(billing, billing.studioCost, billing.studioCredits)).toMatch(/^£61\.65 for 6,165 credits$/);
        expect(billedText(billing, billing.otherCost)).toBeUndefined();
        expect(subscriptionText(1)).toBe("1 subscription");
    });

    it("prints no symbol when Azure billed in more than one currency", () => {
        const billing = readAzureBilling(summary({ ...BILLED, "[Currency]": null, "[Currencies]": "EUR, GBP" }))!;
        expect(billing.currency).toBeUndefined();
        expect(billing.currencies).toBe("EUR, GBP");
        expect(billedText(billing, billing.totalCost)).toBe("77.86");
    });
});
